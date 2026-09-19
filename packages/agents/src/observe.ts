/**
 * Turning world state into what one agent is allowed to know.
 *
 * Partial information lives here. An agent never touches `WorldState`; it gets
 * an `Observation` that a visibility policy has already filtered. That is what
 * makes "A knows X, B does not" representable, and it is why a price is worth
 * discovering rather than simply read off the state.
 */

import type {
  Entity,
  EntityId,
  Observation,
  SimEvent,
  WorldDefinition,
  WorldState,
} from '@aw/types';
import type { Memory } from './memory.ts';
import { makeLens, type WorldLens } from './lens.ts';

export interface VisibilityPolicy {
  readonly name: string;
  /** Other entities this agent perceives, already redacted. */
  entities(self: Entity, state: WorldState): Entity[];
  /** Prices this agent has access to, keyed by market id. */
  prices(self: Entity, state: WorldState): Record<string, number>;
  /** Events this agent witnessed. */
  events(self: Entity, visible: Entity[], events: readonly SimEvent[], state: WorldState): SimEvent[];
}

export type VisibilityPolicyName = 'omniscient' | 'local' | 'marketBoard';

function others(self: Entity, state: WorldState): Entity[] {
  const out: Entity[] = [];
  for (const id of Object.keys(state.entities).sort()) {
    if (id === self.id) continue;
    const entity = state.entities[id];
    if (entity) out.push(entity);
  }
  return out;
}

/** Strip the holdings of another entity; keep its public shape. */
function redactHoldings(entity: Entity): Entity {
  return { ...entity, resources: {} };
}

function referencedIds(event: SimEvent, state: WorldState): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      if (state.entities[node] && !out.includes(node)) out.push(node);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    for (const value of Object.values(node as Record<string, unknown>)) walk(value);
  };
  walk(event.data);
  return out;
}

/**
 * An event is witnessed when it names nobody (a public happening) or names
 * someone this agent can already see.
 */
function witnessed(
  self: Entity,
  visible: Entity[],
  events: readonly SimEvent[],
  state: WorldState,
): SimEvent[] {
  const seen = new Set<string>([self.id, ...visible.map((e) => e.id)]);
  return events.filter((event) => {
    const ids = referencedIds(event, state);
    if (ids.length === 0) return true;
    return ids.some((id) => seen.has(id));
  });
}

/** Everything. Useful for debugging and for worlds that want perfect knowledge. */
export const omniscient: VisibilityPolicy = {
  name: 'omniscient',
  entities: (self, state) => others(self, state),
  prices: (_self, state) => ({ ...state.prices }),
  events: (_self, _visible, events) => [...events],
};

/**
 * Same place only. An entity with no stated location is treated as standing in
 * one shared default space, so a world that does not model geography degrades
 * to "everyone is a neighbour" rather than to "nobody exists".
 */
export const local: VisibilityPolicy = {
  name: 'local',
  entities: (self, state) => others(self, state).filter((e) => e.location === self.location),
  prices: (_self, state) => ({ ...state.prices }),
  events: (self, visible, events, state) => witnessed(self, visible, events, state),
};

/**
 * The default. You know your own holdings and the public prices; you can see
 * that other agents exist and what kind of thing they are, but not what they
 * are sitting on. Perfect information makes a market pointless.
 */
export const marketBoard: VisibilityPolicy = {
  name: 'marketBoard',
  entities: (self, state) => others(self, state).map(redactHoldings),
  prices: (_self, state) => ({ ...state.prices }),
  events: (self, visible, events, state) => witnessed(self, visible, events, state),
};

export const VISIBILITY_POLICIES: Record<VisibilityPolicyName, VisibilityPolicy> = {
  omniscient,
  local,
  marketBoard,
};

export const DEFAULT_VISIBILITY: VisibilityPolicy = marketBoard;

export function visibilityPolicy(
  policy?: VisibilityPolicy | VisibilityPolicyName,
): VisibilityPolicy {
  if (!policy) return DEFAULT_VISIBILITY;
  if (typeof policy === 'string') return VISIBILITY_POLICIES[policy] ?? DEFAULT_VISIBILITY;
  return policy;
}

export interface ObserveOptions {
  /** Events from this tick window. The caller owns the log; we only read it. */
  events?: readonly SimEvent[];
  /** Overrides the query used to pull memories. */
  memoryQuery?: string;
  memoryLimit?: number;
  recentEventLimit?: number;
  /** Reuse a lens instead of deriving one per call. */
  lens?: WorldLens;
}

/**
 * Which actions this actor could legally attempt right now: allowed for its
 * type, and — when the action needs a target — with at least one visible
 * candidate to point at. Everything else is the engine's business.
 */
function availableFor(self: Entity, visible: Entity[], lens: WorldLens): string[] {
  return lens.actionsFor(self.type).filter((id) => {
    const info = lens.info(id);
    if (!info) return false;
    if (info.targetTypes.length === 0) return true;
    return visible.some((e) => info.targetTypes.includes(e.type));
  });
}

function defaultQuery(self: Entity, prices: Record<string, number>, lens: WorldLens): string {
  const parts: string[] = [self.type];
  for (const attribute of lens.pressureAttributes) parts.push(attribute);
  for (const key of Object.keys(prices).sort()) parts.push(key);
  return parts.join(' ');
}

export function buildObservation(
  entityId: EntityId,
  state: WorldState,
  world: WorldDefinition,
  memory: Memory,
  policy?: VisibilityPolicy | VisibilityPolicyName,
  options: ObserveOptions = {},
): Observation {
  const self = state.entities[entityId];
  if (!self) throw new Error(`buildObservation: no entity "${entityId}" in state`);

  const lens = options.lens ?? makeLens(world);
  const chosen = visibilityPolicy(policy);
  const visible = chosen.entities(self, state);
  const prices = chosen.prices(self, state);
  const eventLog = options.events ?? [];
  const witnessedEvents = chosen.events(self, visible, eventLog, state);
  const eventCap = options.recentEventLimit ?? 12;
  const recentEvents = witnessedEvents.slice(Math.max(0, witnessedEvents.length - eventCap));

  memory.setTick(state.tick);
  const query = options.memoryQuery ?? defaultQuery(self, prices, lens);
  const memories = memory.recall(query, options.memoryLimit ?? 6);

  return {
    tick: state.tick,
    self,
    availableActions: availableFor(self, visible, lens),
    visibleEntities: visible,
    prices,
    recentEvents,
    memories,
  };
}
