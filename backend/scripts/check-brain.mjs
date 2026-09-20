// Checks a brain without a chain, a world or a validator: build it, hand a few pretend
// villagers a pretend situation, and see what comes back. It answers the questions that
// actually break — does the key work, does this model call tools, which model did each
// agent draw, what did the round cost — for a fraction of a cent.
//
//   node backend/scripts/check-brain.mjs --pool          who draws what (no key, no calls)
//   node backend/scripts/check-brain.mjs --list          the live Baseten catalog
//   node backend/scripts/check-brain.mjs                 one decision each, BRAIN from .env
//   BRAIN=openai AGENTS=3 node backend/scripts/check-brain.mjs
import { CFG } from '../src/config.mjs';
import { BASE_URL, basetenPool, modelFor, DEFAULT_POOL } from '../src/brains/baseten.mjs';

const has = f => process.argv.includes(f);
// --pool costs nothing, so it shows the whole village; a real decision costs a call each,
// so that path is capped however big AGENTS is.
const BRAIN = CFG.BRAIN, N = has('--pool') ? (+CFG.AGENTS || 10) : Math.min(+CFG.AGENTS || 6, 12);
const KEYS = { openai: 'OPENAI_API_KEY', claude: 'ANTHROPIC_API_KEY', baseten: 'BASETEN_API_KEY' };

// The same names the village uses, so a run and a check talk about the same villagers.
const S1 = ['Ada', 'Bo', 'Cy', 'Dee', 'Eli', 'Fen', 'Gus', 'Hana', 'Ivo', 'Jo', 'Kit', 'Lu', 'Mara', 'Nils', 'Ora', 'Pim'];
const agents = Array.from({ length: N }, (_, i) => ({ id: i, name: `${S1[i % 16]}-${i}`, thought: '' }));

// ---- who draws what -------------------------------------------------------------
if (has('--pool')) {
  const pool = basetenPool();
  console.log(`pool (${pool.length}): ${pool.join(', ')}`);
  console.log(pool === DEFAULT_POOL || !CFG.BASETEN_MODELS ? '(the brain default)' : '(from BASETEN_MODELS)');
  console.log(`\nseed ${CFG.SEED} — the same seed always draws the same line-up:`);
  const tally = {};
  for (const a of agents) {
    const m = modelFor(a.id, pool);
    tally[m] = (tally[m] ?? 0) + 1;
    console.log(`  ${a.name.padEnd(8)} ${m}`);
  }
  console.log('\n' + Object.entries(tally).map(([m, n]) => `${n}x ${m.split('/').pop()}`).join('  '));
  process.exit(0);
}

