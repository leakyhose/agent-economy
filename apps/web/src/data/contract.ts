/**
 * The wire contract between this dashboard and the simulation server.
 *
 * The four message kinds below are the agreed surface. `market` is an optional
 * extension the dashboard renders when present and simply lives without when it
 * is not, so a server that only implements the four required kinds still drives
 * every view except the depth ladder.
 */
import type { SimEvent, WorldDefinition, WorldState } from '@aw/types';

export interface StateMessage {
  type: 'state';
  state: WorldState;
}

export interface EventsMessage {
  type: 'events';
  events: SimEvent[];
}

export interface WorldMessage {
  type: 'world';
  world: WorldDefinition;
}

export interface MetricsMessage {
  type: 'metrics';
  metrics: Record<string, number>;
}

/** Optional extension: resting interest on each market, newest round first. */
export interface MarketMessage {
  type: 'market';
  books: Record<string, OrderBook>;
}

export interface OrderBookLevel {
  price: number;
  quantity: number;
  orders: number;
}

export interface OrderBook {
  marketId: string;
  /** Resting interest to acquire, best (highest) price first. */
  demand: OrderBookLevel[];
  /** Resting interest to release, best (lowest) price first. */
  supply: OrderBookLevel[];
  lastPrice: number;
  previousPrice: number;
  volume: number;
  clearedAtTick: number;
}

/** A model the server is willing to run, as it advertises them. */
export interface ModelChoice {
  id: string;
  label: string;
  provider: 'stub' | 'openai';
  /** [input, output] $ per 1M tokens. Absent for the stub, which is free. */
  price?: [number, number];
  note?: string;
}

export interface BrainChoice {
  id: string;
  label: string;
  note?: string;
}

/** What the server is currently running. Optional: a server that never sends
 *  one simply leaves the dashboard's own numbers in place. */
export interface StatusMessage {
  type: 'status';
  running: boolean;
  world: string;
  worlds: string[];
  tick: number;
  speed: number;
  chain: string | null;
  model: string;
  agents?: number;
  agentLimits?: { min: number; max: number };
  agentNote?: string;
  brain?: string;
  catalogue?: { models: ModelChoice[]; brains: BrainChoice[] };
  hasKey?: boolean;
  /** The server is rebuilding a population; a large one takes real seconds. */
  loading?: boolean;
  /** What this run has actually spent. Absent when nothing is metered. */
  usage?: LLMUsage | null;
}

/** What the model has cost so far. Mirrors @aw/types. */
export interface LLMUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd: number;
  errors: number;
  rateLimited: number;
}

export type ServerMessage =
  | StatusMessage
  | StateMessage
  | EventsMessage
  | WorldMessage
  | MetricsMessage
  | MarketMessage;

/** Commands the dashboard sends upstream. Mirrored by the fixture clock. */
export type ClientCommand =
  | { type: 'control'; command: 'start' | 'pause' | 'step' | 'reset' }
  | { type: 'speed'; multiplier: number }
  | { type: 'load'; world: string; agents?: number; model?: string; brain?: string };

export type TransportStatus = 'offline' | 'connecting' | 'open' | 'closed' | 'error';

/** Both the fixture replay and the live socket expose exactly this. */
export interface SimSource {
  readonly kind: 'fixture' | 'live';
  /** Returns an unsubscribe handle. */
  subscribe(listener: (message: ServerMessage) => void): () => void;
  onStatus(listener: (status: TransportStatus, detail?: string) => void): () => void;
  send(command: ClientCommand): void;
  dispose(): void;
}
