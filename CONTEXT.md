# agent-economy — an AI agent economy on Solana

Hack the North 2026 · Sept 18–20 · University of Waterloo
Target prize: **Best Use of Solana** ($5,000 + Ledger Nano S Plus)
Submission deadline: **Sun Sept 20, 08:00 EDT**
Team: 2 people. Strengths: TS/JS, Solana client-side, frontend/graphics, sim/LLM plumbing. Rust OK if simple.

This doc was rewritten on 2026-09-19 to describe what is **actually built**, after an
earlier version (still in git history) described a fish/boats/credit design that was
superseded once real building started. See §8 for what's genuinely still ahead.

---

## 1. What's built right now

A small village where **every agent is an LLM that acts through tool calls**, and every
trade settles on a real Solana program. It runs headless or with a barebones live
dashboard.

```
agent-economy/
├── chain/            Anchor program: the ledger and its market
│   └── programs/chain/src/lib.rs
├── backend/          the village: clock, agents, the market round, the dashboard
│   ├── src/
│   │   ├── config.mjs      every setting, one place
│   │   ├── chain.mjs       talks to Solana (hand-encoded instructions)
│   │   ├── world.mjs       the clock, work shifts, eating, spoilage, market rounds
│   │   ├── tools.mjs       what an agent can do, and what it's told
│   │   ├── server.mjs      runs it, serves the dashboard, saves every run
│   │   └── brains/
│   │       ├── stub.mjs      free heuristic placeholder (no API key needed)
│   │       ├── claude.mjs    Claude, tool-calling
│   │       └── openai.mjs    OpenAI, tool-calling (currently gpt-5.6-luna)
│   ├── public/index.html   the dashboard — one file, no build step
│   ├── scripts/analyze.mjs analyze any saved run
│   └── runs/                every run, saved automatically (gitignored)
└── .env / .env.example     API keys and settings
```

**Two halves, and the split is deliberate:**
- **Off-chain:** the clock, agent reasoning (LLM calls), the dashboard.
- **On-chain:** every agent's cash and goods, and the market that sets prices. This is
  real Solana program state, not a log of what happened elsewhere.

Say this to judges before they ask: *"The policy is off-chain, the settlement is
on-chain. The chain enforces what can't be faked."*

---

## 2. The economy as it exists today

```
WORK   →  gather_food / gather_wood / craft_net   (a timed shift, several seconds)
SELL   →  place limit orders; a batch auction clears once per round, on-chain
EAT    →  automatic, every few ticks; no food = hunger, which halves output
WARM   →  automatic, burn 1 wood every 16 ticks; no wood = cold, which also halves output
BORROW →  pledge wood/nets to the on-chain bank for newly minted coins; repay or be foreclosed
SPOIL  →  unsold food and wood rot every round; coins never spoil
```

Three goods: **food, wood, nets**. A net doubles your fishing catch and is crafted from
wood. **Every agent draws a random skill per job** (0.5–1.5, `CFG.SKILL_RANGE`) from a
fixed seed (`SEED`), so the same village is reborn every run. Skill multiplies a
shift's yield and divides the wood a net costs. No job is assigned — agents see their
skills and choose, so any specialization is emergent. Each agent is also shown what a
shift of every job earns *at today's prices*, so a good woodcutter can switch to
fishing when food gets expensive. Every agent's stated goal is to end up with as much
money as possible **net of bank debt**, but they must eat and keep warm.

Wood has two uses: fuel (used up, so wood always has buyers) and nets (capital).

**Money is created by lending, as in real economies.** Agents start with
`AGENTS × START_CASH` coins. The only way new coins come into being is the on-chain
bank: an agent pledges wood/nets and `borrow` mints coins into its purse. `repay`
burns them (interest burns a bit more). The program tracks `supply` and it always
equals the sum of every agent's cash — checked on a local validator.

What keeps the money from being worthless — every rule enforced on-chain (`CFG.BANK`):
- **Backed:** a loan with interest may be at most 50% of the pledged goods' value at the
  last clearing prices. Food can't be pledged (it rots).
- **Temporary:** every loan is due ~60s (150 slots) later. Repaying destroys the coins.
- **Capped:** total outstanding debt ≤ 50% of the starting money supply.
- **Enforced by anyone:** `liquidate` is **permissionless**. Once the chain's clock
  passes the due slot, any signer can foreclose: +20% penalty, the debtor's cash is burned
  toward it, and if that falls short ALL collateral goes to the bank. The simulation's
  keeper is a separate keypair with no authority, so every foreclosure proves this.
