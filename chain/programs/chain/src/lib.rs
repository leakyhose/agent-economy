//! agent-economy — the village ledger and its market, on Solana.
//!
//! The simulation (agent minds, time, movement) runs off-chain. What lives here is
//! the economy itself: who owns what, and the market that turns orders into a price.
//!
//! Five goods, in this order: food, wood, nets, boats, houses. Everything but food can
//! be pledged to the bank.
//!
//! Only the ledger's authority (the village server) may write to it — with one
//! exception: `pay_dividend` is permissionless, so anyone can pay out the bank's
//! surplus. Everything written is checked:
//! no balance can go negative, no good can be conjured by a trade, and the market
//! clears at one uniform price for everyone.
//!
//! Money: agents start with a fixed purse, and the only way new coins come into being
//! is the village bank lending them against collateral. Repaying the principal burns
//! it again; the interest goes to the bank. Every coin agents hold is counted in `supply`.
//!
//! Those coins are a real SPL token, SETTLERS, minted by this program and nobody else:
//! the mint is a PDA of the ledger and is its own mint authority, so no key that could
//! sign for it exists. Every coin ever created sits in one vault, also a PDA, and the
//! mint's supply is checked against the books after every instruction that can move it.
//! What the bank's rules allow is exactly what the token's supply can do.
//!
//! The bank is a public bank: its terms are fixed at `initialize`, it charges interest
//! for the time a loan is held, and it pays its surplus back to the villagers. It has a
//! balance sheet. Its equity is its cash (`bank.cash`) plus the seized goods it holds
//! (`bank_book`, carried at fire-sale value) minus `bad_debt`. Cash is seeded at
//! `initialize`, fed by interest, penalties and sales of seized goods, and drained by
//! write-offs, refunds and dividends. It may lend at most `equity / kappa`, so defaults
//! that eat its equity tighten credit for everyone. A write-off bigger than the bank's
//! cash leaves the rest as `bad_debt`, which its next income pays down before anything
//! else. The books close exactly, after every instruction:
//!
//!   supply     = Σ agent cash
//!   Σ agent cash + bank cash = start_money + bank_seed + minted − principal_repaid − written_off
//!   bank cash  = bank_seed + interest_income + penalties + recovered − refunds − written_off − dividends_paid
//!   minted     = Σ open principal + principal_repaid + written_off + bad_debt
//!   Σ bank_book = seized_value − sold_book      (and bank_book[g] = 0 exactly when bank.goods[g] = 0)
//!   debt_total = Σ debt                         (debts as last accrued; see `accrue`)
//!   SETTLERS supply = Σ agent cash + bank cash   (the SPL mint; see `settle_money`)
//!   equity     = bank cash + Σ bank_book − bad_debt
//!   bad_debt > 0  ⇒  bank cash = 0
//!   per agent: principal ≤ debt, and debt = 0 ⇒ principal = 0 and nothing locked
//!
//! and no good is created or destroyed except by `settle`: Σ (goods + locked) + bank goods
//! moves only by the deltas settled.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    system_instruction,
};

declare_id!("4ruVnoc2xFy5YJ8MAUA85mLn6ALCD4CeWsssr4JmCCWY");

/// The SPL Token program. Checked by address before every call into it.
/// TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
pub const TOKEN_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
]);
/// SETTLERS has 2 decimals, so one base unit is one cent — the unit `cash` is already in.
/// No conversion anywhere: `mint.supply` compares directly against `supply + bank.cash`.
pub const SETTLERS_DECIMALS: u8 = 2;
const MINT_LEN: usize = 82;                  // an SPL mint account
const TOKEN_ACCOUNT_LEN: usize = 165;        // an SPL token account
const MINT_SUPPLY_OFFSET: usize = 36;        // mint_authority COption<Pubkey> is 4 + 32 bytes
const TOKEN_AMOUNT_OFFSET: usize = 64;       // an SPL token account is mint 0..32, owner 32..64, amount 64..72
/// PDA seeds. The mint is its own authority and the vault's owner.
pub const MINT_SEED: &[u8] = b"settlers";
pub const VAULT_SEED: &[u8] = b"vault";
/// One purse per agent: an SPL token account at `["purse", ledger, agent]` that, like the
/// mint, is its own owner — so no key that could spend an agent's coins exists anywhere.
pub const PURSE_SEED: &[u8] = b"purse";

pub const MAX_AGENTS: usize = 137;        // 8 + 360 + 137×72 = 10,232 bytes: under the 10 KiB CPI-create limit
pub const N_GOODS: usize = 5;
pub const FOOD: usize = 0;
pub const WOOD: usize = 1;
pub const NETS: usize = 2;
pub const BOATS: usize = 3;
pub const HOUSES: usize = 4;
/// Order `agent` id that means "the bank" — used to sell seized collateral.
pub const BANK: u16 = u16::MAX;
/// A foreclosure values seized goods at 80% of the last price: what a fire sale fetches.
pub const FIRE_SALE_BPS: u64 = 8_000;
/// A repayment that leaves less than one coin owing closes the loan; the rest is forgiven.
pub const FORGIVE_BELOW: u64 = 100;
/// `pay_dividend` pays out this share of the surplus, keeping the rest as a buffer.
pub const DIVIDEND_SHARE_BPS: u64 = 5_000;

#[program]
pub mod chain {
    use super::*;

    /// Create the village ledger and give every agent a starting purse and pantry.
    /// Also sets the opening price of each good, seeds the bank's equity, and fixes
    /// the bank's rules for the life of the ledger. `ltv_bps = 0` is a village with
    /// no credit: every `borrow` fails.
    pub fn initialize(
        ctx: Context<Initialize>,
        num_agents: u32,
        start_cash: u64,
        start_food: u32,
        start_wood: u32,
        start_prices: [u64; N_GOODS],
        bank_seed: u64,
        terms: BankTerms,
    ) -> Result<()> {
        require!(num_agents as usize <= MAX_AGENTS, EconErr::TooManyAgents);
        require!(terms.ltv_bps <= terms.margin_bps && terms.margin_bps <= 10_000, EconErr::BadTerms);
        require!(terms.kappa_bps > 0 && terms.penalty_bps <= 10_000, EconErr::BadTerms);
        require!(terms.rate_period_slots > 0 && terms.term_unit_slots > 0 && terms.max_term_units > 0, EconErr::BadTerms);
        require!(start_prices.iter().all(|&p| p > 0), EconErr::BadTerms);
        let ledger_key = ctx.accounts.ledger.key();
        create_coin(
            &ctx.accounts.authority, &ctx.accounts.mint, &ctx.accounts.vault,
            &ctx.accounts.token_program, &ctx.accounts.system_program,
            &ledger_key, ctx.bumps.mint, ctx.bumps.vault,
        )?;
        let mut l = ctx.accounts.ledger.load_init()?;
        l.authority = ctx.accounts.authority.key();
        l.num_agents = num_agents;
        l.round = 0;
        l.last_price = start_prices;
        for i in 0..num_agents as usize {
            l.slots[i].cash = start_cash;
            l.slots[i].goods[FOOD] = start_food;
            l.slots[i].goods[WOOD] = start_wood;
        }
        l.start_money = start_cash.checked_mul(num_agents as u64).ok_or(EconErr::Overflow)?;
        l.supply = l.start_money;
        l.bank_seed = bank_seed;
        l.bank.cash = bank_seed;
        l.ltv_bps = terms.ltv_bps;
        l.rate_bps = terms.rate_bps;
        l.penalty_bps = terms.penalty_bps;
        l.kappa_bps = terms.kappa_bps;
        l.margin_bps = terms.margin_bps;
        l.max_term_units = terms.max_term_units;
        l.rate_period_slots = terms.rate_period_slots;
        l.term_unit_slots = terms.term_unit_slots;
        l.equity_floor = terms.equity_floor;
        // every coin the village starts with, minted into the vault. `minted` counts
        // only what the bank has lent, so the opening money is not part of it.
        let opening = l.start_money.checked_add(bank_seed).ok_or(EconErr::Overflow)?;
        require_keys_eq!(ctx.accounts.token_program.key(), TOKEN_PROGRAM_ID, EconErr::BadMint);
        if opening > 0 {
            mint_coins(
                &ctx.accounts.mint, &ctx.accounts.vault, &ctx.accounts.token_program,
                &ledger_key, ctx.bumps.mint, opening,
            )?;
        }
        check_supply(&l, &ctx.accounts.mint)
    }

