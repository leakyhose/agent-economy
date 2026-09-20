// The swarm: every villager as a body in one physical system, and what passes between them
// as the links. Nothing here is decorative data:
//   - a coloured link is goods changing hands. Each round every good clears in one pooled
//     auction, so there is no literal counterparty; the round's sellers and buyers of a good
//     are matched by quantity, largest first, which is one exact way of splitting what was
//     actually sold among who actually bought it. What the bank sold goes to the bank's node.
//   - gold coins in flight are SETTLERS moving between purses on chain (the `moves` the
//     backend reads back off each settle_cash transaction; most settle through the vault).
//   - a dashed tie to the bank is an open loan; a node's size is that villager's net worth,
//     and its colour is the job they are doing right now.
//
// The physics is a small force simulation written for this graph rather than pulled in:
//   - every pair repels, and overlapping pairs are pushed apart (a hundred nodes is 5,000
//     pairs a frame: nothing);
//   - every link is a spring, tighter and shorter the more money has crossed it;
//   - each job has an anchor on a ring, and a villager is drawn gently toward their job's —
//     so occupations form loose continents, and a villager who changes job migrates;
//   - the bank sits at the middle and everything is pulled faintly toward it;
//   - well damped: a trade nudges the two ends and the graph settles again.
// It is drawn plainly — flat nodes and thin links on white — and the camera keeps the whole
// swarm in view until the viewer pans or zooms (double-click gives it back). Drag a node
// and the rest of the graph follows it.
import { subscribe, subscribeEvents } from '../store.js';

const JOBS = [
  { key: 'gather_food', label: 'fishing', color: '#1f9fb5' },
  { key: 'gather_wood', label: 'chopping wood', color: '#3f9450' },
  { key: 'craft_net', label: 'crafting nets', color: '#d98c2b' },
  { key: 'build_house', label: 'building', color: '#cf6046' },
  { key: 'idle', label: 'at the market', color: '#8a8f98' },
];
const JOB_AT = new Map(JOBS.map((j, i) => [j.key, i]));
const BANK = -1, GOLD = '#ffcf4a';
// a link takes the colour of the good that last crossed it
const GOOD_COLOR = { food: '#1f9fb5', wood: '#3f9450', nets: '#d98c2b', houses: '#cf6046', boats: '#8a8f98' };
const MAX_LINKS = 260;
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(',');

