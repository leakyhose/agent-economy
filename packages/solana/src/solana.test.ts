import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import type { WorldDefinition } from '@aw/types';
import { clearAuction, fills, sortAsks, sortBids, type Order } from './auction.ts';
import { chainOf, clusterFromEnv, explorerUrl, makeExplorer } from './config.ts';
import { endowmentsFor, mapWorldGoods, modalEndowment, rosterFromWorld } from './goods.ts';
import {
  LEDGER_BYTES,
  MAX_ORDERS_PER_BOOK,
  clearAuctionIx,
  discriminator,
  initializeIx,
  liquidateIx,
  loadIdl,
  settleIx,
} from './ix.ts';
import { distressThresholdFor } from './client.ts';
import { NullSettlementQueue } from './settlement.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const load = (f: string) =>
  JSON.parse(readFileSync(join(ROOT, 'worlds', f), 'utf8')) as WorldDefinition;

const sandbox = load('economic-sandbox.json');
const kingdom = load('medieval-kingdom.json');

describe('good mapping is derived from the world file', () => {
  it('reads Economic Sandbox as SOL, food, wood, tools', () => {
    const m = mapWorldGoods(sandbox);
    expect(m.goods).toEqual(['SOL', 'food', 'wood', 'tools']);
    expect(m.currency).toBe('SOL');
    expect(m.numGoods).toBe(4);
  });

  it('reads Medieval Kingdom as gold, food, wood, iron, land', () => {
    const m = mapWorldGoods(kingdom);
    expect(m.goods).toEqual(['gold', 'food', 'wood', 'iron', 'land']);
    expect(m.currency).toBe('gold');
    expect(m.numGoods).toBe(5);
  });

  it('leaves off-chain resources out', () => {
    // `labor` in the sandbox is declared without `onChain`.
    expect(mapWorldGoods(sandbox).indexOf('labor')).toBeUndefined();
    expect(() => mapWorldGoods(sandbox).mustIndexOf('labor')).toThrow(/does not settle/);
  });

  it('takes the currency from the markets, not from resource order', () => {
    // Reorder the resources so the currency is no longer first. The markets still
    // price everything in gold, so gold must still be index 0.
    const shuffled: WorldDefinition = {
      ...kingdom,
      resources: [...kingdom.resources].reverse(),
    };
    const m = mapWorldGoods(shuffled);
    expect(m.currency).toBe('gold');
    expect(m.goods[0]).toBe('gold');
  });

  it('refuses a world that prices markets in two currencies', () => {
    const mixed: WorldDefinition = {
      ...kingdom,
      markets: [
        { id: 'a', resource: 'food', currency: 'gold', mechanism: 'batch_auction' },
        { id: 'b', resource: 'iron', currency: 'iron', mechanism: 'batch_auction' },
      ],
    };
    expect(() => mapWorldGoods(mixed)).toThrow(/more than one currency/);
  });
});

describe('the population lands in ledger slots', () => {
  it('flattens the sandbox to 24 people', () => {
    const r = rosterFromWorld(sandbox);
    expect(r.count).toBe(24);
    expect(r.ids[0]).toBe('person_0');
    expect(r.indexOf('person_23')).toBe(23);
  });

  it('numbers several cohorts of one type continuously, as the engine does', () => {
    // Two cohorts of the same type must not both start at _0.
    const twoCohorts = {
      ...sandbox,
      population: [
        { type: 'person', count: 3 },
        { type: 'person', count: 2 },
      ],
    };
    const r = rosterFromWorld(twoCohorts);
    expect(r.ids).toEqual(['person_0', 'person_1', 'person_2', 'person_3', 'person_4']);
    expect(new Set(r.ids).size).toBe(r.ids.length);
  });

  it('flattens the kingdom to 18 + 4 + 3 + 2', () => {
    const r = rosterFromWorld(kingdom);
    expect(r.count).toBe(27);
    expect(r.types.filter((t) => t === 'peasant')).toHaveLength(18);
    expect(r.indexOf('kingdom_1')).toBe(26);
  });

  it('endows the unequal world and leaves the equal one alone', () => {
    const sMap = mapWorldGoods(sandbox);
    const sRoster = rosterFromWorld(sandbox);
    const sUniform = modalEndowment(sandbox, sRoster, sMap);
    expect(sUniform.cash).toBe(5000);
    // Everybody is a `person`, so there is nothing to correct after `initialize`.
    expect(endowmentsFor(sandbox, sRoster, sMap, sUniform)).toHaveLength(0);

    const kMap = mapWorldGoods(kingdom);
    const kRoster = rosterFromWorld(kingdom);
    const kUniform = modalEndowment(kingdom, kRoster, kMap);
    expect(kUniform.cash).toBe(800); // peasants are the modal type
    const corrections = endowmentsFor(kingdom, kRoster, kMap, kUniform);
    expect(corrections.length).toBeGreaterThan(0);
    // A kingdom's treasury and its land both need writing.
    expect(corrections).toContainEqual({ agent: 26, good: 0, amount: 50_000 });
    expect(corrections).toContainEqual({ agent: 26, good: 4, amount: 20 });
  });
});

