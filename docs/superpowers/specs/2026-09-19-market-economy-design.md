# From a subsistence village to a market economy

Branch `real-economy`, off `ys-version` at `d5e32df`. JS and config only — no change to the
on-chain program. Written 2026-09-19 after ten LLM test runs ($4.75) and a dozen free stub runs.

## The problem, measured

The baseline LLM run (`runs/2026-09-19T22-09-54`, 23 rounds, before this branch):

| Real economies | The village |
|---|---|
| Nearly all output is sold | 6.5% of output changed hands |
| People sell what they make | 205 buy orders, 20 sell orders |
| Prices are roughly stable | price index 1.00 → 2.07 in 23 rounds |
| Work is specialised | 43% of shifts at the agent's best skill |
| Most people work for wages | no employers, no wages |
| Credit funds investment | 1 loan |

Every villager could make everything they needed, so the market was optional, and thin.

## What changed

**1. Talents that make trade worth it** (`config.mjs TALENT`, `world.mjs talents`). Every villager is
strong at one job (×1.6–2.4), middling at a second (×0.6–1.0), poor at the third (×0.25–0.5). The
strong job goes round the village in turn so a small village has every trade. A first attempt —
wide uniform draws normalised to a fixed total — squashed everyone back to ≈1.0 and did nothing.

**2. A labour market in the dead `boats` slot** (`LABOUR = 3`). One unit is one shift. A villager
sells their *next* shift in the same on-chain call auction as everything else; the buyer has a hired
hand next round who does the employer's job at 75% of the employer's skill, output to the employer.
A hired fisher needs one of the employer's spare nets for the net catch, so hiring pays for those
with capital. Labour is fungible, so nobody is matched with anybody — the auction does it. Every
ledger invariant, including "goods change only by settled deltas", still holds with labour on chain.

**3. ×5 quantities, ÷5 prices.** No zero-catch shifts, no one-unit trade setting the price. A meal is
5/10/15 food; a fire burns 3 wood a round.

**4. Houses as the lasting want.** A 2nd, 3rd… house adds +0.9, +0.5, +0.3, +0.2 wellbeing; each
uses 2 wood a round. Building is paid for as it goes — each of the 3 building shifts uses a third
of the wood — so a builder needs a third of the materials to start. House bids hold no cash back.

**5. Market stalls and shopping lists** (`set_sale`, `set_buy`; `world.mjs endDecision`). Standing
plans: whatever is held above a reserve is offered every round; whatever is short of a target is bid
for. They reprice themselves (`REPRICE`): a stall that sells nothing marks down 7%, one that sells
out marks up 5%; a shopping list that gets nothing bids 7% more. **This was the biggest single
finding:** the fast no-reasoning model reliably posts the buys it needs and forgets to sell, and
forgets to buy food while 138 units sit on offer at 0.10. Producers bring goods to market by habit,
and households buy necessities by habit; the plans are those habits.

**6. One unit, honestly discounted** (`world.mjs jobValues`, `tools.mjs describe`). Every job —
fishing, woodcutting, crafting a net, building to sell — is shown in coins a shift, at what buyers
paid or bid, discounted by how much of what was offered lately actually sold, and ranked. Wages are
shown beside what the agent's own shift is worth.

**7. Habits.** A villager who chooses no shift works the best-paying job they have materials for. A
maker short of wood works their next-best job that round while the shopping list orders the wood
and the stall stops selling it — no refusal, no wasted turn.

## Results (realism scorecard in `analyze.mjs`)

| | Baseline LLM | This branch, LLM (range of the last two runs) | This branch, stub on the plans |
|---|---|---|---|
| output sold through the market | 6.5% | 28–29% | **55%** |
| own shifts at best skill | 43% | 54–57% | **87%** |
| price level (start = 1.00) | 1.00–2.07 | 0.69–1.65 (last run 0.91–1.42) | **0.83–1.27** |
| houses built (10 agents, ~45 rounds) | 5, none sold | 4–5, some sold to non-builders at ≈120–128 | **30** |
| loans | 1 | **3–4** | **7** |
| hungry | 9% | **8–10%** | 11% |
| shifts worked for a wage | none | 0–1% (4%, 17 hires, in an earlier run) | 6–18% |
| wealth gini | 0.29 | 0.14–0.19 | 0.26 |

The stub runs show the world now *supports* a market economy: a specialised village, staples
trading every round, prices that fall in a glut and recover when it clears (wood 1.00 → 0.39 →
0.54), a construction sector, wages. With `gpt-5.6-luna` (reasoning off) driving the agents, the
economy is much closer to real than the baseline but still short of the targets: the model keeps
some villagers fishing badly "for safety", and the labour market flickers rather than persists.

## What I would do next

- **Longer runs.** Builders house themselves first and only then build to sell; the first house sale
  came around round 40 of 45. The mature economy starts about where the test runs end.
- **A reasoning brain for a few agents** (or Claude Haiku): the remaining misses are planning
  failures, not structural ones.
- **Standing labour offers with a floor tied to the agent's own shift value**, so labour supply is a
  habit too without going stale (a fixed-wage standing offer had the best fisher working for others).
- The partner's Phase 4 (learning by doing) and Phase 5 (shock panel) sit on top of this unchanged:
  `W.catch()` is still the fishing-season lever.

## Testing

```bash
backend/scripts/validator.sh                       # a validator with the program at genesis (watch the disk)
BRAIN=stub RUN_SECONDS=60 node backend/src/server.mjs                 # free
STUB_PLANS=1 BRAIN=stub RUN_SECONDS=60 node backend/src/server.mjs    # free, stub relies on stalls + shopping lists
BRAIN=openai AGENTS=10 RUN_SECONDS=180 node backend/src/server.mjs    # ≈ $0.55
node backend/scripts/analyze.mjs                   # ends with the realism scorecard
```
