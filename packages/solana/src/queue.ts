import type { PublicKey, TransactionInstruction } from '@solana/web3.js';
import type { EntityId, SettlementIntent, SettlementQueue } from '@aw/types';
import type { Delta } from './auction.ts';
import type { GoodMap } from './goods.ts';
import { chunk, settleIx, transferIx, type LedgerAccounts } from './instructions.ts';
import { MAX_DELTAS_PER_TX, MAX_TRANSFERS_PER_TX } from './program.ts';
import type { TxSender } from './sender.ts';
import type { SolanaWalletService } from './wallet.ts';

/**
 * An intent that could not be settled, and why.
 *
 * Kept rather than thrown, because a dropped transaction must not take the simulation
 * down with it — but not swallowed either: {@link SolanaSettlementQueue.flush} raises
 * whatever is in here unless the caller has opted to handle it.
 */
export interface SettlementFailure {
  intents: SettlementIntent[];
  error: Error;
}

export interface QueueOptions {
  /** Intents drained per cycle. Keeps a burst from becoming one enormous batch. */
  batchSize?: number;
  /** How long to let intents accumulate before sending. Zero sends next tick. */
  lingerMs?: number;
  /** Hand failures here instead of having `flush` throw them. */
  onError?: (failure: SettlementFailure) => void;
  /** Called with every confirmed signature as it lands. */
  onSignature?: (signature: string, intents: SettlementIntent[]) => void;
}

/**
 * Buffers settlement intents and settles them on chain, asynchronously.
 *
 * The contract that matters is the one in the brief: **the simulation never blocks on
 * RPC**. `enqueue` is synchronous and does nothing but push — the drain runs on its
 * own, off the tick loop, and a validator that is slow, rate-limited or absent slows
 * settlement down without slowing the world down. `flush` is the one place a caller
 * chooses to wait, and it is for the end of a run or a demo checkpoint, not the tick.
 *
 * Intents are grouped by what they move. A transfer of the world's currency becomes a
 * `transfer` instruction; a transfer of a good becomes a pair of signed deltas in a
 * `settle` instruction, which conserves the good for the same reason `transfer`
 * conserves cash. Several of either are packed into one transaction, up to the
 * per-transaction caps in `program.ts`.
 */
export class SolanaSettlementQueue implements SettlementQueue {
  readonly #buffer: SettlementIntent[] = [];
  readonly #signatures: string[] = [];
  readonly #failures: SettlementFailure[] = [];

  readonly #sender: TxSender;
  readonly #wallet: SolanaWalletService;
  readonly #accounts: LedgerAccounts;
  readonly #programId: PublicKey;
  readonly #map: GoodMap;
  readonly #resolve: (entity: EntityId) => number | undefined;

  readonly #batchSize: number;
  readonly #lingerMs: number;
  readonly #onError: ((f: SettlementFailure) => void) | undefined;
  readonly #onSignature: ((s: string, i: SettlementIntent[]) => void) | undefined;

  #draining: Promise<void> | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #armed = false;
  #inflight = 0;

  constructor(opts: {
    sender: TxSender;
    wallet: SolanaWalletService;
    programId: PublicKey;
    accounts: LedgerAccounts;
    map: GoodMap;
    /** Entity id to ledger slot. Usually `roster.indexOf`. */
    resolveAgent: (entity: EntityId) => number | undefined;
    options?: QueueOptions;
  }) {
    this.#sender = opts.sender;
    this.#wallet = opts.wallet;
    this.#programId = opts.programId;
    this.#accounts = opts.accounts;
    this.#map = opts.map;
    this.#resolve = opts.resolveAgent;
    this.#batchSize = opts.options?.batchSize ?? 48;
    this.#lingerMs = opts.options?.lingerMs ?? 0;
    this.#onError = opts.options?.onError;
    this.#onSignature = opts.options?.onSignature;
  }

  /** Synchronous, allocation-only, never throws. This is the tick-loop entry point. */
  enqueue(intent: SettlementIntent): void {
    this.#buffer.push(intent);
    this.#schedule();
  }

  /** Intents buffered or in flight. */
  pending(): number {
    return this.#buffer.length + this.#inflight;
  }

