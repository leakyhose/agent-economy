import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorldDefinition } from '@aw/types';
import { resolveViewConfig } from '../src/derive/viewConfig.ts';
import { FixtureEngine } from '../src/data/fixture.ts';
import { computeMetrics } from '../src/data/expr.ts';

const WORLD_DIR = join(__dirname, '..', '..', '..', 'worlds');

function loadWorlds(): Array<{ slug: string; world: WorldDefinition }> {
  return readdirSync(WORLD_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => ({
      slug: file.replace(/\.json$/, ''),
      world: JSON.parse(readFileSync(join(WORLD_DIR, file), 'utf8')) as WorldDefinition,
    }));
}

const worlds = loadWorlds();

describe('world discovery', () => {
  it('finds every definition on disk, both of the shipped ones included', () => {
    const slugs = worlds.map((w) => w.slug);
    expect(slugs).toContain('economic-sandbox');
    expect(slugs).toContain('medieval-kingdom');
    expect(worlds.length).toBeGreaterThanOrEqual(2);
  });
});

describe.each(worlds)('view config derived from $slug', ({ world }) => {
  const config = resolveViewConfig(world);

  it('takes its unit of account from the first declared resource', () => {
    expect(config.currency).toBe(world.resources[0]?.id);
    expect(config.resourceById[config.currency]?.isCurrency).toBe(true);
  });

  it('carries every entity type with a distinct colour and a stable index', () => {
    expect(config.entityTypes).toHaveLength(world.entityTypes.length);
    const colors = new Set(config.entityTypes.map((t) => t.color));
    expect(colors.size).toBe(world.entityTypes.length);
    config.entityTypes.forEach((type, index) => {
      expect(type.index).toBe(index);
      expect(type.id).toBe(world.entityTypes[index]?.id);
      expect(config.entityTypeById[type.id]).toBe(type);
    });
  });

  it('maps every action onto the types allowed to perform it', () => {
    for (const action of world.actions) {
      const actors = action.actorTypes ?? world.entityTypes.map((t) => t.id);
      for (const actor of actors) {
        expect(config.actionsByType[actor]?.map((a) => a.id)).toContain(action.id);
      }
    }
    const declared = new Set(world.actions.map((a) => a.id));
    for (const list of Object.values(config.actionsByType)) {
      for (const action of list) expect(declared.has(action.id)).toBe(true);
    }
  });

  it('produces one chart target per declared market, priced in that market currency', () => {
    expect(config.markets.map((m) => m.id)).toEqual((world.markets ?? []).map((m) => m.id));
    for (const market of config.markets) {
      expect(config.resourceById[market.resource]).toBeDefined();
      expect(config.resourceById[market.currency]).toBeDefined();
      expect(market.roundTicks).toBeGreaterThan(0);
    }
  });

  it('renders one series per declared metric and classifies it without reading its name', () => {
    expect(config.metrics.map((m) => m.id)).toEqual((world.metrics ?? []).map((m) => m.id));
    for (const metric of config.metrics) {
      const source = (world.metrics ?? []).find((m) => m.id === metric.id);
      if (source?.aggregate === 'gini') expect(metric.kind).toBe('index');
      if (source?.aggregate === 'count') expect(metric.kind).toBe('count');
    }
  });

  it('discovers relationship kinds from the rules rather than a hardcoded list', () => {
    const declared = new Set<string>();
    for (const rule of world.rules ?? []) {
      for (const effect of rule.effects ?? []) {
        if (effect.op === 'relate') declared.add(effect.kind);
      }
    }
    expect(new Set(config.relations.map((r) => r.kind))).toEqual(declared);
    for (const relation of config.relations) {
      expect(relation.fromTypes.length).toBeGreaterThan(0);
      expect(relation.toTypes.length).toBeGreaterThan(0);
    }
  });

  it('lists the resources this world settles on chain', () => {
    const expected = world.resources.filter((r) => r.onChain).map((r) => r.id);
    expect(config.onChainResources).toEqual(expected);
  });

  it('separates events raised by the world itself from ordinary rule emissions', () => {
    const fromWorldEvents = new Set<string>();
    for (const event of world.events ?? []) {
      for (const effect of event.effects ?? []) {
        if (effect.op === 'emit') fromWorldEvents.add(effect.event);
      }
    }
    expect(new Set(config.alertEventTypes)).toEqual(fromWorldEvents);
    for (const type of config.alertEventTypes) expect(config.eventTypes).toContain(type);
  });
});

