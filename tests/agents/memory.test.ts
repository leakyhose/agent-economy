import { describe, expect, it } from 'vitest';
import { Memory } from '../../packages/agents/src/memory.ts';

describe('memory stores', () => {
  it('keeps the short store as a ring buffer, oldest out first', () => {
    const memory = new Memory({ limits: { short: 3 } });
    for (let i = 0; i < 6; i++) {
      memory.setTick(i);
      // Salience descending, so only the ring discipline can explain the result.
      memory.remember('short', `item ${i}`, 1 - i * 0.1);
    }
    expect(memory.size('short')).toBe(3);
    expect(memory.all('short').map((r) => r.content)).toEqual(['item 3', 'item 4', 'item 5']);
  });

  it('evicts the least salient from the durable stores, oldest first on a tie', () => {
    const memory = new Memory({ limits: { long: 3 } });
    memory.remember('long', 'dull one', 0.1);
    memory.remember('long', 'dull two', 0.1);
    memory.remember('long', 'vivid', 0.9);
    memory.remember('long', 'notable', 0.5);

    const kept = memory.all('long').map((r) => r.content);
    expect(kept).not.toContain('dull one');
    expect(kept).toContain('vivid');
    expect(kept).toContain('notable');
    expect(kept).toHaveLength(3);
  });

  it('ranks recall by keyword overlap first, then salience, then recency', () => {
    const memory = new Memory();
    memory.setTick(10);
    memory.remember('long', 'nothing relevant at all', 0.9);
    memory.remember('long', 'the widget level was steady', 0.2);
    memory.setTick(20);
    memory.remember('long', 'the widget level jumped', 0.2);

    const recalled = memory.recall('widget level', 3);
    expect(recalled[0]).toBe('the widget level jumped');
    expect(recalled[1]).toBe('the widget level was steady');
    expect(recalled[2]).toBe('nothing relevant at all');
  });

  it('recalls deterministically and never repeats a line', () => {
    const memory = new Memory();
    for (let i = 0; i < 5; i++) memory.remember('episodic', 'same line', 0.5);
    expect(memory.recall('same', 5)).toEqual(['same line']);
    expect(memory.recall('same', 5)).toEqual(memory.recall('same', 5));
  });

  it('folds repeated samples into one semantic generalisation', () => {
    const memory = new Memory();
    memory.observeValue('level:a', 100);
    memory.observeValue('level:a', 200);
    memory.observeValue('level:a', 300);

    const summary = memory.valueOf('level:a');
    expect(summary?.count).toBe(3);
    expect(summary?.mean).toBe(200);
    expect(summary?.low).toBe(100);
    expect(summary?.high).toBe(300);
    expect(memory.size('semantic')).toBe(1);
    expect(memory.recall('level:a', 1)[0]).toContain('avg=200');
  });

  it('ignores samples that are not numbers', () => {
    const memory = new Memory();
    expect(memory.observeValue('level:b', Number.NaN)).toBeNull();
    expect(memory.valueOf('level:b')).toBeNull();
  });

  it('keeps trust inside -1..1 and remembers who it is about', () => {
    const memory = new Memory();
    memory.note('other-1', 'dealt fairly', 0.6, 0.4);
    memory.note('other-1', 'dealt fairly again', 0.6, 0.9);
    expect(memory.trustOf('other-1')).toBe(1);
    memory.adjustTrust('other-1', -5);
    expect(memory.trustOf('other-1')).toBe(-1);
    expect(memory.trustOf('never-met')).toBe(0);
    expect(memory.knownOthers()).toEqual(['other-1']);
    expect(memory.notesAbout('other-1')).toHaveLength(2);
  });
});
