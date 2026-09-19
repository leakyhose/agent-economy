/**
 * The `org` program's byte layout, mirrored by hand.
 *
 * Anchor's JavaScript coder caps instruction data near 1,000 bytes and pulls in the
 * whole IDL machinery to do it, so — as with `program.ts` and the world ledger —
 * nothing here goes through it. Every instruction is plain Borsh behind the
 * eight-byte discriminator, and every account is decoded by arithmetic. That means
 * this file and `programs/org/src/lib.rs` must agree byte for byte; the Rust test
 * `account_sizes_match_what_the_client_decodes` pins the account side and
 * {@link verifyAgainstIdl} pins the instruction side whenever the build artifacts
 * are present.
 *
 * Nothing in this file names a world. What an organization is called, what its
 * members are called and what their weight is drawn from all arrive as data through
 * {@link readOrganizations}, which reads them out of the world file it is handed.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
  type AccountMeta,
} from '@solana/web3.js';
import type {
  EntityId,
  EntityTypeId,
  GovernanceMechanism,
  ResourceId,
  TokenSpec,
} from '@aw/types';

// ------------------------------------------------------------------ addresses

/**
 * The deployed `org` program. Matches `declare_id!` in `programs/org/src/lib.rs`
 * and `target/deploy/org-keypair.json`; `AW_ORG_PROGRAM_ID` overrides it for a
 * redeploy under a different key.
 */
export const ORG_PROGRAM_ID = new PublicKey(
  process.env['AW_ORG_PROGRAM_ID'] ?? '75xzyWGNtgiB6cKtTFnZE7giPpUuyap2V6KJxu5rsaF',
);

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);

/** SPL token account and mint sizes, for rent exemption and decoding. */
export const TOKEN_ACCOUNT_BYTES = 165;
export const MINT_BYTES = 82;

/** The associated token account of `owner` for `mint`. */
export function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

// ------------------------------------------------------------------ vocabulary

/**
 * The six mechanisms of `GovernanceMechanism`, in declaration order. The index is
 * the byte the program stores.
 *
 * This array is the entire mapping from a world's governance wording to the chain.
 * A world says `"token_weighted"` or `"council"`; nothing downstream of here knows
 * which world said which.
 */
export const MECHANISMS: readonly GovernanceMechanism[] = [
  'leader',
  'majority_vote',
  'token_weighted',
  'reputation_weighted',
  'council',
  'consensus',
] as const;

export function mechanismByte(mechanism: GovernanceMechanism): number {
  const byte = MECHANISMS.indexOf(mechanism);
  if (byte < 0) throw new Error(`unknown governance mechanism "${mechanism}"`);
  return byte;
}

export function mechanismName(byte: number): GovernanceMechanism {
  const name = MECHANISMS[byte];
  if (!name) throw new Error(`no governance mechanism has byte ${byte}`);
  return name;
}

/** Proposal kinds, matching the `kind` module in the program. */
export const KIND_DISBURSE = 0;
export const KIND_SIGNAL = 1;

/** Bits in `Member.roles`, matching the `roles` module in the program. */
export const ROLE_MEMBER = 1 << 0;
export const ROLE_COUNCIL = 1 << 1;
export const ROLE_LEADER = 1 << 2;

/**
 * A world threshold (0..1) as basis points. Default 0.5, per `GovernanceDef`.
 *
 * Rounded, not truncated, so 0.6 is 6,000 and not 5,999 — the difference decides
 * votes that land exactly on the line.
 */
export function thresholdBps(threshold?: number): number {
  const fraction = threshold ?? 0.5;
  if (!(fraction >= 0 && fraction <= 1)) {
    throw new Error(`governance threshold must be between 0 and 1, got ${fraction}`);
  }
  return Math.round(fraction * 10_000);
}

/**
 * Does a tally clear its threshold? The same arithmetic as `proposal_passed` in the
 * program, so a client can predict the chain's answer without asking it.
 */
