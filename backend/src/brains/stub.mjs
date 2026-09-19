// PLACEHOLDER BRAIN. Free, instant, no API key. It acts through exactly the same
// tools the Claude brain uses, so the rest of the system can't tell them apart.
// It is deliberately simple — it exists to exercise the economy, not to be smart.
// What it does know is the one thing the economy is built on: work at whatever a shift
// of yours is worth most in coins, sell what you make, buy what you need.
import { CFG } from '../config.mjs';

export function stubBrain() {
  let seed = 999;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const MEAL = CFG.MEAL, EFF = CFG.HAND_EFFICIENCY, F = CFG.TASKS.gather_food, H = CFG.TASKS.build_house;

  return {
    name: 'stub',
    stats: () => ({ calls: 0, cost: 0 }),
    async decide(a, t) {
      const v = t.view(), p = v.prices, sk = v.skills;
      const jitter = 0.9 + rnd() * 0.2;
      const order = (side, good, quantity, price) => quantity >= 1 && price >= 0.01 &&
        t.exec('place_order', { side, good, quantity: Math.floor(quantity), price: +price.toFixed(2) });

      // what a shift of each job is worth to me, in coins at last prices
      const fish = v.yields.food * (v.netsUsable ? F.netYield / F.yield : 1) * p.food;
      const cut = v.yields.wood * p.wood;
      const craft = p.nets - v.netWood * p.wood;                                     // a net, less the wood in it
      const build = (p.houses - v.houseWood * p.wood) / H.shifts;                    // a house, less its wood, per building shift
      const crafter = sk.craft_net >= 1.2;
      const best = Math.max(fish, cut, crafter ? craft : 0, crafter ? build : 0);

      // lifestyle: eat better when food or cash is plentiful
      const meals = (v.availCash / 100 / p.food + v.food) / MEAL;
      const want = meals > 40 ? 3 : meals > 12 ? 2 : 1;
      if (want !== v.lifestyle) t.exec('set_lifestyle', { level: want, reason: want > v.lifestyle ? 'I can afford to eat better' : 'food is getting tight' });

      // keep a few rounds of food and firewood; sell the rest, buy what's short
      const keepFood = MEAL * want * 4;
      const project = crafter && build >= craft ? v.trancheWood : crafter ? v.netWood : 0;
      const keepWood = CFG.FIRE_WOOD * 2 + CFG.HOUSE_UPKEEP * v.homes * 4 + project;
      if (v.food > keepFood) order('sell', 'food', v.food - keepFood, p.food * jitter * 0.95);
      if (v.wood > keepWood) order('sell', 'wood', v.wood - keepWood, p.wood * jitter * 0.95);
      let cash = () => t.view().availCash / 100;
      if (v.food < keepFood / 2) order('buy', 'food', Math.min(keepFood - v.food, cash() * 0.5 / (p.food * 1.1)), p.food * 1.1 * jitter);
      if (v.wood < keepWood) order('buy', 'wood', Math.min(keepWood - v.wood, cash() * 0.4 / (p.wood * 1.1)), p.wood * 1.1 * jitter);

      // capital: a fisher wants a net, and more nets once hiring pays; a crafter sells the nets it makes
      const fisher = fish >= cut && !crafter;
      if (crafter && v.nets > 0) order('sell', 'net', v.nets, p.nets * jitter);
      else if (fisher && v.netsUsable < 1 + CFG.MAX_HANDS && cash() > p.nets * 1.5 && (!v.netsUsable || rnd() < 0.3)) order('buy', 'net', 1, p.nets * 1.05 * jitter);

      // houses: builders sell what they build beyond their own; the rest buy when they can afford one
      if (crafter && v.houses > 1) order('sell', 'house', v.houses - 1, Math.max(p.houses, v.houseWood * p.wood * 1.3) * jitter);
      else if (!crafter && v.nextHouseWb >= 0.5 && cash() > p.houses * 1.2) order('buy', 'house', 1, p.houses * 1.05 * jitter);

      // labour: hire when a hand makes more than the wage and there is capital for it; otherwise offer my own shift
      const spare = Math.max(0, v.netsUsable - 1);
      const hand = Math.max(v.yields.food * (spare ? F.netYield / F.yield : 1) * EFF * p.food, v.yields.wood * EFF * p.wood);
      if (hand > p.labour * 1.15 && cash() > p.labour * 2) order('buy', 'labour', Math.min(CFG.MAX_HANDS, fisher ? Math.max(1, spare) : 1, Math.floor(cash() * 0.3 / p.labour)), Math.min(hand * 0.85, p.labour * 1.15) * jitter);
      else if (v.canSellLabour && !v.hands) order('sell', 'labour', 1, Math.max(best * 1.05, p.labour * 0.9) * jitter);

      // the bank: borrow against goods to buy capital or wood for a build; repay when cash allows
      const f = t.view();
      if (f.debt && f.availCash > f.debtNow * 1.5 && (a.traits.patience < 0.5 || f.dueIn <= 3)) t.exec('repay', { amount: f.debtNow / 100 + 0.5 });
      else if (!f.debt && f.credit && f.maxLoan > 1000 && (crafter ? f.wood < v.houseWood : fisher && !v.netsUsable) && cash() < p.nets) {
        const pledge = { wood: Math.max(0, f.wood - keepWood), nets: 0, houses: Math.max(0, f.houses) };
        const value = pledge.wood * p.wood + pledge.houses * p.houses;
        const amount = Math.floor(Math.min(f.maxLoan / 100, value * 0.5) * 100) / 100;
        if (amount >= 5) t.exec('borrow', { amount, ...pledge, reason: 'to invest' });
      }

      if (v.hired) return;                                                           // this shift is sold

      // the shift: whatever is worth most, unless something is about to run out
      const g = t.view();
      let act = fish >= cut ? 'gather_food' : 'gather_wood';
      if (crafter && Math.max(craft, build) > Math.max(fish, cut)) {
        if (g.building !== null && g.wood >= v.trancheWood) act = 'build_house';
        else if (build >= craft && g.wood >= v.trancheWood) act = 'build_house';
        else if (g.wood >= v.netWood && craft > 0) act = 'craft_net';
      } else if (g.building !== null && g.wood >= v.trancheWood) act = 'build_house';
      if (v.hunger && v.food < MEAL) act = 'gather_food';
      else if (v.cold && v.wood < CFG.FIRE_WOOD) act = 'gather_wood';
      t.exec(act, { reason: `[stub] ${act.replace('_', ' ')}` });
    },
  };
}
