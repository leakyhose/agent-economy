import { describe, expect, it } from 'vitest';
import type { Entity, Expr, Json, SimEvent, WorldDefinition } from '@aw/types';
import { Engine, Rng, computeMetrics } from '@aw/engine';
import { allFixtures, scriptProposals, totalOf } from './harness.ts';

/** A literal, or `$params.<name>` resolved against a recorded proposal. */
function amountOf(by: Expr | undefined, params: Record<string, Json>): number | null {
  if (typeof by === 'number') return by;
  if (by && typeof by === 'object' && 'ref' in by) {
    const parts = (by as { ref: string }).ref.split('.');
    if (parts[0] === '$params' && parts.length === 2) {
      const v = params[parts[1] as string];
      return typeof v === 'number' ? v : null;
    }
  }
  return null;
}

/**
 * The net amount of `currency` a world's own rules mint or burn when an action
 * is applied. Transfers (a matching decrement and increment) net to zero, so a
 * non-zero result is a deliberate, world-declared source or sink.
 */
function declaredCurrencyDelta(
  world: WorldDefinition,
  currency: string,
  action: string,
  params: Record<string, Json>,
): number {
  let delta = 0;
  const suffix = `.resources.${currency}`;
  for (const rule of world.rules) {
    if (rule.when?.action !== action) continue;
    for (const effect of rule.effects) {
      if (effect.op !== 'increment' && effect.op !== 'decrement') continue;
      if (!effect.path.endsWith(suffix)) continue;
      const amount = amountOf(effect.by, params);
      expect(amount, `could not read the amount in rule "${rule.id}"`).not.toBeNull();
      delta += effect.op === 'increment' ? (amount as number) : -(amount as number);
    }
  }
  return delta;
}

function marketLegsBalance(events: SimEvent[], price: number): void {
  const fills = events.filter((e) => e.type === 'order_filled' && e.data['price'] === price);
  const leg = (side: string): number =>
    fills
      .filter((e) => e.data['side'] === side)
      .reduce((a, e) => a + (e.data['quantity'] as number), 0);
  expect(leg('bid')).toBe(leg('ask'));
}

describe('both fixture worlds run', () => {
  for (const { file, world } of allFixtures()) {
    it(`${file}: 300 ticks, no crash, no negative resources, currency conserved`, () => {
      const engine = new Engine(world, null);
      engine.init();

      const currency = (world.markets ?? [])[0]?.currency as string;
      expect(currency).toBeTruthy();
      let expected = totalOf(engine, currency);
      expect(expected).toBeGreaterThan(0);

      const rng = Rng.fromSeed(31337);
      let applied = 0;
      let clearings = 0;

      for (let t = 0; t < 300; t++) {
        for (const p of scriptProposals(engine, rng)) engine.submit(p);
        const result = engine.tick();

        for (const ev of result.events) {
          if (ev.type === 'action_applied') {
            applied += 1;
            expected += declaredCurrencyDelta(
              world,
              currency,
              ev.data['action'] as string,
              (ev.data['params'] ?? {}) as Record<string, Json>,
            );
          }
          if (ev.type === 'market_cleared') {
            clearings += 1;
            marketLegsBalance(result.events, ev.data['price'] as number);
          }
        }

        for (const entity of Object.values(engine.state.entities) as Entity[]) {
          for (const [rid, amount] of Object.entries(entity.resources)) {
            expect(
              amount,
              `${entity.id}.${rid} went negative at tick ${t}`,
            ).toBeGreaterThanOrEqual(0);
          }
        }

        expect(
          totalOf(engine, currency),
          `currency "${currency}" leaked at tick ${t}`,
        ).toBe(expected);
      }

      expect(engine.state.tick).toBe(300);
      expect(applied).toBeGreaterThan(200);
      expect(clearings).toBeGreaterThan(0);

      const metrics = computeMetrics(world, engine.state);
      for (const def of world.metrics ?? []) {
        expect(Number.isFinite(metrics[def.id]), `metric ${def.id}`).toBe(true);
      }
    });
  }
});
