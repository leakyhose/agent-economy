// Uniform-price batch auction.
//
// Fully deterministic: identical inputs always produce identical fills. There
// is no time priority -- ordering is by limit, then by entity id, then by the
// order's own id, so the result does not depend on arrival order.

import type { EntityId } from '@aw/types';

export type OrderSide = 'bid' | 'ask';

export interface Order {
  id: string;
  market: string;
  side: OrderSide;
  actor: EntityId;
  resource: string;
  currency: string;
  quantity: number;
  /** Highest acceptable price for a bid, lowest acceptable for an ask. */
  limit: number;
  /** Submission counter, used only as a last-resort tie-break. */
  seq: number;
}

export interface Fill {
  orderId: string;
  actor: EntityId;
  quantity: number;
}

export interface ClearingResult {
  price: number;
  volume: number;
  demandFills: Fill[];
  supplyFills: Fill[];
}

function tieBreak(a: Order, b: Order): number {
  if (a.actor !== b.actor) return a.actor < b.actor ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return a.seq - b.seq;
}

export function sortDemand(orders: readonly Order[]): Order[] {
  return [...orders].sort((a, b) => b.limit - a.limit || tieBreak(a, b));
}

export function sortSupply(orders: readonly Order[]): Order[] {
  return [...orders].sort((a, b) => a.limit - b.limit || tieBreak(a, b));
}

/**
 * Hand out `volume` units across `sorted` orders. Whole price levels are filled
 * in order; the level the volume runs out on is rationed pro-rata, with the
 * rounding remainder handed out one unit at a time in tie-break order.
 */
export function allocate(sorted: readonly Order[], volume: number): Fill[] {
  const fills: Fill[] = [];
  let left = volume;
  let i = 0;
  while (i < sorted.length && left > 0) {
    const level = (sorted[i] as Order).limit;
    let j = i;
    let levelTotal = 0;
    while (j < sorted.length && (sorted[j] as Order).limit === level) {
      levelTotal += (sorted[j] as Order).quantity;
      j++;
    }
    const group = sorted.slice(i, j);

    if (levelTotal <= left) {
      for (const o of group) fills.push({ orderId: o.id, actor: o.actor, quantity: o.quantity });
      left -= levelTotal;
      i = j;
      continue;
    }

    // Marginal level: pro-rata by share of the level, deterministic remainder.
    const ration = [...group].sort(tieBreak);
    const shares = ration.map((o) => Math.floor((left * o.quantity) / levelTotal));
    let remainder = left - shares.reduce((a, b) => a + b, 0);
    for (let k = 0; k < ration.length && remainder > 0; k++) {
      const o = ration[k] as Order;
      if ((shares[k] as number) < o.quantity) {
        shares[k] = (shares[k] as number) + 1;
        remainder--;
      }
    }
    for (let k = 0; k < ration.length; k++) {
      const q = shares[k] as number;
      if (q > 0) fills.push({ orderId: (ration[k] as Order).id, actor: (ration[k] as Order).actor, quantity: q });
    }
    left = 0;
    i = j;
  }
  return fills.sort((a, b) => (a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0));
}

/**
 * Walk the two books inward while they cross, accumulating volume. The price is
 * the midpoint of the last crossing pair.
 */
export function clearBatchAuction(
  demand: readonly Order[],
  supply: readonly Order[],
): ClearingResult | null {
  const bids = sortDemand(demand);
  const asks = sortSupply(supply);

  let i = 0;
  let j = 0;
  let bidLeft = bids.length > 0 ? (bids[0] as Order).quantity : 0;
  let askLeft = asks.length > 0 ? (asks[0] as Order).quantity : 0;
  let volume = 0;
  let lastBid: number | null = null;
  let lastAsk: number | null = null;

  while (i < bids.length && j < asks.length) {
    const bid = bids[i] as Order;
    const ask = asks[j] as Order;
    if (bid.limit < ask.limit) break;
    const traded = Math.min(bidLeft, askLeft);
    if (traded <= 0) break;
    volume += traded;
    lastBid = bid.limit;
    lastAsk = ask.limit;
    bidLeft -= traded;
    askLeft -= traded;
    if (bidLeft === 0) {
      i++;
      bidLeft = i < bids.length ? (bids[i] as Order).quantity : 0;
    }
    if (askLeft === 0) {
      j++;
      askLeft = j < asks.length ? (asks[j] as Order).quantity : 0;
    }
  }

  if (volume <= 0 || lastBid === null || lastAsk === null) return null;

  const price = Math.round((lastBid + lastAsk) / 2);
  return {
    price,
    volume,
    demandFills: allocate(bids, volume),
    supplyFills: allocate(asks, volume),
  };
}

/** Match everything that is acceptable at a price the world already fixed. */
export function clearFixedPrice(
  demand: readonly Order[],
  supply: readonly Order[],
  price: number,
): ClearingResult | null {
  const bids = sortDemand(demand.filter((o) => o.limit >= price));
  const asks = sortSupply(supply.filter((o) => o.limit <= price));
  const total = (list: readonly Order[]): number => list.reduce((a, o) => a + o.quantity, 0);
  const volume = Math.min(total(bids), total(asks));
  if (volume <= 0) return null;
  return {
    price,
    volume,
    demandFills: allocate(bids, volume),
    supplyFills: allocate(asks, volume),
  };
}
