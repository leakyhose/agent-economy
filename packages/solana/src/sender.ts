import {
  Connection,
  Transaction,
  type Signer,
  type TransactionInstruction,
} from '@solana/web3.js';
import { BlockhashCache } from './cluster.ts';

/** A program error: the transaction was well-formed and the program said no. */
export class ProgramRejection extends Error {
  constructor(
    message: string,
    readonly logs: string[],
  ) {
    super(message);
    this.name = 'ProgramRejection';
  }
}

/**
 * Whether a failure is worth trying again.
 *
 * A program rejection is deterministic — retrying an auction the program called
 * unsorted just burns the rate limit and delays the real error. An expired blockhash,
 * a node that is behind, or a 429 are all transient and the same bytes will land a
 * moment later.
 */
function isTransient(err: unknown): boolean {
  if (err instanceof ProgramRejection) return false;
  const text = String(err instanceof Error ? err.message : err).toLowerCase();
  return (
    text.includes('blockhash not found') ||
    text.includes('block height exceeded') ||
    text.includes('node is behind') ||
    text.includes('too many requests') ||
    text.includes('429') ||
    text.includes('timed out') ||
    text.includes('timeout') ||
    text.includes('fetch failed') ||
    text.includes('socket') ||
    text.includes('econnreset') ||
    text.includes('service unavailable')
  );
}

/** Pull the useful line out of a Solana error, which buries it in the logs. */
function describe(err: unknown): { message: string; logs: string[] } {
  const e = err as { message?: string; logs?: string[]; transactionLogs?: string[] };
  const logs = e.transactionLogs ?? e.logs ?? [];
  const reason = logs.find((l) => l.includes('Error Message')) ?? e.message ?? String(err);
  return { message: reason, logs };
}

export interface SenderOptions {
  /** Attempts per transaction, including the first. */
  maxAttempts?: number;
  /** First backoff, doubled each retry. */
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Sends transactions with a cached blockhash and bounded retry.
 *
 * Deliberately not `sendAndConfirmTransaction`: that fetches a blockhash per call,
 * which is the fastest way to be rate-limited, and it polls to confirm. Here the
 * blockhash comes from a per-slot cache and confirmation goes through the connection's
 * own subscription-backed path.
 */
export class TxSender {
  readonly #connection: Connection;
  readonly #blockhash: BlockhashCache;
  readonly #maxAttempts: number;
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  #sent = 0;

  constructor(connection: Connection, blockhash?: BlockhashCache, opts: SenderOptions = {}) {
    this.#connection = connection;
    this.#blockhash = blockhash ?? new BlockhashCache(connection);
    this.#maxAttempts = opts.maxAttempts ?? 5;
    this.#baseDelayMs = opts.baseDelayMs ?? 250;
    this.#maxDelayMs = opts.maxDelayMs ?? 4_000;
  }

  /** How many transactions this sender has landed. */
  get sent(): number {
    return this.#sent;
  }

  async send(
    instructions: readonly TransactionInstruction[],
    signers: readonly Signer[],
  ): Promise<string> {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt += 1;
      try {
        const { blockhash, lastValidBlockHeight } = await this.#blockhash.get();
        const tx = new Transaction({
          blockhash,
          lastValidBlockHeight,
          feePayer: signers[0]?.publicKey,
        });
        for (const ix of instructions) tx.add(ix);
        tx.sign(...signers);

        const signature = await this.#connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          maxRetries: 0,
        });
        const result = await this.#connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          this.#connection.commitment ?? 'confirmed',
        );
        if (result.value.err) {
          throw new ProgramRejection(
            `transaction ${signature} failed: ${JSON.stringify(result.value.err)}`,
            [],
          );
        }
        this.#sent += 1;
        return signature;
      } catch (err) {
        const { message, logs } = describe(err);
        // A blockhash we cached has gone stale; the next attempt must fetch a new one.
        if (message.toLowerCase().includes('blockhash')) this.#blockhash.invalidate();
        if (!isTransient(err) || attempt >= this.#maxAttempts) {
          throw err instanceof ProgramRejection ? err : new ProgramRejection(message, logs);
        }
        const delay = Math.min(this.#maxDelayMs, this.#baseDelayMs * 2 ** (attempt - 1));
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
}
