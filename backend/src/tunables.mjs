// Every dial the control panel can pull, in one declarative list.
//
// The simulation already reads CFG on every round, so changing a value here changes the
// village from the next round on: no restart, no new ledger. A dial marked `live: false`
// is baked into the chain (the bank's terms) or into each villager at birth (endowments,
// talents), so it only takes effect on the next run — the panel says so rather than
// pretending.
//
// Disasters are not a feature: a bad fishing season IS `CATCH` at 0.3, a blight IS food
// spoilage at 0.4, a cold snap IS a fire that burns three times the wood. Pull the dial
// and watch the market answer.
//
// The ground rule from CONTEXT.md §9 holds: change the economics or fix the information,
// never steer the result. So every change is announced to the villagers as a plain fact
// ("the fishing has changed: ..."), never as advice, and every number they are shown —
// what a shift yields, what a house costs, what interest costs a round — is read live from
// CFG, so what they are told is always what the simulation does.
import { CFG } from './config.mjs';

// Bumped on every change. Anything that caches a string built out of CFG — the system
// prompt, the tool descriptions — memoizes on this and rebuilds when it moves, so prompt
// caching survives the rounds between changes.
export let REV = 0;

const walk = path => {
  const ks = path.split('.');
  let o = CFG;
  for (const k of ks.slice(0, -1)) o = o[k];
  return [o, ks.at(-1)];
};
export const getVal = path => { const [o, k] = walk(path); return o[k]; };
const setVal = (path, v) => { const [o, k] = walk(path); o[k] = v; };   // always a leaf: object identities never change

const pctFmt = v => `${+(v * 100).toFixed(1)}%`;
// A rate small enough that one decimal place of a percent would round it away.
const ratePct = v => `${+(v * 100).toFixed(2)}%`;
const x = v => `${+v.toFixed(2)}×`;
const n = v => String(+v.toFixed(2));

