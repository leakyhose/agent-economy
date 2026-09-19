import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import type {
  ChainConfig,
  ResourceId,
  SettlementQueue,
  WorldDefinition,
} from '@aw/types';
import type { Order } from './auction.ts';
import { sortAsks, sortBids } from './auction.ts';
import {
  BlockhashCache,
  chainOf,
  clusterFromEnv,
  connect,
  explorerUrl,
  resolveProgramId,
  type ClusterConfig,
} from './config.ts';
import {
  endowmentsFor,
  mapWorldGoods,
  modalEndowment,
  rosterFromWorld,
  type AgentRoster,
  type Endowment,
  type GoodMap,
} from './goods.ts';
import {
  LEDGER_BYTES,
  MAX_ENDOWMENTS_PER_TX,
  MAX_ORDERS_PER_BOOK,
  chunk,
  clearAuctionIx,
  createLedgerAccountIx,
  decodeLedger,
  endowIx,
  initializeIx,
  liquidateIx,
  sealIx,
  settleIx,
  transferIx,
  type LedgerAccounts,
  type LedgerState,
} from './ix.ts';
import { TxSender, signingWith } from './sender.ts';
import { SolanaSettlementQueue } from './settlement.ts';
import { SolanaTokenService, runTokenGenesis, type TokenGenesis } from './tokens.ts';
import { SolanaWalletService } from './wallet.ts';

/**
 * When is an agent distressed?
 *
 * Derived from the world, not chosen by us: an agent is in trouble when it cannot
 * afford one unit of the cheapest thing the world sells — wood, as it happens, at 300
 * in Economic Sandbox and 250 in Medieval Kingdom. An agent below that cannot buy the
 * cheapest good on any market, which is a meaning that holds in anyone's head, and it
 * falls out of the world file rather than a constant in this repository.
 */
export function distressThresholdFor(world: WorldDefinition, currency: ResourceId): number {
  const priced = (world.markets ?? [])
    .map((m) => world.resources.find((r) => r.id === m.resource)?.startPrice)
    .filter((p): p is number => typeof p === 'number' && p > 0);
  if (priced.length > 0) return Math.min(...priced);
  // No markets: fall back to a tenth of a starting purse, so the condition can fire.
  const purse = world.entityTypes
    .map((t) => t.resources?.[currency] ?? 0)
    .filter((c) => c > 0);
  return purse.length > 0 ? Math.max(1, Math.round(Math.min(...purse) / 10)) : 1;
}

/**
 * One world's ledger on chain, and everything needed to drive it.
 *
 * This is the seam the simulation sits behind. It owns no keys — the
 * {@link SolanaWalletService} does — and it knows nothing about a particular world
 * beyond the {@link GoodMap} derived from that world's own JSON.
 */
export class WorldLedger {
  readonly programId: PublicKey;
  readonly address: PublicKey;
  readonly map: GoodMap;
  readonly roster: AgentRoster;
  readonly wallet: SolanaWalletService;
  readonly sender: TxSender;
  readonly cluster: ClusterConfig;
  /** The slot that buys liquidated goods. Not an agent. */
  readonly reliefPool: number;
  /** Cash below which anyone at all may liquidate an agent. */
  readonly distressThreshold: number;

  readonly #connection: Connection;
  readonly #accounts: LedgerAccounts;

  private constructor(args: {
    connection: Connection;
    cluster: ClusterConfig;
    programId: PublicKey;
    address: PublicKey;
    map: GoodMap;
    roster: AgentRoster;
    wallet: SolanaWalletService;
    sender: TxSender;
    reliefPool: number;
    distressThreshold: number;
  }) {
    this.#connection = args.connection;
    this.reliefPool = args.reliefPool;
    this.distressThreshold = args.distressThreshold;
    this.cluster = args.cluster;
    this.programId = args.programId;
    this.address = args.address;
    this.map = args.map;
    this.roster = args.roster;
    this.wallet = args.wallet;
    this.sender = args.sender;
    this.#accounts = { ledger: args.address, authority: new PublicKey(args.wallet.authorityAddress()) };
  }

