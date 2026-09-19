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

const MAX_AGENTS = 320;
const SLOT = 24;                       // u64 cash + [u32;3] goods + u32 pad
const LEDGER_SIZE = 8 + 32 + 4 + 4 + 24 + MAX_AGENTS * SLOT;
const MAX_ORDERS_PER_TX = 96;          // ~1220 bytes: the legacy transaction ceiling
const MAX_DELTAS_PER_TX = 120;

export const explorer = (kind, id) =>
  `https://explorer.solana.com/${kind}/${id}?cluster=custom&customUrl=${encodeURIComponent(CFG.RPC)}`;

export async function connectChain() {
  const conn = new Connection(CFG.RPC, 'confirmed');
  const authority = Keypair.fromSecretKey(Uint8Array.from(
    JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, 'utf8'))));
  const ledger = Keypair.generate();
  let txCount = 0;

  async function send(ix, extraSigners = []) {
    const tx = new Transaction().add(ix);
    try {
      const sig = await sendAndConfirmTransaction(conn, tx, [authority, ...extraSigners],
        { commitment: 'confirmed' });
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

  async function initialize(n, cash, food) {
    const d = Buffer.alloc(8 + 4 + 8 + 4);
    DISC.initialize.copy(d, 0);
    d.writeUInt32LE(n, 8); d.writeBigUInt64LE(BigInt(cash), 12); d.writeUInt32LE(food, 20);
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

  // Read the whole ledger back. Zero-copy layout, decoded by hand.
  async function fetch() {
    const acct = await conn.getAccountInfo(ledger.publicKey, 'confirmed');
    const b = acct.data;
    const n = b.readUInt32LE(40);
    const out = {
      numAgents: n, round: b.readUInt32LE(44),
      lastPrice: [0, 1, 2].map(g => Number(b.readBigUInt64LE(48 + g * 8))),
      slots: [],
    };
    for (let i = 0; i < n; i++) {
      const o = 72 + i * SLOT;
      out.slots.push({
        cash: Number(b.readBigUInt64LE(o)),
        goods: [b.readUInt32LE(o + 8), b.readUInt32LE(o + 12), b.readUInt32LE(o + 16)],
      });
    }
    return out;
  }

  return {
    conn, authority, ledger, initialize, settle, clear, fetch,
    MAX_ORDERS_PER_TX, LEDGER_SIZE, txCount: () => txCount,
  };
}
