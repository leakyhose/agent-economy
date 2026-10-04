# Settlers of Solana — notes for AI agents working in this repo

A village of LLM agents running a market economy; every trade, loan and coin settles on one
Anchor program. `README.md` is the overview and setup. Working notes with design decisions
and what was rejected are in the repo root (`CONTEXT.md`, `FUTURE_PLAN.md`, `FIX_PLAN.md`);
they are gitignored, may be absent, and are partly stale — the code and README win.

## Reading what a villager was shown and why it acted

When asked to evaluate agent decision-making, do not parse `events.jsonl` by hand (a long
run is hundreds of MB). Use the trace script:

```bash
node backend/scripts/trace.mjs --help
node backend/scripts/trace.mjs                                   # latest run, first 5 decisions in full
node backend/scripts/trace.mjs runs/<timestamp> --agent Holliver --round 40-44
node backend/scripts/trace.mjs --tool borrow --rejected --limit 3      # refused borrows
node backend/scripts/trace.mjs --outcome timeout --list                # one line each
node backend/scripts/trace.mjs --grep foreclos --brief                 # search; skip the long context
node backend/scripts/trace.mjs --round 12 --prompt                     # system prompt + tools in force
node backend/scripts/trace.mjs --agent 3 --json                        # machine-readable
```

For each decision it prints four parts:

| Section | What it is | Source field in `events.jsonl` (`type: "decision"`) |
|---|---|---|
| WHAT IT SAW | the full per-turn observation the model was given | `saw` |
| ITS REASONING | the model's own thinking text, only if the provider returns it | `reasoning` |
| WHAT IT DID | every tool call, its arguments, the reply, and `✗ REJECTED` | `actions`, `thought`, `activity`, `orders` |
| WHAT HAPPENED | trades, loans, foreclosure and the villager's state after the round settled | the same round's `type: "round"` event |

Things to know when judging a decision:

- **`thought` / "stated reason" is not a reasoning trace.** It is the one-sentence `reason`
  the model writes as a tool argument. OpenAI runs have reasoning switched off, so that is
  all there is. A reasoning model's own thinking is logged and shown under ITS REASONING
  when its provider returns it (expected for gpt-oss on DeepInfra; not yet confirmed).
- **The system prompt and tool descriptions** are logged as `type: "prompt"` events at the
  start of a run and whenever a dashboard dial rewrites them. Runs from before 2026-10-03
  have none; `backend/src/brains/prompt.mjs` rebuilds it from the config in `meta.json`.
- **"orders sent to market" includes automatic ones.** Each villager has a stall and a
  shopping list: standing plans that post and reprice orders every round with no model call
  (`world.mjs` `endDecision`). Only the `place_order` calls listed
  under WHAT IT DID are the model's own choices.
- **`kept` / outcome `timeout` / `no answer`** mean the model did not decide that round: the
  villager repeated its best available job. A run where most decisions look like this was
  not really run by the model — check `final.json` → `llm` (`calls`, `rateLimited`,
  `timedOut`) before drawing conclusions from it.
- `backend/scripts/analyze.mjs [run]` gives the whole-run summary (prices, GDP, loans,
  invariants); trace is for individual decisions.

## Comparing runs (model or setting A/B tests)

```bash
PROVIDER=openai AGENTS=30 RUN_ROUNDS=100 OPEN_BROWSER=0 node backend/src/server.mjs   # headless, fixed length
node backend/scripts/compare.mjs runs/<a> runs/<b> [...] --rounds 100                 # side-by-side table
```

`node backend/scripts/macro.mjs [runs/<a> ...]` prints one run as 10-round windows (prices, shifts by
job, made and sold, hunger, money and credit, crafters at their trade) — the table to read a
comparative-statics test off. Two env vars move the dashboard's dials (keys as in `tunables.mjs`)
in a headless run:

```bash
DIALS='LEARN=0,BANK.RATE_PER_ROUND=0.002'   # set before the village is born
SCHEDULE='61:CATCH=0.6;81:CATCH=1'          # pulled as that round is decided
```

With no dials touched, prices hold a level only since smoked fish was added (2026-10-04); before
it, output grew against a fixed money supply and the index fell all run. Borrowing does not
respond to the interest rate (0.2%, 0.79% and 2.5% a round gave about the same lending).

Change one thing per run: `PROVIDER`, `MODEL`, `REASONING_EFFORT` (none | low | medium | high)
or `SERVICE_TIER`. Keep `AGENTS`, `SEED` and the dials the same, and cap by `RUN_ROUNDS`, not
time. Two identical gpt-6-luna runs on 2026-10-04 agreed closely (houses 157 vs 159, price
index 0.53 vs 0.54), so differences much larger than that are real.

## Where things are

- `backend/src/tools.mjs` — the tools a villager can call and `describe()`, which builds `saw`.
- `backend/src/brains/prompt.mjs` — the system prompt. Ground rule: give true information
  and real economics, never steer the result.
- `backend/src/brains/providers.mjs` — model providers (`PROVIDER=stub | openai | deepinfra`,
  or any OpenAI-compatible endpoint via env); `chat.mjs` is the shared decision loop.
- `backend/src/world.mjs` — the round: shifts, meals, spoilage, the market, the bank.
- `backend/src/tunables.mjs` — the dashboard's dials.
- `chain/programs/chain/src/lib.rs` — the Anchor program. Rebuild (`anchor build`) and
  restart the validator after any change, or every settle fails.

## Running

A village needs the local validator (`backend/scripts/validator.sh`, its own terminal).
`PROVIDER=stub` is free. Paid runs cost real money: keep them short, and never start one
without being asked.