    /// Borrow newly minted coins against wood, nets, boats and houses.
    ///
    /// The collateral is locked out of the agent's goods (locked goods don't rot). The
    /// debt may be at most `ltv_bps` of the locked goods' value at the last clearing
    /// prices. Food can't be pledged: it rots. With `ltv_bps = 0` the bank lends nothing.
    ///
    /// No interest is added up front: it accrues on the principal for as long as the
    /// loan is held, `rate_bps` per `rate_period_slots` (see `accrue`).
    ///
    /// A new loan is due `term_slots` from now, and the borrower picks the term: it
    /// must be 1 to `max_term_units` whole units of `term_unit_slots` (e.g. 1, 2 or 3
    /// minutes). Borrowing more on an open loan ignores `term_slots` and keeps its due slot;
    /// an overdue loan can't be topped up.
    ///
    /// The bank's lending is capped by its capital: all loans together, this one
    /// included, may not exceed `equity × 10_000 / kappa_bps`.
    pub fn borrow(
        ctx: Context<WriteMint>,
        agent: u16,
        amount: u64,
        term_slots: u64,
        collateral: [u32; N_GOODS],
    ) -> Result<()> {
        let now = Clock::get()?.slot;
        let ledger_key = ctx.accounts.ledger.key();
        let mut l = ctx.accounts.load_checked()?;
        let m0 = money(&l);
        require!((agent as u32) < l.num_agents, EconErr::BadAgent);
        require!(amount > 0, EconErr::BadAmount);
        require!(l.ltv_bps > 0, EconErr::CreditOff);
        require!(collateral[FOOD] == 0, EconErr::FoodNotCollateral);
        let accrued = accrue(&mut l, agent as usize, now)?;
        let new_loan = l.slots[agent as usize].debt == 0;
        require!(new_loan || now <= l.slots[agent as usize].due_slot as u64, EconErr::Overdue);
        if new_loan {
            let unit = l.term_unit_slots;
            require!(
                term_slots > 0 && term_slots % unit == 0 && term_slots / unit <= l.max_term_units as u64,
                EconErr::BadTerm
            );
        }
        let cap = equity(&l).max(0) as u128 * 10_000;
        require!((l.debt_total as u128 + amount as u128) * l.kappa_bps as u128 <= cap, EconErr::DebtCapReached);
        let (price, ltv) = (l.last_price, l.ltv_bps as u128);
        let s = &mut l.slots[agent as usize];
        for g in 0..N_GOODS {
            require!(s.goods[g] >= collateral[g], EconErr::InsufficientGoods);
            s.goods[g] -= collateral[g];
            s.locked[g] = s.locked[g].checked_add(collateral[g]).ok_or(EconErr::Overflow)?;
        }
        let debt = s.debt.checked_add(amount).ok_or(EconErr::Overflow)?;
        require!(debt as u128 * 10_000 <= locked_value(s, &price) * ltv, EconErr::NotEnoughCollateral);
        if new_loan {
            s.due_slot = slot32(now.checked_add(term_slots).ok_or(EconErr::Overflow)?)?;
            s.accrued_slot = slot32(now)?;
        }
        s.debt = debt;
        s.principal += amount;
        s.cash = s.cash.checked_add(amount).ok_or(EconErr::Overflow)?;
        let due_slot = s.due_slot as u64;
        l.debt_total += amount;
        l.supply += amount;
        l.minted += amount;
        emit!(Borrowed { agent, amount, debt, accrued, due_slot });
        settle_money(
            &l, &ctx.accounts.mint, &ctx.accounts.vault, &ctx.accounts.token_program,
            &ledger_key, ctx.bumps.mint, m0, None,
        )
    }

