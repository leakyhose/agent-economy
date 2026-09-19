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

const coins = c => (c / 100).toFixed(2);
const rounds = ev.filter(e => e.type === 'round');
// older runs had 3 or 4 goods (no boats, no houses), a bank without equity, no metrics; read what the run has
const GOODS = ['food', 'wood', 'nets', 'boats', 'houses'].slice(0, rounds[0]?.prices.length ?? final?.chain.lastPrice.length ?? 3);
const G = GOODS.map((_, g) => g);
const decisions = ev.filter(e => e.type === 'decision');
const name = id => meta.agents[id]?.name ?? `#${id}`;
const pct = (a, b) => b ? `${Math.round(a / b * 100)}%` : '—';
const avg = xs => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
const giniOf = xs => { const v = [...xs].sort((a, b) => a - b), n = v.length, sum = v.reduce((s, x) => s + x, 0);
  return n && sum ? v.reduce((acc, x, i) => acc + (2 * (i + 1) - n - 1) * x, 0) / (n * sum) : 0; };
const hr = t => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`);

console.log(`run ${path.basename(dir)}   brain ${meta.brain}   ${meta.agents.length} agents   ${rounds.length} rounds   ${decisions.length} decisions`);

hr('market: did agents try to trade, and did it work?');
for (const g of G) {
  const b = rounds.map(r => r.book?.[g]).filter(Boolean);
  const withBids = b.filter(x => x.bids).length, withAsks = b.filter(x => x.asks).length;
  const both = b.filter(x => x.bids && x.asks).length;
  const traded = rounds.filter(r => r.volumes[g] > 0);
  const vol = rounds.reduce((s, r) => s + r.volumes[g], 0);
  const noCross = b.filter(x => x.bids && x.asks && x.bestBid < x.bestAsk).length;
  console.log(`${GOODS[g].padEnd(6)} rounds with buyers ${String(withBids).padStart(3)}  with sellers ${String(withAsks).padStart(3)}  ` +
    `both ${String(both).padStart(3)}  traded ${String(traded.length).padStart(3)}  volume ${String(vol).padStart(4)}` +
    (noCross ? `   (${noCross} rounds where best bid < best ask)` : ''));
  const p = rounds.map(r => r.prices[g]);
  if (p.length) console.log(`       price ${coins(p[0])} -> ${coins(p.at(-1))}   range ${coins(Math.min(...p))}–${coins(Math.max(...p))}`);
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
const noAct = decisions.filter(d => !d.actions.some(x => ['gather_food', 'gather_wood', 'craft_net', 'build_house', 'rest'].includes(x.tool)));
if (noAct.length) console.log(`decisions that never chose a shift (sat idle): ${noAct.length} (${pct(noAct.length, decisions.length)})`);

hr('needs, waste and money');
const hungryRounds = rounds.map(r => r.agents?.filter(a => a.hunger > 0).length ?? 0);
const spoiled = G.map(g => rounds.reduce((s, r) => s + (r.spoiled?.[g] ?? 0), 0));
console.log(`hungry agents per round: avg ${(hungryRounds.reduce((s, x) => s + x, 0) / Math.max(1, hungryRounds.length)).toFixed(1)}, max ${Math.max(0, ...hungryRounds)}`);
console.log(`spoiled: ${GOODS.map((n, g) => `${n} ${spoiled[g]}`).join('  ')}`);
const last = rounds.at(-1)?.agents ?? [];
if (last.length) {
  const cash = last.map(a => a.cash).sort((a, b) => a - b), n = cash.length, gini = giniOf(cash);
  const moved = rounds.flatMap(r => r.trades ?? []).filter(t => t.side === 'buy').reduce((s, t) => s + t.qty * t.price, 0);
  console.log(`money that changed hands: ${coins(moved)}   cash gini ${gini.toFixed(2)}   ` +
    `poorest ${coins(cash[0])}  median ${coins(cash[Math.floor(n / 2)])}  richest ${coins(cash.at(-1))}`);
  const goods = G.map(g => last.reduce((s, a) => s + a.goods[g], 0));
  console.log(`held at the end: ${GOODS.map((n, g) => `${n} ${goods[g]}`).join('  ')}  (${(goods[0] / n).toFixed(1)} food per agent)`);
}

hr('the economy, round by round');
if (rounds[0]?.metrics) {
  // GDP = everything made in a round (fish, wood, nets, houses finished) at that round's prices;
  // gross output, so wood that went into nets and houses is counted twice.
  const M = rounds.map(r => r.metrics), q = Math.max(1, Math.ceil(M.length / 4));
  const made = G.map(g => M.reduce((s, m) => s + (m.made[g] ?? 0), 0));
  console.log(`GDP ${coins(M.reduce((s, m) => s + m.gdp, 0))} over ${M.length} rounds; per round by quarter of the run: ` +
    [0, 1, 2, 3].map(k => M.slice(k * q, (k + 1) * q)).filter(x => x.length).map(x => coins(avg(x.map(m => m.gdp)))).join(' → '));
  console.log(`  made: ${GOODS.map((n, g) => `${n} ${made[g]}`).join('  ')}`);
  const pi = M.map(m => m.priceIndex), infl = M.map(m => m.inflation).filter(x => x != null);
  console.log(`price index ${pi[0].toFixed(2)} → ${pi.at(-1).toFixed(2)}   range ${Math.min(...pi).toFixed(2)}–${Math.max(...pi).toFixed(2)}   ` +
    (infl.length ? `inflation per minute: last ${(infl.at(-1) * 100).toFixed(1)}%, average ${(avg(infl) * 100).toFixed(1)}%` : 'inflation: run shorter than a minute'));
  const sh = M.reduce((s, m) => ({ worked: s.worked + m.shifts.worked, rested: s.rested + m.shifts.rested, idle: s.idle + m.shifts.idle }), { worked: 0, rested: 0, idle: 0 });
  console.log(`employment ${pct(sh.worked, sh.worked + sh.rested + sh.idle)} of ${sh.worked + sh.rested + sh.idle} shifts worked ` +
    `(rested ${sh.rested}, idle/unchosen ${sh.idle}); by quarter: ` +
    [0, 1, 2, 3].map(k => M.slice(k * q, (k + 1) * q)).filter(x => x.length).map(x => {
      const w = x.reduce((s, m) => s + m.shifts.worked, 0), all = x.reduce((s, m) => s + m.shifts.worked + m.shifts.rested + m.shifts.idle, 0);
      return pct(w, all); }).join(' → '));
  const unsold = G.map(g => M.reduce((s, m) => s + (m.unsold[g] ?? 0), 0));
  console.log(`slack (offered, unsold): ${coins(M.reduce((s, m) => s + m.slack, 0))} in all, avg ${pct(avg(M.filter(m => m.slackShare != null).map(m => m.slackShare)), 1)} of the value offered per round; ` +
    `units unsold ${GOODS.map((n, g) => `${n} ${unsold[g]}`).join('  ')}`);
  console.log(`wellbeing per agent ${M[0].wellbeing} → ${M.at(-1).wellbeing}  (avg ${(avg(M.map(m => m.wbRound)) * 20).toFixed(1)} a minute)   ` +
    `net-worth gini ${M[0].gini.toFixed(2)} → ${M.at(-1).gini.toFixed(2)}`);
  const cr = M.map(m => m.credit);
  console.log(`credit outstanding ${coins(cr.at(-1))} at the end (peak ${coins(Math.max(...cr))})   money ${coins(M[0].money)} → ${coins(M.at(-1).money)}`);
  const cons = rounds.flatMap(r => r.bank.loans).filter(l => l.kind === 'borrow' && l.construction && l.ok !== false);
  console.log(`houses: ${M.at(-1).housesBuilt} built, ${M.at(-1).building} unfinished at the end, ${M.at(-1).homeowners} of ${meta.agents.length} agents live in one; ` +
    `${cons.length} construction loans (${coins(cons.reduce((s, l) => s + l.amount, 0))})`);
  const lastA = rounds.at(-1).agents;
  if (lastA[0]?.score !== undefined) console.log(`end score (wellbeing + net worth / ${meta.config.WELLBEING?.COINS_PER_POINT ?? 10} coins): ` +
    `avg ${avg(lastA.map(a => a.score)).toFixed(1)}   homeowners ${avg(lastA.filter(a => a.house).map(a => a.score)).toFixed(1)}   others ${avg(lastA.filter(a => !a.house).map(a => a.score)).toFixed(1)}`);
} else console.log('(not recorded: the run predates GDP and the other metrics)');

hr('money and the bank');
if (rounds[0]?.bank) {
  const sup = rounds.map(r => r.bank.supply), start = meta.config.AGENTS * meta.config.START_CASH;
  const all = rounds.flatMap(r => r.bank.loans), loans = all.filter(l => l.ok !== false);   // ok: the chain accepted it (older runs: all)
  const fc = rounds.flatMap(r => (r.foreclosures ?? []).map(f => ({ ...f, round: r.round })));
  const col = rounds.flatMap(r => (r.collected ?? []).map(f => ({ ...f, round: r.round })));
  const endB = rounds.at(-1).bank;
  console.log(`money supply ${coins(start)} -> ${coins(sup.at(-1))}   peak ${coins(Math.max(...sup))}   low ${coins(Math.min(...sup))}`);
  console.log(`loans ${loans.filter(l => l.kind === 'borrow').length} (${coins(loans.filter(l => l.kind === 'borrow').reduce((s, l) => s + l.amount, 0))} minted)   ` +
    `repayments ${loans.filter(l => l.kind === 'repay').length} (${coins(loans.filter(l => l.kind === 'repay').reduce((s, l) => s + l.amount, 0))} paid` +
    (endB.books ? `, ${coins(endB.books.principalRepaid)} principal burned)   ` : ' and burned)   ') +
    `still owed ${coins(endB.debtTotalNow ?? endB.debtTotal)}   bad debt ${coins(endB.badDebt)}`);
  const onChainNo = all.filter(l => l.ok === false);
  if (onChainNo.length) console.log(`refused on-chain: ${onChainNo.filter(l => l.kind === 'borrow').length} borrows, ${onChainNo.filter(l => l.kind === 'repay').length} repays`);
  const terms = {};
  for (const l of loans) if (l.kind === 'borrow' && l.term) terms[l.term] = (terms[l.term] ?? 0) + 1;
  if (Object.keys(terms).length) console.log(`terms chosen (new loans): ${Object.entries(terms).map(([k, v]) => `${k} min ×${v}`).join('  ')}`);
  if (rounds.at(-1).collected) console.log(`loans come due: ${col.length} collected from cash at the deadline (no penalty, ${coins(col.reduce((s, f) => s + f.taken, 0))}), ` +
    `${fc.filter(f => f.reason === 'overdue').length} foreclosed overdue, ${fc.filter(f => f.reason === 'margin').length} margin calls`);
  const why = f => [f.reason && (f.reason === 'margin' ? 'margin call' : 'overdue'),
    goodsOf(f.seized) && `seized ${goodsOf(f.seized)}`, goodsOf(f.returned) && `returned ${goodsOf(f.returned)}`].filter(Boolean).join(', ');
  const goodsOf = q => q?.map((n, g) => n ? `${n} ${GOODS[g]}` : '').filter(Boolean).join('+');
  console.log(`foreclosures ${fc.length}` + (fc.length ? ` (${fc.filter(f => f.reason === 'margin').length} margin call, ${fc.filter(f => f.reason === 'overdue').length} overdue): ` +
    fc.map(f => `r${f.round} ${f.name}${why(f) ? ` (${why(f)})` : ''}`).join('; ') : ''));
  const refused = decisions.flatMap(d => d.actions.filter(x => x.tool === 'borrow' && !x.result.startsWith('Loan requested')));
  if (refused.length) console.log(`borrow requests refused before reaching the chain: ${refused.length}` +
    ` (${refused.filter(x => x.result.startsWith('The bank cannot lend')).length} at the bank's lending limit)`);
  if (endB.equity !== undefined) {
    // the bank's balance sheet: equity over time and where it came from
    const b = endB.books, eq = rounds.map(r => r.bank.equity), step = Math.max(1, Math.ceil(rounds.length / 8));
    console.log(`bank equity ${coins(b.bankSeed)} seed -> ${coins(eq.at(-1))}   low ${coins(Math.min(...eq))}   peak ${coins(Math.max(...eq))}   ` +
      `lending cap now ${coins(endB.lendingCap)}`);
    console.log(`  over time: ` + rounds.filter((_, i) => i % step === 0 || i === rounds.length - 1).map(r => `r${r.round} ${coins(r.bank.equity)}`).join('  '));
    console.log(`  income: interest ${coins(b.interestIncome)}  penalties ${coins(b.penalties)}  sales of seized goods ${coins(b.recovered)}   ` +
      `out: written off ${coins(b.writtenOff)}  dividends ${coins(b.dividendsPaid)}${b.refunds !== undefined ? `  refunds ${coins(b.refunds)}` : ''}   bad debt ${coins(b.badDebt)}`);
    const divs = rounds.filter(r => r.bank.dividend);
    if (divs.length) console.log(`  dividends paid in ${divs.length} rounds, ${coins(divs.reduce((s, r) => s + r.bank.dividend.perAgent, 0))} per agent in all`);
  }
  // a price index for runs that didn't record one: food, wood, nets weighted by what a villager uses (8 food : 4 wood : 0.1 net)
  const cpi = r => r.metrics?.priceIndex ?? (r.prices[0] * 8 + r.prices[1] * 4 + r.prices[2] * 0.1) / (500 * 8 + 300 * 4 + 2000 * 0.1);
  console.log(`price index ${cpi(rounds[0]).toFixed(2)} -> ${cpi(rounds.at(-1)).toFixed(2)}   (money supply x${(sup.at(-1) / start).toFixed(2)})`);
  const cold = rounds.map(r => r.agents.filter(a => a.cold >= 2).length);
  console.log(`cold agents per round: avg ${(cold.reduce((s, x) => s + x, 0) / cold.length).toFixed(1)}, max ${Math.max(...cold)}`);
} else console.log('(run predates the bank)');