export function proposalPasses(
  weightFor: bigint,
  weightAgainst: bigint,
  bps: number,
  mechanism: number,
): boolean {
  const total = weightFor + weightAgainst;
  if (total === 0n || weightFor === 0n) return false;
  if (mechanism === mechanismByte('leader')) return weightFor > weightAgainst;
  if (mechanism === mechanismByte('consensus')) return weightAgainst === 0n;
  return weightFor * 10_000n >= total * BigInt(bps);
}

// ------------------------------------------------------------------ world config

/** One organization instance's on-chain settings, read out of a world file. */
export interface OrgSpec {
  /** Position of the `OrganizationDef` this org follows. */
  definition: number;
  /** Slot in the treasury PDA seed. Unique per organization, not per definition. */
  index: number;
  /** The world's entity type for this organization. Opaque here. */
  type: EntityTypeId;
  memberTypes: EntityTypeId[];
  treasuryResource: ResourceId;
  mechanism: GovernanceMechanism;
  mechanismByte: number;
  thresholdBps: number;
  votingTicks: number;
  /** The world's name for what weight is drawn from. Never interpreted here. */
  weightBy?: string;
  equityToken?: TokenSpec;
}

/** Everything the org layer needs from a world file, and nothing else. */
export interface OrgWorldConfig {
  name: string;
  /** 32 bytes identifying the world; the middle seed of every treasury PDA. */
  worldId: Buffer;
  tickMs: number;
  /** One per `OrganizationDef`, in file order. */
  definitions: Omit<OrgSpec, 'index'>[];
}

/** The shape `readOrganizations` reads. A `WorldDefinition` satisfies it. */
export interface WorldOrganizationsSource {
  name: string;
  time?: { tickMs?: number };
  organizations?: {
    type: EntityTypeId;
    memberTypes?: EntityTypeId[];
    treasuryResource?: ResourceId;
    governance?: {
      mechanism: GovernanceMechanism;
      threshold?: number;
      votingTicks?: number;
      weightBy?: string;
    };
    equityToken?: TokenSpec;
  }[];
}

/** A world's identity on chain: the first 32 bytes of sha256 over its name. */
export function worldIdOf(name: string): Buffer {
  return createHash('sha256').update(name).digest();
}

/**
 * Turn a world file's `organizations` block into chain settings.
 *
 * This is the only place a governance mechanism crosses from a world's wording into
 * a byte the program understands, and it is the reason one program can run an
 * organization on `token_weighted` at 0.5 and another on `council` at 0.6 without a
 * line of code knowing which is which (brief §18).
 */
export function readOrganizations(world: WorldOrganizationsSource): OrgWorldConfig {
  const definitions = (world.organizations ?? []).map((def, i) => {
    const governance = def.governance;
    if (!governance) {
      throw new Error(`organization ${i} of "${world.name}" declares no governance`);
    }
    if (!def.treasuryResource) {
      throw new Error(`organization ${i} of "${world.name}" declares no treasuryResource`);
    }
    const spec: Omit<OrgSpec, 'index'> = {
      definition: i,
      type: def.type,
      memberTypes: def.memberTypes ?? [],
      treasuryResource: def.treasuryResource,
      mechanism: governance.mechanism,
      mechanismByte: mechanismByte(governance.mechanism),
      thresholdBps: thresholdBps(governance.threshold),
      votingTicks: governance.votingTicks ?? 1,
    };
    if (governance.weightBy !== undefined) spec.weightBy = governance.weightBy;
    if (def.equityToken !== undefined) spec.equityToken = def.equityToken;
    return spec;
  });

  return {
    name: world.name,
    worldId: worldIdOf(world.name),
    tickMs: world.time?.tickMs ?? 1_000,
    definitions,
  };
}

/**
 * Ticks are the simulation's clock; the chain only has `Clock::unix_timestamp`.
 *
 * A voting window has to be enforceable by the program without trusting anybody's
 * word for what tick it is, so the tick count a world declares is converted here
 * into a wall-clock deadline and the program compares against its own clock.
 */
export function tickToUnixSeconds(tick: number, tickMs: number, genesisUnixMs: number): number {
  return Math.floor((genesisUnixMs + tick * tickMs) / 1_000);
}

export function unixSecondsToTick(unix: number, tickMs: number, genesisUnixMs: number): number {
  return Math.round((unix * 1_000 - genesisUnixMs) / tickMs);
}

