// Does the SETTLERS mint really track the village's money?
//
// Walks a tiny village through every instruction that can create or destroy a coin —
// opening purses, a loan, a repayment, a foreclosure, a fire sale, a dividend — and
// after each one checks the SPL mint's own supply against the ledger's books.
//
// Runs against its own validator, never the one the dashboard uses:
//   backend/scripts/check-settlers.sh
import {
  Connection, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import fs from 'node:fs';
import path from 'node:path';
import { connectChain, N_GOODS, WOOD, FOOD, BANK, PROGRAM_ID } from '../src/chain.mjs';
import { CFG, ROOT } from '../src/config.mjs';

const idl = JSON.parse(fs.readFileSync(path.join(ROOT, 'chain/target/idl/chain.json'), 'utf8'));
const DISC = Object.fromEntries(idl.instructions.map(i => [i.name, Buffer.from(i.discriminator)]));

let failures = 0, checks = 0;
const ok = (name, cond, detail = '') => {
  checks++;
  if (cond) return console.log(`  ok   ${name}${detail && `  ${detail}`}`);
  failures++;
  console.log(`  FAIL ${name}${detail && `  ${detail}`}`);
};
const eq = (name, got, want) => ok(name, got === want, `got ${got}, want ${want}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const AGENTS = 3, START_CASH = 3000, START_FOOD = 6, START_WOOD = 4;
const TERM_UNIT_SLOTS = 25;
const TERMS = {
  ltvBps: 6000, rateBps: 500, ratePeriodSlots: 150, penaltyBps: 1000,
  kappaBps: 1000, marginBps: 8000, termUnitSlots: TERM_UNIT_SLOTS, maxTermUnits: 3, equityFloor: 0,
};
const BANK_SEED = 900;

const C = await connectChain();

// The one thing every step must leave true.
async function invariant(after) {
  const [L, spl] = [await C.fetch(), await C.settlersSupply()];
  const books = L.books.startMoney + L.books.bankSeed + L.books.minted
              - L.books.principalRepaid - L.books.writtenOff;
  ok(`supply matches after ${after}`, spl === L.supply + L.bank.cash && spl === books,
     `mint ${spl}, agents+bank ${L.supply + L.bank.cash}, books ${books}`);
  return L;
}

console.log('\nSETTLERS\n');

// ---- 1. the mint itself ------------------------------------------------------------
await C.initialize(AGENTS, START_CASH, START_FOOD, START_WOOD, CFG.START_PRICES, BANK_SEED, TERMS);
const mintAcct = await C.conn.getAccountInfo(C.mint, 'confirmed');
eq('mint account size', mintAcct.data.length, 82);
eq('decimals', mintAcct.data.readUInt8(44), 2);
ok('mint authority is the mint PDA itself',
   mintAcct.data.readUInt32LE(0) === 1 && new PublicKey(mintAcct.data.subarray(4, 36)).equals(C.mint));
ok('freeze authority is the mint PDA itself',
   mintAcct.data.readUInt32LE(46) === 1 && new PublicKey(mintAcct.data.subarray(50, 82)).equals(C.mint));
const vaultAcct = await C.conn.getAccountInfo(C.vault, 'confirmed');
ok('vault holds this mint', new PublicKey(vaultAcct.data.subarray(0, 32)).equals(C.mint));
ok('vault is owned by the mint PDA', new PublicKey(vaultAcct.data.subarray(32, 64)).equals(C.mint));
eq('opening supply', await C.settlersSupply(), AGENTS * START_CASH + BANK_SEED);
eq('every coin is in the vault', Number(vaultAcct.data.readBigUInt64LE(64)), AGENTS * START_CASH + BANK_SEED);

// ---- 2. settle moves goods, never money --------------------------------------------
let before = await C.settlersSupply();
await C.settle([
  { agent: 0, good: WOOD, delta: 30 },
  { agent: 1, good: FOOD, delta: 20 },
  { agent: 2, good: WOOD, delta: 10 },
]);
eq('settle mints nothing', await C.settlersSupply(), before);

// ---- 3. lending is the only way a coin is born -------------------------------------
const pledge = (good, qty) => { const c = Array(N_GOODS).fill(0); c[good] = qty; return c; };
await C.borrow(0, 3000, TERM_UNIT_SLOTS * 3, pledge(WOOD, 24));
eq('borrowing mints exactly what it lends', await C.settlersSupply(), before + 3000);
await invariant('borrow');

await C.repay(0, 1000);
let L = await invariant('repay');
ok('repaying burns principal, not interest',
   L.books.principalRepaid > 0 && L.books.interestIncome > 0
   && await C.settlersSupply() === before + 3000 - L.books.principalRepaid,
   `principal burned ${L.books.principalRepaid}, interest kept ${L.books.interestIncome}`);

// a second loan, short term, by an agent who will be able to pay it
await C.borrow(2, 500, TERM_UNIT_SLOTS, pledge(WOOD, 10));
await invariant('second borrow');

// ---- 4. an ordinary auction moves coins between purses, and mints none --------------
// agent 0 spends nearly everything on agent 1's food, so its loan cannot be collected.
before = await C.settlersSupply();
await C.clear(FOOD, [{ agent: 0, qty: 12, limit: 450 }], [{ agent: 1, qty: 12, limit: 350 }]);
eq('an ordinary auction mints and burns nothing', await C.settlersSupply(), before);
L = await invariant('auction');
ok('the borrower is now short of cash', L.slots[0].cash < L.slots[0].debt,
   `cash ${L.slots[0].cash}, debt ${L.slots[0].debt}`);

// ---- 5. an overdue loan whose debtor can pay: collected, not foreclosed -------------
L = await C.fetch();
while ((await C.slot()) <= L.slots[2].dueSlot) await sleep(400);
const beforeCollect = await C.settlersSupply();
await C.liquidate(2);
L = await invariant('collection');
ok('the collected loan closed and released its collateral',
   L.slots[2].debt === 0 && L.slots[2].locked[WOOD] === 0);
ok('collecting burned the principal', await C.settlersSupply() < beforeCollect);

// ---- 6. a margin call, and a loss bigger than the bank can absorb -------------------
// wood crashes, so the pledged wood no longer covers the loan.
await C.clear(WOOD, [{ agent: 1, qty: 1, limit: 10 }], [{ agent: 2, qty: 1, limit: 1 }]);
L = await C.fetch();
ok('wood collapsed', L.lastPrice[WOOD] < 50, `last price ${L.lastPrice[WOOD]}`);
await C.liquidate(0);
L = await invariant('foreclosure');
ok('the bank seized the collateral', L.bank.goods[WOOD] > 0, `wood ${L.bank.goods[WOOD]}`);
ok('the loss outran the bank: bad debt', L.badDebt > 0, `bad debt ${L.badDebt}`);

// ---- 7. the fire sale: the one auction that can destroy coins ----------------------
const bankWood = L.bank.goods[WOOD];
const asks = [{ agent: BANK, qty: bankWood, limit: 1 }];
const bids = [{ agent: 2, qty: bankWood, limit: 100 }];   // clears at 50: more than the bad debt, less than agent 2's purse

// left off, the mint accounts must be demanded, never silently skipped
const enc = arr => {
  const b = Buffer.alloc(4 + arr.length * 10);
  b.writeUInt32LE(arr.length, 0);
  arr.forEach((o, k) => {
    const off = 4 + k * 10;
    b.writeUInt16LE(o.agent, off); b.writeUInt32LE(o.qty, off + 2); b.writeUInt32LE(o.limit, off + 6);
  });
  return b;
};
let refused = null;
try {
  await sendAndConfirmTransaction(C.conn, new Transaction().add(new TransactionInstruction({
    programId: PROGRAM_ID,
    data: Buffer.concat([DISC.clear_auction, Buffer.from([WOOD]), enc(bids), enc(asks)]),
    keys: [
      { pubkey: C.ledger.publicKey, isSigner: false, isWritable: true },
      { pubkey: C.authority.publicKey, isSigner: true, isWritable: false },
      ...Array.from({ length: 3 }, () => ({ pubkey: PROGRAM_ID, isSigner: false, isWritable: false })),
    ],
  })), [C.authority], { commitment: 'confirmed' });
} catch (e) { refused = [...(e.transactionLogs ?? e.logs ?? []), e.message].join('\n'); }
ok('a bank sale without the mint accounts is refused', /MintAccountsRequired/.test(refused ?? ''));

const beforeSale = await C.settlersSupply();
const badDebtBefore = L.badDebt;
await C.clear(WOOD, bids, asks);
L = await invariant('fire sale');
ok('the bank sold its seized wood', L.bank.goods[WOOD] < bankWood);
eq('the sale burned exactly the bad debt it paid down',
   beforeSale - await C.settlersSupply(), badDebtBefore - L.badDebt);

// ---- 8. a dividend moves coins, never creates them ---------------------------------
before = await C.settlersSupply();
await C.payDividend();
eq('a dividend mints nothing', await C.settlersSupply(), before);
await invariant('dividend');

console.log(`\n${failures ? 'FAILED' : 'passed'}: ${checks - failures}/${checks} checks`);
console.log(`mint  ${C.mint.toBase58()}`);
process.exit(failures ? 1 : 0);
