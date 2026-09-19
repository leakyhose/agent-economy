// Headless economy spike: does a watchable boom-bust cascade emerge without scripting it?
// No LLMs, no chain. Seeded, deterministic. ~100 agents.
//
// MECHANISM UNDER TEST (nothing below scripts a crash):
//   bank credit -> boat boom -> overfishing -> fish glut -> price crash
//   -> debt service fails -> repossession -> distressed boats flood the market
//   -> boat price crashes -> next borrower's collateral is underwater -> cascade
//
// MONEY IS CONSERVED. Every lamport has a source and a sink:
//   in  : bank lending (credit creation), mainland export earnings
//   out : interest to the bank, loan write-offs
//   pools (builders, bank) spend their income back into the fish market each tick.

export function run(opts = {}) {
  const P = {
    N: 100, TICKS: 260, SEED: 42, SHOCK: -1,
    RATE: 0.010,      // interest per tick
    LTV: 0.70,        // loan-to-value on a boat
    LIQ: 1.05,        // repossess below this health factor
    SPOIL: 0.22,      // fish perish per tick
    COST: 60,         // builders' marginal cost
    HORIZON: 10,      // ticks of profit an agent projects when valuing a boat
    BUILD: 1,         // new boats per tick baseline
    BUILD_MAX: 4,
    COOL: 25,         // credit cooldown after repossession
    DEPREC: 0.012,    // chance a boat wears out per tick  (caps the capital stock)
    EXPORT: [[7,10],[5,16],[3,26],[1.5,40],[0.6,70]],  // world demand curve [price, qty]
    DEP_RATE: 0.004,  // deposit interest the bank pays out  (recycles its income)
    ...opts,
  };
  let _s = P.SEED >>> 0;
  const rnd = () => { _s |= 0; _s = (_s + 0x6D2B79F5) | 0;
    let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

  const agents = Array.from({ length: P.N }, (_, i) => ({
    id: i, cash: 30 + rnd() * 50, fish: 3, boat: false, debt: 0, hunger: 0,
    trend: rnd() < 0.4 ? 0 : rnd() * 2.0,     // 40% fundamentalists, rest extrapolate
    greed: 0.8 + rnd() * 0.45,
    cool: 0,
  }));

  function clear(bids, asks) {
    if (!bids.length || !asks.length) return null;
    bids.sort((x, y) => y.limit - x.limit || (x.a?.id ?? 1e9) - (y.a?.id ?? 1e9));
    asks.sort((x, y) => x.limit - y.limit || (x.a?.id ?? 1e9) - (y.a?.id ?? 1e9));
    const ps = [...new Set([...bids, ...asks].map(o => o.limit))].sort((x, y) => x - y);
    let best = null;
    for (const p of ps) {
      let D = 0, S = 0;
      for (const o of bids) if (o.limit >= p) D += o.qty;
      for (const o of asks) if (o.limit <= p) S += o.qty;
      const v = Math.min(D, S);
      if (v > 0 && (!best || v > best.v || (v === best.v && Math.abs(D - S) < best.gap)))
        best = { p, v, gap: Math.abs(D - S) };
    }
    if (!best) return null;
    let r = best.v; for (const b of bids) { if (b.limit < best.p || r <= 0) break; b.fill = Math.min(b.qty, r); r -= b.fill; }
    r = best.v;     for (const a of asks) { if (a.limit > best.p || r <= 0) break; a.fill = Math.min(a.qty, r); r -= a.fill; }
    return { price: best.p, volume: best.v };
  }

  let fishP = 5, boatP = P.COST * 1.1;
  const fishH = [fishP], boatH = [boatP];
  let builders = 200, bank = 400, stock = 2, repoStock = 0;
  let credit = 0, writeOff = 0, exported = 0, totalRepo = 0, worn = 0;
  const log = [];
  const trend = h => h.length < 10 ? 0 : (h.at(-1) - h.at(-10)) / Math.max(0.5, h.at(-10));

  for (let t = 0; t < P.TICKS; t++) {
    const fT = trend(fishH);
    void worn;

    for (const a of agents) {                                                            // PRODUCE + WEAR
      a.fish += a.boat ? 3 : 1;
      if (a.cool > 0) a.cool--;
      if (a.boat && rnd() < P.DEPREC) { a.boat = false; worn++; }   // boats wear out
    }
    for (const a of agents) {                                                            // EAT
      if (a.fish >= 1) { a.fish -= 1; a.hunger = Math.max(0, a.hunger - 1); } else a.hunger++;
    }

    // ---- FISH MARKET ----
    const fb = [], fa = [];
    for (const a of agents) {
      const exp = fishP * (1 + a.trend * fT * 0.4);
      const sur = a.fish - 2;
      if (sur > 0) fa.push({ a, qty: sur, limit: Math.max(0.2, exp * (0.4 + 0.5 / (1 + sur / 4))), fill: 0 });
      const want = Math.max(0, 3 - a.fish);
      if (want > 0 && a.cash > 0)
        fb.push({ a, qty: want, limit: Math.min(a.cash / want, exp * a.greed * (0.85 + 0.3 * a.hunger)), fill: 0 });
    }
    // mainland export demand: a downward-sloping curve. Non-absorbing floor + money source.
    for (const [lp, q] of P.EXPORT) fb.push({ a: null, pool: 'export', qty: q, limit: lp, fill: 0 });
    // builders and bank eat too — this is how their income returns to circulation
    for (const [name, bal] of [['builders', builders], ['bank', bank]]) {
      const q = Math.floor(Math.min(12, bal / Math.max(1, fishP * 3)));
      if (q > 0) fb.push({ a: null, pool: name, qty: q, limit: Math.min(bal / q, fishP * 1.15), fill: 0 });
    }
    const fr = clear(fb, fa);
    if (fr) {
      fishP = fr.price;
      for (const o of fa) if (o.fill) { o.a.fish -= o.fill; o.a.cash += o.fill * fishP; }
      for (const o of fb) if (o.fill) {
        const v = o.fill * fishP;
        if (o.a) { o.a.fish += o.fill; o.a.cash -= v; }
        else if (o.pool === 'export') exported += v;                  // money IN
        else if (o.pool === 'builders') builders -= v;
        else bank -= v;
      }
    }
    for (const a of agents) a.fish = Math.max(0, a.fish * (1 - P.SPOIL));               // SPOILAGE
    fishH.push(fishP);

    // ---- BOAT MARKET ----
    const bb = [], ba = [];
    const proj = 2 * fishP * P.HORIZON;
    for (const a of agents) {
      if (a.boat || a.debt > 0 || a.cool > 0) continue;
      const appetite = 1 + a.trend * Math.max(0, fT);                 // extrapolation -> the bubble
      const willing = Math.min(proj * appetite * a.greed, a.cash / (1 - P.LTV));
      if (willing > P.COST * 0.85) bb.push({ a, qty: 1, limit: willing, fill: 0 });
    }
    for (let k = 0; k < stock; k++)     ba.push({ a: null, src: 'new',  qty: 1, limit: P.COST * (0.95 + 0.1 * rnd()), fill: 0 });
    for (let k = 0; k < repoStock; k++) ba.push({ a: null, src: 'repo', qty: 1, limit: P.COST * 0.5, fill: 0 });  // distressed
    const br = clear(bb, ba);
    if (br) {
      boatP = br.price;
      let sold = 0, avail = stock + repoStock;
      for (const o of bb) {
        if (!o.fill || sold >= avail) continue;
        const loan = boatP * P.LTV, down = boatP - loan;
        if (o.a.cash < down) continue;
        o.a.cash -= down; o.a.debt = loan; o.a.boat = true;
        credit += loan;                                               // money IN (credit creation)
        builders += boatP;                                            // builder revenue
        sold++;
      }
      const fromRepo = Math.min(sold, repoStock);
      repoStock -= fromRepo; stock -= (sold - fromRepo);
      bank += fromRepo * boatP * 0.5;                                 // bank recovers on repo sales
      builders -= fromRepo * boatP;                                   // repo boats aren't builder revenue
    }
    stock = Math.min(P.BUILD_MAX + 2, stock + (boatP > P.COST * 1.2 ? P.BUILD_MAX : P.BUILD));
    boatH.push(boatP);

    // ---- CREDIT + PERMISSIONLESS REPOSSESSION ----
    let repo = 0;
    for (const a of agents) {
      if (a.debt <= 0) continue;
      const owed = a.debt * P.RATE;
      if (a.cash >= owed) { a.cash -= owed; bank += owed; }           // money OUT of circulation
      else { const paid = a.cash; bank += paid; a.debt += owed - paid; a.cash = 0; }
      if (a.boat && boatP / a.debt < P.LIQ) {                         // anyone may call this
        a.boat = false; repoStock++; repo++; totalRepo++;
        writeOff += Math.max(0, a.debt - boatP * 0.5);
        credit -= a.debt; a.debt = 0; a.cool = P.COOL;
      }
    }

    // bank pays deposit interest on savings -> its income returns to circulation
    if (bank > 0) {
      const tot = agents.reduce((s2, a) => s2 + Math.max(0, a.cash), 0);
      const pot = Math.min(bank * 0.5, tot * P.DEP_RATE);
      if (tot > 0 && pot > 0) { for (const a of agents) a.cash += pot * Math.max(0, a.cash) / tot; bank -= pot; }
    }

    if (t === P.SHOCK) for (const a of agents) a.fish = Math.max(0, a.fish - 3);

    log.push({ t, fishP, boatP, boats: agents.filter(a => a.boat).length,
               debt: agents.reduce((s, a) => s + a.debt, 0), repo,
               M: agents.reduce((s, a) => s + a.cash, 0) + builders + bank });
  }
  return { P, log, totalRepo, writeOff, exported, credit, worn,
           gini: (() => { const c = agents.map(a => a.cash).sort((x, y) => x - y), n = c.length;
             const s = c.reduce((a, b) => a + b, 0); if (!s) return 0;
             return c.reduce((acc, v, i) => acc + (2 * (i + 1) - n - 1) * v, 0) / (n * s); })() };
}

// ---- "is it watchable?" score ----
export function score(r) {
  const L = r.log, T = L.length;
  const boats = L.map(x => x.boats), fish = L.map(x => x.fishP);
  const peakB = Math.max(...boats), peakBt = boats.indexOf(peakB);
  const worst = L.reduce((m, x) => x.repo > m.repo ? x : m, L[0]);
  const after = L.slice(worst.t);
  const troughB = Math.min(...after.map(x => x.boats));
  const recovery = Math.max(...after.map(x => x.boats)) - troughB;
  const pf = Math.max(...fish), tf = Math.min(...fish.slice(fish.indexOf(pf)));
  const drop = 1 - tf / pf;
  const alive = L.at(-1).boats > 2 && L.at(-1).fishP > 0.8;
  return {
    peakB, peakBt, worstT: worst.t, worstRepo: worst.repo, troughB, recovery, drop, alive,
    // want: boom builds slowly, cascade lands mid-run, real drop, life afterwards
    s: (worst.repo >= 4 ? 25 : worst.repo * 5)
     + (worst.t > 60 && worst.t < 190 ? 25 : 0)
     + Math.min(20, drop * 40)
     + Math.min(15, recovery * 2)
     + (alive ? 15 : 0)
     + (peakB >= 12 ? 10 : 0),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = run({ SEED: Number(process.argv[2] ?? 42) });
  const sc = score(r);
  console.log(`seed=${r.P.SEED} agents=${r.P.N} ticks=${r.P.TICKS}   score=${sc.s}\n`);
  console.log('  t   fish   boat  boats    debt      M  repo');
  for (const x of r.log) if (x.t % 8 === 0 || x.repo >= 3)
    console.log(String(x.t).padStart(3), x.fishP.toFixed(2).padStart(6), x.boatP.toFixed(1).padStart(6),
      String(x.boats).padStart(6), x.debt.toFixed(0).padStart(7), x.M.toFixed(0).padStart(6),
      (x.repo ? String(x.repo).padStart(5) : '    -') + (x.repo >= 3 ? '  <<<' : ''));
  console.log(`\npeak boats ${sc.peakB} @t${sc.peakBt} | worst t=${sc.worstT} (${sc.worstRepo} repo) | trough ${sc.troughB} | recovery +${sc.recovery}`);
  console.log(`fish drop ${(sc.drop * 100).toFixed(0)}% | alive=${sc.alive} | repos ${r.totalRepo} | writeoff ${r.writeOff.toFixed(0)} | gini ${r.gini.toFixed(2)}`);
}
