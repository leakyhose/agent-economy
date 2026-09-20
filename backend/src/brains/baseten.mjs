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
// The rule for this pool: cheap, and no dearer than gpt-5.6-luna, the model the OpenAI brain
// runs ($0.20 / $1.20 per 1M tokens). Every one of these undercuts it — $0.30 a side at the
// very worst, against luna's $1.20 on output — so the two brains sit in the same cost class
// and a run compares the models rather than the budget. A village is 30 agents deciding
// every round for hundreds of rounds, so that matters more than it looks.
// Set BASETEN_MODELS to run a different pool, or MODEL to put the whole village on one.
export const DEFAULT_POOL = [
  'zai-org/GLM-5.3-Flash',
  'deepseek-ai/DeepSeek-V4.1-Flash',
  'deepseek-ai/DeepSeek-V4-Flash-0731',
  'openai/gpt-oss-120b',
];

// $ per 1M tokens [input, output], from baseten.co/products/model-apis, checked 2026-09-19.
// UNVERIFIED: that page lists its input column above its output column, which is backwards
// from every other provider, so these may be transposed. A model with no price here still
// counts tokens; it just reports no cost. Correct them against a real bill.
//
// The pro, code and frontier models are priced here only for anyone who names one in
// BASETEN_MODELS; the default pool above stays with the flash-class four.
const PRICE = {
  'zai-org/GLM-5.3-Flash': [0.15, 0.03],
  'zai-org/GLM-5.3': [1.40, 0.14],
  'zai-org/GLM-5.2': [1.40, 0.14],
  'zai-org/GLM-5.2-Fast': [2.10, 0.21],
  'deepseek-ai/DeepSeek-V4.1-Flash': [0.30, 0.03],
  'deepseek-ai/DeepSeek-V4-Flash-0731': [0.13, 0.028],
  'deepseek-ai/DeepSeek-V4-Pro': [1.74, 0.145],
  'deepseek-ai/DeepSeek-V4-Pro-0813': [1.32, 0.132],
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

// Same seed, same line-up: agent 3 draws the same model every run, the way its name and its
// talents are drawn (CFG.SEED). Random across agents, repeatable across runs — otherwise two
// runs of the same village couldn't be compared at all.
export function modelFor(id, pool) {
  let h = Math.imul((CFG.SEED ^ 0x9e3779b9) >>> 0, 0x85ebca6b) >>> 0;
  h = Math.imul((h ^ id) >>> 0, 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;      // XOR gives back a SIGNED int32; unsign it or the index goes negative
  return pool[h % pool.length];
}

export function basetenBrain() {
  const pool = basetenPool();
  return chatBrain({
    label: pool.length === 1 ? `baseten (${pool[0]})` : `baseten (${pool.length} models)`,
    client: new OpenAI({ baseURL: BASE_URL, apiKey: process.env.BASETEN_API_KEY }),
    pickModel: a => modelFor(a.id, pool),
    price: model => PRICE[model] ?? [0, 0],
  });
}
