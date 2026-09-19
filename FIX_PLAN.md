# Fix plan: make it a real economy

Written 2026-09-19 after two runs with the bank (`runs/2026-09-19T15-47-38`, `runs/2026-09-19T17-04-02`)
and six research passes. This is the work to do **now**. Later features live in `FUTURE_PLAN.md`.

**The goal:** a small economy where workers choose what to do, prices come from supply and
demand, and we can play central bank — change interest rates, turn credit on and off, print
money, cause a storm — and watch the economy respond.

---

## What the research taught us

| Source | How they did it | What we take |
|---|---|---|
| **EconAgent** (ACL 2024) | LLM agents choose **how much to work** and **what share of their money to spend** each month. A Taylor-rule central bank sets rates. Agents get prose perception ("prices rose…") and a reflection step every 3 months. Reproduced the Phillips curve and Okun's law. Weak spots: no real market (price by formula), wages minted from nothing. | Consumption and work are *choices*, so demand and labor supply respond to prices and rates. Perception in words. Reflection (their results broke without it). Their metrics. |
| **AI Economist** (Salesforce) | RL agents; utility = enjoyment of coin (diminishing) **minus effort**. Houses built from wood + stone were the capital good; skill differences produced builders vs. gatherers. A planner set taxes; metric = equality × productivity. | A wellbeing goal with diminishing returns and a cost to working. Houses. Specialization. Their metrics. |
| **CATS / JAMEL / Mark-0 / EURACE** (classic credit models) | Credit exists because **spending comes before the revenue**: firms pay wages before sales, and capital takes time to build. Bank capital limits lending; collateral valued at market prices; defaults spread. Stock-flow consistent books. | Big investments (houses, boats) that cost more than savings and pay off later. A bank whose rules are policy. Exact books (we have these). |
| **LLM behaviour** (2024–26 papers) | LLM agents anchor on shown prices, are near-rational and similar to each other, rarely invest on their own. Reasoning and memory of outcomes help; "don't anchor" instructions don't. | Show outcomes and sell-through, not just the last price. A reflection/plan step. Never steer with instructions. |
| **Our two runs** | Nobody borrowed until they could see rejections; then 22 loans, but for food, not investment. Food ≈2× what was eaten (glut), price stuck at ~5.20, 2,166 food rotted. The bank acted like a profit-seeking lender. | See "What's wrong" below. |

## What's wrong now

The bank isn't the root problem. The economy has four structural gaps, and until they're closed
no bank policy can change GDP:

1. **Nobody wants more than survival.** Agents eat a fixed amount and their goal is to hoard money,
   so demand can't grow with income. Extra output just rots (the glut).
2. **Working has no cost.** No leisure, so everyone works all the time and supply can't respond to
   prices or wages.
3. **Nothing worth investing in costs more than an agent has.** A net costs 4–7 wood anyone can cut.
   Credit only matters when a good project needs money up front.
4. **The bank is a profit-seeking lender, not a policy tool.** It seized collateral beyond the debt
   and paid that out as "profit". Its terms are fixed. There's no way to run it differently.

Plus fixable problems: sellers anchor at ~5.20 with no feedback; three foreclosures came from bad
rules (0.11 leftover, pledged net can't fish, whole net seized for a 1.91 debt); two bugs ("due NOW"
right after borrowing; malformed tool calls run with `{}`).

---

## The design

### 1. People want things: wellbeing is the goal
- **Goal changes from "most money" to "the best life": the most total wellbeing over the run.**
  Money is a means. (AI Economist and EconAgent both do this.)
- **Wellbeing per meal period**, diminishing, shown to each agent as a line item:
  - eating: a **lifestyle** the agent chooses — eat 1, 2 or 3 food per meal. log-shaped: 1 → +1.0,
    2 → +1.6, 3 → +2.0. Missing a meal → −2.
  - warmth: +0.5 when warm; cold → −1.
  - a **house**: +1.5 comfort per meal period.
  - **rest**: a rest shift is worth +1.0 (leisure has value, so work is a choice).
- **`set_lifestyle(1|2|3)` tool** — a standing choice, like EconAgent's consumption share, so food
  demand now rises with income and falls when food is dear. This is what absorbs the glut.
- Starting numbers are tunables in `config.mjs`; show the formula to agents.

### 2. Work choice, supply and demand
- Keep random seeded skills and "choose your shift". Add leisure (above).
- **Fish is a shared lake**: catch = base × skill × stock/capacity; the lake regrows (logistic).
  Overfishing lowers everyone's catch, so food supply is bounded and the food price moves.
  Agents see the lake level.
- **Show sell-through, not just the last price**: "last round 3 of 29 offered food sold"; and each
  agent's own fills: "your 5 food asks at 5.20: 0 filled". The missing feedback behind anchoring.
- Earnings per job valued at what actually sells.

