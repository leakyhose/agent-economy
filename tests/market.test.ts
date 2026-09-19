import { describe, expect, it } from 'vitest';
import type { Order } from '@aw/engine';
import { allocate, clearBatchAuction, clearFixedPrice, sortDemand } from '@aw/engine';

let seq = 0;
function order(side: 'bid' | 'ask', actor: string, quantity: number, limit: number): Order {
  seq += 1;
  return {
    id: `m#${String(seq).padStart(4, '0')}`,
    market: 'm',
    side,
    actor,
    resource: 'r',
    currency: 'c',
    quantity,
    limit,
    seq,
  };
}

describe('batch auction clearing', () => {
  it('returns null when the books do not cross', () => {
    seq = 0;
    const result = clearBatchAuction([order('bid', 'e_0', 3, 50)], [order('ask', 'e_1', 3, 60)]);
    expect(result).toBeNull();
  });

  it('prices at the midpoint of the last crossing pair and fills that volume', () => {
    seq = 0;
    const bids = [order('bid', 'e_0', 5, 10), order('bid', 'e_1', 5, 8)];
    const asks = [order('ask', 'e_2', 4, 6), order('ask', 'e_3', 4, 9)];
    const result = clearBatchAuction(bids, asks);
    expect(result).not.toBeNull();
    expect(result?.volume).toBe(5);
    expect(result?.price).toBe(10); // round((10 + 9) / 2)

    const demand = Object.fromEntries(result!.demandFills.map((f) => [f.actor, f.quantity]));
    const supply = Object.fromEntries(result!.supplyFills.map((f) => [f.actor, f.quantity]));
    expect(demand).toEqual({ e_0: 5 });
    expect(supply).toEqual({ e_2: 4, e_3: 1 });
  });

  it('every trade happens at the single uniform price', () => {
    seq = 0;
    const bids = [order('bid', 'e_0', 2, 200), order('bid', 'e_1', 2, 150)];
    const asks = [order('ask', 'e_2', 2, 100), order('ask', 'e_3', 2, 140)];
    const result = clearBatchAuction(bids, asks);
    expect(result?.volume).toBe(4);
    expect(result?.price).toBe(145); // round((150 + 140) / 2)
    const filled = (result?.demandFills ?? []).reduce((a, f) => a + f.quantity, 0);
    const offered = (result?.supplyFills ?? []).reduce((a, f) => a + f.quantity, 0);
    expect(filled).toBe(offered);
  });

  it('rations the marginal level pro-rata, not by arrival', () => {
    seq = 0;
    const bids = [order('bid', 'e_2', 3, 100), order('bid', 'e_0', 3, 100), order('bid', 'e_1', 3, 100)];
    const asks = [order('ask', 'e_9', 4, 50)];
    const result = clearBatchAuction(bids, asks);
    expect(result?.volume).toBe(4);
    const byActor = Object.fromEntries((result?.demandFills ?? []).map((f) => [f.actor, f.quantity]));
    // 4 units over three equal 3-unit orders: 1 each, remainder to the lowest id.
    expect(byActor).toEqual({ e_0: 2, e_1: 1, e_2: 1 });
  });

  it('is insensitive to the order the books are handed over in', () => {
    seq = 0;
    const bids = [order('bid', 'e_0', 3, 100), order('bid', 'e_1', 4, 120), order('bid', 'e_2', 2, 90)];
    const asks = [order('ask', 'e_3', 5, 80), order('ask', 'e_4', 3, 95)];
    const forwards = clearBatchAuction(bids, asks);
    const backwards = clearBatchAuction([...bids].reverse(), [...asks].reverse());
    expect(backwards).toEqual(forwards);
  });

  it('never hands an order more than it asked for', () => {
    seq = 0;
    const bids = [order('bid', 'e_0', 1, 100), order('bid', 'e_1', 1, 100)];
    const fills = allocate(sortDemand(bids), 5);
    expect(fills.every((f) => f.quantity === 1)).toBe(true);
    expect(fills.reduce((a, f) => a + f.quantity, 0)).toBe(2);
  });

  it('clears at a fixed price when the world asks for one', () => {
    seq = 0;
    const bids = [order('bid', 'e_0', 3, 120), order('bid', 'e_1', 3, 80)];
    const asks = [order('ask', 'e_2', 5, 90)];
    const result = clearFixedPrice(bids, asks, 100);
    expect(result?.price).toBe(100);
    expect(result?.volume).toBe(3);
  });
});
