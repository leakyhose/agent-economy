/**
 * End-to-end settlement, against a real validator.
 *
 *   npx tsx packages/solana/scripts/demo.ts
 *
 * For each shipped world it creates a ledger, endows the population from the world
 * file, seals genesis, settles a tick of production, clears every market the world
 * declares, moves cash between agents, and reads the whole thing back off chain. Every
 * signature printed is a real transaction; the explorer links open against whatever
 * cluster `AW_RPC_URL` points at, which defaults to the local validator.
 *
 * Nothing here is mocked. If the validator is not running, this fails and says so.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicKey, Transaction } from '@solana/web3.js';
import type { SettlementIntent, WorldDefinition } from '@aw/types';
import {
  BlockhashCache,
  MAX_ORDERS_PER_BOOK,
  NullSettlementQueue,
  SolanaSettlementQueue,
  TxSender,
  WorldLedger,
  clearAuction,
  clearAuctionIx,
  clusterFromEnv,
  connect,
  loadIdl,
  sortAsks,
  sortBids,
  type Order,
} from '../src/index.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const WORLDS = ['economic-sandbox.json', 'medieval-kingdom.json'];

/**
 * A seeded generator, so a demo run is reproducible and a judge can be handed the
 * seed. Plain xorshift; nothing here needs cryptographic randomness.
 */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

const bar = (label: string): void => {
  console.log(`\n${'─'.repeat(76)}\n${label}\n${'─'.repeat(76)}`);
};

const money = (n: bigint | number): string => n.toLocaleString('en-US');

