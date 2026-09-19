// The simulation kernel.
//
// The engine reads a WorldDefinition as data. It has no idea what any of the
// identifiers in that data mean, and it must stay that way.

import type {
  ActionDef,
  ActionProposal,
  Entity,
  EntityId,
  Json,
  MarketDef,
  Observation,
  Repository,
  SettlementIntent,
  SimEvent,
  ValidationResult,
  WorldDefinition,
  WorldEventDef,
  WorldState,
} from '@aw/types';

import { nextRandom, seedCursor } from './rng.ts';
import { SCOPE_ACTOR, sortedEntities } from './expr.ts';
import {
  BUSY_UNTIL,
  REJECT_EFFECT,
  REJECT_QUEUED,
  applyEffects,
  proposalScope,
  rulesForAction,
  tickRules,
  validate,
  type EffectContext,
} from './rules.ts';
import {
  clearBatchAuction,
  clearFixedPrice,
  type ClearingResult,
  type Order,
  type OrderSide,
} from './market.ts';
import { validateWorld } from './world.ts';

// ---------------------------------------------------------------------------
// Kernel protocol constants
//
// These are the kernel's own vocabulary, not any world's. A world opts into
// market participation by emitting one of these two events from a rule, and by
// declaring params with these three names. Nothing here names a resource, an
// entity type or an action.
// ---------------------------------------------------------------------------

export const ORDER_EVENT_DEMAND = 'bid_posted';
export const ORDER_EVENT_SUPPLY = 'ask_posted';
export const PARAM_RESOURCE = 'resource';
export const PARAM_QUANTITY = 'quantity';
export const PARAM_LIMIT = 'limit';

export const EV_ACTION_APPLIED = 'action_applied';
export const EV_ACTION_REJECTED = 'action_rejected';
export const EV_TICK_COMPLETED = 'tick_completed';
export const EV_MARKET_CLEARED = 'market_cleared';
export const EV_ORDER_FILLED = 'order_filled';
export const EV_SPOILED = 'spoiled';
export const EV_WORLD_EVENT = 'world_event';
export const EV_ENTITY_SPAWNED = 'entity_spawned';
export const EV_WORLD_READY = 'world_ready';

export interface TickResult {
  tick: number;
  events: SimEvent[];
  settlements: SettlementIntent[];
  rejections: { proposal: ActionProposal; result: ValidationResult }[];
}

interface QueuedProposal {
  proposal: ActionProposal;
  seq: number;
}

export class Engine {
  readonly world: WorldDefinition;
  private readonly repo: Repository | null;

  private _state: WorldState;
  private _paused = false;
  private _initialised = false;

  private queue: QueuedProposal[] = [];
  private openOrders: Order[] = [];
  private counters: Record<string, number> = {};
  private eventSeq = 0;
  private orderSeq = 0;
  private submitSeq = 0;
  private pending: SimEvent[] = [];
  private allSettlements: SettlementIntent[] = [];

  constructor(world: WorldDefinition, repo: Repository | null = null) {
    this.world = validateWorld(world);
    this.repo = repo;
    this._state = {
      worldName: world.name,
      tick: 0,
      entities: {},
      prices: {},
      rngCursor: seedCursor(world.seed),
    };
  }

  // -- accessors ------------------------------------------------------------

  get state(): WorldState {
    return this._state;
  }

  get paused(): boolean {
    return this._paused;
  }

  get orders(): readonly Order[] {
    return this.openOrders;
  }

  get settlements(): readonly SettlementIntent[] {
    return this.allSettlements;
  }

  /** Events produced but not yet handed to the repository. */
  get unflushed(): readonly SimEvent[] {
    return this.pending;
  }

  // -- setup ----------------------------------------------------------------

  /** Create the starting population and opening prices. */
  init(): SimEvent[] {
    if (this._initialised) throw new Error('engine is already initialised');
    this._initialised = true;

    const produced: SimEvent[] = [
      this.event(EV_WORLD_READY, { world: this.world.name, seed: this.world.seed }),
    ];

    for (const market of this.world.markets ?? []) {
      const def = this.world.resources.find((r) => r.id === market.resource);
      this._state.prices[market.id] = def?.startPrice ?? 0;
    }

    for (const cohort of this.world.population) {
      for (let i = 0; i < cohort.count; i++) {
        const entity = this.makeEntity(cohort.type, cohort.attributes);
        this._state.entities[entity.id] = entity;
        produced.push(this.event(EV_ENTITY_SPAWNED, { id: entity.id, type: entity.type }));
      }
    }

    this.pending.push(...produced);
    return produced;
  }

