/**
 * Personality. Four scalars, drawn from a seed so a population is diverse but
 * a run is reproducible. They are inputs to scoring, never to validation.
 */

import { makeRng, mixSeed } from './rng.ts';

export interface Traits {
  /** 0 = refuses variance, 1 = happily bets the balance. */
  riskTolerance: number;
  /** 0 = wants payoff now, 1 = will sit through a long action. */
  patience: number;
  /** 0 = ignores what others do, 1 = copies the crowd. */
  herding: number;
  /** How many recent observations this agent keeps in the short store. */
  memoryLength: number;
}

export interface TraitOverrides {
  riskTolerance?: number;
  patience?: number;
  herding?: number;
  memoryLength?: number;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Deterministic in (seed, id): the same agent always has the same character. */
export function makeTraits(seed: number, id: string, overrides: TraitOverrides = {}): Traits {
  const rng = makeRng(mixSeed(seed, `traits:${id}`));
  const drawn: Traits = {
    riskTolerance: round(rng.next()),
    patience: round(rng.next()),
    herding: round(rng.next()),
    memoryLength: 6 + rng.int(13),
  };
  return {
    riskTolerance: clamp01(overrides.riskTolerance ?? drawn.riskTolerance),
    patience: clamp01(overrides.patience ?? drawn.patience),
    herding: clamp01(overrides.herding ?? drawn.herding),
    memoryLength:
      Number.isFinite(overrides.memoryLength) && (overrides.memoryLength ?? 0) > 0
        ? Math.trunc(overrides.memoryLength as number)
        : drawn.memoryLength,
  };
}

export const NEUTRAL_TRAITS: Traits = {
  riskTolerance: 0.5,
  patience: 0.5,
  herding: 0.5,
  memoryLength: 12,
};
