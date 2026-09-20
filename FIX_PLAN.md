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

## Step D: the market fix (spec, from the market audit and research #4–#6)

Agreed with the user 2026-09-19. Two builders in parallel: **on-chain** (D4 only, `lib.rs` +
`chain.mjs`) and **sim** (everything else). Evidence and sources are in the research reports
summarized above; baselines are from `runs/2026-09-19T17-04-02`.

**D1. Price-time priority.** At the same limit, the older order fills first (sort by limit, then
arrival `seq`; never by agent index). A standing order keeps its `seq`; a new or changed order gets
a new one. Within one round everyone decides at once, so arrival order there is effectively the
model's response time — acceptable. The bank's orders queue last at their price (`seq = +∞`).
The program only checks sortedness by limit, so this is JS-only.

**D2. Standing orders.** An order stands until it fills or the agent's next decision replaces it
(each decision's `place_order` calls replace that agent's standing orders; posting nothing at a
decision cancels them). Track the remainder after partial fills by replaying the chain's fill walk.
The observation lists them: `Standing: sell 5 food at 5.20 (30 ahead of you as of last round)`.
Committed goods still rot and can still be eaten/burned — meals and fires first shrink the agent's
own asks — so asking high is not a way to shelter goods.

**D3. Turn-based rounds.** Each round: every agent decides at the same time (all LLM calls in
parallel), the clock waits until all have answered (timeout ≈ 15s → the agent keeps its last job
and standing orders), then the round's work, meals, fires and the market run. A shift = one round.
Meals, fires and loan terms are stated in rounds, and loan terms are converted to slots on-chain
from the measured round length (or rounds become the on-chain unit — builder's call, state it).
All time labels shown to agents must be true. Calls per minute should fall (one decision per agent
per round).

**D4. Clearing price (on-chain).** After the existing walk, clamp the reference price into the full
clearing range:
```
nb = next unfilled bid limit (0 if none); na = next unfilled ask limit (u64::MAX if none)
     // a partly filled order counts as unfilled at its limit
lo = max(last_filled_ask, nb); hi = min(last_filled_bid, na); require lo <= hi
price = clamp(last_price[g], lo, hi), at least 1
```
Same as today when nothing crosses. Tests (last price 500 unless noted): glut bid 1@535 vs asks
10@520 → 520; shortage bids 10@480 vs ask 1@450 → 480; bid 2@510 vs ask 2@490 → 500 (last 600 →
510, last 400 → 490); bids 2@520,3@505 vs asks 2@480,4@510 → 505; no cross → unchanged; one side
empty → unchanged; manipulation bids 1@5000,1@500 vs ask 1@500 → 500; penny ask 1@1 + 2@500 vs bid
2@500 → 500; equal limits → first ask in the ladder fills, 500; bank ask partly filled → books and
supply correct; last price 1 → 1, bid at u32::MAX → no overflow; sortedness still enforced.

**D5. Bank sale of seized goods: descending.** Per good `W.bankSale[g] = {anchor, k}`. On seizure:
`anchor = max(anchor, price before the sale)`, `k = 0`. Each round the bank asks everything it holds
at `max(bookUnit, round(anchor × (1 − 0.05k)))` where `bookUnit = ceil(bank_book[g] / bank goods[g])`
(= 80% of the seizure price); after the clear: no bank fill → `k++`; partial → keep `k`; sold out →
clear the state. Never re-anchor on the bank's own print. Agents are told: "The bank is selling 6
wood from foreclosures at 3.10; the price drops 5% each round it goes unsold."

**D6. Depth ladder (behind `CFG.LADDER`, default on).** Replace the cheapest-ask/best-bid wording
with last round's book before clearing, top 3 levels per side, then the result:
`food: last traded 5.22. Last round: asks 5.20×38 · 5.35×4 · 5.50×6 (+3 higher); bids 5.25×3. 3
sold at 5.22; 45 offered went unsold.` Own fills: `your 5 food asks at 5.20: 0 filled — 30 food at
5.20 or less was queued ahead of yours; buyers took 3.` Empty book: `boat: no orders, last traded
80.00`. No indicative price, nothing that steers. Keep per round `W.lastLadder[g]` (top 3 `[price,
qty]` per side + remaining level count, price, sold, unsold/unfilled) and per order `seq`, queue-ahead
(better prices + same price with earlier `seq`, computed before clearing) and filled qty. Add an
optional `reason` to `place_order`. **Trim** so the observation gets shorter overall: the own-fill
"(X of Y offered sold)" repeat; "You eat N food every…/burn 1 wood…" (the lifestyle line has it);
"Pledged goods are locked…do not rot" (prompt + borrow tool have it); the "about 10%… rots" line
(prompt has it); "Coins in circulation…" (only when the central bank acts).

**D7. Small fixes.** Refuse an order that would cross the agent's own opposite-side order in the
same good (self-trade can set the collateral price in an empty book). Trim to 96 orders before
deducting cash, not after. Time labels true (solved by D3).

**Verify** (free stub + D4's on-chain tests). Next real runs should show, against the 17-04-02
baselines: food sells below the previous best ask > 0% (was 0%); price cuts that break the floor
after a hopeless ask ≫ 4/245; food price falls in glut rounds; asks-only food rounds < 47/99;
share of agents with a live order ≫ 57%; tied-price fills not correlated with agent index; bank
sale prints within ~3% of the no-bank clear; distinct ask levels per round not collapsing to 1
(herding check).

**Not changed now:** house tuning (open question to the user), collateral valued at a median of
prints (later, on-chain), 96-order limit, rounding.

## Step E: dashboard declutter (queued after step D)

Agreed with the user 2026-09-19: too many charts, all the same size. A viewer should see at a glance
whether the economy is growing, what money and credit are doing, and who's winning.

- **Big (the demo):** GDP over time; money supply + credit outstanding on one chart (room above it
  for the future central-bank panel, and policy markers later); prices of all goods on ONE chart
  (lines, normalized or dual-scale — readable); the stacked jobs chart; "who's winning" wealth bars;
  the bank feed (loans, collections, foreclosures, with Solana tx links).
- **Small tiles** (number + tiny sparkline, click to expand to a full chart): inflation, average
  wellbeing, employment, Gini, houses built, lake level, bank capital.
- **Collapsed "details" section:** order book / depth, loans coming due (collected / foreclosed /
  margin call), hungry & cold, goods held, slack, per-good price charts, round log, the full agent
  table (collapsed or top 10 with "show all").
- Keep the plain monospace style and existing chart helpers; no new libraries. Responsive enough for
  a laptop screen during a demo. Check with a headless-Chrome screenshot.

## Step F: fix what the step-D run showed (runs/2026-09-19T19-12-49, credit off, 79 rounds)

**Diagnosis (three read-only audits agree):** the step-D machinery is correct — ladder text matched the
books in 11,700/11,700 lines, standing orders/priority/replay exact, conservation every round, no
errors. The economy stalled because of what agents are told and how they decide:
- **Every order sat at the last price** (583/583 food asks at 5.00; 0/164 bids above; 465 order
  reasons cite "the established market price"; "undercut" appears 0 times in 2,370 thoughts). Any
  clearing rule prints that number — replaying all four rules gives identical prices. Keep D4.
  Step D made it worse in one way: 67% of food asks were re-posts "to keep my place in the queue".
  The median observation says "last price/last traded" 14 times.
- **Costs in coins, benefits in points, no exchange rate:** fishing "≈15.39" next to "rest +1
  wellbeing" (really 0.2 vs 1.0 pts); house cost in coins vs +1.5 pts/round. Result: 6 rests in the
  run, lifestyle 1 for 28–30 agents all run (562 times with 8+ food rotting), 1 house built although
  building was affordable ~25× over (18 agents talked about it; Rosa-19 built and finished +47 pts).
- **No plan memory, no horizon:** a 3-round house needs 3 consistent decisions from a model that
  re-decides every round from scratch and doesn't know how many rounds remain.
- **Little reason to trade:** 28/30 agents fish for themselves; wood sell-through ~4%; inequality
  tracks fishing skill (r = 0.74). Food rot takes 36% of the catch; the lake can't physically feed
  lifestyle 2 for everyone (sustainable max 48/round = 1.6 per agent).

### F-info: what agents are told (tools.mjs, prompt.mjs) — the biggest lever
1. **One unit.** State "1 wellbeing point = 10 coins of end net worth" and show every option in
   points too: each job's shift value (at sell-through), rest, lifestyle levels, a house (+1.5 pts a
   round = 15 coins a round), and the house's payback in rounds.
2. **Prices:** lead each good with sell-through and best bid; mention the last price once per good;
   "no trades yet (reference price X)" for goods that never traded (boats/houses said "last traded").
   Show each standing order's age ("unfilled for 12 rounds") and the rot on goods tied up in it.
   State the rule plainly: "a lower ask fills before all higher asks; everyone who trades gets the
   one clearing price; at the same price the older order fills first." Drop the "re-post to keep
   your place" sentence and "You cannot set the price" (→ "the price is set from everyone's limits").
3. **Horizon:** fixed-length runs (`RUN_ROUNDS`, e.g. 80) and "round N of 80" in the observation.
4. **Houses:** value the wood consistently (same valuation as net worth, last price alongside);
   "you hold X free wood, a house needs Y"; "food for the 3 build rounds at your lifestyle: need N,
   have M".
5. **Lifestyle line:** projected rot of current food, and what surplus food sells for at sell-through.
6. **Contradictions:** "You are fed" with 0 meals of food; "Market (round 0)"; `set_lifestyle`
   answering "now choose your shift" after the shift is chosen.

### F-mech: mechanics and agent loop (world.mjs, server.mjs, brains)
7. **Standing orders persist until changed**, with a `cancel_orders` tool (or post quantity 0), and a
   maximum life of ~8 rounds so prices get re-chosen. No re-posting needed to keep queue place.
8. **Reflect-and-plan** (from item 4, pulled forward): every ~5 rounds a no-tools call with reasoning
   `low` writes a <80-word plan (job, lifestyle, build or not, prices); shown in later observations
   as "Your plan (round 30): …". So "build a house" survives across rounds.
9. **Timed-out decisions:** discard everything a timed-out call did (today its `set_lifestyle` sticks).
10. **Orders eaten/burned to zero:** report "your 1 food ask at 5.00 was withdrawn: eaten first".
    "Free to sell" shows stock after this round's meal and fire.
11. **Credit off:** no "pledged, you could borrow up to 0.00" in rejection messages.
12. **Logging:** store the job reason and the lifestyle reason separately (`thought` is overwritten
    by the last tool); dashboard shows the last job instead of "deciding".

### F-econ: calibration (config.mjs)
13. Food rot `SPOIL[0]` 0.10 → 0.05. `LAKE.CAPACITY` 60 → 80 per villager (sustainable max ≈ 2.1
    per agent, so lifestyle 2 is possible). Keep regrowth 0.107. Keep `HOUSE` 1.5 until the info fixes
    are measured.
14. Wider skill spread (`SKILL_RANGE` 0.3–1.7) so more agents gain from trading instead of
    self-supplying. (Changes the seeded village — note it.)

### F-measure: metrics (analyze.mjs, dashboard)
15. Durables valued properly: don't let one unsold ask zero a house/boat/net (apply sell-through
    only after several offers, else last trade). GDP reported two ways: all output at last prices,
    and output that sold.
16. Before any credit run: collateral valued at a stale price is a risk (wood backed loans at 3.00
    with 4% sell-through). The on-chain LTV uses `last_price`; mitigation now = show agents the
    honest value; on-chain haircut is later work (FUTURE_PLAN).

**Verify:** stub check, then a real 20–40-round run. Targets vs this run: food ask prices per round
> 1 distinct level; any trades below 5.00; rest shifts ≫ 6; lifestyle 2+ share ≫ 5%; houses ≫ 1;
share of asks that are plain re-posts ≪ 67%.
