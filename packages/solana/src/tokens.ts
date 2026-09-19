import {
  AuthorityType,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  createTransferInstruction,
  getMint,
} from '@solana/spl-token';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from '@solana/web3.js';
import type {
  ChainConfig,
  EntityId,
  ResourceId,
  TokenMint,
  TokenService,
  TokenSpec,
  WorldDefinition,
} from '@aw/types';
import { chunk } from './ix.ts';
import type { TxSender } from './sender.ts';
import { SolanaWalletService } from './wallet.ts';

/**
 * Real SPL mints, one per resource the world declares in `chain.tokens`.
 *
 * The world ledger in `programs/world` is the fast path: one account, one transaction,
 * the whole economy. These mints are the *legible* path — an ordinary SPL token that
 * any wallet, any explorer and any other Solana program already understands, with no
 * knowledge of our program required.
 *
 * Nothing here names a resource. Economic Sandbox declares WORLD/FOOD/WOOD/TOOL and
 * Medieval Kingdom declares GOLD/GRAIN/TIMBR/IRON; both come out of the same code
 * reading the same field.
 *
 * # `fixedSupply` is not a flag we honour, it is an authority we destroy
 *
 * A world that sets `fixedSupply: true` gets its mint authority set to `null` after
 * genesis, through `setAuthority`. After that no key in existence can mint that token
 * — not ours, not the simulation server's, not anyone's — and the fact is readable on
 * any block explorer as `mintAuthority: null`. It is the same claim as the `sealed`
 * byte on our ledger, but it needs nobody to trust or even read our program.
 */
export class SolanaTokenService implements TokenService {
  readonly #connection: Connection;
  readonly #sender: TxSender;
  readonly #wallet: SolanaWalletService;
  readonly #specs: Map<ResourceId, TokenSpec>;
  readonly #mints = new Map<ResourceId, TokenMint>();
  readonly #creation = new Map<ResourceId, string>();

  constructor(opts: {
    connection: Connection;
    sender: TxSender;
    wallet: SolanaWalletService;
    /** `chain.tokens` from the world file. */
    specs: Record<ResourceId, TokenSpec>;
  }) {
    this.#connection = opts.connection;
    this.#sender = opts.sender;
    this.#wallet = opts.wallet;
    this.#specs = new Map(Object.entries(opts.specs));
  }

  /** The mints created so far, in declaration order. */
  mints(): TokenMint[] {
    return [...this.#mints.values()];
  }

  mintOf(resource: ResourceId): TokenMint | undefined {
    return this.#mints.get(resource);
  }

  specOf(resource: ResourceId): TokenSpec | undefined {
    return this.#specs.get(resource);
  }

  /** The transaction that created this mint. */
  creationSignature(resource: ResourceId): string | undefined {
    return this.#creation.get(resource);
  }

  /** Whole units to the token's base units. `decimals: 2` makes 1 gold into 100. */
  toBase(resource: ResourceId, amount: number): bigint {
    const decimals = this.#mints.get(resource)?.decimals ?? this.#specs.get(resource)?.decimals ?? 0;
    return BigInt(Math.round(amount * 10 ** decimals));
  }

  fromBase(resource: ResourceId, amount: bigint): number {
    const decimals = this.#mints.get(resource)?.decimals ?? 0;
    return Number(amount) / 10 ** decimals;
  }

  // ------------------------------------------------------------ TokenService

  /**
   * Create one SPL mint, with the authority as both mint and freeze authority for now.
   *
   * Two instructions in one transaction, which is the standard shape: allocate the
   * mint account from the System program, then initialise it. The mint keypair is
   * ephemeral and signs only this transaction.
   */
  async createToken(
    resource: ResourceId,
    symbol: string,
    decimals: number,
  ): Promise<TokenMint> {
    const existing = this.#mints.get(resource);
    if (existing) return existing;

    const mintKey = Keypair.generate();
    const lamports = await this.#connection.getMinimumBalanceForRentExemption(MINT_SIZE);
    const signature = await this.#sender.send(
      [
        SystemProgram.createAccount({
          fromPubkey: this.#wallet.authorityKey,
          newAccountPubkey: mintKey.publicKey,
          space: MINT_SIZE,
          lamports,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(
          mintKey.publicKey,
          decimals,
          this.#wallet.authorityKey,
          // No freeze authority. A world that can freeze a peasant's grain is a
          // different world from the one these rules describe, and leaving the power
          // lying around unused is worse than not having it.
          null,
        ),
      ],
      this.#wallet.signingWithEphemeral(mintKey),
    );

    const record: TokenMint = {
      resource,
      symbol,
      mint: mintKey.publicKey.toBase58(),
      decimals,
      fixedSupply: false,
    };
    this.#mints.set(resource, record);
    this.#creation.set(resource, signature);
    this.#wallet.registerMint(resource, mintKey.publicKey);
    return record;
  }

  async mintTo(resource: ResourceId, to: EntityId, amount: number): Promise<string> {
    const mint = this.#mustMint(resource);
    return this.#sender.send(
      [
        createAssociatedTokenAccountIdempotentInstruction(
          this.#wallet.authorityKey,
          this.#wallet.tokenAccountFor(to, resource),
          this.#wallet.keyFor(to),
          new PublicKey(mint.mint),
        ),
        createMintToInstruction(
          new PublicKey(mint.mint),
          this.#wallet.tokenAccountFor(to, resource),
          this.#wallet.authorityKey,
          this.toBase(resource, amount),
        ),
      ],
      this.#wallet.signing(),
    );
  }

  /**
   * Burn from an agent's own account, which the agent must authorise.
   *
   * The authority pays the fee but cannot burn someone else's tokens — that is a
   * property of SPL, not of our politeness, and it is why agents have real keypairs.
   */
  async burnFrom(resource: ResourceId, from: EntityId, amount: number): Promise<string> {
    const mint = this.#mustMint(resource);
    return this.#sender.send(
      [
        createBurnInstruction(
          this.#wallet.tokenAccountFor(from, resource),
          new PublicKey(mint.mint),
          this.#wallet.keyFor(from),
          this.toBase(resource, amount),
        ),
      ],
      this.#wallet.signing(from),
    );
  }

