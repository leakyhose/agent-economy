// Solana bridge. The ledger account is the source of truth for every balance.
// Instructions are hand-encoded: Anchor's JS coder caps instruction data at 1000
// bytes, which a full village order book overflows.
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import fs from 'node:fs';
import path from 'node:path';
import { CFG, ROOT } from './config.mjs';

const idl = JSON.parse(fs.readFileSync(path.join(ROOT, 'chain/target/idl/chain.json'), 'utf8'));
const DISC = Object.fromEntries(idl.instructions.map(i => [i.name, Buffer.from(i.discriminator)]));
export const PROGRAM_ID = new PublicKey(idl.address);

// Must match lib.rs. The layout is decoded by hand in fetch() below.
export const N_GOODS = 4;              // food, wood, nets, boats
export const MAX_AGENTS = 150;
export const PLEDGEABLE = [false, true, true, true];   // food rots and can't be collateral
export const FIRE_SALE_BPS = 8000;     // foreclosure values seized goods at 80% of the last price
export const BANK = 0xffff;            // order "agent" id for the bank's foreclosure sales
const SLOT = 64;                       // cash u64, goods [u32;4], locked [u32;4], debt, principal, due_slot u64
const HEADER = 8 + 264;                // discriminator + everything before slots (see Ledger in lib.rs)
const LEDGER_SIZE = HEADER + MAX_AGENTS * SLOT;
const MAX_ORDERS_PER_TX = 96;          // ~1220 bytes: the legacy transaction ceiling
const MAX_DELTAS_PER_TX = 120;

export const explorer = (kind, id) =>
  `https://explorer.solana.com/${kind}/${id}?cluster=custom&customUrl=${encodeURIComponent(CFG.RPC)}`;

