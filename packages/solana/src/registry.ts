// Client for the `registry` Anchor program: agent identity PDAs and PDA-record
// asset ownership.
//
// Two things this module refuses to know:
//
//   1. What a world contains. Entity types and asset classes arrive as strings
//      from the world file, get padded to 16 bytes, and are copied through to
//      the chain. Nothing here branches on "peasant" or "land_parcel".
//   2. What the rest of the Solana layer looks like. Anything it needs from a
//      sibling module (wallets, for instance) is described by a narrow local
//      interface, so this file compiles on its own.
//
// Instruction data is hand-encoded rather than built with Anchor's JS coder:
// the coder's buffer caps out near 1000 bytes, which makes batching impossible,
// and batching is the difference between a demo and a coffee break.

import { createHash } from 'node:crypto';
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type Commitment,
  type Signer,
} from '@solana/web3.js';
import type { EntityId, OwnershipRegistry } from '@aw/types';

// ---------------------------------------------------------------- program id

/** Deployed program id. Matches `declare_id!` in programs/registry/src/lib.rs. */
export const REGISTRY_PROGRAM_ID = new PublicKey(
  'HvTb4oPkqCnhvvNH7jcacbUVk4rmRrs5jDfXEXtr1KsK',
);

/** Length of a world-declared label on chain. Mirrors `LABEL_LEN` in the program. */
export const LABEL_LEN = 16;

/**
 * Anchor discriminators, copied from programs/registry/idl/registry.json.
 * `verifyDiscriminators` re-checks them against a parsed IDL at runtime, so the
 * two can never quietly drift apart.
 */
export const IX_DISCRIMINATOR = {
  register_agent: Uint8Array.from([135, 157, 66, 195, 2, 113, 175, 30]),
  update_reputation: Uint8Array.from([194, 220, 43, 201, 54, 209, 49, 178]),
  mint_asset: Uint8Array.from([84, 175, 211, 156, 56, 250, 104, 118]),
  transfer_asset: Uint8Array.from([126, 66, 109, 18, 60, 172, 131, 124]),
} as const;

export const ACCOUNT_DISCRIMINATOR = {
  AgentIdentity: Uint8Array.from([11, 149, 31, 27, 186, 76, 241, 72]),
  AssetRecord: Uint8Array.from([26, 40, 78, 169, 45, 6, 254, 10]),
} as const;

/** Minimal shape of the parsed IDL that `verifyDiscriminators` needs. */
export interface DiscriminatorSource {
  address?: string;
  instructions?: { name: string; discriminator: number[] }[];
  accounts?: { name: string; discriminator: number[] }[];
}

/**
 * Check the compiled-in discriminators against a freshly built IDL. Returns the
 * names that disagree; an empty array means the client and the program agree.
 */
export function verifyDiscriminators(idl: DiscriminatorSource): string[] {
  const bad: string[] = [];
  const same = (a: Uint8Array, b: number[] | undefined) =>
    !!b && b.length === 8 && b.every((v, i) => v === a[i]);
  for (const ix of idl.instructions ?? []) {
    const known = (IX_DISCRIMINATOR as Record<string, Uint8Array>)[ix.name];
    if (!known || !same(known, ix.discriminator)) bad.push(`instruction ${ix.name}`);
  }
  for (const acc of idl.accounts ?? []) {
    const known = (ACCOUNT_DISCRIMINATOR as Record<string, Uint8Array>)[acc.name];
    if (!known || !same(known, acc.discriminator)) bad.push(`account ${acc.name}`);
  }
  if (idl.address && idl.address !== REGISTRY_PROGRAM_ID.toBase58()) {
    bad.push(`program address ${idl.address}`);
  }
  return bad;
}

// -------------------------------------------------------------- encoding

/**
 * A world id: 32 deterministic bytes derived from the world's name, so the same
 * world file always addresses the same PDAs and two worlds never collide.
 */
export function deriveWorldId(worldName: string): PublicKey {
  return new PublicKey(createHash('sha256').update(`aw:world:${worldName}`).digest());
}

