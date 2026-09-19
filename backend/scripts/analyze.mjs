// Summarize a saved run.   node backend/scripts/analyze.mjs runs/<timestamp>   (no arg = latest)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runsDir = path.join(ROOT, 'runs');
const dir = process.argv[2] ? path.resolve(process.argv[2])
  : path.join(runsDir, fs.readdirSync(runsDir).sort().at(-1));
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json')));
const final = fs.existsSync(path.join(dir, 'final.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'final.json'))) : null;
const ev = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

const GOODS = ['food', 'wood', 'nets'];
const coins = c => (c / 100).toFixed(2);
const rounds = ev.filter(e => e.type === 'round');
const decisions = ev.filter(e => e.type === 'decision');
const name = id => meta.agents[id]?.name ?? `#${id}`;
const pct = (a, b) => b ? `${Math.round(a / b * 100)}%` : '—';
const hr = t => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`);

console.log(`run ${path.basename(dir)}   brain ${meta.brain}   ${meta.agents.length} agents   ${rounds.length} rounds   ${decisions.length} decisions`);

hr('market: did agents try to trade, and did it work?');
for (let g = 0; g < 3; g++) {
  const b = rounds.map(r => r.book?.[g]).filter(Boolean);
  const withBids = b.filter(x => x.bids).length, withAsks = b.filter(x => x.asks).length;
  const both = b.filter(x => x.bids && x.asks).length;
  const traded = rounds.filter(r => r.volumes[g] > 0);
  const vol = rounds.reduce((s, r) => s + r.volumes[g], 0);
  const noCross = b.filter(x => x.bids && x.asks && x.bestBid < x.bestAsk).length;
  console.log(`${GOODS[g].padEnd(5)} rounds with buyers ${String(withBids).padStart(3)}  with sellers ${String(withAsks).padStart(3)}  ` +
    `both ${String(both).padStart(3)}  traded ${String(traded.length).padStart(3)}  volume ${String(vol).padStart(4)}` +
    (noCross ? `   (${noCross} rounds where best bid < best ask)` : ''));
  const p = rounds.map(r => r.prices[g]);
  if (p.length) console.log(`      price ${coins(p[0])} -> ${coins(p.at(-1))}   range ${coins(Math.min(...p))}–${coins(Math.max(...p))}`);
}

hr('what agents chose to do');
const acts = {};
for (const d of decisions) acts[d.activity ?? 'none'] = (acts[d.activity ?? 'none'] ?? 0) + 1;
console.log(Object.entries(acts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v} (${pct(v, decisions.length)})`).join('   '));
const orders = decisions.flatMap(d => d.actions.filter(x => x.tool === 'place_order').map(x => ({ ...x, agent: d.agent })));
const rejected = orders.filter(o => !o.result.startsWith('Order posted'));
const bySide = {};
for (const o of orders) { const k = `${o.input.side} ${o.input.good}`; bySide[k] = (bySide[k] ?? 0) + 1; }
console.log(`orders placed ${orders.length}  (rejected ${rejected.length})   ` + Object.entries(bySide).map(([k, v]) => `${k}: ${v}`).join('   '));
if (rejected.length) {
  const why = {};
  for (const o of rejected) { const k = o.result.split(':')[0].slice(0, 50); why[k] = (why[k] ?? 0) + 1; }
  console.log('  rejections: ' + Object.entries(why).map(([k, v]) => `"${k}" x${v}`).join('; '));
}
const noAct = decisions.filter(d => !d.actions.some(x => ['gather_food', 'gather_wood', 'craft_net', 'rest'].includes(x.tool)));
if (noAct.length) console.log(`decisions that never chose a shift (sat idle): ${noAct.length} (${pct(noAct.length, decisions.length)})`);

hr('needs, waste and money');
const hungryRounds = rounds.map(r => r.agents?.filter(a => a.hunger > 0).length ?? 0);
const spoiled = [0, 1, 2].map(g => rounds.reduce((s, r) => s + (r.spoiled?.[g] ?? 0), 0));
console.log(`hungry agents per round: avg ${(hungryRounds.reduce((s, x) => s + x, 0) / Math.max(1, hungryRounds.length)).toFixed(1)}, max ${Math.max(0, ...hungryRounds)}`);
console.log(`spoiled: food ${spoiled[0]}  wood ${spoiled[1]}`);
const last = rounds.at(-1)?.agents ?? [];
if (last.length) {
  const cash = last.map(a => a.cash).sort((a, b) => a - b), n = cash.length, sum = cash.reduce((s, x) => s + x, 0);
  const gini = cash.reduce((acc, v, i) => acc + (2 * (i + 1) - n - 1) * v, 0) / (n * sum);
  const moved = rounds.flatMap(r => r.trades ?? []).filter(t => t.side === 'buy').reduce((s, t) => s + t.qty * t.price, 0);
  console.log(`money that changed hands: ${coins(moved)}   cash gini ${gini.toFixed(2)}   ` +
    `poorest ${coins(cash[0])}  median ${coins(cash[Math.floor(n / 2)])}  richest ${coins(cash.at(-1))}`);
  const goods = [0, 1, 2].map(g => last.reduce((s, a) => s + a.goods[g], 0));
  console.log(`held at the end: food ${goods[0]}  wood ${goods[1]}  nets ${goods[2]}  (${(goods[0] / n).toFixed(1)} food per agent)`);
}

hr('final standings (on chain)');
const standing = (final?.chain.slots ?? last.map(a => ({ cash: a.cash, goods: a.goods }))).map((s, i) => ({ i, ...s }))
  .sort((a, b) => b.cash - a.cash);
for (const s of standing) {
  const mine = decisions.filter(d => d.agent === s.i);
  const top = {}; for (const d of mine) top[d.activity] = (top[d.activity] ?? 0) + 1;
  const main = Object.entries(top).sort((a, b) => b[1] - a[1])[0];
  console.log(`${name(s.i).padEnd(9)} cash ${coins(s.cash).padStart(7)}  food ${String(s.goods[0]).padStart(3)}  wood ${String(s.goods[1]).padStart(3)}  nets ${s.goods[2]}   ` +
    `mostly ${main ? `${main[0]} (${main[1]}/${mine.length})` : '—'}`);
}

hr('sample reasoning');
for (const d of decisions.filter((_, i) => i % Math.max(1, Math.floor(decisions.length / 8)) === 0).slice(0, 8))
  console.log(`${name(d.agent).padEnd(9)} ${String(d.activity).padEnd(12)} ${d.thought}`);

if (final) console.log(`\n${final.transactions} Solana transactions   llm ${final.llm.calls ?? 0} calls, $${(final.llm.cost ?? 0).toFixed(3)}`);
