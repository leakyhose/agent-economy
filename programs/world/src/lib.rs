//! Agentic World — one generic ledger, on Solana.
//!
//! The simulation (agent minds, time, rules, visibility) runs off-chain. What lives
//! here is the part that must not be forgeable: who owns what, and the market that
//! turns orders into a price.
//!
//! The program knows nothing about any particular world. A world declares its
//! on-chain resources in its JSON definition; the client maps those to *good
//! indices* and the program just moves integers around. `Economic Sandbox`
//! (SOL/food/wood/tools) and `Medieval Kingdom` (gold/food/wood/iron/land) are the
//! same program with a different `num_goods`.
//!
//! # Good index 0 is the world's currency
//!
//! Index 0 is whatever the world calls money — `SOL` in one world, `gold` in the
//! other — and it is stored in [`AgentSlot::cash`] as a `u64`. Indices `1..num_goods`
//! are ordinary goods, stored as `u32` in [`AgentSlot::goods`]. `goods[0]` is unused
//! and is required to stay zero; it costs nothing, because the slot pads to 40 bytes
//! either way, and it keeps on-chain good indices identical to the world file's
//! resource ordering instead of off-by-one from it.
//!
//! # Conservation of cash is structural, not audited
//!
//! A world's population is not uniform — a Medieval Kingdom peasant starts with 800
//! gold and its treasury with 50,000 — so the ledger has a **genesis phase**. While
//! `sealed == 0` the authority may `endow` any agent with any balance. `seal` closes
//! that door permanently, and every other write instruction refuses to run until it
//! has been closed. After sealing:
//!
//! `settle` — the instruction the server drives every tick — **cannot touch cash at
//! all**. It moves goods only. Cash moves by exactly two paths, `transfer` and
//! `clear_auction`, and both are zero-sum by construction: every coin debited is
//! credited somewhere else in the same instruction. `clear_auction` additionally
//! re-totals the whole ledger before and after and rejects itself if the sums differ.
//!
//! So the server can lie about how many fish were caught, and the chain will believe
//! it — but once `sealed` is set there is no instruction in this program that creates
//! a coin, and `sealed` is a byte anyone can read off the account. That is the claim
//! worth making, and it is checkable on a block explorer rather than asserted in
//! slides.

use anchor_lang::prelude::*;

declare_id!("1SftM8VJKJTbgPprbpjAfhJXLAUSWqgPaX1tscwtk6D");

/// Ledger capacity. Worlds populate fewer; `num_agents` is the live count.
pub const MAX_AGENTS: usize = 320;
/// Good-index capacity, including the currency at index 0. `num_goods` is runtime.
pub const MAX_GOODS: usize = 8;

/// `8` discriminator + [`Ledger`]. 12,920 bytes — deliberately over Anchor's 10,240
/// `init` ceiling, so the client allocates the account with `SystemProgram.createAccount`
/// and `initialize` takes it via the `zero` constraint. See [`Initialize`].
pub const LEDGER_SIZE: usize = 8 + core::mem::size_of::<Ledger>();

#[program]
pub mod world {
    use super::*;

    /// Create a ledger for one world and endow every agent.
    ///
    /// `start_goods[0]` is ignored — good 0 is cash, and it comes from `start_cash`.
    pub fn initialize(
        ctx: Context<Initialize>,
        num_agents: u32,
        num_goods: u8,
        start_cash: u64,
        start_goods: [u32; MAX_GOODS],
    ) -> Result<()> {
        require!(num_agents as usize <= MAX_AGENTS, WorldErr::TooManyAgents);
        require!(num_goods as usize <= MAX_GOODS, WorldErr::TooManyGoods);
        require!(num_goods >= 1, WorldErr::TooManyGoods);

        let mut l = ctx.accounts.ledger.load_init()?;
        l.authority = ctx.accounts.authority.key();
        l.num_agents = num_agents;
        l.num_goods = num_goods;
        l.round = 0;
        l.last_price = [0u64; MAX_GOODS];
        for i in 0..num_agents as usize {
            l.slots[i].cash = start_cash;
            l.slots[i].goods = start_goods;
            // Good 0 lives in `cash`; its slot in the array stays zero.
            l.slots[i].goods[0] = 0;
        }
        emit!(Initialized {
            authority: l.authority,
            num_agents,
            num_goods,
            start_cash,
        });
        Ok(())
    }

