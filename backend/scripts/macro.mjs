// The macro picture of a run, a window of rounds per row: prices, who worked at what, what
// was made and sold, hunger, money and credit. For reading a comparative-statics test off
// one table — "the wood yield doubled at round 50: did the wood price fall?".
//
//   node backend/scripts/macro.mjs [runs/<a> ...] [--window 10] [--from 1] [--to 100]
//
// No run named = the latest. Dials pulled mid-run are marked on the row they landed in.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const opt = (k, d) => argv.includes(k) ? +argv[argv.indexOf(k) + 1] : d;
const WIN = opt('--window', 10), FROM = opt('--from', 1), TO = opt('--to', Infinity);
let dirs = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
if (!dirs.length) dirs = [path.join(ROOT, 'runs', fs.readdirSync(path.join(ROOT, 'runs')).filter(d => fs.existsSync(path.join(ROOT, 'runs', d, 'events.jsonl'))).sort().at(-1))];

const avg = xs => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
const sum = xs => xs.reduce((s, x) => s + x, 0);
const f = (x, d = 2) => Number.isFinite(x) ? x.toFixed(d) : '—';
const pad = (s, n) => String(s).padStart(n);

for (const dir of dirs) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json')));
  const R = [], policy = [];
  // Born talent: the job each villager's skill was highest at when the run began (meta.json
  // holds the skills at birth). Old runs without skills in meta get '—' in the three columns.
  const JOBS = ['gather_food', 'gather_wood', 'craft_net'];
  const born = meta.agents.map(a => a.skills ? JOBS.reduce((b, j) => (a.skills[j] ?? 0) > (a.skills[b] ?? 0) ? j : b) : null);
  const share = (xs, ok) => xs.length ? xs.filter(ok).length / xs.length : NaN;
  for await (const line of readline.createInterface({ input: fs.createReadStream(path.join(dir, 'events.jsonl')) })) {
    if (line.includes('"type":"policy"')) { const e = JSON.parse(line); policy.push(e); continue; }
    if (!line.includes('"type":"round"')) continue;
    const e = JSON.parse(line);
    if (e.type !== 'round' || e.round < FROM || e.round > TO) continue;
    const n = e.agents.length, job = t => e.agents.filter(a => a.activity === t).length / n;
    const of = t => e.agents.filter(a => (born[a.id] ?? a.talent) === t), fishers = of('gather_food'), crafters = of('craft_net');
    R.push({
      round: e.round, p: e.prices.map(x => x / 100), idx: e.metrics.priceIndex,
      fish: job('gather_food'), cut: job('gather_wood'), craft: job('craft_net'), build: job('build_house'), smoke: job('smoke_fish'), idle: job('idle') + job('rest') + job(null),   // idle/null: no shift; rest: a shift old runs had
      made: e.made, sold: e.volumes, offered: e.book.map(b => b.askQty + b.bankQty), wanted: e.book.map(b => b.bidQty),
      spoiled: e.spoiled?.[0] ?? 0, hungry: e.agents.filter(a => a.hunger > 0).length, cold: e.agents.filter(a => a.cold > 0).length,
      life: avg(e.agents.map(a => a.lifestyle)), money: e.bank.supply / 100, credit: e.bank.debtTotalNow / 100,
      loans: e.bank.loans.filter(l => l.kind === 'borrow' && l.ok), foreclosed: e.foreclosures.length,
      houses: e.metrics.houses, nets: sum(e.agents.map(a => a.goods[2] + a.locked[2])), wb: e.metrics.wbRound, rgdp: e.metrics.realGdp / 100,
      // born fishers holding a usable net (free or pledged); born crafters at their trade; their cash against everyone's
      fNet: share(fishers, a => a.goods[2] + a.locked[2] > 0), cWork: share(crafters, a => a.activity === 'craft_net' || a.activity === 'build_house' || a.activity === 'smoke_fish'),
      // smoked fish made this round, and how much of it by born crafters (a.made is keyed by the good's name)
      smokedBy: [sum(crafters.map(a => a.made?.['smoked fish'] ?? 0)), e.made[3] ?? 0],
      cCash: crafters.length ? avg(crafters.map(a => a.cash)) / 100 : NaN, allCash: avg(e.agents.map(a => a.cash)) / 100,
      gini: e.metrics.gini, cashTop: Math.max(...e.agents.map(a => a.cash)) / Math.max(1, sum(e.agents.map(a => a.cash))),
    });
  }
  const dials = Object.entries(meta.dials ?? {}).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`\n══ ${path.basename(dir)}   ${meta.provider}   ${meta.agents.length} agents   ${R.length} rounds   seed ${meta.config.SEED}` +
    `   rate/round ${meta.config.BANK.RATE_PER_ROUND}   LTV ${meta.config.BANK.LTV}   start cash ${meta.config.START_CASH / 100}${dials ? `\n   dials at birth: ${dials}` : ''}`);
  for (const p of policy) console.log(`   r${p.round}: ${p.changes.map(c => `${c.key} ${c.fromShown} → ${c.toShown}`).join('; ')}`);
  // smoked-fish columns: old runs have index 3 as "boats", zero-filled, so they print 0 and —
  console.log('rounds    │ P food  wood   net smoked  house  index │ fish  cut craft build smoke idle │ made f    w  n  h smk │ sold f    w  n  h smk │ sell-thru f  w │ rot  hungry life │  money credit loans(amt) fcl │ houses nets  wb/rd  rGDP gini top$ │ fisher/net crafter@trade  cash crafter/all  smoked by crafters');
  for (let i = 0; i < R.length; i += WIN) {
    const w = R.slice(i, i + WIN), a = k => avg(w.map(r => r[k])), g = (k, j) => avg(w.map(r => r[k][j])), s = (k, j) => sum(w.map(r => r[k][j]));
    const loans = w.flatMap(r => r.loans), last = w.at(-1);
    const fin = k => { const xs = w.map(r => r[k]).filter(Number.isFinite); return xs.length ? avg(xs) : NaN; }, pc = x => Number.isFinite(x) ? f(x * 100, 0) + '%' : '—';
    const thru = j => s('offered', j) ? s('sold', j) / s('offered', j) : NaN;
    const mark = policy.some(p => p.round >= w[0].round && p.round <= last.round) ? '◀ dial' : '';
    console.log(`${pad(w[0].round, 3)}–${pad(last.round, 3)}   │ ${f(g('p', 0))} ${pad(f(g('p', 1)), 5)} ${pad(f(g('p', 2), 1), 5)} ${pad(f(g('p', 3)), 6)} ${pad(f(g('p', 4), 0), 6)}  ${pad(f(a('idx')), 5)} │ ` +
      `${pad(f(a('fish') * 100, 0), 3)}% ${pad(f(a('cut') * 100, 0), 3)}% ${pad(f(a('craft') * 100, 0), 3)}%  ${pad(f(a('build') * 100, 0), 3)}%  ${pad(f(a('smoke') * 100, 0), 3)}% ${pad(f(a('idle') * 100, 0), 3)}% │ ` +
      `${pad(f(g('made', 0), 0), 5)} ${pad(f(g('made', 1), 0), 4)} ${pad(f(g('made', 2), 1), 3)} ${pad(f(g('made', 4), 1), 3)} ${pad(f(g('made', 3), 1), 4)} │ ` +
      `${pad(f(g('sold', 0), 0), 5)} ${pad(f(g('sold', 1), 0), 4)} ${pad(f(g('sold', 2), 1), 3)} ${pad(f(g('sold', 4), 1), 3)} ${pad(f(g('sold', 3), 1), 4)} │ ` +
      `${pad(f(thru(0) * 100, 0), 6)}% ${pad(f(thru(1) * 100, 0), 3)}% │ ${pad(f(a('spoiled'), 0), 3)} ${pad(f(a('hungry'), 1), 6)} ${pad(f(a('life')), 5)} │ ` +
      `${pad(f(last.money, 0), 6)} ${pad(f(last.credit, 0), 6)} ${pad(loans.length, 3)}(${pad(f(sum(loans.map(l => l.amount)) / 100, 0), 4)}) ${pad(sum(w.map(r => r.foreclosed)), 3)} │ ` +
      `${pad(last.houses, 6)} ${pad(last.nets, 4)} ${pad(f(a('wb')), 6)} ${pad(f(a('rgdp'), 0), 5)} ${f(last.gini)} ${f(last.cashTop)} │ ` +
      `${pad(pc(fin('fNet')), 10)} ${pad(pc(fin('cWork')), 13)} ${pad(f(last.cCash, 0), 7)} / ${pad(f(last.allCash, 0), 3)} ${pad(pc(s('smokedBy', 1) ? s('smokedBy', 0) / s('smokedBy', 1) : NaN), 18)} ${mark}`);
  }
}
