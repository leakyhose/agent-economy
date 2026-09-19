/**
 * Replays a generated run against the same message contract the live server
 * speaks. The dashboard cannot tell the difference between the two.
 */
import type { WorldDefinition } from '@aw/types';
import type { ClientCommand, ServerMessage, SimSource, TransportStatus } from './contract.ts';
import { FixtureEngine } from './fixture.ts';

export interface FixtureOptions {
  /** Population multiplier, for proving the views hold up under load. */
  scale?: number;
  /** Ticks to run before the first frame, so the run opens mid-flight. */
  warmup?: number;
}

export class FixtureSource implements SimSource {
  readonly kind = 'fixture' as const;

  private engine: FixtureEngine;
  private listeners = new Set<(message: ServerMessage) => void>();
  private statusListeners = new Set<(status: TransportStatus, detail?: string) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private multiplier = 1;
  private world: WorldDefinition;

  constructor(world: WorldDefinition, options: FixtureOptions = {}) {
    this.world = world;
    this.engine = new FixtureEngine(world, options.scale ?? 1);
    for (let i = 0; i < (options.warmup ?? 0); i += 1) this.engine.step();
    queueMicrotask(() => {
      this.status('open');
      this.emitSnapshot();
    });
  }

  private status(status: TransportStatus, detail?: string): void {
    for (const listener of this.statusListeners) listener(status, detail);
  }

  private emit(message: ServerMessage): void {
    for (const listener of this.listeners) listener(message);
  }

  private emitSnapshot(): void {
    this.emit({ type: 'world', world: this.world });
    const result = this.engine.step();
    this.emit({ type: 'state', state: result.state });
    this.emit({ type: 'metrics', metrics: result.metrics });
    this.emit({ type: 'market', books: result.books });
    this.emit({ type: 'events', events: result.events });
  }

  subscribe(listener: (message: ServerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: (status: TransportStatus, detail?: string) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private tick(): void {
    const result = this.engine.step();
    this.emit({ type: 'state', state: result.state });
    this.emit({ type: 'metrics', metrics: result.metrics });
    this.emit({ type: 'market', books: result.books });
    if (result.events.length > 0) this.emit({ type: 'events', events: result.events });
  }

  private run(): void {
    this.halt();
    const interval = Math.max(40, (this.engine.config.tickMs || 500) / this.multiplier);
    this.timer = setInterval(() => this.tick(), interval);
  }

  private halt(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  setScale(scale: number): void {
    const running = this.timer !== null;
    this.halt();
    this.engine.setScale(scale);
    this.emitSnapshot();
    if (running) this.run();
  }

  send(command: ClientCommand): void {
    switch (command.type) {
      case 'control':
        if (command.command === 'start') this.run();
        if (command.command === 'pause') this.halt();
        if (command.command === 'step') { this.halt(); this.tick(); }
        if (command.command === 'reset') {
          this.halt();
          this.engine.reset();
          this.emitSnapshot();
        }
        break;
      case 'speed':
        this.multiplier = Math.max(0.25, command.multiplier);
        if (this.timer !== null) this.run();
        break;
      default:
        break;
    }
  }

  dispose(): void {
    this.halt();
    this.listeners.clear();
    this.statusListeners.clear();
  }
}
