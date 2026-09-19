import { describe, expect, it } from 'vitest';
import { Memory } from '../../packages/agents/src/memory.ts';
import { makeLens } from '../../packages/agents/src/lens.ts';
import {
  buildObservation,
  local,
  marketBoard,
  omniscient,
  visibilityPolicy,
} from '../../packages/agents/src/observe.ts';
import { agentIds, loadWorld, makeEvents, makeState, shakeState, WORLD_FILES } from './fixtures.ts';

describe.each(WORLD_FILES)('observation over %s', (file) => {
  const world = loadWorld(file);
  const lens = makeLens(world);

  it('defaults to the market board: own holdings, public prices, no one else’s balances', () => {
    const state = makeState(world, 7);
    const [self] = agentIds(world, state);
    const obs = buildObservation(self!, state, world, new Memory(), undefined, { lens });

    expect(obs.tick).toBe(7);
    expect(obs.self.id).toBe(self);
    expect(Object.keys(obs.self.resources).length).toBeGreaterThan(0);
    expect(obs.prices).toEqual(state.prices);
    expect(obs.visibleEntities.length).toBeGreaterThan(0);
    for (const other of obs.visibleEntities) {
      expect(other.id).not.toBe(self);
      expect(other.resources).toEqual({});
      expect(other.type).toBe(state.entities[other.id]?.type);
    }
  });

  it('shows everything under the omniscient policy', () => {
    const state = makeState(world);
    const [self] = agentIds(world, state);
    const obs = buildObservation(self!, state, world, new Memory(), 'omniscient', { lens });
    const other = obs.visibleEntities[0];
    expect(other).toBeDefined();
    expect(other!.resources).toEqual(state.entities[other!.id]?.resources);
  });

  it('restricts the local policy to one place', () => {
    const state = makeState(world);
    const ids = agentIds(world, state);
    const self = ids[0]!;
    state.entities[self]!.location = 'here';
    for (const id of ids.slice(1)) state.entities[id]!.location = 'elsewhere';
    state.entities[ids[1]!]!.location = 'here';

    const obs = buildObservation(self, state, world, new Memory(), 'local', { lens });
    expect(obs.visibleEntities.map((e) => e.id)).toEqual([ids[1]]);
  });

  it('only offers actions the actor’s type may attempt', () => {
    const state = makeState(world);
    for (const id of agentIds(world, state)) {
      const obs = buildObservation(id, state, world, new Memory(), undefined, { lens });
      expect(obs.availableActions.length).toBeGreaterThan(0);
      for (const action of obs.availableActions) {
        const info = lens.info(action);
        expect(info).not.toBeNull();
        if (info!.actorTypes.length > 0) {
          expect(info!.actorTypes).toContain(obs.self.type);
        }
        if (info!.targetTypes.length > 0) {
          expect(obs.visibleEntities.some((e) => info!.targetTypes.includes(e.type))).toBe(true);
        }
      }
    }
  });

  it('passes through witnessed events and the agent’s own recollections', () => {
    const state = shakeState(world, 99);
    const self = agentIds(world, state)[0]!;
    const events = makeEvents(world, state, 99);
    const memory = new Memory();
    memory.remember('long', 'something worth knowing', 0.9);

    const obs = buildObservation(self, state, world, memory, 'omniscient', { lens, events });
    expect(obs.recentEvents).toHaveLength(events.length);
    expect(obs.memories).toContain('something worth knowing');
    expect(memory.tick).toBe(state.tick);
  });

  it('refuses to observe on behalf of an entity that is not there', () => {
    const state = makeState(world);
    expect(() => buildObservation('nobody', state, world, new Memory(), undefined, { lens })).toThrow(
      /no entity/,
    );
  });
});

describe('visibility policy selection', () => {
  it('resolves names and falls back to the market board', () => {
    expect(visibilityPolicy('omniscient')).toBe(omniscient);
    expect(visibilityPolicy('local')).toBe(local);
    expect(visibilityPolicy('marketBoard')).toBe(marketBoard);
    expect(visibilityPolicy()).toBe(marketBoard);
    expect(visibilityPolicy('nonsense' as 'local')).toBe(marketBoard);
  });
});
