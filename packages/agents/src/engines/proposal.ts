/**
 * Shared machinery for turning "I want to do action X" into a complete,
 * plausible `ActionProposal`.
 *
 * The hard part is parameters: an engine is given a list of action ids and a
 * list of parameter names, and must fill in numbers that stand a chance of
 * passing the rule engine — without knowing what any of the names mean. So the
 * roles are inferred from the preconditions the world's own rules state: a
 * number compared against the actor's stock is an amount; a number multiplied
 * by another and compared against the actor's balance is a unit price; a number
 * compared directly against the balance is an outlay.
 */

import type { ActionProposal, Entity, Json, Observation, Predicate, ResourceId } from '@aw/types';
import { estimateDeltas, satisfiable, type ActionInfo, type WorldLens } from '../lens.ts';
import type { Memory } from '../memory.ts';
import type { Traits } from '../traits.ts';
import { jitter } from '../rng.ts';

export interface EngineContext {
  lens: WorldLens;
  traits: Traits;
  seed: number;
  /** The agent's own store. Optional so engines stay usable standalone. */
  memory?: Memory;
}

export type ParamRole = 'amount' | 'unitPrice' | 'outlay' | 'free';

export interface Candidate {
  actionId: string;
  info: ActionInfo;
  target?: string;
  params?: Record<string, Json>;
  /** The resource this proposal is about, when it is about one. */
  resource?: ResourceId;
  /** Reference price used while filling the numbers, in minor units. */
  referencePrice?: number;
  /** Units of `resource` the proposal moves, when the action moves units. */
  amount?: number;
  /** Price per unit the proposal names, when it names one. */
  unitPrice?: number;
  /** Pay-resource the proposal commits outright, when it commits any. */
  outlay?: number;
  /** Net resource change if the rules fire as written. */
  deltas: Record<ResourceId, number>;
}

const PARAM_PREFIX = '$params.';
const RESOURCE_PREFIX = '$actor.resources.';

function isRef(node: unknown): node is { ref: string } {
  return typeof node === 'object' && node !== null && typeof (node as { ref?: unknown }).ref === 'string';
}

function paramOf(node: unknown): string | null {
  if (!isRef(node)) return null;
  if (!node.ref.startsWith(PARAM_PREFIX)) return null;
  const rest = node.ref.slice(PARAM_PREFIX.length);
  return rest.includes('.') || rest.length === 0 ? null : rest;
}

function resourceOf(node: unknown): string | null {
  if (!isRef(node)) return null;
  if (!node.ref.startsWith(RESOURCE_PREFIX)) return null;
  return node.ref.slice(RESOURCE_PREFIX.length);
}

function flatten(predicates: readonly Predicate[]): Predicate[] {
  const out: Predicate[] = [];
  const walk = (p: Predicate): void => {
    out.push(p);
    if ('and' in p) for (const child of p.and) walk(child);
    else if ('or' in p) for (const child of p.or) walk(child);
    else if ('not' in p) walk(p.not);
  };
  for (const p of predicates) walk(p);
  return out;
}

/** Infer what each stated numeric parameter is for. */
export function paramRoles(info: ActionInfo, payResource: string | null): Record<string, ParamRole> {
  const roles: Record<string, ParamRole> = {};
  const positive = new Set<string>();
  const pairs: Array<[string, string]> = [];

  const predicates: Predicate[] = [];
  for (const rule of info.rules) predicates.push(...flatten(rule.require ?? []));

  for (const predicate of predicates) {
    const sides =
      'gte' in predicate ? predicate.gte
      : 'gt' in predicate ? predicate.gt
      : 'lte' in predicate ? predicate.lte
      : 'lt' in predicate ? predicate.lt
      : null;
    if (!sides) continue;
    const [left, right] = sides;

    const leftParam = paramOf(left);
    if (leftParam !== null && typeof right === 'number' && right >= 0) {
      positive.add(leftParam);
      continue;
    }

    const stock = resourceOf(left);
    if (stock === null) continue;
    const rightParam = paramOf(right);
    if (rightParam !== null) {
      roles[rightParam] = stock === payResource ? 'outlay' : 'amount';
      continue;
    }
    if (typeof right === 'object' && right !== null && 'mul' in right) {
      const factors = (right as { mul: unknown[] }).mul.map(paramOf).filter((p): p is string => p !== null);
      if (factors.length === 2) {
        const first = factors[0];
        const second = factors[1];
        if (first && second) pairs.push([first, second]);
      }
    }
  }

  for (const [a, b] of pairs) {
    // Whichever of the two the world separately constrains to be positive is
    // the amount; the other scales it, so it is a unit price.
    const amount = positive.has(a) ? a : positive.has(b) ? b : a;
    const price = amount === a ? b : a;
    if (roles[amount] === undefined) roles[amount] = 'amount';
    if (roles[price] === undefined) roles[price] = 'unitPrice';
  }

  for (const param of info.params) {
    if (param.type !== 'number') continue;
    if (roles[param.name] === undefined) {
      roles[param.name] = positive.has(param.name) ? 'amount' : 'free';
    }
  }
  return roles;
}

