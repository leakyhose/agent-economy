// A single running simulation, driven entirely from outside.
//
// Nothing here starts on its own. The process comes up idle and the dashboard
// decides what to load and when to run it, so the whole thing is operable from
// a browser with no command line.
import { readdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { Engine, JsonlRepository, computeMetrics, loadWorldFile } from '@aw/engine';
import {
  createAgent, createProvider, makeLens,
  type Agent, type EngineKind, type ProviderKind,
} from '@aw/agents';
import type {
  ActionProposal, LLMUsage, SimEvent, WorldDefinition, WorldState,
} from '@aw/types';
import { CFG } from './config.ts';
import { makeSettlement, type Settlement } from './settlement.ts';
import { settlementsFromFills } from './market-settlement.ts';
import { resizePopulation, MAX_AGENTS, MIN_AGENTS } from './population.ts';
import { MODELS, BRAINS, modelChoice } from './models.ts';

export interface Frame {
  world: WorldDefinition;
  state: WorldState;
  events: SimEvent[];
  metrics: Record<string, number>;
  signatures: string[];
}

/** Worlds the dashboard may offer in its selector. */
export function availableWorlds(dir = 'worlds'): string[] {
  try {
    return readdirSync(resolve(dir))
      .filter((f) => f.endsWith('.json'))
      .map((f) => basename(f, '.json'))
      .sort();
  } catch {
    return [];
  }
}

export class Simulation {
  world: WorldDefinition | null = null;
  engine: Engine | null = null;
  running = false;
  tickMs: number;
  /** Multiplier applied to the world's declared tick length. */
  speed = 1;

  private agents: Agent[] = [];
  private settlement: Settlement | null = null;
  private recent: SimEvent[] = [];
  private signatures: string[] = [];
  private loadedName = '';
  /** Requested headcount, remembered so reset reproduces the same run. */
  private requestedAgents: number | null = null;
  agentNote = '';
  /** Chosen from the dashboard; falls back to the environment's defaults. */
  model: string = CFG.PROVIDER === 'openai' ? CFG.MODEL : 'stub';
  brain: string = CFG.BRAIN;
  /** Held so the console can read what the run has actually spent. */
  private provider: { name: string; usage?: () => LLMUsage } | null = null;

  constructor(private readonly onFrame: (frame: Frame) => void,
              private readonly log: (line: string) => void = console.log) {
    this.tickMs = CFG.TICK_MS;
  }

  get worldName(): string { return this.loadedName; }

  /** Builds a fresh world, population and settlement backend. Never auto-starts. */
  async load(
    name: string,
    headcount?: number | null,
    model?: string | null,
    brain?: string | null,
  ): Promise<void> {
    if (model) this.model = model;
    if (brain) this.brain = brain;
    this.running = false;
    const file = name.endsWith('.json') ? name : `worlds/${name}.json`;
    const declared = await loadWorldFile(resolve(file));

    // An explicit headcount scales the world's declared mix; absent one, the
    // world file's own population stands.
    const wanted = headcount ?? this.requestedAgents;
    const sized = wanted ? resizePopulation(declared, wanted) : null;
    const world = sized?.world ?? declared;
    this.requestedAgents = wanted ?? null;
    this.agentNote = sized?.note ?? '';
    if (sized?.note) this.log(`[sim] ${sized.note}`);

    const engine = new Engine(world, new JsonlRepository(world.name));
    engine.init();

    const settlement = await makeSettlement(world);
    const agentTypes = new Set(world.entityTypes.filter((t) => t.agent).map((t) => t.id));

    const addresses = new Map<string, string>();
    for (const entity of Object.values(engine.state.entities)) {
      if (agentTypes.has(entity.type)) {
        addresses.set(entity.id, await settlement.addressFor(entity.id));
      }
    }

    // One provider shared by the whole population, so the concurrency limit is a
    // real ceiling on in-flight requests rather than one per agent.
    const choice = modelChoice(this.model);
    const provider = createProvider({
      kind: choice.provider as ProviderKind,
      model: choice.id,
      concurrency: CFG.LLM_CONCURRENCY,
      ...(choice.price ? { price: choice.price } : {}),
      onFallback: (reason) => this.log(`[sim] ${reason}`),
    });
    this.provider = provider;

    // A population running one policy does not trade: identical agents in
    // identical situations reach identical conclusions, so everyone bids and
    // nobody asks. A quarter pure LLM so a model is always talking, a quarter
    // hybrid so most spend goes to agents at a real decision point, and half
    // deterministic so somebody is reliably on the other side of the book.
    const mix = this.brain === 'mix';
    const kinds: EngineKind[] = ['llm', 'hybrid', 'utility', 'rule'];
    const usesModel = mix || this.brain === 'llm' || this.brain === 'hybrid';
    const lens = makeLens(world);

    const agents: Agent[] = [];
    let n = 0;
    for (const id of Object.keys(engine.state.entities).sort()) {
      const entity = engine.state.entities[id];
      if (!entity || !agentTypes.has(entity.type)) continue;
      agents.push(createAgent({
        id, lens,
        kind: mix ? kinds[n % kinds.length]! : (this.brain as EngineKind),
        seed: world.seed ^ (n * 0x9e3779b1),
        walletAddress: addresses.get(id) ?? `offchain:${id}`,
        ...(usesModel ? { provider } : {}),
      }));
      n++;
    }

    this.world = world;
    this.engine = engine;
    this.agents = agents;
    this.settlement = settlement;
    this.recent = [];
    this.signatures = [];
    this.loadedName = name.replace(/\.json$/, '').replace(/^worlds\//, '');
    this.tickMs = world.time?.tickMs ?? CFG.TICK_MS;

    const tally = agents.reduce<Record<string, number>>((acc, a) => {
      const k = a.engine?.name ?? 'unknown'; acc[k] = (acc[k] ?? 0) + 1; return acc;
    }, {});
    this.log(`[sim] loaded ${world.name}: ${agents.length} agents, ${world.markets?.length ?? 0} markets`);
    this.log(`[sim] engines: ${Object.entries(tally).map(([k, v]) => `${v}x${k}`).join(' ')}`);
    this.log(`[sim] brain=${this.brain} model=${provider.name === 'stub' ? 'stub' : choice.id} chain=${CFG.CHAIN ? CFG.RPC : 'off'}`);

    this.emit([]);
  }

  async reset(): Promise<void> {
    if (this.loadedName) await this.load(this.loadedName, this.requestedAgents, this.model, this.brain);
  }

  /** What the dashboard should show in its headcount control. */
  get agentCount(): number { return this.agents.length; }
  get agentLimits(): { min: number; max: number } {
    return { min: MIN_AGENTS, max: MAX_AGENTS };
  }
  get catalogue() { return { models: MODELS, brains: BRAINS }; }

  /** What this run has spent so far. Null when nothing is metered. */
  get usage(): LLMUsage | null {
    return this.provider?.usage?.() ?? null;
  }

  start(): void { if (this.engine) { this.running = true; this.engine.resume(); } }
  pause(): void { this.running = false; this.engine?.pause(); }
  setSpeed(multiplier: number): void {
    this.speed = Math.min(16, Math.max(0.25, Number(multiplier) || 1));
  }

  /** Advance exactly one tick, whether or not the clock is running. */
  async step(): Promise<void> {
    if (!this.engine || !this.world) return;
    const engine = this.engine;
    const world = this.world;

    // Skip agents the engine would reject as busy. They are mid-action, so the
    // proposal is discarded anyway, and asking a model to think for an agent
    // that cannot act is the easiest way to waste money.
    const ready = this.agents.filter((a) => {
      const busy = engine.state.entities[a.id]?.state['busyUntil'];
      return typeof busy !== 'number' || busy <= engine.state.tick;
    });

    const proposals = await Promise.all(
      ready.map((a) => a.act(engine.state, world, this.recent).catch(() => null)),
    );
    // Agents propose; nothing they return mutates state. Every proposal goes
    // through submit, which validates it against the world's own rules.
    for (const p of proposals) if (p) engine.submit(p as ActionProposal);

    const result = engine.tick();
    this.recent = result.events.slice(-32);

    if (this.settlement) {
      for (const intent of result.settlements) this.settlement.enqueue(intent);
      for (const intent of settlementsFromFills(result.events, world, result.tick)) {
        this.settlement.enqueue(intent);
      }
    }
    this.emit(result.events);
  }

  /** Signatures confirmed so far, newest last. */
  async drainSignatures(): Promise<string[]> {
    if (!this.settlement) return [];
    const fresh = await this.settlement.flush().catch(() => [] as string[]);
    if (fresh.length > 0) this.signatures.push(...fresh);
    return fresh;
  }

  private emit(events: SimEvent[]): void {
    if (!this.world || !this.engine) return;
    this.onFrame({
      world: this.world,
      state: this.engine.state,
      events,
      metrics: computeMetrics(this.world, this.engine.state),
      signatures: this.signatures,
    });
  }
}