  private makeEntity(type: string, overrides?: Record<string, Json>): Entity {
    const def = this.world.entityTypes.find((t) => t.id === type);
    if (!def) throw new Error(`unknown entity type "${type}"`);
    const resources: Record<string, number> = {};
    for (const r of this.world.resources) resources[r.id] = 0;
    for (const [k, v] of Object.entries(def.resources ?? {})) resources[k] = v;
    return {
      id: this.allocId(type),
      type,
      attributes: { ...(def.attributes ?? {}), ...(overrides ?? {}) },
      resources,
      relationships: {},
      owns: [],
      state: {},
    };
  }

  private allocId(type: string): EntityId {
    const n = this.counters[type] ?? 0;
    this.counters[type] = n + 1;
    return `${type}_${n}`;
  }

  private event(type: string, data: Record<string, Json>): SimEvent {
    return { seq: this.eventSeq++, tick: this._state.tick, type, data };
  }

  private effectContext(settlements: SettlementIntent[]): EffectContext {
    return {
      world: this.world,
      tick: this._state.tick,
      allocId: (type) => this.allocId(type),
      nextSeq: () => this.eventSeq++,
      settlements,
    };
  }

  private draw(): number {
    const d = nextRandom(this._state.rngCursor);
    this._state.rngCursor = d.cursor;
    return d.value;
  }

  // -- intake ---------------------------------------------------------------

  /**
   * The only way state changes from outside. A valid proposal is queued for the
   * next tick; an invalid one is logged as a rejection and discarded.
   */
  submit(proposal: ActionProposal): ValidationResult {
    if (!this._initialised) throw new Error('call init() before submitting proposals');

    if (this.queue.some((q) => q.proposal.actor === proposal.actor)) {
      const result: ValidationResult = {
        ok: false,
        rejectedBy: REJECT_QUEUED,
        message: `entity "${proposal.actor}" already has a queued action this tick`,
      };
      this.logRejection(proposal, result);
      return result;
    }

    const result = validate(proposal, this._state, this.world);
    if (!result.ok) {
      this.logRejection(proposal, result);
      return result;
    }
    this.queue.push({ proposal, seq: this.submitSeq++ });
    return result;
  }

  private logRejection(proposal: ActionProposal, result: ValidationResult): void {
    if (result.ok) return;
    this.pending.push(
      this.event(EV_ACTION_REJECTED, {
        action: proposal.action,
        actor: proposal.actor,
        rejectedBy: result.rejectedBy,
        message: result.message,
      }),
    );
  }

  /** Actions this entity could legally attempt right now. */
  availableActions(actorId: EntityId): string[] {
    const actor = this._state.entities[actorId];
    if (!actor) return [];
    return this.world.actions
      .filter((a) => !a.actorTypes || a.actorTypes.length === 0 || a.actorTypes.includes(actor.type))
      .filter(() => {
        const until = actor.state[BUSY_UNTIL];
        return !(typeof until === 'number' && until > this._state.tick);
      })
      .map((a) => a.id);
  }

  /** A filtered view for a decision engine. Full visibility for now. */
  observe(actorId: EntityId, recent = 20): Observation {
    const self = this._state.entities[actorId];
    if (!self) throw new Error(`no entity "${actorId}"`);
    return {
      tick: this._state.tick,
      self,
      availableActions: this.availableActions(actorId),
      visibleEntities: sortedEntities(this._state).filter((e) => e.id !== actorId),
      prices: { ...this._state.prices },
      recentEvents: this.pending.slice(-recent),
      memories: [],
    };
  }

  // -- the tick -------------------------------------------------------------

