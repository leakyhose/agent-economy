# Shoal — an AI agent economy on Solana

Hack the North 2026 · Sept 18–20 · University of Waterloo
Target prize: **Best Use of Solana** ($5,000 + Ledger Nano S Plus)
Submission deadline: **Sun Sept 20, 08:00 EDT**
Team: 2 people. Strengths: TS/JS, Solana client-side, frontend/graphics, sim/LLM plumbing. Rust OK if simple.

---

## 1. What this is

A fishing village of ~100 AI agents who forage, trade, borrow, and go bankrupt — where the
economy itself lives on Solana. Balances, goods ownership, market trades, loans and
repossessions are real on-chain state, not a log of what happened off-chain.

**Two halves, and the split is deliberate:**

- **Off-chain (the renderer):** walking, animation, hunger, agent decision-making.
- **On-chain (the economy):** every economically meaningful state transition.

Say this out loud to judges before they ask: *"The policy is off-chain, the settlement is
on-chain, and that's the correct split. The chain enforces what can't be faked."* Pretending
the agents' brains are on-chain is the thing judges catch.

---

## 2. The economic loop

```
FORAGE        →  fish / chop wood / mine ore   (visible, takes ~8 ticks)
SELL          →  batch auction, price from supply & demand
BUY CAPITAL   →  a boat catches 3x fish, but costs more than you have
BORROW        →  post the boat as collateral
─────────────────────────────────────────────────────────────────────────
fish price falls → revenue falls → can't service debt → BOAT REPOSSESSED
  → repossessed boats go back on the market → boat prices fall
  → the next fisherman is underwater → repossession spreads along the docks
```

That last block is the thesis: a **liquidation cascade you can watch**. The docks empty out,
boat by boat. The collateral is a physical object on screen, not an abstract position.

**The connection that ties both halves together:** the auction's clearing price is the oracle
for the loan health check. Not an invented price feed — the actual price the town just traded
at, on-chain, this tick.

---

## 3. What's on Solana

Rule: **every economically meaningful state transition, and no agent steps.** Logging
footsteps is what "decorative" means — it's what killed Moltlets' credibility (their
"on-chain" was SPL Memo strings on treasury transfers).

| Off-chain | On-chain |
|---|---|
| Walking, pathfinding, animation | `settle_tick(Vec<Harvest>)` — one tx/tick, all catches |
| Hunger, fatigue | `submit_batch(Vec<Order>)` + `clear_auction()` |
| *Deciding* where to fish | `buy_capital()` — boat ownership transfer |
| Traits, expectations, rumors | `borrow()` / `deposit_collateral()` |
| Everything time-based and visual | **`repossess(agent)` — permissionless, health-gated** |
| | Money: SPL mint, **authority revoked** |

### Account layout

```rust
#[account(zero_copy)]                    // 8 + 100*32 bytes
pub struct Ledger { pub num_agents: u32, pub epoch: u32, pub slots: [AgentSlot; 100] }

#[zero_copy]
pub struct AgentSlot {
    pub cash: u64, pub fish: u32, pub wood: u32, pub ore: u32,
    pub boat: bool, pub axe: bool, pub debt: u64,
}
```

Plus a thin `AgentIdentity` PDA per agent so the explorer shows real accounts — legitimate
*because* the health check reads it. This hybrid (thin identity PDAs + one packed hot account)
is exactly how OpenBook and Phoenix work; saying that converts an apparent shortcut into
evidence you know the ecosystem.

### The three places the chain does real work

1. **The whole town's market clears in one atomic transaction.** Transaction V1 shipped to
   mainnet 2026-09-15 (SIMD-0385, epoch 1035): max tx size 1232 → 4096 bytes. A 12-byte order
   struct gives ~316 orders per tx. On v0 + ALTs you'd get ~75 and need four transactions —
   a partial fill could land while another failed and the market would tear. Atomicity here
   is correctness, not flourish. **This capability is days old.**
2. **Repossession is permissionless.** `repossess()` is callable by anyone once the health
   factor breaks. Hand a judge a terminal and let them take a fisherman's boat. No off-chain
   sim can offer this.
3. **The server cannot create value.** Conservation of money is program-enforced. Prove it:
   kill the sim server mid-demo and rebuild the town from chain state.

### Decoration to avoid
- Minting identity NFTs the simulation never reads.
- A DAO vote by rule-based agents — a deterministic function of a balance distribution we control. Cut.

---

## 4. Centralized vs decentralized

