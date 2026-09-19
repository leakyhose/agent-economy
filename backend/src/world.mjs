// The village: a clock, agents doing timed work, eating, and an order book that
// the chain clears every round. Goods changes are queued as deltas and settled on
// Solana each round; after every round the local view is replaced by what the
// chain says. The chain is the source of truth — this file is a fast mirror.
import { CFG, GOODS, FOOD, WOOD, NETS } from './config.mjs';
import { BANK } from './chain.mjs';

const S1 = ['Ka', 'Lo', 'Mi', 'Ro', 'Te', 'Su', 'Na', 'Vi', 'Jo', 'Pe', 'Di', 'Ha', 'Ba', 'Fe', 'Gu', 'Ze'];
const S2 = ['ra', 'no', 'li', 'ko', 'sa', 'ta', 'vi', 'mo', 'ne', 'du', 'ri', 'la'];

export function createWorld(chain, initial, { onEvent = () => {} } = {}) {
  let seed = CFG.SEED;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  // Round a fractional amount up or down at random, so the expected value is exact.
  const roll = x => { const n = Math.floor(x); return n + (rnd() < x - n ? 1 : 0); };
  const [lo, hi] = CFG.SKILL_RANGE;
  const skill = () => +(lo + rnd() * (hi - lo)).toFixed(1);

  const agents = initial.slots.map((s, i) => ({
    id: i,
    name: `${S1[i % 16]}${S2[(i * 7 + 3) % 12]}-${i}`,
    cash: s.cash, goods: [...s.goods],              // mirror: chain + pending deltas
    chain: { cash: s.cash, goods: [...s.goods] },   // last confirmed on-chain state
    locked: [0, 0, 0], debt: 0, dueSlot: 0,         // the bank loan, mirrored from chain
    activity: null,
    hunger: 0, cold: 0,
    eatPhase: i % CFG.EAT_TICKS,
    warmPhase: (i * 3) % CFG.WARM_TICKS,
    thought: 'just arrived in the village',
    memory: [],
    traits: { patience: +rnd().toFixed(2), risk: +rnd().toFixed(2) },
    skills: { gather_food: skill(), gather_wood: skill(), craft_net: skill() },
    decisions: 0,
  }));

  const emptyBook = () => GOODS.map(() => []);
  const W = {
    agents, tick: 0, round: 0,
    prices: [...initial.lastPrice],
    priceHistory: [], volumes: [0, 0, 0],
    pending: [], book: emptyBook(), inflight: null,
    events: [], roundBusy: false, lastRound: null, lastBook: null,
    loanOps: [],                                     // borrow/repay requests for the next round
    bankLog: [],                                     // every loan, repayment and foreclosure, for the dashboard
    slot: 0,                                         // the chain's clock, read every round
    bank: { supply: initial.supply, debtTotal: 0, badDebt: 0, goods: [0, 0, 0], terms: initial.terms },
  };

  const emit = (type, data) => {
    const e = { t: Date.now(), tick: W.tick, type, ...data };
    W.events.push(e); if (W.events.length > 300) W.events.shift();
    onEvent(e);
  };
  const remember = (a, line) => { a.memory.push(line); if (a.memory.length > 6) a.memory.shift(); };

  // ---- reservations: what an agent has promised to open orders ----------------
  const ordersOf = (a) => [...W.book.flat(), ...(W.inflight?.flat() ?? [])].filter(o => o.agent === a.id);
  W.reservedCash = a => ordersOf(a).filter(o => o.side === 'buy').reduce((s, o) => s + o.qty * o.limit, 0);
  W.reservedGood = (a, g) => ordersOf(a).filter(o => o.side === 'sell' && o.good === g).reduce((s, o) => s + o.qty, 0);
  W.availCash = a => a.cash - W.reservedCash(a);
  W.availGood = (a, g) => a.goods[g] - W.reservedGood(a, g);

  const addDelta = (a, g, delta) => { W.pending.push({ agent: a.id, good: g, delta }); a.goods[g] += delta; };

  // ---- skills: how good an agent is at each kind of work -----------------------
  W.skill = (a, task) => a.skills[task] ?? 1;
  W.netWood = a => Math.max(1, Math.round(CFG.TASKS.craft_net.wood / W.skill(a, 'craft_net')));

  // ---- what agents can do (called through tools.mjs) --------------------------
  W.startActivity = (a, task) => {
    const T = CFG.TASKS[task];
    if (task === 'craft_net') {
      const wood = W.netWood(a);
      if (W.availGood(a, WOOD) < wood) return `You need ${wood} wood to craft a net; you have ${W.availGood(a, WOOD)} free.`;
      addDelta(a, WOOD, -wood);
    }
    a.activity = { task, endsAt: W.tick + T.ticks, place: T.place };
    emit('activity', { agent: a.id, name: a.name, task });
    return null;
  };

  // What an agent holds that could become cash, from real numbers: demand last round
  // and what the bank would lend against it.
  const cashSources = a => {
    const free = [0, W.availGood(a, WOOD), W.availGood(a, NETS)];
    const held = [WOOD, NETS].filter(g => free[g] > 0).map(g => {
      const b = W.lastBook?.[g];
      return `${free[g]} free ${GOODS[g]}` + (b ? `: last round ${b.bidQty} were wanted${b.bids ? ` at up to ${(b.bestBid / 100).toFixed(2)}` : ''}` : '');
    });
    if (!held.length) return ' (You hold no free wood or nets.)';
    return ` (You hold ${held.join('; ')}. Pledged, ${held.length > 1 ? 'they' : 'it'} would let you borrow up to ${(W.maxLoan(a, free) / 100).toFixed(2)}.)`;
  };
  W.placeOrder = (a, side, g, qty, limit) => {
    qty = Math.floor(qty); limit = Math.round(limit);
    if (qty < 1 || limit < 1) return 'Quantity and price must be positive.';
    if (side === 'buy' && qty * limit > W.availCash(a))
      return `Not enough free cash: that order needs ${(qty * limit / 100).toFixed(2)}, you have ${(W.availCash(a) / 100).toFixed(2)}.${cashSources(a)}`;
    if (side === 'sell' && qty > W.availGood(a, g))
      return `You only have ${W.availGood(a, g)} ${GOODS[g]} free to sell.`;
    W.book[g].push({ agent: a.id, side, good: g, qty, limit });
    emit('order', { agent: a.id, name: a.name, side, good: GOODS[g], qty, price: limit });
    return null;
  };

  // ---- the bank: requests queue for the next round, where the chain decides ------
  // The mirror moves at once (so an agent can spend a loan in the same breath), and is
  // replaced by what the chain actually did when the round settles.
  const applyLoan = (a, op) => {
    if (op.kind === 'borrow') {
      a.cash += op.amount; a.debt += op.owed;
      op.collateral.forEach((q, g) => { a.goods[g] -= q; a.locked[g] += q; });
    } else {
      a.cash -= op.amount; a.debt -= op.amount;
      if (a.debt <= 0) { a.locked.forEach((q, g) => { a.goods[g] += q; }); a.locked = [0, 0, 0]; }
    }
  };
  W.collateralValue = locked => locked.reduce((s, q, g) => s + q * W.prices[g], 0);
  W.maxLoan = (a, extra = [0, 0, 0]) => {           // new coins the bank would lend on top of what's owed
    const t = W.bank.terms, value = W.collateralValue(a.locked.map((q, g) => q + extra[g]));
    const room = Math.floor(value * t.ltvBps / 10_000) - a.debt;
    return Math.max(0, Math.floor(room / (1 + t.rateBps / 10_000)));
  };
  W.requestBorrow = (a, amount, collateral) => {
    amount = Math.round(amount);
    const t = W.bank.terms;
    if (amount < 1) return 'Borrow a positive amount.';
    if (collateral[FOOD]) return 'Food rots, so the bank will not take it as collateral. Pledge wood or nets.';
    for (let g = 0; g < 3; g++) if (collateral[g] > W.availGood(a, g))
      return `You only have ${W.availGood(a, g)} ${GOODS[g]} free to pledge.`;
    const max = W.maxLoan(a, collateral);
    if (amount > max) return `Not enough collateral: that pledge lets you borrow at most ${(max / 100).toFixed(2)}.`;
    const owed = amount + Math.floor(amount * t.rateBps / 10_000);
    if (W.bank.debtTotal + owed > t.debtCap) return 'The bank has reached its lending limit. Try again later.';
    const op = { kind: 'borrow', agent: a.id, amount, owed, collateral };
    W.loanOps.push(op); applyLoan(a, op);
    emit('borrow', { agent: a.id, name: a.name, amount, owed, collateral });
    return null;
  };
  W.requestRepay = (a, amount) => {
    const paid = Math.min(Math.round(amount), a.debt, W.availCash(a));
    if (!a.debt) return 'You have no loan to repay.';
    if (paid < 1) return 'You have no free cash to repay with.';
    const op = { kind: 'repay', agent: a.id, amount: paid };
    W.loanOps.push(op); applyLoan(a, op);
    emit('repay', { agent: a.id, name: a.name, amount: paid });
    return null;
  };
  W.secondsUntilDue = a => a.debt ? Math.round((a.dueSlot - W.slot) * CFG.SLOT_MS / 1000) : null;

  // ---- the clock -------------------------------------------------------------
  function finish(a) {
    const { task } = a.activity;
    const T = CFG.TASKS[task];
    const weak = (a.hunger >= 3 ? CFG.HUNGRY_PENALTY : 1) * (a.cold >= 2 ? CFG.COLD_PENALTY : 1);
    if (task === 'gather_food') {
      const hasNet = W.availGood(a, NETS) > 0;
      const got = roll((hasNet ? T.netYield : T.yield) * W.skill(a, task) * weak);
      addDelta(a, FOOD, got);
      remember(a, `You caught ${got} food${hasNet ? ' using your net' : ''}${weak < 1 ? ' (weakened by hunger or cold)' : ''}.`);
      if (hasNet && rnd() < CFG.NET_WEAR) { addDelta(a, NETS, -1); remember(a, 'Your net tore and is gone.'); }
    } else if (task === 'gather_wood') {
      const got = roll(T.yield * W.skill(a, task) * weak);
      addDelta(a, WOOD, got);
      remember(a, `You cut ${got} wood${weak < 1 ? ' (weakened by hunger or cold)' : ''}.`);
    } else if (task === 'craft_net') {
      addDelta(a, NETS, 1);
      remember(a, 'You finished crafting a net.');
    }
    a.activity = null;
  }

  function eat(a) {
    if (W.availGood(a, FOOD) >= 1) { addDelta(a, FOOD, -1); a.hunger = 0; }
    else { a.hunger++; if (a.hunger === 1 || a.hunger % 3 === 0) remember(a, `You went hungry (${a.hunger} missed meal${a.hunger > 1 ? 's' : ''}).`); }
  }

  // Wood's second use: a fire. Like food, it's used up, so wood always has buyers.
  function warm(a) {
    if (W.availGood(a, WOOD) >= 1) { addDelta(a, WOOD, -1); a.cold = 0; }
    else { a.cold++; if (a.cold === 1 || a.cold % 3 === 0) remember(a, `You had no wood for your fire and went cold (${a.cold} time${a.cold > 1 ? 's' : ''}).`); }
  }

  // Goods rot; coins don't. Only FREE stock rots — goods committed to a sale are
  // safe until the round clears.
  W.spoiled = [0, 0, 0];
  function spoil() {
    for (const a of agents) for (let g = 0; g < GOODS.length; g++) {
      const rate = CFG.SPOIL[g], free = W.availGood(a, g);
      if (!rate || free <= 0) continue;
      const n = roll(free * rate);
      if (n > 0) {
        addDelta(a, g, -n); W.spoiled[g] += n;
        (a.rotted ??= [0, 0, 0])[g] += n;           // shown once in the next observation, not in memory
      }
    }
  }

  W.step = () => {
    W.tick++;
    for (const a of agents) {
      if (a.activity && W.tick >= a.activity.endsAt) finish(a);
      if ((W.tick + a.eatPhase) % CFG.EAT_TICKS === 0) eat(a);
      if ((W.tick + a.warmPhase) % CFG.WARM_TICKS === 0) warm(a);
    }
    if (W.tick % CFG.ROUND_TICKS === 0) {
      spoil();
      W.runRound().catch(e => emit('error', { message: e.message }));
    }
  };

  // ---- a market round: settle deltas, clear three auctions, read the chain back
  W.runRound = async () => {
    if (W.roundBusy) { emit('round_skipped', {}); return; }
    W.roundBusy = true;
    const t0 = Date.now();
    const batch = W.pending; W.pending = [];
    const book = W.book; W.book = emptyBook(); W.inflight = book;
    const ops = W.loanOps; W.loanOps = [];
    const sigs = [], foreclosures = [];

    const bookStats = GOODS.map((_, g) => {
      const b = book[g].filter(o => o.side === 'buy'), s = book[g].filter(o => o.side === 'sell');
      return { bids: b.length, bidQty: b.reduce((t, o) => t + o.qty, 0), asks: s.length, askQty: s.reduce((t, o) => t + o.qty, 0),
               bestBid: Math.max(0, ...b.map(o => o.limit)), bestAsk: s.length ? Math.min(...s.map(o => o.limit)) : null };
    });
    const spoiled = W.spoiled; W.spoiled = [0, 0, 0];

    // what the chain WILL hold once this batch settles
    let exp = agents.map(a => ({ cash: a.chain.cash, goods: [...a.chain.goods] }));
    for (const d of batch) exp[d.agent].goods[d.good] += d.delta;
    let bankGoods = [...W.bank.goods];

    try {
      if (batch.length) sigs.push(...await chain.settle(batch));

      // loans — each agent's in the order asked, agents in parallel (one tx each, and
      // waiting on them one by one would outlast a round). The program has the final say.
      const byAgent = new Map();
      for (const op of ops) byAgent.set(op.agent, [...(byAgent.get(op.agent) ?? []), op]);
      await Promise.all([...byAgent.values()].map(async list => { for (const op of list) {
        const a = agents[op.agent];
        try {
          sigs.push(op.kind === 'borrow' ? await chain.borrow(op.agent, op.amount, op.collateral) : await chain.repay(op.agent, op.amount));
          remember(a, op.kind === 'borrow'
            ? `The bank lent you ${(op.amount / 100).toFixed(2)} new coins; you owe ${(op.owed / 100).toFixed(2)} more.`
            : `You repaid ${(op.amount / 100).toFixed(2)} of your loan.`);
        } catch (e) {
          remember(a, `The bank refused your ${op.kind}: ${e.message.replace(/^chain tx failed: /, '').slice(0, 100)}`);
        }
      } }));

      // Foreclosure. The keeper is a stranger with no authority over the ledger —
      // the chain itself decides whether the loan is overdue.
      W.slot = await chain.slot();
      let mid = await chain.fetch();
      await Promise.all(agents.map(async a => {
        const s = mid.slots[a.id];
        if (!s.debt || W.slot <= s.dueSlot) return;
        try {
          const sig = await chain.liquidate(a.id); sigs.push(sig);
          foreclosures.push({ agent: a.id, name: a.name, debt: s.debt, cash: s.cash, locked: s.locked, sig });
        } catch (e) { emit('error', { message: `liquidate ${a.name}: ${e.message}` }); }
      }));
      if (foreclosures.length || ops.length) mid = await chain.fetch();
      for (const f of foreclosures) {
        const s = mid.slots[f.agent], a = agents[f.agent];
        // same rule as the program: if cash can't cover debt + penalty, all collateral is seized
        const owed = f.debt + Math.floor(f.debt * mid.terms.penaltyBps / 10_000);
        f.burned = f.cash - s.cash; f.seized = f.cash < owed ? [...f.locked] : [0, 0, 0];
        remember(a, f.seized.some(q => q)
          ? `FORECLOSED: your loan was overdue. ${(f.burned / 100).toFixed(2)} of your coins were burned and the bank seized your ${f.seized.map((q, g) => q ? `${q} ${GOODS[g]}` : '').filter(Boolean).join(' and ')}.`
          : `Your loan was overdue: it was foreclosed and ${(f.burned / 100).toFixed(2)} coins (debt plus a ${Math.round(CFG.BANK.PENALTY * 100)}% penalty) were taken from your cash. Your collateral is back.`);
      }
      exp = mid.slots.map(x => ({ cash: x.cash, goods: [...x.goods] }));
      bankGoods = [...mid.bank.goods];

      const cashLeft = exp.map(e => e.cash);
      const goodsLeft = exp.map(e => [...e.goods]);
      for (let g = 0; g < GOODS.length; g++) {
        // validate against expected on-chain balances so the auction can never revert
        const asks = book[g].filter(o => o.side === 'sell')
          .sort((x, y) => x.limit - y.limit || x.agent - y.agent)
          .map(o => ({ ...o, qty: Math.min(o.qty, goodsLeft[o.agent][g]) }))
          .filter(o => { if (o.qty < 1) return false; goodsLeft[o.agent][g] -= o.qty; return true; });
        // the bank sells seized collateral at a foreclosure discount; the proceeds are burned
        if (bankGoods[g]) {
          asks.push({ agent: BANK, side: 'sell', good: g, qty: bankGoods[g], limit: Math.max(1, Math.round(W.prices[g] * 0.8)) });
          asks.sort((x, y) => x.limit - y.limit || x.agent - y.agent);
        }
        const bids = book[g].filter(o => o.side === 'buy')
          .sort((x, y) => y.limit - x.limit || x.agent - y.agent)
          .map(o => ({ ...o, qty: Math.min(o.qty, Math.floor(cashLeft[o.agent] / o.limit)) }))
          .filter(o => { if (o.qty < 1) return false; cashLeft[o.agent] -= o.qty * o.limit; return true; });
        // one atomic transaction per good — trim to what fits
        while (bids.length + asks.length > chain.MAX_ORDERS_PER_TX) (bids.length > asks.length ? bids : asks).pop();
        if (bids.length && asks.length) sigs.push(await chain.clear(g, bids, asks));
      }
    } catch (e) {
      emit('error', { message: e.message });
    }

    // the chain is the truth — replace the mirror
    const L = await chain.fetch();
    const fills = [0, 0, 0], trades = [];
    for (let g = 0; g < 3; g++) fills[g] += Math.max(0, bankGoods[g] - L.bank.goods[g]);   // foreclosure sales
    for (const a of agents) {
      const after = L.slots[a.id], e = exp[a.id];
      const cashDelta = after.cash - e.cash;
      for (let g = 0; g < 3; g++) {
        const dg = after.goods[g] - e.goods[g];
        if (dg > 0) { remember(a, `Market: you bought ${dg} ${GOODS[g]} at ${(L.lastPrice[g] / 100).toFixed(2)}.`); trades.push({ agent: a.id, good: GOODS[g], side: 'buy', qty: dg, price: L.lastPrice[g] }); }
        if (dg < 0) { remember(a, `Market: you sold ${-dg} ${GOODS[g]} at ${(L.lastPrice[g] / 100).toFixed(2)}.`); fills[g] += -dg; trades.push({ agent: a.id, good: GOODS[g], side: 'sell', qty: -dg, price: L.lastPrice[g] }); }
        // Orders that didn't fill just expire. Say so, with what the rest of the market
        // looked like — otherwise a seller never learns there was a glut at their price.
        const mine = book[g].filter(o => o.agent === a.id), st = bookStats[g];
        const unsold = mine.filter(o => o.side === 'sell').reduce((s, o) => s + o.qty, 0) - Math.max(0, -dg);
        const unbought = mine.filter(o => o.side === 'buy').reduce((s, o) => s + o.qty, 0) - Math.max(0, dg);
        if (unsold > 0) remember(a, `Market: ${unsold} of your ${GOODS[g]} did not sell and the order expired (${st.askQty} offered, ${st.bidQty} wanted${st.bids ? `, best bid ${(st.bestBid / 100).toFixed(2)}` : ''}).`);
        if (unbought > 0) remember(a, `Market: ${unbought} ${GOODS[g]} you wanted went unbought and the order expired (${st.askQty} offered${st.asks ? `, cheapest ${(st.bestAsk / 100).toFixed(2)}` : ''}, ${st.bidQty} wanted).`);
      }
      void cashDelta;
      a.chain = { cash: after.cash, goods: [...after.goods] };
      a.cash = after.cash;
      a.goods = [...after.goods];
      a.locked = [...after.locked]; a.debt = after.debt; a.dueSlot = after.dueSlot;
    }
    // re-apply what arrived mid-round
    for (const d of W.pending) agents[d.agent].goods[d.good] += d.delta;
    for (const op of W.loanOps) applyLoan(agents[op.agent], op);
    for (const o of ops) W.bankLog.push({ round: W.round + 1, kind: o.kind, name: agents[o.agent].name, amount: o.amount });
    for (const f of foreclosures) W.bankLog.push({ round: W.round + 1, kind: f.seized.some(q => q) ? 'seized' : 'foreclosed', name: f.name, amount: f.burned, seized: f.seized });
    W.bank = { supply: L.supply, debtTotal: L.debtTotal, badDebt: L.badDebt, goods: [...L.bank.goods], terms: L.terms };

    W.prices = L.lastPrice; W.round++; W.volumes = fills; W.lastBook = bookStats;
    const doing = { gather_food: 0, gather_wood: 0, craft_net: 0, idle: 0 };
    for (const a of agents) if (a.activity) doing[a.activity.task]++;
    W.priceHistory.push({ round: W.round, prices: [...L.lastPrice], volumes: [...fills],
      supply: L.supply, debt: L.debtTotal, badDebt: L.badDebt, doing,
      hungry: agents.filter(a => a.hunger > 0).length, cold: agents.filter(a => a.cold >= 2).length,
      held: [0, 1, 2].map(g => agents.reduce((s, a) => s + a.goods[g], 0)) });
    if (W.priceHistory.length > 1000) W.priceHistory.shift();
    W.inflight = null;
    W.lastRound = { round: W.round, ms: Date.now() - t0, txs: sigs.length, sigs };
    emit('round', { round: W.round, prices: L.lastPrice, volumes: fills, txs: sigs.length, ms: Date.now() - t0, sig: sigs.at(-1),
                    book: bookStats, trades, spoiled, foreclosures,
                    bank: { supply: L.supply, debtTotal: L.debtTotal, badDebt: L.badDebt, goods: L.bank.goods, loans: ops.map(o => ({ kind: o.kind, agent: o.agent, amount: o.amount })) },
                    agents: agents.map(a => ({ id: a.id, cash: a.cash, goods: a.goods, locked: a.locked, debt: a.debt, hunger: a.hunger, cold: a.cold, activity: a.activity?.task ?? null })) });
    W.roundBusy = false;
  };

  W.emit = emit;
  W.remember = remember;
  return W;
}
