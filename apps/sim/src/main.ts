// The simulation runner: the single place the four layers meet.
//
// Each layer depends on @aw/types and nothing else, which is what let them be
// built in parallel. The wiring lives here and only here.
import { resolve } from 'node:path';
import { Engine, JsonlRepository, computeMetrics, loadWorldFile } from '@aw/engine';
import {
  createAgent, createProvider, makeLens,
  type Agent, type EngineKind, type ProviderKind,
} from '@aw/agents';
import type { ActionProposal, SimEvent } from '@aw/types';
import { CFG } from './config.ts';

const explorer = (sig: string) =>
  `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(CFG.RPC)}`;
import { startServer } from './server.ts';
import { makeSettlement } from './settlement.ts';
import { settlementsFromFills } from './market-settlement.ts';

async function main() {
  const world = await loadWorldFile(resolve(CFG.WORLD));   // throws loudly on a bad world
  const repo = new JsonlRepository(world.name);   // it slugs the name itself
  const engine = new Engine(world, repo);
  engine.init();

  const settlement = await makeSettlement(world);

  // Wallet addresses first: createPopulation needs them while constructing agents.
  // The runner never learns which types are agents - it reads that from the world.
  const agentTypes = new Set(world.entityTypes.filter((t) => t.agent).map((t) => t.id));
  const addresses = new Map<string, string>();
  for (const entity of Object.values(engine.state.entities)) {
    if (agentTypes.has(entity.type)) {
      addresses.set(entity.id, await settlement.addressFor(entity.id));
    }
  }

  // A population of one policy is a degenerate market: 24 identical deterministic
  // agents all reach the same conclusion, so everyone bids and nobody asks, or the
  // reverse. Markets need disagreement (brief §9, §10). BRAIN=mix - the default -
  // deals the engines round-robin so the population actually trades with itself.
  const lens = makeLens(world);
  const mix = CFG.BRAIN === 'mix';

  // One provider shared by every agent, so the concurrency limit is a real
  // ceiling on in-flight requests rather than one per agent.
  const provider = createProvider({
    kind: CFG.PROVIDER as ProviderKind,
    model: CFG.MODEL,
    concurrency: CFG.LLM_CONCURRENCY,
    onFallback: (reason) => console.warn(`[sim] ${reason}`),
  });
  const usesModel = CFG.BRAIN === 'llm' || CFG.BRAIN === 'hybrid' || mix;
  // A quarter pure-LLM so there is always a model talking, a quarter hybrid so
  // most model spend goes to agents at an actual decision point, and half
  // deterministic so somebody is reliably on the other side of the book.
  const kinds: EngineKind[] = ['llm', 'hybrid', 'utility', 'rule'];
  const agents: Agent[] = [];
  let n = 0;
  for (const id of Object.keys(engine.state.entities).sort()) {
    const entity = engine.state.entities[id];
    if (!entity || !agentTypes.has(entity.type)) continue;
    const kind = mix ? kinds[n % kinds.length]! : (CFG.BRAIN as EngineKind);
    agents.push(createAgent({
      id, lens, kind,
      seed: world.seed ^ (n * 0x9e3779b1),
      walletAddress: addresses.get(id) ?? `offchain:${id}`,
      ...(usesModel ? { provider } : {}),
    }));
    n++;
  }

  const server = startServer(CFG.PORT, { engine, world });
  const tally = agents.reduce<Record<string, number>>((acc, a) => {
    const k = a.engine?.name ?? 'unknown'; acc[k] = (acc[k] ?? 0) + 1; return acc;
  }, {});
  console.log(`[sim] ${world.name}: ${agents.length} agents, ${world.markets?.length ?? 0} markets`);
  console.log(`[sim] engines: ${Object.entries(tally).map(([k, v]) => `${v}x${k}`).join(' ')}`);
  console.log(`[sim] brain=${CFG.BRAIN}  model=${provider.name === 'stub' ? 'stub' : `${provider.name}/${CFG.MODEL}`}  chain=${CFG.CHAIN ? CFG.RPC : 'off'}  ws://localhost:${CFG.PORT}`);

  let recent: SimEvent[] = [];
  let ticks = 0;

  for (;;) {
    if (server.running) {
      // Agents propose. Nothing an agent returns can mutate state: every proposal
      // goes through engine.submit, which validates it against the world's rules.
      // Skip agents the engine would reject as busy. They are mid-action, so a
      // proposal from them is discarded anyway - and asking a model to think for
      // an agent that cannot act is the single easiest way to waste money.
      const ready = agents.filter((a) => {
        const busy = engine.state.entities[a.id]?.state['busyUntil'];
        return typeof busy !== 'number' || busy <= engine.state.tick;
      });
      const proposals = await Promise.all(
        ready.map((a) => a.act(engine.state, world, recent).catch(() => null)),
      );
      for (const p of proposals) if (p) engine.submit(p as ActionProposal);

      const result = engine.tick();
      recent = result.events.slice(-32);
      // Two sources of settlement: explicit `settle` effects declared by rules,
      // and market fills, which a world opts into with chain.onChainMarkets.
      for (const intent of result.settlements) settlement.enqueue(intent);
      for (const intent of settlementsFromFills(result.events, world, result.tick)) {
        settlement.enqueue(intent);
      }

      server.broadcast({
        ...result,
        state: engine.state,
        metrics: computeMetrics(world, engine.state),
      });

      ticks++;
      if (CFG.RUN_TICKS && ticks >= CFG.RUN_TICKS) break;
    }
    await sleep(server.tickMs);
  }

  const signatures = await settlement.flush();
  await engine.flush();
  await engine.snapshot();
  console.log(`[sim] stopped at tick ${engine.state.tick}; ${signatures.length} settled on chain`);
  for (const sig of signatures.slice(0, 5)) {
    console.log(`[sim]   ${sig}`);
    console.log(`[sim]   ${explorer(sig)}`);
  }
  if (signatures.length > 5) console.log(`[sim]   ... and ${signatures.length - 5} more`);
  process.exit(0);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

main().catch((e) => { console.error('[sim] fatal:', e); process.exit(1); });
