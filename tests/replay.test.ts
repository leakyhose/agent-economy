import { describe, expect, it } from 'vitest';
import { Engine, Rng, replay } from '@aw/engine';
import { allFixtures, scriptProposals } from './harness.ts';

describe('replay', () => {
  for (const { file, world } of allFixtures()) {
    it(`${file}: 200 ticks replayed into a fresh engine reproduce the state`, async () => {
      const engine = new Engine(world, null);
      engine.init();
      const rng = Rng.fromSeed(7777);
      for (let t = 0; t < 200; t++) {
        for (const p of scriptProposals(engine, rng)) engine.submit(p);
        engine.tick();
      }
      const log = await engine.flush();
      expect(log.length).toBeGreaterThan(200);

      const restored = replay(world, log);
      expect(restored.state).toEqual(engine.state);
      expect(restored.state.tick).toBe(200);
      expect(restored.settlements).toEqual(engine.settlements);
    });
  }
});