  async transferToken(
    resource: ResourceId,
    from: EntityId,
    to: EntityId,
    amount: number,
  ): Promise<string> {
    const { instructions, signAs } = this.transferInstructions(resource, from, to, amount);
    return this.#sender.send(instructions, this.#wallet.signing(...signAs));
  }

  /**
   * The instructions behind {@link transferToken}, unsent.
   *
   * The settlement queue needs these rather than the send, so it can pack a tick's
   * worth of transfers into one transaction instead of one transaction each.
   */
  transferInstructions(
    resource: ResourceId,
    from: EntityId,
    to: EntityId,
    amount: number,
  ): { instructions: TransactionInstruction[]; signAs: EntityId[] } {
    const mint = this.#mustMint(resource);
    return {
      signAs: [from],
      instructions: [
        // Idempotent: the recipient may never have held this token before, and paying
        // a few hundred compute units to find out is cheaper than a failed transfer.
        createAssociatedTokenAccountIdempotentInstruction(
          this.#wallet.authorityKey,
          this.#wallet.tokenAccountFor(to, resource),
          this.#wallet.keyFor(to),
          new PublicKey(mint.mint),
        ),
        createTransferInstruction(
          this.#wallet.tokenAccountFor(from, resource),
          this.#wallet.tokenAccountFor(to, resource),
          this.#wallet.keyFor(from),
          this.toBase(resource, amount),
        ),
      ],
    };
  }

  /** Read a real token account balance. Returns whole units, not base units. */
  async balanceOf(resource: ResourceId, entity: EntityId): Promise<number> {
    this.#mustMint(resource);
    const ata = this.#wallet.tokenAccountFor(entity, resource);
    try {
      const res = await this.#connection.getTokenAccountBalance(ata, 'confirmed');
      return Number(res.value.uiAmount ?? 0);
    } catch {
      // No account yet means no tokens. That is a balance of zero, not an error.
      return 0;
    }
  }

  /**
   * Set the mint authority to `null`, permanently.
   *
   * There is no inverse. After this the token's supply is whatever it was at this
   * instant, forever, and `getMint(...).mintAuthority` reads `null` for anyone who
   * looks — which is the point: it is checkable without trusting us.
   */
  async revokeMintAuthority(resource: ResourceId): Promise<string> {
    const mint = this.#mustMint(resource);
    const signature = await this.#sender.send(
      [
        createSetAuthorityInstruction(
          new PublicKey(mint.mint),
          this.#wallet.authorityKey,
          AuthorityType.MintTokens,
          null,
        ),
      ],
      this.#wallet.signing(),
    );
    this.#mints.set(resource, { ...mint, fixedSupply: true });
    return signature;
  }

  /**
   * Read the mint back off chain and report whether anyone can still mint it.
   *
   * Deliberately does not consult our own bookkeeping: the whole value of revoking the
   * authority is that it is a fact about the chain, so the check has to be too.
   */
  async verifyFixedSupply(
    resource: ResourceId,
  ): Promise<{ mint: string; mintAuthority: string | null; supply: bigint; decimals: number }> {
    const record = this.#mustMint(resource);
    const info = await getMint(this.#connection, new PublicKey(record.mint), 'confirmed');
    return {
      mint: record.mint,
      mintAuthority: info.mintAuthority?.toBase58() ?? null,
      supply: info.supply,
      decimals: info.decimals,
    };
  }

  #mustMint(resource: ResourceId): TokenMint {
    const mint = this.#mints.get(resource);
    if (!mint) throw new Error(`resource "${resource}" has no mint; call createToken first`);
    return mint;
  }
}

/** What genesis did, for the demo and for the reconciler. */
export interface TokenGenesis {
  mints: TokenMint[];
  signatures: string[];
  /** Resources whose mint authority is now `null`. */
  revoked: ResourceId[];
}

