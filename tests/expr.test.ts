import { describe, expect, it } from 'vitest';
import type { Entity, WorldState } from '@aw/types';
import { ExprError, evalExpr, evalPredicate, resolvePath, resolveWritable } from '@aw/engine';

function entity(id: string, type: string, resources: Record<string, number>): Entity {
  return { id, type, attributes: { level: 3 }, resources, relationships: {}, owns: [], state: {} };
}

const actor = entity('a_0', 'a', { alpha: 10, beta: 4 });
const other = entity('a_1', 'a', { alpha: 1, beta: 0 });

const state: WorldState = {
  worldName: 'w',
  tick: 0,
  entities: { a_0: actor, a_1: other },
  prices: {},
  rngCursor: 1,
};
const ctx = { state };
const scope = { $actor: actor, $target: other, $params: { which: 'alpha', n: 2 } };

describe('expression evaluator', () => {
  it('resolves static paths', () => {
    expect(resolvePath('$actor.resources.alpha', scope)).toBe(10);
    expect(resolvePath('$actor.attributes.level', scope)).toBe(3);
    expect(resolvePath('$target.resources.beta', scope)).toBe(0);
  });

  it('resolves a dynamic path segment', () => {
    expect(resolvePath('$actor.resources.$params.which', scope)).toBe(10);
    expect(evalExpr({ ref: '$actor.resources.$params.which' }, scope, ctx)).toBe(10);
  });

  it('writes through a dynamic path segment', () => {
    const slot = resolveWritable('$actor.resources.$params.which', scope);
    expect(slot.key).toBe('alpha');
    expect(slot.guarded).toBe(true);
  });

  it('rejects an unknown scope root', () => {
    expect(() => resolvePath('$nope.x', scope)).toThrow(ExprError);
  });

  it('evaluates arithmetic', () => {
    expect(evalExpr({ add: [1, 2, { ref: '$params.n' }] }, scope, ctx)).toBe(5);
    expect(evalExpr({ sub: [10, 4] }, scope, ctx)).toBe(6);
    expect(evalExpr({ mul: [3, { ref: '$params.n' }] }, scope, ctx)).toBe(6);
    expect(evalExpr({ div: [10, 4] }, scope, ctx)).toBe(2.5);
    expect(evalExpr({ min: [5, 2, 9] }, scope, ctx)).toBe(2);
    expect(evalExpr({ max: [5, 2, 9] }, scope, ctx)).toBe(9);
    expect(() => evalExpr({ div: [1, 0] }, scope, ctx)).toThrow(ExprError);
  });

  it('counts entities, optionally filtered', () => {
    expect(evalExpr({ count: { of: 'a' } }, scope, ctx)).toBe(2);
    expect(
      evalExpr({ count: { of: 'a', where: { gt: [{ ref: '$e.resources.alpha' }, 5] } } }, scope, ctx),
    ).toBe(1);
  });

  it('evaluates predicates', () => {
    expect(evalPredicate({ gte: [{ ref: '$actor.resources.alpha' }, 10] }, scope, ctx)).toBe(true);
    expect(evalPredicate({ lt: [{ ref: '$actor.resources.beta' }, 4] }, scope, ctx)).toBe(false);
    expect(evalPredicate({ and: [{ eq: [1, 1] }, { ne: [1, 2] }] }, scope, ctx)).toBe(true);
    expect(evalPredicate({ or: [{ eq: [1, 2] }, { eq: [2, 2] }] }, scope, ctx)).toBe(true);
    expect(evalPredicate({ not: { eq: [1, 2] } }, scope, ctx)).toBe(true);
    expect(evalPredicate({ has: '$actor.attributes.level' }, scope, ctx)).toBe(true);
    expect(evalPredicate({ has: '$actor.attributes.missing' }, scope, ctx)).toBe(false);
  });
});
