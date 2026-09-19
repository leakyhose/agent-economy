// The tools an agent can call. Both brains — the free stub and Claude — act ONLY
// through these, so swapping brains changes nothing else in the system.
import { CFG, GOODS, FOOD, WOOD, NETS } from './config.mjs';

const coins = c => (c / 100).toFixed(2);
const GOOD_INDEX = { food: FOOD, wood: WOOD, net: NETS, nets: NETS };

const REASON = {
  type: 'object', additionalProperties: false, required: ['reason'],
  properties: { reason: { type: 'string', description: 'Why, in one short sentence, in your own voice.' } },
};

export const TOOL_DEFS = [
  { name: 'gather_food',
    description: `Spend your next shift fishing at the docks. Yields ${CFG.TASKS.gather_food.yield} food, or ${CFG.TASKS.gather_food.netYield} if you own a net. Takes about ${CFG.TASKS.gather_food.ticks * CFG.TICK_MS / 1000}s.`,
    input_schema: REASON },
  { name: 'gather_wood',
    description: `Spend your next shift cutting wood in the forest. Yields ${CFG.TASKS.gather_wood.yield} wood. Wood is used to craft nets.`,
    input_schema: REASON },
  { name: 'craft_net',
    description: `Spend your next shift crafting a fishing net from ${CFG.TASKS.craft_net.wood} wood. A net doubles your catch. Nets can tear.`,
    input_schema: REASON },
  { name: 'rest',
    description: 'Do nothing until the next market round.',
    input_schema: REASON },
  { name: 'place_order',
    description: 'Post a limit order to the next market round. All orders clear together at ONE price per good, set by supply and demand. A buy fills only if that price is at or below your price; a sell only if at or above. Unfilled orders expire after the round. You may place several orders.',
    input_schema: {
      type: 'object', additionalProperties: false,
      required: ['side', 'good', 'quantity', 'price'],
      properties: {
        side:     { type: 'string', enum: ['buy', 'sell'] },
        good:     { type: 'string', enum: ['food', 'wood', 'net'] },
        quantity: { type: 'integer', minimum: 1 },
        price:    { type: 'number', description: 'coins per unit' },
      },
    } },
  { name: 'check_market',
    description: 'See recent clearing prices and volumes for every good.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false } },
];

const ACTIVITIES = new Set(['gather_food', 'gather_wood', 'craft_net', 'rest']);

export function makeTools(W, a) {
  const acted = { activity: null, orders: 0 };

  function marketText() {
    const h = W.priceHistory.slice(-6);
    return GOODS.map((g, i) => {
      const now = W.prices[i], then = h[0]?.prices[i] ?? now;
      const pct = then ? Math.round((now - then) / then * 100) : 0;
      return `${g}: ${coins(now)} (sold ${W.volumes[i]} last round${pct ? `, ${pct > 0 ? '+' : ''}${pct}% recently` : ''})`;
    }).join('; ');
  }

  // Everything the agent is told about its situation. The LLM sees this as its prompt.
  function observe() {
    const rc = W.reservedCash(a);
    const rf = W.reservedGood(a, FOOD);
    return [
      `You are ${a.name}.`,
      `Cash: ${coins(a.cash)} coins${rc ? ` (${coins(rc)} committed to buy orders)` : ''}.`,
      `Food: ${a.goods[FOOD]}${rf ? ` (${rf} committed to sell)` : ''}. Wood: ${a.goods[WOOD]}. Nets: ${a.goods[NETS]}.`,
      a.hunger ? `You are HUNGRY — ${a.hunger} missed meal(s). Hungry villagers gather half as much.` : 'You are fed.',
      `You eat 1 food every ${CFG.EAT_TICKS * CFG.TICK_MS / 1000}s if you have food that isn't committed to a sale.`,
      `Market (round ${W.round}): ${marketText()}.`,
      a.memory.length ? `Recently:\n- ${a.memory.join('\n- ')}` : '',
      'Choose your next shift.',
    ].filter(Boolean).join('\n');
  }

  function exec(name, input = {}) {
    if (ACTIVITIES.has(name)) {
      if (acted.activity) return `You already chose to ${acted.activity} this shift.`;
      const task = name === 'rest' ? 'idle' : name;
      const err = W.startActivity(a, task);
      if (err) return err;
      acted.activity = name;
      if (input.reason) a.thought = String(input.reason).slice(0, 240);
      return name === 'rest' ? 'You rest until the next market round.'
        : `You head to the ${CFG.TASKS[task].place}. Back in about ${CFG.TASKS[task].ticks * CFG.TICK_MS / 1000}s.`;
    }
    if (name === 'place_order') {
      const g = GOOD_INDEX[input.good];
      if (g === undefined) return `Unknown good "${input.good}".`;
      const err = W.placeOrder(a, input.side, g, input.quantity, Math.round(input.price * 100));
      if (err) return err;
      acted.orders++;
      return `Order posted: ${input.side} ${input.quantity} ${input.good} at ${Number(input.price).toFixed(2)}. It clears at the next round.`;
    }
    if (name === 'check_market') return marketText();
    return `Unknown tool "${name}".`;
  }

  // structured view for the stub brain (the LLM gets observe() text instead)
  function view() {
    return {
      cash: a.cash, availCash: W.availCash(a), hunger: a.hunger,
      food: W.availGood(a, FOOD), wood: W.availGood(a, WOOD), nets: W.availGood(a, NETS),
      prices: { food: W.prices[FOOD] / 100, wood: W.prices[WOOD] / 100, nets: W.prices[NETS] / 100 },
    };
  }

  return { defs: TOOL_DEFS, exec, observe, view, acted };
}