// ------------------------------------------------------------------ seams
//
// Narrow local interfaces, deliberately. The wallet, token and registry modules of
// this package are being written alongside this one; depending on their shapes now
// would couple three tracks together for the sake of two method signatures.

/** Public keys and signatures for world entities. Implemented by the wallet layer. */
export interface OrgKeyring {
  addressFor(entity: EntityId): Promise<PublicKey>;
  /** Anything that can sign for `entity`. Key material never leaves the wallet. */
  signerFor(entity: EntityId): Promise<{ publicKey: PublicKey; secretKey: Uint8Array }>;
  /** The reverse lookup, for decoding chain state back into world terms. */
  entityFor(address: PublicKey): EntityId | undefined;
}

/** Which SPL mint stands for which world resource. Implemented by the token layer. */
export interface OrgMintRegistry {
  mintFor(resource: ResourceId): PublicKey;
  decimalsFor(resource: ResourceId): number;
  /**
   * The per-organization stake mint, when the world declares an `equityToken`.
   * `token_weighted` governance counts balances of this mint and nothing else.
   * Null for a world whose organizations issue no stake.
   */
  equityMintFor(org: EntityId): PublicKey | null;
}

/**
 * Which organization is which.
 *
 * A treasury's PDA is keyed by a slot number, so something has to say that this
 * organization entity owns slot 3. That is bookkeeping the simulation owns, not the
 * chain, so it comes in through this seam rather than being invented here.
 */
export interface OrgDirectory {
  /** The world entity type of an organization, used to pick its governance rules. */
  typeOf(org: EntityId): EntityTypeId;
  /** A stable slot for this organization, 0..65535. */
  indexOf(org: EntityId): number;
  /** Every organization known so far. */
  organizations(): EntityId[];
}

/**
 * The obvious {@link OrgDirectory}: slots handed out in first-seen order.
 *
 * Fine for a run that starts from genesis, which is every run today. A world that
 * resumes from a snapshot hands the saved assignments to the constructor.
 */
export class SequentialOrgDirectory implements OrgDirectory {
  readonly #types = new Map<EntityId, EntityTypeId>();
  readonly #slots = new Map<EntityId, number>();
  #next = 0;

  constructor(seed: Iterable<{ org: EntityId; type: EntityTypeId; index?: number }> = []) {
    for (const entry of seed) this.register(entry.org, entry.type, entry.index);
  }

  register(org: EntityId, type: EntityTypeId, index?: number): number {
    this.#types.set(org, type);
    const existing = this.#slots.get(org);
    if (existing !== undefined) return existing;
    const slot = index ?? this.#next;
    if (slot > 0xffff) throw new Error(`organization slot ${slot} does not fit in a u16`);
    this.#slots.set(org, slot);
    this.#next = Math.max(this.#next, slot + 1);
    return slot;
  }

  typeOf(org: EntityId): EntityTypeId {
    const type = this.#types.get(org);
    if (type === undefined) throw new Error(`organization "${org}" is not registered`);
    return type;
  }

  indexOf(org: EntityId): number {
    const slot = this.#slots.get(org);
    if (slot === undefined) throw new Error(`organization "${org}" has no treasury slot`);
    return slot;
  }