export function mountSwarm(host, { onPick } = {}) {
  host.innerHTML = `
    <div class="swarm-stage">
      <canvas></canvas>
      <div class="swarm-legend">
        ${JOBS.map(j => `<span><i style="background:${j.color}"></i>${j.label}</span>`).join('')}
        <span><i style="background:${GOLD}"></i>the bank</span>
        <span class="swarm-key">size = net worth · link = goods traded, in the good's colour · gold = coins paid on chain · dashed = open loan</span>
      </div>
      <div class="swarm-tip" hidden></div>
      <button class="swarm-full" title="Fullscreen">Fullscreen</button>
      <div class="swarm-empty">Start a village and the swarm assembles here.</div>
    </div>`;
  const stage = host.querySelector('.swarm-stage'), cv = host.querySelector('canvas'), g = cv.getContext('2d');
  const tip = host.querySelector('.swarm-tip'), emptyEl = host.querySelector('.swarm-empty');
  cv.addEventListener('dblclick', () => { ownCam = false; });   // double-click hands the camera back
  host.querySelector('.swarm-full').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen?.());

  // ---- state ----------------------------------------------------------------------
  const nodes = new Map();            // id -> node (the bank is id -1)
  const links = new Map();            // "a|b" (a < b) -> { a, b, w, flash, paid }
  const coins = [];                   // payments in flight: { from, to, t, dur, bend, size }
  const byName = new Map();           // villager name -> id, for events that carry names only
  let W = 0, H = 0, dpr = 1, running = false, payments = 0, trades = 0, lastRoundSeen = 0;
  let cam = { x: 0, y: 0, k: 1 }, hover = null, drag = null, pan = null, active = false, raf = 0, last = 0;

  const bank = () => nodes.get(BANK);
  function ensureBank() {
    if (!nodes.has(BANK)) nodes.set(BANK, { id: BANK, name: 'the bank', x: 0, y: 0, vx: 0, vy: 0, r: 26, tr: 26, color: GOLD, job: -1, kick: 0, born: performance.now() });
  }
  const radiusFor = wealth => 5 + Math.sqrt(Math.max(0, wealth)) * 0.9;

  // ---- data in --------------------------------------------------------------------
  function onState(s) {
    running = !!s?.running;
    emptyEl.style.display = running ? 'none' : '';
    if (!running) { nodes.clear(); links.clear(); coins.length = 0; byName.clear(); payments = 0; trades = 0; lastRoundSeen = 0; return; }
    ensureBank();
    const seen = new Set([BANK]);
    const maxWealth = Math.max(1, ...s.agents.map(a => a.wealth));
    for (const a of s.agents) {
      seen.add(a.id);
      byName.set(a.name, a.id);
      let n = nodes.get(a.id);
      if (!n) {
        // born at the middle with a shove outward: the swarm assembles by bursting open
        const ang = Math.random() * Math.PI * 2, sp = 120 + Math.random() * 120;
        nodes.set(a.id, n = { id: a.id, x: Math.cos(ang) * 8, y: Math.sin(ang) * 8, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
                              r: 0, tr: 6, kick: 0, job: 4, born: performance.now() });
      }
      const job = JOB_AT.get(a.activity);
      if (job !== undefined) n.job = job;                 // "deciding" keeps the last job, as the island does
      n.name = a.name; n.wealth = a.wealth; n.cash = a.cash; n.debt = a.debt; n.wellbeing = a.wellbeing;
      n.hungry = a.hunger > 0 || a.cold >= 2; n.thought = a.thought; n.activity = a.activity; n.model = a.model;
      n.color = JOBS[n.job].color;
      // net worth, on a square root so the richest villager is large, not a planet
      n.tr = Math.min(30, radiusFor(a.wealth) * (22 / Math.max(22, radiusFor(maxWealth))) + 2);
    }
    for (const id of [...nodes.keys()]) if (!seen.has(id)) nodes.delete(id);
    for (const [k, l] of links) if (!nodes.has(l.a) || !nodes.has(l.b)) links.delete(k);
    // the rounds we have not seen yet, oldest first (the SSE stream usually beats the poll to it)
    for (const e of [...(s.events ?? [])].reverse()) if (e.type === 'round') onRound(e);
    // With a big village the server's event buffer fills with per-agent events and holds no
    // rounds at all, so the last round's own transaction list is read as well.
    if (s.chain?.lastRound?.sigs) onRound({ round: s.chain.lastRound.round, sigs: s.chain.lastRound.sigs });
  }

  const idOf = (id, name) => (typeof id === 'number' ? id : name === 'the bank' ? BANK : byName.get(name) ?? null);
  function onRound(e) {
    if (!running || !(e.round > lastRoundSeen)) return;
    lastRoundSeen = e.round;
    let delay = 0;
    for (const tx of e.sigs ?? []) for (const m of tx.moves ?? []) {
      const a = idOf(m.fromId, m.from), b = idOf(m.toId, m.to);
      if (a === null || b === null || a === b || !nodes.has(a) || !nodes.has(b)) continue;
      pay(a, b, m.amount / 100, delay);
      delay += 0.035;                                     // a round's payments fan out, not all in one frame
    }
    // the market: who the goods went from and to. The biggest few dozen are shown in flight.
    const deals = marketLinks(e.trades ?? []);
    trades += deals.length;
    deals.forEach((d, i) => flow(d.from, d.to, d.value, 0.25 + i * 0.02, GOOD_COLOR[d.good] ?? '#8a8f98', 0.2, 0.15, i < 16));
    if (links.size > MAX_LINKS) {                          // a hairball says nothing: the faintest ties go first
      const weakest = [...links.entries()].sort((x, y) => x[1].w - y[1].w).slice(0, links.size - MAX_LINKS);
      for (const [k] of weakest) links.delete(k);
    }
  }
  // Something went from a to b: `amount` of it, drawn in `color`. `gain` is how much the tie
  // tightens, `punch` how hard the two are knocked — a round's worth of market fills is a
  // hundred of these at once, so they are gentler than an on-chain payment.
  function flow(a, b, amount, delay, color, gain, punch, showCoins) {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    let l = links.get(key);
    if (!l) links.set(key, l = { a: Math.min(a, b), b: Math.max(a, b), w: 0, flash: 0, paid: 0, color });
    l.w = Math.min(1, l.w + gain * (0.6 + Math.min(1, Math.log10(1 + amount) * 0.4)));
    l.flash = Math.max(l.flash, punch); l.paid += amount;
    if (color !== GOLD || !l.color) l.color = color;
    if (!active) return;                                   // unseen: the link is kept, the fireworks are not queued up
    if (showCoins && coins.length < 160) {
      const n = 1;
      for (let i = 0; i < n; i++) coins.push({ from: a, to: b, t: -(delay + i * 0.07), dur: 0.85 + Math.random() * 0.3, bend: (Math.random() - 0.5) * 0.5,
                                               size: 2 + Math.min(1.4, Math.log10(1 + amount) * 0.5), rgb: rgb(color === GOLD ? '#c9972a' : color) });
    }
    // the kick: the giver recoils, the taker is knocked back, along the line between them
    const A = nodes.get(a), B = nodes.get(b), dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy) || 1, f = (22 + 12 * Math.log10(1 + amount)) * punch;
    A.vx -= dx / d * f; A.vy -= dy / d * f; B.vx += dx / d * f * 0.6; B.vy += dy / d * f * 0.6;
    A.kick = Math.max(A.kick, punch); B.kick = Math.max(B.kick, punch);
  }
  const pay = (a, b, amount, delay) => { payments++; flow(a, b, amount, delay, GOLD, 0.3, 0.4, a !== BANK && b !== BANK); };

  // One good's pooled clearing, split among who sold and who bought: largest seller to largest
  // buyer until both sides are spent. Whatever buyers took beyond what villagers sold was the
  // bank's fire sale, and comes from the bank.
  function marketLinks(trades) {
    const by = new Map();
    for (const t of trades) {
      if (!nodes.has(t.agent)) continue;
      let gd = by.get(t.good); if (!gd) by.set(t.good, gd = { sell: [], buy: [] });
      gd[t.side === 'sell' ? 'sell' : 'buy'].push({ id: t.agent, q: t.qty, price: t.price / 100 });
    }
    const out = [];
    for (const [good, gd] of by) {
      gd.sell.sort((x, y) => y.q - x.q); gd.buy.sort((x, y) => y.q - x.q);
      let i = 0, j = 0;
      while (j < gd.buy.length) {
        const bq = gd.buy[j], sq = gd.sell[i] ?? { id: BANK, q: Infinity };
        const q = Math.min(sq.q, bq.q);
        if (sq.id !== bq.id && q > 0) out.push({ from: sq.id, to: bq.id, q, value: q * bq.price, good });
        sq.q -= q; bq.q -= q;
        if (sq.q <= 0 && sq.id !== BANK) i++;
        if (bq.q <= 0) j++;
      }
    }
    return out.sort((x, y) => y.value - x.value);
  }
  function onEvent(m) {
    if (m.type === 'round') return onRound(m);
    const n = m.agent != null ? nodes.get(m.agent) : null;
    if (!n) return;
    if (m.type === 'order') n.kick = Math.min(1, n.kick + 0.5);
    else if (m.type === 'borrow') pay(BANK, n.id, m.amount / 100, 0);
    else if (m.type === 'repay') pay(n.id, BANK, m.amount / 100, 0);
  }

  // ---- physics --------------------------------------------------------------------
  function step(dt) {
    const list = [...nodes.values()], N = list.length;
    const ring = 420;
    for (let i = 0; i < N; i++) {
      const a = list[i];
      for (let j = i + 1; j < N; j++) {
        const b = list[j];
        let dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.5; }
        const d = Math.sqrt(d2), reach = a.r + b.r + 22;
        let f = 60000 / d2;                                 // everyone repels everyone
        if (d < reach) f += (reach - d) * 9;               // and nobody overlaps
        const fx = dx / d * f, fy = dy / d * f;
        a.vx -= fx * dt; a.vy -= fy * dt; b.vx += fx * dt; b.vy += fy * dt;
      }
    }
    for (const l of links.values()) {                      // a link is a spring: more money, shorter and stiffer
      const a = nodes.get(l.a), b = nodes.get(l.b);
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
      const rest = 300 - 110 * l.w + a.r + b.r, k = 0.35 + 1.6 * l.w;
      const f = (d - rest) * k, fx = dx / d * f, fy = dy / d * f;
      a.vx += fx * dt; a.vy += fy * dt; b.vx -= fx * dt; b.vy -= fy * dt;
      l.w *= Math.exp(-dt / 30); l.flash *= Math.exp(-dt / 0.9);
      l.dead = l.w < 0.03;
    }
    for (const [k, l] of links) if (l.dead) links.delete(k);
    const t = performance.now() * 0.001;
    for (const n of list) {
      if (n.id === BANK) { n.vx += -n.x * 6 * dt; n.vy += -n.y * 6 * dt; }
      else {
        const ang = n.job / JOBS.length * Math.PI * 2 - Math.PI / 2;   // toward their job's continent
        n.vx += (Math.cos(ang) * ring - n.x) * 0.55 * dt; n.vy += (Math.sin(ang) * ring - n.y) * 0.55 * dt;
        if (n.debt > 0) { n.vx += -n.x * 0.5 * dt; n.vy += -n.y * 0.5 * dt; }   // a debtor is held a little closer to the bank
        n.vx += Math.sin(t * 0.5 + n.id * 1.7) * 3 * dt; n.vy += Math.cos(t * 0.45 + n.id * 2.3) * 3 * dt;   // never quite still
      }
      if (drag && drag.n === n) { n.vx = n.vy = 0; continue; }
      const damp = Math.exp(-dt * 3.4);                    // settles quickly: a nudge, not a ring
      n.vx *= damp; n.vy *= damp;
      const sp = Math.hypot(n.vx, n.vy); if (sp > 900) { n.vx *= 900 / sp; n.vy *= 900 / sp; }
      n.x += n.vx * dt; n.y += n.vy * dt;
      n.r += (n.tr - n.r) * Math.min(1, dt * 5);
      n.kick *= Math.exp(-dt / 0.5);
    }
    for (let i = coins.length - 1; i >= 0; i--) { const c = coins[i]; c.t += dt / c.dur * (c.t < 0 ? c.dur : 1); if (c.t >= 1 || !nodes.has(c.from) || !nodes.has(c.to)) coins.splice(i, 1); }
  }

  // ---- drawing --------------------------------------------------------------------
  function draw() {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
    g.translate(W / 2 + cam.x, H / 2 + cam.y); g.scale(cam.k, cam.k);
    const px = 1 / cam.k;                                  // one screen pixel, in world units

    const near = hover ? new Set([hover.id]) : null;
    for (const l of links.values()) {
      const a = nodes.get(l.a), b = nodes.get(l.b);
      const lit = hover && (l.a === hover.id || l.b === hover.id);
      if (lit) { near.add(l.a); near.add(l.b); }
      const alpha = hover ? (lit ? 0.9 : 0.05) : 0.16 + 0.5 * l.w + 0.2 * l.flash;
      g.strokeStyle = `rgba(${rgb(l.color === GOLD ? '#c9972a' : l.color)},${Math.min(1, alpha).toFixed(3)})`;
      g.lineWidth = (0.6 + 1.8 * l.w) * px;
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    }
    const B = bank();
    if (B) {                                               // open loans: a dashed tie to the bank
      g.setLineDash([4 * px, 5 * px]);
      for (const n of nodes.values()) if (n.debt > 0) {
        const lit = hover && (hover.id === n.id || hover.id === BANK);
        if (lit) { near.add(n.id); near.add(BANK); }
        g.strokeStyle = `rgba(160,120,30,${(hover ? (lit ? 0.8 : 0.04) : 0.28).toFixed(3)})`; g.lineWidth = Math.min(2, 0.7 + n.debt / 160) * px;
        g.beginPath(); g.moveTo(n.x, n.y); g.lineTo(B.x, B.y); g.stroke();
      }
      g.setLineDash([]);
    }
    for (const c of coins) {                               // what is in flight: one small dot, on a slight arc
      if (c.t < 0) continue;
      const a = nodes.get(c.from), b = nodes.get(c.to), u = c.t * c.t * (3 - 2 * c.t), v = 1 - u;
      const mx = (a.x + b.x) / 2 - (b.y - a.y) * c.bend, my = (a.y + b.y) / 2 + (b.x - a.x) * c.bend;
      g.fillStyle = `rgba(${c.rgb},.9)`;
      g.beginPath(); g.arc(v * v * a.x + 2 * v * u * mx + u * u * b.x, v * v * a.y + 2 * v * u * my + u * u * b.y, c.size * px, 0, Math.PI * 2); g.fill();
    }

    const ranked = [...nodes.values()].filter(n => n.id !== BANK).sort((x, y) => y.tr - x.tr);
    const labelled = new Set(ranked.slice(0, 8).map(n => n.id));
    for (const n of nodes.values()) {
      const dim = near && !near.has(n.id), r = n.r * (1 + 0.06 * n.kick);
      g.globalAlpha = dim ? 0.16 : 1;
      g.fillStyle = n.id === BANK ? '#e0b13a' : n.color; g.beginPath(); g.arc(n.x, n.y, r, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#fff'; g.lineWidth = 1.5 * px; g.stroke();
      if (n.hungry) { g.strokeStyle = '#d8453a'; g.lineWidth = 1.6 * px; g.beginPath(); g.arc(n.x, n.y, r + 3 * px, 0, Math.PI * 2); g.stroke(); }   // in want
      if (n === hover) { g.strokeStyle = '#111'; g.lineWidth = 1.5 * px; g.beginPath(); g.arc(n.x, n.y, r + 2.5 * px, 0, Math.PI * 2); g.stroke(); }
      if (!dim && (n.id === BANK || labelled.has(n.id) || (near && near.has(n.id)) || cam.k > 1.7)) {
        g.font = `${n.id === BANK ? 800 : 700} ${(n.id === BANK ? 11 : 10) * px}px Nunito, system-ui, sans-serif`;
        g.textAlign = 'center'; g.fillStyle = '#33373b';
        g.fillText(n.id === BANK ? 'THE BANK' : n.name, n.x, n.y + r + 12 * px);
      }
    }
    g.globalAlpha = 1;
  }

  // Fit the whole swarm in view, with a margin, easing as it spreads or a fullscreen changes
  // the stage. The moment the viewer pans or zooms, the camera is theirs.
  let ownCam = false;
  function fit(dt) {
    if (ownCam || !nodes.size) return;
    let far = 120;
    for (const n of nodes.values()) far = Math.max(far, Math.abs(n.x) * (H / W) + n.r, Math.abs(n.y) + n.r);
    const k = Math.min(1.6, (H / 2 - 46) / far);
    cam.k += (k - cam.k) * Math.min(1, dt * 1.5); cam.x += -cam.x * Math.min(1, dt * 1.5); cam.y += -cam.y * Math.min(1, dt * 1.5);
  }
  function frame(now) {
    raf = active ? requestAnimationFrame(frame) : 0;
    const dt = Math.min(0.033, (now - (last || now)) / 1000); last = now;
    if (!W || document.hidden) return;
    fit(dt);
    if (nodes.size) { step(dt / 2); step(dt / 2); }        // two half steps: the springs stay stable when a frame runs long
    draw();
  }

  // ---- input ----------------------------------------------------------------------
  const world = e => { const b = cv.getBoundingClientRect(); return [((e.clientX - b.left) - W / 2 - cam.x) / cam.k, ((e.clientY - b.top) - H / 2 - cam.y) / cam.k]; };
  const pick = (x, y) => { let best = null, bd = 1e9; for (const n of nodes.values()) { const d = Math.hypot(n.x - x, n.y - y) - n.r; if (d < 6 / cam.k && d < bd) { bd = d; best = n; } } return best; };
  cv.addEventListener('pointerdown', e => {
    const [x, y] = world(e), n = pick(x, y);
    cv.setPointerCapture(e.pointerId);
    if (n) drag = { n, moved: 0, lx: x, ly: y, vx: 0, vy: 0, at: performance.now() };
    else { pan = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y }; ownCam = true; }
  });
  cv.addEventListener('pointermove', e => {
    const [x, y] = world(e);
    if (drag) {
      const now = performance.now(), dtm = Math.max(1, now - drag.at) / 1000;
      drag.vx = (x - drag.lx) / dtm; drag.vy = (y - drag.ly) / dtm; drag.at = now;
      drag.moved += Math.hypot(x - drag.lx, y - drag.ly); drag.lx = x; drag.ly = y;
      drag.n.x = x; drag.n.y = y;
    } else if (pan) { cam.x = pan.cx + e.clientX - pan.x; cam.y = pan.cy + e.clientY - pan.y; }
    else hover = pick(x, y);
    cv.style.cursor = drag ? 'grabbing' : hover ? 'pointer' : pan ? 'grabbing' : 'grab';
    showTip(e);
  });
  const release = () => {
    if (drag) {
      if (drag.moved < 4) { if (drag.n.id !== BANK) onPick?.(drag.n.id); }
      else { drag.n.vx = Math.max(-900, Math.min(900, drag.vx)); drag.n.vy = Math.max(-900, Math.min(900, drag.vy)); }   // thrown, not dropped
    }
    drag = pan = null;
  };
  cv.addEventListener('pointerup', release);
  cv.addEventListener('pointercancel', release);
  cv.addEventListener('pointerleave', () => { if (!drag) { hover = null; tip.hidden = true; } });
  cv.addEventListener('wheel', e => {
    e.preventDefault(); ownCam = true;
    const b = cv.getBoundingClientRect(), px = e.clientX - b.left - W / 2, py = e.clientY - b.top - H / 2;
    const k = Math.min(4, Math.max(0.35, cam.k * Math.exp(-e.deltaY * 0.0015)));
    cam.x = px - (px - cam.x) * k / cam.k; cam.y = py - (py - cam.y) * k / cam.k; cam.k = k;   // zoom about the cursor
  }, { passive: false });
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function showTip(e) {
    const n = drag?.n ?? hover;
    if (!n) { tip.hidden = true; return; }
    const ties = [...links.values()].filter(l => l.a === n.id || l.b === n.id);
    tip.innerHTML = n.id === BANK
      ? `<b>The bank</b><div>${ties.length} live links · ${[...nodes.values()].filter(x => x.debt > 0).length} open loans</div>`
      : `<b>${esc(n.name)}</b> <span style="color:${n.color}">${esc(JOBS[n.job].label)}</span>` +
        `<div>net worth ${n.wealth?.toFixed(2)} · cash ${n.cash?.toFixed(2)}${n.debt ? ` · owes ${n.debt.toFixed(2)}` : ''} · wellbeing ${n.wellbeing?.toFixed(1)}</div>` +
        `<div>${ties.length} live links${n.model ? ` · ${esc(n.model)}` : ''}${n.hungry ? ' · <span style="color:#ff6a5e">in want</span>' : ''}</div>` +
        (n.thought ? `<div class="swarm-said">${esc(n.thought)}</div>` : '') + `<div class="swarm-hint">click to open their log</div>`;
    tip.hidden = false;
    const b = stage.getBoundingClientRect(), x = e.clientX - b.left + 14, y = e.clientY - b.top + 14;
    tip.style.left = Math.min(x, b.width - tip.offsetWidth - 8) + 'px';
    tip.style.top = Math.min(y, b.height - tip.offsetHeight - 8) + 'px';
  }

  // ---- lifecycle ------------------------------------------------------------------
  function resize() {
    const b = stage.getBoundingClientRect();
    W = Math.round(b.width); H = Math.round(b.height); dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = W * dpr; cv.height = H * dpr;
  }
  new ResizeObserver(resize).observe(stage);
  subscribe(s => onState(s));
  subscribeEvents(onEvent);
  return {
    // runs only while it can be seen: the physics is cheap, but not free
    setActive(on) {
      if (on === active) return;
      active = on; last = 0;
      if (on) { resize(); raf = requestAnimationFrame(frame); } else cancelAnimationFrame(raf);
    },
  };
}
