// Runs the village and serves a dashboard.
//   GET  /        dashboard            GET /state   JSON snapshot
//   POST /start   start a new world    GET /events  live event stream (SSE)
//   POST /stop    stop it
//   POST /pause   freeze after the next round settles    POST /resume  unfreeze
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
let sim = null;          // { W, chain, brain, clock, gen, startedAt, log }
let gen = 0;
const sseClients = new Set();

function broadcast(e) {
  const line = `data: ${JSON.stringify(e)}\n\n`;
  for (const res of sseClients) res.write(line);
  sim?.log.write(JSON.stringify(e) + '\n');
  if (e.type === 'round') {
    const W = sim.W, acts = {};
    for (const a of W.agents) { const k = a.activity?.task ?? 'deciding'; acts[k] = (acts[k] ?? 0) + 1; }
    const st = sim.brain.stats();
    console.log(`round ${String(e.round).padStart(3)} | money ${coins(e.bank.supply)} debt ${coins(e.bank.debtTotal)} equity ${coins(e.bank.equity)} | ` +
      GOODS.map((g, i) => `${g} ${coins(e.prices[i])} (${e.volumes[i]})`).join('  ') +
      ` | fish ${acts.gather_food ?? 0} wood ${acts.gather_wood ?? 0} craft ${acts.craft_net ?? 0} idle ${acts.idle ?? 0}` +
      ` | hungry ${W.agents.filter(a => a.hunger > 0).length} cold ${W.agents.filter(a => a.cold >= 2).length}` +
      (e.foreclosures.length ? ` | FORECLOSED ${e.foreclosures.map(f => `${f.name} (${f.reason})`).join(', ')}` : '') +
      (e.bank.dividend ? ` | dividend ${coins(e.bank.dividend.perAgent)} each` : '') + ` | ${e.txs} tx ${e.ms}ms` +
      (st.calls ? ` | llm ${st.calls} calls $${st.cost.toFixed(3)}` : ''));
  }
  if (e.type === 'error') console.error(`  ! ${e.message}`);
}

async function start() {
  if (sim) return 'already running';
  const myGen = ++gen;
  const brain = await makeBrain();
  const chain = await connectChain();
  const B = CFG.BANK, money = CFG.AGENTS * CFG.START_CASH, bps = x => Math.round(x * 10_000);
  await chain.initialize(CFG.AGENTS, CFG.START_CASH, CFG.START_FOOD, CFG.START_WOOD, CFG.START_PRICES,
    Math.round(B.SEED * money), {
      ltvBps: bps(B.LTV), rateBps: bps(B.RATE), penaltyBps: bps(B.PENALTY), kappaBps: bps(B.KAPPA),
      marginBps: bps(B.MARGIN), termSlots: B.TERM_SLOTS, equityFloor: Math.round(B.EQUITY_FLOOR * money),
    });
  const W = createWorld(chain, await chain.fetch(), { onEvent: e => {
    if (!sim) return;
    broadcast(e);
    if (e.type === 'round' && sim.pausing) freeze();
  } });

  // every run is saved: runs/<timestamp>/events.jsonl + meta.json (+ final.json on stop)
  const dir = path.join(ROOT, 'runs', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    startedAt: new Date().toISOString(), brain: brain.name,
    program: PROGRAM_ID.toBase58(), ledger: chain.ledger.publicKey.toBase58(),
    keeper: chain.keeper.publicKey.toBase58(),
    config: { ...CFG, RPC: undefined },
    agents: W.agents.map(a => ({ id: a.id, name: a.name, skills: a.skills, traits: a.traits })),
  }, null, 2));
  sim = { W, chain, brain, gen: myGen, startedAt: Date.now(), dir, pausing: false, paused: false,
          log: fs.createWriteStream(path.join(dir, 'events.jsonl')) };
  console.log(`logging to ${path.relative(ROOT, dir)}/`);
  console.log(`\nstarted   brain=${brain.name}   agents=${CFG.AGENTS}   ledger ${chain.ledger.publicKey.toBase58()}`);

  const alive = () => sim && sim.gen === myGen;
  async function agentLoop(a) {
    await sleep(Math.random() * CFG.STAGGER_MS);          // staggered wake-up
    while (alive()) {
      if (a.activity || sim.paused) { await sleep(CFG.TICK_MS); continue; }   // no LLM calls while paused
      const tools = makeTools(W, a);
      try { await brain.decide(a, tools); } catch (e) { W.emit('error', { agent: a.id, message: e.message }); }
      if (!alive()) return;
      a.decisions++;
      if (!a.activity) W.startActivity(a, 'idle');
      W.emit('decision', { agent: a.id, name: a.name, thought: a.thought, activity: a.activity?.task,
                           saw: tools.log.saw, actions: tools.log.actions });
    }
  }
  W.agents.forEach(agentLoop);
  sim.clock = setInterval(() => W.step(), CFG.TICK_MS);
  return 'started';
}

