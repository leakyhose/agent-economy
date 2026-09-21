# Settlers of Solana

A village of 100 LLM agents running a free-market economy, settled on a real Solana program.

Written up on [Devpost](https://devpost.com/software/_solanasim).

Every villager is a language model. Each round they all choose at once whether to fish, cut
wood, craft a net, build a house or rest — nobody has a job, nobody has a wage, and nothing
has a price until they argue about one. They post limit orders, a batch auction clears
on-chain, and they can borrow against their goods from an on-chain bank, miss the payment,
and be foreclosed on by a stranger.

**The policy is off-chain, the settlement is on-chain.** The backend runs the clock and the
model calls; the Anchor program holds every agent's cash and goods, the order books and the
bank's balance sheet. The backend cannot hand an agent a coin and cannot save one from
foreclosure.

---

## What it does

```
ROUND  →  every agent decides at once; the round closes when 90% have answered (or at 8s)
WORK   →  gather_food / gather_wood / craft_net / build_house / rest — one shift per round
SELL   →  standing limit orders; a uniform-price batch auction clears once a round, on-chain
EAT    →  one meal a round; a villager's chosen lifestyle sets 1, 2 or 3 helpings
WARM   →  fires burn wood; a house makes the wood last twice as long
BORROW →  pledge wood, nets or houses to the on-chain bank for newly minted coins
SPOIL  →  food and wood rot whether offered or not; pledged goods don't, coins never do
```

Five goods — **food, wood, nets, boats, houses**. A net doubles your catch. A house takes 16
wood and three building shifts, goes on-chain unfinished (so it can be pledged for a
construction loan), and once finished pays wellbeing every round and can be sold.

The goal every agent maximises is **wellbeing**: eating well, staying warm, owning a house,
resting, and net worth at the end. Skills are drawn per agent from a fixed `SEED`, so the
same village is reborn every run.

### What's actually on Solana

One Anchor program (`chain/programs/chain/src/lib.rs`) holding a zero-copy `Ledger`:

| Instruction | What it does |
|---|---|
| `initialize` | ledger, purses, opening prices, bank equity and terms, the SETTLERS mint + vault |
| `settle` | signed goods deltas — catches, meals, fires, crafting, houses, spoilage |
| `clear_auction` | uniform-price batch auction for one good, up to 100 orders in one atomic tx |
| `borrow` / `repay` | real SPL `mint_to` / `burn`, capped by collateral **and** bank capital |
| `collect` | overdue → collect from cash, or foreclose; partial seizure at fire-sale value |
| `pay_dividend` | **permissionless** — bank equity above requirement, paid to every agent |
| `init_purses` / `settle_cash` | one SPL token account per agent, a PDA that owns itself |

- **Money is created by lending.** The only way a new coin exists is `borrow`. Repaying
  burns it.
- **Nobody holds the keys.** SETTLERS is an SPL token whose mint is its own mint and freeze
  authority, so no key anywhere can mint or freeze one. Each purse is owned by itself.
- **The books check themselves.** Every instruction asserts `SETTLERS supply = Σ agent cash +
  bank cash`. If that is ever wrong, the next transaction fails.
- **The auction is sorted off-chain and verified on-chain** in one O(n) pass — 100 orders
  cost 12,717 compute units (0.9% of the budget). Transaction *size* is the real limit: 1,220
  of the 1,232 legacy bytes.

### The dashboard

A 3D island and an admin panel in one page. GDP, inflation, employment, wellbeing,
inequality, credit, money supply and the bank's books, a live loan/foreclosure feed, every
agent's log one click away — and **56 dials**, 35 of them live, that change the economy from
the next round on. A famine is `CATCH` at 0.3. A blight is food spoilage at 0.4. A cold snap
is a fire that burns three times the wood. Pull the dial and watch the market answer.

---

## Getting started

### Prerequisites

| | |
|---|---|
| Node.js | 20+ |
| Rust | 1.89.0 (`chain/rust-toolchain.toml` pins it) |
| Anchor | 1.2 |
| Solana CLI | with a keypair at `~/.config/solana/id.json` (`solana-keygen new`) |
| python3 | the shell scripts read the program address out of the IDL with it |

Everything is developed against a **local validator**, not devnet: devnet's public RPC caps
at ~10 requests a second, which is far too slow for a three-second round.

### 1 · Install and build

```bash
npm --prefix backend install
npm run web:install
npm run web:build            # builds web/dist, which the backend serves

cd chain && anchor build && cd ..
```

> **Rebuild the program whenever `chain/programs/chain/src/lib.rs` changes.** A validator
> running a stale `chain.so` is the worst failure in this project: the ledger reads back as
> garbage, every settle is refused for `InsufficientGoods`, no good ever trades, and nothing
> anywhere tells you the program is out of date.

### 2 · Configure

```bash
cp .env.example .env
```

Pick a brain in `.env`:

| `BRAIN` | Needs | Notes |
|---|---|---|
| `stub` | nothing | free heuristic villagers — run the whole thing with no API key |
| `openai` | `OPENAI_API_KEY` | Chat Completions tool-calling, default `gpt-5.6-luna` |
| `baseten` | `BASETEN_API_KEY` | each agent draws a model from a pool and keeps it for the run |

`.env` is gitignored, and its API keys deliberately override anything exported in your shell.
Every other dial goes the usual way round, so `BRAIN=stub npm start` beats the `.env`.

### 3 · Start the validator (its own terminal, leave it running)

```bash
backend/scripts/validator.sh
```

This loads the program at genesis on `http://127.0.0.1:8899` with ~100ms slots
(`TICKS_PER_SLOT=16`), which takes the chain half of a round from 2.35s to 0.92s at 100
agents. `TICKS_PER_SLOT=64` gives Solana's own 400ms slots back for a long unattended run.
Ctrl-C deletes the ledger.

### 4 · Run the village

```bash
npm start                    # http://localhost:8787, opens a browser
```

Choose the brain and the village size beside **Start** on the dashboard, and press it. `/` is
the island, `/dashboard` is the panel — the view is the URL, so links and the back button
work.

For front-end work, run Vite instead and let it proxy to the backend:

```bash
npm run web:dev                                   # http://localhost:5183
BACKEND=http://127.0.0.1:8811 npm run web:dev     # ...against a different backend
```

If `web/dist` hasn't been built, the backend falls back to the older standalone pages
(`frontend/Moku Island.dc.html`, `backend/public/index.html`), so the village runs either way.

### Headless

```bash
RUN_SECONDS=120 npm start     # run for N seconds, print a summary with every invariant, exit
```

---

## Scripts

```bash
backend/scripts/check-brain.sh --pool      # which model each villager draws (no key needed)
backend/scripts/check-brain.sh --list      # what Baseten serves today, ranked by price
backend/scripts/check-brain.sh             # one real decision each — no chain, no validator

backend/scripts/check-settlers.sh          # the SETTLERS mint against the village's books
backend/scripts/check-purses.sh            # agents really holding and paying each other
backend/scripts/deploy-devnet.sh           # put the program and a village on devnet
```

The two `check-*.sh` money scripts each start a validator of their own (ports 8999 and 8997),
so the dashboard's validator on 8899 keeps running.

## Runs and analysis

Every run is saved to `runs/<timestamp>/` (gitignored):

```
meta.json      config, agent names/traits/skills, program + ledger address
events.jsonl   every decision (what the agent saw · thought · did), every order, every round
final.json     on-chain balances read back after Stop, model call stats and cost
```

```bash
node backend/scripts/analyze.mjs                        # the latest run
node backend/scripts/analyze.mjs runs/2026-09-20T05-53-19
```

It reports how prices moved, what agents chose and which orders were rejected and why, hunger
and spoilage, the economy round by round, the bank's books and every invariant, loans
collected vs. foreclosed, final standings, and a sample of the agents' own reasoning.

---

## Layout

```
chain/            Anchor program: the ledger, its market and its bank
  programs/chain/src/lib.rs
backend/
  src/config.mjs    every setting, in one place
  src/tunables.mjs  the 56 dials the control panel can pull
  src/chain.mjs     talks to Solana (hand-encoded instructions)
  src/world.mjs     the clock, shifts, eating, wellbeing, the lake, spoilage, market rounds
  src/tools.mjs     what an agent can do, and what it is told
  src/server.mjs    runs it, serves the dashboard, saves every run
  src/brains/       prompt.mjs · stub.mjs · openai.mjs · baseten.mjs · chat.mjs
  scripts/          analysis, brain and money checks, the validator, devnet deploy
web/              the front end: island + admin panel in one Vite app
  src/store.js      one /state poll and one /events stream, shared by every view
  src/island/       the 3D island (three.js)
  src/admin/        the dashboard, charts and dials
frontend/         the older standalone island page (fallback)
tools/thumbnail/  renders a framed island shot in headless Chrome
runs/             every run, saved automatically (gitignored)
```

---

## Numbers worth knowing

- **100 agents, 6.4s a round.** Six minutes of economy costs about $1.33 on `gpt-5.6-luna`
  (30 agents, 3,059 calls); 10 agents for 2¼ minutes is $0.15.
- **137 agents** is the ledger's ceiling — Solana's 10 KiB limit on an account created by CPI,
  not a limit of the design.
- Reasoning is off on the OpenAI brain because gpt-5.x refuses tool calls otherwise. The
  system prompt and tool schemas are 78% of every request and identical for all agents, so the
  whole village shares one prompt cache key.

## Troubleshooting

**Every settle fails with `InsufficientGoods`, nothing trades, every chart but GDP is flat.**
The validator is running a stale `chain.so`. `cd chain && anchor build`, then restart
`validator.sh`.

**The machine runs out of disk.** The local validator's rocksdb ledger grows by roughly 90 MB
a minute whatever `--limit-ledger-size` says early on. Keep a few GB free and Ctrl-C the
validator when you're done — a full disk kills every validator on the machine.

**429s from the model provider.** The limit is per minute, and faster rounds spend it faster.
At 100 agents a clean run turns into 429s at ~1,000 calls a minute; a village of 30 runs at
~3.6s a round and never sees one.
