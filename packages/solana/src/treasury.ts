/**
 * `TreasuryService` against the `org` program — brief §16, §18.
 *
 * An organization's treasury is an SPL token account at
 * `["treasury", world_id, org_index]`, and its token authority is itself. No
 * keypair anywhere can move the balance; only the program can, and the only path
 * through the program that moves it runs past a proposal that passed.
 *
 * That is why {@link SolanaTreasuryService.disburse} takes a `proposalId` and not
 * just an amount. The signature is the port's, from `chain-ports.ts`, and the
 * argument is there because the chain refuses to do anything without it.
 */

import type { EntityId, ResourceId, TreasuryService } from '@aw/types';
import { PublicKey } from '@solana/web3.js';
import {
  associatedTokenAddress,
  decodeOrg,
  decodeProposal,
  decodeTokenAccount,
  depositIx,
  disburseIx,
  openTreasuryIx,
  orgPda,
  proposalPasses,
  specFor,
  treasuryPda,
  type OrgContext,
} from './org-program.ts';

/** Scale a world-level amount into the mint's minor units. */
export function toMinorUnits(amount: number, decimals: number): bigint {
  const scaled = Math.round(amount * 10 ** decimals);
  if (!Number.isFinite(scaled) || scaled < 0) {
    throw new Error(`amount ${amount} does not scale to a non-negative integer`);
  }
  return BigInt(scaled);
}

/** And back, for reporting. */
export function fromMinorUnits(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}

export class SolanaTreasuryService implements TreasuryService {
  readonly #ctx: OrgContext;

  constructor(ctx: OrgContext) {
    this.#ctx = ctx;
  }

