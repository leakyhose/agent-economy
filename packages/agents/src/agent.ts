/**
 * The agent runtime: observe, recall, decide, check the shape, hand back inert
 * data.
 *
 * Two things this class deliberately does not have: any way to reach the module
 * that signs, and any authority over whether its proposal is accepted. It holds
 * a wallet ADDRESS — a public string — and it emits an `ActionProposal`, which
 * is JSON with no privileges. Everything after that belongs to the engine.
 *
 * One more rule: a broken agent is a quiet agent. Any error inside the decision
 * path is logged and turned into null. A hundred agents run every tick and none
 * of them is allowed to halt the simulation.
 */

import type {
  ActionProposal,
  DecisionEngine,
  EntityId,
  Json,
  Observation,
  SimEvent,
  ValidationResult,
  WorldDefinition,
  WorldState,
} from '@aw/types';
import { makeLens, type WorldLens } from './lens.ts';
import { Memory } from './memory.ts';
import { buildObservation, type ObserveOptions, type VisibilityPolicy, type VisibilityPolicyName } from './observe.ts';
import { makeTraits, type TraitOverrides, type Traits } from './traits.ts';
import { mixSeed } from './rng.ts';
import type { EngineContext } from './engines/proposal.ts';

/** An address is public. Anything long enough to be key material is refused. */
const ADDRESS_LIMIT = 100;

export interface AgentOptions {
  id: EntityId;
  /** Used to derive the lens when one is not supplied. */
  world?: WorldDefinition;
  lens?: WorldLens;
  seed?: number;
  goals?: readonly string[];
  traits?: Traits | TraitOverrides;
  /** A public address. Never a key, a keypair, a seed phrase or a secret. */
  walletAddress?: string;
  /** Built from the agent's own context when a factory is given. */
  engine: DecisionEngine | ((ctx: AgentEngineContext) => DecisionEngine);
  memory?: Memory;
  policy?: VisibilityPolicy | VisibilityPolicyName;
  observe?: Omit<ObserveOptions, 'events' | 'lens'>;
  logger?: (message: string, error?: unknown) => void;
}

export interface AgentEngineContext extends EngineContext {
  id: EntityId;
  memory: Memory;
  goals: readonly string[];
}

function isTraits(value: Traits | TraitOverrides | undefined): value is Traits {
  return (
    !!value &&
    typeof value.riskTolerance === 'number' &&
    typeof value.patience === 'number' &&
    typeof value.herding === 'number' &&
    typeof value.memoryLength === 'number'
  );
}

function assertAddress(value: string | undefined, id: EntityId): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') {
    throw new TypeError(`Agent ${id}: walletAddress must be a public address string.`);
  }
  if (value.length > ADDRESS_LIMIT) {
    throw new TypeError(
      `Agent ${id}: walletAddress is too long to be an address. This layer never holds key material.`,
    );
  }
  return value;
}

export class Agent {
  readonly id: EntityId;
  readonly goals: readonly string[];
  readonly traits: Traits;
  readonly memory: Memory;
  readonly engine: DecisionEngine;
  readonly lens: WorldLens;
  /** Public address only. There is no counterpart to this field. */
  readonly walletAddress: string;

  private readonly seed: number;
  private readonly policy: VisibilityPolicy | VisibilityPolicyName | undefined;
  private readonly observeOptions: Omit<ObserveOptions, 'events' | 'lens'>;
  private readonly log: (message: string, error?: unknown) => void;
  private lastObservation: Observation | null = null;
  private failures = 0;

  constructor(options: AgentOptions) {
    this.id = options.id;
    this.goals = options.goals ?? [];
    this.seed = options.seed ?? 1;

    const lens = options.lens ?? (options.world ? makeLens(options.world) : null);
    if (!lens) throw new Error(`Agent ${this.id}: needs either a world definition or a lens.`);
    this.lens = lens;

    this.traits = isTraits(options.traits)
      ? options.traits
      : makeTraits(this.seed, this.id, options.traits ?? {});

    this.memory =
      options.memory ?? new Memory({ limits: { short: this.traits.memoryLength } });

    this.walletAddress = assertAddress(options.walletAddress, this.id);
    this.policy = options.policy;
    this.observeOptions = options.observe ?? {};
    this.log = options.logger ?? ((message, error) => console.warn(`[agent ${this.id}] ${message}`, error ?? ''));

    const context: AgentEngineContext = {
      id: this.id,
      lens: this.lens,
      traits: this.traits,
      seed: mixSeed(this.seed, this.id),
      memory: this.memory,
      goals: this.goals,
    };
    this.engine = typeof options.engine === 'function' ? options.engine(context) : options.engine;
  }

  /** The observation this agent last acted on. Handy for the dashboard. */
  get observation(): Observation | null {
    return this.lastObservation;
  }

  get errorCount(): number {
    return this.failures;
  }

