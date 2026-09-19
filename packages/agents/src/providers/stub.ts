/**
 * The default provider. No network, no key, no cost, and the same answer every
 * time for the same prompt — so the whole test suite can run the LLM engine.
 *
 * It reads the prompt the way a model would: the only thing it knows about the
 * world is the ACTIONS block it was handed. That keeps the stub honest, and it
 * doubles as a check that the prompt is self-contained.
 */

import type { LLMProvider } from '@aw/types';
import { hashString, makeRng, mixSeed } from '../rng.ts';

const ACTION_LINE = /^- (\S+) \((\d+)t\) \[([^\]]*)\](?: ->(\S+))?(?: : (.*))?$/;

interface ParsedParam {
  name: string;
  required: boolean;
  type: string;
}

interface ParsedAction {
  id: string;
  params: ParsedParam[];
  targeted: boolean;
}

interface ParsedPrompt {
  actions: ParsedAction[];
  holdings: Array<{ id: string; amount: number }>;
  payResource: string | null;
  near: string[];
}

function parsePairs(line: string): Array<{ id: string; amount: number }> {
  const out: Array<{ id: string; amount: number }> = [];
  for (const chunk of line.trim().split(/\s+/)) {
    const at = chunk.indexOf('=');
    if (at <= 0) continue;
    const id = chunk.slice(0, at);
    const amount = Number(chunk.slice(at + 1));
    if (Number.isFinite(amount)) out.push({ id, amount });
  }
  return out;
}

export function parsePrompt(user: string): ParsedPrompt {
  const parsed: ParsedPrompt = { actions: [], holdings: [], payResource: null, near: [] };
  let inActions = false;
  for (const raw of user.split('\n')) {
    const line = raw.trim();
    if (line === 'ACTIONS') {
      inActions = true;
      continue;
    }
    if (line.startsWith('HAVE ')) {
      parsed.holdings = parsePairs(line.slice(5));
      continue;
    }
    if (line.startsWith('PAYWITH ')) {
      parsed.payResource = line.slice(8).trim();
      continue;
    }
    if (line.startsWith('NEAR ')) {
      parsed.near = line
        .slice(5)
        .split(/\s+/)
        .map((token) => {
          const at = token.indexOf('(');
          return at > 0 ? token.slice(0, at) : '';
        })
        .filter((id) => id.length > 0);
      continue;
    }
    if (!inActions) continue;
    const matched = ACTION_LINE.exec(line);
    if (!matched) continue;
    const [, id, , paramBlob, targetBlob] = matched;
    if (!id) continue;
    const params: ParsedParam[] = [];
    for (const part of (paramBlob ?? '').split(',')) {
      const token = part.trim();
      if (!token) continue;
      const colon = token.lastIndexOf(':');
      if (colon <= 0) continue;
      const head = token.slice(0, colon);
      const type = token.slice(colon + 1);
      const required = head.endsWith('!');
      params.push({ name: head.replace(/[!?]$/, ''), required, type });
    }
    parsed.actions.push({ id, params, targeted: Boolean(targetBlob) });
  }
  return parsed;
}

export interface StubOptions {
  seed?: number;
  /** Numeric value the stub proposes. Kept small so it clears most rules. */
  amount?: number;
}

export class StubProvider implements LLMProvider {
  readonly name = 'stub';
  private readonly seed: number;
  private readonly amount: number;

  constructor(options: StubOptions = {}) {
    this.seed = options.seed ?? 1;
    this.amount = Math.max(1, Math.trunc(options.amount ?? 1));
  }

  async complete(_system: string, user: string): Promise<string> {
    return this.completeSync(user);
  }

  completeSync(user: string): string {
    const parsed = parsePrompt(user);
    const usable = parsed.actions.filter((a) => this.canFill(a, parsed));
    const pool = usable.length > 0 ? usable : parsed.actions;
    if (pool.length === 0) return '{}';

    const rng = makeRng(mixSeed(this.seed, `stub:${hashString(user)}`));
    const chosen = pool[rng.int(pool.length)];
    if (!chosen) return '{}';

    const body: Record<string, unknown> = { action: chosen.id };
    if (chosen.targeted) {
      const target = parsed.near[rng.int(Math.max(1, parsed.near.length))];
      if (target) body['target'] = target;
    }
    const params: Record<string, unknown> = {};
    for (const param of chosen.params) {
      if (!param.required) continue;
      if (param.type === 'resource') {
        const resource = this.pickResource(parsed);
        if (resource) params[param.name] = resource;
        continue;
      }
      if (param.type === 'entity') {
        const entity = parsed.near[0];
        if (entity) params[param.name] = entity;
        continue;
      }
      if (param.type === 'number') {
        params[param.name] = this.amount;
        continue;
      }
      params[param.name] = 'x';
    }
    if (Object.keys(params).length > 0) body['params'] = params;
    body['reason'] = 'Routine choice from the options offered.';
    return JSON.stringify(body);
  }

  private pickResource(parsed: ParsedPrompt): string | null {
    const stocked = parsed.holdings.filter(
      (h) => h.amount >= this.amount && h.id !== parsed.payResource,
    );
    if (stocked.length > 0) return stocked[0]?.id ?? null;
    const any = parsed.holdings.filter((h) => h.id !== parsed.payResource);
    return any[0]?.id ?? parsed.holdings[0]?.id ?? null;
  }

  private canFill(action: ParsedAction, parsed: ParsedPrompt): boolean {
    if (action.targeted && parsed.near.length === 0) return false;
    for (const param of action.params) {
      if (!param.required) continue;
      if (param.type === 'resource' && this.pickResource(parsed) === null) return false;
      if (param.type === 'entity' && parsed.near.length === 0) return false;
    }
    return true;
  }
}

/**
 * Replays a fixed list of replies in order, then repeats the last one. For
 * tests that need a specific malformed answer.
 */
export class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted';
  private at = 0;
  constructor(private readonly replies: readonly string[]) {}

  async complete(_system: string, _user: string): Promise<string> {
    if (this.replies.length === 0) return '';
    const index = Math.min(this.at, this.replies.length - 1);
    this.at++;
    return this.replies[index] ?? '';
  }

  get callCount(): number {
    return this.at;
  }
}
