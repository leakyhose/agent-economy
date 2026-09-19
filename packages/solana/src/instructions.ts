import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from '@solana/web3.js';
import type { Delta, Order } from './auction.ts';
import type { Endowment } from './goods.ts';
import { MAX_GOODS } from './goods.ts';
import {
  DELTA_BYTES,
  DISC,
  ENDOWMENT_BYTES,
  LEDGER_BYTES,
  MAX_IX_DATA_BYTES,
  ORDER_BYTES,
} from './program.ts';

/**
 * Instruction data, encoded by hand.
 *
 * Anchor's JS coder caps instruction data at about 1,000 bytes and a full order book
 * runs past that, so nothing here goes through it. The encoding is plain Borsh —
 * little-endian scalars, `u32` length prefix before a `Vec`, no prefix on a fixed
 * array — behind the eight-byte discriminator. See `program.ts` for the sizes.
 */

export interface LedgerAccounts {
  ledger: PublicKey;
  authority: PublicKey;
}

function writeKeys({ ledger, authority }: LedgerAccounts): AccountMeta[] {
  return [
    { pubkey: ledger, isSigner: false, isWritable: true },
    { pubkey: authority, isSigner: true, isWritable: false },
  ];
}

/**
 * Allocate the ledger account.
 *
 * `Ledger` is 12,920 bytes, and a program may only grow an account by 10,240 bytes
 * through a CPI — which is what Anchor's `init` does. So the *client* allocates it
 * with the System program and `initialize` adopts it through the `zero` constraint.
 * Pair this instruction with {@link initializeIx} in one transaction, signed by both
 * the payer and the new ledger keypair.
 */
export function createLedgerAccountIx(args: {
  payer: PublicKey;
  ledger: PublicKey;
  programId: PublicKey;
  lamports: number;
}): TransactionInstruction {
  return SystemProgram.createAccount({
    fromPubkey: args.payer,
    newAccountPubkey: args.ledger,
    lamports: args.lamports,
    space: LEDGER_BYTES,
    programId: args.programId,
  });
}

/** `initialize(num_agents: u32, num_goods: u8, start_cash: u64, start_goods: [u32; 8])`. */
export function initializeIx(
  programId: PublicKey,
  accounts: LedgerAccounts,
  args: { numAgents: number; numGoods: number; startCash: number | bigint; startGoods: number[] },
): TransactionInstruction {
  const data = Buffer.alloc(8 + 4 + 1 + 8 + 4 * MAX_GOODS);
  DISC.initialize.copy(data, 0);
  data.writeUInt32LE(args.numAgents, 8);
  data.writeUInt8(args.numGoods, 12);
  data.writeBigUInt64LE(BigInt(args.startCash), 13);
  for (let g = 0; g < MAX_GOODS; g++) {
    // Fixed-size array: no length prefix. `start_goods[0]` is ignored by the program.
    data.writeUInt32LE(args.startGoods[g] ?? 0, 21 + g * 4);
  }
  return new TransactionInstruction({
    programId,
    data,
    keys: [
      { pubkey: accounts.authority, isSigner: true, isWritable: true },
      { pubkey: accounts.ledger, isSigner: false, isWritable: true },
    ],
  });
}

/** `endow(entries: Vec<Endowment>)`. Genesis only. */
export function endowIx(
  programId: PublicKey,
  accounts: LedgerAccounts,
  entries: Endowment[],
): TransactionInstruction {
  const data = Buffer.alloc(8 + 4 + entries.length * ENDOWMENT_BYTES);
  DISC.endow.copy(data, 0);
  data.writeUInt32LE(entries.length, 8);
  entries.forEach((e, k) => {
    const o = 12 + k * ENDOWMENT_BYTES;
    data.writeUInt16LE(e.agent, o);
    data.writeUInt8(e.good, o + 2);
    data.writeBigUInt64LE(BigInt(e.amount), o + 3);
  });
  return new TransactionInstruction({ programId, data, keys: writeKeys(accounts) });
}

/** `seal()`. Closes genesis, permanently. */
export function sealIx(
  programId: PublicKey,
  accounts: LedgerAccounts,
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    data: Buffer.from(DISC.seal),
    keys: writeKeys(accounts),
  });
}

/** `settle(deltas: Vec<Delta>)`. Goods only — good 0 is cash and the program refuses it. */
export function settleIx(
  programId: PublicKey,
  accounts: LedgerAccounts,
  deltas: Delta[],
): TransactionInstruction {
  const data = Buffer.alloc(8 + 4 + deltas.length * DELTA_BYTES);
  DISC.settle.copy(data, 0);
  data.writeUInt32LE(deltas.length, 8);
  deltas.forEach((d, k) => {
    const o = 12 + k * DELTA_BYTES;
    data.writeUInt16LE(d.agent, o);
    data.writeUInt8(d.good, o + 2);
    data.writeInt32LE(d.delta, o + 3);
  });
  return new TransactionInstruction({ programId, data, keys: writeKeys(accounts) });
}

/** `transfer(from: u16, to: u16, amount: u64)`. */
export function transferIx(
  programId: PublicKey,
  accounts: LedgerAccounts,
  args: { from: number; to: number; amount: number | bigint },
): TransactionInstruction {
  const data = Buffer.alloc(8 + 2 + 2 + 8);
  DISC.transfer.copy(data, 0);
  data.writeUInt16LE(args.from, 8);
  data.writeUInt16LE(args.to, 10);
  data.writeBigUInt64LE(BigInt(args.amount), 12);
  return new TransactionInstruction({ programId, data, keys: writeKeys(accounts) });
}

function encodeOrders(orders: Order[]): Buffer {
  const b = Buffer.alloc(4 + orders.length * ORDER_BYTES);
  b.writeUInt32LE(orders.length, 0);
  orders.forEach((o, k) => {
    const off = 4 + k * ORDER_BYTES;
    b.writeUInt16LE(o.agent, off);
    b.writeUInt32LE(o.qty, off + 2);
    b.writeUInt32LE(o.limit, off + 6);
  });
  return b;
}

/**
 * `clear_auction(good: u8, bids: Vec<Order>, asks: Vec<Order>)`.
 *
 * Both books must already be sorted — bids descending, asks ascending. The program
 * verifies that and rejects the transaction otherwise; it does not sort for you.
 */
export function clearAuctionIx(
  programId: PublicKey,
  accounts: LedgerAccounts,
  args: { good: number; bids: Order[]; asks: Order[] },
): TransactionInstruction {
  const data = Buffer.concat([
    Buffer.from(DISC.clear_auction),
    Buffer.from([args.good]),
    encodeOrders(args.bids),
    encodeOrders(args.asks),
  ]);
  if (data.length > MAX_IX_DATA_BYTES) {
    throw new Error(
      `clear_auction instruction is ${data.length} bytes for ` +
        `${args.bids.length} bids and ${args.asks.length} asks; a legacy transaction ` +
        `will not hold it. Split the books (see MAX_ORDERS_PER_TX).`,
    );
  }
  return new TransactionInstruction({ programId, data, keys: writeKeys(accounts) });
}

/** Split a list into chunks of at most `size`, for the per-transaction caps. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
