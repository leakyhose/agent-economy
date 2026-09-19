// World loader and referential-integrity validator.
//
// A malformed world must fail here, loudly, with a message that names the
// offending id -- never as a mystery crash forty ticks into a run.

import type {
  Effect,
  Expr,
  MetricDef,
  Predicate,
  Rule,
  WorldDefinition,
  WorldEventDef,
} from '@aw/types';

import {
  SCOPE_ACTOR,
  SCOPE_BROADCAST,
  SCOPE_ENTITY,
  SCOPE_NEW,
  SCOPE_PARAMS,
  SCOPE_TARGET,
  pathRoot,
} from './expr.ts';

export class WorldValidationError extends Error {
  constructor(
    public readonly world: string,
    public readonly problems: string[],
  ) {
    super(
      `world "${world}" is invalid:\n  - ${problems.join('\n  - ')}`,
    );
    this.name = 'WorldValidationError';
  }
}

const SUPPORTED_MECHANISMS = ['batch_auction', 'fixed_price'];

interface Ctx {
  world: WorldDefinition;
  problems: string[];
  entityTypeIds: Set<string>;
  resourceIds: Set<string>;
  actionIds: Set<string>;
}

// ---------------------------------------------------------------------------
// Path collection
// ---------------------------------------------------------------------------

function collectExprPaths(expr: Expr | undefined, sink: string[], ctx: Ctx, where: string): void {
  if (expr === null || expr === undefined) return;
  if (typeof expr !== 'object') return;
  const e = expr as Record<string, unknown>;
  if ('ref' in e) {
    if (typeof e['ref'] !== 'string') ctx.problems.push(`${where}: "ref" must be a string`);
    else sink.push(e['ref']);
    return;
  }
  for (const key of ['add', 'mul', 'min', 'max'] as const) {
    if (key in e) {
      const list = e[key];
      if (!Array.isArray(list)) {
        ctx.problems.push(`${where}: "${key}" must be an array`);
        return;
      }
      list.forEach((x) => collectExprPaths(x as Expr, sink, ctx, where));
      return;
    }
  }
  for (const key of ['sub', 'div'] as const) {
    if (key in e) {
      const list = e[key];
      if (!Array.isArray(list) || list.length !== 2) {
        ctx.problems.push(`${where}: "${key}" must be a pair`);
        return;
      }
      list.forEach((x) => collectExprPaths(x as Expr, sink, ctx, where));
      return;
    }
  }
  if ('count' in e) {
    const spec = e['count'] as { of?: unknown; where?: Predicate };
    if (typeof spec?.of !== 'string') {
      ctx.problems.push(`${where}: "count.of" must be an entity type name`);
    } else if (!ctx.entityTypeIds.has(spec.of)) {
      ctx.problems.push(`${where}: "count.of" names unknown entity type "${spec.of}"`);
    }
    if (spec?.where) {
      // Inside a count's filter the engine binds each candidate to $e, so paths
      // rooted there are legitimate and must not be checked against the
      // enclosing rule's scope. Collect them separately and discard.
      const inner: string[] = [];
      collectPredicatePaths(spec.where, inner, ctx, where);
      for (const path of inner) {
        if (!path.startsWith('$e.') && path !== '$e') sink.push(path);
      }
    }
    return;
  }
  ctx.problems.push(`${where}: unrecognised expression ${JSON.stringify(expr)}`);
}

function collectPredicatePaths(pred: Predicate, sink: string[], ctx: Ctx, where: string): void {
  const p = pred as Record<string, unknown>;
  for (const key of ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] as const) {
    if (key in p) {
      const list = p[key];
      if (!Array.isArray(list) || list.length !== 2) {
        ctx.problems.push(`${where}: "${key}" must be a pair`);
        return;
      }
      list.forEach((x) => collectExprPaths(x as Expr, sink, ctx, where));
      return;
    }
  }
  if ('and' in p || 'or' in p) {
    const list = ('and' in p ? p['and'] : p['or']) as unknown;
    if (!Array.isArray(list)) {
      ctx.problems.push(`${where}: "and"/"or" must be an array of predicates`);
      return;
    }
    list.forEach((x) => collectPredicatePaths(x as Predicate, sink, ctx, where));
    return;
  }
  if ('not' in p) {
    collectPredicatePaths(p['not'] as Predicate, sink, ctx, where);
    return;
  }
  if ('has' in p) {
    if (typeof p['has'] !== 'string') ctx.problems.push(`${where}: "has" must be a path`);
    else sink.push(p['has']);
    return;
  }
  ctx.problems.push(`${where}: unrecognised predicate ${JSON.stringify(pred)}`);
}

