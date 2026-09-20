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
// Four houses, four minds, one villager in four thinking with each. A model earns its place
// by clearing three bars, every one of them measured rather than assumed — the measuring is
// backend/scripts/check-brain.sh, and it is worth re-running when the pool changes.
//
//   willing - it answers a village's worth of requests at once. Baseten meters most models
//             at 120 concurrent and a handful at 15. gpt-oss-120b is one of the 15 and
//             still served 8 at once without a murmur, so the number is a ceiling, not a
//             promise of trouble; GLM 5.3 Flash, also 15, turned two villagers in seven
//             away under load, and is not here because of it.
//   quick   - it decides inside the round's clock. These run 0.5-3.1s against a 10s wait.
//             Kimi K2.6 is out on this bar: mostly 1.5s, but it talks itself through the
//             problem in prose when the observation runs long, and one villager in nine
//             went past 8s and posted nothing at all.
//   able    - it calls tools, which is the only way a villager acts on anything.
//
// They are not equally cheap and the village pays the average. Per decision against
// gpt-5.6-luna, the model the OpenAI brain runs: DeepSeek V4 Flash 0.45x, gpt-oss-120b
// 0.46x, Inkling Small 1.81x, Nemotron 2.54x — about 1.3x luna for the mixture, which is
// what the comparison costs. check-brain --list ranks the whole catalogue live.
//
// gpt-oss-120b is OpenAI's, which for a while kept it out of a pool meant to stand against
// OpenAI. It earns its place on the other reading: open weights that anyone can serve,
// running here on Baseten's hardware, against gpt-5.6-luna behind OpenAI's API.
//
// For the cheapest village instead, one env var and no code change:
//   BASETEN_MODELS=deepseek-ai/DeepSeek-V4-Flash-0731
export const DEFAULT_POOL = [
  'deepseek-ai/DeepSeek-V4-Flash-0731',
  'openai/gpt-oss-120b',
  'thinkingmachines/inkling-small',
  'nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B',
];

// Baseten publishes what each model costs on /v1/models, so the run asks rather than
// carries a table: a table went wrong twice here, once by a factor of ten (that page's
// middle column is Cache Input, not Output). These are only the fallback, for a run whose
// catalogue call fails — the pool's four models, at the prices read on 2026-09-19.
const FALLBACK_PRICE = {
  'deepseek-ai/DeepSeek-V4-Flash-0731': [0.13, 0.26],
  'thinkingmachines/inkling-small': [0.50, 1.20],
  'nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B': [0.60, 2.40],
  'openai/gpt-oss-120b': [0.10, 0.50],
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

// What Baseten will run at once for a model, from the x-ratelimit-limit-requests header on
// a throwaway call — one per model at the start of a run. The catalogue splits in two: most
// models answer 120 at a time, a handful only 15, and the narrow ones turn requests away
// under a village's load however politely it asks. Half the ceiling is the gate, so retries
// and the odd slow reply have somewhere to go.
export async function liveLimits(pool, key = process.env.BASETEN_API_KEY) {
  const limits = {};
  await Promise.all(pool.map(async model => {
    try {
      const r = await fetch(`${BASE_URL}/chat/completions`, { method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_completion_tokens: 5, messages: [{ role: 'user', content: 'ok' }] }) });
      await r.text();
      const n = +(r.headers.get('x-ratelimit-limit-requests') ?? 0);
      if (n > 0) limits[model] = Math.max(2, Math.floor(n / 2));
    } catch { /* no header, no gate: the global one still applies */ }
  }));
  return limits;
}

export async function basetenBrain() {
  const pool = basetenPool();
  const [price, limits] = await Promise.all([livePrices(), liveLimits(pool)]);
  const tight = Object.entries(limits).filter(([, n]) => n < 10);
  if (tight.length) console.warn(`  baseten: ${tight.map(([m, n]) => `${m.split('/').pop()} allows ${n * 2} at once`).join(', ')} - villagers on it will queue`);
  return chatBrain({
    label: pool.length === 1 ? `baseten (${pool[0]})` : `baseten (${pool.length} models)`,
    client: new OpenAI({ baseURL: BASE_URL, apiKey: process.env.BASETEN_API_KEY }),
    pickModel: a => modelFor(a.id, pool, CFG.AGENTS),
    price: model => price[model] ?? FALLBACK_PRICE[model] ?? [0, 0],
    concurrency: model => limits[model] ?? 0,
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
