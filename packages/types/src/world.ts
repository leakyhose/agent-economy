import type { Rule, Effect, Expr } from './rules.ts';
import type { ChainConfig, OrganizationDef } from './chain.ts';

// The world definition. Everything world-specific lives here as DATA.
// The engine reads these strings; it never knows what they mean.

/** A resource name, e.g. "SOL", "food", "iron". Opaque to the engine. */
export type ResourceId = string;
/** An entity type name, e.g. "person", "company", "kingdom". Opaque to the engine. */
export type EntityTypeId = string;
/** An action name, e.g. "work", "trade", "declare_war". Opaque to the engine. */
export type ActionId = string;

export interface ResourceDef {
  id: ResourceId;
  /** Declared by the world (brief §13): does this settle on chain? */
  onChain?: boolean;
  /** Fraction of free stock lost per round. 0 = imperishable. */
  spoilage?: number;
  /** Starting price hint for markets, in integer minor units. */
  startPrice?: number;
  divisible?: boolean;
}

export interface EntityTypeDef {
  id: EntityTypeId;
  /** Entities of this type run a decision loop. */
  agent?: boolean;
  /** Default attribute values for entities spawned as this type. */
  attributes?: Record<string, Json>;
  /** Default resource endowment. */
  resources?: Record<ResourceId, number>;
}

export interface ActionDef {
  id: ActionId;
  /** Which entity types may perform this. Empty/absent = any. */
  actorTypes?: EntityTypeId[];
  /** Which entity types may be targeted. Absent = no target. */
  targetTypes?: EntityTypeId[];
  /** Declared parameter names, for proposal validation and LLM prompting. */
  params?: ActionParamDef[];
  /** How many ticks the action occupies the actor. Default 1. */
  duration?: number;
  /** Human-readable, used in agent prompts. */
  description?: string;
}

export interface ActionParamDef {
  name: string;
  type: 'number' | 'string' | 'entity' | 'resource';
  required?: boolean;
}

export interface MarketDef {
  id: string;
  /** Resource being bought and sold. */
  resource: ResourceId;
  /** Resource used to pay. */
  currency: ResourceId;
  mechanism: 'batch_auction' | 'fixed_price';
  /** Clear every N ticks. */
  roundTicks?: number;
}

export interface TimeDef {
  /** Real milliseconds per tick when running live. */
  tickMs?: number;
  /** Label for what one tick represents, e.g. "hour", "day". Cosmetic. */
  unit?: string;
}

export interface WorldDefinition {
  name: string;
  /** Determinism: same seed + same decision stream = same state. */
  seed: number;
  time?: TimeDef;
  resources: ResourceDef[];
  entityTypes: EntityTypeDef[];
  actions: ActionDef[];
  rules: Rule[];
  markets?: MarketDef[];
  /** Initial population, by entity type. */
  population: PopulationSpec[];
  /** Scheduled or probabilistic world events (brief §20). */
  events?: WorldEventDef[];
  /** World-specific metrics (brief §28). */
  metrics?: MetricDef[];
  /** How this world maps onto Solana (brief §11, §13). Optional: a world
   *  that declares none of this still runs, entirely off chain. */
  chain?: ChainConfig;
  /** Organizations this world defines (brief §18). */
  organizations?: OrganizationDef[];
}

export interface PopulationSpec {
  type: EntityTypeId;
  count: number;
  /** Attribute overrides applied to this cohort. */
  attributes?: Record<string, Json>;
}

export interface WorldEventDef {
  id: string;
  /** Fires on this tick, or every N ticks if `every` is set. */
  atTick?: number;
  every?: number;
  /** Probability per tick, 0..1. Drawn from the seeded PRNG. */
  chance?: number;
  effects: Effect[];
  description?: string;
}

export interface MetricDef {
  id: string;
  /** Aggregate a numeric expression across entities. */
  aggregate: 'sum' | 'mean' | 'max' | 'min' | 'count' | 'gini';
  over?: EntityTypeId;
  value?: Expr;
}

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
