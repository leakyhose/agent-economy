/**
 * @aw/solana — the chain layer.
 *
 * Three Anchor programs and their clients: `world` (ledger, uniform-price batch
 * auction, permissionless liquidation), `registry` (agent identity and asset
 * ownership PDAs) and `org` (treasury, governance, escrow).
 *
 * This package is the only one that touches private keys. @aw/agents has no
 * import path to it, directly or transitively, and a test enforces that: the
 * model proposes, the engine validates, and only this layer signs.
 *
 * Five symbols are defined in more than one module. They are re-exported once
 * here, from the module that owns them, rather than being silently dropped by
 * a wildcard.
 */

// --- world program: ledger, auction, settlement -----------------------------
export * from './auction.ts';
export * from './goods.ts';
export * from './ix.ts';            // owns `discriminator`
export * from './sender.ts';
export * from './settlement.ts';
export * from './tokens.ts';
export * from './client.ts';
export * from './config.ts';        // owns `explorerUrl`

// --- key custody ------------------------------------------------------------
// wallet.ts owns the SPL constants and the ATA derivation for the whole package.
export * from './wallet.ts';

// --- registry program: identity and ownership -------------------------------
export {
  REGISTRY_PROGRAM_ID, LABEL_LEN, IX_DISCRIMINATOR, ACCOUNT_DISCRIMINATOR,
  verifyDiscriminators, deriveWorldId, encodeLabel,
  PdaOwnershipRegistry, AgentRegistry,
  type DiscriminatorSource,
} from './registry.ts';

// --- org program: treasury, governance, escrow ------------------------------
export {
  ORG_PROGRAM_ID, TOKEN_ACCOUNT_BYTES, MINT_BYTES, MECHANISMS, mechanismByte,
} from './org-program.ts';
export * from './treasury.ts';
export * from './governance.ts';
export * from './escrow.ts';
