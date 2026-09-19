# Future plan

Written 2026-09-19, after the first run with the bank (`runs/2026-09-19T15-47-38`) and four
research passes: why nobody borrowed; the Salesforce AI Economist design; credit in classic
agent-based macro models (CATS, JAMEL, Mark-0, EURACE, Keen); and how to make LLM agents act
economically (EconAgent, AgentSociety, 2024–26 literature).

**Priority: 1, 2, 3.** 4 and 5 are written down for later. Hiring, an LLM mayor, a map and
agent-issued notes are cut for now.

**Ground rule from every report: change the economics or fix the information, never steer the
result.** No "consider borrowing", no "don't anchor", no rewording the goal. Judges may read
the prompt.

---

## What the last run showed

- 0 `borrow` calls in 264 decisions; no thought ever mentioned the bank. Broke agents
  (Pevi-9: 1.64 coins, 19 wood, told "the bank would lend you up to 31.69") never borrowed.
- Firewood fixed wood: it traded in 17/44 rounds (was ~1). Nets were dead: 1 crafted, 0 orders.
- Fishing took 69% of shifts. 155 food and 57 wood rotted.

Why nobody borrowed:
1. **Bug: agents never see rejected actions.** The brain loop stops as soon as a shift is
   chosen (`brains/openai.mjs`, `brains/claude.mjs`: `if (t.acted.activity) return;`), and
   orders and the shift usually arrive in the same message, so "Not enough free cash" never
   reaches the model. The rejection isn't written to memory either. Pevi-9 was rejected 7 times
   without ever learning it was broke.
2. **Wrong information on screen.** A net shows as "crafting a net −5.69 (net price minus the
   wood)" — resale only. Its value to the owner (≈ +2.6 food ≈ +16 coins per fishing shift, lasts
   ~20 shifts, costs ~15) is never shown. Wood shows "earns 12.11" when 0 wood was wanted.
   Nobody is told that pledged goods don't rot (2%/round on free wood ≈ 33% over one loan).
3. **Nothing costs more than an agent has, or pays off later.** Every job pays within one shift,
   a net costs 4–7 wood that anyone can cut, and everyone starts with 50 coins. A loan is just a
   10% loss versus selling the collateral. Every credit model with real dynamics has spending
   that comes before the revenue it produces (wages before sales, time-to-build capital).

---

## 1. Fixes and true information (≈1h) — do regardless

Files: `backend/src/tools.mjs`, `backend/src/brains/openai.mjs`, `backend/src/brains/claude.mjs`,
`backend/src/world.mjs` (memory only).

- **Rejections reach the agent.** `exec()` marks a failed tool result (`acted.failed`) and writes
  it to memory: `Rejected: place_order buy 2 food — Not enough free cash…`. The brain loop
  continues one more turn when something failed, even after a shift was chosen (a second shift
  is already refused, so the extra turn can only fix orders, sell or borrow).
- **Rejected buy says how to raise cash, factually:** `Not enough free cash: that order needs
  6.40, you have 1.64. (You hold 16 free wood: last round 8 were wanted at up to 3.80; pledged,
  it would let you borrow up to 26.69.)`
- **Net use-value** in the earnings line, replacing "net price minus the wood":
  `A net would raise your fishing from 2.6 to 5.2 food per shift (+2.6 food ≈ +16.60 at today's
  food price). You can craft one from 3 wood (≈11.00) or buy one. Nets tear on about 1 fishing
  shift in 20.`
- **Demand next to earnings:** `woodcutting 12.11 (3.3 wood) — last round 0 wood were wanted.`
- **Pledged goods don't rot** — one sentence after the loan line and in the `borrow` tool
  description (move the foreclosure warning to the end of that description, keep it).
- **Hunger text:** say "hungry" at 1 missed meal but only claim half output at 3+ (the actual rule
  in `finish()`); same for cold at 2+.
- **Spoilage stops crowding memory:** fold rot into one line per decision instead of one memory
  line per round.

Check in the next run: after a rejection, the same decision has a retry/sell/borrow; "Not enough
free cash" count falls; `craft_net` share > 5%; nets held > 0; net orders appear.

## 2. A capital good that takes time to build: the boat (≈5h)

The only change that makes credit *necessary*. Two reports independently arrived at the same
shape: costs more than an agent has, takes several shifts, pays off for a long time, pledgeable.

