//! `org` — treasuries, governance and escrow for any world's organizations.
//!
//! An organization is not a special kind of thing. A firm, a guild, a DAO and a
//! realm are the same three accounts with different numbers in them (brief §18):
//! an [`Org`] holding the rule set, a treasury that is a **real SPL token account**
//! owned by a program address, and whatever [`Proposal`]s are open against it.
//!
//! Nothing in this file knows a world's vocabulary. No entity type, no rank and no
//! stake is named anywhere below. The world file says
//! `governance.mechanism = "token_weighted"` or `"council"`, the client maps that
//! string onto one of the six [`mechanism`] bytes, and the same code runs.
//!
//! Three claims this program is built to make good on:
//!
//! 1. **Money only leaves a treasury through governance.** [`disburse`] takes a
//!    proposal account and recomputes the tally against the threshold that was
//!    recorded when the proposal opened. There is no other instruction that can move
//!    a lamport of a treasury's balance, and no authority — not even the org's —
//!    that can override it.
//! 2. **Vote weight is read, never asserted.** [`cast_vote`] takes one argument:
//!    `support: bool`. The weight comes from a token account balance the voter owns
//!    or a [`Member`] record only the org's authority can write. A client cannot
//!    pass a number, so a client cannot inflate one.
//! 3. **A swap is atomic or it does not happen.** [`accept_escrow`] moves both legs
//!    in one instruction. A taker who cannot pay receives nothing, because the
//!    transaction that would have paid them fails as a whole.

use anchor_lang::prelude::*;
use anchor_spl::token::{
    self, CloseAccount, Mint, Token, TokenAccount, Transfer,
};

declare_id!("75xzyWGNtgiB6cKtTFnZE7giPpUuyap2V6KJxu5rsaF");

// ------------------------------------------------------------------ vocabulary

/// Governance mechanisms, in the order `GovernanceMechanism` declares them in
/// `packages/types/src/chain.ts`. The client maps the world's string onto this byte;
/// the program never sees the string, so no world's wording leaks in here.
pub mod mechanism {
    pub const LEADER: u8 = 0;
    pub const MAJORITY_VOTE: u8 = 1;
    pub const TOKEN_WEIGHTED: u8 = 2;
    pub const REPUTATION_WEIGHTED: u8 = 3;
    pub const COUNCIL: u8 = 4;
    pub const CONSENSUS: u8 = 5;
    pub const COUNT: u8 = 6;
}

/// What passing a proposal does. Mirrors `Proposal['action']` in `chain-ports.ts`.
pub mod kind {
    /// Move `amount` of the treasury's token to `recipient`.
    pub const DISBURSE: u8 = 0;
    /// Record an opinion. Costs nothing and moves nothing.
    pub const SIGNAL: u8 = 1;
}

/// Bits in [`Member::roles`]. Whatever a world calls its ranks, each one is one of
/// these bits plus a weight; the word itself stays in the world file.
pub mod roles {
    /// Eligible to vote at all.
    pub const MEMBER: u8 = 1 << 0;
    /// Seats on the council, for `council` governance.
    pub const COUNCIL: u8 = 1 << 1;
    /// The single voice, for `leader` governance.
    pub const LEADER: u8 = 1 << 2;
}

/// Basis points in a whole. A threshold of 0.6 in the world file is 6,000 here.
pub const BPS: u128 = 10_000;

// ------------------------------------------------------------------ pure logic
//
// Everything a security claim rests on lives in this section as a plain function of
// plain numbers, so `cargo test` can hold it to account without a validator.

/// Does a tally clear its threshold?
///
/// The denominator is the weight actually cast, not the weight that exists. A world
/// that wants a quorum expresses it as a threshold against turnout; a world that
/// wants unanimity picks `consensus`, which is the one mechanism where a single vote
/// against is fatal regardless of how the numbers land.
///
/// Note the `>=`: a threshold is a bar to reach, not to clear. At 6,000 bps, 60
/// for and 40 against passes and 59 for and 41 against does not.
pub fn proposal_passed(
    weight_for: u64,
    weight_against: u64,
    threshold_bps: u16,
    mechanism: u8,
) -> bool {
    let total = weight_for as u128 + weight_against as u128;
    if total == 0 || weight_for == 0 {
        // Nobody voted, or nobody voted for it. Silence is not consent.
        return false;
    }
    match mechanism {
        // One voice decides, and it still has to be a voice in favour.
        mechanism::LEADER => weight_for > weight_against,
        // Unanimity among those who turned out. One objection sinks it.
        mechanism::CONSENSUS => weight_against == 0,
        _ => (weight_for as u128) * BPS >= total * (threshold_bps as u128),
    }
}

/// Where a voter's weight came from. Built by the handler out of accounts it has
/// already checked; never out of instruction data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WeightSource {
    /// The balance of a token account the voter owns, in the org's weight mint.
    TokenBalance(u64),
    /// A [`Member`] record written by the org's authority.
    Member { weight: u64, roles: u8 },
    /// The voter brought neither.
    Missing,
}

/// Turn an on-chain fact into a vote weight, according to the mechanism.
///
/// The mechanism decides which fact counts. `token_weighted` counts tokens;
/// `council` counts seats but only for those holding one; `majority_vote` and
/// `consensus` count heads. No branch reads anything the voter could have typed.
pub fn resolve_weight(mechanism: u8, source: WeightSource) -> Result<u64> {
    let weight = match (mechanism, source) {
        (mechanism::TOKEN_WEIGHTED, WeightSource::TokenBalance(amount)) => amount,
        (mechanism::TOKEN_WEIGHTED, _) => return err!(OrgErr::WeightAccountMissing),

        (mechanism::MAJORITY_VOTE, WeightSource::Member { roles: r, .. })
        | (mechanism::CONSENSUS, WeightSource::Member { roles: r, .. }) => {
            require!(r & roles::MEMBER != 0, OrgErr::NotAMember);
            // One member, one vote. The record's weight is deliberately ignored.
            1
        }

        (mechanism::REPUTATION_WEIGHTED, WeightSource::Member { weight, roles: r }) => {
            require!(r & roles::MEMBER != 0, OrgErr::NotAMember);
            weight
        }

        (mechanism::COUNCIL, WeightSource::Member { weight, roles: r }) => {
            require!(r & roles::COUNCIL != 0, OrgErr::NotOnCouncil);
            weight
        }

        (mechanism::LEADER, WeightSource::Member { weight, roles: r }) => {
            require!(r & roles::LEADER != 0, OrgErr::NotTheLeader);
            // A leader's say-so is one vote even if nobody set a weight.
            weight.max(1)
        }

        (m, _) if m >= mechanism::COUNT => return err!(OrgErr::UnknownMechanism),
        _ => return err!(OrgErr::WeightAccountMissing),
    };
    require!(weight > 0, OrgErr::NoVotingWeight);
    Ok(weight)
}

/// May this token account stand for this voter's weight?
///
/// The obvious attack on `token_weighted` is to point at somebody else's balance —
/// the org's own treasury, say, or the largest holder's account. Both checks are
/// cheap and both are load-bearing.
pub fn check_weight_account(
    account_owner: &Pubkey,
    account_mint: &Pubkey,
    voter: &Pubkey,
    weight_mint: &Pubkey,
) -> Result<()> {
    require_keys_eq!(*account_owner, *voter, OrgErr::WeightAccountNotYours);
    require_keys_eq!(*account_mint, *weight_mint, OrgErr::WrongMint);
    Ok(())
}