// key is the path into CFG and the id the panel posts back.
// min/max/step size the slider; int snaps it to whole numbers; bool makes it a switch.
// live:false = takes effect on the next run (on-chain terms, or what each villager is born with).
export const TUNABLES = [
  // ---- nature and production: what a shift of work brings in ----------------------
  { key: 'CATCH', group: 'nature', label: 'fishing conditions', min: 0, max: 2, step: 0.05, fmt: x,
    help: 'Multiplies every catch. Under 1 is a bad season; 0 is a dead sea. The famine dial.',
    say: (a, b) => `The fishing has changed: every catch is now ${x(b)} what the water used to give (it was ${x(a)}).` },
  { key: 'TASKS.gather_food.yield', group: 'nature', label: 'food a fishing shift catches', min: 0, max: 30, step: 1, int: true,
    help: 'Before skill, conditions and nets. The village needs about MEAL × lifestyle per head per round.' },
  { key: 'TASKS.gather_food.netYield', group: 'nature', label: 'food a fishing shift catches with a net', min: 0, max: 60, step: 1, int: true,
    help: 'What a net is for. Set it equal to the plain yield and nets become worthless.' },
  { key: 'TASKS.gather_wood.yield', group: 'nature', label: 'wood a cutting shift brings', min: 0, max: 30, step: 1, int: true,
    help: 'Wood feeds fires, nets, houses and their upkeep. Cut it and everything downstream gets dearer.',
    say: (a, b) => `The forest has changed: a cutting shift now brings ${b} wood before skill, where it brought ${a}.` },
  { key: 'TASKS.craft_net.wood', group: 'nature', label: 'wood a net costs', min: 1, max: 80, step: 1, int: true,
    help: 'Divided by the crafter\'s skill (clamped). Raising it prices fishers out of nets.' },
  { key: 'TASKS.build_house.wood', group: 'nature', label: 'wood a house costs', min: 1, max: 300, step: 5, int: true,
    help: 'The same for everyone, paid as the house goes up. The village\'s biggest single demand for wood.' },
  { key: 'TASKS.build_house.shifts', group: 'nature', label: 'shifts a house takes', min: 1, max: 12, step: 1, int: true,
    help: 'At crafting skill 1.0; a 2.0 crafter halves it. Longer builds mean more time between spending and payback, which is what credit is for.' },
  { key: 'NET_WEAR', group: 'nature', label: 'chance a net tears per fishing shift', min: 0, max: 0.5, step: 0.01, fmt: pctFmt,
    help: 'Nets are the village\'s wearing capital. At 0 they last forever and crafting dies after everyone owns one.' },
  { key: 'LEARN', group: 'nature', label: 'learning by doing, per shift', min: 0, max: 0.03, step: 0.001, fmt: pctFmt,
    help: 'Every shift worked makes that villager this much better at that job. This is where output per head grows.' },
  { key: 'LEARN_CAP', group: 'nature', label: 'learning ceiling', min: 1, max: 4, step: 0.1, fmt: x,
    help: 'How far above their birth talent anyone can get.' },

  // ---- spoilage: the reason to sell a surplus rather than hoard it ----------------
  { key: 'SPOIL.0', group: 'spoilage', label: 'food that rots each round', min: 0, max: 0.6, step: 0.01, fmt: pctFmt,
    help: 'Of every villager\'s free (unsold, unpledged) food. The blight dial: push it up and a full larder stops being safety.',
    say: (a, b) => `Food is keeping ${b > a ? 'worse' : 'better'} than it did: ${pctFmt(b)} of what is not sold or pledged now spoils each round, where it was ${pctFmt(a)}.` },
  { key: 'SPOIL.1', group: 'spoilage', label: 'wood that rots each round', min: 0, max: 0.6, step: 0.01, fmt: pctFmt,
    help: 'Normally 0. Raise it and stockpiling firewood stops working: a damp winter.' },
  { key: 'SPOIL.2', group: 'spoilage', label: 'nets lost each round', min: 0, max: 0.4, step: 0.01, fmt: pctFmt,
    help: 'On top of tearing while fishing. A storm on the drying racks.' },
  { key: 'SPOIL.4', group: 'spoilage', label: 'houses lost each round', min: 0, max: 0.2, step: 0.005, fmt: pctFmt,
    help: 'The hurricane dial. Finished houses only: a half-built one is never taken. Destroys the village\'s savings and its collateral at once.',
    say: (a, b) => b > a ? `Houses are standing badly: about ${pctFmt(b)} of the village\'s finished houses are being lost each round.`
                         : `Houses are standing better again: ${pctFmt(b)} lost each round, where it was ${pctFmt(a)}.` },

  // ---- what people need: the demand side -----------------------------------------
  { key: 'MEAL', group: 'needs', label: 'food in one helping', min: 1, max: 20, step: 1, int: true,
    help: 'A villager eats lifestyle × this every round. Raising it raises the whole village\'s food demand at a stroke.',
    say: (a, b) => `A helping is now ${b} food, where it was ${a}: every meal you eat takes that much more or less.` },
  { key: 'FIRE_WOOD', group: 'needs', label: 'wood a fire burns', min: 0, max: 15, step: 1, int: true,
    help: 'Each time the fire is fed. The cold-snap dial.',
    say: (a, b) => `The cold has changed: a fire now takes ${b} wood each time it is fed, where it took ${a}.` },
  { key: 'WARM_ROUNDS', group: 'needs', label: 'rounds between fires', min: 1, max: 10, step: 1, int: true,
    help: '1 = a fire every round. Raising it makes warmth cheap.' },
  { key: 'HOUSE_UPKEEP', group: 'needs', label: 'wood a house needs each round', min: 0, max: 10, step: 1, int: true,
    help: 'Unpaid upkeep means the house pays nothing that round. Raise it and houses stop being worth owning.',
    say: (a, b) => `Upkeep has changed: every house you own now wants ${b} wood a round, where it wanted ${a}. A house you cannot keep up gives you nothing.` },
  { key: 'LIFESTYLE_START', group: 'needs', label: 'lifestyle villagers start on', min: 1, max: 3, step: 1, int: true, live: false,
    help: 'Helpings per meal until a villager sets its own.' },

  // ---- wellbeing: the goal, and therefore what everything is worth -----------------
  { key: 'WELLBEING.EAT.0', group: 'wellbeing', label: 'a missed meal', min: -6, max: 0, step: 0.1, fmt: n,
    help: 'What going hungry costs. The whole reason food comes first.' },
  { key: 'WELLBEING.EAT.1', group: 'wellbeing', label: 'eating one helping', min: 0, max: 4, step: 0.1, fmt: n },
  { key: 'WELLBEING.EAT.2', group: 'wellbeing', label: 'eating two helpings', min: 0, max: 4, step: 0.1, fmt: n,
    help: 'The gap to one helping is what a second helping is worth, and what it competes with a house for.' },
  { key: 'WELLBEING.EAT.3', group: 'wellbeing', label: 'eating three helpings', min: 0, max: 4, step: 0.1, fmt: n },
  { key: 'WELLBEING.WARM', group: 'wellbeing', label: 'being warm', min: 0, max: 4, step: 0.1, fmt: n },
  { key: 'WELLBEING.COLD', group: 'wellbeing', label: 'going cold', min: -6, max: 0, step: 0.1, fmt: n },
  { key: 'WELLBEING.HOUSE.0', group: 'wellbeing', label: 'your first house', min: 0, max: 6, step: 0.1, fmt: n,
    help: 'Per round, while its upkeep is paid. This is what a house is worth, and so what anyone will pay for one.' },
  { key: 'WELLBEING.HOUSE.1', group: 'wellbeing', label: 'your second house', min: 0, max: 6, step: 0.1, fmt: n,
    help: 'Diminishing but never zero: there is always something more worth buying, so the rich keep spending.' },

  // ---- the market: how prices find their level ------------------------------------
  { key: 'REPRICE.up', group: 'market', label: 'mark-up when a stall sells out', min: 0, max: 0.3, step: 0.01, fmt: pctFmt,
    help: 'How fast sellers raise their asks when everything goes.' },
  { key: 'REPRICE.down', group: 'market', label: 'mark-down when a stall sells nothing', min: 0, max: 0.3, step: 0.01, fmt: pctFmt,
    help: 'How fast sellers cut when nothing goes. Below the mark-up, prices ratchet.' },
  { key: 'REPRICE.band', group: 'market', label: 'how far a stall may ask above the last traded price', min: 1, max: 3, step: 0.05, fmt: x,
    help: 'The leash on the price ratchet. Widen it and a shortage can run away; 1.00 pins asks to the going rate.' },
  { key: 'BANK_SALE_STEP', group: 'market', label: 'the bank cuts a seized good by, each unsold round', min: 0, max: 0.3, step: 0.01, fmt: pctFmt,
    help: 'A fire sale descends from the last price until someone takes it, never below book value.' },
  { key: 'LADDER', group: 'market', label: 'show villagers the depth ladder', bool: true,
    help: 'On: they see the top few levels a side, what was offered and what sold. Off: best bid and cheapest ask only, and prices stop responding to a glut.' },

  // ---- the bank ------------------------------------------------------------------
  { key: 'BANK.CREDIT', group: 'bank', label: 'credit', bool: true,
    help: 'Off: the bank lends nothing and the borrow and repay tools disappear. The only way new coins are ever made, so off means a fixed money supply.',
    say: (a, b) => b ? 'The bank is lending again.' : 'The bank has stopped lending: no new loans until further notice.' },
  { key: 'BANK.LTV', group: 'bank', label: 'loan-to-value', min: 0, max: 0.95, step: 0.05, fmt: pctFmt,
    help: 'The most you may owe against what you pledge, at last prices. Tightening it mid-run is a credit crunch. It can only tighten inside the ceiling the ledger was created with (LTV ceiling, below).',
    say: (a, b) => `The bank has changed its terms: a loan may now be at most ${pctFmt(b)} of what you pledge, where it was ${pctFmt(a)}.` },
  { key: 'BANK.TERM_ROUNDS', group: 'bank', label: 'rounds a loan runs', min: 2, max: 120, step: 1, int: true,
    help: 'New loans only; loans already out keep the round they were promised.',
    say: (a, b) => `The bank is writing new loans over ${b} rounds now, where it wrote them over ${a}.` },
  { key: 'BANK.RATE_PER_ROUND', group: 'bank', label: 'interest, per round held', min: 0, max: 0.05, step: 0.0005, fmt: ratePct, live: false,
    help: 'What a loan costs to hold for one round, on the principal. A round is the village\'s unit of time, so the cost of credit is a cost per round: running the simulation faster no longer makes borrowing cheaper. The chain counts slots, so it is sent as this rate over one round\'s worth of them. Fixed on the ledger at creation: changing it mid-run needs a set_terms instruction in lib.rs, so this applies to the next run.' },
  { key: 'BANK.LTV_CEILING', group: 'bank', label: 'LTV ceiling written into the ledger', min: 0, max: 0.95, step: 0.05, fmt: pctFmt, live: false,
    help: 'The hard limit the Solana program enforces for the life of the ledger. The live LTV dial tightens inside it and is enforced off-chain; set the two equal for a run where the chain alone decides.' },
  { key: 'BANK.KAPPA', group: 'bank', label: 'capital ratio', min: 0.01, max: 1, step: 0.01, fmt: pctFmt, live: false,
    help: 'All loans together may not exceed equity ÷ this. Defaults eat equity, which tightens lending for everyone.' },
  { key: 'BANK.PENALTY', group: 'bank', label: 'foreclosure penalty', min: 0, max: 1, step: 0.05, fmt: pctFmt, live: false },
  { key: 'BANK.SEED', group: 'bank', label: 'the bank\'s opening capital', min: 0, max: 1, step: 0.01, fmt: pctFmt, live: false,
    help: 'As a share of the starting money supply.' },
  { key: 'BANK.EQUITY_FLOOR', group: 'bank', label: 'capital floor before a dividend', min: 0, max: 1, step: 0.01, fmt: pctFmt, live: false },

  // ---- the clock -----------------------------------------------------------------
  { key: 'DECIDE_TIMEOUT_MS', group: 'clock', label: 'how long a round waits for the slowest villager', min: 1000, max: 30000, step: 500, int: true,
    fmt: v => `${(v / 1000).toFixed(1)}s`,
    help: 'A villager who does not answer keeps its last job and posts no new orders.' },
  { key: 'DECIDE_QUORUM', group: 'clock', label: 'villagers a round waits for before it starts', min: 0.1, max: 1, step: 0.05, fmt: pctFmt,
    help: 'Once this share of the village has answered, the round runs. The rest are left behind exactly as if they had run out of time: they keep their last job and post no new orders. 100% waits for everyone, as it used to. The last tenth of a village is usually the slow tenth, so lowering this is the single quickest way to shorten a round.' },

  // ---- what the village is born with: next run only -------------------------------
  { key: 'AGENTS', group: 'start', label: 'villagers', min: 2, max: 137, step: 1, int: true, live: false,
    help: 'The ledger holds at most 137 slots (the 10 KiB cap on an account created by CPI).' },
  { key: 'START_CASH', group: 'start', label: 'coins each villager starts with', min: 0, max: 50000, step: 500, int: true, live: false,
    fmt: v => (v / 100).toFixed(2) },
  { key: 'START_FOOD', group: 'start', label: 'food each villager starts with', min: 0, max: 200, step: 5, int: true, live: false },
  { key: 'START_WOOD', group: 'start', label: 'wood each villager starts with', min: 0, max: 200, step: 5, int: true, live: false },
  { key: 'SEED', group: 'start', label: 'random seed', min: 1, max: 99999, step: 1, int: true, live: false,
    help: 'Same seed, same names, talents and dice. Change it for a different village.' },
  { key: 'START_PRICES.0', group: 'start', label: 'opening price of food', min: 1, max: 2000, step: 10, int: true, live: false,
    fmt: v => (v / 100).toFixed(2), help: 'Also the fixed price real GDP is measured at.' },
  { key: 'START_PRICES.1', group: 'start', label: 'opening price of wood', min: 1, max: 2000, step: 10, int: true, live: false, fmt: v => (v / 100).toFixed(2) },
  { key: 'START_PRICES.2', group: 'start', label: 'opening price of a net', min: 1, max: 20000, step: 100, int: true, live: false, fmt: v => (v / 100).toFixed(2) },
  { key: 'START_PRICES.4', group: 'start', label: 'opening price of a house', min: 1, max: 60000, step: 500, int: true, live: false, fmt: v => (v / 100).toFixed(2) },
  { key: 'STALL.0.keep', group: 'start', label: 'food a stall holds back', min: 0, max: 60, step: 1, int: true, live: false,
    help: 'What does NOT go to market. Small reserves mean a specialist\'s whole surplus is on sale every round.' },
  { key: 'STALL.1.keep', group: 'start', label: 'wood a stall holds back', min: 0, max: 60, step: 1, int: true, live: false },
  { key: 'SHOP.0.target', group: 'start', label: 'food a shopping list keeps topped up', min: 0, max: 60, step: 1, int: true, live: false },
  { key: 'SHOP.1.target', group: 'start', label: 'wood a shopping list keeps topped up', min: 0, max: 60, step: 1, int: true, live: false },
];

