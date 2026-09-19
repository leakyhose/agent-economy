import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
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
/** `authority` + `last_price` + `num_agents` + `round` + `num_goods` + `sealed` + pad. */
export const HEADER_BYTES = 32 + 8 * MAX_GOODS + 4 + 4 + 1 + 1 + 6;
/** Discriminator + header + slots = 12,920 bytes. */
export const LEDGER_BYTES = 8 + HEADER_BYTES + MAX_AGENTS * SLOT_BYTES;

/** Byte offsets into the account data, discriminator included. */
export const OFF = {
  authority: 8,
  lastPrice: 8 + 32,
  numAgents: 8 + 32 + 8 * MAX_GOODS,
  round: 8 + 32 + 8 * MAX_GOODS + 4,
  numGoods: 8 + 32 + 8 * MAX_GOODS + 8,
  sealed: 8 + 32 + 8 * MAX_GOODS + 9,
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
    lastPrice: Array.from({ length: numGoods }, (_, g) =>
      data.readBigUInt64LE(OFF.lastPrice + g * 8),
    ),
    slots,
    moneySupply,
  };
}
