/**
 * The property that matters most: whatever an engine returns, the engine layer
 * must be able to make sense of it. Run every engine over a wide spread of
 * randomised states drawn from BOTH world fixtures, under every visibility
 * policy, and assert the shape of everything that comes back.
 */

import { describe, expect, it } from 'vitest';
import type { ActionProposal, DecisionEngine, Observation } from '@aw/types';
import { Memory } from '../../packages/agents/src/memory.ts';
import { makeLens, type WorldLens } from '../../packages/agents/src/lens.ts';
import { buildObservation, type VisibilityPolicyName } from '../../packages/agents/src/observe.ts';
import { makeTraits } from '../../packages/agents/src/traits.ts';
import { mixSeed } from '../../packages/agents/src/rng.ts';
import { RuleBasedEngine } from '../../packages/agents/src/engines/rule-based.ts';
import { UtilityEngine } from '../../packages/agents/src/engines/utility.ts';
import { LLMEngine } from '../../packages/agents/src/engines/llm.ts';
import { HybridEngine } from '../../packages/agents/src/engines/hybrid.ts';
import { StubProvider } from '../../packages/agents/src/providers/stub.ts';
import { agentIds, loadWorld, makeEvents, shakeState, WORLD_FILES } from './fixtures.ts';

const POLICIES: VisibilityPolicyName[] = ['marketBoard', 'omniscient', 'local'];

function buildEngines(lens: WorldLens, seed: number, id: string, memory: Memory): DecisionEngine[] {
  const base = { lens, traits: makeTraits(seed, id), seed: mixSeed(seed, id), memory };
  const llm = new LLMEngine({ ...base, provider: new StubProvider({ seed }) });
  return [
    new RuleBasedEngine(base),
    new UtilityEngine(base),
    llm,
    new HybridEngine({ ...base, routine: new RuleBasedEngine(base), deliberate: llm }),
  ];
}

/** Everything a proposal must satisfy before the engine layer ever sees it. */
function assertLegal(proposal: ActionProposal, obs: Observation, lens: WorldLens): void {
  expect(obs.availableActions).toContain(proposal.action);
  expect(proposal.actor).toBe(obs.self.id);

  const info = lens.info(proposal.action);
  expect(info).not.toBeNull();

  if (info!.targetTypes.length > 0) {
    expect(typeof proposal.target).toBe('string');
    const target = obs.visibleEntities.find((e) => e.id === proposal.target);
    expect(target, `target ${proposal.target} must be visible`).toBeDefined();
    expect(info!.targetTypes).toContain(target!.type);
  } else {
    expect(proposal.target).toBeUndefined();
  }

  const stated = new Set(info!.params.map((p) => p.name));
  for (const [key, value] of Object.entries(proposal.params ?? {})) {
    expect(stated, `parameter "${key}" must be one the world states`).toContain(key);
    const definition = info!.params.find((p) => p.name === key)!;
    if (definition.type === 'number') {
      expect(typeof value).toBe('number');
      expect(value as number).toBeGreaterThan(0);
      expect(Number.isFinite(value as number)).toBe(true);
    }
    if (definition.type === 'resource') {
      expect(lens.resourceIds).toContain(value);
    }
  }
  for (const param of info!.params) {
    if (param.required) expect(proposal.params?.[param.name]).toBeDefined();
  }
  if (proposal.reason !== undefined) expect(typeof proposal.reason).toBe('string');
}

describe.each(WORLD_FILES)('every engine on %s', (file) => {
  const world = loadWorld(file);
  const lens = makeLens(world);

  it('returns either null or a proposal the world could actually accept', async () => {
    let decided = 0;
    let total = 0;

    for (let seed = 0; seed < 10; seed++) {
      const state = shakeState(world, seed);
      const events = makeEvents(world, state, seed);
      const ids = agentIds(world, state);
      const sample = [ids[0]!, ids[Math.floor(ids.length / 2)]!, ids[ids.length - 1]!];

      for (const policy of POLICIES) {
        for (const id of sample) {
          const memory = new Memory();
          const obs = buildObservation(id, state, world, memory, policy, { lens, events });
          for (const engine of buildEngines(lens, seed, id, memory)) {
            const proposal = await engine.decide(obs);
            total++;
            if (proposal === null) continue;
            decided++;
            assertLegal(proposal, obs, lens);
          }
        }
      }
    }

    expect(total).toBeGreaterThan(300);
    // A layer that always abstains would pass the assertions above vacuously.
    expect(decided / total).toBeGreaterThan(0.8);
  });

  it('is deterministic: same seed and same observation, same proposal', async () => {
    const state = shakeState(world, 4242);
    const events = makeEvents(world, state, 4242);
    for (const id of agentIds(world, state).slice(0, 6)) {
      const first = buildObservation(id, state, world, new Memory(), 'marketBoard', { lens, events });
      const second = buildObservation(id, state, world, new Memory(), 'marketBoard', { lens, events });

      const runA = buildEngines(lens, 4242, id, new Memory());
      const runB = buildEngines(lens, 4242, id, new Memory());
      for (let i = 0; i < runA.length; i++) {
        const a = await runA[i]!.decide(first);
        const b = await runB[i]!.decide(second);
        expect(JSON.stringify(b), `${runA[i]!.name} drifted`).toBe(JSON.stringify(a));
      }
    }
  });

  it('abstains rather than inventing an action when nothing is available', async () => {
    const state = shakeState(world, 11);
    const id = agentIds(world, state)[0]!;
    const obs = buildObservation(id, state, world, new Memory(), 'marketBoard', { lens });
    const stripped: Observation = { ...obs, availableActions: [] };
    for (const engine of buildEngines(lens, 11, id, new Memory())) {
      expect(await engine.decide(stripped)).toBeNull();
    }
  });
});

describe('utility scoring', () => {
  const world = loadWorld('economic-sandbox.json');
  const lens = makeLens(world);

  it('ranks every viable candidate and breaks ties the same way twice', () => {
    const state = shakeState(world, 8);
    const id = agentIds(world, state)[0]!;
    const memory = new Memory();
    const obs = buildObservation(id, state, world, memory, 'marketBoard', { lens });
    const engine = new UtilityEngine({ lens, traits: makeTraits(8, id), seed: 8, memory });

    const ranked = engine.rank(obs);
    expect(ranked.length).toBeGreaterThan(0);
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1]!.score).toBeGreaterThanOrEqual(ranked[i]!.score);
    }
    expect(engine.rank(obs).map((r) => r.candidate.actionId)).toEqual(
      ranked.map((r) => r.candidate.actionId),
    );
  });

  it('lets temperament change the answer', () => {
    const state = shakeState(world, 3);
    const id = agentIds(world, state)[0]!;
    const obs = buildObservation(id, state, world, new Memory(), 'marketBoard', { lens });

    const cautious = new UtilityEngine({
      lens,
      seed: 3,
      traits: { riskTolerance: 0, patience: 1, herding: 0, memoryLength: 8 },
    });
    const reckless = new UtilityEngine({
      lens,
      seed: 3,
      traits: { riskTolerance: 1, patience: 0, herding: 0, memoryLength: 8 },
    });
    const a = cautious.rank(obs);
    const b = reckless.rank(obs);
    expect(a.length).toBe(b.length);
    // Same options, different ordering of the scores they produce.
    expect(a.map((r) => r.score)).not.toEqual(b.map((r) => r.score));
  });
});
