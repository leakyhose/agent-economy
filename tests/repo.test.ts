import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Engine, JsonlRepository, replay, slug } from '@aw/engine';
import { testWorld } from './fixture-world.ts';

const root = mkdtempSync(join(tmpdir(), 'aw-runs-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('JsonlRepository', () => {
  it('slugifies a world name into a directory token', () => {
    expect(slug('Kernel Test World')).toBe('kernel-test-world');
    expect(slug('!!!')).toBe('world');
  });

  it('appends events as JSONL and snapshots state as JSON', async () => {
    const world = testWorld();
    const repo = new JsonlRepository(world.name, root);
    const engine = new Engine(world, repo);
    engine.init();
    for (let t = 0; t < 10; t++) {
      engine.submit({ action: 'produce', actor: `unit_${t % 4}` });
      engine.tick();
      await engine.flush();
    }
    await engine.snapshot();

    const raw = readFileSync(join(root, 'kernel-test-world', 'events.jsonl'), 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines.length).toBeGreaterThan(10);
    expect(JSON.parse(lines[0] as string).type).toBe('world_ready');

    const events = await repo.loadEvents();
    for (let i = 1; i < events.length; i++) {
      expect((events[i] as { seq: number }).seq).toBeGreaterThan(
        (events[i - 1] as { seq: number }).seq,
      );
    }
    expect(await repo.loadSnapshot()).toEqual(engine.state);

    const restored = replay(testWorld(), events);
    expect(restored.state).toEqual(engine.state);
  });

  it('reports an empty log and a null snapshot before anything is written', async () => {
    const repo = new JsonlRepository('never written', root);
    expect(await repo.loadEvents()).toEqual([]);
    expect(await repo.loadSnapshot()).toBeNull();
  });
});