    /// Genesis only: set absolute balances, so a world can start with peasants and
    /// kings rather than 320 identical agents.
    ///
    /// `good == 0` sets cash; anything else sets that good. This is the only
    /// instruction in the program that can create value, and [`seal`](seal) takes it
    /// away for good.
    pub fn endow(ctx: Context<Write>, entries: Vec<Endowment>) -> Result<()> {
        let mut l = ctx.accounts.load_checked()?;
        require!(l.sealed == 0, WorldErr::GenesisSealed);
        apply_endowments(&mut l, &entries)
    }

    /// Close genesis, permanently. There is no instruction that unsets this.
    pub fn seal(ctx: Context<Write>) -> Result<()> {
        let mut l = ctx.accounts.load_checked()?;
        require!(l.sealed == 0, WorldErr::GenesisSealed);
        l.sealed = 1;
        emit!(SealedGenesis { money_supply: total_cash(&l) as u64 });
        Ok(())
    }

    /// Apply what the world did this tick: harvests, crafting, spoilage, consumption.
    ///
    /// Signed deltas against agent goods. Nothing may go negative, and the whole
    /// transaction is rejected if any single delta would take a balance below zero —
    /// a partial settlement is worse than none, because the off-chain mirror would
    /// silently diverge.
    ///
    /// Good 0 (cash) is not settleable. See the module docs.
    pub fn settle(ctx: Context<Write>, deltas: Vec<Delta>) -> Result<()> {
        let mut l = ctx.accounts.load_checked()?;
        require!(l.sealed == 1, WorldErr::GenesisOpen);
        apply_deltas(&mut l, &deltas)
    }

    /// Move cash between two agents. Backs the world DSL's `settle` effect.
    pub fn transfer(ctx: Context<Write>, from: u16, to: u16, amount: u64) -> Result<()> {
        let mut l = ctx.accounts.load_checked()?;
        require!(l.sealed == 1, WorldErr::GenesisOpen);
        apply_transfer(&mut l, from, to, amount)?;
        emit!(Transferred { from, to, amount });
        Ok(())
    }

    /// Clear one good's market as a uniform-price batch auction.
    ///
    /// `bids` arrive sorted by limit DESCENDING and `asks` ASCENDING. The program does
    /// not sort — sorting hundreds of orders on-chain blows the compute budget — it
    /// *verifies* the ordering in a single O(n) pass, which is cheap and is still a
    /// real invariant that a lying client trips over. Then it walks the two ladders
    /// inward until they stop crossing and settles every fill at one price.
    ///
    /// This mirrors the off-chain batch auction in `@aw/engine`; the TypeScript
    /// mirror in `@aw/solana` (`clearAuction`) is line-for-line the same algorithm so
    /// the two can be diffed on the same order set.
    pub fn clear_auction(
        ctx: Context<Write>,
        good: u8,
        bids: Vec<Order>,
        asks: Vec<Order>,
    ) -> Result<()> {
        let mut l = ctx.accounts.load_checked()?;
        require!(l.sealed == 1, WorldErr::GenesisOpen);
        let out = apply_auction(&mut l, good, &bids, &asks)?;
        emit!(Cleared {
            good,
            price: out.price,
            volume: out.volume,
            round: l.round,
        });
        Ok(())
    }
}

// ------------------------------------------------------------------ core logic
//
// The instruction handlers above are thin. Everything below is plain Rust over a
// plain struct, which is what `cargo test` exercises — no validator, no SBF build,
// so the auction math and the invariants are testable in milliseconds.

/// What an auction did. `price == 0 && volume == 0` means nothing crossed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AuctionOutcome {
    pub price: u64,
    pub volume: u64,
}

/// Read good `g` for `slot` in a single number space, cash included.
pub fn holding(slot: &AgentSlot, g: usize) -> u64 {
    if g == 0 {
        slot.cash
    } else {
        slot.goods[g] as u64
    }
}

/// Total cash across the live agents. Used to prove `clear_auction` is zero-sum.
pub fn total_cash(l: &Ledger) -> u128 {
    let mut sum = 0u128;
    for i in 0..l.num_agents as usize {
        sum += l.slots[i].cash as u128;
    }
    sum
}

/// Signed goods deltas. All-or-nothing: any underflow rejects the batch.
///
/// As with [`apply_auction`], an `Err` leaves the in-memory ledger partly written and
/// the caller must discard it; the runtime does this for us on chain.
pub fn apply_deltas(l: &mut Ledger, deltas: &[Delta]) -> Result<()> {
    let n = l.num_agents;
    let ng = l.num_goods as usize;
    for d in deltas.iter() {
        require!((d.agent as u32) < n, WorldErr::BadAgent);
        let g = d.good as usize;
        require!(g < ng, WorldErr::BadGood);
        require!(g != 0, WorldErr::CurrencyNotSettleable);
        let v = &mut l.slots[d.agent as usize].goods[g];
        let next = (*v as i64) + (d.delta as i64);
        require!(next >= 0, WorldErr::InsufficientGoods);
        require!(next <= u32::MAX as i64, WorldErr::Overflow);
        *v = next as u32;
    }
    Ok(())
}

