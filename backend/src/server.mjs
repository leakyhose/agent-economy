// Runs the village and serves a dashboard.
//   GET  /        island view          GET /state   JSON snapshot
//   GET  /dashboard  the dashboard
//   POST /start   start a new world    GET /events  live event stream (SSE)
//   POST /stop    stop it
//   POST /pause   pause after the current round      POST /resume  continue
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CFG, GOODS, ROOT, HOUSES } from './config.mjs';
import { connectChain, explorer, PROGRAM_ID, lockedValue, MAX_AGENTS } from './chain.mjs';
import { createWorld } from './world.mjs';
import { makeTools } from './tools.mjs';
import { stubBrain } from './brains/stub.mjs';
import { snapshot as tunableSnapshot, apply as applyTunables, preset as presetChanges } from './tunables.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const coins = c => (c / 100).toFixed(2);

// Which brains a run can be driven by. .env picks the default; the dashboard's dropdown
// passes a choice to /start, so openai and baseten can be compared without a restart.
export const BRAINS = ['stub', 'openai', 'baseten'];

// A brain is built once per run: its agents are bound to their models and its token tallies
// belong to that run, so the choice is made at /start and holds until the run stops. A brain
// asked for without its key falls back to the stub rather than killing the run.
async function makeBrain(choice = CFG.BRAIN) {
  if (choice === 'openai') {
    if (process.env.OPENAI_API_KEY) return (await import('./brains/openai.mjs')).openaiBrain();
    console.warn('\n  brain=openai but no OPENAI_API_KEY in the repo-root .env. Using the stub.\n');
  }
  if (choice === 'baseten') {
    if (process.env.BASETEN_API_KEY) return await (await import('./brains/baseten.mjs')).basetenBrain();
    console.warn('\n  brain=baseten but no BASETEN_API_KEY in the repo-root .env. Using the stub.\n');
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
  // Each villager's decisions, kept for the dashboard's per-agent log (GET /agent). The
  // observation (`saw`) is left out — it is kilobytes a turn and is in events.jsonl anyway.
  if (e.type === 'decision' && sim?.agentLog) {
    const log = sim.agentLog.get(e.agent) ?? [];
    if (!log.length) sim.agentLog.set(e.agent, log);
    log.push({ t: e.t, round: e.round, outcome: e.outcome, ms: e.ms, kept: e.kept, thought: e.thought, activity: e.activity,
               orders: e.orders,
               actions: (e.actions ?? []).map(x => ({ tool: x.tool, input: x.input, result: String(x.result ?? '').slice(0, 400), ...(x.rejected ? { rejected: true } : {}) })) });
    if (log.length > 1000) log.shift();
  }
  if (e.type === 'round') {
    // the bank's collect signature for each collection / foreclosure, for the dashboard's bank feed
    for (const f of [...e.foreclosures, ...e.collected]) if (f.sig) sim.sigs.set(`${e.round}|${f.kind}|${f.name}`, f.sig);
    const W = sim.W, acts = {};
    for (const a of W.agents) { const k = a.activity?.task ?? 'deciding'; acts[k] = (acts[k] ?? 0) + 1; }
    const st = sim.brain.stats();
    console.log(`round ${String(e.round).padStart(3)} | money ${coins(e.bank.supply)} debt ${coins(e.bank.debtTotal)} equity ${coins(e.bank.equity)} | ` +
      GOODS.map((g, i) => `${g} ${coins(e.prices[i])} (${e.volumes[i]})`).join('  ') +
      ` | fish ${acts.gather_food ?? 0} wood ${acts.gather_wood ?? 0} craft ${acts.craft_net ?? 0} idle ${acts.idle ?? 0}` +
      ` | hungry ${W.agents.filter(a => a.hunger > 0).length} cold ${W.agents.filter(a => a.cold >= 2).length}` +
      ` | real gdp ${coins(e.metrics.realGdp)} houses ${e.metrics.homeowners}+${e.metrics.building}` +
      (e.decide ? ` | decide p50 ${(e.decide.p50 ?? e.decide.median) / 1000 | 0}.${String(Math.round(((e.decide.p50 ?? e.decide.median) % 1000) / 100))}s` +
        ` waited ${(e.decide.slowest / 1000).toFixed(1)}s${e.decide.timeouts ? ` (${e.decide.timeouts} timed out)` : ''}` +
        `${e.decide.stragglers ? ` (${e.decide.stragglers} left behind)` : ''}` : '') +
      (e.collected.length ? ` | collected ${e.collected.map(f => f.name).join(', ')}` : '') +
      (e.foreclosures.length ? ` | FORECLOSED ${e.foreclosures.map(f => f.name).join(', ')}` : '') + ` | ${e.txs} tx ${e.ms}ms` +
      // where the chain half of the round went, so a slow round can be read, not guessed
      (e.phases ? ` [${Object.entries(e.phases).filter(([, v]) => v >= 20).map(([k, v]) => `${k} ${v}`).join(' ')}]` : '') +
      (st.calls ? ` | llm ${st.calls} calls $${st.cost.toFixed(3)}${st.rateLimited ? ` ${st.rateLimited} 429s` : ''}` : ''));
  }
  if (e.type === 'error') console.error(`  ! ${e.message}`);
}

// How many villagers, from the dashboard or from .env. The ledger has room for MAX_AGENTS
// and the program refuses more, so the dial stops where the chain does.
function setAgents(n) {
  const want = Math.round(+n);
  if (!Number.isFinite(want) || want < 1) return CFG.AGENTS;
  CFG.AGENTS = Math.min(want, MAX_AGENTS);
  return CFG.AGENTS;
}

// { brain, agents } from the dashboard; whatever is left out is what .env says, or the last run's.
async function start({ brain: choice, agents } = {}) {
  if (sim) return 'already running';
  if (agents != null) setAgents(agents);
  const myGen = ++gen;
  const brain = await makeBrain(BRAINS.includes(choice) ? choice : CFG.BRAIN);
  const chain = await connectChain();
  // The bank's terms, fixed on-chain for the life of the ledger. Interest is
  // BANK.RATE_PER_ROUND per ROUND held. Terms are chosen in rounds, whose length the chain
  // can't know, so the chain accepts any whole number of slots (unit 1) and the sim sends
  // each new loan's term as rounds × the measured slots per round (world.mjs termSlots).
  // No credit (CREDIT=0) is LTV 0, which the program enforces: every borrow fails.
  const B = CFG.BANK, money = CFG.AGENTS * CFG.START_CASH, bps = x => Math.round(x * 10_000);
  // Measure the cluster's slot length rather than assume it. The chain can only count
  // slots, so a rate per round has to be sent as a rate per so many slots — and a validator
  // run with shorter slots (backend/scripts/validator.sh TICKS_PER_SLOT) puts more slots in
  // the same round. Measured once here and written back to CFG, which world.mjs reads live,
  // so neither the slot length nor the round length changes the rate the dial names.
  CFG.SLOT_MS = Math.round(await chain.measureSlotMs());
  const roundSlots = Math.max(1, Math.round(CFG.ROUND_MS_EXPECTED / CFG.SLOT_MS));
  console.log(`slot ${CFG.SLOT_MS}ms measured — a round of interest is ${roundSlots} slots ` +
    `(${(CFG.ROUND_MS_EXPECTED / 1000).toFixed(1)}s), ${(B.RATE_PER_ROUND * 100).toFixed(2)}% a round`);
  await chain.initialize(CFG.AGENTS, CFG.START_CASH, CFG.START_FOOD, CFG.START_WOOD, CFG.START_PRICES,
    Math.round(B.SEED * money), {
      // The ledger's LTV is the run's hard ceiling, enforced by the program and unchangeable
      // once the ledger exists. The bank's policy today (CFG.BANK.LTV, which the control
      // panel moves) is applied inside it by world.mjs — so the panel can tighten credit
      // mid-run and can never loosen it past what the chain agreed to.
      ltvBps: B.CREDIT ? bps(Math.max(B.LTV, B.LTV_CEILING)) : 0, rateBps: bps(B.RATE_PER_ROUND), ratePeriodSlots: roundSlots,
      // marginBps 10000 is the loosest lib.rs allows (ltv_bps <= margin_bps <= 10000); the
      // keeper never cites a margin call anyway, so the chain's margin path is dead.
      penaltyBps: bps(B.PENALTY), kappaBps: bps(B.KAPPA), marginBps: bps(B.MARGIN),
      termUnitSlots: 1, maxTermUnits: 65_535, equityFloor: Math.round(B.EQUITY_FLOOR * money),
    });
  // Every agent gets a purse: an SPL token account of their own, so the coins they earn
  // and spend are real SETTLERS moving between real addresses, not a number in our ledger.
  await chain.initPurses(CFG.AGENTS);
  await chain.settleCash(Array.from({ length: CFG.AGENTS }, (_, i) => i));

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
  sim = { W, chain, brain, gen: myGen, startedAt: Date.now(), dir, sigs: new Map(), agentLog: new Map(),
          paused: false, pausing: false, resumeClock: null,
          log: fs.createWriteStream(path.join(dir, 'events.jsonl')) };
  console.log(`logging to ${path.relative(ROOT, dir)}/`);
  console.log(`\nstarted   brain=${brain.name}   agents=${CFG.AGENTS}   ledger ${chain.ledger.publicKey.toBase58()}`);
  console.log(`SETTLERS  ${chain.mint.toBase58()}   (mint authority: itself — no key for it exists)`);

  const alive = () => sim && sim.gen === myGen && !sim.stopping;
  // One agent's turn: its brain decides, and the round waits up to DECIDE_TIMEOUT_MS — or
  // until a quorum of the village has answered (CFG.DECIDE_QUORUM), whichever comes first.
  // A late answer is discarded either way: the call is aborted, tools.close() refuses
  // anything it still tries, and endDecision has already emptied its draft — so a straggler
  // can neither touch the round that has run nor leak an order into the next one. Without an
  // answer the agent keeps its last job and has no orders this round.
  // `quorum` is the round's shared barrier: a promise that resolves once enough have answered.
  async function decideOne(a, quorum) {
    const t0 = Date.now(), tools = makeTools(W, a), ac = new AbortController();
    tools.signal = ac.signal;
    W.beginDecision(a);
    let timer;
    const outcome = await Promise.race([
      Promise.resolve().then(() => brain.decide(a, tools)).then(() => 'ok', e => { W.emit('error', { agent: a.id, message: e.message }); return 'error'; }),
      new Promise(r => { timer = setTimeout(() => r('timeout'), CFG.DECIDE_TIMEOUT_MS); }),
      quorum.reached.then(() => 'straggler'),
    ]);
    clearTimeout(timer);
    tools.close();
    const straggler = outcome === 'straggler';
    if (outcome === 'timeout' || straggler) ac.abort();
    const ok = outcome === 'ok' && tools.answered();
    W.endDecision(a, ok);
    if (ok) a.decisions++;
    if (!a.activity) W.keepJob(a);
    // Anyone whose own call came back counts toward the quorum, answer or not — a village
    // where half the brains error out must still be able to close its round.
    if (outcome === 'ok' || outcome === 'error') quorum.answered();
    const ms = Date.now() - t0;
    // Per agent, the moment that agent's own decision lands — not batched at the round
    // barrier. `outcome` keeps its old vocabulary ('ok' | 'timeout' | 'error' | 'no answer')
    // so nothing downstream has to learn a new word; a villager the quorum left behind is a
    // 'timeout' carrying `straggler: true`.
    W.emit('decision', { agent: a.id, name: a.name, round: W.round + 1, ms,
                         outcome: ok ? 'ok' : outcome === 'ok' ? 'no answer' : straggler ? 'timeout' : outcome,
                         ...(straggler ? { straggler: true } : {}),
                         kept: !!a.activity?.kept, thought: a.thought, activity: a.activity?.task,
                         place: a.activity?.place ?? null,
                         orders: a.orders.map(o => ({ side: o.side, good: GOODS[o.good], qty: o.qty, limit: o.limit, seq: o.seq })),
                         saw: tools.log.saw, actions: tools.log.actions });
    return { ms, timedOut: outcome === 'timeout', straggler, ok };
  }
  // The decision phase's barrier. `reached` resolves the moment `need` villagers have
  // answered; every decision still in flight then sees it and gives up its turn.
  function makeQuorum(n) {
    const need = Math.max(1, Math.ceil(n * Math.min(1, Math.max(0, CFG.DECIDE_QUORUM))));
    let done = 0, fire, at = null;
    const reached = new Promise(r => { fire = r; });
    return {
      need, reached, closedAt: () => at,
      answered() { if (++done >= need && at === null) { at = Date.now(); fire(); } },
    };
  }
  // The clock: every round, all agents decide at once; the round waits for the slowest (up to
  // the timeout), then plays out — shifts, meals, fires, rot, the market — and settles on-chain.
  async function waitIfPaused() {
    if (!alive()) return;
    if (sim.pausing) {
      sim.pausing = false;
      sim.paused = true;
      console.log(`paused after round ${W.round}`);
    }
    if (sim.paused) {
      await new Promise(resolve => { sim.resumeClock = resolve; });
      if (sim) sim.resumeClock = null;
    }
  }
  async function clock() {
    while (alive()) {
      await waitIfPaused();
      if (!alive()) return;
      const t0 = Date.now();
      const quorum = makeQuorum(W.agents.length);
      const res = await Promise.all(W.agents.map(a => decideOne(a, quorum)));
      if (!alive()) return;
      const ms = res.map(r => r.ms).sort((x, y) => x - y);
      const at = p => ms.length ? ms[Math.min(ms.length - 1, Math.round((ms.length - 1) * p))] : 0;
      await W.playRound({ waitMs: Date.now() - t0, slowest: ms.at(-1), median: ms[ms.length >> 1],
                          // the barrier's shape: the round waits for the slowest, so the gap
                          // between p50 and max is exactly what waiting for it costs
                          p50: at(0.5), p90: at(0.9), p95: at(0.95), max: ms.at(-1) ?? 0,
                          timeouts: res.filter(r => r.timedOut).length, noAnswer: res.filter(r => !r.ok && !r.timedOut && !r.straggler).length,
                          // the quorum close, added beside the old fields and never in place of them:
                          // how many villagers the round needed, how many it left behind, and when it closed
                          quorum: CFG.DECIDE_QUORUM, quorumNeed: quorum.need,
                          quorumMs: quorum.closedAt() ? quorum.closedAt() - t0 : null,
                          stragglers: res.filter(r => r.straggler).length });
      await waitIfPaused();
    }
  }
  sim.clock = clock().catch(e => console.error(`clock stopped: ${e.stack}`));
  return 'started';
}

function pause() {
  if (!sim) return 'not running';
  if (sim.paused) return 'already paused';
  sim.pausing = true;
  return 'pausing after this round';
}

function resume() {
  if (!sim) return 'not running';
  if (sim.pausing) {
    sim.pausing = false;
    return 'pause cancelled';
  }
  if (!sim.paused) return 'not paused';
  sim.paused = false;
  sim.resumeClock?.();
  console.log(`resumed at round ${sim.W.round}`);
  return 'resumed';
}

async function stop() {
  if (!sim) return 'not running';
  const s = sim;
  s.stopping = true;
  s.resumeClock?.();               // a paused clock must wake up so it can observe stopping
  await s.clock;                  // the round in progress finishes; a decision phase in progress is dropped
  sim = null;
  const L = await s.chain.fetch();
  fs.writeFileSync(path.join(s.dir, 'final.json'), JSON.stringify({
    stoppedAt: new Date().toISOString(), rounds: s.W.round, transactions: s.chain.txCount(),
    policy: s.W.policyLog,          // every dial pulled, and the round it landed on
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
  if (!sim) return { running: false, brains: BRAINS, maxAgents: MAX_AGENTS,
                     config: { agents: CFG.AGENTS, maxAgents: MAX_AGENTS, brain: CFG.BRAIN, model: CFG.MODEL, decideTimeoutMs: CFG.DECIDE_TIMEOUT_MS, decideQuorum: CFG.DECIDE_QUORUM }, policy: [] };
  const { W, chain, brain } = sim;
  const sum = f => W.agents.reduce((s, a) => s + f(a), 0);
  const doing = {};
  for (const a of W.agents) { const k = a.activity?.task ?? 'deciding'; doing[k] = (doing[k] ?? 0) + 1; }
  return {
    running: true, paused: sim.paused, pausing: sim.pausing, brain: brain.name, brains: BRAINS,
    config: { agents: CFG.AGENTS, maxAgents: MAX_AGENTS, brain: CFG.BRAIN, model: CFG.MODEL, decideTimeoutMs: CFG.DECIDE_TIMEOUT_MS, decideQuorum: CFG.DECIDE_QUORUM },
    round: W.round, roundMs: Math.round(W.roundMs),
    decide: W.lastRound?.decide ?? null,
    // last round's wall-clock, phase by phase (ms): sim, settle, loans, read, keeper,
    // auctions, purses, books, emit. Added, never renamed — the dashboard may ignore it.
    phases: W.lastRound?.phases ?? null,
    seconds: Math.round((Date.now() - sim.startedAt) / 1000),
    prices: Object.fromEntries(GOODS.map((g, i) => [g, W.prices[i] / 100])),
    volumes: Object.fromEntries(GOODS.map((g, i) => [g, W.volumes[i]])),
    bank: { supply: W.bank.supply / 100, startSupply: CFG.AGENTS * CFG.START_CASH / 100,
            debt: W.bank.debtTotalNow / 100, badDebt: W.bank.badDebt / 100, goods: W.bank.goods,
            creditOn: W.ltvBps() > 0, ltv: W.ltvBps() / 10_000, ltvCeiling: W.bank.terms.ltvBps / 10_000,
            ratePerMin: W.ratePerMin(), ratePerRound: W.ratePerRound(), terms: W.termRounds(), autoRepaid: W.autoRepaid,
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
      model: a.model ?? null,                     // the model this villager thinks with (baseten draws one per agent)
    })),
    // every dial pulled this run, with the round it landed on: the charts mark those rounds,
    // so a kink in a price line can be read straight off against the lever that caused it
    policy: W.policyLog.map(p => ({ round: p.round, changes: p.changes.map(c => ({ label: c.label, group: c.group, fromShown: c.fromShown, toShown: c.toShown })) })),
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
// The island and the panel are one app now (web/, built by Vite). If it has been built,
// `web/dist` is served with a single-page fallback so `/` and `/dashboard` are both the
// app; if it hasn't, the old standalone pages are served exactly as before.
const FRONTEND = path.join(ROOT, 'frontend');
const ISLAND_PAGE = path.join(FRONTEND, 'Moku Island.dc.html');
const DASHBOARD_PAGE = path.join(ROOT, 'backend/public/index.html');
const DIST = path.join(ROOT, 'web/dist');
const DIST_INDEX = path.join(DIST, 'index.html');
const hasBuild = () => { try { return fs.statSync(DIST_INDEX).isFile(); } catch { return false; } };
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
};
const json = (res, body, code = 200) => {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
};

const readBody = req => new Promise((resolve, reject) => {
  let s = '';
  req.on('data', c => { s += c; if (s.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  req.on('error', reject);
});

// The control panel. GET is every dial with its value right now; POST moves them — either
// { changes: { "<key>": value } } or { preset: "<id>" }, which is only a bundle of changes.
// A change lands on the running world at once (the simulation reads CFG every round), is
// announced to the villagers as a plain fact, and is written to the run log.
function setTunables(body) {
  const changes = body.preset ? presetChanges(body.preset) : body.changes;
  if (!changes) return { error: 'send { changes: {...} } or { preset: "id" }' };
  const moved = applyTunables(changes, sim?.W ?? null);
  if (moved.length) {
    const round = sim ? sim.W.round + 1 : null;
    // A running world has already emitted (and logged) the change itself, via W.notePolicy.
    console.log(`panel${round ? ` r${round}` : ''}: ${moved.map(m => `${m.label} ${m.fromShown} → ${m.toShown}${m.live ? '' : ' (next run)'}`).join('; ')}`);
  }
  return { moved, ...tunableSnapshot() };
}

function serveFile(res, file, { immutable = false } = {}) {
  try {
    if (!fs.statSync(file).isFile()) return json(res, { error: 'not found' }, 404);
  } catch {
    return json(res, { error: 'not found' }, 404);
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    // the built bundles carry a content hash in their name; everything else must stay fresh
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
  });
  res.end(fs.readFileSync(file));
}

// The built app: any real file under web/dist, and index.html for every other route, so
// /dashboard and / are both the single page and the back button works.
function serveBuilt(res, pathname) {
  const file = path.resolve(DIST, decodeURIComponent(pathname.slice(1)));
  if (file.startsWith(DIST + path.sep)) {
    try {
      if (fs.statSync(file).isFile()) return serveFile(res, file, { immutable: pathname.startsWith('/assets/') });
    } catch { /* fall through to the page */ }
  }
  return serveFile(res, DIST_INDEX);
}

function serveFrontend(res, pathname) {
  if (hasBuild()) return serveBuilt(res, pathname);
  if (pathname === '/') return serveFile(res, ISLAND_PAGE);
  if (pathname === '/dashboard' || pathname === '/dashboard/') return serveFile(res, DASHBOARD_PAGE);
  const file = path.resolve(FRONTEND, decodeURIComponent(pathname.slice(1)));
  if (!file.startsWith(FRONTEND + path.sep)) return json(res, { error: 'not found' }, 404);
  return serveFile(res, file);
}

const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/state') return json(res, state());
    // one villager's whole run: every decision it made and every line it was told, oldest first
    if (pathname === '/agent' && req.method === 'GET') {
      const id = +new URL(req.url, 'http://localhost').searchParams.get('id');
      const a = sim?.W.agents.find(x => x.id === id);
      if (!a) return json(res, { error: 'no such agent' }, 404);
      return json(res, { id: a.id, name: a.name, model: a.model ?? null, traits: a.traits,
                         decisions: sim.agentLog.get(a.id) ?? [], journal: a.journal });
    }
    if (pathname === '/tunables' && req.method === 'GET')  return json(res, tunableSnapshot());
    if (pathname === '/tunables' && req.method === 'POST') return json(res, setTunables(await readBody(req)));
    // { brain: "baseten", agents: 30 } sets up the run; no body means what .env says
    if (pathname === '/start'  && req.method === 'POST') return json(res, { result: await start(await readBody(req)) });
    if (pathname === '/stop'   && req.method === 'POST') return json(res, { result: await stop() });
    if (pathname === '/pause'  && req.method === 'POST') return json(res, { result: pause() });
    if (pathname === '/resume' && req.method === 'POST') return json(res, { result: resume() });
    if (pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' });
      sseClients.add(res); req.on('close', () => sseClients.delete(res)); return;
    }
    if (req.method === 'GET') return serveFrontend(res, pathname);
    return json(res, { error: 'not found' }, 404);
  } catch (e) {
    console.error(`${req.method} ${req.url} failed: ${e.stack ?? e.message}`);
    json(res, { error: e.message }, 500);
  }
});

function listen(port = CFG.PORT) {
  const cleanup = () => {
    server.off('error', onError);
    server.off('listening', onListening);
  };
  const onError = error => {
    cleanup();
    if (error.code !== 'EADDRINUSE' || port >= CFG.PORT + 10) throw error;
    const next = port + 1;
    console.warn(`port ${port} is busy; trying ${next}`);
    listen(next);
  };
  const onListening = () => {
    cleanup();
    const url = `http://localhost:${port}`;
    console.log(`island: ${url}   dashboard: ${url}/dashboard`);
    if (!CFG.RUN_SECONDS && process.env.OPEN_BROWSER !== '0') {
      const command = process.platform === 'darwin' ? ['open', [url]]
        : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
          : ['xdg-open', [url]];
      const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore' });
      child.on('error', () => {});               // headless shells simply keep the printed URL
      child.unref();
    }
  };
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port);
}
listen();

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
  // What the agents' own purses actually hold. settle_cash proves this inside the program
  // on every pass; reading it back here is the same claim made from outside.
  const held = [];
  for (let i = 0; i < L.slots.length && i < CFG.AGENTS; i++) held.push(await chain.purseBalance(i));
  const purseTotal = held.reduce((t, x) => t + x, 0);
  inv.push(['every agent purse = that agent\'s cash',
    held.every((x, i) => x === L.slots[i].cash)]);
  console.log(`\ninvariants: ${inv.map(([k, v]) => `${k} ${ok(v)}`).join('; ')}`);
  console.log(`SETTLERS ${chain.mint.toBase58()}: ${coins(settlers)} in existence, all of it minted by the bank's rules`);
  console.log(`purses: ${coins(purseTotal)} held by ${CFG.AGENTS} agents in token accounts of their own, ` +
    `${coins(settlers - purseTotal)} in the bank's vault`);
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
