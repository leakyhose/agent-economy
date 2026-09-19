import { describe, expect, it } from 'vitest';
import type { Entity, WorldState } from '@aw/types';
import { aggregate, computeMetric, gini } from '@aw/engine';

function state(values: number[]): WorldState {
  const entities: Record<string, Entity> = {};
  values.forEach((v, i) => {
    entities[`u_${i}`] = {
      id: `u_${i}`,
      type: 'u',
      attributes: {},
      resources: { c: v },
      relationships: {},
      owns: [],
      state: {},
    };
  });
  entities['other_0'] = {
    id: 'other_0',
    type: 'other',
    attributes: {},
    resources: { c: 9999 },
    relationships: {},
    owns: [],
    state: {},
  };
  return { worldName: 'w', tick: 0, entities, prices: {}, rngCursor: 0 };
}

describe('aggregates', () => {
  it('implements every kind in the contract', () => {
    const xs = [1, 2, 3, 4];
    expect(aggregate('sum', xs)).toBe(10);
    expect(aggregate('mean', xs)).toBe(2.5);
    expect(aggregate('max', xs)).toBe(4);
    expect(aggregate('min', xs)).toBe(1);
    expect(aggregate('count', xs)).toBe(4);
    expect(aggregate('gini', xs)).toBeCloseTo(0.25, 10);
  });

  it('handles an empty population without dividing by zero', () => {
    for (const kind of ['sum', 'mean', 'max', 'min', 'count', 'gini'] as const) {
      expect(Number.isFinite(aggregate(kind, []))).toBe(true);
    }
  });
});

describe('gini', () => {
  it('is 0 under perfect equality', () => {
    expect(gini([5, 5, 5, 5])).toBe(0);
    expect(gini([0, 0, 0])).toBe(0);
    expect(gini([])).toBe(0);
  });

  it('approaches (n-1)/n when one holder has everything', () => {
    expect(gini([0, 0, 0, 4])).toBeCloseTo(0.75, 10);
    expect(gini([0, 10])).toBeCloseTo(0.5, 10);
  });

  it('ignores the order of the samples', () => {
    expect(gini([1, 9, 3, 7])).toBeCloseTo(gini([7, 3, 9, 1]), 12);
  });
});

describe('metric definitions', () => {
  it('ranges only over the declared entity type', () => {
    const s = state([10, 20, 30]);
    expect(
      computeMetric({ id: 'm', aggregate: 'sum', over: 'u', value: { ref: '$e.resources.c' } }, s),
    ).toBe(60);
    expect(computeMetric({ id: 'm', aggregate: 'count', over: 'u' }, s)).toBe(3);
    expect(computeMetric({ id: 'm', aggregate: 'count' }, s)).toBe(4);
  });
});