// -- prices -------------------------------------------------------------------

export function priceKey(lens: WorldLens, resource: ResourceId): string {
  return lens.marketOf[resource] ?? resource;
}

/** Last public price, else the world's stated opening hint, else one unit. */
export function referencePrice(obs: Observation, lens: WorldLens, resource: ResourceId): number {
  const key = priceKey(lens, resource);
  const live = obs.prices[key];
  if (typeof live === 'number' && Number.isFinite(live) && live > 0) return live;
  const hint = lens.priceHints[resource];
  if (typeof hint === 'number' && hint > 0) return hint;
  return 1;
}

/** What this agent believes the normal level is, from its own semantic store. */
export function believedLevel(
  ctx: EngineContext,
  obs: Observation,
  resource: ResourceId,
): number | null {
  const key = `price:${priceKey(ctx.lens, resource)}`;
  const summary = ctx.memory?.valueOf(key);
  if (summary && summary.count > 0) return summary.mean;
  const hint = ctx.lens.priceHints[resource];
  return typeof hint === 'number' ? hint : null;
}

export function held(self: Entity, resource: ResourceId): number {
  const value = self.resources[resource];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function payBalance(self: Entity, lens: WorldLens): number {
  return lens.payResource ? held(self, lens.payResource) : 0;
}

/** Numeric attribute of self, or null if absent or non-numeric. */
export function attributeOf(self: Entity, name: string): number | null {
  const value = self.attributes[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Highest pressure the world has piled onto this agent, 0 when there is none. */
export function pressureLevel(self: Entity, lens: WorldLens): number {
  let worst = 0;
  for (const attribute of lens.pressureAttributes) {
    const value = attributeOf(self, attribute);
    if (value !== null && value > worst) worst = value;
  }
  return worst;
}

// -- candidate construction ---------------------------------------------------

function tradableHoldings(obs: Observation, lens: WorldLens): ResourceId[] {
  const out: ResourceId[] = [];
  for (const resource of lens.tradedResources) {
    if (resource === lens.payResource) continue;
    if (held(obs.self, resource) > 0) out.push(resource);
  }
  return out;
}

function shortages(obs: Observation, lens: WorldLens): ResourceId[] {
  const pool = lens.tradedResources.filter((r) => r !== lens.payResource);
  return [...pool].sort((a, b) => {
    const perishableA = lens.perishables.includes(a) ? 1 : 0;
    const perishableB = lens.perishables.includes(b) ? 1 : 0;
    if (perishableA !== perishableB) return perishableB - perishableA;
    const stockA = held(obs.self, a);
    const stockB = held(obs.self, b);
    if (stockA !== stockB) return stockA - stockB;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function pickTarget(obs: Observation, info: ActionInfo, seed: number): string | null {
  const pool = obs.visibleEntities
    .filter((e) => e.id !== obs.self.id && info.targetTypes.includes(e.type))
    .map((e) => e.id)
    .sort();
  if (pool.length === 0) return null;
  const at = Math.floor(jitter(seed, `target:${info.id}:${obs.tick}:${obs.self.id}`) * pool.length);
  return pool[Math.min(pool.length - 1, Math.max(0, at))] ?? null;
}

function pickEntityParam(obs: Observation, info: ActionInfo, name: string, seed: number): string | null {
  const pool = obs.visibleEntities.map((e) => e.id).sort();
  if (pool.length === 0) return null;
  const at = Math.floor(jitter(seed, `param:${info.id}:${name}:${obs.self.id}`) * pool.length);
  return pool[Math.min(pool.length - 1, Math.max(0, at))] ?? null;
}

function chooseResource(obs: Observation, info: ActionInfo, ctx: EngineContext): ResourceId | null {
  const { lens } = ctx;
  if (info.shape === 'offer') {
    const owned = tradableHoldings(obs, lens);
    if (owned.length === 0) return null;
    let best: ResourceId | null = null;
    let bestValue = -1;
    for (const resource of owned) {
      const value = held(obs.self, resource) * referencePrice(obs, lens, resource);
      if (value > bestValue) {
        best = resource;
        bestValue = value;
      }
    }
    return best;
  }
  if (info.shape === 'acquire') {
    return shortages(obs, lens)[0] ?? null;
  }
  const owned = tradableHoldings(obs, lens);
  return owned[0] ?? shortages(obs, lens)[0] ?? null;
}

/**
 * Build a fully-specified proposal for one action id, or null when the agent
 * cannot currently satisfy the action's own stated preconditions.
 */
export function buildCandidate(
  actionId: string,
  obs: Observation,
  ctx: EngineContext,
): Candidate | null {
  const info = ctx.lens.info(actionId);
  if (!info) return null;

  const target = info.targetTypes.length > 0 ? pickTarget(obs, info, ctx.seed) : null;
  if (info.targetTypes.length > 0 && target === null) return null;

  const roles = paramRoles(info, ctx.lens.payResource);
  const params: Record<string, Json> = {};
  let resource: ResourceId | null = null;
  let reference: number | null = null;

  const needsResource = info.params.some((p) => p.type === 'resource');
  if (needsResource) {
    resource = chooseResource(obs, info, ctx);
    if (resource === null) return null;
    reference = referencePrice(obs, ctx.lens, resource);
  }

  const risk = ctx.traits.riskTolerance;
  const balance = payBalance(obs.self, ctx.lens);
  let chosenAmount: number | null = null;
  let chosenUnitPrice: number | null = null;
  let chosenOutlay: number | null = null;

  // Unit prices first: amounts depend on them.
  let unitPrice: number | null = null;
  if (reference !== null) {
    if (info.shape === 'acquire') {
      unitPrice = Math.max(1, Math.ceil(reference * (1.02 + 0.18 * risk)));
    } else {
      unitPrice = Math.max(1, Math.floor(reference * (0.98 - 0.15 * (1 - risk))));
    }
  }

  for (const param of info.params) {
    const role = roles[param.name] ?? 'free';
    if (param.type === 'resource') {
      if (resource === null) return null;
      params[param.name] = resource;
      continue;
    }
    if (param.type === 'entity') {
      const picked = target ?? pickEntityParam(obs, info, param.name, ctx.seed);
      if (picked === null) {
        if (param.required) return null;
        continue;
      }
      params[param.name] = picked;
      continue;
    }
    if (param.type === 'string') {
      params[param.name] = obs.self.id;
      continue;
    }
    // numeric
    if (role === 'unitPrice') {
      if (unitPrice === null) return null;
      params[param.name] = unitPrice;
      chosenUnitPrice = unitPrice;
      continue;
    }
    if (role === 'outlay') {
      const amount = Math.floor(balance * (0.08 + 0.35 * risk));
      if (amount < 1) return null;
      params[param.name] = amount;
      chosenOutlay = amount;
      continue;
    }
    if (role === 'amount') {
      if (info.shape === 'offer' && resource !== null) {
        const stock = held(obs.self, resource);
        const wanted = Math.floor(stock * (0.2 + 0.5 * risk));
        const amount = Math.max(1, Math.min(stock, wanted));
        if (stock < 1) return null;
        params[param.name] = amount;
        chosenAmount = amount;
        continue;
      }
      if (unitPrice !== null) {
        const budget = balance * (0.1 + 0.4 * risk);
        const affordable = Math.floor(Math.min(budget, balance) / unitPrice);
        if (affordable < 1) return null;
        chosenAmount = Math.max(1, affordable);
        params[param.name] = chosenAmount;
        continue;
      }
      params[param.name] = 1;
      continue;
    }
    params[param.name] = 1;
  }

  const scope = { self: obs.self, params };
  if (!satisfiable(info, scope)) return null;

  const candidate: Candidate = { actionId, info, deltas: estimateDeltas(info, scope) };
  if (target !== null) candidate.target = target;
  if (Object.keys(params).length > 0) candidate.params = params;
  if (resource !== null) candidate.resource = resource;
  if (reference !== null) candidate.referencePrice = reference;
  if (chosenAmount !== null) candidate.amount = chosenAmount;
  if (chosenUnitPrice !== null) candidate.unitPrice = chosenUnitPrice;
  if (chosenOutlay !== null) candidate.outlay = chosenOutlay;
  return candidate;
}

export function toProposal(candidate: Candidate, obs: Observation, reason?: string): ActionProposal {
  const proposal: ActionProposal = { action: candidate.actionId, actor: obs.self.id };
  if (candidate.target !== undefined) proposal.target = candidate.target;
  if (candidate.params !== undefined) proposal.params = candidate.params;
  if (reason !== undefined) proposal.reason = reason;
  return proposal;
}

/** Every available action the agent could actually specify right now. */
export function viableCandidates(obs: Observation, ctx: EngineContext): Candidate[] {
  const out: Candidate[] = [];
  for (const actionId of obs.availableActions) {
    const candidate = buildCandidate(actionId, obs, ctx);
    if (candidate) out.push(candidate);
  }
  return out;
}

// -- valuation ----------------------------------------------------------------

/** What one unit of a resource is worth, expressed in the pay resource. */
export function unitValue(obs: Observation, lens: WorldLens, resource: ResourceId): number {
  if (resource === lens.payResource) return 1;
  return referencePrice(obs, lens, resource);
}

/**
 * How much this agent wants one more unit of a resource, as a multiple of its
 * market price. Scarcity and standing pressure both raise it; a resource it is
 * already sitting on is worth less than the price it would fetch.
 */
function appetite(obs: Observation, ctx: EngineContext, resource: ResourceId): number {
  const { lens } = ctx;
  let value = 0.85;
  if (lens.perishables.includes(resource)) {
    value += 0.15 + 0.25 * Math.min(4, pressureLevel(obs.self, lens));
  }
  if (held(obs.self, resource) <= 0) value += 0.4;
  return value;
}

/** Discount applied to stock the agent gives away: liquidity is worth having. */
function retention(ctx: EngineContext, resource: ResourceId): number {
  return ctx.lens.perishables.includes(resource) ? 0.6 : 0.85;
}

/**
 * Expected value of a candidate in pay-resource units. Market actions settle in
 * a later round, so their value comes from the terms proposed rather than from
 * any immediate rule effect.
 */
export function expectedGain(candidate: Candidate, obs: Observation, ctx: EngineContext): number {
  let total = 0;
  for (const [resource, delta] of Object.entries(candidate.deltas)) {
    total += delta * unitValue(obs, ctx.lens, resource);
  }

  const resource = candidate.resource;
  const amount = candidate.amount ?? 0;
  const unitPrice = candidate.unitPrice ?? 0;

  if (candidate.info.shape === 'offer' && resource && amount > 0) {
    const price = referencePrice(obs, ctx.lens, resource);
    total += amount * (unitPrice - price * retention(ctx, resource));
  } else if (candidate.info.shape === 'acquire' && resource && amount > 0) {
    const price = referencePrice(obs, ctx.lens, resource);
    total += amount * (price * appetite(obs, ctx, resource) - unitPrice);
  }

  if (candidate.outlay !== undefined && candidate.outlay > 0) {
    // Committing the balance outright buys an option rather than goods. How
    // much that option is worth is a matter of temperament.
    total += candidate.outlay * (0.55 + 0.8 * ctx.traits.riskTolerance) - candidate.outlay;
  }
  return total;
}

/** Fraction of the agent's spendable balance the candidate puts at stake. */
export function exposure(candidate: Candidate, obs: Observation, ctx: EngineContext): number {
  const balance = payBalance(obs.self, ctx.lens);
  if (balance <= 0) return 0;
  let atStake = candidate.outlay ?? 0;
  if (candidate.info.shape === 'acquire') atStake += (candidate.amount ?? 0) * (candidate.unitPrice ?? 0);
  return Math.max(0, Math.min(1, atStake / balance));
}
