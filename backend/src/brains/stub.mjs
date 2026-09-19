// PLACEHOLDER BRAIN. Free, instant, no API key. It acts through exactly the same
// tools the Claude brain uses, so the rest of the system can't tell them apart.
// It is deliberately simple — it exists to exercise the economy, not to be smart.

export function stubBrain() {
  let seed = 999;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  return {
    name: 'stub',
    stats: () => ({ calls: 0, cost: 0 }),
    async decide(a, t) {
      const v = t.view(), p = v.prices;
      const jitter = 0.9 + rnd() * 0.25;
      const sk = v.skills, crafter = sk.craft_net >= Math.max(sk.gather_food, sk.gather_wood);

      // lifestyle: eat more when food is plentiful or cash is, less when both are short
      const meals = (v.availCash / 100 / p.food + v.food) / v.meal;
      const want = meals > 40 ? 3 : meals > 15 ? 2 : 1;
      if (want !== v.lifestyle) t.exec('set_lifestyle', { level: want, reason: want > v.lifestyle ? 'I can afford to eat better' : 'food is getting tight' });
      const keepFood = 6 * want * v.meal;

      // sell what you don't need, asking less the less of it has been selling (what the prompt tells
      // LLM agents to do). Buyers bid a fixed 8% over, so a good nobody wants clears at about the
      // old price and one that sells out drifts up: the stub must not ratchet the index on its own.
      const shade = g => jitter * (0.92 + 0.16 * v.sellThrough[g]);
      if (v.food > keepFood) t.exec('place_order', { side: 'sell', good: 'food', quantity: v.food - keepFood, price: +(p.food * shade('food')).toFixed(2) });
      // patient villagers save wood for a house, and keep going until they have a few
      const wantsHouse = v.owned < 3 && v.building === null && a.traits.patience > 0.4;
      const woodNeed = 2 * v.fireWood + 3 * v.upkeep + (v.netsUsable && !crafter ? 0 : v.netWood) + (wantsHouse ? v.houseWood : 0);
      if (v.wood > woodNeed) t.exec('place_order', { side: 'sell', good: 'wood', quantity: v.wood - woodNeed, price: +(p.wood * shade('wood')).toFixed(2) });
      const keepNets = crafter ? 0 : 1;
      if (v.nets > keepNets) t.exec('place_order', { side: 'sell', good: 'net', quantity: v.nets - keepNets, price: +(p.nets * shade('nets')).toFixed(2) });
      // a builder lives in one house and sells the rest, at about what building it cost him
      const houseCost = v.houseWood * p.wood + 4 * p.food * v.meal;
      if (v.owned > 1) t.exec('place_order', { side: 'sell', good: 'house', quantity: v.owned - 1, price: +(houseCost * jitter).toFixed(2) });

      // buy what you need
      const cash = v.availCash / 100;
      const buyFood = 3 * want * v.meal;
      if (v.food < buyFood && cash > p.food * buyFood) t.exec('place_order', { side: 'buy', good: 'food', quantity: buyFood, price: +(p.food * 1.08 * jitter).toFixed(2) });
      // firewood and upkeep: buy it when someone else cuts it cheaper than a shift of yours would
      const burn = v.fireWood + v.upkeep * 2;
      if (v.wood < burn && cash > p.wood * burn * 2) t.exec('place_order', { side: 'buy', good: 'wood', quantity: 2 * burn - v.wood, price: +(p.wood * 1.1 * jitter).toFixed(2) });
      if (crafter && v.wood < v.netWood && cash > p.wood * v.netWood + p.food * v.meal)
        t.exec('place_order', { side: 'buy', good: 'wood', quantity: v.netWood - v.wood, price: +(p.wood * 1.1).toFixed(2) });
      else if (wantsHouse && v.wood < v.houseWood) {   // buy what's missing for a house, as far as cash goes
        const spare = t.view().availCash / 100 - p.food * 6 * v.meal, qty = Math.min(v.houseWood - v.wood, Math.floor(spare / (p.wood * 1.1 + 0.01)));
        if (qty >= 1) t.exec('place_order', { side: 'buy', good: 'wood', quantity: qty, price: +(p.wood * 1.1).toFixed(2) });
      }
      if (!v.netsUsable && !crafter && cash > p.nets * 1.1 + p.food * v.meal && rnd() < 0.3)
        t.exec('place_order', { side: 'buy', good: 'net', quantity: 1, price: +(p.nets * 1.05).toFixed(2) });
      // with no house of your own, a built one is worth bidding a good part of your savings for
      if (!v.owned && v.building === null && cash > 60 && rnd() < 0.25)
        t.exec('place_order', { side: 'buy', good: 'house', quantity: 1, price: +(Math.min(cash * 0.6, houseCost * 0.9) * jitter).toFixed(2) });

      // the bank: borrow when broke and holding collateral, repay as soon as affordable
      // (a fresh view: the sell orders above committed some goods)
      // Impatient ones repay early; the rest let the bank collect at the deadline.
      const f = t.view();
      if (f.debt && f.availCash > f.debtNow && (a.traits.patience < 0.5 || f.dueIn <= 2)) t.exec('repay', { amount: f.debtNow / 100 + 0.5 });
      else if (!f.debt && f.credit && cash < p.food * v.meal && f.maxLoan > 100) {
        // pledged nets still fish, so the net goes in the pledge too
        const pledge = { wood: Math.max(0, f.wood - f.fireWood), nets: f.nets };
        const value = pledge.wood * p.wood + pledge.nets * p.nets;                     // coins
        const amount = Math.floor(Math.min(f.maxLoan / 100, value * 0.5) * 100) / 100; // under LTV
        if (amount >= 1) t.exec('borrow', { amount, ...pledge, reason: 'short of cash' });
      }

      // pick the shift
      let act;
      const g = t.view();
      if (g.building !== null && !v.hunger && rnd() < 0.8) act = 'build_house';          // keep building, mostly
      else if (wantsHouse && g.wood >= v.houseWood && !v.hunger) act = 'build_house';     // enough wood saved: start
      else if (v.wood >= v.netWood + (wantsHouse ? v.houseWood : 0) && (crafter || !v.netsUsable)) act = 'craft_net';
      else {
        // a shift's output is worth what sells of it (sell-through), plus what you'd use yourself
        const st = x => 0.3 + 0.7 * x;
        const foodValue = p.food * v.yields.food * (v.netsUsable ? 1.4 : 1) * (v.food < keepFood ? 1 : st(v.sellThrough.food));
        const woodValue = p.wood * v.yields.wood * (1 + a.traits.patience * 1.6) *   // patient villagers value wood for the nets and houses it becomes
          (v.wood < 3 * (v.fireWood + v.upkeep) ? 1 : st(v.sellThrough.wood));
        act = foodValue * jitter >= woodValue ? 'gather_food' : 'gather_wood';
        if (v.hunger > 1 && v.food < v.meal) act = 'gather_food';
        else if (v.cold && v.wood < v.fireWood) act = 'gather_wood';   // out of firewood and nobody sold you any
      }
      t.exec(act, { reason: `[stub] ${act.replace('_', ' ')}` });
    },
  };
}
