// Read a villager's decisions out of a saved run: what it was shown, what it did, what the
// tools told it, and what the round then did to it.
//
//   node backend/scripts/trace.mjs [runs/<timestamp>] [filters] [output]     (no run = the latest)
//
// filters (all must hold):
//   --agent <name|id>      one villager, by name (any case, a prefix will do) or index
//   --round <n | a-b>      one round, or a range
//   --tool <name>          decisions that called this tool (borrow, place_order, set_sale, ...)
//   --rejected             decisions where a tool call was refused
//   --outcome <o>          ok | timeout | error | "no answer"
//   --model <text>         decisions made by a model whose slug contains this
//   --grep <text>          text found in the thought, the reasoning, the tool calls or what it saw
// output:
//   --limit <n>            how many decisions to print in full (default 5; 0 = all)
//   --list                 one line per matching decision instead
//   --brief                leave out what it saw
//   --json                 the matching decisions as JSON lines, each with its `after`
//   --prompt               the system prompt and tool descriptions in force (at --round, else the first)
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const opt = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
if (has('--help') || has('-h')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'));
  process.exit(0);
}

const VALUED = new Set(['--agent', '--round', '--tool', '--outcome', '--model', '--grep', '--limit']);
const given = argv.find((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
const runsDir = path.join(ROOT, 'runs');
const dir = given ? path.resolve(given) : path.join(runsDir, fs.readdirSync(runsDir).sort().at(-1));
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json')));
const name = id => meta.agents[id]?.name ?? `#${id}`;
const coins = c => (c / 100).toFixed(2);

// ---- the filters ------------------------------------------------------------------
let agentId = null;
if (opt('--agent') !== undefined) {
  const q = opt('--agent').toLowerCase();
  const hit = /^\d+$/.test(q) ? meta.agents[+q] : meta.agents.find(a => a.name.toLowerCase() === q) ?? meta.agents.find(a => a.name.toLowerCase().startsWith(q));
  if (!hit) { console.error(`no villager "${opt('--agent')}" in this run. They are: ${meta.agents.map(a => a.name).join(', ')}`); process.exit(1); }
  agentId = hit.id;
}
const [r0, r1] = (opt('--round') ?? '').split('-').map(Number);
const rounds = opt('--round') ? [r0, Number.isFinite(r1) ? r1 : r0] : null;
const tool = opt('--tool'), outcome = opt('--outcome'), model = opt('--model')?.toLowerCase(), grep = opt('--grep')?.toLowerCase();
const limit = opt('--limit') !== undefined ? +opt('--limit') : 5;
const full = !has('--list') && !has('--json');

const matches = d =>
  (agentId === null || d.agent === agentId) &&
  (!rounds || (d.round >= rounds[0] && d.round <= rounds[1])) &&
  (!tool || (d.actions ?? []).some(x => x.tool === tool)) &&
  (!has('--rejected') || (d.actions ?? []).some(x => x.rejected)) &&
  (!outcome || d.outcome === outcome) &&
  (!model || (d.model ?? '').toLowerCase().includes(model)) &&
  (!grep || [d.thought, ...(d.reasoning ?? []), JSON.stringify(d.actions ?? []), d.saw].some(s => (s ?? '').toLowerCase().includes(grep)));

// ---- one pass over the log --------------------------------------------------------
// A long run's events.jsonl is hundreds of MB, so it is streamed, and only the three kinds
// of line this needs are parsed. A round's decisions are written before that round's own
// event, so each kept decision is still waiting when its outcome arrives.
const kept = [], waiting = new Map(), prompts = [];
let total = 0, before = new Map();      // before: every villager's wellbeing after the previous round
const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, 'events.jsonl')), crlfDelay: Infinity });
for await (const line of rl) {
  const kind = line.includes('"type":"decision"') ? 'decision' : line.includes('"type":"round"') ? 'round' : line.includes('"type":"prompt"') ? 'prompt' : null;
  if (!kind) continue;
  const e = JSON.parse(line);
  if (e.type === 'prompt') prompts.push(e);
  else if (e.type === 'decision') {
    if (!matches(e)) continue;
    total++;
    if (full && limit && kept.length >= limit) continue;
    kept.push(e);
    if (!waiting.has(e.round)) waiting.set(e.round, []);
    waiting.get(e.round).push(e);
  } else if (e.type === 'round') {
    for (const d of waiting.get(e.round) ?? []) {
      const row = e.agents?.find(a => a.id === d.agent);
      d.after = {
        trades: (e.trades ?? []).filter(t => t.agent === d.agent).map(t => ({ side: t.side, qty: t.qty, good: t.good, price: t.price })),
        loans: (e.bank?.loans ?? []).filter(l => l.agent === d.agent).map(l => ({ kind: l.kind, amount: l.amount, ok: l.ok })),
        foreclosed: (e.foreclosures ?? []).some(f => f.agent === d.agent),
        collected: (e.collected ?? []).some(f => f.agent === d.agent),
        state: row ? { cash: row.cash, goods: row.goods, locked: row.locked, debt: row.debtNow ?? row.debt, hunger: row.hunger, cold: row.cold,
                       homes: row.homes, wellbeing: row.wellbeing, wellbeingGained: before.has(d.agent) ? +(row.wellbeing - before.get(d.agent)).toFixed(2) : null } : null,
      };
    }
    waiting.delete(e.round);
    before = new Map((e.agents ?? []).map(a => [a.id, a.wellbeing]));
  }
}

