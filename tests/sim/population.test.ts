import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WorldDefinition } from '@aw/types';
import { resizePopulation, MAX_AGENTS, MIN_AGENTS } from '../../apps/sim/src/population.ts';

const worlds = readdirSync(resolve('worlds'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(resolve('worlds', f), 'utf8')) as WorldDefinition);

const total = (w: WorldDefinition) => (w.population ?? []).reduce((n, s) => n + s.count, 0);

describe('choosing how many agents a world runs', () => {
  it.each(worlds.map((w) => [w.name, w] as const))('%s: hits the requested count exactly', (_n, world) => {
    for (const requested of [8, 17, 40, 63, 100, 199, MAX_AGENTS]) {
      expect(resizePopulation(world, requested).actual).toBe(requested);
    }
  });

  it.each(worlds.map((w) => [w.name, w] as const))('%s: keeps the declared mix', (_n, world) => {
    const before = world.population ?? [];
    const after = resizePopulation(world, 200).world.population ?? [];
    const share = (specs: typeof before, type: string) =>
      (specs.find((s) => s.type === type)?.count ?? 0) / specs.reduce((n, s) => n + s.count, 0);

    for (const spec of before) {
      // Proportions survive scaling; a tenth of a point of drift is rounding.
      expect(share(after, spec.type)).toBeCloseTo(share(before, spec.type), 1);
    }
  });

  it.each(worlds.map((w) => [w.name, w] as const))('%s: never drops a declared type', (_n, world) => {
    // A medieval world with no kingdom is a different world, not a smaller one.
    const after = resizePopulation(world, MIN_AGENTS).world.population ?? [];
    for (const spec of world.population ?? []) {
      if (spec.count > 0) {
        expect(after.find((s) => s.type === spec.type)?.count ?? 0).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it.each(worlds.map((w) => [w.name, w] as const))('%s: clamps to the ledger ceiling', (_n, world) => {
    expect(resizePopulation(world, 10_000).actual).toBeLessThanOrEqual(MAX_AGENTS);
    expect(resizePopulation(world, -5).actual).toBeGreaterThanOrEqual(MIN_AGENTS);
  });

  it.each(worlds.map((w) => [w.name, w] as const))('%s: asking for what it already has changes nothing', (_n, world) => {
    const same = resizePopulation(world, total(world));
    expect(same.world.population).toEqual(world.population);
  });

  it('is deterministic', () => {
    const a = resizePopulation(worlds[0]!, 137).world.population;
    const b = resizePopulation(worlds[0]!, 137).world.population;
    expect(a).toEqual(b);
  });
});
