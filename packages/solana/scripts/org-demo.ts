/**
 * The organization layer, end to end, against a real validator.
 *
 * Run it for every world in `worlds/` and watch one program govern one world's
 * organizations by token-weighted stake at a 50% threshold and another's by a
 * weighted council at 60%. The only thing that differs between the two halves of
 * the output is the world file (brief §18).
 *
 *     pnpm tsx packages/solana/scripts/org-demo.ts
 *     pnpm tsx packages/solana/scripts/org-demo.ts worlds/medieval-kingdom.json
 *
 * Every signature printed is a transaction that landed. Nothing here is simulated;
 * if the validator is not running the script says so and stops.
 */

import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  TransactionInstruction,
  type Signer,
} from '@solana/web3.js';
import { clusterFromEnv, connect, explorerUrl, type ClusterConfig } from '../src/cluster.ts';
import { TxSender } from '../src/sender.ts';
import { SolanaEscrowService } from '../src/escrow.ts';
import { SolanaGovernanceService } from '../src/governance.ts';
import { SolanaTreasuryService } from '../src/treasury.ts';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_BYTES,
  ORG_PROGRAM_ID,
  ROLE_COUNCIL,
  ROLE_LEADER,
  ROLE_MEMBER,
  SequentialOrgDirectory,
  TOKEN_ACCOUNT_BYTES,
  TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  decodeTokenAccount,
  orgPda,
  readOrganizations,
  treasuryPda,
  upsertMemberIx,
  verifyAgainstIdl,
  type OrgContext,
  type OrgKeyring,
  type OrgMintRegistry,
  type OrgSpec,
  type OrgWorldConfig,
  type WorldOrganizationsSource,
} from '../src/org-program.ts';
import type { EntityId, EntityTypeId, ResourceId } from '@aw/types';

// ------------------------------------------------------------------ presentation

const WIDTH = 78;
let cluster: ClusterConfig;

const bold = (s: string) => `\u001b[1m${s}\u001b[0m`;
const dim = (s: string) => `\u001b[2m${s}\u001b[0m`;
const green = (s: string) => `\u001b[32m${s}\u001b[0m`;
const red = (s: string) => `\u001b[31m${s}\u001b[0m`;
const cyan = (s: string) => `\u001b[36m${s}\u001b[0m`;

function banner(title: string, subtitle?: string): void {
  console.log(`\n${'═'.repeat(WIDTH)}`);
  console.log(bold(`  ${title}`));
  if (subtitle) console.log(dim(`  ${subtitle}`));
  console.log('═'.repeat(WIDTH));
}

function section(title: string): void {
  console.log(`\n${bold(`── ${title} `)}${dim('─'.repeat(Math.max(0, WIDTH - title.length - 4)))}`);
}

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

/** A transaction that landed, with somewhere to go and look at it. */
function tx(label: string, signature: string): void {
  console.log(`  ${green('✓')} ${label.padEnd(20)} ${cyan(signature)}`);
  console.log(`  ${' '.repeat(22)} ${dim(explorerUrl(cluster, 'tx', signature))}`);
}

function account(label: string, address: PublicKey): void {
  console.log(`  ${label.padEnd(22)} ${address.toBase58()}`);
  console.log(`  ${' '.repeat(22)} ${dim(explorerUrl(cluster, 'address', address.toBase58()))}`);
}

/** A rejection we wanted. The program said no, and said why. */
function refused(label: string, error: unknown): void {
  const message = String(error instanceof Error ? error.message : error);
  const named =
    /Error Message: ([^.\n]+)/.exec(message)?.[1] ??
    (/already in use/.test(message) ? 'account already in use' : null) ??
    /custom program error: (0x[0-9a-f]+)/.exec(message)?.[1] ??
    null;
  console.log(`  ${green('✓')} ${red('refused')}  ${label}`);
  console.log(`  ${' '.repeat(12)}${dim(named ?? message.split('\n')[0] ?? message)}`);
}

async function mustFail(label: string, attempt: () => Promise<unknown>): Promise<void> {
  try {
    await attempt();
    console.log(`  ${red('✗ ACCEPTED')} ${label} — this should have been impossible`);
    process.exitCode = 1;
  } catch (error) {
    refused(label, error);
  }
}

// ------------------------------------------------------------------ SPL, by hand

