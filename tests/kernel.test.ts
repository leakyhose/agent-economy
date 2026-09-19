import { describe, expect, it } from 'vitest';
import type { Entity } from '@aw/types';
import { Engine, MemoryRepository, computeMetrics, replay } from '@aw/engine';
import { testWorld } from './fixture-world.ts';

function started(): Engine {
  const engine = new Engine(testWorld(), null);
  engine.init();
  return engine;
}

function unit(engine: Engine, i: number): Entity {
  return engine.state.entities[`unit_${i}`] as Entity;
}

describe('init', () => {
  it('spawns the declared population with type defaults', () => {
    const engine = started();
    expect(Object.keys(engine.state.entities).sort()).toEqual([
      'unit_0',
      'unit_1',
      'unit_2',
      'unit_3',
    ]);
    expect(unit(engine, 0).resources).toEqual({ coin: 1000, widget: 5, gem: 0 });
    expect(unit(engine, 0).attributes).toEqual({ mood: 0, tag: 'none' });
    expect(engine.state.prices['widget_market']).toBe(100);
    expect(engine.state.tick).toBe(0);
  });

  it('applies cohort attribute overrides on top of type defaults', () => {
    const world = testWorld();
    world.population = [{ type: 'unit', count: 2, attributes: { tag: 'cohort' } }];
    const engine = new Engine(world, null);
    engine.init();
    expect(unit(engine, 1).attributes).toEqual({ mood: 0, tag: 'cohort' });
  });
});

