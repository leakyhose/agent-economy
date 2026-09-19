import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from '@solana/web3.js';
import type { Delta, Order } from './auction.ts';
import type { Endowment } from './goods.ts';
import { MAX_AGENTS, MAX_GOODS } from './goods.ts';

/**
 * The on-chain byte layout, mirrored by hand.
 *
 * Anchor's JavaScript instruction coder caps instruction data at roughly 1,000 bytes,
 * which a full order book overflows, so every instruction here is encoded by hand
 * against the IDL's discriminators. That means this file and
 * `programs/world/src/lib.rs` have to agree byte for byte; the Rust test
 * `layout_is_what_the_client_decodes` pins the account side of the bargain.
 */

/** `cash: u64` + `goods: [u32; 8]`. */
export const SLOT_BYTES = 8 + 4 * MAX_GOODS;
/**
 * `authority` + `last_price` + `distress_threshold` + `num_agents` + `round`
 * + `relief_pool` + `num_goods` + `sealed` + 4 bytes of tail padding.
 */
export const HEADER_BYTES = 32 + 8 * MAX_GOODS + 8 + 4 + 4 + 2 + 1 + 1 + 4;
/** Discriminator + header + slots = 12,928 bytes. */
export const LEDGER_BYTES = 8 + HEADER_BYTES + MAX_AGENTS * SLOT_BYTES;

/** Byte offsets into the account data, discriminator included. */
const H = 8 + 32 + 8 * MAX_GOODS; // past the discriminator, authority and prices
export const OFF = {
  authority: 8,
  lastPrice: 8 + 32,
  distressThreshold: H,
  numAgents: H + 8,
  round: H + 12,
  reliefPool: H + 16,
  numGoods: H + 18,
  sealed: H + 19,
  slots: 8 + HEADER_BYTES,
} as const;

/** 10 bytes per order; 7 per delta; 11 per endowment. */
export const ORDER_BYTES = 10;
export const DELTA_BYTES = 7;
export const ENDOWMENT_BYTES = 11;

/**
 * Orders per `clear_auction` transaction, **counting both books together**.
 *
 * A legacy transaction is 1,232 bytes all in: signatures, the message header, account
 * keys, the blockhash, then instruction data. 96 orders is 960 bytes of book, plus the
 * discriminator, the good byte and two length prefixes — 973 — which leaves room for
 * the envelope and nothing to spare. The prototype settled on this number the hard
 * way. Beyond it, batch; `WorldLedger.clearAuction` does, and says so.
 */
export const MAX_ORDERS_PER_TX = 96;
/** Per book, when both are sent in one instruction. */
export const MAX_ORDERS_PER_BOOK = MAX_ORDERS_PER_TX / 2;
/** Refuse to build an instruction that cannot fit a legacy transaction. */
export const MAX_IX_DATA_BYTES = 1_000;
export const MAX_DELTAS_PER_TX = 120;
export const MAX_ENDOWMENTS_PER_TX = 80;
/** `transfer` instructions packed into one transaction. */
export const MAX_TRANSFERS_PER_TX = 24;

/**
 * Anchor's global instruction discriminator: the first eight bytes of
 * `sha256("global:<snake_case_name>")`. Computed rather than read from a file so the
 * client works without the build artifacts present; `loadIdl` cross-checks it when
 * they are.
 */
export function discriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

export const DISC = {
  initialize: discriminator('initialize'),
  liquidate: discriminator('liquidate'),
  endow: discriminator('endow'),
  seal: discriminator('seal'),
  settle: discriminator('settle'),
  transfer: discriminator('transfer'),
  clear_auction: discriminator('clear_auction'),
} as const;

interface Idl {
  address: string;
  instructions: { name: string; discriminator: number[] }[];
}

/**
 * Read `target/idl/world.json`, if it is there, for the deployed program address —
 * and verify the discriminators we computed against the ones Anchor emitted, so a
 * rename in the Rust cannot silently desynchronise this file.
 */
export function loadIdl(path: string): { programId: PublicKey } {
  const idl = JSON.parse(readFileSync(path, 'utf8')) as Idl;
  for (const ix of idl.instructions) {
    const ours = DISC[ix.name as keyof typeof DISC];
    if (!ours) continue;
    if (!ours.equals(Buffer.from(ix.discriminator))) {
      throw new Error(`discriminator mismatch for "${ix.name}": client and IDL disagree`);
    }
  }
  return { programId: new PublicKey(idl.address) };
}

