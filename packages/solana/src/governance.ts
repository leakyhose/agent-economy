/**
 * `GovernanceService` against the `org` program — brief §19.
 *
 * Six mechanisms, one implementation. A world picks `token_weighted` or `council`
 * or `consensus` in its `organizations` block and this file does not branch on
 * which: it reads the byte out of the organization's account and hands the chain
 * whichever account that mechanism's weight is read from. No organization's name,
 * and no member's rank, reaches this file as anything but data.
 *
 * The part worth reading twice is {@link SolanaGovernanceService.vote}. The port
 * hands it a `weight` argument and it throws that argument away, because the weight
 * a vote carries is read on chain from state the voter does not control. A client
 * that could name its own weight could pass anything.
 *
 * And {@link SolanaGovernanceService.finalize} does not merely record an outcome:
 * when a disbursement passes, the transfer happens in that same transaction. A
 * governance decision *is* a Solana transaction rather than a memo about one.
 */

import type {
  EntityId,
  GovernanceMechanism,
  GovernanceService,
  Proposal,
} from '@aw/types';
import { PublicKey } from '@solana/web3.js';
import { fromMinorUnits, toMinorUnits } from './treasury.ts';
import {
  ACCOUNT_DISC,
  associatedTokenAddress,
  castVoteIx,
  createProposalIx,
  decodeOrg,
  decodeProposal,
  finalizeIx,
  KIND_DISBURSE,
  KIND_SIGNAL,
  mechanismByte,
  mechanismName,
  memberPda,
  orgPda,
  proposalPasses,
  proposalPda,
  specFor,
  tickToUnixSeconds,
  treasuryPda,
  unixSecondsToTick,
  votePda,
  type OrgAccount,
  type OrgContext,
  type ProposalAccount,
} from './org-program.ts';

/** How a proposal stands, for a caller that wants more than the port's shape. */
export interface ProposalStanding {
  id: string;
  mechanism: GovernanceMechanism;
  thresholdBps: number;
  weightFor: bigint;
  weightAgainst: bigint;
  passing: boolean;
  executed: boolean;
  closesAt: number;
}

export class SolanaGovernanceService implements GovernanceService {
  readonly #ctx: OrgContext;
  /** Org settings, read once per organization. They cannot change after opening. */
  readonly #settings = new Map<EntityId, OrgAccount>();
  /**
   * A signal proposal's text. The chain records that the decision was taken and
   * how; the words are the simulation's business and stay off chain.
   */
  readonly #signals = new Map<string, string>();
  /** Which organization each proposal belongs to, for decoding tallies back. */
  readonly #owners = new Map<string, EntityId>();

  constructor(ctx: OrgContext) {
    this.#ctx = ctx;
  }

  /** The mechanism the chain is enforcing, not the one the world file hoped for. */
  async mechanism(org: EntityId): Promise<GovernanceMechanism> {
    const settings = await this.#settingsFor(org);
    return mechanismName(settings.mechanism);
  }

  /**
   * Open a proposal.
   *
   * `closesAtTick` is a simulation tick; the program only has a wall clock, so the
   * tick is converted to a deadline here and the program compares it against
   * `Clock::unix_timestamp`. Nobody gets to tell the chain what time it is.
   */
  async propose(
    org: EntityId,
    proposer: EntityId,
    action: Proposal['action'],
    closesAtTick: number,
  ): Promise<Proposal> {
    const ctx = this.#ctx;
    const spec = specFor(ctx, org);
    const settings = await this.#settingsFor(org);
    const orgKey = orgPda(ctx.world.worldId, spec.index, ctx.programId);
    const treasury = treasuryPda(ctx.world.worldId, spec.index, ctx.programId);
    const nonce = settings.proposalNonce;
    const proposalKey = proposalPda(treasury, nonce, ctx.programId);

    const decimals = ctx.mints.decimalsFor(spec.treasuryResource);
    const recipient =
      action.kind === 'disburse'
        ? await ctx.keyring.addressFor(action.to)
        : PublicKey.default;
    const amount =
      action.kind === 'disburse' ? toMinorUnits(action.amount, decimals) : 0n;

    // Both bounds come off the chain's clock, since the chain is what enforces
    // them. `opensAt` is nudged back a second so a proposal is votable in the very
    // next transaction rather than on the next slot boundary.
    const chainNow = await ctx.now();
    const windowSeconds = Math.max(
      1,
      Math.round((closesAtTick * ctx.world.tickMs) / 1_000),
    );
    const closesAt = chainNow + windowSeconds;

    const signer = await ctx.keyring.signerFor(proposer);
    const ix = createProposalIx({
      programId: ctx.programId,
      proposer: signer.publicKey,
      org: orgKey,
      treasury,
      nonce,
      kind: action.kind === 'disburse' ? KIND_DISBURSE : KIND_SIGNAL,
      recipient,
      amount,
      opensAt: BigInt(chainNow - 1),
      closesAt: BigInt(closesAt),
    });
    await ctx.send([ix], [ctx.authority, signer]);

    // The nonce advanced on chain; keep the cached copy honest.
    settings.proposalNonce = nonce + 1n;
    const id = proposalKey.toBase58();
    this.#owners.set(id, org);
    if (action.kind === 'signal') this.#signals.set(id, action.text);

    return this.#read(id, org);
  }

