import { Connection, type Commitment } from '@solana/web3.js';

/** Where the chain is, and what to call it in a URL. */
export interface ClusterConfig {
  /** JSON-RPC endpoint. Defaults to the local test validator. */
  rpcUrl: string;
  /** `mainnet-beta`, `devnet`, `testnet`, or `custom` for a local validator. */
  cluster: 'mainnet-beta' | 'devnet' | 'testnet' | 'custom';
  commitment: Commitment;
}

export const LOCAL_RPC = 'http://127.0.0.1:8899';

/**
 * Read the cluster out of the environment.
 *
 * Defaults to a local validator, deliberately: public devnet is rate-limited to about
 * 100 requests per ten seconds, which a world of 300 agents exhausts immediately, and
 * its faucet is unreliable. Demo on localhost, keep devnet as a cold backup.
 */
export function clusterFromEnv(env: NodeJS.ProcessEnv = process.env): ClusterConfig {
  const rpcUrl = env['AW_RPC_URL'] ?? LOCAL_RPC;
  const named = env['AW_CLUSTER'];
  const cluster =
    named === 'mainnet-beta' || named === 'devnet' || named === 'testnet'
      ? named
      : 'custom';
  return { rpcUrl, cluster, commitment: 'confirmed' };
}

/**
 * A block-explorer URL for a signature, account, or block on the configured cluster.
 *
 * A local validator needs `cluster=custom&customUrl=…`; the public clusters take a
 * plain name. The link works for a judge holding a laptop on the same machine, which
 * is the case that matters during a demo.
 */
export function explorerUrl(
  cfg: ClusterConfig,
  kind: 'tx' | 'address' | 'block',
  id: string,
): string {
  const base = `https://explorer.solana.com/${kind}/${id}`;
  return cfg.cluster === 'custom'
    ? `${base}?cluster=custom&customUrl=${encodeURIComponent(cfg.rpcUrl)}`
    : `${base}?cluster=${cfg.cluster}`;
}

/**
 * Blockhashes, cached per slot.
 *
 * `getLatestBlockhash` on every transaction is the single easiest way to fall off the
 * rate limit, and the answer only changes once a slot (~400ms) anyway. This refreshes
 * at most that often and hands the same value to every transaction in between.
 */
export class BlockhashCache {
  #value: { blockhash: string; lastValidBlockHeight: number } | null = null;
  #fetchedAt = 0;
  #inflight: Promise<{ blockhash: string; lastValidBlockHeight: number }> | null = null;

  constructor(
    private readonly connection: Connection,
    /** Slot time on Solana is ~400ms; one slot of staleness is free. */
    private readonly maxAgeMs = 400,
  ) {}

  async get(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const fresh = this.#value !== null && Date.now() - this.#fetchedAt < this.maxAgeMs;
    if (fresh) return this.#value!;
    // Collapse a burst of concurrent callers onto one RPC round trip.
    this.#inflight ??= this.connection
      .getLatestBlockhash(this.connection.commitment ?? 'confirmed')
      .then((v) => {
        this.#value = v;
        this.#fetchedAt = Date.now();
        return v;
      })
      .finally(() => {
        this.#inflight = null;
      });
    return this.#inflight;
  }

  /** Force the next `get` to hit RPC. Call after a blockhash-expired failure. */
  invalidate(): void {
    this.#value = null;
  }
}

/**
 * Bind {@link explorerUrl} to one cluster: `explorer('tx', sig)`.
 *
 * The form the rest of the system wants, so nothing outside this file has to carry a
 * `ClusterConfig` around just to build a link.
 */
export function makeExplorer(
  cfg: ClusterConfig,
): (kind: 'tx' | 'address' | 'block', id: string) => string {
  return (kind, id) => explorerUrl(cfg, kind, id);
}

export function connect(cfg: ClusterConfig): Connection {
  return new Connection(cfg.rpcUrl, cfg.commitment);
}
