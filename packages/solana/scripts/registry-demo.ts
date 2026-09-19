// Registry demo — the identity and ownership layer, running for real.
//
//   npx tsx packages/solana/scripts/registry-demo.ts
//
// It reads the world files, registers each world's agent population as identity
// PDAs, mints a PDA record for every asset class a world declares with
// `ownership: "pda_record"`, moves one of them, and proves the program rejects a
// move signed by anybody else.
//
// Everything printed below is a real transaction on the configured cluster. If
// the validator is not reachable the script says so and stops; it never invents
// a signature.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Connection, Keypair, PublicKey, type Signer } from '@solana/web3.js';

import {
  AgentRegistry,
  PdaOwnershipRegistry,
  REGISTRY_PROGRAM_ID,
  deriveWorldId,
  explorerUrl,
  sendInstructions,
  transferAssetIx,
  verifyDiscriminators,
  type AgentRegistration,
  type AgentSignerSource,
  type SentTransaction,
} from '../src/registry.ts';

// --------------------------------------------------------------------- setup

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const RPC = process.env['AW_RPC'] ?? 'http://127.0.0.1:8899';
const IDL_PATH = resolve(REPO, 'programs/registry/idl/registry.json');
const WORLD_FILES = ['worlds/economic-sandbox.json', 'worlds/medieval-kingdom.json'];

/**
 * Only the parts of a world file this script reads. The chain block is the
 * world's instructions to the Solana layer; nothing here hard-codes a world's
 * vocabulary, and the two world files take completely different paths through
 * the same code purely because they declare different things.
 */
interface WorldFile {
  name: string;
  entityTypes: { id: string; agent?: boolean }[];
  population: { type: string; count: number }[];
  chain?: {
    cluster?: string;
    agentRegistry?: boolean;
    assets?: { id: string; ownership: string; holders?: string[] }[];
  };
}

// --------------------------------------------------------------------- output

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const OFF = '\x1b[0m';

const line = (s = '') => console.log(s);
const rule = (ch = '─') => line(DIM + ch.repeat(78) + OFF);

function heading(title: string): void {
  line();
  rule('━');
  line(`${BOLD}${title}${OFF}`);
  rule('━');
}

function section(title: string): void {
  line();
  line(`${BOLD}${title}${OFF}`);
  rule();
}

function field(label: string, value: string): void {
  line(`  ${label.padEnd(22)}${value}`);
}

function tx(label: string, signature: string): void {
  line(`  ${GREEN}✓${OFF} ${label}`);
  line(`      ${signature}`);
  line(`      ${DIM}${explorerUrl('tx', signature, RPC)}${OFF}`);
}

function account(label: string, address: PublicKey): void {
  line(`  ${label}`);
  line(`      ${address.toBase58()}`);
  line(`      ${DIM}${explorerUrl('address', address.toBase58(), RPC)}${OFF}`);
}

// ------------------------------------------------------------------- helpers

/**
 * A deterministic keypair per agent, so re-running the demo addresses the same
 * wallets. A real deployment gets these from the wallet service; this script
 * only needs something that can sign, and owns no other module's file.
 */
function walletFor(worldName: string, entity: string): Keypair {
  const seed = createHash('sha256').update(`aw:wallet:${worldName}:${entity}`).digest();
  return Keypair.fromSeed(seed.subarray(0, 32));
}

/** Mirrors the engine's `${type}_${n}` entity ids, so the two layers line up. */
function rosterFor(world: WorldFile): AgentRegistration[] {
  const agentTypes = new Set(
    world.entityTypes.filter((t) => t.agent !== false).map((t) => t.id),
  );
  const out: AgentRegistration[] = [];
  const counters = new Map<string, number>();
  for (const cohort of world.population) {
    if (!agentTypes.has(cohort.type)) continue;
    for (let i = 0; i < cohort.count; i += 1) {
      const n = counters.get(cohort.type) ?? 0;
      counters.set(cohort.type, n + 1);
      const entity = `${cohort.type}_${n}`;
      out.push({
        entity,
        index: out.length,
        entityType: cohort.type,
        wallet: walletFor(world.name, entity).publicKey,
      });
    }
  }
  return out;
}