// ---- what Baseten actually serves today -----------------------------------------
if (has('--list')) {
  const key = process.env.BASETEN_API_KEY;
  if (!key) { console.error('no BASETEN_API_KEY in the repo-root .env'); process.exit(1); }
  const r = await fetch(`${BASE_URL}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) { console.error(`${r.status} ${r.statusText}: ${(await r.text()).slice(0, 200)}`); process.exit(1); }
  const live = (await r.json()).data.map(m => m.id).sort();
  console.log(`baseten serves ${live.length} models:`);
  for (const id of live) console.log(`  ${id}`);
  const missing = basetenPool().filter(m => !live.includes(m));
  console.log(missing.length ? `\n  ! not in the catalog: ${missing.join(', ')}` : '\n  every model in the pool is served');
  process.exit(missing.length ? 1 : 0);
}

// ---- one real decision each ------------------------------------------------------
const need = KEYS[BRAIN];
if (need && !process.env[need]) {
  console.error(`BRAIN=${BRAIN} needs ${need} in the repo-root .env (a run would fall back to the stub)`);
  process.exit(1);
}

// A villager's tools, in miniature: enough of the shape that a model's answer means
// something (choose a shift, post an order, be refused for a bad one), and none of the
// world behind it. The real ones are backend/src/tools.mjs.
function fakeTools() {
  const acted = { activity: null, orders: 0, failed: false, answered: false };
  const did = [];
  const defs = [
    { name: 'work', description: 'Work this round\'s shift. One shift a round, chosen once.',
      input_schema: { type: 'object', additionalProperties: false,
        properties: { task: { type: 'string', enum: ['gather_food', 'gather_wood', 'craft_net', 'build_house', 'idle'] },
                      reason: { type: 'string', description: 'one short line: why' } }, required: ['task'] } },
    { name: 'set_buy', description: 'Your standing shopping list: keep this good topped up to target.',
      input_schema: { type: 'object', additionalProperties: false,
        properties: { good: { type: 'string', enum: ['food', 'wood', 'nets'] }, target: { type: 'number' }, max: { type: 'number', description: 'most you will pay per unit, in coins' } },
        required: ['good', 'target'] } },
  ];
  return {
    defs, acted, did, signal: null,
    observe: () => [
      'You are a villager. You live by fishing, cutting wood, making nets and building a house.',
      'You hold 30.00 coins, 12 food, 4 wood, no net, no house. You eat 5 food a meal and your fire burns 3 wood.',
      'Your talents: fishing 2.1, woodcutting 0.5, crafting 0.8 — you are a fisher.',
      'Prices last round: food 1.10, wood 0.95, nets 30.00, houses 120.00. A fishing shift brings 25 food with a net, 12 without.',
      'Choose this round\'s shift, and keep your shopping list right.',
    ].join('\n'),
    exec(name, input = {}) {
      const def = defs.find(d => d.name === name);
      if (!def) { acted.failed = true; did.push(`${name}: no such tool`); return `There is no tool called ${name}.`; }
      if (name === 'work') {
        if (acted.activity) { acted.failed = true; return `You already chose to ${acted.activity} this round.`; }
        acted.activity = input.task;
        did.push(`work ${input.task}${input.reason ? ` (${input.reason})` : ''}`);
        return `You will ${input.task} this shift. Anything else you want to do this round, do it now.`;
      }
      acted.orders++;
      did.push(`set_buy ${input.good} to ${input.target}${input.max ? ` at up to ${input.max}` : ''}`);
      return `Your shopping list will keep ${input.good} topped up to ${input.target}.`;
    },
    badCall(name, raw, why) { acted.failed = true; did.push(`bad call ${name}: ${why}`); return `That call was refused (${why}). Try again.`; },
  };
}

const brain = BRAIN === 'openai' ? (await import('../src/brains/openai.mjs')).openaiBrain()
  : BRAIN === 'claude' ? (await import('../src/brains/claude.mjs')).claudeBrain()
    : BRAIN === 'baseten' ? (await import('../src/brains/baseten.mjs')).basetenBrain()
      : (await import('../src/brains/stub.mjs')).stubBrain();

console.log(`brain: ${brain.name}   ${N} villagers, one decision each\n`);
const t0 = Date.now();
await Promise.all(agents.map(async a => {
  const t = fakeTools(), started = Date.now();
  try { await brain.decide(a, t); } catch (e) { t.did.push(`threw: ${e.message}`); }
  const ms = Date.now() - started;
  const ok = t.acted.activity && !t.acted.failed;
  console.log(`${ok ? 'ok  ' : '!   '}${a.name.padEnd(8)} ${String(a.model ?? CFG.MODEL).padEnd(36)} ${String(ms + 'ms').padStart(7)}  ${t.did.join(' | ') || 'no tool call'}`);
  if (a.thought) console.log(`      thought: ${a.thought.slice(0, 120)}`);
}));

const s = brain.stats();
console.log(`\n${N} decisions in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${s.calls} calls, ${s.inTok} in / ${s.outTok} out, $${s.cost.toFixed(4)}` +
  (s.errors ? `, ${s.errors} errors` : '') + (s.rateLimited ? `, ${s.rateLimited} rate limited` : ''));
for (const [slug, m] of Object.entries(s.byModel ?? {}))
  console.log(`  ${slug.padEnd(38)} ${m.agents} agents  ${m.calls} calls  ${m.inTok}/${m.outTok} tok  $${m.cost.toFixed(4)}` +
    (m.errors ? `  ${m.errors} errors` : ''));
// A whole village at 30 agents costs about this a round.
if (s.calls) console.log(`\nabout $${(s.cost / N * 30).toFixed(4)} a round at 30 agents (${(s.cost / N * 30 * 100).toFixed(2)} cents)`);
