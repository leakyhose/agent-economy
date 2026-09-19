# Redesign plan: a stable, pokeable village economy

Written 2026-09-19 after two 90-round runs (`runs/2026-09-19T19-45-52` credit off,
`runs/2026-09-19T19-57-54` credit on) and seven investigations (agent reasoning, boom/bust
mechanics, growth design, removable mechanics, starting calibration, academic/LLM economy
sims, game economies).

## Goal

A simulation that looks alive and that you can poke: agents trade every round, money
circulates, output is steady or gently growing — and you can pull a lever mid-run (central
bank, natural disaster, policy) and see the effect on the charts. Not a video-game economy:
few goods, simple rules, clear values, like the academic models.

## What the runs showed

- The market mechanism works since the simplification (prices respond both ways). The
  problem is the world: **only 3–5% of output is ever traded** because every agent can do
  every job and one shift covers their own needs.
- One-off house rush (r1–30): 50 wood wanted, 0 offered; food printed at 22–29 on 1-unit
  trades; a few sellers ended with ~57–76% of all coins. Then demand vanished: deflation
  (price index 0.09 credit off, 0.41 credit on), 1–2 units traded per round.
- **Real output is flat** (~330/round at start prices) in both runs. The GDP chart showed
  the price bubble, not output. The lake pins food at ≤48/round whatever agents do.
- Credit made no difference to output: mean loan 18.6 coins (a house needs ~70), 19 of 29
  loans were emergency food, 15 foreclosures, bank wrote off 119 vs 32 income.
- Agents reject rest and buying because the turn text mixes units ("3.4 food" vs "+1
  wellbeing"); the rich have nothing to buy; 8 agents sat in a cold/hunger yield-halving trap.
- Numbers are lumpy: weak fishers get 0 from 24–37% of shifts; one unit sets the price that
  loans and net worth are marked at; houses (never traded) were valued at a 70-coin
  reference that backed 31% of all credit.
- Research verdict (both reports): **mis-shaped — too complicated in physics, too simple in
  structure.** Known models run 1–2 goods but always give agents a reason they cannot make
  everything themselves. Keep the call auction (institutions do the work; LLMs do worse in
  continuous books). State values in one unit.

## Phase 1 — Cut (config + JS only, no on-chain change)

- Lake stock/regrowth → a single `CATCH` multiplier (default 1.0). Later the
  "bad fishing season" lever.
- Delete: `HOUSE_WARMTH`, `HOUSE_STORE`, hunger/cold yield-halving, wood rot, rest, boats
  from everything agents see (leave the on-chain slot), the timeout paragraph in the prompt.
- Bank: delete dividends, margin calls (keeper forecloses overdue loans only), the 10/20/30
  term choice (one 30-round term), pledging an unfinished house, the "Pledged, it would let
  you borrow…" nudge in the cash rejection.
- Score = wellbeing only. Net worth no longer counts (it rewarded hoarding); this also
  removes the net-worth/sell-through valuation lines from the observation.
- Keep (load-bearing): food rot, nets + net wear, houses, firewood, the order-book line,
  skills, borrow/repay/foreclose, all metrics.

**Test:** stub run (free) → one ~30-round LLM run, credit off (~$1): nothing broke, agents
understand the shorter text.

## Phase 2 — Restructure (what creates trade)

- **Random, wide, talent-normalised skills.** Each agent draws three multipliers (fishing,
  woodcutting, crafting) with a wide spread (~0.2–2.5), normalised so every agent has the
  same total talent. Roles emerge from the draw; nobody is assigned one; anyone can do any
  job at their multiplier, so labour can move when conditions change. Fallback if agents
  still self-provision: widen the spread; assigned roles only as a last resort.
- **×5 quantities, ÷5 unit prices** (coin magnitudes unchanged): yields ~15/shift, a meal is
  5/10/15 food, a fire burns 5 wood, start prices ≈ food 1.00, wood 0.70, net 25.00. A shift
  at any job at skill 1.0 earns about the same (~10 coins). Removes zero-yield shifts, lumpy
  rot and one-unit price prints. Code spots: `eat()` indexes wellbeing by meals not units;
  a `FIRE_WOOD` dial; net/house wood costs.
- **No reference price for untraded goods.** Houses start at price 0 and show "no trades
  yet — a house takes N wood and M shifts"; collateral value is 0 until one actually sells.
- **Houses as the lasting want.** Builders (high crafting skill) build and sell them; an
  agent can own several with diminishing wellbeing (e.g. +1.0, +0.6, +0.4 …); each house
  needs a little upkeep wood per round (wood demand grows with wealth). Targets: a house
  costs ~10–15 rounds of a typical agent's surplus and pays back in 15–25 rounds (today:
  <5). Builders borrow to buy wood before the sale — credit's real job.
