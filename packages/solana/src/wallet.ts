import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import type { AgentWallet, EntityId, WalletService } from '@aw/types';
import type { AgentRoster, GoodMap } from './goods.ts';
import { decodeLedger, type LedgerState } from './ix.ts';
import type { Signing } from './sender.ts';

/**
 * The only module in the system that holds a private key.
 *
 * Nothing here returns key material and nothing here logs it. `addressFor` gives out
 * public keys; signing happens through {@link SolanaWalletService.signing}, which
 * hands back a closure that can sign a transaction but cannot be asked what it signs
 * with. The instances deliberately redact themselves under `console.log` and
 * `JSON.stringify`, because the way secrets escape is not a deliberate
 * `return secretKey` — it is an object that got printed in a debug session.
 *
 * `@aw/agents` must never import this. The brief makes that a structural rule rather
 * than a convention, and the package boundary is what enforces it.
 */
export class SolanaWalletService implements WalletService {
  /** Signs every ledger write. The simulation server's key. */
  readonly #authority: Keypair;
  /** Per-entity identity keys, derived deterministically. Never handed out. */
  readonly #derived = new Map<EntityId, Keypair>();
  readonly #seed: Buffer;

  readonly #connection: Connection;
  readonly #ledger: PublicKey;
  readonly #map: GoodMap;
  readonly #roster: AgentRoster;

  /** resource -> mint, once a {@link TokenService} has created them. */
  readonly #mints = new Map<string, PublicKey>();
  /** `${entity}:${resource}` -> associated token account. Derivation is pure but slow. */
  readonly #ataCache = new Map<string, PublicKey>();

  /** Balance reads are cached briefly: a tick asks for hundreds of them at once. */
  #cache: { at: number; state: LedgerState } | null = null;
  readonly #cacheMs: number;

  constructor(opts: {
    connection: Connection;
    /** The ledger account this world settles into. */
    ledger: PublicKey;
    map: GoodMap;
    roster: AgentRoster;
    /** Defaults to `~/.config/solana/id.json`. */
    authority?: Keypair;
    /**
     * Master secret for per-entity key derivation. Omit and one is generated for the
     * process, which is right for a demo and wrong for anything that must survive a
     * restart.
     */
    masterSeed?: Buffer;
    cacheMs?: number;
  }) {
    this.#connection = opts.connection;
    this.#ledger = opts.ledger;
    this.#map = opts.map;
    this.#roster = opts.roster;
    this.#authority = opts.authority ?? loadKeypair();
    this.#seed = opts.masterSeed ?? randomBytes(32);
    this.#cacheMs = opts.cacheMs ?? 400;
  }

  // ------------------------------------------------------------- addresses

  /** The public key that signs ledger writes. */
  authorityAddress(): string {
    return this.#authority.publicKey.toBase58();
  }

  get authorityKey(): PublicKey {
    return this.#authority.publicKey;
  }

  /**
   * A stable public address for an entity.
   *
   * Derived from the master seed and the entity id, so the same agent has the same
   * address across restarts of the same world — which is what makes an explorer link
   * in the UI mean anything.
   */
  async addressFor(entity: EntityId): Promise<string> {
    return this.keyFor(entity).toBase58();
  }

  /** Synchronous form, for building instructions. Public key only. */
  keyFor(entity: EntityId): PublicKey {
    return this.#keypairFor(entity).publicKey;
  }

  // ------------------------------------------------------------- signing

