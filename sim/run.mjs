// Headless runner. Proves: agents decide -> market clears -> economy stays healthy
// -> an intervention visibly changes behaviour.
//   node run.mjs                 stub minds, free
//   MIND=llm node run.mjs        real Claude Haiku 4.5 minds
//   node run.mjs --drought 120   drought hits the docks at tick 120

import { makeWorld, GOODS, TOOL } from './world.mjs';
import { createMind } from './mind.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i < 0 ? d : Number(argv[i + 1]); };
const TICKS = arg('--ticks', 200);
const DROUGHT = arg('--drought', -1);

const w = makeWorld({ SEED: arg('--seed', 7) });
const mind = createMind(process.env.MIND === 'llm' ? 'llm' : 'stub');
const news = [];
const trendOf = g => w.hist[g].length < 11 ? 0
  : (w.hist[g].at(-1) - w.hist[g].at(-11)) / Math.max(0.5, w.hist[g].at(-11));

console.log(`minds=${mind.mode}  agents=${w.P.N}  ticks=${TICKS}` +
            (DROUGHT > 0 ? `  drought at t=${DROUGHT}` : '  no shock') + '\n');
console.log('  t   fish   wood    ore | jobs f/w/o | tools  hungry   money');

for (let t = 0; t < TICKS; t++) {
  const iv = [];
  if (t === DROUGHT) { iv.push({ type: 'yield', good: 'fish', factor: 0.25 });
                       news.push('the fishing grounds have gone bad.'); }

  const { finished } = w.step(iv);

  // Only agents who just finished a shift get to think. This is the decision point.
  const ctx = { price: w.price, toolCost: w.P.TOOL_COST, news: news.slice(-1),
                trend: Object.fromEntries(GOODS.map(g => [g, trendOf(g)])) };
  await Promise.all(finished.map(async a => {
    const d = await mind.decide(a, { ...ctx, info: a.traits.info });
    a.lastReason = d.reason; a.pricing = d.pricing ?? 'normal';
    if (d.action === 'buy') w.buyTool(a, TOOL[a.job]);
    else if (d.action === 'work' && d.job) a.job = d.job;
  }));

  if (t % 10 === 0 || t === DROUGHT) {
    const jobs = GOODS.map(g => w.agents.filter(a => a.job === g).length);
    const tools = w.agents.filter(a => Object.keys(a.tools).length).length;
    const hungry = w.agents.filter(a => a.hunger > 0).length;
    console.log(String(t).padStart(3),
      ...GOODS.map(g => w.price[g].toFixed(2).padStart(6)),
      '|', jobs.map(n => String(n).padStart(3)).join('/'),
      '|', String(tools).padStart(5), String(hungry).padStart(7),
      w.money().toFixed(0).padStart(7), t === DROUGHT ? '  <<< DROUGHT' : '');
  }
}

console.log('\n--- what five villagers are thinking ---');
for (const a of w.agents.filter((_, i) => i % 19 === 0).slice(0, 5))
  console.log(`  ${a.name}  ${a.job.padEnd(5)} cash ${a.cash.toFixed(0).padStart(4)}  ` +
              `${(Object.keys(a.tools)[0] ?? '—').padEnd(5)}  "${a.lastReason}"`);

const jobs = GOODS.map(g => w.agents.filter(a => a.job === g).length);
console.log(`\njobs fish/wood/ore : ${jobs.join(' / ')}`);
console.log(`tool owners        : ${w.agents.filter(a => Object.keys(a.tools).length).length}/${w.P.N}`);
console.log(`hungry             : ${w.agents.filter(a => a.hunger > 0).length}`);
console.log(`prices             : ${GOODS.map(g => `${g} ${w.price[g].toFixed(2)}`).join('  ')}`);
console.log(`money in economy   : ${w.money().toFixed(0)}`);
if (mind.mode === 'llm') { const s = mind.stats();
  console.log(`llm calls ${s.calls}  cache-read ${s.cacheRead}/${s.inTok} in-tokens  cost $${s.cost.toFixed(3)}`); }
