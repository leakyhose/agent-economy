// Every dial in one place. Override any of them with an env var.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');
// The project's .env wins over the shell for SECRETS, so a stale key exported in ~/.zshrc
// can't silently shadow the one meant for this project. Every other dial goes the usual
// way round, so `BRAIN=stub node src/server.mjs` beats the BRAIN in .env.
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && (/_API_KEY$/.test(m[1]) || process.env[m[1]] === undefined)) process.env[m[1]] = m[2];
  }
} catch { /* no .env yet */ }
const env = process.env;

// Order is fixed: it is the on-chain layout (lib.rs N_GOODS = 5). Houses are built
// (build_house); boats are a dead on-chain slot — nothing makes them and agents are never
// shown them, but index 3 has to stay so the JS arrays line up with the ledger.
export const GOODS = ['food', 'wood', 'nets', 'boats', 'houses'];
export const FOOD = 0, WOOD = 1, NETS = 2, BOATS = 3, HOUSES = 4;

export const CFG = {
  AGENTS:      +env.AGENTS      || 10,
  BRAIN:        env.BRAIN        || 'stub',            // stub | openai | claude
  MODEL:        env.MODEL        || (env.BRAIN === 'claude' ? 'claude-haiku-4-5' : 'gpt-5.6-luna'),
  // Time is counted in rounds. Every round, all agents decide at once (the clock waits
  // for the slowest, up to DECIDE_TIMEOUT_MS), then everyone works one shift, eats one
  // meal, fires burn, goods rot and the market clears on-chain.
  DECIDE_TIMEOUT_MS: +env.DECIDE_TIMEOUT_MS || 8000,   // an agent that hasn't answered by then keeps its last job and posts no orders
  // cents. About 15 rounds of food and fuel: enough runway to specialize and trade for
  // the rest. A house costs far more than this, so buying or building one needs savings
  // or a loan.
  START_CASH:  +env.START_CASH  || 6000,
  START_FOOD:  +env.START_FOOD  || 50,
  START_WOOD:  +env.START_WOOD  || 25,
  WARM_ROUNDS: +env.WARM_ROUNDS || 2,                 // a fire every N rounds (a meal is every round)
  FIRE_WOOD:   +env.FIRE_WOOD   || 5,                 // wood one fire burns
  MEAL:        +env.MEAL        || 5,                 // food in one meal's worth; lifestyle 1–3 eats that many meals' worth
  HOUSE_UPKEEP: +env.HOUSE_UPKEEP || 1,               // wood each house owned costs its owner every round
  LLM_CONCURRENCY: +env.LLM_CONCURRENCY || 64,        // every agent decides at once each round: keep it >= AGENTS
  RUN_SECONDS: +env.RUN_SECONDS || 0,                 // 0 = run forever
  PORT:        +env.PORT        || 8787,
  RPC:          env.RPC          || 'http://127.0.0.1:8899',
  SEED:        +env.SEED        || 12345,             // same seed = same names, traits, skills

  // Every job takes one shift, and a shift is one round. Quantities are deliberately
  // coarse-grained (~15 a shift, a meal 5 food): at a skill of 0.2 a shift still yields
  // something, so a weak agent is poor at a job, not shut out of it.
  // 10, not 15: at 15 the village could meet its needs with ~19.5 of its 30 shifts, and the
  // slack showed up as 32-46% of all food rotting and 22,000 wood nobody could use. At 10
  // the same needs take ~29.5 shifts, so output is scarce enough to be worth selling.
  // Food is 12, not the symmetric 10: at 10 the food ask side ran dry in a third of the early
  // rounds, and an empty ask side prints ~+3.9% a round (bids always sit above the last price),
  // which took the price index to 2.61 in 99 rounds. Wood is the good actually in glut, so it
  // stays at 10. Growth still has to come from skill (LEARN) and from nets: a net is +~42% to
  // a catch, so nets spreading through the fishers is itself a source of real growth.
  TASKS: {
    gather_food: { yield: 12, netYield: 17, place: 'docks' },   // one fisher feeds ~2 people at lifestyle 1
    gather_wood: { yield: 10,               place: 'forest' },  // one woodcutter keeps ~4 fires lit
    // 20 wood, divided by crafting skill: a 2.0 crafter pays 10 (~10.00) plus a shift, and
    // sells into bids that ran to 40.00. Crafting to sell already paid — what stopped it was
    // the observation, not the margin.
    craft_net:   { wood: 20,                place: 'workshop' },
    // A house: the wood is used up when the build starts, and the house exists on-chain
    // from then on, unfinished, so it can be pledged for a construction loan. It gives nothing and can't be sold until `shifts` units of
    // building progress are done; a build left for other work waits, unfinished, until resumed.
    // `shifts` is the work a house takes at crafting skill 1.0 — a shift adds the builder's
    // crafting skill (BUILD_CLAMP), so a 2.0 crafter finishes in 2 shifts and a 0.2 in 4.
    // 60 wood, flat for everyone (see W.houseWood), + 3 shifts ≈ 105.00 all in, against
    // +1.5 wellbeing a round — worth ~7.50 at what a helping of food costs — so it pays back
    // in ~14 rounds, and lands on the 90-145 agents actually bid for a house. At 150 wood
    // divided by crafting skill + 8 shifts it was 340-520 for +1.0, and 8 shifts was 8
    // separate chances to defer: 1 house was built in 97 rounds.
    build_house: { wood: 60, shifts: 3,    place: 'building site' },
    idle:        {                        place: 'square' },
  },
  // Talent, drawn at birth: three skills, one per job, scaled so every villager's three
  // add up to 3.0. The spread is wide on purpose — it is the only reason an agent can't
  // just make everything himself — and the fixed total means being good at one job costs
  // you another, while nobody is bad at everything. A skill multiplies what a shift
  // yields; for craft_net it divides the wood a net costs. Nothing assigns a job: agents
  // see their skills and choose, so roles have to emerge.
  // TILT is how lopsided the draw is before scaling (1 = flat, higher = sharper
  // specialists); FLOOR is the hard minimum, and the ceiling follows from it at
  // 3.0 − 2 × FLOOR. At TILT 2 the middle 90% of skills land between 0.2 and 2.4.
  // Learning by doing, the only source of growth: labour is fixed at one shift each and the
  // village sits at its allocation ceiling from round 1, so real output can only rise if
  // people get better at what they do. Every shift worked multiplies that job's skill by
  // (1 + LEARN), up to LEARN_CAP times the skill the agent was born with. 0.3% a shift is
  // ~+35% over 100 rounds for someone who sticks to one job — which also rewards sticking.
  // The cap is 1.6, not 1.4: a full-time specialist hits 1.4x at round ~112, so growth would
  // flatten just after a 100-round run ends. 1.6x is ~168 shifts, beyond any run so far.
  LEARN: env.LEARN === '0' ? 0 : (+env.LEARN || 0.003),
  LEARN_CAP: +env.LEARN_CAP || 1.6,
  SKILL_TILT: +env.SKILL_TILT || 2,
  SKILL_FLOOR: +env.SKILL_FLOOR || 0.2,
  // ...except that dividing a net's wood by a 0.2 skill would ask for 100 wood, so that one
  // bill is clamped to this band: the best crafter is 4x cheaper than the worst, and no one
  // is priced out of a net entirely.
  CRAFT_CLAMP: [0.5, 2.0],
  // Crafting is the maker's skill: it also sets how fast a house goes up (build_house adds this
  // much progress a shift, out of TASKS.build_house.shifts). A narrower band than CRAFT_CLAMP —
  // 2.0 finishes in 2 shifts, 1.0 in 3, anyone at or under 0.75 in 4 — so the worst builder is
  // twice as slow, not six times, and every agent can still put up a house.
  BUILD_CLAMP: [0.75, 2.0],
  // Chance a (free) net breaks on each fishing shift; a pledged net is held by the chain and
  // doesn't. This is the crafter's whole trade: ~17 fishing shifts a round over a ~6.7-shift
  // life is ~2.5 nets a round of standing demand. Lowering it would remove that.
  NET_WEAR: 0.15,
  // Share of an agent's FREE stock that rots every market round: food, wood, nets, boats, houses.
  // Only food rots: it is the reason to sell a surplus instead of hoarding it. Coins never
  // spoil, so holding money is the way to store value.
  SPOIL: [0.10, 0, 0, 0, 0],

  // The goal: the best life — total wellbeing over the run, and nothing else. It is counted
  // every meal period (every round), per agent. Diminishing: a second meal's worth is worth
  // less than the first, a third less again. Calibrated so the choices are close at opening
  // prices: one extra meal (5 food, 5.00) buys +0.6 then +0.4.
  WELLBEING: {
    EAT: [-2, 1.0, 1.6, 2.0],   // per meal, by meals' worth eaten: none (a missed meal), 1, 2, 3
    WARM: 0.5,                  // per meal period while the fire is lit
    COLD: -1,                   // per meal period while it is out
    // Per meal period, by house owned: the first pays 1.0, the second 0.6, and so on; the
    // last figure repeats for every house beyond. Diminishing, but never nothing — so a
    // builder always has someone left to sell to, and houses are a lasting want.
    HOUSE: [1.5, 0.8, 0.5, 0.3],
  },
  LIFESTYLE_START: 1,           // meals' worth of food per meal (1–3) until an agent sets its own

  // Fishing conditions: a plain multiplier on what a fishing shift catches. There is no
  // lake stock any more — this is the "bad fishing season" dial the panel will pull mid-run.
  CATCH: +env.CATCH || 1.0,

  // The village bank, enforced on-chain. It is the ONLY way new coins come into being:
  // it mints them as a loan against pledged goods, and burns the principal when repaid.
  // A public bank: its terms are policy (set here, later by the central-bank panel), not
  // chosen to make a profit. Interest and penalties go to its capital.
  BANK: {
    // Credit on/off. CREDIT=0 is the no-credit regime: LTV 0, so the chain lends nothing.
    CREDIT: env.CREDIT !== '0',
    LTV: env.CREDIT === '0' ? 0 : (+env.BANK_LTV || 0.60),   // a loan may be at most 60% of the collateral's value
    // Margin calls are off: the keeper forecloses overdue loans only. The chain still knows
    // how (the instruction is unchanged), so this is set as loose as lib.rs allows
    // (ltv_bps <= margin_bps <= 10_000) and world.mjs's keeper never cites it.
    MARGIN: 1.0,
    PENALTY: 0.10,         // added to the debt at foreclosure, to the bank's capital
    RATE_PER_MIN: +env.BANK_RATE || 0.05,   // interest per minute of real time, charged pro-rata per slot for the time the loan is held
    // Every loan runs the same term. The chain counts slots: a new loan is sent with
    // TERM_SLACK × term × the measured slots per round, so its on-chain deadline comes no
    // later than the promised round; the keeper collects at the promised round, not before.
    // Agents see interest per round at the measured round length.
    TERM_ROUNDS: 30,
    TERM_SLACK: 0.8,
    // The bank's opening equity, as a share of the starting money. With KAPPA 0.10 it can
    // lend 10× its equity, so 0.15 lets debt reach 1.5× the starting money supply
    // (10 agents × 60 coins = 600: room to fund a dozen house builds at once) while losing
    // ~15% of that loan book wipes it out and stops lending: a credit crunch that
    // defaults can cause.
    SEED: 0.15,
    KAPPA: 0.10,           // capital ratio: all loans together <= equity / KAPPA
    // Capital the bank must hold beyond KAPPA × loans, as a share of the starting money:
    // the seed plus a 10% buffer.
    EQUITY_FLOOR: 0.11,
  },
  SLOT_MS: 400,            // assumed slot time: a minute of interest is 60000 / SLOT_MS slots
  ROUND_MS_GUESS: 1500,    // round length assumed before the first round is measured (short is safe: see TERM_SLACK)
  // cents: food, wood, nets, boats, houses. Boats open at 1 cent — the chain refuses a zero
  // start price — and nothing makes or shows them. Houses open at what one costs to make
  // (60 wood × 1.00 + 3 shifts × 10 wood × 1.00 = 90.00, the same number world.mjs values
  // real GDP at): a house nobody has bought yet is still the village's biggest asset, and at
  // 1 cent it backed no loan and no net worth — 192 of 222 refused loans were "not enough
  // collateral" and the bank once auctioned a seized house for a penny. Agents are still shown
  // "no trades yet — a house takes …", never this number as a price (see tools.mjs marketText).
  START_PRICES: [100, 100, 2500, 1, 9000],
  // The price index: a fixed basket (15 meals at lifestyle 1, some firewood, a little of the
  // durables), unchanged since rounds became turns so runs stay comparable. Houses stay out
  // of it (weight 0): one house is worth 15 rounds of the rest of the basket, so the first
  // sale away from the opening 90.00 would swamp the index. Index 1.00 = basket at START_PRICES.
  PRICE_BASKET: [75, 18.75, 0.5, 0, 0],
  INFLATION_ROUNDS: 20,
  // D6: agents see last round's order book as a depth ladder (top levels per side).
  // Off: best bid / cheapest ask only.
  LADDER: env.LADDER !== '0',
  BANK_SALE_STEP: 0.05,    // the bank's sale of seized goods starts at the last price and drops this much a round it goes unsold
};
