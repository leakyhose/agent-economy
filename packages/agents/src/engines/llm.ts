/**
 * The language-model engine.
 *
 * Everything a model returns is treated as hostile input. It is parsed, then
 * checked field by field against what the world actually permits, and anything
 * that does not survive that becomes `null` — a skipped turn, never an
 * exception and never a half-trusted proposal. The action name must appear in
 * `availableActions`; parameter names must be ones the world states; numbers
 * must be positive; targets must be entities the agent can actually see.
 *
 * `reason` is the one free-text field. It is carried through because the UI
 * shows it, truncated because it is untrusted, and used for nothing else.
 */

import type { ActionProposal, DecisionEngine, Json, LLMProvider, Observation } from '@aw/types';
import type { EngineContext } from './proposal.ts';
import { renderPrompt, type PromptOptions } from '../providers/prompt.ts';

export type RejectionReason =
  | 'empty-response'
  | 'no-json'
  | 'not-an-object'
  | 'unknown-action'
  | 'unavailable-action'
  | 'bad-target'
  | 'bad-params'
  | 'provider-error';

export interface LLMEngineOptions extends EngineContext {
  provider: LLMProvider;
  goals?: readonly string[];
  prompt?: PromptOptions;
  /** Observability hook; receives every discarded reply. */
  onReject?: (reason: RejectionReason, raw: string) => void;
}

const REASON_LIMIT = 200;

/** Pull the first balanced JSON object out of a reply, ignoring any prose. */
export function extractJson(raw: string): string | null {
  const text = raw.replace(/```[a-zA-Z]*\n?/g, '').trim();
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return null;
  return flat.length <= REASON_LIMIT ? flat : `${flat.slice(0, REASON_LIMIT - 1)}…`;
}

export class LLMEngine implements DecisionEngine {
  readonly name = 'llm';
  private readonly ctx: EngineContext;
  private readonly provider: LLMProvider;
  private readonly promptOptions: PromptOptions;
  private readonly onReject: (reason: RejectionReason, raw: string) => void;
  private lastReason: RejectionReason | null = null;

  constructor(options: LLMEngineOptions) {
    this.ctx = { lens: options.lens, traits: options.traits, seed: options.seed };
    if (options.memory) this.ctx.memory = options.memory;
    this.provider = options.provider;
    this.promptOptions = {
      traits: options.traits,
      ...(options.goals ? { goals: options.goals } : {}),
      ...(options.prompt ?? {}),
    };
    this.onReject = options.onReject ?? (() => undefined);
  }

  /** The reason the most recent reply was discarded, or null if it was kept. */
  get lastRejection(): RejectionReason | null {
    return this.lastReason;
  }

  async decide(obs: Observation): Promise<ActionProposal | null> {
    let raw: string;
    try {
      const { system, user } = renderPrompt(obs, this.ctx.lens, this.promptOptions);
      raw = await this.provider.complete(system, user);
    } catch (error) {
      this.reject('provider-error', String(error));
      return null;
    }
    return this.parse(raw, obs);
  }

  /**
   * Validate a raw reply against this observation. Pure and synchronous, so a
   * test can hand it any string at all.
   */
  parse(raw: string, obs: Observation): ActionProposal | null {
    try {
      return this.parseUnsafe(raw, obs);
    } catch (error) {
      this.reject('no-json', String(error));
      return null;
    }
  }

  private parseUnsafe(raw: string, obs: Observation): ActionProposal | null {
    if (typeof raw !== 'string' || raw.trim().length === 0) return this.reject('empty-response', String(raw));

    // If the whole reply is valid JSON, take it at its word — a list of
    // proposals, or a bare string, is a reply that ignored the instructions and
    // is refused rather than salvaged. Only when the reply is *not* valid JSON
    // do we go digging for an object inside prose.
    let parsed: Record<string, unknown>;
    const whole = tryParse(raw.replace(/```[a-zA-Z]*\n?/g, '').trim());
    if (whole.ok) {
      if (!isPlainObject(whole.value)) return this.reject('not-an-object', raw);
      parsed = whole.value;
    } else {
      const slice = extractJson(raw);
      if (slice === null) return this.reject('no-json', raw);
      const dug = tryParse(slice);
      if (!dug.ok) return this.reject('no-json', raw);
      if (!isPlainObject(dug.value)) return this.reject('not-an-object', raw);
      parsed = dug.value;
    }

    const action = parsed['action'];
    if (typeof action !== 'string' || action.length === 0) return this.reject('unknown-action', raw);
    if (!obs.availableActions.includes(action)) return this.reject('unavailable-action', raw);

    const info = this.ctx.lens.info(action);
    if (!info) return this.reject('unknown-action', raw);

    const proposal: ActionProposal = { action, actor: obs.self.id };

    const target = parsed['target'];
    if (target !== undefined && target !== null && target !== '') {
      if (typeof target !== 'string') return this.reject('bad-target', raw);
      if (info.targetTypes.length === 0) return this.reject('bad-target', raw);
      const match = obs.visibleEntities.find((e) => e.id === target);
      if (!match || !info.targetTypes.includes(match.type)) return this.reject('bad-target', raw);
      proposal.target = target;
    } else if (info.targetTypes.length > 0) {
      return this.reject('bad-target', raw);
    }

    const params = this.validateParams(parsed['params'], obs, action);
    if (params === false) return this.reject('bad-params', raw);
    if (params !== null) proposal.params = params;

    const reason = cleanReason(parsed['reason']);
    if (reason !== null) proposal.reason = reason;

    this.lastReason = null;
    return proposal;
  }

  /** null = nothing to attach, false = reject the whole reply. */
  private validateParams(
    value: unknown,
    obs: Observation,
    action: string,
  ): Record<string, Json> | null | false {
    const info = this.ctx.lens.info(action);
    if (!info) return false;
    const stated = info.params;

    if (value === undefined || value === null) {
      return stated.some((p) => p.required) ? false : null;
    }
    if (!isPlainObject(value)) return false;

    const known = new Set(stated.map((p) => p.name));
    for (const key of Object.keys(value)) {
      if (!known.has(key)) return false;
    }

    const out: Record<string, Json> = {};
    for (const param of stated) {
      const supplied = value[param.name];
      if (supplied === undefined || supplied === null) {
        if (param.required) return false;
        continue;
      }
      switch (param.type) {
        case 'number': {
          if (typeof supplied !== 'number' || !Number.isFinite(supplied) || supplied <= 0) {
            return false;
          }
          out[param.name] = supplied;
          break;
        }
        case 'resource': {
          if (typeof supplied !== 'string' || !this.ctx.lens.resourceIds.includes(supplied)) {
            return false;
          }
          out[param.name] = supplied;
          break;
        }
        case 'entity': {
          if (typeof supplied !== 'string') return false;
          const visible = supplied === obs.self.id || obs.visibleEntities.some((e) => e.id === supplied);
          if (!visible) return false;
          out[param.name] = supplied;
          break;
        }
        default: {
          if (typeof supplied !== 'string') return false;
          out[param.name] = supplied.slice(0, REASON_LIMIT);
          break;
        }
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  private reject(reason: RejectionReason, raw: string): null {
    this.lastReason = reason;
    this.onReject(reason, raw);
    return null;
  }
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}