describe('the auction mirror', () => {
  // These are the same fixtures as the Rust tests in programs/world/src/lib.rs.
  // If one side changes, this fails, which is the entire point of having a mirror.
  it('prices at the marginal midpoint', () => {
    expect(clearAuction([{ agent: 0, qty: 10, limit: 100 }], [{ agent: 1, qty: 10, limit: 90 }]))
      .toEqual({ price: 95, volume: 10 });
  });

  it('stops where the ladders stop crossing', () => {
    const bids: Order[] = [
      { agent: 0, qty: 5, limit: 120 },
      { agent: 1, qty: 8, limit: 110 },
      { agent: 2, qty: 4, limit: 50 },
    ];
    const asks: Order[] = [
      { agent: 3, qty: 6, limit: 100 },
      { agent: 4, qty: 9, limit: 130 },
    ];
    expect(clearAuction(bids, asks)).toEqual({ price: 105, volume: 6 });
  });

  it('returns null when nothing crosses', () => {
    expect(clearAuction([{ agent: 0, qty: 5, limit: 50 }], [{ agent: 1, qty: 5, limit: 80 }]))
      .toBeNull();
    expect(clearAuction([], [{ agent: 1, qty: 5, limit: 80 }])).toBeNull();
  });

  it('sorts the way the program demands', () => {
    const unsorted: Order[] = [
      { agent: 0, qty: 1, limit: 50 },
      { agent: 1, qty: 1, limit: 90 },
      { agent: 2, qty: 1, limit: 70 },
    ];
    expect(sortBids(unsorted).map((o) => o.limit)).toEqual([90, 70, 50]);
    expect(sortAsks(unsorted).map((o) => o.limit)).toEqual([50, 70, 90]);
  });

  it('fills the top of the book first and truncates the marginal order', () => {
    const bids: Order[] = [
      { agent: 0, qty: 5, limit: 120 },
      { agent: 1, qty: 8, limit: 110 },
    ];
    expect(fills(bids, 6)).toEqual([
      { agent: 0, qty: 5 },
      { agent: 1, qty: 1 },
    ]);
  });
});

describe('the wire format', () => {
  it('matches the account size the program computes', () => {
    expect(LEDGER_BYTES).toBe(12_928);
  });

  it('computes Anchor discriminators by hand', () => {
    expect([...discriminator('initialize')]).toEqual([175, 175, 109, 31, 13, 152, 155, 237]);
  });

  it('agrees with the built IDL, when there is one', () => {
    // The IDL is a build artifact and is gitignored, so on a fresh clone it is simply
    // absent until `anchor build` runs. That is not a failure — but when it is there,
    // `loadIdl` cross-checks every discriminator and must not throw.
    const idl = join(ROOT, 'target/idl/world.json');
    if (!existsSync(idl)) return;
    expect(() => loadIdl(idl)).not.toThrow();
  });

  it('encodes the permissionless instruction with no authority account', () => {
    const ix = liquidateIx(PublicKey.default, {
      ledger: PublicKey.default,
      caller: PublicKey.unique(),
      agent: 7,
      good: 2,
    });
    expect(ix.data.length).toBe(11);
    expect(ix.data.readUInt16LE(8)).toBe(7);
    expect(ix.data.readUInt8(10)).toBe(2);
    // Two accounts: the ledger, and whoever is calling. No authority, by design.
    expect(ix.keys).toHaveLength(2);
    expect(ix.keys[1]?.isSigner).toBe(true);
  });

  it('encodes initialize with the relief pool and distress threshold', () => {
    const ix = initializeIx(
      PublicKey.default,
      { ledger: PublicKey.default, authority: PublicKey.default },
      {
        numAgents: 25,
        numGoods: 4,
        startCash: 5000,
        startGoods: [0, 6, 0, 0, 0, 0, 0, 0],
        distressThreshold: 500,
        reliefPool: 24,
      },
    );
    expect(ix.data.length).toBe(8 + 4 + 1 + 8 + 32 + 8 + 2);
    expect(ix.data.readUInt32LE(8)).toBe(25);
    expect(ix.data.readUInt8(12)).toBe(4);
    expect(ix.data.readBigUInt64LE(13)).toBe(5000n);
    expect(ix.data.readUInt32LE(21 + 4)).toBe(6); // start_goods[1] = food
    expect(ix.data.readBigUInt64LE(53)).toBe(500n);
    expect(ix.data.readUInt16LE(61)).toBe(24);
  });

  it('fits 96 orders and refuses a book that would not', () => {
    const programId = PublicKey.default;
    const accounts = { ledger: PublicKey.default, authority: PublicKey.default };
    const book = (n: number, base: number): Order[] =>
      Array.from({ length: n }, (_, k) => ({ agent: k, qty: 1, limit: base + k }));

    const ok = clearAuctionIx(programId, accounts, {
      good: 1,
      bids: book(MAX_ORDERS_PER_BOOK, 100),
      asks: book(MAX_ORDERS_PER_BOOK, 100),
    });
    expect(ok.data.length).toBe(977);

    expect(() =>
      clearAuctionIx(programId, accounts, { good: 1, bids: book(200, 100), asks: [] }),
    ).toThrow(/will not hold it/);
  });

  it('encodes a delta as seven little-endian bytes', () => {
    const ix = settleIx(
      PublicKey.default,
      { ledger: PublicKey.default, authority: PublicKey.default },
      [{ agent: 513, good: 3, delta: -7 }],
    );
    expect(ix.data.length).toBe(8 + 4 + 7);
    expect(ix.data.readUInt32LE(8)).toBe(1); // Vec length prefix
    expect(ix.data.readUInt16LE(12)).toBe(513);
    expect(ix.data.readUInt8(14)).toBe(3);
    expect(ix.data.readInt32LE(15)).toBe(-7);
  });
});

