// Turns market fills into settlement intents.
//
// The engine clears markets and knows nothing about Solana - correctly; that is
// the whole design. A world that declares `chain.onChainMarkets` wants those
// clearings to land on chain, and translating one into the other is the
// integration layer's job, so it lives here and not in the kernel.
//
// A uniform-price batch auction is zero-sum in its currency: every unit a buyer
// pays, a seller receives. So rather than inventing a counterparty account, net
// each participant's currency delta over the round and match payers against
// receivers. The sum is zero by construction, which is what lets the ledger
// accept the batch - the chain enforces conservation and would reject anything
// else.
import type { SettlementIntent, SimEvent, WorldDefinition } from '@aw/types';

interface Fill {
  market: string;
  side: string;
  actor: string;
  quantity: number;
  price: number;
}

export function settlementsFromFills(
  events: readonly SimEvent[],
  world: WorldDefinition,
  tick: number,
): SettlementIntent[] {
  if (!world.chain?.onChainMarkets) return [];

  const currencyOf = new Map<string, string>();
  for (const m of world.markets ?? []) currencyOf.set(m.id, m.currency);
  const onChain = new Set(world.resources.filter((r) => r.onChain).map((r) => r.id));

  // Net currency movement per participant, per currency.
  const net = new Map<string, Map<string, number>>();
  for (const e of events) {
    if (e.type !== 'order_filled') continue;
    const f = e.data as unknown as Fill;
    const currency = currencyOf.get(f.market);
    if (!currency || !onChain.has(currency)) continue;

    const amount = Math.round(f.quantity * f.price);
    if (amount <= 0) continue;

    const book = net.get(currency) ?? new Map<string, number>();
    // A filled bid pays currency out; a filled ask takes currency in.
    book.set(f.actor, (book.get(f.actor) ?? 0) + (f.side === 'bid' ? -amount : amount));
    net.set(currency, book);
  }

  const intents: SettlementIntent[] = [];
  for (const [asset, book] of net) {
    // Sorted so the pairing is deterministic: same fills, same transfers.
    const payers = [...book].filter(([, v]) => v < 0).sort(([a], [b]) => a < b ? -1 : 1)
      .map(([id, v]) => ({ id, left: -v }));
    const payees = [...book].filter(([, v]) => v > 0).sort(([a], [b]) => a < b ? -1 : 1)
      .map(([id, v]) => ({ id, left: v }));

    let i = 0;
    let j = 0;
    while (i < payers.length && j < payees.length) {
      const from = payers[i]!;
      const to = payees[j]!;
      const amount = Math.min(from.left, to.left);
      if (amount > 0) intents.push({ tick, asset, from: from.id, to: to.id, amount });
      from.left -= amount;
      to.left -= amount;
      if (from.left === 0) i++;
      if (to.left === 0) j++;
    }
    // Any residue is a rounding remainder the auction kept; it is never negative
    // and never creates value, so leaving it unsettled is safe.
  }
  return intents;
}
