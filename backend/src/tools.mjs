// The tools an agent can call. Both brains — the free stub and Claude — act ONLY
// through these, so swapping brains changes nothing else in the system.
import { CFG, GOODS, FOOD, WOOD, NETS, LABOUR, HOUSES } from './config.mjs';
import { FIRE_SALE_BPS } from './chain.mjs';

const coins = c => (c / 100).toFixed(2);
const GOOD_INDEX = { food: FOOD, wood: WOOD, net: NETS, nets: NETS, labour: LABOUR, labor: LABOUR, house: HOUSES, houses: HOUSES };
const B = CFG.BANK, WB = CFG.WELLBEING, pct = x => Math.round(x * 100);
const H = CFG.TASKS.build_house, TERM = B.TERM_ROUNDS, MEAL = CFG.MEAL, EFF = CFG.HAND_EFFICIENCY;
const rounds = n => `${n} round${n === 1 ? '' : 's'}`;
const pct100 = x => +(x * 100).toFixed(1);
const signed = x => `${x >= 0 ? '+' : ''}${+x.toFixed(1)}`;

const REASON = {
  type: 'object', additionalProperties: false, required: ['reason'],
  properties: { reason: { type: 'string', description: 'Why, in one short sentence, in your own voice.' } },
};

const ALL_TOOLS = [
  { name: 'gather_food',
    description: 'Spend this round\'s shift fishing. Your catch depends on your fishing skill; a net doubles it.',
    input_schema: REASON },
  { name: 'gather_wood',
    description: 'Spend this round\'s shift cutting wood. How much you cut depends on your woodcutting skill.',
    input_schema: REASON },
  { name: 'craft_net',
    description: 'Spend this round\'s shift crafting a fishing net from wood (how much wood depends on your crafting skill).',
    input_schema: REASON },
  { name: 'build_house',
    description: `Spend this round's shift building a house. Starting one uses up ${H.wood} wood divided by your crafting skill, all at once; ` +
      `it then takes ${H.shifts} building shifts to finish (hired hands each add a shift). You can do other work in between and call build_house again to continue. ` +
      `You build one at a time but may own several, to live in or to sell. ` +
      `An unfinished house gives nothing, and cannot be sold or pledged.`,
    input_schema: REASON },
  { name: 'set_lifestyle',
    description: `Choose how well you eat at every meal (one a round) from now on: level 1, 2 or 3 = ${MEAL}, ${2 * MEAL} or ${3 * MEAL} food ` +
      `(${signed(WB.EAT[1])}, ${signed(WB.EAT[2])}, ${signed(WB.EAT[3])} wellbeing; a meal with under ${MEAL} food gives ${WB.EAT[0]}). ` +
      `With less food than that, you eat what you have. This does not use up your shift.`,
    input_schema: {
      type: 'object', additionalProperties: false, required: ['level', 'reason'],
      properties: {
        level:  { type: 'integer', enum: [1, 2, 3], description: `meal level: ${MEAL} food per level` },
        reason: REASON.properties.reason,
      },
    } },
  { name: 'place_order',
    description: 'Post a limit order to this round\'s market: a buy names the most you will pay per unit, a sell the least you will take. ' +
      'Lower asks sell first and higher bids buy first; everyone who trades a good gets the same clearing price. Unfilled orders expire after the round. ' +
      'You may place several orders, but not a buy and a sell of the same good that would trade with each other. Only finished houses can be sold. ' +
      `The good "labour" is one shift of work, and its price is the wage. SELL 1 labour to offer your NEXT round's shift: if it sells you are paid the wage at once, and next round you work for the buyer instead of choosing a job. ` +
      `BUY labour (up to ${CFG.MAX_HANDS}) to hire hands for NEXT round: each works in whatever job you choose then, at ${pct(EFF)}% of your skill, and what they make is yours. You can't do both in one round.`,
    input_schema: {
      type: 'object', additionalProperties: false,
      required: ['side', 'good', 'quantity', 'price'],
      properties: {
        side:     { type: 'string', enum: ['buy', 'sell'] },
        good:     { type: 'string', enum: ['food', 'wood', 'net', 'house', 'labour'] },
        quantity: { type: 'integer', minimum: 1 },
        price:    { type: 'number', description: 'coins per unit' },
        reason:   { type: 'string', description: 'Optional: why this price, in a few words.' },
      },
    } },
  { name: 'borrow',
    description: `Borrow newly minted coins from the village bank against pledged wood, nets and/or finished houses (food is not accepted). ` +
      `You may owe at most ${pct(B.LTV)}% of the collateral's value at last prices. Pledged goods stay in use (you fish with a pledged net, live in a pledged house) and don't rot, ` +
      `but can't be sold, burned or pledged again until the loan is repaid. Interest accrues for the time you hold the loan (your situation shows the rate per round), so repaying early costs less. ` +
      `Every loan runs ${TERM} rounds; borrowing again adds to the open loan and keeps its due round. ` +
      `At the deadline the debt is taken from your cash, with no penalty. If your cash can't cover it, the loan is foreclosed: a ${pct(B.PENALTY)}% penalty, ` +
      `and the bank seizes as much collateral as it still needs, valued at ${FIRE_SALE_BPS / 100}% of its last price, and returns the rest.`,
    input_schema: {
      type: 'object', additionalProperties: false, required: ['amount', 'wood', 'nets', 'reason'],
      properties: {
        amount: { type: 'number', description: 'coins to borrow' },
        wood:   { type: 'integer', minimum: 0, description: 'wood to pledge' },
        nets:   { type: 'integer', minimum: 0, description: 'nets to pledge' },
        houses: { type: 'integer', minimum: 0, description: 'finished houses to pledge (optional)' },
        reason: REASON.properties.reason,
      },
    } },
  { name: 'repay',
    description: 'Pay coins toward your bank loan (interest first, then principal). Paid in full, your collateral is released when this round settles.',
    input_schema: {
      type: 'object', additionalProperties: false, required: ['amount'],
      properties: { amount: { type: 'number', description: 'coins to repay' } },
    } },
  { name: 'check_market',
    description: 'See last round\'s market again: price, offered / wanted / sold, and the best asks and bids for every good with orders.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false } },
];
// With credit switched off the bank lends nothing, so its tools are not offered at all.
export const TOOL_DEFS = ALL_TOOLS.filter(d => B.CREDIT || (d.name !== 'borrow' && d.name !== 'repay'));

const ACTIVITIES = new Set(['gather_food', 'gather_wood', 'craft_net', 'build_house']);
// A call missing a required argument is refused rather than run with made-up values.
// A missing reason, or a pledge count (0 is what it means), is not worth a refusal.
const DEFAULTABLE = new Set(['reason', 'wood', 'nets', 'houses']);
const REQUIRED = Object.fromEntries(ALL_TOOLS.map(d => [d.name, (d.input_schema.required ?? []).filter(k => !DEFAULTABLE.has(k))]));

export function makeTools(W, a) {
  const acted = { activity: a.hired ? 'hired' : null, orders: 0, failed: false, answered: false };
  const log = { saw: null, actions: [] };      // written to the run log after each decision
  let closed = false;                           // the round has moved on: a late answer changes nothing

  const lvl = ls => ls.map(([p, q]) => `${coins(p)}×${q}`).join(' · ');

  // One line per good: the price, what was offered / wanted / sold last round, the best asks and bids.
  // A good with no orders that the agent holds none of is left out.
  function marketText() {
    const h = W.priceHistory.slice(-6);
    const lines = GOODS.map((g, i) => {
      const now = W.prices[i], then = h[0]?.prices[i] ?? now, n = Math.max(0, h.length - 1);
      const d = then ? Math.round((now - then) / then * 100) : 0;
      const trend = d && n ? ` (${d > 0 ? '+' : ''}${d}% over ${rounds(n)})` : '';
      const traded = W.priceHistory.some(r => r.volumes[i] > 0);
      const price = `${i === LABOUR ? (traded ? 'last wage' : 'reference wage') : traded ? 'last price' : 'reference price'} ${coins(now)}${trend}`;
      if (i === LABOUR) g = 'labour (one shift)';
      const sale = W.bankAsk(i);
      const bank = sale ? ` The bank is selling ${sale.qty} seized ${g} at ${coins(sale.price)}, ${pct100(CFG.BANK_SALE_STEP)}% lower each round they go unsold.` : '';
      const L = CFG.LADDER ? W.lastLadder?.[i] : null, b = W.lastBook?.[i];
      const offered = L ? L.offered : b ? b.askQty + b.bankQty : 0, wanted = L ? L.wanted : b?.bidQty ?? 0;
      if (!offered && !wanted) return sale || W.owned(a, i) ? `${g}: ${price}; no orders last round.${bank}` : '';
      const sold = L ? L.sold : b.sold;
      const side = (s, word, dir) => s.count ? `${word} ${lvl(s.top)}${s.more ? ` (+${s.more} ${dir})` : ''}` : `no ${word}`;
      const best = L ? `${side(L.asks, 'asks', 'higher')}; ${side(L.bids, 'bids', 'lower')}`
        : `${b.asks ? `best ask ${coins(b.bestAsk)}` : 'no asks'}; ${b.bids ? `best bid ${coins(b.bestBid)}` : 'no bids'}`;
      return `${g}: ${price}; ${offered} offered, ${wanted} wanted, ${sold} sold; ${best}.${bank}`;
    }).filter(Boolean);
    return lines.length ? lines.join('\n') : 'No orders yet.';
  }

  // Everything the agent is told about its situation. The LLM sees this as its prompt.
  function observe() {
    log.saw = describe();
    a.rotted = GOODS.map(() => 0);                 // shown once, then reset
    return log.saw;
  }
  function describe() {
    const F = CFG.TASKS.gather_food, sk = t => W.skill(a, t), n1 = x => +x.toFixed(1);
    const nets = W.usableNets(a);
    const now = W.round + 1;                     // the round being decided
    const P = W.prices, c = x => coins(Math.round(x));
    // what one shift of each job yields for this agent, and what that is worth at last prices
    const noNet = F.yield * sk('gather_food') * W.catch(), withNet = F.netYield * sk('gather_food') * W.catch();
    const fish = nets ? withNet : noNet, cut = CFG.TASKS.gather_wood.yield * sk('gather_wood');
    const wood = W.availGood(a, WOOD), food = W.availGood(a, FOOD);
    const rot = (a.rotted ?? []).map((q, g) => q ? `${q} ${GOODS[g]}` : '').filter(Boolean).join(' and ');
    // every job in one unit: coins a shift, at what buyers paid (or bid and didn't get) last round
    const hw0 = W.houseWood(a), nw = W.netWood(a);
    const fishCoins = fish * P[FOOD], cutCoins = cut * P[WOOD];
    const craftCoins = W.fetch(NETS) - nw * P[WOOD], buildCoins = (W.fetch(HOUSES) - hw0 * P[WOOD]) / W.buildShifts;
    // A price is only worth what sells at it: the share of what was offered lately that found a buyer.
    const through = g => { const r = W.recentSales(g, 3); return r.offered ? Math.min(1, r.sold / r.offered) : 1; };
    const glut = g => through(g) < 0.6 ? ` — but only ${Math.round(through(g) * 100)}% of the ${GOODS[g]} offered lately found a buyer, so count on less or ask less` : '';
    const sure = (x, g) => x * (0.15 + 0.85 * through(g));
    const best = Math.max(sure(fishCoins, FOOD), sure(cutCoins, WOOD), sure(craftCoins, NETS), sure(buildCoins, HOUSES));

    // food held against food eaten: how much of it rots before it is eaten, at this lifestyle
    const perMeal = a.lifestyle * MEAL;
    let left = food, waste = 0;
    while (left >= MEAL) { left -= Math.min(perMeal, left); const r = CFG.SPOIL[FOOD] * left; waste += r; left -= r; }
    const meals = Math.floor(food / perMeal);
    const rotTxt = waste >= 15 && waste >= food / 3 ? ` About ${Math.round(waste)} of it will rot before you eat it — sell the surplus.` : '';

    const parts = w => ['eating', 'warmth', 'house'].map(k => `${k} ${signed(w[k])}`).join(', ');
    const recent = a.wbRecent.reduce((s, r) => { for (const k in s) s[k] += r[k]; return s; }, { eating: 0, warmth: 0, house: 0 });

    // houses: what you have, what the next one adds, what it costs you to build against the market
    const homes = W.homes(a), hw = W.houseWood(a), shiftsLeft = W.buildShifts - (a.building?.done ?? 0);
    const nextWb = W.houseWb(homes + 1), buildCost = hw * P[WOOD] + W.buildShifts * Math.max(fishCoins, cutCoins, craftCoins);
    // a house for someone who would rather buy than build: what is on offer, or how to ask for one
    const HL = W.lastLadder?.[HOUSES], offer = HL?.asks.top[0];
    const buyTxt = a.building ? '' : ` To buy instead: ${offer ? `one was offered at ${coins(offer[0])} last round` : 'none is on offer yet — post a bid (buy house) at what it is worth to you, so builders see a buyer'}` +
      `${a.cash >= 0.6 * W.fetch(HOUSES) ? `; your ${coins(a.cash)} coins give you nothing until they are spent` : ''}.`;
    const ownTxt = homes ? `You own ${homes} house${homes > 1 ? 's' : ''} (${signed(Array.from({ length: homes }, (_, i) => W.houseWb(i + 1)).reduce((x, y) => x + y, 0))} wellbeing a round in all; each uses ${CFG.HOUSE_UPKEEP} wood a round). ` : '';
    const houseTxt = ownTxt + (a.building
      ? `Your unfinished house: ${a.building.done} of ${W.buildShifts} building shifts done, ${shiftsLeft} to go (build_house continues it).`
      : `${homes ? 'Another' : 'A'} house would add ${signed(nextWb)} wellbeing every round. To build one yourself: ${hw} wood (you have ${wood}) + ${W.buildShifts} building shifts, ` +
        `≈${c(buildCost)} coins of wood and lost work; ${W.priceHistory.some(r => r.volumes[HOUSES] > 0) ? `houses last sold at ${coins(P[HOUSES])}` : 'no house has been sold yet'}.${buyTxt}`);

    // labour: what selling a shift pays against working it yourself, and what a hand would make for you
    const spare = Math.max(0, nets - 1);
    const handFish = (spare ? F.netYield : F.yield) * sk('gather_food') * EFF * W.catch(), handCut = cut * EFF;
    const handCoins = Math.max(handFish * P[FOOD], handCut * P[WOOD], craftCoins, buildCoins);   // a hand crafts or builds a full shift's worth
    const labourTxt = a.hired
      ? `THIS ROUND YOU ARE HIRED: you sold this shift for ${coins(a.hired.wage)} (already paid), so you work for your employer and can't choose a job. You can still trade${CFG.BANK.CREDIT ? ', borrow, repay' : ''} and set your lifestyle.`
      : (a.hands ? `You have ${a.hands} hired hand${a.hands > 1 ? 's' : ''} THIS round: they do the job you choose now, at ${pct(EFF)}% of your skill${a.hands > spare && fishCoins >= cutCoins ? ` (you have ${spare} spare net${spare === 1 ? '' : 's'} for them)` : ''}. ` : '') +
        `Labour: the wage for one shift is ${coins(P[LABOUR])}. Your own best shift is worth ≈${c(best)} — sell your next shift (sell 1 labour) only for more than that. ` +
        `A hired hand would make you ≈${c(handCoins)} a shift (${n1(handFish)} food${spare ? ' with your spare net' : '; double that with a spare net of yours'}, or ${n1(handCut)} wood, or one more net crafted from your wood, or one more building shift on your house) — hire (buy labour) if the wage is below that.`;

    // the bank: nothing at all unless it lends or the agent owes it
    const credit = W.bank.terms.ltvBps > 0, rate = W.ratePerRound(), ratePct = `≈${+(rate * 100).toFixed(2)}% a round`;
    let loanTxt = '';
    if (a.debt) {
      const owed = W.debtNow(a), due = a.dueRound, value = W.collateralValue(a.locked);
      const lockedTxt = a.locked.map((q, g) => q ? `${q} ${q === 1 ? GOODS[g].replace(/s$/, '') : GOODS[g]}` : '').filter(Boolean).join(' and ');
      loanTxt = `LOAN: you owe ${coins(owed)} (${coins(a.principal)} borrowed + interest, ≈${coins(a.principal * rate)} more each round). ` +
        (due == null ? '' : now > due ? 'OVERDUE: the bank acts on it when this round settles. '
          : now === due ? 'Due at the end of this round. ' : `Due at the end of round ${due} (${rounds(due - now)} after this one). `) +
        (a.cash >= owed ? 'Your cash covers it. ' : `Your cash does not cover it: if it still doesn't at the deadline, you are foreclosed with a ${pct(B.PENALTY)}% penalty. `) +
        `Pledged: ${lockedTxt} (worth ${coins(value)}).`;
    } else if (credit) {
      const lim = W.loanLimits(a, W.freePledge(a));
      loanTxt = `No loan. The bank would lend you up to ${coins(Math.min(lim.collateral, lim.bank))} against your free goods, for ${rounds(W.termRounds())} at ${ratePct}.`;
    }

    return [
      `You are ${a.name}. This is round ${now}.`,
      `Wellbeing so far: ${a.wellbeing.toFixed(1)} (${parts(a.wbParts)}).` +
        (a.wbRecent.length ? ` Last ${rounds(a.wbRecent.length)}: ${parts(recent)}.` : ''),
      `A meal of ${MEAL} food gives ${signed(WB.EAT[1])} wellbeing, ${2 * MEAL} give ${signed(WB.EAT[2])}, ${3 * MEAL} give ${signed(WB.EAT[3])}, under ${MEAL} gives ${WB.EAT[0]}. ` +
        `You eat ${perMeal} per meal (level ${a.lifestyle}) and hold ${food} food: ${meals} meal${meals === 1 ? '' : 's'}.${rotTxt}`,
      `What one shift of yours is worth, in coins at the market:\n` +
        `- fishing: ${n1(fish)} food ≈ ${c(fishCoins)} (skill x${sk('gather_food')}${nets ? ', with your net' : ', no net'})${glut(FOOD)}\n` +
        `- woodcutting: ${n1(cut)} wood ≈ ${c(cutCoins)} (x${sk('gather_wood')})${glut(WOOD)}\n` +
        `- crafting a net: ${nw} wood (≈${c(nw * P[WOOD])}) becomes a net that fetches ≈${coins(W.fetch(NETS))} → ≈${c(craftCoins)} (crafting x${sk('craft_net')})\n` +
        `- building to sell: ${hw0} wood (≈${c(hw0 * P[WOOD])}) + ${W.buildShifts} shifts become a house that fetches ≈${coins(W.fetch(HOUSES))} → ≈${c(buildCoins)} a shift\n` +
        `Work at what pays you best and buy the rest: what you are bad at is cheaper bought than made.`,
      nets ? `Your net doubles your catch: ${n1(noNet)} → ${n1(withNet)} food/shift.`
        : `A net doubles your catch: ${n1(noNet)} → ${n1(withNet)} food/shift; craft one from ${W.netWood(a)} wood (you have ${wood}) or buy one.`,
      houseTxt,
      labourTxt,
      `Cash: ${coins(a.cash)} coins. You hold: ${GOODS.map((g, i) => i === LABOUR || (i > WOOD && !W.owned(a, i)) ? '' : `${g} ${W.owned(a, i)}${a.locked[i] ? ` (${a.locked[i]} pledged)` : ''}`).filter(Boolean).join(', ')}.`,
      loanTxt,
      a.hunger ? `You are hungry: ${a.hunger} missed meal${a.hunger === 1 ? '' : 's'} in a row.` : '',
      a.cold ? `You are cold: ${a.cold} missed fire${a.cold === 1 ? '' : 's'} in a row (a fire burns ${CFG.FIRE_WOOD} wood every ${CFG.WARM_ROUNDS} rounds).` : '',
      rot ? `Since your last turn: ${rot} rotted.` : '',
      `Market (round ${W.round}):\n${marketText()}`,
      a.fills ? `Your orders in round ${a.fills.round}:\n- ${a.fills.lines.join('\n- ')}` : '',
      a.memory.length ? `Recently:\n- ${a.memory.join('\n- ')}` : '',
      a.hired ? 'Your shift is sold. Post any orders you want, then stop.' : 'Choose this round\'s shift.',
    ].filter(Boolean).join('\n');
  }

  // A refused action is flagged (the brain gets another turn) and remembered.
  let refused = null;
  const no = msg => { refused = msg; return msg; };
  const LATE = `Too late: round ${W.round + 1} has already run, so nothing was done.`;
  function exec(name, input = {}) {
    refused = null;
    if (closed) { log.late = (log.late ?? 0) + 1; return LATE; }
    const missing = (REQUIRED[name] ?? []).filter(k => input?.[k] === undefined || input?.[k] === null);
    const result = missing.length ? no(`Missing ${missing.join(', ')}. Nothing was done.`) : run(name, input);
    if (refused) {
      acted.failed = true;
      const what = name === 'place_order' ? `place_order ${input.side} ${input.quantity} ${input.good}`
        : name === 'borrow' ? `borrow ${input.amount}` : name === 'repay' ? `repay ${input.amount}` : name;
      W.remember(a, `Rejected: ${what} — ${refused}`);
    }
    log.actions.push({ tool: name, input, result, ...(refused ? { rejected: true } : {}) });
    return result;
  }
  // A call whose arguments couldn't be read (malformed or cut-off JSON): never run it,
  // tell the model so, and give it another turn.
  function badCall(name, raw, why) {
    if (closed) return LATE;
    acted.failed = true;
    const result = `Your call to ${name} could not be read (${why}), so nothing was done. Call it again with valid arguments.`;
    log.actions.push({ tool: name, input: { raw: String(raw ?? '').slice(0, 200) }, result, rejected: true });
    return result;
  }
  function run(name, input) {
    if (ACTIVITIES.has(name)) {
      if (a.hired) return W.startActivity(a, name);      // explains that this shift is sold; not an error to retry
      if (acted.activity) return `You already chose to ${acted.activity} this round.`;
      const err = W.startActivity(a, name);
      if (err) return no(err);
      acted.activity = name;
      if (input.reason) a.thought = String(input.reason).slice(0, 240);
      if (name === 'build_house') return `You work on your house this round (${a.building.done} of ${W.buildShifts} building shifts done before this one).`;
      return `You head to the ${CFG.TASKS[name].place} for this round's shift.`;
    }
    if (name === 'set_lifestyle') {
      const err = W.setLifestyle(a, input.level);
      if (err) return no(err);
      if (input.reason) a.thought = String(input.reason).slice(0, 240);
      return `From now on you eat ${a.lifestyle} food per meal.`;
    }
    if (name === 'place_order') {
      const g = GOOD_INDEX[input.good];
      if (g === undefined) return no(`Unknown good "${input.good}".`);
      const err = W.placeOrder(a, input.side, g, input.quantity, Math.round(input.price * 100), input.reason);
      if (err) return no(err);
      acted.orders++;
      return `Order posted: ${input.side} ${input.quantity} ${input.good} at ${Number(input.price).toFixed(2)}. It goes to this round's market.`;
    }
    if (name === 'borrow') {
      const pledge = GOODS.map(() => 0);
      pledge[WOOD] = Math.floor(input.wood ?? 0); pledge[NETS] = Math.floor(input.nets ?? 0);
      pledge[HOUSES] = Math.floor(input.houses ?? 0);
      const err = W.requestBorrow(a, Number(input.amount) * 100, pledge);
      if (err) return no(err);
      if (input.reason) a.thought = String(input.reason).slice(0, 240);
      const op = W.loanOps.at(-1);
      return `Loan requested: ${Number(input.amount).toFixed(2)} coins${op?.topUp ? ', added to your open loan (same due round)' : ` for ${op.termRounds} rounds (due at the end of round ${op.dueRound})`}. ` +
        `You can spend them now; the chain confirms when this round settles.`;
    }
    if (name === 'repay') {
      const err = W.requestRepay(a, Number(input.amount) * 100);
      return err ? no(err) : `Repayment of up to ${Number(input.amount).toFixed(2)} sent; it settles when this round settles.`;
    }
    if (name === 'check_market') return marketText();
    return no(`Unknown tool "${name}".`);
  }

  // structured view for the stub brain (the LLM gets observe() text instead)
  function view() {
    return {
      cash: a.cash, availCash: W.availCash(a), hunger: a.hunger, cold: a.cold,
      // free (sellable) goods; netsUsable and house count pledged ones too
      food: W.availGood(a, FOOD), wood: W.availGood(a, WOOD), nets: W.availGood(a, NETS), houses: W.sellable(a, HOUSES),
      netsUsable: W.usableNets(a), house: W.hasHouse(a), homes: W.homes(a), nextHouseWb: W.houseWb(W.homes(a) + 1),
      lifestyle: a.lifestyle, wellbeing: a.wellbeing,
      hired: !!a.hired, hands: a.hands, canSellLabour: W.sellable(a, LABOUR) >= 1,
      // a house under construction: shifts done (null = none), and the wood a new one takes
      building: a.building?.done ?? null, houseWood: W.houseWood(a),
      credit: W.bank.terms.ltvBps > 0, debtNow: W.debtNow(a),
      // share of what was offered that sold, last 5 rounds (1 when nothing was offered)
      sellThrough: Object.fromEntries(GOODS.map((g, i) => { const r = W.recentSales(i); return [g, r.offered ? Math.min(1, r.sold / r.offered) : 1]; })),
      prices: Object.fromEntries(GOODS.map((g, i) => [g, W.prices[i] / 100])),
      skills: a.skills, netWood: W.netWood(a), debt: a.debt, dueIn: W.roundsUntilDue(a),
      maxLoan: W.maxLoan(a, W.freePledge(a)),
      yields: { food: CFG.TASKS.gather_food.yield * W.skill(a, 'gather_food') * W.catch(), wood: CFG.TASKS.gather_wood.yield * W.skill(a, 'gather_wood') },
    };
  }

  // The round won't wait any longer: whatever this decision does from now on is refused.
  const close = () => { closed = true; };
  // Did the agent answer (a model reply, or any tool call)? A decision that errored out is not one.
  const answered = () => acted.answered || log.actions.length > 0;
  return { defs: TOOL_DEFS, exec, badCall, observe, view, acted, log, close, answered, signal: null };
}