  tick(): TickResult {
    if (!this._initialised) throw new Error('call init() before ticking');

    const t = this._state.tick;
    const events: SimEvent[] = [];
    const settlements: SettlementIntent[] = [];
    const rejections: TickResult['rejections'] = [];

    this.runQueue(events, settlements, rejections);
    this.runTickRules(t, events, settlements);
    this.runSpoilage(events);
    this.runWorldEvents(t, events, settlements);
    this.runMarkets(t, events);

    events.push(this.event(EV_TICK_COMPLETED, { tick: t }));

    this.pending.push(...events);
    this.allSettlements.push(...settlements);
    this._state.tick = t + 1;

    return { tick: t, events, settlements, rejections };
  }

  private runQueue(
    events: SimEvent[],
    settlements: SettlementIntent[],
    rejections: TickResult['rejections'],
  ): void {
    const batch = [...this.queue].sort((a, b) => a.seq - b.seq);
    this.queue = [];

    for (const { proposal } of batch) {
      // Re-check: an earlier action this tick may have invalidated this one.
      const recheck = validate(proposal, this._state, this.world);
      if (!recheck.ok) {
        rejections.push({ proposal, result: recheck });
        events.push(
          this.event(EV_ACTION_REJECTED, {
            action: proposal.action,
            actor: proposal.actor,
            rejectedBy: recheck.rejectedBy,
            message: recheck.message,
          }),
        );
        continue;
      }

      const backup = structuredClone(this._state);
      const counterBackup = { ...this.counters };
      const seqBackup = this.eventSeq;
      const localSettlements: SettlementIntent[] = [];
      const produced: SimEvent[] = [];

      // Reserve the applied-action event first so its sequence number precedes
      // the effect events it caused. Rollback rewinds the counter.
      const appliedEvent = this.event(EV_ACTION_APPLIED, {
        action: proposal.action,
        actor: proposal.actor,
        target: proposal.target ?? null,
        params: (proposal.params ?? {}) as Json,
      });

      try {
        const scope = proposalScope(proposal, this._state);
        const ctx = this.effectContext(localSettlements);
        for (const rule of rulesForAction(this.world, proposal.action)) {
          produced.push(...applyEffects(rule.effects, scope, this._state, ctx));
        }
      } catch (err) {
        this._state = backup;
        this.counters = counterBackup;
        this.eventSeq = seqBackup;
        const result: ValidationResult = {
          ok: false,
          rejectedBy: REJECT_EFFECT,
          message: `action "${proposal.action}" was rolled back: ${(err as Error).message}`,
        };
        rejections.push({ proposal, result });
        events.push(
          this.event(EV_ACTION_REJECTED, {
            action: proposal.action,
            actor: proposal.actor,
            rejectedBy: result.rejectedBy,
            message: result.message,
          }),
        );
        continue;
      }

      const action = this.world.actions.find((a) => a.id === proposal.action) as ActionDef;
      const actor = this._state.entities[proposal.actor];
      if (actor) actor.state[BUSY_UNTIL] = this._state.tick + (action.duration ?? 1);

      events.push(appliedEvent);
      events.push(...produced);
      settlements.push(...localSettlements);
      this.captureOrders(proposal, produced);
    }
  }

  /** Turn kernel-protocol order events into resting orders. */
  private captureOrders(proposal: ActionProposal, produced: SimEvent[]): void {
    for (const ev of produced) {
      let side: OrderSide;
      if (ev.type === ORDER_EVENT_DEMAND) side = 'bid';
      else if (ev.type === ORDER_EVENT_SUPPLY) side = 'ask';
      else continue;

      const params = proposal.params ?? {};
      const resource = params[PARAM_RESOURCE];
      const quantity = params[PARAM_QUANTITY];
      const limit = params[PARAM_LIMIT];
      if (typeof resource !== 'string' || typeof quantity !== 'number' || typeof limit !== 'number') {
        continue;
      }
      const market = (this.world.markets ?? []).find((m) => m.resource === resource);
      if (!market) continue;
      if (quantity <= 0 || limit < 0) continue;

      this.openOrders.push({
        id: `${market.id}#${String(this.orderSeq).padStart(8, '0')}`,
        market: market.id,
        side,
        actor: proposal.actor,
        resource: market.resource,
        currency: market.currency,
        quantity,
        limit,
        seq: this.orderSeq++,
      });
    }
  }