// The chain's books must balance: checked on every round event, and on final.json. The
// full set (lib.rs header) needs the fields step C added; older runs get the first three.
if (rounds.at(-1)?.bank?.books) {
  hr('invariants (should all hold)');
  const full = rounds.at(-1).bank.cash !== undefined;
  const checks = {
    'supply = Σ agent cash': r => r.bank.sumCash === r.bank.supply,
    // older runs: the bank's cash was its equity
    'Σ agent cash + bank cash = start + seed + minted − repaid − written off': r => { const b = r.bank, k = b.books;
      return b.sumCash + (b.cash ?? b.equity) === k.startMoney + k.bankSeed + k.minted - k.principalRepaid - k.writtenOff; },
    'debt total = Σ agent debt': r => r.bank.sumDebt === r.bank.debtTotal,
    ...(full ? {
      'bank cash = seed + interest + penalties + recovered − refunds − written off − dividends': r => { const k = r.bank.books;
        return r.bank.cash === k.bankSeed + k.interestIncome + k.penalties + k.recovered - k.refunds - k.writtenOff - k.dividendsPaid; },
      'minted = Σ open principal + repaid + written off + bad debt': r => { const k = r.bank.books;
        return k.minted === r.bank.sumPrincipal + k.principalRepaid + k.writtenOff + k.badDebt; },
      'Σ bank book = seized − sold': r => r.bank.bankBook.reduce((s, x) => s + x, 0) === r.bank.books.seizedValue - r.bank.books.soldBook,
      'bad debt > 0 ⇒ bank cash = 0': r => !r.bank.badDebt || !r.bank.cash,
      'per agent: principal ≤ debt; no debt ⇒ no principal, nothing locked': r => r.bank.slotsOk,
    } : {}),
  };
  // the SETTLERS mint against the books — only runs since the coin exists recorded it
  if (rounds.at(-1).bank.settlers != null) {
    checks['SETTLERS supply = Σ agent cash + bank cash'] =
      r => r.bank.settlers == null || r.bank.settlers === r.bank.sumCash + r.bank.cash;
  }
  const bad = Object.fromEntries(Object.keys(checks).map(k => [k, []]));
  for (const r of rounds) for (const [k, f] of Object.entries(checks)) if (!f(r)) bad[k].push(r.round);
  // goods move only by what was settled: Σ (goods + locked) + the bank's goods changes by the settled deltas
  if (full) {
    const n = meta.agents.length, c = meta.config;
    let prev = G.map(g => g === 0 ? n * c.START_FOOD : g === 1 ? n * c.START_WOOD : 0);
    bad['goods change only by settled deltas'] = [];
    for (const r of rounds) {
      const d = r.bank.settled ?? G.map(() => 0);
      if (G.some(g => r.bank.goodsTotal[g] !== prev[g] + d[g])) bad['goods change only by settled deltas'].push(r.round);
      prev = r.bank.goodsTotal;
    }
  }
  const say = (what, xs) => console.log(`${what.padEnd(88)} ${xs.length ? `BROKEN in ${xs.length} rounds (first r${xs[0]})` : `ok in all ${rounds.length} rounds`}`);
  for (const [k, xs] of Object.entries(bad)) say(k, xs);
  const L = final?.chain;
  if (L?.books) {
    const cash = L.slots.reduce((s, x) => s + x.cash, 0), k = L.books;
    const ok = x => x ? 'ok' : 'BROKEN';
    console.log(`final ledger: supply ${ok(L.supply === cash)}   money ${ok(cash + L.bank.cash === k.startMoney + k.bankSeed + k.minted - k.principalRepaid - k.writtenOff)}   ` +
      `debt ${ok(L.debtTotal === L.slots.reduce((s, x) => s + x.debt, 0))}` +
      (k.refunds !== undefined ? `   bank cash ${ok(L.bank.cash === k.bankSeed + k.interestIncome + k.penalties + k.recovered - k.refunds - k.writtenOff - k.dividendsPaid)}` +
        `   minted ${ok(k.minted === L.slots.reduce((s, x) => s + x.principal, 0) + k.principalRepaid + k.writtenOff + k.badDebt)}` : '') +
      (final.settlersSupply != null ? `   SETTLERS ${ok(final.settlersSupply === cash + L.bank.cash)}` : ''));
    if (final.mint) console.log(`SETTLERS ${final.mint}: ${coins(final.settlersSupply)} in existence`);
  }
}