/// Is this proposal in a state where treasury funds may move?
///
/// This is the whole security claim of the treasury in one function: a disbursement
/// needs a proposal that is of the right kind, whose voting has closed, whose tally
/// clears its own recorded threshold, and which has not already paid out.
pub fn check_disbursable(p: &Proposal, now: u64) -> Result<()> {
    require!(p.kind == kind::DISBURSE, OrgErr::NotADisbursement);
    require!(!p.executed, OrgErr::AlreadyExecuted);
    require!(now >= p.closes_at, OrgErr::VotingStillOpen);
    require!(
        proposal_passed(p.weight_for, p.weight_against, p.threshold_bps, p.mechanism),
        OrgErr::ProposalDidNotPass
    );
    require!(p.amount > 0, OrgErr::ZeroAmount);
    Ok(())
}

/// Is the voting window open at `now`?
pub fn check_voting_window(p: &Proposal, now: u64) -> Result<()> {
    require!(now >= p.opens_at, OrgErr::VotingNotStarted);
    require!(now < p.closes_at, OrgErr::VotingClosed);
    Ok(())
}

/// Only the maker may cancel an escrow, and reclaim exactly what they put in.
pub fn check_cancel(escrow_maker: &Pubkey, signer: &Pubkey) -> Result<()> {
    require_keys_eq!(*escrow_maker, *signer, OrgErr::NotTheMaker);
    Ok(())
}

/// Both legs of a swap, checked before either of them moves.
///
/// The taker pays from an account they own, in the mint the maker asked for, and
/// receives into an account they own, in the mint the maker put up. Getting any of
/// these wrong is how a swap turns into a gift.
#[allow(clippy::too_many_arguments)]
pub fn check_swap(
    taker: &Pubkey,
    maker: &Pubkey,
    payment_owner: &Pubkey,
    payment_mint: &Pubkey,
    payment_balance: u64,
    maker_receive_owner: &Pubkey,
    maker_receive_mint: &Pubkey,
    taker_receive_owner: &Pubkey,
    taker_receive_mint: &Pubkey,
    want_mint: &Pubkey,
    want_amount: u64,
    give_mint: &Pubkey,
) -> Result<()> {
    require_keys_eq!(*payment_owner, *taker, OrgErr::PaymentNotYours);
    require_keys_eq!(*payment_mint, *want_mint, OrgErr::WrongMint);
    require!(payment_balance >= want_amount, OrgErr::InsufficientFunds);
    require_keys_eq!(*maker_receive_owner, *maker, OrgErr::WrongRecipient);
    require_keys_eq!(*maker_receive_mint, *want_mint, OrgErr::WrongMint);
    require_keys_eq!(*taker_receive_owner, *taker, OrgErr::WrongRecipient);
    require_keys_eq!(*taker_receive_mint, *give_mint, OrgErr::WrongMint);
    Ok(())
}

// ------------------------------------------------------------------ program

#[program]
pub mod org {
    use super::*;

    /// Open an organization and its treasury.
    ///
    /// The treasury is a genuine SPL token account living at
    /// `["treasury", world_id, org_index]`, and its token authority is itself: the
    /// program address signs for it, so no human key can move the balance. The
    /// governance rules are copied in here, once, from the world file — which is why
    /// a proposal can later be judged against a threshold nobody was able to choose
    /// after seeing the votes.
    pub fn open_treasury(
        ctx: Context<OpenTreasury>,
        world_id: [u8; 32],
        org_index: u16,
        mechanism: u8,
        threshold_bps: u16,
    ) -> Result<()> {
        require!(mechanism < mechanism::COUNT, OrgErr::UnknownMechanism);
        require!(threshold_bps as u128 <= BPS, OrgErr::ThresholdOutOfRange);

        let org = &mut ctx.accounts.org;
        org.authority = ctx.accounts.authority.key();
        org.world_id = world_id;
        org.org_index = org_index;
        org.mint = ctx.accounts.mint.key();
        org.treasury = ctx.accounts.treasury.key();
        org.weight_mint = ctx
            .accounts
            .weight_mint
            .as_ref()
            .map(|m| m.key())
            .unwrap_or_default();
        org.mechanism = mechanism;
        org.threshold_bps = threshold_bps;
        org.total_weight = 0;
        org.member_count = 0;
        org.proposal_nonce = 0;
        org.bump = ctx.bumps.org;
        org.treasury_bump = ctx.bumps.treasury;

        // `token_weighted` without a weight mint would silently fall back to "nobody
        // can vote". Better to refuse the configuration than to ship a dead org.
        if mechanism == mechanism::TOKEN_WEIGHTED {
            require!(org.weight_mint != Pubkey::default(), OrgErr::WeightMintRequired);
        }

        emit!(TreasuryOpened {
            org: org.key(),
            treasury: org.treasury,
            mint: org.mint,
            mechanism,
            threshold_bps,
        });
        Ok(())
    }