/// Genesis endowments: absolute balances, not deltas. Callers must have checked that
/// the ledger is unsealed.
pub fn apply_endowments(l: &mut Ledger, entries: &[Endowment]) -> Result<()> {
    let n = l.num_agents;
    let ng = l.num_goods as usize;
    for e in entries.iter() {
        require!((e.agent as u32) < n, WorldErr::BadAgent);
        let g = e.good as usize;
        require!(g < ng, WorldErr::BadGood);
        if g == 0 {
            l.slots[e.agent as usize].cash = e.amount;
        } else {
            require!(e.amount <= u32::MAX as u64, WorldErr::Overflow);
            l.slots[e.agent as usize].goods[g] = e.amount as u32;
        }
    }
    Ok(())
}

/// Zero-sum cash movement between two live agents.
pub fn apply_transfer(l: &mut Ledger, from: u16, to: u16, amount: u64) -> Result<()> {
    let n = l.num_agents;
    require!((from as u32) < n, WorldErr::BadAgent);
    require!((to as u32) < n, WorldErr::BadAgent);
    require!(from != to, WorldErr::SelfTransfer);
    let src = l.slots[from as usize].cash;
    require!(src >= amount, WorldErr::InsufficientCash);
    let dst = l.slots[to as usize]
        .cash
        .checked_add(amount)
        .ok_or(WorldErr::Overflow)?;
    l.slots[from as usize].cash = src - amount;
    l.slots[to as usize].cash = dst;
    Ok(())
}

/// The clearing rule, with no ledger attached: walk the crossed ladders inward and
/// take the midpoint of the marginal bid and ask as the single price everyone pays.
///
/// Both halves of the crossing region trade in full, so `volume` is the largest
/// quantity at which demand and supply both stand. Returns `None` when nothing
/// crosses. Assumes the sortedness that [`apply_auction`] verifies.
pub fn compute_clearing(bids: &[Order], asks: &[Order]) -> Option<AuctionOutcome> {
    if bids.is_empty() || asks.is_empty() {
        return None;
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
            if i < bids.len() {
                bid_rem = bids[i].qty;
            }
        }
        if ask_rem == 0 {
            j += 1;
            if j < asks.len() {
                ask_rem = asks[j].qty;
            }
        }
    }
    if volume == 0 {
        return None;
    }
    // `last_bid >= last_ask`, so the midpoint is individually rational for both
    // sides of every fill: no buyer pays above its limit, no seller sells below its.
    let price = ((last_bid as u64 + last_ask as u64) / 2).max(1);
    Some(AuctionOutcome { price, volume })
}

/// Verify sortedness, clear, and settle the fills against the ledger.
///
/// **On `Err`, the ledger may be left partly mutated.** On-chain that is harmless and
/// invisible: a failed instruction aborts the transaction and the account write is
/// discarded. Anything reusing this off-chain must treat an `Err` as "throw this copy
/// of the ledger away", exactly as the runtime does.
pub fn apply_auction(
    l: &mut Ledger,
    good: u8,
    bids: &[Order],
    asks: &[Order],
) -> Result<AuctionOutcome> {
    let g = good as usize;
    require!(g < l.num_goods as usize, WorldErr::BadGood);
    require!(g != 0, WorldErr::CurrencyNotTradeable);
    let n = l.num_agents;

    // O(n), one pass each. Cheap enough to be free, strict enough to be an invariant.
    for w in bids.windows(2) {
        require!(w[0].limit >= w[1].limit, WorldErr::BidsNotSorted);
    }
    for w in asks.windows(2) {
        require!(w[0].limit <= w[1].limit, WorldErr::AsksNotSorted);
    }
    for o in bids.iter().chain(asks.iter()) {
        require!((o.agent as u32) < n, WorldErr::BadAgent);
    }

    l.round += 1;

    let Some(out) = compute_clearing(bids, asks) else {
        return Ok(AuctionOutcome {
            price: l.last_price[g],
            volume: 0,
        });
    };

    let before = total_cash(l);

    // Buyers: the top `volume` units of demand, in limit order, all at `out.price`.
    let mut remaining = out.volume;
    for o in bids.iter() {
        if remaining == 0 {
            break;
        }
        let q = (o.qty as u64).min(remaining);
        let cost = q.checked_mul(out.price).ok_or(WorldErr::Overflow)?;
        let s = &mut l.slots[o.agent as usize];
        require!(s.cash >= cost, WorldErr::InsufficientCash);
        let held = (s.goods[g] as u64)
            .checked_add(q)
            .ok_or(WorldErr::Overflow)?;
        require!(held <= u32::MAX as u64, WorldErr::Overflow);
        s.cash -= cost;
        s.goods[g] = held as u32;
        remaining -= q;
    }

    // Sellers: the bottom `volume` units of supply, same price.
    let mut remaining = out.volume;
    for o in asks.iter() {
        if remaining == 0 {
            break;
        }
        let q = (o.qty as u64).min(remaining);
        let proceeds = q.checked_mul(out.price).ok_or(WorldErr::Overflow)?;
        let s = &mut l.slots[o.agent as usize];
        require!(s.goods[g] as u64 >= q, WorldErr::InsufficientGoods);
        s.cash = s.cash.checked_add(proceeds).ok_or(WorldErr::Overflow)?;
        s.goods[g] -= q as u32;
        remaining -= q;
    }

    // Belt and braces over the structural argument: the same quantity was bought as
    // was sold, at one price, so the two loops must have moved equal and opposite
    // cash. If they did not, something is wrong with this program and the safe move
    // is to refuse the transaction rather than write the discrepancy down forever.
    require!(total_cash(l) == before, WorldErr::CashNotConserved);

    l.last_price[g] = out.price;
    Ok(out)
}

