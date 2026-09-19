// Storage seam. JSONL on disk today, Postgres later, same interface.

import type { Repository, SimEvent, WorldState } from '@aw/types';

/** Filesystem-free repository, for tests and for dry runs. */
export class MemoryRepository implements Repository {
  private events: SimEvent[] = [];
  private snapshot: WorldState | null = null;

  async appendEvents(events: SimEvent[]): Promise<void> {
    this.events.push(...events.map((e) => structuredClone(e)));
  }

  async loadEvents(): Promise<SimEvent[]> {
    return this.events.map((e) => structuredClone(e));
  }

  async saveSnapshot(state: WorldState): Promise<void> {
    this.snapshot = structuredClone(state);
  }

  async loadSnapshot(): Promise<WorldState | null> {
    return this.snapshot === null ? null : structuredClone(this.snapshot);
  }
}

/** Slugify a world name into a directory-safe token. */
export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'world'
  );
}

/**
 * Appends events to `<root>/<world>/events.jsonl` and writes the snapshot to
 * `<root>/<world>/snapshot.json`.
 */
export class JsonlRepository implements Repository {
  readonly dir: string;
  private ready: Promise<void> | null = null;

  constructor(worldName: string, root = 'runs') {
    this.dir = `${root}/${slug(worldName)}`;
  }

  private async ensure(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(this.dir, { recursive: true });
      })();
    }
    return this.ready;
  }

  private get eventsPath(): string {
    return `${this.dir}/events.jsonl`;
  }

  private get snapshotPath(): string {
    return `${this.dir}/snapshot.json`;
  }

  async appendEvents(events: SimEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.ensure();
    const { appendFile } = await import('node:fs/promises');
    await appendFile(this.eventsPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  }

  async loadEvents(): Promise<SimEvent[]> {
    const { readFile } = await import('node:fs/promises');
    let text: string;
    try {
      text = await readFile(this.eventsPath, 'utf8');
    } catch {
      return [];
    }
    return text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as SimEvent);
  }

  async saveSnapshot(state: WorldState): Promise<void> {
    await this.ensure();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(this.snapshotPath, JSON.stringify(state, null, 2), 'utf8');
  }

  async loadSnapshot(): Promise<WorldState | null> {
    const { readFile } = await import('node:fs/promises');
    try {
      return JSON.parse(await readFile(this.snapshotPath, 'utf8')) as WorldState;
    } catch {
      return null;
    }
  }
}
