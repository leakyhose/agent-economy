// World-declared metrics. Every aggregate kind in the contract is implemented.

import type { Entity, MetricDef, WorldDefinition, WorldState } from '@aw/types';
import { SCOPE_ENTITY, evalNumber, sortedEntities, type EvalContext } from './expr.ts';

/** Sample the metric's value expression across the entities it ranges over. */
export function metricSamples(def: MetricDef, state: WorldState): number[] {
  const pool: Entity[] = sortedEntities(state).filter(
    (en) => def.over === undefined || en.type === def.over,
  );
  if (def.value === undefined) return pool.map(() => 1);
  const ctx: EvalContext = { state };
  return pool.map((en) => evalNumber(def.value!, { [SCOPE_ENTITY]: en }, ctx));
}

/**
 * Gini coefficient over non-negative samples. 0 = perfectly even, 1 = one
 * holder has everything. Empty or all-zero populations score 0.
 */
export function gini(samples: readonly number[]): number {
  const n = samples.length;
  if (n === 0) return 0;
  const xs = [...samples].sort((a, b) => a - b);
  const total = xs.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let weighted = 0;
  for (let i = 0; i < n; i++) weighted += (i + 1) * (xs[i] as number);
  return (2 * weighted) / (n * total) - (n + 1) / n;
}

export function aggregate(kind: MetricDef['aggregate'], samples: readonly number[]): number {
  switch (kind) {
    case 'count':
      return samples.length;
    case 'sum':
      return samples.reduce((a, b) => a + b, 0);
    case 'mean':
      return samples.length === 0 ? 0 : samples.reduce((a, b) => a + b, 0) / samples.length;
    case 'max':
      return samples.length === 0 ? 0 : Math.max(...samples);
    case 'min':
      return samples.length === 0 ? 0 : Math.min(...samples);
    case 'gini':
      return gini(samples);
    default: {
      const never: never = kind;
      throw new Error(`unknown aggregate "${String(never)}"`);
    }
  }
}

export function computeMetric(def: MetricDef, state: WorldState): number {
  return aggregate(def.aggregate, metricSamples(def, state));
}

export function computeMetrics(world: WorldDefinition, state: WorldState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const def of world.metrics ?? []) out[def.id] = computeMetric(def, state);
  return out;
}
