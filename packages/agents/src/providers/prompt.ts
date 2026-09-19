/**
 * The prompt. One agent, one turn, as few tokens as will still decide well —
 * there are a hundred of these per tick and they are all paid for.
 *
 * The action catalogue is rendered from the world definition at runtime, with
 * whatever descriptions the world's author wrote. That is the only place the
 * model learns what it can do, which is exactly the point: swap the world file
 * and the same code prompts for a different game.
 */

import type { ActionParamDef, Entity, Observation } from '@aw/types';
import type { WorldLens } from '../lens.ts';
import type { Traits } from '../traits.ts';

export interface PromptOptions {
  goals?: readonly string[];
  traits?: Traits;
  /** Trim long descriptions to this many characters. */
  descriptionLimit?: number;
  maxVisible?: number;
  maxEvents?: number;
  maxMemories?: number;
}

const DEFAULTS = {
  descriptionLimit: 110,
  maxVisible: 8,
  maxEvents: 6,
  maxMemories: 5,
};

function shorten(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

function renderParams(params: readonly ActionParamDef[]): string {
  if (params.length === 0) return '';
  return params.map((p) => `${p.name}${p.required ? '!' : '?'}:${p.type}`).join(',');
}

function numbersOf(record: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) parts.push(`${key}=${value}`);
    else if (typeof value === 'boolean') parts.push(`${key}=${value ? 1 : 0}`);
  }
  return parts.join(' ');
}

function describeEntity(entity: Entity): string {
  return `${entity.id}(${entity.type})`;
}

/**
 * Standing instructions. Stable across ticks, which makes it the natural
 * boundary for prompt caching later on.
 */
export function systemPrompt(options: PromptOptions = {}): string {
  const lines: string[] = [
    'You are one autonomous agent inside a simulation. Each turn you choose exactly one action.',
    '',
    'Reply with ONE JSON object and nothing else:',
    '{"action":"<id from ACTIONS>","target":"<entity id, omit if unused>","params":{},"reason":"<max 12 words>"}',
    '',
    'Hard requirements:',
    '- Copy "action" character for character from the ACTIONS list. Never invent one.',
    '- Supply every parameter marked ! and no parameter that is not listed.',
    '- Every number must be a positive integer. Never ask for more than you hold.',
    '- No prose, no explanation outside "reason", no code fences.',
    'A reply that breaks any of these is discarded and the turn is wasted.',
  ];
  if (options.traits) {
    const t = options.traits;
    lines.push(
      '',
      `Temperament: risk ${t.riskTolerance}, patience ${t.patience}, herding ${t.herding}.`,
    );
  }
  const goals = options.goals ?? [];
  if (goals.length > 0) {
    lines.push('Goals, in order:', ...goals.map((g, i) => `${i + 1}. ${g}`));
  }
  return lines.join('\n');
}

/** The turn itself: everything this agent is allowed to know, compressed. */
export function userPrompt(obs: Observation, lens: WorldLens, options: PromptOptions = {}): string {
  const limit = options.descriptionLimit ?? DEFAULTS.descriptionLimit;
  const maxVisible = options.maxVisible ?? DEFAULTS.maxVisible;
  const maxEvents = options.maxEvents ?? DEFAULTS.maxEvents;
  const maxMemories = options.maxMemories ?? DEFAULTS.maxMemories;

  const lines: string[] = [];
  lines.push(`T=${obs.tick} you=${obs.self.id} (${obs.self.type})`);

  const holdings = numbersOf(obs.self.resources);
  if (holdings) lines.push(`HAVE ${holdings}`);
  const attributes = numbersOf(obs.self.attributes);
  if (attributes) lines.push(`ATTR ${attributes}`);
  if (lens.payResource) lines.push(`PAYWITH ${lens.payResource}`);

  const prices = numbersOf(obs.prices);
  if (prices) lines.push(`PRICES ${prices}`);

  if (obs.visibleEntities.length > 0) {
    const shown = obs.visibleEntities.slice(0, maxVisible).map(describeEntity).join(' ');
    const extra = obs.visibleEntities.length - maxVisible;
    lines.push(`NEAR ${shown}${extra > 0 ? ` +${extra} more` : ''}`);
  }

  if (obs.recentEvents.length > 0) {
    const recent = obs.recentEvents.slice(-maxEvents).map((e) => e.type);
    lines.push(`SEEN ${recent.join(',')}`);
  }

  if (obs.memories.length > 0) {
    lines.push('RECALL');
    for (const item of obs.memories.slice(0, maxMemories)) {
      lines.push(`- ${shorten(item, limit)}`);
    }
  }

  lines.push('ACTIONS');
  for (const id of obs.availableActions) {
    const info = lens.info(id);
    const duration = info ? info.duration : 1;
    const params = info ? renderParams(info.params) : '';
    const targets = info && info.targetTypes.length > 0 ? ` ->${info.targetTypes.join('|')}` : '';
    const description = info && info.description ? ` : ${shorten(info.description, limit)}` : '';
    lines.push(`- ${id} (${duration}t) [${params}]${targets}${description}`);
  }
  lines.push('Choose one. JSON only.');
  return lines.join('\n');
}

export interface RenderedPrompt {
  system: string;
  user: string;
}

export function renderPrompt(
  obs: Observation,
  lens: WorldLens,
  options: PromptOptions = {},
): RenderedPrompt {
  return { system: systemPrompt(options), user: userPrompt(obs, lens, options) };
}
