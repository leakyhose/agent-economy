// Runs the village: chain setup, the clock, one async loop per agent, and an HTTP
// server so it can be watched.  GET /  (status page)   /state  (JSON)   /events  (SSE)
import http from 'node:http';
import { CFG, GOODS } from './config.mjs';
import { connectChain, explorer, PROGRAM_ID } from './chain.mjs';
import { createWorld } from './world.mjs';
import { makeTools } from './tools.mjs';
import { stubBrain } from './brains/stub.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const coins = c => (c / 100).toFixed(2);

// ---- brain ----------------------------------------------------------------------
let brain;
if (CFG.BRAIN === 'claude') {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('\n  BRAIN=claude but no ANTHROPIC_API_KEY (put it in the repo-root .env). Using the stub.\n');
    brain = stubBrain();
  } else {
    brain = (await import('./brains/claude.mjs')).claudeBrain();
  }
} else brain = stubBrain();

// ---- chain ----------------------------------------------------------------------
const chain = await connectChain();
console.log(`\nagent-economy   brain=${brain.name}   agents=${CFG.AGENTS}`);
console.log(`program  ${PROGRAM_ID.toBase58()}`);
await chain.initialize(CFG.AGENTS, CFG.START_CASH, CFG.START_FOOD);
console.log(`ledger   ${chain.ledger.publicKey.toBase58()}`);
console.log(`explorer ${explorer('address', chain.ledger.publicKey.toBase58())}\n`);

// ---- world ----------------------------------------------------------------------
const sseClients = new Set();
let W;
W = createWorld(chain, await chain.fetch(), {
  onEvent: e => {
    const line = `data: ${JSON.stringify(e)}\n\n`; for (const res of sseClients) res.write(line);
    logEvent(e);
  },
});

// ---- one loop per agent, staggered so they never all decide at once --------------
let running = true;
async function agentLoop(a) {
  await sleep(Math.random() * CFG.STAGGER_MS);
  while (running) {
    if (a.activity) { await sleep(CFG.TICK_MS); continue; }
    const tools = makeTools(W, a);
    try { await brain.decide(a, tools); } catch (e) { W.emit('error', { agent: a.id, message: e.message }); }
    a.decisions++;
    if (!a.activity) W.startActivity(a, 'idle');
    W.emit('thought', { agent: a.id, name: a.name, thought: a.thought, activity: a.activity?.task });
  }
}
W.agents.forEach(a => agentLoop(a));

// ---- the clock ------------------------------------------------------------------
const clock = setInterval(() => W.step(), CFG.TICK_MS);

// ---- console heartbeat, one line per round ---------------------------------------
function logEvent(e) {
  if (e.type === 'round') {
    const acts = {};
    for (const a of W.agents) { const k = a.activity?.task ?? 'deciding'; acts[k] = (acts[k] ?? 0) + 1; }
    const hungry = W.agents.filter(a => a.hunger > 0).length;
    const px = GOODS.map((g, i) => `${g} ${coins(e.prices[i])} (${e.volumes[i]})`).join('  ');
    const st = brain.stats();
    console.log(`round ${String(e.round).padStart(3)} | ${px} | ` +
      `fish ${acts.gather_food ?? 0} wood ${acts.gather_wood ?? 0} craft ${acts.craft_net ?? 0} idle ${acts.idle ?? 0} | ` +
      `hungry ${hungry} | ${e.txs} tx ${e.ms}ms` + (st.calls ? ` | llm ${st.calls} calls $${st.cost.toFixed(3)}` : ''));
  }
  if (e.type === 'error') console.error(`  ! ${e.message}`);
}

// ---- HTTP ------------------------------------------------------------------------
function state() {
  return {
    brain: brain.name, tick: W.tick, round: W.round,
    prices: Object.fromEntries(GOODS.map((g, i) => [g, W.prices[i] / 100])),
    volumes: Object.fromEntries(GOODS.map((g, i) => [g, W.volumes[i]])),
    priceHistory: W.priceHistory,
    chain: {
      program: PROGRAM_ID.toBase58(), ledger: chain.ledger.publicKey.toBase58(),
      ledgerExplorer: explorer('address', chain.ledger.publicKey.toBase58()),
      transactions: chain.txCount(), lastRound: W.lastRound,
    },
    llm: brain.stats(),
    agents: W.agents.map(a => ({
      id: a.id, name: a.name, cash: a.cash / 100,
      food: a.goods[0], wood: a.goods[1], nets: a.goods[2], hunger: a.hunger,
      activity: a.activity?.task ?? null, thought: a.thought, memory: a.memory,
    })),
    events: W.events.slice(-60),
  };
}