    /// Pay down a loan. Interest accrued to now is paid first and goes to the bank's
    /// equity; the rest pays off principal, and those coins are burned. If less than
    /// one coin (`FORGIVE_BELOW` cents) is left owing, the loan closes: the unpaid
    /// principal is written off against the bank's equity (the unpaid interest was
    /// never income), and the whole remainder is counted in `forgiven`. Paid off, the
    /// collateral unlocks. With less than a coin owing, a repay of 0 closes the loan too.
    pub fn repay<'i>(ctx: Context<'i, WriteMint<'i>>, agent: u16, amount: u64) -> Result<()> {
        let now = Clock::get()?.slot;
        let ledger_key = ctx.accounts.ledger.key();
        let mut l = ctx.accounts.load_checked()?;
        let m0 = money(&l);
        require!((agent as u32) < l.num_agents, EconErr::BadAgent);
        require!(l.slots[agent as usize].debt > 0, EconErr::NoLoan);
        accrue(&mut l, agent as usize, now)?;
        let s = &mut l.slots[agent as usize];
        let paid = amount.min(s.debt).min(s.cash);
        require!(paid > 0 || s.debt < FORGIVE_BELOW, EconErr::BadAmount);
        let interest = paid.min(s.debt - s.principal);
        let principal = paid - interest;
        s.cash -= paid;
        s.debt -= paid;
        s.principal -= principal;
        let (forgiven, forgiven_principal) = if s.debt < FORGIVE_BELOW { (s.debt, s.principal) } else { (0, 0) };
        if s.debt < FORGIVE_BELOW {
            s.debt = 0;
            release(s);
        }
        l.interest_income += interest;
        credit_equity(&mut l, interest);
        l.principal_repaid += principal;
        l.debt_total -= paid + forgiven;
        l.supply -= paid;
        l.forgiven += forgiven;
        write_off(&mut l, forgiven_principal);
        emit!(Repaid { agent, paid, interest, principal, forgiven });
        settle_money(
            &l, &ctx.accounts.mint, &ctx.accounts.vault, &ctx.accounts.token_program,
            &ledger_key, ctx.bumps.mint, m0, debtor_purse(&ctx.remaining_accounts, agent),
        )
    }

    /// Collect a loan that has come due, or foreclose it. The bank does this: it is the
    /// lender, and the only party with a claim on the debtor. Like every other write, it
    /// is signed by the ledger's authority.
    ///
    /// Interest is accrued to now first. Then it is allowed when the loan is overdue
    /// (the chain's clock is past the due slot), or on a margin call: when the debt is
    /// more than `margin_bps` of the collateral's value at the last clearing prices,
    /// i.e. `debt × 10_000 > locked value × margin_bps`. A fire sale that drops a price
    /// can push other loans under that line.
    ///
    /// Overdue, with the cash to cover it, the loan is simply repaid — a direct debit at
    /// the loan's own terms: the whole debt (principal plus interest to now) comes out of
    /// the debtor's cash, interest to the bank's equity, principal burned, no penalty,
    /// and every pledged good is released. That rule holds whenever `now > due_slot` and
    /// `cash ≥ debt`, even if the loan is also under its margin.
    ///
    /// Otherwise — overdue and short of cash, or a margin call before the due slot — it
    /// is a foreclosure. A penalty of `penalty_bps` of the debt is added, and the bank
    /// takes the debt plus penalty — never more:
    ///  1. The debtor's cash is collected first: interest and penalty to the bank's
    ///     equity, the rest burned as principal.
    ///  2. If that falls short, the bank seizes collateral valued at fire-sale price
    ///     (`FIRE_SALE_BPS` of the last price): whole units of the priciest goods that
    ///     fit under the shortfall, then one unit of the cheapest good left to cover the
    ///     rest. That last unit overshoots by less than its own value; the bank refunds
    ///     the excess to the debtor in cash. If the bank's cash can't pay that refund, it
    ///     leaves that unit with the debtor instead and takes the shortfall as a loss.
    ///     Everything not seized is given back.
    ///  3. The principal the debtor's cash didn't cover is written off against the
    ///     bank's cash at once (a loss bigger than its cash is `bad_debt`), and the
    ///     seized goods go on the bank's books at their fire-sale value (`bank_book`,
    ///     `seized_value`). Selling them at that value later is neither profit nor loss.
    pub fn collect<'i>(ctx: Context<'i, WriteMint<'i>>, agent: u16) -> Result<()> {
        let now = Clock::get()?.slot;
        let ledger_key = ctx.accounts.ledger.key();
        let mut l = ctx.accounts.load_checked()?;
        let m0 = money(&l);
        require!((agent as u32) < l.num_agents, EconErr::BadAgent);
        require!(l.slots[agent as usize].debt > 0, EconErr::NoLoan);
        accrue(&mut l, agent as usize, now)?;
        let (price, penalty_bps, margin_bps) = (l.last_price, l.penalty_bps as u64, l.margin_bps as u128);
        let s = &mut l.slots[agent as usize];
        let overdue = now > s.due_slot as u64;
        let margin_call = s.debt as u128 * 10_000 > locked_value(s, &price) * margin_bps;
        require!(overdue || margin_call, EconErr::NotCollectable);

        if overdue && s.cash >= s.debt {
            // the direct debit: repaid at the loan's terms, no penalty, collateral released
            let (paid, principal) = (s.debt, s.principal);
            let interest = paid - principal;
            s.cash -= paid;
            s.debt = 0;
            release(s);
            l.interest_income += interest;
            credit_equity(&mut l, interest);
            l.principal_repaid += principal;
            l.debt_total -= paid;
            l.supply -= paid;
            emit!(Collected { agent, paid, interest, principal });
            return settle_money(
                &l, &ctx.accounts.mint, &ctx.accounts.vault, &ctx.accounts.token_program,
                &ledger_key, ctx.bumps.mint, m0, debtor_purse(&ctx.remaining_accounts, agent),
            );
        }

        let debt = s.debt;
        let interest = s.debt - s.principal;
        let penalty = debt * penalty_bps / 10_000;
        let owed = debt + penalty;
        let collected = owed.min(s.cash);
        s.cash -= collected;
        let to_equity = collected.min(interest + penalty);
        let burned = collected - to_equity;
        let principal_short = s.principal - burned;

        // seize just enough to cover what's still owed, at fire-sale value
        let short = owed - collected;
        let unit: [u64; N_GOODS] = core::array::from_fn(|g| (price[g] * FIRE_SALE_BPS / 10_000).max(1));
        let mut order: [usize; N_GOODS] = core::array::from_fn(|g| g);
        order.sort_by(|&a, &b| unit[b].cmp(&unit[a]));
        let mut seized = [0u32; N_GOODS];
        let mut rem = short;
        for &g in order.iter() {             // whole units that fit under the shortfall, priciest first
            let take = (rem / unit[g]).min(s.locked[g] as u64);
            seized[g] = take as u32;
            rem -= take * unit[g];
        }
        let mut last = None;
        for &g in order.iter().rev() {       // then the cheapest good left: one unit covers the rest
            if rem == 0 { break; }
            let take = rem.div_ceil(unit[g]).min((s.locked[g] - seized[g]) as u64);
            if take == 0 { continue; }
            seized[g] += take as u32;
            rem = rem.saturating_sub(take * unit[g]);
            last = Some(g);
        }
        let mut value: u64 = (0..N_GOODS).map(|g| seized[g] as u64 * unit[g]).sum();
        let mut refund = value.saturating_sub(short);

        // interest and penalty collected in cash go to equity first, so a refund can use them
        let interest_paid = to_equity.min(interest);
        l.interest_income += interest_paid;
        l.penalties += to_equity - interest_paid;
        credit_equity(&mut l, to_equity);
        if refund > l.bank.cash {
            if let Some(g) = last {
                seized[g] -= 1;
                value -= unit[g];
            }
            refund = 0;
        }
        let s = &mut l.slots[agent as usize];
        let mut returned = [0u32; N_GOODS];
        for g in 0..N_GOODS {
            returned[g] = s.locked[g] - seized[g];
            s.goods[g] += returned[g];
        }
        s.locked = [0; N_GOODS];
        s.debt = 0;
        s.principal = 0;
        s.due_slot = 0;
        s.accrued_slot = 0;
        s.cash += refund;

        l.bank.cash -= refund;
        l.refunds += refund;
        for g in 0..N_GOODS {
            l.bank.goods[g] += seized[g];
            l.bank_book[g] += seized[g] as u64 * unit[g];
        }
        l.seized_value += value;
        l.principal_repaid += burned;
        let (written_off, bad_debt) = write_off(&mut l, principal_short);
        l.debt_total -= debt;
        l.supply = l.supply - collected + refund;
        emit!(Foreclosed {
            agent, margin_call, debt, penalty, collected, burned, seized, seized_value: value, refund,
            returned, written_off, bad_debt,
        });
        settle_money(
            &l, &ctx.accounts.mint, &ctx.accounts.vault, &ctx.accounts.token_program,
            &ledger_key, ctx.bumps.mint, m0, debtor_purse(&ctx.remaining_accounts, agent),
        )
    }

    /// Pay part of the bank's surplus out to every agent equally. PERMISSIONLESS.
    ///
    /// The bank must keep `kappa × debt_total` plus `equity_floor` as capital (the
    /// floor is the seed plus a buffer). Half the equity above that
    /// (`DIVIDEND_SHARE_BPS`) is paid out, never more than the bank's cash, rounded
    /// down to an equal share each. With no surplus this does nothing.
    pub fn pay_dividend(ctx: Context<Anyone>) -> Result<()> {
        let mut l = ctx.accounts.ledger.load_mut()?;
        let n = l.num_agents as u64;
        let required = (l.debt_total as u128 * l.kappa_bps as u128 / 10_000) as i128 + l.equity_floor as i128;
        let surplus = equity(&l) - required;
        if n == 0 || surplus <= 0 { return Ok(()); }
        let payout = ((surplus as u128 * DIVIDEND_SHARE_BPS as u128 / 10_000) as u64).min(l.bank.cash);
        let per_agent = payout / n;
        if per_agent == 0 { return Ok(()); }
        let total = per_agent * n;
        for i in 0..n as usize { l.slots[i].cash += per_agent; }
        l.bank.cash -= total;
        l.supply += total;
        l.dividends_paid += total;
        emit!(DividendPaid { per_agent, total, equity_left: equity(&l) as i64, by: ctx.accounts.caller.key() });
        Ok(())
    }

    /// Apply what happened in the world since the last round: catches, wood cut,
    /// meals eaten, nets, boats and houses built, things worn out. Signed deltas;
    /// nothing may go negative.
    /// Give a batch of agents a purse: an SPL token account of their own, at
    /// `["purse", ledger, agent]`, owning itself. Call it once per ledger, in chunks,
    /// after `initialize`. Re-running it over a purse that already exists is a no-op,
    /// so a partly-finished pass can simply be run again.
    ///
    /// The purses come in as remaining accounts, one per entry in `agents`, in order.
    /// `bumps` are checked, not trusted: a wrong bump derives a different address and
    /// fails against the account that was actually passed.
    pub fn init_purses<'i>(ctx: Context<'i, InitPurses<'i>>, agents: Vec<u16>, bumps: Vec<u8>) -> Result<()> {
        require!(agents.len() == bumps.len(), EconErr::BadAmount);
        require!(agents.len() == ctx.remaining_accounts.len(), EconErr::BadAmount);
        require_keys_eq!(*ctx.accounts.token_program.key, TOKEN_PROGRAM_ID, EconErr::BadMint);
        let ledger_key = ctx.accounts.ledger.key();
        let num_agents = ctx.accounts.load_checked()?.num_agents;
        let rent = Rent::get()?;
        for (i, (&agent, &bump)) in agents.iter().zip(bumps.iter()).enumerate() {
            require!((agent as u32) < num_agents, EconErr::BadAgent);
            let purse = &ctx.remaining_accounts[i];
            check_purse(purse.key, &ledger_key, agent, bump)?;
            if !purse.data_is_empty() {
                continue;                       // already has a purse
            }
            let index = agent.to_le_bytes();
            let seeds: &[&[u8]] = &[PURSE_SEED, ledger_key.as_ref(), &index, &[bump]];
            invoke_signed(
                &system_instruction::create_account(
                    ctx.accounts.authority.key, purse.key,
                    rent.minimum_balance(TOKEN_ACCOUNT_LEN), TOKEN_ACCOUNT_LEN as u64,
                    &TOKEN_PROGRAM_ID),
                &[ctx.accounts.authority.to_account_info(), purse.clone(),
                  ctx.accounts.system_program.to_account_info()],
                &[seeds],
            )?;
            // InitializeAccount3: the purse owns itself, so only the program can spend it
            invoke_signed(
                &token_ix(18, purse.key.as_ref(), vec![
                    AccountMeta::new(*purse.key, false),
                    AccountMeta::new_readonly(*ctx.accounts.mint.key, false),
                ]),
                &[purse.clone(), ctx.accounts.mint.to_account_info(),
                  ctx.accounts.token_program.to_account_info()],
                &[seeds],
            )?;
        }
        Ok(())
    }

    /// Move real SETTLERS between agents until every purse holds what the ledger says
    /// that agent has.
    ///
    /// `settle_money` reconciles the *total* — how many coins exist. This reconciles the
    /// *distribution* — who holds them — and in the same spirit: the client says only
    /// which agents to look at, and the program derives every transfer from the gap
    /// between a purse's balance and its slot's `cash`. Nothing about a transfer is
    /// taken on the caller's word.
    ///
    /// Agents who owe coins are paired against agents who are owed them, so an auction
    /// settles as direct transfers between the villagers who traded. A chunk that
    /// doesn't net to zero settles the remainder against the vault, which is what lets
    /// the caller chunk purely by size and never produce a wrong state.
    ///
    /// It ends by proving itself: every purse it touched must equal its slot's cash.
    pub fn settle_cash<'i>(ctx: Context<'i, SettleCash<'i>>, agents: Vec<u16>, bumps: Vec<u8>) -> Result<()> {
        require!(agents.len() == bumps.len(), EconErr::BadAmount);
        require!(agents.len() == ctx.remaining_accounts.len(), EconErr::BadAmount);
        require_keys_eq!(*ctx.accounts.token_program.key, TOKEN_PROGRAM_ID, EconErr::BadMint);
        let ledger_key = ctx.accounts.ledger.key();

        // What each purse holds now, and what it should hold. Read in its own scope:
        // no account data may stay borrowed across a CPI.
        let mut want: Vec<u64> = Vec::with_capacity(agents.len());
        let mut owed: Vec<i128> = Vec::with_capacity(agents.len());
        {
            let l = ctx.accounts.load_checked()?;
            for (i, (&agent, &bump)) in agents.iter().zip(bumps.iter()).enumerate() {
                require!((agent as u32) < l.num_agents, EconErr::BadAgent);
                let purse = &ctx.remaining_accounts[i];
                check_purse(purse.key, &ledger_key, agent, bump)?;
                let cash = l.slots[agent as usize].cash;
                want.push(cash);
                owed.push(cash as i128 - token_amount(purse)? as i128);
            }
        }

        // Pair those holding too much against those holding too little, so the coins
        // move between the agents themselves rather than through the bank.
        let (mut payer, mut receiver) = (0usize, 0usize);
        while payer < agents.len() && receiver < agents.len() {
            if owed[payer] >= 0 { payer += 1; continue; }
            if owed[receiver] <= 0 { receiver += 1; continue; }
            let amount = (-owed[payer]).min(owed[receiver]) as u64;
            transfer_coins(
                &ctx.remaining_accounts[payer], &ctx.remaining_accounts[receiver],
                &ctx.accounts.token_program, &ledger_key, agents[payer], bumps[payer], amount,
            )?;
            owed[payer] += amount as i128;
            owed[receiver] -= amount as i128;
        }

        // Whatever a chunk can't match among itself settles against the vault.
        let vault = ctx.accounts.vault.to_account_info();
        for (i, &agent) in agents.iter().enumerate() {
            if owed[i] < 0 {
                transfer_coins(
                    &ctx.remaining_accounts[i], &vault, &ctx.accounts.token_program,
                    &ledger_key, agent, bumps[i], (-owed[i]) as u64,
                )?;
            } else if owed[i] > 0 {
                transfer_from_vault(
                    &vault, &ctx.remaining_accounts[i], &ctx.accounts.mint,
                    &ctx.accounts.token_program, &ledger_key, ctx.bumps.mint, owed[i] as u64,
                )?;
            }
        }

        for (i, &cash) in want.iter().enumerate() {
            require_eq!(token_amount(&ctx.remaining_accounts[i])?, cash, EconErr::CashMismatch);
        }
        Ok(())
    }

    pub fn settle(ctx: Context<Write>, deltas: Vec<Delta>) -> Result<()> {
        let mut l = ctx.accounts.load_checked()?;
        let n = l.num_agents;
        for d in deltas.iter() {
            require!((d.agent as u32) < n, EconErr::BadAgent);
            require!((d.good as usize) < N_GOODS, EconErr::BadGood);
            let v = &mut l.slots[d.agent as usize].goods[d.good as usize];
            let next = (*v as i64) + (d.delta as i64);
            require!(next >= 0 && next <= u32::MAX as i64, EconErr::InsufficientGoods);
            *v = next as u32;
        }
        Ok(())
    }

    /// Clear one good's market with a uniform-price batch auction.
    ///
    /// `bids` must arrive sorted by limit DESCENDING, `asks` ASCENDING. The program
    /// verifies the ordering in one O(n) pass (sorting on-chain would blow the compute
    /// budget; verifying is cheap and still a real invariant), walks the two ladders
    /// inward until they stop crossing, and settles every fill at one price.
    ///
    /// The bank may sell seized goods (as agent `BANK`), never buy. A sale takes the
    /// goods off its books at their average book value (`sold_book`); the proceeds
    /// (`recovered`) go to its cash, paying down any `bad_debt` first.
    pub fn clear_auction(
        ctx: Context<ClearAuction>,
        good: u8,
        bids: Vec<Order>,
        asks: Vec<Order>,
    ) -> Result<()> {
        let g = good as usize;
        require!(g < N_GOODS, EconErr::BadGood);
        // The bank selling its seized goods is the one way an auction can destroy coins
        // (the proceeds pay down `bad_debt`). Demanded up front, before any early exit,
        // so a burn can never be skipped by leaving the accounts off.
        let coin = match (
            ctx.accounts.mint.as_ref(),
            ctx.accounts.vault.as_ref(),
            ctx.accounts.token_program.as_ref(),
        ) {
            (Some(m), Some(v), Some(t)) => {
                Some((m.to_account_info(), v.to_account_info(), t.to_account_info()))
            }
            _ => None,
        };
        require!(
            coin.is_some() || !asks.iter().any(|o| o.agent == BANK),
            EconErr::MintAccountsRequired
        );
        let ledger_key = ctx.accounts.ledger.key();
        let mut l = ctx.accounts.load_checked()?;
        let m0 = money(&l);
        let n = l.num_agents;

        for w in bids.windows(2) {
            require!(w[0].limit >= w[1].limit, EconErr::BidsNotSorted);
        }
        for w in asks.windows(2) {
            require!(w[0].limit <= w[1].limit, EconErr::AsksNotSorted);
        }
        for o in bids.iter() {
            require!((o.agent as u32) < n, EconErr::BadAgent);
        }
        for o in asks.iter() {   // the bank may sell (seized collateral), never buy
            require!((o.agent as u32) < n || o.agent == BANK, EconErr::BadAgent);
        }
        l.round += 1;
        if bids.is_empty() || asks.is_empty() {
            return Ok(());
        }

        let (mut i, mut j) = (0usize, 0usize);
        let (mut bid_rem, mut ask_rem) = (bids[0].qty, asks[0].qty);
        let (mut volume, mut last_bid, mut last_ask) = (0u64, 0u32, 0u32);
        while i < bids.len() && j < asks.len() && bids[i].limit >= asks[j].limit {
            let q = bid_rem.min(ask_rem);
            volume += q as u64;
            last_bid = bids[i].limit;
            last_ask = asks[j].limit;
            bid_rem -= q;
            ask_rem -= q;
            if bid_rem == 0 {
                i += 1;
                if i < bids.len() { bid_rem = bids[i].qty; }
            }
            if ask_rem == 0 {
                j += 1;
                if j < asks.len() { ask_rem = asks[j].qty; }
            }
        }
        if volume == 0 {
            return Ok(());
        }
        let price = ((last_bid as u64 + last_ask as u64) / 2).max(1);

        let mut remaining = volume;
        for o in bids.iter() {
            if remaining == 0 { break; }
            let q = (o.qty as u64).min(remaining);
            let s = &mut l.slots[o.agent as usize];
            let cost = q * price;
            require!(s.cash >= cost, EconErr::InsufficientCash);
            s.cash -= cost;
            s.goods[g] = s.goods[g].saturating_add(q as u32);
            remaining -= q;
        }
        let (mut remaining, mut bank_sales, mut bank_cost) = (volume, 0u64, 0u64);
        for o in asks.iter() {
            if remaining == 0 { break; }
            let q = (o.qty as u64).min(remaining);
            if o.agent == BANK {
                let held = l.bank.goods[g] as u64;
                require!(held >= q, EconErr::InsufficientGoods);
                // average book value of the units sold; the last unit takes what's left
                let cost = (l.bank_book[g] as u128 * q as u128 / held as u128) as u64;
                l.bank_book[g] -= cost;
                l.bank.goods[g] -= q as u32;
                bank_sales += q * price;
                bank_cost += cost;
            } else {
                let s = &mut l.slots[o.agent as usize];
                require!(s.goods[g] as u64 >= q, EconErr::InsufficientGoods);
                s.goods[g] -= q as u32;
                s.cash += q * price;
            }
            remaining -= q;
        }
        // a foreclosure sale: the coins leave circulation and turn the bank's goods back into cash
        l.supply -= bank_sales;
        l.recovered += bank_sales;
        l.sold_book += bank_cost;
        credit_equity(&mut l, bank_sales);

        l.last_price[g] = price;
        emit!(Cleared { good, price, volume, round: l.round });
        if let Some((mint, vault, token_program)) = coin.as_ref() {
            settle_money(&l, mint, vault, token_program,
                         &ledger_key, mint_bump_for(&ledger_key), m0, None)?;
        }
        Ok(())
    }
}