### 3. Big investments: houses and boats
Both cost far more than an agent's savings and pay off over time — the thing that makes credit
necessary.
- **House** (consumer durable → **mortgage**): ~16 wood + 3 shifts (crafting skill cuts the wood).
  Gives +1.5 wellbeing per meal period, halves firewood, stores up to 10 food without rot.
  Tradable. Everyone wants one. Big wood demand → woodcutters have customers.
- **Boat** (business capital → **business loan**): ~20 wood + 3 shifts. Reaches a separate
  **deep-water stock** the lake can't, so its catch doesn't just deplete the shared lake. Tradable.
- **Construction finance:** starting a build turns the wood into the unfinished house/boat at once
  (it exists on-chain as the good; the sim marks it unfinished until the shifts are done), so it
  can be pledged for a construction loan before it's finished.
- **Pledged goods stay usable** (a lien, not a pawn shop): you live in your mortgaged house and fish
  from your pledged boat.
- Observation shows payback from real numbers: cost at market, wellbeing or extra catch per shift,
  loan cost at current terms.

### 4. The bank becomes a policy tool
- **A public bank:** it doesn't try to profit. Its terms are **set by the central bank** (you).
  Interest and penalties go into its capital; surplus above its buffer goes back to villagers
  equally (like a central bank remitting profit).
- **Interest by time held** (pro-rata per slot) and a **borrower-chosen term** (1, 2 or 3 minutes).
- **Foreclosure takes only the debt + penalty;** any excess value is refunded to the borrower.
  Seized goods booked at fire-sale value. Leftovers under 1 coin are forgiven.
- **Lending can be switched off** entirely (the no-credit regime).

