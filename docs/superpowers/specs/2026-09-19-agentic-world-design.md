# Agentic World — Design

**Date:** 2026-09-19
**Status:** Awaiting review

A programmable world engine. Users define the rules, AI agents inhabit the world
and make autonomous decisions, and Solana provides persistent identity,
ownership, assets, payments, markets, and coordination.

---

## 1. Scope

This spec covers the foundation: the simulation kernel, the agent layer, the
Solana layer, and the observation dashboard. Together these are the MVP
described in §31 of the source brief and the demo in §32.

**Deferred to later cycles**, with reasons:

| Feature | Why deferred |
|---|---|
| Experiment system (§21) | Cheap once metrics and parallel sims exist; an expensive guess before. |
| Simulation forking (§23) | Nearly free once seeded PRNG + event log land. The design below makes it possible; the feature comes later. |
| NL world generator (§25) | Needs a stable, validated world schema to target. Building it first means generating into a moving target. |

Deferring these is not deprioritising them. Each depends on foundations this
spec builds, and the declarative-rule decision in §3 exists largely to make the
world generator possible at all.

### Decisions taken

| Decision | Choice | Rationale |
|---|---|---|
| Solana depth | Full six-program Anchor suite (§16) | User selected. Highest fidelity to brief. |
| Settlement | Selective, async queue | Devnet throughput will not sustain 100 agents settling synchronously. |
| LLM provider | Abstraction now, provider later | No API key available. Unblocks every other track. |
| Persistence | Postgres in Docker | Required by replay, forking, parallel sims. |
| Program rollout | Critical path wired first | Working demo at every stage, not only at the end. |

---

## 2. The engine must not know what a "company" is

§4 and §30 of the brief are one requirement. The kernel's type vocabulary is
exactly six nouns:

```
Entity · Resource · Action · Rule · Event · Tick
```

World-specific words — `company`, `peasant`, `declare_war`, `territory` — exist
**only as strings in configuration data**. Never a TypeScript type, never a
switch case, never a filename under `packages/simulation-engine`.

This is enforced two ways:

1. **Mechanically.** A test greps the engine package for world vocabulary drawn
   from both world fixtures and fails on any hit. Discipline decays; a failing
   build does not.
2. **By acceptance test.** The same engine loads both world definitions with
   zero code change. This is §31's requirement and the project's real proof.

The kernel depends on `packages/types` and nothing else.

---

## 3. Rules are data, not code

The central design decision.

If rules were arbitrary JavaScript, three requirements in the brief become
impossible: the world generator (§25) cannot safely emit executable code, replay
(§24) cannot guarantee determinism, and the engine cannot validate a rule before
running it.

So rules are a small declarative expression language — JSON predicates and
effects over entity paths:

```json
{
  "id": "purchase_requires_funds",
  "when":   { "action": "buy" },
  "require": [{ "gte": ["$actor.resources.SOL", "$params.price"] }],
  "effects": [
    { "op": "decrement", "path": "$actor.resources.SOL",  "by": "$params.price" },
    { "op": "increment", "path": "$target.resources.SOL", "by": "$params.price" },
    { "op": "set",       "path": "$params.asset.owner",   "value": "$actor.id" },
    { "op": "settle",    "asset": "SOL", "from": "$actor", "to": "$target",
                         "amount": "$params.price" }
  ]
}
```

Serializable, sandboxed, deterministic, diffable, and generatable by an LLM.

**The cost, stated plainly:** any rule that cannot be expressed in this language
requires extending the language. There is no escape hatch into arbitrary code.
This constraint is load-bearing — the moment an escape hatch exists, determinism
and safe generation are both gone. Extensions to the expression language are
expected and fine; escape hatches are not.

### The `settle` op

`settle` marks an effect as requiring on-chain settlement. The rule knows
nothing about Solana — it declares economic intent, and the settlement layer
decides how that becomes a transaction. This is the seam between §6 and §11.

Whether a given asset settles on-chain is declared by the world definition
(§13), not by the rule.

### Determinism

One seeded PRNG, threaded through the tick loop. No `Math.random()` and no
`Date.now()` anywhere in the engine — banned by lint rule.

Same seed + same event log = byte-identical state. This is the only thing that
makes forking (§23) and replay (§24) real rather than approximate, and it is why
the PRNG design matters more than the features that depend on it.

---

## 4. The §30 boundary

```
Agent (LLM)      →  ActionProposal — inert JSON, zero privileges
                         ↓
RuleEngine       →  validate: preconditions, costs, constraints
                         ↓
Engine           →  apply effects, append to event log
                    ← the only mutation point in the system
                         ↓
SettlementQueue  →  effects flagged on-chain, batched, async
                         ↓
WalletService    →  signs
```

**The agent package cannot import the wallet package.** Enforced at the
package-boundary level, not by convention. This makes "the LLM cannot directly
execute Solana instructions" a structural fact rather than a promise.

An LLM proposing `{"action": "transfer", "amount": 999999}` produces a rejected
proposal and a logged rejection event. Never a transaction.

Private keys never enter an LLM context window. The agent layer has no reference
to the module that holds them.

---

## 5. Repository layout

```
/apps
    /web                 Next.js dashboard
    /simulation          simulation runner service
/packages
    /types               ← the contract. Everything depends on this.
    /world-schema        world definition parsing + validation
    /simulation-engine   tick loop, state, event log
    /rule-engine         predicate/effect evaluation
    /event-system        world events
    /agent-engine        decision loop, memory, observability
    /economy             resources, ownership, settlement intent
    /markets             order book, price discovery
    /memory              five memory types
    /solana              wallet service, settlement queue, SPL ops
    /analytics           metrics
/programs
    /agent-registry  /asset-registry  /marketplace
    /escrow          /treasury        /governance
```