/// Charge interest for the time held since the loan was last touched: simple interest
/// on the principal, `rate_bps` per `rate_period_slots`, pro rata by slot (rounded
/// down). It is added to the debt (and `debt_total`); it becomes the bank's income only
/// when paid. Called before every borrow, repay and collect, so `debt` is exact at
/// those points; between them, `accruedDebt` in chain.mjs computes it for any slot.
fn accrue(l: &mut Ledger, agent: usize, now: u64) -> Result<u64> {
    let (rate, period) = (l.rate_bps as u128, l.rate_period_slots as u128);
    let s = &mut l.slots[agent];
    let held = now.saturating_sub(s.accrued_slot as u64) as u128;
    let add = u64::try_from(s.principal as u128 * rate * held / (10_000 * period)).map_err(|_| EconErr::Overflow)?;
    s.accrued_slot = slot32(now)?;
    s.debt = s.debt.checked_add(add).ok_or(EconErr::Overflow)?;
    l.debt_total = l.debt_total.checked_add(add).ok_or(EconErr::Overflow)?;
    Ok(add)
}

/// Loan slots are stored as u32 to fit more agents in the ledger (good for ~54 years of slots).
fn slot32(slot: u64) -> Result<u32> {
    u32::try_from(slot).map_err(|_| error!(EconErr::Overflow))
}

