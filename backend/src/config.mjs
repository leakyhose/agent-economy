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
  // cents. A house (~70 coins) can't be bought outright from this, so buying or
  // building one needs savings or a loan. Endowments are a few rounds of runway: enough
  // that nobody starves while the market finds its prices, not enough to live on.
  START_CASH:  +env.START_CASH  || 10000,
  START_FOOD:  +env.START_FOOD  || 40,
  START_WOOD:  +env.START_WOOD  || 30,
  WARM_ROUNDS: +env.WARM_ROUNDS || 1,                 // each agent's fire burns FIRE_WOOD every N rounds (a meal is every round)
  // Quantities are 5x what they once were (and unit prices a fifth), so nothing is lumpy:
  // no zero-catch shifts, no one-unit trade setting the price everything is valued at.
  MEAL: 5,                                            // food per lifestyle level per meal: lifestyle 2 eats 10
  FIRE_WOOD: 3,                                       // wood a fire burns each time it is fed
  LLM_CONCURRENCY: +env.LLM_CONCURRENCY || 64,        // every agent decides at once each round: keep it >= AGENTS
  RUN_SECONDS: +env.RUN_SECONDS || 0,                 // 0 = run forever
  PORT:        +env.PORT        || 8787,
  RPC:          env.RPC          || 'http://127.0.0.1:8899',
  SEED:        +env.SEED        || 12345,             // same seed = same names, traits, skills

  // Every job takes one shift, and a shift is one round.
  TASKS: {
    // Calibrated so the village runs near capacity, as economies do: a talented fisher with a
    // net feeds about three people well, a talented woodcutter keeps about four fires and
    // houses going — so needs take most of the village's shifts, and what is left builds.
    // Food is 12, not 9: at 9 the village could not feed itself at the lifestyle agents
    // actually choose. A 121-round LLM run made 34,050 food against 37,980 wanted and lost
    // 7,713 more to rot, so the ask side was empty in half the rounds, and an unmet market
    // prints +4.9% a round against -1.9% in a glut — food went 1.00 -> 11.48 and fishing came
    // to pay ten times any other job, so every villager fished whatever their talent.
    // At 12, ~16 fishers feed 30 at two helpings and the other 14 shifts are free for wood,
    // nets and houses. A net still doubles a catch.
    gather_food: { yield: 12, netYield: 24, place: 'docks' },
    gather_wood: { yield: 12,             place: 'forest' },
    craft_net:   { wood: 20,                place: 'workshop' },
    // A house: `wood` is the same for everyone (see W.houseWood) and is paid for as the house
    // goes up — what is still owed is spread evenly over the building shifts the builder still
    // needs (W.trancheWood: 30 + 30 for a 2.0 crafter, 20 × 3 at 1.0), so a builder needs a shift's worth of materials to start, not all of
    // them. The house exists on-chain, unfinished, from the first shift. It gives nothing and
    // can't be sold or pledged until `shifts` units of building progress are done; a build left
    // for other work waits, unfinished, until resumed.
    // `shifts` is the work a house takes at crafting skill 1.0 — a shift adds the builder's
    // crafting skill (BUILD_CLAMP), so a 2.0 crafter finishes in 2 shifts and a 0.75 in 4.
    // Crafting skill buys speed, not cheaper wood: dividing the wood by skill quoted the
    // villagers who hold the wood (the woodcutters, poor crafters) several times what it
    // quoted the crafters who hold none.
    build_house: { wood: 60, shifts: 3,    place: 'building site' },
    idle:        {                        place: 'square' },
  },
  // Every villager draws a talent per job at birth: strong at one, middling at another,
  // poor at the third. It multiplies what a shift yields; for crafting it divides the wood a
  // net costs and sets how fast a house goes up. Everybody is several times better at one job than at another:
  // that is what makes doing everything yourself a bad idea, and it is the reason a market
  // exists at all. Nothing assigns a job — agents see their skills and choose, and the
  // middling talent is there so a villager can change trade when prices say so.
  TALENT: { strong: [1.6, 2.4], mid: [0.6, 1.0], weak: [0.25, 0.5] },
  // Learning by doing, on top of talent: everyone works one shift a round, so real output
  // per head can only rise if people get better at what they do. Every shift worked multiplies
  // that job's skill by (1 + LEARN), up to LEARN_CAP times the skill the agent was born with.
  // 0.3% a shift is ~+35% over 100 rounds for someone who sticks to one job — which also
  // rewards sticking. The cap is 1.6, not 1.4: a full-time specialist hits 1.4x at round ~112,
  // so growth would flatten just after a 100-round run ends. 1.6x is ~168 shifts.
  LEARN: env.LEARN === '0' ? 0 : (+env.LEARN || 0.003),
  LEARN_CAP: +env.LEARN_CAP || 1.6,
  // Dividing a net's wood by a 0.25 talent would ask for 80 wood, so that one bill is clamped
  // to this band: the best crafter is 4x cheaper than the worst, and no one is priced out of
  // a net entirely.
  CRAFT_CLAMP: [0.5, 2.0],
  // Crafting is the maker's skill: it also sets how fast a house goes up (build_house adds this
  // much progress a shift, out of TASKS.build_house.shifts). A narrower band than CRAFT_CLAMP —
  // 2.0 finishes in 2 shifts, 1.0 in 3, anyone at or under 0.75 in 4 — so the worst builder is
  // twice as slow, not six times, and every agent can still put up a house.
  BUILD_CLAMP: [0.75, 2.0],
  NET_WEAR: 0.05,          // chance a (free) net breaks on each fishing shift; a pledged net is held by the chain and doesn't
  // Share of an agent's FREE stock that rots every market round: food, wood, nets, boats, houses.
  // Only food rots: it is the reason to sell a surplus instead of hoarding it. Coins never
  // spoil, so holding money is the way to store value.
  SPOIL: [0.10, 0, 0, 0, 0],

  // The goal: the best life — total wellbeing over the run, and nothing else. It is counted
  // every meal period (every round), per agent. Diminishing: a second food per meal is worth
  // less than the first, a third less again. Calibrated so the choices are close at opening
  // prices: one extra food (5.00) buys +0.6 then +0.4.
  WELLBEING: {
    // Per meal, by helpings eaten: none (a missed meal), 1, 2, 3. The 2nd helping adds +0.4 and
    // the 3rd +0.2, not +0.6 and +0.4: at +0.6 a second helping was the cheapest wellbeing in
    // the village at opening prices, so agents settled at 2.2 helpings and asked the village for
    // 330 food a round it could not make. Eating well is still worth doing; eating three times
    // over is now a luxury, and the coins go to nets and houses instead.
    EAT: [-2, 1.0, 1.4, 1.6],
    WARM: 0.5,                  // per meal period while the fire is lit
    COLD: -1,                   // per meal period while it is out
    // per meal period, for the 1st, 2nd, 3rd… finished house you own and keep up (pledged
    // or not); any beyond the list give the last figure. Diminishing, never zero: there is
    // always something more worth buying, so the rich keep spending and demand never dies.
    HOUSE: [1.5, 0.9, 0.5, 0.3, 0.2],
  },
  // Wood each finished house uses every round; a house not kept up gives nothing that round.
  // 1, not 2: houses are the thing agents keep buying, and at 2 the 97 houses a 121-round run
  // ended with wanted 194 wood a round beside 90 for the fires, against ~216 cut. Upkeep ate
  // the wood the village needed for nets and building, and 4.9 villagers a round went cold.
  HOUSE_UPKEEP: 1,

  // The market stall everyone starts with (agents change theirs with set_sale): what is held
  // above `keep` is offered every round at `min` × the start price or better. Food, wood and
  // nets only; nobody's house is for sale until they say so.
  // The stall asks the going price to begin with and reprices itself (REPRICE); `min` is its floor.
  // The reserves are what does NOT go to market, so they set how much of the village's output
  // ever trades. 10 food is two rounds' eating and 12 wood four fires: enough that a bad round
  // doesn't starve anyone, small enough that a specialist's whole surplus is on sale every
  // round. At 20 and 25 a villager holding exactly their reserve neither sold nor bought, and
  // only 23% of output went through the market.
  STALL: [{ keep: 10, min: 0.3 }, { keep: 12, min: 0.3 }, { keep: 1, min: 0.4 }, null, null],
  // Prices move when markets don't clear: a stall that sold nothing asks `down` less next round,
  // one that sold out asks `up` more; a shopping list that got nothing bids `down` more.
  // `band` is the leash: a stall may ask at most this much more than the last price the good
  // actually traded at, and a shopping list may bid at most this much less. Without it a stall
  // that sells out marks up 5% a round off ITS OWN last sticker, so in a shortage every stall
  // compounds away from the market together — 65 rounds of that took food from 1.00 to 11.48.
  // Priced off the going rate instead, the market can still rise fast when goods are short
  // (the band is per round, and the clearing price rises with it) but cannot run away.
  REPRICE: { down: 0.07, up: 0.05, band: 1.35 },

  // The shopping list everyone starts with (agents change theirs with set_buy): every round,
  // bid for whatever is held short of `target`, at up to `max` × the start price.
  // The stock each villager keeps topped up. Targets sit just above the stall's reserve, so a
  // villager who runs short buys rather than switching jobs to make it themselves — that is
  // what a market is for. Nets are on the list too (target 1): a net doubles a catch and pays
  // for itself many times over, so standing demand for one is what makes crafting a trade.
  SHOP: [{ target: 14, max: 2.5 }, { target: 16, max: 2.5 }, { target: 1, max: 2.5 }, null, null],

  LIFESTYLE_START: 1,           // food per meal (1–3) until an agent sets its own

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
    // The hard ceiling written into the ledger at `initialize`, for the life of the run.
    // LTV above is the bank's policy today and the control panel moves it; the chain refuses
    // anything above this whatever the panel says: the tightening is off-chain, the limit
    // is not. Set LTV_CEILING = LTV for a run where the chain alone decides.
    LTV_CEILING: +env.BANK_LTV_CEILING || 0.95,
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
    // lend 10× its equity, so 0.10 lets debt reach the whole starting money supply
    // (30 agents × 30 coins = 900: room for ~20 house loans at 60% of 70) while losing
    // ~10% of that loan book wipes it out and stops lending: a credit crunch that
    // defaults can cause.
    SEED: 0.10,
    KAPPA: 0.10,           // capital ratio: all loans together <= equity / KAPPA
    // Capital the bank must hold beyond KAPPA × loans, as a share of the starting money:
    // the seed plus a 10% buffer.
    EQUITY_FLOOR: 0.11,
  },
  SLOT_MS: 400,            // assumed slot time: a minute of interest is 60000 / SLOT_MS slots
  ROUND_MS_GUESS: 1500,    // round length assumed before the first round is measured (short is safe: see TERM_SLACK)
  // cents: food, wood, nets, boats, houses. Boats open at 1 cent — the chain refuses a zero
  // start price — and nothing makes or shows them. Houses open near what one costs to make,
  // not at a token cent: a house nobody has bought yet is still the village's biggest asset,
  // and at 1 cent it backed no loan and no net worth (the bank once auctioned a seized house
  // for a penny). These are also the fixed prices real GDP is valued at (world.mjs).
  START_PRICES: [100, 100, 3000, 1, 12000],
  // The price index: a fixed basket (15 meals at lifestyle 1, some firewood, a little of the
  // durables), unchanged since rounds became turns so runs stay comparable. Index 1.00 = this
  // basket at START_PRICES. Inflation is its change over the last INFLATION_ROUNDS.
  PRICE_BASKET: [75, 18.75, 0.1, 0, 0.02],
  INFLATION_ROUNDS: 20,
  // D6: agents see last round's order book as a depth ladder (top levels per side).
  // Off: best bid / cheapest ask only.
  LADDER: env.LADDER !== '0',
  BANK_SALE_STEP: 0.05,    // the bank's sale of seized goods starts at the last price and drops this much a round it goes unsold
};
