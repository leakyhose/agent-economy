import type { EntityId } from './state.ts';
import type { ActionId, Json } from './world.ts';

/** What an agent emits. Inert data with zero privileges (brief §30). */
export interface ActionProposal {
  action: ActionId;
  actor: EntityId;
  target?: EntityId;
  params?: Record<string, Json>;
  /** The agent's own words. Shown in the UI; never affects validation. */
  reason?: string;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; rejectedBy: string; message: string };
