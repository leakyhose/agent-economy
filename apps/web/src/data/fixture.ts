/**
 * Generates and replays a plausible run for ANY world definition.
 *
 * Population, relationship kinds, ownership, legal actions, price series,
 * settlements and metrics are all derived from the file; nothing here is keyed
 * to a particular world. This is the path the dashboard demos from when the
 * simulation server is not running.
 */
import type { Entity, EntityId, Json, SimEvent, WorldDefinition, WorldState } from '@aw/types';
import type { OrderBook, OrderBookLevel } from './contract.ts';
import { applyEffects, evalPredicate, type RuleScope } from './engineLite.ts';
import { computeMetrics } from './expr.ts';
import { base58, between, gaussian, intBetween, makeRng, pick } from './rng.ts';
import { ENGINE_EVENTS, resolveViewConfig, type ViewConfig } from '../derive/viewConfig.ts';
import { humanize, num, price as fmtPrice } from '../derive/format.ts';

export interface StepResult {
  state: WorldState;
  events: SimEvent[];
  metrics: Record<string, number>;
  books: Record<string, OrderBook>;
}

interface PendingSettlement {
  dueTick: number;
  asset: string;
  from: EntityId;
  to: EntityId;
  amount: number;
}

const REASON_FRAMES = [
  'Holding {qty} {res}. {act} is the best use of the next {dur} {unit}.',
  '{res} last cleared at {price}. {act} while that holds.',
  'Reserves are thin at {qty} {res}, so {act} before committing to anything larger.',
  '{act} keeps me liquid. Nothing else pays back inside {dur} {unit}.',
  '{other} is the shortest path to what I lack, so {act}.',
  'Nothing scored higher this pass. {act}.',
  '{res} moved against me since the last clearing. {act} is the hedge.',
  'Stock of {res} is {qty} and falling. {act} now, reassess in {dur} {unit}.',
];

/** Agents speak in sentences; the frames are filled with lower-case world nouns. */
function sentenceCase(text: string): string {
  return text.replace(/(^|[.!?]\s+)([a-z])/g, (_, lead: string, letter: string) => lead + letter.toUpperCase());
}

export class FixtureEngine {
  readonly world: WorldDefinition;
  readonly config: ViewConfig;
  state!: WorldState;
  books: Record<string, OrderBook> = {};

  private rng: () => number = makeRng(1);
  private seq = 0;
  private counter = 0;
  private pending: PendingSettlement[] = [];
  private flow: Record<string, { demand: number; supply: number }> = {};
  private roundLength = 6;
  private scale: number;
  /** Ceiling on generated population, so a spawning rule cannot run away. */
  private ceiling = 512;
  /** Actions whose rules bring a new entity into being. */
  private spawning = new Set<string>();

  constructor(world: WorldDefinition, scale = 1) {
    this.world = world;
    this.config = resolveViewConfig(world);
    this.scale = Math.max(1, Math.round(scale));
    this.reset();
  }

  setScale(scale: number): void {
    this.scale = Math.max(1, Math.round(scale));
    this.reset();
  }

