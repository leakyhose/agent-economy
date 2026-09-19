/**
 * The clearing rule, in TypeScript.
 *
 * This is a line-for-line mirror of `compute_clearing` in
 * `programs/world/src/lib.rs`. It exists so the off-chain market in `@aw/engine` and
 * the on-chain one can be run over the same order set and diffed — the invariant
 * worth writing on a wall is *on-chain clear == off-chain clear*. If the two ever
 * disagree, one of them is wrong and it matters which.
 *
 * Integers throughout. Prices are in the world's minor units, as the world files
 * declare them (`startPrice: 500` is 500 of the currency, not 5.00).
 */

/** Wire-identical to the program's `Order`. */
export interface Order {
  /** Ledger slot index, `u16`. */
  agent: number;
  /** `u32`. */
  qty: number;
  /** Limit price in the world's currency, `u32`. */
  limit: number;
}

/** Wire-identical to the program's `Delta`. */
export interface Delta {
  agent: number;
  good: number;
  /** Signed, `i32`. */
  delta: number;
}

export interface AuctionOutcome {
  price: number;
  volume: number;
}

/** Bids descending by limit — the order the program verifies, not one it imposes. */
export function sortBids(orders: Order[]): Order[] {
  return [...orders].sort((a, b) => b.limit - a.limit || a.agent - b.agent);
}

/** Asks ascending by limit. */
export function sortAsks(orders: Order[]): Order[] {
  return [...orders].sort((a, b) => a.limit - b.limit || a.agent - b.agent);
}

/**
 * Walk the two crossed ladders inward and take the midpoint of the marginal bid and
 * ask as the one price everyone trades at. Returns `null` when nothing crosses.
 *
 * Assumes the sortedness above. The program verifies it in O(n) rather than sorting,
 * because sorting hundreds of orders on-chain does not fit the compute budget.
 */
export function clearAuction(bids: Order[], asks: Order[]): AuctionOutcome | null {
  if (bids.length === 0 || asks.length === 0) return null;
  let i = 0;
  let j = 0;
  let bidRem = bids[0]!.qty;
  let askRem = asks[0]!.qty;
  let volume = 0;
  let lastBid = 0;
  let lastAsk = 0;
  while (i < bids.length && j < asks.length && bids[i]!.limit >= asks[j]!.limit) {
    const q = Math.min(bidRem, askRem);
    volume += q;
    lastBid = bids[i]!.limit;
    lastAsk = asks[j]!.limit;
    bidRem -= q;
    askRem -= q;
    if (bidRem === 0) {
      i += 1;
      if (i < bids.length) bidRem = bids[i]!.qty;
    }
    if (askRem === 0) {
      j += 1;
      if (j < asks.length) askRem = asks[j]!.qty;
    }
  }
  if (volume === 0) return null;
  // `lastBid >= lastAsk`, so the floor of the midpoint sits inside both limits: no
  // buyer pays above its limit and no seller sells below its.
  return { price: Math.max(1, Math.floor((lastBid + lastAsk) / 2)), volume };
}

/**
 * Which orders actually fill, and by how much.
 *
 * The program does not report this — it just writes the balances — so this reproduces
 * its two settlement loops for anyone that needs to mirror the result off-chain.
 * The top of each book fills in full and the marginal order is truncated.
 */
export function fills(orders: Order[], volume: number): { agent: number; qty: number }[] {
  const out: { agent: number; qty: number }[] = [];
  let remaining = volume;
  for (const o of orders) {
    if (remaining === 0) break;
    const q = Math.min(o.qty, remaining);
    out.push({ agent: o.agent, qty: q });
    remaining -= q;
  }
  return out;
}
