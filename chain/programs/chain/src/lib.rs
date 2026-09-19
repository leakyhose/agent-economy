//! agent-economy — the village ledger and its market, on Solana.
//!
//! The simulation (agent minds, time, movement) runs off-chain. What lives here is
//! the economy itself: who owns what, and the market that turns orders into a price.
//!
//! Only the ledger's authority (the village server) may write to it. Everything it
//! writes is checked: no balance can go negative, no good can be conjured by a trade,
//! and the market clears at one uniform price for everyone.

use anchor_lang::prelude::*;

declare_id!("9cs35JHZo92yqd8teVHUUi44gLmKuVkc8kYP6pw7RhR7");

pub const MAX_AGENTS: usize = 320;
pub const N_GOODS: usize = 3;
pub const FOOD: usize = 0;
pub const WOOD: usize = 1;
pub const NETS: usize = 2;

#[program]
pub mod chain {
    use super::*;

    /// Create the village ledger and give every agent a starting purse and pantry.
    pub fn initialize(
        ctx: Context<Initialize>,
        num_agents: u32,
        start_cash: u64,
        start_food: u32,
    ) -> Result<()> {
        require!(num_agents as usize <= MAX_AGENTS, EconErr::TooManyAgents);
        let mut l = ctx.accounts.ledger.load_init()?;
        l.authority = ctx.accounts.authority.key();
        l.num_agents = num_agents;
        l.round = 0;
        l.last_price = [500, 300, 2000]; // cents: food, wood, nets
        for i in 0..num_agents as usize {
            l.slots[i].cash = start_cash;
            l.slots[i].goods = [start_food, 0, 0];
        }
        Ok(())
    }

    /// Apply what happened in the world since the last round: catches, wood cut,
    /// meals eaten, nets crafted, nets worn out. Signed deltas; nothing may go negative.
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
        for o in bids.iter().chain(asks.iter()) {
            require!((o.agent as u32) < n, EconErr::BadAgent);
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
        emit!(Cleared { good, price, volume, round: l.round });
        Ok(())
    }
}

// ---------------------------------------------------------------- accounts

#[account(zero_copy)]
#[repr(C)]
pub struct Ledger {
    pub authority: Pubkey,
    pub num_agents: u32,
    pub round: u32,
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
}