  organizations(): EntityId[] {
    return [...this.#slots.keys()];
  }
}

/**
 * What the three services share: a connection, a way to land a transaction, and the
 * four seams above. Built once per world and handed to each service.
 */
export interface OrgContext {
  programId: PublicKey;
  world: OrgWorldConfig;
  directory: OrgDirectory;
  keyring: OrgKeyring;
  mints: OrgMintRegistry;
  /** Pays rent and signs org-authority instructions. */
  authority: { publicKey: PublicKey; secretKey: Uint8Array };
  /** Tick zero, as wall-clock milliseconds. Fixes the tick-to-clock conversion. */
  genesisUnixMs: number;
  send(
    instructions: readonly TransactionInstruction[],
    signers: readonly { publicKey: PublicKey; secretKey: Uint8Array }[],
  ): Promise<string>;
  /**
   * The chain's own clock, in unix seconds.
   *
   * Not `Date.now()`. Voting windows are enforced by the program against
   * `Clock::unix_timestamp`, and a validator — a local one especially — does not
   * keep wall-clock time. A window measured against the wrong clock either opens
   * late or closes early, and both look like a bug in the governance.
   */
  now(): Promise<number>;
  getAccount(address: PublicKey): Promise<Buffer | null>;
  getProgramAccounts(filters: { offset: number; bytes: Buffer }[]): Promise<
    { pubkey: PublicKey; data: Buffer }[]
  >;
}

/** The governance rules that apply to an organization, by its world entity type. */
export function specFor(ctx: OrgContext, org: EntityId): OrgSpec {
  const type = ctx.directory.typeOf(org);
  const definition = ctx.world.definitions.find((d) => d.type === type);
  if (!definition) {
    throw new Error(
      `world "${ctx.world.name}" declares no organization of type "${type}"`,
    );
  }
  return { ...definition, index: ctx.directory.indexOf(org) };
}

// ------------------------------------------------------------------ addresses

function u16le(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value);
  return b;
}

function u64le(value: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return b;
}

export function orgPda(worldId: Buffer, index: number, programId = ORG_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('org'), worldId, u16le(index)],
    programId,
  )[0];
}

/** The treasury: seeds `["treasury", world_id, org_index]`, per brief §16. */
export function treasuryPda(
  worldId: Buffer,
  index: number,
  programId = ORG_PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('treasury'), worldId, u16le(index)],
    programId,
  )[0];
}

export function proposalPda(
  treasury: PublicKey,
  nonce: bigint | number,
  programId = ORG_PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('proposal'), treasury.toBuffer(), u64le(nonce)],
    programId,
  )[0];
}

export function votePda(
  proposal: PublicKey,
  voter: PublicKey,
  programId = ORG_PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vote'), proposal.toBuffer(), voter.toBuffer()],
    programId,
  )[0];
}

export function memberPda(
  org: PublicKey,
  authority: PublicKey,
  programId = ORG_PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('member'), org.toBuffer(), authority.toBuffer()],
    programId,
  )[0];
}

export function escrowPda(
  maker: PublicKey,
  escrowId: bigint,
  programId = ORG_PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('escrow'), maker.toBuffer(), u64le(escrowId)],
    programId,
  )[0];
}

export function vaultPda(escrow: PublicKey, programId = ORG_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), escrow.toBuffer()],
    programId,
  )[0];
}

// ------------------------------------------------------------------ discriminators

/** Anchor's global discriminator: `sha256("global:<snake_case_name>")[..8]`. */
export function discriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

/** Anchor's account discriminator: `sha256("account:<PascalName>")[..8]`. */
export function accountDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
}

export const ORG_DISC = {
  open_treasury: discriminator('open_treasury'),
  deposit: discriminator('deposit'),
  upsert_member: discriminator('upsert_member'),
  create_proposal: discriminator('create_proposal'),
  cast_vote: discriminator('cast_vote'),
  finalize: discriminator('finalize'),
  disburse: discriminator('disburse'),
  create_escrow: discriminator('create_escrow'),
  accept_escrow: discriminator('accept_escrow'),
  cancel_escrow: discriminator('cancel_escrow'),
} as const;

export const ACCOUNT_DISC = {
  Org: accountDiscriminator('Org'),
  Member: accountDiscriminator('Member'),
  Proposal: accountDiscriminator('Proposal'),
  VoteReceipt: accountDiscriminator('VoteReceipt'),
  Escrow: accountDiscriminator('Escrow'),
} as const;

/**
 * Cross-check the hand-computed discriminators and program address against
 * `target/idl/org.json`, if the build artifacts are there.
 *
 * Renaming an instruction in the Rust would otherwise desynchronise this file
 * silently: the transaction would be well-formed and land on the wrong handler, or
 * on none. Returns the address the IDL claims so a caller can prefer it.
 */