// Did agents gravitate to what they're best at, and did doing so pay?
const bestAt = id => { const sk = meta.agents[id]?.skills; return sk && Object.entries(sk).sort((a, b) => b[1] - a[1])[0][0]; };
if (meta.agents[0]?.skills) {
  hr('skills: did agents specialize in what they are best at?');
  const endCash = final?.chain.slots.map(s => s.cash) ?? last.map(a => a.cash);
  const rows = meta.agents.map(a => {
    const mine = decisions.filter(d => d.agent === a.id);
    return { a, best: bestAt(a.id), share: mine.filter(d => d.activity === bestAt(a.id)).length / Math.max(1, mine.length), cash: endCash[a.id] ?? 0 };
  });
  const avgCash = xs => avg(xs.map(r => r.cash));
  const spec = rows.filter(r => r.share >= 0.5), gen = rows.filter(r => r.share < 0.5);
  console.log(`shifts spent at own best skill: ${pct(rows.reduce((s, r) => s + r.share, 0), rows.length)} on average`);
  console.log(`specialized (>=50% at best skill): ${spec.length} agents, avg cash ${coins(avgCash(spec))}   ` +
    `others: ${gen.length} agents, avg cash ${coins(avgCash(gen))}`);
}

hr('final standings (on chain)');
const standing = (final?.chain.slots ?? last.map(a => ({ cash: a.cash, goods: a.goods }))).map((s, i) => ({ i, ...s }))
  .sort((a, b) => b.cash - a.cash);
