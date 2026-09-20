# agent-economy — an AI agent economy on Solana

Hack the North 2026 · Sept 18–20 · University of Waterloo
Target prize: **Best Use of Solana** ($5,000 + Ledger Nano S Plus)
Submission deadline: **Sun Sept 20, 08:00 EDT**
Team: 2 people. Strengths: TS/JS, Solana client-side, frontend/graphics, sim/LLM plumbing. Rust OK if simple.

This doc describes what is **built**. The work in progress is in `FIX_PLAN.md`; later
features and what was cut are in `FUTURE_PLAN.md`.

---

## 1. What's built

A small village where **every agent is an LLM that acts through tool calls**, and every
trade settles on a real Solana program. It runs headless or with a live dashboard
(prices, order book, GDP / prices / employment / slack / wellbeing / Gini / houses,
money and bank charts, jobs, needs, wealth, loan feed).

```
agent-economy/
├── chain/            Anchor program: the ledger, its market and its bank
│   └── programs/chain/src/lib.rs
├── backend/          the village: clock, agents, the market round, the dashboard
│   ├── src/
│   │   ├── config.mjs      every setting, one place
│   │   ├── chain.mjs       talks to Solana (hand-encoded instructions)
│   │   ├── world.mjs       the clock, work shifts, eating, wellbeing, the fish lake, spoilage, market rounds
│   │   ├── tools.mjs       what an agent can do, and what it's told
│   │   ├── server.mjs      runs it, serves the dashboard, saves every run
│   │   └── brains/
│   │       ├── prompt.mjs    the shared system prompt
│   │       ├── stub.mjs      free heuristic placeholder (no API key needed)
│   │       ├── claude.mjs    Claude, tool-calling
│   │       └── openai.mjs    OpenAI, tool-calling (default gpt-5.6-luna)
│   ├── public/index.html   the old standalone dashboard (kept as a fallback)
│   └── scripts/analyze.mjs analyze any saved run
├── web/              the front end: island + admin panel in one Vite app (§10)
│   └── src/
│       ├── main.jsx        the shell: two views, the CCTV inset, the URL
│       ├── store.js        one /state poll and one /events stream for everything
│       ├── island/         the island view, ported from frontend/ (React + three.js)
│       └── admin/          the admin panel, ported from backend/public/index.html
├── frontend/         the old standalone island page (kept as a fallback)
├── runs/             every run, saved automatically (gitignored)
├── FIX_PLAN.md       the work in progress
├── FUTURE_PLAN.md    later features, and what was cut
└── .env / .env.example     API keys and settings (AGENTS=30 in both)
```

**The split is deliberate:**
- **Off-chain:** the clock, agent reasoning (LLM calls), the dashboard.
- **On-chain:** every agent's cash and goods, the market that sets prices, and the bank.
  This is real Solana program state, not a log of what happened elsewhere. The money is a
  real SPL token, **SETTLERS**, that the program alone can mint (§3).

*"The policy is off-chain, the settlement is on-chain. The chain enforces what can't be
faked."*

---

## 2. The economy

```
ROUND  →  every agent decides at once; the clock runs as soon as DECIDE_QUORUM (90%) have
          answered, or at DECIDE_TIMEOUT_MS (8s), whichever comes first (§5)
WORK   →  gather_food / gather_wood / craft_net / build_house / rest   (one shift = one round)
SELL   →  standing limit orders; a batch auction clears once per round, on-chain
EAT    →  one meal a round; the agent's lifestyle sets 1, 2 or 3 food per meal
WARM   →  burn 1 wood every 2 rounds (a house makes it last 2× as long)
BORROW →  pledge wood/nets/boats/houses to the on-chain bank for newly minted coins
SPOIL  →  food and wood rot every round, offered or not (pledged goods don't); coins never spoil
```

Five goods: **food, wood, nets, boats, houses**. A net doubles your catch and is crafted
from wood. Boats can be owned, traded and pledged, but nothing builds them yet.

**Houses are built:** `build_house` uses up 16 wood (÷ crafting skill) when the build
starts, and the house goes on-chain at once, unfinished — so it can be pledged for a
construction loan — then takes 3 building shifts. Unfinished, it gives nothing and can't
be sold; a build left for other work waits. Finished, it gives +1.5 wellbeing a round,
halves firewood and keeps up to 10 food from rotting, and it can be sold. Agents see a
payback line from real numbers: the wood at market plus the shifts' forgone earnings,
what a house gives a round, and what a loan against it costs a round.

