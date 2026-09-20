// The admin panel — the dashboard from backend/public/index.html, as a module. The drawing
// code (charts, tiles, wealth, feeds, the dials) is the original, verbatim where it could be.
// What changed: it is mounted into a container instead of owning the page, it reads the
// shared /state store instead of polling on its own, the inline handlers go through the
// `dash` namespace rather than globals, and it draws nothing while it is out of view.
import './admin.css';
import { subscribe, refresh as refreshState } from '../store.js';

const $ = id => document.getElementById(id);
const GN = ['food', 'wood', 'nets', 'boats', 'houses'];  // good index -> name, same order as the chain

// One palette for every chart, so a colour means the same thing wherever it appears.
const C = {
  blue: '#3b6ea5', blueSoft: '#9db9d8', amber: '#bd7d2a', green: '#3f8f5b',
  red: '#b0504a', purple: '#7a63b8', brown: '#93785c', grey: '#aab4bf',
  axis: '#96a1ac', rule: '#e9edf2', ink: '#3a444e',
};
const GC = [C.blue, C.brown, C.purple, C.grey, C.amber];   // one colour per good
const SHOWN = [0, 1, 2, 4];          // goods with a chart of their own; boats (3) are a dead slot nothing makes
const goodsList = q => q.map((n, g) => n ? `${n} ${GN[g]}` : '').filter(Boolean).join(', ');
const pct = v => `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;

let btn, statusEl, world, events, rows, root;
let running = false;
let last = null;                     // last /state, so hover can redraw without a fetch
let showAll = false;                 // agent table: top 10 by net worth, or everyone
let visible = false;                 // the island view is up: draw nothing until we are back
const hover = GN.map(() => null);   // hovered round index per chart

// ---- the range the charts show ----------------------------------------------------
// One toggle for every chart: the whole run, or the last RANGE_N rounds (about two minutes
// at the usual round length). Long runs are drawn from a sample, so "All" stays smooth.
const RANGE_N = 50;
const MAX_POINTS = 400;
let range = 'all';
try { range = localStorage.getItem('admin.range') || 'all'; } catch { /* private window */ }

function downsample(h) {
  if (h.length <= MAX_POINTS) return h;
  const step = Math.ceil(h.length / MAX_POINTS);
  const out = h.filter((_, i) => i % step === 0);
  if (out.at(-1) !== h.at(-1)) out.push(h.at(-1));
  return out;
}
// The rounds the charts draw. Rolling averages are still computed over the whole run.
const view = () => {
  const h = last?.history ?? [];
  return range === 'all' ? downsample(h) : h.slice(-RANGE_N);
};
function setRange(next) {
  range = next;
  try { localStorage.setItem('admin.range', next); } catch { /* private window */ }
  root.querySelectorAll('#range button').forEach(b => b.classList.toggle('on', b.dataset.r === next));
  if (last?.running && visible) { econ(); details(); }
}
const detailsOpen = () => $('more').open;
// a Solana explorer link for a transaction, on the same cluster as the ledger link the server gives
const txUrl = sig => last.chain.explorer.replace(/\/address\/[^?]+/, '/tx/' + sig);

const MARKUP = `
<div class="top">
  <h1>agent-economy</h1>
  <label class="agents">agents <input id="agents" type="number" min="2" max="137" step="1" value="100"></label>
  <button id="btn" onclick="dash.toggle()">Start</button>
  <button id="pausebtn" onclick="dash.togglePause()" disabled>Pause</button>
  <button id="dialsbtn" onclick="dash.toggleDials()">Dials</button>
  <span class="range" id="range"><button data-r="all">All</button><button data-r="window">Last ${RANGE_N}</button></span>
  <span id="status"></span>
</div>
<div id="headline"></div>

<div id="admin-panel">
  <button class="close" onclick="dash.toggleDials()">Close</button>
  <h2>Dials</h2>
  <div class="presets" id="presets"></div>
  <div id="dialgroups"></div>
  <div id="pfeed"></div>
</div>

<div id="dash" style="display:none">
  <div class="tiles" id="tiles"></div>
  <div id="tile-open"></div>

  <div class="big">
    <div class="chart" id="k-gdp"></div>
    <div class="col">
      <div id="cb-panel"></div>
      <div class="chart" id="k-money"></div>
    </div>
    <div class="chart" id="k-prices"></div>
    <div class="chart" id="k-jobs"></div>
    <div class="chart" id="wealth"></div>
    <div class="chart" id="bankfeed"></div>
  </div>

  <details class="more" id="more">
    <summary>Details: order book, loans, needs, stock, prices, chain, round log, agents</summary>
    <div class="box" id="world"></div>
    <div class="small">
      <div class="box" id="book" style="margin:0; min-width:300px; flex:1"></div>
    </div>
    <div class="small">
      <div class="chart" id="k-fore"></div><div class="chart" id="k-needs"></div>
      <div class="chart" id="k-held"></div><div class="chart" id="k-slack"></div>
    </div>
    <div class="small">
      <div class="chart" id="c0"></div><div class="chart" id="c1"></div><div class="chart" id="c2"></div><div class="chart" id="c4"></div>
    </div>
    <div class="chart" id="txfeed" style="width:auto; margin:10px 0"></div>
    <h3>Round log</h3>
    <div class="box" id="events" style="margin-top:0"></div>
    <h3>Agents <button id="allbtn" onclick="dash.toggleAll()" style="font-size:11px; padding:1px 8px"></button>
      <span class="muted" style="font-weight:normal">click a villager to open their log</span></h3>
    <div class="scroll"><table>
      <thead><tr>
        <th></th><th>agent</th><th>skills f/w/n</th><th>doing</th><th class="n">cash</th><th class="n">food</th>
        <th class="n">wood</th><th class="n">nets</th><th>house</th><th class="n">hunger</th><th class="n">cold</th>
        <th class="n">wellbeing</th><th class="n">net worth</th><th class="n">debt</th><th class="n">due</th><th>standing orders</th><th>last thought</th>
      </tr></thead>
      <tbody id="rows"></tbody>
    </table></div>
  </details>
