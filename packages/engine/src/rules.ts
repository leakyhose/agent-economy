// The rule engine: validation of proposals and application of effects.
//
// Rules are data. Nothing in this file knows what any world identifier means.

import type {
  ActionProposal,
  Effect,
  Entity,
  EntityId,
  Json,
  Rule,
  SettlementIntent,
  SimEvent,
  ValidationResult,
  WorldDefinition,
  WorldState,
} from '@aw/types';

import {
  SCOPE_ACTOR,
  SCOPE_BROADCAST,
  SCOPE_PARAMS,
  SCOPE_TARGET,
  evalExpr,
  evalNumber,
  evalPredicate,
  resolvePath,
  resolveWritable,
  sortedEntities,
  type EvalContext,
  type Scope,
} from './expr.ts';

/** Raised when an effect would drive a resource below zero. The whole action aborts. */
export class NegativeResourceError extends Error {
  constructor(
    public readonly path: string,
    public readonly attempted: number,
  ) {
    super(`resource "${path}" would become ${attempted}; resources may not go negative`);
    this.name = 'NegativeResourceError';
  }
}

export class EffectError extends Error {}

/** Everything applying an effect needs that does not live in WorldState. */
export interface EffectContext {
  world: WorldDefinition;
  tick: number;
  /** Allocate the next id for an entity type, e.g. `<type>_7`. */
  allocId(type: string): EntityId;
  /** Monotonic event sequence number. */
  nextSeq(): number;
  /** Collected `settle` effects; the engine never touches a chain itself. */
  settlements: SettlementIntent[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const REJECT_UNKNOWN_ACTION = 'engine.unknown_action';
export const REJECT_UNKNOWN_ACTOR = 'engine.unknown_actor';
export const REJECT_ACTOR_TYPE = 'engine.actor_type';
export const REJECT_TARGET = 'engine.target';
export const REJECT_TARGET_TYPE = 'engine.target_type';
export const REJECT_MISSING_PARAM = 'engine.missing_param';
export const REJECT_PARAM_TYPE = 'engine.param_type';
export const REJECT_ACTOR_BUSY = 'engine.actor_busy';
export const REJECT_QUEUED = 'engine.actor_already_queued';
export const REJECT_EFFECT = 'engine.effect_failed';

/** Key under which an actor's occupied-until tick is stored in `entity.state`. */
export const BUSY_UNTIL = 'busyUntil';

function fail(rejectedBy: string, message: string): ValidationResult {
  return { ok: false, rejectedBy, message };
}

export function rulesForAction(world: WorldDefinition, action: string): Rule[] {
  return world.rules
    .filter((r) => r.when?.action === action)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));
}

export function tickRules(world: WorldDefinition): Rule[] {
  return world.rules
    .filter((r) => r.when?.tick !== undefined)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));
}

export function proposalScope(proposal: ActionProposal, state: WorldState): Scope {
  const actor = state.entities[proposal.actor];
  const scope: Scope = {
    [SCOPE_ACTOR]: actor,
    [SCOPE_PARAMS]: proposal.params ?? {},
    [SCOPE_TARGET]: proposal.target === undefined ? null : state.entities[proposal.target] ?? null,
  };
  return scope;
}

/**
 * Evaluate every `require` of every rule whose `when.action` matches, plus the
 * structural checks the action definition implies.
 */