---

## 6. Build plan

### Why not four agents immediately

Parallel agents cannot see each other's work and each starts cold. Four agents
independently inventing `Entity` or `ActionProposal` produces four incompatible
codebases and a merge costing more than the parallelism saved.

The kernel's contract is what every other track depends on. So: **one solo phase
to land the contract, after which parallelism is safe.**

### Phase 0 — solo, no agents

- `git init`, pnpm workspace, tsconfig, vitest
- `packages/types`: `WorldDefinition`, `Entity`, `Action`, `ActionProposal`,
  `Rule`, `Effect`, `Event`, `Tick`, plus the `DecisionEngine`, `WalletService`,
  `SettlementQueue`, and `Repository` interfaces
- Both world fixtures committed up front — **Economic Sandbox** and **Medieval
  Kingdom** — because they are the shared acceptance target every track builds
  against

Nothing in Phase 0 is negotiable by the parallel agents. It is the seam.

### Phase 1 — four worktrees

| Track | Branch | Owns | Depends on |
|---|---|---|---|
| **A · Kernel** | `track/kernel` | simulation-engine, rule-engine, world-schema, event-system, seeded PRNG, Postgres repo | types |
| **B · Agents** | `track/agents` | agent-engine, rule-based + utility + hybrid engines, LLM provider abstraction, five memory types, partial observability | types |
| **C · Solana** | `track/solana` | six Anchor programs, packages/solana, wallet service, settlement queue, SPL ops | types |
| **D · Web** | `track/web` | Next.js dashboard, websocket transport, visualization, analytics | types |

The test applied: **no two tracks touch the same file.** They do not. B tests
against a fake engine, D renders fixture data, C has its own validator. No track
blocks on another finishing.

### Phase 2 — integration

Markets, organizations, governance, settlement queue wired to real devnet, and
the §31 acceptance test: same engine binary, two world files, zero code change.

### Known risks

**Track C is the long pole.** Six Anchor programs is more work than the other
three tracks combined, and it is where an agent working cold is most likely to
go wrong. It gets the most detailed brief and is checked first.

**Track D will need rework.** The dashboard renders whatever the engine actually
emits, and is guessing until A lands. Accepted — better than leaving the UI to
the end — but it is where parallelism pays least.

---

## 7. Agent layer

Each agent has identity, goals, skills, personality, memory, knowledge,
relationships, resources, strategy, risk tolerance, preferences, and a wallet
reference (an address, not a key).

Decision loop:

```
Observe → Interpret → Evaluate goals → Generate candidate actions
       → Select → Validate → Execute → Update memory
```

The agent proposes. The engine disposes.

### Decision engines

`DecisionEngine` is an interface. Implementations: `RuleBasedEngine`,
`UtilityEngine`, `LLMEngine`, `HybridEngine`. Reinforcement learning is
interface-compatible but out of scope for this cycle.

Rule-based and utility engines land first — they are deterministic, testable,
free to run, and let the kernel be proven before any LLM exists. The LLM engine
sits behind a provider abstraction and activates when a key is supplied.

### Partial observability

Agents see only what the world permits (§10). An agent's observation is
constructed by filtering world state through a visibility policy, so `Agent A
knows X, Agent B does not, Agent C believes Y` is representable. This is what
makes markets, negotiation, politics, and research meaningful rather than
games of perfect information.

Memory types: short-term, long-term, episodic, semantic, relationship. Memory is
world-agnostic — it stores observations and beliefs, not companies or kingdoms.

---

## 8. Solana layer

Six Anchor programs: agent-registry, asset-registry, marketplace, escrow,
treasury, governance.

Wired into the live simulation in dependency order:

1. agent-registry + asset-registry + treasury — needed for any economy
2. marketplace + escrow — trade
3. governance — organizations

Each becomes real as it lands, so there is a working demo at every stage.

`WalletService` exposes `getBalance`, `getTokenBalances`, `transferSOL`,
`transferToken`, `createToken`, `buy`, `sell`. It is the only module that
touches private keys.

**Settlement is asynchronous.** The engine emits settlement intents; a queue
batches them to devnet with retry and backoff. The simulation never blocks on
RPC. Confirmed transaction signatures flow back into the event log so the
dashboard can link to Solana Explorer.

Devnet rate limits are a real constraint and the queue is the answer to them.

---

## 9. Testing

- **Kernel:** deterministic replay — same seed and event log reproduce identical
  state, asserted byte-for-byte.
- **Rule engine:** predicate and effect evaluation, including rejection paths.
- **Agent layer:** decision engines tested against a fake engine, no LLM
  required.
- **Solana:** Anchor program tests against a local validator; settlement queue
  tested against devnet.
- **Acceptance (§31):** the same engine runs both world fixtures with no code
  change. This test is the project's definition of done.

---

## 10. Definition of done for this cycle

1. Both world fixtures run on one unmodified engine.
2. Agents make real decisions through a real decision engine — no scripted
   behaviour.
3. Real economic events settle on Solana devnet with Explorer-linkable
   signatures — no simulated transactions.
4. The dashboard observes a running world: agents, markets, ownership, events,
   and chain activity.
5. A run can be replayed from its event log to identical state.
