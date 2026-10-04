// Who the village thinks with. Every provider here speaks OpenAI's chat-completions wire
// format — same tools, same tool_calls, same usage block — so they all run the one decision
// loop in chat.mjs and differ only in where the request goes, whose key signs it, which
// model answers and what that costs.
//
// Adding a provider is one entry below. Or no code at all: PROVIDER=foo with FOO_BASE_URL,
// FOO_API_KEY and MODEL in .env runs any OpenAI-compatible endpoint (FOO_PRICE=in,out in
// $ per 1M tokens if the run should be costed).
//
//   baseURL    the endpoint; left out, the SDK's own default (api.openai.com)
//   key        the env var holding the API key
//   model      what runs when MODEL doesn't name one
//   prices     slug => $ per 1M tokens [input, output, cached input?]; a model not listed counts tokens, no cost
//   cachedRate what a cached input token costs, as a share of the input price (1 = no discount)
//   tokenParam the name the endpoint gives the reply's token budget. Most take max_tokens;
//              OpenAI's gpt-5 family refuses it and wants max_completion_tokens.
//   maxTokens  that budget. A reply cut off here reads as a villager who never answered.
//   params     (slug, api) => anything else the request needs
//   api        () => 'responses' to speak OpenAI's Responses API instead of Chat Completions
import OpenAI from 'openai';
import { CFG } from '../config.mjs';
import { chatBrain } from './chat.mjs';

export const PROVIDERS = {
  openai: {
    key: 'OPENAI_API_KEY',
    model: 'gpt-6-luna',
    // standard tier, checked 2026-10-04 (gpt-6-luna) and 2026-09-19 (the rest)
    prices: {
      'gpt-6-luna': [0.10, 0.50], 'gpt-5.6-luna': [0.20, 1.20],
      'gpt-4.1-nano': [0.10, 0.40], 'gpt-4.1-mini': [0.40, 1.60], 'gpt-4o-mini': [0.15, 0.60],
      'gpt-5-nano': [0.05, 0.40], 'gpt-5-mini': [0.25, 2.00], 'gpt-5.4-nano': [0.20, 1.25],
    },
    cachedRate: 0.1,
    tokenParam: 'max_completion_tokens',
    // gpt-5.x and gpt-6 models reason by default, and chat completions refuses tools unless reasoning
    // is off. Off is also faster and cheaper — this is a quick decision. REASONING_EFFORT
    // turns it on, and then the run speaks the Responses API, the one place these models
    // will think and call tools in the same request.
    // Every villager sends the same system prompt and the same tool schemas — ~78% of the
    // request, and identical until a dial moves. One key for the whole village keeps those
    // requests on the same cache, so that prefix is read, not re-read.
    api: () => effort() !== 'none' ? 'responses' : 'chat',
    // reasoning is billed as output and spent before the first tool call, so it needs room
    maxTokens: () => effort() !== 'none' ? 4000 : 1000,
    params: (model, api) => ({
      prompt_cache_key: 'moku-village',
      ...(CFG.SERVICE_TIER ? { service_tier: CFG.SERVICE_TIER } : {}),
      ...(api === 'responses' ? { reasoning: { effort: effort(), summary: 'auto' }, store: false, include: ['reasoning.encrypted_content'] }
        : /^gpt-[56]/.test(model) ? { reasoning_effort: 'none' } : {}),
    }),
  },
  deepinfra: {
    baseURL: 'https://api.deepinfra.com/v1/openai',
    key: 'DEEPINFRA_API_KEY',
    model: 'openai/gpt-oss-120b',
    // checked 2026-10-03. Run another with MODEL=<slug>; one not listed here is not costed.
    prices: {
      'openai/gpt-oss-120b': [0.037, 0.17, 0.03],
      'deepseek-ai/DeepSeek-V4-Flash-0731': [0.06, 0.18, 0.015],
      'nvidia/NVIDIA-Nemotron-3.5-Lightning': [0.06, 0.16, 0.03],
    },
    // A villager's decision is not worth reasoning about at length: left to think, a model
    // spends its whole reply on it and is cut off before a single tool call. gpt-oss always
    // reasons and 'low' is the least it will do; the rest are asked for none. The budget is
    // roomier than OpenAI's for one that ignores the setting anyway.
    maxTokens: 1500,
    params: model => ({ reasoning_effort: CFG.REASONING_EFFORT || (model.includes('gpt-oss') ? 'low' : 'none') }),
  },
};

const effort = () => CFG.REASONING_EFFORT || 'none';
const val = x => typeof x === 'function' ? x() : x;

// A provider named in .env and nowhere above, spelled out by its own env vars.
function fromEnv(name) {
  const P = name.toUpperCase().replace(/[^A-Z0-9]/g, '_'), env = process.env;
  if (!env[`${P}_BASE_URL`]) return null;
  const price = (env[`${P}_PRICE`] ?? '').split(',').map(Number);
  return { baseURL: env[`${P}_BASE_URL`], key: `${P}_API_KEY`, model: '',
           prices: price.length === 2 && price.every(Number.isFinite) ? { '*': price } : {} };
}
const lookup = name => PROVIDERS[name] ?? fromEnv(name);

// What the dashboard offers: the free stub, everything above, and .env's own if it is neither.
export const providerNames = () => [...new Set(['stub', ...Object.keys(PROVIDERS),
  ...(lookup(CFG.PROVIDER) ? [CFG.PROVIDER] : [])])];

// The model a run on this provider thinks with. MODEL belongs to the provider .env names:
// picking another one on the dashboard runs that provider's own default, never a slug the
// other endpoint has not heard of.
export const modelFor = (name, model) =>
  model || (name === CFG.PROVIDER && CFG.MODEL) || lookup(name)?.model || '';

// Why this provider can't run, or null if it can.
export function missing(name, model) {
  const p = lookup(name);
  if (!p) return `no provider called "${name}" (add it to brains/providers.mjs, or set ${name.toUpperCase()}_BASE_URL)`;
  if (!process.env[p.key]) return `${p.key} is not set in the repo-root .env`;
  if (!modelFor(name, model)) return 'MODEL is not set, and this provider has no default';
  return null;
}

export function providerBrain(name, model) {
  const p = lookup(name), slug = modelFor(name, model), api = val(p.api) ?? 'chat';
  // the label is what a saved run is known by, so a setting that changes the run is in it
  const tags = [CFG.REASONING_EFFORT && `reasoning ${CFG.REASONING_EFFORT}`, CFG.SERVICE_TIER].filter(Boolean);
  return chatBrain({
    label: `${name} (${[slug, ...tags].join(', ')})`,
    client: new OpenAI({ apiKey: process.env[p.key], ...(p.baseURL ? { baseURL: p.baseURL } : {}) }),
    pickModel: () => slug,
    price: m => p.prices?.[m] ?? p.prices?.['*'] ?? [0, 0],
    params: p.params && (m => p.params(m, api)),
    cachedRate: p.cachedRate,
    tokenParam: p.tokenParam,
    maxTokens: val(p.maxTokens),
    api,
  });
}