/// The bank's equity: its cash plus its seized goods at book value, less bad debt.
fn equity(l: &Ledger) -> i128 {
    l.bank.cash as i128 + l.bank_book.iter().map(|&v| v as i128).sum::<i128>() - l.bad_debt as i128
}

/// Income to the bank: it first pays down any negative equity (burning those coins and
/// counting them as written off), and only the rest becomes cash.
fn credit_equity(l: &mut Ledger, amount: u64) {
    let cover = amount.min(l.bad_debt);
    l.bad_debt -= cover;
    l.written_off += cover;
    l.bank.cash += amount - cover;
}

/// Burn unpaid principal out of the bank's cash; what its cash can't cover becomes
/// `bad_debt`. Returns (written off now, added to bad debt).
fn write_off(l: &mut Ledger, principal: u64) -> (u64, u64) {
    let now = principal.min(l.bank.cash);
    l.bank.cash -= now;
    l.written_off += now;
    l.bad_debt += principal - now;
    (now, principal - now)
}

fn locked_value(s: &AgentSlot, price: &[u64; N_GOODS]) -> u128 {
    (0..N_GOODS).map(|g| s.locked[g] as u128 * price[g] as u128).sum()
}

fn release(s: &mut AgentSlot) {
    for g in 0..N_GOODS { s.goods[g] += s.locked[g]; }
    s.locked = [0; N_GOODS];
    s.principal = 0;
    s.due_slot = 0;
    s.accrued_slot = 0;
}

// ---------------------------------------------------------------- the coin

/// Build one SPL Token instruction: a tag byte, its arguments, and its accounts.
fn token_ix(tag: u8, args: &[u8], accounts: Vec<AccountMeta>) -> Instruction {
    let mut data = Vec::with_capacity(1 + args.len());
    data.push(tag);
    data.extend_from_slice(args);
    Instruction { program_id: TOKEN_PROGRAM_ID, accounts, data }
}

/// The debtor's purse, if the caller handed one in. It rides as a remaining account, so
/// nothing in the instruction's data or its `Accounts` changed and an older caller that
/// sends none still works (see `fund_burn`).
fn debtor_purse<'a, 'i>(rest: &'a [AccountInfo<'i>], agent: u16) -> Option<(&'a AccountInfo<'i>, u16)> {
    rest.first().map(|purse| (purse, agent))
}

/// What the books say about money, before and after an instruction: coins ever created,
/// and coins ever destroyed. The difference across an instruction is what the mint must
/// do — so the token follows the economics instead of restating it.
fn money(l: &Ledger) -> (u64, u64) {
    (l.minted, l.principal_repaid + l.written_off)
}

/// The SPL mint's own record of how many SETTLERS exist.
fn mint_supply(mint: &AccountInfo) -> Result<u64> {
    let data = mint.try_borrow_data()?;
    require!(data.len() >= MINT_LEN, EconErr::BadMint);
    let bytes: [u8; 8] = data[MINT_SUPPLY_OFFSET..MINT_SUPPLY_OFFSET + 8]
        .try_into()
        .map_err(|_| error!(EconErr::BadMint))?;
    Ok(u64::from_le_bytes(bytes))
}

