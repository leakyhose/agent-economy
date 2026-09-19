// How a world maps onto Solana. Additive to the core contract: every field here
// is optional, so a world that declares none of it still runs exactly as before.
//
// The simulation layer never reads these types. They are the vocabulary a world
// uses to tell the Solana layer what it wants, so simulation logic stays free of
// blockchain implementation details (brief §1).

import type { ResourceId, EntityTypeId } from './world.ts';

/** How a world resource is represented on chain (brief §13, §14). */
export interface TokenSpec {
  /** Ticker for the SPL mint, e.g. "WORLD", "GOLD", "IRON". */
  symbol: string;
  decimals?: number;
  /** Minted once at genesis. Omit for a supply that only rules can mint. */
  initialSupply?: number;
  /**
   * Revoke mint authority after genesis. A world that sets this cannot inflate:
   * the instruction ceases to exist, which is checkable on any explorer.
   */
  fixedSupply?: boolean;
}

/** Ownership representation for an asset class (brief §15). */
export type OwnershipMode =
  /** Balance in an SPL token account. Fungible: resources, currency. */
  | 'spl_token'
  /** A PDA keyed by asset id. Non-fungible and indivisible: land, a title. */
  | 'pda_record'
  /** Fractional claims on an entity, as balances of a per-entity mint. */
  | 'equity_shares'
  /** Off chain entirely. */
  | 'none';

export interface AssetClassDef {
  id: string;
  /** Which entity types may hold this. */
  holders?: EntityTypeId[];
  ownership: OwnershipMode;
  token?: TokenSpec;
}

/** Governance for an organization type (brief §19). */
export type GovernanceMechanism =
  | 'leader'
  | 'majority_vote'
  | 'token_weighted'
  | 'reputation_weighted'
  | 'council'
  | 'consensus';

export interface GovernanceDef {
  mechanism: GovernanceMechanism;
  /** Fraction of weight required to pass, 0..1. Default 0.5. */
  threshold?: number;
  /** Ticks a proposal stays open. */
  votingTicks?: number;
  /** Weight source for token_weighted / reputation_weighted. */
  weightBy?: string;
}

/**
 * Organizations are ordinary entities with members, a treasury and optional
 * governance — not a separate system (brief §18). A company, a DAO, a guild and
 * a kingdom are the same machinery with different configuration.
 */
export interface OrganizationDef {
  /** The entity type that behaves as an organization. */
  type: EntityTypeId;
  /** Entity types that may be members. */
  memberTypes?: EntityTypeId[];
  /** Resource held in the org's on-chain treasury. */
  treasuryResource?: ResourceId;
  governance?: GovernanceDef;
  /** Issue a per-organization SPL mint representing ownership stakes. */
  equityToken?: TokenSpec;
}

/** Top-level chain configuration for a world (brief §11, §13). */
export interface ChainConfig {
  /** Cluster to settle against. */
  cluster?: 'localnet' | 'devnet' | 'mainnet-beta';
  /** The world's unit of account. Must name a resource. */
  currency: ResourceId;
  /** Per-resource token specs, keyed by resource id. */
  tokens?: Record<ResourceId, TokenSpec>;
  /** Non-fungible or record-based asset classes. */
  assets?: AssetClassDef[];
  /** Give every agent entity a real keypair and token accounts (brief §12). */
  agentWallets?: boolean;
  /** Register a thin identity PDA per agent so explorers show real accounts. */
  agentRegistry?: boolean;
  /** Settle market clearings on chain rather than only mirroring them. */
  onChainMarkets?: boolean;
  /** After each round, reconcile engine balances against chain; chain wins. */
  chainAuthoritative?: boolean;
}
