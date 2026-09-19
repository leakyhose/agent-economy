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

      // sell what you don't need
      if (v.food > 6) t.exec('place_order', { side: 'sell', good: 'food', quantity: v.food - 6, price: +(p.food * jitter * 0.95).toFixed(2) });
      const woodNeed = v.nets ? 0 : 4;
      if (v.wood > woodNeed) t.exec('place_order', { side: 'sell', good: 'wood', quantity: v.wood - woodNeed, price: +(p.wood * jitter * 0.95).toFixed(2) });
      if (v.nets > 1) t.exec('place_order', { side: 'sell', good: 'net', quantity: v.nets - 1, price: +(p.nets * jitter).toFixed(2) });

      // buy what you need
      const cash = v.availCash / 100;
      if (v.food < 3 && cash > p.food * 3) t.exec('place_order', { side: 'buy', good: 'food', quantity: 3, price: +(p.food * 1.15 * jitter).toFixed(2) });
      if (!v.nets && v.wood < 4 && cash > p.wood * 4 + p.food * 4 && rnd() < 0.3)
        t.exec('place_order', { side: 'buy', good: 'wood', quantity: 4 - v.wood, price: +(p.wood * 1.1).toFixed(2) });

      // pick the shift
      let act;
      if (!v.nets && v.wood >= 4) act = 'craft_net';
      else {
        const foodValue = p.food * (v.nets ? 6 : 3);
        const woodValue = p.wood * 3 * (1 + a.traits.patience * 1.6);   // patient villagers value wood for the nets it becomes
        act = foodValue * jitter >= woodValue ? 'gather_food' : 'gather_wood';
        if (v.hunger > 1 && v.food < 1) act = 'gather_food';
      }
      t.exec(act, {});
      a.thought = `[stub] ${act.replace('_', ' ')}`;
    },
  };
}
