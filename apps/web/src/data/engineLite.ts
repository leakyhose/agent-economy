/**
 * A minimal interpreter for the declarative rule language, used only to give the
 * fixture replay plausible dynamics. The real engine lives in the simulation
 * package; this is deliberately small and forgiving, but it reads the same data,
 * so a fixture run obeys whatever rules the loaded world happens to define.
 */
import type { Effect, Entity, EntityId, Expr, Json, Predicate, WorldState } from '@aw/types';
import { evalExpr } from './expr.ts';

export interface RuleScope {
  actor?: Entity;
  target?: Entity;
  params?: Record<string, Json>;
  bindings: Record<string, Entity>;
}

export interface EffectOutcome {
  emits: Array<{ event: string; data: Record<string, Json> }>;
  settlements: Array<{ asset: string; from: EntityId; to: EntityId; amount: number }>;
  spawned: Entity[];
  destroyed: EntityId[];
}

function scopeObject(scope: RuleScope): Record<string, unknown> {
  return { actor: scope.actor, target: scope.target, params: scope.params, ...scope.bindings };
}

/**
 * Expands a dynamic `$params.x` segment so a path can name a chosen resource,
 * as in `$actor.resources.$params.resource`. A leading `$params` is an ordinary
 * read of the proposal's own parameters and is left alone.
 */
function expandSegments(path: string, scope: RuleScope): string[] {
  const raw = path.split('.');
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const segment = raw[i];
    if (segment === undefined) continue;
    if (segment === '$params' && i > 0) {
      const key = raw[i + 1];
      i += 1;
      if (key === undefined) continue;
      const value = scope.params?.[key];
      out.push(typeof value === 'string' ? value : String(value));
      continue;
    }
    out.push(segment);
  }
  return out;
}

function entityFor(token: string, scope: RuleScope): Entity | undefined {
  if (token === '$actor') return scope.actor;
  if (token === '$target') return scope.target;
  return scope.bindings[token];
}

interface WriteTarget {
  container: Record<string, unknown>;
  key: string;
}

function writeTargets(path: string, scope: RuleScope, state: WorldState): WriteTarget[] {
  const segments = expandSegments(path, scope);
  const head = segments[0];
  if (head === undefined) return [];

  const roots: Entity[] = [];
  let rest: string[];

  if (head === '$each') {
    const typeId = segments[1];
    rest = segments.slice(2);
    for (const entity of Object.values(state.entities)) {
      if (!typeId || entity.type === typeId) roots.push(entity);
    }
  } else {
    const entity = entityFor(head, scope);
    if (!entity) return [];
    roots.push(entity);
    rest = segments.slice(1);
  }

  if (rest.length === 0) return [];
  const targets: WriteTarget[] = [];
  for (const root of roots) {
    let cursor: Record<string, unknown> = root as unknown as Record<string, unknown>;
    let reachable = true;
    for (let i = 0; i < rest.length - 1; i += 1) {
      const key = rest[i];
      if (key === undefined) { reachable = false; break; }
      const next = cursor[key];
      if (next === null || typeof next !== 'object') { reachable = false; break; }
      cursor = next as Record<string, unknown>;
    }
    const key = rest[rest.length - 1];
    if (reachable && key !== undefined) targets.push({ container: cursor, key });
  }
  return targets;
}

function numberAt(target: WriteTarget): number {
  const current = target.container[target.key];
  return typeof current === 'number' ? current : 0;
}

export function evalPredicate(predicate: Predicate, scope: RuleScope): boolean {
  const s = scopeObject(scope);
  const n = (e: Expr) => evalExpr(resolveExpr(e, scope), s);
  if ('eq' in predicate) return n(predicate.eq[0]) === n(predicate.eq[1]);
  if ('ne' in predicate) return n(predicate.ne[0]) !== n(predicate.ne[1]);
  if ('gt' in predicate) return n(predicate.gt[0]) > n(predicate.gt[1]);
  if ('gte' in predicate) return n(predicate.gte[0]) >= n(predicate.gte[1]);
  if ('lt' in predicate) return n(predicate.lt[0]) < n(predicate.lt[1]);
  if ('lte' in predicate) return n(predicate.lte[0]) <= n(predicate.lte[1]);
  if ('and' in predicate) return predicate.and.every((p) => evalPredicate(p, scope));
  if ('or' in predicate) return predicate.or.some((p) => evalPredicate(p, scope));
  if ('not' in predicate) return !evalPredicate(predicate.not, scope);
  if ('has' in predicate) {
    const segments = expandSegments(predicate.has, scope);
    const head = segments[0];
    if (head === undefined) return false;
    let cursor: unknown = entityFor(head, scope);
    for (const segment of segments.slice(1)) {
      if (cursor === null || typeof cursor !== 'object') return false;
      cursor = (cursor as Record<string, unknown>)[segment];
    }
    return cursor !== undefined && cursor !== null;
  }
  return true;
}

