import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import { BlockhashCache } from './config.ts';

/**
 * Who pays for a transaction and who signs it.
 *
 * The sender never receives a `Keypair`. It hands the built transaction to `sign` and
 * gets it back signed, which keeps every private key inside whatever produced the
 * `Signing` — in practice the wallet service. It matters because the sender is the one
 * object everything else in the package holds a reference to; if keys flowed through
 * here, "only the wallet touches keys" would be a comment rather than a fact.
 */
export interface Signing {
  feePayer: PublicKey;
  sign(tx: Transaction): void | Promise<void>;
}

/**
 * A `Signing` from keypairs the caller already holds — an ephemeral mint or ledger
 * account, or a stranger's key in a test. Not a way to get keys *out* of the wallet.
 */
export function signingWith(...keypairs: Keypair[]): Signing {
  const first = keypairs[0];
  if (!first) throw new Error('signingWith needs at least one keypair');
  return {
    feePayer: first.publicKey,
    sign: (tx) => tx.partialSign(...keypairs),
  };
}

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

/**
 * Pull the useful line out of a Solana error, which buries it in the logs.
 *
 * Anchor writes `Error Message: ...`; the SPL token program writes
 * `Program log: Error: ...`; everything else leaves only the raw message, which for a
 * failed simulation is three lines of boilerplate before anything informative.
 */
function describe(err: unknown): { message: string; logs: string[] } {
  const e = err as { message?: string; logs?: string[]; transactionLogs?: string[] };
  const logs = e.transactionLogs ?? e.logs ?? [];
  const anchor = logs.find((l) => l.includes('Error Message'));
  if (anchor) return { message: anchor.split('Error Message:').pop()!.trim(), logs };
  const program = logs.find((l) => l.startsWith('Program log: Error'));
  if (program) return { message: program.replace('Program log: ', '').trim(), logs };
  const custom = logs.find((l) => l.includes('failed: custom program error'));
  if (custom) return { message: custom.trim(), logs };
  return { message: (e.message ?? String(err)).split('\n')[0]!.trim(), logs };
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
    signing: Signing,
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
          feePayer: signing.feePayer,
        });
        for (const ix of instructions) tx.add(ix);
        await signing.sign(tx);

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