  /**
   * One turn. Returns a proposal the engine may accept or reject, or null —
   * which is a perfectly ordinary outcome and means "nothing this tick".
   */
  async act(
    state: WorldState,
    world: WorldDefinition,
    events: readonly SimEvent[] = [],
  ): Promise<ActionProposal | null> {
    let obs: Observation;
    try {
      obs = buildObservation(this.id, state, world, this.memory, this.policy, {
        ...this.observeOptions,
        events,
        lens: this.lens,
      });
    } catch (error) {
      this.failures++;
      this.log('could not observe the world this tick', error);
      return null;
    }

    this.lastObservation = obs;
    try {
      this.perceive(obs);
    } catch (error) {
      this.log('memory update failed; continuing', error);
    }

    let proposal: ActionProposal | null;
    try {
      proposal = await this.engine.decide(obs);
    } catch (error) {
      this.failures++;
      this.log(`engine "${this.engine.name}" threw; skipping this turn`, error);
      return null;
    }

    if (proposal === null) return null;

    const checked = this.checkShape(proposal, obs);
    if (checked === null) {
      this.failures++;
      this.memory.remember('episodic', `t${obs.tick} proposal discarded before submission`, 0.4);
      return null;
    }

    this.memory.remember(
      'episodic',
      `t${obs.tick} chose ${checked.action}${checked.target ? ` on ${checked.target}` : ''}`,
      0.45,
    );
    return checked;
  }

  /** Fold what the world made of a proposal back into memory. */
  recordOutcome(proposal: ActionProposal, result: ValidationResult, tick?: number): void {
    const at = tick ?? this.memory.tick;
    if (result.ok) {
      this.memory.remember('episodic', `t${at} ${proposal.action} went through`, 0.5);
      if (proposal.target) this.memory.note(proposal.target, `t${at} dealt with ${proposal.target}`, 0.5, 0.05);
      return;
    }
    this.memory.remember(
      'long',
      `t${at} ${proposal.action} was refused by ${result.rejectedBy}: ${result.message}`,
      0.8,
    );
    if (proposal.target) {
      this.memory.note(proposal.target, `t${at} ${proposal.action} on ${proposal.target} failed`, 0.6, -0.05);
    }
  }

  /** Write this tick's perceptions into the five stores. */
  private perceive(obs: Observation): void {
    const balance = this.lens.payResource ? (obs.self.resources[this.lens.payResource] ?? 0) : 0;
    const pressures = this.lens.pressureAttributes
      .map((attribute) => {
        const value = obs.self.attributes[attribute];
        return typeof value === 'number' ? `${attribute}=${value}` : null;
      })
      .filter((part): part is string => part !== null);
    this.memory.remember(
      'short',
      `t${obs.tick} balance=${balance}${pressures.length ? ` ${pressures.join(' ')}` : ''}`,
      0.3,
    );

    for (const [key, price] of Object.entries(obs.prices)) {
      this.memory.observeValue(`price:${key}`, price);
    }

    const known = new Set(this.memory.knownOthers());
    for (const other of obs.visibleEntities) {
      if (known.has(other.id)) continue;
      this.memory.note(other.id, `${other.id} is a ${other.type}`, 0.35, 0);
    }

    for (const event of obs.recentEvents) {
      this.memory.remember('short', `t${event.tick} saw ${event.type}`, 0.25, { tick: event.tick });
    }
  }

  /**
   * Last line of defence before a proposal leaves this package. The engine
   * validates against the rules; this only checks that what we are handing over
   * is structurally what we claim it is.
   */
  private checkShape(proposal: ActionProposal, obs: Observation): ActionProposal | null {
    if (!proposal || typeof proposal !== 'object') return null;
    if (typeof proposal.action !== 'string' || !obs.availableActions.includes(proposal.action)) {
      return null;
    }
    const info = this.lens.info(proposal.action);
    if (!info) return null;

    const out: ActionProposal = { action: proposal.action, actor: this.id };

    if (proposal.target !== undefined) {
      if (typeof proposal.target !== 'string') return null;
      if (info.targetTypes.length === 0) return null;
      const match = obs.visibleEntities.find((e) => e.id === proposal.target);
      if (!match || !info.targetTypes.includes(match.type)) return null;
      out.target = proposal.target;
    } else if (info.targetTypes.length > 0) {
      return null;
    }

    if (proposal.params !== undefined) {
      if (typeof proposal.params !== 'object' || proposal.params === null || Array.isArray(proposal.params)) {
        return null;
      }
      const stated = new Set(info.params.map((p) => p.name));
      const params: Record<string, Json> = {};
      for (const [key, value] of Object.entries(proposal.params)) {
        if (!stated.has(key)) return null;
        if (typeof value === 'number' && (!Number.isFinite(value) || value <= 0)) return null;
        params[key] = value;
      }
      for (const param of info.params) {
        if (param.required && params[param.name] === undefined) return null;
      }
      if (Object.keys(params).length > 0) out.params = params;
    } else if (info.params.some((p) => p.required)) {
      return null;
    }

    if (typeof proposal.reason === 'string' && proposal.reason.length > 0) {
      out.reason = proposal.reason.slice(0, 240);
    }
    return out;
  }
}