**The goal is wellbeing**, counted every meal period (numbers in `CFG.WELLBEING`, shown
to agents in the prompt): eating 1/2/3 food → +1.0/+1.6/+2.0, a missed meal −2; warm
+0.5, cold −1; owning a house +1.5; each rest shift +1.0. At the end, every 10 coins of
net worth adds 1 point: cash, plus goods at last price × the share of what was offered
in the last 20 rounds that sold (so an unsold glut isn't counted at full price), an
unfinished house as the wood in it, minus debt with interest to now. Lifestyle is a
standing choice (`set_lifestyle`), so food demand rises with income and falls when food
is dear. Rest has value, so working is a choice. After 3 missed meals or 2 missed fires, yield halves.

**Fish come from one shared lake** (`CFG.LAKE`): catch scales with how full it is, and
it regrows logistically each round (scaled so it feeds the same per meal as before rounds
became turns). Overfishing lowers everyone's catch.

**Skills:** every agent draws a random skill per job (0.5–1.5) from a fixed `SEED`, so
the same village is reborn every run. No job is assigned; agents see their skills, what
a shift of each job yields, and how much of each good actually sold last round
(sell-through and their own fills), and choose.

Agents start with 30 coins, 6 food and 4 wood.

### The bank

**Money is created by lending.** Starting money is `AGENTS × START_CASH`; the only way
new coins appear is `borrow`, which mints them against pledged goods (not food). Those are
SETTLERS, a real SPL token: `borrow` mints and `repay` burns them by CPI, and the mint's
supply is checked against the books inside the same instruction (§3).
Repaying pays interest to the bank and burns the principal. Pledged goods don't rot and
stay usable (you fish with a pledged net, live in a pledged house) but can't be sold.

Rules, all enforced on-chain (dials in `CFG.BANK`):
- **Equity** is the bank's own cash plus the seized goods it holds (at fire-sale value)
  minus bad debt, seeded at start (10% of starting money, not counted in `supply`).
  Interest, penalties and sales add to it; write-offs, refunds and dividends take from it.
- **Backed:** a loan may be at most `LTV` of the collateral at last prices.
  `CREDIT=0` sets LTV to 0: the no-credit regime.
- **Capital limit:** all loans together ≤ equity / `KAPPA` (0.10). Defaults eat equity,
  which tightens lending for everyone.
- **Interest per round held:** `BANK.RATE_PER_ROUND` (0.79%) on the principal, nothing up
  front. A round is the village's unit of time — one shift, one meal, one market — so the
  cost of credit is a cost per round, and making the simulation run faster no longer makes
  borrowing cheaper. (It used to: the dial was `RATE_PER_MIN`, 5% a *minute of real time*,
  so a round that went from 9.5s to 5s halved what a loan cost to hold for a round without
  anyone touching a dial.) 0.79% is exactly what the old dial charged at the original
  round: `0.05 × (9500/400 slots a round) / (60000/400 slots a minute) = 0.79167%`, so the
  credit economy is unchanged. Over a 30-round loan that is ~23.8% of the principal.
  The chain can only count slots, so `initialize` sends the rate over
  `ROUND_MS_EXPECTED / SLOT_MS` slots — one round's worth, at the slot length measured at
  startup, so neither `TICKS_PER_SLOT` nor the slot length changes what a round costs.
  What is left is that a run whose rounds are longer than `ROUND_MS_EXPECTED` (6.0s, the
  measured round at 100 LLM agents) pays in that proportion; the rate agents are *shown*
  is computed from the round actually measured (`world.mjs ratePerRound`), so the number
  they act on is always the number charged.
  The borrower picks a term of 10, 20 or 30 rounds (`TERM_ROUNDS`): the chain counts slots, so
  a new loan is sent with 0.8 × term × measured slots per round, and the keeper collects
  at the promised round, not before. A top-up keeps the due round. Repaying pays interest
  first; under 1 coin left owing is forgiven.
- **At the deadline, by anyone:** `liquidate` is permissionless once a loan is overdue or
  on a margin call (debt > `MARGIN` of the collateral). Overdue with the cash to cover it,
  the debt is simply collected from the debtor's cash — no penalty, collateral released.
  Otherwise it's a foreclosure: a 10% penalty, cash collected first, then only as many
  goods as needed are seized at 80% of the last price and sold into the auction (descending, §4); a
  seized item worth more than the shortfall is refunded in cash, and the rest go back.
  Losses bigger than the bank's cash become `bad_debt`. The keeper — a separate keypair
  with no authority — calls it on every overdue loan at its due round.
- **Dividend:** half the equity above `KAPPA × loans` plus a floor (the seed + 10%) is
  paid to every agent equally by the permissionless `pay_dividend`, once per round.
- **Books:** every identity in the `lib.rs` header (`Σ agent cash + bank cash = start
  money + seed + minted − principal repaid − written off`, the bank's cash, minted
  principal, seized goods at book, goods moving only by settled deltas) is checked every
  round by `analyze.mjs` and at the end by the headless summary.

### Findings from runs (`runs/`, analyzed with `analyze.mjs`)

- **LLM agents anchor on the price they're shown.** They post at or near it rather than
  forming expectations — consistent with the literature (§5). In early runs food was
  overproduced ~2× yet its price only rose, because sellers never saw the glut. Showing
  depth, sell-through and their own unfilled orders got the first price declines.
- **Agents don't borrow or invest on their own initiative** unless they can see why:
  nobody borrowed until rejected orders reached them, and then loans were for food, not
  investment. This is why FIX_PLAN adds wellbeing, houses and payback figures.
- **LLM reasoning is legible and mostly sensible** — e.g. correctly reasoning about
  committed vs. free inventory. Real model output, not scripted text.

---

## 3. What's on Solana

One Anchor program (`chain/programs/chain/src/lib.rs`), 5 goods, `MAX_AGENTS` 137 (the
most that fits under the 10 KiB create limit). The instructions:

```
initialize   ledger, purses, opening prices, bank equity + terms (LTV 0 = no credit),
             and the SETTLERS mint + vault (both PDAs), with the opening money minted
settle       signed goods deltas: catches, meals, fires, crafting, houses, spoilage
clear_auction  uniform-price batch auction for one good (the bank may sell)
borrow       lock goods, MINT coins (real SPL mint_to), borrower's term; capped by
             collateral AND bank capital
repay        accrued interest to equity, principal BURNED (real SPL burn); unlock when paid off
liquidate    PERMISSIONLESS: overdue → collect from cash, or foreclose; margin call →
             foreclose. Partial seizure at fire-sale value, excess refunded
pay_dividend PERMISSIONLESS: equity above requirement, to all agents
init_purses  one SPL token account per agent, a PDA that owns itself (chunked)
settle_cash  move real SETTLERS between purses until each holds that agent's cash
```

The `Ledger` is one zero-copy account: prices, `supply`, `debt_total`, the bank's books,
the terms, a `bank` slot (cash = equity, goods = seized collateral) and a fixed array of
`AgentSlot { cash, goods, locked, debt, principal, due_slot, accrued_slot }`. Byte offsets are
commented in `lib.rs` and decoded by hand in `chain.mjs` `fetch()`.

**Every write except `liquidate` and `pay_dividend` requires the ledger's `authority`
to sign** (`Write::load_checked`). Those two take any signer; the program itself checks
the loan is overdue by the chain's `Clock` or under margin at last prices.

### Per market round

1. The backend batches the round's catches, meals, crafting and spoilage as **signed
   deltas** in one or more `settle` transactions. No balance may go negative.
2. Loans and repayments are sent; the keeper calls `liquidate` on every overdue loan
   and margin call (collected or foreclosed, as the chain decides); `pay_dividend` is
   called if there's a surplus.
3. Each good's order book goes to `clear_auction`. **Orders are pre-sorted off-chain;
   the program verifies sortedness in one O(n) pass** rather than sorting on-chain. An
   unsorted book is rejected (verified with a real transaction).
4. The clearing price is the last price, clamped into the range where the book clears
   (the exchange-auction "closest to the reference price" rule), so a one-unit order can't
   move it without trading through every real order. Every fill settles atomically in that
   transaction.
5. The backend reads the ledger back and replaces its local mirror — **the chain is the
   source of truth**.

Nothing moves while a round settles: rounds are turns, so the next decisions start only
after it. Auctions and the dividend go out in parallel (~1.2s per round at 30 agents).

### Measured compute (early load test, `solana-test-validator`)

| Instruction | Compute units | Share of 1.4M budget |
|---|---|---|
| `initialize(100)` | 4,882 | 0.3% |
| `settle(40 deltas)` | 2,491 | 0.2% |
| `clear_auction(100 orders)` | 12,717 | 0.9% |

Compute is not the constraint; transaction **size** is. At 100 agents a `clear_auction`
transaction was 1220 of 1232 legacy-transaction bytes.

### SETTLERS, the coin

The money is an SPL token. The mint is a PDA at `["settlers", ledger]` and **is its own
mint and freeze authority**, so no key that could mint or freeze a SETTLER exists
anywhere. It has 2 decimals, so one token base unit is one cent — the unit `cash` is
already held in, with no conversion anywhere. Every coin sits in one vault, a PDA at
`["vault", ledger]` owned by the mint.

Minting and burning are derived from the books rather than restated: each instruction
snapshots `(minted, principal_repaid + written_off)` on entry, and on exit mints or burns
the difference and asserts

```
SETTLERS supply = Σ agent cash + bank cash
```

so a wrong burn fails the next transaction that touches the mint. `settle` and
`pay_dividend` never carry the mint — neither can change the total. `clear_auction` takes
it as **optional accounts**, required exactly when the asks contain a `BANK` order: a fire
sale paying down `bad_debt` is the one way an auction destroys coins, and an ordinary
auction (the transaction closest to the size limit) pays 3 bytes rather than 96 to leave
them off.

Verified end to end by `backend/scripts/check-settlers.sh`, which runs a village through
every one of those paths on a validator of its own (port 8999, never 8899).

### Purses: the agents hold the coin themselves

Every agent has a purse — an SPL token account at `["purse", ledger, agent]` that, like
the mint, **is its own owner**, so no key that could spend an agent's coins exists
anywhere. The ledger stays the source of truth for the economics; `settle_cash` then
moves real SETTLERS until every purse holds what that agent's slot says.

`settle_money` reconciles the *total* — how many coins exist. `settle_cash` reconciles
the *distribution* — who holds them — in the same spirit: the caller says only which
agents to look at, and the program derives every transfer from the gap between a purse's
balance and its `cash`. Agents who owe coins are paired against agents who are owed them,
so **an auction settles as direct transfers between the villagers who traded**, never
through the bank. A chunk that doesn't net to zero settles the remainder against the
vault, which is what lets the caller chunk purely by size. It ends by proving itself:
every purse it touched must equal its slot, or the transaction fails.

No existing instruction changed. `borrow` still mints into the vault and `repay` still
burns from it; the coins reach and leave an agent's purse on the next pass, which the
round loop runs as soon as the round's writes are done.

**A burn takes coins out of the vault, and the vault holds only the bank's cash.** Every
other SETTLER in existence is in an agent's purse. But the coins a repayment or a
foreclosure *destroys* are the debtor's, not the bank's — so the burn was asking the bank
to front them, and once write-offs had eaten the bank's cash the vault was empty and the
SPL burn came back `0x1`, "insufficient funds". Long runs reached that state and then
every foreclosure reverted for good: 20 failures in a 111-round load test, and faster
rounds get there inside a minute.

So `repay` and `liquidate` now carry the debtor's purse as a **remaining account** (no
instruction data, `Accounts` struct, discriminator or IDL changed, and a caller that sends
none behaves exactly as before), and `fund_burn` moves the coins home before burning: it
takes from that purse the larger of what the burn is short and what the purse is holding
that the ledger no longer says is that agent's. The second half matters as much as the
first — leaving the interest and the penalty behind in the purse was what made the vault
drift below the bank's cash, so the *next* foreclosure in the same round found it short
even though its own debtor was good for it. Nothing about the economy moves: the debtor's
`cash` has already been reduced by at least this much, and `settle_cash` would have moved
exactly these coins at the end of the round anyway. The purse is checked against its PDA,
so no other account can be drained. Verified at 100 agents over 206 rounds: **0 failures,
every invariant intact**, and `check-purses.sh` (32/32) and `check-settlers.sh` (30/30)
still pass unchanged.