export function verifyAgainstIdl(path: string): PublicKey {
  const idl = JSON.parse(readFileSync(path, 'utf8')) as {
    address: string;
    instructions: { name: string; discriminator: number[] }[];
    accounts?: { name: string; discriminator: number[] }[];
  };
  for (const ix of idl.instructions) {
    const ours = ORG_DISC[ix.name as keyof typeof ORG_DISC];
    if (!ours) continue;
    if (!ours.equals(Buffer.from(ix.discriminator))) {
      throw new Error(`discriminator mismatch for instruction "${ix.name}"`);
    }
  }
  for (const account of idl.accounts ?? []) {
    const ours = ACCOUNT_DISC[account.name as keyof typeof ACCOUNT_DISC];
    if (!ours) continue;
    if (!ours.equals(Buffer.from(account.discriminator))) {
      throw new Error(`discriminator mismatch for account "${account.name}"`);
    }
  }
  return new PublicKey(idl.address);
}

// ------------------------------------------------------------------ decoding

/** Byte offsets into each account, discriminator included. */
export const ORG_OFF = {
  authority: 8,
  worldId: 40,
  orgIndex: 72,
  mint: 74,
  treasury: 106,
  weightMint: 138,
  mechanism: 170,
  thresholdBps: 171,
  totalWeight: 173,
  memberCount: 181,
  proposalNonce: 185,
  bump: 193,
  treasuryBump: 194,
} as const;
export const ORG_BYTES = 195;

export const PROPOSAL_OFF = {
  org: 8,
  proposer: 40,
  kind: 72,
  recipient: 73,
  amount: 105,
  opensAt: 113,
  closesAt: 121,
  weightFor: 129,
  weightAgainst: 137,
  thresholdBps: 145,
  mechanism: 147,
  executed: 148,
} as const;
export const PROPOSAL_BYTES = 149;

export const MEMBER_BYTES = 82;
export const VOTE_RECEIPT_BYTES = 82;
export const ESCROW_BYTES = 161;

export interface OrgAccount {
  authority: PublicKey;
  worldId: Buffer;
  orgIndex: number;
  mint: PublicKey;
  treasury: PublicKey;
  weightMint: PublicKey;
  mechanism: number;
  thresholdBps: number;
  totalWeight: bigint;
  memberCount: number;
  proposalNonce: bigint;
}

export function decodeOrg(data: Buffer): OrgAccount {
  expect(data, ORG_BYTES, ACCOUNT_DISC.Org, 'Org');
  return {
    authority: key(data, ORG_OFF.authority),
    worldId: data.subarray(ORG_OFF.worldId, ORG_OFF.worldId + 32),
    orgIndex: data.readUInt16LE(ORG_OFF.orgIndex),
    mint: key(data, ORG_OFF.mint),
    treasury: key(data, ORG_OFF.treasury),
    weightMint: key(data, ORG_OFF.weightMint),
    mechanism: data.readUInt8(ORG_OFF.mechanism),
    thresholdBps: data.readUInt16LE(ORG_OFF.thresholdBps),
    totalWeight: data.readBigUInt64LE(ORG_OFF.totalWeight),
    memberCount: data.readUInt32LE(ORG_OFF.memberCount),
    proposalNonce: data.readBigUInt64LE(ORG_OFF.proposalNonce),
  };
}

export interface ProposalAccount {
  org: PublicKey;
  proposer: PublicKey;
  kind: number;
  recipient: PublicKey;
  amount: bigint;
  opensAt: bigint;
  closesAt: bigint;
  weightFor: bigint;
  weightAgainst: bigint;
  thresholdBps: number;
  mechanism: number;
  executed: boolean;
}

export function decodeProposal(data: Buffer): ProposalAccount {
  expect(data, PROPOSAL_BYTES, ACCOUNT_DISC.Proposal, 'Proposal');
  return {
    org: key(data, PROPOSAL_OFF.org),
    proposer: key(data, PROPOSAL_OFF.proposer),
    kind: data.readUInt8(PROPOSAL_OFF.kind),
    recipient: key(data, PROPOSAL_OFF.recipient),
    amount: data.readBigUInt64LE(PROPOSAL_OFF.amount),
    opensAt: data.readBigUInt64LE(PROPOSAL_OFF.opensAt),
    closesAt: data.readBigUInt64LE(PROPOSAL_OFF.closesAt),
    weightFor: data.readBigUInt64LE(PROPOSAL_OFF.weightFor),
    weightAgainst: data.readBigUInt64LE(PROPOSAL_OFF.weightAgainst),
    thresholdBps: data.readUInt16LE(PROPOSAL_OFF.thresholdBps),
    mechanism: data.readUInt8(PROPOSAL_OFF.mechanism),
    executed: data.readUInt8(PROPOSAL_OFF.executed) === 1,
  };
}