function collectEffectPaths(
  effect: Effect,
  sink: string[],
  ctx: Ctx,
  where: string,
  bound: Set<string>,
): void {
  switch (effect.op) {
    case 'set':
      sink.push(effect.path);
      collectExprPaths(effect.value, sink, ctx, where);
      break;
    case 'increment':
    case 'decrement':
      sink.push(effect.path);
      collectExprPaths(effect.by, sink, ctx, where);
      break;
    case 'destroy':
      sink.push(effect.path);
      break;
    case 'relate':
    case 'unrelate':
      sink.push(effect.from, effect.to);
      break;
    case 'settle':
      sink.push(effect.from, effect.to);
      collectExprPaths(effect.amount, sink, ctx, where);
      if (!ctx.resourceIds.has(effect.asset)) {
        ctx.problems.push(`${where}: settle names unknown asset "${effect.asset}"`);
      }
      break;
    case 'spawn':
      if (!ctx.entityTypeIds.has(effect.type)) {
        ctx.problems.push(`${where}: spawn names unknown entity type "${effect.type}"`);
      }
      for (const expr of Object.values(effect.attributes ?? {})) {
        collectExprPaths(expr, sink, ctx, where);
      }
      if (effect.bind) {
        bound.add(effect.bind.startsWith('$') ? effect.bind : `$${effect.bind}`);
      }
      break;
    case 'emit':
      for (const expr of Object.values(effect.data ?? {})) {
        collectExprPaths(expr, sink, ctx, where);
      }
      break;
    case 'with': {
      collectExprPaths(effect.entity, sink, ctx, where);
      const key = effect.bind.startsWith('$') ? effect.bind : `$${effect.bind}`;
      if (!effect.bind) ctx.problems.push(`${where}: with needs a bind name`);
      bound.add(key);
      // Both arms see the binding; the else arm sees it only as a name it must
      // not read, which checkRoots catches if it tries.
      for (const predicate of effect.require ?? []) {
        collectPredicatePaths(predicate, sink, ctx, where);
      }
      for (const child of effect.effects) collectEffectPaths(child, sink, ctx, where, bound);
      for (const child of effect.else ?? []) collectEffectPaths(child, sink, ctx, where, bound);
      break;
    }
    default:
      ctx.problems.push(`${where}: unrecognised effect ${JSON.stringify(effect)}`);
  }
}

function checkRoots(paths: string[], allowed: Set<string>, ctx: Ctx, where: string): void {
  for (const path of paths) {
    let key: string;
    try {
      key = pathRoot(path).key;
    } catch (err) {
      ctx.problems.push(`${where}: ${(err as Error).message}`);
      continue;
    }
    if (key.startsWith(`${SCOPE_BROADCAST}.`)) {
      const type = key.slice(SCOPE_BROADCAST.length + 1);
      if (!ctx.entityTypeIds.has(type)) {
        ctx.problems.push(
          `${where}: path "${path}" broadcasts over unknown entity type "${type}"`,
        );
      }
      if (!allowed.has(SCOPE_BROADCAST)) {
        ctx.problems.push(`${where}: path "${path}" may not broadcast in this context`);
      }
      continue;
    }
    if (!allowed.has(key)) {
      ctx.problems.push(
        `${where}: path "${path}" starts with "${key}", which is not in scope here ` +
          `(allowed: ${[...allowed].sort().join(', ')})`,
      );
    }
  }
}