// ---------------------------------------------------------------- accounts

/// One world's entire economy. Zero-copy: 12,912 bytes is far past what Borsh
/// deserialization would survive on a 4 KiB stack.
#[account(zero_copy)]
#[repr(C)]
pub struct Ledger {
    /// The only key allowed to write. The simulation server.
    pub authority: Pubkey,
    /// Last clearing price per good index. Index 0 unused.
    pub last_price: [u64; MAX_GOODS],
    pub num_agents: u32,
    pub round: u32,
    /// Live good count, including the currency at index 0.
    pub num_goods: u8,
    /// `0` while genesis is open, `1` once closed. One-way.
    pub sealed: u8,
    pub _pad: [u8; 6],
    pub slots: [AgentSlot; MAX_AGENTS],
}

/// 40 bytes. `goods[0]` is unused — good 0 is `cash`.
#[zero_copy]
#[repr(C)]
#[derive(Default)]
pub struct AgentSlot {
    pub cash: u64,
    pub goods: [u32; MAX_GOODS],
}

/// 10 bytes on the wire. An order book of these is what the 1,232-byte legacy
/// transaction budget gets spent on, which is why the client caps orders per tx.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Order {
    pub agent: u16,
    pub qty: u32,
    pub limit: u32,
}

/// 11 bytes on the wire. `good == 0` means cash.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Endowment {
    pub agent: u16,
    pub good: u8,
    pub amount: u64,
}

/// 7 bytes on the wire.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Delta {
    pub agent: u16,
    pub good: u8,
    pub delta: i32,
}

#[event]
pub struct Initialized {
    pub authority: Pubkey,
    pub num_agents: u32,
    pub num_goods: u8,
    pub start_cash: u64,
}

#[event]
pub struct SealedGenesis {
    pub money_supply: u64,
}

#[event]
pub struct Cleared {
    pub good: u8,
    pub price: u64,
    pub volume: u64,
    pub round: u32,
}

#[event]
pub struct Transferred {
    pub from: u16,
    pub to: u16,
    pub amount: u64,
}

/// The ledger is bigger than Anchor's `init` can allocate (a program may only grow an
/// account by 10,240 bytes via CPI), so the client pre-creates it with
/// `SystemProgram.createAccount` in the same transaction and hands it over
/// zero-initialised. `zero` checks it is owned by us, correctly sized, and unwritten.
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(zero)]
    pub ledger: AccountLoader<'info, Ledger>,
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
        require_keys_eq!(l.authority, self.authority.key(), WorldErr::Unauthorized);
        Ok(l)
    }
}

