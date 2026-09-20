// Put a village on devnet, where anyone can look it up.
//
// The live simulation can't run here — devnet's public RPC allows roughly 10 requests a
// second and a round needs more than that — so this walks one village through the whole
// monetary story by hand, slowly, and leaves it on a public chain forever: coins minted
// by a loan, burned by a repayment, a foreclosure anyone could have called, a fire sale,
// a dividend. Every transaction is a link you can hand someone.
//
//   backend/scripts/deploy-devnet.sh
import { connectChain, explorer, N_GOODS, WOOD, FOOD, BANK, PROGRAM_ID } from '../src/chain.mjs';
import { CFG } from '../src/config.mjs';

const AGENTS = 8, START_CASH = 3000, START_FOOD = 6, START_WOOD = 4;
const TERM_UNIT_SLOTS = 40;
const TERMS = {
  ltvBps: 6000, rateBps: 500, ratePeriodSlots: 150, penaltyBps: 1000,
  kappaBps: 1000, marginBps: 8000, termUnitSlots: TERM_UNIT_SLOTS, maxTermUnits: 3, equityFloor: 0,
};
const BANK_SEED = Math.round(AGENTS * START_CASH * 0.10);

// devnet's public RPC is rate limited: go slowly and deliberately
const sleep = ms => new Promise(r => setTimeout(r, ms));
const step = async (what, fn) => {
  process.stdout.write(`  ${what.padEnd(42)}`);
  const r = await fn();
  const supply = await C.settlersSupply();
  const L = await C.fetch();
  const okay = supply === L.supply + L.bank.cash;
  console.log(`SETTLERS ${(supply / 100).toFixed(2).padStart(10)}  ${okay ? 'books agree' : 'MISMATCH'}`);
  if (!okay) throw new Error('the mint no longer matches the books');
  await sleep(1200);
  return r;
};

const C = await connectChain();
const pledge = (good, qty) => { const c = Array(N_GOODS).fill(0); c[good] = qty; return c; };

console.log(`\nprogram  ${PROGRAM_ID.toBase58()}`);
console.log(`rpc      ${CFG.RPC}\n`);

await step('opening the village', () =>
  C.initialize(AGENTS, START_CASH, START_FOOD, START_WOOD, CFG.START_PRICES, BANK_SEED, TERMS));

console.log(`\nledger   ${C.ledger.publicKey.toBase58()}`);
console.log(`SETTLERS ${C.mint.toBase58()}`);
console.log(`vault    ${C.vault.toBase58()}\n`);

await step('a week of gathering', () => C.settle([
  { agent: 0, good: WOOD, delta: 30 }, { agent: 1, good: FOOD, delta: 24 },
  { agent: 2, good: WOOD, delta: 12 }, { agent: 3, good: FOOD, delta: 10 },
]));
await step('agent 0 borrows against 24 wood', () => C.borrow(0, 3000, TERM_UNIT_SLOTS * 3, pledge(WOOD, 24)));
await step('agent 2 borrows against 10 wood', () => C.borrow(2, 500, TERM_UNIT_SLOTS, pledge(WOOD, 10)));
await step('agent 0 repays 10 coins', () => C.repay(0, 1000));
await step('the food market clears', () =>
  C.clear(FOOD, [{ agent: 0, qty: 12, limit: 450 }], [{ agent: 1, qty: 12, limit: 350 }]));

process.stdout.write('  waiting for agent 2\'s loan to come due   ');
let L = await C.fetch();
while ((await C.slot()) <= L.slots[2].dueSlot) { await sleep(2000); process.stdout.write('.'); }
console.log();
await step('the bank collects the due loan', () => C.collect(2));

await step('wood collapses', () =>
  C.clear(WOOD, [{ agent: 1, qty: 1, limit: 10 }], [{ agent: 2, qty: 1, limit: 1 }]));
await step('the bank forecloses agent 0', () => C.collect(0));

L = await C.fetch();
const seized = L.bank.goods[WOOD];
if (seized > 0) {
  await step('the bank fire-sells the collateral', () =>
    C.clear(WOOD, [{ agent: 3, qty: seized, limit: 100 }], [{ agent: BANK, qty: seized, limit: 1 }]));
}
await step('the surplus is paid out', () => C.payDividend());

L = await C.fetch();
const supply = await C.settlersSupply();
console.log(`\n${AGENTS} villagers, ${(supply / 100).toFixed(2)} SETTLERS in existence`);
console.log(`bad debt ${(L.badDebt / 100).toFixed(2)}, written off ${(L.books.writtenOff / 100).toFixed(2)}, minted by loans ${(L.books.minted / 100).toFixed(2)}\n`);
console.log('look it up:');
console.log(`  SETTLERS  ${explorer('address', C.mint.toBase58())}`);
console.log(`  vault     ${explorer('address', C.vault.toBase58())}`);
console.log(`  ledger    ${explorer('address', C.ledger.publicKey.toBase58())}`);
console.log(`  program   ${explorer('address', PROGRAM_ID.toBase58())}`);
console.log(`\n${C.txCount()} transactions\n`);