function checkRule(rule: Rule, ctx: Ctx): void {
  const where = `rule "${rule.id}"`;
  const isActionRule = rule.when?.action !== undefined;
  const isTickRule = rule.when?.tick !== undefined;

  if (!isActionRule && !isTickRule) {
    ctx.problems.push(`${where}: has neither "when.action" nor "when.tick"`);
  }
  if (isActionRule && isTickRule) {
    ctx.problems.push(`${where}: has both "when.action" and "when.tick"; pick one`);
  }
  if (isActionRule && !ctx.actionIds.has(rule.when?.action as string)) {
    ctx.problems.push(
      `${where}: fires on action "${rule.when?.action}", which is not declared in "actions"`,
    );
  }
  if (isTickRule) {
    const every = rule.when?.tick?.every;
    if (typeof every !== 'number' || !Number.isInteger(every) || every <= 0) {
      ctx.problems.push(`${where}: "when.tick.every" must be a positive integer`);
    }
    if ((rule.require ?? []).length > 0) {
      ctx.problems.push(`${where}: tick rules may not declare "require"`);
    }
  }
  if (!Array.isArray(rule.effects)) {
    ctx.problems.push(`${where}: "effects" must be an array`);
    return;
  }

  const bound = new Set<string>();
  const allowed = new Set<string>(
    isActionRule ? [SCOPE_ACTOR, SCOPE_TARGET, SCOPE_PARAMS, SCOPE_BROADCAST] : [SCOPE_BROADCAST],
  );

  const reqPaths: string[] = [];
  for (const req of rule.require ?? []) collectPredicatePaths(req, reqPaths, ctx, where);
  checkRoots(reqPaths, allowed, ctx, where);

  for (const effect of rule.effects) {
    const paths: string[] = [];
    collectEffectPaths(effect, paths, ctx, where, bound);
    const allowedHere = new Set([...allowed, ...bound, SCOPE_NEW].filter((k) =>
      k === SCOPE_NEW ? bound.has(SCOPE_NEW) : true,
    ));
    checkRoots(paths, allowedHere, ctx, where);
  }
}

function checkWorldEvent(def: WorldEventDef, ctx: Ctx): void {
  const where = `event "${def.id}"`;
  if (def.atTick === undefined && def.every === undefined && def.chance === undefined) {
    ctx.problems.push(`${where}: needs one of "atTick", "every" or "chance"`);
  }
  if (def.every !== undefined && (!Number.isInteger(def.every) || def.every <= 0)) {
    ctx.problems.push(`${where}: "every" must be a positive integer`);
  }
  if (def.chance !== undefined && (def.chance < 0 || def.chance > 1)) {
    ctx.problems.push(`${where}: "chance" must be between 0 and 1`);
  }
  if (!Array.isArray(def.effects)) {
    ctx.problems.push(`${where}: "effects" must be an array`);
    return;
  }
  const bound = new Set<string>();
  for (const effect of def.effects) {
    const paths: string[] = [];
    collectEffectPaths(effect, paths, ctx, where, bound);
    checkRoots(paths, new Set([SCOPE_BROADCAST, ...bound]), ctx, where);
  }
}