  reset(): void {
    this.rng = makeRng(this.world.seed);
    this.seq = 0;
    this.counter = 0;
    this.pending = [];
    this.flow = {};
    this.roundLength = this.config.markets[0]?.roundTicks ?? 6;
    this.spawning = new Set(
      this.config.spawns.map((spawn) => spawn.viaAction).filter((id): id is string => id !== null),
    );

    const state: WorldState = {
      worldName: this.world.name,
      tick: 0,
      entities: {},
      prices: {},
      rngCursor: 0,
    };
    this.state = state;

    const seeded = (this.world.population ?? []).reduce((a, p) => a + p.count, 0) * this.scale;
    this.ceiling = Math.max(32, Math.round(seeded * 1.8));

    for (const spec of this.world.population ?? []) {
      const count = Math.max(1, Math.round(spec.count * this.scale));
      for (let i = 0; i < count; i += 1) {
        const entity = this.makeEntity(spec.type, (spec.attributes ?? {}) as Record<string, Json>);
        state.entities[entity.id] = entity;
      }
    }

    // Types that only ever come into existence through a `spawn` effect still
    // need a starting cohort, or their views would be empty on tick zero.
    for (const spawn of this.config.spawns) {
      const owners = Object.values(state.entities).filter((e) => spawn.ownerTypes.includes(e.type));
      const wanted = Math.max(2, Math.round(owners.length * 0.18));
      for (let i = 0; i < wanted; i += 1) {
        const owner = pick(this.rng, owners);
        if (!owner) break;
        const child = this.makeEntity(spawn.type, {});
        state.entities[child.id] = child;
        child.ownedBy = owner.id;
        if (!owner.owns.includes(child.id)) owner.owns.push(child.id);
      }
    }

    this.seedRelationships();

    for (const market of this.config.markets) {
      const start = this.config.resourceById[market.resource]?.startPrice ?? 100;
      state.prices[market.id] = Math.max(1, Math.round(start * between(this.rng, 0.92, 1.08)));
      this.flow[market.id] = { demand: 0, supply: 0 };
      this.books[market.id] = this.makeBook(market.id, state.prices[market.id] ?? start, start, 0, 0);
    }

    for (const entity of Object.values(state.entities)) this.assign(entity, 0);
  }

  private makeEntity(type: string, overrides: Record<string, Json>): Entity {
    const def = this.world.entityTypes.find((t) => t.id === type);
    const prefix = type.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || 'EN';
    this.counter += 1;
    const id = `${prefix}-${this.counter.toString().padStart(3, '0')}`;

    const attributes: Record<string, Json> = {};
    for (const [key, value] of Object.entries(def?.attributes ?? {})) {
      attributes[key] = typeof value === 'number' && value !== 0
        ? Math.round(value * between(this.rng, 0.6, 1.6))
        : (value as Json);
    }
    Object.assign(attributes, overrides);

    const resources: Record<string, number> = {};
    for (const [key, value] of Object.entries(def?.resources ?? {})) {
      if (value === 0) {
        resources[key] = this.rng() < 0.25 ? intBetween(this.rng, 1, 3) : 0;
        continue;
      }
      // Log-normal endowments, so the distribution has a tail worth measuring.
      const factor = Math.exp(gaussian(this.rng) * (key === this.config.currency ? 0.75 : 0.45));
      resources[key] = Math.max(0, Math.round(value * Math.min(4, Math.max(0.15, factor))));
    }
    for (const resource of this.config.resources) {
      if (!(resource.id in resources)) resources[resource.id] = 0;
    }

    return {
      id,
      type,
      attributes,
      resources,
      relationships: {},
      owns: [],
      state: { wallet: base58(this.rng, 44) },
    };
  }

  private seedRelationships(): void {
    const byType = new Map<string, Entity[]>();
    for (const entity of Object.values(this.state.entities)) {
      const bucket = byType.get(entity.type) ?? [];
      bucket.push(entity);
      byType.set(entity.type, bucket);
    }

    this.config.relations.forEach((relation, index) => {
      const sources = relation.fromTypes.flatMap((t) => byType.get(t) ?? []);
      const sinks = relation.toTypes.flatMap((t) => byType.get(t) ?? []);
      if (sources.length === 0 || sinks.length === 0) return;
      const chance = index === 0 ? 0.45 : 0.22;
      for (const source of sources) {
        if (this.rng() > chance) continue;
        const sink = pick(this.rng, sinks);
        if (!sink || sink.id === source.id) continue;
        const bucket = source.relationships[relation.kind] ?? [];
        if (!bucket.includes(sink.id)) bucket.push(sink.id);
        source.relationships[relation.kind] = bucket;
      }
    });
  }

  // ---- action selection -----------------------------------------------------

