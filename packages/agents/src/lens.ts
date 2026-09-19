/**
 * A structural reading of a world definition.
 *
 * The decision engines need to know things like "which resource do people pay
 * with" and "which actions produce something" — but they must not know the
 * answers in advance. This module derives them at runtime from the shape of the
 * world data: its markets, its stated action parameters, and the paths its
 * rules touch. Nothing here is keyed off a literal name, so both fixtures (and
 * any world a user writes later) read identically.
 */

import type {
  ActionDef,
  ActionParamDef,
  Entity,
  EntityTypeId,
  Json,
  ResourceId,
  Predicate,
  Rule,
  WorldDefinition,
} from '@aw/types';

export type ActionShape = 'produce' | 'offer' | 'acquire' | 'social' | 'other';

export interface ActionInfo {
  id: string;
  shape: ActionShape;
  description: string;
  duration: number;
  params: ActionParamDef[];
  actorTypes: EntityTypeId[];
  targetTypes: EntityTypeId[];
  /** Resources a rule increments on the actor when this action fires. */
  produces: ResourceId[];
  /** Resources a rule decrements on the actor when this action fires. */
  consumes: ResourceId[];
  /** Attributes a rule raises on the actor. */
  raises: string[];
  /** True when a precondition reads the actor's stock of a parameter resource. */
  stakesOwnStock: boolean;
  /** True when a precondition reads the actor's balance of the pay resource. */
  stakesPayResource: boolean;
  /** Rules that fire on this action, in definition order. */
  rules: Rule[];
}

export interface WorldLens {
  worldName: string;
  /** Every resource the world states, in definition order. */
  resourceIds: ResourceId[];
  /** What things are priced in, inferred from the markets. */
  payResource: ResourceId | null;
  /** Resources with a market, in definition order. */
  tradedResources: ResourceId[];
  /** market id keyed by resource, so prices can be looked up. */
  marketOf: Record<ResourceId, string>;
  /** Resources that decay if held. Holding these is a running cost. */
  perishables: ResourceId[];
  /** Starting price per resource, where the world states one. */
  priceHints: Record<ResourceId, number>;
  /** Attributes the world raises on a timer: pressures the agent should relieve. */
  pressureAttributes: string[];
  /** Every action, keyed by id. */
  actions: Record<string, ActionInfo>;
  actionIds: string[];
  /** Action ids an entity of this type may attempt. */
  actionsFor(entityType: EntityTypeId): string[];
  info(actionId: string): ActionInfo | null;
}

const RESOURCE_PREFIX = '$actor.resources.';
const ATTRIBUTE_PREFIX = '$actor.attributes.';
const PARAM_PREFIX = '$params.';

function collectRefs(node: unknown, out: string[]): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out);
    return;
  }
  const record = node as Record<string, unknown>;
  const ref = record['ref'];
  if (typeof ref === 'string') out.push(ref);
  for (const key of Object.keys(record)) collectRefs(record[key], out);
}

function suffixAfter(path: string, prefix: string): string | null {
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  if (rest.length === 0 || rest.includes('.')) return null;
  return rest;
}

function pushUnique<T>(list: T[], value: T): void {
  if (!list.includes(value)) list.push(value);
}