    /// Put tokens into a treasury. Anyone may; that is what a treasury is for.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, OrgErr::ZeroAmount);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.from.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            amount,
        )?;
        emit!(Deposited {
            org: ctx.accounts.org.key(),
            from: ctx.accounts.depositor.key(),
            amount,
        });
        Ok(())
    }

    /// Record who may vote and how much their voice is worth.
    ///
    /// Only the org's authority writes these, which is exactly why a voter cannot.
    /// For `token_weighted` this instruction is unnecessary — the token ledger is
    /// already the register of who holds what.
    pub fn upsert_member(ctx: Context<UpsertMember>, weight: u64, roles: u8) -> Result<()> {
        let fresh = ctx.accounts.member.authority == Pubkey::default();
        let previous = if fresh { 0 } else { ctx.accounts.member.weight };

        let member = &mut ctx.accounts.member;
        member.org = ctx.accounts.org.key();
        member.authority = ctx.accounts.member_authority.key();
        member.weight = weight;
        member.roles = roles;
        member.bump = ctx.bumps.member;

        let org = &mut ctx.accounts.org;
        org.total_weight = org
            .total_weight
            .saturating_sub(previous)
            .saturating_add(weight);
        if fresh {
            org.member_count = org.member_count.saturating_add(1);
        }
        Ok(())
    }

    /// Open a proposal against a treasury.
    ///
    /// `mechanism` and `threshold_bps` are copied from the org rather than taken as
    /// arguments. A proposer who could name their own threshold could pass anything.
    pub fn create_proposal(
        ctx: Context<CreateProposal>,
        kind_byte: u8,
        recipient: Pubkey,
        amount: u64,
        opens_at: u64,
        closes_at: u64,
    ) -> Result<()> {
        require!(kind_byte <= kind::SIGNAL, OrgErr::UnknownProposalKind);
        require!(closes_at > opens_at, OrgErr::EmptyVotingWindow);
        if kind_byte == kind::DISBURSE {
            require!(amount > 0, OrgErr::ZeroAmount);
            require!(recipient != Pubkey::default(), OrgErr::WrongRecipient);
        }

        let org = &mut ctx.accounts.org;
        let nonce = org.proposal_nonce;
        org.proposal_nonce = nonce.checked_add(1).ok_or(OrgErr::NonceOverflow)?;

        let p = &mut ctx.accounts.proposal;
        p.org = org.key();
        p.proposer = ctx.accounts.proposer.key();
        p.kind = kind_byte;
        p.recipient = recipient;
        p.amount = amount;
        p.opens_at = opens_at;
        p.closes_at = closes_at;
        p.weight_for = 0;
        p.weight_against = 0;
        p.threshold_bps = org.threshold_bps;
        p.mechanism = org.mechanism;
        p.executed = false;

        emit!(ProposalOpened {
            proposal: p.key(),
            org: p.org,
            nonce,
            kind: kind_byte,
            recipient,
            amount,
            closes_at,
            mechanism: p.mechanism,
            threshold_bps: p.threshold_bps,
        });
        Ok(())
    }

    /// Vote. The only argument is which way.
    ///
    /// The weight is read out of chain state — a token balance the voter owns, or a
    /// member record the org wrote — and a receipt account is created at
    /// `["vote", proposal, voter]`, so the second attempt fails on account creation
    /// before any tally is touched.
    pub fn cast_vote(ctx: Context<CastVote>, support: bool) -> Result<()> {
        let now = Clock::get()?.unix_timestamp as u64;
        check_voting_window(&ctx.accounts.proposal, now)?;

        let org = &ctx.accounts.org;
        let voter = ctx.accounts.voter.key();

        let source = match org.mechanism {
            mechanism::TOKEN_WEIGHTED => {
                let account = ctx
                    .accounts
                    .weight_token_account
                    .as_ref()
                    .ok_or(OrgErr::WeightAccountMissing)?;
                check_weight_account(&account.owner, &account.mint, &voter, &org.weight_mint)?;
                WeightSource::TokenBalance(account.amount)
            }
            _ => match ctx.accounts.member.as_ref() {
                Some(m) => {
                    require_keys_eq!(m.org, org.key(), OrgErr::WrongOrg);
                    require_keys_eq!(m.authority, voter, OrgErr::WeightAccountNotYours);
                    WeightSource::Member { weight: m.weight, roles: m.roles }
                }
                None => WeightSource::Missing,
            },
        };
        let weight = resolve_weight(org.mechanism, source)?;

        let p = &mut ctx.accounts.proposal;
        if support {
            p.weight_for = p.weight_for.checked_add(weight).ok_or(OrgErr::TallyOverflow)?;
        } else {
            p.weight_against =
                p.weight_against.checked_add(weight).ok_or(OrgErr::TallyOverflow)?;
        }

        let receipt = &mut ctx.accounts.receipt;
        receipt.proposal = p.key();
        receipt.voter = voter;
        receipt.weight = weight;
        receipt.support = support;
        receipt.bump = ctx.bumps.receipt;

        emit!(VoteCast { proposal: p.key(), voter, weight, support });
        Ok(())
    }

    /// Close the vote and, if it passed and it was a disbursement, pay it out — in
    /// this transaction.
    ///
    /// Brief §19 asks that a governance decision *be* a Solana transaction rather
    /// than a note that one should happen later, so the tally and the transfer share
    /// a signature. A proposal that fails is left alone: the tally stays on chain as
    /// the record of why nothing moved.
    pub fn finalize(ctx: Context<Finalize>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp as u64;
        let p = &ctx.accounts.proposal;
        require!(now >= p.closes_at, OrgErr::VotingStillOpen);
        require!(!p.executed, OrgErr::AlreadyExecuted);

        let passed = proposal_passed(p.weight_for, p.weight_against, p.threshold_bps, p.mechanism);
        let mut executed = false;

        if passed && p.kind == kind::DISBURSE {
            let recipient_account = ctx
                .accounts
                .recipient_token_account
                .as_ref()
                .ok_or(OrgErr::RecipientAccountMissing)?;
            pay_out(
                &ctx.accounts.org,
                p,
                &ctx.accounts.treasury,
                recipient_account,
                &ctx.accounts.token_program,
            )?;
            executed = true;
        }

        if executed {
            ctx.accounts.proposal.executed = true;
        }

        emit!(Finalized {
            proposal: ctx.accounts.proposal.key(),
            passed,
            executed,
            weight_for: ctx.accounts.proposal.weight_for,
            weight_against: ctx.accounts.proposal.weight_against,
            threshold_bps: ctx.accounts.proposal.threshold_bps,
        });
        Ok(())
    }

    /// Pay out a proposal that has already passed.
    ///
    /// The counterpart to [`finalize`] for the case where the recipient's token
    /// account did not exist yet when the vote closed. It asks the same question and
    /// accepts the same answer: a proposal account, of the right kind, closed,
    /// carrying a tally that clears its own threshold, not yet executed. Call it
    /// with a proposal that nobody voted for and it fails — which is the point, and
    /// what `disburse_without_a_passing_proposal_is_rejected` pins down.
    pub fn disburse(ctx: Context<Disburse>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp as u64;
        check_disbursable(&ctx.accounts.proposal, now)?;
        pay_out(
            &ctx.accounts.org,
            &ctx.accounts.proposal,
            &ctx.accounts.treasury,
            &ctx.accounts.recipient_token_account,
            &ctx.accounts.token_program,
        )?;
        ctx.accounts.proposal.executed = true;
        emit!(Disbursed {
            proposal: ctx.accounts.proposal.key(),
            to: ctx.accounts.recipient_token_account.key(),
            amount: ctx.accounts.proposal.amount,
        });
        Ok(())
    }

    /// Lock up what you are offering. The vault holds it until somebody takes the
    /// other side or you take it back.
    pub fn create_escrow(
        ctx: Context<CreateEscrow>,
        escrow_id: u64,
        give_amount: u64,
        want_amount: u64,
    ) -> Result<()> {
        require!(give_amount > 0 && want_amount > 0, OrgErr::ZeroAmount);

        let e = &mut ctx.accounts.escrow;
        e.maker = ctx.accounts.maker.key();
        e.escrow_id = escrow_id;
        e.give_mint = ctx.accounts.give_mint.key();
        e.want_mint = ctx.accounts.want_mint.key();
        e.give_amount = give_amount;
        e.want_amount = want_amount;
        e.vault = ctx.accounts.vault.key();
        e.bump = ctx.bumps.escrow;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.maker_give_account.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.maker.to_account_info(),
                },
            ),
            give_amount,
        )?;

        emit!(EscrowCreated {
            escrow: e.key(),
            maker: e.maker,
            give_mint: e.give_mint,
            give_amount,
            want_mint: e.want_mint,
            want_amount,
        });
        Ok(())
    }

    /// Take the other side. Both legs move here or neither does.
    ///
    /// The taker's payment goes out first and the vault's release second, in the same
    /// instruction. There is no ordering that lets a taker receive without paying:
    /// if the payment fails, the release never runs, and if the release fails the
    /// payment is rolled back with the rest of the transaction.
    pub fn accept_escrow(ctx: Context<AcceptEscrow>) -> Result<()> {
        let e = &ctx.accounts.escrow;
        check_swap(
            &ctx.accounts.taker.key(),
            &e.maker,
            &ctx.accounts.taker_payment_account.owner,
            &ctx.accounts.taker_payment_account.mint,
            ctx.accounts.taker_payment_account.amount,
            &ctx.accounts.maker_receive_account.owner,
            &ctx.accounts.maker_receive_account.mint,
            &ctx.accounts.taker_receive_account.owner,
            &ctx.accounts.taker_receive_account.mint,
            &e.want_mint,
            e.want_amount,
            &e.give_mint,
        )?;

        // Leg one: the taker pays the maker.
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.taker_payment_account.to_account_info(),
                    to: ctx.accounts.maker_receive_account.to_account_info(),
                    authority: ctx.accounts.taker.to_account_info(),
                },
            ),
            e.want_amount,
        )?;

        // Leg two: the vault releases to the taker.
        let maker = e.maker;
        let id = e.escrow_id.to_le_bytes();
        let seeds: &[&[u8]] = &[b"escrow", maker.as_ref(), id.as_ref(), &[e.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.taker_receive_account.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                &[seeds],
            ),
            e.give_amount,
        )?;

        let rent_destination = ctx.accounts.maker_account.to_account_info();
        close_vault(
            &ctx.accounts.vault,
            &ctx.accounts.escrow,
            &rent_destination,
            &ctx.accounts.token_program,
            seeds,
        )?;

        emit!(EscrowAccepted {
            escrow: ctx.accounts.escrow.key(),
            taker: ctx.accounts.taker.key(),
            give_amount: ctx.accounts.escrow.give_amount,
            want_amount: ctx.accounts.escrow.want_amount,
        });
        Ok(())
    }

    /// Take your offer back. Maker only; the constraint is on the account, and
    /// `check_cancel` restates it so a test can hold the rule rather than the wiring.
    pub fn cancel_escrow(ctx: Context<CancelEscrow>) -> Result<()> {
        check_cancel(&ctx.accounts.escrow.maker, &ctx.accounts.maker.key())?;

        let e = &ctx.accounts.escrow;
        let maker = e.maker;
        let id = e.escrow_id.to_le_bytes();
        let seeds: &[&[u8]] = &[b"escrow", maker.as_ref(), id.as_ref(), &[e.bump]];
        let refund = ctx.accounts.vault.amount;

        if refund > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.maker_give_account.to_account_info(),
                        authority: ctx.accounts.escrow.to_account_info(),
                    },
                    &[seeds],
                ),
                refund,
            )?;
        }

        let refund_destination = ctx.accounts.maker.to_account_info();
        close_vault(
            &ctx.accounts.vault,
            &ctx.accounts.escrow,
            &refund_destination,
            &ctx.accounts.token_program,
            seeds,
        )?;

        emit!(EscrowCancelled { escrow: ctx.accounts.escrow.key(), refunded: refund });
        Ok(())
    }
}

