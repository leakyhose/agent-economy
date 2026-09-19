/** Deterministic PRNG so a given world seed always replays the same fixture run. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, items: readonly T[]): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(rng() * items.length)];
}

export function between(rng: () => number, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}

export function intBetween(rng: () => number, lo: number, hi: number): number {
  return Math.floor(between(rng, lo, hi + 1));
}

/** Box-Muller, clamped, for price walks that do not look like a sawtooth. */
export function gaussian(rng: () => number): number {
  const u = Math.max(rng(), 1e-9);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58(rng: () => number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += BASE58[Math.floor(rng() * BASE58.length)] ?? '1';
  }
  return out;
}