  private assign(entity: Entity, tick: number): void {
    const legal = this.config.actionsByType[entity.type] ?? [];
    let action = pick(this.rng, legal);
    // Bringing a new entity into the world is a rare move, not a coin flip.
    if (action && this.spawning.has(action.id) && this.rng() < 0.88) {
      action = pick(this.rng, legal);
    }
    if (!action) {
      entity.state = { ...entity.state, action: null, reason: null, until: tick + 4 };
      return;
    }

    const params: Record<string, Json> = {};
    const resourceParam = (action.params ?? []).find((p) => p.type === 'resource');
    let chosenResource: string | null = null;
    if (resourceParam) {
      const tradable = this.config.resources.filter((r) => !r.isCurrency);
      const candidate = pick(this.rng, tradable.length > 0 ? tradable : this.config.resources);
      chosenResource = candidate?.id ?? null;
      if (chosenResource) params[resourceParam.name] = chosenResource;
    }

    const numberParams = (action.params ?? []).filter((p) => p.type === 'number');
    numberParams.forEach((param, index) => {
      if (chosenResource) {
        if (index === 0) {
          const held = entity.resources[chosenResource] ?? 0;
          params[param.name] = Math.max(1, Math.min(5, Math.round(held * between(this.rng, 0.2, 0.6)) || 1));
        } else {
          const market = this.config.markets.find((m) => m.resource === chosenResource);
          const last = market ? this.state.prices[market.id] ?? 100 : 100;
          params[param.name] = Math.max(1, Math.round(last * between(this.rng, 0.9, 1.12)));
        }
        return;
      }
      const funds = entity.resources[this.config.currency] ?? 0;
      params[param.name] = Math.max(1, Math.round(funds * between(this.rng, 0.05, 0.3)));
    });

    let target: EntityId | null = null;
    if (action.targetTypes && action.targetTypes.length > 0) {
      const candidates = Object.values(this.state.entities).filter(
        (e) => action.targetTypes?.includes(e.type) && e.id !== entity.id,
      );
      target = pick(this.rng, candidates)?.id ?? null;
    }

    const duration = Math.max(1, action.duration ?? 1);
    entity.state = {
      ...entity.state,
      action: action.id,
      params,
      target,
      reason: this.reason(entity, action.id, chosenResource, target, duration),
      since: tick,
      until: tick + duration,
    };

    if (chosenResource) {
      const market = this.config.markets.find((m) => m.resource === chosenResource);
      if (market) {
        const bucket = this.flow[market.id] ?? { demand: 0, supply: 0 };
        const qty = Number(Object.values(params).find((v) => typeof v === 'number') ?? 1);
        // Direction is inferred from whether the actor already holds the good.
        if ((entity.resources[chosenResource] ?? 0) >= qty) bucket.supply += qty;
        else bucket.demand += qty;
        this.flow[market.id] = bucket;
      }
    }
  }

  private reason(
    entity: Entity,
    actionId: string,
    resource: string | null,
    target: EntityId | null,
    duration: number,
  ): string {
    const frame = pick(this.rng, REASON_FRAMES) ?? REASON_FRAMES[0] ?? '';
    const res = resource
      ?? pick(this.rng, this.config.resources.filter((r) => !r.isCurrency))?.id
      ?? this.config.currency;
    const market = this.config.markets.find((m) => m.resource === res);
    const last = market ? this.state.prices[market.id] ?? 0 : 0;
    return sentenceCase(frame
      .replace('{act}', humanize(actionId).toLowerCase())
      .replace('{res}', res)
      .replace('{qty}', num(entity.resources[res] ?? 0))
      .replace('{price}', last > 0 ? `${fmtPrice(last)} ${this.config.currency}` : 'no clearing yet')
      .replace('{dur}', String(duration))
      .replace('{unit}', duration === 1 ? this.config.tickUnit : `${this.config.tickUnit}s`)
      .replace('{other}', target ?? 'the market'));
  }

  // ---- stepping -------------------------------------------------------------

  private event(tick: number, type: string, data: Record<string, Json>, signature?: string): SimEvent {
    this.seq += 1;
    const base: SimEvent = { seq: this.seq, tick, type, data };
    return signature ? { ...base, signature } : base;
  }

