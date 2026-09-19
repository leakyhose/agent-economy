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
      const meals = v.availCash / 100 / p.food + v.food;
      const want = meals > 40 ? 3 : meals > 15 ? 2 : 1;
      if (want !== v.lifestyle) t.exec('set_lifestyle', { level: want, reason: want > v.lifestyle ? 'I can afford to eat better' : 'food is getting tight' });
      const keepFood = 6 * want;

      // sell what you don't need
      if (v.food > keepFood) t.exec('place_order', { side: 'sell', good: 'food', quantity: v.food - keepFood, price: +(p.food * jitter * 0.95).toFixed(2) });
      // patient villagers without a house save wood for one
      const wantsHouse = !v.house && v.building === null && a.traits.patience > 0.4;
      const woodNeed = 3 + (v.netsUsable && !crafter ? 0 : v.netWood) + (wantsHouse ? v.houseWood : 0);   // 3 for the fire
      if (v.wood > woodNeed) t.exec('place_order', { side: 'sell', good: 'wood', quantity: v.wood - woodNeed, price: +(p.wood * jitter * 0.95).toFixed(2) });
      const keepNets = crafter ? 0 : 1;
      if (v.nets > keepNets) t.exec('place_order', { side: 'sell', good: 'net', quantity: v.nets - keepNets, price: +(p.nets * jitter).toFixed(2) });

      // buy what you need
      const cash = v.availCash / 100;
      if (v.food < 3 * want && cash > p.food * 3) t.exec('place_order', { side: 'buy', good: 'food', quantity: 3, price: +(p.food * 1.15 * jitter).toFixed(2) });
      if (crafter && v.wood < v.netWood && cash > p.wood * v.netWood + p.food * 4)
        t.exec('place_order', { side: 'buy', good: 'wood', quantity: v.netWood - v.wood, price: +(p.wood * 1.1).toFixed(2) });
      else if (wantsHouse && v.wood < v.houseWood) {   // buy what's missing for a house, as far as cash goes
        const spare = t.view().availCash / 100 - p.food * 6, qty = Math.min(v.houseWood - v.wood, Math.floor(spare / (p.wood * 1.1 + 0.01)));
        if (qty >= 1) t.exec('place_order', { side: 'buy', good: 'wood', quantity: qty, price: +(p.wood * 1.1).toFixed(2) });
      }
      if (!v.netsUsable && !crafter && cash > p.nets * 1.1 + p.food * 4 && rnd() < 0.3)
        t.exec('place_order', { side: 'buy', good: 'net', quantity: 1, price: +(p.nets * 1.05).toFixed(2) });

      // the bank: borrow when broke and holding collateral, repay as soon as affordable
      // (a fresh view: the sell orders above committed some goods)
      // Impatient ones repay early; the rest let the bank collect at the deadline.
      const f = t.view(), term = f.terms[Math.floor(rnd() * f.terms.length)];
      if (f.debt && f.availCash > f.debtNow && (a.traits.patience < 0.5 || f.dueIn <= 2)) t.exec('repay', { amount: f.debtNow / 100 + 0.5 });
      else if (!f.debt && f.credit && f.unfinishedFree && f.maxLoan > 100 && cash < p.food * 12) {
        // a construction loan: the unfinished house is the collateral, to eat while building
        const amount = Math.floor(f.maxLoan * 0.8) / 100;
        t.exec('borrow', { amount, term_rounds: term, wood: 0, nets: 0, boats: 0, houses: 1, reason: 'a loan against the house I am building' });
      } else if (!f.debt && f.credit && cash < p.food * 3 && f.maxLoan > 100) {
        // pledged nets still fish, so the net goes in the pledge too
        const pledge = { wood: Math.max(0, f.wood - 3), nets: f.nets, boats: f.boats };
        const value = pledge.wood * p.wood + pledge.nets * p.nets + pledge.boats * p.boats;   // coins
        const amount = Math.floor(Math.min(f.maxLoan / 100, value * 0.5) * 100) / 100;       // under LTV
        if (amount >= 1) t.exec('borrow', { amount, term_rounds: term, ...pledge, reason: 'short of cash' });
      }

      // pick the shift
      let act;
      const g = t.view();
      if (g.building !== null && !v.hunger && rnd() < 0.8) act = 'build_house';          // keep building, mostly
      else if (wantsHouse && g.wood >= v.houseWood && !v.hunger) act = 'build_house';     // enough wood saved: start
      else if (v.wood >= v.netWood + (wantsHouse ? v.houseWood : 0) && (crafter || !v.netsUsable)) act = 'craft_net';
      else if (!v.hunger && !v.cold && v.food >= 4 * want && v.wood >= 2 && rnd() < 0.2) act = 'rest';   // fed and warm: take a break
      else {
        // a shift's output is worth what sells of it (sell-through), plus what you'd use yourself
        const st = x => 0.3 + 0.7 * x;
        const foodValue = p.food * v.yields.food * (v.netsUsable ? 2 : 1) * (v.food < 6 * want ? 1 : st(v.sellThrough.food));
        const woodValue = p.wood * v.yields.wood * (1 + a.traits.patience * 1.6) * (v.wood < 4 ? 1 : st(v.sellThrough.wood));   // patient villagers value wood for the nets it becomes
        act = foodValue * jitter >= woodValue ? 'gather_food' : 'gather_wood';
        if (v.hunger > 1 && v.food < 1) act = 'gather_food';
        else if (v.wood < 1) act = 'gather_wood';
      }
      t.exec(act, { reason: `[stub] ${act.replace('_', ' ')}` });
    },
  };
}
