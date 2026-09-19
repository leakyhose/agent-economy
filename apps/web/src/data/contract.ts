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

export type ServerMessage =
  | StateMessage
  | EventsMessage
  | WorldMessage
  | MetricsMessage
  | MarketMessage;

/** Commands the dashboard sends upstream. Mirrored by the fixture clock. */
export type ClientCommand =
  | { type: 'control'; command: 'start' | 'pause' | 'step' | 'reset' }
  | { type: 'speed'; multiplier: number }
  | { type: 'load'; world: string };

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
