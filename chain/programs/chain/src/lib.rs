//! agent-economy — the village ledger and its market, on Solana.
//!
//! The simulation runs off-chain. What lives here is the economy itself:
//!   * who owns what (cash and goods)
//!   * the market that turns orders into a price
//!
//! The market is a uniform-price batch auction. Every agent submits a limit order,
//! the program finds the single price that maximises traded volume, and everyone
//! trades at that one price. Orders arrive PRE-SORTED from the crank and the program
//! verifies the ordering in one O(n) pass — sorting on-chain would blow the compute
//! budget, while verifying is cheap and is still a real on-chain invariant.

use anchor_lang::prelude::*;

declare_id!("9cs35JHZo92yqd8teVHUUi44gLmKuVkc8kYP6pw7RhR7");

pub const MAX_AGENTS: usize = 320;
pub const N_GOODS: usize = 3; // 0 = fish, 1 = wood, 2 = ore

#[program]
pub mod chain {
    use super::*;

    /// Create the village ledger and hand every agent a starting purse.
    pub fn initialize(ctx: Context<Initialize>, num_agents: u32, start_cash: u64) -> Result<()> {
        require!(num_agents as usize <= MAX_AGENTS, EconErr::TooManyAgents);
        let mut l = ctx.accounts.ledger.load_init()?;
        l.authority = ctx.accounts.payer.key();
        l.num_agents = num_agents;
        l.epoch = 0;
        l.last_price = [500, 400, 600]; // cents
        for i in 0..num_agents as usize {
            l.slots[i].cash = start_cash;
            l.slots[i].goods = [300, 0, 0]; // three fish to start, in hundredths
        }
        Ok(())
    }

    /// A shift ended: credit what these agents caught, cut or mined.
    pub fn settle_production(ctx: Context<Mutate>, harvests: Vec<Harvest>) -> Result<()> {
        let mut l = ctx.accounts.ledger.load_mut()?;
        let n = l.num_agents;
        for h in harvests.iter() {
            require!((h.agent as u32) < n, EconErr::BadAgent);
            require!((h.good as usize) < N_GOODS, EconErr::BadGood);
            let s = &mut l.slots[h.agent as usize];
            s.goods[h.good as usize] = s.goods[h.good as usize].saturating_add(h.qty);
        }
        l.epoch += 1;
        Ok(())
    }

    /// Clear one good's market. This is the heart of the program.
    ///
    /// `bids` must arrive sorted by limit DESCENDING, `asks` by limit ASCENDING.
    /// Returns nothing; the clearing price is written to `ledger.last_price[good]`
    /// and every filled order is settled against the ledger atomically.
    pub fn clear_auction(
        ctx: Context<Mutate>,
        good: u8,
        bids: Vec<Order>,
        asks: Vec<Order>,
    ) -> Result<()> {
        let g = good as usize;
        require!(g < N_GOODS, EconErr::BadGood);
        let mut l = ctx.accounts.ledger.load_mut()?;
        let n = l.num_agents;

        // --- verify the ordering the crank claims (O(n), cheap, still an invariant) ---
        for w in bids.windows(2) {
            require!(w[0].limit >= w[1].limit, EconErr::BidsNotSorted);
        }
        for w in asks.windows(2) {
            require!(w[0].limit <= w[1].limit, EconErr::AsksNotSorted);
        }
        for o in bids.iter().chain(asks.iter()) {
            require!((o.agent as u32) < n, EconErr::BadAgent);
        }

        if bids.is_empty() || asks.is_empty() {
            return Ok(());
        }

        // --- walk the two ladders inward until they stop crossing ---
        // Volume is whatever changes hands before bid < ask; the clearing price sits
        // between the last bid and last ask that actually traded.
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
            return Ok(()); // no crossing: no trade, price unchanged
        }
        let price = ((last_bid as u64 + last_ask as u64) / 2).max(1);

        // --- settle, in the same order we matched ---
        let mut remaining = volume;
        for o in bids.iter() {
            if remaining == 0 { break; }
            let q = (o.qty as u64).min(remaining);
            let cost = q * price;
            let s = &mut l.slots[o.agent as usize];
            require!(s.cash >= cost, EconErr::InsufficientCash);
            s.cash -= cost;
            s.goods[g] = s.goods[g].saturating_add(q as u32);
            remaining -= q;
        }
        let mut remaining = volume;
        for o in asks.iter() {
            if remaining == 0 { break; }
            let q = (o.qty as u64).min(remaining);
            let s = &mut l.slots[o.agent as usize];
            require!(s.goods[g] as u64 >= q, EconErr::InsufficientGoods);
            s.goods[g] -= q as u32;
            s.cash = s.cash.saturating_add(q * price);
            remaining -= q;
        }

        l.last_price[g] = price;
        emit!(Cleared { good, price, volume, epoch: l.epoch });
        Ok(())
    }
}

// ---------------------------------------------------------------- accounts

#[account(zero_copy)]
#[repr(C)]
pub struct Ledger {
    pub authority: Pubkey,
    pub num_agents: u32,
    pub epoch: u32,
    pub last_price: [u64; N_GOODS],
    pub slots: [AgentSlot; MAX_AGENTS],
}

#[zero_copy]
#[repr(C)]
#[derive(Default)]
pub struct AgentSlot {
    pub cash: u64,
    pub goods: [u32; N_GOODS],
    pub _pad: u32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct Order {
    pub agent: u16,
    pub qty: u32,
    pub limit: u32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct Harvest {
    pub agent: u16,
    pub good: u8,
    pub qty: u32,
}

#[event]
pub struct Cleared {
    pub good: u8,
    pub price: u64,
    pub volume: u64,
    pub epoch: u32,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + std::mem::size_of::<Ledger>())]
    pub ledger: AccountLoader<'info, Ledger>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Mutate<'info> {
    #[account(mut)]
    pub ledger: AccountLoader<'info, Ledger>,
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
}