export function validate(
  proposal: ActionProposal,
  state: WorldState,
  world: WorldDefinition,
): ValidationResult {
  const action = world.actions.find((a) => a.id === proposal.action);
  if (!action) {
    return fail(REJECT_UNKNOWN_ACTION, `no action "${proposal.action}" in this world`);
  }

  const actor = state.entities[proposal.actor];
  if (!actor) {
    return fail(REJECT_UNKNOWN_ACTOR, `no entity "${proposal.actor}"`);
  }

  if (action.actorTypes && action.actorTypes.length > 0 && !action.actorTypes.includes(actor.type)) {
    return fail(
      REJECT_ACTOR_TYPE,
      `entity type "${actor.type}" may not perform "${action.id}"`,
    );
  }

  if (action.targetTypes && action.targetTypes.length > 0) {
    if (proposal.target === undefined) {
      return fail(REJECT_TARGET, `action "${action.id}" requires a target`);
    }
    const target = state.entities[proposal.target];
    if (!target) return fail(REJECT_TARGET, `no target entity "${proposal.target}"`);
    if (!action.targetTypes.includes(target.type)) {
      return fail(
        REJECT_TARGET_TYPE,
        `target type "${target.type}" is not valid for "${action.id}"`,
      );
    }
  }

  const params = proposal.params ?? {};
  for (const p of action.params ?? []) {
    const given = params[p.name];
    if (given === undefined || given === null) {
      if (p.required) {
        return fail(REJECT_MISSING_PARAM, `action "${action.id}" requires param "${p.name}"`);
      }
      continue;
    }
    if (p.type === 'number' && typeof given !== 'number') {
      return fail(REJECT_PARAM_TYPE, `param "${p.name}" must be a number`);
    }
    if ((p.type === 'string' || p.type === 'entity' || p.type === 'resource') && typeof given !== 'string') {
      return fail(REJECT_PARAM_TYPE, `param "${p.name}" must be a string`);
    }
    if (p.type === 'resource' && !world.resources.some((r) => r.id === given)) {
      return fail(REJECT_PARAM_TYPE, `param "${p.name}" is not a resource of this world`);
    }
    if (p.type === 'entity' && !(String(given) in state.entities)) {
      return fail(REJECT_PARAM_TYPE, `param "${p.name}" is not an existing entity`);
    }
  }

  const busyUntil = actor.state[BUSY_UNTIL];
  if (typeof busyUntil === 'number' && busyUntil > state.tick) {
    return fail(
      REJECT_ACTOR_BUSY,
      `entity "${actor.id}" is occupied until tick ${busyUntil}`,
    );
  }

  const ctx: EvalContext = { state };
  const scope = proposalScope(proposal, state);
  for (const rule of rulesForAction(world, action.id)) {
    for (const req of rule.require ?? []) {
      let held: boolean;
      try {
        held = evalPredicate(req, scope, ctx);
      } catch (err) {
        return fail(rule.id, `rule "${rule.id}" could not be evaluated: ${(err as Error).message}`);
      }
      if (!held) {
        return fail(
          rule.id,
          `rule "${rule.id}" not satisfied: ${JSON.stringify(req)}`,
        );
      }
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

const BROADCAST_RE = /^\$each\.([A-Za-z0-9_-]+)/;

/** Collect the entity types an effect broadcasts over, in first-seen order. */
export function broadcastTypes(effect: Effect): string[] {
  const found: string[] = [];
  const visit = (v: unknown): void => {
    if (typeof v === 'string') {
      const m = BROADCAST_RE.exec(v);
      if (m && m[1] && !found.includes(m[1])) found.push(m[1]);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v as Record<string, unknown>)) {
        visit(k);
        visit((v as Record<string, unknown>)[k]);
      }
    }
  };
  visit(effect);
  return found;
}

function entityFrom(path: string, scope: Scope, state: WorldState): Entity {
  const v = resolvePath(path, scope);
  if (v && typeof v === 'object' && 'id' in (v as Record<string, unknown>)) {
    return v as Entity;
  }
  if (typeof v === 'string') {
    const en = state.entities[v];
    if (en) return en;
  }
  throw new EffectError(`path "${path}" does not resolve to an entity`);
}

function writeGuarded(path: string, scope: Scope, value: unknown, guarded: boolean): void {
  if (guarded && typeof value === 'number' && value < 0) {
    throw new NegativeResourceError(path, value);
  }
}

/**
 * Apply a list of effects, mutating `state`, and return the events produced.
 * Throws on any violation; callers run this inside a transaction so a partial
 * application is never committed.
 */
export function applyEffects(
  effects: Effect[],
  scope: Scope,
  state: WorldState,
  ctx: EffectContext,
): SimEvent[] {
  const events: SimEvent[] = [];
  for (const effect of effects) {
    const types = broadcastTypes(effect);
    if (types.length === 0) {
      events.push(...applyOne(effect, scope, state, ctx));
      continue;
    }
    if (types.length > 1) {
      throw new EffectError(
        `effect broadcasts over more than one entity type (${types.join(', ')}); not supported`,
      );
    }
    const type = types[0] as string;
    const members = sortedEntities(state).filter((en) => en.type === type);
    for (const member of members) {
      const inner: Scope = { ...scope, [`${SCOPE_BROADCAST}.${type}`]: member };
      events.push(...applyOne(effect, inner, state, ctx));
    }
  }
  return events;
}

function applyOne(
  effect: Effect,
  scope: Scope,
  state: WorldState,
  ctx: EffectContext,
): SimEvent[] {
  const ectx: EvalContext = { state };
  const mkEvent = (type: string, data: Record<string, Json>): SimEvent => ({
    seq: ctx.nextSeq(),
    tick: ctx.tick,
    type,
    data,
  });

  switch (effect.op) {
    case 'set': {
      const slot = resolveWritable(effect.path, scope);
      const value = evalExpr(effect.value, scope, ectx);
      writeGuarded(effect.path, scope, value, slot.guarded);
      slot.container[slot.key] = value;
      return [];
    }
    case 'increment':
    case 'decrement': {
      const slot = resolveWritable(effect.path, scope);
      const current = slot.container[slot.key];
      const base = typeof current === 'number' ? current : 0;
      const delta = evalNumber(effect.by, scope, ectx);
      const next = effect.op === 'increment' ? base + delta : base - delta;
      writeGuarded(effect.path, scope, next, slot.guarded);
      slot.container[slot.key] = next;
      return [];
    }
    case 'spawn': {
      const def = ctx.world.entityTypes.find((t) => t.id === effect.type);
      if (!def) throw new EffectError(`spawn refers to unknown entity type "${effect.type}"`);
      const id = ctx.allocId(effect.type);
      const entity: Entity = {
        id,
        type: effect.type,
        attributes: { ...(def.attributes ?? {}) },
        resources: { ...(def.resources ?? {}) },
        relationships: {},
        owns: [],
        state: {},
      };
      for (const [k, expr] of Object.entries(effect.attributes ?? {})) {
        entity.attributes[k] = evalExpr(expr, scope, ectx);
      }
      state.entities[id] = entity;
      if (effect.bind) {
        const key = effect.bind.startsWith('$') ? effect.bind : `$${effect.bind}`;
        scope[key] = entity;
      }
      return [mkEvent('entity_spawned', { id, type: effect.type })];
    }
    case 'destroy': {
      const victim = entityFrom(effect.path, scope, state);
      delete state.entities[victim.id];
      for (const other of Object.values(state.entities)) {
        if (!other) continue;
        for (const kind of Object.keys(other.relationships)) {
          const list = other.relationships[kind];
          if (!list) continue;
          other.relationships[kind] = list.filter((x) => x !== victim.id);
        }
        other.owns = other.owns.filter((x) => x !== victim.id);
        if (other.ownedBy === victim.id) delete other.ownedBy;
      }
      return [mkEvent('entity_destroyed', { id: victim.id, type: victim.type })];
    }
    case 'relate': {
      const from = entityFrom(effect.from, scope, state);
      const to = entityFrom(effect.to, scope, state);
      const list = from.relationships[effect.kind] ?? [];
      if (!list.includes(to.id)) list.push(to.id);
      from.relationships[effect.kind] = list;
      return [mkEvent('related', { from: from.id, to: to.id, kind: effect.kind })];
    }
    case 'unrelate': {
      const from = entityFrom(effect.from, scope, state);
      const to = entityFrom(effect.to, scope, state);
      const list = from.relationships[effect.kind] ?? [];
      from.relationships[effect.kind] = list.filter((x) => x !== to.id);
      return [mkEvent('unrelated', { from: from.id, to: to.id, kind: effect.kind })];
    }
    case 'settle': {
      const from = entityFrom(effect.from, scope, state);
      const to = entityFrom(effect.to, scope, state);
      const amount = evalNumber(effect.amount, scope, ectx);
      const intent: SettlementIntent = {
        tick: ctx.tick,
        asset: effect.asset,
        from: from.id,
        to: to.id,
        amount,
      };
      ctx.settlements.push(intent);
      return [
        mkEvent('settlement_requested', {
          asset: intent.asset,
          from: intent.from,
          to: intent.to,
          amount: intent.amount,
        }),
      ];
    }
    case 'emit': {
      const data: Record<string, Json> = {};
      for (const [k, expr] of Object.entries(effect.data ?? {})) {
        data[k] = evalExpr(expr, scope, ectx);
      }
      return [mkEvent(effect.event, data)];
    }
    case 'with': {
      // Resolve an entity the rule knows only by reference, and branch on
      // whether it is there and fit. Both arms are data; neither can run code.
      const raw = evalExpr(effect.entity, scope, ectx);
      const id = typeof raw === 'string' ? raw : null;
      const entity = id ? state.entities[id] : undefined;

      const bindKey = effect.bind.startsWith('$') ? effect.bind : `$${effect.bind}`;
      let ok = Boolean(entity);
      if (entity && effect.require) {
        const inner: Scope = { ...scope, [bindKey]: entity };
        ok = effect.require.every((p) => evalPredicate(p, inner, ectx));
      }

      const branch = ok ? effect.effects : (effect.else ?? []);
      const nested: Scope = entity ? { ...scope, [bindKey]: entity } : scope;
      const events: SimEvent[] = [];
      for (const child of branch) {
        // applyOne, not applyEffects: any broadcast wrapping this effect has
        // already bound its member, and re-expanding here would apply the child
        // once per member per member.
        events.push(...applyOne(child, nested, state, ctx));
      }
      return events;
    }
    default: {
      const never: never = effect;
      throw new EffectError(`unrecognised effect op: ${JSON.stringify(never)}`);
    }
  }
}
