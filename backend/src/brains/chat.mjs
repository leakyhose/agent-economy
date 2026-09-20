// The decision loop every OpenAI-protocol brain shares. Baseten's Model APIs speak the same
// wire format as OpenAI's chat completions — same tools, same tool_calls, same usage block —
// so the two brains differ only in which client they hold, what a model costs, and which
// model an agent thinks with. Everything that decides how a villager decides lives here.
import OpenAI from 'openai';
import { CFG } from '../config.mjs';
import { systemPrompt } from './prompt.mjs';

// The rate-limit headers the API sends with every reply, so a run can say why it was throttled.
const head = (h, k) => (typeof h?.get === 'function' ? h.get(k) : h?.[k]) ?? null;
function readLimits(h) {
  const n = k => head(h, k);
  return { requests: n('x-ratelimit-limit-requests'), requestsLeft: n('x-ratelimit-remaining-requests'),
           tokens: n('x-ratelimit-limit-tokens'), tokensLeft: n('x-ratelimit-remaining-tokens'),
           resetTokens: n('x-ratelimit-reset-tokens'), resetRequests: n('x-ratelimit-reset-requests') };
}
// "retry-after: 2" (seconds) or "retry-after-ms: 1300": wait as long as the API asks, not a
// guess. A provider that doesn't say gets 0.3s, 0.6s, 1.2s, 2.4s. Clamped so one 429 can't
// spend the whole round, and jittered so the whole village doesn't come back at the same instant.
function retryAfterMs(h, attempt) {
  const ms = Number(head(h, 'retry-after-ms'));
  const sec = Number(head(h, 'retry-after'));
  const asked = Number.isFinite(ms) && ms > 0 ? ms : Number.isFinite(sec) && sec > 0 ? sec * 1000 : 300 * 2 ** attempt;
  return Math.min(2400, asked) + Math.random() * 300;
}

export function semaphore(n) {
  let active = 0; const q = [];
  return async fn => {
    if (active >= n) await new Promise(r => q.push(r));
    active++;
    try { return await fn(); } finally { active--; q.shift()?.(); }
  };
}

