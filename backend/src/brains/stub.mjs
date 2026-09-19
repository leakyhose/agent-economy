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

      // sell what you don't need
      if (v.food > 6) t.exec('place_order', { side: 'sell', good: 'food', quantity: v.food - 6, price: +(p.food * jitter * 0.95).toFixed(2) });
      const woodNeed = 3 + (v.nets && !crafter ? 0 : v.netWood);   // 3 for the fire
      if (v.wood > woodNeed) t.exec('place_order', { side: 'sell', good: 'wood', quantity: v.wood - woodNeed, price: +(p.wood * jitter * 0.95).toFixed(2) });
      const keepNets = crafter ? 0 : 1;
      if (v.nets > keepNets) t.exec('place_order', { side: 'sell', good: 'net', quantity: v.nets - keepNets, price: +(p.nets * jitter).toFixed(2) });

      // buy what you need
      const cash = v.availCash / 100;
      if (v.food < 3 && cash > p.food * 3) t.exec('place_order', { side: 'buy', good: 'food', quantity: 3, price: +(p.food * 1.15 * jitter).toFixed(2) });
      if (crafter && v.wood < v.netWood && cash > p.wood * v.netWood + p.food * 4)
        t.exec('place_order', { side: 'buy', good: 'wood', quantity: v.netWood - v.wood, price: +(p.wood * 1.1).toFixed(2) });
      if (!v.nets && !crafter && cash > p.nets * 1.1 + p.food * 4 && rnd() < 0.3)
        t.exec('place_order', { side: 'buy', good: 'net', quantity: 1, price: +(p.nets * 1.05).toFixed(2) });

      // the bank: borrow when broke and holding collateral, repay as soon as affordable
      // (a fresh view: the sell orders above committed some goods)
      const f = t.view();
      if (f.debt && f.availCash > f.debt) t.exec('repay', { amount: f.debt / 100 });
      else if (!f.debt && cash < p.food * 3 && f.maxLoan > 100) {
        const pledge = { wood: Math.max(0, f.wood - 3), nets: f.nets, boats: f.boats };
        const value = pledge.wood * p.wood + pledge.nets * p.nets + pledge.boats * p.boats;   // coins
        const amount = Math.floor(Math.min(f.maxLoan / 100, value * 0.4) * 100) / 100;       // under LTV after interest
        if (amount >= 1) t.exec('borrow', { amount, ...pledge, reason: 'short of cash' });
      }

      // pick the shift
      let act;
      if (v.wood >= v.netWood && (crafter || !v.nets)) act = 'craft_net';
      else {
        const foodValue = p.food * v.yields.food * (v.nets ? 2 : 1);
        const woodValue = p.wood * v.yields.wood * (1 + a.traits.patience * 1.6);   // patient villagers value wood for the nets it becomes
        act = foodValue * jitter >= woodValue ? 'gather_food' : 'gather_wood';
        if (v.hunger > 1 && v.food < 1) act = 'gather_food';
        else if (v.wood < 1) act = 'gather_wood';
      }
      t.exec(act, {});
      a.thought = `[stub] ${act.replace('_', ' ')}`;
    },
  };
}
