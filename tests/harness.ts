// Shared test harness: load the fixture worlds and script a seeded, repeatable
// stream of proposals against whatever a world happens to declare.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ActionProposal, Entity, Json, WorldDefinition } from '@aw/types';
import { Engine, PARAM_LIMIT, PARAM_QUANTITY, PARAM_RESOURCE, Rng, loadWorld } from '@aw/engine';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const WORLD_FILES = [
  'worlds/economic-sandbox.json',
  'worlds/medieval-kingdom.json',
] as const;

export function readWorldFile(rel: string): string {
  return readFileSync(ROOT + rel, 'utf8');
}

export function loadFixture(rel: string): WorldDefinition {
  return loadWorld(readWorldFile(rel));
}

export function allFixtures(): { file: string; world: WorldDefinition }[] {
  return WORLD_FILES.map((file) => ({ file, world: loadFixture(file) }));
}

function sortedEntityList(engine: Engine): Entity[] {
  return Object.keys(engine.state.entities)
    .sort()
    .map((id) => engine.state.entities[id] as Entity);
}

function priceHint(engine: Engine, resource: string): number {
  const market = (engine.world.markets ?? []).find((m) => m.resource === resource);
  if (market) {
    const p = engine.state.prices[market.id];
    if (typeof p === 'number' && p > 0) return p;
  }
  const def = engine.world.resources.find((r) => r.id === resource);
  return def?.startPrice && def.startPrice > 0 ? def.startPrice : 1;
}

/**
 * Build one tick's worth of proposals. Purely a function of the engine's
 * current state and the supplied cursor, so the same cursor replays exactly.
 */
export function scriptProposals(engine: Engine, rng: Rng): ActionProposal[] {
  const out: ActionProposal[] = [];
  const entities = sortedEntityList(engine);
  const tradables = (engine.world.markets ?? []).map((m) => m.resource);
  const resources = tradables.length > 0 ? tradables : engine.world.resources.map((r) => r.id);

  for (const entity of entities) {
    if (rng.next() < 0.35) continue;
    const options = engine.availableActions(entity.id);
    if (options.length === 0) continue;
    const actionId = rng.pick(options);
    if (!actionId) continue;
    const def = engine.world.actions.find((a) => a.id === actionId);
    if (!def) continue;

    const params: Record<string, Json> = {};
    let resource = rng.pick(resources) ?? (resources[0] as string);
    for (const p of def.params ?? []) {
      if (p.type === 'resource' || p.name === PARAM_RESOURCE) {
        params[p.name] = resource;
      } else if (p.name === PARAM_QUANTITY) {
        params[p.name] = 1 + rng.int(3);
      } else if (p.name === PARAM_LIMIT) {
        const base = priceHint(engine, resource);
        params[p.name] = Math.max(1, Math.round(base * (0.7 + rng.int(60) / 100)));
      } else if (p.type === 'number') {
        params[p.name] = 1 + rng.int(500);
      } else if (p.type === 'entity') {
        params[p.name] = (rng.pick(entities) ?? entity).id;
      } else {
        params[p.name] = 'x';
      }
    }

    const proposal: ActionProposal = { action: actionId, actor: entity.id, params };
    if (def.targetTypes && def.targetTypes.length > 0) {
      const candidates = entities.filter(
        (e) => def.targetTypes?.includes(e.type) && e.id !== entity.id,
      );
      const target = rng.pick(candidates);
      if (!target) continue;
      proposal.target = target.id;
    }
    out.push(proposal);
  }
  return out;
}

/** Run a world for `ticks` ticks with a scripted, seeded proposal stream. */
export function runScripted(
  world: WorldDefinition,
  ticks: number,
  scriptSeed = 99,
): { engine: Engine; log: ActionProposal[][] } {
  const engine = new Engine(world, null);
  engine.init();
  const rng = Rng.fromSeed(scriptSeed);
  const log: ActionProposal[][] = [];
  for (let t = 0; t < ticks; t++) {
    const batch = scriptProposals(engine, rng);
    log.push(batch);
    for (const p of batch) engine.submit(p);
    engine.tick();
  }
  return { engine, log };
}

export function totalOf(engine: Engine, resource: string): number {
  return Object.values(engine.state.entities).reduce(
    (sum, e) => sum + ((e as Entity).resources[resource] ?? 0),
    0,
  );
}