- **Boat** = 4th good (`food, wood, nets, boats`). `build_boat` uses ~20 wood (divided by
  crafting skill, like nets) and takes 3 shifts with no other income. Owning a boat triples the
  base fishing catch (a net still doubles on top — calibrate so food doesn't flood). Boats wear
  slowly (≈1% per fishing shift). Start price ≈ 80 coins.
- **Lower starting cash** (≈ 30 coins) so a boat, or the wood for it, can't be paid for outright.
- **Longer loans** (≈ 3 minutes) so a boat can be built and pay back within one term.
- Boats trade in the batch auction and can be pledged to the bank.
- Observation shows the payback plainly, from real numbers: build cost at market, extra catch per
  shift, shifts to pay back, loan cost.
- On-chain: `N_GOODS` 3 → 4; `AgentSlot` grows; lower `MAX_AGENTS` to keep the ledger under the
  10,240-byte create limit (≈150). Update `chain.mjs` encoding/decoding, `config.mjs` (`GOODS`,
  `START_PRICES`, `SPOIL`, tasks), `world.mjs`, `tools.mjs`, `prompt.mjs`, dashboard, analyzer.

Hoped-for dynamics: builders borrow to buy wood (reviving wood), boats finish in a wave, fish
price falls, debt service gets harder, boats are foreclosed and fire-sold, collateral values fall
— a time-to-build cycle with a Minsky tail. Risk: LLMs may still not invest; the payback line is
the fix, not a nudge.

Check: borrows whose reasons mention wood or boats; wood buy orders rise; money supply rises then
falls; some foreclosures; boat owners out-earn non-owners.

## 3. A bank with a balance sheet (≈3h, on-chain)

Makes a default spread instead of staying private, and fixes stock-flow consistency.

- **Equity:** the bank's own `cash` slot is its equity, seeded at `initialize`.
- **Interest and penalties go to bank equity** instead of being burned (principal is still
  burned on repayment). Fixes the slow money drain.
- **Dividend:** equity above the capital requirement is paid out to all agents equally
  (permissionless `pay_dividend`, or folded into each round).
- **Lending limited by capital:** `debt_total + owed ≤ equity / κ` (κ ≈ 0.1, as JAMEL). Defaults
  eat equity → lending tightens → credit crunch.
- **Foreclosure takes only what's needed:** seize `ceil(shortfall / (0.8 × price))` units,
  return the rest to the debtor. Write-offs come out of equity.
- **Margin calls:** `liquidate` also allowed when `debt > locked value at last price × 70%`
  (still permissionless). A fire sale at 80% drops the last price, which can push other loans
  under the line — a cascade.
- **Books on-chain:** `interest_income`, `penalties`, `recovered`, `written_off`, and an invariant
  `Σ agent cash + bank cash = start money + bank seed + minted − principal repaid − written off`.
- Optional: interest by time held instead of flat 10%, so a short bridge loan is cheap.

Pitch: "a Minsky moment, enforced by an instruction anyone can call."

Check: invariant holds after every round; bank equity chart; a margin-call foreclosure appears;
after a wave of defaults, `borrow` refusals for "lending cap" rise.

## 4. Smarter agents, backed by research (≈3h) — later

- **Outcome ledger and own P&L** in the observation: last N shifts and average yields, trades and
  average prices, rejections, and wealth trend (cash + goods at market − debt).
- **Reflect-and-plan call** every ~6 decisions: no tools, reasoning `low`, <80 words: what worked,
  plan for the next shifts (job, buy/sell/build, borrow or not, prices). The plan is shown in later
  observations ("Your plan, written at round 30: …"). EconAgent's results broke without reflection.
- **AI Economist metrics** in analyzer and dashboard: productivity, equality (1 − Gini),
  equality × productivity, specialization index.
- Optional: disclose persona traits already generated in `world.mjs` (patience, risk) — a strong
  knob, so disclose it if used. Reasoning effort for all decisions via the Responses API (×3–5 cost;
  the only anchoring fix with evidence behind it).

## 5. Shocks (≈2h) — later

- **Seasons:** every S rounds, winter doubles firewood use and halves the catch; a countdown is
  shown. **Storms** stop fishing for a few rounds.
- Or **fish and forest as commons** with logistic regrowth: overfishing lowers catches, food price
  rises, labor moves (also fixes fishing dominance).

## Cut for now

- Hiring with wages paid up front (the textbook credit engine, but LLM matching is risky).
- LLM mayor setting an on-chain sales tax with permissionless redistribution (~5h; good stretch).
- A spatial map. Agent-issued notes (Option B; slim hybrid ≈10–12h).

---

## How to build it

Items 2 and 3 both change the on-chain layout, so the Rust is done once, by one agent.

| Phase | Agent | Files it owns | Runs with |
|---|---|---|---|
| A | **Fixes & information** (item 1) | `tools.mjs`, `brains/*.mjs` | B |
| A | **On-chain** (items 2 + 3 in Rust): 4th good, balance-sheet bank, margin calls, books, invariant; `chain.mjs` encode/decode; a scripted check on a validator on separate ports | `chain/programs/chain/src/lib.rs`, `backend/src/chain.mjs` | A |
| B | **Boat gameplay** (item 2 in JS): config, world, tools, prompt | `config.mjs`, `world.mjs` (activities), `tools.mjs`, `prompt.mjs` | C, after A |
| B | **Bank in the sim** (item 3 in JS): round loop, foreclosure/margin/dividend handling, dashboard, analyzer | `world.mjs` (round), `server.mjs`, `public/index.html`, `scripts/analyze.mjs` | B, after A |
| C | **Review**: read the whole diff, run the free stub-brain check, fix | all | — |

Rules for every agent: don't touch ports 8787/8899 (the live dashboard and validator), no paid
LLM calls, no test runs of the real simulation (the user runs those), no commits.