20 purses per transaction: ~640 bytes of account keys and, measured on a validator,
80,522 compute units in the worst case (nothing pairs, all 20 paid from the vault) and
66,758 when trades pair. Both are inside the **default** 200,000, so this needs no
compute-budget instruction, no address lookup table and no v0 transactions — the chunk
size is the only knob. `MAX_AGENTS` stays 137.

Verified by `backend/scripts/check-purses.sh` (port 8997, never 8899): 32 checks over
purse creation, the opening pay-out, an auction that moves coins straight from the
buyer's purse to the seller's, a loan, a repayment, a dividend, and a call handing over
the wrong purse, which is refused.

**On devnet:** `backend/scripts/deploy-devnet.sh` deploys the program (~1.11 SOL of rent)
and then walks one village through the whole monetary story slowly enough for devnet's
rate limit — a loan, a repayment, a collection, a foreclosure, a fire sale, a dividend —
leaving a mint anyone can open in Solana Explorer. The live simulation still runs against
a local validator; devnet's ~10 req/s is too slow for 3-second rounds.

### Gaps

- No standalone script for a judge to call `liquidate` themselves.
- No Metaplex token metadata, so explorers show the mint's address rather than the name
  "SETTLERS". The metadata program isn't on a bare `solana-test-validator`; on devnet it is.