/**
 * `@aw/solana` may import `@solana/web3.js` and nothing else from the ecosystem, so
 * the four SPL instructions this demo needs are encoded here rather than pulled in
 * from `@solana/spl-token`. They are small.
 */
function initializeMint2Ix(mint: PublicKey, decimals: number, authority: PublicKey) {
  const data = Buffer.alloc(1 + 1 + 32 + 1);
  data.writeUInt8(20, 0); // InitializeMint2
  data.writeUInt8(decimals, 1);
  authority.toBuffer().copy(data, 2);
  data.writeUInt8(0, 34); // no freeze authority
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    data,
    keys: [{ pubkey: mint, isSigner: false, isWritable: true }],
  });
}

function createAtaIx(payer: PublicKey, owner: PublicKey, mint: PublicKey) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    data: Buffer.from([1]), // CreateIdempotent
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedTokenAddress(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });
}

function mintToIx(mint: PublicKey, to: PublicKey, authority: PublicKey, amount: bigint) {
  const data = Buffer.alloc(9);
  data.writeUInt8(7, 0); // MintTo
  data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    data,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
  });
}

// ------------------------------------------------------------------ seams

/** Keys for the demo's entities. A real run gets these from the wallet layer. */
class DemoKeyring implements OrgKeyring {
  readonly #keys = new Map<EntityId, Keypair>();
  readonly #reverse = new Map<string, EntityId>();

  add(entity: EntityId, keypair = Keypair.generate()): Keypair {
    this.#keys.set(entity, keypair);
    this.#reverse.set(keypair.publicKey.toBase58(), entity);
    return keypair;
  }

  keypair(entity: EntityId): Keypair {
    const key = this.#keys.get(entity);
    if (!key) throw new Error(`no wallet for "${entity}"`);
    return key;
  }

  async addressFor(entity: EntityId): Promise<PublicKey> {
    return this.keypair(entity).publicKey;
  }

  async signerFor(entity: EntityId): Promise<Signer> {
    return this.keypair(entity);
  }

  entityFor(address: PublicKey): EntityId | undefined {
    return this.#reverse.get(address.toBase58());
  }
}

/** Mints for the demo. A real run gets these from the token layer. */
class DemoMints implements OrgMintRegistry {
  readonly #mints = new Map<ResourceId, { mint: PublicKey; decimals: number }>();
  readonly #stake = new Map<EntityId, PublicKey>();

  set(resource: ResourceId, mint: PublicKey, decimals: number): void {
    this.#mints.set(resource, { mint, decimals });
  }

  setStakeMint(org: EntityId, mint: PublicKey): void {
    this.#stake.set(org, mint);
  }

  mintFor(resource: ResourceId): PublicKey {
    const entry = this.#mints.get(resource);
    if (!entry) throw new Error(`no mint for resource "${resource}"`);
    return entry.mint;
  }

  decimalsFor(resource: ResourceId): number {
    const entry = this.#mints.get(resource);
    if (!entry) throw new Error(`no mint for resource "${resource}"`);
    return entry.decimals;
  }

  equityMintFor(org: EntityId): PublicKey | null {
    return this.#stake.get(org) ?? null;
  }
}

// ------------------------------------------------------------------ world file

interface WorldFile {
  name: string;
  time?: { tickMs?: number };
  entityTypes?: { id: EntityTypeId }[];
  chain?: {
    currency?: ResourceId;
    tokens?: Record<ResourceId, { symbol: string; decimals?: number; initialSupply?: number }>;
  };
  organizations?: WorldOrganizationsSource['organizations'];
}

/**
 * Pick a second on-chain resource to trade against, for the escrow.
 *
 * Read out of the world's `chain.tokens`, in file order — never named. Both worlds
 * happen to declare several; the first that is not the treasury's own is the one.
 */
function tradeGoodOf(world: WorldFile, treasuryResource: ResourceId): ResourceId {
  const tokens = Object.keys(world.chain?.tokens ?? {});
  const other = tokens.find((r) => r !== treasuryResource);
  if (!other) throw new Error(`world "${world.name}" declares nothing to trade`);
  return other;
}

function decimalsOf(world: WorldFile, resource: ResourceId): number {
  return world.chain?.tokens?.[resource]?.decimals ?? 0;
}

// ------------------------------------------------------------------ the run

