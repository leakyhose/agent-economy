// Runs the village and serves a dashboard.
//   GET  /        dashboard            GET /state   JSON snapshot
//   POST /start   start a new world    GET /events  live event stream (SSE)
//   POST /stop    stop it
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { CFG, GOODS, ROOT, HOUSES } from './config.mjs';
import { connectChain, explorer, PROGRAM_ID, lockedValue } from './chain.mjs';
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
    // the keeper's liquidate signature for each collection / foreclosure, for the dashboard's bank feed
    for (const f of [...e.foreclosures, ...e.collected]) if (f.sig) sim.sigs.set(`${e.round}|${f.kind}|${f.name}`, f.sig);
    const W = sim.W, acts = {};
    for (const a of W.agents) { const k = a.activity?.task ?? 'deciding'; acts[k] = (acts[k] ?? 0) + 1; }
    const st = sim.brain.stats();
    console.log(`round ${String(e.round).padStart(3)} | money ${coins(e.bank.supply)} debt ${coins(e.bank.debtTotal)} equity ${coins(e.bank.equity)} | ` +
      GOODS.map((g, i) => `${g} ${coins(e.prices[i])} (${e.volumes[i]})`).join('  ') +
      ` | fish ${acts.gather_food ?? 0} wood ${acts.gather_wood ?? 0} craft ${acts.craft_net ?? 0} idle ${acts.idle ?? 0}` +
      ` | hungry ${W.agents.filter(a => a.hunger > 0).length} cold ${W.agents.filter(a => a.cold >= 2).length}` +
      ` | real gdp ${coins(e.metrics.realGdp)} houses ${e.metrics.homeowners}+${e.metrics.building}` +
      (e.decide ? ` | waited ${(e.decide.slowest / 1000).toFixed(1)}s${e.decide.timeouts ? ` (${e.decide.timeouts} timed out)` : ''}` : '') +
      (e.collected.length ? ` | collected ${e.collected.map(f => f.name).join(', ')}` : '') +
      (e.foreclosures.length ? ` | FORECLOSED ${e.foreclosures.map(f => f.name).join(', ')}` : '') + ` | ${e.txs} tx ${e.ms}ms` +
      (st.calls ? ` | llm ${st.calls} calls $${st.cost.toFixed(3)}` : ''));
  }
  if (e.type === 'error') console.error(`  ! ${e.message}`);
}