for (const s of standing) {
  const mine = decisions.filter(d => d.agent === s.i);
  const top = {}; for (const d of mine) top[d.activity] = (top[d.activity] ?? 0) + 1;
  const main = Object.entries(top).sort((a, b) => b[1] - a[1])[0];
  const sk = meta.agents[s.i]?.skills;
  const end = last[s.i];
  console.log(`${name(s.i).padEnd(9)} ${sk ? `f${sk.gather_food} w${sk.gather_wood} n${sk.craft_net}  ` : ''}cash ${coins(s.cash).padStart(7)}  food ${String(s.goods[0]).padStart(3)}  wood ${String(s.goods[1]).padStart(3)}  nets ${s.goods[2]}${s.goods.length > 3 ? `  boats ${s.goods[3]}` : ''}` +
    `${s.goods.length > 4 ? `  houses ${s.goods[4] + (s.locked?.[4] ?? 0)}${end?.building != null ? ' (1 unfinished)' : ''}` : ''}${end?.score !== undefined ? `  score ${end.score.toFixed(1)}` : ''}   ` +
    `mostly ${main ? `${main[0]} (${main[1]}/${mine.length})` : '—'}`);
}

hr('sample reasoning');
for (const d of decisions.filter((_, i) => i % Math.max(1, Math.floor(decisions.length / 8)) === 0).slice(0, 8))
  console.log(`${name(d.agent).padEnd(9)} ${String(d.activity).padEnd(12)} ${d.thought}`);

if (final) console.log(`\n${final.transactions} Solana transactions   llm ${final.llm.calls ?? 0} calls, $${(final.llm.cost ?? 0).toFixed(3)}`);
