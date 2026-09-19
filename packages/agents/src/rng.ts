/**
 * Deterministic pseudo-randomness.
 *
 * Every non-deterministic-looking choice in this package routes through here so
 * that "same seed + same observation => same proposal" is a testable property.
 */

/** FNV-1a over a string. Stable across runs and platforms. */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mix a numeric seed with an arbitrary label into a new 32-bit seed. */
export function mixSeed(seed: number, label: string): number {
  return (hashString(label) ^ Math.imul(seed >>> 0, 0x9e3779b1)) >>> 0;
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Integer in [0, bound). Returns 0 when bound <= 0. */
  int(bound: number): number;
  /** Deterministic pick, or undefined for an empty list. */
  pick<T>(items: readonly T[]): T | undefined;
}

/** mulberry32 — small, fast, good enough, and completely reproducible. */
export function makeRng(seed: number): Rng {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (bound: number): number => (bound <= 0 ? 0 : Math.floor(next() * bound) % bound);
  return {
    next,
    int,
    pick<T>(items: readonly T[]): T | undefined {
      if (items.length === 0) return undefined;
      return items[int(items.length)];
    },
  };
}

/**
 * A stable score in [0, 1) derived from a seed and a label. Used for
 * tie-breaking: unlike `makeRng`, it does not depend on how many draws came
 * before it, so adding a candidate never reshuffles the others.
 */
export function jitter(seed: number, label: string): number {
  return makeRng(mixSeed(seed, label)).next();
}
