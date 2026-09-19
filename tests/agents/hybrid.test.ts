/**
 * The hybrid engine exists to make a hundred agents affordable, so the thing
 * worth testing is the predicate that decides when to spend money.
 */

import { describe, expect, it } from 'vitest';
import type { ActionProposal, DecisionEngine, Observation } from '@aw/types';
import { makeLens } from '../../packages/agents/src/lens.ts';
import { Memory } from '../../packages/agents/src/memory.ts';
import { buildObservation } from '../../packages/agents/src/observe.ts';
import { NEUTRAL_TRAITS } from '../../packages/agents/src/traits.ts';
import {
  HybridEngine,
  absorb,
  defaultDecisionPointConfig,
  detectDecisionPoint,
  makeHybridState,
  occupied,
  type HybridState,
} from '../../packages/agents/src/engines/hybrid.ts';
import { agentIds, loadWorld, makeState } from './fixtures.ts';

const world = loadWorld('economic-sandbox.json');
const lens = makeLens(world);
const config = defaultDecisionPointConfig(lens);

function baseObservation(tick: number): Observation {
  const state = makeState(world, tick);
  const id = agentIds(world, state)[0]!;
  return buildObservation(id, state, world, new Memory(), 'marketBoard', { lens });
}

function settled(tick: number, obs: Observation): HybridState {
  const state = makeHybridState();
  absorb(obs, state);
  state.lastDeliberateTick = tick;
  return state;
}

describe('decision-point predicate', () => {
  it('always fires the first time it sees the world', () => {
    const obs = baseObservation(0);
    expect(detectDecisionPoint(obs, lens, makeHybridState(), config).trigger).toBe('first-look');
  });

  it('stays quiet inside the cooldown, whatever else changed', () => {
    const obs = baseObservation(20);
    const state = settled(19, obs);
    state.lastPrices = { food_market: 1 };
    const point = detectDecisionPoint(obs, lens, state, config);
    expect(point.trigger).toBeNull();
    expect(point.triggers).toEqual([]);
  });

  it('fires on a sharp price move and not on a gentle one', () => {
    const obs = baseObservation(30);
    const key = Object.keys(obs.prices)[0]!;
    const price = obs.prices[key]!;

    const sharp = settled(20, obs);
    sharp.lastPrices = { ...obs.prices, [key]: Math.round(price / 2) };
    expect(detectDecisionPoint(obs, lens, sharp, config).triggers).toContain('price-move');

    const gentle = settled(20, obs);
    gentle.lastPrices = { ...obs.prices, [key]: Math.round(price * 0.98) };
    expect(detectDecisionPoint(obs, lens, gentle, config).triggers).not.toContain('price-move');
  });

  it('fires the first time an unfamiliar kind of event lands', () => {
    const obs = baseObservation(30);
    const withShock: Observation = {
      ...obs,
      recentEvents: [{ seq: 1, tick: 30, type: 'shock', data: { kind: 'sudden' } }],
    };
    const state = settled(25, withShock);
    state.seenEventTypes = ['worked'];
    expect(detectDecisionPoint(withShock, lens, state, config).triggers).toContain('novel-event');

    state.seenEventTypes = ['worked', 'shock'];
    expect(detectDecisionPoint(withShock, lens, state, config).triggers).not.toContain('novel-event');
  });

  it('fires when a long job comes to an end', () => {
    const obs = baseObservation(40);
    const busy: Observation = { ...obs, self: { ...obs.self, state: { until: 45 } } };
    expect(occupied(busy)).toBe(true);
    expect(occupied(obs)).toBe(false);

    const state = settled(30, busy);
    expect(state.wasOccupied).toBe(true);
    expect(detectDecisionPoint(obs, lens, state, config).triggers).toContain('task-finished');
  });

  it('fires when the agent is under pressure and out of money', () => {
    const obs = baseObservation(50);
    const desperate: Observation = {
      ...obs,
      self: {
        ...obs.self,
        attributes: { ...obs.self.attributes, hunger: 5 },
        resources: { ...obs.self.resources, SOL: 0 },
      },
    };
    const state = settled(40, desperate);
    expect(detectDecisionPoint(desperate, lens, state, config).triggers).toContain(
      'pressure-and-thin',
    );

    const comfortable: Observation = {
      ...obs,
      self: { ...obs.self, attributes: { ...obs.self.attributes, hunger: 5 } },
    };
    expect(detectDecisionPoint(comfortable, lens, settled(40, comfortable), config).triggers).not.toContain(
      'pressure-and-thin',
    );
  });

  it('fires on cadence when nothing else has happened for a while', () => {
    const obs = baseObservation(100);
    const quiet = settled(100 - config.cadenceTicks, obs);
    expect(detectDecisionPoint(obs, lens, quiet, config).triggers).toContain('cadence');

    const recent = settled(97, obs);
    expect(detectDecisionPoint(obs, lens, recent, config).triggers).not.toContain('cadence');
  });
});

class Counting implements DecisionEngine {
  calls = 0;
  constructor(
    readonly name: string,
    private readonly answer: ActionProposal | null,
  ) {}
  async decide(obs: Observation): Promise<ActionProposal | null> {
    this.calls++;
    if (this.answer === null) return null;
    return { ...this.answer, actor: obs.self.id };
  }
}

describe('hybrid routing', () => {
  const obs = baseObservation(0);
  const proposal: ActionProposal = { action: 'idle', actor: 'unset' };

  it('spends on the deliberate engine only at decision points', async () => {
    const routine = new Counting('routine', proposal);
    const deliberate = new Counting('deliberate', proposal);
    const engine = new HybridEngine({
      lens,
      traits: NEUTRAL_TRAITS,
      seed: 1,
      routine,
      deliberate,
      config: { cadenceTicks: 100, cooldownTicks: 3 },
    });

    await engine.decide(obs);
    expect(deliberate.calls).toBe(1);
    expect(routine.calls).toBe(0);

    for (let tick = 1; tick <= 3; tick++) await engine.decide({ ...obs, tick });
    expect(deliberate.calls).toBe(1);
    expect(routine.calls).toBe(3);
    expect(engine.stats.deliberateTicks).toBe(1);
    expect(engine.stats.routineTicks).toBe(3);
  });

  it('falls back to the cheap engine when the deliberate one returns nothing', async () => {
    const routine = new Counting('routine', proposal);
    const deliberate = new Counting('deliberate', null);
    const engine = new HybridEngine({ lens, traits: NEUTRAL_TRAITS, seed: 1, routine, deliberate });

    const result = await engine.decide(obs);
    expect(result?.action).toBe('idle');
    expect(routine.calls).toBe(1);
    expect(engine.stats.deliberateFailures).toBe(1);
  });

  it('labels a deliberate proposal with the trigger that caused it', async () => {
    const engine = new HybridEngine({
      lens,
      traits: NEUTRAL_TRAITS,
      seed: 1,
      routine: new Counting('routine', proposal),
      deliberate: new Counting('deliberate', proposal),
    });
    const result = await engine.decide(obs);
    expect(result?.reason).toContain('first-look');
  });
});
