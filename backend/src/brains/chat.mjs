// The decision loop every provider shares (providers.mjs). They all speak OpenAI's
// chat-completions wire format — same tools, same tool_calls, same usage block — so they
// differ only in which client they hold, what a model costs, and which model an agent
// thinks with. Everything that decides how a villager decides lives here.
import OpenAI from 'openai';
import { CFG } from '../config.mjs';
import { systemPrompt } from './prompt.mjs';

// The rate-limit headers the API sends with every reply, so a run can say why it was throttled.
const head = (h, k) => (typeof h?.get === 'function' ? h.get(k) : h?.[k]) ?? null;
function readLimits(h) {
  const n = k => head(h, k);
  // OpenAI's names, or Anthropic's (whose token limit that matters is the INPUT one: cache reads don't count toward it)
  return { requests: n('x-ratelimit-limit-requests') ?? n('anthropic-ratelimit-requests-limit'),
           requestsLeft: n('x-ratelimit-remaining-requests') ?? n('anthropic-ratelimit-requests-remaining'),
           tokens: n('x-ratelimit-limit-tokens') ?? n('anthropic-ratelimit-input-tokens-limit'),
           tokensLeft: n('x-ratelimit-remaining-tokens') ?? n('anthropic-ratelimit-input-tokens-remaining'),
           resetTokens: n('x-ratelimit-reset-tokens') ?? n('anthropic-ratelimit-input-tokens-reset'),
           resetRequests: n('x-ratelimit-reset-requests') ?? n('anthropic-ratelimit-requests-reset') };
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

// The two wire formats a provider can be spoken to in. Chat Completions is the one every
// OpenAI-compatible host understands. OpenAI's own Responses API is the only way its gpt-6
// models will reason AND call tools in the same request, so it is used for exactly that.
// Each turns the conversation so far into a request, and a reply into the same four things:
// token counts, any text, any reasoning, and the tool calls.
const WIRES = {
  chat: {
    start: (system, user) => ({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    send: (client, st, { model, defs, maxTokens, tokenParam, extra, signal }) => client.chat.completions.create({
      model, messages: st.messages, [tokenParam]: maxTokens, ...extra,
      tools: defs.map(d => ({ type: 'function', function: { name: d.name, description: d.description, parameters: d.input_schema } })),
    }, { signal }).withResponse(),
    read(r) {
      const msg = r.choices[0].message;
      return { inTok: r.usage?.prompt_tokens ?? 0, cachedTok: r.usage?.prompt_tokens_details?.cached_tokens ?? 0, outTok: r.usage?.completion_tokens ?? 0,
               text: msg.content, reasoning: msg.reasoning_content ?? msg.reasoning,     // the field has two names in the wild
               calls: (msg.tool_calls ?? []).map(c => ({ id: c.id, name: c.function.name, args: c.function.arguments })), keep: [msg] };
    },
    reply: (st, got, results) => st.messages.push(...got.keep, ...results.map(x => ({ role: 'tool', tool_call_id: x.id, content: x.content }))),
  },
  responses: {
    start: (system, user) => ({ instructions: system, input: [{ role: 'user', content: user }] }),
    send: (client, st, { model, defs, maxTokens, extra, signal }) => client.responses.create({
      model, instructions: st.instructions, input: st.input, max_output_tokens: maxTokens, ...extra,
      tools: defs.map(d => ({ type: 'function', name: d.name, description: d.description, parameters: d.input_schema, strict: false })),
    }, { signal }).withResponse(),
    read(r) {
      const out = r.output ?? [], texts = kind => out.filter(o => o.type === kind);
      return { inTok: r.usage?.input_tokens ?? 0, cachedTok: r.usage?.input_tokens_details?.cached_tokens ?? 0, outTok: r.usage?.output_tokens ?? 0,
               text: texts('message').flatMap(m => m.content ?? []).map(c => c.text ?? '').join('\n'),
               reasoning: texts('reasoning').flatMap(m => m.summary ?? []).map(c => c.text ?? '').join('\n'),
               calls: texts('function_call').map(c => ({ id: c.call_id, name: c.name, args: c.arguments })), keep: out };
    },
    reply: (st, got, results) => st.input.push(...got.keep, ...results.map(x => ({ type: 'function_call_output', call_id: x.id, output: x.content }))),
  },
  // Anthropic's Messages API, spoken natively: its OpenAI-compatible endpoint has no prompt
  // caching, and the shared prefix (tools, then the system prompt) is ~3/4 of every request.
  // One cache breakpoint on the system prompt covers both, for the whole village. `client` is
  // an Anthropic-SDK client here. Usage counts uncached, cache-read and cache-written input
  // separately; a write costs more than plain input, so it is carried as `writeTok`.
  anthropic: {
    start: (system, user) => ({ system, messages: [{ role: 'user', content: user }] }),
    send: (client, st, { model, defs, maxTokens, extra, signal }) => client.messages.create({
      model, max_tokens: maxTokens, ...extra,
      system: [{ type: 'text', text: st.system, cache_control: { type: 'ephemeral' } }],
      tools: defs.map(d => ({ name: d.name, description: d.description, input_schema: d.input_schema })),
      messages: st.messages,
    }, { signal }).withResponse(),
    read(r) {
      const u = r.usage ?? {}, read = u.cache_read_input_tokens ?? 0, write = u.cache_creation_input_tokens ?? 0;
      const of = type => (r.content ?? []).filter(b => b.type === type);
      return { inTok: (u.input_tokens ?? 0) + read + write, cachedTok: read, writeTok: write, outTok: u.output_tokens ?? 0,
               text: of('text').map(b => b.text).join('\n'), reasoning: of('thinking').map(b => b.thinking ?? '').join('\n'),
               calls: of('tool_use').map(b => ({ id: b.id, name: b.name, args: JSON.stringify(b.input ?? {}) })), keep: r.content };
    },
    // the whole assistant turn goes back as it came (thinking blocks included), and every
    // tool result in ONE user message
    reply: (st, got, results) => st.messages.push({ role: 'assistant', content: got.keep },
      { role: 'user', content: results.map(x => ({ type: 'tool_result', tool_use_id: x.id, content: String(x.content ?? '') })) }),
  },
};

export function semaphore(n) {
  let active = 0; const q = [];
  return async fn => {
    if (active >= n) await new Promise(r => q.push(r));
    active++;
    try { return await fn(); } finally { active--; q.shift()?.(); }
  };
}

// label     what the dashboard calls this run's provider and model
// client    an OpenAI-SDK client, pointed at whichever endpoint
// pickModel (agent) => slug. It takes the agent, not just a name, so a village can be
//           dealt several models; today every provider runs one.
// price     (slug) => $ per 1M tokens [input, output, cached input?]; [0, 0] for a model we have no price
//           for, which then counts tokens and no cost.
// params    (slug) => anything else the request needs.
// maxTokens what one reply may spend. A reply cut off here reads as a villager who never
//           answered, so it is a budget for the tool calls, not for thinking out loud.
// cachedRate what an input token read from the provider's prompt cache costs, as a share of
//           the input price. 1 (no discount) for a provider whose cache price we don't know.
// tokenParam what the endpoint calls that budget: max_tokens nearly everywhere,
//           max_completion_tokens for OpenAI's gpt-5 family.
// api       'chat' (Chat Completions, the default) or 'responses' (see WIRES).
export function chatBrain({ label, client, pickModel, price = () => [0, 0], params = () => ({}), maxTokens = 1000,
                            concurrency = () => 0, cachedRate = 1, writeRate = 1, tokenParam = 'max_tokens', api = 'chat' }) {
  const wire = WIRES[api];
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
  const s = { calls: 0, inTok: 0, cachedTok: 0, writeTok: 0, outTok: 0, errors: 0, rateLimited: 0, timedOut: 0,
              apiMs: 0, limits: null };
  // The same tallies again, per model, so a mixed village can be read model by model:
  // who thought with what, how often it answered, what it cost.
  const per = new Map();
  const track = slug => {
    let m = per.get(slug);
    if (!m) per.set(slug, m = { agents: new Set(), calls: 0, inTok: 0, cachedTok: 0, writeTok: 0, outTok: 0, errors: 0, rateLimited: 0, timedOut: 0, apiMs: 0 });
    return m;
  };
  const costOf = m => {
    // a third figure is that model's own cached-input price; without one, cachedRate stands in
    const [pin, pout, pcached = pin * cachedRate] = price(m.slug);
    // writeRate: what an input token WRITTEN to the cache costs, as a multiple of the input price (Anthropic: 1.25)
    return (m.inTok - m.cachedTok - m.writeTok) / 1e6 * pin + m.cachedTok / 1e6 * pcached + m.writeTok / 1e6 * pin * writeRate + m.outTok / 1e6 * pout;
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
        byModel[slug] = { agents: m.agents.size, calls: m.calls, inTok: m.inTok, cachedTok: m.cachedTok, writeTok: m.writeTok, outTok: m.outTok,
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

      const talk = wire.start(systemPrompt(), t.observe());

      for (let turn = 0; turn < 3; turn++) {
        let r;
        // A 429 is the provider's queue, not the villager's turn. It used to spend one of the
        // three turns a decision gets, so three of them in a row and the villager never spoke
        // at all — it kept last round's job and posted no orders, silently. Now it waits and
        // asks again, backing off, until the round's own clock stops it.
        for (let attempt = 0; ; attempt++) {
          try {
            const t1 = Date.now();
            const out = await run(model, () => wire.send(client, talk,
              { model, defs: t.defs, maxTokens, tokenParam, extra: params(model), signal: t.signal }));
            r = out.data;
            bump('apiMs', Date.now() - t1);
            if (!s.limits || !(s.calls & 31)) s.limits = readLimits(out.response.headers);
            break;
          } catch (e) {
            if (t.signal?.aborted) { bump('timedOut'); return; }   // the round stopped waiting

            if ((e instanceof OpenAI.RateLimitError || e?.status === 429 || e?.status === 529) && attempt < 4) {   // 529: Anthropic overloaded
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
        const got = wire.read(r);
        bump('calls');
        bump('inTok', got.inTok);
        bump('cachedTok', got.cachedTok);
        bump('writeTok', got.writeTok ?? 0);
        bump('outTok', got.outTok);
        // The round closed while this call was in flight — it timed out, or the quorum went
        // on without it. Its tokens were spent and are counted, but nothing it says may land:
        // the tools already refuse every action, and `a.thought` is written here rather than
        // through them, so it would otherwise turn up in the next round's villager.
        if (t.signal?.aborted) { bump('timedOut'); return; }

        t.acted.answered = true;
        if (got.text) a.thought = got.text.trim().slice(0, 240);
        // A reasoning model's thinking, where the provider hands it back. Kept for the run
        // log only: no villager is ever shown it.
        const why = got.reasoning;
        if (typeof why === 'string' && why.trim() && t.log) (t.log.reasoning ??= []).push(why.trim());
        const calls = got.calls;
        if (!calls.length) return;

        t.acted.failed = false;
        // Arguments that aren't a JSON object (malformed, or cut off at the token limit)
        // are never run with defaults: the model is told, and gets another turn.
        const results = calls.map(c => {
          let args;
          try { args = JSON.parse(c.args || '{}'); } catch (e) {
            return { id: c.id, content: t.badCall(c.name, c.args, `invalid JSON: ${e.message}`) };
          }
          if (!args || typeof args !== 'object' || Array.isArray(args))
            return { id: c.id, content: t.badCall(c.name, c.args, 'arguments must be a JSON object') };
          return { id: c.id, content: t.exec(c.name, args) };
        });
        // Done once a shift is chosen and nothing was refused — unless the shift was the ONLY
        // thing in the first reply. Orders used to register only if the model happened to send
        // them in the same reply as the shift; when a wording change made it answer one call at
        // a time, 79% of turns ended before an order could be posted and the market died. A
        // lone shift now gets one follow-up turn (tools.mjs says so in the shift's result).
        if (t.acted.activity && !t.acted.failed && (turn > 0 || calls.length > 1)) return;
        wire.reply(talk, got, results);
      }
    },
  };
}
