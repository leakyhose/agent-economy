/**
 * Test doubles. @aw/engine does not exist yet and this package must not depend
 * on it, so everything the agents need — a world state, a tick, an event log —
 * is fabricated here from the world files themselves.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  Entity,
  SimEvent,
  WorldDefinition,
  WorldState,
} from '@aw/types';
import { makeRng } from '../../packages/agents/src/rng.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export const WORLD_FILES = ['economic-sandbox.json', 'medieval-kingdom.json'] as const;

export function loadWorld(file: string): WorldDefinition {
  return JSON.parse(readFileSync(`${ROOT}worlds/${file}`, 'utf8')) as WorldDefinition;
}

export function loadWorlds(): WorldDefinition[] {
  return WORLD_FILES.map(loadWorld);
}

/** A plain starting state: the population the world asks for, nothing more. */
export function makeState(world: WorldDefinition, tick = 0): WorldState {
  const entities: Record<string, Entity> = {};
  let n = 0;
  for (const spec of world.population) {
    const typeDef = world.entityTypes.find((t) => t.id === spec.type);
    for (let i = 0; i < spec.count; i++) {
      const id = `e${n++}`;
      entities[id] = {
        id,
        type: spec.type,
        attributes: { ...(typeDef?.attributes ?? {}), ...(spec.attributes ?? {}) },
        resources: { ...(typeDef?.resources ?? {}) },
        relationships: {},
        owns: [],
        state: {},
      };
    }
  }

  const prices: Record<string, number> = {};
  for (const market of world.markets ?? []) {
    const resource = world.resources.find((r) => r.id === market.resource);
    prices[market.id] = resource?.startPrice ?? 1;
  }

  return { worldName: world.name, tick, entities, prices, rngCursor: 0 };
}

/**
 * A state shaken hard: odd balances, empty stores, pressure, occupied agents,
 * prices well away from their opening levels. The point is to reach the corners
 * a tidy starting state never does.
 */
export function shakeState(world: WorldDefinition, seed: number): WorldState {
  const rng = makeRng(seed);
  const state = makeState(world, rng.int(400));

  for (const id of Object.keys(state.entities)) {
    const entity = state.entities[id];
    if (!entity) continue;
    for (const resource of Object.keys(entity.resources)) {
      const roll = rng.next();
      entity.resources[resource] = roll < 0.3 ? 0 : Math.floor(rng.next() * 12000);
    }
    for (const attribute of Object.keys(entity.attributes)) {
      if (typeof entity.attributes[attribute] === 'number') {
        entity.attributes[attribute] = rng.int(9);
      }
    }
    if (rng.next() < 0.25) entity.state['busyUntil'] = state.tick + 1 + rng.int(8);
    if (rng.next() < 0.2) entity.location = `place-${rng.int(3)}`;
  }

  for (const key of Object.keys(state.prices)) {
    const base = state.prices[key] ?? 1;
    state.prices[key] = Math.max(1, Math.floor(base * (0.3 + rng.next() * 2.2)));
  }
  return state;
}

/** A handful of events of the kinds the world's own rules emit. */
export function makeEvents(world: WorldDefinition, state: WorldState, seed: number): SimEvent[] {
  const rng = makeRng(seed ^ 0x5bf03635);
  const kinds = new Set<string>();
  for (const rule of world.rules) {
    for (const effect of rule.effects) if (effect.op === 'emit') kinds.add(effect.event);
  }
  for (const definition of world.events ?? []) {
    for (const effect of definition.effects) if (effect.op === 'emit') kinds.add(effect.event);
  }
  const names = [...kinds].sort();
  const ids = Object.keys(state.entities).sort();
  const out: SimEvent[] = [];
  const howMany = rng.int(6);
  for (let i = 0; i < howMany; i++) {
    const type = names[rng.int(Math.max(1, names.length))] ?? 'tick';
    const actor = ids[rng.int(Math.max(1, ids.length))] ?? '';
    out.push({ seq: i, tick: state.tick, type, data: { actor } });
  }
  return out;
}

export function agentIds(world: WorldDefinition, state: WorldState): string[] {
  const agentTypes = new Set(world.entityTypes.filter((t) => t.agent).map((t) => t.id));
  return Object.keys(state.entities)
    .sort()
    .filter((id) => agentTypes.has(state.entities[id]?.type ?? ''));
}
