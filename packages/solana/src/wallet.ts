import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type Signer,
} from '@solana/web3.js';
import type { EntityId, WalletService } from '@aw/types';
import type { AgentRoster, GoodMap } from './goods.ts';
import { decodeLedger, type LedgerState } from './ix.ts';

/**
 * The only module in the system that holds a private key.
 *
 * Nothing here returns key material, and nothing here logs it. `addressFor` gives out
 * public keys; signing happens inside {@link SolanaWalletService.sign} and the
 * `Keypair`s never leave the closure. The instances deliberately redact themselves
 * under `console.log` and `JSON.stringify`, because the way secrets escape is not a
 * deliberate `return secretKey` — it is an object that got printed in a debug session.
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

  /** The public key that signs ledger writes. */
  authorityAddress(): string {
    return this.#authority.publicKey.toBase58();
  }

  /**
   * A stable public address for an entity.
   *
   * Derived from the master seed and the entity id, so the same agent has the same
   * address across restarts of the same world — which is what makes an explorer link
   * in the UI mean anything.
   */
  async addressFor(entity: EntityId): Promise<string> {
    return this.#keyFor(entity).publicKey.toBase58();
  }

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

  /**
   * Sign a transaction with the ledger authority.
   *
   * The caller builds and sends; the key stays here. Returns the same transaction so
   * this reads as a pipeline step, not because anything secret comes back.
   */
  sign(tx: Transaction, extra: readonly Signer[] = []): Transaction {
    tx.sign(this.#authority, ...extra);
    return tx;
  }

  /** Signers for a transaction, for the send path. Public keys only in, keys stay in. */
  signers(extra: readonly Signer[] = []): Signer[] {
    return [this.#authority, ...extra];
  }

  /** Drop the cached ledger snapshot; the next read hits RPC. */
  invalidate(): void {
    this.#cache = null;
  }

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

  #keyFor(entity: EntityId): Keypair {
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

/** Load a Solana CLI keypair file. Used for the authority; never re-exported. */
export function loadKeypair(path?: string): Keypair {
  const file = path ?? join(homedir(), '.config', 'solana', 'id.json');
  const bytes = JSON.parse(readFileSync(file, 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}
