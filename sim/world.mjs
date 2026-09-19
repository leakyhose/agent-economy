// The village. ~100 agents, three trades, a market, money that is conserved.
// Agents have LLM minds (see mind.mjs) and rule-based bodies.
// Default behaviour should be STABLE and pleasant. Drama comes from interventions.

export const GOODS = ['fish', 'wood', 'ore'];
export const JOBS  = { fish: 'docks', wood: 'forest', ore: 'hills' };
export const TOOL  = { fish: 'boat', wood: 'axe', ore: 'pick' };

export function makeWorld(opts = {}) {
  const P = {
    N: 100, WORK_TICKS: 8, SPOIL: 0.03, TOOL_BOOST: 2, TOOL_WEAR: 0.008,
    EAT_EVERY: 4,                       // ticks between meals
    // yield per shift, per trade. Fish is food, so a catch must feed more than the fisher.
    YIELD: { fish: [8, 11], wood: [4, 6], ore: [3, 5] },
    HUNGER_CAP: 2.2,                    // ceiling on desperation bidding (prevents famine spirals)
    EXPORT: { fish: [[8,4],[5,9],[3,15],[1.5,24]],    // world demand curves [limit, qty]
              wood: [[7,5],[4,12],[2,22],[1,34]],
              ore:  [[9,4],[6,10],[3,20],[1.5,30]] },
    TOOL_COST: { boat: 55, axe: 40, pick: 48 },
    SEED: 1, ...opts,
  };
  let _s = P.SEED >>> 0;
  const rnd = () => { _s |= 0; _s = (_s + 0x6D2B79F5) | 0;
    let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

  const agents = Array.from({ length: P.N }, (_, i) => ({
    id: i,
    name: `agent-${String(i).padStart(3, '0')}`,
    cash: 40 + rnd() * 40,
    inv: { fish: 3, wood: 0, ore: 0 },
    tools: {},                              // boat / axe / pick -> true
    job: GOODS[i % 3],                      // starting trade
    busy: Math.floor(rnd() * P.WORK_TICKS), // stagger so they don't all finish together
    fed: 0, hunger: 0,
    // traits, drawn once — injected into the prompt so minds actually differ
    traits: {
      risk:     +(0.2 + rnd() * 0.7).toFixed(2),
      patience: +(0.2 + rnd() * 0.7).toFixed(2),
      herding:  +(rnd()).toFixed(2),
      info:     ['local', 'board', 'gossip'][Math.floor(rnd() * 3)],
    },
    lastReason: 'starting out',
    pricing: 'normal',
  }));

  const price = { fish: 5, wood: 4, ore: 6 };
  const hist  = { fish: [5], wood: [4], ore: [6] };
  let builders = 600;                       // toolmakers: buy wood+ore, sell tools, eat fish
  let exported = 0, spentOnTools = 0, tick = 0;
  const events = [];

  // ---- uniform-price batch auction -------------------------------------------------
  function clear(bids, asks) {
    if (!bids.length || !asks.length) return null;
    bids.sort((a, b) => b.limit - a.limit || (a.id ?? 1e9) - (b.id ?? 1e9));
    asks.sort((a, b) => a.limit - b.limit || (a.id ?? 1e9) - (b.id ?? 1e9));
    const ps = [...new Set([...bids, ...asks].map(o => o.limit))].sort((a, b) => a - b);
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

  const PRICING = { patient: 1.15, normal: 1.0, urgent: 0.82 };   // ask multiplier

  function step(interventions = []) {
    tick++;
    for (const iv of interventions) applyIntervention(iv);

    // 1. WORK — progress, then harvest when the shift ends
    const finished = [];
    for (const a of agents) {
      if (a.busy > 0) { a.busy--; continue; }
      const t = TOOL[a.job];
      const [lo, hi] = P.YIELD[a.job];
      let yld = (a.tools[t] ? P.TOOL_BOOST : 1) * (lo + Math.floor(rnd() * (hi - lo + 1)));
      yld = Math.round(yld * (mods.yield[a.job] ?? 1));
      a.inv[a.job] += yld;
      if (a.tools[t] && rnd() < P.TOOL_WEAR) { delete a.tools[t]; events.push({ tick, type: 'tool_broke', who: a.id, tool: t }); }
      a.busy = P.WORK_TICKS;
      finished.push(a);                       // <- these agents get to think this tick
    }

    // 2. EAT
    for (const a of agents) {
      a.fed++;
      if (a.fed >= P.EAT_EVERY) {
        if (a.inv.fish >= 1) { a.inv.fish -= 1; a.fed = 0; a.hunger = Math.max(0, a.hunger - 1); }
        else a.hunger++;
      }
    }

    // 3. MARKETS — one uniform-price batch auction per good
    const traded = {};
    for (const g of GOODS) {
      const bids = [], asks = [];
      for (const a of agents) {
        const keep = g === 'fish' ? 2 : 0;
        const sur = a.inv[g] - keep;
        if (sur > 0) asks.push({ id: a.id, a, qty: sur, fill: 0,
          limit: Math.max(0.2, price[g] * PRICING[a.pricing] * (0.5 + 0.45 / (1 + sur / 5))) });
        if (g === 'fish') {
          const want = Math.max(0, 3 - a.inv.fish);
          if (want > 0 && a.cash > 0) bids.push({ id: a.id, a, qty: want, fill: 0,
            limit: Math.min(a.cash / want, price.fish * Math.min(P.HUNGER_CAP, 0.9 + 0.25 * a.hunger)) });
        }
      }
      // toolmakers buy wood+ore; the mainland buys everything (money source + price floor)
      if (g !== 'fish' && builders > 0) {
        const q = Math.floor(Math.min(18, builders / Math.max(1, price[g] * 4)));
        if (q > 0) bids.push({ id: 1e9, pool: 'builders', qty: q, fill: 0, limit: price[g] * 1.1 });
      }
      if (g === 'fish' && builders > 0) {
        const q = Math.floor(Math.min(10, builders / Math.max(1, price.fish * 6)));
        if (q > 0) bids.push({ id: 1e9, pool: 'builders', qty: q, fill: 0, limit: price.fish * 1.05 });
      }
      for (const [lp, qt] of P.EXPORT[g])
        bids.push({ id: 2e9, pool: 'export', qty: Math.round(qt * (mods.export[g] ?? 1)), fill: 0, limit: lp });

      const r = clear(bids, asks);
      if (r) {
        price[g] = r.price; traded[g] = r.volume;
        for (const o of asks) if (o.fill) { o.a.inv[g] -= o.fill; o.a.cash += o.fill * r.price; }
        for (const o of bids) if (o.fill) {
          const v = o.fill * r.price;
          if (o.a) { o.a.inv[g] += o.fill; o.a.cash -= v; }
          else if (o.pool === 'export') exported += v;            // money IN
          else builders -= v;                                     // toolmakers' spend
        }
      }
      hist[g].push(price[g]);
    }

    // 4. SPOILAGE — fish perish; keeps gluts from becoming permanent
    for (const a of agents) a.inv.fish = Math.max(0, a.inv.fish * (1 - P.SPOIL));

    return { tick, finished, price: { ...price }, traded, builders, exported };
  }

  // ---- interventions: the user is the shock generator ------------------------------
  const mods = { yield: {}, export: {} };
  function applyIntervention(iv) {
    if (iv.type === 'yield')  { mods.yield[iv.good]  = iv.factor; events.push({ tick, ...iv }); }
    if (iv.type === 'export') { mods.export[iv.good] = iv.factor; events.push({ tick, ...iv }); }
    if (iv.type === 'cash')   { for (const a of agents) a.cash += iv.amount; events.push({ tick, ...iv }); }
  }

  function buyTool(a, tool) {
    const cost = P.TOOL_COST[tool];
    if (a.cash < cost || a.tools[tool]) return false;
    a.cash -= cost; builders += cost; spentOnTools += cost; a.tools[tool] = true;
    events.push({ tick, type: 'bought_tool', who: a.id, tool, cost });
    return true;
  }

  const money = () => agents.reduce((s, a) => s + a.cash, 0) + builders;

  return { P, agents, price, hist, step, buyTool, applyIntervention, events,
           get tick() { return tick; }, get builders() { return builders; }, money, GOODS, TOOL };
}
