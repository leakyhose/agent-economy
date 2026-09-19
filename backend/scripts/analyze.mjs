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
const G = GOODS.map((_, g) => g);                       // every slot, incl. the dead boat slot (index order = the chain's)
const SHOWN = G.filter(g => GOODS[g] !== 'boats');      // boats are never made or shown; old runs logged zeros for them
const perGood = f => SHOWN.map(g => f(GOODS[g], g)).join('  ');
const decisions = ev.filter(e => e.type === 'decision');
const name = id => meta.agents[id]?.name ?? `#${id}`;
const pct = (a, b) => b ? `${Math.round(a / b * 100)}%` : '—';
const avg = xs => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
const giniOf = xs => { const v = [...xs].sort((a, b) => a - b), n = v.length, sum = v.reduce((s, x) => s + x, 0);
  return n && sum ? v.reduce((acc, x, i) => acc + (2 * (i + 1) - n - 1) * x, 0) / (n * sum) : 0; };
// runs since step D count time in rounds (turns); older ones in 3s rounds and minutes
const turns = !!meta.config.BANK?.TERM_ROUNDS;
const hr = t => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`);

console.log(`run ${path.basename(dir)}   brain ${meta.brain}   ${meta.agents.length} agents   ${rounds.length} rounds   ${decisions.length} decisions`);

hr('market: did agents try to trade, and did it work?');
for (const g of SHOWN) {
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

// ---- market quality (FIX_PLAN step D). Newer runs log every order sent to each auction
// with its arrival seq and fill; for older runs the books are rebuilt from
// the order events between rounds, and fills from the round's trades (approximate).
hr('market quality: priority, price discovery');
{
  const N = meta.agents.length, logged = rounds.some(r => r.orders);
  const books = logged ? rounds.map(r => r.orders.filter(o => o.agent !== 'bank'))
    : (() => {
      const out = rounds.map(() => []); let k = 0;
      for (const e of ev) {
        if (e.type === 'round') k++;
        else if (e.type === 'order' && k < rounds.length) out[k].push({ g: GOODS.indexOf(e.good), side: e.side, agent: e.agent, qty: e.qty, limit: e.price, filled: 0 });
      }
      out.forEach((os, i) => {            // a round's trades, handed out to that agent's orders best price first
        for (const t of rounds[i].trades ?? []) {
          let left = t.qty;
          for (const o of os.filter(o => o.agent === t.agent && GOODS[o.g] === t.good && o.side === t.side)
            .sort((x, y) => t.side === 'sell' ? x.limit - y.limit : y.limit - x.limit)) { const q = Math.min(left, o.qty - o.filled); o.filled += q; left -= q; }
        }
      });
      return out;
    })();
  console.log(logged ? '(from the orders each auction was sent; "was" = this analysis of run 17-04-02, before step D)' : '(older run: books rebuilt from order events, fills from trades — approximate)');
  const live = rounds.map((r, i) => r.live ?? new Set(books[i].map(o => o.agent)).size);
  console.log(`agents with an order: ${pct(avg(live), N)} per round on average (was 57%)`);
  const F = 0, foodR = rounds.map((r, i) => ({ r, i, b: r.book?.[F] })).filter(x => x.b);
  const asksOnly = foodR.filter(x => x.b.asks && !x.b.bids).length;
  console.log(`food rounds with asks but no bids: ${asksOnly}/${foodR.length} (was 47/99)`);
  // the print below the cheapest ask of the round before: sellers undercutting the old floor
  const below = foodR.filter(x => x.i > 0 && x.r.volumes[F] > 0 && rounds[x.i - 1].book?.[F]?.asks);
  console.log(`food traded below the previous round's cheapest ask: ${below.filter(x => x.r.prices[F] < rounds[x.i - 1].book[F].bestAsk).length} of ${below.length} trading rounds (was 0/51)`);
  // after a food ask that filled nothing, does the agent's next food ask go below that round's cheapest ask?
  let hopeless = 0, broke = 0;
  for (let i = 0; i < books.length; i++) {
    const asks = books[i].filter(o => o.g === F && o.side === 'sell'), floor = Math.min(...asks.map(o => o.limit));
    for (const o of asks.filter(o => !o.filled)) {
      const next = books.slice(i + 1).map(b => b.find(x => x.g === F && x.side === 'sell' && x.agent === o.agent)).find(Boolean);
      if (!next) continue;
      hopeless++; if (next.limit < floor) broke++;
    }
  }
  console.log(`after an unfilled food ask, the agent's next ask broke below that round's floor: ${broke}/${hopeless} (was 17/802)`);
  const levels = books.map(b => new Set(b.filter(o => o.g === F && o.side === 'sell').map(o => o.limit)).size).filter((n, i) => books[i].filter(o => o.g === F && o.side === 'sell').length >= 2);
  if (levels.length) console.log(`distinct food ask prices per round (rounds with 2+ asks): avg ${avg(levels).toFixed(1)}, a single price in ${levels.filter(n => n === 1).length}/${levels.length} rounds (was 2.8, 16/96)`);
  // ties: orders at the same price, same side and good, that filled differently. With price-time
  // priority the lower agent index should win about half of them.
  let ties = 0, lowWon = 0;
  for (const b of books) {
    const groups = {};
    for (const o of b) if (typeof o.agent === 'number') (groups[`${o.g}${o.side}${o.limit}`] ??= []).push(o);
    for (const os of Object.values(groups)) for (let x = 0; x < os.length; x++) for (let y = x + 1; y < os.length; y++) {
      const fx = os[x].filled / os[x].qty, fy = os[y].filled / os[y].qty;
      if (fx === fy || os[x].agent === os[y].agent) continue;
      ties++; if ((fx > fy) === (os[x].agent < os[y].agent)) lowWon++;
    }
  }
  console.log(`tied orders that filled differently: lower agent index won ${lowWon} of ${ties} (${pct(lowWon, ties)}; 50% = no index bias; was 434/479)`);
  // the bank's sale of seized goods: its print against what the same book would have printed without it
  const sales = rounds.flatMap(r => (r.noBankPrice ?? []).map((p, g) => ({ r, g, p })).filter(x => x.p != null && x.r.book[x.g].bankQty));
  if (sales.length) {
    const d = sales.map(x => (x.r.prices[x.g] - x.p) / x.p);
    console.log(`bank sale rounds ${sales.length}: print vs the no-bank clear avg ${(avg(d) * 100).toFixed(1)}%, worst ${(Math.min(...d) * 100).toFixed(1)}% (target within ~3%)`);
  } else if (logged) console.log('bank sale: no round where the bank sold into a crossing book');
  const bankAsks = rounds.filter(r => r.book?.some(b => b.bankPrice != null));
  if (bankAsks.length) console.log(`  bank asks by round: ${bankAsks.slice(0, 12).map(r => `r${r.round} ${r.book.map((b, g) => b.bankPrice != null ? `${GOODS[g]} ${b.bankQty}@${coins(b.bankPrice)}` : '').filter(Boolean).join(',')}`).join('  ')}`);
  // turns: how long each round waited for the slowest agent, and how many didn't answer in time
  const dec = rounds.map(r => r.decide).filter(Boolean);
  const mins = final ? (new Date(final.stoppedAt) - new Date(meta.startedAt)) / 60_000 : null;
  if (dec.length) {
    const w = dec.map(d => d.slowest).sort((a, b) => a - b), q = p => w[Math.min(w.length - 1, Math.floor(p * w.length))];
    console.log(`round wait (slowest agent): median ${(q(0.5) / 1000).toFixed(1)}s  p90 ${(q(0.9) / 1000).toFixed(1)}s  max ${(w.at(-1) / 1000).toFixed(1)}s   ` +
      `timed out ${dec.reduce((s, d) => s + d.timeouts, 0)} of ${dec.length * N} turns, no answer ${dec.reduce((s, d) => s + (d.noAnswer ?? 0), 0)}   ` +
      `round length avg ${(avg(rounds.map(r => r.roundMs ?? 0)) / 1000).toFixed(1)}s`);
  }
  if (mins) console.log(`calls per minute ${((final.llm.calls ?? 0) / mins).toFixed(0)}   decisions per minute ${(decisions.length / mins).toFixed(0)}   rounds per minute ${(rounds.length / mins).toFixed(1)}` +
    ` (was 511, 329, 16.5)`);
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
const noAct = decisions.filter(d => !d.actions.some(x => ['gather_food', 'gather_wood', 'craft_net', 'build_house', 'rest'].includes(x.tool)));   // rest: old runs
if (noAct.length) { const n = decisions.length, acts = decisions.map(d => (d.actions ?? []).length);
  console.log(`actions per decision: avg ${(acts.reduce((s, x) => s + x, 0) / Math.max(1, n)).toFixed(2)}   a lone shift and nothing else: ${pct(acts.filter(x => x === 1).length, n)} of decisions   (the market died at 79%: orders need room in the turn)`); }
