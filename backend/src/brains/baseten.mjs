// Baseten brain. Same tools, same prompt, same interface as the OpenAI brain — Baseten's
// Model APIs speak the OpenAI Chat Completions format, so this reuses that SDK pointed at
// Baseten's endpoint. Lets the village run on open-source models (GLM, DeepSeek, Kimi,
// GPT-OSS, Nemotron, ...) via a single BASETEN_API_KEY.
import OpenAI from 'openai';
import { CFG } from '../config.mjs';
import { SYSTEM } from './prompt.mjs';

function semaphore(n) {
  let active = 0; const q = [];
  return async fn => {
    if (active >= n) await new Promise(r => q.push(r));
    active++;
    try { return await fn(); } finally { active--; q.shift()?.(); }
  };
}

export function basetenBrain() {
  const client = new OpenAI({
    apiKey: process.env.BASETEN_API_KEY,
    baseURL: 'https://inference.baseten.co/v1',
  });
  const limit = semaphore(CFG.LLM_CONCURRENCY);
  const s = { calls: 0, inTok: 0, outTok: 0, errors: 0, rateLimited: 0, timedOut: 0 };

  return {
    name: `baseten (${CFG.MODEL})`,
    // Baseten bills per model at rates that vary by provider; not tracked here.
    stats: () => ({ ...s, cost: 0 }),

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
          }, { signal: t.signal }));
        } catch (e) {
          if (t.signal?.aborted) { s.timedOut++; return; }   // the round stopped waiting

          if (e instanceof OpenAI.RateLimitError) { s.rateLimited++; await new Promise(r => setTimeout(r, 2000)); continue; }
          s.errors++;
          if (s.errors <= 3) console.error(`[baseten] ${e.status ?? ''} ${e.message}`);
          return;
        }
        s.calls++;
        s.inTok += r.usage?.prompt_tokens ?? 0;
        s.outTok += r.usage?.completion_tokens ?? 0;

        t.acted.answered = true;
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
