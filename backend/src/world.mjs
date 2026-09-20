// The village, turn by turn: every round all agents decide, then everyone works a shift,
// eats, keeps warm, goods rot, and each round's orders clear on-chain.
// Goods changes are queued as deltas and settled on Solana each round; after every round
// the local view is replaced by what the chain says. The chain is the source of truth —
// this file is a fast mirror.
import { CFG, GOODS, FOOD, WOOD, NETS, BOATS, HOUSES } from './config.mjs';
import { BANK, PLEDGEABLE, FIRE_SALE_BPS, FORGIVE_BELOW, liquidatable, accruedDebt } from './chain.mjs';

const S1 = ['Ka', 'Lo', 'Mi', 'Ro', 'Te', 'Su', 'Na', 'Vi', 'Jo', 'Pe', 'Di', 'Ha', 'Ba', 'Fe', 'Gu', 'Ze'];
const S2 = ['ra', 'no', 'li', 'ko', 'sa', 'ta', 'vi', 'mo', 'ne', 'du', 'ri', 'la'];

// Gini coefficient of non-negative values: 0 = all equal, 1 = one holds everything.
export function gini(xs) {
  const v = [...xs].sort((a, b) => a - b), n = v.length, sum = v.reduce((s, x) => s + x, 0);
  return n && sum ? v.reduce((acc, x, i) => acc + (2 * (i + 1) - n - 1) * x, 0) / (n * sum) : 0;
}

