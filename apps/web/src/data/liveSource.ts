/** The same contract over a socket. Reconnects quietly; never blocks the UI. */
import type { ClientCommand, ServerMessage, SimSource, TransportStatus } from './contract.ts';

export const DEFAULT_ENDPOINT = 'ws://localhost:8787';

export class LiveSource implements SimSource {
  readonly kind = 'live' as const;

  private socket: WebSocket | null = null;
  private listeners = new Set<(message: ServerMessage) => void>();
  private statusListeners = new Set<(status: TransportStatus, detail?: string) => void>();
  private queue: ClientCommand[] = [];
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private closed = false;

  constructor(private endpoint: string = DEFAULT_ENDPOINT) {
    this.connect();
  }

  private status(status: TransportStatus, detail?: string): void {
    for (const listener of this.statusListeners) listener(status, detail);
  }

  private connect(): void {
    if (this.closed) return;
    this.status('connecting', this.endpoint);
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.endpoint);
    } catch (error) {
      this.status('error', error instanceof Error ? error.message : 'socket refused');
      this.scheduleRetry();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.attempts = 0;
      this.status('open', this.endpoint);
      for (const command of this.queue.splice(0)) socket.send(JSON.stringify(command));
    };
    socket.onmessage = (frame) => {
      try {
        const parsed = JSON.parse(String(frame.data)) as ServerMessage;
        if (parsed && typeof parsed.type === 'string') {
          for (const listener of this.listeners) listener(parsed);
        }
      } catch {
        // A malformed frame is not worth tearing the stream down for.
      }
    };
    socket.onerror = () => this.status('error', this.endpoint);
    socket.onclose = () => {
      this.socket = null;
      if (this.closed) return;
      this.status('closed', this.endpoint);
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    if (this.closed || this.retry !== null) return;
    this.attempts += 1;
    const delay = Math.min(8000, 600 * 2 ** Math.min(this.attempts, 4));
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, delay);
  }

  subscribe(listener: (message: ServerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: (status: TransportStatus, detail?: string) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  send(command: ClientCommand): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(command));
    } else {
      this.queue.push(command);
    }
  }

  dispose(): void {
    this.closed = true;
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    this.socket?.close();
    this.socket = null;
    this.listeners.clear();
    this.statusListeners.clear();
  }
}