#[error_code]
pub enum WorldErr {
    #[msg("too many agents for this ledger")]
    TooManyAgents,
    #[msg("num_goods must be between 1 and MAX_GOODS")]
    TooManyGoods,
    #[msg("agent index out of range")]
    BadAgent,
    #[msg("good index out of range")]
    BadGood,
    #[msg("good 0 is the world currency and cannot be settled as a delta")]
    CurrencyNotSettleable,
    #[msg("good 0 is the world currency and has no market against itself")]
    CurrencyNotTradeable,
    #[msg("bids must be sorted by limit descending")]
    BidsNotSorted,
    #[msg("asks must be sorted by limit ascending")]
    AsksNotSorted,
    #[msg("agent cannot afford this fill")]
    InsufficientCash,
    #[msg("agent does not hold enough of this good")]
    InsufficientGoods,
    #[msg("cannot transfer to self")]
    SelfTransfer,
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("cash was created or destroyed; refusing to write")]
    CashNotConserved,
    #[msg("only the ledger authority may write to it")]
    Unauthorized,
    #[msg("genesis is sealed; no instruction can create value any more")]
    GenesisSealed,
    #[msg("genesis is still open; seal the ledger before running the world")]
    GenesisOpen,
}

// -------------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    fn ledger(num_agents: u32, num_goods: u8, cash: u64, goods: u32) -> Box<Ledger> {
        let mut l: Box<Ledger> = Box::new(unsafe { std::mem::zeroed() });
        l.num_agents = num_agents;
        l.num_goods = num_goods;
        for i in 0..num_agents as usize {
            l.slots[i].cash = cash;
            for g in 1..num_goods as usize {
                l.slots[i].goods[g] = goods;
            }
        }
        l
    }

    fn order(agent: u16, qty: u32, limit: u32) -> Order {
        Order { agent, qty, limit }
    }

    fn err_of(e: Error) -> u32 {
        match e {
            Error::AnchorError(a) => a.error_code_number,
            _ => panic!("expected an AnchorError, got {e:?}"),
        }
    }

    fn code(e: WorldErr) -> u32 {
        e as u32 + anchor_lang::error::ERROR_CODE_OFFSET
    }

    // --- the account actually fits the shape we claim -----------------------

    #[test]
    fn layout_is_what_the_client_decodes() {
        assert_eq!(core::mem::size_of::<AgentSlot>(), 40);
        assert_eq!(core::mem::size_of::<Ledger>(), 112 + 320 * 40);
        assert_eq!(LEDGER_SIZE, 12_920);
        // Past Anchor's `init` ceiling on purpose; the client allocates it.
        assert!(LEDGER_SIZE > 10_240);
    }

    // --- auction math -------------------------------------------------------

    #[test]
    fn uniform_price_is_the_marginal_midpoint() {
        // Demand 10 @ >=100, supply 10 @ <=90. Everything crosses at one price.
        let bids = [order(0, 10, 100)];
        let asks = [order(1, 10, 90)];
        let out = compute_clearing(&bids, &asks).unwrap();
        assert_eq!(out, AuctionOutcome { price: 95, volume: 10 });
    }

    #[test]
    fn volume_stops_where_the_ladders_stop_crossing() {
        // 6 units cross (5 @120 + 1 of the 8 @110 against 6 @100); the 110/130 pair
        // is the marginal one, so volume is capped by supply at that rung.
        let bids = [order(0, 5, 120), order(1, 8, 110), order(2, 4, 50)];
        let asks = [order(3, 6, 100), order(4, 9, 130)];
        let out = compute_clearing(&bids, &asks).unwrap();
        assert_eq!(out.volume, 6);
        assert_eq!(out.price, (110 + 100) / 2);
    }

    #[test]
    fn no_cross_means_no_trade() {
        let bids = [order(0, 5, 50)];
        let asks = [order(1, 5, 80)];
        assert!(compute_clearing(&bids, &asks).is_none());
        assert!(compute_clearing(&[], &asks).is_none());
        assert!(compute_clearing(&bids, &[]).is_none());
    }

    #[test]
    fn every_fill_is_individually_rational() {
        let bids = [order(0, 3, 500), order(1, 7, 410), order(2, 2, 400)];
        let asks = [order(3, 4, 300), order(4, 6, 395), order(5, 5, 600)];
        let out = compute_clearing(&bids, &asks).unwrap();
        // Walk the same prefix the settlement loops fill and check limits hold.
        let mut rem = out.volume;
        for o in bids.iter() {
            if rem == 0 {
                break;
            }
            assert!(o.limit as u64 >= out.price, "buyer paid above its limit");
            rem -= (o.qty as u64).min(rem);
        }
        let mut rem = out.volume;
        for o in asks.iter() {
            if rem == 0 {
                break;
            }
            assert!(o.limit as u64 <= out.price, "seller sold below its limit");
            rem -= (o.qty as u64).min(rem);
        }
    }

    #[test]
    fn clearing_moves_goods_and_cash_the_right_way() {
        let mut l = ledger(4, 3, 10_000, 20);
        // agent 0 buys 5 @<=100, agent 1 sells 5 @>=90 -> 5 units at 95.
        let out = apply_auction(&mut l, 1, &[order(0, 5, 100)], &[order(1, 5, 90)]).unwrap();
        assert_eq!(out, AuctionOutcome { price: 95, volume: 5 });
        assert_eq!(l.slots[0].cash, 10_000 - 5 * 95);
        assert_eq!(l.slots[0].goods[1], 25);
        assert_eq!(l.slots[1].cash, 10_000 + 5 * 95);
        assert_eq!(l.slots[1].goods[1], 15);
        assert_eq!(l.last_price[1], 95);
        assert_eq!(l.round, 1);
    }

    #[test]
    fn a_round_with_no_cross_still_counts_and_leaves_balances_alone() {
        let mut l = ledger(4, 3, 10_000, 20);
        let out = apply_auction(&mut l, 1, &[order(0, 5, 10)], &[order(1, 5, 900)]).unwrap();
        assert_eq!(out.volume, 0);
        assert_eq!(l.round, 1);
        assert_eq!(l.slots[0].cash, 10_000);
        assert_eq!(l.slots[1].goods[1], 20);
    }

    // --- sortedness ---------------------------------------------------------

    #[test]
    fn unsorted_bids_are_rejected() {
        let mut l = ledger(4, 3, 10_000, 20);
        let e = apply_auction(
            &mut l,
            1,
            &[order(0, 1, 50), order(1, 1, 90)], // ascending: wrong way round
            &[order(2, 2, 10)],
        )
        .unwrap_err();
        assert_eq!(err_of(e), code(WorldErr::BidsNotSorted));
    }

    #[test]
    fn unsorted_asks_are_rejected() {
        let mut l = ledger(4, 3, 10_000, 20);
        let e = apply_auction(
            &mut l,
            1,
            &[order(0, 2, 90)],
            &[order(1, 1, 80), order(2, 1, 10)], // descending: wrong way round
        )
        .unwrap_err();
        assert_eq!(err_of(e), code(WorldErr::AsksNotSorted));
    }

    #[test]
    fn equal_limits_are_sorted() {
        let mut l = ledger(4, 3, 10_000, 20);
        apply_auction(
            &mut l,
            1,
            &[order(0, 1, 90), order(1, 1, 90)],
            &[order(2, 1, 50), order(3, 1, 50)],
        )
        .expect("ties are not a sortedness violation");
    }

    #[test]
    fn an_order_from_an_agent_that_does_not_exist_is_rejected() {
        let mut l = ledger(4, 3, 10_000, 20);
        let e = apply_auction(&mut l, 1, &[order(99, 1, 90)], &[order(1, 1, 50)]).unwrap_err();
        assert_eq!(err_of(e), code(WorldErr::BadAgent));
    }

    #[test]
    fn there_is_no_market_in_the_currency_against_itself() {
        let mut l = ledger(4, 3, 10_000, 20);
        let e = apply_auction(&mut l, 0, &[order(0, 1, 90)], &[order(1, 1, 50)]).unwrap_err();
        assert_eq!(err_of(e), code(WorldErr::CurrencyNotTradeable));
    }

    #[test]
    fn a_good_the_world_did_not_declare_is_rejected() {
        let mut l = ledger(4, 3, 10_000, 20); // num_goods = 3 -> indices 0,1,2
        let e = apply_auction(&mut l, 5, &[], &[]).unwrap_err();
        assert_eq!(err_of(e), code(WorldErr::BadGood));
    }

    // --- settle: nothing may go negative -----------------------------------

    #[test]
    fn deltas_apply_in_both_directions() {
        let mut l = ledger(4, 4, 1_000, 10);
        apply_deltas(
            &mut l,
            &[
                Delta { agent: 0, good: 1, delta: 5 },
                Delta { agent: 0, good: 2, delta: -4 },
                Delta { agent: 3, good: 3, delta: -10 },
            ],
        )
        .unwrap();
        assert_eq!(l.slots[0].goods[1], 15);
        assert_eq!(l.slots[0].goods[2], 6);
        assert_eq!(l.slots[3].goods[3], 0);
    }

    #[test]
    fn a_delta_that_would_go_negative_rejects_the_whole_batch() {
        let mut l = ledger(4, 4, 1_000, 10);
        let e = apply_deltas(
            &mut l,
            &[
                Delta { agent: 0, good: 1, delta: 5 },   // fine on its own
                Delta { agent: 1, good: 2, delta: -11 }, // one too far
            ],
        )
        .unwrap_err();
        assert_eq!(err_of(e), code(WorldErr::InsufficientGoods));
        // All-or-nothing: the caller must not be able to bank the good half. The
        // instruction aborts, so the account write never lands on chain. In-memory
        // the first delta did apply, which is exactly why the handler returns Err
        // rather than reporting a partial result.
    }

    #[test]
    fn settle_cannot_touch_the_currency() {
        let mut l = ledger(4, 4, 1_000, 10);
        let e = apply_deltas(&mut l, &[Delta { agent: 0, good: 0, delta: 1_000_000 }]).unwrap_err();
        assert_eq!(err_of(e), code(WorldErr::CurrencyNotSettleable));
        assert_eq!(l.slots[0].cash, 1_000);
    }

    #[test]
    fn settle_rejects_an_agent_out_of_range() {
        let mut l = ledger(4, 4, 1_000, 10);
        let e = apply_deltas(&mut l, &[Delta { agent: 4, good: 1, delta: 1 }]).unwrap_err();
        assert_eq!(err_of(e), code(WorldErr::BadAgent));
    }

    // --- conservation of cash ----------------------------------------------

    #[test]
    fn transfer_conserves_cash() {
        let mut l = ledger(8, 3, 1_000, 5);
        let before = total_cash(&l);
        apply_transfer(&mut l, 2, 5, 400).unwrap();
        assert_eq!(l.slots[2].cash, 600);
        assert_eq!(l.slots[5].cash, 1_400);
        assert_eq!(total_cash(&l), before);
    }

    #[test]
    fn transfer_cannot_overdraw() {
        let mut l = ledger(8, 3, 1_000, 5);
        let before = total_cash(&l);
        let e = apply_transfer(&mut l, 2, 5, 1_001).unwrap_err();
        assert_eq!(err_of(e), code(WorldErr::InsufficientCash));
        assert_eq!(total_cash(&l), before);
    }

    #[test]
    fn an_auction_creates_no_cash_however_lopsided() {
        let mut l = ledger(16, 4, 50_000, 40);
        let before = total_cash(&l);
        let bids: Vec<Order> = (0..8).map(|k| order(k, 3 + k as u32, 900 - 50 * k as u32)).collect();
        let asks: Vec<Order> = (8..16).map(|k| order(k, 2 + k as u32, 100 + 40 * k as u32)).collect();
        let out = apply_auction(&mut l, 2, &bids, &asks).unwrap();
        assert!(out.volume > 0, "the fixture must actually trade");
        assert_eq!(total_cash(&l), before, "cash was created or destroyed");
    }

    #[test]
    fn goods_are_conserved_too() {
        let mut l = ledger(16, 4, 50_000, 40);
        let total_goods = |l: &Ledger| -> u64 {
            (0..l.num_agents as usize).map(|i| l.slots[i].goods[2] as u64).sum()
        };
        let before = total_goods(&l);
        let bids: Vec<Order> = (0..8).map(|k| order(k, 3 + k as u32, 900 - 50 * k as u32)).collect();
        let asks: Vec<Order> = (8..16).map(|k| order(k, 2 + k as u32, 100 + 40 * k as u32)).collect();
        apply_auction(&mut l, 2, &bids, &asks).unwrap();
        assert_eq!(total_goods(&l), before);
    }

    #[test]
    fn a_thousand_random_rounds_never_move_the_money_supply() {
        // A cheap xorshift keeps this deterministic without pulling in `rand`.
        let mut s: u64 = 0x5eed_1234_9abc_def1;
        let mut next = |m: u32| -> u32 {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            (s % m as u64) as u32
        };
        let mut l = ledger(32, 5, 100_000, 60);
        let before = total_cash(&l);
        let mut cleared = 0;
        for _ in 0..1_000 {
            let good = 1 + next(4) as u8;
            let mut bids: Vec<Order> = (0..8)
                .map(|_| order(next(32) as u16, 1 + next(6), 50 + next(500)))
                .collect();
            let mut asks: Vec<Order> = (0..8)
                .map(|_| order(next(32) as u16, 1 + next(6), 50 + next(500)))
                .collect();
            bids.sort_by(|a, b| b.limit.cmp(&a.limit));
            asks.sort_by(|a, b| a.limit.cmp(&b.limit));
            // Some rounds legitimately fail: a buyer ran out of cash, a seller ran out
            // of stock. Those abort the transaction, so model that here by clearing
            // into a scratch copy and only committing on Ok — which is precisely what
            // the runtime does with the account write.
            let mut scratch = l.clone();
            if apply_auction(&mut scratch, good, &bids, &asks).is_ok() {
                l = scratch;
                cleared += 1;
            }
            assert_eq!(total_cash(&l), before, "the money supply moved");
        }
        assert!(cleared > 50, "the fixture barely traded ({cleared} rounds); test is vacuous");
    }

    #[test]
    fn a_buyer_who_cannot_pay_kills_the_round() {
        let mut l = ledger(4, 3, 10, 20); // 10 cash each, nowhere near enough
        let e = apply_auction(&mut l, 1, &[order(0, 5, 100)], &[order(1, 5, 90)]).unwrap_err();
        assert_eq!(err_of(e), code(WorldErr::InsufficientCash));
    }

    #[test]
    fn a_seller_without_the_goods_kills_the_round() {
        let mut l = ledger(4, 3, 10_000, 2); // only 2 units held, 5 offered
        let e = apply_auction(&mut l, 1, &[order(0, 5, 100)], &[order(1, 5, 90)]).unwrap_err();
        assert_eq!(err_of(e), code(WorldErr::InsufficientGoods));
    }

    // --- genesis ------------------------------------------------------------

    #[test]
    fn endowments_make_a_population_unequal() {
        // Medieval Kingdom: 18 peasants, 4 merchants, 3 nobles, 2 kingdoms.
        let mut l = ledger(27, 5, 800, 4); // initialize() gives everyone a peasant purse
        let entries: Vec<Endowment> = (22..25)
            .map(|a| Endowment { agent: a, good: 0, amount: 20_000 }) // nobles
            .chain((25..27).map(|a| Endowment { agent: a, good: 0, amount: 50_000 })) // kingdoms
            .chain((25..27).map(|a| Endowment { agent: a, good: 4, amount: 20 })) // and their land
            .collect();
        apply_endowments(&mut l, &entries).unwrap();
        assert_eq!(l.slots[0].cash, 800, "peasants keep the uniform endowment");
        assert_eq!(l.slots[23].cash, 20_000);
        assert_eq!(l.slots[26].cash, 50_000);
        assert_eq!(l.slots[26].goods[4], 20);
        assert_eq!(total_cash(&l), 22 * 800 + 3 * 20_000 + 2 * 50_000);
    }

    #[test]
    fn endowments_respect_the_worlds_good_count() {
        let mut l = ledger(4, 3, 100, 1);
        let e = apply_endowments(&mut l, &[Endowment { agent: 0, good: 3, amount: 1 }]).unwrap_err();
        assert_eq!(err_of(e), code(WorldErr::BadGood));
        let e = apply_endowments(&mut l, &[Endowment { agent: 9, good: 1, amount: 1 }]).unwrap_err();
        assert_eq!(err_of(e), code(WorldErr::BadAgent));
    }

    #[test]
    fn a_sealed_byte_is_the_whole_no_printing_claim() {
        // The gate lives in the handlers (they hold the account); what the core owes
        // is that once genesis is over, nothing below can add a coin. `apply_deltas`
        // refuses good 0 outright, and the other two paths are zero-sum.
        let mut l = ledger(8, 3, 1_000, 5);
        l.sealed = 1;
        let supply = total_cash(&l);
        assert!(apply_deltas(&mut l, &[Delta { agent: 0, good: 0, delta: i32::MAX }]).is_err());
        apply_transfer(&mut l, 0, 1, 1_000).unwrap();
        apply_auction(&mut l, 1, &[order(2, 3, 90)], &[order(3, 3, 50)]).unwrap();
        assert_eq!(total_cash(&l), supply);
    }

    // --- generic over worlds ------------------------------------------------

    #[test]
    fn the_same_program_serves_both_shipped_worlds() {
        // Economic Sandbox: SOL, food, wood, tools.
        let mut sandbox = ledger(24, 4, 5_000, 6);
        apply_auction(&mut sandbox, 3, &[order(0, 1, 2_100)], &[order(1, 1, 1_900)]).unwrap();
        assert_eq!(sandbox.last_price[3], 2_000);
        let e = apply_auction(&mut sandbox, 4, &[], &[]).unwrap_err();
        assert_eq!(err_of(e), code(WorldErr::BadGood), "sandbox has no good 4");

        // Medieval Kingdom: gold, food, wood, iron, land. Land clears near 8,000, so
        // this fixture endows nobles' purses (20,000) rather than peasants' (800).
        let mut kingdom = ledger(27, 5, 20_000, 4);
        apply_auction(&mut kingdom, 4, &[order(0, 1, 8_100)], &[order(1, 1, 7_900)]).unwrap();
        assert_eq!(kingdom.last_price[4], 8_000, "land trades in the kingdom");
    }
}
