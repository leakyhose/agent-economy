//! agent-economy — the village ledger and its market, on Solana.
//!
//! The simulation (agent minds, time, movement) runs off-chain. What lives here is
//! the economy itself: who owns what, and the market that turns orders into a price.
//!
//! Only the ledger's authority (the village server) may write to it — with two
//! exceptions: `liquidate` and `pay_dividend` are permissionless, so anyone can
//! foreclose a bad loan or pay out the bank's surplus. Everything written is checked:
//! no balance can go negative, no good can be conjured by a trade, and the market
//! clears at one uniform price for everyone.
//!
//! Money: agents start with a fixed purse, and the only way new coins come into being
//! is the village bank lending them against collateral. Repaying the principal burns
//! it again; the interest goes to the bank. Every coin agents hold is counted in `supply`.
//!
//! The bank has a balance sheet. Its equity is its own cash (`bank.cash`), seeded at
//! `initialize`, fed by interest, penalties and foreclosure sales, and drained by bad
//! loans and dividends. It may lend at most `equity / kappa`, so defaults that eat its
//! equity tighten credit for everyone. A loss bigger than the bank's cash leaves it
//! with negative equity (`bad_debt`), which its next income pays down before anything
//! else. The books close exactly:
//!
//!   Σ agent cash + bank cash = start_money + bank_seed + minted − principal_repaid − written_off
//!   bank cash = bank_seed + interest_income + penalties + recovered − written_off − dividends_paid
//!   minted = Σ open principal + principal_repaid + written_off + bad_debt

use anchor_lang::prelude::*;

declare_id!("9cs35JHZo92yqd8teVHUUi44gLmKuVkc8kYP6pw7RhR7");

pub const MAX_AGENTS: usize = 150;        // 8 + 264 + 150×64 = 9,872 bytes: under the 10 KiB CPI-create limit
pub const N_GOODS: usize = 4;
pub const FOOD: usize = 0;
pub const WOOD: usize = 1;
pub const NETS: usize = 2;
pub const BOATS: usize = 3;
/// Order `agent` id that means "the bank" — used to sell seized collateral.
pub const BANK: u16 = u16::MAX;
/// A foreclosure values seized goods at 80% of the last price: what a fire sale fetches.
pub const FIRE_SALE_BPS: u64 = 8_000;

#[program]
pub mod chain {
    use super::*;