- **One unit.** One line per turn giving values in points (a meal, warmth, a house, what a
  shift earns at the market), plus a plain make-vs-buy line: "5 wood costs you a shift
  (≈10 coins of fish) or 3.50 at the market."
- Start endowments sized for ~15–20 rounds of runway (≈60 coins, 50 food, 25 wood).

## Phase 3 — Tune cheaply, then the main checkpoint

- Fix config so `BRAIN=stub` from the shell wins over `.env` (today `.env` overrides it).
- Stub runs, 100 rounds: food and wood roughly balance, money circulates, nobody starves.
- **Main checkpoint — full LLM pair, credit on vs off (~$5).** Must pass before going on:
  - traded share of output ≥ 20% (today 3–5%)
  - share of shifts at own best skill ≥ 70% (today 44%)
  - no boom/bust: price index stays within ~0.5–2× over the run
  - real GDP steady; cash top-5 share < 50% (today 76%)
  - credit-on builds more houses than credit-off; most loans buy wood/nets, not food

## Phase 4 — Growth (only once the baseline holds)

- Learning by doing, gently: +0.01 skill per shift at that job, cap 2.0. With free job
  choice, rising food productivity lets labour move into building — that shift is the growth.
- Dashboard GDP chart = real GDP at fixed start prices (nominal kept alongside).

**Test:** stub → full LLM pair (~$5): real GDP slopes upward in both, more with credit.

## Phase 5 — The sandbox

One control panel on the dashboard, one `/shock` endpoint, every lever is one number, and a
marker on every chart at the round it was pulled.

- **Nature:** fishing season (`CATCH` multiplier), forest fire (wood yield multiplier or burn
  a share of wood stocks), storm (destroy a share of nets/houses — uses the existing
  goods-delta settle path).
- **Central bank:** credit on/off and max loan-to-value, enforced in JS (chain initialised
  with a generous ceiling). Interest rate mid-run needs one small `set_terms` instruction
  (~15 lines of Rust) — the only on-chain change in this plan.
- **Policy (check on-chain needs first):** one-off payment to every agent; a trade tax shared
  equally each round.

**Test:** one LLM run per lever type (~$2.50 each): pull it mid-run, confirm a visible,
sensible response (prices, volume, real GDP, credit, inequality).

## Testing rhythm

| After | Test | Cost |
|---|---|---|
| Every phase | Stub run, 100 rounds: no crashes, ledger invariants, material balance | free |
| Phase 1 | ~30-round LLM run, credit off | ~$1 |
| Phases 2–3 | Full 90-round pair, credit on/off — main checkpoint | ~$5 |
| Phase 4 | Full pair, real GDP slope | ~$5 |
| Phase 5 | One run per lever type | ~$2.50 each |

## Build approach

Phases 1–2 together (same files; the ×5 rescale touches everything). Opus subagents split by
file: `world.mjs` + `config.mjs` · `tools.mjs` + `prompt.mjs` · dashboard + `analyze.mjs`.
Then Phase 3 and the checkpoint pair; Phases 4 and 5 after it passes.

## Open questions / least-sure calls

- Dropping net worth from the score (agents may under-value saving for a house).
- Whether LLM agents will trust the market enough for random skills to produce
  specialisation — Phase 3's checkpoint is the test.
- House numbers and the upkeep rate are targets, to be tuned with stub runs.
- Hiring at a wage (the literature's best job for credit) is deliberately left out: matching
  LLM agents is risky. Revisit only if credit still has no visible effect after Phase 3.
- The bank's stepped sale of seized goods and partial-seizure refunds stay for now (on-chain
  or low value to remove).