/** The signer source the ownership registry asks for, backed by the demo keys. */
function signerSource(worldName: string): AgentSignerSource {
  return {
    signerFor(entity: string): Signer | undefined {
      return entity ? walletFor(worldName, entity) : undefined;
    },
  };
}

function summarise(sent: SentTransaction[]): string {
  const ixs = sent.reduce((n, s) => n + s.instructionCount, 0);
  return `${ixs} instruction${ixs === 1 ? '' : 's'} in ${sent.length} transaction${
    sent.length === 1 ? '' : 's'
  }`;
}

function programLogs(err: unknown): string[] {
  const logs = (err as { logs?: string[] } | undefined)?.logs;
  if (Array.isArray(logs)) return logs;
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n');
}

// ---------------------------------------------------------------------- main

async function main(): Promise<void> {
  heading('Agentic World — on-chain identity and ownership');

  const connection = new Connection(RPC, 'confirmed');
  let version: string;
  try {
    version = (await connection.getVersion())['solana-core'];
  } catch (err) {
    line(`${RED}No validator at ${RPC}.${OFF}`);
    line(`${DIM}${err instanceof Error ? err.message : String(err)}${OFF}`);
    line();
    line('Start one and re-run:');
    line('  solana-test-validator --limit-ledger-size 50000000');
    process.exitCode = 1;
    return;
  }

  const idl = JSON.parse(readFileSync(IDL_PATH, 'utf8'));
  const drift = verifyDiscriminators(idl);
  if (drift.length > 0) {
    line(`${RED}Client and IDL disagree: ${drift.join(', ')}${OFF}`);
    process.exitCode = 1;
    return;
  }

  const programInfo = await connection.getAccountInfo(REGISTRY_PROGRAM_ID);
  if (!programInfo?.executable) {
    line(`${RED}Program ${REGISTRY_PROGRAM_ID.toBase58()} is not deployed at ${RPC}.${OFF}`);
    line();
    line('Build and deploy it:');
    line('  cargo build-sbf --manifest-path programs/registry/Cargo.toml \\');
    line('    --arch v3 --sbf-out-dir programs/registry/target/deploy-v3');
    line('  solana program deploy --program-id programs/registry/keys/registry-keypair.json \\');
    line('    programs/registry/target/deploy-v3/registry.so');
    process.exitCode = 1;
    return;
  }

  const payer = loadPayer();
  const balance = await connection.getBalance(payer.publicKey);

  field('cluster', `${RPC}  (solana-core ${version})`);
  field('program', REGISTRY_PROGRAM_ID.toBase58());
  field('discriminators', `${GREEN}match programs/registry/idl/registry.json${OFF}`);
  field('payer', `${payer.publicKey.toBase58()}  (${(balance / 1e9).toFixed(4)} SOL)`);

  if (balance < 2e9) {
    line(`  ${YELLOW}warning: payer balance is low; PDA rent may fail${OFF}`);
  }

  for (const file of WORLD_FILES) {
    await runWorld(connection, payer, file);
  }

  line();
  rule('━');
  line(`${BOLD}Done.${OFF} Every signature above is on ${RPC}.`);
  rule('━');
}

function loadPayer(): Keypair {
  const path =
    process.env['AW_KEYPAIR'] ?? resolve(process.env['HOME'] ?? '~', '.config/solana/id.json');
  const secret = Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')));
  return Keypair.fromSecretKey(secret);
}