console.log(`decisions that never chose a shift (sat idle): ${noAct.length} (${pct(noAct.length, decisions.length)})`);

hr('needs, waste and money');
const hungryRounds = rounds.map(r => r.agents?.filter(a => a.hunger > 0).length ?? 0);
const spoiled = G.map(g => rounds.reduce((s, r) => s + (r.spoiled?.[g] ?? 0), 0));
console.log(`hungry agents per round: avg ${(hungryRounds.reduce((s, x) => s + x, 0) / Math.max(1, hungryRounds.length)).toFixed(1)}, max ${Math.max(0, ...hungryRounds)}`);
console.log(`spoiled: ${perGood((n, g) => `${n} ${spoiled[g]}`)}`);
const last = rounds.at(-1)?.agents ?? [];
if (last.length) {
  const cash = last.map(a => a.cash).sort((a, b) => a - b), n = cash.length, gini = giniOf(cash);
  const moved = rounds.flatMap(r => r.trades ?? []).filter(t => t.side === 'buy').reduce((s, t) => s + t.qty * t.price, 0);
  console.log(`money that changed hands: ${coins(moved)}   cash gini ${gini.toFixed(2)}   ` +
    `poorest ${coins(cash[0])}  median ${coins(cash[Math.floor(n / 2)])}  richest ${coins(cash.at(-1))}`);
  const goods = G.map(g => last.reduce((s, a) => s + a.goods[g], 0));
  console.log(`held at the end: ${perGood((n, g) => `${n} ${goods[g]}`)}  (${(goods[0] / n).toFixed(1)} food per agent)`);
}