describe('submit and rejection paths', () => {
  it('rejects an unknown action', () => {
    const engine = started();
    const r = engine.submit({ action: 'nope', actor: 'unit_0' });
    expect(r).toEqual({
      ok: false,
      rejectedBy: 'engine.unknown_action',
      message: 'no action "nope" in this world',
    });
  });

  it('rejects an actor of the wrong type', () => {
    const engine = started();
    engine.submit({ action: 'endow', actor: 'unit_0', params: { capital: 10 } });
    engine.tick();
    const r = engine.submit({ action: 'produce', actor: 'holding_0' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejectedBy).toBe('engine.actor_type');
  });

  it('rejects insufficient funds by naming the rule', () => {
    const engine = started();
    const r = engine.submit({ action: 'consume', actor: 'unit_0', params: { amount: 5000 } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.rejectedBy).toBe('consume_needs_coin');
      expect(r.message).toContain('consume_needs_coin');
    }
  });

  it('rejects insufficient stock through a dynamic path', () => {
    const engine = started();
    const r = engine.submit({
      action: 'offer',
      actor: 'unit_0',
      params: { resource: 'gem', quantity: 1, limit: 10 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejectedBy).toBe('offer_needs_stock');

    const ok = engine.submit({
      action: 'offer',
      actor: 'unit_0',
      params: { resource: 'widget', quantity: 5, limit: 10 },
    });
    expect(ok.ok).toBe(true);
  });

  it('rejects a missing required param and a wrongly typed one', () => {
    const engine = started();
    const missing = engine.submit({ action: 'consume', actor: 'unit_0' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.rejectedBy).toBe('engine.missing_param');

    const wrong = engine.submit({ action: 'consume', actor: 'unit_0', params: { amount: 'x' } });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.rejectedBy).toBe('engine.param_type');
  });

  it('rejects a proposal from an occupied actor for the action duration', () => {
    const engine = started();
    expect(engine.submit({ action: 'produce', actor: 'unit_0' }).ok).toBe(true);
    engine.tick(); // tick 0 -> busy until tick 2
    const busy = engine.submit({ action: 'produce', actor: 'unit_0' });
    expect(busy.ok).toBe(false);
    if (!busy.ok) expect(busy.rejectedBy).toBe('engine.actor_busy');
    engine.tick(); // tick 1
    expect(engine.submit({ action: 'produce', actor: 'unit_0' }).ok).toBe(true);
  });

  it('rejects a second queued action from the same actor in one tick', () => {
    const engine = started();
    expect(engine.submit({ action: 'produce', actor: 'unit_0' }).ok).toBe(true);
    const second = engine.submit({ action: 'produce', actor: 'unit_0' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.rejectedBy).toBe('engine.actor_already_queued');
  });

  it('logs a rejection event rather than mutating state', () => {
    const engine = started();
    engine.submit({ action: 'consume', actor: 'unit_0', params: { amount: 99999 } });
    const rejected = engine.unflushed.filter((e) => e.type === 'action_rejected');
    expect(rejected).toHaveLength(1);
    expect(unit(engine, 0).resources['coin']).toBe(1000);
  });
});

describe('resources never go negative', () => {
  it('refuses an unguarded decrement and rolls the whole action back', () => {
    const engine = started();
    const r = engine.submit({ action: 'overspend', actor: 'unit_0', params: { amount: 1500 } });
    expect(r.ok).toBe(true); // no rule forbids it at validation time
    const result = engine.tick();
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]?.result).toMatchObject({ rejectedBy: 'engine.effect_failed' });
    expect(result.rejections[0]?.result.ok).toBe(false);
    expect(unit(engine, 0).resources['coin']).toBe(1000);
    expect(unit(engine, 0).state['busyUntil']).toBeUndefined();
  });

  it('does not clamp: the balance is untouched, not zeroed', () => {
    const engine = started();
    engine.submit({ action: 'overspend', actor: 'unit_0', params: { amount: 1000.5 } });
    engine.tick();
    expect(unit(engine, 0).resources['coin']).toBe(1000);
  });

  it('allows a decrement that lands exactly on zero', () => {
    const engine = started();
    engine.submit({ action: 'overspend', actor: 'unit_0', params: { amount: 1000 } });
    engine.tick();
    expect(unit(engine, 0).resources['coin']).toBe(0);
  });
});

describe('effects', () => {
  it('spawns, binds $new, relates and produces a settlement intent', () => {
    const engine = started();
    engine.submit({ action: 'endow', actor: 'unit_0', params: { capital: 250 } });
    const result = engine.tick();

    const spawned = engine.state.entities['holding_0'] as Entity;
    expect(spawned).toBeTruthy();
    expect(spawned.resources['coin']).toBe(250);
    expect(spawned.attributes['label']).toBe('fresh');
    expect(unit(engine, 0).resources['coin']).toBe(750);
    expect(unit(engine, 0).relationships['controls']).toEqual(['holding_0']);
    expect(result.settlements).toEqual([
      { tick: 0, asset: 'coin', from: 'unit_0', to: 'holding_0', amount: 250 },
    ]);
  });

  it('broadcasts a tick rule over every entity of a type', () => {
    const engine = started();
    engine.step(4); // ticks 0..3: the rule has not come round yet
    for (let i = 0; i < 4; i++) expect(unit(engine, i).attributes['mood']).toBe(0);
    engine.step(1); // tick 4 fires it
    for (let i = 0; i < 4; i++) expect(unit(engine, i).attributes['mood']).toBe(1);
    engine.step(4); // tick 8 fires it again
    for (let i = 0; i < 4; i++) expect(unit(engine, i).attributes['mood']).toBe(2);
  });

  it('applies spoilage to free stock only', () => {
    const engine = started();
    // Pledge everything to a resting ask; free stock is then zero.
    engine.submit({
      action: 'offer',
      actor: 'unit_0',
      params: { resource: 'widget', quantity: 5, limit: 10000 },
    });
    engine.tick();
    expect(unit(engine, 0).resources['widget']).toBe(5);
    // unit_1 pledged nothing, so half its widgets spoil.
    expect(unit(engine, 1).resources['widget']).toBe(3);
  });

  it('fires a scheduled world event at its tick', () => {
    const engine = started();
    const results = engine.step(8);
    const fired = results.flatMap((r) => r.events).filter((e) => e.type === 'world_event');
    expect(fired.some((e) => e.data['id'] === 'scheduled_shock' && e.tick === 5)).toBe(true);
  });

  it('draws probabilistic events from the seeded cursor only', () => {
    const a = started();
    const b = started();
    a.step(30);
    b.step(30);
    expect(a.state.rngCursor).toBe(b.state.rngCursor);
    expect(a.state.rngCursor).not.toBe(started().state.rngCursor);
  });
});

describe('markets inside the engine', () => {
  it('moves goods and currency at one uniform price', () => {
    const engine = started();
    engine.submit({
      action: 'offer',
      actor: 'unit_0',
      params: { resource: 'widget', quantity: 4, limit: 80 },
    });
    engine.submit({
      action: 'seek',
      actor: 'unit_1',
      params: { resource: 'widget', quantity: 4, limit: 120 },
    });
    engine.tick(); // tick 0
    engine.tick(); // tick 1
    const before = { a: unit(engine, 0).resources['coin'], b: unit(engine, 1).resources['coin'] };
    const result = engine.tick(); // tick 2: not a round boundary yet (roundTicks 3)
    expect(result.events.some((e) => e.type === 'market_cleared')).toBe(false);

    const round = engine.tick(); // tick 3: clears
    const cleared = round.events.find((e) => e.type === 'market_cleared');
    expect(cleared).toBeTruthy();
    expect(cleared?.data['price']).toBe(100);
    expect(cleared?.data['volume']).toBe(4);
    expect(unit(engine, 0).resources['coin']).toBe((before.a as number) + 400);
    expect(unit(engine, 1).resources['coin']).toBe((before.b as number) - 400);
    expect(engine.state.prices['widget_market']).toBe(100);
  });
});

describe('controls', () => {
  it('pause stops runFor, resume restarts it, step ignores the flag', () => {
    const engine = started();
    engine.runFor(3);
    expect(engine.state.tick).toBe(3);
    engine.pause();
    expect(engine.paused).toBe(true);
    expect(engine.runFor(5)).toHaveLength(0);
    expect(engine.state.tick).toBe(3);
    engine.step(2);
    expect(engine.state.tick).toBe(5);
    engine.resume();
    engine.runFor(2);
    expect(engine.state.tick).toBe(7);
  });
});

describe('persistence and replay', () => {
  it('round-trips through the repository interface', async () => {
    const repo = new MemoryRepository();
    const engine = new Engine(testWorld(), repo);
    engine.init();
    for (let t = 0; t < 12; t++) {
      engine.submit({ action: 'produce', actor: `unit_${t % 4}` });
      engine.tick();
    }
    await engine.flush();
    await engine.snapshot();

    const events = await repo.loadEvents();
    expect(events.length).toBeGreaterThan(12);
    expect(await repo.loadSnapshot()).toEqual(engine.state);

    const restored = replay(testWorld(), events);
    expect(restored.state).toEqual(engine.state);
  });

  it('computes every declared metric', () => {
    const engine = started();
    engine.step(10);
    const metrics = computeMetrics(testWorld(), engine.state);
    expect(metrics['units']).toBe(4);
    expect(metrics['coin_sum']).toBe(4000);
    expect(metrics['coin_gini']).toBe(0);
  });
});