  /**
   * Create and populate a ledger for a world, then seal genesis.
   *
   * The account is allocated client-side rather than by Anchor's `init`: at 12,920
   * bytes it is past the 10,240-byte ceiling on what a program may allocate through a
   * CPI. So the System program creates it in the same transaction and `initialize`
   * adopts it through the `zero` constraint.
   */
  static async create(args: {
    world: WorldDefinition;
    connection: Connection;
    cluster: ClusterConfig;
    programId: PublicKey;
    /** Reuse one across ledgers so a slot is fetched once, not once per world. */
    blockhash?: BlockhashCache;
    authority?: Keypair;
    masterSeed?: Buffer;
    /** Progress reporting for a demo script. */
    onStep?: (step: string, signature: string) => void;
  }): Promise<WorldLedger> {
    const map = mapWorldGoods(args.world);
    const roster = rosterFromWorld(args.world);
    const uniform = modalEndowment(args.world, roster, map);
    // One slot past the population is the relief pool: an ordinary slot, so every
    // bounds check in the program already covers it, but not an agent.
    const reliefPool = roster.count;
    const numAgents = roster.count + 1;
    const distressThreshold = distressThresholdFor(args.world, map.currency);

    const sender = new TxSender(args.connection, args.blockhash);
    const ledgerKey = Keypair.generate();
    const authority = args.authority;

    const wallet = new SolanaWalletService({
      connection: args.connection,
      ledger: ledgerKey.publicKey,
      map,
      roster,
      ...(authority ? { authority } : {}),
      ...(args.masterSeed ? { masterSeed: args.masterSeed } : {}),
    });
    const authorityKey = new PublicKey(wallet.authorityAddress());
    const accounts: LedgerAccounts = { ledger: ledgerKey.publicKey, authority: authorityKey };

    const lamports = await args.connection.getMinimumBalanceForRentExemption(LEDGER_BYTES);
    const sig = await sender.send(
      [
        createLedgerAccountIx({
          payer: authorityKey,
          ledger: ledgerKey.publicKey,
          programId: args.programId,
          lamports,
        }),
        initializeIx(args.programId, accounts, {
          numAgents,
          numGoods: map.numGoods,
          startCash: uniform.cash,
          startGoods: uniform.goods,
          distressThreshold,
          reliefPool,
        }),
      ],
      wallet.signingWithEphemeral(ledgerKey),
    );
    args.onStep?.('initialize', sig);

    const self = new WorldLedger({
      connection: args.connection,
      cluster: args.cluster,
      programId: args.programId,
      address: ledgerKey.publicKey,
      map,
      roster,
      wallet,
      sender,
      reliefPool,
      distressThreshold,
    });

    // `initialize` gives every slot the same purse. Correct the ones that differ —
    // a kingdom's treasury is not a peasant's — and stock the relief pool, which has
    // to be able to pay for what it is asked to buy or the permissionless path is
    // decorative. Then close genesis for good.
    const endowments = endowmentsFor(args.world, roster, map, uniform);
    endowments.push({
      agent: reliefPool,
      good: 0,
      amount: Math.max(uniform.cash * 10, distressThreshold * 50),
    });
    for (const part of chunk(endowments, MAX_ENDOWMENTS_PER_TX)) {
      args.onStep?.('endow', await self.endow(part));
    }
    args.onStep?.('seal', await self.seal());

    return self;
  }