- **Seized goods are sold, proceeds burned:** the bank posts seized collateral into the
  auction at 80% of the last price; coins it takes in leave circulation.
- **Needs:** food and firewood are used up constantly, so everyone always needs coins.

The analyzer reports money supply over time next to a price index. Prices rising much
faster than supply grows would be the sign of money losing value.

### Findings from real runs so far (see `backend/runs/`, analyzed with `analyze.mjs`)

- **A goods market with a fixed starting price only trades if a good is genuinely
  scarce.** Early calibration had food abundant enough that nobody ever needed to buy
  it — zero trades, frozen price, the whole point of a market absent. Tightening food
  (fewer ticks between meals, lower fishing yield, spoilage) got real trading and a
  moving price (food rose ~30% over one run as it got scarce).
- **Food was never actually scarce — its price rise was a ratchet.** Across the first
  three runs agents overproduced food ~1.8× what they ate (100 units rotted in one run),
  yet the price rose 30–40% and never once fell. Sellers posted at ~1.00× the last
  price, buyers only appeared when hungry and bid ~1.1×, so every trade was a desperate
  buyer lifting the ask. Nobody could see the glut: agents were shown only the last
  price, and an unfilled order expired silently. Fixed: agents now see last round's
  depth (units offered vs. wanted, best bid/ask) and are told when their order expired
  unfilled. The first run with this saw food trade in 10/19 rounds (was 6/28) and
  the first-ever price decline.
- **Wood is currently a dead market.** Everyone can cut their own wood and craft their
  own net, so nobody needs to buy wood from anyone else — lots of sell orders, almost
  no buy orders, price never moves. The fix is either (a) different agents being better
  at different trades, or (b) a second use for wood that not everyone needs. Neither is
  built yet.
- **LLM agents anchor hard on the price they're shown.** They mostly post orders at or
  very near the current price rather than pushing it around — consistent with the
  literature (§7) that LLM traders price near fundamentals rather than speculating.
  Real price movement in the runs so far comes from scarcity forcing trades through,
  not from agents forming expectations about where the price is going.