// ------------------------------------------------------------------ helpers

/// The one place treasury funds move. Both callers reach it only past a check that
/// the proposal passed.
fn pay_out<'info>(
    org: &Account<'info, Org>,
    proposal: &Proposal,
    treasury: &Account<'info, TokenAccount>,
    recipient: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
) -> Result<()> {
    require_keys_eq!(recipient.mint, org.mint, OrgErr::WrongMint);
    require_keys_eq!(recipient.owner, proposal.recipient, OrgErr::WrongRecipient);
    require!(treasury.amount >= proposal.amount, OrgErr::InsufficientFunds);

    let index = org.org_index.to_le_bytes();
    let seeds: &[&[u8]] = &[
        b"treasury",
        org.world_id.as_ref(),
        index.as_ref(),
        &[org.treasury_bump],
    ];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.key(),
            Transfer {
                from: treasury.to_account_info(),
                to: recipient.to_account_info(),
                authority: treasury.to_account_info(),
            },
            &[seeds],
        ),
        proposal.amount,
    )
}

/// Hand the vault's rent back and stop the account existing. An escrow that has
/// settled should leave nothing behind to settle again.
fn close_vault<'info>(
    vault: &Account<'info, TokenAccount>,
    escrow: &Account<'info, Escrow>,
    destination: &AccountInfo<'info>,
    token_program: &Program<'info, Token>,
    seeds: &[&[u8]],
) -> Result<()> {
    token::close_account(CpiContext::new_with_signer(
        token_program.key(),
        CloseAccount {
            account: vault.to_account_info(),
            destination: destination.clone(),
            authority: escrow.to_account_info(),
        },
        &[seeds],
    ))
}

// ------------------------------------------------------------------ accounts

/// An organization's rule set. Written once, read by every proposal.
#[account]
#[derive(InitSpace)]
pub struct Org {
    /// May write [`Member`] records. May **not** move treasury funds.
    pub authority: Pubkey,
    /// Identifies the world this org belongs to; part of the treasury seed.
    pub world_id: [u8; 32],
    pub org_index: u16,
    /// The treasury's token, i.e. the world's `treasuryResource`.
    pub mint: Pubkey,
    pub treasury: Pubkey,
    /// The stake mint for `token_weighted`. Default when unused.
    pub weight_mint: Pubkey,
    pub mechanism: u8,
    pub threshold_bps: u16,
    /// Sum of member weights. Informational; the tally is against turnout.
    pub total_weight: u64,
    pub member_count: u32,
    pub proposal_nonce: u64,
    pub bump: u8,
    pub treasury_bump: u8,
}

/// Who may vote, and how loudly. The on-chain identity record that
/// `council` and `reputation_weighted` read instead of trusting the client.
#[account]
#[derive(InitSpace)]
pub struct Member {
    pub org: Pubkey,
    pub authority: Pubkey,
    /// Seats, standing, rank — whatever the world's `weightBy` names.
    pub weight: u64,
    /// See [`roles`].
    pub roles: u8,
    pub bump: u8,
}

/// A decision in progress. The layout the client decodes; see
/// `packages/solana/src/org-program.ts`.
#[account]
#[derive(InitSpace)]
pub struct Proposal {
    pub org: Pubkey,
    pub proposer: Pubkey,
    /// See [`kind`].
    pub kind: u8,
    pub recipient: Pubkey,
    pub amount: u64,
    pub opens_at: u64,
    pub closes_at: u64,
    pub weight_for: u64,
    pub weight_against: u64,
    /// Copied from the org when the proposal opened, so it cannot move afterwards.
    pub threshold_bps: u16,
    /// See [`mechanism`].
    pub mechanism: u8,
    pub executed: bool,
}

/// Proof that this voter has already voted on this proposal. Its existence is the
/// whole mechanism: a second `cast_vote` cannot create it twice.
#[account]
#[derive(InitSpace)]
pub struct VoteReceipt {
    pub proposal: Pubkey,
    pub voter: Pubkey,
    /// What the chain said the voter was worth at the moment they voted.
    pub weight: u64,
    pub support: bool,
    pub bump: u8,
}

/// A bilateral offer with the maker's side already paid in.
#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub maker: Pubkey,
    pub escrow_id: u64,
    pub give_mint: Pubkey,
    pub want_mint: Pubkey,
    pub give_amount: u64,
    pub want_amount: u64,
    pub vault: Pubkey,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(world_id: [u8; 32], org_index: u16)]