  /**
   * Settle everything outstanding and resolve with the signatures confirmed since the
   * last flush.
   *
   * Throws an `AggregateError` if anything failed and no `onError` handler was given —
   * a settlement layer that quietly drops value is worse than one that stops.
   */
  async flush(): Promise<string[]> {
    // Take over from whatever the scheduler had planned and run it now, repeatedly,
    // because a drain can finish with new intents already buffered behind it.
    while (this.#buffer.length > 0 || this.#draining) {
      if (!this.#draining) this.#start();
      if (this.#draining) await this.#draining;
    }

    const signatures = this.#signatures.splice(0, this.#signatures.length);
    if (this.#failures.length > 0 && !this.#onError) {
      const failures = this.#failures.splice(0, this.#failures.length);
      throw new AggregateError(
        failures.map((f) => f.error),
        `${failures.length} settlement batch(es) failed; ` +
          `${failures.reduce((n, f) => n + f.intents.length, 0)} intent(s) did not settle`,
      );
    }
    return signatures;
  }

  /** Failures recorded so far, for callers that supplied an `onError`. */
  failures(): readonly SettlementFailure[] {
    return this.#failures;
  }

  /**
   * Arm a drain, without starting one synchronously.
   *
   * The delay is the point. A tick enqueues its intents in one synchronous burst, and
   * draining on the first of them would send a transaction holding exactly one
   * transfer and then another holding the rest. Deferring to a microtask lets the
   * whole tick land in one batch, which is the difference between one transaction per
   * tick and one per effect.
   */
  #schedule(): void {
    if (this.#draining || this.#armed || this.#buffer.length === 0) return;
    this.#armed = true;
    if (this.#lingerMs === 0) queueMicrotask(() => this.#start());
    else this.#timer = setTimeout(() => this.#start(), this.#lingerMs);
  }

  #start(): void {
    this.#armed = false;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#draining || this.#buffer.length === 0) return;
    this.#draining = this.#drain().finally(() => {
      this.#draining = null;
      // Anything that arrived mid-drain gets its own cycle.
      this.#schedule();
    });
  }

  async #drain(): Promise<void> {
    while (this.#buffer.length > 0) {
      const batch = this.#buffer.splice(0, this.#batchSize);
      this.#inflight += batch.length;
      try {
        for (const group of this.#plan(batch)) {
          const signature = await this.#sender.send(
            group.instructions,
            this.#wallet.signers(),
          );
          this.#signatures.push(signature);
          this.#onSignature?.(signature, group.intents);
        }
      } catch (error) {
        const failure: SettlementFailure = {
          intents: batch,
          error: error instanceof Error ? error : new Error(String(error)),
        };
        this.#failures.push(failure);
        this.#onError?.(failure);
      } finally {
        this.#inflight -= batch.length;
      }
    }
  }

  /** Turn intents into transactions: cash moves one way, goods the other. */
  #plan(batch: SettlementIntent[]): { instructions: TransactionInstruction[]; intents: SettlementIntent[] }[] {
    const cash: { intent: SettlementIntent; from: number; to: number }[] = [];
    const goods: { intent: SettlementIntent; deltas: Delta[] }[] = [];

    for (const intent of batch) {
      const from = this.#resolve(intent.from);
      const to = this.#resolve(intent.to);
      if (from === undefined || to === undefined) {
        throw new Error(
          `settlement intent references an entity with no ledger slot ` +
            `(${intent.from} -> ${intent.to})`,
        );
      }
      const good = this.#map.indexOf(intent.asset);
      if (good === undefined) {
        throw new Error(`asset "${intent.asset}" does not settle on chain in this world`);
      }
      const amount = Math.trunc(intent.amount);
      if (amount <= 0 || from === to) continue; // nothing to settle
      if (good === 0) cash.push({ intent, from, to });
      else {
        goods.push({
          intent,
          deltas: [
            { agent: from, good, delta: -amount },
            { agent: to, good, delta: amount },
          ],
        });
      }
    }

    const out: { instructions: TransactionInstruction[]; intents: SettlementIntent[] }[] = [];

    for (const part of chunk(cash, MAX_TRANSFERS_PER_TX)) {
      out.push({
        intents: part.map((p) => p.intent),
        instructions: part.map((p) =>
          transferIx(this.#programId, this.#accounts, {
            from: p.from,
            to: p.to,
            amount: Math.trunc(p.intent.amount),
          }),
        ),
      });
    }

    // Two deltas per intent, so halve the per-transaction delta cap.
    for (const part of chunk(goods, Math.floor(MAX_DELTAS_PER_TX / 2))) {
      out.push({
        intents: part.map((p) => p.intent),
        instructions: [
          settleIx(this.#programId, this.#accounts, part.flatMap((p) => p.deltas)),
        ],
      });
    }

    return out;
  }
}

/**
 * A settlement queue that settles nothing.
 *
 * For offline development and for CI, where there is no validator and no reason to
 * want one. The simulation runs identically — it only ever calls `enqueue`, `pending`
 * and `flush`, and gets sensible answers to all three — which is the point of having
 * the port in the first place. It records what it was asked to do, so a test can
 * assert on the intents a run produced without a chain anywhere near it.
 */
export class NullSettlementQueue implements SettlementQueue {
  readonly #seen: SettlementIntent[] = [];
  #buffered = 0;

  enqueue(intent: SettlementIntent): void {
    this.#seen.push(intent);
    this.#buffered += 1;
  }

  pending(): number {
    return this.#buffered;
  }

  /** Resolves with no signatures, because nothing was signed. Never pretends. */
  async flush(): Promise<string[]> {
    this.#buffered = 0;
    return [];
  }

  /** Everything ever enqueued, in order. */
  intents(): readonly SettlementIntent[] {
    return this.#seen;
  }
}
