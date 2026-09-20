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
export const N_GOODS = 5;              // food, wood, nets, boats, houses
export const FOOD = 0, WOOD = 1, NETS = 2, BOATS = 3, HOUSES = 4;
export const MAX_AGENTS = 137;
export const PLEDGEABLE = [false, true, true, false, true];  // food rots and can't be collateral; slot 3 is dead
export const FIRE_SALE_BPS = 8000;     // foreclosure values seized goods at 80% of the last price
export const FORGIVE_BELOW = 100;      // a repay that leaves less than one coin owing closes the loan
export const DIVIDEND_SHARE_BPS = 5000; // pay_dividend pays half the surplus above the capital required
export const BANK = 0xffff;            // order "agent" id for the bank's foreclosure sales
const SLOT = 72;                       // cash u64, goods [u32;5], locked [u32;5], debt, principal u64, due_slot, accrued_slot u32
const HEADER = 8 + 360;                // discriminator + everything before slots (see Ledger in lib.rs)
const LEDGER_SIZE = HEADER + MAX_AGENTS * SLOT;
const MAX_ORDERS_PER_TX = 96;          // ~1220 bytes: the legacy transaction ceiling
// An auction selling the bank's seized goods also carries the mint, its vault and the
// token program: 3 more account keys, ~99 bytes, so fewer orders fit in that one call.
const MAX_ORDERS_BANK_TX = 84;
const MAX_DELTAS_PER_TX = 120;
// One purse per agent in a settle_cash or init_purses call. 20 purses is ~640 bytes of
// account keys and at most 20 transfer CPIs: inside both the 1232-byte legacy
// transaction and the default 200,000 compute units, so neither needs raising.
const MAX_PURSES_PER_TX = 20;

// The SPL Token program, and the SETTLERS mint's decimals. Cash is held in cents and the
// mint has 2 decimals, so one token base unit is one cent: no conversion, anywhere.
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const SETTLERS_DECIMALS = 2;

// On a public cluster the link must name it; a customUrl pointing at 127.0.0.1 resolves
// to the reader's own machine, where nothing is listening.
const CLUSTER = /devnet/.test(CFG.RPC) ? 'devnet'
              : /testnet/.test(CFG.RPC) ? 'testnet'
              : /mainnet|api\.solana\.com/.test(CFG.RPC) ? null
              : `custom&customUrl=${encodeURIComponent(CFG.RPC)}`;
export const explorer = (kind, id) =>
  `https://explorer.solana.com/${kind}/${id}${CLUSTER ? `?cluster=${CLUSTER}` : ''}`;
export const IS_PUBLIC = CLUSTER === 'devnet' || CLUSTER === 'testnet' || CLUSTER === null;

