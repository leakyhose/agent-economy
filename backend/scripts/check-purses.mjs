// Do agents really hold their own SETTLERS, and really pay each other in them?
//
// Every coin in the village sits in some agent's purse or the bank's vault, and an
// auction settles as transfers between the villagers who traded — not as a number we
// edited. This walks a village through that and checks the chain after every step.
//
// Runs against its own validator, never the one the dashboard uses:
//   backend/scripts/check-purses.sh
import { PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import fs from 'node:fs';
import path from 'node:path';
import { connectChain, N_GOODS, WOOD, FOOD, PROGRAM_ID, TOKEN_PROGRAM_ID } from '../src/chain.mjs';
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

const AGENTS = 6, START_CASH = 3000, START_FOOD = 6, START_WOOD = 4;
const TERM_UNIT_SLOTS = 25;
const TERMS = {
  ltvBps: 6000, rateBps: 500, ratePeriodSlots: 150, penaltyBps: 1000,
  kappaBps: 1000, marginBps: 8000, termUnitSlots: TERM_UNIT_SLOTS, maxTermUnits: 3, equityFloor: 0,
};
const BANK_SEED = 1800;
// The suite's own opening prices, for the same reason check-settlers.mjs pins its own:
// the collateral and order sizes below are calibrated against these.
const PRICES = [100, 100, 3000, 1500, 12000];  // food, wood, nets, labour, houses
const ALL = Array.from({ length: AGENTS }, (_, i) => i);

const C = await connectChain();
const pledge = (good, qty) => { const c = Array(N_GOODS).fill(0); c[good] = qty; return c; };
const vaultBalance = async () =>
  Number((await C.conn.getAccountInfo(C.vault, 'confirmed')).data.readBigUInt64LE(64));
const name = key => {
  const i = ALL.find(a => C.purseOf(a).toBase58() === key);
  return i === undefined ? (key === C.vault.toBase58() ? 'the bank' : '?') : `agent ${i}`;
};

// Every purse holds exactly what the ledger says that agent has, and no coin is lost:
// the purses plus the bank's vault are the entire supply.
async function purseInvariant(after) {
  const L = await C.fetch();
  const held = [];
  for (const i of ALL) held.push(await C.purseBalance(i));
  const off = ALL.filter(i => held[i] !== L.slots[i].cash);
  ok(`every purse matches the books after ${after}`, off.length === 0,
     off.map(i => `agent ${i}: purse ${held[i]} vs cash ${L.slots[i].cash}`).join(', '));
  const [vault, supply] = [await vaultBalance(), await C.settlersSupply()];
  const total = held.reduce((a, b) => a + b, 0) + vault;
  ok(`purses + the bank are the whole supply after ${after}`, total === supply,
     `${total} held, ${supply} exists`);
  return { L, held, vault };
}

// The SPL transfers a transaction actually made, as [source, destination, amount].
async function transfersIn(sig) {
  const tx = await C.conn.getParsedTransaction(sig,
    { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  return (tx?.meta?.innerInstructions ?? []).flatMap(g => g.instructions)
    .filter(i => i.parsed?.type === 'transfer')
    .map(i => [i.parsed.info.source, i.parsed.info.destination, Number(i.parsed.info.amount)]);
}

console.log('\nPURSES\n');

// ---- 1. every agent gets a purse of their own --------------------------------------
await C.initialize(AGENTS, START_CASH, START_FOOD, START_WOOD, PRICES, BANK_SEED, TERMS);
eq('before purses, every coin is in the vault', await vaultBalance(), AGENTS * START_CASH + BANK_SEED);
await C.initPurses(AGENTS);
for (const i of [0, AGENTS - 1]) {
  const acct = await C.conn.getAccountInfo(C.purseOf(i), 'confirmed');
  ok(`agent ${i} has a purse`, !!acct);
  eq(`agent ${i} purse is a token account`, acct.data.length, 165);
  ok(`agent ${i} purse holds SETTLERS`, new PublicKey(acct.data.subarray(0, 32)).equals(C.mint));
  ok(`agent ${i} purse owns itself — no key can spend it`,
     new PublicKey(acct.data.subarray(32, 64)).equals(C.purseOf(i)));
}
ok('every agent has a different address', new Set(ALL.map(i => C.purseOf(i).toBase58())).size === AGENTS);
await C.initPurses(AGENTS);
ok('running init_purses again changes nothing', await vaultBalance() === AGENTS * START_CASH + BANK_SEED);

// ---- 2. the opening purses are paid out of the vault --------------------------------
await C.settleCash(ALL);
const opening = await purseInvariant('the opening pass');
eq('each agent holds their starting cash', await C.purseBalance(0), START_CASH);
eq('the vault is left holding exactly the bank', opening.vault, BANK_SEED);

// ---- 3. an auction pays one villager with another villager's coins -------------------
await C.settle([{ agent: 1, good: FOOD, delta: 20 }, { agent: 0, good: WOOD, delta: 30 },
                { agent: 2, good: WOOD, delta: 60 }]);
await C.clear(FOOD, [{ agent: 0, qty: 4, limit: 300 }], [{ agent: 1, qty: 4, limit: 200 }]);
const traded = await C.fetch();
ok('the ledger moved cash from the buyer to the seller',
   traded.slots[0].cash < START_CASH && traded.slots[1].cash > START_CASH,
   `agent 0 ${traded.slots[0].cash}, agent 1 ${traded.slots[1].cash}`);
const [sig] = await C.settleCash([0, 1]);
const moves = await transfersIn(sig);
ok('the coins went straight from the buyer\'s purse to the seller\'s',
   moves.some(([s, d]) => s === C.purseOf(0).toBase58() && d === C.purseOf(1).toBase58()),
   moves.map(([s, d, a]) => `${name(s)} -> ${name(d)} ${a}`).join(', '));
ok('a trade between two agents does not touch the bank',
   !moves.some(([s, d]) => s === C.vault.toBase58() || d === C.vault.toBase58()));
await purseInvariant('an auction');

// ---- 4. a loan puts new coins in the borrower's own purse ----------------------------
const beforeLoan = await C.purseBalance(2);
await C.borrow(2, 2000, TERM_UNIT_SLOTS * 3, pledge(WOOD, 60));
await C.settleCash([2]);
eq('the borrower holds the coins the loan minted', await C.purseBalance(2), beforeLoan + 2000);
await purseInvariant('a loan');

// ---- 5. repaying destroys coins out of that purse ------------------------------------
await C.repay(2, 800);
await C.settleCash([2]);
ok('repaying takes coins back out of the purse', await C.purseBalance(2) < beforeLoan + 2000,
   `purse now ${await C.purseBalance(2)}`);
await purseInvariant('a repayment');

// ---- 6. a dividend reaches every purse ----------------------------------------------
const beforeDividend = await C.purseBalance(3);
await C.fundKeeper();
await C.payDividend();
await C.settleCash(ALL);
ok('the dividend reached the agents', await C.purseBalance(3) >= beforeDividend);
await purseInvariant('a dividend');

// ---- 7. the program does not take the caller's word for a purse ----------------------
// Name agent 0, but hand over agent 1's purse. The address is derived on-chain from the
// bump, so it cannot match what was passed.
function settleCashIx(agents, accounts) {
  const d = Buffer.alloc(8 + 4 + agents.length * 2 + 4 + agents.length);
  DISC.settle_cash.copy(d, 0);
  d.writeUInt32LE(agents.length, 8);
  agents.forEach((a, k) => d.writeUInt16LE(a, 12 + k * 2));
  const at = 12 + agents.length * 2;
  d.writeUInt32LE(agents.length, at);
  agents.forEach((_, k) => d.writeUInt8(255, at + 4 + k));   // a bump that derives nothing
  return new TransactionInstruction({
    programId: PROGRAM_ID, data: d,
    keys: [
      { pubkey: C.ledger.publicKey, isSigner: false, isWritable: true },
      { pubkey: C.authority.publicKey, isSigner: true, isWritable: false },
      { pubkey: C.mint, isSigner: false, isWritable: false },
      { pubkey: C.vault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ...accounts.map(pubkey => ({ pubkey, isSigner: false, isWritable: true })),
    ],
  });
}
let refused = false;
try {
  await sendAndConfirmTransaction(C.conn,
    new Transaction().add(settleCashIx([0], [C.purseOf(1)])), [C.authority], { commitment: 'confirmed' });
} catch { refused = true; }
ok('a call handing over the wrong purse is refused', refused);
await purseInvariant('a refused call');

console.log(`\n${checks - failures}/${checks} checks passed\n`);
process.exit(failures ? 1 : 0);
