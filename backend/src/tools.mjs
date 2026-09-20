// The tools an agent can call. Both brains — the free stub and Claude — act ONLY
// through these, so swapping brains changes nothing else in the system.
import { CFG, GOODS, FOOD, WOOD, NETS, BOATS, HOUSES } from './config.mjs';
import { FIRE_SALE_BPS } from './chain.mjs';

const coins = c => (c / 100).toFixed(2);
const GOOD_INDEX = { food: FOOD, wood: WOOD, net: NETS, nets: NETS, house: HOUSES, houses: HOUSES };
const B = CFG.BANK, WB = CFG.WELLBEING, pct = x => Math.round(x * 100);
const H = CFG.TASKS.build_house, TERM = B.TERM_ROUNDS, MEAL = CFG.MEAL;
const NET_GAIN = pct(CFG.TASKS.gather_food.netYield / CFG.TASKS.gather_food.yield - 1);   // what a net adds to a catch, %
const NET_LIFE = Math.round(1 / CFG.NET_WEAR);                                            // fishing shifts a net lasts, on average
const rounds = n => `${n} round${n === 1 ? '' : 's'}`;
const pct100 = x => +(x * 100).toFixed(1);
const signed = x => `${x >= 0 ? '+' : ''}${+x.toFixed(1)}`;

const REASON = {
  type: 'object', additionalProperties: false, required: ['reason'],
  properties: { reason: { type: 'string', description: 'Why, in one short sentence, in your own voice.' } },
};

