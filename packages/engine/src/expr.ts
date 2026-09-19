// Expression + predicate evaluator for the declarative rule language.
//
// Everything here is generic: the evaluator resolves paths against a scope and
// knows nothing about the meaning of any identifier it walks through.

import type { Entity, Expr, Json, Predicate, WorldState } from '@aw/types';

/** Scope roots understood by the evaluator. */
export const SCOPE_ACTOR = '$actor';
export const SCOPE_TARGET = '$target';
export const SCOPE_PARAMS = '$params';
export const SCOPE_NEW = '$new';
export const SCOPE_ENTITY = '$e';
export const SCOPE_BROADCAST = '$each';

/** Every root a path may legally start with (before `$each.<type>` expansion). */
export const SCOPE_ROOTS: readonly string[] = [
  SCOPE_ACTOR,
  SCOPE_TARGET,
  SCOPE_PARAMS,
  SCOPE_NEW,
  SCOPE_ENTITY,
  SCOPE_BROADCAST,
];

/**
 * A scope maps a root key to a value. Broadcast bindings are stored under the
 * composite key `$each.<entityType>`, which is what the path spells out.
 */
export type Scope = Record<string, unknown>;

export class ExprError extends Error {}

export interface EvalContext {
  state: WorldState;
}

// ---------------------------------------------------------------------------
// Path handling
// ---------------------------------------------------------------------------

export function splitPath(path: string): string[] {
  return path.split('.').filter((s) => s.length > 0);
}

/** The scope key a path addresses, plus the remaining segments. */
export function pathRoot(path: string): { key: string; rest: string[] } {
  const parts = splitPath(path);
  const head = parts[0] ?? '';
  if (head === SCOPE_BROADCAST) {
    const type = parts[1];
    if (type === undefined) throw new ExprError(`broadcast path is missing a type: "${path}"`);
    return { key: `${SCOPE_BROADCAST}.${type}`, rest: parts.slice(2) };
  }
  return { key: head, rest: parts.slice(1) };
}

function isIndexable(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Walk `segments` from `base`. A segment beginning with `$` is itself a path:
 * the shortest suffix prefix that resolves to a string or number is consumed
 * and its value used as the key. This is what makes
 * `$actor.resources.$params.resource` work.
 */
function walk(base: unknown, segments: string[], scope: Scope): unknown {
  let cursor: unknown = base;
  let i = 0;
  while (i < segments.length) {
    const seg = segments[i] as string;
    let key = seg;
    let consumed = 1;
    if (seg.startsWith('$')) {
      const resolved = resolveDynamicSegment(segments, i, scope);
      key = resolved.key;
      consumed = resolved.consumed;
    }
    if (!isIndexable(cursor)) return undefined;
    cursor = cursor[key];
    i += consumed;
  }
  return cursor;
}

function resolveDynamicSegment(
  segments: string[],
  start: number,
  scope: Scope,
): { key: string; consumed: number } {
  for (let len = 1; start + len <= segments.length; len++) {
    const sub = segments.slice(start, start + len).join('.');
    let value: unknown;
    try {
      value = resolvePath(sub, scope);
    } catch {
      value = undefined;
    }
    if (typeof value === 'string' || typeof value === 'number') {
      return { key: String(value), consumed: len };
    }
  }
  throw new ExprError(
    `dynamic path segment "${segments.slice(start).join('.')}" did not resolve to a key`,
  );
}

/** Resolve a path to a value, or `undefined` if any step is missing. */
export function resolvePath(path: string, scope: Scope): unknown {
  const { key, rest } = pathRoot(path);
  if (!(key in scope)) {
    throw new ExprError(`unknown scope root "${key}" in path "${path}"`);
  }
  return walk(scope[key], rest, scope);
}

export interface Writable {
  container: Record<string, unknown>;
  key: string;
  /** True when the slot lives under a `resources` map, which may not go below 0. */
  guarded: boolean;
}

/** Resolve a path down to its parent container and final key, for mutation. */
export function resolveWritable(path: string, scope: Scope): Writable {
  const { key: rootKey, rest } = pathRoot(path);
  if (!(rootKey in scope)) {
    throw new ExprError(`unknown scope root "${rootKey}" in path "${path}"`);
  }
  if (rest.length === 0) {
    throw new ExprError(`path "${path}" addresses a scope root, which is not writable`);
  }

  // Materialise the concrete key sequence first (dynamic segments resolved).
  const keys: string[] = [];
  let i = 0;
  while (i < rest.length) {
    const seg = rest[i] as string;
    if (seg.startsWith('$')) {
      const resolved = resolveDynamicSegment(rest, i, scope);
      keys.push(resolved.key);
      i += resolved.consumed;
    } else {
      keys.push(seg);
      i += 1;
    }
  }

  let container: unknown = scope[rootKey];
  for (let k = 0; k < keys.length - 1; k++) {
    if (!isIndexable(container)) {
      throw new ExprError(`path "${path}" runs through a non-object at "${keys[k]}"`);
    }
    container = container[keys[k] as string];
  }
  if (!isIndexable(container)) {
    throw new ExprError(`path "${path}" has no container to write into`);
  }
  return {
    container,
    key: keys[keys.length - 1] as string,
    guarded: keys.includes('resources'),
  };
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

function num(v: unknown, what: string): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === undefined || v === null) return 0;
  throw new ExprError(`${what} is not numeric: ${JSON.stringify(v)}`);
}

