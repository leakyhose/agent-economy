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
  // building one needs savings or a loan.
  START_CASH:  +env.START_CASH  || 3000,
  START_FOOD:  +env.START_FOOD  || 6,
  START_WOOD:  +env.START_WOOD  || 4,
  WARM_ROUNDS: +env.WARM_ROUNDS || 2,                 // each agent burns 1 wood every N rounds to keep warm (a meal is every round)
  LLM_CONCURRENCY: +env.LLM_CONCURRENCY || 64,        // every agent decides at once each round: keep it >= AGENTS
  RUN_SECONDS: +env.RUN_SECONDS || 0,                 // 0 = run forever
  PORT:        +env.PORT        || 8787,
  RPC:          env.RPC          || 'http://127.0.0.1:8899',
  SEED:        +env.SEED        || 12345,             // same seed = same names, traits, skills

  // Every job takes one shift, and a shift is one round.
  TASKS: {
    gather_food: { yield: 2, netYield: 4, place: 'docks' },   // one fisher feeds ~2 people
    gather_wood: { yield: 3,               place: 'forest' },
    craft_net:   { wood: 4,                place: 'workshop' },
    // A house: the wood (divided by crafting skill, like a net) is used up when the build
    // starts, and the house exists on-chain from then on, unfinished, so it can be pledged
    // for a construction loan. It gives nothing and can't be sold until `shifts` building
    // shifts are done; a build left for other work waits, unfinished, until resumed.
    build_house: { wood: 16, shifts: 3,    place: 'building site' },
    idle:        {                        place: 'square' },
  },
  // Every villager draws a random skill per job at birth (1.0 = average). It multiplies
  // what a shift yields; for craft_net it divides the wood a net costs. Nothing assigns
  // a job — agents see their skills and choose, so specialization has to emerge.
  SKILL_RANGE: [0.5, 1.5],
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
    HOUSE: 1.5,                 // per meal period while you own a house (pledged or not)
  },
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
  START_PRICES: [500, 300, 2000, 8000, 7000],   // cents: food, wood, nets, boats, houses
  // The price index: a fixed basket (15 meals at lifestyle 1, some firewood, a little of the
  // durables), unchanged since rounds became turns so runs stay comparable. Index 1.00 = this
  // basket at START_PRICES. Inflation is its change over the last INFLATION_ROUNDS.
  PRICE_BASKET: [15, 3.75, 0.1, 0, 0.02],
  INFLATION_ROUNDS: 20,
  // D6: agents see last round's order book as a depth ladder (top levels per side).
  // Off: best bid / cheapest ask only.
  LADDER: env.LADDER !== '0',
  BANK_SALE_STEP: 0.05,    // the bank's sale of seized goods starts at the last price and drops this much a round it goes unsold
};