- **The bank's fire sale is the one burn left without a purse to draw on.** Selling seized
  goods pays down `bad_debt`, which destroys coins — and those coins are spread across
  every buyer's purse, so there is no single account to pull them from. While bad debt is
  outstanding that auction can still come back `0x1`. It no longer costs the villagers
  their market: `world.mjs clearGood` sends the same book again without the bank's ask, so
  the village trades and the bank keeps the goods and marks them down again next round (2
  such rounds in 206). The proper fix is to credit the sale to the bank's cash and sweep
  the bad debt down inside `settle_cash`, which is the one instruction that can burn once
  every purse matches.

All of these are in FUTURE_PLAN.md §6.

---

## 4. The market

Uniform-price batch auction, once a round, per good, cleared on-chain (§3). Agents post
orders with `place_order` (optional `reason`); the backend checks them against the agent's
cash and goods first, so the chain is never sent an order that would fail.

- **Price-time priority:** at the same limit the older order (lower arrival `seq`) fills
  first, never the lower agent index. The bank's sale queues last at its price.
- **Standing orders:** what doesn't fill stands; each decision's orders replace the
  agent's standing ones (re-posting the same side, good and price at no larger quantity
  keeps its `seq`; posting none cancels them). An agent that times out keeps them.
  Remainders come from replaying the chain's fill walk, checked against the balances.
  Meals, fires and rot shrink an agent's own asks first.