</div>`;

// Every transaction the village has just made, newest first, with what it did and a link
// to it on the explorer. A trade in the village and a signature on the chain, side by side.
const txColour = { auction: C.green, borrow: C.amber, repay: C.green, collect: C.red, purses: C.blue, settle: C.ink };
function txFeed() {
  // The round log is the usual source. With many agents the server's event buffer fills with
  // per-agent events before a round is read back, so fall back to the last round's own list.
  const logged = (last.events ?? []).filter(e => e.type === 'round' && e.sigs?.length);
  const lastRound = last.chain?.lastRound;
  const rounds = logged.length ? logged
    : lastRound?.sigs?.length ? [{ round: lastRound.round, sigs: lastRound.sigs }] : [];
  const rows = rounds.slice(0, 6).flatMap(e => e.sigs.map(t => {
    const moves = (t.moves ?? []).map(m =>
      `<div style="padding-left:14px" class="muted">${m.from} → ${m.to} <b>${(m.amount / 100).toFixed(2)}</b></div>`).join('');
    return `<div style="color:${txColour[t.kind] ?? '#333'}">r${e.round} · ${t.what} ` +
      `<a target="_blank" href="${txUrl(t.sig)}" title="${t.sig}">${t.sig.slice(0, 8)}… ↗</a></div>${moves}`;
  }));
  $('txfeed').innerHTML =
    `<div class="head"><b>Chain</b><span class="muted">one signature per act, newest first</span></div>` +
    `<div style="line-height:1.45; max-height:260px; overflow-y:auto">${rows.join('') || '<span class="muted">waiting for the first round</span>'}</div>`;
}

// ---- one good's price: a step line (it moves only when a trade clears) with volume
//      bars under it. Hover reads out the round.
function chart(g) {
  const el = $('c' + g), s = last, h = view(), name = GN[g];
  const W = 300, PH = 88, VH = 20, PAD = 34, top = 8, vTop = top + PH + 10, H = vTop + VH + 14;
  const now = s.prices[name], first = h.length ? h[0].prices[g] : now;
  const chg = first ? (now - first) / first * 100 : 0;
  const head = `<div class="head"><b>${cap(name)}</b><span>${now.toFixed(2)} ` +
    `<span class="${chg > 0 ? 'up' : chg < 0 ? 'down' : ''}">${chg > 0 ? '+' : ''}${chg.toFixed(1)}%</span></span></div>`;
  if (h.length < 2) { el.innerHTML = head + WAITING; return; }

  const ps = h.map(x => x.prices[g]), vs = h.map(x => x.volumes[g]);
  let lo = Math.min(...ps), hi = Math.max(...ps);
  if (hi - lo < 0.01) { lo -= 0.5; hi += 0.5; }               // flat line: give it room
  const pad = (hi - lo) * 0.15; lo -= pad; hi += pad;
  const vmax = Math.max(1, ...vs);
  const x = i => PAD + i / (h.length - 1) * (W - PAD - 4);
  const y = p => top + (hi - p) / (hi - lo) * PH;

  let d = `M${x(0)},${y(ps[0])}`;
  for (let i = 1; i < ps.length; i++) d += ` H${x(i)} V${y(ps[i])}`;
  const bw = Math.max(1, (W - PAD - 4) / h.length - 2);
  const bars = vs.map((v, i) => v ? `<rect x="${x(i) - bw / 2}" y="${vTop + VH - v / vmax * VH}" width="${bw}" height="${v / vmax * VH}" rx="1" fill="${C.blueSoft}"/>` : '').join('');

  const k = hover[g];
  const tip = k == null ? '' :
    `<line x1="${x(k)}" x2="${x(k)}" y1="${top}" y2="${vTop + VH}" stroke="${C.axis}" stroke-dasharray="2 3" stroke-width=".7"/>` +
    `<circle cx="${x(k)}" cy="${y(ps[k])}" r="3" fill="${C.blue}" stroke="#fff" stroke-width="1.5"/>` +
    `<text x="${x(k) > W / 2 ? x(k) - 6 : x(k) + 6}" y="${top + 9}" text-anchor="${x(k) > W / 2 ? 'end' : 'start'}" font-size="9.5" fill="${C.ink}" stroke="#fff" stroke-width="3" paint-order="stroke">` +
    `r${h[k].round} · ${ps[k].toFixed(2)} · ${vs[k]} sold</text>`;

  el.innerHTML = head + `<svg viewBox="0 0 ${W} ${H}" shape-rendering="geometricPrecision">
    <text x="${PAD - 5}" y="${y(hi - pad) + 3}" text-anchor="end" font-size="9" fill="${C.axis}">${(hi - pad).toFixed(2)}</text>
    <text x="${PAD - 5}" y="${y(lo + pad) + 3}" text-anchor="end" font-size="9" fill="${C.axis}">${(lo + pad).toFixed(2)}</text>
    <line x1="${PAD}" x2="${W - 4}" y1="${top + PH}" y2="${top + PH}" stroke="${C.rule}"/>
    <path d="${d}" fill="none" stroke="${C.blue}" stroke-width="1.4" stroke-linejoin="round"/>
    <text x="${PAD - 5}" y="${vTop + VH}" text-anchor="end" font-size="9" fill="${C.axis}">vol</text>
    ${bars}
    <text x="${PAD}" y="${H - 2}" font-size="9" fill="${C.axis}">r${h[0].round}</text>
    <text x="${W - 4}" y="${H - 2}" text-anchor="end" font-size="9" fill="${C.axis}">r${h.at(-1).round}</text>
    ${policyMarks(h, x, top, vTop + VH)}
    ${tip}
    <rect x="${PAD}" y="0" width="${W - PAD}" height="${H}" fill="transparent" data-g="${g}"/>
  </svg>`;
  const hit = el.querySelector('rect[data-g]');
  hit.onmousemove = ev => {
    const r = hit.getBoundingClientRect(), fx = (ev.clientX - r.left) / r.width;
    hover[g] = Math.max(0, Math.min(h.length - 1, Math.round(fx * (h.length - 1)))); chart(g);
  };
  hit.onmouseleave = () => { hover[g] = null; chart(g); };
}

// ---- a line chart over rounds. series: [{ name, color, get(h), dash?, legend? }]
//      stacked: bars that add up (jobs). ref: a dashed reference level.
//      tip(k): the hover readout for round index k.
const khover = {};
function lines(id, title, series, opts = {}) {
  const { fmt = v => v.toFixed(0), stacked = false, note = '', zero = true, w = 300, ph = 110, ref = null, tip: tipText = null, sub = '' } = opts;
  const el = $(id), h = view(), W = w, PH = ph, big = W > 400, fs = big ? 10 : 9, PAD = big ? 44 : 34, top = 8, H = top + PH + (big ? 30 : 26);
  const legend = series.filter(s => s.legend !== false).map(s =>
    `<span style="color:${s.color}; white-space:nowrap">${s.name} <b>${s.label ? s.label() : fmt(h.length ? s.get(h.at(-1)) : 0)}</b></span>`).join('<span class="sep"></span>');
  const head = `<div class="head"><b>${title}</b><span class="muted">${sub}</span></div><div class="legend">${legend}</div>`;
  if (h.length < 2) { el.innerHTML = head + WAITING; return; }
  const vals = series.map(s => h.map(s.get));
  const tops = stacked ? h.map((_, i) => vals.reduce((t, v) => t + v[i], 0)) : vals.flat();
  const all = ref == null ? vals.flat() : [...vals.flat(), ref];
  let lo = stacked || zero ? Math.min(0, ...all) : Math.min(...all), hi = Math.max(zero ? 1 : lo + 1, ...tops, ...(ref == null ? [] : [ref]));
  if (!zero) { const p = (hi - lo) * 0.1; lo -= p; hi += p; }
  const x = i => PAD + i / (h.length - 1) * (W - PAD - 4);
  const y = v => top + (hi - v) / (hi - lo) * PH;
  let body = '';
  if (stacked) {
    const bw = Math.max(1, (W - PAD - 4) / h.length - 1);
    h.forEach((_, i) => { let acc = 0; series.forEach((s, k) => { const v = vals[k][i]; if (!v) return;
      body += `<rect x="${x(i) - bw / 2}" y="${y(acc + v)}" width="${bw}" height="${y(acc) - y(acc + v)}" fill="${s.color}"/>`; acc += v; }); });
  } else {
    series.forEach((s, k) => { const d = vals[k].map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
      if (s.area) body += `<path d="${d} L${x(h.length - 1).toFixed(1)},${y(lo)} L${x(0).toFixed(1)},${y(lo)} Z" fill="${s.color}" opacity="0.10"/>`;
      body += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width ?? 1.4}" stroke-linejoin="round" stroke-linecap="round" ${s.dash ? 'stroke-dasharray="3 3"' : ''}/>`; });
  }
  const refLine = ref == null ? '' : `<line x1="${PAD}" x2="${W - 4}" y1="${y(ref)}" y2="${y(ref)}" stroke="${C.axis}" stroke-width=".7" stroke-dasharray="3 3" opacity=".7"/>` +
    (Math.min(Math.abs(y(ref) - y(lo)), Math.abs(y(ref) - y(hi))) < fs + 2 ? '' :   // no label when it would sit on an axis label
    `<text x="${PAD - 5}" y="${y(ref) + 3}" text-anchor="end" font-size="${fs}" fill="${C.axis}">${fmt(ref)}</text>`);
  const k = khover[id];
  const tip = k == null ? '' : `<line x1="${x(k)}" x2="${x(k)}" y1="${top}" y2="${top + PH}" stroke="${C.axis}" stroke-width=".7" stroke-dasharray="2 3"/>` +
    `<text x="${x(k) > W / 2 ? x(k) - 6 : x(k) + 6}" y="${top + fs + 1}" text-anchor="${x(k) > W / 2 ? 'end' : 'start'}" font-size="${fs + 1}" fill="${C.ink}" stroke="#fff" stroke-width="3" paint-order="stroke">` +
    `r${h[k].round}: ${tipText ? tipText(k) : series.filter(s => s.legend !== false).map((s, j) => `${s.name} ${fmt(vals[series.indexOf(s)][k])}`).join(', ')}</text>`;
  el.innerHTML = head + `<svg viewBox="0 0 ${W} ${H}" shape-rendering="geometricPrecision">
    <text x="${PAD - 5}" y="${y(hi) + 3}" text-anchor="end" font-size="${fs}" fill="${C.axis}">${fmt(hi)}</text>
    <text x="${PAD - 5}" y="${y(lo) + 3}" text-anchor="end" font-size="${fs}" fill="${C.axis}">${fmt(lo)}</text>
    <line x1="${PAD}" x2="${W - 4}" y1="${y(lo)}" y2="${y(lo)}" stroke="${C.rule}"/>
    ${opts.grid ? [1 / 2].map(f => { const v = lo + (hi - lo) * f; return `<line x1="${PAD}" x2="${W - 4}" y1="${y(v)}" y2="${y(v)}" stroke="${C.rule}"/>` +
      // no label where the reference line already has one
      (ref != null && Math.abs(y(v) - y(ref)) < fs + 2 ? ''
        : `<text x="${PAD - 5}" y="${y(v) + 3}" text-anchor="end" font-size="${fs}" fill="${C.axis}">${fmt(v)}</text>`); }).join('') : ''}
    ${refLine}${body}
    <text x="${PAD}" y="${top + PH + fs + 4}" font-size="${fs}" fill="${C.axis}">r${h[0].round}</text>
    <text x="${W - 4}" y="${top + PH + fs + 4}" text-anchor="end" font-size="${fs}" fill="${C.axis}">r${h.at(-1).round}</text>
    <text x="${PAD}" y="${H - 1}" font-size="${fs}" fill="${C.axis}">${note}</text>
    ${policyMarks(h, x, top, top + PH)}
    ${tip}<rect x="${PAD}" y="0" width="${W - PAD}" height="${top + PH}" fill="transparent" data-k="1"/></svg>`;
  const hit = el.querySelector('rect[data-k]'), redraw = () => lines(id, title, series, opts);
  hit.onmousemove = ev => { const r = hit.getBoundingClientRect();
    khover[id] = Math.max(0, Math.min(h.length - 1, Math.round((ev.clientX - r.left) / r.width * (h.length - 1)))); redraw(); };
  hit.onmouseleave = () => { khover[id] = null; redraw(); };
}
const BIG = { w: 640, ph: 150 };
const WIDE = { w: 1000, ph: 130 };
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const WAITING = '<div class="waiting">waiting for rounds</div>';