    /// Create the village ledger and give every agent a starting purse and pantry.
    /// Also sets the opening price of each good, seeds the bank's equity, and fixes
    /// the bank's rules for the life of the ledger.
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
        require!(terms.kappa_bps > 0, EconErr::BadTerms);
        require!(start_prices.iter().all(|&p| p > 0), EconErr::BadTerms);
        let mut l = ctx.accounts.ledger.load_init()?;
        l.authority = ctx.accounts.authority.key();
        l.num_agents = num_agents;
        l.round = 0;
        l.last_price = start_prices;
        for i in 0..num_agents as usize {
            l.slots[i].cash = start_cash;
            l.slots[i].goods = [start_food, start_wood, 0, 0];
        }
        l.start_money = start_cash * num_agents as u64;
        l.supply = l.start_money;
        l.bank_seed = bank_seed;
        l.bank.cash = bank_seed;
        l.ltv_bps = terms.ltv_bps;
        l.rate_bps = terms.rate_bps;
        l.penalty_bps = terms.penalty_bps;
        l.kappa_bps = terms.kappa_bps;
        l.margin_bps = terms.margin_bps;
        l.term_slots = terms.term_slots;
        l.equity_floor = terms.equity_floor;
        Ok(())
    }

    /// Borrow newly minted coins against wood, nets and boats.
    ///
    /// The collateral is locked out of the agent's goods (locked goods don't rot). The
    /// loan (principal plus interest) may be at most `ltv_bps` of the locked goods' value
    /// at the last clearing prices. Food can't be pledged: it rots.
    ///
    /// The bank's lending is capped by its capital: all loans together, this one
    /// included, may not exceed `equity × 10_000 / kappa_bps`. Borrowing more on an
    /// open loan does not move its due date.
    pub fn borrow(ctx: Context<Write>, agent: u16, amount: u64, collateral: [u32; N_GOODS]) -> Result<()> {
        let now = Clock::get()?.slot;
        let mut l = ctx.accounts.load_checked()?;
        require!((agent as u32) < l.num_agents, EconErr::BadAgent);
        require!(amount > 0, EconErr::BadAmount);
        require!(collateral[FOOD] == 0, EconErr::FoodNotCollateral);
        let owed = amount + amount * l.rate_bps as u64 / 10_000;
        require!(
            (l.debt_total + owed) as u128 * l.kappa_bps as u128 <= l.bank.cash as u128 * 10_000,
            EconErr::DebtCapReached
        );
        let (price, ltv, term) = (l.last_price, l.ltv_bps as u64, l.term_slots);
        let s = &mut l.slots[agent as usize];
        for g in 0..N_GOODS {
            require!(s.goods[g] >= collateral[g], EconErr::InsufficientGoods);
            s.goods[g] -= collateral[g];
            s.locked[g] += collateral[g];
        }
        require!((s.debt + owed) * 10_000 <= locked_value(s, &price) * ltv, EconErr::NotEnoughCollateral);
        if s.debt == 0 { s.due_slot = now + term; }
        s.debt += owed;
        s.principal += amount;
        s.cash += amount;
        let due_slot = s.due_slot;
        l.debt_total += owed;
        l.supply += amount;
        l.minted += amount;
        emit!(Borrowed { agent, amount, owed, due_slot });
        Ok(())
    }

    /// Pay down a loan. Interest is paid first and goes to the bank's equity; the
    /// rest pays off principal, and those coins are burned. Paid off in full, the
    /// collateral unlocks.
    pub fn repay(ctx: Context<Write>, agent: u16, amount: u64) -> Result<()> {
        let mut l = ctx.accounts.load_checked()?;
        require!((agent as u32) < l.num_agents, EconErr::BadAgent);
        let s = &mut l.slots[agent as usize];
        let paid = amount.min(s.debt).min(s.cash);
        require!(paid > 0, EconErr::BadAmount);
        let interest = paid.min(s.debt - s.principal);
        let principal = paid - interest;
        s.cash -= paid;
        s.debt -= paid;
        s.principal -= principal;
        if s.debt == 0 { release(s); }
        l.interest_income += interest;
        credit_equity(&mut l, interest);
        l.principal_repaid += principal;
        l.debt_total -= paid;
        l.supply -= paid;
        emit!(Repaid { agent, paid, interest, principal });
        Ok(())
    }

    /// Foreclose a loan. PERMISSIONLESS: any signer may call this — the server can't
    /// protect a debtor, and a stranger can enforce the bank's rules without asking.
    ///
    /// Allowed when the loan is overdue (the chain's clock is past the due slot), or on
    /// a margin call: when the debt is more than `margin_bps` of the collateral's value
    /// at the last clearing prices, i.e. `debt × 10_000 > locked value × margin_bps`.
    /// A fire sale that drops a price can push other loans under that line.
    ///
    /// A penalty is added, then the debtor's cash is collected — interest and penalty
    /// first, to the bank's equity, the rest burned as principal. If that falls short,
    /// the bank seizes only as much collateral as the shortfall needs at fire-sale value
    /// (most valuable goods first) and gives the rest back. Whatever principal the
    /// debtor's cash didn't cover is written off against the bank's equity at once —
    /// the seized goods are carried at zero, and their sale later shows up as
    /// `recovered`. A write-off bigger than the bank's cash leaves the rest as
    /// `bad_debt` (negative equity), burned out of the bank's next income.
    pub fn liquidate(ctx: Context<Anyone>, agent: u16) -> Result<()> {
        let now = Clock::get()?.slot;
        let mut l = ctx.accounts.ledger.load_mut()?;
        require!((agent as u32) < l.num_agents, EconErr::BadAgent);
        let (price, penalty_bps, margin_bps) = (l.last_price, l.penalty_bps as u64, l.margin_bps as u128);
        let s = &mut l.slots[agent as usize];
        require!(s.debt > 0, EconErr::NoLoan);
        let overdue = now > s.due_slot;
        let margin_call = s.debt as u128 * 10_000 > locked_value(s, &price) as u128 * margin_bps;
        require!(overdue || margin_call, EconErr::NotLiquidatable);

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
        let mut rem = owed - collected;
        let mut seized = [0u32; N_GOODS];
        let mut order: [usize; N_GOODS] = core::array::from_fn(|g| g);
        order.sort_by(|&a, &b| price[b].cmp(&price[a]));
        for g in order {
            if rem == 0 { break; }
            let unit = (price[g] * FIRE_SALE_BPS / 10_000).max(1);
            let take = rem.div_ceil(unit).min(s.locked[g] as u64);
            seized[g] = take as u32;
            rem = rem.saturating_sub(take * unit);
        }
        let mut returned = [0u32; N_GOODS];
        for g in 0..N_GOODS {
            returned[g] = s.locked[g] - seized[g];
            s.goods[g] += returned[g];
        }
        s.locked = [0; N_GOODS];
        s.debt = 0;
        s.principal = 0;
        s.due_slot = 0;

        let interest_paid = to_equity.min(interest);
        l.interest_income += interest_paid;
        l.penalties += to_equity - interest_paid;
        credit_equity(&mut l, to_equity);
        let written_off = principal_short.min(l.bank.cash);
        l.bank.cash -= written_off;
        let bad_debt = principal_short - written_off;
        for g in 0..N_GOODS { l.bank.goods[g] += seized[g]; }
        l.principal_repaid += burned;
        l.written_off += written_off;
        l.bad_debt += bad_debt;
        l.debt_total -= debt;
        l.supply -= collected;
        emit!(Liquidated {
            agent, margin_call, collected, burned, seized, returned, written_off, bad_debt,
            by: ctx.accounts.caller.key(),
        });
        Ok(())
    }

    /// Pay the bank's surplus out to every agent equally. PERMISSIONLESS.
    ///
    /// The bank must keep `kappa × debt_total` plus `equity_floor` as capital; any
    /// equity above that is paid out (rounded down to an equal share each). With no
    /// surplus this does nothing.
    pub fn pay_dividend(ctx: Context<Anyone>) -> Result<()> {
        let mut l = ctx.accounts.ledger.load_mut()?;
        let n = l.num_agents as u64;
        let required = l.debt_total * l.kappa_bps as u64 / 10_000 + l.equity_floor;
        if n == 0 || l.bank.cash <= required { return Ok(()); }
        let per_agent = (l.bank.cash - required) / n;
        if per_agent == 0 { return Ok(()); }
        let total = per_agent * n;
        for i in 0..n as usize { l.slots[i].cash += per_agent; }
        l.bank.cash -= total;
        l.supply += total;
        l.dividends_paid += total;
        emit!(DividendPaid { per_agent, total, equity_left: l.bank.cash, by: ctx.accounts.caller.key() });
        Ok(())
    }

    /// Apply what happened in the world since the last round: catches, wood cut,
    /// meals eaten, nets and boats built, nets and boats worn out. Signed deltas;
    /// nothing may go negative.
    pub fn settle(ctx: Context<Write>, deltas: Vec<Delta>) -> Result<()> {
        let mut l = ctx.accounts.load_checked()?;
        let n = l.num_agents;
        for d in deltas.iter() {
            require!((d.agent as u32) < n, EconErr::BadAgent);
            require!((d.good as usize) < N_GOODS, EconErr::BadGood);
            let v = &mut l.slots[d.agent as usize].goods[d.good as usize];
            let next = (*v as i64) + (d.delta as i64);
            require!(next >= 0, EconErr::InsufficientGoods);
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
    pub fn clear_auction(
        ctx: Context<Write>,
        good: u8,
        bids: Vec<Order>,
        asks: Vec<Order>,
    ) -> Result<()> {
        let g = good as usize;
        require!(g < N_GOODS, EconErr::BadGood);
        let mut l = ctx.accounts.load_checked()?;
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
        let (mut remaining, mut bank_sales) = (volume, 0u64);
        for o in asks.iter() {
            if remaining == 0 { break; }
            let q = (o.qty as u64).min(remaining);
            if o.agent == BANK {
                require!(l.bank.goods[g] as u64 >= q, EconErr::InsufficientGoods);
                l.bank.goods[g] -= q as u32;
                bank_sales += q * price;
            } else {
                let s = &mut l.slots[o.agent as usize];
                require!(s.goods[g] as u64 >= q, EconErr::InsufficientGoods);
                s.goods[g] -= q as u32;
                s.cash += q * price;
            }
            remaining -= q;
        }
        // a foreclosure sale: the coins leave circulation and rebuild the bank's equity
        l.supply -= bank_sales;
        l.recovered += bank_sales;
        credit_equity(&mut l, bank_sales);

        l.last_price[g] = price;
        emit!(Cleared { good, price, volume, round: l.round });
        Ok(())
    }
}

/// Income to the bank: it first pays down any negative equity (burning those coins and
/// counting them as written off), and only the rest becomes cash.
fn credit_equity(l: &mut Ledger, amount: u64) {
    let cover = amount.min(l.bad_debt);
    l.bad_debt -= cover;
    l.written_off += cover;
    l.bank.cash += amount - cover;
}

fn locked_value(s: &AgentSlot, price: &[u64; N_GOODS]) -> u64 {
    (0..N_GOODS).map(|g| s.locked[g] as u64 * price[g]).sum()
}

fn release(s: &mut AgentSlot) {
    for g in 0..N_GOODS { s.goods[g] += s.locked[g]; }
    s.locked = [0; N_GOODS];
    s.principal = 0;
    s.due_slot = 0;
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
    pub last_price: [u64; N_GOODS],   //  40  cents: food, wood, nets, boats
    pub supply: u64,                  //  72  coins held by agents (not the bank)
    pub debt_total: u64,              //  80  owed to the bank across all open loans
    // ---- the books
    pub start_money: u64,             //  88  start_cash × num_agents
    pub bank_seed: u64,               //  96  the bank's opening equity
    pub minted: u64,                  // 104  principal ever lent
    pub principal_repaid: u64,        // 112  principal burned: repayments + debtor cash at foreclosure
    pub interest_income: u64,         // 120  interest collected, to equity
    pub penalties: u64,               // 128  foreclosure penalties collected, to equity
    pub recovered: u64,               // 136  foreclosure sale proceeds, to equity
    pub written_off: u64,             // 144  unpaid principal burned out of equity (at foreclosure, or later from bad_debt)
    pub bad_debt: u64,                // 152  negative equity: unpaid principal not yet burned; income pays it first
    pub dividends_paid: u64,          // 160  equity paid out to agents
    // ---- the bank's rules
    pub equity_floor: u64,            // 168  equity never paid out as a dividend
    pub term_slots: u64,              // 176
    pub ltv_bps: u16,                 // 184
    pub rate_bps: u16,                // 186
    pub penalty_bps: u16,             // 188
    pub kappa_bps: u16,               // 190  capital ratio: lend at most equity × 10_000 / kappa
    pub margin_bps: u16,              // 192  margin call when debt > this share of collateral value
    pub _pad: [u16; 3],               // 194
    pub bank: AgentSlot,              // 200  cash = equity; goods = seized collateral for sale
    pub slots: [AgentSlot; MAX_AGENTS], // 264
}

#[zero_copy]
#[repr(C)]
#[derive(Default)]
pub struct AgentSlot {
    pub cash: u64,               //  0
    pub goods: [u32; N_GOODS],   //  8  free goods
    pub locked: [u32; N_GOODS],  // 24  pledged to the bank
    pub debt: u64,               // 40  owed, interest included
    pub principal: u64,          // 48  the part of `debt` that is principal (the rest is interest)
    pub due_slot: u64,           // 56  after this slot, anyone may liquidate
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct BankTerms {
    pub ltv_bps: u16,
    pub rate_bps: u16,
    pub penalty_bps: u16,
    pub kappa_bps: u16,
    pub margin_bps: u16,
    pub term_slots: u64,
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
pub struct Borrowed { pub agent: u16, pub amount: u64, pub owed: u64, pub due_slot: u64 }
#[event]
pub struct Repaid { pub agent: u16, pub paid: u64, pub interest: u64, pub principal: u64 }
#[event]
pub struct Liquidated {
    pub agent: u16,
    pub margin_call: bool,
    pub collected: u64,
    pub burned: u64,
    pub seized: [u32; N_GOODS],
    pub returned: [u32; N_GOODS],
    pub written_off: u64,
    pub bad_debt: u64,
    pub by: Pubkey,
}
#[event]
pub struct DividendPaid { pub per_agent: u64, pub total: u64, pub equity_left: u64, pub by: Pubkey }

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + std::mem::size_of::<Ledger>())]
    pub ledger: AccountLoader<'info, Ledger>,
    pub system_program: Program<'info, System>,
}

/// Every write to the ledger must be signed by the ledger's authority.
#[derive(Accounts)]
pub struct Write<'info> {
    #[account(mut)]
    pub ledger: AccountLoader<'info, Ledger>,
    pub authority: Signer<'info>,
}

/// No authority check: foreclosure and dividends are open to anyone. The
/// instructions themselves check that the rules allow them.
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
    NotLiquidatable,
}