pub struct OpenTreasury<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Org::INIT_SPACE,
        seeds = [b"org", world_id.as_ref(), org_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub org: Account<'info, Org>,
    pub mint: Account<'info, Mint>,
    /// The treasury itself: an SPL token account at a program address, holding the
    /// authority over its own balance.
    #[account(
        init,
        payer = authority,
        seeds = [b"treasury", world_id.as_ref(), org_index.to_le_bytes().as_ref()],
        bump,
        token::mint = mint,
        token::authority = treasury,
    )]
    pub treasury: Account<'info, TokenAccount>,
    /// Present only for `token_weighted`.
    pub weight_mint: Option<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    pub org: Account<'info, Org>,
    #[account(mut, address = org.treasury @ OrgErr::WrongTreasury)]
    pub treasury: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = from.owner == depositor.key() @ OrgErr::PaymentNotYours,
        constraint = from.mint == org.mint @ OrgErr::WrongMint,
    )]
    pub from: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UpsertMember<'info> {
    #[account(mut, address = org.authority @ OrgErr::Unauthorized)]
    pub authority: Signer<'info>,
    #[account(mut)]
    pub org: Account<'info, Org>,
    /// CHECK: the identity being described. Not a signer: membership is conferred,
    /// not claimed, and nothing is read out of this account.
    pub member_authority: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + Member::INIT_SPACE,
        seeds = [b"member", org.key().as_ref(), member_authority.key().as_ref()],
        bump,
    )]
    pub member: Account<'info, Member>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateProposal<'info> {
    #[account(mut)]
    pub proposer: Signer<'info>,
    #[account(mut)]
    pub org: Account<'info, Org>,
    #[account(address = org.treasury @ OrgErr::WrongTreasury)]
    pub treasury: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = proposer,
        space = 8 + Proposal::INIT_SPACE,
        seeds = [b"proposal", treasury.key().as_ref(), org.proposal_nonce.to_le_bytes().as_ref()],
        bump,
    )]
    pub proposal: Account<'info, Proposal>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CastVote<'info> {
    #[account(mut)]
    pub voter: Signer<'info>,
    pub org: Account<'info, Org>,
    #[account(mut, constraint = proposal.org == org.key() @ OrgErr::WrongOrg)]
    pub proposal: Account<'info, Proposal>,
    /// One per voter per proposal. The second attempt fails here, in account
    /// creation, before the tally is touched.
    #[account(
        init,
        payer = voter,
        space = 8 + VoteReceipt::INIT_SPACE,
        seeds = [b"vote", proposal.key().as_ref(), voter.key().as_ref()],
        bump,
    )]
    pub receipt: Account<'info, VoteReceipt>,
    /// For `token_weighted`: the voter's own balance in the org's weight mint.
    pub weight_token_account: Option<Account<'info, TokenAccount>>,
    /// For every other mechanism: the record the org's authority wrote.
    pub member: Option<Account<'info, Member>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Finalize<'info> {
    /// Anyone may close a vote. Nobody can change what it says.
    pub finalizer: Signer<'info>,
    pub org: Account<'info, Org>,
    #[account(mut, constraint = proposal.org == org.key() @ OrgErr::WrongOrg)]
    pub proposal: Account<'info, Proposal>,
    #[account(mut, address = org.treasury @ OrgErr::WrongTreasury)]
    pub treasury: Account<'info, TokenAccount>,
    /// Required when the proposal is a disbursement and it passes.
    #[account(mut)]
    pub recipient_token_account: Option<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Disburse<'info> {
    pub caller: Signer<'info>,
    pub org: Account<'info, Org>,
    #[account(mut, constraint = proposal.org == org.key() @ OrgErr::WrongOrg)]
    pub proposal: Account<'info, Proposal>,
    #[account(mut, address = org.treasury @ OrgErr::WrongTreasury)]
    pub treasury: Account<'info, TokenAccount>,
    #[account(mut)]
    pub recipient_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct CreateEscrow<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    #[account(
        init,
        payer = maker,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [b"escrow", maker.key().as_ref(), escrow_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub escrow: Account<'info, Escrow>,
    pub give_mint: Account<'info, Mint>,
    pub want_mint: Account<'info, Mint>,
    #[account(
        mut,
        constraint = maker_give_account.owner == maker.key() @ OrgErr::PaymentNotYours,
        constraint = maker_give_account.mint == give_mint.key() @ OrgErr::WrongMint,
    )]
    pub maker_give_account: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = maker,
        seeds = [b"vault", escrow.key().as_ref()],
        bump,
        token::mint = give_mint,
        token::authority = escrow,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AcceptEscrow<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,
    #[account(
        mut,
        close = maker_account,
        seeds = [b"escrow", escrow.maker.as_ref(), escrow.escrow_id.to_le_bytes().as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, Escrow>,
    /// CHECK: the maker, as rent destination. Pinned to the escrow's own record.
    #[account(mut, address = escrow.maker @ OrgErr::NotTheMaker)]
    pub maker_account: UncheckedAccount<'info>,
    #[account(mut, address = escrow.vault @ OrgErr::WrongVault)]
    pub vault: Account<'info, TokenAccount>,
    /// The taker pays from here.
    #[account(mut)]
    pub taker_payment_account: Account<'info, TokenAccount>,
    /// The maker is paid into here.
    #[account(mut)]
    pub maker_receive_account: Account<'info, TokenAccount>,
    /// The taker is paid into here.
    #[account(mut)]
    pub taker_receive_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelEscrow<'info> {
    /// The account constraint already says maker-only; `cancel_escrow` says it again
    /// in code so the rule is testable without a validator.
    #[account(mut)]
    pub maker: Signer<'info>,
    #[account(
        mut,
        close = maker,
        seeds = [b"escrow", escrow.maker.as_ref(), escrow.escrow_id.to_le_bytes().as_ref()],
        bump = escrow.bump,
        constraint = escrow.maker == maker.key() @ OrgErr::NotTheMaker,
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, address = escrow.vault @ OrgErr::WrongVault)]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = maker_give_account.owner == maker.key() @ OrgErr::WrongRecipient,
        constraint = maker_give_account.mint == escrow.give_mint @ OrgErr::WrongMint,
    )]
    pub maker_give_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

// ------------------------------------------------------------------ events

#[event]
pub struct TreasuryOpened {
    pub org: Pubkey,
    pub treasury: Pubkey,
    pub mint: Pubkey,
    pub mechanism: u8,
    pub threshold_bps: u16,
}