async function runWorld(file: string): Promise<{ world: string; signatures: string[] }> {
  const world = JSON.parse(
    readFileSync(join(ROOT, 'worlds', file), 'utf8'),
  ) as WorldDefinition;

  const cluster = clusterFromEnv();
  const connection = connect(cluster);
  const blockhash = new BlockhashCache(connection);
  const { programId } = loadIdl(join(ROOT, 'target/idl/world.json'));

  bar(`${world.name}  ·  ${file}`);

  const ledger = await WorldLedger.create({
    world,
    connection,
    cluster,
    programId,
    blockhash,
    masterSeed: Buffer.alloc(32, world.seed % 251),
    onStep: (step, sig) => console.log(`  ${step.padEnd(11)} ${sig}`),
  });
  const signatures: string[] = [];

  console.log(`\n  ledger      ${ledger.address.toBase58()}`);
  console.log(`  authority   ${ledger.wallet.authorityAddress()}`);
  console.log(`  goods       ${ledger.map.goods.map((g, i) => `${i}:${g}`).join('  ')}`);
  console.log(`  currency    ${ledger.map.currency}   (derived from the world's markets)`);
  console.log(`  agents      ${ledger.roster.count}`);

  const genesis = await ledger.read();
  console.log(`  sealed      ${genesis.sealed}`);
  console.log(`  money       ${money(genesis.moneySupply)} ${ledger.map.currency}`);
  console.log(`  explorer    ${ledger.explorer('address', ledger.address.toBase58())}`);

  // ---- a tick of production ------------------------------------------------
  // Signed goods deltas, exactly as the engine's `increment`/`decrement` effects
  // would produce them. Good 0 is cash and the program refuses it here, on purpose.
  const rand = rng(world.seed);
  const deltas = ledger.roster.ids.flatMap((_, agent) =>
    ledger.map.tradable
      .filter(() => rand() < 0.5)
      .map(({ index }) => ({ agent, good: index, delta: 1 + Math.floor(rand() * 4) })),
  );
  const settleSigs = await ledger.settle(deltas);
  signatures.push(...settleSigs);
  console.log(`\n  settle      ${deltas.length} deltas in ${settleSigs.length} tx`);
  for (const s of settleSigs) console.log(`              ${s}`);

  // ---- every market the world declares ------------------------------------
  const afterProduction = await ledger.read();
  for (const market of world.markets ?? []) {
    const good = ledger.map.mustIndexOf(market.resource);
    const startPrice =
      world.resources.find((r) => r.id === market.resource)?.startPrice ?? 100;

    // Buyers who can pay, sellers who hold stock. Limits scatter around the world's
    // declared start price, which is what produces a crossing book.
    const bids: Order[] = [];
    const asks: Order[] = [];
    for (let agent = 0; agent < ledger.roster.count; agent++) {
      const slot = afterProduction.slots[agent]!;
      const held = slot.goods[good] ?? 0;
      const limit = Math.max(1, Math.round(startPrice * (0.75 + rand() * 0.5)));
      if (rand() < 0.5) {
        const qty = 1 + Math.floor(rand() * 3);
        if (slot.cash >= BigInt(qty * limit)) bids.push({ agent, qty, limit });
      } else if (held > 0) {
        asks.push({ agent, qty: Math.min(held, 1 + Math.floor(rand() * 3)), limit });
      }
    }

    // What the off-chain market says. The chain must agree, or one of them is wrong.
    const expected = clearAuction(sortBids(bids), sortAsks(asks));

    const { signatures: clearSigs, atomic } = await ledger.clearAuction(good, bids, asks);
    signatures.push(...clearSigs);
    const after = await ledger.read();
    const onChain = Number(after.lastPrice[good] ?? 0n);

    const agree =
      expected === null
        ? onChain === Number(afterProduction.lastPrice[good] ?? 0n)
        : expected.price === onChain;

    console.log(
      `\n  ${market.id.padEnd(14)} good ${good} (${market.resource})  ` +
        `${bids.length} bids / ${asks.length} asks` +
        `${atomic ? '' : '  [split across tx — not atomic]'}`,
    );
    console.log(
      `                off-chain ${expected ? `${expected.price} × ${expected.volume}` : 'no cross'}` +
        `   on-chain ${onChain}   ${agree ? 'AGREE' : 'DISAGREE'}`,
    );
    if (!agree) throw new Error(`${market.id}: off-chain and on-chain clears disagree`);
    for (const s of clearSigs) {
      console.log(`                ${s}`);
      console.log(`                ${ledger.explorer('tx', s)}`);
    }
  }

  // ---- the transaction ceiling, on chain -----------------------------------
  // The cap is the whole reason instruction data is hand-encoded, so prove it rather
  // than assert it. This book is deliberately non-crossing: no balance moves, which
  // means what is under test is purely the 1,232-byte transaction budget and the
  // compute cost of verifying 96 orders are sorted.
  {
    const good = 1;
    const n = MAX_ORDERS_PER_BOOK;
    const bids: Order[] = Array.from({ length: n }, (_, k) => ({
      agent: k % ledger.roster.count,
      qty: 1,
      limit: 100 - Math.floor(k / 2),
    }));
    const asks: Order[] = Array.from({ length: n }, (_, k) => ({
      agent: k % ledger.roster.count,
      qty: 1,
      limit: 10_000 + k,
    }));
    const ix = clearAuctionIx(programId, ledger.accounts, { good, bids, asks });
    // The number that actually matters is the wire size of the whole transaction,
    // against the 1,232-byte legacy limit — not the instruction data alone.
    const probe = new Transaction({
      blockhash: PublicKey.default.toBase58(),
      lastValidBlockHeight: 0,
      feePayer: ledger.accounts.authority,
    }).add(ix);
    const txBytes = probe.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }).length;

    const full = await ledger.clearAuction(good, bids, asks);
    signatures.push(...full.signatures);
    console.log(
      `\n  ceiling     ${n} bids + ${n} asks = ${2 * n} orders  ·  ` +
        `${ix.data.length} B instruction, ${txBytes} B transaction (limit 1232)  ·  ` +
        `atomic=${full.atomic}`,
    );
    for (const s of full.signatures) console.log(`              ${s}`);

    // Well past the cap, the encoder refuses rather than letting the RPC come back
    // with an unhelpful "transaction too large".
    const over = [
      ...bids,
      ...Array.from({ length: 16 }, () => ({ agent: 0, qty: 1, limit: 1 })),
    ];
    try {
      clearAuctionIx(programId, ledger.accounts, { good, bids: over, asks });
      console.log(
        `              ${over.length + n} orders: ACCEPTED — the guard is not working`,
      );
    } catch (err) {
      console.log(
        `              ${over.length + n} orders: refused — ` +
          `${(err as Error).message.replace(/^clear_auction instruction is /, '').split(';')[0] ?? ''}`,
      );
    }
  }

  // ---- the settlement queue ------------------------------------------------
  // What the world DSL's `settle` effect produces. Enqueue is synchronous; the sim
  // would have moved on several ticks by the time these land.
  const queue = new SolanaSettlementQueue({
    sender: new TxSender(connection, blockhash),
    wallet: ledger.wallet,
    programId,
    accounts: ledger.accounts,
    map: ledger.map,
    resolveAgent: (e) => ledger.roster.indexOf(e),
  });

  const before = await ledger.read();
  const payers = before.slots
    .map((s, agent) => ({ agent, cash: s.cash }))
    .filter((s) => s.cash > 500n)
    .slice(0, 6);
  const intents: SettlementIntent[] = payers.map((p, k) => ({
    tick: 1,
    asset: ledger.map.currency,
    from: ledger.roster.ids[p.agent]!,
    to: ledger.roster.ids[(p.agent + 1) % ledger.roster.count]!,
    amount: 100 + k,
  }));
  for (const intent of intents) queue.enqueue(intent);
  console.log(`\n  queue       ${queue.pending()} intents buffered, sim did not wait`);
  const queueSigs = await queue.flush();
  signatures.push(...queueSigs);
  for (const s of queueSigs) console.log(`              ${s}`);

  // ---- the claim worth making ---------------------------------------------
  const final = await ledger.read();
  console.log(`\n  round       ${final.round}`);
  console.log(`  money       ${money(final.moneySupply)} ${ledger.map.currency}`);
  const conserved = final.moneySupply === genesis.moneySupply;
  console.log(
    `  conserved   ${conserved ? 'yes' : 'NO'}  ` +
      `(genesis ${money(genesis.moneySupply)}, now ${money(final.moneySupply)})`,
  );
  if (!conserved) throw new Error('the money supply moved; the program is broken');

  // The server is not trusted to say so: try to print money and watch it fail.
  let refused = 'the ledger accepted it — CONSERVATION IS BROKEN';
  try {
    await ledger.endow([{ agent: 0, good: 0, amount: 999_999_999 }]);
  } catch (err) {
    refused = String((err as Error).message).replace(/^.*Error Message: /, '').trim();
  }
  console.log(`  print money ${refused}`);

  const sample = ledger.roster.ids[0]!;
  console.log(`\n  ${sample} address ${await ledger.wallet.addressFor(sample)}`);
  console.log(
    `  ${sample} holdings ${JSON.stringify(await ledger.wallet.getTokenBalances(sample))}`,
  );

  return { world: world.name, signatures };
}