/// Mint or burn so the token's supply matches the books, then prove it did.
///
/// `before` is `money(&l)` taken at the top of the instruction. An instruction never
/// both creates and destroys coins, but handling both costs nothing and leaves no case
/// to reason about.
fn settle_money<'i>(
    l: &Ledger,
    mint: &AccountInfo<'i>,
    vault: &AccountInfo<'i>,
    token_program: &AccountInfo<'i>,
    ledger_key: &Pubkey,
    bump: u8,
    before: (u64, u64),
    source: Option<(&AccountInfo<'i>, u16)>,
) -> Result<()> {
    require_keys_eq!(*token_program.key, TOKEN_PROGRAM_ID, EconErr::BadMint);
    let (minted_now, destroyed_now) = money(l);
    let created = minted_now - before.0;
    let destroyed = destroyed_now - before.1;
    if created > 0 {
        mint_coins(mint, vault, token_program, ledger_key, bump, created)?;
    }
    if destroyed > 0 {
        // The coins the burn destroys belong to `source`, so bring them home first.
        let want = source.map_or(0, |(_, agent)| l.slots[agent as usize].cash);
        fund_burn(source, want, vault, token_program, ledger_key, destroyed)?;
        burn_coins(mint, vault, token_program, ledger_key, bump, destroyed)?;
    }
    check_supply(l, mint)
}

/// Bring the coins a burn is about to destroy into the vault, out of the purse that
/// actually holds them.
///
/// Burning takes coins out of the vault, but the vault's own balance is only ever the
/// bank's cash: every other SETTLER in existence sits in an agent's purse (`settle_cash`).
/// The coins a repayment or a foreclosure destroys are the DEBTOR's — they left that
/// agent's `cash` a few lines above — so the burn was asking the bank to front them, and
/// once the bank's cash had been eaten by write-offs the vault was empty and the SPL burn
/// failed with "insufficient funds". Long runs reached that state and then every
/// foreclosure reverted, so the keeper could never clear the overdue loan.
///
/// So: before burning, move what the vault is short out of the debtor's purse. Nothing
/// about the economy changes — the debtor's `cash` has already been reduced by at least
/// this much, and `settle_cash` would have moved exactly these coins at the end of the
/// round anyway. This only moves them a few seconds earlier, from the account that holds
/// them to the account the burn reads.
///
/// `source` is optional and the purse is a remaining account, so a caller that passes
/// nothing behaves exactly as before. The purse is checked against its PDA, so no other
/// account can be drained; the bump is derived here rather than taken on trust.
fn fund_burn<'i>(
    source: Option<(&AccountInfo<'i>, u16)>,
    cash: u64,
    vault: &AccountInfo<'i>,
    token_program: &AccountInfo<'i>,
    ledger_key: &Pubkey,
    need: u64,
) -> Result<()> {
    let Some((purse, agent)) = source else { return Ok(()) };
    let index = agent.to_le_bytes();
    let (want, bump) =
        Pubkey::find_program_address(&[PURSE_SEED, ledger_key.as_ref(), &index], &crate::ID);
    require_keys_eq!(*purse.key, want, EconErr::BadPurse);
    // A village whose purses were never created (the token-level tests) simply has
    // nothing to draw on: then this does nothing and the burn behaves as it always did.
    let held = token_amount(purse).unwrap_or(0);
    // Two claims on this purse, and the larger wins.
    //  - `surplus`: coins it is holding that the ledger no longer says are this agent's,
    //    because the instruction just took them (the debt, the penalty, the interest). They
    //    belong in the vault whether or not this burn needs them. Leaving them behind was
    //    what made the vault drift below the bank's cash, so that the NEXT foreclosure in
    //    the same round found it short even though its own debtor was good for it.
    //  - `short`: what the burn is still missing after the vault's own balance.
    let surplus = held.saturating_sub(cash);
    let short = need.saturating_sub(token_amount(vault)?);
    let take = surplus.max(short).min(held);
    transfer_coins(purse, vault, token_program, ledger_key, agent, bump, take)
}

/// MintTo: mint (w), destination (w), authority (s) — the mint signs for itself.
fn mint_coins<'i>(
    mint: &AccountInfo<'i>, vault: &AccountInfo<'i>, token_program: &AccountInfo<'i>,
    ledger_key: &Pubkey, bump: u8, amount: u64,
) -> Result<()> {
    invoke_signed(
        &token_ix(7, &amount.to_le_bytes(), vec![
            AccountMeta::new(*mint.key, false),
            AccountMeta::new(*vault.key, false),
            AccountMeta::new_readonly(*mint.key, true),
        ]),
        &[mint.clone(), vault.clone(), token_program.clone()],
        &[&[MINT_SEED, ledger_key.as_ref(), &[bump]]],
    )?;
    Ok(())
}

/// Burn: account (w), mint (w), authority (s) — the mint owns the vault.
fn burn_coins<'i>(
    mint: &AccountInfo<'i>, vault: &AccountInfo<'i>, token_program: &AccountInfo<'i>,
    ledger_key: &Pubkey, bump: u8, amount: u64,
) -> Result<()> {
    invoke_signed(
        &token_ix(8, &amount.to_le_bytes(), vec![
            AccountMeta::new(*vault.key, false),
            AccountMeta::new(*mint.key, false),
            AccountMeta::new_readonly(*mint.key, true),
        ]),
        &[vault.clone(), mint.clone(), token_program.clone()],
        &[&[MINT_SEED, ledger_key.as_ref(), &[bump]]],
    )?;
    Ok(())
}

/// Every coin the village holds is a SETTLER, and every SETTLER is a coin the village
/// holds. Checked after every instruction that can change either side.
fn check_supply(l: &Ledger, mint: &AccountInfo) -> Result<()> {
    let want = l.supply.checked_add(l.bank.cash).ok_or(EconErr::Overflow)?;
    require_eq!(mint_supply(mint)?, want, EconErr::SupplyMismatch);
    Ok(())
}

/// Create the SETTLERS mint and the vault that holds every coin. Both are PDAs of this
/// ledger, so neither has a private key; the mint is its own mint and freeze authority.
fn create_coin<'i>(
    authority: &AccountInfo<'i>,
    mint: &AccountInfo<'i>,
    vault: &AccountInfo<'i>,
    token_program: &AccountInfo<'i>,
    system_program: &AccountInfo<'i>,
    ledger_key: &Pubkey,
    mint_bump: u8,
    vault_bump: u8,
) -> Result<()> {
    require_keys_eq!(*token_program.key, TOKEN_PROGRAM_ID, EconErr::BadMint);
    let rent = Rent::get()?;
    let mint_seeds: &[&[u8]] = &[MINT_SEED, ledger_key.as_ref(), &[mint_bump]];
    let vault_seeds: &[&[u8]] = &[VAULT_SEED, ledger_key.as_ref(), &[vault_bump]];

    invoke_signed(
        &system_instruction::create_account(
            authority.key, mint.key,
            rent.minimum_balance(MINT_LEN), MINT_LEN as u64, &TOKEN_PROGRAM_ID),
        &[authority.clone(), mint.clone(), system_program.clone()],
        &[mint_seeds],
    )?;
    // InitializeMint2: decimals, mint authority, freeze authority (1-byte option tag)
    let mut args = Vec::with_capacity(1 + 32 + 33);
    args.push(SETTLERS_DECIMALS);
    args.extend_from_slice(mint.key.as_ref());
    args.push(1);
    args.extend_from_slice(mint.key.as_ref());
    invoke_signed(
        &token_ix(20, &args, vec![AccountMeta::new(*mint.key, false)]),
        &[mint.clone(), token_program.clone()],
        &[mint_seeds],
    )?;

    invoke_signed(
        &system_instruction::create_account(
            authority.key, vault.key,
            rent.minimum_balance(TOKEN_ACCOUNT_LEN), TOKEN_ACCOUNT_LEN as u64, &TOKEN_PROGRAM_ID),
        &[authority.clone(), vault.clone(), system_program.clone()],
        &[vault_seeds],
    )?;
    // InitializeAccount3: the owner, given inline — the mint PDA owns the vault
    invoke_signed(
        &token_ix(18, mint.key.as_ref(), vec![
            AccountMeta::new(*vault.key, false),
            AccountMeta::new_readonly(*mint.key, false),
        ]),
        &[vault.clone(), mint.clone(), token_program.clone()],
        &[vault_seeds],
    )?;
    Ok(())
}