// label     what the dashboard calls this brain
// client    an OpenAI-SDK client, pointed at whichever endpoint
// pickModel (agent) => slug. One fixed model for OpenAI; one drawn per agent for Baseten,
//           which is why this takes the agent and not just a name.
// price     (slug) => $ per 1M tokens [input, output]; [0, 0] for a model we have no price
//           for, which then counts tokens and no cost.
// params    (slug) => anything else the request needs.
// maxTokens what one reply may spend. A reply cut off here reads as a villager who never
//           answered, so it is a budget for the tool calls, not for thinking out loud.
// cachedRate what an input token read from the provider's prompt cache costs, as a share of
//           the input price. 1 (no discount) for a provider whose cache price we don't know.
export function chatBrain({ label, client, pickModel, price = () => [0, 0], params = () => ({}), maxTokens = 1000,
                            concurrency = () => 0, cachedRate = 1 }) {
  // Every villager calls at once: there is no global gate. The only gate is per model:
  // providers meter each model separately, and one model's ceiling is no reason to hold up
  // a villager thinking with another. Zero means no gate at all.
  const gates = new Map();
  const run = (model, fn) => {
    if (!gates.has(model)) { const n = concurrency(model); gates.set(model, n > 0 ? semaphore(n) : null); }
    const gate = gates.get(model);
    return gate ? gate(fn) : fn();
  };
  // apiMs: total time spent waiting on the API (a per-model gate's queue included).
  // cachedTok: input tokens the provider served from its prompt cache (the system prompt and
  // the tool schemas are ~78% of every request and never change, so this should be most of it).
  // limits: the rate-limit headers the API last sent back — why the 429s happen, from the source.
  const s = { calls: 0, inTok: 0, cachedTok: 0, outTok: 0, errors: 0, rateLimited: 0, timedOut: 0,
              apiMs: 0, limits: null };
  // The same tallies again, per model, so a mixed village can be read model by model:
  // who thought with what, how often it answered, what it cost.
  const per = new Map();
  const track = slug => {
    let m = per.get(slug);
    if (!m) per.set(slug, m = { agents: new Set(), calls: 0, inTok: 0, cachedTok: 0, outTok: 0, errors: 0, rateLimited: 0, timedOut: 0, apiMs: 0 });
    return m;
  };
  const costOf = m => {
    const [pin, pout] = price(m.slug);
    return (m.inTok - m.cachedTok) / 1e6 * pin + m.cachedTok / 1e6 * pin * cachedRate + m.outTok / 1e6 * pout;
  };

  return {
    name: label,
    models: () => [...per.keys()],
    stats() {
      const byModel = {};
      let cost = 0;
      for (const [slug, m] of per) {
        const c = costOf({ ...m, slug });
        cost += c;
        byModel[slug] = { agents: m.agents.size, calls: m.calls, inTok: m.inTok, cachedTok: m.cachedTok, outTok: m.outTok,
                          errors: m.errors, rateLimited: m.rateLimited, timedOut: m.timedOut, apiMs: m.apiMs, cost: c };
      }
      return { ...s, cost, byModel };
    },

    async decide(a, t) {
      const model = pickModel(a);
      a.model = model;                      // the agent carries its model into the dashboard
      const m = track(model);
      m.agents.add(a.id);
      const bump = (k, n = 1) => { s[k] += n; m[k] += n; };

      const tools = t.defs.map(d => ({
        type: 'function', function: { name: d.name, description: d.description, parameters: d.input_schema },
      }));
      const messages = [{ role: 'system', content: systemPrompt() }, { role: 'user', content: t.observe() }];

      for (let turn = 0; turn < 3; turn++) {
        let r;
        // A 429 is the provider's queue, not the villager's turn. It used to spend one of the
        // three turns a decision gets, so three of them in a row and the villager never spoke
        // at all — it kept last round's job and posted no orders, silently. Now it waits and
        // asks again, backing off, until the round's own clock stops it.
        for (let attempt = 0; ; attempt++) {
          try {
            const t1 = Date.now();
            const out = await run(model, () => client.chat.completions.create({
              model, messages, tools, max_completion_tokens: maxTokens, ...params(model),
            }, { signal: t.signal }).withResponse());
            r = out.data;
            bump('apiMs', Date.now() - t1);
            if (!s.limits || !(s.calls & 31)) s.limits = readLimits(out.response.headers);
            break;
          } catch (e) {
            if (t.signal?.aborted) { bump('timedOut'); return; }   // the round stopped waiting

            if (e instanceof OpenAI.RateLimitError && attempt < 4) {
              bump('rateLimited');
              if (!s.limits) s.limits = readLimits(e.headers);
              await new Promise(r => setTimeout(r, retryAfterMs(e.headers, attempt)));
              continue;
            }
            bump('errors');
            if (s.errors <= 3) console.error(`[${label} ${model}] ${e.status ?? ''} ${e.message}`);
            return;
          }
        }
        bump('calls');
        bump('inTok', r.usage?.prompt_tokens ?? 0);
        bump('cachedTok', r.usage?.prompt_tokens_details?.cached_tokens ?? 0);
        bump('outTok', r.usage?.completion_tokens ?? 0);
        // The round closed while this call was in flight — it timed out, or the quorum went
        // on without it. Its tokens were spent and are counted, but nothing it says may land:
        // the tools already refuse every action, and `a.thought` is written here rather than
        // through them, so it would otherwise turn up in the next round's villager.
        if (t.signal?.aborted) { bump('timedOut'); return; }

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
        // Done once a shift is chosen and nothing was refused — unless the shift was the ONLY
        // thing in the first reply. Orders used to register only if the model happened to send
        // them in the same reply as the shift; when a wording change made it answer one call at
        // a time, 79% of turns ended before an order could be posted and the market died. A
        // lone shift now gets one follow-up turn (tools.mjs says so in the shift's result).
        if (t.acted.activity && !t.acted.failed && (turn > 0 || calls.length > 1)) return;
        messages.push(msg, ...results);
      }
    },
  };
}