- **LLM reasoning is legible and mostly sensible.** Agents correctly reason about
  committed vs. free inventory (e.g. "my wood is committed to a sale so crafting is
  blocked"), balance eating against building a sellable surplus, and give concrete,
  agent-specific reasons for their choices — this is real model output, not scripted
  text.

---

## 3. What's on Solana today

One Anchor program (`chain/programs/chain/src/lib.rs`), six instructions:

```rust
pub const MAX_AGENTS: usize = 200;   // keeps the ledger (9,768 bytes) under the 10 KiB create limit
pub const N_GOODS: usize = 3;   // food, wood, nets

initialize(num_agents, start_cash, start_food, start_wood, terms)  // ledger, purses, bank rules
settle(deltas: Vec<Delta>)                        // signed goods deltas: catches,
                                                   //   meals, fires, crafting, spoilage
clear_auction(good, bids, asks)                   // uniform-price batch auction (the bank may sell)
borrow(agent, amount, collateral)                 // lock wood/nets, MINT coins, record debt
repay(agent, amount)                              // BURN coins, unlock collateral when paid off
liquidate(agent)                                  // PERMISSIONLESS foreclosure once overdue
```

```rust
#[account(zero_copy)]
pub struct Ledger {
    pub authority: Pubkey,               // only this key may write — CHECKED on every write but liquidate
    pub num_agents: u32,
    pub round: u32,
    pub last_price: [u64; N_GOODS],
    pub supply: u64, pub debt_total: u64, pub bad_debt: u64, pub debt_cap: u64,
    pub ltv_bps: u16, pub rate_bps: u16, pub penalty_bps: u16, pub _pad: u16,
    pub term_slots: u64,
    pub bank: AgentSlot,                 // seized collateral awaiting sale
    pub slots: [AgentSlot; MAX_AGENTS],
}
#[zero_copy]
pub struct AgentSlot { cash: u64, goods: [u32; 3], locked: [u32; 3], debt: u64, due_slot: u64 }  // 48 bytes
```

**Every write except `liquidate` requires the ledger's `authority` to sign, and the
program checks the signer matches** (`Write::load_checked`). `liquidate` takes any
signer; the program itself checks the loan is overdue by the chain's `Clock`.

### What actually happens on-chain, per market round

1. The backend batches everything that happened that round (catches, meals eaten,
   crafting, spoilage) as **signed deltas** and sends one or more `settle` transactions.
   No balance may go negative — the program checks and rejects.
2. For each of the three goods, the backend sends the round's order book to
   `clear_auction`. **Orders are pre-sorted off-chain; the program verifies the
   sortedness in one O(n) pass** rather than sorting on-chain (sorting on-chain risks
   blowing the compute budget at scale — this is the same design as the earlier
   research recommended). An unsorted book is rejected — verified with a real
   transaction that the program refuses it.
3. The clearing price is the midpoint of the last crossing bid/ask pair; every filled
   order settles atomically inside that one transaction.
4. The backend reads the ledger back and replaces its local mirror with what the chain
   says — **the chain is the source of truth**, not an assertion the server makes about
   itself.

**Instructions are hand-encoded** (`backend/src/chain.mjs`), not built through
Anchor's JS coder — its `BorshInstructionCoder` hardcodes a 1000-byte instruction
buffer and silently throws `ERR_OUT_OF_RANGE` on a full order book. A ~30-line manual
encoder replaces it. At 100 agents a `clear_auction` transaction sits at 1220 of 1232
legacy-transaction bytes — right at the ceiling; see §7 on why Transaction V1 matters
for growing past this.

### Measured, not estimated

From an early load test on `solana-test-validator`:

| Instruction | Compute units | Share of 1.4M budget |
|---|---|---|
| `initialize(100)` | 4,882 | 0.3% |
| `settle(40 deltas)` | 2,491 | 0.2% |
| `clear_auction(100 orders)` | 12,717 | 0.9% |

Compute is nowhere near the constraint. Transaction **size** is: 100 orders is close to
what fits in one legacy (1232-byte) transaction.

### Honest gaps against the original vision (see §8)

- No SPL token — cash is a `u64` field inside our account, not a mint. There's no
  `mintAuthority: null` moment to show a judge yet.
- No per-agent on-chain identity (no PDA per agent) — agent #40 is an array index, not
  an account a judge can open in the explorer individually.
- `liquidate` is the one permissionless instruction. There's no standalone CLI yet
  for a judge to call it from their own terminal. That would be a small script.

---

## 4. The market

Uniform-price batch auction, one round every `ROUND_TICKS` ticks (default 6 ticks =
3s), per good, cleared on-chain (§3).

```
clear(bids, asks):     # bids desc by limit, asks asc by limit — verified on-chain
  walk both ladders inward while bid.limit >= ask.limit, accumulating volume
  price = midpoint of the last crossing bid and ask
  settle every filled order at that one price, atomically
```

**Why this and not an AMM:** price is a mechanical function of reserves in an AMM, so
it can't move from agents actually disagreeing about value — and it guarantees
liquidity, which would hide the exact scarcity dynamics we're trying to observe.

**Why this and not a continuous order book:** far more code, and the outcome depends on
message arrival order, which makes runs non-reproducible from a saved log.

Agents submit orders through the `place_order` tool with a side, good, quantity and
price; the backend validates against each agent's **free** (uncommitted) cash and
goods before the round clears, so the on-chain auction can never be sent an order that
would fail.

---

## 5. Agent design — LLM minds, tool calls, shared interface

**Every agent decision goes through the same set of tools**
(`backend/src/tools.mjs`), regardless of which brain is answering:

```
gather_food / gather_wood / craft_net / rest   — choose your next shift (needs a reason)
place_order                                     — post a limit order for the next round
borrow / repay                                  — take or pay down a bank loan (settles next round)
check_market                                    — see recent prices and volumes
```

The brain is fully swappable and the rest of the system can't tell which one is
running:

| Brain | File | Status |
|---|---|---|
| `stub` | `brains/stub.mjs` | Free heuristic placeholder. No API key. Used for fast/free load testing. |
| `openai` | `brains/openai.mjs` | Tool-calling via Chat Completions. Currently `gpt-5.6-luna`. Reasoning must be set to `'none'` — the API rejects tool calls with `reasoning_effort` on by default for this model family. |
| `claude` | `brains/claude.mjs` | Tool-calling via the Messages API. Currently `claude-haiku-4-5`. |

Both real brains get the **same system prompt** (`brains/prompt.mjs`) and the same
per-turn `observe()` text: identity, cash and goods (free vs. committed), hunger,
recent prices and volumes, and a short rolling memory of what just happened to them
("Market: you sold 4 wood at 3.00", "3 of your food spoiled").

Decisions happen **only when an agent finishes a shift**, not every tick — this paces
LLM calls for free and is why the cost stays low. Agent wake-ups are staggered over a
window (`STAGGER_MS`) so 10 or 100 agents don't all call out in the same instant.

### Cost, measured

A 100-second, 10-agent run on `gpt-5.6-luna` with reasoning off: **379 LLM calls, $0.08
total.** Scales roughly linearly with agent count and run length.

### Honesty about LLM agents (still true, worth knowing before a judge raises it)

- LLM traders price near fundamentals and rarely speculate on their own
  ([arXiv 2502.15800](https://arxiv.org/abs/2502.15800), Caltech) — **matches what
  we're observing**: agents anchor on the shown price rather than forming independent
  expectations.
- Behavioral magnitudes are prompt-tunable
  ([arXiv 2604.18373](https://arxiv.org/abs/2604.18373)) — if asked "did you prompt
  them into that?", the honest answer is "the prompt is on screen, read it."
- LLM algorithmic collusion is a robust, documented phenomenon
  ([arXiv 2404.00806](https://arxiv.org/abs/2404.00806)) — if agents converge on
  suspiciously similar prices, that's real and citable, not a bug to hide.
- LLM calls are non-deterministic — runs are not bit-reproducible. The saved event log
  (§6) is what lets a run be reconstructed and analyzed after the fact; it is not a
  deterministic replay.

---

## 6. Logging and analysis

**Every run is saved automatically**, from server start to Stop, in
`backend/runs/<timestamp>/` (gitignored):

```
meta.json       config, agent names/traits, program + ledger address, start time
events.jsonl    every decision (what the agent saw · thought · did), every order,
                every round (prices, volumes, order book stats, trades, spoilage,
                every agent's state)
final.json      on-chain balances read back after Stop, LLM call stats
```

```bash
node backend/scripts/analyze.mjs                  # the latest run
node backend/scripts/analyze.mjs runs/2026-09-19T14-45-27
```

The analysis script reports, per run: which goods actually traded and how price moved,
what agents chose to do and how many orders were rejected (and why), hunger and
spoilage, how much money changed hands and the cash Gini coefficient, final standings,
and a sample of agents' own reasoning. This is what produced the findings in §2 — it's
the way to get real answers instead of guessing at what changed a run.

---

## 7. Solana specifics worth remembering

- **Transaction V1** shipped to mainnet 2026-09-15 (SIMD-0385, epoch 1035): max
  transaction size 1232 → 4096 bytes. Not yet adopted in this build (still on legacy
  transactions), but it's the direct answer to "how do we grow past ~100 agents in one
  atomic auction" — a 12-byte order struct gives roughly 316 orders per transaction
  instead of ~100. Worth wiring in if agent count needs to grow.
- **`solana-test-validator`** is what this has been developed and tested against
  (`http://127.0.0.1:8899`), not devnet — devnet's public RPC rate limit (~10 req/s) is
  hostile to a fast-moving sim with 10–100 agents.
- **Anchor's JS `BorshInstructionCoder` caps instruction data at 1000 bytes.** A full
  order book overflows it with an unhelpful `ERR_OUT_OF_RANGE`. Solved by hand-encoding
  instructions (`backend/src/chain.mjs`) rather than using `program.methods.*`.
- **`AccountLoader` + `zero_copy` needs `bytemuck` as a direct crate dependency** with
  the `derive` and `min_const_generics` features — the `#[account(zero_copy)]` macro
  expands to reference it directly; Anchor doesn't pull it in for you.
- **LiteSVM (as scaffolded by `anchor init`, pinned to 0.10.0) works on stable Rust;
  upgrading to 0.16.0 requires nightly** (`maybe_uninit_write_slice`). Testing against
  a real local validator was used instead, which is also closer to how the demo will
  actually run.

---

## 8. What's still ahead — the original vision, not yet built

An earlier planning pass (before any code existed) designed a deeper system: fish,
boats as capital, borrowing against a boat, **permissionless repossession**, a
central-bank-vs-decentralized comparison (`Freeport` / `Crownhaven`, same seed, one
optional `authority` key), a voice/text "director" for live interventions, and a
PixiJS/React visual frontend. None of that is built. It's recorded here because it's
the reason certain design choices were made early (the packed-account layout, the
`authority` field already existing on `Ledger`, the batch-auction market) and because
it's the natural next layer once the current goods market is solid:

- **Credit and repossession are still the most genuinely unoccupied idea** found in
  prior art (§9) — nobody has agents borrow, post collateral, get liquidated, and have
  that liquidation be a real on-chain instruction a stranger can call. This remains the
  strongest "why Solana, really" story if there's time to build it.
- **An SPL token for money**, with the mint authority revoked, would make "the supply
  can't be inflated" a fact a judge can verify in the explorer instead of a claim.
- **A visual frontend does not exist.** Everything observable right now is the
  barebones HTML dashboard (`backend/public/index.html`): a status panel, three live
  price charts with volume bars and hover tooltips, an order book / recent trades
  panel, and a sortable agent table with each agent's live activity and last thought.
  It's deliberately minimal and was built to be replaced, not extended.

---

## 9. Prior art

Useful as proof-of-concept and as code to steal, not as a reason to avoid the space.
The only real risk is visual pattern-match — a polished frontend needs to look
distinct from these, not that the underlying idea is taken.

| Project | What it proves | Use |
|---|---|---|
| [a16z-infra/ai-town](https://github.com/a16z-infra/ai-town) — MIT, 10.5k★, React+Vite+PixiJS+Convex | A browser agent town with tick-based sim works | Steal the PixiJS setup, not the Convex game loop (built for conversation, not markets) |
| [Mercatorio](https://mercatorio.io/) — browser medieval economy | Production chains + order-book prices are legible to normal players | Best reference for economy UI |
| [manicinc/wunderland-sol](https://github.com/manicinc/wunderland-sol) — Apache-2.0, Colosseum | Per-agent on-chain identity as PDAs works today | Reference for adding identity PDAs (§8) |
| [salesforce/ai-economist](https://github.com/salesforce/ai-economist) | Gather-Trade-Build: forage→trade→capital loop produces real dynamics | Reference for a spatial/capital layer if added |
| [Project Sid](https://github.com/altera-al/project-sid) (arXiv:2411.00114) | 1000+ agents converged on gems as currency, formed a merchant hub | Paper + video only, no code |
| [arXiv 2506.04699](https://arxiv.org/abs/2506.04699) | Emergent role specialization + price fluctuations in MMO economies | Academic validation of this general design |
| [Moltlets World](https://web.archive.org/web/20260225082836/https://moltlets.world/) (site now 404s) | Fish/chop/build/sell is engaging — ran 7 months | **Cloned and inspected directly.** Its "on-chain" was SPL Memo strings summarizing counts every 5 minutes; the real economy lived in SQLite, and agent wallets were server-derived from a salt, so the server could recover any agent's keys. This build already has more real on-chain state than Moltlets ever did — the ledger is genuinely the source of truth, not a log. |

**Genuinely unoccupied (confirmed, and still true):** credit, default and insolvency as
real on-chain instructions. See §8.

---

## 10. Decisions made along the way

- **Name:** just `agent-economy`.
- **Agents are LLMs with tool calls, not heuristics that merely resemble reasoning.**
  Reversed from an earlier "heuristic core, thin LLM layer" plan once the team decided
  the swarm itself needed to think, not just narrate.
- **Started at 10 agents, not 100**, to keep API cost and iteration speed manageable
  while tuning the economy; `AGENTS` in `.env` scales this trivially.
- **Brain is OpenAI (`gpt-5.6-luna`) by default**, with Claude Haiku as an alternative
  — both implemented behind the same tool interface, switchable via `BRAIN=`.
- **Coins never spoil; food and wood do** — this is what makes holding money the
  rational choice for storing value, and forces surplus goods to be sold or lost.
- **Every run is saved to disk automatically** — this was previously a gap (a run's
  reasoning was lost on Stop) and is now fixed.
- **Badge Hack: dropped.** Not pursued.
- **Rox "Best AI Agent" ($10,000):** worth a free submission as-is; not worth
  reweighting the build toward it.

### Still open

- Wood is still dead even with trades: the first trades run ended with woodcutters
  holding 25–31 unsold wood each, going hungry and broke (avg cash 22 vs. fishers' 77),
  and still choosing to cut wood. Netmakers barely crafted and nobody ever bid on a
  net — LLM agents don't make the capital investment (buy wood → net → more fish) on
  their own. Needs a second, final-demand use for wood, or stronger net demand.
- Whether to build the credit/repossession layer (§8) at all given remaining time, or
  stay focused on making the current goods market and its frontend excellent.
- A real frontend — nothing beyond the barebones dashboard exists yet.
- SPL token for money; per-agent identity PDAs; a permissionless instruction.