  private runTickRules(t: number, events: SimEvent[], settlements: SettlementIntent[]): void {
    if (t === 0) return;
    for (const rule of tickRules(this.world)) {
      const every = rule.when?.tick?.every ?? 0;
      if (every <= 0 || t % every !== 0) continue;
      const ctx = this.effectContext(settlements);
      events.push(...applyEffects(rule.effects, {}, this._state, ctx));
    }
  }

  /** Quantities pledged to resting orders, which spoilage must not eat. */
  private reservedStock(): Map<string, number> {
    const held = new Map<string, number>();
    for (const o of this.openOrders) {
      if (o.side !== 'ask') continue;
      const key = `${o.actor}|${o.resource}`;
      held.set(key, (held.get(key) ?? 0) + o.quantity);
    }
    return held;
  }

  private runSpoilage(events: SimEvent[]): void {
    const reserved = this.reservedStock();
    for (const def of this.world.resources) {
      const rate = def.spoilage ?? 0;
      if (rate <= 0) continue;
      let lost = 0;
      for (const entity of sortedEntities(this._state)) {
        const holding = entity.resources[def.id] ?? 0;
        const free = holding - (reserved.get(`${entity.id}|${def.id}`) ?? 0);
        if (free <= 0) continue;
        const loss = Math.floor(free * rate);
        if (loss <= 0) continue;
        entity.resources[def.id] = holding - loss;
        lost += loss;
      }
      if (lost > 0) events.push(this.event(EV_SPOILED, { resource: def.id, amount: lost }));
    }
  }

  private runWorldEvents(t: number, events: SimEvent[], settlements: SettlementIntent[]): void {
    for (const def of this.world.events ?? []) {
      if (!this.isScheduled(def, t)) continue;
      if (def.chance !== undefined && this.draw() >= def.chance) continue;
      events.push(this.event(EV_WORLD_EVENT, { id: def.id }));
      const ctx = this.effectContext(settlements);
      events.push(...applyEffects(def.effects, {}, this._state, ctx));
    }
  }

  private isScheduled(def: WorldEventDef, t: number): boolean {
    if (def.atTick !== undefined && t === def.atTick) return true;
    if (def.every !== undefined && t > 0 && t % def.every === 0) return true;
    if (def.atTick === undefined && def.every === undefined) return def.chance !== undefined;
    return false;
  }

  // -- markets --------------------------------------------------------------

  private runMarkets(t: number, events: SimEvent[]): void {
    if (t === 0) return;
    for (const market of this.world.markets ?? []) {
      const every = market.roundTicks ?? 1;
      if (every <= 0 || t % every !== 0) continue;
      const round = this.openOrders.filter((o) => o.market === market.id);
      this.openOrders = this.openOrders.filter((o) => o.market !== market.id);
      if (round.length === 0) continue;
      this.clearMarket(market, round, events);
    }
  }

  /**
   * Drop orders the holder can no longer back, so every fill is settleable and
   * no balance can be driven below zero.
   */
  private coveredOrders(orders: readonly Order[]): Order[] {
    const spent = new Map<string, number>();
    const kept: Order[] = [];
    for (const o of [...orders].sort((a, b) => a.seq - b.seq)) {
      const holder = this._state.entities[o.actor];
      if (!holder) continue;
      const asset = o.side === 'bid' ? o.currency : o.resource;
      const need = o.side === 'bid' ? o.limit * o.quantity : o.quantity;
      const key = `${o.actor}|${asset}`;
      const already = spent.get(key) ?? 0;
      const balance = holder.resources[asset] ?? 0;
      if (already + need > balance) continue;
      spent.set(key, already + need);
      kept.push(o);
    }
    return kept;
  }