hr('the economy, round by round');
if (rounds[0]?.metrics) {
  // GDP = everything made in a round (fish, wood, nets, houses finished) at that round's prices;
  // gross output, so wood that went into nets and houses is counted twice.
  const M = rounds.map(r => r.metrics), q = Math.max(1, Math.ceil(M.length / 4));
  const made = G.map(g => M.reduce((s, m) => s + (m.made[g] ?? 0), 0));
  // real GDP (output at fixed opening prices): the growth number. Runs before it was logged have none.
  if (M.some(m => m.realGdp != null))
    console.log(`REAL GDP per round by quarter: ` + [0, 1, 2, 3].map(k => M.slice(k * q, (k + 1) * q)).filter(x => x.length)
      .map(x => coins(avg(x.map(m => m.realGdp ?? 0)))).join(' → ') + `   (nominal, at market prices, below)`);
  console.log(`GDP ${coins(M.reduce((s, m) => s + m.gdp, 0))} over ${M.length} rounds; per round by quarter of the run: ` +
    [0, 1, 2, 3].map(k => M.slice(k * q, (k + 1) * q)).filter(x => x.length).map(x => coins(avg(x.map(m => m.gdp)))).join(' → '));
  console.log(`  made: ${perGood((n, g) => `${n} ${made[g]}`)}`);
  const pi = M.map(m => m.priceIndex), infl = M.map(m => m.inflation).filter(x => x != null);
  console.log(`price index ${pi[0].toFixed(2)} → ${pi.at(-1).toFixed(2)}   range ${Math.min(...pi).toFixed(2)}–${Math.max(...pi).toFixed(2)}   ` +
    (infl.length ? `inflation per ${meta.config.INFLATION_ROUNDS ?? 20} rounds: last ${(infl.at(-1) * 100).toFixed(1)}%, average ${(avg(infl) * 100).toFixed(1)}%` : 'inflation: run too short'));
  // rested: gone since phase 1, but old runs logged it, so it still counts toward all shifts
  const allOf = m => m.shifts.worked + (m.shifts.rested ?? 0) + m.shifts.idle;
  const sh = M.reduce((s, m) => ({ worked: s.worked + m.shifts.worked, rested: s.rested + (m.shifts.rested ?? 0), idle: s.idle + m.shifts.idle }), { worked: 0, rested: 0, idle: 0 });
  console.log(`employment ${pct(sh.worked, sh.worked + sh.rested + sh.idle)} of ${sh.worked + sh.rested + sh.idle} shifts worked ` +
    `(${sh.rested ? `rested ${sh.rested}, ` : ''}idle/unchosen ${sh.idle}); by quarter: ` +
    [0, 1, 2, 3].map(k => M.slice(k * q, (k + 1) * q)).filter(x => x.length).map(x => {
      const w = x.reduce((s, m) => s + m.shifts.worked, 0), all = x.reduce((s, m) => s + allOf(m), 0);
      return pct(w, all); }).join(' → '));
  const unsold = G.map(g => M.reduce((s, m) => s + (m.unsold[g] ?? 0), 0));
  console.log(`slack (offered, unsold): ${coins(M.reduce((s, m) => s + m.slack, 0))} in all, avg ${pct(avg(M.filter(m => m.slackShare != null).map(m => m.slackShare)), 1)} of the value offered per round; ` +
    `units unsold ${perGood((n, g) => `${n} ${unsold[g]}`)}`);
  console.log(`wellbeing per agent ${M[0].wellbeing} → ${M.at(-1).wellbeing}  (avg ${turns ? `${avg(M.map(m => m.wbRound)).toFixed(2)} a round` : `${(avg(M.map(m => m.wbRound)) * 20).toFixed(1)} a minute`})   ` +
    `net-worth gini ${M[0].gini.toFixed(2)} → ${M.at(-1).gini.toFixed(2)}`);
  const cr = M.map(m => m.credit);
  console.log(`credit outstanding ${coins(cr.at(-1))} at the end (peak ${coins(Math.max(...cr))})   money ${coins(M[0].money)} → ${coins(M.at(-1).money)}`);
  console.log(`houses: ${M.at(-1).housesBuilt} built, ${M.at(-1).building} unfinished at the end, ${M.at(-1).homeowners} of ${meta.agents.length} agents live in one`);
  const lastA = rounds.at(-1).agents;
  // the score is wellbeing alone; net worth is reported beside it, not added to it
  if (lastA[0]?.wellbeing !== undefined) console.log(`end wellbeing: avg ${avg(lastA.map(a => a.wellbeing)).toFixed(1)}   ` +
    `homeowners ${avg(lastA.filter(a => a.house).map(a => a.wellbeing)).toFixed(1)}   others ${avg(lastA.filter(a => !a.house).map(a => a.wellbeing)).toFixed(1)}   ` +
    `net worth avg ${coins(avg(lastA.map(a => a.wealth ?? 0)))} coins`);
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
  if (Object.keys(terms).length) console.log(`terms chosen (new loans): ${Object.entries(terms).map(([k, v]) => `${k} ${turns ? 'rounds' : 'min'} ×${v}`).join('  ')}`);
  // margin calls are gone; old runs still have them in the log, so they are still counted
  const margin = fc.filter(f => f.reason === 'margin').length;
  if (rounds.at(-1).collected) console.log(`loans come due: ${col.length} collected from cash at the deadline (no penalty, ${coins(col.reduce((s, f) => s + f.taken, 0))}), ` +
    `${fc.filter(f => f.reason === 'overdue').length} foreclosed overdue${margin ? `, ${margin} margin calls` : ''}`);
  const why = f => [f.reason && (f.reason === 'margin' ? 'margin call' : 'overdue'),
    goodsOf(f.seized) && `seized ${goodsOf(f.seized)}`, goodsOf(f.returned) && `returned ${goodsOf(f.returned)}`].filter(Boolean).join(', ');
  const goodsOf = q => q?.map((n, g) => n ? `${n} ${GOODS[g]}` : '').filter(Boolean).join('+');
  console.log(`foreclosures ${fc.length}` + (fc.length ? `: ` + fc.map(f => `r${f.round} ${f.name}${why(f) ? ` (${why(f)})` : ''}`).join('; ') : ''));
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
      `out: written off ${coins(b.writtenOff)}${b.refunds !== undefined ? `  refunds ${coins(b.refunds)}` : ''}   bad debt ${coins(b.badDebt)}`);
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
        `   minted ${ok(k.minted === L.slots.reduce((s, x) => s + x.principal, 0) + k.principalRepaid + k.writtenOff + k.badDebt)}` : ''));
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
  console.log(`${name(s.i).padEnd(9)} ${sk ? `f${sk.gather_food} w${sk.gather_wood} n${sk.craft_net}  ` : ''}cash ${coins(s.cash).padStart(7)}  food ${String(s.goods[0]).padStart(3)}  wood ${String(s.goods[1]).padStart(3)}  nets ${s.goods[2]}` +
    `${s.goods.length > 4 ? `  houses ${s.goods[4] + (s.locked?.[4] ?? 0)}${end?.building != null ? ' (1 unfinished)' : ''}` : ''}` +
    `${end?.wellbeing !== undefined ? `  wellbeing ${end.wellbeing.toFixed(1)}` : ''}${end?.wealth !== undefined ? `  net worth ${coins(end.wealth)}` : ''}   ` +
    `mostly ${main ? `${main[0]} (${main[1]}/${mine.length})` : '—'}`);
}

hr('sample reasoning');
for (const d of decisions.filter((_, i) => i % Math.max(1, Math.floor(decisions.length / 8)) === 0).slice(0, 8))
  console.log(`${name(d.agent).padEnd(9)} ${String(d.activity).padEnd(12)} ${d.thought}`);

if (final) console.log(`\n${final.transactions} Solana transactions   llm ${final.llm.calls ?? 0} calls, $${(final.llm.cost ?? 0).toFixed(3)}`);