export const GROUPS = [
  { id: 'nature',    title: 'nature & production', blurb: 'what a shift of work brings in' },
  { id: 'spoilage',  title: 'spoilage',            blurb: 'what the village loses every round whether it sells or not' },
  { id: 'needs',     title: 'needs',               blurb: 'what people must eat, burn and keep up' },
  { id: 'wellbeing', title: 'wellbeing',           blurb: 'the goal, and so what everything is worth' },
  { id: 'market',    title: 'the market',          blurb: 'how fast prices find their level' },
  { id: 'bank',      title: 'the bank',            blurb: 'credit, and the only way new coins are made' },
  { id: 'clock',     title: 'the clock',           blurb: '' },
  { id: 'start',     title: 'the village at birth', blurb: 'baked into each villager and into the ledger: these take effect on the next run' },
];

const BY_KEY = new Map(TUNABLES.map(t => [t.key, t]));

// A bundle of dials pulled together. Nothing here is a special mechanism — each preset is
// exactly the slider positions it lists, which is the point: a disaster is a number.
export const PRESETS = [
  { id: 'baseline', label: 'baseline', note: 'everything back to the config defaults',
    set: () => Object.fromEntries(TUNABLES.filter(t => t.live !== false).map(t => [t.key, DEFAULTS[t.key]])) },
  { id: 'famine', label: 'bad fishing season', note: 'the lake gives a third of what it did',
    set: () => ({ CATCH: 0.35 }) },
  { id: 'blight', label: 'blight', note: 'food rots four times as fast, so a full larder is no longer safety',
    set: () => ({ 'SPOIL.0': 0.4 }) },
  { id: 'coldsnap', label: 'cold snap', note: 'fires burn three times the wood',
    set: () => ({ FIRE_WOOD: 9 }) },
  { id: 'forestfire', label: 'forest fire', note: 'a cutting shift brings a third of the wood',
    set: () => ({ 'TASKS.gather_wood.yield': 4 }) },
  { id: 'hurricane', label: 'hurricane', note: 'houses and nets start being lost every round',
    set: () => ({ 'SPOIL.4': 0.03, 'SPOIL.2': 0.08 }) },
  { id: 'crunch', label: 'credit crunch', note: 'the bank stops lending',
    set: () => ({ 'BANK.CREDIT': false }) },
  { id: 'easy', label: 'easy money', note: 'lend against almost the whole value of a pledge',
    set: () => ({ 'BANK.CREDIT': true, 'BANK.LTV': 0.9 }) },
  { id: 'boom', label: 'good season', note: 'the water is generous and the forest thick',
    set: () => ({ CATCH: 1.5, 'TASKS.gather_wood.yield': 18 }) },
];