  private clearMarket(market: MarketDef, orders: readonly Order[], events: SimEvent[]): void {
    const usable = this.coveredOrders(orders);
    const demand = usable.filter((o) => o.side === 'bid');
    const supply = usable.filter((o) => o.side === 'ask');

    let result: ClearingResult | null;
    if (market.mechanism === 'fixed_price') {
      const price = this._state.prices[market.id] ?? 0;
      result = clearFixedPrice(demand, supply, price);
    } else {
      result = clearBatchAuction(demand, supply);
    }
    if (!result) return;

    const byId = new Map(usable.map((o) => [o.id, o]));
    for (const fill of result.supplyFills) {
      const order = byId.get(fill.orderId);
      if (!order) continue;
      this.move(order.actor, market.resource, -fill.quantity);
      this.move(order.actor, market.currency, result.price * fill.quantity);
      events.push(
        this.event(EV_ORDER_FILLED, {
          market: market.id,
          side: 'ask',
          actor: order.actor,
          quantity: fill.quantity,
          price: result.price,
        }),
      );
    }
    for (const fill of result.demandFills) {
      const order = byId.get(fill.orderId);
      if (!order) continue;
      this.move(order.actor, market.currency, -result.price * fill.quantity);
      this.move(order.actor, market.resource, fill.quantity);
      events.push(
        this.event(EV_ORDER_FILLED, {
          market: market.id,
          side: 'bid',
          actor: order.actor,
          quantity: fill.quantity,
          price: result.price,
        }),
      );
    }

    this._state.prices[market.id] = result.price;
    events.push(
      this.event(EV_MARKET_CLEARED, {
        market: market.id,
        price: result.price,
        volume: result.volume,
      }),
    );
  }

  private move(entityId: EntityId, resource: string, delta: number): void {
    const entity = this._state.entities[entityId];
    if (!entity) throw new Error(`no entity "${entityId}"`);
    const next = (entity.resources[resource] ?? 0) + delta;
    if (next < 0) {
      throw new Error(
        `clearing would drive "${entityId}" resource "${resource}" to ${next}; refusing`,
      );
    }
    entity.resources[resource] = next;
  }

  // -- controls -------------------------------------------------------------

  pause(): void {
    this._paused = true;
  }

  resume(): void {
    this._paused = false;
  }

  /** Advance n ticks, ignoring the paused flag. */
  step(n = 1): TickResult[] {
    const out: TickResult[] = [];
    for (let i = 0; i < n; i++) out.push(this.tick());
    return out;
  }

  /** Advance n ticks unless paused. */
  runFor(ticks: number): TickResult[] {
    const out: TickResult[] = [];
    for (let i = 0; i < ticks; i++) {
      if (this._paused) break;
      out.push(this.tick());
    }
    return out;
  }

  // -- persistence ----------------------------------------------------------

  /** Hand buffered events to the repository and clear the buffer. */
  async flush(): Promise<SimEvent[]> {
    const batch = this.pending;
    this.pending = [];
    if (this.repo && batch.length > 0) await this.repo.appendEvents(batch);
    return batch;
  }

  async snapshot(): Promise<void> {
    if (this.repo) await this.repo.saveSnapshot(this._state);
  }
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/** Extract the applied-action stream from an event log, grouped by tick. */
export function proposalsByTick(events: readonly SimEvent[]): Map<number, ActionProposal[]> {
  const out = new Map<number, ActionProposal[]>();
  for (const ev of [...events].sort((a, b) => a.seq - b.seq)) {
    if (ev.type !== EV_ACTION_APPLIED) continue;
    const target = ev.data['target'];
    const proposal: ActionProposal = {
      action: ev.data['action'] as string,
      actor: ev.data['actor'] as string,
      ...(typeof target === 'string' ? { target } : {}),
      params: (ev.data['params'] ?? {}) as Record<string, Json>,
    };
    out.set(ev.tick, [...(out.get(ev.tick) ?? []), proposal]);
  }
  return out;
}

/** How many ticks the log covers. */
export function ticksInLog(events: readonly SimEvent[]): number {
  let last = -1;
  for (const ev of events) if (ev.type === EV_TICK_COMPLETED) last = Math.max(last, ev.tick);
  return last + 1;
}

/**
 * Rebuild state from an event log: feed the recorded proposals back into a
 * fresh engine. Same world, same seed, same order, same result.
 */
export function replay(
  world: WorldDefinition,
  events: readonly SimEvent[],
  repo: Repository | null = null,
): Engine {
  const engine = new Engine(world, repo);
  engine.init();
  const byTick = proposalsByTick(events);
  const total = ticksInLog(events);
  for (let t = 0; t < total; t++) {
    for (const proposal of byTick.get(t) ?? []) engine.submit(proposal);
    engine.tick();
  }
  return engine;
}

export { SCOPE_ACTOR };
