// The tools an agent can call. Both brains — the free stub and Claude — act ONLY
// through these, so swapping brains changes nothing else in the system.
import { CFG, GOODS, FOOD, WOOD, NETS, BOATS } from './config.mjs';
import { FIRE_SALE_BPS } from './chain.mjs';

const coins = c => (c / 100).toFixed(2);
const GOOD_INDEX = { food: FOOD, wood: WOOD, net: NETS, nets: NETS, boat: BOATS, boats: BOATS };
const B = CFG.BANK, pct = x => Math.round(x * 100);

const REASON = {
  type: 'object', additionalProperties: false, required: ['reason'],
  properties: { reason: { type: 'string', description: 'Why, in one short sentence, in your own voice.' } },
};

export const TOOL_DEFS = [
  { name: 'gather_food',
    description: `Spend your next shift fishing at the docks. Owning a net doubles the catch. How much you catch depends on your fishing skill. Takes about ${CFG.TASKS.gather_food.ticks * CFG.TICK_MS / 1000}s.`,
    input_schema: REASON },
  { name: 'gather_wood',
    description: 'Spend your next shift cutting wood in the forest. How much you cut depends on your woodcutting skill. Wood keeps you warm and is used to craft nets.',
    input_schema: REASON },
  { name: 'craft_net',
    description: 'Spend your next shift crafting a fishing net from wood (how much wood depends on your crafting skill). A net doubles its owner\'s catch. Nets can tear.',
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
        good:     { type: 'string', enum: ['food', 'wood', 'net', 'boat'] },
        quantity: { type: 'integer', minimum: 1 },
        price:    { type: 'number', description: 'coins per unit' },
      },
    } },
  { name: 'borrow',
    description: `Borrow newly minted coins from the village bank, enforced on Solana. Pledge wood, nets and/or boats as collateral (food is not accepted): they are locked until the loan is repaid, and locked goods do not rot. ` +
      `You may borrow up to ${pct(B.LTV)}% of the collateral's market value, minus ${pct(B.RATE)}% interest. The interest goes to the bank; whatever the bank earns beyond the capital it must keep is paid out to every villager equally as a dividend. ` +
      `The bank can lend at most ${Math.round(1 / B.KAPPA)}× its capital in total, so when bad loans eat its capital it lends less. ` +
      `The loan is due in about ${Math.round(B.TERM_SLOTS * CFG.SLOT_MS / 1000)}s. Anyone may foreclose once it is overdue, or at any time if prices fall so that your debt is more than ${pct(B.MARGIN)}% of the collateral's value (a margin call): ` +
      `your cash is taken toward the debt plus a ${pct(B.PENALTY)}% penalty, and if that is not enough the bank seizes as much collateral as it needs, most valuable first, valued at ${FIRE_SALE_BPS / 100}% of its last price, and gives the rest back.`,
    input_schema: {
      type: 'object', additionalProperties: false, required: ['amount', 'wood', 'nets', 'boats', 'reason'],
      properties: {
        amount: { type: 'number', description: 'coins to borrow' },
        wood:   { type: 'integer', minimum: 0, description: 'wood to pledge' },
        nets:   { type: 'integer', minimum: 0, description: 'nets to pledge' },
        boats:  { type: 'integer', minimum: 0, description: 'boats to pledge' },
        reason: REASON.properties.reason,
      },
    } },
  { name: 'repay',
    description: 'Pay coins toward your bank loan. Interest is paid first. Paid in full, your collateral is released at the next round.',
    input_schema: {
      type: 'object', additionalProperties: false, required: ['amount'],
      properties: { amount: { type: 'number', description: 'coins to repay' } },
    } },
  { name: 'check_market',
    description: 'See recent clearing prices and volumes for every good.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false } },
];

const ACTIVITIES = new Set(['gather_food', 'gather_wood', 'craft_net', 'rest']);