// Pausing only ever happens between rounds: /pause sets a flag, and the clock is stopped
// right after the next round has settled on-chain, so no round is left half-applied.
// With the clock stopped no ticks pass: activities don't finish, nobody eats or freezes,
// and idle agents don't call the LLM. Solana's own clock keeps running, though, so loan
// due dates (in slots) still come closer while paused.
function freeze() {
  clearInterval(sim.clock);
  sim.clock = null;
  sim.pausing = false;
  sim.paused = true;
  console.log(`paused after round ${sim.W.round}`);
}

function pause() {
  if (!sim) return 'not running';
  if (sim.paused) return 'already paused';
  sim.pausing = true;
  return 'pausing after this round';
}

function resume() {
  if (!sim) return 'not running';
  if (sim.pausing) { sim.pausing = false; return 'resumed'; }   // cancel a pause still waiting on its round
  if (!sim.paused) return 'not paused';
  sim.paused = false;
  sim.clock = setInterval(() => sim.W.step(), CFG.TICK_MS);
  console.log(`resumed at round ${sim.W.round}`);
  return 'resumed';
}

async function stop() {
  if (!sim) return 'not running';
  clearInterval(sim.clock);
  const s = sim;
  while (s.W.roundBusy) await sleep(50);
  sim = null;
  const L = await s.chain.fetch();
  fs.writeFileSync(path.join(s.dir, 'final.json'), JSON.stringify({
    stoppedAt: new Date().toISOString(), rounds: s.W.round, transactions: s.chain.txCount(),
    llm: s.brain.stats(), chain: L,
  }, null, 2));
  s.log.end();
  console.log(`saved ${path.relative(ROOT, s.dir)}/`);
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
    running: true, paused: sim.paused, pausing: sim.pausing, brain: brain.name, tick: W.tick, round: W.round,
    seconds: Math.round((Date.now() - sim.startedAt) / 1000),
    prices: Object.fromEntries(GOODS.map((g, i) => [g, W.prices[i] / 100])),
    volumes: Object.fromEntries(GOODS.map((g, i) => [g, W.volumes[i]])),
    bank: { supply: W.bank.supply / 100, startSupply: CFG.AGENTS * CFG.START_CASH / 100,
            debt: W.bank.debtTotal / 100, badDebt: W.bank.badDebt / 100, goods: W.bank.goods,
            equity: W.bank.equity / 100, lendingCap: W.bank.lendingCap / 100, capitalRequired: W.bank.capitalRequired / 100,
            books: Object.fromEntries(Object.entries(W.bank.books).map(([k, v]) => [k, v / 100])),
            dividends: W.bank.books.dividendsPaid / 100, lastDividend: W.bank.lastDividend,
            marginCalls: W.marginCalls, overdue: W.overdue,
            keeper: chain.keeper.publicKey.toBase58() },
    totals: { money: sum(a => a.cash) / 100, food: sum(a => a.goods[0]), wood: sum(a => a.goods[1]),
              nets: sum(a => a.goods[2]), boats: sum(a => a.goods[3]), hungry: W.agents.filter(a => a.hunger > 0).length,
              cold: W.agents.filter(a => a.cold >= 2).length },
    doing,
    chain: { program: PROGRAM_ID.toBase58(), ledger: chain.ledger.publicKey.toBase58(),
             explorer: explorer('address', chain.ledger.publicKey.toBase58()),
             transactions: chain.txCount(), lastRound: W.lastRound },
    llm: brain.stats(),
    agents: W.agents.map(a => ({
      id: a.id, name: a.name, skills: a.skills, cash: a.cash / 100,
      food: a.goods[0], wood: a.goods[1], nets: a.goods[2], boats: a.goods[3], locked: a.locked, hunger: a.hunger, cold: a.cold,
      debt: a.debt / 100, dueIn: W.secondsUntilDue(a),
      activity: a.activity?.task ?? 'deciding', thought: a.thought, memory: a.memory,
    })),
    events: W.events.filter(e => e.type === 'round' || e.type === 'error').slice(-15).reverse(),
    foreclosures: W.bankLog.filter(f => f.kind === 'foreclosed').slice(-8).reverse(),
    // live market: price history for the charts, last round's order book, recent trades
    history: W.priceHistory.map(h => ({ ...h, prices: h.prices.map(p => p / 100),
      supply: h.supply / 100, debt: h.debt / 100, badDebt: h.badDebt / 100, equity: h.equity / 100,
      lendingCap: h.lendingCap / 100, dividends: h.dividends / 100, writtenOff: h.writtenOff / 100 })),
    // every loan, repayment and foreclosure, newest first
    bankFeed: W.bankLog.slice(-14).reverse().map(f => ({ ...f, amount: f.amount / 100, ...(f.debt ? { debt: f.debt / 100 } : {}) })),
    market: (() => {
      const rounds = W.events.filter(e => e.type === 'round');
      const last = rounds.at(-1);
      return {
        book: last ? last.book.map((b, g) => ({ good: GOODS[g], ...b,
          bestBid: b.bestBid ? b.bestBid / 100 : null, bestAsk: b.bestAsk ? b.bestAsk / 100 : null })) : [],
        trades: rounds.slice(-8).flatMap(r => (r.trades ?? []).filter(t => t.side === 'buy')
          .map(t => ({ round: r.round, name: W.agents[t.agent].name, good: t.good, qty: t.qty, price: t.price / 100 }))).slice(-12).reverse(),
      };
    })(),
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
    if (req.url === '/pause' && req.method === 'POST') return json(res, { result: pause() });
    if (req.url === '/resume' && req.method === 'POST') return json(res, { result: resume() });
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
  const { W, chain, brain, dir } = sim;
  await stop();
  console.log(`analyze with: node backend/scripts/analyze.mjs ${path.relative(ROOT, dir)}`);
  const L = await chain.fetch(), b = L.books;
  const rich = W.agents.slice().sort((x, y) => y.cash - x.cash);
  const cash = L.slots.reduce((s, x) => s + x.cash, 0), debt = L.slots.reduce((s, x) => s + x.debt, 0);
  const books = b.startMoney + b.bankSeed + b.minted - b.principalRepaid - b.writtenOff;
  const ok = x => x ? 'ok' : 'BROKEN';
  console.log(`\ninvariants: supply ${coins(L.supply)} = Σ cash ${coins(cash)} ${ok(L.supply === cash)}; ` +
    `Σ cash + bank ${coins(cash + L.bank.cash)} = books ${coins(books)} ${ok(cash + L.bank.cash === books)}; ` +
    `debt ${coins(L.debtTotal)} = Σ debt ${coins(debt)} ${ok(L.debtTotal === debt)}`);
  console.log(`bank: equity ${coins(L.equity)} (seed ${coins(b.bankSeed)}), lending cap ${coins(L.lendingCap)}, interest ${coins(b.interestIncome)}, ` +
    `penalties ${coins(b.penalties)}, recovered ${coins(b.recovered)}, written off ${coins(b.writtenOff)}, bad debt ${coins(b.badDebt)}, dividends ${coins(b.dividendsPaid)}; ` +
    `foreclosures ${W.marginCalls} margin call, ${W.overdue} overdue`);
  console.log(`hungry ${W.agents.filter(a => a.hunger > 0).length}/${CFG.AGENTS}   nets ${L.slots.reduce((s, x) => s + x.goods[2], 0)}   boats ${L.slots.reduce((s, x) => s + x.goods[3], 0)}`);
  console.log(`richest ${rich.slice(0, 3).map(a => `${a.name} ${coins(a.cash)}`).join(', ')}`);
  console.log(`poorest ${rich.slice(-3).map(a => `${a.name} ${coins(a.cash)}`).join(', ')}`);
  const st = brain.stats(); if (st.calls) console.log(`llm ${st.calls} calls, ${st.errors} errors, $${st.cost.toFixed(3)}`);
  process.exit(0);
}