// ---- output -----------------------------------------------------------------------
if (has('--prompt')) {
  const at = rounds?.[0] ?? 1, p = prompts.filter(x => x.round <= at).at(-1) ?? prompts[0];
  if (!p) { console.log('This run did not record its prompt (it predates the `prompt` event). backend/src/brains/prompt.mjs builds it from the config in meta.json.'); process.exit(0); }
  console.log(`# system prompt in force from round ${p.round}${prompts.length > 1 ? ` (${prompts.length} versions in this run, at rounds ${prompts.map(x => x.round).join(', ')})` : ''}\n`);
  console.log(p.system);
  console.log('\n# tools\n');
  for (const t of p.tools) console.log(`- ${t.name}: ${t.description}\n  arguments: ${JSON.stringify(t.input_schema.properties ?? {})}\n`);
  process.exit(0);
}
if (has('--json')) { for (const d of kept) console.log(JSON.stringify(d)); process.exit(0); }

// slot 3: smoked fish in a run that has the smoke_fish job; "boats", a dead slot, before that
const GOODS = ['food', 'wood', 'nets', meta.config?.TASKS?.smoke_fish ? 'smoked fish' : 'boats', 'houses'];
const holds = q => (q ?? []).map((n, g) => n && GOODS[g] !== 'boats' ? `${GOODS[g]} ${n}` : '').filter(Boolean).join(', ') || 'nothing';
const head = d => `${name(d.agent)} (#${d.agent}) · round ${d.round} · ${d.outcome}${d.straggler ? ' (left behind by the quorum)' : ''} in ${(d.ms / 1000).toFixed(1)}s${d.model ? ` · ${d.model}` : ''}`;

console.log(`run ${path.basename(dir)}   provider ${meta.provider ?? meta.brain}   ${total} decision${total === 1 ? '' : 's'} match`);
if (has('--list')) {
  for (const d of kept) {
    const acts = (d.actions ?? []).map(x => x.tool + (x.rejected ? '✗' : '')).join(' ');
    console.log(`r${String(d.round).padStart(3)} ${name(d.agent).padEnd(14)} ${String(d.outcome).padEnd(9)} ${String(d.activity ?? '—').padEnd(12)} ${acts}${d.thought ? `  — ${d.thought}` : ''}`);
  }
  process.exit(0);
}
if (kept.length < total) console.log(`showing the first ${kept.length} (--limit ${limit}; --limit 0 for all, --list for one line each)`);

for (const d of kept) {
  console.log(`\n${'═'.repeat(100)}\n${head(d)}\n${'═'.repeat(100)}`);
  if (!has('--brief')) console.log(`\n── WHAT IT SAW (its whole prompt for this turn, after the system prompt: --prompt) ──\n${d.saw ?? '(nothing recorded)'}`);
  if (d.reasoning?.length) console.log(`\n── ITS REASONING (the model's own thinking, as the provider returned it) ──\n${d.reasoning.join('\n---\n')}`);
  console.log('\n── WHAT IT DID (each tool call, and the reply it got) ──');
  if (!d.actions?.length) console.log(d.kept ? '(no tool call: it kept its last job and posted no orders of its own)' : '(no tool call)');
  (d.actions ?? []).forEach((x, i) => {
    console.log(`${i + 1}. ${x.tool} ${JSON.stringify(x.input)}${x.rejected ? '   ✗ REJECTED' : ''}`);
    console.log(`   → ${String(x.result ?? '').replace(/\n/g, '\n     ')}`);
  });
  console.log(`shift: ${d.activity ?? 'none'}${d.kept ? ' (kept from before, not chosen)' : ''}`);
  if (d.thought) console.log(`stated reason: ${d.thought}`);
  // stall and shopping-list orders are included: the villager's standing plans post them
  if (d.orders?.length) console.log(`orders sent to market: ${d.orders.map(o => `${o.side} ${o.qty} ${o.good} @ ${coins(o.limit)}`).join(' · ')}`);
  console.log(`\n── WHAT HAPPENED (round ${d.round} settled) ──`);
  const A = d.after;
  if (!A) { console.log('(the run ended before this round settled)'); continue; }
  console.log(A.trades.length ? `traded: ${A.trades.map(t => `${t.side === 'buy' ? 'bought' : 'sold'} ${t.qty} ${t.good} at ${coins(t.price)}`).join(' · ')}` : 'traded: nothing');
  for (const l of A.loans) console.log(`bank: ${l.kind} ${coins(l.amount)} ${l.ok ? 'went through' : 'REFUSED on-chain'}`);
  if (A.foreclosed) console.log('bank: FORECLOSED this round');
  if (A.collected) console.log('bank: loan collected from cash at its deadline');
  const s = A.state;
  if (s) console.log(`after: cash ${coins(s.cash)} · ${holds(s.goods)}${s.locked?.some(Boolean) ? ` · pledged ${holds(s.locked)}` : ''} · debt ${coins(s.debt ?? 0)} · ` +
    `${s.hunger ? `hungry ×${s.hunger}` : 'fed'}, ${s.cold ? `cold ×${s.cold}` : 'warm'} · wellbeing ${s.wellbeing}${s.wellbeingGained !== null ? ` (${s.wellbeingGained >= 0 ? '+' : ''}${s.wellbeingGained} this round)` : ''}`);
}