async function start() {
  if (sim) return 'already running';
  const myGen = ++gen;
  const brain = await makeBrain();
  const chain = await connectChain();
  // The bank's terms, fixed on-chain for the life of the ledger. A minute is 60000 / SLOT_MS
  // slots: interest is RATE_PER_MIN per minute held. Terms are chosen in rounds, whose length
  // the chain can't know, so the chain accepts any whole number of slots (unit 1) and the sim
  // sends each new loan's term as rounds × the measured slots per round (world.mjs termSlots).
  // No credit (CREDIT=0) is LTV 0, which the program enforces: every borrow fails.
  const B = CFG.BANK, money = CFG.AGENTS * CFG.START_CASH, bps = x => Math.round(x * 10_000);
  const minute = Math.round(60_000 / CFG.SLOT_MS);
  await chain.initialize(CFG.AGENTS, CFG.START_CASH, CFG.START_FOOD, CFG.START_WOOD, CFG.START_PRICES,
    Math.round(B.SEED * money), {
      ltvBps: B.CREDIT ? bps(B.LTV) : 0, rateBps: bps(B.RATE_PER_MIN), ratePeriodSlots: minute,
      // marginBps 10000 is the loosest lib.rs allows (ltv_bps <= margin_bps <= 10000); the
      // keeper never cites a margin call anyway, so the chain's margin path is dead.
      penaltyBps: bps(B.PENALTY), kappaBps: bps(B.KAPPA), marginBps: bps(B.MARGIN),
      termUnitSlots: 1, maxTermUnits: 65_535, equityFloor: Math.round(B.EQUITY_FLOOR * money),
    });
  const W = createWorld(chain, await chain.fetch(), { onEvent: e => sim && broadcast(e) });

  // every run is saved: runs/<timestamp>/events.jsonl + meta.json (+ final.json on stop)
  const dir = path.join(ROOT, 'runs', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    startedAt: new Date().toISOString(), brain: brain.name,
    program: PROGRAM_ID.toBase58(), ledger: chain.ledger.publicKey.toBase58(),
    keeper: chain.keeper.publicKey.toBase58(),
    mint: chain.mint.toBase58(), vault: chain.vault.toBase58(),
    config: { ...CFG, RPC: undefined },
    agents: W.agents.map(a => ({ id: a.id, name: a.name, skills: a.skills, traits: a.traits })),
  }, null, 2));
  sim = { W, chain, brain, gen: myGen, startedAt: Date.now(), dir, sigs: new Map(),
          log: fs.createWriteStream(path.join(dir, 'events.jsonl')) };
  console.log(`logging to ${path.relative(ROOT, dir)}/`);
  console.log(`\nstarted   brain=${brain.name}   agents=${CFG.AGENTS}   ledger ${chain.ledger.publicKey.toBase58()}`);
  console.log(`SETTLERS  ${chain.mint.toBase58()}   (mint authority: itself — no key for it exists)`);

  const alive = () => sim && sim.gen === myGen && !sim.stopping;
  // One agent's turn: its brain decides, and the round waits up to DECIDE_TIMEOUT_MS. A late
  // answer is discarded: the call is aborted, and any tool it still tries is refused, so it can
  // never touch a round that has already run. Without an answer the agent keeps its last job
  // and has no orders this round.
  async function decideOne(a) {
    const t0 = Date.now(), tools = makeTools(W, a), ac = new AbortController();
    tools.signal = ac.signal;
    W.beginDecision(a);
    let timer;
    const outcome = await Promise.race([
      Promise.resolve().then(() => brain.decide(a, tools)).then(() => 'ok', e => { W.emit('error', { agent: a.id, message: e.message }); return 'error'; }),
      new Promise(r => { timer = setTimeout(() => r('timeout'), CFG.DECIDE_TIMEOUT_MS); }),
    ]);
    clearTimeout(timer);
    tools.close();
    if (outcome === 'timeout') ac.abort();
    const ok = outcome === 'ok' && tools.answered();
    W.endDecision(a, ok);
    if (ok) a.decisions++;
    if (!a.activity) W.keepJob(a);
    const ms = Date.now() - t0;
    W.emit('decision', { agent: a.id, name: a.name, round: W.round + 1, ms, outcome: ok ? 'ok' : outcome === 'ok' ? 'no answer' : outcome,
                         kept: !!a.activity?.kept, thought: a.thought, activity: a.activity?.task,
                         orders: a.orders.map(o => ({ side: o.side, good: GOODS[o.good], qty: o.qty, limit: o.limit, seq: o.seq })),
                         saw: tools.log.saw, actions: tools.log.actions });
    return { ms, timedOut: outcome === 'timeout', ok };
  }
  // The clock: every round, all agents decide at once; the round waits for the slowest (up to
  // the timeout), then plays out — shifts, meals, fires, rot, the market — and settles on-chain.
  async function clock() {
    while (alive()) {
      const t0 = Date.now();
      const res = await Promise.all(W.agents.map(decideOne));
      if (!alive()) return;
      const ms = res.map(r => r.ms).sort((x, y) => x - y);
      await W.playRound({ waitMs: Date.now() - t0, slowest: ms.at(-1), median: ms[ms.length >> 1],
                          timeouts: res.filter(r => r.timedOut).length, noAnswer: res.filter(r => !r.ok && !r.timedOut).length });
    }
  }
  sim.clock = clock().catch(e => console.error(`clock stopped: ${e.stack}`));
  return 'started';
}