/** Pad a world-declared label into the program's fixed 16-byte field. */
export function encodeLabel(label: string): Buffer {
  const raw = Buffer.from(label, 'utf8');
  if (raw.length > LABEL_LEN) {
    throw new Error(
      `label ${JSON.stringify(label)} is ${raw.length} bytes; the on-chain field holds ${LABEL_LEN}`,
    );
  }
  const out = Buffer.alloc(LABEL_LEN);
  raw.copy(out);
  return out;
}

/** Read a 16-byte label back as the string the world file wrote. */
export function decodeLabel(bytes: Buffer): string {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString('utf8');
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

function u64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

function i32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n);
  return b;
}

/**
 * Map a world's asset id string onto the program's u64 key.
 *
 * A world that numbers its assets gets those numbers; anything else is hashed,
 * so `"parcel:north-field"` is as valid an asset id as `"17"`.
 */
export function assetKey(assetId: string): bigint {
  if (/^\d{1,19}$/.test(assetId)) {
    const n = BigInt(assetId);
    if (n <= 0xffff_ffff_ffff_ffffn) return n;
  }
  const digest = createHash('sha256').update(`aw:asset:${assetId}`).digest();
  // Clear the top bit so the value stays comfortably inside anything that
  // later decides to treat it as signed.
  return digest.readBigUInt64LE(0) & 0x7fff_ffff_ffff_ffffn;
}

// ------------------------------------------------------------------- PDAs

export const AGENT_SEED = Buffer.from('agent');
export const ASSET_SEED = Buffer.from('asset');

export function agentIdentityPda(
  world: PublicKey,
  index: number,
  programId: PublicKey = REGISTRY_PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [AGENT_SEED, world.toBuffer(), u16(index)],
    programId,
  )[0];
}

export function assetRecordPda(
  world: PublicKey,
  key: bigint,
  programId: PublicKey = REGISTRY_PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [ASSET_SEED, world.toBuffer(), u64(key)],
    programId,
  )[0];
}

// -------------------------------------------------------------- account data

export interface AgentIdentityAccount {
  address: PublicKey;
  world: PublicKey;
  index: number;
  wallet: PublicKey;
  entityType: string;
  createdSlot: bigint;
  reputation: number;
}

export interface AssetRecordAccount {
  address: PublicKey;
  world: PublicKey;
  assetClass: string;
  assetKey: bigint;
  owner: PublicKey;
  transfers: number;
}

/** Byte offsets inside AssetRecord, for `getProgramAccounts` filters. */
const ASSET_OFFSET = { world: 8, assetClass: 40, assetKey: 56, owner: 64 } as const;

export function decodeAgentIdentity(address: PublicKey, data: Buffer): AgentIdentityAccount {
  return {
    address,
    world: new PublicKey(data.subarray(8, 40)),
    index: data.readUInt16LE(40),
    wallet: new PublicKey(data.subarray(42, 74)),
    entityType: decodeLabel(data.subarray(74, 90)),
    createdSlot: data.readBigUInt64LE(90),
    reputation: data.readInt32LE(98),
  };
}

export function decodeAssetRecord(address: PublicKey, data: Buffer): AssetRecordAccount {
  return {
    address,
    world: new PublicKey(data.subarray(ASSET_OFFSET.world, ASSET_OFFSET.world + 32)),
    assetClass: decodeLabel(data.subarray(ASSET_OFFSET.assetClass, ASSET_OFFSET.assetClass + 16)),
    assetKey: data.readBigUInt64LE(ASSET_OFFSET.assetKey),
    owner: new PublicKey(data.subarray(ASSET_OFFSET.owner, ASSET_OFFSET.owner + 32)),
    transfers: data.readUInt32LE(ASSET_OFFSET.owner + 32),
  };
}

// ------------------------------------------------------------ instructions

export interface AgentRegistration {
  /** The simulation's id for this entity. */
  entity: EntityId;
  /** Index within the world's population; part of the PDA seed. */
  index: number;
  /** World-declared entity type. Copied through as bytes, never interpreted. */
  entityType: string;
  /** The agent's real keypair address. */
  wallet: PublicKey;
}

