// Chooses a settlement backend. The sim must run with no validator, so the
// null queue is the default and the real one is opt-in via CHAIN=1.
//
// Note the import boundary: this file may reach into @aw/solana because it is
// the integration layer. @aw/agents may not, and that is enforced by a test.
import type { SettlementIntent, SettlementQueue, WorldDefinition } from '@aw/types';
import { CFG } from './config.ts';

export interface Settlement extends SettlementQueue {
  addressFor(entityId: string): Promise<string>;
}

class NullSettlement implements Settlement {
  private queued = 0;
  enqueue(_intent: SettlementIntent) { this.queued++; }
  async flush() { return []; }
  pending() { return this.queued; }
  async addressFor(entityId: string) { return `offchain:${entityId}`; }
}

export async function makeSettlement(world: WorldDefinition): Promise<Settlement> {
  if (!CFG.CHAIN) {
    console.log('[sim] settlement: OFF (set CHAIN=1 with a local validator to settle for real)');
    return new NullSettlement();
  }
  try {
    const { createSettlement } = await import('@aw/solana');
    return await createSettlement({ world, rpc: CFG.RPC }) as Settlement;
  } catch (e) {
    // Never let a chain problem take the simulation down mid-demo.
    console.error('[sim] settlement: chain unavailable, falling back to off-chain:', (e as Error).message);
    return new NullSettlement();
  }
}