async function stop() {
  if (!sim) return 'not running';
  const s = sim;
  s.stopping = true;
  await s.clock;                  // the round in progress finishes; a decision phase in progress is dropped
  sim = null;
  const L = await s.chain.fetch();
  fs.writeFileSync(path.join(s.dir, 'final.json'), JSON.stringify({
    stoppedAt: new Date().toISOString(), rounds: s.W.round, transactions: s.chain.txCount(),
    llm: s.brain.stats(), chain: L,
    mint: s.chain.mint.toBase58(), settlersSupply: await s.chain.settlersSupply(),
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
    running: true, brain: brain.name, round: W.round, roundMs: Math.round(W.roundMs),
    decide: W.lastRound?.decide ?? null,
    seconds: Math.round((Date.now() - sim.startedAt) / 1000),
    prices: Object.fromEntries(GOODS.map((g, i) => [g, W.prices[i] / 100])),
    volumes: Object.fromEntries(GOODS.map((g, i) => [g, W.volumes[i]])),
    bank: { supply: W.bank.supply / 100, startSupply: CFG.AGENTS * CFG.START_CASH / 100,
            debt: W.bank.debtTotalNow / 100, badDebt: W.bank.badDebt / 100, goods: W.bank.goods,
            creditOn: W.bank.terms.ltvBps > 0, ratePerMin: W.ratePerMin(), ratePerRound: W.ratePerRound(), terms: W.termRounds(), autoRepaid: W.autoRepaid,
            equity: W.bank.equity / 100, lendingCap: W.bank.lendingCap / 100, capitalRequired: W.bank.capitalRequired / 100,
            books: Object.fromEntries(Object.entries(W.bank.books).map(([k, v]) => [k, v / 100])),
            overdue: W.overdue,
            keeper: chain.keeper.publicKey.toBase58() },
    totals: { money: sum(a => a.cash) / 100, food: sum(a => a.goods[0]), wood: sum(a => a.goods[1]),
              nets: sum(a => a.goods[2]), houses: sum(a => W.houses(a)), homeowners: W.agents.filter(a => W.hasHouse(a)).length,
              building: W.agents.filter(a => a.building).length, housesBuilt: W.housesBuilt, hungry: W.agents.filter(a => a.hunger > 0).length,
              cold: W.agents.filter(a => a.cold >= 2).length },
    doing,
    chain: { program: PROGRAM_ID.toBase58(), ledger: chain.ledger.publicKey.toBase58(),
             explorer: explorer('address', chain.ledger.publicKey.toBase58()),
             mint: chain.mint.toBase58(), mintExplorer: explorer('address', chain.mint.toBase58()),
             settlers: W.settlersSupply,
             transactions: chain.txCount(), lastRound: W.lastRound },
    llm: brain.stats(),
    agents: W.agents.map(a => ({
      id: a.id, name: a.name, skills: Object.fromEntries(Object.entries(a.skills).map(([k, v]) => [k, +v.toFixed(2)])), cash: a.cash / 100,
      food: a.goods[0], wood: a.goods[1], nets: a.goods[2], houses: W.houses(a), house: W.hasHouse(a),
      // a build in progress: shifts worked, out of what it takes this agent (crafting skill sets that)
      building: a.building?.shifts ?? null, buildShifts: (a.building?.shifts ?? 0) + W.buildShiftsLeft(a),
      locked: a.locked, hunger: a.hunger, cold: a.cold,
      debt: W.debtNow(a) / 100, dueIn: W.roundsUntilDue(a), wellbeing: a.wellbeing, wealth: W.wealth(a) / 100,
      orders: a.orders.map(o => `${o.side} ${o.qty} ${GOODS[o.good]} @ ${coins(o.limit)}`),
      activity: a.activity?.task ?? 'deciding', thought: a.thought, memory: a.memory,
    })),
    events: W.events.filter(e => e.type === 'round' || e.type === 'error').slice(-15).reverse(),
    foreclosures: W.bankLog.filter(f => f.kind === 'foreclosed').slice(-8).reverse(),
    metrics: (h => h ? { ...h, gdp: h.gdp / 100, realGdp: (h.realGdp ?? 0) / 100, slack: h.slack / 100, credit: h.credit / 100, money: h.money / 100 } : null)(W.priceHistory.at(-1)),
    // live market: price history for the charts, last round's order book, recent trades
    history: W.priceHistory.map(h => ({ ...h, prices: h.prices.map(p => p / 100),
      supply: h.supply / 100, debt: h.debt / 100, badDebt: h.badDebt / 100, equity: h.equity / 100,
      lendingCap: h.lendingCap / 100, writtenOff: h.writtenOff / 100,
      gdp: h.gdp / 100, realGdp: (h.realGdp ?? 0) / 100, slack: h.slack / 100, credit: h.credit / 100, money: h.money / 100 })),
    // every loan, repayment and foreclosure, newest first
    bankFeed: W.bankLog.slice(-14).reverse().map(f => ({ ...f, amount: f.amount / 100, ...(f.debt ? { debt: f.debt / 100 } : {}),
      ...(f.refund ? { refund: f.refund / 100 } : {}), sig: sim.sigs.get(`${f.round}|${f.kind}|${f.name}`) ?? null })),
    market: (() => {
      const rounds = W.events.filter(e => e.type === 'round');
      const last = rounds.at(-1);
      return {
        book: last ? last.book.map((b, g) => ({ good: GOODS[g], ...b,
          bestBid: b.bestBid ? b.bestBid / 100 : null, bestAsk: b.bestAsk ? b.bestAsk / 100 : null, bankPrice: b.bankPrice ? b.bankPrice / 100 : null })) : [],
        ladder: (W.lastLadder ?? []).map((l, g) => ({ good: GOODS[g], asks: l.asks, bids: l.bids, price: l.price / 100, sold: l.sold,
          offered: l.offered, wanted: l.wanted, bankSale: (s => s && { qty: s.qty, price: s.price / 100 })(W.bankAsk(g)) })),
        live: last?.live ?? 0,
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
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' });
      sseClients.add(res); req.on('close', () => sseClients.delete(res)); return;
    }
    // no-store: the page is re-read from disk every request, so the browser must never
    // serve a cached copy — a stale dashboard silently breaks charts after a redeploy.
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
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
  const sumS = f => L.slots.reduce((s, x) => s + f(x), 0);
  const cash = sumS(x => x.cash), debt = sumS(x => x.debt), principal = sumS(x => x.principal);
  const ok = x => x ? 'ok' : 'BROKEN';
  // every book the program keeps (lib.rs header)
  const inv = [
    ['supply = Σ cash', L.supply === cash],
    ['Σ cash + bank cash = start + seed + minted − repaid − written off', cash + L.bank.cash === b.startMoney + b.bankSeed + b.minted - b.principalRepaid - b.writtenOff],
    ['bank cash = seed + interest + penalties + recovered − refunds − written off − dividends',
      L.bank.cash === b.bankSeed + b.interestIncome + b.penalties + b.recovered - b.refunds - b.writtenOff - b.dividendsPaid],
    ['minted = Σ principal + repaid + written off + bad debt', b.minted === principal + b.principalRepaid + b.writtenOff + b.badDebt],
    ['Σ bank book = seized − sold', L.inventory === b.seizedValue - b.soldBook],
    ['debt total = Σ debt', L.debtTotal === debt],
    ['bad debt ⇒ bank cash 0', !b.badDebt || !L.bank.cash],
    ['per agent: principal ≤ debt; no debt ⇒ nothing owed or locked', L.slots.every(x => x.principal <= x.debt && (x.debt || (!x.principal && !lockedValue(x, L.lastPrice))))],
  ];
  const settlers = await chain.settlersSupply();
  inv.push(['SETTLERS supply = Σ cash + bank cash', settlers === cash + L.bank.cash]);
  console.log(`\ninvariants: ${inv.map(([k, v]) => `${k} ${ok(v)}`).join('; ')}`);
  console.log(`SETTLERS ${chain.mint.toBase58()}: ${coins(settlers)} in existence, all of it minted by the bank's rules`);
  console.log(`bank: equity ${coins(L.equity)} (seed ${coins(b.bankSeed)}), lending cap ${coins(L.lendingCap)}, interest ${coins(b.interestIncome)}, ` +
    `penalties ${coins(b.penalties)}, recovered ${coins(b.recovered)}, refunds ${coins(b.refunds)}, written off ${coins(b.writtenOff)}, bad debt ${coins(b.badDebt)}; ` +
    `${W.autoRepaid} collected at the deadline, ${W.overdue} foreclosed overdue`);
  const m = W.priceHistory.at(-1) ?? {};
  console.log(`houses built ${W.housesBuilt}, being built ${W.agents.filter(a => a.building).length}, homeowners ${m.homeowners}   ` +
    `GDP ${coins(W.priceHistory.reduce((s, h) => s + h.gdp, 0))} over the run   avg wellbeing ${m.wellbeing}   price index ${m.priceIndex}   wealth gini ${m.gini}`);
  console.log(`hungry ${W.agents.filter(a => a.hunger > 0).length}/${CFG.AGENTS}   nets ${sumS(x => x.goods[2])}`);
  console.log(`richest ${rich.slice(0, 3).map(a => `${a.name} ${coins(a.cash)}`).join(', ')}`);
  console.log(`poorest ${rich.slice(-3).map(a => `${a.name} ${coins(a.cash)}`).join(', ')}`);
  const st = brain.stats(); if (st.calls) console.log(`llm ${st.calls} calls, ${st.errors} errors, $${st.cost.toFixed(3)}`);
  process.exit(0);
}
