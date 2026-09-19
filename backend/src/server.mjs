// Runs the village and serves a dashboard.
//   GET  /        dashboard            GET /state   JSON snapshot
//   POST /start   start a new world    GET /events  live event stream (SSE)
//   POST /stop    stop it
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { CFG, GOODS, ROOT } from './config.mjs';
import { connectChain, explorer, PROGRAM_ID } from './chain.mjs';
import { createWorld } from './world.mjs';
import { makeTools } from './tools.mjs';
import { stubBrain } from './brains/stub.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const coins = c => (c / 100).toFixed(2);

async function makeBrain() {
  if (CFG.BRAIN === 'openai') {
    if (process.env.OPENAI_API_KEY) return (await import('./brains/openai.mjs')).openaiBrain();
    console.warn('\n  BRAIN=openai but no OPENAI_API_KEY in the repo-root .env. Using the stub.\n');
  }
  if (CFG.BRAIN === 'claude') {
    if (process.env.ANTHROPIC_API_KEY) return (await import('./brains/claude.mjs')).claudeBrain();
    console.warn('\n  BRAIN=claude but no ANTHROPIC_API_KEY in the repo-root .env. Using the stub.\n');
  }
  return stubBrain();
}

// ---- one simulation at a time --------------------------------------------------
let sim = null;          // { W, chain, brain, clock, gen, startedAt }
let gen = 0;
const sseClients = new Set();

function broadcast(e) {
  const line = `data: ${JSON.stringify(e)}\n\n`;
  for (const res of sseClients) res.write(line);
  if (e.type === 'round') {
    const W = sim.W, acts = {};
    for (const a of W.agents) { const k = a.activity?.task ?? 'deciding'; acts[k] = (acts[k] ?? 0) + 1; }
    const st = sim.brain.stats();
    console.log(`round ${String(e.round).padStart(3)} | ` +
      GOODS.map((g, i) => `${g} ${coins(e.prices[i])} (${e.volumes[i]})`).join('  ') +
      ` | fish ${acts.gather_food ?? 0} wood ${acts.gather_wood ?? 0} craft ${acts.craft_net ?? 0} idle ${acts.idle ?? 0}` +
      ` | hungry ${W.agents.filter(a => a.hunger > 0).length} | ${e.txs} tx ${e.ms}ms` +
      (st.calls ? ` | llm ${st.calls} calls $${st.cost.toFixed(3)}` : ''));
  }
  if (e.type === 'error') console.error(`  ! ${e.message}`);
}

async function start() {
  if (sim) return 'already running';
  const myGen = ++gen;
  const brain = await makeBrain();
  const chain = await connectChain();
  await chain.initialize(CFG.AGENTS, CFG.START_CASH, CFG.START_FOOD);
  const W = createWorld(chain, await chain.fetch(), { onEvent: e => sim && broadcast(e) });
  sim = { W, chain, brain, gen: myGen, startedAt: Date.now() };
  console.log(`\nstarted   brain=${brain.name}   agents=${CFG.AGENTS}   ledger ${chain.ledger.publicKey.toBase58()}`);

  const alive = () => sim && sim.gen === myGen;
  async function agentLoop(a) {
    await sleep(Math.random() * CFG.STAGGER_MS);          // staggered wake-up
    while (alive()) {
      if (a.activity) { await sleep(CFG.TICK_MS); continue; }
      try { await brain.decide(a, makeTools(W, a)); } catch (e) { W.emit('error', { agent: a.id, message: e.message }); }
      if (!alive()) return;
      a.decisions++;
      if (!a.activity) W.startActivity(a, 'idle');
      W.emit('thought', { agent: a.id, name: a.name, thought: a.thought, activity: a.activity?.task });
    }
  }
  W.agents.forEach(agentLoop);
  sim.clock = setInterval(() => W.step(), CFG.TICK_MS);
  return 'started';
}