Decentralization here is **not** about who runs the server. It's about **which rules have an owner.**

| Institution | Crownhaven (centralized) | Freeport (decentralized) |
|---|---|---|
| Money supply | authority key can `mint()` | `mintAuthority: null` — no instruction exists |
| Foreclosure | authority calls `forbear()` / `seize()` at discretion | `repossess()` — permissionless, no discretion |
| Ownership | authority can reassign | a field only the rules can change |

Cost: **one optional `authority` pubkey in the program, ~50 lines.** Not two worlds, two sims,
two renderers — one program, two configs, same seed run twice. This gets the split-screen
comparison back for ~1 hour instead of a day.

**Thesis moment:** "Print a million gold." In Crownhaven it works and savers get wiped out. In
Freeport it fails — not because of a coded refusal message, but because the mint authority was
revoked. Then open the Solana explorer and point at `mintAuthority: null`. A verifiable
on-chain fact on a block explorer, not a claim in slides.

**Frame it as a trade, not a win.** Freeport: cascade rips through, 20 fishermen lose boats in
90 seconds, brutal and fast — and it clears. Crownhaven: authority forbears, nobody loses a
boat, and then show the bill (idle boats with owners who can't use them, a money supply that
ate everyone's savings). A judge who hears "decentralization is better" discounts you.

**Concede before they ask:** the sim is centrally run, the agent policies are ours, we could
have rigged them. The chain doesn't fix that. Seed replay + the unshocked twin run do.

---

## 5. The market

Uniform-price **batch auction**, one round per tick, per good. Markets: fish, wood, ore,
boats/axes. Repossessed boats re-enter the boat market — that's the cascade's transmission
mechanism.

```
clear(good, bids, asks):
    sort bids desc by limit, asks asc by limit     # off-chain; VERIFIED on-chain in O(n)
    D(p) = Σ qty of bids with limit >= p
    S(p) = Σ qty of asks with limit <= p
    p* = argmax_p min(D(p), S(p))                  # maximize volume
         tie-break: minimize |D-S|, then nearest to last tick's price
    fill bids above p* and asks below p* fully
    ration the marginal level pro-rata by agent id # deterministic
    everyone executes at p*
```

**Why not an AMM:** price is a mechanical function of reserves, so it cannot bubble
endogenously, and it guarantees liquidity — which structurally eliminates the finite-depth
channel the cascade requires. It would delete the thesis.

**Why not a continuous order book:** 5–10x the code, and the outcome depends on message
arrival order, so it can't be replayed deterministically. That kills seed-replay and twin-run
proofs.

Agents submit limit orders from heuristics — reservation price rises with hunger, trend
followers chase, fundamentalists fade. Heterogeneity comes from traits (trend gain, memory
length, risk tolerance) and critically from **different information sets** (own market only /
town price board / rumor neighbors). Disagreement produces volume; volume produces dynamics.

---

## 6. Agent design — heuristic core, thin LLM layer

**The core loop has no LLM in it.** ~800 lines of deterministic, seeded code. This is not a
budget compromise — it's the only version whose emergence claim survives a skeptical judge:

- LLM traders price near fundamentals and barely bubble ([arXiv 2502.15800](https://arxiv.org/abs/2502.15800), Caltech).
- Where LLMs do produce drama, **bubble magnitude is a dial you turn by editing the prompt**
  ([arXiv 2604.18373](https://arxiv.org/abs/2604.18373)). A judge asks "did you prompt them to
  extrapolate?" and there's no answer.
- LLM calls make runs non-replayable, destroying the best proof we have.

LLMs go where they're defensible:

| Layer | Model | Why honest |
|---|---|---|
| ~8 firm managers setting prices | Haiku 4.5 | LLM algorithmic collusion is *robust* ([arXiv 2404.00806](https://arxiv.org/abs/2404.00806)) — supracompetitive prices would be a real documented phenomenon |
| Narrator / headlines | Haiku 4.5 | Code detects events; LLM only phrases them. Numbers pinned, causes forbidden |
| "Why did this happen?" | Opus 5 | RAG over the real event log, citing ticks and agent IDs. Must be able to say "I don't see a cause" |
| Director (text, later voice) | Sonnet 5 | Strict tool schema, translation shown on screen |

Cost: ~$3.90/hour, under $1 for the demo.

**Watch for accounting identities.** EconAgent's famous Okun's-law result is an accounting
identity — a coin-flip work policy scores -0.998 ([arXiv 2608.11215](https://arxiv.org/html/2608.11215)).
A production chain mechanically links output and employment, so check that any "emergent"
regularity isn't implied by our own bookkeeping.

**Double-buffer the sim** (all agents read `S_t`, write `S_next`). Without it, iteration order
silently becomes a behavioral parameter and "emergence" is a bug.

**Stabilizers** (keep a 10-min run alive without looking scripted): perishability/decay,
endogenous firm entry, transaction tax with rebate, leverage cap 3–4x, bankruptcy with partial
recovery (inventory goes to next tick's auction — fuel for the cascade). Keep fast levers
(circuit breaker, deposit insurance) OFF by default so turning one on becomes a demo beat.

---

## 7. Stack (versions verified 2026-09-19)

```
Program:  anchor 1.2.0 (via avm) · agave 4.3.0 · litesvm 1.4.1 · surfpool 1.6.0 (dev only)
Client:   @solana/kit 8.3.0 · @anchor-lang/core 1.2.0    # RENAMED from @coral-xyz/anchor
Front:    react 19.3.0 · vite 8.3.0 · pixi.js 8.21.0 · @pixi/react 8.0.5 · zustand · gsap
Art:      Kenney Tiny Town (CC0) · Ninja Adventure (CC0, has walk cycles)
```

Sprites at work sites (you need to see fishing); dots with trails at city zoom.

**Demo on a local validator**, devnet as cold backup. Public devnet RPC is 100 req/10s ≈ 10/s —
dead on arrival, and you can't faucet 100 wallets.

---

## 8. Build ladder

Walking skeleton first, not layers. The riskiest component is the **loop** (sim → chain →
mirror → screen), not the auction.

**v0 — 20 agents, fish only, FIXED price, no market, no credit.**
Agent walks to water → fishes 8 ticks → walks to market → sells. SPL mint + Ledger + one
`settle_tick` instruction. Crank submits one tx/tick; server mirrors via `accountSubscribe`;
frontend renders 20 dots + balances.
*Done when: a dot fishes, a Solana account changes, the screen shows it, and it's visible in the explorer.*

| | Add | Proves | ~h |
|---|---|---|---|
| v1 | Batch auction (clear off-chain first, then port on-chain) | Real economy | 3 |
| v2 | Boats — cost money, triple fish yield | Capital exists | 1.5 |
| v3 | `borrow()` against the boat | Credit exists | 2 |
| v4 | **`repossess()` — permissionless** | the thesis | 2 |
| v5 | Shock buttons + interest rate slider | Interactivity | 2 |
| v6 | `authority` variant → Crownhaven, same seed | The comparison | 1 |

Every version is demoable. Checkpoint to write on the wall: **on-chain clear == off-chain clear
on the same order set.**

**Descope order:** badge → voice → LLM pricers → twin ghost → newspaper → on-chain auction
(fallback: clear off-chain, settle on-chain) → lending (never, it's the thesis).

**Working rules:** freeze the byte layout (`Order`, `AgentSlot`, WS message) before splitting
up. Fake the other half — frontend renders from a JSON fixture, chain tested with LiteSVM
against a fake order list. Neither blocks the other.

---

## 9. Landmines

1. **V1 txs: an unset `computeUnitLimit` defaults to ZERO, not the runtime default.** Instant
   failure, no useful error. Set it explicitly in the very first transaction.
2. **ALTs do not exist on V1.** Encoding must be base64. `getTransaction`/`getBlock` need
   `maxSupportedTransactionVersion: 1` — and one v1 tx in a block makes `getBlock` fail
   entirely, no partial result.
3. **Sorting 300 orders on-chain blows the 1.4M CU budget.** Submit pre-sorted; verify
   sortedness in one O(n) pass. Still a real on-chain invariant. Budget 2h.
4. **`--limit-ledger-size 50000000`** on the test validator or it eats the disk mid-demo.
5. **Never `getLatestBlockhash()` per transaction.** Cache per slot. Confirm via
   `signatureSubscribe`, never `confirmTransaction` polling.
6. **Token-2022 "interest-bearing" is display-only** — "no new tokens are ever created."
   Pitch it as loan interest and a judge who knows the extension ends the demo. Transfer-fee
   *is* real if a sales tax is wanted.
7. **SPL Governance / Realms: the UI was discontinued 2026-07-01.** Don't go near it.
8. **Pixi `Text` objects are the #1 frame killer** — 300 labels = 300 texture uploads. Use
   BitmapText or put numbers in DOM.
9. **Anchor 1.2 TS v1-transaction support is UNVERIFIED.** Budget 2h; fallback is building the
   v1 tx with `@solana/kit` 8.3 directly and passing Anchor-encoded instruction data in.

---

## 10. Demo (3 minutes)

```
0:00  Town. Seed printed. SHA-256(seed || ruleset) on screen.
0:20  Boom. Fishermen lever up for boats. Price climbing.
0:50  "Same seed, no shock" -> ghost line on the chart. Flat.
1:10  HAND A JUDGE A TERMINAL:  shoal repossess --agent 41
      Permissionless. Anyone can call it. It succeeds.
1:20  Boat hits the next auction. Boat price cracks.
      Agents 3, 7, 19 breach margin. Docks empty, boat by boat.
1:50  Click the crash -> grounded why-chain citing ticks and agent IDs.
2:20  Zoom to agent 47. Wallet, last five trades. Click through to the real explorer.
2:40  Kill the sim server. Rebuild the whole town from chain state.
      "The chain is the source of truth. The town is just a renderer."
```

**Interactivity, by payoff per hour:** interest-rate slider (~1h, best in class) · click agent →
wallet + explorer deep link (~2h) · hand the judge `repossess` (~0.5h) · shock buttons (~2h) ·
place a resource node and watch migration (~1.5h).

---

## 11. Prior art

Useful as proof-of-concept and as code to steal. The only real risk is visual pattern-match:
if a judge's first three seconds say "AI Town with coins," we lose originality points
specifically. Build in the proven space, look different doing it.

| Project | What it proves | Use |
|---|---|---|
| [a16z-infra/ai-town](https://github.com/a16z-infra/ai-town) — MIT, 10.5k★, React+Vite+PixiJS+Convex | A browser agent town with tick-based sim works | **Steal, don't fork.** Convex owns the game loop and is built for conversation, not markets. Take the PixiJS setup |
| [Mercatorio](https://mercatorio.io/) — browser medieval economy | Production chains + order-book prices ("not by predetermined scripting") are legible to normal players | Best reference for the economy UI. Play it for 20 min |
| [manicinc/wunderland-sol](https://github.com/manicinc/wunderland-sol) — Apache-2.0, Colosseum | Per-agent on-chain identity as PDAs works today | **Best code reference for the chain layer.** Copy the Anchor account layout |
| [salesforce/ai-economist](https://github.com/salesforce/ai-economist) | Gather-Trade-Build: the forage→trade→capital loop produces real dynamics | Steal the environment design |
| [Project Sid](https://github.com/altera-al/project-sid) (arXiv:2411.00114) | 1000+ agents converged on gems as currency, formed a merchant hub | Paper + video only, **no code** |
| [arXiv 2506.04699](https://arxiv.org/abs/2506.04699) | Emergent role specialization + price fluctuations in MMO economies | Academic validation of this exact design |
| [SOLPRISM](https://github.com/NeukoAI/axiom-protocol) | Commit-reveal for agent reasoning, 300+ traces on mainnet | If we want decision attestation, **use theirs** |
| [Moltlets World](https://web.archive.org/web/20260225082836/https://moltlets.world/) (site now 404s) | Fish/chop/build/sell is engaging — ran 7 months | Economy was in a database; Solana part was memo strings. **This is the gap we fill** |
| [GOD](https://arxiv.org/abs/2608.27992) (Aug 2026) | NL intervention into agent sims. Text, not voice | Read before building the director; primitive taxonomy is done |

**Genuinely unoccupied:** credit, default and insolvency. Sid got to barter and a shared
currency; nobody has agents borrow, post collateral, get liquidated, and have that liquidation
be a real on-chain instruction a stranger can call.

---

## 12. Open questions

- 100 agents (village, you can watch someone fish) vs 300 (swarm spectacle, unreadable
  individuals)? The task-based economy points at 100.
- Badge Hack ($2,500, zero competition): badge is ESP32-C3, **Lua only, no WiFi/HTTP**, NFC
  read-only. Bridge would be USB serial → laptop. ~3–4h, **unverified** that a Lua app can
  write to serial. Only if ahead at 22:00.
- Rox "Best AI Agent" ($10,000) would mean putting LLM agents visibly back in the loop, which
  cuts against section 6. Probably don't chase both.
- Let the audience trade (judge bids on fish from their phone — real wallet, real tx)? Breaks
  "no outsiders in the world," ~2h. Stretch goal behind repossession.
