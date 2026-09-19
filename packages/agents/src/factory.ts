/**
 * Convenience wiring. Nothing here is required to use the package — it just
 * saves every caller from repeating the same six lines, and gives the runner a
 * one-call way to populate a world.
 */

import type { DecisionEngine, EntityId, LLMProvider, WorldDefinition, WorldState } from '@aw/types';
import { Agent, type AgentEngineContext, type AgentOptions } from './agent.ts';
import { makeLens, type WorldLens } from './lens.ts';
import { RuleBasedEngine } from './engines/rule-based.ts';
import { UtilityEngine } from './engines/utility.ts';
import { LLMEngine } from './engines/llm.ts';
import { HybridEngine } from './engines/hybrid.ts';
import { createProvider, type ProviderOptions } from './providers/index.ts';

export type EngineKind = 'rule' | 'utility' | 'llm' | 'hybrid';

export interface EngineChoice {
  kind?: EngineKind;
  /** Which cheap engine a hybrid falls back on. */
  routine?: 'rule' | 'utility';
  provider?: LLMProvider;
  providerOptions?: ProviderOptions;
}

export function makeEngine(ctx: AgentEngineContext, choice: EngineChoice = {}): DecisionEngine {
  const kind = choice.kind ?? 'rule';
  const base = { lens: ctx.lens, traits: ctx.traits, seed: ctx.seed, memory: ctx.memory };

  if (kind === 'utility') return new UtilityEngine(base);
  if (kind === 'rule') return new RuleBasedEngine(base);

  const provider = choice.provider ?? createProvider(choice.providerOptions ?? {});
  const llm = new LLMEngine({ ...base, provider, goals: ctx.goals });
  if (kind === 'llm') return llm;

  const routine =
    choice.routine === 'utility' ? new UtilityEngine(base) : new RuleBasedEngine(base);
  return new HybridEngine({ ...base, routine, deliberate: llm });
}

export interface CreateAgentOptions extends Omit<AgentOptions, 'engine'>, EngineChoice {
  engine?: AgentOptions['engine'];
}

export function createAgent(options: CreateAgentOptions): Agent {
  const { kind, routine, provider, providerOptions, engine, ...rest } = options;
  return new Agent({
    ...rest,
    engine:
      engine ??
      ((ctx) =>
        makeEngine(ctx, {
          ...(kind ? { kind } : {}),
          ...(routine ? { routine } : {}),
          ...(provider ? { provider } : {}),
          ...(providerOptions ? { providerOptions } : {}),
        })),
  });
}

export interface PopulationOptions extends EngineChoice {
  seed?: number;
  lens?: WorldLens;
  goalsFor?: (id: EntityId, type: string) => readonly string[];
  addressFor?: (id: EntityId) => string;
  policy?: AgentOptions['policy'];
  logger?: AgentOptions['logger'];
}

/** One agent per entity whose type the world marks as an agent. */
export function createPopulation(
  state: WorldState,
  world: WorldDefinition,
  options: PopulationOptions = {},
): Agent[] {
  const lens = options.lens ?? makeLens(world);
  const agentTypes = new Set(world.entityTypes.filter((t) => t.agent).map((t) => t.id));
  const agents: Agent[] = [];

  for (const id of Object.keys(state.entities).sort()) {
    const entity = state.entities[id];
    if (!entity || !agentTypes.has(entity.type)) continue;
    agents.push(
      createAgent({
        id,
        lens,
        seed: options.seed ?? world.seed,
        goals: options.goalsFor?.(id, entity.type) ?? [],
        ...(options.addressFor ? { walletAddress: options.addressFor(id) } : {}),
        ...(options.policy ? { policy: options.policy } : {}),
        ...(options.logger ? { logger: options.logger } : {}),
        ...(options.kind ? { kind: options.kind } : {}),
        ...(options.routine ? { routine: options.routine } : {}),
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.providerOptions ? { providerOptions: options.providerOptions } : {}),
      }),
    );
  }
  return agents;
}
