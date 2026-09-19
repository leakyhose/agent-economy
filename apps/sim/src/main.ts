// The simulation runner: wires the kernel, the agent layer and the chain layer
// together, and streams the result to the dashboard.
//
// This file is the ONLY place the four layers meet. Each of them depends on
// @aw/types and on nothing else, which is what let them be built in parallel.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Engine, JsonlRepository, loadWorld } from '@aw/engine';
import { Agent, makeDecisionEngine, makeMemory } from '@aw/agents';
import { CFG } from './config.ts';
import { startServer } from './server.ts';
import { makeSettlement } from './settlement.ts';
import type { ActionProposal, WorldDefinition } from '@aw/types';

async function main() {
  const raw = JSON.parse(readFileSync(resolve(CFG.WORLD), 'utf8'));
  const world: WorldDefinition = loadWorld(raw);       // throws loudly on a bad world

  const repo = new JsonlRepository(`runs/${slug(world.name)}`);
  const engine = new Engine(world, repo);
  await engine.init();

  const settlement = await makeSettlement(world);

  // One Agent per entity whose type is declared `agent: true`. The runner does
  // not know what those types are called - it reads them from the world file.
  const agentTypes = new Set(world.entityTypes.filter(t => t.agent).map(t => t.id));
  const agents = new Map<string, Agent>();
  for (const e of Object.values(engine.state.entities)) {
    if (!agentTypes.has(e.type)) continue;
    agents.set(e.id, new Agent({
      id: e.id,
      seed: world.seed ^ hash(e.id),
      decision: makeDecisionEngine(CFG.BRAIN, { world, seed: world.seed ^ hash(e.id) }),
      memory: makeMemory(),
      wallet: await settlement.addressFor(e.id),
    }));
  }

  const server = startServer(CFG.PORT, { engine, world, agents });
  console.log(`[sim] ${world.name}: ${agents.size} agents, ${world.markets?.length ?? 0} markets`);
  console.log(`[sim] chain=${CFG.CHAIN ? CFG.RPC : 'off'}  dashboard=ws://localhost:${CFG.PORT}`);

  let ticks = 0;
  for (;;) {
    if (server.running) {
      // Agents propose. Nothing they return can mutate state directly - every
      // proposal goes through engine.submit, which validates against the rules.
      const proposals = await Promise.all(
        [...agents.values()].map(a => a.act(engine.state, world).catch(() => null)),
      );
      for (const p of proposals) if (p) engine.submit(p as ActionProposal);

      const result = engine.tick();
      for (const intent of result.settlements) settlement.enqueue(intent);
      server.broadcast(result);
      ticks++;
      if (CFG.RUN_TICKS && ticks >= CFG.RUN_TICKS) break;
    }
    await sleep(server.tickMs);
  }

  const sigs = await settlement.flush();
  console.log(`[sim] done at tick ${engine.state.tick}; ${sigs.length} settled on chain`);
  process.exit(0);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const hash = (s: string) => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

main().catch(e => { console.error('[sim] fatal:', e); process.exit(1); });