export interface MemberAccount {
  org: PublicKey;
  authority: PublicKey;
  weight: bigint;
  roles: number;
}

export function decodeMember(data: Buffer): MemberAccount {
  expect(data, MEMBER_BYTES, ACCOUNT_DISC.Member, 'Member');
  return {
    org: key(data, 8),
    authority: key(data, 40),
    weight: data.readBigUInt64LE(72),
    roles: data.readUInt8(80),
  };
}

export interface EscrowAccount {
  maker: PublicKey;
  escrowId: bigint;
  giveMint: PublicKey;
  wantMint: PublicKey;
  giveAmount: bigint;
  wantAmount: bigint;
  vault: PublicKey;
}

export function decodeEscrow(data: Buffer): EscrowAccount {
  expect(data, ESCROW_BYTES, ACCOUNT_DISC.Escrow, 'Escrow');
  return {
    maker: key(data, 8),
    escrowId: data.readBigUInt64LE(40),
    giveMint: key(data, 48),
    wantMint: key(data, 80),
    giveAmount: data.readBigUInt64LE(112),
    wantAmount: data.readBigUInt64LE(120),
    vault: key(data, 128),
  };
}

/** An SPL token account, decoded. The layout is fixed, so this is arithmetic too. */
export function decodeTokenAccount(data: Buffer): {
  mint: PublicKey;
  owner: PublicKey;
  amount: bigint;
} {
  if (data.length < TOKEN_ACCOUNT_BYTES) {
    throw new Error(`token account is ${data.length} bytes; expected ${TOKEN_ACCOUNT_BYTES}`);
  }
  return {
    mint: key(data, 0),
    owner: key(data, 32),
    amount: data.readBigUInt64LE(64),
  };
}

function key(data: Buffer, offset: number): PublicKey {
  return new PublicKey(data.subarray(offset, offset + 32));
}

function expect(data: Buffer, size: number, disc: Buffer, name: string): void {
  if (data.length < size) {
    throw new Error(`${name} account is ${data.length} bytes; expected ${size}`);
  }
  if (!data.subarray(0, 8).equals(disc)) {
    throw new Error(`account is not an ${name}: wrong discriminator`);
  }
}

// ------------------------------------------------------------------ instructions

function meta(pubkey: PublicKey, isSigner: boolean, isWritable: boolean): AccountMeta {
  return { pubkey, isSigner, isWritable };
}

/**
 * Anchor represents an absent `Option<Account>` by the program's own id in that
 * position. Passing nothing would shift every account after it.
 */
function optional(pubkey: PublicKey | null, programId: PublicKey, writable = false): AccountMeta {
  return pubkey ? meta(pubkey, false, writable) : meta(programId, false, false);
}

export interface OpenTreasuryArgs {
  programId: PublicKey;
  authority: PublicKey;
  worldId: Buffer;
  orgIndex: number;
  mint: PublicKey;
  weightMint: PublicKey | null;
  mechanism: number;
  thresholdBps: number;
}

/** `open_treasury(world_id: [u8; 32], org_index: u16, mechanism: u8, threshold_bps: u16)`. */
export function openTreasuryIx(args: OpenTreasuryArgs): TransactionInstruction {
  const data = Buffer.alloc(8 + 32 + 2 + 1 + 2);
  ORG_DISC.open_treasury.copy(data, 0);
  args.worldId.copy(data, 8);
  data.writeUInt16LE(args.orgIndex, 40);
  data.writeUInt8(args.mechanism, 42);
  data.writeUInt16LE(args.thresholdBps, 43);

  const org = orgPda(args.worldId, args.orgIndex, args.programId);
  const treasury = treasuryPda(args.worldId, args.orgIndex, args.programId);
  return new TransactionInstruction({
    programId: args.programId,
    data,
    keys: [
      meta(args.authority, true, true),
      meta(org, false, true),
      meta(args.mint, false, false),
      meta(treasury, false, true),
      optional(args.weightMint, args.programId),
      meta(TOKEN_PROGRAM_ID, false, false),
      meta(SystemProgram.programId, false, false),
      meta(SYSVAR_RENT_PUBKEY, false, false),
    ],
  });
}