export function evalExpr(expr: Expr, scope: Scope, ctx: EvalContext): Json {
  if (expr === null) return null;
  const t = typeof expr;
  if (t === 'number' || t === 'string' || t === 'boolean') return expr as Json;

  const e = expr as Record<string, unknown>;

  if ('ref' in e) {
    const v = resolvePath(e['ref'] as string, scope);
    return (v === undefined ? null : v) as Json;
  }
  if ('add' in e) {
    return (e['add'] as Expr[]).reduce<number>(
      (acc, x) => acc + num(evalExpr(x, scope, ctx), 'add operand'),
      0,
    );
  }
  if ('sub' in e) {
    const [a, b] = e['sub'] as [Expr, Expr];
    return num(evalExpr(a, scope, ctx), 'sub operand') - num(evalExpr(b, scope, ctx), 'sub operand');
  }
  if ('mul' in e) {
    return (e['mul'] as Expr[]).reduce<number>(
      (acc, x) => acc * num(evalExpr(x, scope, ctx), 'mul operand'),
      1,
    );
  }
  if ('div' in e) {
    const [a, b] = e['div'] as [Expr, Expr];
    const d = num(evalExpr(b, scope, ctx), 'div operand');
    if (d === 0) throw new ExprError('division by zero');
    return num(evalExpr(a, scope, ctx), 'div operand') / d;
  }
  if ('min' in e) {
    const xs = (e['min'] as Expr[]).map((x) => num(evalExpr(x, scope, ctx), 'min operand'));
    if (xs.length === 0) throw new ExprError('min needs at least one operand');
    return Math.min(...xs);
  }
  if ('max' in e) {
    const xs = (e['max'] as Expr[]).map((x) => num(evalExpr(x, scope, ctx), 'max operand'));
    if (xs.length === 0) throw new ExprError('max needs at least one operand');
    return Math.max(...xs);
  }
  if ('count' in e) {
    const spec = e['count'] as { of: string; where?: Predicate };
    return countEntities(spec, scope, ctx);
  }
  throw new ExprError(`unrecognised expression: ${JSON.stringify(expr)}`);
}

export function evalNumber(expr: Expr, scope: Scope, ctx: EvalContext): number {
  return num(evalExpr(expr, scope, ctx), 'expression');
}

function entitiesOfType(state: WorldState, type: string): Entity[] {
  return sortedEntities(state).filter((en) => en.type === type);
}

/** Deterministic entity ordering: ascending id. Used everywhere order matters. */
export function sortedEntities(state: WorldState): Entity[] {
  return Object.keys(state.entities)
    .sort()
    .map((id) => state.entities[id] as Entity);
}

function countEntities(
  spec: { of: string; where?: Predicate },
  scope: Scope,
  ctx: EvalContext,
): number {
  const candidates = entitiesOfType(ctx.state, spec.of);
  if (!spec.where) return candidates.length;
  let n = 0;
  for (const en of candidates) {
    const inner: Scope = { ...scope, [SCOPE_ENTITY]: en };
    if (evalPredicate(spec.where, inner, ctx)) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

function compare(a: Json, b: Json): number {
  if (typeof a === 'number' || typeof b === 'number') {
    return num(a, 'comparison operand') - num(b, 'comparison operand');
  }
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function looseEqual(a: Json, b: Json): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  if (typeof a === typeof b) return a === b;
  if (typeof a === 'number' || typeof b === 'number') {
    return num(a, 'eq operand') === num(b, 'eq operand');
  }
  return String(a) === String(b);
}

export function evalPredicate(pred: Predicate, scope: Scope, ctx: EvalContext): boolean {
  const p = pred as Record<string, unknown>;
  const pair = (k: string): [Json, Json] => {
    const [a, b] = p[k] as [Expr, Expr];
    return [evalExpr(a, scope, ctx), evalExpr(b, scope, ctx)];
  };

  if ('eq' in p) { const [a, b] = pair('eq'); return looseEqual(a, b); }
  if ('ne' in p) { const [a, b] = pair('ne'); return !looseEqual(a, b); }
  if ('gt' in p) { const [a, b] = pair('gt'); return compare(a, b) > 0; }
  if ('gte' in p) { const [a, b] = pair('gte'); return compare(a, b) >= 0; }
  if ('lt' in p) { const [a, b] = pair('lt'); return compare(a, b) < 0; }
  if ('lte' in p) { const [a, b] = pair('lte'); return compare(a, b) <= 0; }
  if ('and' in p) return (p['and'] as Predicate[]).every((q) => evalPredicate(q, scope, ctx));
  if ('or' in p) return (p['or'] as Predicate[]).some((q) => evalPredicate(q, scope, ctx));
  if ('not' in p) return !evalPredicate(p['not'] as Predicate, scope, ctx);
  if ('has' in p) {
    let v: unknown;
    try {
      v = resolvePath(p['has'] as string, scope);
    } catch {
      return false;
    }
    return v !== undefined && v !== null;
  }
  throw new ExprError(`unrecognised predicate: ${JSON.stringify(pred)}`);
}

/** Human-readable rendering of a predicate, for rejection messages. */
export function describePredicate(pred: Predicate): string {
  return JSON.stringify(pred);
}