export async function connectChain() {
  const conn = new Connection(CFG.RPC, 'confirmed');
  const authority = Keypair.fromSecretKey(Uint8Array.from(
    JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, 'utf8'))));
  const ledger = Keypair.generate();
  // A stranger with no authority over the ledger. It forecloses loans and pays dividends,
  // to prove on every call that `liquidate` and `pay_dividend` really are open to anyone.
  const keeper = Keypair.generate();
  let txCount = 0;

  async function send(ix, extraSigners = [], signers = [authority, ...extraSigners]) {
    const tx = new Transaction().add(ix);
    try {
      const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: 'confirmed' });
      txCount++;
      return sig;
    } catch (e) {
      const logs = e.transactionLogs ?? e.logs ?? [];
      const why = logs.find(l => l.includes('Error Message')) ?? e.message;
      throw new Error(`chain tx failed: ${why}`);
    }
  }

  const writeKeys = () => [
    { pubkey: ledger.publicKey, isSigner: false, isWritable: true },
    { pubkey: authority.publicKey, isSigner: true, isWritable: false },
  ];

  // prices: opening last price per good, in cents. bankSeed: the bank's opening equity.
  // terms: { ltvBps, rateBps, penaltyBps, kappaBps, marginBps, termSlots, equityFloor }
  async function initialize(n, cash, food, wood, prices, bankSeed, terms) {
    const d = Buffer.alloc(8 + 4 + 8 + 4 + 4 + 8 * N_GOODS + 8 + 26);
    DISC.initialize.copy(d, 0);
    d.writeUInt32LE(n, 8); d.writeBigUInt64LE(BigInt(cash), 12); d.writeUInt32LE(food, 20); d.writeUInt32LE(wood, 24);
    prices.forEach((p, g) => d.writeBigUInt64LE(BigInt(p), 28 + g * 8));
    d.writeBigUInt64LE(BigInt(bankSeed), 60);
    d.writeUInt16LE(terms.ltvBps, 68); d.writeUInt16LE(terms.rateBps, 70); d.writeUInt16LE(terms.penaltyBps, 72);
    d.writeUInt16LE(terms.kappaBps, 74); d.writeUInt16LE(terms.marginBps, 76);
    d.writeBigUInt64LE(BigInt(terms.termSlots), 78); d.writeBigUInt64LE(BigInt(terms.equityFloor ?? 0), 86);
    const sig = await conn.requestAirdrop(keeper.publicKey, 1e9);   // localnet: fees for the keeper
    await conn.confirmTransaction(sig, 'confirmed');
    return send(new TransactionInstruction({
      programId: PROGRAM_ID, data: d, keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: ledger.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    }), [ledger]);
  }

  // Signed goods deltas: catches, meals, crafting, wear. Chunked to fit a transaction.
  async function settle(deltas) {
    const sigs = [];
    for (let i = 0; i < deltas.length; i += MAX_DELTAS_PER_TX) {
      const chunk = deltas.slice(i, i + MAX_DELTAS_PER_TX);
      const d = Buffer.alloc(8 + 4 + chunk.length * 7);
      DISC.settle.copy(d, 0);
      d.writeUInt32LE(chunk.length, 8);
      chunk.forEach((x, k) => {
        const o = 12 + k * 7;
        d.writeUInt16LE(x.agent, o); d.writeUInt8(x.good, o + 2); d.writeInt32LE(x.delta, o + 3);
      });
      sigs.push(await send(new TransactionInstruction({ programId: PROGRAM_ID, data: d, keys: writeKeys() })));
    }
    return sigs;
  }

  // One good's batch auction. bids desc, asks asc — the program verifies it.
  async function clear(good, bids, asks) {
    const enc = arr => {
      const b = Buffer.alloc(4 + arr.length * 10);
      b.writeUInt32LE(arr.length, 0);
      arr.forEach((o, k) => {
        const off = 4 + k * 10;
        b.writeUInt16LE(o.agent, off); b.writeUInt32LE(o.qty, off + 2); b.writeUInt32LE(o.limit, off + 6);
      });
      return b;
    };
    const data = Buffer.concat([DISC.clear_auction, Buffer.from([good]), enc(bids), enc(asks)]);
    return send(new TransactionInstruction({ programId: PROGRAM_ID, data, keys: writeKeys() }));
  }

  // ---- the bank ---------------------------------------------------------------
  async function borrow(agent, amount, collateral) {
    const d = Buffer.alloc(8 + 2 + 8 + 4 * N_GOODS);
    DISC.borrow.copy(d, 0);
    d.writeUInt16LE(agent, 8); d.writeBigUInt64LE(BigInt(amount), 10);
    collateral.forEach((q, g) => d.writeUInt32LE(q, 18 + g * 4));
    return send(new TransactionInstruction({ programId: PROGRAM_ID, data: d, keys: writeKeys() }));
  }
  async function repay(agent, amount) {
    const d = Buffer.alloc(8 + 2 + 8);
    DISC.repay.copy(d, 0);
    d.writeUInt16LE(agent, 8); d.writeBigUInt64LE(BigInt(amount), 10);
    return send(new TransactionInstruction({ programId: PROGRAM_ID, data: d, keys: writeKeys() }));
  }
  // Signed and paid for by the keeper alone — the authority is not on these transactions.
  const anyone = (name, arg) => {
    const d = Buffer.alloc(8 + (arg === undefined ? 0 : 2));
    DISC[name].copy(d, 0);
    if (arg !== undefined) d.writeUInt16LE(arg, 8);
    return send(new TransactionInstruction({ programId: PROGRAM_ID, data: d, keys: [
      { pubkey: ledger.publicKey, isSigner: false, isWritable: true },
      { pubkey: keeper.publicKey, isSigner: true, isWritable: false },
    ] }), [], [keeper]);
  };
  // Foreclose: allowed once overdue or under margin (see liquidatable()).
  const liquidate = agent => anyone('liquidate', agent);
  // Pay the bank's equity above its capital requirement to every agent equally. A no-op without a surplus.
  const payDividend = () => anyone('pay_dividend');

  // Read the whole ledger back. Zero-copy layout, decoded by hand (offsets: Ledger in lib.rs, +8).
  async function fetch() {
    const acct = await conn.getAccountInfo(ledger.publicKey, 'confirmed');
    const b = acct.data;
    const u64 = o => Number(b.readBigUInt64LE(8 + o));
    const u32 = o => b.readUInt32LE(8 + o);
    const u16 = o => b.readUInt16LE(8 + o);
    const G = [...Array(N_GOODS).keys()];
    const slot = o => ({
      cash: u64(o),
      goods: G.map(g => u32(o + 8 + g * 4)),
      locked: G.map(g => u32(o + 24 + g * 4)),
      debt: u64(o + 40), principal: u64(o + 48), dueSlot: u64(o + 56),
    });
    const n = u32(32);
    const books = {
      startMoney: u64(88), bankSeed: u64(96), minted: u64(104), principalRepaid: u64(112),
      interestIncome: u64(120), penalties: u64(128), recovered: u64(136), writtenOff: u64(144),
      badDebt: u64(152), dividendsPaid: u64(160),
    };
    const terms = { equityFloor: u64(168), termSlots: u64(176), ltvBps: u16(184), rateBps: u16(186),
                    penaltyBps: u16(188), kappaBps: u16(190), marginBps: u16(192) };
    const bank = slot(200);
    const debtTotal = u64(80);
    const out = {
      numAgents: n, round: u32(36),
      lastPrice: G.map(g => u64(40 + g * 8)),
      supply: u64(72), debtTotal, badDebt: books.badDebt,
      books, terms, bank,
      equity: bank.cash,
      lendingCap: Math.floor(bank.cash * 10_000 / terms.kappaBps),            // max debtTotal
      capitalRequired: Math.floor(debtTotal * terms.kappaBps / 10_000) + terms.equityFloor,
      slots: [],
    };
    for (let i = 0; i < n; i++) out.slots.push(slot(HEADER + i * SLOT - 8));
    return out;
  }

  return {
    conn, authority, ledger, keeper, initialize, settle, clear, fetch, borrow, repay, liquidate, payDividend,
    slot: () => conn.getSlot('confirmed'),
    MAX_ORDERS_PER_TX, LEDGER_SIZE, txCount: () => txCount,
  };
}

// Value of a slot's pledged goods at the given prices (cents).
export const lockedValue = (s, prices) => s.locked.reduce((v, q, g) => v + q * prices[g], 0);

// Why `liquidate` would succeed on this slot right now — 'overdue', 'margin' or null.
// Same rule as the program: overdue once the chain slot passes dueSlot; a margin call
// once debt × 10000 > locked value at the last prices × marginBps.
export function liquidatable(s, L, nowSlot) {
  if (!s.debt) return null;
  if (nowSlot > s.dueSlot) return 'overdue';
  if (s.debt * 10_000 > lockedValue(s, L.lastPrice) * L.terms.marginBps) return 'margin';
  return null;
}
