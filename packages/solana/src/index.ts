/**
 * `@aw/solana` — the settlement layer.
 *
 * One generic Anchor program (`programs/world`) holds every world's economy: who owns
 * what, and the batch auction that turns orders into a price. This package is the
 * only thing that talks to it, and the only thing that holds a key.
 *
 * Three rules the package exists to keep:
 *
 * 1. **Keys live in one place.** {@link SolanaWalletService} and nothing else. No
 *    method returns key material and no instance prints it.
 * 2. **The simulation never blocks on RPC.** {@link SolanaSettlementQueue.enqueue} is
 *    synchronous and does nothing but buffer; sending happens off the tick loop, with
 *    retry and backoff. {@link NullSettlementQueue} keeps the sim running with no
 *    validator at all.
 * 3. **The world is data.** Nothing here names `SOL`, `gold`, `food` or `land`.
 *    {@link mapWorldGoods} reads the good indices out of a `WorldDefinition`, so the
 *    same code drives Economic Sandbox and Medieval Kingdom.
 *
 * It may import `@aw/types`, `@solana/web3.js` and Node builtins. It must not import
 * `@aw/engine` or `@aw/agents`, and does not.
 */

export {
  clearAuction,
  fills,
  sortAsks,
  sortBids,
  type AuctionOutcome,
  type Delta,
  type Order,
} from './auction.ts';

export {
  BlockhashCache,
  LOCAL_RPC,
  clusterFromEnv,
  connect,
  explorerUrl,
  makeExplorer,
  type ClusterConfig,
} from './cluster.ts';

export {
  MAX_AGENTS,
  MAX_GOODS,
  endowmentsFor,
  mapWorldGoods,
  modalEndowment,
  rosterFromWorld,
  type AgentRoster,
  type Endowment,
  type GoodMap,
} from './goods.ts';

export {
  chunk,
  clearAuctionIx,
  createLedgerAccountIx,
  endowIx,
  initializeIx,
  sealIx,
  settleIx,
  transferIx,
  type LedgerAccounts,
} from './instructions.ts';

export { WorldLedger } from './ledger.ts';

export {
  DELTA_BYTES,
  DISC,
  ENDOWMENT_BYTES,
  HEADER_BYTES,
  LEDGER_BYTES,
  MAX_DELTAS_PER_TX,
  MAX_ENDOWMENTS_PER_TX,
  MAX_IX_DATA_BYTES,
  MAX_ORDERS_PER_BOOK,
  MAX_ORDERS_PER_TX,
  MAX_TRANSFERS_PER_TX,
  OFF,
  ORDER_BYTES,
  SLOT_BYTES,
  decodeLedger,
  discriminator,
  loadIdl,
  type LedgerSlot,
  type LedgerState,
} from './program.ts';

export {
  NullSettlementQueue,
  SolanaSettlementQueue,
  type QueueOptions,
  type SettlementFailure,
} from './queue.ts';

export { ProgramRejection, TxSender, type SenderOptions } from './sender.ts';

export { SolanaWalletService, loadKeypair } from './wallet.ts';
