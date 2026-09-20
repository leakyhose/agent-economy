// Claude brain. The agent reads its situation, then acts through tools — the same
// tools the stub uses. One API call per decision in the common case; another only
// if it spends a turn looking around without choosing a shift, or an action was refused.
import Anthropic from '@anthropic-ai/sdk';
import { CFG } from '../config.mjs';

import { systemPrompt } from './prompt.mjs';

function semaphore(n) {
  let active = 0; const q = [];
  return async fn => {
    if (active >= n) await new Promise(r => q.push(r));
    active++;
    try { return await fn(); } finally { active--; q.shift()?.(); }
  };
}

export function claudeBrain() {
  const client = new Anthropic();
  const limit = semaphore(CFG.LLM_CONCURRENCY);
  const s = { calls: 0, inTok: 0, outTok: 0, cacheRead: 0, errors: 0, rateLimited: 0, timedOut: 0 };

  return {
    name: `claude (${CFG.MODEL})`,
    stats: () => ({ ...s,
      cost: (s.inTok - s.cacheRead) / 1e6 * 1 + s.cacheRead / 1e6 * 0.1 + s.outTok / 1e6 * 5 }),

    async decide(a, t) {
      const messages = [{ role: 'user', content: t.observe() }];
      for (let turn = 0; turn < 3; turn++) {
        let r;
        try {
          r = await limit(() => client.messages.create({
            model: CFG.MODEL,
            max_tokens: 400,
            system: systemPrompt(),
            tools: t.defs,
            cache_control: { type: 'ephemeral' },
            messages,
          }, { signal: t.signal }));
        } catch (e) {
          if (t.signal?.aborted) { s.timedOut++; return; }   // the round stopped waiting

          if (e instanceof Anthropic.RateLimitError) { s.rateLimited++; await new Promise(r => setTimeout(r, 2000)); continue; }
          s.errors++;
          if (s.errors <= 3) console.error(`[claude] ${e.status ?? ''} ${e.message}`);
          return;                      // not an answer: the agent keeps its last job and posts no orders
        }
        s.calls++;
        s.inTok += r.usage.input_tokens + (r.usage.cache_read_input_tokens ?? 0) + (r.usage.cache_creation_input_tokens ?? 0);
        s.cacheRead += r.usage.cache_read_input_tokens ?? 0;
        s.outTok += r.usage.output_tokens;

        t.acted.answered = true;
        const text = r.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
        if (text) a.thought = text.slice(0, 240);
        const uses = r.content.filter(b => b.type === 'tool_use');
        if (!uses.length) return;

        t.acted.failed = false;
        // A tool call cut off by the token limit carries incomplete arguments: never run it
        // with what's there. Tell the model, and give it another turn.
        const cut = r.stop_reason === 'max_tokens' ? uses.at(-1) : null;
        const results = uses.map(u => ({ type: 'tool_result', tool_use_id: u.id,
          ...(u === cut || !u.input || typeof u.input !== 'object' || Array.isArray(u.input)
            ? { is_error: true, content: t.badCall(u.name, JSON.stringify(u.input), u === cut ? 'it was cut off at the length limit' : 'arguments must be a JSON object') }
            : { content: t.exec(u.name, u.input) }) }));
        // Done once a shift is chosen and nothing was refused — unless the shift was the ONLY
        // thing in the first reply. Orders used to register only if the model happened to send
        // them in the same reply as the shift; when a wording change made it answer one call at
        // a time, 79% of turns ended before an order could be posted and the market died. A
        // lone shift now gets one follow-up turn (tools.mjs says so in the shift's result).
        if (t.acted.activity && !t.acted.failed && (turn > 0 || uses.length > 1)) return;
        messages.push({ role: 'assistant', content: r.content }, { role: 'user', content: results });
      }
    },
  };
}
