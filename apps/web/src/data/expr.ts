/**
 * A small evaluator for the declarative expression language in the frozen rule
 * contract. It is used to compute the world's own metrics from raw state, so
 * the dashboard never needs to know what any metric means.
 */
import type { Entity, Expr, MetricDef, WorldState } from '@aw/types';

type Scope = Record<string, unknown>;

function readPath(scope: Scope, path: string): unknown {
  const parts = path.replace(/^\$/, '').split('.');
  let cursor: unknown = scope;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

export function evalExpr(expr: Expr | undefined, scope: Scope): number {
  if (expr === undefined || expr === null) return 0;
  if (typeof expr === 'number') return expr;
  if (typeof expr === 'boolean') return expr ? 1 : 0;
  if (typeof expr === 'string') {
    const parsed = Number(expr);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if ('ref' in expr) {
    const raw = readPath(scope, expr.ref);
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'boolean') return raw ? 1 : 0;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if ('add' in expr) return expr.add.reduce<number>((a, e) => a + evalExpr(e, scope), 0);
  if ('mul' in expr) return expr.mul.reduce<number>((a, e) => a * evalExpr(e, scope), 1);
  if ('sub' in expr) return evalExpr(expr.sub[0], scope) - evalExpr(expr.sub[1], scope);
  if ('div' in expr) {
    const denominator = evalExpr(expr.div[1], scope);
    return denominator === 0 ? 0 : evalExpr(expr.div[0], scope) / denominator;
  }
  if ('min' in expr) return Math.min(...expr.min.map((e) => evalExpr(e, scope)));
  if ('max' in expr) return Math.max(...expr.max.map((e) => evalExpr(e, scope)));
  return 0;
}

export function gini(samples: number[]): number {
  const values = samples.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = values.length;
  if (n === 0) return 0;
  let total = 0;
  let weighted = 0;
  for (let i = 0; i < n; i += 1) {
    const v = values[i] ?? 0;
    total += v;
    weighted += (i + 1) * v;
  }
  if (total === 0) return 0;
  return (2 * weighted) / (n * total) - (n + 1) / n;
}

export function aggregate(def: MetricDef, samples: number[], population: number): number {
  switch (def.aggregate) {
    case 'count':
      return population;
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
    default:
      return 0;
  }
}

/** Evaluates every metric the world declares. Names are never inspected. */
export function computeMetrics(defs: MetricDef[], state: WorldState): Record<string, number> {
  const entities = Object.values(state.entities);
  const out: Record<string, number> = {};
  for (const def of defs) {
    const cohort: Entity[] = def.over ? entities.filter((e) => e.type === def.over) : entities;
    const samples = def.value ? cohort.map((e) => evalExpr(def.value, { e })) : [];
    out[def.id] = aggregate(def, samples, cohort.length);
  }
  return out;
}