  /** Attach to a ledger that already exists. */
  static attach(args: {
    world: WorldDefinition;
    connection: Connection;
    cluster: ClusterConfig;
    programId: PublicKey;
    address: PublicKey;
    blockhash?: BlockhashCache;
    authority?: Keypair;
    masterSeed?: Buffer;
  }): WorldLedger {
    const map = mapWorldGoods(args.world);
    const roster = rosterFromWorld(args.world);
    const wallet = new SolanaWalletService({
      connection: args.connection,
      ledger: args.address,
      map,
      roster,
      ...(args.authority ? { authority: args.authority } : {}),
      ...(args.masterSeed ? { masterSeed: args.masterSeed } : {}),
    });
    return new WorldLedger({
      connection: args.connection,
      cluster: args.cluster,
      programId: args.programId,
      address: args.address,
      map,
      roster,
      wallet,
      sender: new TxSender(args.connection, args.blockhash),
      reliefPool: roster.count,
      distressThreshold: distressThresholdFor(args.world, map.currency),
    });
  }

  get accounts(): LedgerAccounts {
    return this.#accounts;
  }

  /** Genesis balances. Fails once {@link seal} has run. */
  async endow(entries: Endowment[]): Promise<string> {
    return this.sender.send(
      [endowIx(this.programId, this.#accounts, entries)],
      this.wallet.signing(),
    );
  }

  /** Close genesis. After this no instruction in the program can create a coin. */
  async seal(): Promise<string> {
    return this.sender.send([sealIx(this.programId, this.#accounts)], this.wallet.signing());
  }

  /** Signed goods deltas. Chunked to fit a transaction. */
  async settle(deltas: { agent: number; good: number; delta: number }[]): Promise<string[]> {
    const sigs: string[] = [];
    for (const part of chunk(deltas, 120)) {
      sigs.push(
        await this.sender.send(
          [settleIx(this.programId, this.#accounts, part)],
          this.wallet.signing(),
        ),
      );
    }
    return sigs;
  }

  async transfer(from: number, to: number, amount: number): Promise<string> {
    return this.sender.send(
      [transferIx(this.programId, this.#accounts, { from, to, amount })],
      this.wallet.signing(),
    );
  }

  /**
   * Clear one good's market.
   *
   * Sorts here, on the client, because the program will not: it verifies the ordering
   * in O(n) instead.
   *
   * Both books travel in one instruction, so the 96-order budget is shared: 48 bids
   * and 48 asks. A market bigger than that cannot clear in one transaction, and
   * splitting it means each slice gets its own uniform price — which is a different
   * auction, not the same one in pieces. So the split is reported (`atomic: false`)
   * rather than hidden, and a caller that needs one price for the whole book has to
   * keep the book under the cap.
   */
  async clearAuction(
    good: number,
    bids: Order[],
    asks: Order[],
  ): Promise<{ signatures: string[]; atomic: boolean }> {
    const sortedBids = sortBids(bids);
    const sortedAsks = sortAsks(asks);
    const atomic =
      sortedBids.length <= MAX_ORDERS_PER_BOOK && sortedAsks.length <= MAX_ORDERS_PER_BOOK;

    if (atomic) {
      const sig = await this.sender.send(
        [clearAuctionIx(this.programId, this.#accounts, { good, bids: sortedBids, asks: sortedAsks })],
        this.wallet.signing(),
      );
      return { signatures: [sig], atomic: true };
    }

    // Both ladders are already price-ordered, so slicing them in lockstep clears the
    // most aggressive orders first. Each slice is its own uniform price, which is not
    // the same auction — hence `atomic: false`.
    const bidParts = chunk(sortedBids, MAX_ORDERS_PER_BOOK);
    const askParts = chunk(sortedAsks, MAX_ORDERS_PER_BOOK);
    const rounds = Math.max(bidParts.length, askParts.length);
    const signatures: string[] = [];
    for (let r = 0; r < rounds; r++) {
      signatures.push(
        await this.sender.send(
          [
            clearAuctionIx(this.programId, this.#accounts, {
              good,
              bids: bidParts[r] ?? [],
              asks: askParts[r] ?? [],
            }),
          ],
          this.wallet.signing(),
        ),
      );
    }
    return { signatures, atomic: false };
  }

  /**
   * Call the permissionless instruction as a complete stranger.
   *
   * `caller` is any funded keypair. It is not the ledger authority, it is not known to
   * the world, and the program does not look at it: the only thing that decides
   * whether this succeeds is whether the agent's on-chain cash is below the world's
   * declared threshold. That is the whole demonstration — hand someone a terminal and
   * a keypair and they can reach into a running economy.
   */
  async liquidate(caller: Keypair, agent: number, good: number): Promise<string> {
    return this.sender.send(
      [liquidateIx(this.programId, {
        ledger: this.address,
        caller: caller.publicKey,
        agent,
        good,
      })],
      signingWith(caller),
    );
  }

  /** Agents the chain currently considers distressed, cheapest first. */
  async distressed(): Promise<{ agent: number; cash: bigint; goods: number[] }[]> {
    const state = await this.read();
    const out: { agent: number; cash: bigint; goods: number[] }[] = [];
    for (let agent = 0; agent < state.numAgents; agent++) {
      if (agent === state.reliefPool) continue;
      const slot = state.slots[agent]!;
      if (slot.cash < state.distressThreshold) {
        out.push({ agent, cash: slot.cash, goods: slot.goods });
      }
    }
    return out.sort((a, b) => Number(a.cash - b.cash));
  }

  /**
   * Reconcile engine balances against the chain, with the chain winning.
   *
   * This is what `chain.chainAuthoritative` buys. Without it the ledger is a mirror —
   * a log of what the simulation decided, and a judge is right to ask what it is for.
   * With it the direction of authority reverses: after each round the engine's numbers
   * are checked against the account and corrected from it, so a divergence is the
   * engine's bug to fix rather than the chain's to absorb.
   *
   * Returns every difference it found and wrote back, so the caller can log them
   * rather than have them disappear.
   */
  async reconcile(
    engineBalances: Record<string, Record<ResourceId, number>>,
  ): Promise<ReconcileReport> {
    const state = await this.read();
    const divergences: Divergence[] = [];

    for (let agent = 0; agent < this.roster.count; agent++) {
      const entity = this.roster.ids[agent]!;
      const onChain = state.slots[agent];
      const offChain = engineBalances[entity];
      if (!onChain || !offChain) continue;

      for (let good = 0; good < this.map.numGoods; good++) {
        const resource = this.map.goods[good]!;
        const chainValue = good === 0 ? Number(onChain.cash) : (onChain.goods[good] ?? 0);
        const engineValue = Math.trunc(offChain[resource] ?? 0);
        if (chainValue !== engineValue) {
          divergences.push({ entity, agent, resource, chain: chainValue, engine: engineValue });
          // The chain wins. Write the correction into the caller's own object so the
          // engine picks it up on the next tick.
          offChain[resource] = chainValue;
        }
      }
    }

    return {
      round: state.round,
      checked: this.roster.count * this.map.numGoods,
      divergences,
      moneySupply: state.moneySupply,
    };
  }

  /** Read the whole ledger back. The chain, not the mirror, is the source of truth. */
  async read(): Promise<LedgerState> {
    const info = await this.#connection.getAccountInfo(this.address, 'confirmed');
    if (!info) throw new Error(`ledger account ${this.address.toBase58()} does not exist`);
    return decodeLedger(info.data);
  }

  /** Explorer URL on the configured cluster. */
  explorer(kind: 'tx' | 'address' | 'block', id: string): string {
    return explorerUrl(this.cluster, kind, id);
  }
}

/** One balance the engine and the chain disagreed about. The chain's value won. */
export interface Divergence {
  entity: string;
  agent: number;
  resource: ResourceId;
  chain: number;
  engine: number;
}

export interface ReconcileReport {
  round: number;
  /** How many (agent, good) pairs were compared. */
  checked: number;
  divergences: Divergence[];
  moneySupply: bigint;
}

// ---------------------------------------------------------------- bootstrap

/** Everything a running world needs on the chain side. */
export interface WorldChain {
  ledger: WorldLedger;
  /** Present when the world declares `chain.tokens`. */
  tokens?: SolanaTokenService;
  /** What token genesis did, including which mints are now un-mintable. */
  genesis?: TokenGenesis;
  queue: SolanaSettlementQueue;
  chain: ChainConfig | undefined;
}

/**
 * Stand a world up on chain from its definition alone.
 *
 * Creates the ledger, runs genesis, seals it, and — if the world declares
 * `chain.tokens` — creates the real SPL mints, funds the agents, hands out the
 * starting balances and revokes the authority on anything marked `fixedSupply`.
 *
 * Every decision here comes out of the world file. Nothing in this function knows
 * whether it is building a sandbox economy or a medieval kingdom.
 */
export async function bootstrapWorld(args: {
  world: WorldDefinition;
  connection?: Connection;
  cluster?: ClusterConfig;
  programId?: PublicKey;
  blockhash?: BlockhashCache;
  masterSeed?: Buffer;
  /** Real lamports per agent, so each is an account an explorer will render. */
  fundLamports?: number;
  onStep?: (step: string, signature: string) => void;
}): Promise<WorldChain> {
  const cluster = args.cluster ?? clusterFromEnv();
  const connection = args.connection ?? connect(cluster);
  const blockhash = args.blockhash ?? new BlockhashCache(connection);
  const programId = args.programId ?? resolveProgramId();
  const chain = chainOf(args.world);

  const ledger = await WorldLedger.create({
    world: args.world,
    connection,
    cluster,
    programId,
    blockhash,
    ...(args.masterSeed ? { masterSeed: args.masterSeed } : {}),
    ...(args.onStep ? { onStep: args.onStep } : {}),
  });

  let tokens: SolanaTokenService | undefined;
  let genesis: TokenGenesis | undefined;
  if (chain?.tokens && Object.keys(chain.tokens).length > 0) {
    tokens = new SolanaTokenService({
      connection,
      sender: ledger.sender,
      wallet: ledger.wallet,
      specs: chain.tokens,
    });
    genesis = await runTokenGenesis({
      world: args.world,
      chain,
      tokens,
      wallet: ledger.wallet,
      sender: ledger.sender,
      roster: { ids: ledger.roster.ids, types: ledger.roster.types },
      fundLamports: args.fundLamports ?? 2_000_000,
      ...(args.onStep ? { onStep: args.onStep } : {}),
    });
  }

  const queue = new SolanaSettlementQueue({
    sender: ledger.sender,
    wallet: ledger.wallet,
    programId,
    accounts: ledger.accounts,
    map: ledger.map,
    resolveAgent: (e) => ledger.roster.indexOf(e),
    ...(tokens ? { tokens } : {}),
  });

  return { ledger, queue, chain, ...(tokens ? { tokens } : {}), ...(genesis ? { genesis } : {}) };
}

/**
 * The entry point `apps/sim` imports.
 *
 * Returns a `SettlementQueue` that also answers `addressFor`, which is all the
 * simulation is allowed to know about the chain. If anything here throws, the sim
 * falls back to running off-chain — that fallback lives on its side of the boundary,
 * deliberately, so a chain problem can never take the world down mid-demo.
 */
export async function createSettlement(args: {
  world: WorldDefinition;
  rpc?: string;
  onStep?: (step: string, signature: string) => void;
}): Promise<SettlementQueue & { addressFor(entity: string): Promise<string> }> {
  const cluster = args.rpc
    ? { ...clusterFromEnv(), rpcUrl: args.rpc }
    : clusterFromEnv();
  const built = await bootstrapWorld({
    world: args.world,
    cluster,
    ...(args.onStep ? { onStep: args.onStep } : {}),
  });
  return {
    enqueue: (intent) => built.queue.enqueue(intent),
    flush: () => built.queue.flush(),
    pending: () => built.queue.pending(),
    addressFor: (entity) => built.ledger.wallet.addressFor(entity),
  };
}
