// Ports the Solana layer implements. The simulation depends on these interfaces,
// never on @solana/web3.js, so the chain implementation stays swappable.
import type { EntityId } from './state.ts';
import type { ResourceId } from './world.ts';
import type { GovernanceMechanism } from './chain.ts';

export interface TokenMint {
  resource: ResourceId;
  symbol: string;
  mint: string;
  decimals: number;
  /** True once mint authority is revoked — an inflation-proof world. */
  fixedSupply: boolean;
}

/** Brief §12. The only component that touches private keys. */
export interface AgentWallet {
  entity: EntityId;
  address: string;
  /** resource id -> associated token account address. */
  tokenAccounts: Record<ResourceId, string>;
}

/** Brief §14, §17. Token operations, all key handling internal. */
export interface TokenService {
  createToken(resource: ResourceId, symbol: string, decimals: number): Promise<TokenMint>;
  mintTo(resource: ResourceId, to: EntityId, amount: number): Promise<string>;
  burnFrom(resource: ResourceId, from: EntityId, amount: number): Promise<string>;
  transferToken(resource: ResourceId, from: EntityId, to: EntityId, amount: number): Promise<string>;
  balanceOf(resource: ResourceId, entity: EntityId): Promise<number>;
  revokeMintAuthority(resource: ResourceId): Promise<string>;
}

/** Brief §15. Ownership as a first-class, on-chain fact. */
export interface OwnershipRegistry {
  /** Record that `owner` holds `assetId`. Returns the transaction signature. */
  assign(assetId: string, owner: EntityId): Promise<string>;
  transfer(assetId: string, from: EntityId, to: EntityId): Promise<string>;
  ownerOf(assetId: string): Promise<EntityId | null>;
  assetsOf(owner: EntityId): Promise<string[]>;
}

/** Brief §16, §18. An organization's on-chain treasury. */
export interface TreasuryService {
  open(org: EntityId, resource: ResourceId): Promise<string>;
  deposit(org: EntityId, from: EntityId, amount: number): Promise<string>;
  /** Only callable as the result of an executed governance decision. */
  disburse(org: EntityId, to: EntityId, amount: number, proposalId: string): Promise<string>;
  balance(org: EntityId): Promise<number>;
}

export interface Proposal {
  id: string;
  org: EntityId;
  proposer: EntityId;
  /** What passing this proposal does, as a settlement instruction. */
  action: { kind: 'disburse'; to: EntityId; amount: number } | { kind: 'signal'; text: string };
  opensAtTick: number;
  closesAtTick: number;
  votesFor: number;
  votesAgainst: number;
  executed: boolean;
}

/** Brief §19. Governance decisions can trigger Solana transactions. */
export interface GovernanceService {
  mechanism(org: EntityId): Promise<GovernanceMechanism>;
  propose(org: EntityId, proposer: EntityId, action: Proposal['action'], closesAtTick: number): Promise<Proposal>;
  vote(proposalId: string, voter: EntityId, support: boolean, weight: number): Promise<string>;
  /** Tally and, if passed, execute on chain. Returns the signature if executed. */
  finalize(proposalId: string, tick: number): Promise<string | null>;
  open(org: EntityId): Promise<Proposal[]>;
}

/** Brief §16, §17. Escrowed bilateral trade. */
export interface EscrowService {
  create(from: EntityId, to: EntityId, give: { resource: ResourceId; amount: number },
         want: { resource: ResourceId; amount: number }): Promise<string>;
  accept(escrowId: string, by: EntityId): Promise<string>;
  cancel(escrowId: string, by: EntityId): Promise<string>;
}