async function stop() {
  if (!sim) return 'not running';
  clearInterval(sim.clock);
  const s = sim; sim = null;
  while (s.W.roundBusy) await sleep(50);
  console.log(`stopped after ${s.W.round} rounds, ${s.chain.txCount()} transactions`);
  return 'stopped';
}

// ---- snapshot for the dashboard ------------------------------------------------
function state() {
  if (!sim) return { running: false, config: { agents: CFG.AGENTS, brain: CFG.BRAIN, model: CFG.MODEL } };
  const { W, chain, brain } = sim;
  const sum = f => W.agents.reduce((s, a) => s + f(a), 0);
  const doing = {};
  for (const a of W.agents) { const k = a.activity?.task ?? 'deciding'; doing[k] = (doing[k] ?? 0) + 1; }
  return {
    running: true, brain: brain.name, tick: W.tick, round: W.round,
    seconds: Math.round((Date.now() - sim.startedAt) / 1000),
    prices: Object.fromEntries(GOODS.map((g, i) => [g, W.prices[i] / 100])),
    volumes: Object.fromEntries(GOODS.map((g, i) => [g, W.volumes[i]])),
    totals: { money: sum(a => a.cash) / 100, food: sum(a => a.goods[0]), wood: sum(a => a.goods[1]),
              nets: sum(a => a.goods[2]), hungry: W.agents.filter(a => a.hunger > 0).length },
    doing,
    chain: { program: PROGRAM_ID.toBase58(), ledger: chain.ledger.publicKey.toBase58(),
             explorer: explorer('address', chain.ledger.publicKey.toBase58()),
             transactions: chain.txCount(), lastRound: W.lastRound },
    llm: brain.stats(),
    agents: W.agents.map(a => ({
      id: a.id, name: a.name, cash: a.cash / 100,
      food: a.goods[0], wood: a.goods[1], nets: a.goods[2], hunger: a.hunger,
      activity: a.activity?.task ?? 'deciding', thought: a.thought, memory: a.memory,
    })),
    events: W.events.filter(e => e.type === 'round' || e.type === 'error').slice(-15).reverse(),
  };
}

// ---- HTTP ----------------------------------------------------------------------
const PAGE = path.join(ROOT, 'backend/public/index.html');
const json = (res, body, code = 200) => {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
};

http.createServer(async (req, res) => {
  try {
    if (req.url === '/state') return json(res, state());
    if (req.url === '/start' && req.method === 'POST') return json(res, { result: await start() });
    if (req.url === '/stop'  && req.method === 'POST') return json(res, { result: await stop() });
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' });
      sseClients.add(res); req.on('close', () => sseClients.delete(res)); return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(fs.readFileSync(PAGE));            // re-read each time: edit the page, refresh
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
}).listen(CFG.PORT, () => console.log(`dashboard: http://localhost:${CFG.PORT}`));

// ---- headless mode: RUN_SECONDS=45 starts immediately, prints a summary, exits ---
if (CFG.RUN_SECONDS) {
  await start();
  await sleep(CFG.RUN_SECONDS * 1000);
  const { W, chain, brain } = sim;
  await stop();
  const L = await chain.fetch();
  const rich = W.agents.slice().sort((x, y) => y.cash - x.cash);
  console.log(`\nmoney on chain ${coins(L.slots.reduce((s, x) => s + x.cash, 0))} (started ${coins(CFG.START_CASH * CFG.AGENTS)})`);
  console.log(`hungry ${W.agents.filter(a => a.hunger > 0).length}/${CFG.AGENTS}   nets ${L.slots.reduce((s, x) => s + x.goods[2], 0)}`);
  console.log(`richest ${rich.slice(0, 3).map(a => `${a.name} ${coins(a.cash)}`).join(', ')}`);
  console.log(`poorest ${rich.slice(-3).map(a => `${a.name} ${coins(a.cash)}`).join(', ')}`);
  const st = brain.stats(); if (st.calls) console.log(`llm ${st.calls} calls, ${st.errors} errors, $${st.cost.toFixed(3)}`);
  process.exit(0);
}
