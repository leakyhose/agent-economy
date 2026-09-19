// OpenAI brain. Same tools, same prompt, same interface as the Claude brain.
import OpenAI from 'openai';
import { CFG } from '../config.mjs';
import { SYSTEM } from './prompt.mjs';

// $ per 1M tokens [input, output], standard tier, checked 2026-09-19
const PRICE = {
  'gpt-5.6-luna': [0.20, 1.20],
  'gpt-4.1-nano': [0.10, 0.40], 'gpt-4.1-mini': [0.40, 1.60], 'gpt-4o-mini': [0.15, 0.60],
  'gpt-5-nano': [0.05, 0.40], 'gpt-5-mini': [0.25, 2.00], 'gpt-5.4-nano': [0.20, 1.25],
};

function semaphore(n) {
  let active = 0; const q = [];
  return async fn => {
    if (active >= n) await new Promise(r => q.push(r));
    active++;
    try { return await fn(); } finally { active--; q.shift()?.(); }
  };
}

export function openaiBrain() {
  const client = new OpenAI();
  const limit = semaphore(CFG.LLM_CONCURRENCY);
  const [pin, pout] = PRICE[CFG.MODEL] ?? [0, 0];
  const s = { calls: 0, inTok: 0, outTok: 0, errors: 0, rateLimited: 0 };

  return {
    name: `openai (${CFG.MODEL})`,
    stats: () => ({ ...s, cost: s.inTok / 1e6 * pin + s.outTok / 1e6 * pout }),

    async decide(a, t) {
      const tools = t.defs.map(d => ({
        type: 'function', function: { name: d.name, description: d.description, parameters: d.input_schema },
      }));
      const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: t.observe() }];

      for (let turn = 0; turn < 3; turn++) {
        let r;
        try {
          r = await limit(() => client.chat.completions.create({
            model: CFG.MODEL, messages, tools, max_completion_tokens: 1000,
            // gpt-5.x models reason by default, and chat completions refuses tools unless
            // reasoning is off. Off is also faster and cheaper — this is a quick decision.
            ...(CFG.MODEL.startsWith('gpt-5') ? { reasoning_effort: 'none' } : {}),
          }));
        } catch (e) {
          if (e instanceof OpenAI.RateLimitError) { s.rateLimited++; await new Promise(r => setTimeout(r, 2000)); continue; }
          s.errors++;
          if (s.errors <= 3) console.error(`[openai] ${e.status ?? ''} ${e.message}`);
          return;
        }
        s.calls++;
        s.inTok += r.usage?.prompt_tokens ?? 0;
        s.outTok += r.usage?.completion_tokens ?? 0;

        const msg = r.choices[0].message;
        if (msg.content) a.thought = msg.content.trim().slice(0, 240);
        const calls = msg.tool_calls ?? [];
        if (!calls.length) return;

        t.acted.failed = false;
        // Arguments that aren't a JSON object (malformed, or cut off at the token limit)
        // are never run with defaults: the model is told, and gets another turn.
        const results = calls.map(c => {
          let args;
          try { args = JSON.parse(c.function.arguments || '{}'); } catch (e) {
            return { role: 'tool', tool_call_id: c.id, content: t.badCall(c.function.name, c.function.arguments, `invalid JSON: ${e.message}`) };
          }
          if (!args || typeof args !== 'object' || Array.isArray(args))
            return { role: 'tool', tool_call_id: c.id, content: t.badCall(c.function.name, c.function.arguments, 'arguments must be a JSON object') };
          return { role: 'tool', tool_call_id: c.id, content: t.exec(c.function.name, args) };
        });
        if (t.acted.activity && !t.acted.failed) return;   // chose a shift, nothing refused — done
        messages.push(msg, ...results);
      }
    },
  };
}
