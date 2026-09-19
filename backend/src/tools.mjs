// The tools an agent can call. Both brains — the free stub and Claude — act ONLY
// through these, so swapping brains changes nothing else in the system.
import { CFG, GOODS, FOOD, WOOD, NETS, BOATS, HOUSES } from './config.mjs';
import { FIRE_SALE_BPS } from './chain.mjs';

const coins = c => (c / 100).toFixed(2);
const GOOD_INDEX = { food: FOOD, wood: WOOD, net: NETS, nets: NETS, boat: BOATS, boats: BOATS, house: HOUSES, houses: HOUSES };
const B = CFG.BANK, WB = CFG.WELLBEING, pct = x => Math.round(x * 100);
const sec = ticks => ticks * CFG.TICK_MS / 1000;
const H = CFG.TASKS.build_house, MEALS_PER_MIN = 60 / sec(CFG.EAT_TICKS);
const TERMS = Array.from({ length: B.MAX_TERM_MINUTES }, (_, k) => k + 1);
const signed = x => `${x >= 0 ? '+' : ''}${+x.toFixed(1)}`;

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
  { name: 'build_house',
    description: `Spend your next shift building a house (about ${sec(H.ticks)}s a shift). Starting a house uses up ${H.wood} wood divided by your crafting skill, all at once, ` +
      `and gives you an unfinished house at once; it takes ${H.shifts} building shifts to finish. A finished house gives ${signed(WB.HOUSE)} wellbeing every meal, ` +
      `makes your firewood last ${CFG.HOUSE_WARMTH}× as long, and keeps up to ${CFG.HOUSE_STORE} of your food from rotting. An unfinished house gives none of that and cannot be sold, ` +
      `but it can be pledged to the bank (a construction loan). If you do other work in between, the house waits unfinished; call build_house again to continue it. One house at a time.`,
    input_schema: REASON },
  { name: 'rest',
    description: `Rest for your next shift (about ${sec(CFG.TASKS.idle.ticks)}s). Rest is worth ${signed(WB.REST)} wellbeing.`,
    input_schema: REASON },
  { name: 'set_lifestyle',
    description: `Choose how much you eat at every meal from now on: 1, 2 or 3 food. ` +
      `A meal of 1 food gives ${signed(WB.EAT[1])} wellbeing, 2 give ${signed(WB.EAT[2])}, 3 give ${signed(WB.EAT[3])}; a meal with no food gives ${WB.EAT[0]}. ` +
      `It stays until you change it. If you have less food than it calls for, you eat what you have. This does not use up your shift.`,
    input_schema: {
      type: 'object', additionalProperties: false, required: ['level', 'reason'],
      properties: {
        level:  { type: 'integer', enum: [1, 2, 3], description: 'food per meal' },
        reason: REASON.properties.reason,
      },
    } },
  { name: 'place_order',
    description: 'Post a limit order to the next market round. All orders clear together at ONE price per good, set by supply and demand. A buy fills only if that price is at or below your price; a sell only if at or above. Unfilled orders expire after the round. You may place several orders. Only finished houses can be sold.',
    input_schema: {
      type: 'object', additionalProperties: false,
      required: ['side', 'good', 'quantity', 'price'],
      properties: {
        side:     { type: 'string', enum: ['buy', 'sell'] },
        good:     { type: 'string', enum: ['food', 'wood', 'net', 'boat', 'house'] },
        quantity: { type: 'integer', minimum: 1 },
        price:    { type: 'number', description: 'coins per unit' },
      },
    } },
  { name: 'borrow',
    description: `Borrow newly minted coins from the village bank, enforced on Solana. Pledge wood, nets, boats and/or houses as collateral (food is not accepted), including a house you are still building: they are locked until the loan is repaid, and locked goods do not rot. ` +
      `You keep using what you pledge — you still fish with a pledged net and live in a pledged house — but you cannot sell, burn or pledge it again. ` +
      `You may owe at most ${pct(B.LTV)}% of the collateral's value at last prices. Nothing is charged up front: interest is ${pct(B.RATE_PER_MIN)}% a minute on what you borrowed, charged for the time you hold the loan (by the slot), so repaying early costs less. ` +
      `You choose the term: ${TERMS.join(', ')} minutes. Borrowing again while a loan is open adds to it and keeps its due time (not allowed once it is overdue). ` +
      `The interest goes to the bank; whatever it earns beyond the capital it must keep is paid out to every villager equally as a dividend. The bank can lend at most ${Math.round(1 / B.KAPPA)}× its capital in total, so when bad loans eat its capital it lends less. ` +
      `At the deadline the bank collects the whole debt from your cash if you have enough — no penalty, and your collateral is released. If your cash can't cover it, the loan is foreclosed: ` +
      `your cash goes to the debt plus a ${pct(B.PENALTY)}% penalty, and the bank seizes only as much collateral as it still needs, valued at ${FIRE_SALE_BPS / 100}% of its last price; ` +
      `if a seized item is worth more than that, the excess is refunded to you in cash, and everything else comes back. ` +
      `Before the deadline, anyone may foreclose the same way if prices fall so that your debt passes ${pct(B.MARGIN)}% of the collateral's value (a margin call) — then the penalty applies even if you have the cash.`,
    input_schema: {
      type: 'object', additionalProperties: false, required: ['amount', 'term_minutes', 'wood', 'nets', 'boats', 'reason'],
      properties: {
        amount: { type: 'number', description: 'coins to borrow' },
        term_minutes: { type: 'integer', enum: TERMS, description: 'minutes until the loan is due (ignored when adding to an open loan)' },
        wood:   { type: 'integer', minimum: 0, description: 'wood to pledge' },
        nets:   { type: 'integer', minimum: 0, description: 'nets to pledge' },
        boats:  { type: 'integer', minimum: 0, description: 'boats to pledge' },
        houses: { type: 'integer', minimum: 0, description: 'houses to pledge, finished or not (optional)' },
        reason: REASON.properties.reason,
      },
    } },
  { name: 'repay',
    description: 'Pay coins toward your bank loan: the interest accrued so far is paid first, then the principal. Paid in full (or with less than 1 coin left, which is forgiven), your collateral is released at the next round.',
    input_schema: {
      type: 'object', additionalProperties: false, required: ['amount'],
      properties: { amount: { type: 'number', description: 'coins to repay' } },
    } },
  { name: 'check_market',
    description: 'See recent clearing prices and volumes for every good.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false } },
];