#[event]
pub struct Deposited {
    pub org: Pubkey,
    pub from: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ProposalOpened {
    pub proposal: Pubkey,
    pub org: Pubkey,
    pub nonce: u64,
    pub kind: u8,
    pub recipient: Pubkey,
    pub amount: u64,
    pub closes_at: u64,
    pub mechanism: u8,
    pub threshold_bps: u16,
}

#[event]
pub struct VoteCast {
    pub proposal: Pubkey,
    pub voter: Pubkey,
    pub weight: u64,
    pub support: bool,
}

#[event]
pub struct Finalized {
    pub proposal: Pubkey,
    pub passed: bool,
    pub executed: bool,
    pub weight_for: u64,
    pub weight_against: u64,
    pub threshold_bps: u16,
}

#[event]
pub struct Disbursed {
    pub proposal: Pubkey,
    pub to: Pubkey,
    pub amount: u64,
}

#[event]
pub struct EscrowCreated {
    pub escrow: Pubkey,
    pub maker: Pubkey,
    pub give_mint: Pubkey,
    pub give_amount: u64,
    pub want_mint: Pubkey,
    pub want_amount: u64,
}

#[event]
pub struct EscrowAccepted {
    pub escrow: Pubkey,
    pub taker: Pubkey,
    pub give_amount: u64,
    pub want_amount: u64,
}

#[event]
pub struct EscrowCancelled {
    pub escrow: Pubkey,
    pub refunded: u64,
}

// ------------------------------------------------------------------ errors

#[error_code]
pub enum OrgErr {
    #[msg("governance mechanism byte is not one of the six")]
    UnknownMechanism,
    #[msg("threshold must be between 0 and 10000 basis points")]
    ThresholdOutOfRange,
    #[msg("token_weighted governance needs a weight mint")]
    WeightMintRequired,
    #[msg("proposal kind must be disburse or signal")]
    UnknownProposalKind,
    #[msg("a proposal must close after it opens")]
    EmptyVotingWindow,
    #[msg("voting has not opened yet")]
    VotingNotStarted,
    #[msg("voting has closed")]
    VotingClosed,
    #[msg("voting is still open")]
    VotingStillOpen,
    #[msg("this proposal did not pass its threshold")]
    ProposalDidNotPass,
    #[msg("this proposal has already been executed")]
    AlreadyExecuted,
    #[msg("this proposal does not disburse anything")]
    NotADisbursement,
    #[msg("no weight account was supplied for this mechanism")]
    WeightAccountMissing,
    #[msg("that weight account does not belong to the voter")]
    WeightAccountNotYours,
    #[msg("the voter has no weight in this organization")]
    NoVotingWeight,
    #[msg("the voter is not a member of this organization")]
    NotAMember,
    #[msg("the voter does not hold a council seat")]
    NotOnCouncil,
    #[msg("the voter is not this organization's leader")]
    NotTheLeader,
    #[msg("that record belongs to a different organization")]
    WrongOrg,
    #[msg("that is not this organization's treasury")]
    WrongTreasury,
    #[msg("that is not this escrow's vault")]
    WrongVault,
    #[msg("token account is for the wrong mint")]
    WrongMint,
    #[msg("token account belongs to the wrong party")]
    WrongRecipient,
    #[msg("a disbursement needs the recipient's token account")]
    RecipientAccountMissing,
    #[msg("that payment account does not belong to you")]
    PaymentNotYours,
    #[msg("not enough tokens")]
    InsufficientFunds,
    #[msg("amount must be greater than zero")]
    ZeroAmount,
    #[msg("only the escrow's maker may do that")]
    NotTheMaker,
    #[msg("only the organization's authority may do that")]
    Unauthorized,
    #[msg("proposal nonce overflowed")]
    NonceOverflow,
    #[msg("vote tally overflowed")]
    TallyOverflow,
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

    /// Pull the custom error number out of an anchor `Error`, so a test can say
    /// *which* rejection it got rather than merely that something failed.
    fn code(e: &Error) -> u32 {
        match e {
            Error::AnchorError(a) => a.error_code_number,
            other => panic!("expected an anchor error, got {other:?}"),
        }
    }

    /// Anchor numbers user errors from 6,000, in declaration order.
    fn expected(want: OrgErr) -> u32 {
        want as u32 + 6_000
    }

    fn expect_err(result: Result<u64>, want: OrgErr) {
        match result {
            Ok(v) => panic!("expected {want:?}, got Ok({v})"),
            Err(e) => assert_eq!(code(&e), expected(want), "wrong error: {e:?}"),
        }
    }

    fn proposal(kind_byte: u8, weight_for: u64, weight_against: u64, executed: bool) -> Proposal {
        Proposal {
            org: Pubkey::new_unique(),
            proposer: Pubkey::new_unique(),
            kind: kind_byte,
            recipient: Pubkey::new_unique(),
            amount: 1_000,
            opens_at: 100,
            closes_at: 200,
            weight_for,
            weight_against,
            threshold_bps: 5_000,
            mechanism: mechanism::TOKEN_WEIGHTED,
            executed,
        }
    }

    // -------------------------------------------------------- the treasury claim

    /// The security claim the treasury exists to make. Every way of arriving at
    /// `disburse` without a passed, closed, unexecuted disbursement is a rejection.
    #[test]
    fn disburse_without_a_passing_proposal_is_rejected() {
        let now = 500;

        // Nobody voted at all: the default state of a fresh proposal.
        let untouched = proposal(kind::DISBURSE, 0, 0, false);
        assert!(check_disbursable(&untouched, now).is_err(), "no votes must not pay out");

        // Voted down.
        let rejected = proposal(kind::DISBURSE, 10, 90, false);
        assert!(check_disbursable(&rejected, now).is_err(), "a defeat must not pay out");

        // Passed, but voting is still open: the tally is not final yet.
        let open = proposal(kind::DISBURSE, 100, 0, false);
        assert!(check_disbursable(&open, 150).is_err(), "an open vote must not pay out");

        // Passed and already paid. Replay must not pay twice.
        let spent = proposal(kind::DISBURSE, 100, 0, true);
        assert!(check_disbursable(&spent, now).is_err(), "a paid proposal must not pay again");

        // A signal carries no money, whatever its tally.
        let signal = proposal(kind::SIGNAL, 100, 0, false);
        assert!(check_disbursable(&signal, now).is_err(), "a signal must not pay out");

        // And the one case that should work.
        let good = proposal(kind::DISBURSE, 100, 0, false);
        assert!(check_disbursable(&good, now).is_ok(), "a passed, closed disbursement pays");
    }

    #[test]
    fn disburse_rejections_name_their_reason() {
        let now = 500;
        let cases: [(Proposal, u64, OrgErr); 4] = [
            (proposal(kind::DISBURSE, 0, 0, false), now, OrgErr::ProposalDidNotPass),
            (proposal(kind::DISBURSE, 100, 0, false), 150, OrgErr::VotingStillOpen),
            (proposal(kind::DISBURSE, 100, 0, true), now, OrgErr::AlreadyExecuted),
            (proposal(kind::SIGNAL, 100, 0, false), now, OrgErr::NotADisbursement),
        ];
        for (p, at, want) in cases {
            let err = check_disbursable(&p, at).expect_err("should have been rejected");
            assert_eq!(code(&err), expected(want), "wrong reason for kind {}", p.kind);
        }
    }

    // -------------------------------------------------------- threshold arithmetic

    /// The boundary, from both worlds' configurations. A threshold is reached, not
    /// exceeded, and the denominator is the weight that turned out.
    #[test]
    fn threshold_arithmetic_at_the_boundary() {
        let tw = mechanism::TOKEN_WEIGHTED;

        // Economic Sandbox: threshold 0.5.
        assert!(proposal_passed(50, 50, 5_000, tw), "exactly half must pass at 0.5");
        assert!(!proposal_passed(49, 51, 5_000, tw), "just under half must fail at 0.5");
        assert!(proposal_passed(51, 49, 5_000, tw));

        // The second fixture: threshold 0.6, mechanism council. Same arithmetic.
        let c = mechanism::COUNCIL;
        assert!(proposal_passed(60, 40, 6_000, c), "exactly 60% must pass at 0.6");
        assert!(!proposal_passed(59, 41, 6_000, c), "59% must fail at 0.6");
        assert!(proposal_passed(6, 4, 6_000, c), "the ratio is what counts, not the size");
        assert!(!proposal_passed(599, 401, 6_000, c));
        assert!(proposal_passed(600, 400, 6_000, c));

        // Silence decides nothing, at any threshold.
        assert!(!proposal_passed(0, 0, 0, tw));
        assert!(!proposal_passed(0, 1, 0, tw));

        // A unanimous tally passes any reachable threshold.
        assert!(proposal_passed(1, 0, 10_000, tw));
        assert!(!proposal_passed(9_999, 1, 10_000, tw));
    }