async function main(): Promise<void> {
  const cluster = clusterFromEnv();
  bar('Agentic World — settlement layer');
  console.log(`  rpc         ${cluster.rpcUrl}`);
  console.log(`  cluster     ${cluster.cluster}`);

  const connection = connect(cluster);
  try {
    const version = await connection.getVersion();
    console.log(`  validator   solana-core ${version['solana-core']}`);
  } catch {
    console.error(
      `\n  No validator at ${cluster.rpcUrl}.\n` +
        `  Start one:  solana-test-validator --limit-ledger-size 50000000\n` +
        `  Then:       solana program deploy target/deploy/world.so ` +
        `--program-id target/deploy/world-keypair.json\n`,
    );
    process.exitCode = 1;
    return;
  }

  const results = [];
  for (const file of WORLDS) results.push(await runWorld(file));

  // The offline path: the same simulation, no validator, no signatures, no pretending.
  bar('Offline (NullSettlementQueue)');
  const offline = new NullSettlementQueue();
  offline.enqueue({ tick: 1, asset: 'gold', from: 'a', to: 'b', amount: 10 });
  offline.enqueue({ tick: 1, asset: 'gold', from: 'b', to: 'c', amount: 4 });
  console.log(`  pending     ${offline.pending()}`);
  console.log(`  flush       ${JSON.stringify(await offline.flush())}  (nothing signed, nothing faked)`);
  console.log(`  recorded    ${offline.intents().length} intents, available to a test`);

  bar('Transactions');
  let total = 0;
  for (const r of results) {
    console.log(`  ${r.world}: ${r.signatures.length}`);
    total += r.signatures.length;
  }
  console.log(`  total: ${total} real transactions on ${cluster.rpcUrl}`);
}

main().catch((err) => {
  console.error(`\ndemo failed: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof AggregateError) for (const e of err.errors) console.error(`  - ${e.message}`);
  process.exitCode = 1;
});