async function runWorld(connection: Connection, payer: Keypair, file: string): Promise<void> {
  const world = JSON.parse(readFileSync(resolve(REPO, file), 'utf8')) as WorldFile;
  const worldId = deriveWorldId(world.name);

  heading(`${world.name}  ${DIM}(${file})${OFF}`);
  field('world id', worldId.toBase58());
  field('declared assets', describeAssets(world));

  if (world.chain?.agentRegistry === false) {
    line(`  ${DIM}world opted out of the agent registry; nothing to do${OFF}`);
    return;
  }

  // ---- identities -------------------------------------------------------
  const registry = new AgentRegistry({ connection, payer, world: worldId });
  const roster = rosterFor(world);

  section(`1. Agent identities — ${roster.length} agents`);
  const counts = new Map<string, number>();
  for (const r of roster) counts.set(r.entityType, (counts.get(r.entityType) ?? 0) + 1);
  field(
    'population',
    [...counts].map(([type, n]) => `${n}×${type}`).join(', '),
  );

  const started = Date.now();
  const sent = await registry.registerMany(roster, { concurrency: 8 });
  if (sent.length === 0) {
    line(`  ${DIM}all ${roster.length} identity PDAs already exist on this ledger${OFF}`);
  } else {
    field('batched', `${summarise(sent)} in ${Date.now() - started} ms`);
    for (const s of sent.slice(0, 3)) {
      tx(`${s.instructionCount} registrations`, s.signature);
    }
    if (sent.length > 3) line(`  ${DIM}… and ${sent.length - 3} more transaction(s)${OFF}`);
  }

  const sample = await registry.fetchMany(roster.slice(0, 3).map((r) => r.index));
  line();
  for (const id of sample) {
    if (!id) continue;
    const entity = registry.entityForWallet(id.wallet) ?? '?';
    account(
      `${entity}  ${DIM}type=${id.entityType} index=${id.index} slot=${id.createdSlot} rep=${id.reputation}${OFF}`,
      id.address,
    );
  }

  // ---- reputation -------------------------------------------------------
  if (roster.length >= 2) {
    const subject = roster[0] as AgentRegistration;
    const attestor = roster[1] as AgentRegistration;
    section('2. Reputation — peer-attested, so it reads two identity PDAs');
    const signature = await registry.attestReputation({
      subject: subject.entity,
      attestor: attestor.entity,
      delta: 3,
      attestorSigner: walletFor(world.name, attestor.entity),
    });
    tx(`${attestor.entity} attests +3 for ${subject.entity}`, signature);
    const after = await registry.fetch(subject.index);
    field('reputation now', String(after?.reputation ?? 'unknown'));
  }

  // ---- assets -----------------------------------------------------------
  const pdaClasses = (world.chain?.assets ?? []).filter((a) => a.ownership === 'pda_record');
  if (pdaClasses.length === 0) {
    section('3. Assets');
    line(
      `  ${DIM}this world declares no "pda_record" asset class` +
        `${describeOtherModes(world)}; nothing for this registry to mint${OFF}`,
    );
    return;
  }

  for (const assetClass of pdaClasses) {
    await runAssetClass(connection, payer, world, worldId, registry, roster, assetClass);
  }
}

function describeAssets(world: WorldFile): string {
  const assets = world.chain?.assets ?? [];
  if (assets.length === 0) return 'none';
  return assets.map((a) => `${a.id} (${a.ownership})`).join(', ');
}

function describeOtherModes(world: WorldFile): string {
  const modes = [...new Set((world.chain?.assets ?? []).map((a) => a.ownership))];
  return modes.length > 0 ? ` — it uses ${modes.join(', ')} instead` : '';
}

