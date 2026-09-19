import type { EntityTypeId, ResourceId, Json } from './world.ts';

export type EntityId = string;

export interface Entity {
  id: EntityId;
  type: EntityTypeId;
  attributes: Record<string, Json>;
  resources: Record<ResourceId, number>;
  /** kind -> entity ids. e.g. "employer" -> ["entity_7"]. */
  relationships: Record<string, EntityId[]>;
  /** Entity ids this entity owns. Ownership is first-class (brief §15). */
  owns: EntityId[];
  ownedBy?: EntityId;
  location?: string;
  /** Free-form per-entity simulation state (busy-until, current task, ...). */
  state: Record<string, Json>;
}

export interface WorldState {
  worldName: string;
  tick: number;
  entities: Record<EntityId, Entity>;
  /** Last clearing price per market id, in integer minor units. */
  prices: Record<string, number>;
  /** PRNG cursor. Part of state so a snapshot fully determines the future. */
  rngCursor: number;
}

/** Everything that has happened. Replaying this log reproduces state exactly. */
export interface SimEvent {
  seq: number;
  tick: number;
  type: string;
  data: Record<string, Json>;
  /** Present once the corresponding on-chain settlement confirms. */
  signature?: string;
}
