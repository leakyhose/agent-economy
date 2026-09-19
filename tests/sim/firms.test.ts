/**
 * The firm lifecycle in Economic Sandbox: found, hire, produce, pay, dividend,
 * fail. Driven by scripted proposals rather than by agents, so the rules are
 * tested independently of whether any decision engine happens to choose them.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { Engine, loadWorldFile } from '@aw/engine';
import type { WorldDefinition } from '@aw/types';

let world: WorldDefinition;
let engine: Engine;

const person = (n: number) => `person_${n}`;
const firms = () => Object.values(engine.state.entities).filter((e) => e.type === 'company');
const ent = (id: string) => engine.state.entities[id]!;

beforeEach(async () => {
  world = await loadWorldFile(resolve('worlds/economic-sandbox.json'));
  engine = new Engine(world, null);
  engine.init();
});

function found(by: number, capital = 3000) {
  return engine.submit({ action: 'found_company', actor: person(by), params: { capital } });
}

describe('founding a firm', () => {
  it('costs the founder capital and stands the firm up with it', () => {
    const before = ent(person(0)).resources['SOL']!;
    expect(found(0).ok).toBe(true);
    engine.tick();

    const firm = firms()[0]!;
    expect(ent(person(0)).resources['SOL']).toBe(before - 3000);
    expect(firm.resources['SOL']).toBe(3000);
    expect(firm.attributes['founder']).toBe(person(0));
    expect(ent(person(0)).relationships['owns']).toContain(firm.id);
  });

  it('allows only one firm per founder', () => {
    expect(found(0).ok).toBe(true);
    engine.runFor(4);          // founding occupies the actor; wait it out
    const second = found(0);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.rejectedBy).toBe('found_company_requires_capital');
    expect(firms()).toHaveLength(1);
  });

  it('lets a different person found their own', () => {
    found(0); engine.runFor(4);
    expect(found(1).ok).toBe(true);
    engine.tick();
    expect(firms()).toHaveLength(2);
  });

  it('refuses a founder who cannot cover the capital', () => {
    expect(found(0, 999_999).ok).toBe(false);
  });
});

describe('employment', () => {
  it('binds a worker to one firm, and refuses a second employer', () => {
    found(0); engine.tick();
    found(1); engine.tick();
    const [a, b] = firms();

    expect(engine.submit({ action: 'hire', actor: a!.id, target: person(5) }).ok).toBe(true);
    engine.tick();
    expect(ent(person(5)).attributes['employer']).toBe(a!.id);
    expect(ent(a!.id).attributes['headcount']).toBe(1);

    const poach = engine.submit({ action: 'hire', actor: b!.id, target: person(5) });
    expect(poach.ok).toBe(false);
    if (!poach.ok) expect(poach.rejectedBy).toBe('hire_takes_one_worker');
    expect(ent(person(5)).attributes['employer']).toBe(a!.id);
  });
});

describe('production', () => {
  it('sends an employed worker output to the firm, not to the worker', () => {
    found(0); engine.tick();
    const firm = firms()[0]!;
    engine.submit({ action: 'hire', actor: firm.id, target: person(5) });
    engine.tick();

    const workerFood = ent(person(5)).resources['food']!;
    const firmFood = ent(firm.id).resources['food'] ?? 0;
    engine.submit({ action: 'gather_food', actor: person(5) });
    engine.tick();

    expect(ent(firm.id).resources['food']).toBeGreaterThan(firmFood);
    expect(ent(person(5)).resources['food']).toBe(workerFood);
  });

  it('leaves an unemployed worker their own output', () => {
    const before = ent(person(7)).resources['food']!;
    engine.submit({ action: 'gather_food', actor: person(7) });
    engine.tick();
    expect(ent(person(7)).resources['food']).toBeGreaterThan(before);
  });
});

describe('payroll', () => {
  it('pays a wage each round out of the firm', () => {
    found(0); engine.tick();
    const firm = firms()[0]!;
    engine.submit({ action: 'hire', actor: firm.id, target: person(5) });
    engine.tick();

    const wage = firm.attributes['wage'] as number;
    const workerBefore = ent(person(5)).resources['SOL']!;
    const firmBefore = ent(firm.id).resources['SOL']!;
    engine.runFor(7);

    expect(ent(person(5)).resources['SOL']).toBeGreaterThanOrEqual(workerBefore + wage);
    expect(ent(firm.id).resources['SOL']).toBeLessThanOrEqual(firmBefore - wage);
  });

  it('lays a worker off when the firm cannot pay, and frees them to be rehired', () => {
    found(0, 1000); engine.tick();
    const firm = firms()[0]!;
    engine.submit({ action: 'hire', actor: firm.id, target: person(5) });
    engine.tick();
    // Drain the treasury so payroll must fail.
    ent(firm.id).resources['SOL'] = 0;
    engine.runFor(7);

    expect(ent(person(5)).attributes['employer']).toBeNull();
    expect(ent(firm.id).attributes['headcount']).toBe(0);
  });
});

describe('returns to ownership', () => {
  it('pays the founder a dividend once the firm is in profit', () => {
    found(0, 5000); engine.tick();
    const firm = firms()[0]!;
    const ownerBefore = ent(person(0)).resources['SOL']!;
    engine.runFor(13);
    expect(ent(person(0)).resources['SOL']).toBeGreaterThan(ownerBefore);
    expect(ent(firm.id).resources['SOL']).toBeLessThan(5000);
  });
});

describe('failure', () => {
  it('dissolves an empty firm with no money', () => {
    found(0, 1000); engine.tick();
    const firm = firms()[0]!;
    ent(firm.id).resources['SOL'] = 0;
    engine.runFor(13);
    expect(engine.state.entities[firm.id]).toBeUndefined();
    // and the owner's edge goes with it
    expect(ent(person(0)).relationships['owns'] ?? []).not.toContain(firm.id);
  });

  it('does not dissolve a firm that still employs someone', () => {
    found(0, 5000); engine.tick();
    const firm = firms()[0]!;
    engine.submit({ action: 'hire', actor: firm.id, target: person(5) });
    engine.tick();
    engine.runFor(13);
    // It may have laid the worker off, but it must not vanish underneath them.
    if (ent(person(5)).attributes['employer'] !== null) {
      expect(engine.state.entities[firm.id]).toBeDefined();
    }
  });
});