/** `deposit(amount: u64)`. */
export function depositIx(args: {
  programId: PublicKey;
  depositor: PublicKey;
  org: PublicKey;
  treasury: PublicKey;
  from: PublicKey;
  amount: bigint;
}): TransactionInstruction {
  const data = Buffer.alloc(16);
  ORG_DISC.deposit.copy(data, 0);
  data.writeBigUInt64LE(args.amount, 8);
  return new TransactionInstruction({
    programId: args.programId,
    data,
    keys: [
      meta(args.depositor, true, true),
      meta(args.org, false, false),
      meta(args.treasury, false, true),
      meta(args.from, false, true),
      meta(TOKEN_PROGRAM_ID, false, false),
    ],
  });
}

/** `upsert_member(weight: u64, roles: u8)`. Org authority only. */
export function upsertMemberIx(args: {
  programId: PublicKey;
  authority: PublicKey;
  org: PublicKey;
  memberAuthority: PublicKey;
  weight: bigint;
  roles: number;
}): TransactionInstruction {
  const data = Buffer.alloc(17);
  ORG_DISC.upsert_member.copy(data, 0);
  data.writeBigUInt64LE(args.weight, 8);
  data.writeUInt8(args.roles, 16);
  return new TransactionInstruction({
    programId: args.programId,
    data,
    keys: [
      meta(args.authority, true, true),
      meta(args.org, false, true),
      meta(args.memberAuthority, false, false),
      meta(memberPda(args.org, args.memberAuthority, args.programId), false, true),
      meta(SystemProgram.programId, false, false),
    ],
  });
}

/** `create_proposal(kind: u8, recipient: Pubkey, amount: u64, opens_at: u64, closes_at: u64)`. */
export function createProposalIx(args: {
  programId: PublicKey;
  proposer: PublicKey;
  org: PublicKey;
  treasury: PublicKey;
  nonce: bigint;
  kind: number;
  recipient: PublicKey;
  amount: bigint;
  opensAt: bigint;
  closesAt: bigint;
}): TransactionInstruction {
  const data = Buffer.alloc(8 + 1 + 32 + 8 + 8 + 8);
  ORG_DISC.create_proposal.copy(data, 0);
  data.writeUInt8(args.kind, 8);
  args.recipient.toBuffer().copy(data, 9);
  data.writeBigUInt64LE(args.amount, 41);
  data.writeBigUInt64LE(args.opensAt, 49);
  data.writeBigUInt64LE(args.closesAt, 57);
  return new TransactionInstruction({
    programId: args.programId,
    data,
    keys: [
      meta(args.proposer, true, true),
      meta(args.org, false, true),
      meta(args.treasury, false, false),
      meta(proposalPda(args.treasury, args.nonce, args.programId), false, true),
      meta(SystemProgram.programId, false, false),
    ],
  });
}

/**
 * `cast_vote(support: bool)`.
 *
 * Note what is missing: there is no weight argument, here or in the program. The
 * chain reads the weight off `weightTokenAccount` or `member` and the caller only
 * says which way they are voting.
 */
export function castVoteIx(args: {
  programId: PublicKey;
  voter: PublicKey;
  org: PublicKey;
  proposal: PublicKey;
  support: boolean;
  weightTokenAccount: PublicKey | null;
  member: PublicKey | null;
}): TransactionInstruction {
  const data = Buffer.alloc(9);
  ORG_DISC.cast_vote.copy(data, 0);
  data.writeUInt8(args.support ? 1 : 0, 8);
  return new TransactionInstruction({
    programId: args.programId,
    data,
    keys: [
      meta(args.voter, true, true),
      meta(args.org, false, false),
      meta(args.proposal, false, true),
      meta(votePda(args.proposal, args.voter, args.programId), false, true),
      optional(args.weightTokenAccount, args.programId),
      optional(args.member, args.programId),
      meta(SystemProgram.programId, false, false),
    ],
  });
}