  /**
   * Vote. `weight` is ignored, deliberately.
   *
   * The port passes a weight because the in-memory implementation needs one. This
   * implementation does not take the caller's word for it: for `token_weighted` the
   * chain reads the voter's own balance of the organization's stake mint, and for
   * every other mechanism it reads the member record only the organization's
   * authority can write. There is no instruction argument to put a number in.
   */
  async vote(
    proposalId: string,
    voter: EntityId,
    support: boolean,
    _weight?: number,
  ): Promise<string> {
    const ctx = this.#ctx;
    const org = this.#ownerOf(proposalId);
    const spec = specFor(ctx, org);
    const settings = await this.#settingsFor(org);
    const orgKey = orgPda(ctx.world.worldId, spec.index, ctx.programId);
    const signer = await ctx.keyring.signerFor(voter);

    const tokenWeighted = settings.mechanism === mechanismByte('token_weighted');
    const weightTokenAccount = tokenWeighted
      ? associatedTokenAddress(signer.publicKey, settings.weightMint)
      : null;
    const member = tokenWeighted
      ? null
      : memberPda(orgKey, signer.publicKey, ctx.programId);

    const ix = castVoteIx({
      programId: ctx.programId,
      voter: signer.publicKey,
      org: orgKey,
      proposal: new PublicKey(proposalId),
      support,
      weightTokenAccount,
      member,
    });
    return ctx.send([ix], [ctx.authority, signer]);
  }

  /**
   * Close the vote, and pay out if it passed.
   *
   * Returns the signature only when something actually settled on chain. A proposal
   * that lost, or a signal that won, leaves its tally behind as the record and
   * returns null — there is no transfer to point at.
   */
  async finalize(proposalId: string, _tick?: number): Promise<string | null> {
    const ctx = this.#ctx;
    const org = this.#ownerOf(proposalId);
    const spec = specFor(ctx, org);
    const proposalKey = new PublicKey(proposalId);
    const before = await this.#decode(proposalKey);

    const treasury = treasuryPda(ctx.world.worldId, spec.index, ctx.programId);
    const mint = ctx.mints.mintFor(spec.treasuryResource);
    const willPay =
      before.kind === KIND_DISBURSE &&
      proposalPasses(
        before.weightFor,
        before.weightAgainst,
        before.thresholdBps,
        before.mechanism,
      );

    const ix = finalizeIx({
      programId: ctx.programId,
      finalizer: ctx.authority.publicKey,
      org: orgPda(ctx.world.worldId, spec.index, ctx.programId),
      proposal: proposalKey,
      treasury,
      recipientTokenAccount: willPay
        ? associatedTokenAddress(before.recipient, mint)
        : null,
    });
    const signature = await ctx.send([ix], [ctx.authority]);

    const after = await this.#decode(proposalKey);
    return after.executed ? signature : null;
  }