const ACTIVITIES = new Set(['gather_food', 'gather_wood', 'craft_net', 'build_house', 'rest']);
// A call missing a required argument is refused rather than run with made-up values.
// A missing reason, or a pledge count (0 is what it means), is not worth a refusal.
const DEFAULTABLE = new Set(['reason', 'wood', 'nets', 'boats', 'houses']);
const REQUIRED = Object.fromEntries(TOOL_DEFS.map(d => [d.name, (d.input_schema.required ?? []).filter(k => !DEFAULTABLE.has(k))]));

export function makeTools(W, a) {
  const acted = { activity: null, orders: 0, failed: false };
  const log = { saw: null, actions: [] };      // written to the run log after each decision

  const recentSales = W.recentSales;

  function marketText() {
    const h = W.priceHistory.slice(-6);
    return GOODS.map((g, i) => {
      const now = W.prices[i], then = h[0]?.prices[i] ?? now;
      const pct = then ? Math.round((now - then) / then * 100) : 0;
      const b = W.lastBook?.[i];
      const offered = b ? b.askQty + b.bankQty : 0;
      const notes = [b?.asks ? `cheapest ask ${coins(b.bestAsk)}` : '', b?.bankQty ? `${b.bankQty} of them the bank's foreclosure sale` : ''].filter(Boolean).join('; ');
      const depth = !b ? '' : `; last round ${b.sold} of ${offered} offered ${g} sold${notes ? ` (${notes})` : ''}, ` +
        `${b.sold} of ${b.bidQty} wanted bought${b.bids ? ` (best bid ${coins(b.bestBid)})` : ''}`;
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
    const F = CFG.TASKS.gather_food, sk = t => W.skill(a, t);
    const p = W.prices, weak = (a.hunger >= 3 ? CFG.HUNGRY_PENALTY : 1) * (a.cold >= 2 ? CFG.COLD_PENALTY : 1);
    const lake = W.lake, share = W.lakeShare(), nets = W.usableNets(a);
    // what one shift of each job yields at today's lake, and is worth at what actually sells
    const fish = (nets ? F.netYield : F.yield) * sk('gather_food') * weak * share;
    const cut = CFG.TASKS.gather_wood.yield * sk('gather_wood') * weak;
    const worth = (qty, g) => {
      const r = recentSales(g), v = qty * p[g];
      if (!r.offered) return `${coins(v)} at the last price; none was offered for sale in the last 5 rounds`;
      const st = Math.min(1, r.sold / r.offered);
      return `${coins(v)} at the last price; in the last 5 rounds ${r.sold} of ${r.offered} ${GOODS[g]} offered sold (${Math.round(st * 100)}%), ` +
        `so ≈${coins(v * st)} if sold at that rate`;
    };
    const due = W.secondsUntilDue(a);
    const lockedTxt = a.locked.map((q, g) => q ? `${q} ${q === 1 ? GOODS[g].replace(/s$/, '') : GOODS[g]}` : '').filter(Boolean).join(' and ');
    const lim = W.loanLimits(a, W.freePledge(a)), bank = W.bank;
    // the bank's capital is only worth mentioning when it, not the agent's collateral, is the limit
    const room = lim.bank < lim.collateral ? ` The bank's capital is the limit: it can lend only ${coins(lim.bank)} more to anyone right now.` : '';
    // a net's worth to its owner: the extra catch, against the wood it takes
    const withNet = F.netYield * sk('gather_food') * weak * share, noNet = F.yield * sk('gather_food') * weak * share;
    const netTxt = nets
      ? `Your net raises your fishing from ${+noNet.toFixed(1)} to ${+withNet.toFixed(1)} food per shift at today's lake.`
      : `A net would raise your fishing from ${+noNet.toFixed(1)} to ${+withNet.toFixed(1)} food per shift at today's lake ` +
        `(+${+(withNet - noNet).toFixed(1)} food ≈ +${coins((withNet - noNet) * p[FOOD])} at the last food price). ` +
        `You can craft one from ${W.netWood(a)} wood (≈${coins(W.netWood(a) * p[WOOD])}) or buy one (last traded at ${coins(p[NETS])}).`;
    const rot = (a.rotted ?? []).map((q, g) => q ? `${q} ${GOODS[g]}` : '').filter(Boolean).join(' and ');

    // wellbeing: the goal, so far and lately, by source
    const parts = w => ['eating', 'warmth', 'house', 'rest'].map(k => `${k} ${signed(w[k])}`).join(', ');
    const recent = a.wbRecent.reduce((s, r) => { for (const k in s) s[k] += r[k]; return s; }, { eating: 0, warmth: 0, house: 0, rest: 0 });
    const wealth = W.wealth(a), perPoint = CFG.WELLBEING.COINS_PER_POINT;
    const mealSec = sec(CFG.EAT_TICKS), perMin = 60 / mealSec;
    const food = W.availGood(a, FOOD);
    const house = W.hasHouse(a), fireSec = sec(CFG.WARM_TICKS * (house ? CFG.HOUSE_WARMTH : 1));
    const homes = W.agents.filter(x => W.hasHouse(x)).length, builds = W.agents.filter(x => x.building).length;
    const rate = W.ratePerMin(), ratePct = `${+(rate * 100).toFixed(2)}% a minute`, credit = bank.terms.ltvBps > 0;

    // a house, from real numbers: what it costs you to build at market, what it gives, what a loan on it costs
    const shiftWorth = Math.max(fish * p[FOOD] * W.sellThrough(FOOD), cut * p[WOOD] * W.sellThrough(WOOD));
    const hw = W.houseWood(a), left = W.buildShifts - (a.building?.done ?? 0);
    const woodSaved = 60 / sec(CFG.WARM_TICKS) * (1 - 1 / CFG.HOUSE_WARMTH);
    const houseLoan = Math.floor(p[HOUSES] * bank.terms.ltvBps / 10_000);
    const payback = `${a.building ? `Finishing it: ${left} more building shift${left === 1 ? '' : 's'}` : `A house for you: ${hw} wood (≈${coins(hw * p[WOOD])} at the last wood price) + ${W.buildShifts} building shifts`} ` +
      `(each ≈${coins(shiftWorth)}: what your best shift now earns at recent sell-through) ≈ ${coins((a.building ? 0 : hw * p[WOOD]) + left * shiftWorth)} in all. ` +
      `A finished house gives ${signed(WB.HOUSE)} wellbeing a meal (${signed(WB.HOUSE * MEALS_PER_MIN)} a minute) and saves ${+woodSaved.toFixed(2)} wood a minute ` +
      `(≈${coins(woodSaved * p[WOOD])} at the last wood price). ` +
      (credit ? `Pledged, a house at the last house price (${coins(p[HOUSES])}) backs a loan of up to ${coins(houseLoan)}, which costs ≈${coins(houseLoan * rate)} a minute in interest at ${ratePct}.`
              : 'The bank is not lending, so there are no construction loans.');

    // the loan: what's owed now, what it costs, what happens at the deadline
    const owed = W.debtNow(a), interest = owed - a.principal;
    const loanTxt = !a.debt ? '' :
      `LOAN: you owe the bank ${coins(owed)} now (${coins(a.principal)} borrowed + ${coins(interest)} interest so far); ` +
      `interest adds ≈${coins(a.principal * rate)} a minute (${ratePct} on what you borrowed). ` +
      (due > 0 ? `Due in about ${due}s. ` : 'OVERDUE: the bank acts on it at the next round. ') +
      (a.cash >= owed ? `Your cash (${coins(a.cash)}) covers it now, so at the deadline it would be collected from your cash, with no penalty. `
        : `Your cash (${coins(a.cash)}) does not cover it now: if it still doesn't at the deadline, the loan is foreclosed with a ${pct(B.PENALTY)}% penalty and collateral seized. `) +
      `Pledged: ${lockedTxt}${a.building && a.locked[HOUSES] ? ' (the house is your unfinished one)' : ''} ` +
      `(worth ${coins(W.collateralValue(a.locked))} at last prices; a margin call is allowed if your debt passes ${coins(W.collateralValue(a.locked) * bank.terms.marginBps / 10_000)}).`;

    return [
      `You are ${a.name}.`,
      `Your wellbeing so far: ${a.wellbeing.toFixed(1)} (${parts(a.wbParts)}).` +
        (a.wbRecent.length ? ` Over your last ${a.wbRecent.length} meal periods: ${parts(recent)}.` : ''),
      `Your net worth now: ${coins(wealth)} coins (cash${a.debt ? ' minus debt with interest to now' : ''}, plus goods at last prices × the share of what was offered in the last 20 rounds that sold` +
        `${a.building ? ', your unfinished house as the wood in it' : ''}) — worth ${(wealth / 100 / perPoint).toFixed(1)} points at the end, ` +
        `so your score if the run ended now would be ${W.score(a).toFixed(1)}.`,
      `Lifestyle: you eat ${a.lifestyle} food per meal (${signed(CFG.WELLBEING.EAT[a.lifestyle])} per meal). A meal comes every ${mealSec}s (${perMin} a minute); ` +
        `at the last food price (${coins(p[FOOD])}) lifestyle 1 costs ≈${coins(perMin * p[FOOD])} a minute, 2 ≈${coins(2 * perMin * p[FOOD])}, 3 ≈${coins(3 * perMin * p[FOOD])}. ` +
        `Your free food lasts ${Math.floor(food / a.lifestyle)} meal${Math.floor(food / a.lifestyle) === 1 ? '' : 's'} at this lifestyle.`,
      `Your skills (1.0 = average): fishing x${sk('gather_food')} → ${+(F.yield * sk('gather_food')).toFixed(1)} food per shift from a full lake ` +
        `(${+(F.netYield * sk('gather_food')).toFixed(1)} with a net); woodcutting x${sk('gather_wood')} → ` +
        `${+(CFG.TASKS.gather_wood.yield * sk('gather_wood')).toFixed(1)} wood per shift; net-crafting x${sk('craft_net')} → a net costs you ${W.netWood(a)} wood.`,
      `The lake is ${Math.round(share * 100)}% full (${Math.round(lake.stock)} of ${lake.capacity} fish), so every catch is ${Math.round(share * 100)}% of what a full lake gives. ` +
        `Last round the village caught ${lake.caught} fish and the lake regrew ${Math.round(lake.regrew)}; ` +
        `it regrows fastest at half full (up to ${Math.round(CFG.LAKE.REGROWTH * lake.capacity / 4)} a round) and slowly when nearly empty or nearly full.`,
      `One shift for you now: fishing ≈${+fish.toFixed(1)} food (${worth(fish, FOOD)}); woodcutting ≈${+cut.toFixed(1)} wood (${worth(cut, WOOD)}); ` +
        `resting ${signed(CFG.WELLBEING.REST)} wellbeing.`,
      `${netTxt} Nets tear on about 1 fishing shift in ${Math.round(1 / CFG.NET_WEAR)}; a pledged net still fishes and does not tear.`,
      `Cash: ${coins(a.cash)} coins${rc ? ` (${coins(rc)} committed to buy orders)` : ''}.`,
      `You hold: ${GOODS.map((g, i) => `${g} ${W.owned(a, i)}${a.locked[i] ? ` (${a.locked[i]} pledged)` : ''}`).join(', ')}.`,
      `Free to sell now: ${GOODS.map((g, i) => `${g} ${Math.max(0, W.sellable(a, i))}`).join(', ')}.`,
      house
        ? `You own a house: ${signed(CFG.WELLBEING.HOUSE)} wellbeing every meal period, your fire burns 1 wood every ${fireSec}s instead of ${sec(CFG.WARM_TICKS)}s, ` +
          `and up to ${CFG.HOUSE_STORE} of your food doesn't rot.`
        : `You have no finished house. A house gives ${signed(CFG.WELLBEING.HOUSE)} wellbeing every meal period, halves the firewood you burn and keeps up to ${CFG.HOUSE_STORE} food from rotting.`,
      a.building ? `You are building a house: ${a.building.done} of ${W.buildShifts} building shifts done (build_house continues it). ` +
        `Until it is finished it gives nothing and can't be sold, but it can be pledged.` : '',
      `${house && !a.building ? '' : `${payback} `}Houses last traded at ${coins(p[HOUSES])}; ${homes} villager${homes === 1 ? ' lives' : 's live'} in a house, ${builds} ${builds === 1 ? 'is' : 'are'} being built.`,
      a.debt ? loanTxt
        : !credit ? 'No loan. The bank is not lending: credit is switched off.'
        : `No loan. With your free goods pledged, the bank would lend you up to ${coins(Math.min(lim.collateral, lim.bank))} ` +
          `(you pick a term of ${W.termMinutes().join(', ')} minutes; interest ${ratePct} on what you borrow, for the time you hold it).${room}`,
      'Pledged goods are locked with the bank and do not rot.',
      `What the bank earns (interest, penalties) beyond the capital it must keep is paid to every villager equally as a dividend` +
        (a.dividends ? `; you have received ${coins(a.dividends)} so far.` : '; none has been paid yet.'),
      // same thresholds as finish() in world.mjs
      a.hunger >= 3 ? `You are HUNGRY — ${a.hunger} missed meals in a row. At 3 or more, your fishing and woodcutting yield half.`
        : a.hunger ? `You are hungry — ${a.hunger} missed meal(s) in a row. At 3 or more, your fishing and woodcutting yield half.` : 'You are fed.',
      a.cold >= 2 ? `You are COLD — ${a.cold} missed fires in a row. At 2 or more, your fishing and woodcutting yield half.`
        : a.cold ? 'Your fire went out once. At 2 missed fires in a row, your fishing and woodcutting yield half.' : 'You are warm.',
      `You eat ${a.lifestyle} food every ${mealSec}s and burn 1 wood every ${fireSec}s, from goods not committed to a sale.`,
      `Every market round about ${Math.round(CFG.SPOIL[FOOD] * 100)}% of your free food and ${Math.round(CFG.SPOIL[WOOD] * 100)}% of your free wood rots. Coins never spoil.`,
      rot ? `Since your last decision: ${rot} rotted.` : '',
      `Market (round ${W.round}):\n${marketText()}`,
      a.fills ? `Your orders in round ${a.fills.round}${a.fills.round === W.round ? ' (the last round)' : ''}:\n- ${a.fills.lines.join('\n- ')}` : '',
      `Coins in circulation: ${coins(bank.supply)}; villagers owe the bank ${coins(bank.debtTotalNow ?? bank.debtTotal)}. The bank's capital: ${coins(bank.equity)}.`,
      a.memory.length ? `Recently:\n- ${a.memory.join('\n- ')}` : '',
      'Choose your next shift.',
    ].filter(Boolean).join('\n');
  }

  // A refused action is flagged (the brain gets another turn) and remembered.
  let refused = null;
  const no = msg => { refused = msg; return msg; };
  function exec(name, input = {}) {
    refused = null;
    const missing = (REQUIRED[name] ?? []).filter(k => input?.[k] === undefined || input?.[k] === null);
    const result = missing.length ? no(`Missing ${missing.join(', ')}. Nothing was done.`) : run(name, input);
    if (refused) {
      acted.failed = true;
      const what = name === 'place_order' ? `place_order ${input.side} ${input.quantity} ${input.good}`
        : name === 'borrow' ? `borrow ${input.amount} for ${input.term_minutes} min` : name === 'repay' ? `repay ${input.amount}` : name;
      W.remember(a, `Rejected: ${what} — ${refused}`);
    }
    log.actions.push({ tool: name, input, result, ...(refused ? { rejected: true } : {}) });
    return result;
  }
  // A call whose arguments couldn't be read (malformed or cut-off JSON): never run it,
  // tell the model so, and give it another turn.
  function badCall(name, raw, why) {
    acted.failed = true;
    const result = `Your call to ${name} could not be read (${why}), so nothing was done. Call it again with valid arguments.`;
    log.actions.push({ tool: name, input: { raw: String(raw ?? '').slice(0, 200) }, result, rejected: true });
    return result;
  }
  function run(name, input) {
    if (ACTIVITIES.has(name)) {
      if (acted.activity) return `You already chose to ${acted.activity} this shift.`;
      const task = name === 'rest' ? 'idle' : name;
      const err = W.startActivity(a, task, { rest: name === 'rest' });
      if (err) return no(err);
      acted.activity = name;
      if (input.reason) a.thought = String(input.reason).slice(0, 240);
      if (name === 'build_house') return `You work on your house (${a.building.done} of ${W.buildShifts} building shifts done before this one). Back in about ${sec(H.ticks)}s.`;
      return name === 'rest' ? `You rest. Back in about ${sec(CFG.TASKS.idle.ticks)}s.`
        : `You head to the ${CFG.TASKS[task].place}. Back in about ${CFG.TASKS[task].ticks * CFG.TICK_MS / 1000}s.`;
    }
    if (name === 'set_lifestyle') {
      const err = W.setLifestyle(a, input.level);
      if (err) return no(err);
      if (input.reason) a.thought = String(input.reason).slice(0, 240);
      return `From now on you eat ${a.lifestyle} food per meal. Now choose your shift.`;
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
      pledge[HOUSES] = Math.floor(input.houses ?? 0);
      const err = W.requestBorrow(a, Number(input.amount) * 100, pledge, input.term_minutes);
      if (err) return no(err);
      if (input.reason) a.thought = String(input.reason).slice(0, 240);
      return `Loan requested: ${Number(input.amount).toFixed(2)} coins${W.loanOps.at(-1)?.topUp ? ', added to your open loan (same due time)' : ` for ${Math.round(Number(input.term_minutes))} minute(s)`}. ` +
        `You can spend them now; the chain confirms at the next round.`;
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
      // free (sellable) goods; netsUsable and house count pledged ones too
      food: W.availGood(a, FOOD), wood: W.availGood(a, WOOD), nets: W.availGood(a, NETS), boats: W.availGood(a, BOATS), houses: W.sellable(a, HOUSES),
      netsUsable: W.usableNets(a), house: W.hasHouse(a), lifestyle: a.lifestyle, lake: W.lakeShare(), wellbeing: a.wellbeing,
      // a house under construction: shifts done (null = none), and the wood a new one takes
      building: a.building?.done ?? null, unfinishedFree: a.building && !a.locked[HOUSES] ? 1 : 0, houseWood: W.houseWood(a),
      credit: W.bank.terms.ltvBps > 0, terms: W.termMinutes(), debtNow: W.debtNow(a),
      // share of what was offered that sold, last 5 rounds (1 when nothing was offered)
      sellThrough: Object.fromEntries(GOODS.map((g, i) => { const r = recentSales(i); return [g, r.offered ? Math.min(1, r.sold / r.offered) : 1]; })),
      prices: Object.fromEntries(GOODS.map((g, i) => [g, W.prices[i] / 100])),
      skills: a.skills, netWood: W.netWood(a), debt: a.debt, dueIn: W.secondsUntilDue(a),
      maxLoan: W.maxLoan(a, W.freePledge(a)),
      yields: { food: CFG.TASKS.gather_food.yield * W.skill(a, 'gather_food') * W.lakeShare(), wood: CFG.TASKS.gather_wood.yield * W.skill(a, 'gather_wood') },
    };
  }

  return { defs: TOOL_DEFS, exec, badCall, observe, view, acted, log };
}
