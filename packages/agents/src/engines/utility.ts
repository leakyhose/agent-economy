/**
 * Score every action the agent could take, pick the best one.
 *
 * The features are all observable: what the action is expected to return, how
 * long it ties the agent up, how much of its balance it puts at stake, and how
 * many others were recently seen doing the same thing. Temperament sets the
 * weights. Ties break on a seeded jitter keyed to the action id, so adding an
 * action never reshuffles the ranking of the others.
 */

import type { ActionProposal, DecisionEngine, Observation } from '@aw/types';
import {
  expectedGain,
  exposure,
  pressureLevel,
  toProposal,
  viableCandidates,
  type Candidate,
  type EngineContext,
} from './proposal.ts';
import { jitter } from '../rng.ts';

export interface UtilityWeights {
  gain: number;
  time: number;
  risk: number;
  herding: number;
  pressure: number;
}

export const DEFAULT_WEIGHTS: UtilityWeights = {
  gain: 1,
  time: 1,
  risk: 1,
  herding: 1,
  pressure: 1,
};

export interface UtilityOptions extends EngineContext {
  weights?: Partial<UtilityWeights>;
}

export interface ScoredCandidate {
  candidate: Candidate;
  score: number;
  parts: Record<string, number>;
}

/** How many recent events look like other agents taking this same action. */
function crowd(obs: Observation, actionId: string): number {
  let n = 0;
  for (const event of obs.recentEvents) {
    if (event.type === actionId) {
      n++;
      continue;
    }
    for (const value of Object.values(event.data)) {
      if (value === actionId) {
        n++;
        break;
      }
    }
  }
  return n;
}

export class UtilityEngine implements DecisionEngine {
  readonly name = 'utility';
  private readonly ctx: EngineContext;
  private readonly weights: UtilityWeights;

  constructor(options: UtilityOptions) {
    this.ctx = { lens: options.lens, traits: options.traits, seed: options.seed };
    if (options.memory) this.ctx.memory = options.memory;
    this.weights = { ...DEFAULT_WEIGHTS, ...(options.weights ?? {}) };
  }

  async decide(obs: Observation): Promise<ActionProposal | null> {
    return this.decideSync(obs);
  }

  decideSync(obs: Observation): ActionProposal | null {
    const ranked = this.rank(obs);
    const top = ranked[0];
    if (!top) return null;
    return toProposal(top.candidate, obs, this.explain(top));
  }

  /** Full ranking, highest first. Exposed so the scoring can be inspected. */
  rank(obs: Observation): ScoredCandidate[] {
    const candidates = viableCandidates(obs, this.ctx);
    const { traits } = this.ctx;
    const pressure = pressureLevel(obs.self, this.ctx.lens);

    const scored = candidates.map((candidate) => {
      const gain = expectedGain(candidate, obs, this.ctx);
      const scale = Math.max(1, Math.abs(gain));

      // Everything below is normalised against the size of the payoff so the
      // weights mean the same thing in a world priced in ones and a world
      // priced in thousands.
      const gainPart = this.weights.gain * (gain / candidate.info.duration);
      const timePart =
        -this.weights.time * (1 - traits.patience) * (candidate.info.duration - 1) * 0.25 * scale;
      const riskPart =
        -this.weights.risk * (1 - traits.riskTolerance) * exposure(candidate, obs, this.ctx) * scale;
      const herdPart =
        this.weights.herding * traits.herding * crowd(obs, candidate.actionId) * 0.1 * scale;

      let pressurePart = 0;
      if (pressure > 0) {
        let relief = 0;
        for (const resource of this.ctx.lens.perishables) {
          const delta = candidate.deltas[resource] ?? 0;
          if (delta > 0) relief += delta;
          if (candidate.info.shape === 'acquire' && candidate.resource === resource) {
            relief += candidate.amount ?? 0;
          }
        }
        pressurePart = this.weights.pressure * pressure * relief * 0.2 * scale;
      }

      const tie = jitter(this.ctx.seed, `score:${obs.self.id}:${obs.tick}:${candidate.actionId}`);
      const score =
        gainPart + timePart + riskPart + herdPart + pressurePart + tie * 1e-6 * scale;

      return {
        candidate,
        score,
        parts: {
          gain: gainPart,
          time: timePart,
          risk: riskPart,
          herding: herdPart,
          pressure: pressurePart,
        },
      };
    });

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.candidate.actionId < b.candidate.actionId ? -1 : 1;
    });
    return scored;
  }

  private explain(top: ScoredCandidate): string {
    const parts = Object.entries(top.parts)
      .filter(([, value]) => Math.abs(value) > 1e-9)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 2)
      .map(([key, value]) => `${key} ${value >= 0 ? '+' : ''}${Math.round(value)}`);
    return `Highest scoring option (${parts.join(', ') || 'no distinguishing factor'}).`;
  }
}