  /** The treasury's address, for anyone who wants to look it up on an explorer. */
  addressOf(org: EntityId): PublicKey {
    const spec = specFor(this.#ctx, org);
    return treasuryPda(this.#ctx.world.worldId, spec.index, this.#ctx.programId);
  }

  /** The organization's settings account. */
  configOf(org: EntityId): PublicKey {
    const spec = specFor(this.#ctx, org);
    return orgPda(this.#ctx.world.worldId, spec.index, this.#ctx.programId);
  }

  /**
   * Create the organization and its treasury.
   *
   * The governance rules are written here, once, from the world file — the
   * mechanism byte, the threshold in basis points, and the stake mint if the world
   * issues one. After this, nobody chooses them again: every proposal copies them
   * from this account at the moment it opens.
   */
  async open(org: EntityId, resource: ResourceId): Promise<string> {
    const ctx = this.#ctx;
    const spec = specFor(ctx, org);
    if (spec.treasuryResource !== resource) {
      throw new Error(
        `world "${ctx.world.name}" holds the ${spec.type} treasury in ` +
          `"${spec.treasuryResource}", not "${resource}"`,
      );
    }

    const weightMint =
      spec.mechanism === 'token_weighted' ? ctx.mints.equityMintFor(org) : null;
    if (spec.mechanism === 'token_weighted' && !weightMint) {
      throw new Error(
        `organization "${org}" votes by ${spec.weightBy ?? 'stake'} but has no stake mint`,
      );
    }

    const ix = openTreasuryIx({
      programId: ctx.programId,
      authority: ctx.authority.publicKey,
      worldId: ctx.world.worldId,
      orgIndex: spec.index,
      mint: ctx.mints.mintFor(resource),
      weightMint,
      mechanism: spec.mechanismByte,
      thresholdBps: spec.thresholdBps,
    });
    return ctx.send([ix], [ctx.authority]);
  }

  /** Put resources in. Anyone may; a treasury nobody can pay into is furniture. */
  async deposit(org: EntityId, from: EntityId, amount: number): Promise<string> {
    const ctx = this.#ctx;
    const spec = specFor(ctx, org);
    const mint = ctx.mints.mintFor(spec.treasuryResource);
    const depositor = await ctx.keyring.signerFor(from);

    const ix = depositIx({
      programId: ctx.programId,
      depositor: depositor.publicKey,
      org: orgPda(ctx.world.worldId, spec.index, ctx.programId),
      treasury: treasuryPda(ctx.world.worldId, spec.index, ctx.programId),
      from: associatedTokenAddress(depositor.publicKey, mint),
      amount: toMinorUnits(amount, ctx.mints.decimalsFor(spec.treasuryResource)),
    });
    return ctx.send([ix], [ctx.authority, depositor]);
  }

  /**
   * Pay out a decision the organization already took.
   *
   * `proposalId` is the proposal's account address. The program reads that account,
   * recomputes the tally against the threshold recorded when the proposal opened,
   * and refuses if it did not pass, if voting has not closed, or if it has already
   * been executed. This method checks the same things first — not because the check
   * matters here, but so a caller gets a sentence instead of a simulation dump.
   *
   * Most disbursements never come through here at all: `finalize` pays out in the
   * same transaction that closes the vote (brief §19). This is the second door, for
   * the case where the recipient had no token account when the vote closed.
   */
  async disburse(
    org: EntityId,
    to: EntityId,
    amount: number,
    proposalId: string,
  ): Promise<string> {
    const ctx = this.#ctx;
    const spec = specFor(ctx, org);
    const proposalKey = new PublicKey(proposalId);
    const raw = await ctx.getAccount(proposalKey);
    if (!raw) throw new Error(`no proposal at ${proposalId}`);
    const proposal = decodeProposal(raw);

    if (!proposalPasses(
      proposal.weightFor,
      proposal.weightAgainst,
      proposal.thresholdBps,
      proposal.mechanism,
    )) {
      throw new Error(
        `proposal ${proposalId} did not pass: ${proposal.weightFor} for, ` +
          `${proposal.weightAgainst} against, needed ${proposal.thresholdBps / 100}%`,
      );
    }
    if (proposal.executed) throw new Error(`proposal ${proposalId} has already paid out`);

    const recipient = await ctx.keyring.addressFor(to);
    const mint = ctx.mints.mintFor(spec.treasuryResource);
    const decimals = ctx.mints.decimalsFor(spec.treasuryResource);
    const wanted = toMinorUnits(amount, decimals);
    if (proposal.amount !== wanted) {
      throw new Error(
        `proposal ${proposalId} disburses ${fromMinorUnits(proposal.amount, decimals)}, ` +
          `not ${amount}`,
      );
    }
    if (!proposal.recipient.equals(recipient)) {
      throw new Error(`proposal ${proposalId} does not pay "${to}"`);
    }

    const ix = disburseIx({
      programId: ctx.programId,
      caller: ctx.authority.publicKey,
      org: orgPda(ctx.world.worldId, spec.index, ctx.programId),
      proposal: proposalKey,
      treasury: treasuryPda(ctx.world.worldId, spec.index, ctx.programId),
      recipientTokenAccount: associatedTokenAddress(recipient, mint),
    });
    return ctx.send([ix], [ctx.authority]);
  }

  /** What the treasury actually holds, read off the token account. */
  async balance(org: EntityId): Promise<number> {
    const ctx = this.#ctx;
    const spec = specFor(ctx, org);
    const data = await ctx.getAccount(
      treasuryPda(ctx.world.worldId, spec.index, ctx.programId),
    );
    if (!data) return 0;
    return fromMinorUnits(
      decodeTokenAccount(data).amount,
      ctx.mints.decimalsFor(spec.treasuryResource),
    );
  }

  /** Has this organization's treasury been opened yet? */
  async isOpen(org: EntityId): Promise<boolean> {
    return (await this.#ctx.getAccount(this.configOf(org))) !== null;
  }

  /**
   * The governance settings the chain is actually enforcing.
   *
   * Read from the account rather than from the world file, so a mismatch between
   * what a world says and what was deployed shows up instead of being assumed away.
   */
  async settings(org: EntityId): Promise<{
    mechanism: number;
    thresholdBps: number;
    proposalNonce: bigint;
    weightMint: PublicKey;
  } | null> {
    const data = await this.#ctx.getAccount(this.configOf(org));
    if (!data) return null;
    const decoded = decodeOrg(data);
    return {
      mechanism: decoded.mechanism,
      thresholdBps: decoded.thresholdBps,
      proposalNonce: decoded.proposalNonce,
      weightMint: decoded.weightMint,
    };
  }
}
