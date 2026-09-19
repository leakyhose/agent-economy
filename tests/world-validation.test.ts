import { describe, expect, it } from 'vitest';
import { WorldValidationError, loadWorld, validateWorld } from '@aw/engine';
import { allFixtures } from './harness.ts';
import { testWorld } from './fixture-world.ts';

function expectProblem(mutate: (w: ReturnType<typeof testWorld>) => void, needle: string): void {
  const world = testWorld();
  mutate(world);
  try {
    validateWorld(world);
    throw new Error(`expected validation to fail with "${needle}"`);
  } catch (err) {
    expect(err).toBeInstanceOf(WorldValidationError);
    expect((err as Error).message).toContain(needle);
  }
}

describe('world validation', () => {
  it('accepts both shipped worlds', () => {
    for (const { file, world } of allFixtures()) {
      expect(world.name, file).toBeTruthy();
    }
  });

  it('rejects a rule that fires on an undeclared action', () => {
    expectProblem((w) => {
      w.rules[0]!.when = { action: 'no_such_action' };
    }, 'which is not declared in "actions"');
  });

  it('rejects a market whose traded resource does not exist', () => {
    expectProblem((w) => {
      w.markets![0]!.resource = 'phlogiston';
    }, 'traded resource "phlogiston" is not declared');
  });

  it('rejects a market whose currency does not exist', () => {
    expectProblem((w) => {
      w.markets![0]!.currency = 'scrip';
    }, 'currency "scrip" is not declared');
  });

  it('rejects a population cohort of an unknown entity type', () => {
    expectProblem((w) => {
      w.population[0]!.type = 'gremlin';
    }, 'population: unknown entity type "gremlin"');
  });

  it('rejects a path with an unknown scope root', () => {
    expectProblem((w) => {
      w.rules[0]!.effects = [{ op: 'increment', path: '$everyone.resources.coin', by: 1 }];
    }, 'which is not in scope here');
  });

  it('rejects $actor in a tick rule', () => {
    expectProblem((w) => {
      w.rules.push({
        id: 'bad_tick_rule',
        when: { tick: { every: 2 } },
        effects: [{ op: 'increment', path: '$actor.resources.coin', by: 1 }],
      });
    }, 'path "$actor.resources.coin" starts with "$actor"');
  });

  it('rejects a broadcast over an unknown entity type', () => {
    expectProblem((w) => {
      w.rules.push({
        id: 'bad_broadcast',
        when: { tick: { every: 2 } },
        effects: [{ op: 'increment', path: '$each.wombat.attributes.mood', by: 1 }],
      });
    }, 'broadcasts over unknown entity type "wombat"');
  });

  it('rejects $new before anything binds it', () => {
    expectProblem((w) => {
      w.rules[0]!.effects = [{ op: 'increment', path: '$new.resources.coin', by: 1 }];
    }, 'path "$new.resources.coin" starts with "$new"');
  });

  it('rejects a spawn of an unknown entity type', () => {
    expectProblem((w) => {
      w.rules[0]!.effects = [{ op: 'spawn', type: 'dragon' }];
    }, 'spawn names unknown entity type "dragon"');
  });

  it('rejects a metric over an unknown entity type', () => {
    expectProblem((w) => {
      w.metrics![0]!.over = 'ghost';
    }, '"over" names unknown entity type "ghost"');
  });

  it('rejects duplicate ids', () => {
    expectProblem((w) => {
      w.resources.push({ id: 'coin' });
    }, 'declares id "coin" more than once');
  });

  it('rejects two markets competing for one resource', () => {
    expectProblem((w) => {
      w.markets!.push({
        id: 'second_widget_market',
        resource: 'widget',
        currency: 'coin',
        mechanism: 'batch_auction',
      });
    }, 'is traded by more than one market');
  });

  it('rejects a malformed metric aggregate', () => {
    expectProblem((w) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (w.metrics![0] as any).aggregate = 'median';
    }, 'unknown aggregate "median"');
  });

  it('reports every problem at once, not just the first', () => {
    const world = testWorld();
    world.population[0]!.type = 'gremlin';
    world.markets![0]!.currency = 'scrip';
    try {
      validateWorld(world);
      throw new Error('expected failure');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('gremlin');
      expect(message).toContain('scrip');
    }
  });

  it('rejects text that is not JSON with a clear message', () => {
    expect(() => loadWorld('{ not json')).toThrow(/not valid JSON/);
  });

  it('rejects a world missing its required sections', () => {
    expect(() => loadWorld('{"name":"x","seed":1}')).toThrow(/"resources" must be an array/);
  });
});