export function createWorld(chain, initial, { onEvent = () => {} } = {}) {
  let seed = CFG.SEED;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  // Round a fractional amount up or down at random, so the expected value is exact.
  const roll = x => { const n = Math.floor(x); return n + (rnd() < x - n ? 1 : 0); };
  // Talents: every villager is strong at one job, middling at a second and poor at the third
  // (CFG.TALENT: a range for each). Which job is the strong one goes round the village in
  // turn from a random start, so a small village still has some of every trade; which of the
  // other two is the weak one is a coin toss. Totals differ a little, as people's do.
  const JOBS = ['gather_food', 'gather_wood', 'craft_net'], jobShift = Math.floor(rnd() * 3);
  const draw = ([lo, hi]) => +(lo + rnd() * (hi - lo)).toFixed(2);
  const talents = i => {
    const strong = (i + jobShift) % 3, rest = [0, 1, 2].filter(j => j !== strong), mid = rest[rnd() < 0.5 ? 0 : 1];
    return Object.fromEntries(JOBS.map((job, j) => [job, draw(j === strong ? CFG.TALENT.strong : j === mid ? CFG.TALENT.mid : CFG.TALENT.weak)]));
  };

  // Fixed prices for real GDP, in cents: the opening price of each good. A house opens at what
  // it takes to make (its wood plus its shifts of gathering), so START_PRICES is the whole
  // story; boats, at the chain's 1-cent minimum, are made by nothing and count for nothing.
  const REAL_PRICES = CFG.START_PRICES.map(p => p > 1 ? p : 0);
  const none = () => GOODS.map(() => 0);
  const list = q => q.map((n, g) => n ? `${n} ${n === 1 ? GOODS[g].replace(/s$/, '') : GOODS[g]}` : '').filter(Boolean).join(' and ');
  const agents = initial.slots.map((s, i) => ({
    id: i,
    name: `${S1[i % 16]}${S2[(i * 7 + 3) % 12]}-${i}`,
    cash: s.cash, goods: [...s.goods],              // mirror: chain + pending deltas
    chain: { cash: s.cash, goods: [...s.goods] },   // last confirmed on-chain state
    locked: none(), debt: 0, principal: 0, dueSlot: 0, accruedSlot: 0,   // the bank loan, mirrored from chain (debt as last accrued)
    dueRound: null,                                 // the round the loan is due at (the chain counts slots; see TERM_SLACK)
    activity: null,                               // this round's shift (kept after it's worked, for the dashboard)
    lastJob: null,                                  // last round's shift: kept when the agent doesn't answer in time
    orders: [],                                     // this round's orders: { agent, side, good, qty, limit, seq }; all expire when it clears
    draft: null,                                    // orders posted during the decision in progress; they become `orders` when it ends
    hunger: 0, cold: 0,
    lifestyle: CFG.LIFESTYLE_START,                 // food per meal, the agent's standing choice
    wellbeing: 0,                                   // total over the run: the goal, and the whole score
    wbParts: { eating: 0, warmth: 0, house: 0 },    // the same total, by source
    wbNow: { eating: 0, warmth: 0, house: 0 },      // the meal period in progress
    wbRecent: [],                                   // the last few meal periods, by source
    shifts: { gather_food: 0, gather_wood: 0, craft_net: 0, build_house: 0, idle: 0 },   // finished shifts, by kind (idle = not chosen)
    building: null,                                 // a house under construction: { done (progress, out of build_house.shifts), shifts worked, wood paid in so far } (it is already one of goods[HOUSES])
    housesBuilt: 0,
    fills: null,                                    // how the agent's orders did in the last round it traded in
    warmPhase: i % CFG.WARM_ROUNDS,
    thought: 'just arrived in the village',
    memory: [],
    traits: { patience: +rnd().toFixed(2), risk: +rnd().toFixed(2) },
    skills: talents(i),
    upkeepPaid: 0,                                  // houses whose upkeep wood was paid last round
    // The market stall: a standing sale plan per good, { keep, min } — every round whatever is
    // held above `keep` is offered at `min` (cents) or better, until the agent changes it.
    // Producers everywhere bring their goods to market without deciding to each morning.
    // `ask` is what the stall asks now: it starts at the going price, is marked down when nothing
    // sells and up when everything does (CFG.REPRICE), and never goes below `min`.
    sale: GOODS.map((_, g) => CFG.STALL[g] ? { keep: CFG.STALL[g].keep, min: Math.round(CFG.START_PRICES[g] * CFG.STALL[g].min), ask: CFG.START_PRICES[g] } : null),
    // The shopping list: a standing purchase plan per good, { target, max } — every round the
    // agent bids for whatever it holds short of `target`, at up to `max` (cents). Households buy
    // their necessities by habit, not by remembering to each morning.
    // `bid` is what it offers now: raised when it gets nothing, eased when it gets everything, never above `max`.
    shop: GOODS.map((_, g) => CFG.SHOP[g] ? { target: CFG.SHOP[g].target, max: Math.round(CFG.START_PRICES[g] * CFG.SHOP[g].max), bid: CFG.START_PRICES[g] } : null),
    decisions: 0,
  }));

  const W = {
    agents, tick: 0, round: 0,
    prices: [...initial.lastPrice],
    priceHistory: [], volumes: none(),
    pending: [], seq: 0,                             // seq: arrival order of orders, for price-time priority
    events: [], roundBusy: false, lastRound: null, lastBook: null, settlersSupply: null,
    lastLadder: null,                                // last round's book before clearing, per good (D6)
    bankSale: {},                                    // per good: the bank's descending sale of seized goods, { anchor, k }
    slotsPerRound: CFG.ROUND_MS_GUESS / CFG.SLOT_MS, roundMs: CFG.ROUND_MS_GUESS,   // measured every round
    loanOps: [], opsInflight: [],                    // borrow/repay requests for the next round / being sent now
    bankLog: [],                                     // every loan, repayment and foreclosure, for the dashboard
    slot: 0,                                         // the chain's clock, read every round
    bank: null,                                      // the bank's books, from the chain every round
    overdue: 0,                                      // foreclosures so far (the keeper only acts on overdue loans)
    autoRepaid: 0,                                   // overdue loans collected from the debtor's cash, no penalty
    housesBuilt: 0,                                  // houses finished so far
    made: none(), shiftsNow: { worked: 0, idle: 0 },  // this round's output and finished shifts (for GDP, employment)
    slotAt: Date.now(),                              // when W.slot was read
    roundSlot: initial.slot, roundAt: Date.now(),    // the chain's slot and the time when the last round ended
  };
  const bankView = L => ({ supply: L.supply, debtTotal: L.debtTotal, debtTotalNow: L.debtTotalNow, badDebt: L.badDebt, goods: [...L.bank.goods], cash: L.bank.cash, bankBook: [...L.bankBook],
    terms: L.terms, books: L.books, equity: L.equity, lendingCap: L.lendingCap, capitalRequired: L.capitalRequired });
  W.bank = bankView(initial);
  W.slot = initial.slot;

  const emit = (type, data) => {
    const e = { t: Date.now(), tick: W.tick, type, ...data };
    W.events.push(e); if (W.events.length > 300) W.events.shift();
    onEvent(e);
  };
  const remember = (a, line) => { a.memory.push(line); if (a.memory.length > 6) a.memory.shift(); };

  // ---- reservations: what an agent has promised to its orders -----------------
  // During a decision, the orders posted so far; after it, this round's orders.
  const ordersOf = a => a.draft ?? a.orders;
  // A bid for a house holds no cash back: nobody stops eating while they wait for a builder.
  // Houses clear last, on whatever cash is left by then (round() trims every bid to the cash there is).
  W.reservedCash = a => ordersOf(a).filter(o => o.side === 'buy' && o.good !== HOUSES).reduce((s, o) => s + o.qty * o.limit, 0);
  W.reservedGood = (a, g) => ordersOf(a).filter(o => o.side === 'sell' && o.good === g).reduce((s, o) => s + o.qty, 0);
  W.availCash = a => a.cash - W.reservedCash(a);
  W.availGood = (a, g) => a.goods[g] - W.reservedGood(a, g);

  const addDelta = (a, g, delta) => { W.pending.push({ agent: a.id, good: g, delta }); a.goods[g] += delta; };

  // Pledged goods stay usable (a lien, not a pawn shop): for USING a net or living in a
  // house, pledged units count. Selling, pledging and consuming use free goods only.
  W.owned = (a, g) => a.goods[g] + a.locked[g];
  W.usableNets = a => Math.max(0, W.availGood(a, NETS)) + a.locked[NETS];
  // An unfinished house is on-chain (one of goods or locked) but is not a home yet.
  W.unfinished = a => a.building ? 1 : 0;
  W.houses = a => Math.max(0, W.owned(a, HOUSES) - W.unfinished(a));   // finished houses owned, pledged ones too; several are worth having
  W.hasHouse = a => W.houses(a) >= 1;
  // What n houses pay a meal period: WELLBEING.HOUSE in order, its last figure repeating.
  // houseAdds: what the n-th house (1-based) adds on its own.
  const HWB = CFG.WELLBEING.HOUSE;
  W.houseAdds = n => HWB[Math.min(n, HWB.length) - 1];
  W.houseWB = n => { let s = 0; for (let i = 1; i <= n; i++) s += W.houseAdds(i); return s; };
  // What can be sold: free goods, less a house under construction. Pledged houses are
  // counted as the unfinished one first, so a free finished house stays sellable.
  const holdable = (a, g) => a.goods[g] - (g === HOUSES ? Math.max(0, W.unfinished(a) - a.locked[HOUSES]) : 0);
  W.sellable = (a, g) => holdable(a, g) - W.reservedGood(a, g);
  // A house costs the same wood for everyone: crafting skill buys speed (W.buildSkill), not
  // cheaper wood. Dividing it by skill was perverse — the agents with the wood are the ones
  // with the worst crafting, and they were quoted several times what the crafters were.
  W.houseWood = () => CFG.TASKS.build_house.wood;

  // ---- wellbeing: the goal ------------------------------------------------------
  const credit = (a, part, x) => { a.wellbeing += x; a.wbParts[part] += x; a.wbNow[part] += x; };
  // Fishing conditions, one multiplier. A function, not a constant: Phase 5 moves it mid-run.
  W.catch = () => CFG.CATCH;
  // Sell-through over the last few rounds: units sold of units offered, per good (1 when nothing was offered).
  W.recentSales = (g, rounds = 5) => {
    const h = W.priceHistory.slice(-rounds);
    return { sold: h.reduce((s, r) => s + (r.volumes[g] ?? 0), 0), offered: h.reduce((s, r) => s + (r.offered?.[g] ?? 0), 0) };
  };
  // Net worth: cash, plus every good held (pledged too) at its last price, minus debt with the
  // interest accrued to now. A house under construction counts as the wood in it. Cents.
  // It is no longer part of the score — only collateral, the standings and the metrics use it.
  W.wealth = a => a.cash - W.debtNow(a) + GOODS.reduce((s, _, g) => s + W.owned(a, g) * W.prices[g], 0) -
    (a.building ? W.prices[HOUSES] - a.building.wood * W.prices[WOOD] : 0);
  W.setLifestyle = (a, level) => {
    level = Math.round(Number(level));
    if (!(level >= 1 && level <= 3)) return 'Lifestyle must be 1, 2 or 3 (food per meal).';
    if (level !== a.lifestyle) emit('lifestyle', { agent: a.id, name: a.name, from: a.lifestyle, to: level });
    a.lifestyle = level;
    return null;
  };

  // What a unit would fetch now: if buyers went short last round, their best bid; else the last price.
  W.fetch = g => { const L = W.lastLadder?.[g]; return L && L.wanted > L.sold && L.bids.top[0] ? Math.max(L.bids.top[0][0], W.prices[g]) : W.prices[g]; };

  // ---- what a shift of each job is worth to an agent, in cents --------------------
  // `raw` is output at what buyers paid (or bid and didn't get); `sure` discounts it by how much of
  // what was offered lately actually sold — a price is only worth what sells at it. `can`: the
  // agent has the wood for it right now.
  W.through = g => { const r = W.recentSales(g, 3); return r.offered ? Math.min(1, r.sold / r.offered) : 1; };
  // A good that rots is worth what sells TODAY, so a thin market discounts it hard. A good that
  // keeps — a net, a house — is not worthless because it waits a few rounds for its buyer, so it
  // is discounted gently. At the food floor, 17% of nets selling made a 21.32 crafting shift read
  // as 6.22 and crafting fell below every other job: 63 nets were made in 82 rounds, none after
  // the first quarter, and with no new nets the village's output per shift stopped rising.
  W.sure = (x, g) => x > 0 ? x * (CFG.SPOIL[g] ? 0.15 + 0.85 * W.through(g) : 0.55 + 0.45 * W.through(g)) : x;
  W.jobValues = a => {
    const F = CFG.TASKS.gather_food, P = W.prices, wood = W.availGood(a, WOOD);
    const fish = (W.usableNets(a) ? F.netYield : F.yield) * W.skill(a, 'gather_food') * W.catch() * P[FOOD];
    const cut = CFG.TASKS.gather_wood.yield * W.skill(a, 'gather_wood') * P[WOOD];
    const craft = W.fetch(NETS) - W.netWood(a) * P[WOOD];
    const build = (W.fetch(HOUSES) - W.houseWood(a) * P[WOOD]) / W.buildShiftsFor(a);
    return [
      { task: 'gather_food', raw: fish, sure: W.sure(fish, FOOD), can: true },
      { task: 'gather_wood', raw: cut, sure: W.sure(cut, WOOD), can: true },
      { task: 'craft_net', raw: craft, sure: W.sure(craft, NETS), can: wood >= W.netWood(a), needs: W.netWood(a) },
      { task: 'build_house', raw: build, sure: W.sure(build, HOUSES), can: wood >= W.trancheWood(a), needs: W.trancheWood(a) },
    ];
  };
  // The trade an agent falls back on: the best-paying job it has the materials for.
  W.bestDoable = a => W.jobValues(a).filter(j => j.can).sort((x, y) => y.sure - x.sure)[0].task;
  // ---- skills: how good an agent is at each kind of work -----------------------
  W.skill = (a, task) => a.skills[task] ?? 1;
  // Crafting divides a wood bill rather than multiplying a yield, so the full skill range
  // would swing a net between 8 and 100 wood. Clamped, the spread is 4× either way.
  W.craftSkill = a => Math.min(CFG.CRAFT_CLAMP[1], Math.max(CFG.CRAFT_CLAMP[0], W.skill(a, 'craft_net')));
  W.netWood = a => Math.max(1, Math.round(CFG.TASKS.craft_net.wood / W.craftSkill(a)));
  // Crafting is the maker's skill for houses too: a build_house shift adds this much progress,
  // and a house needs build_house.shifts of it. The wood stays flat (see W.houseWood).
  const BUILD = CFG.TASKS.build_house.shifts;
  W.buildSkill = a => Math.min(CFG.BUILD_CLAMP[1], Math.max(CFG.BUILD_CLAMP[0], W.skill(a, 'craft_net')));
  W.buildShiftsFor = a => Math.ceil(BUILD / W.buildSkill(a));                  // a fresh house, whole shifts
  W.buildShiftsLeft = a => a.building ? Math.ceil((BUILD - a.building.done - 1e-9) / W.buildSkill(a)) : W.buildShiftsFor(a);
  // Building is paid for as it goes: the wood still owed is spread evenly over the shifts the
  // builder still needs (a 2.0 crafter pays 30 + 30, a 1.0 crafter 20 × 3), so a builder needs
  // one shift's materials to start, not all of them. Charging by progress instead asked a fast
  // builder for 40 wood up front, and crafters — who hold no wood — never got started.
  W.trancheWood = a => {
    const owed = W.buildWoodLeft(a), left = BUILD - (a.building?.done ?? 0), step = W.buildSkill(a);
    return Math.ceil(owed / Math.max(1, Math.ceil((left - 1e-9) / step)));
  };
  W.buildWoodLeft = a => W.houseWood(a) - (a.building?.wood ?? 0);   // wood the house in hand (or a fresh one) still takes
  // A good nobody has ever traded has no price: what agents are shown is what it costs to
  // make (nets, houses), never the opening price, which nobody paid.
  W.traded = g => W.priceHistory.some(r => r.volumes[g] > 0);

  // ---- what agents can do (called through tools.mjs) --------------------------
  // kept: the agent didn't decide in time and repeats its last job.
  W.startActivity = (a, task, { kept = false } = {}) => {
    const T = CFG.TASKS[task];
    if ((task === 'craft_net' || task === 'build_house') && !kept) {
      const wood = task === 'craft_net' ? W.netWood(a) : W.trancheWood(a), have = W.availGood(a, WOOD);
      if (have < wood) {
        a.materials = wood;                               // the shopping list orders it, the stall stops selling it
        const other = W.jobValues(a).filter(j => j.can).sort((x, y) => y.sure - x.sure)[0].task;
        W.startActivity(a, other);
        a.note = `You are ${wood - have} wood short for that (${wood} needed, ${have} free), so this shift you ${other === 'gather_wood' ? 'cut wood' : other === 'gather_food' ? 'fish' : 'work'} instead. ` +
          `Your shopping list now orders the wood and your stall holds it back; try again next round.`;
        return null;
      }
    }
    if (task === 'craft_net') {
      const wood = W.netWood(a);
      if (W.availGood(a, WOOD) < wood) return `You need ${wood} wood to craft a net; you have ${W.availGood(a, WOOD)} free.`;
      addDelta(a, WOOD, -wood); a.materials = 0;
    }
    if (task === 'build_house') {
      // every building shift uses its share of the wood; a new build's (unfinished) house exists from the next settle
      const wood = W.trancheWood(a);
      if (W.availGood(a, WOOD) < wood) return `This building shift uses ${wood} wood; you have ${W.availGood(a, WOOD)} free. Cut or buy ${wood - W.availGood(a, WOOD)} more (set_buy wood with a higher target gets it for you).`;
      if (!a.building) { addDelta(a, HOUSES, 1); a.building = { done: 0, shifts: 0, wood: 0 }; emit('build_start', { agent: a.id, name: a.name, wood }); }
      addDelta(a, WOOD, -wood); a.materials = 0;
      a.building.wood += wood;
    }
    a.activity = { task, place: T.place, ...(kept ? { kept } : {}) };
    emit('activity', { agent: a.id, name: a.name, task, ...(kept ? { kept } : {}) });
    return null;
  };
  // No decision in time (or no shift chosen): the agent keeps its last job if it still can.
  W.keepJob = a => {
    // No shift chosen: nobody stands in the square all day — they work their trade, the
    // best-paying job they have the materials for.
    if (W.startActivity(a, W.bestDoable(a), { kept: true })) W.startActivity(a, 'idle', { kept: true });
  };

  // ---- a decision: the orders it posts are the agent's orders for this round -------
  W.beginDecision = a => {
    a.draft = [];
    a.lastJob = a.activity;
    a.activity = null;
  };
  // ok: the agent answered in time. Otherwise it has no orders this round.
  // Then the stall: for every good with a sale plan and no sell order of the agent's own this
  // round, what is held above the reserve is offered at the plan's minimum — answered or not.
  W.endDecision = (a, ok) => {
    a.orders = ok ? a.draft : []; a.draft = null;
    a.sale.forEach((plan, g) => {
      if (!plan || a.orders.some(o => o.good === g && o.side === 'sell')) return;
      const bids = a.orders.filter(o => o.good === g && o.side === 'buy');
      if (bids.some(o => o.limit >= plan.ask)) return;   // never trade with yourself
      const need = g !== WOOD ? 0 : a.building ? W.buildWoodLeft(a) : a.materials ?? 0;
      const qty = Math.floor(W.sellable(a, g) - plan.keep - need);
      if (qty < 1) return;
      const o = { agent: a.id, side: 'sell', good: g, qty, limit: plan.ask, seq: ++W.seq, stall: true };
      a.orders.push(o);
      emit('order', { agent: a.id, name: a.name, side: 'sell', good: GOODS[g], qty, price: plan.ask, seq: o.seq, stall: true });
    });
  };
  // The shopping list, after the stall: bid for what is short of the target, as far as free cash goes.
  // (Food's target is never less than two meals at the agent's lifestyle.)
  const endStall = W.endDecision;
  W.endDecision = (a, ok) => {
    endStall(a, ok);
    a.shop.forEach((plan, g) => {
      if (!plan || a.orders.some(o => o.good === g)) return;          // the agent's own order for it, or its stall is selling it
      const target = g === FOOD ? Math.max(plan.target, 2 * a.lifestyle * CFG.MEAL)
        : g === WOOD ? plan.target + (a.building ? W.trancheWood(a) : a.materials ?? 0) : plan.target;   // a maker orders the next shift's materials
      const free = a.cash - a.orders.filter(o => o.side === 'buy' && o.good !== HOUSES).reduce((t, o) => t + o.qty * o.limit, 0);
      const qty = Math.min(target - W.owned(a, g), Math.floor(free / plan.bid));
      if (qty < 1) return;
      const o = { agent: a.id, side: 'buy', good: g, qty, limit: plan.bid, seq: ++W.seq, shop: true };
      a.orders.push(o);
      emit('order', { agent: a.id, name: a.name, side: 'buy', good: GOODS[g], qty, price: plan.bid, seq: o.seq, shop: true });
    });
  };
  W.setBuy = (a, g, target, max) => {
    target = Math.floor(Number(target)); max = Math.round(Number(max));
    if (g === HOUSES) return 'The shopping list is for food, wood and nets; bid for a house with place_order.';
    if (!(target >= 0) || !(max >= 1)) return 'target must be 0 or more and max_price positive.';
    a.shop[g] = target ? { target, max, bid: Math.min(max, a.shop[g]?.bid ?? W.prices[g]) } : null;
    emit('shop_plan', { agent: a.id, name: a.name, good: GOODS[g], target, max });
    return null;
  };
  W.setSale = (a, g, keep, min) => {
    keep = Math.floor(Number(keep)); min = Math.round(Number(min));
    if (!(keep >= 0) || !(min >= 1)) return 'keep must be 0 or more and min_price positive.';
    a.sale[g] = { keep, min, ask: Math.max(min, a.sale[g]?.ask ?? W.prices[g]) };
    emit('sale_plan', { agent: a.id, name: a.name, good: GOODS[g], keep, min });
    return null;
  };
  W.stopSale = (a, g) => { a.sale[g] = null; emit('sale_plan', { agent: a.id, name: a.name, good: GOODS[g], off: true }); return null; };

  W.placeOrder = (a, side, g, qty, limit, reason) => {
    qty = Math.floor(qty); limit = Math.round(limit);
    if (!a.draft) return 'This round has already run; nothing was done.';
    if (qty < 1 || limit < 1) return 'Quantity and price must be positive.';
    // no trading with yourself: a self-trade could print a price (the collateral price) in an empty book
    const cross = a.draft.find(o => o.good === g && o.side !== side && (side === 'buy' ? o.limit <= limit : o.limit >= limit));
    if (cross) return `That would cross your own ${cross.side} order for ${GOODS[g]} at ${(cross.limit / 100).toFixed(2)}: you can't trade with yourself.`;
    // a house bid beyond the agent's cash is posted at its cash: said in the reply (tools.mjs), not refused
    if (side === 'buy' && g === HOUSES) { qty = 1; limit = Math.min(limit, a.cash); if (limit < 1) return 'You have no coins to bid with.'; }
    if (side === 'buy' && g !== HOUSES && qty * limit > W.availCash(a))
      return `Not enough free cash: that order needs ${(qty * limit / 100).toFixed(2)}, you have ${(Math.max(0, W.availCash(a)) / 100).toFixed(2)} free — bid at most that in total.`;
    if (side === 'sell' && qty > W.sellable(a, g))
      return `You only have ${Math.max(0, W.sellable(a, g))} ${GOODS[g]} free to sell${g === HOUSES && a.building ? ' (a house under construction can\'t be sold)' : ''}.`;
    const seq = ++W.seq;
    a.draft.push({ agent: a.id, side, good: g, qty, limit, seq });
    emit('order', { agent: a.id, name: a.name, side, good: GOODS[g], qty, price: limit, seq, ...(reason ? { reason: String(reason).slice(0, 200) } : {}) });
    return null;
  };

  // ---- the bank: requests queue for the next round, where the chain decides ------
  // Interest accrues per slot on the principal (rateBps per ratePeriodSlots): the mirror
  // holds the debt as last accrued on-chain, and debtNow() adds what has accrued since,
  // at the chain's slot estimated from the last read.
  W.nowSlot = () => W.slot + Math.max(0, Math.floor((Date.now() - W.slotAt) / CFG.SLOT_MS));
  W.debtNow = (a, slot = W.nowSlot()) => accruedDebt(a, W.bank.terms, slot);
  W.slotsPerMin = () => Math.round(60_000 / CFG.SLOT_MS);
  W.ratePerMin = () => W.bank.terms.rateBps / 10_000 * W.slotsPerMin() / W.bank.terms.ratePeriodSlots;
  // Interest is charged by the slot, so what a round costs depends on how long rounds take: measured.
  W.ratePerRound = () => W.bank.terms.rateBps / 10_000 * W.slotsPerRound / W.bank.terms.ratePeriodSlots;
  W.termRounds = () => CFG.BANK.TERM_ROUNDS;
  W.termSlots = rounds => Math.min(65_535, Math.max(1, Math.floor(rounds * W.slotsPerRound * CFG.BANK.TERM_SLACK)));
  // The mirror moves at once (so an agent can spend a loan in the same breath), and is
  // replaced by what the chain actually did when the round settles.
  const applyLoan = (a, op) => {
    const now = W.nowSlot();
    a.debt = W.debtNow(a, now); a.accruedSlot = now;      // what the chain does first: accrue to now
    if (op.kind === 'borrow') {
      // a new loan's clock starts now (the chain's own due slot replaces this when it settles);
      // a top-up keeps its due slot
      if (!a.debt) { a.dueSlot = now + op.termSlots; a.dueRound = op.dueRound; }
      a.cash += op.amount; a.debt += op.amount; a.principal += op.amount;
      op.collateral.forEach((q, g) => { a.goods[g] -= q; a.locked[g] += q; });
    } else {
      // interest first, then principal. The collateral stays locked here until the chain
      // releases it: freeing it early let agents burn or sell goods the chain still held.
      const paid = Math.min(op.amount, a.debt), interest = Math.min(paid, a.debt - a.principal);
      a.cash -= paid; a.debt -= paid; a.principal -= paid - interest;
      if (a.debt < FORGIVE_BELOW) { a.debt = 0; a.principal = 0; }
    }
  };
  W.collateralValue = locked => locked.reduce((s, q, g) => s + q * W.prices[g], 0);
  // What an agent could pledge right now. A house under construction is worth nothing and
  // can't be sold, so the bank doesn't take one: only finished, unreserved houses count.
  W.pledgeable = (a, g) => PLEDGEABLE[g] ? Math.max(0, g === HOUSES ? W.sellable(a, g) : W.availGood(a, g)) : 0;
  W.freePledge = a => GOODS.map((_, g) => W.pledgeable(a, g));
  // What the bank may still lend anyone: its capital caps all loans at equity / kappa
  // (the chain's lendingCap, against debt as last accrued). Loans asked for but not yet on-chain count too.
  W.bankCommitted = () => W.bank.debtTotal +
    [...W.opsInflight, ...W.loanOps].filter(o => o.kind === 'borrow').reduce((s, o) => s + o.amount, 0);
  W.bankRoom = () => Math.max(0, W.bank.lendingCap - W.bankCommitted());
  // new coins the bank would lend on top of what's owed: the collateral limit, and the bank's
  // capital. The debt is taken as it will be when the request lands: after the decisions, at settlement.
  const SOON = Math.ceil((CFG.DECIDE_TIMEOUT_MS + 2000) / CFG.SLOT_MS);
  W.loanLimits = (a, extra = none()) => {
    const value = W.collateralValue((a.debt > 0 ? a.locked : none()).map((q, g) => q + extra[g]));
    const owed = a.debt ? W.debtNow(a, W.nowSlot() + SOON) : 0;
    return { collateral: Math.max(0, Math.floor(value * W.bank.terms.ltvBps / 10_000) - owed), bank: W.bankRoom() };
  };
  W.maxLoan = (a, extra) => { const l = W.loanLimits(a, extra); return Math.min(l.collateral, l.bank); };
  W.requestBorrow = (a, amount, collateral) => {
    amount = Math.round(amount);
    const t = W.bank.terms, termRounds = W.termRounds();
    if (amount < 1) return 'Borrow a positive amount.';
    if (!t.ltvBps) return 'The bank is not lending: credit is switched off.';
    if (a.debt && (W.nowSlot() > a.dueSlot || (a.dueRound && W.round + 1 >= a.dueRound)))
      return 'Your loan is due: it can\'t be topped up, only repaid or collected.';
    if (collateral.some((q, g) => q && !PLEDGEABLE[g])) return `The bank does not take ${GOODS.filter((_, g) => collateral[g] && !PLEDGEABLE[g]).join(' or ')} as collateral${collateral[FOOD] ? ' (food rots)' : ''}.`;
    for (let g = 0; g < GOODS.length; g++) if (collateral[g] > W.pledgeable(a, g))
      return `You only have ${W.pledgeable(a, g)} ${GOODS[g]} free to pledge` +
        (g === HOUSES && a.building ? ' (a house under construction can\'t be pledged).' : '.');
    const lim = W.loanLimits(a, collateral);
    if (amount > lim.collateral) return `Not enough collateral: that pledge lets you borrow at most ${(lim.collateral / 100).toFixed(2)}.`;
    if (amount > lim.bank) return `The bank cannot lend that much: its capital (${(W.bank.equity / 100).toFixed(2)}) lets it lend ` +
      `at most ${(W.bank.lendingCap / 100).toFixed(2)} in all, and ${(W.bankCommitted() / 100).toFixed(2)} is already owed or requested. ` +
      `It can lend you at most ${(lim.bank / 100).toFixed(2)} right now.`;
    // a top-up keeps its due slot on-chain, whatever term is sent; send the shortest
    const op = { kind: 'borrow', agent: a.id, amount, termSlots: a.debt ? 1 : W.termSlots(termRounds), collateral,
                 topUp: !!a.debt, ...(a.debt ? {} : { termRounds, dueRound: W.round + 1 + termRounds }) };
    W.loanOps.push(op); applyLoan(a, op);
    emit('borrow', { agent: a.id, name: a.name, amount, term: op.topUp ? null : termRounds, termSlots: op.termSlots, collateral });
    return null;
  };
  W.requestRepay = (a, amount) => {
    const owed = W.debtNow(a);
    if (!a.debt) return 'You have no loan to repay.';
    const paid = Math.min(Math.round(amount), owed, W.availCash(a));
    if (paid < 1) return 'You have no free cash to repay with.';
    // repaying "everything" pays what will have accrued by the time it lands, if the cash allows
    const all = paid >= owed ? Math.min(W.availCash(a), W.debtNow(a, W.nowSlot() + SOON)) : paid;
    const op = { kind: 'repay', agent: a.id, amount: all };
    W.loanOps.push(op); applyLoan(a, op);
    emit('repay', { agent: a.id, name: a.name, amount: all });
    return null;
  };
  // Rounds left before the loan is collected, counting the coming one (0 = overdue).
  W.roundsUntilDue = a => a.debt && a.dueRound ? Math.max(0, a.dueRound - W.round) : null;

  // ---- a round's work, meals, fires and rot ----------------------------------------
  // One round's work: the shift the agent chose.
  function finish(a) {
    const { task } = a.activity;
    const T = CFG.TASKS[task];
    if (task === 'gather_food') {
      // a pledged net fishes too; only a free one can tear (the chain holds the pledged one)
      const hasNet = W.usableNets(a) > 0, atRisk = Math.max(0, W.availGood(a, NETS));
      const got = roll((hasNet ? T.netYield : T.yield) * W.skill(a, task) * W.catch());
      W.made[FOOD] += got; addDelta(a, FOOD, got);
      if (hasNet && atRisk > 0 && rnd() < CFG.NET_WEAR) { addDelta(a, NETS, -1); remember(a, 'One of your nets tore and is gone.'); }
      remember(a, `You caught ${got} food${hasNet ? ' using your net' : ''}.`);
    } else if (task === 'gather_wood') {
      const got = roll(T.yield * W.skill(a, task));
      addDelta(a, WOOD, got); W.made[WOOD] += got;
      remember(a, `You cut ${got} wood.`);
    } else if (task === 'craft_net') {
      addDelta(a, NETS, 1); W.made[NETS]++;               // its wood went in when the shift began
      remember(a, 'You finished crafting a net.');
    } else if (task === 'build_house') {
      // the house may have been seized or sold (as unfinished it can't be) since the shift began
      // the shift's wood was taken when it began
      if (a.building) {
        a.building.done += W.buildSkill(a); a.building.shifts++;
        if (a.building.done >= BUILD - 1e-9) {
          const shifts = a.building.shifts;
          a.building = null; a.housesBuilt++; W.housesBuilt++; W.made[HOUSES]++;
          remember(a, `You finished building a house. You now own ${W.houses(a)}.`);
          emit('house_built', { agent: a.id, name: a.name, shifts });
        } else remember(a, `You worked on your house: ${W.buildShiftsLeft(a)} more building shift${W.buildShiftsLeft(a) === 1 ? '' : 's'} to go.`);
      }
    }
    a.shifts[task] = (a.shifts[task] ?? 0) + 1;
    W.shiftsNow[task === 'idle' ? 'idle' : 'worked']++;
    // Learning by doing: a shift worked makes the agent a little better at that job, up to
    // LEARN_CAP times the skill it was born with. Building is crafting work, and build_house is
    // not a skill of its own: it trains craft_net.
    const learn = task === 'build_house' ? 'craft_net' : task;
    if (CFG.LEARN && a.skills[learn] != null) {
      a.skills0 ??= { ...a.skills };
      a.skills[learn] = Math.min(a.skills0[learn] * CFG.LEARN_CAP, a.skills[learn] * (1 + CFG.LEARN));
    }
  }

  // A meal: eat what the lifestyle calls for, or whatever there is, and count the meal
  // period's wellbeing — the food, the fire, the houses. Part of a helping counts in
  // proportion (wellbeing is read off WB.EAT along a straight line between whole helpings):
  // when meals had to be whole, 70% of hungry agent-rounds had 1-4 food in the larder and
  // got nothing for it. Less than one full helping still counts as going hungry. Food
  // committed to a sale is eaten too (the agent's asks shrink): asking high doesn't keep
  // food from the table.
  function eat(a) {
    const WB = CFG.WELLBEING;
    const ate = Math.max(0, Math.min(a.lifestyle * CFG.MEAL, a.goods[FOOD]));
    const n = ate / CFG.MEAL, lo = Math.floor(n), hi = Math.ceil(n);
    if (ate) addDelta(a, FOOD, -ate);
    if (n >= 1) a.hunger = 0;
    else { a.hunger++; if (a.hunger === 1 || a.hunger % 3 === 0) remember(a, `You went hungry (${a.hunger} meal${a.hunger > 1 ? 's' : ''} short of a full helping).`); }
    credit(a, 'eating', WB.EAT[lo] + (n - lo) * (WB.EAT[hi] - WB.EAT[lo]));
    credit(a, 'warmth', a.cold ? WB.COLD : WB.WARM);
    // Upkeep: every house owned wants HOUSE_UPKEEP wood a round. Unpaid, it still stands —
    // it just pays nothing this round. The fire comes first: warmth is worth more than a
    // spare house, so upkeep only spends wood beyond one fire's worth.
    const own = W.houses(a);
    const spare = Math.max(0, a.goods[WOOD] - CFG.FIRE_WOOD);
    a.upkeepPaid = Math.min(own, Math.floor(spare / CFG.HOUSE_UPKEEP));
    if (a.upkeepPaid) addDelta(a, WOOD, -a.upkeepPaid * CFG.HOUSE_UPKEEP);
    if (a.upkeepPaid < own && !a.neglect) remember(a, `You had no wood for the upkeep of ${own - a.upkeepPaid} of your ${own} house${own > 1 ? 's' : ''}: ` +
      `${own - a.upkeepPaid === 1 ? 'it gave' : 'they gave'} you nothing this round.`);
    a.neglect = a.upkeepPaid < own;
    credit(a, 'house', W.houseWB(a.upkeepPaid));
    a.wbRecent.push({ tick: W.tick, ate: n, ...a.wbNow });
    if (a.wbRecent.length > 6) a.wbRecent.shift();
    a.wbNow = { eating: 0, warmth: 0, house: 0 };
  }

  // Wood's second use: a fire. Like food, it's used up, so wood always has buyers.
  function warm(a) {
    if (a.goods[WOOD] >= CFG.FIRE_WOOD) { addDelta(a, WOOD, -CFG.FIRE_WOOD); a.cold = 0; }
    else { a.cold++; if (a.cold === 1 || a.cold % 3 === 0) remember(a, `You had no wood for your fire and went cold (${a.cold} time${a.cold > 1 ? 's' : ''}).`); }
  }

  // Goods rot; coins don't. Goods committed to a sale rot too (pledged ones don't: the
  // chain holds them), so an ask nobody takes is no shelter.
  W.spoiled = none();
  function spoil() {
    for (const a of agents) for (let g = 0; g < GOODS.length; g++) {
      const rate = CFG.SPOIL[g], free = a.goods[g];
      if (!rate || free <= 0) continue;
      const n = roll(free * rate);
      if (n > 0) {
        addDelta(a, g, -n); W.spoiled[g] += n;
        (a.rotted ??= none())[g] += n;           // shown once in the next observation, not in memory
      }
    }
  }

  // One round, after every agent has decided (or timed out): the shift each chose, a meal,
  // fires, rot, then the market. Nothing else moves while it settles on-chain.
  // decide: how the decisions went (the slowest answer is how long the round waited).
  W.playRound = async (decide = null) => {
    W.tick = W.round + 1;
    for (const a of agents) {
      if (!a.activity) W.keepJob(a);
      finish(a);
      eat(a);
      if ((W.tick + a.warmPhase) % CFG.WARM_ROUNDS === 0) warm(a);
    }
    spoil();
    await W.runRound(decide);
  };

  // ---- a market round: settle deltas, loans, the keeper, one auction per good, read the chain back
  // Whatever fails, the round ends (roundBusy is always released) and the next one starts from the chain.
  W.runRound = async (decide = null) => {
    if (W.roundBusy) { emit('round_skipped', {}); return; }
    W.roundBusy = true;
    try { await round(decide); }
    catch (e) { emit('error', { message: e.message }); }
    finally { W.opsInflight = []; W.roundBusy = false; }
  };

  // The clearing the chain does (lib.rs clear_auction), replayed: the walk, the price
  // (the midpoint of the last matched bid and ask, rounded down), and each order's fill,
  // filled greedily in the order sent. Orders: { qty, limit }, bids desc and asks asc.
  W.replayClear = (bids, asks, last) => {
    let i = 0, j = 0, br = bids[0]?.qty ?? 0, ar = asks[0]?.qty ?? 0, volume = 0, lb = 0, la = 0;
    while (i < bids.length && j < asks.length && bids[i].limit >= asks[j].limit) {
      const q = Math.min(br, ar);
      volume += q; lb = bids[i].limit; la = asks[j].limit; br -= q; ar -= q;
      if (!br && ++i < bids.length) br = bids[i].qty;
      if (!ar && ++j < asks.length) ar = asks[j].qty;
    }
    const fill = side => { let rem = volume; return side.map(o => { const q = Math.min(o.qty, rem); rem -= q; return q; }); };
    if (!volume) return { volume, price: last, bidFills: bids.map(() => 0), askFills: asks.map(() => 0) };
    return { volume, price: Math.max(1, Math.floor((lb + la) / 2)), bidFills: fill(bids), askFills: fill(asks) };
  };

  // Last round's book before clearing, per good: the top levels each side, what's beyond them.
  const LEVELS = 3;
  const levels = side => {
    const out = [];
    for (const o of side) { if (out.at(-1)?.[0] === o.limit) out.at(-1)[1] += o.qty; else out.push([o.limit, o.qty]); }
    return { top: out.slice(0, LEVELS), more: Math.max(0, out.length - LEVELS), count: out.length };
  };

  // The bank's sale of seized goods: from the higher of its anchor and the price before the
  // seizure, 5% lower each round nothing sells, never below what it has them on its books at.
  // It never re-anchors on its own prints. Returns the price it asks at, or null.
  W.bankAsk = (g, held = W.bank.goods[g], book = W.bank.bankBook?.[g] ?? 0) => {
    if (!held) return null;
    const st = W.bankSale[g] ??= { anchor: W.prices[g], k: 0 };
    const floor = Math.ceil(book / held);
    return { price: Math.max(1, floor, Math.round(st.anchor * (1 - CFG.BANK_SALE_STEP * st.k))), floor, qty: held };
  };

  async function round(decide) {
    const t0 = Date.now();
    const batch = W.pending; W.pending = [];
    // the book: the orders every agent posted this round
    const book = GOODS.map((_, g) => agents.flatMap(a => a.orders.filter(o => o.good === g)));
    const live = agents.filter(a => a.orders.length).length;
    for (const o of book.flat()) { o.sentQty = 0; o.filled = 0; }
    const ops = W.loanOps; W.loanOps = []; W.opsInflight = ops;
    const made = W.made, shifts = W.shiftsNow;
    W.made = none(); W.shiftsNow = { worked: 0, idle: 0 };
    const sigs = [], liquidated = [];
    let settled = batch.length ? null : none();   // net goods settled per good (null if the settle failed)
    // On-chain balances right before the auctions: every change after them is a fill. Stays
    // null if the round fails before the auctions, and then no fills are reported.
    let base = null, bankGoods = null;

    // askQty/bidQty: what villagers offered and wanted; bankQty: the bank's foreclosure
    // sale (set below); sold: units that changed hands (set after the round)
    const bookStats = GOODS.map((_, g) => {
      const b = book[g].filter(o => o.side === 'buy'), s = book[g].filter(o => o.side === 'sell');
      return { bids: b.length, bidQty: b.reduce((t, o) => t + o.qty, 0), asks: s.length, askQty: s.reduce((t, o) => t + o.qty, 0),
               bestBid: Math.max(0, ...b.map(o => o.limit)), bestAsk: s.length ? Math.min(...s.map(o => o.limit)) : null,
               bankQty: 0, bankPrice: null, sold: 0 };
    });
    // what went to each good's auction, and how it went (for the ladder, fills and remainders)
    const sent = GOODS.map(() => ({ bids: [], asks: [], ok: false, last: 0 }));
    const spoiled = W.spoiled; W.spoiled = none();

    try {
      // Should never fail: the mirror never shows more than the chain holds. If it does,
      // this round's goods changes are lost, but loans, the keeper and the auction go on.
      if (batch.length) {
        try {
          sigs.push(...await chain.settle(batch));
          settled = none(); for (const d of batch) settled[d.good] += d.delta;
        } catch (e) { emit('error', { message: `settle: ${e.message}` }); }
      }

      // loans — each agent's in the order asked, agents in parallel. The program has the final say.
      const byAgent = new Map();
      for (const op of ops) byAgent.set(op.agent, [...(byAgent.get(op.agent) ?? []), op]);
      const rate = `≈${+(W.ratePerRound() * 100).toFixed(2)}% a round`;
      await Promise.all([...byAgent.values()].map(async list => { for (const op of list) {
        const a = agents[op.agent];
        try {
          sigs.push(op.kind === 'borrow' ? await chain.borrow(op.agent, op.amount, op.termSlots, op.collateral) : await chain.repay(op.agent, op.amount));
          op.ok = true;
          if (op.kind === 'borrow' && !op.topUp) a.dueRound = op.dueRound;
          remember(a, op.kind === 'repay' ? `You repaid ${(op.amount / 100).toFixed(2)} of your loan (interest first).`
            : op.topUp ? `The bank added ${(op.amount / 100).toFixed(2)} new coins to your loan; it is due at the same round as before.`
            : `The bank lent you ${(op.amount / 100).toFixed(2)} new coins for ${op.termRounds} rounds (due at the end of round ${op.dueRound}). ` +
              `Interest: ${rate} on what you borrowed, charged for the time you hold it.`);
        } catch (e) {
          // the program's own reason, e.g. "the bank has reached its lending cap"
          const why = e.message.match(/Error Message: (.*)/)?.[1] ?? e.message.replace(/^chain tx failed: /, '');
          remember(a, `The bank refused your ${op.kind}: ${why.slice(0, 120)}`);
        }
      } }));

      // The keeper — a stranger with no authority over the ledger — calls `liquidate` on
      // every loan past its due slot. The chain decides what happens: an overdue loan whose
      // debtor has the cash is collected from it (no penalty); otherwise it's a foreclosure.
      // `liquidate` still permits margin calls on-chain, but the keeper never cites one:
      // a falling price is not a reason to seize a villager's goods (see CFG.BANK.MARGIN).
      let mid = await chain.fetch();
      W.slot = mid.slot; W.slotAt = Date.now();
      // An overdue loan is collected at the round it was promised for, not before: its
      // on-chain deadline was set a little early (TERM_SLACK) so that it has passed by then.
      await Promise.all(agents.map(async a => {
        const s = mid.slots[a.id], reason = liquidatable(s, mid, mid.slot);
        if (reason !== 'overdue' || (a.dueRound && W.round + 1 < a.dueRound)) return;
        try {
          const sig = await chain.liquidate(a.id); sigs.push(sig);
          liquidated.push({ agent: a.id, name: a.name, reason, before: s, sig });
        } catch (e) { emit('error', { message: `liquidate ${a.name}: ${e.message}` }); }
      }));
      const keeperSlot = mid.slot;
      if (liquidated.length || ops.length) mid = await chain.fetch();
      // What each call actually did, read off the chain.
      for (const f of liquidated) {
        const b = f.before, s = mid.slots[f.agent], a = agents[f.agent], T = mid.terms;
        f.returned = s.goods.map((q, g) => q - b.goods[g]);
        f.seized = b.locked.map((q, g) => q - f.returned[g]);
        // A collection takes exactly the debt accrued to the slot it landed at, and nothing else.
        const owedAt = t => accruedDebt(b, T, t);
        let landed = null;
        if (f.reason === 'overdue') for (let t = keeperSlot; t <= mid.slot && landed === null; t++)
          if (b.cash - owedAt(t) === s.cash) landed = t;
        const debt = owedAt(landed ?? mid.slot);
        f.debt = debt;
        if (landed !== null) {
          f.kind = 'collected'; f.taken = debt; f.interest = debt - b.principal;
          W.autoRepaid++;
          const back = list(f.returned);
          remember(a, `Your loan came due and the bank collected it from your cash: ${(debt / 100).toFixed(2)} ` +
            `(${(f.interest / 100).toFixed(2)} of it interest). No penalty${back ? `; your pledged ${back} ${f.returned.reduce((x, y) => x + y, 0) === 1 ? 'is' : 'are'} free again` : ''}.`);
        } else {
          // cash first; goods are seized only when it fell short, and then all of it was taken
          // and whatever the debtor holds now is the refund
          const seizedAny = f.seized.some(q => q > 0);
          f.kind = 'foreclosed';
          f.refund = seizedAny ? s.cash : 0;
          f.taken = b.cash - s.cash + f.refund;
          const penalty = Math.floor(debt * T.penaltyBps / 10_000);
          f.writtenOff = Math.max(0, b.principal - Math.max(0, f.taken - (debt - b.principal + penalty)));
          W.overdue++;
          const why = `FORECLOSED: your loan of ${(debt / 100).toFixed(2)} was overdue and your cash could not cover it.`;
          const seized = list(f.seized), back = list(f.returned);
          // the bank's sale of what it seized starts again from the price before the seizure
          f.seized.forEach((q, g) => { if (q > 0) W.bankSale[g] = { anchor: Math.max(W.bankSale[g]?.anchor ?? 0, W.prices[g]), k: 0 }; });
          remember(a, `${why} ${(f.taken / 100).toFixed(2)} of your coins went to the debt plus a ${T.penaltyBps / 100}% penalty` +
            (seized ? `; the bank seized ${seized}, valued at ${FIRE_SALE_BPS / 100}% of the last price` : '') +
            (f.refund ? `, and refunded you ${(f.refund / 100).toFixed(2)} (what that was worth beyond what you owed)` : '') +
            (back ? `; ${back} came back to you` : '') + '.');
          // a seized house is the unfinished one first (see W.sellable)
          if (a.building && f.seized[HOUSES] && b.locked[HOUSES] - f.seized[HOUSES] < W.unfinished(a)) {
            a.building = null;
            remember(a, 'The bank took your unfinished house, so that build is over.');
          }
        }
        delete f.before;
      }
      const txs = [];
      base = mid.slots.map(x => ({ cash: x.cash, goods: [...x.goods] }));
      bankGoods = [...mid.bank.goods];

      const cashLeft = base.map(e => e.cash);
      const goodsLeft = base.map(e => [...e.goods]);
      for (let g = 0; g < GOODS.length; g++) {
        // price-time priority: better price first, then the older order (never the agent's index)
        let asks = book[g].filter(o => o.side === 'sell').sort((x, y) => x.limit - y.limit || x.seq - y.seq);
        // the bank sells seized collateral, queued last at its price
        const bank = W.bankAsk(g, bankGoods[g], mid.bankBook[g]);
        if (bank) {
          bookStats[g].bankQty = bank.qty; bookStats[g].bankPrice = bank.price;
          asks.push({ agent: BANK, side: 'sell', good: g, qty: bank.qty, limit: bank.price, seq: Infinity });
          asks.sort((x, y) => x.limit - y.limit || x.seq - y.seq);
        }
        let bids = book[g].filter(o => o.side === 'buy').sort((x, y) => y.limit - x.limit || x.seq - y.seq);
        // one atomic transaction per good: trim to what fits first, so trimmed orders hold no cash or goods
        while (bids.length + asks.length > chain.MAX_ORDERS_PER_TX) (bids.length > asks.length ? bids : asks).pop();
        // then check against on-chain balances, so the auction can never revert
        const take = (o, q) => ({ agent: o.agent, qty: q, limit: o.limit, seq: o.seq, src: o });
        asks = asks.map(o => take(o, o.agent === BANK ? o.qty : Math.min(o.qty, goodsLeft[o.agent][g])))
          .filter(o => { if (o.qty < 1) return false; if (o.agent !== BANK) goodsLeft[o.agent][g] -= o.qty; return true; });
        bids = bids.map(o => take(o, Math.min(o.qty, Math.floor(cashLeft[o.agent] / o.limit))))
          .filter(o => { if (o.qty < 1) return false; cashLeft[o.agent] -= o.qty * o.limit; return true; });
        Object.assign(sent[g], { bids, asks, last: mid.lastPrice[g] });
        if (bids.length && asks.length) txs.push(chain.clear(g, bids, asks).then(sig => { sent[g].ok = true; return sig; }));
      }
      // Cash and goods were split between goods above, so the auctions can't conflict: send
      // them together instead of waiting on each confirmation in turn.
      for (const r of await Promise.allSettled(txs)) {
        if (r.status === 'fulfilled') { if (r.value) sigs.push(r.value); }
        else emit('error', { message: r.reason?.message ?? String(r.reason) });
      }
    } catch (e) {
      emit('error', { message: e.message });
    }

    // the chain is the truth — replace the mirror
    const L = await chain.fetch();
    // what the SETTLERS mint itself says exists. The program checks this against the
    // books inside every instruction that can move it, so this is a read, not a guard.
    W.settlersSupply = await chain.settlersSupply();
    W.slot = L.slot; W.slotAt = Date.now();
    const fills = none(), trades = [], dgs = [];
    if (base) for (let g = 0; g < GOODS.length; g++) fills[g] += Math.max(0, bankGoods[g] - L.bank.goods[g]);   // foreclosure sales
    for (const a of agents) {
      const after = L.slots[a.id];
      dgs[a.id] = base ? GOODS.map((_, g) => after.goods[g] - base[a.id].goods[g]) : none();
      for (let g = 0; g < GOODS.length; g++) {
        const dg = dgs[a.id][g];
        const at = (L.lastPrice[g] / 100).toFixed(2);
        if (dg > 0) { remember(a, `Market: you bought ${dg} ${GOODS[g]} at ${(L.lastPrice[g] / 100).toFixed(2)}.`); trades.push({ agent: a.id, good: GOODS[g], side: 'buy', qty: dg, price: L.lastPrice[g] }); }
        if (dg < 0) { remember(a, `Market: you sold ${-dg} ${GOODS[g]} at ${(L.lastPrice[g] / 100).toFixed(2)}.`); fills[g] += -dg; trades.push({ agent: a.id, good: GOODS[g], side: 'sell', qty: -dg, price: L.lastPrice[g] }); }
      }
    }
    for (let g = 0; g < GOODS.length; g++) bookStats[g].sold = fills[g];

    // Replay each good's clearing to know every order's fill (the chain reports only balances),
    // and check it against what the chain did.
    const got = agents.map(() => none()), ladder = [], orderLog = [], noBankPrice = none().map(() => null);
    for (let g = 0; g < GOODS.length; g++) {
      const S = sent[g], r = W.replayClear(S.ok ? S.bids : [], S.ok ? S.asks : [], S.last);
      if (S.ok && r.price !== L.lastPrice[g]) emit('error', { message: `replayed ${GOODS[g]} price ${r.price} but the chain printed ${L.lastPrice[g]}` });
      for (const [side, fl, sign] of [[S.bids, r.bidFills, 1], [S.asks, r.askFills, -1]]) side.forEach((o, k) => {
        o.filled = fl[k] ?? 0;
        if (o.agent !== BANK) { Object.assign(o.src, { sentQty: o.qty, filled: o.filled }); got[o.agent][g] += sign * o.filled; }
        orderLog.push({ g, side: sign > 0 ? 'buy' : 'sell', agent: o.agent === BANK ? 'bank' : o.agent, qty: o.qty, limit: o.limit,
                        seq: Number.isFinite(o.seq) ? o.seq : null, filled: o.filled });
      });
      // the D5 check: what the same book would have printed without the bank's sale
      if (bookStats[g].bankQty && S.ok) { const nb = W.replayClear(S.bids, S.asks.filter(o => o.agent !== BANK), S.last); noBankPrice[g] = nb.volume ? nb.price : null; }
      const qty = xs => xs.reduce((t, o) => t + o.qty, 0);
      ladder[g] = { asks: levels(S.asks), bids: levels(S.bids), price: L.lastPrice[g], sold: fills[g], offered: qty(S.asks), wanted: qty(S.bids) };
      // the bank's sale: nothing sold → 5% lower next round; some sold → same price; sold out → over
      if (base && bankGoods[g]) {
        if (!L.bank.goods[g]) delete W.bankSale[g];
        else if (bankGoods[g] === L.bank.goods[g] && W.bankSale[g]) W.bankSale[g].k++;
      }
    }
    if (base) for (const a of agents) for (let g = 0; g < GOODS.length; g++) if (got[a.id][g] !== dgs[a.id][g])
      emit('error', { message: `replayed fills for ${a.name} ${GOODS[g]}: ${got[a.id][g]}, chain: ${dgs[a.id][g]}` });
    W.lastLadder = ladder;

    for (const a of agents) {
      const after = L.slots[a.id];
      // How each of the agent's orders did. Then they expire: nothing stands into the next round.
      const lines = a.orders.map(o => {
        const n = GOODS[o.good], sell = o.side === 'sell', l = ladder[o.good];
        const head = `your ${o.stall ? 'stall\'s ' : o.shop ? 'shopping list\'s ' : ''}${o.qty} ${n} ${sell ? 'ask' : 'bid'} at ${(o.limit / 100).toFixed(2)}`;
        if (!o.sentQty) return `${head}: not sent — you no longer had the ${sell ? n : 'cash'}.`;
        return `${head}: ${o.sentQty < o.qty ? `only ${o.sentQty} sent, ` : ''}${o.filled} ${sell ? 'sold' : 'bought'}` +
          (o.filled ? ` at ${(l.price / 100).toFixed(2)}.` : ` — ${l.offered} were offered, ${l.wanted} wanted.`);
      });
      // Repricing by habit: a stall that sold nothing marks down, one that sold out marks up; a
      // shopping list that got nothing bids more, one that got everything bids a little less.
      const R = CFG.REPRICE, clamp = (x, lo, hi) => Math.round(Math.min(hi, Math.max(lo, x)));
      for (const o of a.orders) {
        if (!o.sentQty) continue;
        const none = !o.filled, all = o.filled >= o.sentQty;
        // ...but a stall prices off the going rate, not off its own last sticker: it may lead the
        // last traded price by REPRICE.band and no more. Compounding from its own quote, every
        // stall in a shortage marks up together round after round and the price runs away from
        // what the good is worth (see CFG.REPRICE). The shopping list needs no such leash: its
        // own `max` is the ceiling, and a floor under a bid would be a ratchet of the same kind.
        const cap = Math.max(1, Math.round(W.prices[o.good] * R.band));
        if (o.stall && a.sale[o.good]) { const pl = a.sale[o.good]; pl.ask = clamp(pl.ask * (none ? 1 - R.down : all ? 1 + R.up : 1), pl.min, Math.max(pl.min, cap)); }
        if (o.shop && a.shop[o.good]) { const pl = a.shop[o.good]; pl.bid = clamp(pl.bid * (none ? 1 + R.down : all ? 1 - R.up / 2 : 1), 1, pl.max); }
      }
      a.fills = lines.length ? { round: W.round + 1, lines } : null;
      a.orders = [];
      a.chain = { cash: after.cash, goods: [...after.goods] };
      a.cash = after.cash;
      a.goods = [...after.goods];
      a.locked = [...after.locked]; a.debt = after.debt; a.principal = after.principal;
      a.dueSlot = after.dueSlot; a.accruedSlot = after.accruedSlot;
      if (!after.debt) a.dueRound = null;
    }
    // re-apply what arrived mid-round
    for (const d of W.pending) agents[d.agent].goods[d.good] += d.delta;
    for (const op of W.loanOps) applyLoan(agents[op.agent], op);
    // a build whose house is gone (its start never settled) is over
    for (const a of agents) if (a.building && W.owned(a, HOUSES) < 1) {
      a.building = null; remember(a, 'Your unfinished house is gone, so that build is over.');
    }
    for (const o of ops) W.bankLog.push({ round: W.round + 1, kind: o.kind, name: agents[o.agent].name, amount: o.amount, ok: !!o.ok,
      ...(o.kind === 'borrow' ? { term: o.topUp ? null : o.termRounds } : {}) });
    for (const f of liquidated) W.bankLog.push({ round: W.round + 1, kind: f.kind, reason: f.reason, name: f.name,
      amount: f.taken, debt: f.debt, seized: f.seized, returned: f.returned, refund: f.refund ?? 0 });
    W.bank = bankView(L);

    W.prices = L.lastPrice; W.round++; W.volumes = fills; W.lastBook = bookStats;
    // how long a round takes (decisions included), in slots and ms: loan terms and interest per round use it
    const dSlots = L.slot - W.roundSlot, dMs = Date.now() - W.roundAt;
    W.slotsPerRound = W.round === 1 ? dSlots : 0.7 * W.slotsPerRound + 0.3 * dSlots;
    W.roundMs = W.round === 1 ? dMs : 0.7 * W.roundMs + 0.3 * dMs;
    W.roundSlot = L.slot; W.roundAt = Date.now();
    const m = metrics(L, fills, bookStats, made, shifts);
    const doing = Object.fromEntries(Object.keys(CFG.TASKS).map(k => [k, 0]));
    for (const a of agents) if (a.activity) doing[a.activity.task]++;
    W.priceHistory.push({ round: W.round, prices: [...L.lastPrice], volumes: [...fills],
      supply: L.supply, debt: L.debtTotalNow, badDebt: L.badDebt, doing,
      equity: L.equity, lendingCap: L.lendingCap, writtenOff: L.books.writtenOff,
      overdue: W.overdue, autoRepaid: W.autoRepaid,
      hungry: agents.filter(a => a.hunger > 0).length, cold: agents.filter(a => a.cold >= 2).length,
      held: GOODS.map((_, g) => agents.reduce((s, a) => s + a.goods[g], 0)),
      // sell-through (sold of offered, offered incl. the bank's fire sale), the goal
      offered: bookStats.map(b => b.askQty + b.bankQty), wanted: bookStats.map(b => b.bidQty), catch: W.catch(),
      wellbeing: m.wellbeing, lifestyle: agents.reduce((s, a) => s + a.lifestyle, 0) / agents.length, ...m });
    if (W.priceHistory.length > 1000) W.priceHistory.shift();
    W.lastRound = { round: W.round, ms: Date.now() - t0, txs: sigs.length, sigs, decide };
    const sum = f => L.slots.reduce((s, x) => s + f(x), 0);
    emit('round', { round: W.round, prices: L.lastPrice, volumes: fills, txs: sigs.length, ms: Date.now() - t0, sig: sigs.at(-1),
                    book: bookStats, ladder, orders: orderLog, live, noBankPrice, decide,
                    roundMs: dMs, slotsPerRound: dSlots, trades, spoiled, foreclosures: liquidated.filter(f => f.kind === 'foreclosed'),
                    collected: liquidated.filter(f => f.kind === 'collected'), made, metrics: m,
                    bank: { supply: L.supply, debtTotal: L.debtTotal, debtTotalNow: L.debtTotalNow, badDebt: L.badDebt, goods: L.bank.goods,
                            cash: L.bank.cash, bankBook: L.bankBook,
                            equity: L.equity, lendingCap: L.lendingCap, capitalRequired: L.capitalRequired, books: L.books,
                            // chain-side sums, so every round's invariants can be checked from the log
                            sumCash: sum(x => x.cash), sumDebt: sum(x => x.debt), sumPrincipal: sum(x => x.principal),
                            settlers: W.settlersSupply,
                            // every agent: principal ≤ debt, and no debt ⇒ no principal and nothing locked
                            slotsOk: L.slots.every(x => x.principal <= x.debt && (x.debt || (!x.principal && x.locked.every(q => !q)))),
                            goodsTotal: GOODS.map((_, g) => sum(x => x.goods[g] + x.locked[g]) + L.bank.goods[g]), settled,
                            loans: ops.map(o => ({ kind: o.kind, agent: o.agent, amount: o.amount, ok: !!o.ok,
                              ...(o.kind === 'borrow' ? { term: o.topUp ? null : o.termRounds, termSlots: o.termSlots, dueRound: o.dueRound,
                                                          collateral: o.collateral } : {}) })) },
                    catch: W.catch(),
                    agents: agents.map(a => ({ id: a.id, cash: a.cash, goods: a.goods, locked: a.locked, debt: a.debt, debtNow: W.debtNow(a),
                      hunger: a.hunger, cold: a.cold,
                      homes: W.houses(a),
                      activity: a.activity?.task ?? null, kept: !!a.activity?.kept, lifestyle: a.lifestyle,
                      building: a.building ? a.building.shifts : null, house: W.hasHouse(a), housesBuilt: a.housesBuilt,
                      wellbeing: +a.wellbeing.toFixed(2), wbParts: a.wbParts, wealth: Math.round(W.wealth(a)), shifts: a.shifts })) });
  }

  // ---- how the economy is doing, once a round ------------------------------------
  // GDP: everything produced this round (fish caught, wood cut, nets crafted, houses
  // finished) at this round's prices — gross output, so wood that went into a net or a
  // house is counted twice. Price index: the CFG.PRICE_BASKET at today's prices over the
  // same basket at START_PRICES; inflation is its change over INFLATION_ROUNDS.
  // Employment: finished shifts that were work, of all shifts (work or idle).
  // Slack: goods offered for sale this round that didn't sell, at this round's prices.
  // Gini: of net worth (W.wealth, negatives as 0). Credit: debt with interest accrued to now.
  const START_BASKET = CFG.PRICE_BASKET.reduce((s, w, g) => s + w * CFG.START_PRICES[g], 0);
  let wbBefore = 0;
  function metrics(L, fills, bookStats, made, shifts) {
    const p = L.lastPrice, n = agents.length;
    const gdp = made.reduce((s, q, g) => s + q * p[g], 0);
    // Real GDP: the same output at FIXED prices, so the chart shows what was made and not
    // what inflation did to its price tag (nominal GDP once rose tenfold on flat output).
    const realGdp = made.reduce((s, q, g) => s + q * REAL_PRICES[g], 0);
    const priceIndex = CFG.PRICE_BASKET.reduce((s, w, g) => s + w * p[g], 0) / START_BASKET;
    const then = W.priceHistory.at(-CFG.INFLATION_ROUNDS)?.priceIndex;
    const unsold = bookStats.map((b, g) => Math.max(0, b.askQty + b.bankQty - fills[g]));
    const offeredValue = bookStats.reduce((s, b, g) => s + (b.askQty + b.bankQty) * p[g], 0);
    const slack = unsold.reduce((s, q, g) => s + q * p[g], 0);
    const all = shifts.worked + shifts.idle;
    // sales against what was made: how much of output goes through the market
    const sales = fills.reduce((s, q, g) => s + q * p[g], 0);
    const wb = agents.reduce((s, a) => s + a.wellbeing, 0);
    const wbRound = (wb - wbBefore) / n; wbBefore = wb;
    return {
      made: [...made], gdp, realGdp, priceIndex: +priceIndex.toFixed(4), inflation: then ? +(priceIndex / then - 1).toFixed(4) : null,
      shifts: { ...shifts }, employment: all ? +(shifts.worked / all).toFixed(3) : null,
      sales,
      tradedShare: gdp ? +(sales / gdp).toFixed(3) : null,
      unsold, slack, slackShare: offeredValue ? +(slack / offeredValue).toFixed(3) : null,
      wellbeing: +(wb / n).toFixed(2), wbRound: +wbRound.toFixed(3),
      gini: +gini(agents.map(a => Math.max(0, W.wealth(a)))).toFixed(3),
      credit: L.debtTotalNow, money: L.supply,
      housesBuilt: W.housesBuilt, building: agents.filter(a => a.building).length, homeowners: agents.filter(a => W.hasHouse(a)).length,
      houses: agents.reduce((s, a) => s + W.houses(a), 0),   // finished houses owned: more than one per villager is the point
    };
  }

  W.emit = emit;
  W.remember = remember;
  return W;
}