### 5. You are the central bank (interactivity)
A dashboard control panel. Every change is an on-chain transaction signed by a separate
**central-bank key** (public, auditable), and announced truthfully to agents ("The central bank
cut the interest rate from 10% to 4% at round 40").
- **Levers:** interest rate · credit on/off · pledge limit (LTV) · margin-call level · loan term ·
  capital requirement.
- **Tools:** helicopter money (mint N coins to everyone, booked as central-bank issuance so the
  invariants still hold).
- **Shocks:** storm (no fishing for N rounds) · cold snap (double firewood) · bumper catch.
- **Regimes as presets:** no credit · cheap credit · tight credit · helicopter money · optional
  Taylor-rule autopilot (EconAgent/JAMEL formula) vs. manual.

### 6. Measure it like an economy
On the dashboard and in `analyze.mjs`:
- **GDP** per round: everything produced (fish, wood, nets, houses, boats) at current prices.
- **Inflation** (price index), **employment** (share of shifts worked vs. rested), **slack**
  (output that didn't sell), **average wellbeing**, **inequality** (Gini, equality × productivity),
  **credit outstanding**, **money supply**.
- **Policy changes and shocks marked** on every chart's timeline.
- **Compare two runs** of the same seed (same village) side by side — the policy experiment.

### 7. Agents that can learn from outcomes
- Outcome ledger in the observation: recent shifts and yields, fills, wellbeing trend.
- A **reflect-and-plan** call every ~6 decisions (no tools, reasoning low, <80 words); the plan is
  shown in later observations. (EconAgent.)
- Perception in words: "food got 12% dearer since your last decision".
- **Ground rule:** true information and real economics only — no "consider borrowing", no
  "don't anchor". Judges may read the prompt.

### What stays
The on-chain batch auction, the on-chain bank and its books and invariants, permissionless
foreclosure, seeded skills, the frozen clock during settlement, the dashboard.

---

## What the demo must show (acceptance tests)

Each run uses the same seed so the village is identical.

1. **No credit vs. cheap credit:** with credit, more houses and boats get built and GDP and
   wellbeing end higher.
2. **Rate hike mid-run:** borrowing and building fall within ~10 rounds; wood price falls;
   woodcutters rest or switch jobs.
3. **Storm:** food price spikes, lifestyles drop, consumption loans and foreclosures rise.
4. **Helicopter money:** money supply up → prices up (inflation visible).
5. **Supply and demand:** overfishing lowers the lake and raises the food price; labor shifts.

If any of these doesn't happen, that's a finding to explain, not a thing to prompt away.

---

## Scope: what to build now, what next, what's nice to have

**Now — build, then measure:**
1. Wellbeing goal + lifestyle choice + leisure (demand).
2. Fish lake + sell-through and own fills (supply, prices).
3. Houses, with construction loans and pledged goods staying usable (first big investment).
4. Bank fixes: interest per slot, term choice, refund excess on foreclosure, forgive < 1 coin, bugs.
5. Metrics: GDP, inflation, employment, average wellbeing (dashboard + analyzer).
6. Bank terms from config (no sliders yet). LTV = 0 gives a "no credit" run, enforced on-chain.

The on-chain pass adds **both** boats and houses as goods now so the layout changes once; only
houses get gameplay now.

**Measure:** two short runs of the same seed, no credit vs. credit. Credit should give more houses
and higher GDP and wellbeing. If yes, go on.

**Next:** boats (+ deep-water stock); the central-bank panel (sliders, shock buttons, policy
markers, `set_terms` + central-bank key); reflect-and-plan; comparing two runs side by side.

**Nice to have:** Taylor-rule autopilot; helicopter-money button (`stimulus`); cold snap, bumper
catch; inequality charts; 100-agent demo and the items in `FUTURE_PLAN.md`.

## Decisions (agreed 2026-09-19)

1. **Goal:** the best life — total wellbeing, **plus a value for the wealth you end with**, so
   getting richer still counts and saving is meaningful. Markets, prices, competition and profit
   all stay; money is wanted for what it buys (hoarding everything is what caused the glut).
2. **Wellbeing numbers** as above; tune after the first run.
3. **Public bank.** Terms set in config for now, sliders later. Starting values:

| Setting | Value |
|---|---|
| Interest | 5% per minute, charged by time held (per slot) |
| Loan term | borrower picks 1, 2 or 3 minutes |
| Pledge limit (LTV) | 60% · margin call at 80% · late penalty 10% |
| Bank capital requirement (κ) | 10% |
| Starting cash | 30 coins (a house ≈ 16 wood + 3 shifts ≈ 70 coins can't be bought outright) |
| No-credit run | LTV = 0 |

## Build order

| Step | Agent | Owns | Runs with | ≈Hours |
|---|---|---|---|---|
| A | **On-chain**: goods become food, wood, nets, boats, houses; interest per slot + borrower-chosen term; refund excess on foreclosure; seized goods at fire value; forgive < 1 coin; dividend buffer; terms from `initialize` (LTV 0 = no credit); books + invariants; scripted check on its own validator | `lib.rs`, `chain.mjs` | B | 3 |
| B | **Economics in the sim**: wellbeing goal + lifestyle + leisure; fish lake; bugs; pledged goods usable; sell-through and own fills; config values above | `config.mjs`, `world.mjs`, `tools.mjs`, `prompt.mjs`, brains | A | 3 |
| C | **Houses + metrics**: build tool, unfinished builds, construction loans, payback line; wire to A's chain API; GDP / inflation / employment / wellbeing on the dashboard and analyzer | sim + `server.mjs`, `public/index.html`, `scripts/analyze.mjs` | — (after A, B) | 3 |
| D | **Market fixes** (agreed 2026-09-19): (1) ties by first come, first served (price-time priority); (2) orders stand until the agent's next decision, renewed each round, committed goods still rot/eatable, "your standing orders" shown; (3) **turn-based rounds** — every round all agents decide together, the clock waits (timeout → keep last job), then the round's work and market run; meals, fires and loan terms counted in rounds; (4) fairer clearing price, (5) descending bank fire sale, (6) depth ladder — each being researched first; (7) trim-before-cash bug + time labels | `world.mjs`, `tools.mjs`, `prompt.mjs`, `server.mjs`, `brains/*`, `lib.rs` | — (after C) | 6 |
| — | **Checkpoint:** free stub check → your two runs (no credit vs. credit) → commit + push | | | |
| Next | Boats; central-bank panel; reflect-and-plan; run comparison | | | |

## Market audit (2026-09-19, runs 17-04-02 and 15-47-38)

The core auction is sound: a real uniform-price double auction, deterministic, sort checked
on-chain, no fill ever breaks a limit (reconstructed 188/193 auctions exactly; the 5 misses are
bank fire-sale rounds). Flaws, ranked:

1. **Must-fix — tie order favours low agent indices** (419/419 tied comparisons won by the lower
   index; agents 0–7 got 23% of food ask fills vs 7% for 23–29). Random tie order per round, JS only.
2. **Must-fix — thin books, stale prices.** Orders live one round but agents post only when they
   decide: 57% of agents have a live order per round; food untraded in 48/99 rounds, wood 59/99.
   Orders should stand until the agent's next decision or until filled (JS only — the book is
   off-chain). Committed goods must still rot and be eatable, or asks become a rot shelter.
3. **Should-fix — model latency is lost work.** Agents are thinking 34% of the time (11.0 of 16.8
   possible shifts per minute), so latency is a hidden supply parameter. Keep working the last job
   while the model thinks, or queue the next shift during the current one.
4. **Should-fix — clearing price in gluts.** Midpoint of the marginal pair printed above willing,
   unfilled sellers in 63/90 glut rounds, ratcheting food up (5.00 → 5.35 with 51 asks, 0 bids).
   Use the midpoint of the full clearing range (Budish et al.; exchange auctions). On-chain.
5. **Should-fix — bank fire sale knocks ~10% off the print**, which is also the collateral price
   (possible margin-call cascade). Descending price: start at last price, −5% a round, floor 80%.
6. **Should-fix (low) — depth ladder** in the observation ("38 already asked at 5.20 ahead of you;
   0 bids"): true information that gives a reason to undercut.
7. **Fine as is:** 96-order trim (max seen 20), frozen clock, rounding, goods-order cash
   allocation (fix the small trim-after-cash bug), time labels (~20% off).
