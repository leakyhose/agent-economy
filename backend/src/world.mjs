// The village: a clock, agents doing timed work, eating, and an order book that
// the chain clears every round. Goods changes are queued as deltas and settled on
// Solana each round; after every round the local view is replaced by what the
// chain says. The chain is the source of truth — this file is a fast mirror.
import { CFG, GOODS, FOOD, WOOD, NETS } from './config.mjs';

const S1 = ['Ka', 'Lo', 'Mi', 'Ro', 'Te', 'Su', 'Na', 'Vi', 'Jo', 'Pe', 'Di', 'Ha', 'Ba', 'Fe', 'Gu', 'Ze'];
const S2 = ['ra', 'no', 'li', 'ko', 'sa', 'ta', 'vi', 'mo', 'ne', 'du', 'ri', 'la'];

export function createWorld(chain, initial, { onEvent = () => {} } = {}) {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  const agents = initial.slots.map((s, i) => ({
    id: i,
    name: `${S1[i % 16]}${S2[(i * 7 + 3) % 12]}-${i}`,
    cash: s.cash, goods: [...s.goods],              // mirror: chain + pending deltas
    chain: { cash: s.cash, goods: [...s.goods] },   // last confirmed on-chain state
    activity: null,
    hunger: 0,
    eatPhase: i % CFG.EAT_TICKS,
    thought: 'just arrived in the village',
    memory: [],
    traits: { patience: +rnd().toFixed(2), risk: +rnd().toFixed(2) },
    decisions: 0,
  }));

  const emptyBook = () => GOODS.map(() => []);
  const W = {
    agents, tick: 0, round: 0,
    prices: [...initial.lastPrice],
    priceHistory: [], volumes: [0, 0, 0],
    pending: [], book: emptyBook(), inflight: null,
    events: [], roundBusy: false, lastRound: null,
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

  // ---- what agents can do (called through tools.mjs) --------------------------
  W.startActivity = (a, task) => {
    const T = CFG.TASKS[task];
    if (task === 'craft_net') {
      if (W.availGood(a, WOOD) < T.wood) return `You need ${T.wood} wood to craft a net; you have ${W.availGood(a, WOOD)} free.`;
      addDelta(a, WOOD, -T.wood);
    }
    a.activity = { task, endsAt: W.tick + T.ticks, place: T.place };
    emit('activity', { agent: a.id, name: a.name, task });
    return null;
  };

  W.placeOrder = (a, side, g, qty, limit) => {
    qty = Math.floor(qty); limit = Math.round(limit);
    if (qty < 1 || limit < 1) return 'Quantity and price must be positive.';
    if (side === 'buy' && qty * limit > W.availCash(a))
      return `Not enough free cash: that order needs ${(qty * limit / 100).toFixed(2)}, you have ${(W.availCash(a) / 100).toFixed(2)}.`;
    if (side === 'sell' && qty > W.availGood(a, g))
      return `You only have ${W.availGood(a, g)} ${GOODS[g]} free to sell.`;
    W.book[g].push({ agent: a.id, side, good: g, qty, limit });
    emit('order', { agent: a.id, name: a.name, side, good: GOODS[g], qty, price: limit });
    return null;
  };

  // ---- the clock -------------------------------------------------------------
  function finish(a) {
    const { task } = a.activity;
    const T = CFG.TASKS[task];
    const weak = a.hunger >= 3 ? CFG.HUNGRY_PENALTY : 1;
    if (task === 'gather_food') {
      const hasNet = W.availGood(a, NETS) > 0;
      const got = Math.max(1, Math.round((hasNet ? T.netYield : T.yield) * weak));
      addDelta(a, FOOD, got);
      remember(a, `You caught ${got} food${hasNet ? ' using your net' : ''}${weak < 1 ? ' (weak with hunger)' : ''}.`);
      if (hasNet && rnd() < CFG.NET_WEAR) { addDelta(a, NETS, -1); remember(a, 'Your net tore and is gone.'); }
    } else if (task === 'gather_wood') {
      const got = Math.max(1, Math.round(T.yield * weak));
      addDelta(a, WOOD, got);
      remember(a, `You cut ${got} wood.`);
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

  // Goods rot; coins don't. Only FREE stock rots — goods committed to a sale are
  // safe until the round clears. Fractional rot rounds up or down at random, so the
  // expected loss is exact even for small piles.
  W.spoiled = [0, 0, 0];
  function spoil() {
    for (const a of agents) for (let g = 0; g < GOODS.length; g++) {
      const rate = CFG.SPOIL[g], free = W.availGood(a, g);
      if (!rate || free <= 0) continue;
      const x = free * rate; let n = Math.floor(x); if (rnd() < x - n) n++;
      if (n > 0) {
        addDelta(a, g, -n); W.spoiled[g] += n;
        if (g === FOOD) remember(a, `${n} of your food spoiled.`);
      }
    }
  }

  W.step = () => {
    W.tick++;
    for (const a of agents) {
      if (a.activity && W.tick >= a.activity.endsAt) finish(a);
      if ((W.tick + a.eatPhase) % CFG.EAT_TICKS === 0) eat(a);
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
    const sigs = [];

    const bookStats = GOODS.map((_, g) => {
      const b = book[g].filter(o => o.side === 'buy'), s = book[g].filter(o => o.side === 'sell');
      return { bids: b.length, bidQty: b.reduce((t, o) => t + o.qty, 0), asks: s.length, askQty: s.reduce((t, o) => t + o.qty, 0),
               bestBid: Math.max(0, ...b.map(o => o.limit)), bestAsk: s.length ? Math.min(...s.map(o => o.limit)) : null };
    });
    const spoiled = W.spoiled; W.spoiled = [0, 0, 0];

    // what the chain WILL hold once this batch settles
    const exp = agents.map(a => ({ cash: a.chain.cash, goods: [...a.chain.goods] }));
    for (const d of batch) exp[d.agent].goods[d.good] += d.delta;

    try {
      if (batch.length) sigs.push(...await chain.settle(batch));

      const cashLeft = exp.map(e => e.cash);
      const goodsLeft = exp.map(e => [...e.goods]);
      for (let g = 0; g < GOODS.length; g++) {
        // validate against expected on-chain balances so the auction can never revert
        const asks = book[g].filter(o => o.side === 'sell')
          .sort((x, y) => x.limit - y.limit || x.agent - y.agent)
          .map(o => ({ ...o, qty: Math.min(o.qty, goodsLeft[o.agent][g]) }))
          .filter(o => { if (o.qty < 1) return false; goodsLeft[o.agent][g] -= o.qty; return true; });
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
    for (const a of agents) {
      const after = L.slots[a.id], e = exp[a.id];
      const cashDelta = after.cash - e.cash;
      for (let g = 0; g < 3; g++) {
        const dg = after.goods[g] - e.goods[g];
        if (dg > 0) { remember(a, `Market: you bought ${dg} ${GOODS[g]} at ${(L.lastPrice[g] / 100).toFixed(2)}.`); trades.push({ agent: a.id, good: GOODS[g], side: 'buy', qty: dg, price: L.lastPrice[g] }); }
        if (dg < 0) { remember(a, `Market: you sold ${-dg} ${GOODS[g]} at ${(L.lastPrice[g] / 100).toFixed(2)}.`); fills[g] += -dg; trades.push({ agent: a.id, good: GOODS[g], side: 'sell', qty: -dg, price: L.lastPrice[g] }); }
      }
      void cashDelta;
      a.chain = { cash: after.cash, goods: [...after.goods] };
      a.cash = after.cash;
      a.goods = [...after.goods];
    }
    for (const d of W.pending) agents[d.agent].goods[d.good] += d.delta;   // re-apply what arrived mid-round

    W.prices = L.lastPrice; W.round++; W.volumes = fills;
    W.priceHistory.push({ round: W.round, prices: [...L.lastPrice], volumes: [...fills] });
    if (W.priceHistory.length > 200) W.priceHistory.shift();
    W.inflight = null;
    W.lastRound = { round: W.round, ms: Date.now() - t0, txs: sigs.length, sigs };
    emit('round', { round: W.round, prices: L.lastPrice, volumes: fills, txs: sigs.length, ms: Date.now() - t0, sig: sigs.at(-1),
                    book: bookStats, trades, spoiled,
                    agents: agents.map(a => ({ id: a.id, cash: a.cash, goods: a.goods, hunger: a.hunger, activity: a.activity?.task ?? null })) });
    W.roundBusy = false;
  };

  W.emit = emit;
  W.remember = remember;
  return W;
}