export function registerAgentIx(args: {
  world: PublicKey;
  payer: PublicKey;
  registration: AgentRegistration;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = args.programId ?? REGISTRY_PROGRAM_ID;
  const { index, entityType, wallet } = args.registration;
  const data = Buffer.concat([
    Buffer.from(IX_DISCRIMINATOR.register_agent),
    args.world.toBuffer(),
    u16(index),
    encodeLabel(entityType),
    wallet.toBuffer(),
  ]);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: agentIdentityPda(args.world, index, programId), isSigner: false, isWritable: true },
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function updateReputationIx(args: {
  agent: PublicKey;
  attestor: PublicKey;
  attestorWallet: PublicKey;
  delta: number;
  programId?: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId ?? REGISTRY_PROGRAM_ID,
    keys: [
      { pubkey: args.agent, isSigner: false, isWritable: true },
      { pubkey: args.attestor, isSigner: false, isWritable: false },
      { pubkey: args.attestorWallet, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from(IX_DISCRIMINATOR.update_reputation), i32(args.delta)]),
  });
}

export function mintAssetIx(args: {
  world: PublicKey;
  payer: PublicKey;
  assetKey: bigint;
  assetClass: string;
  ownerIdentity: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = args.programId ?? REGISTRY_PROGRAM_ID;
  const data = Buffer.concat([
    Buffer.from(IX_DISCRIMINATOR.mint_asset),
    args.world.toBuffer(),
    u64(args.assetKey),
    encodeLabel(args.assetClass),
  ]);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: assetRecordPda(args.world, args.assetKey, programId), isSigner: false, isWritable: true },
      { pubkey: args.ownerIdentity, isSigner: false, isWritable: false },
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function transferAssetIx(args: {
  asset: PublicKey;
  currentOwner: PublicKey;
  newOwnerIdentity: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId ?? REGISTRY_PROGRAM_ID,
    keys: [
      { pubkey: args.asset, isSigner: false, isWritable: true },
      { pubkey: args.currentOwner, isSigner: true, isWritable: false },
      { pubkey: args.newOwnerIdentity, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(IX_DISCRIMINATOR.transfer_asset),
  });
}

// ----------------------------------------------------------------- batching

/** Hard cap on a Solana transaction, in bytes. */
const PACKET_DATA_SIZE = 1232;
/** Leave room for the blockhash the runtime substitutes and a little slack. */
const SIZE_MARGIN = 64;

export interface BatchOptions {
  /** How many transactions to have in flight at once. */
  concurrency?: number;
  commitment?: Commitment;
  /** Called once per confirmed transaction, for progress output. */
  onProgress?: (done: number, total: number, signature: string) => void;
}

/**
 * Pack instructions into as few transactions as will hold them.
 *
 * The packer measures real serialized messages rather than guessing, because
 * account lists differ per instruction and the difference between 6 and 8
 * registrations per transaction is 4 round trips over a population of 27.
 */
export function packInstructions(
  instructions: TransactionInstruction[],
  feePayer: PublicKey,
  extraSigners = 0,
): TransactionInstruction[][] {
  const batches: TransactionInstruction[][] = [];
  let current: TransactionInstruction[] = [];
  // Any 32-byte value serializes identically; the real blockhash is swapped in
  // at send time and does not change the length.
  const probeBlockhash = PublicKey.default.toBase58();

  const fits = (ixs: TransactionInstruction[]): boolean => {
    const tx = new Transaction();
    tx.feePayer = feePayer;
    tx.recentBlockhash = probeBlockhash;
    tx.add(...ixs);
    const message = tx.serializeMessage();
    const signatures = tx.compileMessage().header.numRequiredSignatures + extraSigners;
    return message.length + 1 + signatures * 64 <= PACKET_DATA_SIZE - SIZE_MARGIN;
  };

  for (const ix of instructions) {
    if (current.length > 0 && !fits([...current, ix])) {
      batches.push(current);
      current = [];
    }
    current.push(ix);
    if (!fits(current)) {
      throw new Error('a single instruction does not fit in one transaction');
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** One confirmed transaction. */
export interface SentTransaction {
  signature: string;
  instructionCount: number;
}

async function sendBatches(
  connection: Connection,
  batches: TransactionInstruction[][],
  payer: Signer,
  extraSigners: Signer[],
  options: BatchOptions = {},
): Promise<SentTransaction[]> {
  const commitment = options.commitment ?? 'confirmed';
  const concurrency = Math.max(1, options.concurrency ?? 8);
  const results: SentTransaction[] = new Array(batches.length);
  let done = 0;

  for (let start = 0; start < batches.length; start += concurrency) {
    const window = batches.slice(start, start + concurrency);
    const latest = await connection.getLatestBlockhash(commitment);
    const sent = await Promise.all(
      window.map(async (ixs, offset) => {
        const tx = new Transaction();
        tx.feePayer = payer.publicKey;
        tx.recentBlockhash = latest.blockhash;
        tx.add(...ixs);
        const signers = [payer, ...extraSigners.filter((s) => !s.publicKey.equals(payer.publicKey))];
        tx.sign(...signers);
        const signature = await connection.sendRawTransaction(tx.serialize(), {
          preflightCommitment: commitment,
        });
        return { signature, index: start + offset, instructionCount: ixs.length };
      }),
    );
    await Promise.all(
      sent.map(async (s) => {
        const confirmation = await connection.confirmTransaction(
          {
            signature: s.signature,
            blockhash: latest.blockhash,
            lastValidBlockHeight: latest.lastValidBlockHeight,
          },
          commitment,
        );
        if (confirmation.value.err) {
          throw new Error(`transaction ${s.signature} failed: ${JSON.stringify(confirmation.value.err)}`);
        }
        results[s.index] = { signature: s.signature, instructionCount: s.instructionCount };
        done += 1;
        options.onProgress?.(done, batches.length, s.signature);
      }),
    );
  }
  return results;
}

/**
 * Pack, sign, send and confirm arbitrary registry instructions.
 *
 * Exposed because some things are worth doing at this level — notably proving
 * that the *program* rejects an illegitimate transfer, rather than having the
 * client refuse to send one.
 */
export async function sendInstructions(
  connection: Connection,
  instructions: TransactionInstruction[],
  payer: Signer,
  extraSigners: Signer[] = [],
  options: BatchOptions = {},
): Promise<SentTransaction[]> {
  const batches = packInstructions(instructions, payer.publicKey, extraSigners.length);
  return sendBatches(connection, batches, payer, extraSigners, options);
}

// ------------------------------------------------------------ agent registry

export interface RegistryContext {
  connection: Connection;
  /** Pays rent for the PDAs. Usually the simulation host, not an agent. */
  payer: Signer;
  /** Identifies the world. See `deriveWorldId`. */
  world: PublicKey;
  programId?: PublicKey;
  commitment?: Commitment;
}

/**
 * The identity PDAs: one real account per agent, so a block explorer shows a
 * world's inhabitants rather than a single opaque ledger.
 */
export class AgentRegistry {
  readonly connection: Connection;
  readonly payer: Signer;
  readonly world: PublicKey;
  readonly programId: PublicKey;
  readonly commitment: Commitment;

  private readonly byEntity = new Map<EntityId, AgentRegistration>();
  private readonly byWallet = new Map<string, EntityId>();

  constructor(ctx: RegistryContext) {
    this.connection = ctx.connection;
    this.payer = ctx.payer;
    this.world = ctx.world;
    this.programId = ctx.programId ?? REGISTRY_PROGRAM_ID;
    this.commitment = ctx.commitment ?? 'confirmed';
  }

  /** Every registration this client knows about, in index order. */
  get roster(): AgentRegistration[] {
    return [...this.byEntity.values()].sort((a, b) => a.index - b.index);
  }

  pdaFor(entity: EntityId): PublicKey | undefined {
    const reg = this.byEntity.get(entity);
    return reg ? agentIdentityPda(this.world, reg.index, this.programId) : undefined;
  }

  pdaAt(index: number): PublicKey {
    return agentIdentityPda(this.world, index, this.programId);
  }

  registrationOf(entity: EntityId): AgentRegistration | undefined {
    return this.byEntity.get(entity);
  }

  entityForWallet(wallet: PublicKey): EntityId | undefined {
    return this.byWallet.get(wallet.toBase58());
  }

  /** Teach the client about agents without touching the chain. */
  remember(registrations: AgentRegistration[]): void {
    for (const r of registrations) {
      this.byEntity.set(r.entity, r);
      this.byWallet.set(r.wallet.toBase58(), r.entity);
    }
  }

  /**
   * Register a whole population. Instructions are packed to the transaction
   * size limit and the transactions go out concurrently, so 27 agents cost a
   * handful of round trips rather than 27.
   */
  async registerMany(
    registrations: AgentRegistration[],
    options: BatchOptions = {},
  ): Promise<SentTransaction[]> {
    this.remember(registrations);
    const fresh = await this.filterUnregistered(registrations);
    if (fresh.length === 0) return [];
    const ixs = fresh.map((registration) =>
      registerAgentIx({
        world: this.world,
        payer: this.payer.publicKey,
        registration,
        programId: this.programId,
      }),
    );
    const batches = packInstructions(ixs, this.payer.publicKey);
    return sendBatches(this.connection, batches, this.payer, [], {
      commitment: this.commitment,
      ...options,
    });
  }

  /** Drop registrations whose PDA already exists — re-running a demo is cheap. */
  private async filterUnregistered(
    registrations: AgentRegistration[],
  ): Promise<AgentRegistration[]> {
    const fresh: AgentRegistration[] = [];
    const chunk = 100;
    for (let i = 0; i < registrations.length; i += chunk) {
      const slice = registrations.slice(i, i + chunk);
      const infos = await this.connection.getMultipleAccountsInfo(
        slice.map((r) => agentIdentityPda(this.world, r.index, this.programId)),
        this.commitment,
      );
      slice.forEach((r, j) => {
        if (!infos[j]) fresh.push(r);
      });
    }
    return fresh;
  }

  async fetch(index: number): Promise<AgentIdentityAccount | null> {
    const address = this.pdaAt(index);
    const info = await this.connection.getAccountInfo(address, this.commitment);
    if (!info) return null;
    return decodeAgentIdentity(address, info.data);
  }

  async fetchMany(indices: number[]): Promise<(AgentIdentityAccount | null)[]> {
    const addresses = indices.map((i) => this.pdaAt(i));
    const infos = await this.connection.getMultipleAccountsInfo(addresses, this.commitment);
    return infos.map((info, i) =>
      info ? decodeAgentIdentity(addresses[i] as PublicKey, info.data) : null,
    );
  }

  /**
   * Move an agent's reputation. The program requires a *different* registered
   * agent of the same world to sign, so this needs the attestor's keypair.
   */
  async attestReputation(args: {
    subject: EntityId;
    attestor: EntityId;
    delta: number;
    attestorSigner: Signer;
  }): Promise<string> {
    const subjectPda = this.pdaFor(args.subject);
    const attestorPda = this.pdaFor(args.attestor);
    if (!subjectPda) throw new Error(`agent ${args.subject} is not registered in this world`);
    if (!attestorPda) throw new Error(`attestor ${args.attestor} is not registered in this world`);

    const ix = updateReputationIx({
      agent: subjectPda,
      attestor: attestorPda,
      attestorWallet: args.attestorSigner.publicKey,
      delta: args.delta,
      programId: this.programId,
    });
    const [sent] = await sendBatches(
      this.connection,
      [[ix]],
      this.payer,
      [args.attestorSigner],
      { commitment: this.commitment },
    );
    return (sent as SentTransaction).signature;
  }
}

// -------------------------------------------------------- ownership registry

/**
 * The host's wallet service, described narrowly so this module does not depend
 * on whichever sibling file ends up providing it.
 */
export interface AgentSignerSource {
  /** The signing keypair for an agent entity, if the host holds it. */
  signerFor(entity: EntityId): Signer | undefined;
}

export interface OwnershipRegistryOptions {
  /** The world-declared asset class this registry serves, e.g. from `AssetClassDef.id`. */
  assetClass: string;
  /** Where signatures come from when an owner has to authorise a transfer. */
  signers: AgentSignerSource;
  /** Agents must exist before they can own anything; the program enforces it. */
  agents: AgentRegistry;
}

/**
 * `OwnershipRegistry` (brief §15) backed by one PDA per asset.
 *
 * Suitable for any asset class a world declares with `ownership: "pda_record"`.
 * The class name is carried as data; this code is the same whether a world calls
 * its indivisible things parcels, titles, ships or nothing at all.
 */
export class PdaOwnershipRegistry implements OwnershipRegistry {
  private readonly ctx: RegistryContext;
  private readonly programId: PublicKey;
  private readonly commitment: Commitment;
  private readonly agents: AgentRegistry;
  private readonly signers: AgentSignerSource;
  readonly assetClass: string;

  /** u64 key -> the asset id string the world used, so lookups round-trip. */
  private readonly keyToAssetId = new Map<string, string>();

  constructor(ctx: RegistryContext, options: OwnershipRegistryOptions) {
    this.ctx = ctx;
    this.programId = ctx.programId ?? REGISTRY_PROGRAM_ID;
    this.commitment = ctx.commitment ?? 'confirmed';
    this.agents = options.agents;
    this.signers = options.signers;
    this.assetClass = options.assetClass;
  }

  get world(): PublicKey {
    return this.ctx.world;
  }

  keyOf(assetId: string): bigint {
    const key = assetKey(assetId);
    this.keyToAssetId.set(key.toString(), assetId);
    return key;
  }

  pdaOf(assetId: string): PublicKey {
    return assetRecordPda(this.ctx.world, this.keyOf(assetId), this.programId);
  }

  // --- OwnershipRegistry ---------------------------------------------------

  /** Record that `owner` holds `assetId`, minting the record if it is new. */
  async assign(assetId: string, owner: EntityId): Promise<string> {
    const existing = await this.fetchRecord(assetId);
    if (existing) {
      const current = this.agents.entityForWallet(existing.owner);
      if (current === owner) {
        throw new Error(`asset ${assetId} is already assigned to ${owner}`);
      }
      return this.transfer(assetId, current ?? '', owner);
    }
    const [sent] = await this.mintMany([{ assetId, owner }]);
    return (sent as SentTransaction).signature;
  }

  async transfer(assetId: string, from: EntityId, to: EntityId): Promise<string> {
    const record = await this.fetchRecord(assetId);
    if (!record) throw new Error(`asset ${assetId} has no on-chain record`);

    const ownerEntity = this.agents.entityForWallet(record.owner);
    if (from && ownerEntity && ownerEntity !== from) {
      throw new Error(
        `asset ${assetId} is owned by ${ownerEntity}, not ${from}` +
          ' (the program would reject this too)',
      );
    }
    const signer = this.signers.signerFor(ownerEntity ?? from);
    if (!signer) {
      throw new Error(`no signing key available for the current owner of ${assetId}`);
    }
    if (!signer.publicKey.equals(record.owner)) {
      throw new Error(
        `signer ${signer.publicKey.toBase58()} is not the recorded owner ${record.owner.toBase58()}`,
      );
    }
    const newOwnerPda = this.agents.pdaFor(to);
    if (!newOwnerPda) throw new Error(`agent ${to} is not registered in this world`);

    const ix = transferAssetIx({
      asset: record.address,
      currentOwner: signer.publicKey,
      newOwnerIdentity: newOwnerPda,
      programId: this.programId,
    });
    const [sent] = await sendBatches(
      this.ctx.connection,
      [[ix]],
      this.ctx.payer,
      [signer],
      { commitment: this.commitment },
    );
    return (sent as SentTransaction).signature;
  }

  async ownerOf(assetId: string): Promise<EntityId | null> {
    const record = await this.fetchRecord(assetId);
    if (!record) return null;
    return this.agents.entityForWallet(record.owner) ?? null;
  }

  async assetsOf(owner: EntityId): Promise<string[]> {
    const registration = this.agents.registrationOf(owner);
    if (!registration) return [];
    const records = await this.scan({ owner: registration.wallet });
    return records.map((r) => this.assetIdFor(r.assetKey));
  }

  // --- extras beyond the port ---------------------------------------------

  /** Mint many asset records in as few transactions as they fit into. */
  async mintMany(
    assets: { assetId: string; owner: EntityId }[],
    options: BatchOptions = {},
  ): Promise<SentTransaction[]> {
    const ixs: TransactionInstruction[] = [];
    for (const { assetId, owner } of assets) {
      const ownerPda = this.agents.pdaFor(owner);
      if (!ownerPda) throw new Error(`agent ${owner} is not registered in this world`);
      ixs.push(
        mintAssetIx({
          world: this.ctx.world,
          payer: this.ctx.payer.publicKey,
          assetKey: this.keyOf(assetId),
          assetClass: this.assetClass,
          ownerIdentity: ownerPda,
          programId: this.programId,
        }),
      );
    }
    if (ixs.length === 0) return [];
    const batches = packInstructions(ixs, this.ctx.payer.publicKey);
    return sendBatches(this.ctx.connection, batches, this.ctx.payer, [], {
      commitment: this.commitment,
      ...options,
    });
  }

  async fetchRecord(assetId: string): Promise<AssetRecordAccount | null> {
    const address = this.pdaOf(assetId);
    const info = await this.ctx.connection.getAccountInfo(address, this.commitment);
    if (!info) return null;
    return decodeAssetRecord(address, info.data);
  }

  /** Every asset record for this world, optionally narrowed to one owner. */
  async scan(filter: { owner?: PublicKey } = {}): Promise<AssetRecordAccount[]> {
    const filters = [
      { memcmp: { offset: 0, bytes: bs58Of(ACCOUNT_DISCRIMINATOR.AssetRecord) } },
      { memcmp: { offset: ASSET_OFFSET.world, bytes: this.ctx.world.toBase58() } },
      {
        memcmp: {
          offset: ASSET_OFFSET.assetClass,
          bytes: bs58Of(encodeLabel(this.assetClass)),
        },
      },
    ];
    if (filter.owner) {
      filters.push({ memcmp: { offset: ASSET_OFFSET.owner, bytes: filter.owner.toBase58() } });
    }
    const found = await this.ctx.connection.getProgramAccounts(this.programId, {
      commitment: this.commitment,
      filters,
    });
    return found
      .map(({ pubkey, account }) => decodeAssetRecord(pubkey, account.data))
      .sort((a, b) => (a.assetKey < b.assetKey ? -1 : a.assetKey > b.assetKey ? 1 : 0));
  }

  private assetIdFor(key: bigint): string {
    return this.keyToAssetId.get(key.toString()) ?? key.toString();
  }
}

/**
 * base58 for a raw byte string, as `getProgramAccounts` memcmp wants it.
 * `PublicKey` only encodes 32-byte values, and discriminators and labels are
 * shorter, so the encoder is spelled out below.
 */
function bs58Of(bytes: Uint8Array | Buffer): string {
  return base58Encode(Buffer.from(bytes));
}

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes: Buffer): string {
  if (bytes.length === 0) return '';
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += (digits[i] as number) << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (const byte of bytes) {
    if (byte !== 0) break;
    out += B58_ALPHABET[0];
  }
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    out += B58_ALPHABET[digits[i] as number];
  }
  return out;
}

// ------------------------------------------------------------------ explorer

/**
 * Explorer link for a signature or address. A local validator is not a public
 * cluster, so the URL carries the RPC endpoint along with it.
 */
export function explorerUrl(
  kind: 'tx' | 'address',
  value: string,
  rpcEndpoint: string,
): string {
  const base = `https://explorer.solana.com/${kind}/${value}`;
  if (/mainnet/.test(rpcEndpoint)) return base;
  if (/devnet/.test(rpcEndpoint)) return `${base}?cluster=devnet`;
  if (/testnet/.test(rpcEndpoint)) return `${base}?cluster=testnet`;
  return `${base}?cluster=custom&customUrl=${encodeURIComponent(rpcEndpoint)}`;
}
