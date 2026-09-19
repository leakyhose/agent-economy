// The MIND half of each agent. The body (world.mjs) executes; this decides.
// Two modes:
//   stub — free, deterministic, used for development and for load-testing the economy
//   llm  — Claude Haiku 4.5, one call per agent per decision point
// Same interface either way, so the world never knows which is running.

import { TOOL } from './world.mjs';

const MODEL = 'claude-haiku-4-5';

// Stable across every agent and every tick -> this is the cached prefix.
const RULES = `You are one villager in a small economy. You decide what to do next; a separate
system walks you there and does the work.

The village produces three goods:
  fish  — food. Everyone must eat. Caught at the docks.
  wood  — cut in the forest.
  ore   — mined in the hills.

Tools double your output: boat (fish), axe (wood), pick (ore). Tools cost money and wear out.
A work shift takes about 8 ticks. You sell what you produce at a daily market where the price
is set by supply and demand — not by you.

Choose ONE action:
  work    — work a trade this shift. Pick fish, wood, or ore.
  buy     — buy a tool for your current trade, if you can afford it.
  rest    — do nothing this shift. Rarely correct.

Also choose how to price what you sell:
  patient — hold out for a better price
  normal
  urgent  — undercut to sell fast (do this if you are hungry or broke)

Decide in your own interest. You are not coordinating with anyone. Keep your reason under
12 words, concrete, and in your own voice.`;

export function createMind(mode = 'stub') {
  if (mode === 'stub') return { mode, decide: stubDecide, stats: () => ({ calls: 0, cost: 0 }) };

  let client, zodOutputFormat, z, calls = 0, inTok = 0, cacheRead = 0, outTok = 0;
  const ready = (async () => {
    const [{ default: Anthropic }, zod, helpers] = await Promise.all([
      import('@anthropic-ai/sdk'), import('zod'), import('@anthropic-ai/sdk/helpers/zod'),
    ]);
    client = new Anthropic(); z = zod.z; zodOutputFormat = helpers.zodOutputFormat;
  })();

  async function llmDecide(a, ctx) {
    await ready;
    const Schema = z.object({
      action:  z.enum(['work', 'buy', 'rest']),
      job:     z.enum(['fish', 'wood', 'ore']),
      pricing: z.enum(['patient', 'normal', 'urgent']),
      reason:  z.string(),
    });
    try {
      const r = await client.messages.parse({
        model: MODEL,
        max_tokens: 200,
        cache_control: { type: 'ephemeral' },        // caches RULES across all agents
        system: RULES,
        messages: [{ role: 'user', content: situation(a, ctx) }],
        output_config: { format: zodOutputFormat(Schema) },
      });
      calls++;
      inTok += r.usage?.input_tokens ?? 0;
      cacheRead += r.usage?.cache_read_input_tokens ?? 0;
      outTok += r.usage?.output_tokens ?? 0;
      return r.parsed_output ?? stubDecide(a, ctx);
    } catch (e) {
      if (!llmDecide.warned) { console.error(`[mind] LLM failed, falling back to stub: ${e.message}`); llmDecide.warned = true; }
      return stubDecide(a, ctx);
    }
  }
  return { mode, decide: llmDecide,
    stats: () => ({ calls, inTok, cacheRead, outTok,
      cost: (inTok - cacheRead) / 1e6 * 1 + cacheRead / 1e6 * 0.1 + outTok / 1e6 * 5 }) };
}

// The volatile half of the prompt — everything specific to this agent, this moment.
function situation(a, ctx) {
  const board = ctx.info === 'local'
    ? `${a.job}: ${ctx.price[a.job].toFixed(2)} (you only follow your own trade)`
    : Object.entries(ctx.price).map(([g, p]) => `${g}: ${p.toFixed(2)}${ctx.trend[g] ? ` (${ctx.trend[g] > 0 ? '+' : ''}${(ctx.trend[g] * 100).toFixed(0)}% over 10 ticks)` : ''}`).join(', ');
  const tool = TOOL[a.job];
  return [
    `You are ${a.name}. Trade: ${a.job}.`,
    `Cash ${a.cash.toFixed(1)}. Holding — fish ${a.inv.fish.toFixed(1)}, wood ${a.inv.wood.toFixed(1)}, ore ${a.inv.ore.toFixed(1)}.`,
    `Tools: ${Object.keys(a.tools).join(', ') || 'none'}. A ${tool} costs ${ctx.toolCost[tool]}.`,
    a.hunger > 0 ? `You are HUNGRY (${a.hunger} missed meals).` : `You are fed.`,
    `Market: ${board}`,
    ctx.news.length ? `Word around the village: ${ctx.news.join(' ')}` : '',
    `Your temperament: risk ${a.traits.risk}, patience ${a.traits.patience}, herding ${a.traits.herding}.`,
    `You just finished a shift. What now?`,
  ].filter(Boolean).join('\n');
}

// Free stand-in. Roughly what a rational villager would do — good enough to exercise
// the economy without spending money on every test run.
function stubDecide(a, ctx) {
  const tool = TOOL[a.job];
  const earn = g => ctx.price[g] * (a.tools[TOOL[g]] ? 2 : 1);
  const best = ['fish', 'wood', 'ore'].sort((x, y) => earn(y) - earn(x))[0];

  if (a.hunger > 1 && a.inv.fish < 1)
    return { action: 'work', job: 'fish', pricing: 'urgent', reason: "I'm hungry. Fish first." };
  if (!a.tools[tool] && a.cash > ctx.toolCost[tool] * (1.3 + a.traits.risk))
    return { action: 'buy', job: a.job, pricing: 'normal', reason: `Saved enough for a ${tool}. It pays for itself.` };
  if (best !== a.job && earn(best) > earn(a.job) * (1.25 + 0.7 * a.traits.patience))
    return { action: 'work', job: best, pricing: 'normal', reason: `${best} pays better than ${a.job} now. Switching.` };
  return { action: 'work', job: a.job, pricing: a.cash < 10 ? 'urgent' : 'normal',
           reason: a.cash < 10 ? `Low on cash — selling cheap to move it.` : `Sticking with ${a.job}.` };
}