export async function connectChain() {
  const conn = new Connection(CFG.RPC, 'confirmed');
  const authority = Keypair.fromSecretKey(Uint8Array.from(
    JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, 'utf8'))));
  const ledger = Keypair.generate();
  // A stranger with no authority over the ledger. It pays dividends, to prove on every
  // call that `pay_dividend` really is open to anyone.
  const keeper = Keypair.generate();
  // The coin. Both are PDAs of this ledger, so neither has a private key: the mint is
  // its own mint and freeze authority, and it owns the vault that holds every SETTLER.
  const [mint] = PublicKey.findProgramAddressSync(
    [Buffer.from('settlers'), ledger.publicKey.toBuffer()], PROGRAM_ID);
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), ledger.publicKey.toBuffer()], PROGRAM_ID);
  // An agent's purse: an SPL token account at ["purse", ledger, agent] that owns itself,
  // so no key that could spend it exists. The bump is sent with every call and checked
  // on-chain against the account actually passed.
  const purses = new Map();
  const purseOf = agent => {
    if (!purses.has(agent)) {
      const index = Buffer.alloc(2); index.writeUInt16LE(agent);
      const [pda, bump] = PublicKey.findProgramAddressSync(
        [Buffer.from('purse'), ledger.publicKey.toBuffer(), index], PROGRAM_ID);
      purses.set(agent, { pubkey: pda, bump });
    }
    return purses.get(agent);
  };
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

  // 0.05 SOL is thousands of pay_dividend calls at 5,000 lamports a signature.
  async function fundKeeper(lamports = 5e7) {
    if (await conn.getBalance(keeper.publicKey) >= lamports) return;
    try {
      const sig = await conn.requestAirdrop(keeper.publicKey, lamports);
      await conn.confirmTransaction(sig, 'confirmed');
      return;
    } catch { /* no faucet here: pay the keeper out of the authority's pocket */ }
    await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({
      fromPubkey: authority.publicKey, toPubkey: keeper.publicKey, lamports,
    })), [authority], { commitment: 'confirmed' });
  }

  const writeKeys = () => [
    { pubkey: ledger.publicKey, isSigner: false, isWritable: true },
    { pubkey: authority.publicKey, isSigner: true, isWritable: false },
  ];
  // The three accounts every instruction that mints or burns must carry.
  const coinKeys = () => [
    { pubkey: mint, isSigner: false, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  // Anchor reads an absent optional account as the program's own id, which is already in
  // the transaction — so leaving the coin off an ordinary auction costs 3 bytes, not 96.
  const noCoinKeys = () => Array.from({ length: 3 }, () =>
    ({ pubkey: PROGRAM_ID, isSigner: false, isWritable: false }));
  const writeMintKeys = () => [...writeKeys(), ...coinKeys()];

  // prices: opening last price per good (N_GOODS of them), in cents. bankSeed: the bank's opening cash.
  // terms: { ltvBps, rateBps, ratePeriodSlots, penaltyBps, kappaBps, marginBps,
  //          termUnitSlots, maxTermUnits, equityFloor }  — ltvBps 0 = no credit.
  // Interest is rateBps per ratePeriodSlots, by slot; a loan term is 1..maxTermUnits × termUnitSlots.
  async function initialize(n, cash, food, wood, prices, bankSeed, terms) {
    if (prices.length !== N_GOODS) throw new Error(`initialize: need ${N_GOODS} prices`);
    const d = Buffer.alloc(8 + 4 + 8 + 4 + 4 + 8 * N_GOODS + 8 + 6 * 2 + 3 * 8);
    DISC.initialize.copy(d, 0);
    d.writeUInt32LE(n, 8); d.writeBigUInt64LE(BigInt(cash), 12); d.writeUInt32LE(food, 20); d.writeUInt32LE(wood, 24);
    prices.forEach((p, g) => d.writeBigUInt64LE(BigInt(p), 28 + g * 8));
    d.writeBigUInt64LE(BigInt(bankSeed), 68);
    d.writeUInt16LE(terms.ltvBps, 76); d.writeUInt16LE(terms.rateBps, 78); d.writeUInt16LE(terms.penaltyBps, 80);
    d.writeUInt16LE(terms.kappaBps, 82); d.writeUInt16LE(terms.marginBps, 84); d.writeUInt16LE(terms.maxTermUnits, 86);
    d.writeBigUInt64LE(BigInt(terms.ratePeriodSlots), 88); d.writeBigUInt64LE(BigInt(terms.termUnitSlots), 96);
    d.writeBigUInt64LE(BigInt(terms.equityFloor ?? 0), 104);
    // The keeper pays its own fees to prove pay_dividend really is permissionless. A local
    // validator will airdrop; a public faucet usually won't, so fall back to a transfer.
    await fundKeeper();
    return send(new TransactionInstruction({
      programId: PROGRAM_ID, data: d, keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: ledger.publicKey, isSigner: true, isWritable: true },
        ...coinKeys(),
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    }), [ledger]);
  }

  // Encode `agents: Vec<u16>` then `bumps: Vec<u8>` — the shape both purse calls take —
  // and pass each agent's purse as a remaining account, in the same order.
  function purseCall(disc, agents, keys) {
    const d = Buffer.alloc(8 + 4 + agents.length * 2 + 4 + agents.length);
    disc.copy(d, 0);
    d.writeUInt32LE(agents.length, 8);
    agents.forEach((a, k) => d.writeUInt16LE(a, 12 + k * 2));
    const at = 12 + agents.length * 2;
    d.writeUInt32LE(agents.length, at);
    agents.forEach((a, k) => d.writeUInt8(purseOf(a).bump, at + 4 + k));
    return new TransactionInstruction({
      programId: PROGRAM_ID, data: d,
      keys: [...keys, ...agents.map(a =>
        ({ pubkey: purseOf(a).pubkey, isSigner: false, isWritable: true }))],
    });
  }

  // Give every agent a purse of their own. Once per ledger, after initialize; re-running
  // it is a no-op per purse, so an interrupted pass can just be run again.
  async function initPurses(n) {
    const keys = [
      ...writeKeys(),
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    // The authority pays rent for each purse, so it must be writable here.
    keys[1] = { pubkey: authority.publicKey, isSigner: true, isWritable: true };
    const sigs = [];
    for (let i = 0; i < n; i += MAX_PURSES_PER_TX) {
      const agents = Array.from({ length: Math.min(MAX_PURSES_PER_TX, n - i) }, (_, k) => i + k);
      sigs.push(await send(purseCall(DISC.init_purses, agents, keys)));
    }
    return sigs;
  }

  // Move real SETTLERS between the agents named, until every purse holds what the ledger
  // says that agent has. The program derives the transfers; we only say who to look at.
  async function settleCash(agents) {
    const list = [...new Set(agents)].sort((a, b) => a - b);
    const keys = [
      ...writeKeys(),
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    const sigs = [];
    for (let i = 0; i < list.length; i += MAX_PURSES_PER_TX) {
      sigs.push(await send(purseCall(DISC.settle_cash, list.slice(i, i + MAX_PURSES_PER_TX), keys)));
    }
    return sigs;
  }

  // Who paid whom in a settle_cash transaction, read back off the chain: the SPL
  // transfers it actually made, with each purse resolved to the agent who owns it.
  // This is the transaction's own record, not our account of it.
  async function transfersIn(sig) {
    const tx = await conn.getParsedTransaction(sig,
      { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    const who = new Map([[vault.toBase58(), 'the bank']]);
    for (const [agent, p] of purses) who.set(p.pubkey.toBase58(), agent);
    return (tx?.meta?.innerInstructions ?? []).flatMap(g => g.instructions)
      .filter(i => i.parsed?.type === 'transfer')
      .map(i => ({ from: who.get(i.parsed.info.source) ?? null,
                   to: who.get(i.parsed.info.destination) ?? null,
                   amount: Number(i.parsed.info.amount) }));
  }

  // What an agent's purse actually holds on chain, in cents.
  async function purseBalance(agent) {
    const info = await conn.getAccountInfo(purseOf(agent).pubkey, 'confirmed');
    return info ? Number(info.data.readBigUInt64LE(64)) : 0;
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
  // Price: the last price clamped into [max(last filled ask, next unfilled bid),
  // min(last filled bid, next unfilled ask)] (a partly filled order counts as unfilled).
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
    // Only a bank sale can destroy coins here, so only then does the mint ride along.
    const bankSelling = asks.some(o => o.agent === BANK);
    return send(new TransactionInstruction({
      programId: PROGRAM_ID, data,
      keys: [...writeKeys(), ...(bankSelling ? coinKeys() : noCoinKeys())],
    }));
  }

  // ---- the bank ---------------------------------------------------------------
  // termSlots: one of allowedTerms(L.terms); used only when opening a loan (a top-up keeps
  // its due slot, so any value is accepted then; an overdue loan can't be topped up).
  // collateral: N_GOODS counts to add to the pledge, food must be 0.
  async function borrow(agent, amount, termSlots, collateral) {
    const d = Buffer.alloc(8 + 2 + 8 + 8 + 4 * N_GOODS);
    DISC.borrow.copy(d, 0);
    d.writeUInt16LE(agent, 8); d.writeBigUInt64LE(BigInt(amount), 10); d.writeBigUInt64LE(BigInt(termSlots), 18);
    collateral.forEach((q, g) => d.writeUInt32LE(q, 26 + g * 4));
    return send(new TransactionInstruction({ programId: PROGRAM_ID, data: d, keys: writeMintKeys() }));
  }
  // Interest accrued to the chain's slot is paid first. Leaving < FORGIVE_BELOW owing closes the loan.
  async function repay(agent, amount) {
    const d = Buffer.alloc(8 + 2 + 8);
    DISC.repay.copy(d, 0);
    d.writeUInt16LE(agent, 8); d.writeBigUInt64LE(BigInt(amount), 10);
    return send(new TransactionInstruction({ programId: PROGRAM_ID, data: d, keys: writeMintKeys() }));
  }
  // Signed and paid for by the keeper alone — the authority is not on this transaction.
  const anyone = name => {
    const d = Buffer.alloc(8);
    DISC[name].copy(d, 0);
    return send(new TransactionInstruction({ programId: PROGRAM_ID, data: d, keys: [
      { pubkey: ledger.publicKey, isSigner: false, isWritable: true },
      { pubkey: keeper.publicKey, isSigner: true, isWritable: false },
    ] }), [], [keeper]);
  };
  // The bank collects a loan that has come due, or forecloses it: allowed once overdue or
  // under margin (see collectable()). An overdue loan whose debtor has the cash is simply
  // repaid from it — no penalty, collateral released (see collects()); otherwise it's a
  // foreclosure with the penalty. Signed by the authority, like every other write.
  async function collect(agent) {
    const d = Buffer.alloc(8 + 2);
    DISC.collect.copy(d, 0);
    d.writeUInt16LE(agent, 8);
    return send(new TransactionInstruction({ programId: PROGRAM_ID, data: d, keys: writeMintKeys() }));
  }
  // Pay half the bank's equity above its capital requirement to every agent equally. A no-op without a surplus.
  const payDividend = () => anyone('pay_dividend');

  // Read the whole ledger back. Zero-copy layout, decoded by hand (offsets: Ledger in lib.rs, +8).
  // `debt` is as last accrued on-chain; `debtNow` adds the interest accrued up to `slot`,
  // the slot this read was taken at.
  async function fetch() {
    const { context, value: acct } = await conn.getAccountInfoAndContext(ledger.publicKey, 'confirmed');
    const b = acct.data, now = context.slot;
    const u64 = o => Number(b.readBigUInt64LE(8 + o));
    const u32 = o => b.readUInt32LE(8 + o);
    const u16 = o => b.readUInt16LE(8 + o);
    const G = [...Array(N_GOODS).keys()];
    const slot = o => ({
      cash: u64(o),
      goods: G.map(g => u32(o + 8 + g * 4)),
      locked: G.map(g => u32(o + 28 + g * 4)),
      debt: u64(o + 48), principal: u64(o + 56), dueSlot: u32(o + 64), accruedSlot: u32(o + 68),
    });
    const n = u32(32);
    const books = {
      startMoney: u64(96), bankSeed: u64(104), minted: u64(112), principalRepaid: u64(120),
      interestIncome: u64(128), penalties: u64(136), recovered: u64(144), writtenOff: u64(152),
      badDebt: u64(160), dividendsPaid: u64(168), seizedValue: u64(176), soldBook: u64(184),
      refunds: u64(192), forgiven: u64(200),
    };
    const bankBook = G.map(g => u64(208 + g * 8));
    const terms = { equityFloor: u64(248), ratePeriodSlots: u64(256), termUnitSlots: u64(264),
                    ltvBps: u16(272), rateBps: u16(274), penaltyBps: u16(276), kappaBps: u16(278),
                    marginBps: u16(280), maxTermUnits: u16(282) };
    terms.allowedTerms = allowedTerms(terms);
    const bank = slot(288);
    const debtTotal = u64(88);
    const inventory = bankBook.reduce((t, v) => t + v, 0);
    const equity = bank.cash + inventory - books.badDebt;
    const capitalRequired = Math.floor(debtTotal * terms.kappaBps / 10_000) + terms.equityFloor;
    const out = {
      numAgents: n, round: u32(36),
      lastPrice: G.map(g => u64(40 + g * 8)),
      supply: u64(80), debtTotal, badDebt: books.badDebt,
      books, terms, bank, bankBook, inventory,
      equity,                                                                   // cash + seized goods at book − bad debt
      lendingCap: Math.floor(Math.max(0, equity) * 10_000 / terms.kappaBps),    // max debtTotal
      capitalRequired,
      creditOn: terms.ltvBps > 0,
      slots: [],
    };
    for (let i = 0; i < n; i++) out.slots.push(slot(HEADER + i * SLOT - 8));
    for (const s of out.slots) s.debtNow = accruedDebt(s, terms, now);
    out.slot = now;
    out.debtTotalNow = out.slots.reduce((t, s) => t + s.debtNow, 0);
    return out;
  }

  // What the SPL mint itself says exists, in cents. The program checks this against
  // `supply + bank.cash` after every instruction that can move either, so a mismatch
  // here means a transaction that should have failed did not.
  async function settlersSupply() {
    const acct = await conn.getAccountInfo(mint, 'confirmed');
    return acct ? Number(acct.data.readBigUInt64LE(36)) : null;   // SPL mint layout: supply at 36
  }

  return {
    conn, authority, ledger, keeper, initialize, settle, clear, fetch, borrow, repay, collect, payDividend,
    fundKeeper, initPurses, settleCash, purseBalance, transfersIn,
    purseOf: agent => purseOf(agent).pubkey,
    MAX_PURSES_PER_TX,
    slot: () => conn.getSlot('confirmed'),
    mint, vault, settlersSupply,
    MAX_ORDERS_PER_TX, MAX_ORDERS_BANK_TX, LEDGER_SIZE, txCount: () => txCount,
  };
}

// Value of a slot's pledged goods at the given prices (cents).
export const lockedValue = (s, prices) => s.locked.reduce((v, q, g) => v + q * prices[g], 0);

// The loan terms a borrower may pick, in slots: 1..maxTermUnits × termUnitSlots.
export const allowedTerms = terms => Array.from({ length: terms.maxTermUnits }, (_, k) => (k + 1) * terms.termUnitSlots);

// A slot's debt at `nowSlot`: the stored debt plus simple interest on the principal since
// accruedSlot, rateBps per ratePeriodSlots, rounded down — exactly what the program adds
// when it next touches the loan (borrow, repay, collect) at that slot.
export function accruedDebt(s, terms, nowSlot) {
  if (!s.debt || !s.principal) return s.debt;
  const held = BigInt(Math.max(0, nowSlot - s.accruedSlot));
  return s.debt + Number(BigInt(s.principal) * BigInt(terms.rateBps) * held / (10_000n * BigInt(terms.ratePeriodSlots)));
}

// Why `collect` would succeed on this slot right now — 'overdue', 'margin' or null.
// 'overdue' covers both outcomes: collects() says whether it's a direct debit or a foreclosure.
// Same rule as the program: overdue once the chain slot passes dueSlot; a margin call
// once accrued debt × 10000 > locked value at the last prices × marginBps.
export function collectable(s, L, nowSlot) {
  if (!s.debt) return null;
  if (nowSlot > s.dueSlot) return 'overdue';
  if (accruedDebt(s, L.terms, nowSlot) * 10_000 > lockedValue(s, L.lastPrice) * L.terms.marginBps) return 'margin';
  return null;
}

// True when `collect` at nowSlot would repay the loan from the debtor's cash (overdue, and
// cash covers the accrued debt): no penalty, nothing seized. False = foreclosure, or not allowed.
// The program decides at the slot the transaction lands, when a little more interest is owed.
export function collects(s, L, nowSlot) {
  return !!s.debt && nowSlot > s.dueSlot && s.cash >= accruedDebt(s, L.terms, nowSlot);
}

// What pay_dividend would pay each agent right now (0 = nothing): half the equity above
// capitalRequired, at most the bank's cash, split equally and rounded down.
export function dividendPerAgent(L) {
  const surplus = L.equity - L.capitalRequired;
  if (surplus <= 0 || !L.numAgents) return 0;
  return Math.floor(Math.min(Math.floor(surplus * DIVIDEND_SHARE_BPS / 10_000), L.bank.cash) / L.numAgents);
}