async function main(): Promise<void> {
  cluster = clusterFromEnv();
  const connection = connect(cluster);

  const root = resolve(new URL('../../..', import.meta.url).pathname);
  const requested = process.argv.slice(2);
  const worldPaths = (
    requested.length > 0
      ? requested
      : ['worlds/economic-sandbox.json', 'worlds/medieval-kingdom.json']
  ).map((p) => (p.startsWith('/') ? p : join(root, p)));

  banner('Agentic World — organizations on Solana', `${ORG_PROGRAM_ID.toBase58()}`);

  // Refuse to fake anything. If the chain is not there, say so and stop.
  let version: string;
  try {
    version = (await connection.getVersion())['solana-core'];
  } catch (error) {
    console.error(red('\n  No validator at ' + cluster.rpcUrl + '.'));
    console.error(dim('  Start one with: solana-test-validator --limit-ledger-size 50000000'));
    console.error(dim(`  (${error instanceof Error ? error.message : error})`));
    process.exit(1);
  }

  const deployed = await connection.getAccountInfo(ORG_PROGRAM_ID);
  if (!deployed?.executable) {
    console.error(red(`\n  The org program is not deployed at ${ORG_PROGRAM_ID.toBase58()}.`));
    console.error(
      dim('  cargo build-sbf --manifest-path programs/org/Cargo.toml --arch v3 && ' +
        'solana program deploy target/deploy/org.so --program-id target/deploy/org-keypair.json'),
    );
    process.exit(1);
  }

  line('validator', `${cluster.rpcUrl} (solana-core ${version})`);
  line('program', 'deployed, executable');
  try {
    const fromIdl = verifyAgainstIdl(join(root, 'target/idl/org.json'));
    line('idl', `discriminators agree; address ${fromIdl.toBase58()}`);
  } catch (error) {
    line('idl', dim(`not checked (${error instanceof Error ? error.message : error})`));
  }

  const payer = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(readFileSync(join(homedir(), '.config/solana/id.json'), 'utf8')) as number[],
    ),
  );
  line('payer', payer.publicKey.toBase58());
  line(
    'payer balance',
    `${(await connection.getBalance(payer.publicKey)) / 1e9} SOL`,
  );

  for (const path of worldPaths) {
    await runWorld(connection, payer, path);
  }

  banner('Done', 'Every signature above is a transaction on this validator.');
}