- **Depth ladder** (`CFG.LADDER`): agents see last round's book before clearing (top 3
  levels a side), what sold and went unsold, and for each of their orders how much was
  queued ahead of it.
- **The bank's sale of seized goods descends:** from the price before the seizure, 5%
  lower each round nothing sells, never below its book value; never re-anchored on its own print.
- **No self-trades:** an order that would cross the agent's own opposite order is refused.

**Not an AMM:** its price is a function of reserves, not of agents disagreeing, and it
guarantees liquidity, which would hide scarcity.
**Not a continuous order book:** more code, and outcomes depend on message arrival
order, so runs can't be reconstructed from a saved log.

---

## 5. Agents

Every decision goes through the same tools (`backend/src/tools.mjs`), whichever brain
answers:

```
gather_food / gather_wood / craft_net / build_house / rest   — choose this round's shift (needs a reason)
set_lifestyle                                                 — food per meal, 1–3
place_order                                                   — limit order; stands until filled or replaced
borrow / repay                                                — bank loan, term 10/20/30 rounds (settles this round)
check_market                                                  — last round's book, prices and volumes
```

| Brain | File | Notes |
|---|---|---|
| `stub` | `brains/stub.mjs` | Free heuristic placeholder. No API key. For load tests. |
| `openai` | `brains/openai.mjs` | Chat Completions tool-calling, default `gpt-5.6-luna`. `reasoning_effort` must be `'none'` — gpt-5.x refuses tools otherwise. |
| `baseten` | `brains/baseten.mjs` | Baseten's OpenAI-compatible Model APIs. Each agent is dealt a model from a pool (`BASETEN_MODELS`) and keeps it for the run; stats are kept per model. |