// ---------------------------------------------------------------- purses

/// An agent's purse address, derived from the bump the caller supplied. A wrong bump
/// derives a different address, which then fails against the account actually passed —
/// so the caller cannot name an account the program didn't choose.
fn check_purse(purse: &Pubkey, ledger_key: &Pubkey, agent: u16, bump: u8) -> Result<()> {
    let index = agent.to_le_bytes();
    let want = Pubkey::create_program_address(
        &[PURSE_SEED, ledger_key.as_ref(), &index, &[bump]], &crate::ID,
    ).map_err(|_| error!(EconErr::BadPurse))?;
    require_keys_eq!(*purse, want, EconErr::BadPurse);
    Ok(())
}

/// What a token account holds. Read in its own scope — never across a CPI.
fn token_amount(account: &AccountInfo) -> Result<u64> {
    let data = account.try_borrow_data()?;
    require!(data.len() >= TOKEN_ACCOUNT_LEN, EconErr::BadPurse);
    let bytes: [u8; 8] = data[TOKEN_AMOUNT_OFFSET..TOKEN_AMOUNT_OFFSET + 8]
        .try_into()
        .map_err(|_| error!(EconErr::BadPurse))?;
    Ok(u64::from_le_bytes(bytes))
}

/// Transfer: source (w), destination (w), authority (s). A purse owns itself, so the
/// program signs for it with the purse's own seeds.
fn transfer_coins<'i>(
    from: &AccountInfo<'i>, to: &AccountInfo<'i>, token_program: &AccountInfo<'i>,
    ledger_key: &Pubkey, agent: u16, bump: u8, amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let index = agent.to_le_bytes();
    invoke_signed(
        &token_ix(3, &amount.to_le_bytes(), vec![
            AccountMeta::new(*from.key, false),
            AccountMeta::new(*to.key, false),
            AccountMeta::new_readonly(*from.key, true),
        ]),
        &[from.clone(), to.clone(), token_program.clone()],
        &[&[PURSE_SEED, ledger_key.as_ref(), &index, &[bump]]],
    )?;
    Ok(())
}

/// The vault pays out what a chunk couldn't match among its own agents. The vault is
/// owned by the mint PDA, so the mint signs.
fn transfer_from_vault<'i>(
    vault: &AccountInfo<'i>, to: &AccountInfo<'i>, mint: &AccountInfo<'i>,
    token_program: &AccountInfo<'i>, ledger_key: &Pubkey, bump: u8, amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    invoke_signed(
        &token_ix(3, &amount.to_le_bytes(), vec![
            AccountMeta::new(*vault.key, false),
            AccountMeta::new(*to.key, false),
            AccountMeta::new_readonly(*mint.key, true),
        ]),
        &[vault.clone(), to.clone(), mint.clone(), token_program.clone()],
        &[&[MINT_SEED, ledger_key.as_ref(), &[bump]]],
    )?;
    Ok(())
}

/// The bump for this ledger's mint, found the long way. Used only on the rare auction
/// that carries the mint, where Anchor has no bump for an optional account.
fn mint_bump_for(ledger_key: &Pubkey) -> u8 {
    Pubkey::find_program_address(&[MINT_SEED, ledger_key.as_ref()], &crate::ID).1
}

// ---------------------------------------------------------------- accounts

/// Byte offsets below are from the start of the struct; the account adds Anchor's
/// 8-byte discriminator in front. `chain.mjs` decodes this by hand, so keep them in step.
#[account(zero_copy)]
#[repr(C)]
pub struct Ledger {
    pub authority: Pubkey,            //   0
    pub num_agents: u32,              //  32
    pub round: u32,                   //  36
    pub last_price: [u64; N_GOODS],   //  40  cents: food, wood, nets, boats, houses
    pub supply: u64,                  //  80  coins held by agents (not the bank)
    pub debt_total: u64,              //  88  owed to the bank across all open loans, as last accrued
    // ---- the books
    pub start_money: u64,             //  96  start_cash × num_agents
    pub bank_seed: u64,               // 104  the bank's opening equity
    pub minted: u64,                  // 112  principal ever lent
    pub principal_repaid: u64,        // 120  principal burned: repayments + debtor cash at foreclosure
    pub interest_income: u64,         // 128  interest collected in cash, to equity
    pub penalties: u64,               // 136  foreclosure penalties collected in cash, to equity
    pub recovered: u64,               // 144  sale proceeds of seized goods, to cash
    pub written_off: u64,             // 152  unpaid principal burned out of cash (at foreclosure, forgiveness, or later from bad_debt)
    pub bad_debt: u64,                // 160  unpaid principal not yet burned (negative cash); income pays it first
    pub dividends_paid: u64,          // 168  cash paid out to agents
    pub seized_value: u64,            // 176  fire-sale value of all goods ever seized, booked as bank goods
    pub sold_book: u64,               // 184  book value of seized goods sold; recovered − sold_book = gain on sales
    pub refunds: u64,                 // 192  cash refunded to debtors when seized goods were worth more than owed
    pub forgiven: u64,                // 200  debt remainders under a coin forgiven on repay (principal part is in written_off)
    pub bank_book: [u64; N_GOODS],    // 208  book value of the seized goods the bank holds, per good
    // ---- the bank's rules
    pub equity_floor: u64,            // 248  equity never paid out as a dividend
    pub rate_period_slots: u64,       // 256  interest is rate_bps per this many slots
    pub term_unit_slots: u64,         // 264  a loan term is 1..=max_term_units of these
    pub ltv_bps: u16,                 // 272  0 = no credit
    pub rate_bps: u16,                // 274
    pub penalty_bps: u16,             // 276
    pub kappa_bps: u16,               // 278  capital ratio: lend at most equity × 10_000 / kappa
    pub margin_bps: u16,              // 280  margin call when debt > this share of collateral value
    pub max_term_units: u16,          // 282
    pub _pad: [u16; 2],               // 284
    pub bank: AgentSlot,              // 288  cash = the bank's cash; goods = seized collateral for sale
    pub slots: [AgentSlot; MAX_AGENTS], // 360
}