// ---- a tiny sparkline for a tile
function spark(vals, color) {
  if (vals.length < 2) return '<svg></svg>';
  let lo = Math.min(...vals), hi = Math.max(...vals); if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pts = vals.map((v, i) => `${(i / (vals.length - 1) * 100).toFixed(2)},${(24 - (v - lo) / (hi - lo) * 22).toFixed(2)}`).join(' ');
  return `<svg viewBox="0 0 100 26" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
}

// average of a per-round series over the last k rounds (per-round numbers are noisy)
const rolling = (get, k) => last.history.map((_, i, h) => { const w = h.slice(Math.max(0, i - k + 1), i + 1).map(get).filter(v => v != null);
  return w.length ? w.reduce((s, v) => s + v, 0) / w.length : 0; });

// ---- the tiles: value, sparkline, and the full chart they open into
let openTile = null;
const TILES = [
  { id: 'infl', label: 'inflation', sub: '20 rd', color: C.red,
    val: m => m.inflation == null ? 'n/a' : pct(m.inflation), spark: x => x.priceIndex,
    full: () => lines('tile-chart', 'Inflation', [
      { name: 'price index', color: C.red, get: x => x.priceIndex },
    ], { ...WIDE, fmt: v => v.toFixed(2), zero: false, ref: 1, note: 'basket at last prices, 1 at the start' }) },
  { id: 'wb', label: 'wellbeing', sub: 'per rd', color: C.green,
    val: m => (m.wb5 >= 0 ? '+' : '') + (m.wb5 ?? 0).toFixed(2), spark: x => x.wb5,
    full: () => lines('tile-chart', 'Wellbeing', [
      { name: 'total', color: C.blue, get: x => x.wellbeing },
      { name: 'per round, 5 rd avg', color: C.green, get: x => x.wb5 },
    ], { ...WIDE, fmt: v => v.toFixed(1), note: 'average per agent' }) },
  { id: 'emp', label: 'employment', sub: '5 rd avg', color: C.green,
    val: m => m.emp5.toFixed(0) + '%', spark: x => x.emp5,
    full: () => lines('tile-chart', 'Employment', [
      { name: 'worked, 5 rd avg', color: C.green, get: x => x.emp5 },
    ], { ...WIDE, note: 'worked shifts / shifts finished' }) },
  { id: 'gini', label: 'inequality', sub: 'gini', color: C.purple,
    val: m => m.gini.toFixed(2), spark: x => x.gini,
    full: () => lines('tile-chart', 'Inequality', [
      { name: 'gini, net worth', color: C.purple, get: x => x.gini },
    ], { ...WIDE, fmt: v => v.toFixed(2), note: '0 = equal' }) },
  { id: 'houses', label: 'houses', sub: 'built', color: C.amber,
    val: m => `${m.housesBuilt ?? 0}`, spark: x => x.housesBuilt ?? 0,
    full: () => lines('tile-chart', 'Houses', [
      { name: 'lived in', color: C.green, get: x => x.homeowners },
      { name: 'being built', color: C.amber, get: x => x.building },
      { name: 'built', color: C.blue, get: x => x.housesBuilt, dash: true },
    ], { ...WIDE, note: `out of ${last.agents.length} agents` }) },
  { id: 'bank', label: 'capital', sub: 'equity', color: C.blue,
    val: m => m.equity.toFixed(1), spark: x => x.equity,
    full: () => lines('tile-chart', 'Capital', [
      { name: 'equity', color: C.blue, get: x => x.equity },
      { name: 'written off', color: C.red, get: x => x.writtenOff },
      { name: 'bad debt', color: C.red, get: x => x.badDebt, dash: true },
    ], { ...WIDE, fmt: v => v.toFixed(1), note: 'write-offs are a running total' }) },
];

function tiles() {
  const h = view(), m = last.history.at(-1);
  if (!m) return;
  for (const t of TILES) {
    const el = $('t-' + t.id);
    el.classList.toggle('on', openTile === t.id);
    el.innerHTML = `<div class="lab"><span>${t.label}</span><span>${t.sub}</span></div>` +
      `<div class="val">${t.val(m)}</div>${spark(h.map(t.spark), t.color)}`;
  }
  const t = TILES.find(t => t.id === openTile);
  if (!t) { $('tile-open').innerHTML = ''; return; }
  if (!$('tile-chart')) $('tile-open').innerHTML = '<div class="chart" id="tile-chart"></div>';
  t.full();
}

// ---- the headline charts
function bigCharts() {
  const h = last.history, b = last.bank;   // the full run: the reference level is the first rounds
  const g0 = h.slice(0, 5).reduce((t, x) => t + (x.realGdp ?? x.gdp), 0) / Math.min(5, h.length), gNow = h.at(-1).gdp10;
  const chg = g0 ? (gNow / g0 - 1) * 100 : 0;
  lines('k-gdp', 'GDP', [
    { name: '3 rd avg', color: C.blueSoft, get: x => x.gdp3, width: 1 },
    { name: '10 rd avg', color: C.blue, get: x => x.gdp10, width: 2, area: true },
  ], { ...BIG, zero: false, grid: true, ref: g0, fmt: v => v.toFixed(0),
       sub: h.length > 5 ? `<b style="color:${chg >= 0 ? C.green : C.red}">${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%</b> vs the first rounds` : '',
       note: 'output at fixed opening prices, so price moves are not growth' });

  lines('k-money', 'Money', [
    { name: 'supply', color: C.blue, get: x => x.supply, width: 2 },
    { name: 'credit', color: C.amber, get: x => x.debt, width: 2 },
    { name: 'lending cap', color: C.amber, get: x => x.lendingCap, dash: true, width: 1 },
  ], { ...BIG, fmt: v => v.toFixed(0), ref: b.startSupply,
       sub: b.creditOn ? `${(b.ratePerMin * 100).toFixed(1)}%/min, ${(b.ratePerRound * 100).toFixed(2)}%/round` : 'credit off',
       note: `dashed line: starting money ${b.startSupply.toFixed(0)}, above it loans minted the rest` });

  // every good as % of its first-round price, so one chart reads for all five; hover shows actual prices
  const base = GN.map((_, g) => h.find(x => x.prices[g] > 0)?.prices[g] ?? 1);
  const now = h.at(-1)?.prices ?? [];
  const shownRounds = view();
  lines('k-prices', 'Prices', SHOWN.map(g => ({
    name: GN[g], color: GC[g], get: x => x.prices[g] / base[g] * 100,
    label: () => now.length ? `${now[g].toFixed(2)} <span class="${now[g] > base[g] ? 'up' : now[g] < base[g] ? 'down' : 'muted'}">${pct(now[g] / base[g] - 1)}</span>` : '',
  })), { ...BIG, zero: false, ref: 100, fmt: v => v.toFixed(0) + '%',
         tip: k => SHOWN.map(g => `${GN[g]} ${shownRounds[k].prices[g].toFixed(2)}`).join('  '),
         note: '% of each good\'s first price, hover for coins' });

  lines('k-jobs', 'Jobs', [
    { name: 'fish', color: C.blue, get: x => x.doing.gather_food },
    { name: 'wood', color: C.brown, get: x => x.doing.gather_wood },
    { name: 'craft', color: C.purple, get: x => x.doing.craft_net },
    { name: 'build', color: C.amber, get: x => x.doing.build_house ?? 0 },
    { name: 'idle', color: C.grey, get: x => x.doing.idle },
  ], { ...BIG, stacked: true, note: 'agents on each job, per round' });
}

// ---- the charts inside "details"
function detailCharts() {
  const m = last.history.at(-1);
  lines('k-fore', 'Loans', [
    { name: 'collected', color: C.green, get: x => x.autoRepaid ?? 0 },
    { name: 'foreclosed', color: C.amber, get: x => x.overdue },
  ], { note: 'collected: taken from cash at the due round' });
  lines('k-needs', 'Needs', [
    { name: 'hungry', color: C.red, get: x => x.hungry },
    { name: 'cold', color: C.blue, get: x => x.cold },
  ], { note: `out of ${last.agents.length} agents` });
  lines('k-held', 'Stock', SHOWN.map(g => ({ name: GN[g], color: GC[g], get: x => x.held[g] ?? 0 })),
    { note: 'goods held by agents' });
  lines('k-slack', 'Slack', [
    { name: 'value offered, unsold', color: C.amber, get: x => x.slack },
  ], { fmt: v => v.toFixed(1), note: `${m.slackShare == null ? 'no' : Math.round(m.slackShare * 100) + '%'} of value offered went unsold last round` });
  SHOWN.forEach(g => chart(g));
}

function econ() {
  const h = last.history;
  if (!h.length || h[0].gdp === undefined || h[0].supply === undefined) return;
  const gdp10 = rolling(x => x.realGdp ?? x.gdp, 10), gdp3 = rolling(x => x.realGdp ?? x.gdp, 3), emp5 = rolling(x => x.employment, 5), wb5 = rolling(x => x.wbRound, 5);
  h.forEach((x, i) => { x.gdp10 = gdp10[i]; x.gdp3 = gdp3[i]; x.emp5 = emp5[i] * 100; x.wb5 = wb5[i]; });
  tiles(); bigCharts();
  if (detailsOpen()) detailCharts();
}

// ---- who's winning: cash to the right, debt to the left, net worth (cash + goods at what they sell for − debt) on the right
function wealth() {
  const ag = [...last.agents].sort((a, b) => b.wealth - a.wealth);
  const max = Math.max(1, ...ag.map(a => Math.max(a.cash, a.debt))), start = last.bank.startSupply / ag.length;
  const W = 640, L = 96, mid = L + 90, R = W - 70, row = 15, fs = 11;
  const sx = v => v / max * (R - mid);
  const bars = ag.map((a, i) => { const yy = i * row + 14;
    return `<text x="0" y="${yy + 10}" font-size="${fs}">${i + 1}. ${a.name}</text>` +
      (a.debt ? `<rect x="${mid - Math.min(sx(a.debt), mid - L)}" y="${yy + 2}" width="${Math.min(sx(a.debt), mid - L)}" height="${row - 4}" fill="${C.amber}"/>` : '') +
      `<rect x="${mid}" y="${yy + 2}" width="${sx(a.cash)}" height="${row - 4}" fill="${a.cash - a.debt >= start ? C.green : '#9dc4ac'}"/>` +
      `<text x="${W}" y="${yy + 10}" font-size="${fs}" text-anchor="end">${a.wealth.toFixed(2)}</text>`; }).join('');
  const sLine = mid + sx(start), Hh = ag.length * row + 20;
  $('wealth').innerHTML = `<div class="head"><b>Wealth</b><span class="muted">net worth = cash + goods − debt</span></div>` +
    `<div class="legend"><span style="color:${C.amber}">debt</span><span class="sep"></span>` +
    `<span style="color:${C.green}">cash, dark above starting cash</span></div>` +
    `<svg viewBox="0 0 ${W} ${Hh}" shape-rendering="geometricPrecision">${bars}` +
    `<line x1="${sLine}" x2="${sLine}" y1="10" y2="${ag.length * row + 16}" stroke="${C.axis}" stroke-width=".7" stroke-dasharray="3 3"/>` +
    `<text x="${sLine + 3}" y="9" font-size="9" fill="${C.axis}">start ${start.toFixed(0)}</text>` +
    `<line x1="${mid}" x2="${mid}" y1="10" y2="${ag.length * row + 16}" stroke="${C.rule}"/></svg>`;
}

function bankFeed() {
  const words = { borrow: C.amber, repay: C.green, collected: C.green, foreclosed: C.red };
  const items = last.bankFeed.map(f => `<div style="color:${f.ok === false ? '#888' : words[f.kind]}">r${f.round} · ${f.name} ` + (
    f.kind === 'borrow' ? `${f.ok === false ? 'refused: borrow' : 'borrowed'} ${f.amount.toFixed(2)}${f.term ? ` for ${f.term} rounds` : ' (top-up)'}`
    : f.kind === 'repay' ? `${f.ok === false ? 'refused: repay' : 'repaid'} ${f.amount.toFixed(2)}`
    : f.kind === 'collected' ? `loan due: ${f.amount.toFixed(2)} collected from cash, no penalty`
    : `<b>FORECLOSED</b> (overdue) on ${(f.debt ?? 0).toFixed(2)}: ${f.amount.toFixed(2)} cash taken` +
      (f.seized?.some(q => q) ? `, seized ${goodsList(f.seized)}` : '') + (f.refund ? `, refunded ${f.refund.toFixed(2)}` : '') +
      (f.returned?.some(q => q) ? `, returned ${goodsList(f.returned)}` : '')) +
    (f.sig ? ` <a target="_blank" href="${txUrl(f.sig)}">tx ↗</a>` : '') +
    `</div>`).join('');
  const b = last.bank;
  $('bankfeed').innerHTML = `<div class="head"><b>Bank</b><span class="muted">keeper ${b.keeper.slice(0, 8)}… signs foreclosures</span></div>` +
    `<div style="line-height:1.5">owed <b>${b.debt.toFixed(2)}</b> of cap ${b.lendingCap.toFixed(2)} · equity <b>${b.equity.toFixed(2)}</b> (must keep ${b.capitalRequired.toFixed(2)})<br>` +
    `due loans: <span class="up">${b.autoRepaid} collected</span> · <span class="down">${b.overdue} overdue foreclosures</span><br>` +
    `written off ${b.books.writtenOff.toFixed(2)} · bad debt ${b.badDebt.toFixed(2)}` +
    (b.creditOn ? '' : `<br><span class="down">credit off: the chain refuses every loan</span>`) +
    (b.goods.some(q => q) ? `<br>seized, for sale: ${goodsList(b.goods)}` : '') + `</div>` +
    `<div class="feed">${items || '<div class="muted">no loans yet</div>'}</div>`;
}

// ---- the market right now: last round's book before clearing (top levels a side), what cleared, the latest trades
function book() {
  const m = last.market, lv = ls => ls.map(([p, q]) => `${(p / 100).toFixed(2)}×${q}`).join(' · ');
  const rows = m.ladder.length ? m.ladder.map(l =>
    `<tr><td>${l.good}</td><td class="n">${l.bids.count ? lv(l.bids.top) + (l.bids.more ? ` <span class="muted">+${l.bids.more}</span>` : '') : '-'}</td>` +
    `<td class="n">${l.asks.count ? lv(l.asks.top) + (l.asks.more ? ` <span class="muted">+${l.asks.more}</span>` : '') : '-'}</td>` +
    `<td class="n">${l.sold ? `${l.sold} @ ${l.price.toFixed(2)}` : '-'}</td><td class="n">${l.offered - l.sold || ''}</td>` +
    `<td>${l.bankSale ? `bank ${l.bankSale.qty} @ ${l.bankSale.price.toFixed(2)}` : ''}</td></tr>`).join('')
    : '<tr><td colspan="6" class="muted">no round yet</td></tr>';
  const trades = m.trades.map(t => `<div>r${t.round} · ${t.name} bought ${t.qty} ${t.good} @ ${t.price.toFixed(2)}</div>`).join('');
  $('book').innerHTML =
    `<b>Order book</b> <span class="muted">last round before clearing · ${m.live} of ${last.agents.length} agents had an order</span>` +
    `<div class="scroll"><table style="margin:4px 0 8px"><tr><th></th><th class="n">bids (price×qty)</th><th class="n">asks (price×qty)</th>` +
    `<th class="n">sold</th><th class="n">unsold</th><th>next: bank sale</th></tr>${rows}</table></div>` +
    `<b>Trades</b>${trades || '<div class="muted">none yet</div>'}`;
}

function agentTable() {
  if (!last?.agents) return;
  const ag = [...last.agents].sort((a, b) => b.wealth - a.wealth), shown = showAll ? ag : ag.slice(0, 10);
  $('allbtn').textContent = showAll ? 'top 10 only' : `show all ${ag.length}`;
  rows.innerHTML = shown.map(a => {
    const open = openAgents.has(a.id);
    return `<tr class="agent ${open ? 'open' : ''}" onclick="dash.toggleAgent(${a.id})"><td class="tw">${open ? '▾' : '▸'}</td><td>${esc(a.name)}</td>` +
    `<td>${a.skills.gather_food} / ${a.skills.gather_wood} / ${a.skills.craft_net}</td><td>${a.activity}</td><td class="n">${a.cash.toFixed(2)}</td>` +
    `<td class="n">${a.food}</td><td class="n">${a.wood}</td><td class="n">${a.nets}</td>` +
    `<td>${a.house ? 'home' + (a.houses > 1 ? ` +${a.houses - 1}` : '') : ''}${a.building != null ? `${a.house ? ', ' : ''}building ${a.building}/${a.buildShifts ?? 0}` : ''}${!a.house && a.building == null && a.houses ? a.houses : ''}</td>` +
    `<td class="n ${a.hunger ? 'hungry' : ''}">${a.hunger || ''}</td>` +
    `<td class="n ${a.cold >= 2 ? 'hungry' : ''}">${a.cold || ''}</td>` +
    `<td class="n">${a.wellbeing.toFixed(1)}</td><td class="n">${a.wealth.toFixed(2)}</td>` +
    `<td class="n">${a.debt ? a.debt.toFixed(2) : ''}</td>` +
    `<td class="n ${a.dueIn !== null && a.dueIn <= 1 ? 'hungry' : ''}">${a.dueIn === null ? '' : a.dueIn + ' r'}</td>` +
    `<td class="t">${a.orders.join('<br>')}</td>` +
    `<td class="t">${esc(a.thought ?? '')}</td></tr>` +
    (open ? `<tr class="agentlog"><td></td><td colspan="${AGENT_COLS - 1}"><div class="alog" id="alog-${a.id}" onscroll="dash.logScrolled(${a.id}, this)">${agentLogHtml(a.id)}</div></td></tr>` : '');
  }).join('');
  // the table is rebuilt every poll: put each open log back where the reader had scrolled it
  for (const id of openAgents) { const el = $('alog-' + id); if (el && logScroll.has(id)) el.scrollTop = logScroll.get(id); }
  refreshOpenLogs();
}

// ---- one villager's whole run (GET /agent): every decision it made, with the tools it
//      called and what they answered, and every line it was told in between. Newest first.
const AGENT_COLS = 17;
const openAgents = new Set();          // agent ids whose log is open
const agentLogs = new Map();           // id -> the last /agent reply
const logScroll = new Map();           // id -> scrollTop of that log, kept across redraws
let logsAt = 0;
function toggleAgent(id) {
  if (openAgents.has(id)) { openAgents.delete(id); logScroll.delete(id); }
  else { openAgents.add(id); logsAt = 0; }
  agentTable();
}
async function refreshOpenLogs() {
  if (!openAgents.size || Date.now() - logsAt < 2500) return;
  logsAt = Date.now();
  let changed = false;
  await Promise.all([...openAgents].map(async id => {
    try {
      const r = await fetch('/agent?id=' + id);
      if (!r.ok) return;
      const log = await r.json(), was = agentLogs.get(id);
      if (!was || was.decisions.length !== log.decisions.length || was.journal.length !== log.journal.length) changed = true;
      agentLogs.set(id, log);
    } catch { /* the next poll tries again */ }
  }));
  if (changed) for (const id of openAgents) { const el = $('alog-' + id); if (el) el.innerHTML = agentLogHtml(id); }
}
const showInput = input => Object.entries(input ?? {}).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ');
function agentLogHtml(id) {
  const log = agentLogs.get(id);
  if (!log) return '<span class="muted">loading…</span>';
  if (!log.decisions.length && !log.journal.length) return '<span class="muted">nothing yet: the log fills as the rounds run</span>';
  // A journal line belongs to the turn it followed: it is what that round did to them.
  const turns = log.decisions.map(d => ({ ...d, told: [] }));
  const before = [];
  for (const j of log.journal) {
    let k = -1;
    for (let i = turns.length - 1; i >= 0; i--) if (turns[i].t <= j.t) { k = i; break; }
    (k < 0 ? before : turns[k].told).push(j.line);
  }
  const head = `<div class="ahead"><b>${esc(log.name)}</b>` +
    (log.model ? ` · <span class="muted">${esc(log.model)}</span>` : '') +
    (log.traits ? ` · <span class="muted">patience ${log.traits.patience} · risk ${log.traits.risk}</span>` : '') +
    ` · <span class="muted">${turns.length} turns</span></div>`;
  const told = lines => lines.map(l => `<div class="told">${esc(l)}</div>`).join('');
  return head + [...turns].reverse().map(d =>
    `<div class="turn"><div class="th"><b>round ${d.round}</b> <span class="${d.outcome === 'ok' ? 'muted' : 'hungry'}">${esc(d.outcome)}${d.kept ? ', kept last job' : ''}</span>` +
    ` <span class="muted">· ${esc(d.activity ?? 'no shift')} · ${(d.ms / 1000).toFixed(1)}s</span></div>` +
    (d.thought ? `<div class="said">${esc(d.thought)}</div>` : '') +
    d.actions.map(x => `<div class="act ${x.rejected ? 'hungry' : ''}"><b>${esc(x.tool)}</b>(${esc(showInput(x.input))})` +
      `<div class="res">${esc(x.result)}</div></div>`).join('') +
    told(d.told) + `</div>`).join('') +
    (before.length ? `<div class="turn"><div class="th"><b>before the first turn</b></div>${told(before)}</div>` : '');
}

// everything inside "details": drawn only while it's open
function details() {
  const s = last;
  if (!detailsOpen()) return;
  book(); agentTable(); txFeed();
  const prices = Object.keys(s.prices).map(g => `${g} ${s.prices[g].toFixed(2)} (${s.volumes[g]} sold)`).join(' · ');
  const doing = Object.entries(s.doing).map(([k, v]) => `${k} ${v}`).join(' · ');
  world.innerHTML =
    (s.decide ? `decide: slowest ${(s.decide.slowest / 1000).toFixed(1)}s, median ${(s.decide.median / 1000).toFixed(1)}s` +
      (s.decide.timeouts ? `, <span class="hungry">${s.decide.timeouts} timed out</span>` : '') + '<br>' : '') +
    `prices: ${prices}<br>` +
    `doing: ${doing}<br>` +
    `totals: money ${s.totals.money.toFixed(2)} · food ${s.totals.food} · wood ${s.totals.wood} · nets ${s.totals.nets} · ` +
    `houses ${s.totals.houses} owned by ${s.totals.homeowners}, ${s.totals.building} being built (${s.totals.housesBuilt} built) · ` +
    `<span class="hungry">hungry ${s.totals.hungry} · cold ${s.totals.cold}</span><br>` +
    `bank: income: interest ${s.bank.books.interestIncome.toFixed(2)} · penalties ${s.bank.books.penalties.toFixed(2)} · sales ${s.bank.books.recovered.toFixed(2)} · ` +
    (s.bank.creditOn ? `loans run ${s.bank.terms} rounds` : 'credit off') + '<br>' +
    (s.metrics ? `last round: GDP ${s.metrics.gdp.toFixed(2)} · price index ${s.metrics.priceIndex.toFixed(2)}` +
      ` · employment ${s.metrics.employment == null ? 'n/a' : Math.round(s.metrics.employment * 100) + '%'} · slack ${s.metrics.slack.toFixed(2)}` +
      ` · ${Math.round((s.metrics.tradedShare ?? 0) * 100)}% of output sold` +
      ` · wellbeing ${s.metrics.wellbeing.toFixed(1)} avg · gini ${s.metrics.gini.toFixed(2)} · credit ${s.metrics.credit.toFixed(2)} · money ${s.metrics.money.toFixed(2)}` : '');
  events.innerHTML = s.events.map(e => e.type === 'error'
    ? `<div class="hungry">error: ${e.message}</div>`
    : `<div>round ${e.round}: ${e.prices.map((p, i) => (p / 100).toFixed(2) + ' (' + e.volumes[i] + ')').join(' / ')} · ${e.txs} tx · ${e.ms}ms` +
      (e.sigs?.length ? ' · ' + e.sigs.map(t => `<a target="_blank" href="${txUrl(t.sig)}" title="${t.what}">${t.what.split(' ')[0]} ↗</a>`).join(' · ') : '') + `</div>`
  ).join('') || '<span class="muted">waiting for the first round</span>';
}

// ---- the control panel ----------------------------------------------------------
// One slider per dial in backend/src/tunables.mjs. Dragging one posts it; the simulation
// reads CFG every round, so the change lands on the next one. Nothing here is a special
// "disaster" mechanism — a hurricane is the houses-lost dial, and that is the point.
let dials = null;                 // the last /tunables snapshot
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function toggleDials() {
  const open = $('admin-panel').classList.toggle('open');
  root.classList.toggle('dials-open', open);
  if (open && !dials) loadDials();
}

// A panel that fails silently is worse than no panel: say so on the page.
async function loadDials() {
  try {
    const r = await fetch('/tunables');
    if (!r.ok) throw new Error(`/tunables returned ${r.status}`);
    dials = await r.json();
    if (!dials?.tunables?.length) throw new Error('/tunables returned no dials');
    drawDials();
  } catch (e) {
    dials = null;
    console.error('loadDials:', e);
    $('dialgroups').innerHTML = `<div class="hungry">could not load the dials: ${esc(e.message)}` +
      `<br><button onclick="dash.loadDials()" style="margin-top:6px">Try again</button></div>`;
  }
}

// POST one dial (or a preset) and redraw from the snapshot that comes back.
async function post(body) {
  dials = await (await fetch('/tunables', { method: 'POST', headers: { 'content-type': 'application/json' },
                                            body: JSON.stringify(body) })).json();
  drawDials();
  refreshState();
}
let pending = null;               // debounce: a drag posts once it settles, not per pixel
function slide(key, raw, el) {
  const t = dials.tunables.find(d => d.key === key);
  const v = t.int ? Math.round(+raw) : +raw;
  el.closest('.dial').querySelector('.dv').textContent = fmtDial(t, v);
  clearTimeout(pending);
  pending = setTimeout(() => post({ changes: { [key]: v } }), 120);
}
// The server is the authority on how a value reads; this is only what the label says while
// a slider is still moving, so it matches the same rounding.
function fmtDial(t, v) {
  if (t.bool) return v ? 'on' : 'off';
  const d = Math.max(0, (String(t.step).split('.')[1] ?? '').length);
  return t.shown.includes('%') ? `${+(v * 100).toFixed(1)}%`
       : t.shown.endsWith('×') ? `${+v.toFixed(2)}×`
       : t.shown.endsWith('s') && t.key.endsWith('_MS') ? `${(v / 1000).toFixed(1)}s`
       : String(+v.toFixed(d));
}

function drawDials() {
  if (!dials) return;
  $('presets').innerHTML = (dials.presets ?? []).map(p =>
    `<button class="${p.id === 'baseline' ? 'base' : ''}" title="${esc(p.note)}" onclick="dash.post({preset:'${p.id}'})">${esc(p.label)}</button>`).join('');
  $('dialgroups').innerHTML = (dials.groups ?? []).map(g => {
    const ds = (dials.tunables ?? []).filter(t => t.group === g.id);
    if (!ds.length) return '';
    return `<div class="grp"><div class="gh">${esc(g.title)}</div><div class="gb">${esc(g.blurb)}</div>` +
      ds.map(t => `<div class="dial ${t.moved ? 'moved' : ''}" data-key="${esc(t.key)}">
        <div class="dl"><span title="${esc(t.key)}">${esc(t.label)}${t.live ? '' : '<span class="next">next run</span>'}</span>
          <span><b class="dv">${esc(t.shown)}</b>${t.moved ? `<button class="rst" title="back to ${esc(String(t.dflt))}" onclick="dash.post({changes:{'${esc(t.key)}':${JSON.stringify(t.dflt)}}})">↺</button>` : ''}</span></div>` +
        (t.bool
          ? `<div><label><input type="checkbox" ${t.value ? 'checked' : ''} onchange="dash.post({changes:{'${esc(t.key)}':this.checked}})"> ${esc(t.label)}</label></div>`
          : `<input type="range" min="${t.min}" max="${t.max}" step="${t.step}" value="${t.value}" oninput="dash.slide('${esc(t.key)}', this.value, this)">`) +
        (t.help ? `<div class="dh">${esc(t.help)}</div>` : '') + `</div>`).join('') + '</div>';
  }).join('');
  policyFeed();
}

// What has been pulled this run, newest first — the same list the charts are marked from.
function policyFeed() {
  const p = last?.policy ?? [];
  $('pfeed').innerHTML = !p.length ? '<span class="muted">nothing pulled yet this run</span>'
    : '<b>Pulled this run</b>' + p.slice().reverse().slice(0, 12).map(e =>
        `<div>r${e.round} · ${e.changes.map(c => `${esc(c.label)} ${esc(c.fromShown)} → ${esc(c.toShown)}`).join('; ')}</div>`).join('');
}

// Where on a chart's x-axis a policy change landed: the first round at or after it.
function policyMarks(h, x, y1, y2) {
  return (last?.policy ?? []).map(p => {
    const i = h.findIndex(r => r.round >= p.round);
    if (i < 0) return '';
    const what = p.changes.map(c => `${c.label} ${c.fromShown} → ${c.toShown}`).join('\n');
    return `<line x1="${x(i)}" x2="${x(i)}" y1="${y1}" y2="${y2}" stroke="${C.amber}" stroke-width=".7" stroke-dasharray="2 3" opacity=".6">` +
      `<title>round ${p.round}\n${what}</title></line>` +
      `<polygon points="${x(i) - 3},${y1} ${x(i) + 3},${y1} ${x(i)},${y1 + 4}" fill="${C.amber}" opacity=".6"/>`;
  }).join('');
}

let agentsTouched = false;             // once the owner types a size, the poll stops overwriting it
async function togglePause() {
  if (!running) return;
  const pb = $('pausebtn');
  pb.disabled = true;
  await fetch(last?.paused || last?.pausing ? '/resume' : '/pause', { method: 'POST' });
  refreshState();
}
async function toggle() {
  btn.disabled = true;
  statusEl.textContent = running ? 'stopping' : 'starting, creating the ledger on Solana';
  const n = Math.round(+$('agents').value);
  await fetch(running ? '/stop' : '/start', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: running || !(n > 0) ? '{}' : JSON.stringify({ agents: n }) });
  btn.disabled = false;
  refreshState();
}

// The old page's refresh(), minus the fetch: the store hands us the snapshot.
function render(s, error) {
  if (!s) {
    if (error && statusEl) statusEl.innerHTML = `<span class="hungry">backend unreachable: ${esc(error)}</span>`;
    return;
  }
  last = s;
  running = s.running;
  if (!visible) return;                 // the island is up; we redraw when we come back
  btn.textContent = running ? 'Stop' : 'Start';
  // Pause lets the round in hand finish first, so there is a moment of "pausing" in between;
  // pressing again in that moment calls the pause off.
  const pb = $('pausebtn');
  pb.disabled = !running;
  pb.textContent = s.pausing ? 'Cancel pause' : s.paused ? 'Resume' : 'Pause';
  const cfg = s.config ?? {};
  // The village size is chosen here before a start, and fixed while it runs.
  const agentsEl = $('agents');
  agentsEl.disabled = running;
  if (cfg.maxAgents) agentsEl.max = cfg.maxAgents;
  if (cfg.agents && (running || !agentsTouched)) agentsEl.value = cfg.agents;
  const tuning = cfg.decideTimeoutMs
    ? ` · <span class="muted">timeout ${(cfg.decideTimeoutMs / 1000).toFixed(1)}s</span>` : '';
  if (!running) {
    statusEl.innerHTML = `${cfg.agents} agents · ${cfg.brain}${cfg.model ? ` ${cfg.model}` : ''}${tuning}`;
    $('headline').innerHTML = '<span class="muted">not running</span>'; $('dash').style.display = 'none';
    return;
  }
  $('dash').style.display = '';
  statusEl.innerHTML = `<b>round ${s.round}</b> · ${s.seconds}s · ${s.brain} · ${s.agents.length} agents`;
  $('headline').innerHTML =
    `round ${(s.roundMs / 1000).toFixed(1)}s` +
    (s.decide?.timeouts ? ` · <span class="hungry">${s.decide.timeouts} timed out</span>` : '') +
    ` · <b>${s.chain.transactions}</b> tx · <a target="_blank" href="${s.chain.explorer}">ledger ${s.chain.ledger.slice(0, 8)}… ↗</a>` +
    ` · <a target="_blank" href="${s.chain.mintExplorer}" title="SETTLERS. The mint's authority is itself, a program address, so no key can mint one.">SETTLERS ${s.chain.mint.slice(0, 8)}… ↗</a>` +
    (s.chain.settlers != null ? ` ${(s.chain.settlers / 100).toFixed(2)}` : '') +
    (s.llm.calls ? ` · llm ${s.llm.calls} calls $${s.llm.cost.toFixed(3)}` : '') +
    ` · <span class="${s.totals.hungry ? 'hungry' : 'muted'}">hungry ${s.totals.hungry}</span> · <span class="${s.totals.cold ? 'hungry' : 'muted'}">cold ${s.totals.cold}</span>` +
    (s.foreclosures.length ? ` · <span class="hungry">foreclosure r${s.foreclosures[0].round} ${s.foreclosures[0].name}</span>` : '') +
    tuning;
  econ(); wealth(); bankFeed(); details();
  if (dials) policyFeed();
}

/** Mount the panel into `el`. Called once; the panel then lives for the life of the page. */
export function mountAdmin(el) {
  root = el;
  el.innerHTML = MARKUP;
  btn = $('btn'); statusEl = $('status'); world = $('world'); events = $('events'); rows = $('rows');
  $('tiles').innerHTML = TILES.map(t => `<div class="tile" id="t-${t.id}" title="Open the full chart"></div>`).join('');
  TILES.forEach(t => { $('t-' + t.id).onclick = () => { openTile = openTile === t.id ? null : t.id; tiles(); }; });
  $('more').addEventListener('toggle', () => { if (last?.running && visible) { details(); econ(); } });
  $('agents').addEventListener('input', () => { agentsTouched = true; });
  root.querySelectorAll('#range button').forEach(b => b.addEventListener('click', () => setRange(b.dataset.r)));
  setRange(range === 'window' ? 'window' : 'all');
  window.dash = { toggle, togglePause, toggleDials, post, slide, loadDials, toggleAll: () => { showAll = !showAll; agentTable(); },
                  toggleAgent, logScrolled: (id, el) => logScroll.set(id, el.scrollTop) };
  subscribe(render);
  loadDials();
}

/** The shell tells us whether we are on screen; hidden, we draw nothing. */
export function setAdminVisible(on) {
  const was = visible;
  visible = on;
  if (on && !was && last) render(last);
}
