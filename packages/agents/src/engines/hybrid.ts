/**
 * Cheap engine most ticks, expensive engine at the moments that matter.
 *
 * A hundred agents cannot each call a model every tick, and they do not need
 * to: most ticks are the continuation of a plan already made. What is needed is
 * an honest answer to "is this tick different?" — so the predicate is a pure,
 * exported function with named triggers, and the engine is a thin shell around
 * it. If the deliberate engine returns nothing, the routine one still answers:
 * a failed model call costs a little money, never a turn.
 */

import type { ActionProposal, DecisionEngine, Observation } from '@aw/types';
import type { WorldLens } from '../lens.ts';
import { payBalance, pressureLevel, type EngineContext } from './proposal.ts';

export interface DecisionPointConfig {
  /** Consider properly at least this often, whatever else is happening. */
  cadenceTicks: number;
  /** Never two deliberate calls closer together than this. */
  cooldownTicks: number;
  /** Relative price move that counts as sharp. */
  priceMove: number;
  /** Pressure at or above this, with a thin balance, is a crisis. */
  pressureThreshold: number;
  /** Balance below which the agent counts as broke. */
  payFloor: number;
}

export type DecisionTrigger =
  | 'first-look'
  | 'task-finished'
  | 'pressure-and-thin'
  | 'price-move'
  | 'novel-event'
  | 'cadence';

export interface HybridState {
  lastDeliberateTick: number | null;
  lastPrices: Record<string, number>;
  wasOccupied: boolean;
  seenEventTypes: string[];
}

export interface DecisionPoint {
  /** Null when this tick is routine. */
  trigger: DecisionTrigger | null;
  /** Every trigger that fired, for logging and for tests. */
  triggers: DecisionTrigger[];
}

export function makeHybridState(): HybridState {
  return { lastDeliberateTick: null, lastPrices: {}, wasOccupied: false, seenEventTypes: [] };
}

export function defaultDecisionPointConfig(lens: WorldLens): DecisionPointConfig {
  let low = Number.POSITIVE_INFINITY;
  for (const resource of lens.tradedResources) {
    if (resource === lens.payResource) continue;
    const hint = lens.priceHints[resource];
    if (typeof hint === 'number' && hint > 0 && hint < low) low = hint;
  }
  return {
    cadenceTicks: 12,
    cooldownTicks: 2,
    priceMove: 0.15,
    pressureThreshold: 2,
    payFloor: Number.isFinite(low) ? low * 2 : 1,
  };
}

/**
 * Is the agent mid-task? The rule language lets a world park a deadline in an
 * entity's free-form state, so a numeric value there that lies in the future is
 * the one portable signal available. A world that does not use the convention
 * simply never fires this trigger.
 */
export function occupied(obs: Observation): boolean {
  for (const value of Object.values(obs.self.state)) {
    if (typeof value === 'number' && Number.isFinite(value) && value > obs.tick) return true;
  }
  return false;
}

/** Pure. Given the world, the tick and what we saw last time, is this a moment? */
export function detectDecisionPoint(
  obs: Observation,
  lens: WorldLens,
  state: HybridState,
  config: DecisionPointConfig,
): DecisionPoint {
  const triggers: DecisionTrigger[] = [];

  if (state.lastDeliberateTick === null) {
    return { trigger: 'first-look', triggers: ['first-look'] };
  }
  if (obs.tick - state.lastDeliberateTick < config.cooldownTicks) {
    return { trigger: null, triggers: [] };
  }

  if (state.wasOccupied && !occupied(obs)) triggers.push('task-finished');

  if (
    pressureLevel(obs.self, lens) >= config.pressureThreshold &&
    payBalance(obs.self, lens) < config.payFloor
  ) {
    triggers.push('pressure-and-thin');
  }

  for (const [key, price] of Object.entries(obs.prices)) {
    const previous = state.lastPrices[key];
    if (typeof previous !== 'number' || previous <= 0) continue;
    if (Math.abs(price - previous) / previous >= config.priceMove) {
      triggers.push('price-move');
      break;
    }
  }

  for (const event of obs.recentEvents) {
    if (!state.seenEventTypes.includes(event.type)) {
      triggers.push('novel-event');
      break;
    }
  }

  if (obs.tick - state.lastDeliberateTick >= config.cadenceTicks) triggers.push('cadence');

  return { trigger: triggers[0] ?? null, triggers };
}

/** Fold this tick into the state the predicate reads next time. */
export function absorb(obs: Observation, state: HybridState): void {
  state.lastPrices = { ...obs.prices };
  state.wasOccupied = occupied(obs);
  for (const event of obs.recentEvents) {
    if (!state.seenEventTypes.includes(event.type)) state.seenEventTypes.push(event.type);
  }
}

export interface HybridOptions extends EngineContext {
  /** Runs every tick that is not a decision point. Cheap and deterministic. */
  routine: DecisionEngine;
  /** Runs at decision points. Usually the model. */
  deliberate: DecisionEngine;
  config?: Partial<DecisionPointConfig>;
  state?: HybridState;
}

export interface HybridStats {
  routineTicks: number;
  deliberateTicks: number;
  deliberateFailures: number;
}

export class HybridEngine implements DecisionEngine {
  readonly name = 'hybrid';
  readonly state: HybridState;
  readonly config: DecisionPointConfig;
  private readonly lens: WorldLens;
  private readonly routine: DecisionEngine;
  private readonly deliberate: DecisionEngine;
  private readonly counters: HybridStats = {
    routineTicks: 0,
    deliberateTicks: 0,
    deliberateFailures: 0,
  };

  constructor(options: HybridOptions) {
    this.lens = options.lens;
    this.routine = options.routine;
    this.deliberate = options.deliberate;
    this.state = options.state ?? makeHybridState();
    this.config = { ...defaultDecisionPointConfig(options.lens), ...(options.config ?? {}) };
  }

  get stats(): HybridStats {
    return { ...this.counters };
  }

  /** What the predicate says about this tick, without acting on it. */
  inspect(obs: Observation): DecisionPoint {
    return detectDecisionPoint(obs, this.lens, this.state, this.config);
  }

  async decide(obs: Observation): Promise<ActionProposal | null> {
    const point = this.inspect(obs);
    absorb(obs, this.state);

    if (point.trigger !== null) {
      this.state.lastDeliberateTick = obs.tick;
      this.counters.deliberateTicks++;
      const considered = await this.deliberate.decide(obs);
      if (considered) {
        if (considered.reason === undefined) considered.reason = `Decision point: ${point.trigger}.`;
        return considered;
      }
      this.counters.deliberateFailures++;
    }

    this.counters.routineTicks++;
    return this.routine.decide(obs);
  }
}