/** `finalize()`. Tallies and, if the vote passed a disbursement, pays it out here. */
export function finalizeIx(args: {
  programId: PublicKey;
  finalizer: PublicKey;
  org: PublicKey;
  proposal: PublicKey;
  treasury: PublicKey;
  recipientTokenAccount: PublicKey | null;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    data: Buffer.from(ORG_DISC.finalize),
    keys: [
      meta(args.finalizer, true, false),
      meta(args.org, false, false),
      meta(args.proposal, false, true),
      meta(args.treasury, false, true),
      optional(args.recipientTokenAccount, args.programId, true),
      meta(TOKEN_PROGRAM_ID, false, false),
    ],
  });
}

/** `disburse()`. Refuses unless the proposal account it is given actually passed. */
export function disburseIx(args: {
  programId: PublicKey;
  caller: PublicKey;
  org: PublicKey;
  proposal: PublicKey;
  treasury: PublicKey;
  recipientTokenAccount: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    data: Buffer.from(ORG_DISC.disburse),
    keys: [
      meta(args.caller, true, false),
      meta(args.org, false, false),
      meta(args.proposal, false, true),
      meta(args.treasury, false, true),
      meta(args.recipientTokenAccount, false, true),
      meta(TOKEN_PROGRAM_ID, false, false),
    ],
  });
}

/** `create_escrow(escrow_id: u64, give_amount: u64, want_amount: u64)`. */
export function createEscrowIx(args: {
  programId: PublicKey;
  maker: PublicKey;
  escrowId: bigint;
  giveMint: PublicKey;
  wantMint: PublicKey;
  makerGiveAccount: PublicKey;
  giveAmount: bigint;
  wantAmount: bigint;
}): TransactionInstruction {
  const data = Buffer.alloc(32);
  ORG_DISC.create_escrow.copy(data, 0);
  data.writeBigUInt64LE(args.escrowId, 8);
  data.writeBigUInt64LE(args.giveAmount, 16);
  data.writeBigUInt64LE(args.wantAmount, 24);
  const escrow = escrowPda(args.maker, args.escrowId, args.programId);
  return new TransactionInstruction({
    programId: args.programId,
    data,
    keys: [
      meta(args.maker, true, true),
      meta(escrow, false, true),
      meta(args.giveMint, false, false),
      meta(args.wantMint, false, false),
      meta(args.makerGiveAccount, false, true),
      meta(vaultPda(escrow, args.programId), false, true),
      meta(TOKEN_PROGRAM_ID, false, false),
      meta(SystemProgram.programId, false, false),
      meta(SYSVAR_RENT_PUBKEY, false, false),
    ],
  });
}

/** `accept_escrow()`. Both legs of the swap, in one instruction. */
export function acceptEscrowIx(args: {
  programId: PublicKey;
  taker: PublicKey;
  escrow: PublicKey;
  maker: PublicKey;
  vault: PublicKey;
  takerPaymentAccount: PublicKey;
  makerReceiveAccount: PublicKey;
  takerReceiveAccount: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    data: Buffer.from(ORG_DISC.accept_escrow),
    keys: [
      meta(args.taker, true, true),
      meta(args.escrow, false, true),
      meta(args.maker, false, true),
      meta(args.vault, false, true),
      meta(args.takerPaymentAccount, false, true),
      meta(args.makerReceiveAccount, false, true),
      meta(args.takerReceiveAccount, false, true),
      meta(TOKEN_PROGRAM_ID, false, false),
    ],
  });
}

/** `cancel_escrow()`. Maker only. */
export function cancelEscrowIx(args: {
  programId: PublicKey;
  maker: PublicKey;
  escrow: PublicKey;
  vault: PublicKey;
  makerGiveAccount: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    data: Buffer.from(ORG_DISC.cancel_escrow),
    keys: [
      meta(args.maker, true, true),
      meta(args.escrow, false, true),
      meta(args.vault, false, true),
      meta(args.makerGiveAccount, false, true),
      meta(TOKEN_PROGRAM_ID, false, false),
    ],
  });
}
