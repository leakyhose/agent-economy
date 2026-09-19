//! registry — who exists, and who owns what.
//!
//! Two account families, both PDAs, both world-agnostic:
//!
//!   * `AgentIdentity` — one thin account per simulated agent, so a block explorer
//!     shows a real, addressable account for every inhabitant of a world.
//!   * `AssetRecord`   — one account per indivisible asset for any asset class a
//!     world declares with `ownership: "pda_record"`.
//!
//! The program knows nothing about what a world contains. `entity_type` and
//! `asset_class` are 16-byte labels the world file supplies; this program copies
//! them, indexes by them, and never branches on their contents. A kingdom's
//! "land_parcel" and a sandbox's "widget" are the same code path.
//!
//! The identity PDAs are not decoration. `mint_asset`, `transfer_asset` and
//! `update_reputation` all *read* them: an asset can only be minted to, or
//! transferred to, an agent that has been registered in the same world, and
//! reputation can only be moved by another registered agent of that world.

use anchor_lang::prelude::*;

declare_id!("HvTb4oPkqCnhvvNH7jcacbUVk4rmRrs5jDfXEXtr1KsK");

/// Length of a world-declared label (entity type, asset class). Labels are
/// zero-padded UTF-8; the program treats them as opaque bytes.
pub const LABEL_LEN: usize = 16;

pub const AGENT_SEED: &[u8] = b"agent";
pub const ASSET_SEED: &[u8] = b"asset";

#[program]
pub mod registry {
    use super::*;

    /// Give an agent a real on-chain account.
    ///
    /// `world` is the world's identifier (a 32-byte id the host derives from the
    /// world file, stable across runs). `index` is the agent's index within that
    /// world's population. Together they seed the PDA, so re-registering the same
    /// agent fails at account creation — a world cannot be double-populated.
    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        world: Pubkey,
        index: u16,
        entity_type: [u8; LABEL_LEN],
        wallet: Pubkey,
    ) -> Result<()> {
        let identity = &mut ctx.accounts.identity;
        identity.world = world;
        identity.index = index;
        identity.wallet = wallet;
        identity.entity_type = entity_type;
        identity.created_slot = Clock::get()?.slot;
        identity.reputation = 0;

        emit!(AgentRegistered { world, index, wallet, entity_type });
        Ok(())
    }

    /// Move an agent's reputation. Reputation is peer-attested: the change must be
    /// signed by the wallet of a *different* agent registered in the same world, so
    /// no agent can simply vote itself trustworthy.
    pub fn update_reputation(ctx: Context<UpdateReputation>, delta: i32) -> Result<()> {
        let attestor = &ctx.accounts.attestor;
        let agent = &mut ctx.accounts.agent;

        require_keys_eq!(attestor.world, agent.world, RegistryErr::WorldMismatch);
        require!(
            attestor.key() != agent.key(),
            RegistryErr::SelfAttestation
        );

        agent.reputation = agent
            .reputation
            .checked_add(delta)
            .ok_or(RegistryErr::ReputationOverflow)?;

        emit!(ReputationUpdated {
            world: agent.world,
            index: agent.index,
            attestor: attestor.index,
            delta,
            reputation: agent.reputation,
        });
        Ok(())
    }

    /// Create the on-chain record for one indivisible asset and vest it in an agent.
    ///
    /// The owner is named by their identity PDA, not by a raw pubkey: an asset
    /// cannot be minted to someone who does not exist in this world.
    pub fn mint_asset(
        ctx: Context<MintAsset>,
        world: Pubkey,
        asset_id: u64,
        asset_class: [u8; LABEL_LEN],
    ) -> Result<()> {
        let owner = &ctx.accounts.owner;
        require_keys_eq!(owner.world, world, RegistryErr::WorldMismatch);

        let asset = &mut ctx.accounts.asset;
        asset.world = world;
        asset.asset_class = asset_class;
        asset.asset_id = asset_id;
        asset.owner = owner.wallet;
        asset.transfers = 0;

        emit!(AssetMinted { world, asset_id, asset_class, owner: owner.wallet });
        Ok(())
    }

    /// Hand an asset to another agent. Only the current owner's wallet can do this:
    /// ownership is enforced by the program, not by whoever is driving the client.
    pub fn transfer_asset(ctx: Context<TransferAsset>) -> Result<()> {
        let new_owner = &ctx.accounts.new_owner;
        let asset = &mut ctx.accounts.asset;

        require_keys_eq!(new_owner.world, asset.world, RegistryErr::WorldMismatch);
        require_keys_eq!(
            asset.owner,
            ctx.accounts.current_owner.key(),
            RegistryErr::NotOwner
        );
        // A no-op transfer would silently inflate the transfer count.
        // Reject it rather than record a move that never happened.
        require!(
            new_owner.wallet != asset.owner,
            RegistryErr::TransferToSelf
        );

        let from = asset.owner;
        asset.owner = new_owner.wallet;
        asset.transfers = asset.transfers.saturating_add(1);

        emit!(AssetTransferred {
            world: asset.world,
            asset_id: asset.asset_id,
            asset_class: asset.asset_class,
            from,
            to: asset.owner,
            transfers: asset.transfers,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------- accounts

/// One per agent. Deliberately thin: an explorer-visible anchor point that other
/// instructions resolve against, not a mirror of simulation state.
#[account]
pub struct AgentIdentity {
    pub world: Pubkey,
    pub index: u16,
    /// The agent's real keypair address — the wallet that signs for it.
    pub wallet: Pubkey,
    /// World-declared entity type name, zero-padded. Data, never a branch.
    pub entity_type: [u8; LABEL_LEN],
    pub created_slot: u64,
    pub reputation: i32,
}

impl AgentIdentity {
    pub const LEN: usize = 8 + 32 + 2 + 32 + LABEL_LEN + 8 + 4;
}

/// One per indivisible asset of a `pda_record` asset class.
#[account]
pub struct AssetRecord {
    pub world: Pubkey,
    /// World-declared asset class name, zero-padded. Data, never a branch.
    pub asset_class: [u8; LABEL_LEN],
    pub asset_id: u64,
    /// An agent wallet. Always the `wallet` of some `AgentIdentity` in this world.
    pub owner: Pubkey,
    pub transfers: u32,
}

impl AssetRecord {
    pub const LEN: usize = 8 + 32 + LABEL_LEN + 8 + 32 + 4;
}

// ---------------------------------------------------------------- contexts

#[derive(Accounts)]
#[instruction(world: Pubkey, index: u16)]
pub struct RegisterAgent<'info> {
    #[account(
        init,
        payer = payer,
        space = AgentIdentity::LEN,
        seeds = [AGENT_SEED, world.as_ref(), &index.to_le_bytes()],
        bump,
    )]
    pub identity: Account<'info, AgentIdentity>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateReputation<'info> {
    #[account(
        mut,
        seeds = [AGENT_SEED, agent.world.as_ref(), &agent.index.to_le_bytes()],
        bump,
    )]
    pub agent: Account<'info, AgentIdentity>,
    #[account(
        seeds = [AGENT_SEED, attestor.world.as_ref(), &attestor.index.to_le_bytes()],
        bump,
        has_one = wallet @ RegistryErr::NotAttestorWallet,
    )]
    pub attestor: Account<'info, AgentIdentity>,
    /// The attestor's own key must sign. `has_one` above ties it to the PDA.
    pub wallet: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(world: Pubkey, asset_id: u64)]