    /// Big weights must not wrap. Token balances are u64 and stake supplies can be
    /// enormous; the tally is computed in u128 for exactly this reason.
    #[test]
    fn threshold_arithmetic_does_not_overflow() {
        let tw = mechanism::TOKEN_WEIGHTED;
        assert!(proposal_passed(u64::MAX, u64::MAX - 1, 5_000, tw));
        assert!(!proposal_passed(u64::MAX / 3, u64::MAX / 3 * 2, 5_000, tw));
    }

    /// `consensus` is not a threshold at all: a single vote against ends it.
    #[test]
    fn consensus_needs_nobody_against() {
        let c = mechanism::CONSENSUS;
        assert!(proposal_passed(9, 0, 5_000, c));
        assert!(!proposal_passed(9, 1, 5_000, c), "one objection sinks a consensus");
        assert!(!proposal_passed(0, 0, 5_000, c));
    }

    /// `leader` ignores the threshold: whoever holds the role decides.
    #[test]
    fn leader_decides_alone() {
        let l = mechanism::LEADER;
        assert!(proposal_passed(1, 0, 10_000, l));
        assert!(!proposal_passed(0, 1, 0, l));
    }

    // -------------------------------------------------------- vote weight

    /// The attack: a client naming its own weight. There is no argument to name it
    /// with, and every mechanism's weight is a function of an account the program
    /// read. This test pins each of the six to its source.
    #[test]
    fn client_asserted_vote_weight_is_impossible() {
        // token_weighted reads the balance, whole and unmodified.
        assert_eq!(
            resolve_weight(mechanism::TOKEN_WEIGHTED, WeightSource::TokenBalance(413)).unwrap(),
            413
        );
        // ...and refuses to fall back to a member record the voter might control.
        expect_err(
            resolve_weight(
                mechanism::TOKEN_WEIGHTED,
                WeightSource::Member { weight: 1_000_000, roles: 0xff },
            ),
            OrgErr::WeightAccountMissing,
        );
        expect_err(
            resolve_weight(mechanism::TOKEN_WEIGHTED, WeightSource::Missing),
            OrgErr::WeightAccountMissing,
        );

        // Head-count mechanisms ignore the weight field entirely, so writing a large
        // number into a member record buys nothing.
        let fat = WeightSource::Member { weight: u64::MAX, roles: roles::MEMBER };
        assert_eq!(resolve_weight(mechanism::MAJORITY_VOTE, fat).unwrap(), 1);
        assert_eq!(resolve_weight(mechanism::CONSENSUS, fat).unwrap(), 1);

        // Weighted mechanisms read the record, which only the org authority writes.
        let seats = WeightSource::Member { weight: 7, roles: roles::MEMBER | roles::COUNCIL };
        assert_eq!(resolve_weight(mechanism::COUNCIL, seats).unwrap(), 7);
        assert_eq!(resolve_weight(mechanism::REPUTATION_WEIGHTED, seats).unwrap(), 7);

        // And no mechanism accepts a source it was not built for.
        expect_err(
            resolve_weight(mechanism::COUNCIL, WeightSource::TokenBalance(10_000)),
            OrgErr::WeightAccountMissing,
        );
        expect_err(
            resolve_weight(mechanism::REPUTATION_WEIGHTED, WeightSource::Missing),
            OrgErr::WeightAccountMissing,
        );
        expect_err(
            resolve_weight(mechanism::COUNT, WeightSource::TokenBalance(1)),
            OrgErr::UnknownMechanism,
        );
    }

    /// Pointing `token_weighted` at somebody else's balance — the treasury's, or the
    /// biggest holder's — is the other half of the same attack.
    #[test]
    fn a_voter_cannot_borrow_another_accounts_balance() {
        let voter = Pubkey::new_unique();
        let whale = Pubkey::new_unique();
        let stake = Pubkey::new_unique();
        let other_mint = Pubkey::new_unique();

        assert!(check_weight_account(&voter, &stake, &voter, &stake).is_ok());

        let err = check_weight_account(&whale, &stake, &voter, &stake)
            .expect_err("somebody else's account must be refused");
        assert_eq!(code(&err), OrgErr::WeightAccountNotYours as u32 + 6_000);

        let err = check_weight_account(&voter, &other_mint, &voter, &stake)
            .expect_err("a different mint must be refused");
        assert_eq!(code(&err), OrgErr::WrongMint as u32 + 6_000);
    }

    /// Roles are checked, not assumed. A member with no seat cannot vote in a
    /// council, and a zero-weight record is not a vote.
    #[test]
    fn roles_and_zero_weights_are_enforced() {
        let plain = WeightSource::Member { weight: 3, roles: roles::MEMBER };
        expect_err(resolve_weight(mechanism::COUNCIL, plain), OrgErr::NotOnCouncil);
        expect_err(resolve_weight(mechanism::LEADER, plain), OrgErr::NotTheLeader);

        let unlisted = WeightSource::Member { weight: 5, roles: 0 };
        expect_err(resolve_weight(mechanism::MAJORITY_VOTE, unlisted), OrgErr::NotAMember);
        expect_err(resolve_weight(mechanism::REPUTATION_WEIGHTED, unlisted), OrgErr::NotAMember);

        let broke = WeightSource::Member { weight: 0, roles: roles::MEMBER };
        expect_err(resolve_weight(mechanism::REPUTATION_WEIGHTED, broke), OrgErr::NoVotingWeight);
        expect_err(
            resolve_weight(mechanism::TOKEN_WEIGHTED, WeightSource::TokenBalance(0)),
            OrgErr::NoVotingWeight,
        );

        // A leader with no weight set still gets one vote; the role is the weight.
        let leader = WeightSource::Member { weight: 0, roles: roles::LEADER };
        assert_eq!(resolve_weight(mechanism::LEADER, leader).unwrap(), 1);
    }

    /// Both world fixtures, run through the same function. This is brief §18 as a
    /// test: nothing changes but the configuration.
    #[test]
    fn both_worlds_are_the_same_machinery() {
        // The first fixture: token_weighted, threshold 0.5, weight from a stake mint.
        let first_weight =
            resolve_weight(mechanism::TOKEN_WEIGHTED, WeightSource::TokenBalance(300)).unwrap();
        let first_other =
            resolve_weight(mechanism::TOKEN_WEIGHTED, WeightSource::TokenBalance(200)).unwrap();
        assert!(proposal_passed(first_weight, first_other, 5_000, mechanism::TOKEN_WEIGHTED));

        // The second fixture: council, threshold 0.6, weight from a member record.
        let senior = WeightSource::Member { weight: 6, roles: roles::MEMBER | roles::COUNCIL };
        let junior = WeightSource::Member { weight: 4, roles: roles::MEMBER | roles::COUNCIL };
        let for_ = resolve_weight(mechanism::COUNCIL, senior).unwrap();
        let against = resolve_weight(mechanism::COUNCIL, junior).unwrap();
        assert!(proposal_passed(for_, against, 6_000, mechanism::COUNCIL));
        // One seat fewer and the same motion fails, at the same threshold.
        assert!(!proposal_passed(for_ - 1, against + 1, 6_000, mechanism::COUNCIL));
    }