async function runAssetClass(
  connection: Connection,
  payer: Keypair,
  world: WorldFile,
  worldId: PublicKey,
  registry: AgentRegistry,
  roster: AgentRegistration[],
  assetClass: { id: string; holders?: string[] },
): Promise<void> {
  section(`3. Asset class "${assetClass.id}" — one PDA record per asset`);

  // Which agents may hold this class is the world's decision, not this script's.
  const holders = new Set(assetClass.holders ?? roster.map((r) => r.entityType));
  const eligible = roster.filter((r) => holders.has(r.entityType));
  field('holders (from world)', [...holders].join(', '));
  field('eligible agents', `${eligible.length} of ${roster.length}`);

  if (eligible.length < 2) {
    line(`  ${YELLOW}fewer than two eligible holders; skipping${OFF}`);
    return;
  }

  const ownership = new PdaOwnershipRegistry(
    { connection, payer, world: worldId },
    { assetClass: assetClass.id, agents: registry, signers: signerSource(world.name) },
  );

  // One record per eligible holder. The count is this demo's choice; the
  // eligibility, the class name and the ownership mode all come from the world.
  const planned = eligible.map((holder, i) => ({
    assetId: `${assetClass.id}:${i}`,
    owner: holder.entity,
  }));
  const existing = await ownership.scan();
  const known = new Set(existing.map((r) => r.assetKey.toString()));
  const todo = planned.filter((p) => !known.has(ownership.keyOf(p.assetId).toString()));

  if (todo.length === 0) {
    line(`  ${DIM}all ${planned.length} records already minted on this ledger${OFF}`);
  } else {
    const started = Date.now();
    const sent = await ownership.mintMany(todo, { concurrency: 8 });
    field('minted', `${summarise(sent)} in ${Date.now() - started} ms`);
    for (const s of sent.slice(0, 3)) tx(`${s.instructionCount} records`, s.signature);
    if (sent.length > 3) line(`  ${DIM}… and ${sent.length - 3} more transaction(s)${OFF}`);
  }

  const first = planned[0] as { assetId: string; owner: string };
  line();
  account(`${first.assetId}  ${DIM}owner ${await ownership.ownerOf(first.assetId)}${OFF}`,
    ownership.pdaOf(first.assetId));

  // ---- transfer ---------------------------------------------------------
  const seller = eligible[0] as AgentRegistration;
  const buyer = (eligible.find((e) => e.entityType !== seller.entityType) ??
    eligible[1]) as AgentRegistration;
  const stranger = (eligible.find((e) => e.entity !== seller.entity && e.entity !== buyer.entity) ??
    buyer) as AgentRegistration;

  section(`4. Ownership is enforced by the program, not by this script`);

  // Negative control first: a registered agent who does not own the asset.
  const currentOwner = await ownership.ownerOf(first.assetId);
  if (stranger.entity !== currentOwner) {
    // Built and sent at the instruction level on purpose: the client is not
    // allowed to be the thing that says no. The chain has to say it.
    const rogueIx = transferAssetIx({
      asset: ownership.pdaOf(first.assetId),
      currentOwner: walletFor(world.name, stranger.entity).publicKey,
      newOwnerIdentity: registry.pdaFor(buyer.entity) as PublicKey,
    });
    try {
      await sendInstructions(connection, [rogueIx], payer, [
        walletFor(world.name, stranger.entity),
      ]);
      line(`  ${RED}✗ a non-owner transfer SUCCEEDED — the program is broken${OFF}`);
      process.exitCode = 1;
    } catch (err) {
      const logs = programLogs(err);
      const hit = logs.find((l) => /NotOwner|custom program error/i.test(l));
      line(
        `  ${GREEN}✓${OFF} ${stranger.entity} signed a transfer of ${first.assetId} ` +
          `and the program refused`,
      );
      line(`      ${DIM}${(hit ?? logs[0] ?? 'rejected').trim()}${OFF}`);
    }
  }

  // Now the real owner.
  if (currentOwner && currentOwner !== buyer.entity) {
    const signature = await ownership.transfer(first.assetId, currentOwner, buyer.entity);
    tx(`${currentOwner} → ${buyer.entity}`, signature);
    const record = await ownership.fetchRecord(first.assetId);
    field('owner now', `${await ownership.ownerOf(first.assetId)}`);
    field('owner wallet', record?.owner.toBase58() ?? '?');
    field('transfers', String(record?.transfers ?? 0));
  } else {
    line(`  ${DIM}${first.assetId} is already held by ${buyer.entity}${OFF}`);
  }

  const held = await ownership.assetsOf(buyer.entity);
  field(`${buyer.entity} holds`, held.length > 0 ? held.join(', ') : 'nothing');
  field('records on chain', String((await ownership.scan()).length));
}

main().catch((err) => {
  line();
  line(`${RED}${err instanceof Error ? err.stack ?? err.message : String(err)}${OFF}`);
  process.exitCode = 1;
});
