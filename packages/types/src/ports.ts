import type { ActionProposal } from './actions.ts';
import type { Entity, EntityId, SimEvent, WorldState } from './state.ts';
import type { WorldDefinition, Json } from './world.ts';

/**
 * What an agent is allowed to see. Constructed by filtering world state through
 * the world's visibility policy, so partial information is representable
 * (brief §10) rather than every agent having perfect knowledge.
 */
export interface Observation {
  tick: number;
  self: Entity;
  /** Only the actions this actor may legally attempt right now. */
  availableActions: string[];
  /** Other entities this agent can perceive, already filtered. */
  visibleEntities: Entity[];
  /** Market prices this agent has access to. */
  prices: Record<string, number>;
  /** Recent events this agent witnessed. */
  recentEvents: SimEvent[];
  /** Retrieved memories, newest first. */
  memories: string[];
}

/** Brief §9. Implementations: rule-based, utility, LLM, hybrid. */
export interface DecisionEngine {
  readonly name: string;
  decide(obs: Observation): Promise<ActionProposal | null>;
}

/**
 * The only module that touches private keys. The agent package must never
 * import this — enforced structurally, not by convention (brief §12, §30).
 */
export interface WalletService {
  addressFor(entity: EntityId): Promise<string>;
  getBalance(entity: EntityId): Promise<number>;
  getTokenBalances(entity: EntityId): Promise<Record<string, number>>;
}

/** A settlement intent produced by a `settle` effect. */
export interface SettlementIntent {
  tick: number;
  asset: string;
  from: EntityId;
  to: EntityId;
  amount: number;
}

/** Batches intents to chain asynchronously; the sim never blocks on RPC. */
export interface SettlementQueue {
  enqueue(intent: SettlementIntent): void;
  /** Flush pending intents. Resolves with confirmed signatures. */
  flush(): Promise<string[]>;
  pending(): number;
}

/** Storage seam. JSONL today, Postgres later, same interface. */
export interface Repository {
  appendEvents(events: SimEvent[]): Promise<void>;
  loadEvents(): Promise<SimEvent[]>;
  saveSnapshot(state: WorldState): Promise<void>;
  loadSnapshot(): Promise<WorldState | null>;
}

/** What a provider has spent so far. Cost is in US dollars. */
export interface LLMUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  /** Tokens served from the provider's cache, where it reports them. */
  cachedTokens: number;
  costUsd: number;
  errors: number;
  rateLimited: number;
}

export interface LLMProvider {
  readonly name: string;
  complete(system: string, user: string): Promise<string>;
  /** Running total for this provider instance. Absent on providers that cost
   *  nothing to run, so a caller must treat it as optional. */
  usage?(): LLMUsage;
}

export type { WorldDefinition, Json };