Both real brains run the same decision loop, `brains/chat.mjs`; they differ only in client, prices and model choice.

Both real brains get the same system prompt (`brains/prompt.mjs`) and the same
per-turn observation: cash and goods (free vs. committed), hunger, wellbeing, lake
level, prices, sell-through, and a short memory of what just happened, including
rejected actions.

**One decision per agent per round**, all in parallel. The round closes as soon as
`DECIDE_QUORUM` of the village has answered (0.9; 1.0 waits for everyone, as it used to),
or at `DECIDE_TIMEOUT_MS` (8s), whichever comes first. The last tenth of a village is the
slow tenth: at 100 agents the slowest answer *was* the timeout itself while the median was
2.3s, so waiting for it cost more than half the round.

A villager the quorum leaves behind is treated exactly as one that ran out of time: the
call is aborted, `tools.close()` refuses anything it still tries, its draft orders are
dropped, and even the thought its reply carries is discarded — so a late answer can
neither touch the round that has run nor leak into the next one. It keeps its last job and
posts no orders. Both dials are live in the control panel, and each round reports
`decide.stragglers` and `decide.quorumMs` beside the old `timeouts` and `noAnswer`.

### Decisions on the wire

Each villager's decision is broadcast on `/events` **the moment that villager's own answer
lands**, not at the round barrier: at 100 agents the decisions of one round arrive spread
over several seconds, and the island can show each one acting as it comes in. `/state`
reflects the same thing at once (`agents[].activity` is `deciding` from the start of a
villager's turn until its answer arrives, then the task it chose).

```jsonc
{ "type": "decision", "t": 1758342000123, "tick": 7,
  "agent": 13, "name": "Tracyrus", "round": 8,     // the round being decided
  "ms": 3565,                                       // how long this villager took
  "outcome": "ok",                                  // "ok" | "timeout" | "error" | "no answer"
  "straggler": true,                                // only present when the quorum moved on without it
  "kept": false,                                    // true = it repeated its last job (no answer)
  "activity": "build_house",                        // the shift it chose, or null
  "place": "building site",                         // where that shift happens (CFG.TASKS[...].place)
  "thought": "…",                                   // its own one-line reason
  "orders": [{ "side": "buy", "good": "wood", "qty": 31, "limit": 100, "seq": 3 }],  // limit in cents
  "saw": "…", "actions": [ … ]                      // the full prompt and every tool call, for the run log
}
```

`straggler` and `place` were added beside the existing fields; nothing was renamed or
removed. Two other per-agent events land during the same window and are worth listening
for: `activity` (`{agent, name, task, kept}`), emitted the instant the shift is chosen —
before the decision is even finished — and `order` (`{agent, name, side, good, qty, price,
seq, reason?, stall?, shop?}`) for each order as it is posted.

### Speed, measured (100 agents, `gpt-5.6-luna`, 100ms slots)

| | before | after |
|---|---|---|
| round length | 9.5s | **6.4s** (5.9s before the provider throttled us) |
| rounds a minute | 6.2 | **9.4** |
| the chain half of a round | 2.35s | **0.92s** |
| wait for the decide phase, median | 7.3s | **5.0s** |
| turns that timed out | 122 / 3,100 (3.9%) | 11 / 1,100 (1.0%) |
| villagers the quorum left behind | — | 100 / 1,100 (9.1%) |
| villagers that answered nothing | 88 | 52 |
| 429s per call | 0.59 (`LLM_CONCURRENCY=100`) | 0.37 (`=50`) |

Three things bought that: the quorum close (§5), 100ms slots (§7), and the earlier round
of behaviour-neutral work on the chain phase.

**There is no concurrency setting any more** (that run had one, `LLM_CONCURRENCY`, since
removed): every villager calls the model at once, so concurrency is the number of agents,
and the village's size is chosen on the dashboard beside Start (default 100, up to the
ledger's 137). The provider's limit is **per minute**, and faster rounds spend it
faster: this run was clean for 9 rounds, then 429s arrived at ~1,000 calls a minute and
the next round's median decision went 3.3s → 5.3s. That, not concurrency, is now the
ceiling at 100 agents — a higher-tier key, or a shorter observation, is what moves it.
A village of 30 runs at ~3.6s a round and never sees a 429.

### Cost, measured

From `final.json` of saved runs on `gpt-5.6-luna`, reasoning off:
- 10 agents, 2¼ min: 440 calls, $0.15 — ≈ $0.07/min, $0.00035/call.
- 30 agents, 6 min: 3,059 calls, $1.33 — ≈ $0.22/min, $0.00044/call.

### Honesty about LLM agents

- LLM traders price near fundamentals and rarely speculate
  ([arXiv 2502.15800](https://arxiv.org/abs/2502.15800)) — matches what we see.
- Behavioral magnitudes are prompt-tunable
  ([arXiv 2604.18373](https://arxiv.org/abs/2604.18373)) — if asked "did you prompt them
  into that?", the answer is "the prompt is on screen, read it." Ground rule: the prompt
  gives true information and real economics, never steering.
- LLM algorithmic collusion is documented
  ([arXiv 2404.00806](https://arxiv.org/abs/2404.00806)) — if agents converge on similar
  prices, that's real and citable.
- LLM calls are non-deterministic; runs are not bit-reproducible. The saved log (§6)
  lets a run be analyzed after the fact; it is not a replay.

---

## 6. Logging and analysis

Every run is saved automatically in `runs/<timestamp>/` (gitignored):

```
meta.json       config, agent names/traits, program + ledger address, start time
events.jsonl    every decision (what the agent saw · thought · did), every order,
                every round (prices, volumes, order book, trades, spoilage, every agent's state)
final.json      on-chain balances read back after Stop, LLM call stats and cost
```

```bash
node backend/scripts/analyze.mjs                  # the latest run
node backend/scripts/analyze.mjs runs/2026-09-19T17-04-02
```

It reports which goods traded and how prices moved, what agents chose and which orders
were rejected (and why), hunger and spoilage, the economy round by round (GDP, price
index and inflation, employment, slack, wellbeing, Gini, credit, money, houses built and
construction loans), the bank's books and every invariant, loans collected vs.
foreclosed, final standings, and a sample of agents' reasoning. Older runs (3 or 4
goods, no metrics) still analyze.

---

## 7. Solana specifics worth remembering

- **Transaction V1** shipped to mainnet 2026-09-15 (SIMD-0385, epoch 1035): max
  transaction size 1232 → 4096 bytes. Not adopted yet (still legacy transactions), but
  it's the answer to growing past ~100 agents in one atomic auction.
- **`solana-test-validator`** (`http://127.0.0.1:8899`) is what this is developed
  against, not devnet — devnet's public RPC limit (~10 req/s) is too slow for the sim.
- **`--ticks-per-slot 16` (~100ms slots) is the default** in `backend/scripts/validator.sh`,
  because almost all of a round's chain time is waiting for confirmations and a
  confirmation can't come sooner than a slot. At 100 agents it takes the chain half of a
  round from 2.35s to 0.92s. Two things had to be true first: the blockhash cache is
  retired well inside 150 slots (`chain.mjs BLOCKHASH_TTL`, which is what "Blockhash not
  found" used to be at short slots), and the bank's rate is per round rather than per
  minute of real time, so shorter slots no longer change what credit costs. Measured over
  206 rounds at 100 agents: no blockhash failure, every invariant intact. It costs about
  twice the CPU; `TICKS_PER_SLOT=64` gives Solana's own 400ms slots back.
- **Anchor's JS `BorshInstructionCoder` caps instruction data at 1000 bytes** and a full
  order book overflows it with an unhelpful `ERR_OUT_OF_RANGE`. Instructions are
  hand-encoded in `chain.mjs` instead of `program.methods.*`.
- **Accounts created via CPI are capped at 10,240 bytes**, which bounds `MAX_AGENTS` for
  a given `AgentSlot` size.
- **`AccountLoader` + `zero_copy` needs `bytemuck` as a direct dependency** with the
  `derive` and `min_const_generics` features; Anchor doesn't pull it in.
- **LiteSVM 0.10.0 (as `anchor init` scaffolds) works on stable Rust; 0.16.0 needs
  nightly.** We test against a real local validator instead.

---

## 8. Prior art

| Project | What it proves | Use |
|---|---|---|
| [a16z-infra/ai-town](https://github.com/a16z-infra/ai-town) — MIT, React+PixiJS+Convex | A browser agent town with a tick sim works | PixiJS setup, not its conversation-oriented game loop |
| [Mercatorio](https://mercatorio.io/) | Production chains + order-book prices are legible to players | Economy UI reference |
| [manicinc/wunderland-sol](https://github.com/manicinc/wunderland-sol) | Per-agent on-chain identity as PDAs | Reference for identity PDAs |
| [salesforce/ai-economist](https://github.com/salesforce/ai-economist) | Gather-trade-build with houses and a wellbeing goal | Source of our wellbeing goal and houses |
| EconAgent (ACL 2024) | LLM agents choosing work and consumption reproduce macro regularities | Source of lifestyle choice and reflection (see FIX_PLAN) |
| [Moltlets World](https://web.archive.org/web/20260225082836/https://moltlets.world/) (site now 404s) | Fish/chop/build/sell is engaging | Inspected directly: its "on-chain" was SPL Memo summaries; the economy lived in SQLite and the server could recover every agent key. Our ledger is the actual source of truth. |

**Unoccupied, as far as we found:** credit, default and foreclosure as real on-chain
instructions a stranger can call.

---

## 9. Decisions

- **Agents are LLMs with tool calls**, not heuristics that resemble reasoning.
- **Default brain is OpenAI `gpt-5.6-luna`**, Claude Haiku as an alternative, switchable
  via `BRAIN=`.
- **30 agents** in `.env` (config default is 10); `AGENTS` scales it.
- **Goal is wellbeing plus a value for end wealth**, not most money — hoarding money is
  what caused the food glut.
- **Coins never spoil; food and wood do** — holding money stores value, and surplus goods
  must be sold or lost.
- **Public bank:** terms are policy set in config (a central-bank panel later), not
  chosen for profit.
- **Change the economics or fix the information, never steer the result in the prompt.**

---

## 10. The front end

The island and the admin panel are **one page** (`web/`, Vite). The island's 3D scene and the
`/events` stream are created once and live for as long as the tab does: switching views only
moves them. In the admin panel the island keeps rendering as a small live inset in
the top right corner, at about 8 fps; clicking it expands it to the full island, and `Esc`
or the "Detailed dashboard" button goes back. The view is the URL (`/` island,
`/dashboard` admin), so links and the back button work.

```bash
npm run web:install          # once
npm run web:build            # build to web/dist; the backend then serves it
npm start                    # the village, serving web/dist at http://localhost:8787

npm run web:dev              # Vite on http://localhost:5183, proxying to the backend
BACKEND=http://127.0.0.1:8811 npm run web:dev    # ...to a different backend
```

`backend/src/server.mjs` serves `web/dist` with a single-page fallback when it exists, and the
old standalone pages (`frontend/Moku Island.dc.html`, `backend/public/index.html`) when it
doesn't, so the village runs whether or not the app has been built.

One store (`web/src/store.js`) polls `/state` once a second and holds the one `EventSource`;
every view reads from it. The panel's charts share a range toggle (all rounds, or the last 50)
that is remembered in `localStorage`, and long runs are drawn from a sample of at most 400
points.

**Nobody moves in a lump.** A round's hundred answers land spread over a few seconds, and the
island shows each villager the moment *their own* answer lands rather than all of them at the
barrier. `web/src/island/pulse.js` turns the per-agent events — `decision` first, else
`activity` / `order` / `borrow` / `repay` — into one "act" per villager per round: the first
event of the round from an agent starts their act, everything after it that round fills it in.
That act is what walks that one blob to its new workplace and writes its line
on the market wire and the live feed. `/state` is still the truth — first load, reconnection,
drift — but it only sets villagers whose news the pulse does not already hold (`owns()`),
so a poll landing mid-burst can never gather the village up again. The market trip after a
settle is per villager too: each sets off in their own moment and leaves the moment their own
next answer arrives, and dusk follows the size of the crowd rather than a flag.

A burst (the stub brain, or a quorum close) is spread over at most 1.5 s, a gap of
`1500 ms / villagers` at a time, and the queue is always released at the round barrier — so
nobody ever lags more than 1.5 s behind their own event or spills into the next round. Answers
that are already spread out, as a real model's are, find the queue empty and pass through
untouched. `?jitter=1200` is a test-only front-end flag: it holds each agent's events back by
its own slice of that many ms, so the stub can be made to arrive like a model. Nothing in the
backend knows about it.
