/**
 * The runtime. One bad agent must never halt the simulation, and nothing that
 * leaves this package may be anything other than inert, well-formed data.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ActionProposal, DecisionEngine, Observation } from '@aw/types';
import { Agent } from '../../packages/agents/src/agent.ts';
import { createAgent, createPopulation } from '../../packages/agents/src/factory.ts';
import { makeLens } from '../../packages/agents/src/lens.ts';
import { makeTraits } from '../../packages/agents/src/traits.ts';
import {
  OpenAIProvider,
  MissingOpenAIKeyError,
  createProvider,
} from '../../packages/agents/src/providers/index.ts';
import { agentIds, loadWorld, makeEvents, makeState, shakeState, WORLD_FILES } from './fixtures.ts';

const quiet = () => undefined;

class Fixed implements DecisionEngine {
  readonly name = 'fixed';
  constructor(private readonly answer: ActionProposal | null) {}
  async decide(_obs: Observation): Promise<ActionProposal | null> {
    return this.answer;
  }
}

class Exploding implements DecisionEngine {
  readonly name = 'exploding';
  async decide(): Promise<ActionProposal | null> {
    throw new Error('something went very wrong');
  }
}

describe.each(WORLD_FILES)('agent runtime on %s', (file) => {
  const world = loadWorld(file);
  const lens = makeLens(world);

  it('produces legal proposals for a whole population, on every engine kind', async () => {
    const state = shakeState(world, 21);
    const events = makeEvents(world, state, 21);
    const ids = agentIds(world, state);

    for (const kind of ['rule', 'utility', 'llm', 'hybrid'] as const) {
      let produced = 0;
      for (const id of ids) {
        const agent = createAgent({ id, lens, seed: 21, kind, logger: quiet });
        const proposal = await agent.act(state, world, events);
        if (proposal === null) continue;
        produced++;
        expect(proposal.actor).toBe(id);
        expect(agent.observation!.availableActions).toContain(proposal.action);
      }
      expect(produced, `${kind} decided for nobody`).toBeGreaterThan(ids.length / 2);
    }
  });

  it('populates a world with one agent per agent entity', () => {
    const state = makeState(world);
    const agents = createPopulation(state, world, { kind: 'rule', logger: quiet });
    expect(agents).toHaveLength(agentIds(world, state).length);
    expect(new Set(agents.map((a) => a.id)).size).toBe(agents.length);
  });
});

describe('agent resilience', () => {
  const world = loadWorld('economic-sandbox.json');
  const lens = makeLens(world);
  const state = makeState(world, 3);
  const id = agentIds(world, state)[0]!;

  it('logs and returns null when the engine throws', async () => {
    const logger = vi.fn();
    const agent = new Agent({ id, lens, engine: new Exploding(), logger });
    expect(await agent.act(state, world)).toBeNull();
    expect(agent.errorCount).toBe(1);
    expect(logger).toHaveBeenCalledOnce();
  });

  it('discards a proposal naming an action that is not available', async () => {
    const agent = new Agent({
      id,
      lens,
      engine: new Fixed({ action: 'declare_war', actor: id }),
      logger: quiet,
    });
    expect(await agent.act(state, world)).toBeNull();
    expect(agent.errorCount).toBe(1);
  });

  it('discards a proposal with a parameter the world never stated', async () => {
    const agent = new Agent({
      id,
      lens,
      engine: new Fixed({
        action: 'sell',
        actor: id,
        params: { resource: 'food', quantity: 1, limit: 1, backdoor: 1 },
      }),
      logger: quiet,
    });
    expect(await agent.act(state, world)).toBeNull();
  });

  it('discards a proposal with a negative number', async () => {
    const agent = new Agent({
      id,
      lens,
      engine: new Fixed({
        action: 'sell',
        actor: id,
        params: { resource: 'food', quantity: -1, limit: 1 },
      }),
      logger: quiet,
    });
    expect(await agent.act(state, world)).toBeNull();
  });

  it('overrides an actor the engine tried to spoof', async () => {
    const agent = new Agent({
      id,
      lens,
      engine: new Fixed({ action: 'idle', actor: 'somebody-else' }),
      logger: quiet,
    });
    const proposal = await agent.act(state, world);
    expect(proposal?.actor).toBe(id);
  });

  it('returns null rather than throwing when the entity is missing from state', async () => {
    const agent = new Agent({ id: 'ghost', lens, engine: new Fixed(null), logger: quiet });
    expect(await agent.act(state, world)).toBeNull();
    expect(agent.errorCount).toBe(1);
  });
});

describe('agent identity and memory', () => {
  const world = loadWorld('economic-sandbox.json');
  const lens = makeLens(world);
  const state = makeState(world, 9);
  const id = agentIds(world, state)[0]!;

  it('holds a public address and refuses anything long enough to be key material', () => {
    const agent = createAgent({ id, lens, walletAddress: '7xKX'.repeat(4), logger: quiet });
    expect(agent.walletAddress).toBe('7xKX'.repeat(4));
    expect(() => createAgent({ id, lens, walletAddress: 'k'.repeat(120) })).toThrow(/address/i);
  });

  it('draws the same character from the same seed, and different ones from different ids', () => {
    expect(makeTraits(5, 'e1')).toEqual(makeTraits(5, 'e1'));
    expect(makeTraits(5, 'e1')).not.toEqual(makeTraits(5, 'e2'));
    const traits = makeTraits(5, 'e1');
    for (const key of ['riskTolerance', 'patience', 'herding'] as const) {
      expect(traits[key]).toBeGreaterThanOrEqual(0);
      expect(traits[key]).toBeLessThanOrEqual(1);
    }
    expect(traits.memoryLength).toBeGreaterThan(0);
  });

  it('writes what it perceived and what it chose into memory', async () => {
    const agent = createAgent({ id, lens, kind: 'rule', seed: 9, logger: quiet });
    const events = makeEvents(world, state, 9);
    const proposal = await agent.act(state, world, events);

    expect(agent.memory.size('short')).toBeGreaterThan(0);
    expect(agent.memory.size('semantic')).toBe(Object.keys(state.prices).length);
    expect(agent.memory.knownOthers().length).toBeGreaterThan(0);
    expect(agent.memory.all('episodic').some((r) => r.content.includes(proposal!.action))).toBe(true);

    const marketId = Object.keys(state.prices)[0]!;
    expect(agent.memory.valueOf(`price:${marketId}`)?.last).toBe(state.prices[marketId]);
  });

  it('remembers a refusal more strongly than a success', async () => {
    const agent = createAgent({ id, lens, kind: 'rule', seed: 9, logger: quiet });
    const proposal = (await agent.act(state, world))!;

    agent.recordOutcome(proposal, { ok: false, rejectedBy: 'some_rule', message: 'not enough' }, 9);
    const refusal = agent.memory.all('long').find((r) => r.content.includes('some_rule'));
    expect(refusal).toBeDefined();
    expect(refusal!.salience).toBeGreaterThan(0.6);

    agent.recordOutcome(proposal, { ok: true }, 10);
    expect(agent.memory.all('episodic').some((r) => r.content.includes('went through'))).toBe(true);
  });
});

describe('provider selection', () => {
  it('defaults to the stub, which needs no key and no network', async () => {
    const provider = createProvider();
    expect(provider.name).toBe('stub');
    expect(await provider.complete('s', 'ACTIONS\n- idle (1t) []\n')).toContain('idle');
  });

  it('refuses to build the real provider without a key, and says why', () => {
    const previous = process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
    try {
      expect(() => new OpenAIProvider()).toThrow(MissingOpenAIKeyError);
      expect(() => new OpenAIProvider()).toThrow(/OPENAI_API_KEY/);
    } finally {
      if (previous !== undefined) process.env['OPENAI_API_KEY'] = previous;
    }
  });

  it('falls back to the stub rather than crashing the simulation', () => {
    const previous = process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
    const reasons: string[] = [];
    try {
      const provider = createProvider({ kind: 'openai', onFallback: (r) => reasons.push(r) });
      expect(provider.name).toBe('stub');
      expect(reasons[0]).toContain('no API key');
    } finally {
      if (previous !== undefined) process.env['OPENAI_API_KEY'] = previous;
    }
  });

  it('builds the real provider when a key is supplied, without calling out', () => {
    const provider = new OpenAIProvider({ apiKey: 'test-key-not-used' });
    expect(provider.name).toBe('openai');
    expect(provider).toBeInstanceOf(OpenAIProvider);
  });
});
