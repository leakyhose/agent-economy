/**
 * Priority heuristics. Cheap, deterministic, and the baseline every other
 * engine is measured against.
 *
 * The priorities are expressed in terms the observation supplies — pressure the
 * world is applying, the balance of the pay resource, stock relative to a
 * remembered level — and the action to serve each one is discovered from
 * `availableActions`. No action name appears anywhere in this file.
 */

import type { ActionProposal, DecisionEngine, Observation, ResourceId } from '@aw/types';
import {
  believedLevel,
  expectedGain,
  held,
  payBalance,
  pressureLevel,
  referencePrice,
  toProposal,
  viableCandidates,
  type Candidate,
  type EngineContext,
} from './proposal.ts';
import { jitter } from '../rng.ts';

export interface RuleBasedOptions extends EngineContext {
  /** Pressure at or above which relieving it outranks everything else. */
  pressureThreshold?: number;
  /**
   * Balance below which the agent must earn. Defaults to three units of the
   * cheapest thing the world prices, so it scales with the world.
   */
  payFloor?: number;
  /** How far above the believed level a price must sit to trigger an offer. */
  offerMargin?: number;
}

function cheapestTraded(ctx: EngineContext): number {
  let low = Number.POSITIVE_INFINITY;
  for (const resource of ctx.lens.tradedResources) {
    if (resource === ctx.lens.payResource) continue;
    const hint = ctx.lens.priceHints[resource];
    if (typeof hint === 'number' && hint > 0 && hint < low) low = hint;
  }
  return Number.isFinite(low) ? low : 1;
}

function bestBy(
  candidates: Candidate[],
  seed: number,
  obs: Observation,
  score: (c: Candidate) => number | null,
): Candidate | null {
  let best: Candidate | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const raw = score(candidate);
    if (raw === null) continue;
    const tie = jitter(seed, `${obs.self.id}:${obs.tick}:${candidate.actionId}`) * 1e-6;
    const value = raw + tie;
    if (value > bestScore) {
      best = candidate;
      bestScore = value;
    }
  }
  return best;
}

export class RuleBasedEngine implements DecisionEngine {
  readonly name = 'rule-based';
  private readonly ctx: EngineContext;
  private readonly pressureThreshold: number;
  private readonly payFloor: number;
  private readonly offerMargin: number;

  constructor(options: RuleBasedOptions) {
    this.ctx = { lens: options.lens, traits: options.traits, seed: options.seed };
    if (options.memory) this.ctx.memory = options.memory;
    this.pressureThreshold = options.pressureThreshold ?? 1;
    this.payFloor = options.payFloor ?? cheapestTraded(this.ctx) * 3;
    this.offerMargin = options.offerMargin ?? 1;
  }

  async decide(obs: Observation): Promise<ActionProposal | null> {
    return this.decideSync(obs);
  }

  /** Synchronous twin, so a hybrid engine can consult it without awaiting. */
  decideSync(obs: Observation): ActionProposal | null {
    const candidates = viableCandidates(obs, this.ctx);
    if (candidates.length === 0) return null;
    const { lens } = this.ctx;

    const pressure = pressureLevel(obs.self, lens);
    const balance = payBalance(obs.self, lens);

    // 1. The world is squeezing this agent and it has nothing to answer with.
    if (pressure >= this.pressureThreshold) {
      const wanted = this.mostNeededPerishable(obs);
      if (wanted !== null) {
        const supply = bestBy(candidates, this.ctx.seed, obs, (c) =>
          (c.deltas[wanted] ?? 0) > 0 ? (c.deltas[wanted] ?? 0) / c.info.duration : null,
        );
        if (supply) {
          return toProposal(supply, obs, `Pressure at ${pressure}; producing ${wanted}.`);
        }
        const acquire = bestBy(candidates, this.ctx.seed, obs, (c) =>
          c.info.shape === 'acquire' && c.resource === wanted ? 1 : null,
        );
        if (acquire) {
          return toProposal(acquire, obs, `Pressure at ${pressure}; acquiring ${wanted}.`);
        }
      }
    }

    // 2. Out of spending power: do something that ends in tradable output.
    if (balance < this.payFloor) {
      const earn = bestBy(candidates, this.ctx.seed, obs, (c) => {
        if (c.info.shape !== 'produce') return null;
        let value = 0;
        for (const [resource, delta] of Object.entries(c.deltas)) {
          if (delta > 0) value += delta * referencePrice(obs, lens, resource);
        }
        return value > 0 ? value / c.info.duration : null;
      });
      if (earn) return toProposal(earn, obs, `Balance ${balance} is low; working for output.`);

      const liquidate = bestBy(candidates, this.ctx.seed, obs, (c) =>
        c.info.shape === 'offer' ? expectedGain(c, obs, this.ctx) : null,
      );
      if (liquidate) {
        return toProposal(liquidate, obs, `Balance ${balance} is low; releasing stock.`);
      }
    }

    // 3. Sitting on stock at a price above the level this agent remembers.
    const offer = bestBy(candidates, this.ctx.seed, obs, (c) => {
      if (c.info.shape !== 'offer' || !c.resource) return null;
      const stock = held(obs.self, c.resource);
      if (stock < 2) return null;
      const price = referencePrice(obs, lens, c.resource);
      const level = believedLevel(this.ctx, obs, c.resource);
      if (level === null || price < level * this.offerMargin) return null;
      return (price - level) * (c.amount ?? 1);
    });
    if (offer) {
      return toProposal(offer, obs, `Price for ${offer.resource} is above the remembered level.`);
    }

    // 4. Nothing pressing: take the best value per tick, patience permitting.
    const fallback = bestBy(candidates, this.ctx.seed, obs, (c) => {
      const gain = expectedGain(c, obs, this.ctx);
      const patienceCost = (1 - this.ctx.traits.patience) * (c.info.duration - 1);
      return gain / c.info.duration - patienceCost;
    });
    if (fallback) return toProposal(fallback, obs, 'Best available return for the time it takes.');
    return null;
  }

  /** The perishable this agent is shortest of, or null when it is stocked. */
  private mostNeededPerishable(obs: Observation): ResourceId | null {
    let worst: ResourceId | null = null;
    let worstStock = Number.POSITIVE_INFINITY;
    for (const resource of this.ctx.lens.perishables) {
      const stock = held(obs.self, resource);
      if (stock < worstStock) {
        worst = resource;
        worstStock = stock;
      }
    }
    if (worst === null) return null;
    return worstStock <= 4 ? worst : null;
  }
}
