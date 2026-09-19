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
// (build_house). Index 3 (once "boats", never used) is LABOUR: one unit is one shift of
// work. Every villager holds their own next shift and may sell it in the same on-chain
// auction as everything else; whoever buys it has an extra pair of hands next round. The
// program neither knows nor cares what slot 3 is called, so this took no on-chain change.
export const GOODS = ['food', 'wood', 'nets', 'labour', 'houses'];
export const FOOD = 0, WOOD = 1, NETS = 2, LABOUR = 3, HOUSES = 4;

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
  START_CASH:  +env.START_CASH  || 6000,
  START_FOOD:  +env.START_FOOD  || 40,
  START_WOOD:  +env.START_WOOD  || 30,
  WARM_ROUNDS: +env.WARM_ROUNDS || 1,                 // each agent's fire burns FIRE_WOOD every N rounds (a meal is every round)
  // Quantities are 5x what they once were (and unit prices a fifth), so nothing is lumpy:
  // no zero-catch shifts, no one-unit trade setting the price everything is valued at.
  MEAL: 5,                                            // food per lifestyle level per meal: lifestyle 2 eats 10
  FIRE_WOOD: 5,                                       // wood a fire burns each time it is fed
  LLM_CONCURRENCY: +env.LLM_CONCURRENCY || 64,        // every agent decides at once each round: keep it >= AGENTS
  RUN_SECONDS: +env.RUN_SECONDS || 0,                 // 0 = run forever
  PORT:        +env.PORT        || 8787,
  RPC:          env.RPC          || 'http://127.0.0.1:8899',
  SEED:        +env.SEED        || 12345,             // same seed = same names, traits, skills

  // Every job takes one shift, and a shift is one round.
  TASKS: {
    gather_food: { yield: 10, netYield: 20, place: 'docks' },   // at skill 1: one fisher with a net feeds ~2 people well
    gather_wood: { yield: 15,               place: 'forest' },
    craft_net:   { wood: 20,                place: 'workshop' },
    // A house: the wood (divided by crafting skill, like a net) is used up when the build
    // starts, and the house exists on-chain from then on, unfinished, so it can be pledged
    // for a construction loan. It gives nothing and can't be sold until `shifts` building
    // shifts are done; a build left for other work waits, unfinished, until resumed.
    build_house: { wood: 120, shifts: 3,    place: 'building site' },
    hired:       {                        place: 'an employer\'s side' },   // never chosen: the shift was sold last round
    idle:        {                        place: 'square' },
  },
  // Every villager draws a talent per job at birth: strong at one, middling at another,
  // poor at the third. It multiplies what a shift yields; for crafting it divides the wood a
  // net or a house costs. Everybody is several times better at one job than at another:
  // that is what makes doing everything yourself a bad idea, and it is the reason a market
  // exists at all. Nothing assigns a job — agents see their skills and choose, and the
  // middling talent is there so labour can move when prices say so.
  TALENT: { strong: [1.6, 2.4], mid: [0.6, 1.0], weak: [0.25, 0.5] },
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
    EAT: [-2, 1.0, 1.6, 2.0],   // per meal, by food eaten: none (a missed meal), 1, 2, 3
    WARM: 0.5,                  // per meal period while the fire is lit
    COLD: -1,                   // per meal period while it is out
    // per meal period, for the 1st, 2nd, 3rd… finished house you own and keep up (pledged
    // or not); any beyond the list give the last figure. Diminishing, never zero: there is
    // always something more worth buying, so the rich keep spending and demand never dies.
    HOUSE: [1.5, 0.9, 0.5, 0.3, 0.2],
  },
  HOUSE_UPKEEP: 2,              // wood each finished house uses up every round; a house not kept up gives nothing that round

  // The market stall everyone starts with (agents change theirs with set_sale): what is held
  // above `keep` is offered every round at `min` × the start price or better. Food, wood and
  // nets only; nobody's house or labour is for sale until they say so.
  STALL: [{ keep: 20, min: 0.8 }, { keep: 25, min: 0.8 }, { keep: 1, min: 0.8 }, null, null],

  // The shopping list everyone starts with (agents change theirs with set_buy): every round,
  // bid for whatever is held short of `target`, at up to `max` × the start price.
  SHOP: [{ target: 20, max: 1.25 }, { target: 15, max: 1.25 }, null, null, null],

  // The labour market. A villager may sell their NEXT shift (one unit of labour) in the
  // round's auction; the buyer has a hired hand next round, working in whatever job the
  // buyer does then, at the buyer's skill times HAND_EFFICIENCY. A hired fisher needs one
  // of the employer's spare nets to get the net catch — capital is what makes hiring pay.
  // Labour is fungible, so nobody has to be matched with anybody: the auction does it.
  HAND_EFFICIENCY: 0.75,
  MAX_HANDS: 3,                 // the most hands one villager can hire for a round
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
  START_PRICES: [100, 60, 2000, 900, 7000],     // cents: food, wood, nets, labour (one shift's wage), houses
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