async function runWorld(connection: Connection, payer: Keypair, path: string): Promise<void> {
  const world = JSON.parse(readFileSync(path, 'utf8')) as WorldFile;
  const config = readOrganizations(world);
  if (config.definitions.length === 0) {
    console.log(dim(`\n  ${world.name} declares no organizations; skipping.`));
    return;
  }

  const sender = new TxSender(connection);
  const send: OrgContext['send'] = async (instructions, signers) => {
    // One signature per key, whatever the caller passed.
    const unique = new Map<string, Signer>();
    for (const s of signers) unique.set(s.publicKey.toBase58(), s as Signer);
    return sender.send(instructions, [...unique.values()]);
  };

  const keyring = new DemoKeyring();
  const mints = new DemoMints();
  const directory = new SequentialOrgDirectory();

  const definition = config.definitions[0]!;
  // A fresh slot per run. The PDA seed is `["treasury", world_id, org_index]`, so a
  // second run against the same validator would collide with the first — which is
  // correct behaviour for a world resuming, and useless for a demo. A world with
  // twenty organizations uses twenty slots; this one uses a random one.
  const slot = randomInt(0, 0x1_0000);
  const spec: OrgSpec = { ...definition, index: slot };
  // Entity ids are the world's own type names plus a number. No vocabulary here.
  const orgEntity: EntityId = `${spec.type}-1`;
  directory.register(orgEntity, spec.type, slot);

  banner(
    `${world.name} — one ${spec.type}`,
    `governance: ${spec.mechanism} · threshold ${spec.thresholdBps / 100}%` +
      `${spec.weightBy ? ` · weight by ${spec.weightBy}` : ''} · treasury in ${spec.treasuryResource}`,
  );

  // ---------------------------------------------------------------- genesis

  section('Genesis: mints, wallets, accounts');

  // Three members, so a threshold has something to bite on. A world that names
  // several member types gets one of each; a world that names one gets three of it.
  const memberTypes = spec.memberTypes.length > 0 ? spec.memberTypes : [spec.type];
  const seats = Math.max(3, memberTypes.length);
  const members: EntityId[] = Array.from(
    { length: seats },
    (_, i) => `${memberTypes[i % memberTypes.length]}-${i + 1}`,
  );
  const outsider: EntityId = `${memberTypes[0]}-outsider`;
  for (const entity of [...members, outsider]) keyring.add(entity);

  const treasuryResource = spec.treasuryResource;
  const tradeGood = tradeGoodOf(world, treasuryResource);
  const currencyMint = Keypair.generate();
  const goodMint = Keypair.generate();
  const equityMint = spec.equityToken ? Keypair.generate() : null;

  mints.set(treasuryResource, currencyMint.publicKey, decimalsOf(world, treasuryResource));
  mints.set(tradeGood, goodMint.publicKey, decimalsOf(world, tradeGood));
  if (equityMint) mints.setStakeMint(orgEntity, equityMint.publicKey);

  const rentMint = await connection.getMinimumBalanceForRentExemption(MINT_BYTES);
  const mintSetup: TransactionInstruction[] = [];
  const mintSigners: Signer[] = [payer];
  for (const [kp, decimals] of [
    [currencyMint, decimalsOf(world, treasuryResource)],
    [goodMint, decimalsOf(world, tradeGood)],
    ...(equityMint ? [[equityMint, spec.equityToken?.decimals ?? 0] as const] : []),
  ] as [Keypair, number][]) {
    mintSetup.push(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: kp.publicKey,
        lamports: rentMint,
        space: MINT_BYTES,
        programId: TOKEN_PROGRAM_ID,
      }),
      initializeMint2Ix(kp.publicKey, decimals, payer.publicKey),
    );
    mintSigners.push(kp);
  }
  tx(`${treasuryResource}/${tradeGood} mints`, await send(mintSetup, mintSigners));
  line(`${treasuryResource} mint`, currencyMint.publicKey.toBase58());
  line(`${tradeGood} mint`, goodMint.publicKey.toBase58());
  if (equityMint) line(`${spec.weightBy ?? 'stake'} mint`, equityMint.publicKey.toBase58());

  // Wallets that sign need lamports of their own: they pay rent for the accounts
  // they create (a proposal, a vote receipt, an escrow).
  const fund = [...members, outsider].map((entity) =>
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: keyring.keypair(entity).publicKey,
      lamports: 200_000_000,
    }),
  );
  tx('fund member wallets', await send(fund, [payer]));

  const atas: TransactionInstruction[] = [];
  for (const entity of [...members, outsider]) {
    const owner = keyring.keypair(entity).publicKey;
    atas.push(createAtaIx(payer.publicKey, owner, currencyMint.publicKey));
    atas.push(createAtaIx(payer.publicKey, owner, goodMint.publicKey));
    if (equityMint) atas.push(createAtaIx(payer.publicKey, owner, equityMint.publicKey));
  }
  tx('token accounts', await send(atas, [payer]));

  const currencyDecimals = decimalsOf(world, treasuryResource);
  const goodDecimals = decimalsOf(world, tradeGood);
  const endow: TransactionInstruction[] = [];
  for (const entity of [...members, outsider]) {
    const owner = keyring.keypair(entity).publicKey;
    endow.push(
      mintToIx(
        currencyMint.publicKey,
        associatedTokenAddress(owner, currencyMint.publicKey),
        payer.publicKey,
        BigInt(1_000 * 10 ** currencyDecimals),
      ),
      mintToIx(
        goodMint.publicKey,
        associatedTokenAddress(owner, goodMint.publicKey),
        payer.publicKey,
        BigInt(100 * 10 ** goodDecimals),
      ),
    );
  }
  tx('endow members', await send(endow, [payer]));

  // ---------------------------------------------------------------- treasury

  const ctx: OrgContext = {
    programId: ORG_PROGRAM_ID,
    world: config,
    directory,
    keyring,
    mints,
    authority: payer,
    genesisUnixMs: Date.now(),
    send,
    async now() {
      // The Clock sysvar, not this machine's clock. `unix_timestamp` sits 32 bytes
      // in, after slot, epoch_start_timestamp, epoch and leader_schedule_epoch.
      const info = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, cluster.commitment);
      if (!info) throw new Error('the validator has no clock sysvar');
      return Number(Buffer.from(info.data).readBigInt64LE(32));
    },
    async getAccount(address) {
      const info = await connection.getAccountInfo(address, cluster.commitment);
      return info ? Buffer.from(info.data) : null;
    },
    async getProgramAccounts(filters) {
      const found = await connection.getProgramAccounts(ORG_PROGRAM_ID, {
        commitment: cluster.commitment,
        filters: filters.map((f) => ({
          memcmp: { offset: f.offset, bytes: bs58(f.bytes) },
        })),
      });
      return found.map(({ pubkey, account }) => ({ pubkey, data: Buffer.from(account.data) }));
    },
  };

  const treasury = new SolanaTreasuryService(ctx);
  const governance = new SolanaGovernanceService(ctx);
  const escrow = new SolanaEscrowService(ctx, [treasuryResource, tradeGood]);

  section(`Treasury — a real token account at ["treasury", world_id, ${spec.index}]`);
  tx('open_treasury', await treasury.open(orgEntity, treasuryResource));
  account('treasury', treasuryPda(config.worldId, spec.index, ORG_PROGRAM_ID));
  account('org settings', orgPda(config.worldId, spec.index, ORG_PROGRAM_ID));

  const settings = await treasury.settings(orgEntity);
  line(
    'enforced on chain',
    `mechanism byte ${settings?.mechanism} (${await governance.mechanism(orgEntity)}), ` +
      `threshold ${((settings?.thresholdBps ?? 0) / 100).toFixed(1)}%`,
  );

  for (const [i, entity] of members.entries()) {
    tx(`deposit by ${entity}`, await treasury.deposit(orgEntity, entity, 100 * (i + 1)));
  }
  line('treasury balance', `${await treasury.balance(orgEntity)} ${treasuryResource}`);

  // ---------------------------------------------------------------- weight

  section(`Voting weight, from chain state — ${spec.mechanism}`);

  const weights = members.map((_, i) => (i + 1) * 100);
  if (equityMint) {
    // token_weighted: weight is a balance the voter holds. Nothing else counts.
    const issue = members.map((entity, i) =>
      mintToIx(
        equityMint.publicKey,
        associatedTokenAddress(keyring.keypair(entity).publicKey, equityMint.publicKey),
        payer.publicKey,
        BigInt(weights[i]!),
      ),
    );
    tx(`issue ${spec.weightBy ?? 'stake'}`, await send(issue, [payer]));
  } else {
    // Everything else: weight is a record only the org's authority can write.
    const orgKey = orgPda(config.worldId, spec.index, ORG_PROGRAM_ID);
    const records = members.map((entity, i) =>
      upsertMemberIx({
        programId: ORG_PROGRAM_ID,
        authority: payer.publicKey,
        org: orgKey,
        memberAuthority: keyring.keypair(entity).publicKey,
        weight: BigInt(weights[i]!),
        roles: ROLE_MEMBER | ROLE_COUNCIL | (i === members.length - 1 ? ROLE_LEADER : 0),
      }),
    );
    tx('upsert_member records', await send(records, [payer]));
  }
  for (const [i, entity] of members.entries()) {
    line(entity, `${weights[i]} ${spec.weightBy ?? 'votes'}`);
  }

  // ---------------------------------------------------------------- a vote that passes

  const totalWeight = weights.reduce((a, b) => a + b, 0);
  // Split the room so the outcome turns on the world's own threshold, not on luck:
  // the largest holder plus the smallest, against the middle.
  const forSide = members.filter((_, i) => i !== members.length - 2);
  const againstSide = members.filter((_, i) => i === members.length - 2);
  const weightFor = weights.filter((_, i) => i !== members.length - 2).reduce((a, b) => a + b, 0);

  section('Governance — a proposal that passes');
  const beneficiary = members[0]!;
  const grant = 120;
  // The world says how many ticks a vote stays open; that is the window, verbatim.
  const closesAtTick = spec.votingTicks;

  const passing = await governance.propose(
    orgEntity,
    members[members.length - 1]!,
    { kind: 'disburse', to: beneficiary, amount: grant },
    closesAtTick,
  );
  line('proposal', passing.id);
  line('asks', `${grant} ${treasuryResource} to ${beneficiary}`);
  console.log(`  ${dim(explorerUrl(cluster, 'address', passing.id))}`);

  for (const voter of forSide) {
    // The `weight` argument is a lie the port lets a caller tell. Tell a big one.
    tx(`${voter} votes for`, await governance.vote(passing.id, voter, true, 999_999));
  }
  for (const voter of againstSide) {
    tx(`${voter} votes against`, await governance.vote(passing.id, voter, false, 999_999));
  }

  const standing = await governance.standing(passing.id);
  line(
    'tally (chain)',
    `${standing.weightFor} for / ${standing.weightAgainst} against of ${totalWeight}`,
  );
  line(
    'the client asked for',
    dim('999,999 each — the chain ignored it and read the balances'),
  );
  line(
    'verdict',
    `${((Number(standing.weightFor) * 100) / (Number(standing.weightFor) + Number(standing.weightAgainst))).toFixed(1)}%` +
      ` vs ${(standing.thresholdBps / 100).toFixed(1)}% required → ` +
      (standing.passing ? green('passes') : red('fails')),
  );
  if (Number(standing.weightFor) !== weightFor) {
    console.log(red(`  tally disagrees with the issued weights (${weightFor} expected)`));
    process.exitCode = 1;
  }

  section('The decision becomes a transaction');
  const before = await treasury.balance(orgEntity);
  const recipientAta = associatedTokenAddress(
    keyring.keypair(beneficiary).publicKey,
    currencyMint.publicKey,
  );
  const recipientBefore = await balanceOf(connection, recipientAta);

  await mustFail('finalize before the vote closes', () =>
    governance.finalize(passing.id, closesAtTick),
  );
  await waitUntil(ctx, standing.closesAt);

  const signature = await governance.finalize(passing.id, closesAtTick);
  if (!signature) throw new Error('a passing disbursement did not execute');
  tx('finalize + transfer', signature);

  const after = await treasury.balance(orgEntity);
  const recipientAfter = await balanceOf(connection, recipientAta);
  line('treasury', `${before} → ${after} ${treasuryResource}`);
  line(
    beneficiary,
    `${recipientBefore / 10 ** currencyDecimals} → ` +
      `${recipientAfter / 10 ** currencyDecimals} ${treasuryResource}`,
  );
  account('recipient account', recipientAta);
  if (before - after !== grant) {
    console.log(red(`  the treasury moved ${before - after}, not ${grant}`));
    process.exitCode = 1;
  }

  // ---------------------------------------------------------------- a vote that fails

  section('Governance — the same machinery, a proposal that fails');
  const failing = await governance.propose(
    orgEntity,
    members[0]!,
    { kind: 'disburse', to: outsider, amount: grant },
    closesAtTick * 2,
  );
  line('proposal', failing.id);
  // Only the smallest holder supports it; everyone else objects.
  tx(`${members[0]} votes for`, await governance.vote(failing.id, members[0]!, true, 999_999));
  for (const voter of members.slice(1)) {
    tx(`${voter} votes against`, await governance.vote(failing.id, voter, false, 999_999));
  }
  const lost = await governance.standing(failing.id);
  line(
    'tally (chain)',
    `${lost.weightFor} for / ${lost.weightAgainst} against → ` +
      (lost.passing ? green('passes') : red('fails')) +
      ` at ${(lost.thresholdBps / 100).toFixed(1)}%`,
  );

  await waitUntil(ctx, lost.closesAt);
  const nothing = await governance.finalize(failing.id, closesAtTick * 2);
  line('finalize returned', nothing === null ? green('null — nothing moved') : red(nothing));
  line('treasury', `${await treasury.balance(orgEntity)} ${treasuryResource} (unchanged)`);

  // ---------------------------------------------------------------- attacks

  section('What the chain refuses');

  // A proposal nobody will vote for, to try to rob the treasury with.
  const fresh = await governance.propose(
    orgEntity,
    members[0]!,
    { kind: 'disburse', to: outsider, amount: 50 },
    closesAtTick,
  );

  // While it is open: the two ways of voting weight you do not have.
  await mustFail('voting with somebody else’s weight account', () =>
    voteWithForeignWeight(ctx, spec, fresh.id, outsider, members[members.length - 1]!, equityMint),
  );
  await mustFail('an unlisted outsider voting at all', () =>
    governance.vote(fresh.id, outsider, true, 1),
  );
  await mustFail('the same voter voting twice', () =>
    governance.vote(passing.id, forSide[0]!, true, 1),
  );

  // And once it has closed with a tally of nothing, the treasury stays shut.
  await waitUntil(ctx, (await governance.standing(fresh.id)).closesAt);
  await mustFail('disburse straight from the program, past the tally', async () =>
    send([await rawDisburse(ctx, spec, fresh.id, recipientAta)], [payer]),
  );
  await mustFail('disburse through the service, with no votes at all', () =>
    treasury.disburse(orgEntity, outsider, 50, fresh.id),
  );
  await mustFail('finalizing a proposal nobody voted on into a payment', async () => {
    const paid = await governance.finalize(fresh.id, closesAtTick);
    if (paid === null) throw new Error('finalize moved nothing: the tally did not pass');
    return paid;
  });
  line('treasury', `${await treasury.balance(orgEntity)} ${treasuryResource} (still)`);

  // ---------------------------------------------------------------- escrow

  section(`Escrow — ${treasuryResource} for ${tradeGood}, atomically`);
  const maker = members[0]!;
  const taker = members[1] ?? outsider;
  const offer = { give: { resource: tradeGood, amount: 10 }, want: { resource: treasuryResource, amount: 40 } };

  const escrowId = await escrow.create(maker, taker, offer.give, offer.want);
  tx('create_escrow', escrow.signatures.get(escrowId)!);
  account('escrow', new PublicKey(escrowId));
  account('vault (holds the goods)', escrow.vaultOf(escrowId));
  line('terms', `${offer.give.amount} ${tradeGood} for ${offer.want.amount} ${treasuryResource}`);

  await mustFail('a stranger cancelling the maker’s escrow', () =>
    escrow.cancel(escrowId, outsider),
  );
  await mustFail('…and the same cancel, straight at the program', () =>
    rawCancel(ctx, escrowId, outsider, goodMint.publicKey),
  );
  await mustFail('a taker who cannot pay taking the goods', () =>
    acceptWithEmptyPurse(ctx, escrowId, currencyMint.publicKey, goodMint.publicKey, payer),
  );

  const takerGoodBefore = await balanceOf(
    connection,
    associatedTokenAddress(keyring.keypair(taker).publicKey, goodMint.publicKey),
  );
  const makerCashBefore = await balanceOf(
    connection,
    associatedTokenAddress(keyring.keypair(maker).publicKey, currencyMint.publicKey),
  );
  tx('accept_escrow', await escrow.accept(escrowId, taker));
  const takerGoodAfter = await balanceOf(
    connection,
    associatedTokenAddress(keyring.keypair(taker).publicKey, goodMint.publicKey),
  );
  const makerCashAfter = await balanceOf(
    connection,
    associatedTokenAddress(keyring.keypair(maker).publicKey, currencyMint.publicKey),
  );
  line(
    `${taker} ${tradeGood}`,
    `${takerGoodBefore / 10 ** goodDecimals} → ${takerGoodAfter / 10 ** goodDecimals}`,
  );
  line(
    `${maker} ${treasuryResource}`,
    `${makerCashBefore / 10 ** currencyDecimals} → ${makerCashAfter / 10 ** currencyDecimals}`,
  );
  line('both legs', green('one instruction, one signature'));

  const cancelled = await escrow.create(maker, taker, offer.give, offer.want);
  tx('create_escrow (to cancel)', escrow.signatures.get(cancelled)!);
  tx('cancel_escrow', await escrow.cancel(cancelled, maker));
  line('refunded', `${offer.give.amount} ${tradeGood} back to ${maker}`);
  line('escrow account', (await escrow.terms(cancelled)) === null ? green('closed') : red('still open'));
}

