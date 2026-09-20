// Baseten brain. Baseten's Model APIs are OpenAI-compatible — same endpoint shape, same
// tool calling — so this is chat.mjs pointed at a different base URL with a different key.
//
// What it adds is a village of mixed minds. Every agent draws a model at birth and keeps
// it for the whole run, so a run says something about the models as well as about the
// economy: the dashboard shows who thinks with what, and the stats are kept per model, so
// two models can be compared on the same prices, the same talents and the same weather.
import OpenAI from 'openai';
import { CFG } from '../config.mjs';
import { chatBrain } from './chat.mjs';

export const BASE_URL = 'https://inference.baseten.co/v1';

// Small, fast, cheap models that all support tool calling. A villager has DECIDE_TIMEOUT_MS
// (8s by default) to choose a shift and post its orders, so time to first token matters more
// here than depth: these are the flash-class models, never the pro or code ones.
//
// Four houses, none of them OpenAI's: the point of this brain is to put other people's
// models beside gpt-5.6-luna, so an OpenAI model in the pool would only muddy the reading.
//
// A decision is input-heavy — about 2,000 tokens of observation in, a few hundred out — so
// the input price is what a run really pays. Of the seventeen models Baseten serves, only
// GLM 5.3 Flash and DeepSeek V4 Flash undercut gpt-5.6-luna ($0.20 / $1.20) on both sides
// without being an OpenAI model; V4.1 Flash is half again as dear on input and level on
// output, which is close enough to belong. Everything else — Kimi, Nemotron, Inkling, the
// Pros, the full GLMs — costs multiples of luna. Name one in BASETEN_MODELS if you want it.
export const DEFAULT_POOL = [
  'zai-org/GLM-5.3-Flash',
  'deepseek-ai/DeepSeek-V4.1-Flash',
  'deepseek-ai/DeepSeek-V4-Flash-0731',
];

// $ per 1M tokens [input, output], from baseten.co/products/model-apis, checked 2026-09-19.
// That table has three columns — Input, Cache Input, Output — and the middle one is easy to
// read as the last: these were briefly priced at a tenth of the truth because of it.
// A model with no price here still counts tokens; it just reports no cost.
const PRICE = {
  'zai-org/GLM-5.3-Flash': [0.15, 0.50],
  'zai-org/GLM-5.3': [1.40, 4.40],
  'zai-org/GLM-5.2': [1.40, 4.40],
  'zai-org/GLM-5.2-Fast': [2.10, 6.60],
  'deepseek-ai/DeepSeek-V4.1-Flash': [0.30, 1.20],
  'deepseek-ai/DeepSeek-V4-Flash-0731': [0.13, 0.26],
  'deepseek-ai/DeepSeek-V4-Pro': [1.74, 3.48],
  'deepseek-ai/DeepSeek-V4-Pro-0813': [1.32, 3.96],
  'moonshotai/Kimi-K3': [3.00, 15.00],
  'moonshotai/Kimi-K2.7-Code': [0.95, 4.00],
  'nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B': [0.60, 2.40],
  'thinkingmachines/inkling': [1.00, 4.05],
  'thinkingmachines/inkling-small': [0.50, 1.20],
  'openai/gpt-oss-120b': [0.10, 0.50],
};

// CFG.BASETEN_MODELS is the pool when it is set (and config.mjs folds a MODEL chosen for
// baseten into it, so naming one model puts the whole village on it); otherwise the default.
export function basetenPool() {
  const listed = CFG.BASETEN_MODELS.split(',').map(m => m.trim()).filter(Boolean);
  return listed.length ? listed : DEFAULT_POOL;
}

function hash(id) {
  let h = Math.imul((CFG.SEED ^ 0x9e3779b9) >>> 0, 0x85ebca6b) >>> 0;
  h = Math.imul((h ^ id) >>> 0, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;   // XOR gives back a SIGNED int32; unsign it or the index goes negative
}

// Deal, don't draw. Drawing each villager's model independently left the pool lumpy — eleven
// villagers on one model and three on another at 30 agents — and then a comparison between
// two models is also a comparison between a big sample and a small one. So the villagers are
// shuffled by a seeded hash and the pool is dealt round the table: who gets what is random,
// how many each model gets is even. Same seed, same deal, so runs stay comparable.
const deals = new Map();
export function deal(pool, n = CFG.AGENTS) {
  const key = `${n}|${pool.join(',')}`;
  let byId = deals.get(key);
  if (!byId) {
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => hash(a) - hash(b) || a - b);
    byId = new Array(n);
    order.forEach((id, seat) => { byId[id] = pool[seat % pool.length]; });
    deals.set(key, byId);
  }
  return byId;
}

// A villager past the deal (a check run with more agents than AGENTS) falls back to the hash.
export function modelFor(id, pool, n = CFG.AGENTS) {
  return deal(pool, n)[id] ?? pool[hash(id) % pool.length];
}

export function basetenBrain() {
  const pool = basetenPool();
  return chatBrain({
    label: pool.length === 1 ? `baseten (${pool[0]})` : `baseten (${pool.length} models)`,
    client: new OpenAI({ baseURL: BASE_URL, apiKey: process.env.BASETEN_API_KEY }),
    pickModel: a => modelFor(a.id, pool, CFG.AGENTS),
    price: model => PRICE[model] ?? [0, 0],
    // Every model here reasons by default, and a villager's decision is not worth reasoning
    // about at length: with it on, three agents in eight spent all 1,000 tokens thinking and
    // the answer was cut off before a single tool call — which the round reads as a villager
    // who never spoke, so it keeps last round's job and posts no orders. Off, the same
    // decisions come back in 18-50 tokens. A model that doesn't know the field ignores it.
    params: () => ({ reasoning_effort: 'none' }),
    // Headroom for one that ignores it anyway: better a few more output tokens than a
    // decision truncated mid-thought.
    maxTokens: 1500,
  });
}
