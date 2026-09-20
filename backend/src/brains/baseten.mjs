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
// Everything in this pool costs less than gpt-5.6-luna, the model the OpenAI brain runs, so
// a village of these is unambiguously the cheaper village. Of the seventeen models Baseten
// serves, exactly three are (check-brain --list ranks them): these two, at 0.45x and 0.60x
// luna a decision, and OpenAI's own gpt-oss-120b, which has no business in a pool meant to
// stand against OpenAI. Everything else is dearer — V4.1 Flash by 1.27x, Inkling Small 1.8x,
// Kimi K2.6 4.1x, Kimi K3 nearly fourteen. Name one in BASETEN_MODELS if you want it anyway.
//
// A decision is input-heavy — about 1,400 tokens of observation in, 200 out — so the input
// price is most of what a run pays, and a model dear on input is dear.
export const DEFAULT_POOL = [
  'zai-org/GLM-5.3-Flash',
  'deepseek-ai/DeepSeek-V4-Flash-0731',
];

// Baseten publishes what each model costs on /v1/models, so the run asks rather than
// carries a table: a table went wrong twice here, once by a factor of ten (that page's
// middle column is Cache Input, not Output). These are only the fallback, for a run whose
// catalogue call fails — the pool's three models, at the prices read on 2026-09-19.
const FALLBACK_PRICE = {
  'zai-org/GLM-5.3-Flash': [0.15, 0.50],
  'deepseek-ai/DeepSeek-V4-Flash-0731': [0.13, 0.26],
};

// What every model Baseten serves costs, $ per 1M tokens [input, output]. One call at the
// start of a run; a run whose call fails still prices its own pool from the fallback.
export async function livePrices(key = process.env.BASETEN_API_KEY) {
  try {
    const r = await fetch(`${BASE_URL}/models`, { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const priced = {};
    for (const m of (await r.json()).data)
      priced[m.id] = [+m.pricing.prompt * 1e6, +m.pricing.completion * 1e6];
    return priced;
  } catch (e) {
    console.warn(`  baseten: could not read the price list (${e.message}); using the prices in baseten.mjs`);
    return { ...FALLBACK_PRICE };
  }
}

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

export async function basetenBrain() {
  const pool = basetenPool();
  const price = await livePrices();
  return chatBrain({
    label: pool.length === 1 ? `baseten (${pool[0]})` : `baseten (${pool.length} models)`,
    client: new OpenAI({ baseURL: BASE_URL, apiKey: process.env.BASETEN_API_KEY }),
    pickModel: a => modelFor(a.id, pool, CFG.AGENTS),
    price: model => price[model] ?? FALLBACK_PRICE[model] ?? [0, 0],
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