const PAGE = `<!doctype html><meta charset=utf-8><title>agent-economy</title>
<style>body{font:13px ui-monospace,monospace;margin:16px;background:#fafaf7;color:#222}
table{border-collapse:collapse;width:100%}td,th{padding:3px 8px;border-bottom:1px solid #e5e5e0;text-align:left}
th{position:sticky;top:0;background:#fafaf7}.n{text-align:right}#top{margin-bottom:12px;line-height:1.7}
.th{color:#666;max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}a{color:#0a58ca}</style>
<div id=top></div><table><thead><tr><th>agent<th class=n>cash<th class=n>food<th class=n>wood<th class=n>nets<th>doing<th>thinking</thead><tbody id=rows></tbody></table>
<script>
async function tick(){const s=await (await fetch('/state')).json();
top.innerHTML='<b>round '+s.round+'</b> &nbsp; brain: '+s.brain+' &nbsp; '+Object.entries(s.prices).map(([g,p])=>g+' <b>'+p.toFixed(2)+'</b> ('+s.volumes[g]+' sold)').join(' &nbsp; ')+
'<br>'+s.chain.transactions+' Solana transactions &nbsp; <a target=_blank href="'+s.chain.ledgerExplorer+'">ledger on explorer</a>'+(s.llm.calls?' &nbsp; llm calls '+s.llm.calls+' ($'+s.llm.cost.toFixed(3)+')':'');
rows.innerHTML=s.agents.slice().sort((a,b)=>b.cash-a.cash).map(a=>'<tr><td>'+a.name+(a.hunger?' 🍽':'')+'<td class=n>'+a.cash.toFixed(2)+'<td class=n>'+a.food+'<td class=n>'+a.wood+'<td class=n>'+a.nets+'<td>'+(a.activity||'')+'<td class=th title="'+a.thought.replace(/"/g,'&quot;')+'">'+a.thought).join('')}
tick();setInterval(tick,1000)</script>`;

http.createServer((req, res) => {
  if (req.url === '/state') { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); return res.end(JSON.stringify(state())); }
  if (req.url === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' });
    sseClients.add(res); req.on('close', () => sseClients.delete(res)); return;
  }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE);
}).listen(CFG.PORT, () => console.log(`watch at http://localhost:${CFG.PORT}\n`));

// ---- optional timed run, then a summary --------------------------------------------
if (CFG.RUN_SECONDS) {
  await sleep(CFG.RUN_SECONDS * 1000);
  running = false; clearInterval(clock);
  while (W.roundBusy) await sleep(100);
  const L = await chain.fetch();
  const total = L.slots.reduce((s, x) => s + x.cash, 0);
  const rich = W.agents.slice().sort((x, y) => y.cash - x.cash);
  console.log(`\n--- after ${CFG.RUN_SECONDS}s: ${W.round} rounds, ${chain.txCount()} Solana transactions ---`);
  console.log(`money on chain: ${coins(total)} (started ${coins(CFG.START_CASH * CFG.AGENTS)})   <- conserved`);
  console.log(`hungry now: ${W.agents.filter(a => a.hunger > 0).length}/${CFG.AGENTS}   nets owned: ${L.slots.reduce((s, x) => s + x.goods[2], 0)}`);
  console.log(`richest: ${rich.slice(0, 3).map(a => `${a.name} ${coins(a.cash)}`).join(', ')}`);
  console.log(`poorest: ${rich.slice(-3).map(a => `${a.name} ${coins(a.cash)}`).join(', ')}`);
  for (const a of rich.filter((_, i) => i % 25 === 0)) console.log(`  ${a.name}: "${a.thought}"`);
  const st = brain.stats(); if (st.calls) console.log(`llm: ${st.calls} calls, ${st.errors} errors, $${st.cost.toFixed(3)}`);
  process.exit(0);
}