/** Rewrites `$params.x` inside ref paths before the expression is evaluated. */
function resolveExpr(expr: Expr, scope: RuleScope): Expr {
  if (!expr || typeof expr !== 'object') return expr;
  if ('ref' in expr) return { ref: expandSegments(expr.ref, scope).join('.').replace(/^\$/, '') };
  if ('add' in expr) return { add: expr.add.map((e) => resolveExpr(e, scope)) };
  if ('mul' in expr) return { mul: expr.mul.map((e) => resolveExpr(e, scope)) };
  if ('sub' in expr) return { sub: [resolveExpr(expr.sub[0], scope), resolveExpr(expr.sub[1], scope)] };
  if ('div' in expr) return { div: [resolveExpr(expr.div[0], scope), resolveExpr(expr.div[1], scope)] };
  if ('min' in expr) return { min: expr.min.map((e) => resolveExpr(e, scope)) };
  if ('max' in expr) return { max: expr.max.map((e) => resolveExpr(e, scope)) };
  return expr;
}

function relate(from: Entity, to: Entity, kind: string): void {
  const bucket = from.relationships[kind] ?? [];
  if (!bucket.includes(to.id)) bucket.push(to.id);
  from.relationships[kind] = bucket;
}

export function applyEffects(
  effects: Effect[],
  scope: RuleScope,
  state: WorldState,
  makeEntity: (type: string, attributes: Record<string, Json>) => Entity,
): EffectOutcome {
  const outcome: EffectOutcome = { emits: [], settlements: [], spawned: [], destroyed: [] };
  const s = scopeObject(scope);

  for (const effect of effects) {
    switch (effect.op) {
      case 'set': {
        for (const t of writeTargets(effect.path, scope, state)) {
          const value = effect.value;
          t.container[t.key] = typeof value === 'object' && value !== null
            ? evalExpr(resolveExpr(value, scope), s)
            : (value as Json);
        }
        break;
      }
      case 'increment': {
        const by = evalExpr(resolveExpr(effect.by, scope), s);
        for (const t of writeTargets(effect.path, scope, state)) {
          t.container[t.key] = numberAt(t) + by;
        }
        break;
      }
      case 'decrement': {
        const by = evalExpr(resolveExpr(effect.by, scope), s);
        for (const t of writeTargets(effect.path, scope, state)) {
          t.container[t.key] = Math.max(0, numberAt(t) - by);
        }
        break;
      }
      case 'relate': {
        const from = entityFor(expandSegments(effect.from, scope)[0] ?? '', scope);
        const to = entityFor(expandSegments(effect.to, scope)[0] ?? '', scope);
        if (from && to && from.id !== to.id) relate(from, to, effect.kind);
        break;
      }
      case 'unrelate': {
        const from = entityFor(expandSegments(effect.from, scope)[0] ?? '', scope);
        const to = entityFor(expandSegments(effect.to, scope)[0] ?? '', scope);
        if (from && to) {
          const bucket = from.relationships[effect.kind];
          if (bucket) from.relationships[effect.kind] = bucket.filter((id) => id !== to.id);
        }
        break;
      }
      case 'spawn': {
        const attributes: Record<string, Json> = {};
        for (const [key, expr] of Object.entries(effect.attributes ?? {})) {
          attributes[key] = typeof expr === 'object' && expr !== null
            ? evalExpr(resolveExpr(expr, scope), s)
            : (expr as Json);
        }
        const entity = makeEntity(effect.type, attributes);
        state.entities[entity.id] = entity;
        outcome.spawned.push(entity);
        if (effect.bind) scope.bindings[effect.bind] = entity;
        break;
      }
      case 'destroy': {
        const entity = entityFor(expandSegments(effect.path, scope)[0] ?? '', scope);
        if (entity) {
          delete state.entities[entity.id];
          outcome.destroyed.push(entity.id);
        }
        break;
      }
      case 'settle': {
        const from = entityFor(expandSegments(effect.from, scope)[0] ?? '', scope);
        const to = entityFor(expandSegments(effect.to, scope)[0] ?? '', scope);
        if (from && to) {
          outcome.settlements.push({
            asset: effect.asset,
            from: from.id,
            to: to.id,
            amount: evalExpr(resolveExpr(effect.amount, scope), s),
          });
        }
        break;
      }
      case 'emit': {
        const data: Record<string, Json> = {};
        for (const [key, expr] of Object.entries(effect.data ?? {})) {
          data[key] = typeof expr === 'object' && expr !== null
            ? evalExpr(resolveExpr(expr, scope), s)
            : (expr as Json);
        }
        outcome.emits.push({ event: effect.event, data });
        break;
      }
      default:
        break;
    }
  }
  return outcome;
}