  step(): StepResult {
    const state = this.state;
    const tick = state.tick + 1;
    state.tick = tick;
    const events: SimEvent[] = [];
    const settlements: PendingSettlement[] = [];

    const actionRules = (this.world.rules ?? []).filter((r) => r.when?.action);

    for (const entity of Object.values(state.entities)) {
      const until = Number(entity.state['until'] ?? 0);
      if (tick < until) continue;
      const actionId = entity.state['action'];
      if (typeof actionId === 'string') {
        const targetId = entity.state['target'];
        const scope: RuleScope = {
          actor: entity,
          target: typeof targetId === 'string' ? state.entities[targetId] : undefined,
          params: (entity.state['params'] as Record<string, Json>) ?? {},
          bindings: {},
        };
        for (const rule of actionRules) {
          if (rule.when?.action !== actionId) continue;
          const grows = (rule.effects ?? []).some((e) => e.op === 'spawn');
          if (grows && Object.keys(state.entities).length >= this.ceiling) {
            events.push(this.event(tick, ENGINE_EVENTS.rejected, {
              actor: entity.id,
              action: actionId,
              rejectedBy: 'population_ceiling',
            }));
            continue;
          }
          const blocked = (rule.require ?? []).some((p) => !evalPredicate(p, scope));
          if (blocked) {
            events.push(this.event(tick, ENGINE_EVENTS.rejected, {
              actor: entity.id,
              action: actionId,
              rejectedBy: rule.id,
            }));
            continue;
          }
          const outcome = applyEffects(rule.effects ?? [], scope, state, (type, attrs) => {
            const child = this.makeEntity(type, attrs);
            child.ownedBy = entity.id;
            if (!entity.owns.includes(child.id)) entity.owns.push(child.id);
            return child;
          });
          for (const emit of outcome.emits) {
            events.push(this.event(tick, emit.event, { ...emit.data, actor: entity.id, action: actionId }));
          }
          for (const s of outcome.settlements) {
            settlements.push({ ...s, dueTick: tick + intBetween(this.rng, 1, 3) });
          }
          for (const spawned of outcome.spawned) this.assign(spawned, tick);
        }
      }
      this.assign(entity, tick);
    }

    for (const rule of this.world.rules ?? []) {
      const every = rule.when?.tick?.every;
      if (!every || tick % every !== 0) continue;
      const outcome = applyEffects(rule.effects ?? [], { bindings: {} }, state, (type, attrs) =>
        this.makeEntity(type, attrs),
      );
      for (const emit of outcome.emits) events.push(this.event(tick, emit.event, emit.data));
    }

    for (const worldEvent of this.world.events ?? []) {
      const scheduled = worldEvent.atTick === tick;
      const recurring = worldEvent.every !== undefined && tick % worldEvent.every === 0;
      const rolled = worldEvent.chance === undefined || this.rng() < worldEvent.chance;
      if (!(scheduled || (recurring && rolled))) continue;
      const outcome = applyEffects(worldEvent.effects ?? [], { bindings: {} }, state, (type, attrs) =>
        this.makeEntity(type, attrs),
      );
      for (const emit of outcome.emits) {
        events.push(this.event(tick, emit.event, {
          ...emit.data,
          source: worldEvent.id,
          note: worldEvent.description ?? null,
        }));
      }
    }

    for (const market of this.config.markets) {
      if (tick % market.roundTicks !== 0) continue;
      const previous = state.prices[market.id] ?? 100;
      const start = this.config.resourceById[market.resource]?.startPrice ?? previous;
      const bucket = this.flow[market.id] ?? { demand: 0, supply: 0 };
      const imbalance = Math.tanh((bucket.demand - bucket.supply) / 24);
      const reversion = start > 0 ? 0.04 * ((start - previous) / start) : 0;
      const drift = 0.035 * imbalance + reversion + gaussian(this.rng) * 0.018;
      const next = Math.max(1, Math.round(previous * (1 + drift)));
      const clamped = Math.min(Math.max(next, Math.round(start * 0.2) || 1), Math.round(start * 5) || next);
      const volume = Math.max(1, Math.round(Math.min(bucket.demand, bucket.supply) || between(this.rng, 1, 6)));
      state.prices[market.id] = clamped;
      this.books[market.id] = this.makeBook(market.id, clamped, previous, volume, tick);
      this.flow[market.id] = { demand: 0, supply: 0 };
      events.push(this.event(tick, ENGINE_EVENTS.cleared, {
        market: market.id,
        resource: market.resource,
        price: clamped,
        volume,
      }));

      // When the world declares no explicit settlement, an on-chain pair still
      // settles its currency leg the moment a round clears.
      const resourceOnChain = this.config.resourceById[market.resource]?.onChain === true;
      const currencyOnChain = this.config.resourceById[market.currency]?.onChain === true;
      if (this.config.settlementAssets.length === 0 && resourceOnChain && currencyOnChain) {
        const ids = Object.keys(state.entities);
        const from = pick(this.rng, ids);
        const to = pick(this.rng, ids);
        if (from && to && from !== to) {
          settlements.push({
            asset: market.currency,
            from,
            to,
            amount: Math.round((clamped * volume) / 100),
            dueTick: tick + intBetween(this.rng, 1, 2),
          });
        }
      }
    }

    if (tick % this.roundLength === 0) {
      for (const resource of this.config.resources) {
        if (resource.spoilage <= 0) continue;
        for (const entity of Object.values(state.entities)) {
          const held = entity.resources[resource.id] ?? 0;
          if (held <= 0) continue;
          entity.resources[resource.id] = Math.max(0, Math.floor(held * (1 - resource.spoilage)));
        }
      }
    }

    this.pending.push(...settlements);
    const stillPending: PendingSettlement[] = [];
    for (const intent of this.pending) {
      if (intent.dueTick > tick) {
        stillPending.push(intent);
        continue;
      }
      events.push(this.event(tick, ENGINE_EVENTS.settled, {
        asset: intent.asset,
        from: intent.from,
        to: intent.to,
        amount: intent.amount,
      }, base58(this.rng, 88)));
    }
    this.pending = stillPending;

    state.rngCursor += events.length + Object.keys(state.entities).length;

    return {
      state: this.snapshot(),
      events,
      metrics: computeMetrics(this.world.metrics ?? [], state),
      books: { ...this.books },
    };
  }