  /** Every proposal of this organization that has not yet been executed. */
  async open(org: EntityId): Promise<Proposal[]> {
    const ctx = this.#ctx;
    const spec = specFor(ctx, org);
    const orgKey = orgPda(ctx.world.worldId, spec.index, ctx.programId);
    const found = await ctx.getProgramAccounts([
      { offset: 0, bytes: Buffer.from(ACCOUNT_DISC.Proposal) },
      { offset: 8, bytes: orgKey.toBuffer() },
    ]);

    const proposals = found
      .map(({ pubkey, data }) => ({ pubkey, account: decodeProposal(data) }))
      .filter(({ account }) => !account.executed)
      .sort((a, b) => Number(a.account.closesAt - b.account.closesAt));

    for (const { pubkey } of proposals) this.#owners.set(pubkey.toBase58(), org);
    return proposals.map(({ pubkey, account }) =>
      this.#toPortProposal(pubkey.toBase58(), org, account),
    );
  }

  // ------------------------------------------------------------ beyond the port

  /** Where the tally stands, with the chain's own verdict on whether it passes. */
  async standing(proposalId: string): Promise<ProposalStanding> {
    const account = await this.#decode(new PublicKey(proposalId));
    return {
      id: proposalId,
      mechanism: mechanismName(account.mechanism),
      thresholdBps: account.thresholdBps,
      weightFor: account.weightFor,
      weightAgainst: account.weightAgainst,
      passing: proposalPasses(
        account.weightFor,
        account.weightAgainst,
        account.thresholdBps,
        account.mechanism,
      ),
      executed: account.executed,
      closesAt: Number(account.closesAt),
    };
  }

  /** The receipt a voter left behind, if they voted. Proof of weight, on chain. */
  receiptAddress(proposalId: string, voter: PublicKey): PublicKey {
    return votePda(new PublicKey(proposalId), voter, this.#ctx.programId);
  }

  /** Tie a proposal address to its organization, for proposals found elsewhere. */
  adopt(proposalId: string, org: EntityId): void {
    this.#owners.set(proposalId, org);
  }

  // ------------------------------------------------------------ internals

  #ownerOf(proposalId: string): EntityId {
    const org = this.#owners.get(proposalId);
    if (!org) {
      throw new Error(
        `proposal ${proposalId} is not known to this service; call open() or adopt() first`,
      );
    }
    return org;
  }

  async #settingsFor(org: EntityId): Promise<OrgAccount> {
    const cached = this.#settings.get(org);
    if (cached) return cached;
    const ctx = this.#ctx;
    const spec = specFor(ctx, org);
    const data = await ctx.getAccount(orgPda(ctx.world.worldId, spec.index, ctx.programId));
    if (!data) throw new Error(`organization "${org}" has no treasury yet`);
    const decoded = decodeOrg(data);
    this.#settings.set(org, decoded);
    return decoded;
  }

  async #decode(proposal: PublicKey): Promise<ProposalAccount> {
    const data = await this.#ctx.getAccount(proposal);
    if (!data) throw new Error(`no proposal at ${proposal.toBase58()}`);
    return decodeProposal(data);
  }

  async #read(id: string, org: EntityId): Promise<Proposal> {
    return this.#toPortProposal(id, org, await this.#decode(new PublicKey(id)));
  }

  #toPortProposal(id: string, org: EntityId, account: ProposalAccount): Proposal {
    const ctx = this.#ctx;
    const spec = specFor(ctx, org);
    const decimals = ctx.mints.decimalsFor(spec.treasuryResource);
    const toTick = (unix: bigint) =>
      unixSecondsToTick(Number(unix), ctx.world.tickMs, ctx.genesisUnixMs);

    const action: Proposal['action'] =
      account.kind === KIND_SIGNAL
        ? { kind: 'signal', text: this.#signals.get(id) ?? '' }
        : {
            kind: 'disburse',
            to: ctx.keyring.entityFor(account.recipient) ?? account.recipient.toBase58(),
            amount: fromMinorUnits(account.amount, decimals),
          };

    return {
      id,
      org,
      proposer: ctx.keyring.entityFor(account.proposer) ?? account.proposer.toBase58(),
      action,
      opensAtTick: toTick(account.opensAt),
      closesAtTick: toTick(account.closesAt),
      votesFor: Number(account.weightFor),
      votesAgainst: Number(account.weightAgainst),
      executed: account.executed,
    };
  }
}