const ALL_TOOLS = [
  { name: 'gather_food',
    description: `Spend this round's shift fishing. Your catch depends on your fishing skill; a net adds ${NET_GAIN}%.`,
    input_schema: REASON },
  { name: 'gather_wood',
    description: 'Spend this round\'s shift cutting wood. How much you cut depends on your woodcutting skill.',
    input_schema: REASON },
  { name: 'craft_net',
    description: 'Spend this round\'s shift crafting a fishing net from wood (how much wood depends on your crafting skill).',
    input_schema: REASON },
  { name: 'build_house',
    description: `Spend this round's shift building a house. A house takes ${H.wood} wood, the same for everyone, paid for as it goes up: ` +
      `the wood is spread evenly over the building shifts you need, so you can start with one shift's materials. ` +
      `It takes ${Math.ceil(H.shifts / CFG.BUILD_CLAMP[1])} to ${Math.ceil(H.shifts / CFG.BUILD_CLAMP[0])} building shifts, depending on your crafting skill ` +
      `(your situation says how many for you). You can do other work in between and call build_house again to continue. ` +
      `Only one build at a time, but you may own and sell as many finished houses as you like. ` +
      `An unfinished house gives nothing, and cannot be sold or pledged.`,
    input_schema: REASON },
  { name: 'set_lifestyle',
    description: `Choose how many helpings you eat at every meal (one a round) from now on: 1, 2 or 3, each ${MEAL} food ` +
      `(${signed(WB.EAT[1])}, ${signed(WB.EAT[2])}, ${signed(WB.EAT[3])} wellbeing; a meal with no food gives ${WB.EAT[0]}). ` +
      `With less food than that you eat what you have, and part of a helping counts in proportion. This does not use up your shift.`,
    input_schema: {
      type: 'object', additionalProperties: false, required: ['level', 'reason'],
      properties: {
        level:  { type: 'integer', enum: [1, 2, 3], description: `helpings of ${MEAL} food per meal` },
        reason: REASON.properties.reason,
      },
    } },
  { name: 'place_order',
    description: 'Post a limit order to this round\'s market: a buy names the most you will pay per unit, a sell the least you will take. ' +
      'Lower asks sell first and higher bids buy first; everyone who trades a good gets the same clearing price. Unfilled orders expire after the round. ' +
      'You may place several orders, but not a buy and a sell of the same good that would trade with each other. Only finished houses can be sold.',
    input_schema: {
      type: 'object', additionalProperties: false,
      required: ['side', 'good', 'quantity', 'price'],
      properties: {
        side:     { type: 'string', enum: ['buy', 'sell'] },
        good:     { type: 'string', enum: ['food', 'wood', 'net', 'house'] },
        quantity: { type: 'integer', minimum: 1 },
        price:    { type: 'number', description: 'coins per unit' },
        reason:   { type: 'string', description: 'Optional: why this price, in a few words.' },
      },
    } },
  { name: 'set_sale',
    description: 'Your market stall: a STANDING instruction that works every round until you change it. Whatever you hold of the good above `keep` is offered for sale at `min_price` or better, automatically — ' +
      'you do not need to place sell orders yourself. The stall prices itself: it asks the going price, marks down 7% each round nothing sells and up 5% when it sells out, never below min_price (your floor). Raise keep to hold more back. ' +
'Set stop=true to stop selling that good.',
    input_schema: {
      type: 'object', additionalProperties: false, required: ['good', 'keep', 'min_price'],
      properties: {
        good:      { type: 'string', enum: ['food', 'wood', 'net', 'house'] },
        keep:      { type: 'integer', minimum: 0, description: 'units you never sell (your own reserve)' },
        min_price: { type: 'number', description: 'the least you will take per unit, in coins' },
        stop:      { type: 'boolean', description: 'true = stop selling this good' },
      },
    } },
  { name: 'set_buy',
    description: 'Your shopping list: a STANDING instruction that works every round until you change it. Whenever you hold less than `target` of the good, you automatically bid for the difference at up to `max_price` ' +
      '(as far as your free cash goes). It prices itself: it bids the going price, 7% more each round it gets nothing, a little less when it gets everything, never above max_price (your ceiling). Raise target to hold a bigger reserve; ' +
      'target 0 stops buying. Keep target at or below your stall\'s keep for the same good. For food, wood and nets.',
    input_schema: {
      type: 'object', additionalProperties: false, required: ['good', 'target', 'max_price'],
      properties: {
        good:      { type: 'string', enum: ['food', 'wood', 'net'] },
        target:    { type: 'integer', minimum: 0, description: 'the stock you want to hold' },
        max_price: { type: 'number', description: 'the most you will pay per unit, in coins' },
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
  const acted = { activity: null, orders: 0, failed: false, answered: false };
  const log = { saw: null, actions: [] };      // written to the run log after each decision
  let closed = false;                           // the round has moved on: a late answer changes nothing

  const lvl = ls => ls.map(([p, q]) => `${coins(p)}×${q}`).join(' · ');

  // One line per good: the price, what was offered / wanted / sold last round, the best asks and bids.
  // A good with no orders that the agent holds none of is left out.
  function marketText() {
    const lines = GOODS.map((g, i) => {
      const now = W.prices[i];
      // No trend suffix: " (+8% over 5 rounds)" is a momentum cue in a market priced off
      // quotes, and bids walked up in lockstep with it.
      // Nothing that has never sold has a price — "reference price 25.00" invents one, and
      // that invented net price anchored a quarter of the village's net bids at a third of
      // what a net is worth to a fisher (it also used to back a third of the village's
      // credit). What it costs to make is the only honest anchor until one changes hands —
      // houses open at that cost (START_PRICES) for collateral, and are still never shown it.
      const make = i === NETS ? ` — a net takes ${W.netWood(a)} wood and a shift`
        : i === HOUSES ? ` — a house takes ${W.houseWood(a)} wood and ${W.buildShiftsFor(a)} building shifts` : '';
      const price = W.traded(i) ? `last price ${coins(now)}`
        : make ? `no trades yet${make}` : `reference price ${coins(now)}`;
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
    const F = CFG.TASKS.gather_food, sk = t => +W.skill(a, t).toFixed(2), n1 = x => +x.toFixed(1);
    const nets = W.usableNets(a);
    const now = W.round + 1;                     // the round being decided
    const P = W.prices, c = x => coins(Math.round(x));
    // what one shift of each job yields for this agent, and what that is worth at last prices
    const noNet = F.yield * sk('gather_food') * W.catch(), withNet = F.netYield * sk('gather_food') * W.catch();
    const fish = nets ? withNet : noNet, cut = CFG.TASKS.gather_wood.yield * sk('gather_wood');
    const wood = W.availGood(a, WOOD), food = W.availGood(a, FOOD), houses = W.houses(a);
    const rot = (a.rotted ?? []).map((q, g) => q ? `${q} ${GOODS[g]}` : '').filter(Boolean).join(' and ');
    // every job in one unit: coins a shift (world.mjs jobValues), and how much of it can be counted on
    const nw = W.netWood(a);
    const JV = W.jobValues(a), [fishCoins, cutCoins, craftCoins, buildCoins] = JV.map(j => j.raw), jobs = JV.map(j => j.sure);
    const through = W.through, sure = W.sure;
    const glut = (x, g) => through(g) < 0.6 ? ` — but only ${Math.round(through(g) * 100)}% of the ${GOODS[g]} offered lately found a buyer: count on ≈${c(sure(x, g))}, or ask less` : '';
    const best = Math.max(...jobs);
    const NAME = { gather_food: 'fishing', gather_wood: 'woodcutting', craft_net: 'crafting nets', build_house: 'building houses' };
    const ranked = [...JV].sort((x, y) => y.sure - x.sure).map((j, i) => `${i + 1}. ${NAME[j.task]} ≈${c(j.sure)}${j.can ? '' : ` (you are ${j.needs - wood} wood short)`}`).join('  ');

    // food held against food eaten: how much of it rots before it is eaten, at this lifestyle
    const perMeal = a.lifestyle * MEAL;
    let left = food, waste = 0;
    while (left >= MEAL) { left -= Math.min(a.lifestyle, Math.floor(left / MEAL)) * MEAL; const r = CFG.SPOIL[FOOD] * left; waste += r; left -= r; }
    const meals = Math.floor(food / MEAL);
    // One helping is enough to say so: at the old two-helpings-and-a-third threshold the
    // forecast fired 14 times in 2,970 turns while 7,046 food rotted.
    const rotTxt = waste >= MEAL ? ` About ${Math.round(waste)} of it will rot before you eat it.` : '';

    // Unfilled bids for something this agent can make: what making one to SELL would earn.
    // The net and house lines only ever said what one does for YOU, so a crafting specialist
    // who barely fishes read "a net is worthless" — 562 net bids, 1 ask, 0 trades in 112 rounds.
    const wantedBy = i => {
      const L = CFG.LADDER ? W.lastLadder?.[i] : null, b = W.lastBook?.[i];
      const want = L ? L.wanted : b?.bidQty ?? 0, top = L ? L.bids.top[0]?.[0] : b?.bestBid;
      if (!want || !top) return '';
      const off = L ? L.offered : b ? b.askQty : 0;
      return ` Wanted: ${want} bid for, up to ${coins(top)}, ${off ? `${off} offered` : 'none offered'}.`;
    };
    const netWant = wantedBy(NETS);
    const netFood = (F.netYield - F.yield) * sk('gather_food') * W.catch() * NET_LIFE;   // extra catch over a net's life, for this agent

    const parts = w => ['eating', 'warmth', 'house'].map(k => `${k} ${signed(w[k])}`).join(', ');
    const recent = a.wbRecent.reduce((s, r) => { for (const k in s) s[k] += r[k]; return s; }, { eating: 0, warmth: 0, house: 0 });

    // houses: what you have, what the next one adds (sized against a second helping of food, the
    // other standing way to spend on wellbeing), and what it costs you to build against the market
    const hw = W.houseWood(a), bs = W.buildShiftsFor(a), tw = W.trancheWood(a), U = CFG.HOUSE_UPKEEP;
    const unpaid = houses - a.upkeepPaid;
    const nextWb = W.houseAdds(houses + 1), buildCost = hw * P[WOOD] + bs * Math.max(jobs[0], jobs[1], jobs[2]);
    // a house for someone who would rather buy than build: what is on offer, or how to ask for one
    const HL = W.lastLadder?.[HOUSES], offer = HL?.asks.top[0];
    const buyTxt = a.building ? '' : ` To buy instead: ${offer ? `one was offered at ${coins(offer[0])} last round` : 'none is on offer yet — post a bid (buy house) at what it is worth to you, so builders see a buyer'}` +
      `${a.cash >= 0.6 * W.fetch(HOUSES) ? `; your ${coins(a.cash)} coins give you nothing until they are spent` : ''}.`;
    const ownTxt = houses ? `You own ${houses} house${houses > 1 ? 's' : ''}: ${signed(W.houseWB(houses))} wellbeing a round for ${houses * U} wood upkeep` +
      (unpaid > 0 ? `, but you couldn't pay upkeep on ${unpaid} last round, so ${unpaid === 1 ? 'it' : 'they'} paid nothing` : '') + '. ' : '';
    const houseTxt = ownTxt + (a.building
      ? `Your unfinished house: ${a.building.shifts} building shift${a.building.shifts === 1 ? '' : 's'} done, ${W.buildShiftsLeft(a)} to go (build_house continues it; the next shift uses ${tw} wood, you have ${wood}${HL?.wanted ? `; ${HL.wanted} buyer${HL.wanted > 1 ? 's' : ''} bid up to ${coins(W.fetch(HOUSES))} for a house last round` : ''}).`
      : `${houses ? 'Another' : 'A'} house would add ${signed(nextWb)} wellbeing every round (a second helping of food adds ${signed(WB.EAT[2] - WB.EAT[1])}), for ${U} wood upkeep. ` +
        `To build one yourself: ${bs} building shifts at your crafting skill and ${hw} wood in all, paid as you build — the first shift uses ${tw} (you have ${wood}); ` +
        `≈${c(buildCost)} coins of wood and lost work; ${W.traded(HOUSES) ? `houses last sold at ${coins(P[HOUSES])}` : 'no house has been sold yet'}.${buyTxt}`);

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
      `You eat ${a.lifestyle} helping${a.lifestyle === 1 ? '' : 's'} of ${MEAL} food a round (1 helping ${signed(WB.EAT[1])}, 2 ${signed(WB.EAT[2])}, 3 ${signed(WB.EAT[3])}, none ${WB.EAT[0]}) ` +
        `and hold ${food} food: ${meals} helping${meals === 1 ? '' : 's'}.${rotTxt}`,
      `What one shift of yours is worth, in coins at the market:\n` +
        `- fishing: ${n1(fish)} food ≈ ${c(fishCoins)} (skill x${sk('gather_food')}${nets ? ', with your net' : ', no net'})${glut(fishCoins, FOOD)}\n` +
        `- woodcutting: ${n1(cut)} wood ≈ ${c(cutCoins)} (x${sk('gather_wood')})${glut(cutCoins, WOOD)}\n` +
        `- crafting a net: ${nw} wood (≈${c(nw * P[WOOD])}) becomes a net that fetches ≈${coins(W.fetch(NETS))} → ≈${c(craftCoins)} (crafting x${sk('craft_net')})${glut(craftCoins, NETS)}\n` +
        `- building to sell: ${bs} shifts and ${hw} wood in all (≈${c(hw * P[WOOD])}; the next shift uses ${tw}, you have ${wood}) become a house that fetches ≈${coins(W.fetch(HOUSES))} → ≈${c(buildCoins)} a shift${glut(buildCoins, HOUSES)}${HL?.wanted ? ` (${HL.wanted} buyer${HL.wanted > 1 ? 's' : ''} bid for a house last round${HL.sold ? '' : ' and got none'})` : ''}\n` +
        `Ranked by what you can count on: ${ranked}.`,
      // What a net is worth to its BUYER, in coins: the observation never said, the median net
      // bid sat at 18.00 all run against a ~45-coin cost, and 907 bids met 4 asks and no trade.
      // A net you own still matters if others are bidding for one: that is the crafter's trade.
      `A net adds ${NET_GAIN}% to a fisher's catch and lasts about ${NET_LIFE} fishing shifts` +
        (nets ? ' (you have one)' : `: for you about ${Math.round(netFood)} more food in all (≈${coins(netFood * W.prices[FOOD])} at the last food price)`) +
        `. Making one costs you ${nw} wood (crafting x${sk('craft_net')}) and a shift; nets can be bought and sold.` + netWant,
      houseTxt,
      `Cash: ${coins(a.cash)} coins. You hold: ${GOODS.map((g, i) => i === BOATS || (i > WOOD && !W.owned(a, i)) ? '' : `${g} ${W.owned(a, i)}${a.locked[i] ? ` (${a.locked[i]} pledged)` : ''}`).filter(Boolean).join(', ')}.`,
      `Your stall (works every round on its own — leave it alone unless prices have moved; set_sale changes it): ` + (a.sale.some(Boolean)
        ? a.sale.map((pl, g) => !pl ? '' : `${GOODS[g]} above ${pl.keep}, asking ${coins(pl.ask)} now (floor ${coins(pl.min)})`).filter(Boolean).join('; ') + '.'
        : 'nothing on sale.'),
      `Your shopping list (works every round on its own; set_buy changes it): ` + (a.shop.some(Boolean)
        ? a.shop.map((pl, g) => pl ? `${GOODS[g]} up to a stock of ${pl.target}, bidding ${coins(pl.bid)} now (ceiling ${coins(pl.max)})` : '').filter(Boolean).join('; ') + '.'
        : 'nothing.'),
      loanTxt,
      a.hunger ? `You are hungry: ${a.hunger} missed meal${a.hunger === 1 ? '' : 's'} in a row.` : '',
      a.cold ? `You are cold: ${a.cold} missed fire${a.cold === 1 ? '' : 's'} in a row (a fire burns ${CFG.FIRE_WOOD} wood every ${CFG.WARM_ROUNDS === 1 ? 'round' : rounds(CFG.WARM_ROUNDS)}).` : '',
      rot ? `Since your last turn: ${rot} rotted.` : '',
      `Market (round ${W.round}):\n${marketText()}`,
      a.fills ? `Your orders in round ${a.fills.round}:\n- ${a.fills.lines.join('\n- ')}` : '',
      a.memory.length ? `Recently:\n- ${a.memory.join('\n- ')}` : '',
      // No "set your lifestyle": naming it here took set_lifestyle to 2,913 calls in 2,970
      // decisions, of which 239 changed anything. The payoffs are in the eating line above.
      `This round: post any market orders${credit ? ', borrow or repay' : ''}, and choose your shift.`,
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
      if (acted.activity) return `You already chose to ${acted.activity} this round.`;
      const err = W.startActivity(a, name);
      if (err) return no(err);
      acted.activity = name;
      if (a.note) { const note = a.note; a.note = null; acted.activity = a.activity.task; if (input.reason) a.thought = String(input.reason).slice(0, 240); return note; }
      if (input.reason) a.thought = String(input.reason).slice(0, 240);
      // The turn stays open after a shift (see the brains): say so, or a model that answers
      // one call at a time never posts an order.
      const still = ` Your shift is set. You can still post market orders${W.bank.terms.ltvBps > 0 ? ', borrow or repay' : ''} this round.`;
      if (name === 'build_house') return `You work on your house this round (${W.buildShiftsLeft(a)} building shifts to go, this one included).${still}`;
      return `You head to the ${CFG.TASKS[name].place} for this round's shift.${still}`;
    }
    if (name === 'set_lifestyle') {
      const err = W.setLifestyle(a, input.level);
      if (err) return no(err);
      if (input.reason) a.thought = String(input.reason).slice(0, 240);
      return `From now on you eat ${a.lifestyle} helping${a.lifestyle === 1 ? '' : 's'} of ${MEAL} food per meal.`;
    }
    if (name === 'set_sale') {
      const g = GOOD_INDEX[input.good];
      if (g === undefined) return no(`Unknown good "${input.good}".`);
      if (input.stop) { W.stopSale(a, g); return `Your stall no longer sells ${GOODS[g]}.`; }
      const err = W.setSale(a, g, input.keep, Number(input.min_price) * 100);
      if (err) return no(err);
      return `From now on your stall offers all your ${GOODS[g]} above ${Math.floor(input.keep)} at ${Number(input.min_price).toFixed(2)} or better, every round.`;
    }
    if (name === 'set_buy') {
      const g = GOOD_INDEX[input.good];
      if (g === undefined) return no(`Unknown good "${input.good}".`);
      const err = W.setBuy(a, g, input.target, Number(input.max_price) * 100);
      if (err) return no(err);
      return Math.floor(input.target) ? `From now on you bid every round for whatever ${GOODS[g]} you hold short of ${Math.floor(input.target)}, at up to ${Number(input.max_price).toFixed(2)}.`
        : `Your shopping list no longer buys ${GOODS[g]}.`;
    }
    if (name === 'place_order') {
      const g = GOOD_INDEX[input.good];
      if (g === undefined) return no(`Unknown good "${input.good}".`);
      const err = W.placeOrder(a, input.side, g, input.quantity, Math.round(input.price * 100), input.reason);
      if (err) return no(err);
      acted.orders++;
      const posted = a.draft?.at(-1);
      if (g === HOUSES && input.side === 'buy' && posted && posted.limit < Math.round(input.price * 100))
        return `You have ${coins(a.cash)} coins, so your bid for a house was posted at ${coins(posted.limit)}. It holds none of your cash back.`;
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
      netsUsable: W.usableNets(a), house: W.hasHouse(a), homes: W.houses(a), nextHouseWb: W.houseAdds(W.houses(a) + 1),
      lifestyle: a.lifestyle, wellbeing: a.wellbeing,
      // a house under construction: shifts worked on it (null = none), the shifts one still
      // takes (a fresh house when there is none), the wood a whole one takes and the next shift's share
      building: a.building?.shifts ?? null, buildShifts: W.buildShiftsLeft(a), houseWood: W.houseWood(a), trancheWood: W.trancheWood(a),
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