// ------------------------------------------------------------------ attack helpers

/**
 * The raw `disburse` instruction, with no service-level check in front of it — the
 * attack the treasury exists to survive. It reaches the program, and the program
 * refuses it.
 */
async function rawDisburse(
  ctx: OrgContext,
  spec: OrgSpec,
  proposalId: string,
  recipientAta: PublicKey,
): Promise<TransactionInstruction> {
  const { disburseIx } = await import('../src/org-program.ts');
  return disburseIx({
    programId: ctx.programId,
    caller: ctx.authority.publicKey,
    org: orgPda(ctx.world.worldId, spec.index, ctx.programId),
    proposal: new PublicKey(proposalId),
    treasury: treasuryPda(ctx.world.worldId, spec.index, ctx.programId),
    recipientTokenAccount: recipientAta,
  });
}

/** A voter pointing the weight account at the biggest holder's balance. */
async function voteWithForeignWeight(
  ctx: OrgContext,
  spec: OrgSpec,
  proposalId: string,
  voter: EntityId,
  victim: EntityId,
  equityMint: Keypair | null,
): Promise<string> {
  const { castVoteIx, memberPda } = await import('../src/org-program.ts');
  const orgKey = orgPda(ctx.world.worldId, spec.index, ctx.programId);
  const attacker = await ctx.keyring.signerFor(voter);
  const victimKey = await ctx.keyring.addressFor(victim);

  return ctx.send(
    [
      castVoteIx({
        programId: ctx.programId,
        voter: attacker.publicKey,
        org: orgKey,
        proposal: new PublicKey(proposalId),
        support: true,
        weightTokenAccount: equityMint
          ? associatedTokenAddress(victimKey, equityMint.publicKey)
          : null,
        member: equityMint ? null : memberPda(orgKey, victimKey, ctx.programId),
      }),
    ],
    [ctx.authority, attacker],
  );
}