  /** A fresh object graph each tick, so consumers can compare by identity. */
  snapshot(): WorldState {
    const entities: Record<EntityId, Entity> = {};
    for (const [id, e] of Object.entries(this.state.entities)) {
      entities[id] = {
        ...e,
        attributes: { ...e.attributes },
        resources: { ...e.resources },
        relationships: Object.fromEntries(
          Object.entries(e.relationships).map(([k, v]) => [k, [...v]]),
        ),
        owns: [...e.owns],
        state: { ...e.state },
      };
    }
    return { ...this.state, entities, prices: { ...this.state.prices } };
  }

  private makeBook(
    marketId: string,
    last: number,
    previous: number,
    volume: number,
    tick: number,
  ): OrderBook {
    const step = Math.max(1, Math.round(last * 0.005));
    const ladder = (direction: -1 | 1): OrderBookLevel[] => {
      const levels: OrderBookLevel[] = [];
      for (let i = 1; i <= 6; i += 1) {
        const levelPrice = Math.max(1, last + direction * step * i);
        levels.push({
          price: levelPrice,
          quantity: Math.max(1, Math.round(between(this.rng, 1, 9) * (1 + i * 0.55))),
          orders: intBetween(this.rng, 1, 4),
        });
      }
      return levels;
    };
    return {
      marketId,
      demand: ladder(-1),
      supply: ladder(1),
      lastPrice: last,
      previousPrice: previous,
      volume,
      clearedAtTick: tick,
    };
  }
}