function checkMetric(def: MetricDef, ctx: Ctx): void {
  const where = `metric "${def.id}"`;
  const kinds = ['sum', 'mean', 'max', 'min', 'count', 'gini'];
  if (!kinds.includes(def.aggregate)) {
    ctx.problems.push(`${where}: unknown aggregate "${def.aggregate}" (expected ${kinds.join(', ')})`);
  }
  if (def.over !== undefined && !ctx.entityTypeIds.has(def.over)) {
    ctx.problems.push(`${where}: "over" names unknown entity type "${def.over}"`);
  }
  if (def.aggregate !== 'count' && def.value === undefined) {
    ctx.problems.push(`${where}: aggregate "${def.aggregate}" needs a "value" expression`);
  }
  if (def.value !== undefined) {
    const paths: string[] = [];
    collectExprPaths(def.value, paths, ctx, where);
    checkRoots(paths, new Set([SCOPE_ENTITY]), ctx, where);
  }
}

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes];
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Validate a parsed world. Throws WorldValidationError listing every problem. */
export function validateWorld(world: WorldDefinition): WorldDefinition {
  const problems: string[] = [];
  const name = typeof world?.name === 'string' ? world.name : '<unnamed>';

  for (const [field, value] of Object.entries({
    resources: world?.resources,
    entityTypes: world?.entityTypes,
    actions: world?.actions,
    rules: world?.rules,
    population: world?.population,
  })) {
    if (!Array.isArray(value)) problems.push(`"${field}" must be an array`);
  }
  if (typeof world?.seed !== 'number' || !Number.isFinite(world.seed)) {
    problems.push('"seed" must be a finite number');
  }
  if (problems.length > 0) throw new WorldValidationError(name, problems);

  const ctx: Ctx = {
    world,
    problems,
    entityTypeIds: new Set(world.entityTypes.map((t) => t.id)),
    resourceIds: new Set(world.resources.map((r) => r.id)),
    actionIds: new Set(world.actions.map((a) => a.id)),
  };

  for (const [field, ids] of [
    ['resources', world.resources.map((r) => r.id)],
    ['entityTypes', world.entityTypes.map((t) => t.id)],
    ['actions', world.actions.map((a) => a.id)],
    ['rules', world.rules.map((r) => r.id)],
    ['markets', (world.markets ?? []).map((m) => m.id)],
    ['events', (world.events ?? []).map((e) => e.id)],
    ['metrics', (world.metrics ?? []).map((m) => m.id)],
  ] as [string, string[]][]) {
    for (const dup of duplicates(ids)) {
      problems.push(`"${field}" declares id "${dup}" more than once`);
    }
  }

  for (const type of world.entityTypes) {
    for (const rid of Object.keys(type.resources ?? {})) {
      if (!ctx.resourceIds.has(rid)) {
        problems.push(`entity type "${type.id}": endowment names unknown resource "${rid}"`);
      }
    }
  }

  for (const action of world.actions) {
    for (const t of action.actorTypes ?? []) {
      if (!ctx.entityTypeIds.has(t)) {
        problems.push(`action "${action.id}": actorTypes names unknown entity type "${t}"`);
      }
    }
    for (const t of action.targetTypes ?? []) {
      if (!ctx.entityTypeIds.has(t)) {
        problems.push(`action "${action.id}": targetTypes names unknown entity type "${t}"`);
      }
    }
    if (action.duration !== undefined && (!Number.isInteger(action.duration) || action.duration < 0)) {
      problems.push(`action "${action.id}": "duration" must be a non-negative integer`);
    }
    for (const dup of duplicates((action.params ?? []).map((p) => p.name))) {
      problems.push(`action "${action.id}": duplicate param "${dup}"`);
    }
  }

  for (const rule of world.rules) checkRule(rule, ctx);

  for (const market of world.markets ?? []) {
    const where = `market "${market.id}"`;
    if (!ctx.resourceIds.has(market.resource)) {
      problems.push(`${where}: traded resource "${market.resource}" is not declared in "resources"`);
    }
    if (!ctx.resourceIds.has(market.currency)) {
      problems.push(`${where}: currency "${market.currency}" is not declared in "resources"`);
    }
    if (market.resource === market.currency) {
      problems.push(`${where}: resource and currency are the same ("${market.resource}")`);
    }
    if (!SUPPORTED_MECHANISMS.includes(market.mechanism)) {
      problems.push(`${where}: unsupported mechanism "${market.mechanism}"`);
    }
    if (market.roundTicks !== undefined && (!Number.isInteger(market.roundTicks) || market.roundTicks <= 0)) {
      problems.push(`${where}: "roundTicks" must be a positive integer`);
    }
  }

  const byResource = new Map<string, string[]>();
  for (const market of world.markets ?? []) {
    byResource.set(market.resource, [...(byResource.get(market.resource) ?? []), market.id]);
  }
  for (const [rid, ids] of byResource) {
    if (ids.length > 1) {
      problems.push(`resource "${rid}" is traded by more than one market (${ids.join(', ')})`);
    }
  }

  for (const cohort of world.population) {
    if (!ctx.entityTypeIds.has(cohort.type)) {
      problems.push(`population: unknown entity type "${cohort.type}"`);
    }
    if (!Number.isInteger(cohort.count) || cohort.count < 0) {
      problems.push(`population "${cohort.type}": "count" must be a non-negative integer`);
    }
  }

  for (const resource of world.resources) {
    if (resource.spoilage !== undefined && (resource.spoilage < 0 || resource.spoilage > 1)) {
      problems.push(`resource "${resource.id}": "spoilage" must be between 0 and 1`);
    }
  }

  for (const def of world.events ?? []) checkWorldEvent(def, ctx);
  for (const def of world.metrics ?? []) checkMetric(def, ctx);

  if (problems.length > 0) throw new WorldValidationError(name, problems);
  return world;
}

/** Parse JSON text (or an already-parsed value) into a validated world. */
export function loadWorld(source: string | unknown): WorldDefinition {
  let parsed: unknown;
  if (typeof source === 'string') {
    try {
      parsed = JSON.parse(source);
    } catch (err) {
      throw new WorldValidationError('<unparsed>', [`not valid JSON: ${(err as Error).message}`]);
    }
  } else {
    parsed = source;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WorldValidationError('<unparsed>', ['world definition must be a JSON object']);
  }
  return validateWorld(parsed as WorldDefinition);
}

/** Read and validate a world file from disk. */
export async function loadWorldFile(filePath: string): Promise<WorldDefinition> {
  const { readFile } = await import('node:fs/promises');
  return loadWorld(await readFile(filePath, 'utf8'));
}