/**
 * A cancel signed by somebody who is not the maker, with no client-side check in
 * the way. The account constraint catches it.
 */
async function rawCancel(
  ctx: OrgContext,
  escrowId: string,
  stranger: EntityId,
  giveMint: PublicKey,
): Promise<string> {
  const { cancelEscrowIx, vaultPda } = await import('../src/org-program.ts');
  const escrow = new PublicKey(escrowId);
  const thief = await ctx.keyring.signerFor(stranger);
  return ctx.send(
    [
      cancelEscrowIx({
        programId: ctx.programId,
        maker: thief.publicKey,
        escrow,
        vault: vaultPda(escrow, ctx.programId),
        makerGiveAccount: associatedTokenAddress(thief.publicKey, giveMint),
      }),
    ],
    [ctx.authority, thief],
  );
}

/** A taker with an empty purse reaching for the vault. */
async function acceptWithEmptyPurse(
  ctx: OrgContext,
  escrowId: string,
  currencyMint: PublicKey,
  goodMint: PublicKey,
  payer: Keypair,
): Promise<string> {
  const { acceptEscrowIx, decodeEscrow, vaultPda } = await import('../src/org-program.ts');
  const pauper = Keypair.generate();
  const escrow = new PublicKey(escrowId);
  const data = await ctx.getAccount(escrow);
  if (!data) throw new Error('escrow vanished');
  const account = decodeEscrow(data);

  await ctx.send(
    [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: pauper.publicKey,
        lamports: 50_000_000,
      }),
      createAtaIx(payer.publicKey, pauper.publicKey, currencyMint),
      createAtaIx(payer.publicKey, pauper.publicKey, goodMint),
    ],
    [payer],
  );

  return ctx.send(
    [
      acceptEscrowIx({
        programId: ctx.programId,
        taker: pauper.publicKey,
        escrow,
        maker: account.maker,
        vault: vaultPda(escrow, ctx.programId),
        takerPaymentAccount: associatedTokenAddress(pauper.publicKey, account.wantMint),
        makerReceiveAccount: associatedTokenAddress(account.maker, account.wantMint),
        takerReceiveAccount: associatedTokenAddress(pauper.publicKey, account.giveMint),
      }),
    ],
    [payer, pauper],
  );
}