// The config as it was loaded, so "baseline" means something and the panel can mark a dial
// as moved. Captured at import, before anything can have changed it.
export const DEFAULTS = Object.fromEntries(TUNABLES.map(t => [t.key, getVal(t.key)]));

const coerce = (t, raw) => {
  if (t.bool) return !!raw;
  let v = Number(raw);
  if (!Number.isFinite(v)) return null;
  if (t.int) v = Math.round(v);
  return Math.min(t.max, Math.max(t.min, v));
};

export const show = (t, v) => t.bool ? (v ? 'on' : 'off') : (t.fmt ?? n)(v);

// Everything the panel needs to draw itself, with each dial's value right now.
export const snapshot = () => ({
  groups: GROUPS,
  presets: PRESETS.map(p => ({ id: p.id, label: p.label, note: p.note })),
  rev: REV,
  tunables: TUNABLES.map(t => ({
    key: t.key, label: t.label, group: t.group, help: t.help ?? '',
    min: t.min, max: t.max, step: t.step, int: !!t.int, bool: !!t.bool,
    live: t.live !== false, value: getVal(t.key), shown: show(t, getVal(t.key)),
    dflt: DEFAULTS[t.key], moved: getVal(t.key) !== DEFAULTS[t.key],
  })),
});

// Apply a set of changes. Returns what actually moved, each with the sentence the
// villagers are told — a plain statement of the new fact, never advice.
// `W` is the running world, or null when nothing is running (then it is just config).
export function apply(changes, W = null) {
  const moved = [];
  for (const [key, raw] of Object.entries(changes)) {
    const t = BY_KEY.get(key);
    if (!t) continue;
    const from = getVal(key), to = coerce(t, raw);
    if (to === null || to === from) continue;
    setVal(key, to);
    moved.push({
      key, label: t.label, group: t.group, live: t.live !== false,
      from, to, fromShown: show(t, from), toShown: show(t, to),
      say: t.live === false ? null
        : t.say ? t.say(from, to)
        : `Village news: ${t.label} is now ${show(t, to)}, where it was ${show(t, from)}.`,
    });
  }
  if (!moved.length) return moved;
  REV++;
  if (W) {
    const lines = moved.map(m => m.say).filter(Boolean);
    if (lines.length) W.announce(lines);
    W.notePolicy(moved);
  }
  return moved;
}

// Resolve a preset id to the changes it stands for.
export const preset = id => PRESETS.find(p => p.id === id)?.set() ?? null;
