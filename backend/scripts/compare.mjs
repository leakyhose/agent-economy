// Put saved runs side by side: how each model behaved as a villager, what the village did
// under it, and what it cost.
//
//   node backend/scripts/compare.mjs runs/<a> runs/<b> [runs/<c> ...] [--rounds N]
//
// --rounds N reads only the first N rounds of every run, so a long run can be set against a
// short one. Runs are only comparable with the same AGENTS, SEED and dials; the header says
// what each was run with. One run per model is one draw: model calls are not deterministic,
// so a small gap between columns may be noise (run each twice to see how much).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const N = argv.includes('--rounds') ? +argv[argv.indexOf('--rounds') + 1] : Infinity;
const dirs = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--rounds');
if (dirs.length < 2) { console.error('usage: node backend/scripts/compare.mjs runs/<a> runs/<b> [...] [--rounds N]'); process.exit(1); }

const avg = xs => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
const q = (xs, p) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.round((v.length - 1) * p))] : 0; };
const pct = (a, b) => b ? `${(a / b * 100).toFixed(1)}%` : '—';
const JOBS = ['gather_food', 'gather_wood', 'craft_net'];

async function read(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json')));
  const final = fs.existsSync(path.join(dir, 'final.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'final.json'))) : null;
  const D = [], R = [];
  for await (const line of readline.createInterface({ input: fs.createReadStream(path.join(dir, 'events.jsonl')) })) {
    const dec = line.includes('"type":"decision"'), rnd = !dec && line.includes('"type":"round"');
    if (!dec && !rnd) continue;
    const e = JSON.parse(line);
    if (e.round > N) { if (rnd) break; continue; }
    if (dec) D.push({ agent: e.agent, outcome: e.outcome, straggler: !!e.straggler, ms: e.ms, kept: e.kept, activity: e.activity,
                      actions: (e.actions ?? []).map(x => ({ tool: x.tool, rejected: !!x.rejected })), reasoned: !!e.reasoning?.length });
    else R.push({ m: e.metrics, hungry: e.agents.filter(a => a.hunger > 0).length, cold: e.agents.filter(a => a.cold >= 2).length,
                  foreclosed: e.foreclosures.length, loans: e.bank.loans.filter(l => l.kind === 'borrow' && l.ok).length,
                  refused: e.bank.loans.filter(l => !l.ok).length, supply: e.bank.supply, prices: e.prices, roundMs: e.roundMs });
  }
  const ok = D.filter(d => d.outcome === 'ok'), acts = ok.flatMap(d => d.actions);
  const tool = t => acts.filter(x => x.tool === t);
  // the job a villager was born best at; building is crafting work
  const best = Object.fromEntries(meta.agents.map(a => [a.id, JOBS.reduce((b, j) => a.skills[j] > a.skills[b] ? j : b)]));
  const chosen = ok.filter(d => !d.kept && d.activity);
  const half = Math.floor(R.length / 2), llm = final?.llm, whole = !Number.isFinite(N) || (final && R.length >= (final.rounds ?? R.length));
  const perCall = llm?.calls ? llm.cost / llm.calls : null, callsPerDecision = llm?.calls && whole ? llm.calls / D.length : null;
  const last = R.at(-1);
  return {
    'run': path.basename(dir),
    'provider (model)': meta.provider ?? meta.brain,
    'agents · rounds': `${meta.agents.length} · ${R.length}`,
    'seed · timeout · quorum': `${meta.config.SEED} · ${meta.config.DECIDE_TIMEOUT_MS / 1000}s · ${meta.config.DECIDE_QUORUM}`,
    '── did it answer?': '',
    'turns answered in time': pct(ok.length, D.length),
    'timed out': pct(D.filter(d => d.outcome === 'timeout' && !d.straggler).length, D.length),
    'left behind by the quorum': pct(D.filter(d => d.straggler).length, D.length),
    'no answer / error': pct(D.filter(d => d.outcome === 'no answer' || d.outcome === 'error').length, D.length),
    'decision time p50 · p90': `${(q(ok.map(d => d.ms), 0.5) / 1000).toFixed(1)}s · ${(q(ok.map(d => d.ms), 0.9) / 1000).toFixed(1)}s`,
    'round length (avg)': `${(avg(R.map(r => r.roundMs)) / 1000).toFixed(1)}s`,
    '── how did it play?': '',
    'tool calls per answered turn': avg(ok.map(d => d.actions.length)).toFixed(2),
    'tool calls refused': pct(acts.filter(x => x.rejected).length, acts.length),
    'answered but chose no shift': pct(ok.filter(d => d.kept).length, ok.length),
    'chosen shifts at best skill': pct(chosen.filter(d => (d.activity === 'build_house' || d.activity === 'smoke_fish' ? 'craft_net' : d.activity) === best[d.agent]).length, chosen.length),
    'shift mix (food/wood/net/house/smoke)': ['gather_food', 'gather_wood', 'craft_net', 'build_house', 'smoke_fish'].map(j => Math.round(chosen.filter(d => d.activity === j).length / (chosen.length || 1) * 100)).join(' / ') + ' %',
    'place_order · set_sale · set_buy': `${tool('place_order').length} · ${tool('set_sale').length} · ${tool('set_buy').length}`,
    'borrow calls (refused)': `${tool('borrow').length} (${tool('borrow').filter(x => x.rejected).length})`,
    'repay calls': String(tool('repay').length),
    'turns with reasoning text logged': pct(D.filter(d => d.reasoned).length, D.length),
    '── what did the village do?': '',
    'houses built': String(last?.m.housesBuilt ?? '—'),
    'homeowners at the end': `${last?.m.homeowners ?? '—'} of ${meta.agents.length}`,
    'loans made · foreclosures': `${R.reduce((s, r) => s + r.loans, 0)} · ${R.reduce((s, r) => s + r.foreclosed, 0)}`,
    'real GDP per round, 1st → 2nd half': `${avg(R.slice(0, half).map(r => r.m.realGdp / 100)).toFixed(0)} → ${avg(R.slice(half).map(r => r.m.realGdp / 100)).toFixed(0)}`,
    'price index at the end': last?.m.priceIndex.toFixed(2) ?? '—',
    'food · wood price at the end': last ? `${(last.prices[0] / 100).toFixed(2)} · ${(last.prices[1] / 100).toFixed(2)}` : '—',
    'money supply, start → end': R.length ? `${(R[0].supply / 100).toFixed(0)} → ${(last.supply / 100).toFixed(0)}` : '—',
    'hungry villagers per round': avg(R.map(r => r.hungry)).toFixed(1),
    'cold villagers per round': avg(R.map(r => r.cold)).toFixed(1),
    'wellbeing per villager at the end': last?.m.wellbeing.toFixed(0) ?? '—',
    'net-worth gini at the end': last?.m.gini.toFixed(2) ?? '—',
    '── what did it cost?': '',
    'cost per model call': perCall !== null ? `$${perCall.toFixed(5)}` : '—',
    'tokens per call, in (cached) · out': llm?.calls ? `${Math.round(llm.inTok / llm.calls)} (${pct(llm.cachedTok ?? 0, llm.inTok)}) · ${Math.round(llm.outTok / llm.calls)}` : '—',
    'model calls per turn': callsPerDecision !== null ? callsPerDecision.toFixed(2) : '— (run was cut with --rounds)',
    'run total': llm && whole ? `$${llm.cost.toFixed(2)} for ${R.length} rounds` : llm ? `$${llm.cost.toFixed(2)} for the whole run (${final.rounds ?? '?'} rounds)` : '—',
    '429s · errors (whole run)': llm ? `${llm.rateLimited ?? 0} · ${llm.errors ?? 0}` : '—',
  };
}

const cols = [];
for (const d of dirs) cols.push(await read(path.resolve(d)));
const keys = Object.keys(cols[0]), w0 = Math.max(...keys.map(k => k.length)) + 2;
const w = cols.map(c => Math.max(...Object.values(c).map(v => String(v).length)) + 2);
for (const k of keys) {
  if (k.startsWith('──')) { console.log(`\n${k}`); continue; }
  console.log(k.padEnd(w0) + cols.map((c, i) => String(c[k]).padEnd(w[i])).join(''));
}
