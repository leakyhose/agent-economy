import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import type { WorldDefinition } from '@aw/types';
import type { Order } from './auction.ts';
import { sortAsks, sortBids } from './auction.ts';
import { BlockhashCache, explorerUrl, type ClusterConfig } from './cluster.ts';
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
  chunk,
  clearAuctionIx,
  createLedgerAccountIx,
  endowIx,
  initializeIx,
  sealIx,
  settleIx,
  transferIx,
  type LedgerAccounts,
} from './instructions.ts';
import {
  LEDGER_BYTES,
  MAX_ENDOWMENTS_PER_TX,
  MAX_ORDERS_PER_BOOK,
  decodeLedger,
  type LedgerState,
} from './program.ts';
import { TxSender } from './sender.ts';
import { SolanaWalletService } from './wallet.ts';

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
  }) {
    this.#connection = args.connection;
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
          numAgents: roster.count,
          numGoods: map.numGoods,
          startCash: uniform.cash,
          startGoods: uniform.goods,
        }),
      ],
      wallet.signers([ledgerKey]),
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
    });

    // `initialize` gives every slot the same purse. Correct the ones that differ —
    // a kingdom's treasury is not a peasant's — then close genesis for good.
    const endowments = endowmentsFor(args.world, roster, map, uniform);
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
    });
  }

  get accounts(): LedgerAccounts {
    return this.#accounts;
  }

  /** Genesis balances. Fails once {@link seal} has run. */
  async endow(entries: Endowment[]): Promise<string> {
    return this.sender.send(
      [endowIx(this.programId, this.#accounts, entries)],
      this.wallet.signers(),
    );
  }

  /** Close genesis. After this no instruction in the program can create a coin. */
  async seal(): Promise<string> {
    return this.sender.send([sealIx(this.programId, this.#accounts)], this.wallet.signers());
  }

  /** Signed goods deltas. Chunked to fit a transaction. */
  async settle(deltas: { agent: number; good: number; delta: number }[]): Promise<string[]> {
    const sigs: string[] = [];
    for (const part of chunk(deltas, 120)) {
      sigs.push(
        await this.sender.send(
          [settleIx(this.programId, this.#accounts, part)],
          this.wallet.signers(),
        ),
      );
    }
    return sigs;
  }

  async transfer(from: number, to: number, amount: number): Promise<string> {
    return this.sender.send(
      [transferIx(this.programId, this.#accounts, { from, to, amount })],
      this.wallet.signers(),
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
        this.wallet.signers(),
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
          this.wallet.signers(),
        ),
      );
    }
    return { signatures, atomic: false };
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
