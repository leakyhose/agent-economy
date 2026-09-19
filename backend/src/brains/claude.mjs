// Claude brain. The agent reads its situation, then acts through tools — the same
// tools the stub uses. One API call per decision in the common case; a second only
// if it spends its first turn looking around without choosing a shift.
import Anthropic from '@anthropic-ai/sdk';
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

export function claudeBrain() {
  const client = new Anthropic();
  const limit = semaphore(CFG.LLM_CONCURRENCY);
  const s = { calls: 0, inTok: 0, outTok: 0, cacheRead: 0, errors: 0, rateLimited: 0 };

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
            system: SYSTEM,
            tools: t.defs,
            cache_control: { type: 'ephemeral' },
            messages,
          }));
        } catch (e) {
          if (e instanceof Anthropic.RateLimitError) { s.rateLimited++; await new Promise(r => setTimeout(r, 2000)); continue; }
          s.errors++;
          if (s.errors <= 3) console.error(`[claude] ${e.status ?? ''} ${e.message}`);
          return;                      // agent sits out one round; server marks it idle
        }
        s.calls++;
        s.inTok += r.usage.input_tokens + (r.usage.cache_read_input_tokens ?? 0) + (r.usage.cache_creation_input_tokens ?? 0);
        s.cacheRead += r.usage.cache_read_input_tokens ?? 0;
        s.outTok += r.usage.output_tokens;

        const text = r.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
        if (text) a.thought = text.slice(0, 240);
        const uses = r.content.filter(b => b.type === 'tool_use');
        if (!uses.length) return;

        const results = uses.map(u => ({ type: 'tool_result', tool_use_id: u.id, content: t.exec(u.name, u.input) }));
        if (t.acted.activity) return;  // chose a shift — done, no need to spend another call
        messages.push({ role: 'assistant', content: r.content }, { role: 'user', content: results });
      }
    },
  };
}