describe.each(worlds)('fixture replay of $slug', ({ world }) => {
  it('populates, ticks and yields state, events and every declared metric', () => {
    const engine = new FixtureEngine(world, 1);
    const seeded = Object.values(engine.state.entities);
    expect(seeded.length).toBeGreaterThanOrEqual(
      (world.population ?? []).reduce((a, p) => a + p.count, 0),
    );
    for (const entity of seeded) {
      expect(world.entityTypes.some((t) => t.id === entity.type)).toBe(true);
      expect(typeof entity.state['wallet']).toBe('string');
    }

    let events = 0;
    let last = engine.step();
    for (let i = 0; i < 80; i += 1) {
      last = engine.step();
      events += last.events.length;
    }

    expect(last.state.tick).toBe(81);
    expect(events).toBeGreaterThan(0);
    for (const metric of world.metrics ?? []) {
      expect(Number.isFinite(last.metrics[metric.id])).toBe(true);
    }
    for (const market of world.markets ?? []) {
      expect(last.state.prices[market.id]).toBeGreaterThan(0);
      expect(last.books[market.id]?.demand.length).toBeGreaterThan(0);
      expect(last.books[market.id]?.supply.length).toBeGreaterThan(0);
    }
  });

  it('only ever emits event names the world declares, plus the engine ones', () => {
    const config = resolveViewConfig(world);
    const engine = new FixtureEngine(world, 1);
    const seen = new Set<string>();
    for (let i = 0; i < 120; i += 1) {
      for (const event of engine.step().events) seen.add(event.type);
    }
    expect(seen.size).toBeGreaterThan(0);
    for (const type of seen) expect(config.eventTypes).toContain(type);
  });
});

describe('a world this code has never seen', () => {
  const unseen: WorldDefinition = {
    name: 'Tidal Reef',
    seed: 99,
    time: { tickMs: 250, unit: 'cycle' },
    resources: [
      { id: 'shell', onChain: true, startPrice: 1, divisible: true },
      { id: 'plankton', onChain: false, startPrice: 120, spoilage: 0.2 },
      { id: 'coral', onChain: true, startPrice: 4400 },
    ],
    entityTypes: [
      { id: 'polyp', agent: true, attributes: { depth: 3 }, resources: { shell: 400, plankton: 5, coral: 0 } },
      { id: 'current', agent: false, attributes: {}, resources: { shell: 0, plankton: 0, coral: 0 } },
    ],
    actions: [
      { id: 'filter', actorTypes: ['polyp'], duration: 3 },
      {
        id: 'barter',
        actorTypes: ['polyp'],
        duration: 1,
        params: [
          { name: 'resource', type: 'resource', required: true },
          { name: 'quantity', type: 'number', required: true },
          { name: 'limit', type: 'number', required: true },
        ],
      },
      { id: 'attach', actorTypes: ['polyp'], targetTypes: ['current'], duration: 2 },
    ],
    rules: [
      {
        id: 'filter_yield',
        when: { action: 'filter' },
        effects: [
          { op: 'increment', path: '$actor.resources.plankton', by: 2 },
          { op: 'emit', event: 'fed' },
        ],
      },
      {
        id: 'attach_binds',
        when: { action: 'attach' },
        effects: [
          { op: 'relate', from: '$actor', to: '$target', kind: 'anchored' },
          { op: 'settle', asset: 'shell', from: '$actor', to: '$target', amount: 5 },
          { op: 'emit', event: 'anchored' },
        ],
      },
    ],
    markets: [
      { id: 'plankton_market', resource: 'plankton', currency: 'shell', mechanism: 'batch_auction', roundTicks: 4 },
      { id: 'coral_market', resource: 'coral', currency: 'shell', mechanism: 'fixed_price', roundTicks: 10 },
    ],
    population: [
      { type: 'polyp', count: 12 },
      { type: 'current', count: 3 },
    ],
    events: [{ id: 'bleaching', atTick: 30, effects: [{ op: 'emit', event: 'bleached' }] }],
    metrics: [
      { id: 'shell_supply', aggregate: 'sum', over: 'polyp', value: { ref: '$e.resources.shell' } },
      { id: 'reef_spread', aggregate: 'gini', over: 'polyp', value: { ref: '$e.resources.coral' } },
      { id: 'currents', aggregate: 'count', over: 'current' },
    ],
  };

  const config = resolveViewConfig(unseen);

  it('derives a complete dashboard with no change to the source', () => {
    expect(config.currency).toBe('shell');
    expect(config.entityTypes.map((t) => t.id)).toEqual(['polyp', 'current']);
    expect(config.agentTypes).toEqual(['polyp']);
    expect(config.markets).toHaveLength(2);
    expect(config.metrics.map((m) => m.kind)).toEqual(['currency', 'index', 'count']);
    expect(config.relations.map((r) => r.kind)).toEqual(['anchored']);
    expect(config.relations[0]?.fromTypes).toEqual(['polyp']);
    expect(config.relations[0]?.toTypes).toEqual(['current']);
    expect(config.onChainResources).toEqual(['shell', 'coral']);
    expect(config.settlementAssets).toEqual(['shell']);
    expect(config.alertEventTypes).toEqual(['bleached']);
    expect(config.tickUnit).toBe('cycle');
  });

  it('replays from fixtures and computes its metrics', () => {
    const engine = new FixtureEngine(unseen, 2);
    let result = engine.step();
    for (let i = 0; i < 60; i += 1) result = engine.step();
    expect(Object.keys(result.state.entities).length).toBeGreaterThanOrEqual(30);
    expect(result.metrics['currents']).toBe(6);
    expect(Number.isFinite(result.metrics['reef_spread'])).toBe(true);
    const direct = computeMetrics(unseen.metrics ?? [], result.state);
    expect(direct['shell_supply']).toBeCloseTo(result.metrics['shell_supply'] ?? -1, 6);
  });
});