describe('the chain block, read from the world file', () => {
  it('declares the sandbox tokens the sandbox asks for', () => {
    const tokens = chainOf(sandbox)?.tokens ?? {};
    expect(Object.keys(tokens)).toEqual(['SOL', 'food', 'wood', 'tools']);
    expect(tokens['SOL']).toMatchObject({ symbol: 'WORLD', decimals: 4, fixedSupply: true });
    expect(tokens['food']).toMatchObject({ symbol: 'FOOD', decimals: 0 });
    // food is not fixed supply: the world can grow more of it, which is the point.
    expect(tokens['food']?.fixedSupply).toBeUndefined();
  });

  it('declares the kingdom tokens the kingdom asks for', () => {
    const tokens = chainOf(kingdom)?.tokens ?? {};
    expect(Object.keys(tokens)).toEqual(['gold', 'food', 'wood', 'iron']);
    expect(tokens['gold']).toMatchObject({ symbol: 'GOLD', decimals: 2, fixedSupply: true });
    expect(tokens['food']?.symbol).toBe('GRAIN');
    expect(tokens['wood']?.symbol).toBe('TIMBR');
    // `land` is a pda_record asset, not a fungible token, so it has no mint and
    // settles through the ledger instead.
    expect(tokens['land']).toBeUndefined();
    expect(mapWorldGoods(kingdom).indexOf('land')).toBe(4);
  });

  it('derives the distress threshold from what the world sells', () => {
    // The cheapest thing on any market: wood in both worlds, at 300 and 250.
    expect(distressThresholdFor(sandbox, 'SOL')).toBe(300);
    expect(distressThresholdFor(kingdom, 'gold')).toBe(250);
  });
});

describe('explorer links', () => {
  it('points a custom cluster at the configured RPC', () => {
    const cfg = clusterFromEnv({ AW_RPC_URL: 'http://127.0.0.1:8899' });
    expect(explorerUrl(cfg, 'tx', 'abc')).toBe(
      'https://explorer.solana.com/tx/abc?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899',
    );
  });

  it('names a public cluster plainly', () => {
    const cfg = clusterFromEnv({ AW_CLUSTER: 'devnet', AW_RPC_URL: 'https://api.devnet.solana.com' });
    expect(makeExplorer(cfg)('address', 'xyz')).toBe(
      'https://explorer.solana.com/address/xyz?cluster=devnet',
    );
  });
});

describe('NullSettlementQueue', () => {
  it('lets the simulation run with no chain, and never invents a signature', async () => {
    const q = new NullSettlementQueue();
    q.enqueue({ tick: 1, asset: 'gold', from: 'a', to: 'b', amount: 10 });
    q.enqueue({ tick: 2, asset: 'food', from: 'b', to: 'c', amount: 3 });
    expect(q.pending()).toBe(2);
    expect(await q.flush()).toEqual([]);
    expect(q.pending()).toBe(0);
    // It still records what happened, so an offline test can assert on it.
    expect(q.intents()).toHaveLength(2);
    expect(q.intents()[1]?.asset).toBe('food');
  });
});
