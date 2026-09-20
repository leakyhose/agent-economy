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
// A decision is input-heavy — about 2,000 tokens of observation in, 100 out — so the input
// price is what a run really pays. Against luna's $0.0005 a decision: GLM 5.3 Flash and the
// DeepSeek Flashes land at a third of that or less, Inkling Small at about double, and Kimi
// K2.6 at about four times, which makes it the one to drop first if the bill bites
// (BASETEN_MODELS, or MODEL to put the whole village on one model).
export const DEFAULT_POOL = [
  'zai-org/GLM-5.3-Flash',
  'deepseek-ai/DeepSeek-V4.1-Flash',
  'deepseek-ai/DeepSeek-V4-Flash-0731',
  'thinkingmachines/inkling-small',
  'moonshotai/Kimi-K2.6',
];

// $ per 1M tokens [input, output], from baseten.co/products/model-apis, checked 2026-09-19.
// Its columns read "Input, Cache Input, Output", so output really is the cheaper side here —
// these models are priced the other way round from OpenAI's. A model with no price counts
// tokens and reports no cost. The pro, code and frontier models are listed only for anyone
// who names one in BASETEN_MODELS; the pool above doesn't use them.
const PRICE = {
  'zai-org/GLM-5.3-Flash': [0.15, 0.03],
  'zai-org/GLM-5.3': [1.40, 0.14],
  'zai-org/GLM-5.2': [1.40, 0.14],
  'zai-org/GLM-5.2-Fast': [2.10, 0.21],
  'deepseek-ai/DeepSeek-V4.1-Flash': [0.30, 0.03],
  'deepseek-ai/DeepSeek-V4-Flash-0731': [0.13, 0.028],
  'deepseek-ai/DeepSeek-V4-Pro': [1.74, 0.145],
  'deepseek-ai/DeepSeek-V4-Pro-0813': [1.32, 0.132],
  // Baseten doesn't publish a rate for K2.6; this is Moonshot's own, so its cost line is an
  // estimate until a bill says otherwise.
  'moonshotai/Kimi-K2.6': [0.95, 4.00],
  'moonshotai/Kimi-K3': [3.00, 0.30],
  'moonshotai/Kimi-K2.7-Code': [0.95, 0.16],
  'nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B': [0.60, 0.12],
  'thinkingmachines/inkling': [1.00, 0.17],
  'thinkingmachines/inkling-small': [0.50, 0.10],
  'openai/gpt-oss-120b': [0.10, 0.10],
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
  });
}
