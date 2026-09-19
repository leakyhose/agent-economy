// Resizing a world's population.
//
// A world file declares how many of each type it wants - 18 peasants, 4
// merchants, 3 nobles, 2 kingdoms. Asking for "60 agents" means keeping those
// proportions and scaling them, not inventing a flat headcount: a kingdom with
// 30 kings is a different world, not a bigger one.
import type { PopulationSpec, WorldDefinition } from '@aw/types';

/** The chain ledger is a fixed-size account, so this is a hard ceiling. */
export const MAX_AGENTS = 320;
export const MIN_AGENTS = 2;

export interface Resized {
  world: WorldDefinition;
  requested: number;
  actual: number;
  note?: string;
}

export function resizePopulation(world: WorldDefinition, requested: number): Resized {
  const specs = world.population ?? [];
  const current = specs.reduce((n, s) => n + s.count, 0);
  if (specs.length === 0 || current === 0) {
    return { world, requested, actual: current, note: 'world declares no population' };
  }

  const target = Math.round(Math.min(MAX_AGENTS, Math.max(MIN_AGENTS, requested)));
  if (target === current) return { world, requested, actual: current };

  // Largest-remainder apportionment: scale by the exact ratio, floor, then hand
  // the leftover seats to whoever was rounded down hardest. Keeps the mix
  // faithful and makes the total land exactly on target.
  const exact = specs.map((s) => (s.count * target) / current);
  const scaled: number[] = exact.map((v, i) => {
    // A type the world asked for at all must survive scaling down, or a
    // medieval world with no kingdom stops being that world.
    const floor = Math.floor(v);
    return specs[i]!.count > 0 ? Math.max(1, floor) : 0;
  });

  let drift = target - scaled.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => ({ i, remainder: v - Math.floor(v) }))
    .sort((a, b) => b.remainder - a.remainder || a.i - b.i);

  // Hand out or claw back the rounding difference, deterministically.
  for (let pass = 0; drift !== 0 && pass < specs.length * 4; pass++) {
    for (const { i } of order) {
      if (drift === 0) break;
      if (drift > 0) { scaled[i]! += 1; drift -= 1; }
      else if (scaled[i]! > 1) { scaled[i]! -= 1; drift += 1; }
    }
    if (drift < 0 && scaled.every((c) => c <= 1)) break;   // cannot shrink further
  }

  const population: PopulationSpec[] = specs.map((s, i) => ({ ...s, count: scaled[i]! }));
  const actual = population.reduce((n, s) => n + s.count, 0);

  return {
    world: { ...world, population },
    requested,
    actual,
    ...(actual !== requested
      ? { note: `${requested} requested, ${actual} spawned (${describe(population)})` }
      : {}),
  };
}

const describe = (p: PopulationSpec[]) => p.map((s) => `${s.count} ${s.type}`).join(', ');