  /**
   * A {@link Signing} that pays with the authority and signs as the authority plus,
   * optionally, some agents — needed when an agent's own token account is the source
   * of a transfer and must authorise it.
   *
   * Returns a closure, not keys. That is the whole point.
   */
  signing(...as: EntityId[]): Signing {
    const extra = as.map((e) => this.#keypairFor(e));
    return {
      feePayer: this.#authority.publicKey,
      sign: (tx: Transaction) => {
        tx.partialSign(this.#authority, ...extra);
      },
    };
  }

  /** As {@link signing}, but also signs with ephemeral keypairs the caller made. */
  signingWithEphemeral(...ephemeral: Keypair[]): Signing {
    return {
      feePayer: this.#authority.publicKey,
      sign: (tx: Transaction) => {
        tx.partialSign(this.#authority, ...ephemeral);
      },
    };
  }

  // ------------------------------------------------------------- balances

  /** The entity's balance in the world's currency: `SOL` here, `gold` there. */
  async getBalance(entity: EntityId): Promise<number> {
    const slot = await this.#slotFor(entity);
    return Number(slot.cash);
  }

  /** Every on-chain resource the entity holds, keyed by the world's own names. */
  async getTokenBalances(entity: EntityId): Promise<Record<string, number>> {
    const slot = await this.#slotFor(entity);
    const out: Record<string, number> = { [this.#map.currency]: Number(slot.cash) };
    for (const { index, resource } of this.#map.tradable) {
      out[resource] = slot.goods[index] ?? 0;
    }
    return out;
  }

  /** Drop the cached ledger snapshot; the next read hits RPC. */
  invalidate(): void {
    this.#cache = null;
  }

  // ------------------------------------------------------------- SPL wiring

  /**
   * Tell the wallet which mint backs which resource.
   *
   * Called by the {@link TokenService} once the mints exist. The wallet needs it to
   * derive associated token accounts, and keeping the mapping here rather than in the
   * token service means an {@link AgentWallet} can be produced without a round trip.
   */
  registerMint(resource: string, mint: PublicKey): void {
    this.#mints.set(resource, mint);
  }

  mintFor(resource: string): PublicKey | undefined {
    return this.#mints.get(resource);
  }

  get resourcesWithMints(): string[] {
    return [...this.#mints.keys()];
  }

  /**
   * The associated token account for one entity and resource.
   *
   * Derived, not fetched — a PDA off the owner, the token program and the mint — so
   * this is arithmetic and it is cached because the arithmetic is a SHA-256 grind and
   * a world of 27 agents across 4 tokens asks for it constantly.
   */
  tokenAccountFor(entity: EntityId, resource: string): PublicKey {
    const key = `${entity}:${resource}`;
    const hit = this.#ataCache.get(key);
    if (hit) return hit;
    const mint = this.#mints.get(resource);
    if (!mint) throw new Error(`resource "${resource}" has no mint registered`);
    const ata = associatedTokenAddress(mint, this.keyFor(entity));
    this.#ataCache.set(key, ata);
    return ata;
  }

  /** The authority's own token account — the world reserve, and the mint destination. */
  treasuryTokenAccount(resource: string): PublicKey {
    const mint = this.#mints.get(resource);
    if (!mint) throw new Error(`resource "${resource}" has no mint registered`);
    return associatedTokenAddress(mint, this.#authority.publicKey);
  }

  /** The `AgentWallet` record for an entity: addresses only, by construction. */
  walletFor(entity: EntityId): AgentWallet {
    const tokenAccounts: Record<string, string> = {};
    for (const resource of this.#mints.keys()) {
      tokenAccounts[resource] = this.tokenAccountFor(entity, resource).toBase58();
    }
    return { entity, address: this.keyFor(entity).toBase58(), tokenAccounts };
  }

  /** Every agent's wallet, in ledger slot order. */
  allWallets(): AgentWallet[] {
    return this.#roster.ids.map((id) => this.walletFor(id));
  }

  /**
   * Instructions that move a little real SOL to each agent.
   *
   * Agents do not strictly need lamports — the authority pays every fee and an
   * associated token account's owner needs no balance — but an account with zero
   * lamports does not exist as far as an explorer is concerned, and "click the agent,
   * see a real account" is most of why per-agent keypairs are worth having. Batched by
   * the caller; this only builds them.
   */
  fundingInstructions(lamportsEach: number): TransactionInstruction[] {
    return this.#roster.ids.map((id) =>
      SystemProgram.transfer({
        fromPubkey: this.#authority.publicKey,
        toPubkey: this.keyFor(id),
        lamports: lamportsEach,
      }),
    );
  }

  // ------------------------------------------------------------- internals

  async #state(): Promise<LedgerState> {
    if (this.#cache && Date.now() - this.#cache.at < this.#cacheMs) return this.#cache.state;
    const info = await this.#connection.getAccountInfo(this.#ledger, 'confirmed');
    if (!info) throw new Error(`ledger account ${this.#ledger.toBase58()} does not exist`);
    const state = decodeLedger(info.data);
    this.#cache = { at: Date.now(), state };
    return state;
  }

  async #slotFor(entity: EntityId) {
    const i = this.#roster.indexOf(entity);
    if (i === undefined) throw new Error(`entity "${entity}" has no ledger slot`);
    const state = await this.#state();
    const slot = state.slots[i];
    if (!slot) throw new Error(`ledger slot ${i} is out of range for "${entity}"`);
    return slot;
  }

  #keypairFor(entity: EntityId): Keypair {
    let kp = this.#derived.get(entity);
    if (!kp) {
      // HMAC over the master seed: deterministic, and the entity id cannot be worked
      // backwards into the seed.
      const material = createHmac('sha512', this.#seed).update(`agentic-world:${entity}`).digest();
      kp = Keypair.fromSeed(material.subarray(0, 32));
      this.#derived.set(entity, kp);
    }
    return kp;
  }

  /** Redact under `console.log`. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `SolanaWalletService { authority: ${this.authorityAddress()}, keys: <redacted> }`;
  }

  toJSON(): Record<string, string> {
    return { authority: this.authorityAddress(), keys: '<redacted>' };
  }
}

/** The SPL token program. */
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
/** The associated-token-account program. */
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);

/**
 * Derive an associated token account address.
 *
 * `[owner, token program, mint]` under the ATA program — the same derivation
 * `@solana/spl-token` does, done here so the wallet has no runtime dependency on it
 * and so the result can be cached behind our own key.
 */
export function associatedTokenAddress(mint: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

/** Load a Solana CLI keypair file. Used for the authority; never re-exported. */
export function loadKeypair(path?: string): Keypair {
  const file = path ?? join(homedir(), '.config', 'solana', 'id.json');
  const bytes = JSON.parse(readFileSync(file, 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}