/** An agent's row of the ledger, decoded. */
export interface LedgerSlot {
  cash: bigint;
  goods: number[];
}

/** The whole ledger, decoded from raw account data. */
export interface LedgerState {
  authority: PublicKey;
  numAgents: number;
  numGoods: number;
  round: number;
  sealed: boolean;
  /** Cash below which anyone may liquidate an agent. */
  distressThreshold: bigint;
  /** The slot that buys liquidated goods. */
  reliefPool: number;
  lastPrice: bigint[];
  slots: LedgerSlot[];
  /** Sum of every live agent's cash. The world's money supply. */
  moneySupply: bigint;
}

/** Decode a zero-copy `Ledger` account. The layout is fixed, so this is arithmetic. */
export function decodeLedger(data: Buffer): LedgerState {
  if (data.length < LEDGER_BYTES) {
    throw new Error(`ledger account is ${data.length} bytes; expected ${LEDGER_BYTES}`);
  }
  const numAgents = data.readUInt32LE(OFF.numAgents);
  const numGoods = data.readUInt8(OFF.numGoods);
  const slots: LedgerSlot[] = [];
  let moneySupply = 0n;
  for (let i = 0; i < numAgents; i++) {
    const o = OFF.slots + i * SLOT_BYTES;
    const cash = data.readBigUInt64LE(o);
    moneySupply += cash;
    slots.push({
      cash,
      goods: Array.from({ length: numGoods }, (_, g) => data.readUInt32LE(o + 8 + g * 4)),
    });
  }
  return {
    authority: new PublicKey(data.subarray(OFF.authority, OFF.authority + 32)),
    numAgents,
    numGoods,
    round: data.readUInt32LE(OFF.round),
    sealed: data.readUInt8(OFF.sealed) === 1,
    distressThreshold: data.readBigUInt64LE(OFF.distressThreshold),
    reliefPool: data.readUInt16LE(OFF.reliefPool),
    lastPrice: Array.from({ length: numGoods }, (_, g) =>
      data.readBigUInt64LE(OFF.lastPrice + g * 8),
    ),
    slots,
    moneySupply,
  };
}

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

/**
 * `initialize(num_agents, num_goods, start_cash, start_goods, distress_threshold,
 * relief_pool)`.
 */
export function initializeIx(
  programId: PublicKey,
  accounts: LedgerAccounts,
  args: {
    numAgents: number;
    numGoods: number;
    startCash: number | bigint;
    startGoods: number[];
    distressThreshold: number | bigint;
    reliefPool: number;
  },
): TransactionInstruction {
  const data = Buffer.alloc(8 + 4 + 1 + 8 + 4 * MAX_GOODS + 8 + 2);
  DISC.initialize.copy(data, 0);
  data.writeUInt32LE(args.numAgents, 8);
  data.writeUInt8(args.numGoods, 12);
  data.writeBigUInt64LE(BigInt(args.startCash), 13);
  for (let g = 0; g < MAX_GOODS; g++) {
    // Fixed-size array: no length prefix. `start_goods[0]` is ignored by the program.
    data.writeUInt32LE(args.startGoods[g] ?? 0, 21 + g * 4);
  }
  data.writeBigUInt64LE(BigInt(args.distressThreshold), 21 + 4 * MAX_GOODS);
  data.writeUInt16LE(args.reliefPool, 29 + 4 * MAX_GOODS);
  return new TransactionInstruction({
    programId,
    data,
    keys: [
      { pubkey: accounts.authority, isSigner: true, isWritable: true },
      { pubkey: accounts.ledger, isSigner: false, isWritable: true },
    ],
  });
}

/**
 * `liquidate(agent: u16, good: u8)` — the permissionless one.
 *
 * `caller` is any signer at all. It is in the account list because a transaction
 * needs a fee payer, not because the program checks it: there is no authority here
 * and deliberately so. Anyone who can see a distressed agent can act on it.
 */
export function liquidateIx(
  programId: PublicKey,
  args: { ledger: PublicKey; caller: PublicKey; agent: number; good: number },
): TransactionInstruction {
  const data = Buffer.alloc(8 + 2 + 1);
  DISC.liquidate.copy(data, 0);
  data.writeUInt16LE(args.agent, 8);
  data.writeUInt8(args.good, 10);
  return new TransactionInstruction({
    programId,
    data,
    keys: [
      { pubkey: args.ledger, isSigner: false, isWritable: true },
      { pubkey: args.caller, isSigner: true, isWritable: false },
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
