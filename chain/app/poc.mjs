// Proof of concept: the village market clears ON SOLANA.
//   1. create the ledger for 100 agents
//   2. a shift ends — 40 fishermen land a catch  (on chain)
//   3. the market opens — 60 buyers, 40 sellers, ONE clearing price  (on chain)
//   4. read the ledger back and confirm goods and cash actually moved

import anchor from '@anchor-lang/core';
import { Connection, Keypair, PublicKey, SystemProgram,
         Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import fs from 'node:fs';

const { AnchorProvider, Program, Wallet, BN } = anchor;

const idl = JSON.parse(fs.readFileSync('../target/idl/chain.json', 'utf8'));
const payer = Keypair.fromSecretKey(Uint8Array.from(
  JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, 'utf8'))));
const conn = new Connection('http://127.0.0.1:8899', 'confirmed');
const provider = new AnchorProvider(conn, new Wallet(payer), { commitment: 'confirmed' });
const program = new Program(idl, provider);

const N = 100;
const ledger = Keypair.generate();
const cents = c => `${(c / 100).toFixed(2)}`;

// Anchor's JS coder hardcodes a 1000-byte instruction buffer, which a full village
// order book overflows. Encode clear_auction by hand so the only real ceiling is
// the transaction size itself.
const CLEAR_DISC = Buffer.from([134, 224, 172, 82, 51, 143, 234, 32]);
function encodeClear(good, bids, asks) {
  const orders = arr => {
    const b = Buffer.alloc(4 + arr.length * 10);
    b.writeUInt32LE(arr.length, 0);
    arr.forEach((o, i) => { const off = 4 + i * 10;
      b.writeUInt16LE(o.agent, off); b.writeUInt32LE(o.qty, off + 2); b.writeUInt32LE(o.limit, off + 6); });
    return b;
  };
  return Buffer.concat([CLEAR_DISC, Buffer.from([good]), orders(bids), orders(asks)]);
}
async function sendClear(good, bids, asks) {
  const data = encodeClear(good, bids, asks);
  const ix = new TransactionInstruction({
    programId: program.programId, data,
    keys: [{ pubkey: ledger.publicKey, isSigner: false, isWritable: true }],
  });
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: 'confirmed' });
  const raw = tx.serialize().length;
  return { sig, data: data.length, raw };
}
const link = s => `http://localhost:8899  (sig ${s.slice(0, 16)}…)`;

async function cu(sig) {
  const tx = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  return tx?.meta?.computeUnitsConsumed ?? '?';
}

console.log('\n=== agent-economy — the market lives on Solana ===\n');
console.log(`program ${program.programId.toBase58()}`);
console.log(`ledger  ${ledger.publicKey.toBase58()}\n`);

// 1. create the village ledger
let sig = await program.methods.initialize(N, new BN(50_000))
  .accounts({ payer: payer.publicKey, ledger: ledger.publicKey, systemProgram: SystemProgram.programId })
  .signers([ledger]).rpc();
console.log(`initialize(${N})        ${await cu(sig)} CU   ${link(sig)}`);

let L = await program.account.ledger.fetch(ledger.publicKey);
console.log(`  ${L.numAgents} agents, ${cents(L.slots[0].cash)} each, 3 fish each\n`);

// 2. a shift ends: 40 fishermen land a catch
const harvests = Array.from({ length: 40 }, (_, i) => ({ agent: i, good: 0, qty: 900 }));
sig = await program.methods.settleProduction(harvests)
  .accounts({ ledger: ledger.publicKey }).rpc();
console.log(`settle_production(40)   ${await cu(sig)} CU   ${link(sig)}`);

// 3. the market opens. Sorted off-chain; the PROGRAM verifies the ordering.
const bids = Array.from({ length: 60 }, (_, k) => ({ agent: 40 + k, qty: 15, limit: 700 - k * 5 }));
const asks = Array.from({ length: 40 }, (_, k) => ({ agent: k,      qty: 30, limit: 300 + k * 6 }));

const before = await program.account.ledger.fetch(ledger.publicKey);
const res = await sendClear(0, bids, asks);
sig = res.sig;
const clearCU = await cu(sig);
console.log(`clear_auction(100)      ${clearCU} CU   ${link(sig)}`);
console.log(`  instruction data ${res.data} bytes   whole transaction ${res.raw} / 1232 bytes (legacy limit)`);

// 4. read it back
L = await program.account.ledger.fetch(ledger.publicKey);
console.log(`\n  ONE clearing price for the whole village: ${cents(L.lastPrice[0])}\n`);
const row = (label, i) => console.log(
  `  ${label.padEnd(12)} cash ${cents(before.slots[i].cash).padStart(8)} -> ${cents(L.slots[i].cash).padStart(8)}` +
  `   fish ${String(before.slots[i].goods[0]).padStart(5)} -> ${L.slots[i].goods[0]}`);
row('seller #0', 0); row('seller #12', 12); row('buyer #40', 40); row('buyer #85', 85);

const sum = (s, f) => s.slice(0, N).reduce((a, x) => a + f(x), 0);
console.log(`\n  total fish before ${sum(before.slots, x => x.goods[0])}  after ${sum(L.slots, x => x.goods[0])}   <- conserved by the program`);
console.log(`  clear_auction used ${clearCU} of 1,400,000 CU  (${(clearCU / 14000).toFixed(1)}%)`);

// 5. the program refuses a crank that lies about sorting
try {
  await sendClear(0, [bids[1], bids[0]], asks);
  console.log('\n  !! unsorted book was ACCEPTED — that is a bug');
} catch (e) {
  console.log(`\n  unsorted book rejected on chain: ${String(e.message || e).split('\n')[0].slice(0, 80)}`);
}
console.log('\n=== the economy is program state, not a log ===\n');