#[zero_copy]
#[repr(C)]
#[derive(Default)]
pub struct AgentSlot {
    pub cash: u64,               //  0
    pub goods: [u32; N_GOODS],   //  8  free goods
    pub locked: [u32; N_GOODS],  // 28  pledged to the bank
    pub debt: u64,               // 48  owed, interest accrued to `accrued_slot` included
    pub principal: u64,          // 56  the part of `debt` that is principal (the rest is interest)
    pub due_slot: u32,           // 64  after this slot, anyone may collect or foreclose
    pub accrued_slot: u32,       // 68  interest is charged up to here
}                                // 72 bytes, no padding

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct BankTerms {
    pub ltv_bps: u16,
    pub rate_bps: u16,
    pub penalty_bps: u16,
    pub kappa_bps: u16,
    pub margin_bps: u16,
    pub max_term_units: u16,
    pub rate_period_slots: u64,
    pub term_unit_slots: u64,
    pub equity_floor: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct Order {
    pub agent: u16,
    pub qty: u32,
    pub limit: u32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct Delta {
    pub agent: u16,
    pub good: u8,
    pub delta: i32,
}

#[event]
pub struct Cleared {
    pub good: u8,
    pub price: u64,
    pub volume: u64,
    pub round: u32,
}

#[event]
pub struct Borrowed { pub agent: u16, pub amount: u64, pub debt: u64, pub accrued: u64, pub due_slot: u64 }
#[event]
pub struct Repaid { pub agent: u16, pub paid: u64, pub interest: u64, pub principal: u64, pub forgiven: u64 }
#[event]
pub struct Collected { pub agent: u16, pub paid: u64, pub interest: u64, pub principal: u64 }
#[event]
pub struct Foreclosed {
    pub agent: u16,
    pub margin_call: bool,
    pub debt: u64,
    pub penalty: u64,
    pub collected: u64,
    pub burned: u64,
    pub seized: [u32; N_GOODS],
    pub seized_value: u64,
    pub refund: u64,
    pub returned: [u32; N_GOODS],
    pub written_off: u64,
    pub bad_debt: u64,
}
#[event]
pub struct DividendPaid { pub per_agent: u64, pub total: u64, pub equity_left: i64, pub by: Pubkey }

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + std::mem::size_of::<Ledger>())]
    pub ledger: AccountLoader<'info, Ledger>,
    /// CHECK: the SETTLERS mint, a PDA of this ledger, created and initialized here.
    #[account(mut, seeds = [MINT_SEED, ledger.key().as_ref()], bump)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the vault that holds every SETTLER, a PDA of this ledger, created here.
    #[account(mut, seeds = [VAULT_SEED, ledger.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: checked by address against TOKEN_PROGRAM_ID.
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// A write that can create or destroy coins: it carries the mint and its vault.
/// `Write` is left alone for `settle`, which moves goods and never money.
#[derive(Accounts)]
pub struct WriteMint<'info> {
    #[account(mut)]
    pub ledger: AccountLoader<'info, Ledger>,
    pub authority: Signer<'info>,
    /// CHECK: the SETTLERS mint, validated by its seeds.
    #[account(mut, seeds = [MINT_SEED, ledger.key().as_ref()], bump)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the vault, validated by its seeds.
    #[account(mut, seeds = [VAULT_SEED, ledger.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: checked by address against TOKEN_PROGRAM_ID.
    pub token_program: UncheckedAccount<'info>,
}

/// An auction only touches the money supply when the bank fire-sells seized goods and
/// the proceeds pay down `bad_debt`. The mint accounts are optional so an ordinary
/// auction — the transaction already closest to the size limit — doesn't carry them.
/// `clear_auction` requires them whenever the asks contain a `BANK` order.
#[derive(Accounts)]
pub struct ClearAuction<'info> {
    #[account(mut)]
    pub ledger: AccountLoader<'info, Ledger>,
    pub authority: Signer<'info>,
    /// CHECK: the SETTLERS mint, validated by its seeds when present.
    #[account(mut, seeds = [MINT_SEED, ledger.key().as_ref()], bump)]
    pub mint: Option<UncheckedAccount<'info>>,
    /// CHECK: the vault, validated by its seeds when present.
    #[account(mut, seeds = [VAULT_SEED, ledger.key().as_ref()], bump)]
    pub vault: Option<UncheckedAccount<'info>>,
    /// CHECK: checked by address against TOKEN_PROGRAM_ID when present.
    pub token_program: Option<UncheckedAccount<'info>>,
}

/// Creating agents' purses: the authority pays their rent, so it signs.
/// The purses themselves come in as remaining accounts, one per agent in the batch.
#[derive(Accounts)]
pub struct InitPurses<'info> {
    #[account(mut)]
    pub ledger: AccountLoader<'info, Ledger>,
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: the SETTLERS mint, validated by its seeds.
    #[account(seeds = [MINT_SEED, ledger.key().as_ref()], bump)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: checked by address against TOKEN_PROGRAM_ID.
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Moving coins between purses. The mint signs for the vault, so it is here even
/// though nothing is minted or burned. The purses come in as remaining accounts.
#[derive(Accounts)]
pub struct SettleCash<'info> {
    #[account(mut)]
    pub ledger: AccountLoader<'info, Ledger>,
    pub authority: Signer<'info>,
    /// CHECK: the SETTLERS mint, validated by its seeds. Signs for the vault.
    #[account(seeds = [MINT_SEED, ledger.key().as_ref()], bump)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the vault, validated by its seeds.
    #[account(mut, seeds = [VAULT_SEED, ledger.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: checked by address against TOKEN_PROGRAM_ID.
    pub token_program: UncheckedAccount<'info>,
}

/// Every write to the ledger must be signed by the ledger's authority.
#[derive(Accounts)]
pub struct Write<'info> {
    #[account(mut)]
    pub ledger: AccountLoader<'info, Ledger>,
    pub authority: Signer<'info>,
}

/// No authority check: the dividend is open to anyone. The instruction
/// itself checks that the rules allow it.
#[derive(Accounts)]
pub struct Anyone<'info> {
    #[account(mut)]
    pub ledger: AccountLoader<'info, Ledger>,
    pub caller: Signer<'info>,
}

impl<'info> Write<'info> {
    fn load_checked(&self) -> Result<std::cell::RefMut<'_, Ledger>> {
        let l = self.ledger.load_mut()?;
        require_keys_eq!(l.authority, self.authority.key(), EconErr::Unauthorized);
        Ok(l)
    }
}

impl<'info> WriteMint<'info> {
    fn load_checked(&self) -> Result<std::cell::RefMut<'_, Ledger>> {
        let l = self.ledger.load_mut()?;
        require_keys_eq!(l.authority, self.authority.key(), EconErr::Unauthorized);
        Ok(l)
    }
}

impl<'info> InitPurses<'info> {
    fn load_checked(&self) -> Result<std::cell::RefMut<'_, Ledger>> {
        let l = self.ledger.load_mut()?;
        require_keys_eq!(l.authority, self.authority.key(), EconErr::Unauthorized);
        Ok(l)
    }
}

impl<'info> SettleCash<'info> {
    fn load_checked(&self) -> Result<std::cell::RefMut<'_, Ledger>> {
        let l = self.ledger.load_mut()?;
        require_keys_eq!(l.authority, self.authority.key(), EconErr::Unauthorized);
        Ok(l)
    }
}

impl<'info> ClearAuction<'info> {
    fn load_checked(&self) -> Result<std::cell::RefMut<'_, Ledger>> {
        let l = self.ledger.load_mut()?;
        require_keys_eq!(l.authority, self.authority.key(), EconErr::Unauthorized);
        Ok(l)
    }
}

#[error_code]
pub enum EconErr {
    #[msg("too many agents for this ledger")]
    TooManyAgents,
    #[msg("agent index out of range")]
    BadAgent,
    #[msg("good index out of range")]
    BadGood,
    #[msg("bids must be sorted by limit descending")]
    BidsNotSorted,
    #[msg("asks must be sorted by limit ascending")]
    AsksNotSorted,
    #[msg("agent cannot afford this fill")]
    InsufficientCash,
    #[msg("agent does not hold enough of this good")]
    InsufficientGoods,
    #[msg("only the ledger authority may write to it")]
    Unauthorized,
    #[msg("bad bank terms")]
    BadTerms,
    #[msg("amount must be positive")]
    BadAmount,
    #[msg("food rots and cannot be pledged")]
    FoodNotCollateral,
    #[msg("the bank has reached its lending cap")]
    DebtCapReached,
    #[msg("collateral is worth too little for this loan")]
    NotEnoughCollateral,
    #[msg("this agent has no open loan")]
    NoLoan,
    #[msg("the loan is neither overdue nor under its margin")]
    NotCollectable,
    #[msg("the bank is not lending: credit is switched off")]
    CreditOff,
    #[msg("loan term must be a whole number of term units, from 1 up to the maximum")]
    BadTerm,
    #[msg("this loan is overdue: it can't be topped up, only repaid or collected")]
    Overdue,
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("the SETTLERS supply no longer matches the village's books")]
    SupplyMismatch,
    #[msg("this auction sells the bank's collateral: it must carry the mint and its vault")]
    MintAccountsRequired,
    #[msg("not this ledger's SETTLERS mint")]
    BadMint,
    #[msg("not this agent's purse for this ledger")]
    BadPurse,
    #[msg("a purse no longer holds what the village's books say that agent has")]
    CashMismatch,
}