export function makeTools(W, a) {
  const acted = { activity: null, orders: 0, failed: false };
  const log = { saw: null, actions: [] };      // written to the run log after each decision

  function marketText() {
    const h = W.priceHistory.slice(-6);
    return GOODS.map((g, i) => {
      const now = W.prices[i], then = h[0]?.prices[i] ?? now;
      const pct = then ? Math.round((now - then) / then * 100) : 0;
      const b = W.lastBook?.[i];
      const depth = !b ? '' : `; last round ${b.askQty} offered${b.asks ? ` (cheapest ${coins(b.bestAsk)})` : ''}, ` +
        `${b.bidQty} wanted${b.bids ? ` (best bid ${coins(b.bestBid)})` : ''}, ${W.volumes[i]} sold`;
      return `${g}: last traded at ${coins(now)}${pct ? ` (${pct > 0 ? '+' : ''}${pct}% recently)` : ''}${depth}`;
    }).join('\n');
  }

  // Everything the agent is told about its situation. The LLM sees this as its prompt.
  function observe() {
    log.saw = describe();
    a.rotted = GOODS.map(() => 0);                 // shown once, then reset
    return log.saw;
  }
  function describe() {
    const rc = W.reservedCash(a);
    const rf = W.reservedGood(a, FOOD);
    const F = CFG.TASKS.gather_food, sk = t => W.skill(a, t);
    // what one shift of each job is worth at today's prices, so switching jobs is a choice
    const p = W.prices, weak = (a.hunger >= 3 ? CFG.HUNGRY_PENALTY : 1) * (a.cold >= 2 ? CFG.COLD_PENALTY : 1);
    const fish = (a.goods[NETS] ? F.netYield : F.yield) * sk('gather_food') * weak;
    const cut = CFG.TASKS.gather_wood.yield * sk('gather_wood') * weak;
    const due = W.secondsUntilDue(a);
    const lockedTxt = a.locked.map((q, g) => q ? `${q} ${GOODS[g]}` : '').filter(Boolean).join(' and ');
    const lim = W.loanLimits(a, W.freePledge(a)), bank = W.bank;
    // the bank's capital is only worth mentioning when it, not the agent's collateral, is the limit
    const room = lim.bank < lim.collateral ? ` The bank's capital is the limit: it can lend only ${coins(lim.bank)} more to anyone right now.` : '';
    const wanted = g => W.lastBook ? `; last round ${W.lastBook[g].bidQty} ${GOODS[g]} were wanted` : '';
    // a net's worth to its owner: the extra catch, against the wood it takes
    const withNet = F.netYield * sk('gather_food') * weak, noNet = F.yield * sk('gather_food') * weak;
    const netTxt = a.goods[NETS]
      ? `Your net raises your fishing from ${+noNet.toFixed(1)} to ${+withNet.toFixed(1)} food per shift.`
      : `A net would raise your fishing from ${+noNet.toFixed(1)} to ${+withNet.toFixed(1)} food per shift ` +
        `(+${+(withNet - noNet).toFixed(1)} food ≈ +${coins((withNet - noNet) * p[FOOD])} at today's food price). ` +
        `You can craft one from ${W.netWood(a)} wood (≈${coins(W.netWood(a) * p[WOOD])}) or buy one (last traded at ${coins(p[NETS])}).`;
    const rot = (a.rotted ?? []).map((q, g) => q ? `${q} ${GOODS[g]}` : '').filter(Boolean).join(' and ');
    return [
      `You are ${a.name}.`,
      `Your skills (1.0 = average): fishing x${sk('gather_food')} → ${+(F.yield * sk('gather_food')).toFixed(1)} food per shift ` +
        `(${+(F.netYield * sk('gather_food')).toFixed(1)} with a net); woodcutting x${sk('gather_wood')} → ` +
        `${+(CFG.TASKS.gather_wood.yield * sk('gather_wood')).toFixed(1)} wood per shift; net-crafting x${sk('craft_net')} → a net costs you ${W.netWood(a)} wood.`,
      `At today's prices one shift earns you about: fishing ${coins(fish * p[FOOD])} (${+fish.toFixed(1)} food${wanted(FOOD)}), ` +
        `woodcutting ${coins(cut * p[WOOD])} (${+cut.toFixed(1)} wood${wanted(WOOD)}).`,
      `${netTxt} Nets tear on about 1 fishing shift in ${Math.round(1 / CFG.NET_WEAR)}.`,
      `Cash: ${coins(a.cash)} coins${rc ? ` (${coins(rc)} committed to buy orders)` : ''}.`,
      `Food: ${a.goods[FOOD]}${rf ? ` (${rf} committed to sell)` : ''}. Wood: ${a.goods[WOOD]}. Nets: ${a.goods[NETS]}. Boats: ${a.goods[BOATS]}.`,
      a.debt
        ? `LOAN: you owe the bank ${coins(a.debt)}, due in ${due > 0 ? `about ${due}s` : 'NOW — it can be foreclosed at any moment'}. Pledged: ${lockedTxt} ` +
          `(worth ${coins(W.collateralValue(a.locked))} at last prices; a margin call is allowed if your debt passes ${coins(W.collateralValue(a.locked) * bank.terms.marginBps / 10_000)}). Your money net of debt: ${coins(a.cash - a.debt)}.`
        : `No loan. With your free wood, nets and boats pledged, the bank would lend you up to ${coins(Math.min(lim.collateral, lim.bank))}.${room}`,
      'Pledged goods are locked with the bank and do not rot.',
      `What the bank earns (interest, penalties) beyond the capital it must keep is paid to every villager equally as a dividend` +
        (a.dividends ? `; you have received ${coins(a.dividends)} so far.` : '; none has been paid yet.'),
      // same thresholds as finish() in world.mjs
      a.hunger >= 3 ? `You are HUNGRY — ${a.hunger} missed meals in a row. At 3 or more, your fishing and woodcutting yield half.`
        : a.hunger ? `You are hungry — ${a.hunger} missed meal(s) in a row. At 3 or more, your fishing and woodcutting yield half.` : 'You are fed.',
      a.cold >= 2 ? `You are COLD — ${a.cold} missed fires in a row. At 2 or more, your fishing and woodcutting yield half.`
        : a.cold ? 'Your fire went out once. At 2 missed fires in a row, your fishing and woodcutting yield half.' : 'You are warm.',
      `You eat 1 food every ${CFG.EAT_TICKS * CFG.TICK_MS / 1000}s and burn 1 wood every ${CFG.WARM_TICKS * CFG.TICK_MS / 1000}s, from goods not committed to a sale.`,
      `Every market round about ${Math.round(CFG.SPOIL[FOOD] * 100)}% of your free food and ${Math.round(CFG.SPOIL[WOOD] * 100)}% of your free wood rots. Coins never spoil.`,
      rot ? `Since your last decision: ${rot} rotted.` : '',
      `Market (round ${W.round}):\n${marketText()}`,
      `Coins in circulation: ${coins(bank.supply)} (${coins(bank.debtTotal)} of it owed to the bank). The bank's capital: ${coins(bank.equity)}.`,
      a.memory.length ? `Recently:\n- ${a.memory.join('\n- ')}` : '',
      'Choose your next shift.',
    ].filter(Boolean).join('\n');
  }

  // A refused action is flagged (the brain gets another turn) and remembered.
  let refused = null;
  const no = msg => { refused = msg; return msg; };
  function exec(name, input = {}) {
    refused = null;
    const result = run(name, input);
    if (refused) {
      acted.failed = true;
      const what = name === 'place_order' ? `place_order ${input.side} ${input.quantity} ${input.good}`
        : name === 'borrow' ? `borrow ${input.amount}` : name === 'repay' ? `repay ${input.amount}` : name;
      W.remember(a, `Rejected: ${what} — ${refused}`);
    }
    log.actions.push({ tool: name, input, result, ...(refused ? { rejected: true } : {}) });
    return result;
  }
  function run(name, input) {
    if (ACTIVITIES.has(name)) {
      if (acted.activity) return `You already chose to ${acted.activity} this shift.`;
      const task = name === 'rest' ? 'idle' : name;
      const err = W.startActivity(a, task);
      if (err) return no(err);
      acted.activity = name;
      if (input.reason) a.thought = String(input.reason).slice(0, 240);
      return name === 'rest' ? 'You rest until the next market round.'
        : `You head to the ${CFG.TASKS[task].place}. Back in about ${CFG.TASKS[task].ticks * CFG.TICK_MS / 1000}s.`;
    }
    if (name === 'place_order') {
      const g = GOOD_INDEX[input.good];
      if (g === undefined) return no(`Unknown good "${input.good}".`);
      const err = W.placeOrder(a, input.side, g, input.quantity, Math.round(input.price * 100));
      if (err) return no(err);
      acted.orders++;
      return `Order posted: ${input.side} ${input.quantity} ${input.good} at ${Number(input.price).toFixed(2)}. It clears at the next round.`;
    }
    if (name === 'borrow') {
      const pledge = GOODS.map(() => 0);
      pledge[WOOD] = Math.floor(input.wood ?? 0); pledge[NETS] = Math.floor(input.nets ?? 0); pledge[BOATS] = Math.floor(input.boats ?? 0);
      const err = W.requestBorrow(a, Number(input.amount) * 100, pledge);
      if (err) return no(err);
      if (input.reason) a.thought = String(input.reason).slice(0, 240);
      return `Loan requested: ${Number(input.amount).toFixed(2)} coins. You can spend them now; the chain confirms at the next round.`;
    }
    if (name === 'repay') {
      const err = W.requestRepay(a, Number(input.amount) * 100);
      return err ? no(err) : `Repayment of up to ${Number(input.amount).toFixed(2)} sent; it settles at the next round.`;
    }
    if (name === 'check_market') return marketText();
    return no(`Unknown tool "${name}".`);
  }

  // structured view for the stub brain (the LLM gets observe() text instead)
  function view() {
    return {
      cash: a.cash, availCash: W.availCash(a), hunger: a.hunger, cold: a.cold,
      food: W.availGood(a, FOOD), wood: W.availGood(a, WOOD), nets: W.availGood(a, NETS), boats: W.availGood(a, BOATS),
      prices: Object.fromEntries(GOODS.map((g, i) => [g, W.prices[i] / 100])),
      skills: a.skills, netWood: W.netWood(a), debt: a.debt, dueIn: W.secondsUntilDue(a),
      maxLoan: W.maxLoan(a, W.freePledge(a)),
      yields: { food: CFG.TASKS.gather_food.yield * W.skill(a, 'gather_food'), wood: CFG.TASKS.gather_wood.yield * W.skill(a, 'gather_wood') },
    };
  }

  return { defs: TOOL_DEFS, exec, observe, view, acted, log };
}