/**
 * Create every mint the world declares, hand out the starting balances, and revoke
 * the authority on anything marked `fixedSupply`.
 *
 * Batched throughout, because 27 agents across 4 tokens is 108 token accounts and
 * doing that one round trip at a time is the difference between two seconds and two
 * minutes. Associated token accounts are created idempotently alongside the mint that
 * fills them, so there is no separate creation pass to get out of step.
 */
export async function runTokenGenesis(args: {
  world: WorldDefinition;
  chain: ChainConfig;
  tokens: SolanaTokenService;
  wallet: SolanaWalletService;
  sender: TxSender;
  /** entity id -> entity type, for reading starting balances out of the world file. */
  roster: { ids: readonly string[]; types: readonly string[] };
  /** Lamports of real SOL to give each agent so it exists on an explorer. */
  fundLamports?: number;
  onStep?: (step: string, signature: string) => void;
}): Promise<TokenGenesis> {
  const { world, chain, tokens, wallet, sender, roster } = args;
  const specs = chain.tokens ?? {};
  const signatures: string[] = [];
  const mints: TokenMint[] = [];

  // 1. The mints themselves. Two instructions each and an ephemeral signer, so these
  //    cannot be batched with one another without the transaction growing signers.
  for (const [resource, spec] of Object.entries(specs)) {
    const mint = await tokens.createToken(resource, spec.symbol, spec.decimals ?? 0);
    mints.push(mint);
    const sig = tokens.creationSignature(resource);
    if (sig) {
      signatures.push(sig);
      args.onStep?.(`mint ${spec.symbol}`, sig);
    }
  }

  // 2. Real lamports for every agent, so each is an account an explorer will show.
  if (chain.agentWallets && (args.fundLamports ?? 0) > 0) {
    const funding = wallet.fundingInstructions(args.fundLamports!);
    for (const part of chunk(funding, 18)) {
      const sig = await sender.send(part, wallet.signing());
      signatures.push(sig);
      args.onStep?.(`fund ${part.length} agents`, sig);
    }
  }

  // 3. Starting balances, from the world's own entity types. Each agent's token
  //    account is created in the same instruction batch that funds it.
  const byType = new Map(world.entityTypes.map((t) => [t.id, t.resources ?? {}]));
  const minted = new Map<ResourceId, number>();

  for (const [resource, spec] of Object.entries(specs)) {
    const mintKey = wallet.mintFor(resource)!;
    const decimals = spec.decimals ?? 0;
    const ixs: TransactionInstruction[] = [];
    let total = 0;

    for (let i = 0; i < roster.ids.length; i++) {
      const entity = roster.ids[i]!;
      const amount = Math.trunc(byType.get(roster.types[i]!)?.[resource] ?? 0);
      if (amount <= 0) continue;
      total += amount;
      ixs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          wallet.authorityKey,
          wallet.tokenAccountFor(entity, resource),
          wallet.keyFor(entity),
          mintKey,
        ),
        createMintToInstruction(
          mintKey,
          wallet.tokenAccountFor(entity, resource),
          wallet.authorityKey,
          BigInt(Math.round(amount * 10 ** decimals)),
        ),
      );
    }

    // Two instructions per agent, each touching two accounts the transaction has not
    // seen before, so the account list is what binds — not the instruction data.
    for (const part of chunk(ixs, 12)) {
      const sig = await sender.send(part, wallet.signing());
      signatures.push(sig);
    }
    if (ixs.length > 0) {
      args.onStep?.(`endow ${spec.symbol}`, signatures[signatures.length - 1]!);
    }
    minted.set(resource, total);
  }

  // 4. A fixed-supply token must actually reach its declared supply before the
  //    authority goes away, or "fixed supply" would mean "whatever we happened to
  //    hand out". The remainder is minted to the authority as the world reserve.
  for (const [resource, spec] of Object.entries(specs)) {
    if (spec.initialSupply === undefined) continue;
    const handedOut = minted.get(resource) ?? 0;
    const remainder = spec.initialSupply - handedOut;
    if (remainder <= 0) continue;
    const mintKey = wallet.mintFor(resource)!;
    const reserve = wallet.treasuryTokenAccount(resource);
    const sig = await sender.send(
      [
        createAssociatedTokenAccountIdempotentInstruction(
          wallet.authorityKey,
          reserve,
          wallet.authorityKey,
          mintKey,
        ),
        createMintToInstruction(
          mintKey,
          reserve,
          wallet.authorityKey,
          BigInt(Math.round(remainder * 10 ** (spec.decimals ?? 0))),
        ),
      ],
      wallet.signing(),
    );
    signatures.push(sig);
    args.onStep?.(`reserve ${spec.symbol}`, sig);
  }

  // 5. The irreversible bit, last.
  const revoked: ResourceId[] = [];
  for (const [resource, spec] of Object.entries(specs)) {
    if (!spec.fixedSupply) continue;
    const sig = await tokens.revokeMintAuthority(resource);
    signatures.push(sig);
    revoked.push(resource);
    args.onStep?.(`revoke ${spec.symbol}`, sig);
  }

  return { mints: mints.map((m) => tokens.mintOf(m.resource) ?? m), signatures, revoked };
}