/** The pay resource is whatever the world's markets settle in. */
function inferPayResource(world: WorldDefinition): ResourceId | null {
  const tally = new Map<string, number>();
  for (const m of world.markets ?? []) {
    tally.set(m.currency, (tally.get(m.currency) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [id, n] of tally) {
    if (n > bestCount || (n === bestCount && best !== null && id < best)) {
      best = id;
      bestCount = n;
    }
  }
  if (best) return best;
  // No markets: fall back to the divisible resource with the lowest price hint.
  const divisible = world.resources.filter((r) => r.divisible);
  const pool = divisible.length > 0 ? divisible : world.resources;
  let pick: ResourceId | null = null;
  let pickPrice = Number.POSITIVE_INFINITY;
  for (const r of pool) {
    const price = typeof r.startPrice === 'number' ? r.startPrice : Number.POSITIVE_INFINITY;
    if (price < pickPrice) {
      pick = r.id;
      pickPrice = price;
    }
  }
  return pick ?? (pool[0]?.id ?? null);
}

/** Attributes that a timed rule raises on everyone: the world's built-in needs. */
function inferPressures(world: WorldDefinition): string[] {
  const out: string[] = [];
  for (const rule of world.rules) {
    if (!rule.when?.tick) continue;
    for (const effect of rule.effects) {
      if (effect.op !== 'increment') continue;
      const parts = effect.path.split('.');
      // $each.<type>.attributes.<attr>  or  $actor.attributes.<attr>
      if (parts.length >= 2 && parts[parts.length - 2] === 'attributes') {
        const attr = parts[parts.length - 1];
        if (attr) pushUnique(out, attr);
      }
    }
  }
  return out;
}

function analyseAction(def: ActionDef, world: WorldDefinition, payResource: ResourceId | null): ActionInfo {
  const rules = world.rules.filter((r) => r.when?.action === def.id);
  const produces: ResourceId[] = [];
  const consumes: ResourceId[] = [];
  const raises: string[] = [];

  for (const rule of rules) {
    for (const effect of rule.effects) {
      if (effect.op === 'increment' || effect.op === 'decrement') {
        const resource = suffixAfter(effect.path, RESOURCE_PREFIX);
        if (resource) {
          if (effect.op === 'increment') pushUnique(produces, resource);
          else pushUnique(consumes, resource);
          continue;
        }
        const attribute = suffixAfter(effect.path, ATTRIBUTE_PREFIX);
        if (attribute && effect.op === 'increment') pushUnique(raises, attribute);
      }
    }
  }

  const requireRefs: string[] = [];
  for (const rule of rules) collectRefs(rule.require ?? [], requireRefs);
  const stakesOwnStock = requireRefs.some((p) => p.startsWith(`${RESOURCE_PREFIX}${PARAM_PREFIX}`));
  const stakesPayResource =
    payResource !== null && requireRefs.includes(`${RESOURCE_PREFIX}${payResource}`);

  const params = def.params ?? [];
  const actorTypes = def.actorTypes ?? [];
  const targetTypes = def.targetTypes ?? [];

  let shape: ActionShape = 'other';
  if (stakesOwnStock) shape = 'offer';
  else if (stakesPayResource && params.some((p) => p.type === 'resource')) shape = 'acquire';
  else if (produces.length > 0 && params.length === 0) shape = 'produce';
  else if (targetTypes.length > 0) shape = 'social';

  return {
    id: def.id,
    shape,
    description: def.description ?? '',
    duration: typeof def.duration === 'number' && def.duration > 0 ? def.duration : 1,
    params,
    actorTypes,
    targetTypes,
    produces,
    consumes,
    raises,
    stakesOwnStock,
    stakesPayResource,
    rules,
  };
}

export function makeLens(world: WorldDefinition): WorldLens {
  const payResource = inferPayResource(world);
  const tradedResources: ResourceId[] = [];
  const marketOf: Record<ResourceId, string> = {};
  for (const m of world.markets ?? []) {
    pushUnique(tradedResources, m.resource);
    if (marketOf[m.resource] === undefined) marketOf[m.resource] = m.id;
  }
  if (tradedResources.length === 0) {
    for (const r of world.resources) if (r.id !== payResource) pushUnique(tradedResources, r.id);
  }

  const perishables: ResourceId[] = [];
  const priceHints: Record<ResourceId, number> = {};
  for (const r of world.resources) {
    if (typeof r.spoilage === 'number' && r.spoilage > 0) perishables.push(r.id);
    if (typeof r.startPrice === 'number') priceHints[r.id] = r.startPrice;
  }

  const actions: Record<string, ActionInfo> = {};
  const actionIds: string[] = [];
  for (const def of world.actions) {
    actions[def.id] = analyseAction(def, world, payResource);
    actionIds.push(def.id);
  }

  return {
    worldName: world.name,
    resourceIds: world.resources.map((r) => r.id),
    payResource,
    tradedResources,
    marketOf,
    perishables,
    priceHints,
    pressureAttributes: inferPressures(world),
    actions,
    actionIds,
    actionsFor(entityType: EntityTypeId): string[] {
      return actionIds.filter((id) => {
        const info = actions[id];
        if (!info) return false;
        return info.actorTypes.length === 0 || info.actorTypes.includes(entityType);
      });
    },
    info(actionId: string): ActionInfo | null {
      return actions[actionId] ?? null;
    },
  };
}

// -- expression estimation ---------------------------------------------------

export interface EstimateScope {
  self: Entity;
  params?: Record<string, Json>;
}

function numeric(value: Json | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function resolvePath(path: string, scope: EstimateScope): number | null {
  // "$actor.resources.$params.x" — the stock of whichever resource the
  // parameter names. Indirection the rule language allows, so we follow it.
  if (path.startsWith(`${RESOURCE_PREFIX}${PARAM_PREFIX}`)) {
    const paramName = path.slice(RESOURCE_PREFIX.length + PARAM_PREFIX.length);
    if (!paramName || paramName.includes('.') || !scope.params) return null;
    const named = scope.params[paramName];
    if (typeof named !== 'string') return null;
    return numeric(scope.self.resources[named] ?? 0);
  }
  const resource = suffixAfter(path, RESOURCE_PREFIX);
  if (resource) return numeric(scope.self.resources[resource] ?? 0);
  const attribute = suffixAfter(path, ATTRIBUTE_PREFIX);
  if (attribute) return numeric(scope.self.attributes[attribute]);
  const param = suffixAfter(path, PARAM_PREFIX);
  if (param && scope.params) return numeric(scope.params[param]);
  return null;
}

/**
 * Best-effort numeric value of a rule expression, used to guess what an action
 * would yield. Returns null when any part of it cannot be resolved, so callers
 * can tell "zero" apart from "no idea".
 */
export function estimateExpr(expr: unknown, scope: EstimateScope): number | null {
  if (typeof expr === 'number') return Number.isFinite(expr) ? expr : null;
  if (typeof expr === 'boolean') return expr ? 1 : 0;
  if (expr === null || typeof expr !== 'object') return null;
  const node = expr as Record<string, unknown>;

  if (typeof node['ref'] === 'string') return resolvePath(node['ref'], scope);

  const fold = (key: string, reduce: (acc: number, n: number) => number): number | null => {
    const raw = node[key];
    if (!Array.isArray(raw) || raw.length === 0) return null;
    let acc: number | null = null;
    for (const part of raw) {
      const value = estimateExpr(part, scope);
      if (value === null) return null;
      acc = acc === null ? value : reduce(acc, value);
    }
    return acc;
  };

  if ('add' in node) return fold('add', (a, b) => a + b);
  if ('mul' in node) return fold('mul', (a, b) => a * b);
  if ('min' in node) return fold('min', (a, b) => Math.min(a, b));
  if ('max' in node) return fold('max', (a, b) => Math.max(a, b));
  if ('sub' in node) return fold('sub', (a, b) => a - b);
  if ('div' in node) return fold('div', (a, b) => (b === 0 ? Number.NaN : a / b));
  return null;
}

/** Expected net change to each resource if `info`'s rules all fire. */
export function estimateDeltas(
  info: ActionInfo,
  scope: EstimateScope,
): Record<ResourceId, number> {
  const out: Record<ResourceId, number> = {};
  for (const rule of info.rules) {
    for (const effect of rule.effects) {
      if (effect.op !== 'increment' && effect.op !== 'decrement') continue;
      const resource = suffixAfter(effect.path, RESOURCE_PREFIX);
      if (!resource) continue;
      const amount = estimateExpr(effect.by, scope);
      if (amount === null) continue;
      const sign = effect.op === 'increment' ? 1 : -1;
      out[resource] = (out[resource] ?? 0) + sign * amount;
    }
  }
  return out;
}

// -- precondition checking ----------------------------------------------------

/**
 * Evaluate one of a rule's stated preconditions. Returns null when any part of
 * it refers to something outside this scope, so a caller can distinguish
 * "this would be rejected" from "cannot tell from here".
 */
export function evalPredicate(predicate: Predicate, scope: EstimateScope): boolean | null {
  const compare = (
    sides: readonly [unknown, unknown],
    test: (a: number, b: number) => boolean,
  ): boolean | null => {
    const left = estimateExpr(sides[0], scope);
    const right = estimateExpr(sides[1], scope);
    if (left === null || right === null) return null;
    return test(left, right);
  };

  if ('gte' in predicate) return compare(predicate.gte, (a, b) => a >= b);
  if ('gt' in predicate) return compare(predicate.gt, (a, b) => a > b);
  if ('lte' in predicate) return compare(predicate.lte, (a, b) => a <= b);
  if ('lt' in predicate) return compare(predicate.lt, (a, b) => a < b);
  if ('eq' in predicate) return compare(predicate.eq, (a, b) => a === b);
  if ('ne' in predicate) return compare(predicate.ne, (a, b) => a !== b);
  if ('and' in predicate) {
    let verdict: boolean | null = true;
    for (const child of predicate.and) {
      const inner = evalPredicate(child, scope);
      if (inner === false) return false;
      if (inner === null) verdict = null;
    }
    return verdict;
  }
  if ('or' in predicate) {
    let verdict: boolean | null = false;
    for (const child of predicate.or) {
      const inner = evalPredicate(child, scope);
      if (inner === true) return true;
      if (inner === null) verdict = null;
    }
    return verdict;
  }
  if ('not' in predicate) {
    const inner = evalPredicate(predicate.not, scope);
    return inner === null ? null : !inner;
  }
  return null;
}

/**
 * False only when a precondition we can fully evaluate would reject the action.
 * Unknowable preconditions are left to the engine, which is the authority.
 */
export function satisfiable(info: ActionInfo, scope: EstimateScope): boolean {
  for (const rule of info.rules) {
    for (const predicate of rule.require ?? []) {
      if (evalPredicate(predicate, scope) === false) return false;
    }
  }
  return true;
}