// ------------------------------------------------------------------ small things

async function balanceOf(connection: Connection, address: PublicKey): Promise<number> {
  const info = await connection.getAccountInfo(address);
  if (!info || info.data.length < TOKEN_ACCOUNT_BYTES) return 0;
  return Number(decodeTokenAccount(Buffer.from(info.data)).amount);
}

/**
 * Wait for the chain's own clock to pass a deadline.
 *
 * Polls the Clock sysvar rather than sleeping for the difference. A local validator
 * keeps its own time and it drifts from the wall clock; sleeping the arithmetic
 * difference is how a demo ends up finalizing a vote the program still thinks is
 * open.
 */
async function waitUntil(ctx: OrgContext, unixSeconds: number): Promise<void> {
  let now = await ctx.now();
  if (now > unixSeconds) return;
  console.log(
    dim(`  … waiting ${unixSeconds - now + 1}s of chain time for the voting window to close`),
  );
  while (now <= unixSeconds) {
    await new Promise((r) => setTimeout(r, 500));
    now = await ctx.now();
  }
}

/** base58, for `getProgramAccounts` memcmp filters, which take strings. */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bs58(bytes: Buffer): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let out = '';
  while (value > 0n) {
    out = B58[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out || '1';
}

main().catch((error) => {
  console.error(red(`\n  ${error instanceof Error ? error.stack : String(error)}`));
  process.exit(1);
});
