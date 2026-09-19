import type { Entity } from '@aw/types';

/** Which cluster this deployment settles against. A local validator is not on
 *  the public explorer, so links carry the custom RPC it needs to reach it. */
export const EXPLORER_CLUSTER = process.env.NEXT_PUBLIC_CLUSTER ?? 'custom';
const CUSTOM_RPC = process.env.NEXT_PUBLIC_RPC ?? 'http://127.0.0.1:8899';

function clusterQuery(): string {
  return EXPLORER_CLUSTER === 'custom'
    ? `cluster=custom&customUrl=${encodeURIComponent(CUSTOM_RPC)}`
    : `cluster=${EXPLORER_CLUSTER}`;
}
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function explorerTx(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?${clusterQuery()}`;
}

export function explorerAddress(address: string): string {
  return `https://explorer.solana.com/address/${address}?${clusterQuery()}`;
}

/**
 * The address the server supplied, or a deterministic stand-in derived from the
 * entity id so every row still links somewhere sensible before wallets exist.
 */
export function walletOf(entity: Entity): string {
  const supplied = entity.state?.['wallet'] ?? entity.state?.['address'] ?? entity.attributes?.['wallet'];
  if (typeof supplied === 'string' && supplied.length > 20) return supplied;
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < entity.id.length; i += 1) {
    h1 = Math.imul(h1 ^ entity.id.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + entity.id.charCodeAt(i) + i, 0x85ebca6b) >>> 0;
  }
  let out = '';
  for (let i = 0; i < 44; i += 1) {
    h1 = (Math.imul(h1, 1664525) + 1013904223) >>> 0;
    h2 = (h2 ^ (h1 >>> 7)) >>> 0;
    out += BASE58[(h1 ^ h2) % BASE58.length] ?? '1';
  }
  return out;
}