    // -------------------------------------------------------- voting window

    #[test]
    fn votes_land_only_inside_the_window() {
        let p = proposal(kind::DISBURSE, 0, 0, false);
        assert!(check_voting_window(&p, 99).is_err(), "before opening");
        assert!(check_voting_window(&p, 100).is_ok(), "the opening tick counts");
        assert!(check_voting_window(&p, 199).is_ok());
        assert!(check_voting_window(&p, 200).is_err(), "closing is exclusive");
        assert!(check_voting_window(&p, 10_000).is_err());

        // The window and the payout do not overlap: at no instant is a proposal both
        // votable and payable.
        for t in [99u64, 100, 150, 199, 200, 500] {
            let votable = check_voting_window(&p, t).is_ok();
            let payable = check_disbursable(&proposal(kind::DISBURSE, 100, 0, false), t).is_ok();
            assert!(!(votable && payable), "both open and payable at {t}");
        }
    }

    // -------------------------------------------------------- escrow

    #[test]
    fn only_the_maker_may_cancel() {
        let maker = Pubkey::new_unique();
        let stranger = Pubkey::new_unique();
        assert!(check_cancel(&maker, &maker).is_ok());
        let err = check_cancel(&maker, &stranger).expect_err("a stranger must not cancel");
        assert_eq!(code(&err), OrgErr::NotTheMaker as u32 + 6_000);
    }

    struct Swap {
        taker: Pubkey,
        maker: Pubkey,
        give_mint: Pubkey,
        want_mint: Pubkey,
    }

    impl Swap {
        fn new() -> Self {
            Self {
                taker: Pubkey::new_unique(),
                maker: Pubkey::new_unique(),
                give_mint: Pubkey::new_unique(),
                want_mint: Pubkey::new_unique(),
            }
        }

        /// A well-formed swap, with one field overridable per test.
        #[allow(clippy::too_many_arguments)]
        fn check(
            &self,
            payment_owner: Pubkey,
            payment_mint: Pubkey,
            payment_balance: u64,
            maker_recv_owner: Pubkey,
            maker_recv_mint: Pubkey,
            taker_recv_owner: Pubkey,
            taker_recv_mint: Pubkey,
        ) -> Result<()> {
            check_swap(
                &self.taker,
                &self.maker,
                &payment_owner,
                &payment_mint,
                payment_balance,
                &maker_recv_owner,
                &maker_recv_mint,
                &taker_recv_owner,
                &taker_recv_mint,
                &self.want_mint,
                100,
                &self.give_mint,
            )
        }

        fn good(&self) -> Result<()> {
            self.check(
                self.taker,
                self.want_mint,
                100,
                self.maker,
                self.want_mint,
                self.taker,
                self.give_mint,
            )
        }
    }

    /// A taker cannot receive without paying, and cannot redirect either leg.
    #[test]
    fn escrow_swap_is_all_or_nothing() {
        let s = Swap::new();
        assert!(s.good().is_ok(), "the honest swap must be accepted");

        // Cannot pay from an account they do not own.
        let thief = Pubkey::new_unique();
        let err = s
            .check(thief, s.want_mint, 100, s.maker, s.want_mint, s.taker, s.give_mint)
            .expect_err("paying from someone else's account must fail");
        assert_eq!(code(&err), OrgErr::PaymentNotYours as u32 + 6_000);

        // Cannot pay in the wrong currency.
        let err = s
            .check(s.taker, s.give_mint, 100, s.maker, s.want_mint, s.taker, s.give_mint)
            .expect_err("paying in the wrong mint must fail");
        assert_eq!(code(&err), OrgErr::WrongMint as u32 + 6_000);

        // Cannot take the goods while short of the price. This is the one that makes
        // the swap a swap: the release leg never runs.
        let err = s
            .check(s.taker, s.want_mint, 99, s.maker, s.want_mint, s.taker, s.give_mint)
            .expect_err("an underfunded taker must fail");
        assert_eq!(code(&err), OrgErr::InsufficientFunds as u32 + 6_000);
        assert!(
            s.check(s.taker, s.want_mint, 100, s.maker, s.want_mint, s.taker, s.give_mint).is_ok(),
            "exactly the asking price is enough"
        );

        // Cannot pay somebody other than the maker.
        let err = s
            .check(s.taker, s.want_mint, 100, thief, s.want_mint, s.taker, s.give_mint)
            .expect_err("paying the wrong party must fail");
        assert_eq!(code(&err), OrgErr::WrongRecipient as u32 + 6_000);

        // Cannot have the goods delivered to a third party.
        let err = s
            .check(s.taker, s.want_mint, 100, s.maker, s.want_mint, thief, s.give_mint)
            .expect_err("delivering elsewhere must fail");
        assert_eq!(code(&err), OrgErr::WrongRecipient as u32 + 6_000);

        // Cannot be delivered something other than what was escrowed.
        let err = s
            .check(s.taker, s.want_mint, 100, s.maker, s.want_mint, s.taker, s.want_mint)
            .expect_err("receiving the wrong mint must fail");
        assert_eq!(code(&err), OrgErr::WrongMint as u32 + 6_000);
    }

    // -------------------------------------------------------- layout

    /// The client decodes these accounts by hand (Anchor's JS coder is not in the
    /// loop), so the sizes it assumes have to be the sizes the program writes.
    /// `org-program.ts` carries the same numbers.
    #[test]
    fn account_sizes_match_what_the_client_decodes() {
        assert_eq!(8 + Org::INIT_SPACE, 8 + 32 + 32 + 2 + 32 + 32 + 32 + 1 + 2 + 8 + 4 + 8 + 1 + 1);
        assert_eq!(8 + Proposal::INIT_SPACE, 8 + 32 + 32 + 1 + 32 + 8 + 8 + 8 + 8 + 8 + 2 + 1 + 1);
        assert_eq!(8 + Member::INIT_SPACE, 8 + 32 + 32 + 8 + 1 + 1);
        assert_eq!(8 + VoteReceipt::INIT_SPACE, 8 + 32 + 32 + 8 + 1 + 1);
        assert_eq!(8 + Escrow::INIT_SPACE, 8 + 32 + 8 + 32 + 32 + 8 + 8 + 32 + 1);
    }

    /// The six mechanism bytes are the six `GovernanceMechanism` strings, in order.
    /// If `chain.ts` ever grows a seventh, this is where it bites.
    #[test]
    fn mechanism_bytes_are_dense_and_ordered() {
        assert_eq!(mechanism::LEADER, 0);
        assert_eq!(mechanism::MAJORITY_VOTE, 1);
        assert_eq!(mechanism::TOKEN_WEIGHTED, 2);
        assert_eq!(mechanism::REPUTATION_WEIGHTED, 3);
        assert_eq!(mechanism::COUNCIL, 4);
        assert_eq!(mechanism::CONSENSUS, 5);
        assert_eq!(mechanism::COUNT, 6);
        // Every byte below COUNT resolves a weight rather than falling through.
        for m in 0..mechanism::COUNT {
            let src = WeightSource::Member { weight: 3, roles: 0xff };
            let result = if m == mechanism::TOKEN_WEIGHTED {
                resolve_weight(m, WeightSource::TokenBalance(3))
            } else {
                resolve_weight(m, src)
            };
            assert!(result.is_ok(), "mechanism {m} has no weight rule");
        }
    }
}
