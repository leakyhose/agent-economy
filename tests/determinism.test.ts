import { describe, expect, it } from 'vitest';
import { allFixtures, runScripted } from './harness.ts';

describe('determinism', () => {
  for (const { file, world } of allFixtures()) {
    it(`${file}: same world + same seed + same proposals => identical state`, () => {
      const a = runScripted(world, 120, 4242);
      const b = runScripted(world, 120, 4242);
      expect(a.log).toEqual(b.log);
      expect(a.engine.state).toEqual(b.engine.state);
      expect(a.engine.state.rngCursor).toBe(b.engine.state.rngCursor);
      expect(a.engine.settlements).toEqual(b.engine.settlements);
    });

    it(`${file}: a different script seed diverges`, () => {
      const a = runScripted(world, 60, 1);
      const b = runScripted(world, 60, 2);
      expect(a.engine.state).not.toEqual(b.engine.state);
    });
  }
});