pub struct MintAsset<'info> {
    #[account(
        init,
        payer = payer,
        space = AssetRecord::LEN,
        seeds = [ASSET_SEED, world.as_ref(), &asset_id.to_le_bytes()],
        bump,
    )]
    pub asset: Account<'info, AssetRecord>,
    /// The agent receiving the asset, proven to exist by its identity PDA.
    #[account(
        seeds = [AGENT_SEED, owner.world.as_ref(), &owner.index.to_le_bytes()],
        bump,
    )]
    pub owner: Account<'info, AgentIdentity>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TransferAsset<'info> {
    #[account(
        mut,
        seeds = [ASSET_SEED, asset.world.as_ref(), &asset.asset_id.to_le_bytes()],
        bump,
    )]
    pub asset: Account<'info, AssetRecord>,
    /// Must be the wallet currently recorded as owner. This is the whole point.
    pub current_owner: Signer<'info>,
    #[account(
        seeds = [AGENT_SEED, new_owner.world.as_ref(), &new_owner.index.to_le_bytes()],
        bump,
    )]
    pub new_owner: Account<'info, AgentIdentity>,
}

// ---------------------------------------------------------------- events

#[event]
pub struct AgentRegistered {
    pub world: Pubkey,
    pub index: u16,
    pub wallet: Pubkey,
    pub entity_type: [u8; LABEL_LEN],
}

#[event]
pub struct ReputationUpdated {
    pub world: Pubkey,
    pub index: u16,
    pub attestor: u16,
    pub delta: i32,
    pub reputation: i32,
}

#[event]
pub struct AssetMinted {
    pub world: Pubkey,
    pub asset_id: u64,
    pub asset_class: [u8; LABEL_LEN],
    pub owner: Pubkey,
}

#[event]
pub struct AssetTransferred {
    pub world: Pubkey,
    pub asset_id: u64,
    pub asset_class: [u8; LABEL_LEN],
    pub from: Pubkey,
    pub to: Pubkey,
    pub transfers: u32,
}

// ---------------------------------------------------------------- errors

#[error_code]
pub enum RegistryErr {
    #[msg("account belongs to a different world")]
    WorldMismatch,
    #[msg("only the current owner may transfer this asset")]
    NotOwner,
    #[msg("an agent cannot attest to its own reputation")]
    SelfAttestation,
    #[msg("signer is not the attesting agent's wallet")]
    NotAttestorWallet,
    #[msg("reputation would overflow")]
    ReputationOverflow,
    #[msg("asset is already owned by that agent")]
    TransferToSelf,
}
