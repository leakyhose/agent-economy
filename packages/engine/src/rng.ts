// Seeded PRNG. mulberry32.
//
// The generator is a pure function of a 32-bit cursor, and that cursor lives in
// `WorldState.rngCursor`. A snapshot therefore fully determines the future.
// There is no hidden generator instance, no ambient randomness and no clock
// anywhere in this package.

export interface Draw {
  value: number;
  cursor: number;
}

/** Derive the initial cursor for a world seed. */
export function seedCursor(seed: number): number {
  return seed >>> 0;
}

/** One mulberry32 step: returns a float in [0, 1) and the advanced cursor. */
export function nextRandom(cursor: number): Draw {
  const a = (cursor + 0x6d2b79f5) | 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, cursor: a >>> 0 };
}

/** Uniform integer in [0, bound). `bound <= 0` yields 0. */
export function nextInt(cursor: number, bound: number): Draw {
  const d = nextRandom(cursor);
  if (bound <= 0) return { value: 0, cursor: d.cursor };
  return { value: Math.floor(d.value * bound), cursor: d.cursor };
}

/**
 * Convenience cursor holder for callers that want a stream rather than a fold.
 * It never reads a clock and never touches global state.
 */
export class Rng {
  constructor(public cursor: number) {}

  static fromSeed(seed: number): Rng {
    return new Rng(seedCursor(seed));
  }

  next(): number {
    const d = nextRandom(this.cursor);
    this.cursor = d.cursor;
    return d.value;
  }

  int(bound: number): number {
    const d = nextInt(this.cursor, bound);
    this.cursor = d.cursor;
    return d.value;
  }

  pick<T>(items: readonly T[]): T | undefined {
    if (items.length === 0) return undefined;
    return items[this.int(items.length)];
  }
}
