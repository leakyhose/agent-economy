// The island view — the component from "Moku Island.dc.html", ported to React. The logic
// (activityFor / agentView / toSim / renderVals) is the original code; what changed is that
// it reads the shared store instead of polling on its own, the template is now JSX, and the
// readouts move with each villager rather than once a round: the market wire, the live feed
// and the "doing now" tally are driven by each agent's own event as it lands (pulse.js),
// while /state stays the thing they are reconciled against.
import React from 'react';
import { subscribe, command } from '../store.js';
import { subscribeActs, subscribeUpdates, subscribeRound, queued } from './pulse.js';
import { S } from './css.js';
import { LOCS, bucketOf, ACT_LABEL, SHORT, SKIN, HAIR, SHIRT, KINDS, EMPTY_SIM } from './constants.js';
import './island3d.js';   // defines <island-3d>
import { bodyOf, moodOf, drawBlob } from './blob.js';
import { paintBlob } from './blob3d.js';

const GOODS = ['food', 'wood', 'nets', 'boats', 'houses'];
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const coins = c => (Number(c) / 100).toFixed(2);

// One line on the market wire for one villager, the moment they answer.
function wireLine(act, seen) {
  const who = act.name || `Settler ${act.id}`;
  const order = act.orders?.at(-1);
  if (order) return `${who} ${order.side === 'buy' ? 'bids' : 'offers'} ${order.qty} ${order.good} at ${coins(order.price ?? order.limit)}c` +
    (order.reason ? `: ${clip(order.reason, 70)}` : '');
  const said = seen.thought || seen.reason;
  const doing = ACT_LABEL[seen.task] || (seen.task ? seen.task.replace(/_/g, ' ') : 'thinking it over');
  return `${who}, ${doing.toLowerCase()}${said ? `: ${clip(said, 90)}` : ''}`;
}

// A row for the live feed, posted the moment a villager acts — before there is a signature
// to point at. Settled rows, which have one, push it down the list a round later.
let rowSeq = 0;
const liveRow = (act, note) => ({
  id: "live-" + (++rowSeq),
  kind: act.orders?.length ? 'post_order' : act.bank ? 'mint_loan' : 'transfer_goods',
  short: act.orders?.length ? 'order' : act.bank ? 'bank' : 'acts',
  live: true, who: clip(act.name || `#${act.id}`, 18), note: clip(note, 26),
});

// The transaction count, run up to rather than jumped to: a round lands a few hundred
// transactions at once, and a number that rolls reads as a chain being written to.
function CountUp({ value, style }) {
  const ref = React.useRef(null);
  const shown = React.useRef(value);
  React.useEffect(() => {
    const from = shown.current, to = value;
    if (from === to || to < from) { shown.current = to; if (ref.current) ref.current.textContent = to; return; }
    let raf = 0; const t0 = performance.now(), ms = Math.min(1400, 300 + (to - from) * 6);
    const step = now => {
      const k = Math.min(1, (now - t0) / ms), eased = 1 - (1 - k) ** 3;
      shown.current = Math.round(from + (to - from) * eased);
      if (ref.current) ref.current.textContent = shown.current;
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <div ref={ref} style={style}>{shown.current}</div>;
}

// "#3f9450" -> "63,148,80", for rgba(); and the same colour pushed toward white (k > 0) or black (k < 0)
const rgbOf = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const shade = (hex, k) => "rgb(" + rgbOf(hex).map(v => Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k))).join(",") + ")";

// One villager in the lineup: the island's own 3D model (blob3d.js), so the same build, face,
// hat and mood — alive the way they are on the island: blinking on their own clock, breathing,
// and turning to look about. Every portrait on the page is painted from ONE ticker at ~30 fps,
// and only while it is actually in view; where WebGL will not start, the flat painter stands in.
const BLOB_W = 96, BLOB_H = 150, BLOB_UNIT = 76;
const portraits = new Set();           // { cv, id, get() -> { mood, color } }
let portraitRaf = 0, portraitAt = 0;
function portraitTick(now) {
  portraitRaf = portraits.size ? requestAnimationFrame(portraitTick) : 0;
  if (now - portraitAt < 32 || document.hidden) return;
  portraitAt = now;
  const dpr = Math.min(2, window.devicePixelRatio || 1), vh = window.innerHeight;
  for (const p of portraits) {
    const r = p.cv.getBoundingClientRect();
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > window.innerWidth || !r.width) continue;   // off screen, or scrolled out of the row
    if (p.cv.width !== BLOB_W * dpr) { p.cv.width = BLOB_W * dpr; p.cv.height = BLOB_H * dpr; }
    const B = bodyOf(p.id), t = now * 0.001 + B.phase, { mood, color } = p.get();
    const blink = t % B.blinkEvery < 0.13;
    // a slow look to one side and back, each on their own beat, and a breath
    const yaw = Math.sin(t * 0.55) * 0.42 + Math.sin(t * 1.3) * 0.1;
    const breath = 0.018 * Math.sin(t * 1.9);
    const g = p.cv.getContext("2d");
    if (!paintBlob(g, { id: p.id, mood, blink, color, yaw, breath, w: BLOB_W, h: BLOB_H, dpr })) {
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, BLOB_W, BLOB_H);
      drawBlob(g, { id: p.id, mood, blink, color, dark: shade(color, -0.3), cx: BLOB_W / 2, base: BLOB_H - 2, unit: BLOB_UNIT });
    }
  }
}
function BlobFigure({ id, mood, color }) {
  const ref = React.useRef(null);
  const live = React.useRef({ mood, color });
  live.current = { mood, color };
  React.useEffect(() => {
    const p = { cv: ref.current, id, get: () => live.current };
    portraits.add(p);
    if (!portraitRaf) portraitRaf = requestAnimationFrame(portraitTick);
    return () => { portraits.delete(p); };
  }, [id]);
  return <canvas ref={ref} style={S(`display: block; width: ${BLOB_W}px; height: ${BLOB_H}px;`)}></canvas>;
}

// The lineup. Everyone at the place stands against the wall — a pale flat tint of the place's
// colour, ruled with height lines — on a floor in its darker shade, with a name card each,
// in two rows that never become three.
// Villagers come and go many times a round, and a row that simply re-rendered would blink
// them in and out and jolt everyone else sideways. So:
//   arriving  a new one drops into line with a little bounce (`blobin`);
//   leaving   one who has gone is kept for LEAVE_MS, hops out of line (`blobout`), then is dropped;
//   the rest  shuffle along to close the gap (FLIP, measured against the lineup itself so
//             that scrolling is never mistaken for movement).
// Everyone's thought is up over their head the whole time, in full: nothing to click, nothing clamped.
const LEAVE_MS = 320, FLOOR_H = 40, SLOT_W = 196;
function Lineup({ agents, color }) {
  const [gone, setGone] = React.useState([]);          // [{ agent, until }]: departed, still hopping off
  const prev = React.useRef(new Map());                 // id -> the agent as last shown here
  const els = React.useRef(new Map());                  // id -> element
  const spots = React.useRef(new Map());                // id -> [left, top] inside the lineup

  const present = new Map(agents.map(a => [a.id, a]));
  React.useEffect(() => {
    const left = [];
    for (const [id, a] of prev.current) if (!present.has(id)) left.push({ agent: a, until: Date.now() + LEAVE_MS });
    prev.current = present;
    if (left.length) setGone(g => [...g.filter(x => !present.has(x.agent.id)), ...left]);
  });
  React.useEffect(() => {
    if (!gone.length) return;
    const t = setTimeout(() => setGone(g => g.filter(x => x.until > Date.now() && !present.has(x.agent.id))), LEAVE_MS + 20);
    return () => clearTimeout(t);
  }, [gone]);

  const leaving = gone.filter(x => !present.has(x.agent.id));
  const shown = [...agents.map(a => ({ a, out: false })), ...leaving.map(x => ({ a: x.agent, out: true }))]
    .sort((x, y) => x.a.id - y.a.id);                   // a leaver hops out from where it stood

  React.useLayoutEffect(() => {
    const next = new Map();
    for (const [id, el] of els.current) {
      if (!el) continue;
      const at = [el.offsetLeft, el.offsetTop];
      next.set(id, at);
      const was = spots.current.get(id);
      if (was && (was[0] !== at[0] || was[1] !== at[1]))
        el.animate([{ transform: `translate(${was[0] - at[0]}px,${was[1] - at[1]}px)` }, { transform: "none" }],
                   { duration: 340, easing: "cubic-bezier(.2,.7,.2,1)" });
    }
    spots.current = next;
  });

  // Two rows, always, and a backdrop that never moves. The wall, its height lines and the
  // floor are painted once, behind everything, on a layer that neither scrolls nor takes part
  // in the shuffle; the villagers stand in a transparent two-row grid laid over it. When
  // someone arrives or leaves, only villagers move — the room stays put. A crowd too big for
  // two rows runs on to the right, and the rows scroll sideways together over the same wall.
  const wall = shade(color, 0.8), rule = shade(color, 0.45), floor = shade(color, -0.42);
  const row = top => (
    <div style={S(`position: absolute; left: 0; right: 0; top: ${top}; height: 50%; background: ${wall};`)}>
      {[30, 60, 90, 120].map(y => <i key={y} style={S(`position: absolute; left: 0; right: 0; bottom: ${FLOOR_H + y}px; height: 1.5px; background: ${rule};`)}></i>)}
      <i style={S(`position: absolute; left: 0; right: 0; bottom: 0; height: ${FLOOR_H}px; background: ${floor};`)}></i>
    </div>
  );

  return (
    <div style={S("position: relative; flex: 1; min-height: 0; margin: 0 18px 18px; border-radius: 6px; overflow: hidden;")}>
      {row("0")}{row("50%")}
      <div style={S(`position: absolute; inset: 0; overflow-x: auto; overflow-y: hidden; display: grid; grid-template-rows: 1fr 1fr; grid-auto-flow: column; grid-auto-columns: ${SLOT_W}px; justify-content: safe center;`)}>
        {shown.map(({ a, out }) => (
          <div key={a.id} ref={el => { if (el) els.current.set(a.id, el); else els.current.delete(a.id); }}
               style={S("position: relative; min-height: 0; display: flex; flex-direction: column; justify-content: flex-end; align-items: center;")}>
            <div style={S(`position: relative; display: flex; flex-direction: column; align-items: center; width: 100%; max-height: 100%; min-height: 0; animation: ${out ? "blobout" : "blobin"} ${out ? LEAVE_MS : 420}ms cubic-bezier(.3,1.3,.5,1) both;`)}>
              {a.thought && (
                <div style={S(`position: relative; flex: 0 1 auto; min-height: 0; display: flex; margin: 10px 8px 9px; border-radius: 8px; background: #fff; box-shadow: 0 2px 0 ${rule};`)}>
                  {/* the whole thought; if a window is too short for it, it scrolls rather than being cut */}
                  <div style={S("min-height: 0; overflow-y: auto; padding: 7px 9px; font-size: 11.5px; line-height: 1.36; font-weight: 700; color: #26221f; text-align: center; overflow-wrap: anywhere;")}>{a.thought}</div>
                  <i style={S("position: absolute; left: 50%; bottom: -5px; width: 10px; height: 10px; margin-left: -5px; background: #fff; transform: rotate(45deg);")}></i>
                </div>
              )}
              <div style={S("flex: none;")}><BlobFigure id={a.id} mood={a.mood} color={color} /></div>
              {/* the card they hold: their name */}
              <div style={S(`flex: none; height: ${FLOOR_H}px; display: flex; align-items: center;`)}>
                <span style={S(`max-width: ${SLOT_W - 16}px; padding: 3px 8px; border-radius: 3px; background: rgba(255,255,255,.94); box-shadow: 0 1px 3px rgba(0,0,0,.35); font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; font-weight: 500; letter-spacing: .04em; text-transform: uppercase; color: #1d1a18; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`)}>{a.name}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
      {agents.length === 0 && !leaving.length && (
        <div style={S(`position: absolute; left: 0; right: 0; top: 22%; text-align: center; font-size: 13px; font-weight: 800; color: ${shade(color, -0.35)};`)}>Nobody in the lineup right now.</div>
      )}
    </div>
  );
}

const FEED_ROWS = 10;      // kept in the list; the panel shows about seven and fades the rest off its edge

export default class IslandApp extends React.Component {
  state = { sim: EMPTY_SIM, running: false, paused: false, pausing: false, selected: null, closing: false, live: false, tickN: 0, uiHidden: false, busy: false, error: "" };

  snapshot = null;          // the last /state, kept so the view can be rebuilt between polls
  live = new Map();         // agent id -> what that villager has told us since the last round
  lastRound = null;         // the round event, applied before /state has caught up with it
  wire = [];                // newest first: one line per villager, as they answer
  ticker = [];              // newest first: live feed rows, before there are signatures

  componentDidMount() {
    this.onPin = (e) => { clearTimeout(this._closing); this.setState({ selected: e.detail, closing: false }); };
    window.addEventListener("moku:location", this.onPin);
    this.startCrawls();
    // One shared poll and one shared /events stream for the whole app (see src/store.js).
    this.unsubscribe = subscribe((snapshot, error) => this.apply(snapshot, error));
    // …and one act per villager, in that villager's own moment (see src/island/pulse.js).
    this.unsubActs = subscribeActs(act => this.onAct(act));
    this.unsubUpdates = subscribeUpdates(act => this.onAct(act));
    this.unsubRound = subscribeRound(e => this.onRound(e));
  }
  componentWillUnmount() {
    this.stopCrawls();
    this.unsubscribe?.();
    this.unsubActs?.();
    this.unsubUpdates?.();
    this.unsubRound?.();
    clearTimeout(this._nudge);
    clearTimeout(this._closing);
    window.removeEventListener("moku:location", this.onPin);
  }

  // The market wire scrolls from here rather than from a CSS keyframe. The poll and
  // the round events rewrite their text, and translateX(-50%) is a share of the track's
  // own width, so every width change used to remap the same animation progress onto a
  // different pixel offset and the row lurched. An offset kept in pixels does not move
  // when the content does; the content repeats, so subtracting exactly one copy width
  // to wrap around is invisible.
  startCrawls() {
    this.stopCrawls();
    const SPEED = 52; // px per second
    const tracks = [{ sel: '[data-crawl="wire"]', offset: 0, el: null }];
    let last = 0;
    const step = now => {
      this.crawlRaf = requestAnimationFrame(step);
      // A hidden tab stops firing frames; bank nothing so returning does not jump.
      if (document.visibilityState === "hidden") { last = 0; return; }
      const delta = last ? Math.min(now - last, 100) : 0;
      last = now;
      for (const track of tracks) {
        if (!track.el || !track.el.isConnected) track.el = document.querySelector(track.sel);
        const el = track.el;
        const copy = el && el.firstElementChild;
        const width = copy ? copy.offsetWidth : 0;
        // nothing to measure yet: hold and wait
        if (width <= 0) continue;
        track.offset += SPEED * delta / 1000;
        if (track.offset >= width) track.offset -= Math.floor(track.offset / width) * width;
        el.style.transform = "translate3d(" + (-track.offset).toFixed(2) + "px,0,0)";
      }
    };
    this.onCrawlVisibility = () => { last = 0; };
    document.addEventListener("visibilitychange", this.onCrawlVisibility);
    this.crawlRaf = requestAnimationFrame(step);
  }

  stopCrawls() {
    if (this.crawlRaf) cancelAnimationFrame(this.crawlRaf);
    this.crawlRaf = 0;
    if (this.onCrawlVisibility) document.removeEventListener("visibilitychange", this.onCrawlVisibility);
    this.onCrawlVisibility = null;
  }

  /** A hundred villagers answering 15 ms apart must not be a hundred React renders. */
  nudge() {
    if (this._nudge || !this.snapshot) return;
    this._nudge = setTimeout(() => { this._nudge = null; this.setState({ sim: this.toSim(this.snapshot) }); }, 110);
  }

  /** One villager has answered. Their job, their thought and their orders, right now. */
  onAct(act) {
    const was = this.live.get(act.id) || {};
    const seen = {
      task: act.task || was.task, thought: act.thought || was.thought, reason: act.reason || was.reason,
      orders: act.orders?.length ? [...(was.orders || []), ...act.orders] : was.orders,
      trading: act.trading || was.trading, bank: act.bank || was.bank,
    };
    this.live.set(act.id, seen);
    // Their answer earns a line. Later news about the same villager only does if it says
    // something new — an order, a loan, a different shift — so the wire is not spammed.
    const order = act.orders?.at(-1);
    const worth = !act.released || order || act.bank || (act.task && act.task !== was.task);
    if (worth) {
      this.wire.unshift(wireLine(act, seen));
      if (this.wire.length > 16) this.wire.length = 16;
      this.ticker.unshift(liveRow(act, order
        ? `${order.side} ${order.qty} ${order.good} @ ${coins(order.price ?? order.limit)}`
        : act.bank ? 'at the bank' : (ACT_LABEL[seen.task] || 'decided')));
      if (this.ticker.length > FEED_ROWS) this.ticker.length = FEED_ROWS;
    }
    this.nudge();
  }

  /** The barrier: prices, volumes and the transaction count, without waiting for the poll. */
  onRound(e) {
    this.live.clear();
    this.ticker.length = 0;
    this.lastRound = e;
    this.wire.unshift(`Round ${e.round} settled on-chain in ${e.txs} transactions`);
    if (this.wire.length > 16) this.wire.length = 16;
    clearTimeout(this._nudge);
    this._nudge = null;
    if (this.snapshot) this.setState({ sim: this.toSim(this.snapshot) });
  }

  /** What /state says about a villager, with anything they have told us since laid over it. */
  merged(a) {
    const seen = this.live.get(a.id);
    // Their news is in, but not their turn to show it yet: the tally must not run ahead of
    // the island, so they stay "deciding" until their own moment comes round.
    if (!seen) return queued(a.id) ? { ...a, activity: "deciding" } : a;
    return {
      ...a,
      activity: seen.task || a.activity,
      thought: seen.thought || seen.reason || a.thought,
      orders: seen.orders?.length ? seen.orders.map(o => `${o.side} ${o.qty} ${o.good}`) : a.orders,
    };
  }

  /** Close the place card first, then hand Esc on to the shell. */
  closeOverlay() {
    if (!this.state.selected) return false;
    this.closeCard();
    return true;
  }

  /** Play the card out, then let go of it. */
  closeCard() {
    if (this.state.closing) return;
    this.setState({ closing: true });
    clearTimeout(this._closing);
    this._closing = setTimeout(() => this.setState({ selected: null, closing: false }), 200);
  }

  openAdmin = (e) => { e.preventDefault(); this.props.onAdmin?.(); };

  activityFor(a) {
    // Carrying orders is the normal state, not a sign of trading: counting on it put nearly
    // every settler at the market. The shift the backend reports wins, and the last known
    // one carries through the deciding phase, as the 3D scene already does.
    this.lastAct = this.lastAct || {};
    if (LOCS.some(l => l.act === a.activity)) return (this.lastAct[a.id] = a.activity);
    if (a.activity === "idle") return (this.lastAct[a.id] = "trade");
    if (this.lastAct[a.id]) return this.lastAct[a.id];
    if (a.orders?.length) return "trade";
    if (a.debt > 0 && a.dueIn != null && a.dueIn <= 2) return "bank";
    return "rest";
  }

  agentView(a) {
    const fract = n => n - Math.floor(n);
    const seeded = salt => fract(Math.sin((a.id + 1) * (12.9898 + salt * 17.31)) * 43758.5453);
    const act = this.activityFor(a);
    const mood = a.hunger >= 3 ? 0.12 : a.cold >= 2 ? 0.28 : a.hunger > 0 ? 0.42 : a.house ? 0.9 : 0.7;
    return {
      ...a, act, mood,
      // the model's own words, verbatim, or nothing at all: no memory line or label stands in
      thought: a.thought || "",
      skin: SKIN[Math.floor(seeded(1) * SKIN.length)],
      hair: HAIR[Math.floor(seeded(2) * HAIR.length)],
      shirt: SHIRT[Math.floor(seeded(3) * SHIRT.length)],
      hairStyleN: Math.floor(seeded(4) * 3), faceN: Math.floor(seeded(5) * 5),
      jx: seeded(6) * 2 - 1, jy: seeded(7) * 2 - 1, delay: seeded(8) * 3
    };
  }

  toSim(snapshot) {
    const goods = GOODS;
    // The round event carries the clearing prices the moment they are struck; /state is a
    // second behind it. Use it until the poll catches up, then drop back to the poll.
    const fresh = this.lastRound && this.lastRound.round > (snapshot.round || 0) ? this.lastRound : null;
    const prices = fresh ? Object.fromEntries(goods.map((g, i) => [g, (fresh.prices?.[i] ?? 0) / 100]))
      : snapshot.prices || Object.fromEntries(goods.map(g => [g, 0]));
    const vols = fresh ? Object.fromEntries(goods.map((g, i) => [g, fresh.volumes?.[i] ?? 0]))
      : snapshot.volumes || Object.fromEntries(goods.map(g => [g, 0]));
    const priorRound = fresh ? snapshot.history?.at(-1) : snapshot.history?.at(-2);
    const pricePrev = Object.fromEntries(goods.map((g, i) => [g, priorRound?.prices?.[i] ?? prices[g]]));
    const agents = (snapshot.agents || []).map(a => this.agentView(this.merged(a)));
    const books = snapshot.bank?.books || {};
    // What the bank minted and burned since the last snapshot. Worked out once per poll in
    // apply(), not here: the view is now rebuilt many times between polls, and a difference
    // against the last render would read zero every time but the first.
    const minted = this.minted || 0, burned = this.burned || 0;
    const bankBySig = new Map((snapshot.bankFeed || []).filter(x => x.sig).map(x => [x.sig, x]));
    // The chain's own list is { sig, what, kind } per transaction; older runs had bare strings.
    const chainTxs = [...(snapshot.chain?.lastRound?.sigs || [])].reverse()
      .map(t => (typeof t === "string" ? { sig: t } : t)).filter(t => t?.sig);
    const chainBySig = new Map(chainTxs.map(t => [t.sig, t]));
    const signatures = chainTxs.map(t => t.sig);
    for (const entry of snapshot.bankFeed || []) if (entry.sig && !signatures.includes(entry.sig)) signatures.push(entry.sig);
    const txUrl = signature => (snapshot.chain?.explorer || "").replace(/\/address\/[^?]+/, "/tx/" + signature);
    const CHAIN_KIND = { borrow: "mint_loan", repay: "burn_repay", liquidate: "burn_repay", purses: "transfer_goods", settle: "transfer_goods", auction: "settle_auction" };
    const feed = signatures.slice(0, FEED_ROWS).map(signature => {
      const entry = bankBySig.get(signature);
      const tx = chainBySig.get(signature);
      const kind = entry?.kind === "borrow" ? "mint_loan"
        : ["repay", "collected"].includes(entry?.kind) ? "burn_repay"
          : entry?.kind === "foreclosed" ? "transfer_goods"
            : CHAIN_KIND[tx?.kind] || "settle_auction";
      const color = KINDS.find(x => x.k === kind)?.c || "#14f195";
      const what = tx?.what ? String(tx.what).split(" · ")[0] : null;
      const note = entry ? entry.kind + (entry.amount ? " " + Number(entry.amount).toFixed(1) + "c" : "")
        : what || "round " + (snapshot.round || 0);
      return { id: signature, kind, color, sig: signature, note, url: txUrl(signature) };
    });
    // Everything a villager has done since the last settle goes straight to the top of the
    // feed, as it happens; settled rows with real signatures push it back down.
    const live = this.ticker.map(r => ({ ...r, color: KINDS.find(x => x.k === r.kind)?.c || "#7fd4ff",
                                         sig: r.who, url: null }));
    return {
      agents, prices, pricePrev, vols, books, feed: [...live, ...feed].slice(0, FEED_ROWS),
      round: fresh ? fresh.round : snapshot.round || 0, tick: snapshot.round || 0, seconds: snapshot.seconds || 0,
      gdp: snapshot.metrics?.gdp || 0, gdpPrev: priorRound?.gdp ?? snapshot.metrics?.gdp ?? 0,
      // wellbeing gained this round, averaged over the village (world.mjs wbRound), and the
      // round before's, so the row can say whether the village is getting better off faster
      wbRound: snapshot.metrics?.wbRound ?? 0, wbRoundPrev: priorRound?.wbRound ?? snapshot.metrics?.wbRound ?? 0,
      supply: snapshot.bank?.supply || 0, debt: snapshot.bank?.debt || 0, minted, burned,
      txTotal: snapshot.chain?.transactions || 0,
      lastRoundTxs: fresh ? fresh.txs || 0 : snapshot.chain?.lastRound?.txs || 0,
      roundMs: (fresh ? fresh.roundMs : 0) || snapshot.roundMs || 0,
      live: this.wire.slice(0, 6),
      agentTarget: snapshot.config?.agents || agents.length,
      brain: snapshot.brain || [snapshot.config?.brain, snapshot.config?.model].filter(Boolean).join(" · ") || "not started",
      program: snapshot.chain?.program || "-", ledger: snapshot.chain?.ledger || "-",
      explorer: snapshot.chain?.explorer || "#"
    };
  }

  apply(snapshot, error) {
    if (error || !snapshot) { this.setState({ live: false, error: error || "no state yet" }); return; }
    if (!snapshot.running) { this.lastAct = {}; this.live.clear(); this.ticker.length = 0; this.wire.length = 0; this.lastRound = null; }
    // What the bank minted and burned between this snapshot and the one before it — once a
    // poll, whatever else rebuilds the view in between.
    const books = snapshot.bank?.books || {};
    const before = this.prevBooks || books;
    const round2 = n => Math.round(n * 100) / 100;   // cents in floats, or the ticker prints 214.98000000000002
    this.minted = round2(Math.max(0, (books.minted || 0) - (before.minted || 0)));
    this.burned = round2(Math.max(0, (books.principalRepaid || 0) - (before.principalRepaid || 0)));
    this.prevBooks = books;
    this.snapshot = snapshot;
    const sim = this.toSim(snapshot);
    this.setState({
      sim, running: !!snapshot.running, paused: !!snapshot.paused, pausing: !!snapshot.pausing,
      live: true, error: "", tickN: this.state.tickN + 1
    });
  }

  async request(endpoint) {
    if (this.state.busy) return;
    this.setState({ busy: true, error: "" });
    let requestError = "";
    try {
      await command(endpoint);
    } catch (error) {
      requestError = error.message;
    } finally {
      this.setState({ busy: false, ...(requestError ? { error: requestError } : {}) });
    }
  }

  wireText(headlines) {
    const key = headlines.join("|");
    const now = Date.now();
    if (this._wireText && key === this._wireKey) return this._wireText;
    if (this._wireText && now - (this._wireAt || 0) < 1500) return this._wireText;
    this._wireKey = key;
    this._wireAt = now;
    return (this._wireText = headlines.join("     ◆     ") + "     ◆     ");
  }

  renderVals() {
    const s = this.state.sim;
    const showThoughts = this.props.showThoughts ?? true;
    const fmt = (v, d = 2) => Number(v).toFixed(d);
    const counts = {}; LOCS.forEach(l => counts[l.id] = 0);
    s.agents.forEach(a => counts[bucketOf(a.act).id] = (counts[bucketOf(a.act).id] || 0) + 1);

    const tapeStyle = tone => ({ fontSize: "12px", fontWeight: 800, color: tone > 0 ? "#3fe0a0" : tone < 0 ? "#ff7d63" : "#8b9095", whiteSpace: "nowrap" });
    const noteStyle = note => ({ display: note ? "inline" : "none", fontFamily: "'IBM Plex Mono', monospace", fontSize: "11px", color: "#7d8287" });
    const tape = Object.keys(s.prices).filter(k => k !== "boats").map(k => {
      const change = s.prices[k] - (s.pricePrev[k] ?? s.prices[k]);
      const tone = change > 0 ? 1 : change < 0 ? -1 : 0;
      return {
        name: k, price: this.state.running ? fmt(s.prices[k], 2) : "-",
        delta: !this.state.running ? "" : tone ? (tone > 0 ? "▲ +" : "▼ −") + fmt(Math.abs(change), 2) : "• 0.00",
        deltaStyle: tapeStyle(tone), note: "vol " + s.vols[k], noteStyle: noteStyle("vol")
      };
    });

    const gdpTone = s.gdp === s.gdpPrev ? 0 : s.gdp > s.gdpPrev ? 1 : -1;
    const gdpPct = fmt(Math.abs(s.gdp - s.gdpPrev) / Math.max(1, s.gdpPrev) * 100, 1) + "%";
    // The village's GDP leads the row, in the title's gold: it is the headline number.
    tape.unshift(
      { name: "village GDP", price: this.state.running ? fmt(s.gdp, 0) : "-", priceColor: "#ffcf4a",
        delta: !this.state.running ? "" : (gdpTone > 0 ? "▲ +" : gdpTone < 0 ? "▼ −" : "• ") + gdpPct,
        deltaStyle: tapeStyle(gdpTone), note: "round " + s.round, noteStyle: noteStyle("round") });
    const wbChange = s.wbRound - s.wbRoundPrev;
    const wbTone = Math.abs(wbChange) < 0.005 ? 0 : wbChange > 0 ? 1 : -1;
    tape.push(
      { name: "wellbeing growth", price: !this.state.running ? "-" : (s.wbRound >= 0 ? "+" : "−") + fmt(Math.abs(s.wbRound), 2),
        delta: !this.state.running ? "" : wbTone ? (wbTone > 0 ? "▲ +" : "▼ −") + fmt(Math.abs(wbChange), 2) : "• 0.00",
        deltaStyle: tapeStyle(wbTone), note: "", noteStyle: noteStyle("") }
    );

    const feed = s.feed.map(f => ({
      id: f.id, color: f.color, kind: f.kind, short: f.short || SHORT[f.kind] || f.kind, sig: f.sig, note: f.note, url: f.url
    }));

    const sel = LOCS.find(l => l.id === this.state.selected) || null;
    const here = sel ? s.agents.filter(a => bucketOf(a.act).id === sel.id) : [];
    // what each villager says is exactly what their model wrote, duplicates and all
    const selectedAgents = here.map(a => ({ id: a.id, name: a.name, mood: moodOf(a), thought: showThoughts ? a.thought : "" }));

    const countFor = act => counts[bucketOf(act).id] || 0;
    const busiest = LOCS.reduce((a, l) => (counts[l.id] || 0) > (counts[a.id] || 0) ? l : a, LOCS[0]);
    const dearest = Object.keys(s.prices).reduce((a, k) => s.prices[k] > s.prices[a] ? k : a, "food");
    const headlines = this.state.running ? [
      "Food clears at " + fmt(s.prices.food, 2) + "c with " + countFor("gather_food") + " settlers working the lake",
      "Wood settles at " + fmt(s.prices.wood, 2) + "c with " + s.vols.wood + " units traded",
      s.minted > 0 ? "Bank mints " + s.minted + "c of fresh credit; village debt now " + fmt(s.debt, 0) + "c"
        : "No new credit issued this round, so debt holds at " + fmt(s.debt, 0) + "c",
      s.burned > 0 ? "Repayments burn " + s.burned + "c out of circulation" : "Nothing repaid this round; supply steady at " + fmt(s.supply, 0) + "c",
      "Round " + s.round + " settled on-chain in " + s.lastRoundTxs + " transactions",
      busiest.name + " is the busiest place on the island with " + (counts[busiest.id] || 0) + " settlers there",
      "Nets hold at " + fmt(s.prices.nets, 2) + "c as crafters stock up on wood",
      "Houses asking " + fmt(s.prices.houses, 0) + "c with " + countFor("build_house") + " frames going up at the building site",
      "GDP prints " + fmt(s.gdp, 0) + ", " + (s.gdp >= s.gdpPrev ? "up" : "down") + " " + fmt(Math.abs(s.gdp - s.gdpPrev) / Math.max(1, s.gdpPrev) * 100, 1) + "% on the round",
      dearest.charAt(0).toUpperCase() + dearest.slice(1) + " is the priciest good on the island right now",
      s.txTotal + " transactions written to Solana since the sun came up"
    ] : ["The village is ready. Press Start to initialize the on-chain economy", this.state.error || "Waiting for the first settlers"];
    // The villagers who have just spoken lead the wire; the round's own headlines follow.
    if (this.state.running && s.live?.length) headlines.unshift(...s.live);
    const busyLabel = this.state.running ? "Stopping…" : "Starting…";
    return {
      round: s.round,
      clock: Math.floor(s.seconds / 60) + ":" + String(s.seconds % 60).padStart(2, "0"),
      txTotal: s.txTotal, lastRoundTxs: s.lastRoundTxs, txRate: s.roundMs ? Math.round(s.lastRoundTxs * 60000 / s.roundMs) : 0,
      explorer: s.explorer,
      tape, feed,
      selected: sel ? { name: sel.name, blurb: sel.blurb, color: sel.color, here: here.length } : null,
      selectedAgents,
      // The crawl is a marquee: retyping it on every villager would shake it to pieces, so
      // new lines are taken up on a gentle cadence \u2014 still many times a round, not once.
      wireText: this.wireText(headlines),
      closeLoc: () => this.closeCard(),
      closing: this.state.closing,
      toggleRun: () => this.state.running
        ? window.confirm("Stop this simulation and save the current run?") && this.request("/stop")
        : this.request("/start"),
      togglePause: () => this.state.running && this.request(this.state.paused || this.state.pausing ? "/resume" : "/pause"),
      runLabel: this.state.busy ? busyLabel : this.state.running ? "Stop" : "Start",
      pauseLabel: this.state.pausing ? "Cancel pause" : this.state.paused ? "Resume" : "Pause",
      runBtnStyle: { all: "unset", cursor: this.state.busy ? "wait" : "pointer", opacity: this.state.busy ? .65 : 1, fontFamily: "Nunito, system-ui, sans-serif", fontSize: "15px", fontWeight: 900, letterSpacing: ".14em", textTransform: "uppercase", color: this.state.running ? "#ff9d7a" : "#4ff0b0", textShadow: "0 2px 6px rgba(0,0,0,.85)" },
      pauseBtnStyle: { all: "unset", cursor: this.state.running && !this.state.busy ? "pointer" : "not-allowed", opacity: this.state.running && !this.state.busy ? 1 : .4, fontFamily: "Nunito, system-ui, sans-serif", fontSize: "15px", fontWeight: 900, letterSpacing: ".14em", textTransform: "uppercase", color: "#f2f3f4", textShadow: "0 2px 6px rgba(0,0,0,.85)" },
      toggleUi: () => this.setState({ uiHidden: !this.state.uiHidden }),
      hideUiLabel: this.state.uiHidden ? "Show UI" : "Hide UI",
      hideUiBtnStyle: { all: "unset", gridRow: "2", gridColumn: "1", alignSelf: "end", justifySelf: "end", margin: "0 18px 6px", position: "relative", zIndex: 6, cursor: "pointer", fontFamily: "Nunito, system-ui, sans-serif", fontSize: "12.5px", fontWeight: 900, letterSpacing: ".14em", textTransform: "uppercase", color: "#f2f3f4", textShadow: "0 2px 6px rgba(0,0,0,.85)" },
      // The island is the whole stage and the footer lies over its bottom edge on a scrim, so
      // Hide UI only has to fade the furniture out: the water is already underneath it, and
      // the island keeps exactly the frame it had.
      chainPanelStyle: { display: "flex", opacity: this.state.uiHidden ? 0 : 1, pointerEvents: this.state.uiHidden ? "none" : "auto", transition: "opacity .35s ease", position: "absolute", right: "26px", top: "22px", width: "204px", flexDirection: "column", gap: "5px", background: "rgba(16,16,18,.55)", border: "1px solid rgba(255,255,255,.1)", borderRadius: "8px", padding: "10px 12px 6px", color: "#e6e8ea", zIndex: 5 },
      titleStyle: { opacity: this.state.uiHidden ? 0 : 1, transition: "opacity .35s ease", position: "absolute", left: "28px", top: "22px", zIndex: 5, pointerEvents: "none", fontFamily: "Grandstander, 'Baloo 2', cursive", fontSize: "26px", fontWeight: 900, letterSpacing: ".2px", lineHeight: 1, color: "#ffcf4a", whiteSpace: "nowrap", textShadow: "0 3px 0 #6b4a2a, 0 4px 0 rgba(43,28,15,.45)" },
      footerStyle: { gridRow: "3", gridColumn: "1", position: "relative", zIndex: 6, background: "linear-gradient(180deg, rgba(10,10,12,0) 0%, rgba(10,10,12,.66) 38%, rgba(10,10,12,.86) 100%)", display: "flex", opacity: this.state.uiHidden ? 0 : 1, pointerEvents: this.state.uiHidden ? "none" : "auto", transition: "opacity .35s ease", flexDirection: "column", gap: "6px", padding: "22px 18px 10px", minWidth: 0 }
    };
  }

  // The template from Moku Island.dc.html, as JSX. Every style string is the original one.
  render() {
    const v = this.renderVals();
    return (
      <div style={S("font-family: Nunito, system-ui, sans-serif; position: relative; height: 100%; min-height: 420px; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; grid-template-columns: minmax(0, 1fr); overflow: hidden; background: #0c0d0f; color: #e6e8ea;")}>

        <main style={S("grid-row: 1 / -1; grid-column: 1; position: relative; overflow: hidden; z-index: 0;")}>
          <div style={S("position: absolute; inset: 0; z-index: 0;")}>
            <island-3d hide-labels={this.state.uiHidden ? "" : undefined} style={S("position: absolute; inset: 0;")}></island-3d>
            <div style={v.titleStyle}>Settlers of Solana</div>
            <div style={v.chainPanelStyle}>
              {/* The count is the link: clicking it opens the ledger in Solana Explorer. */}
              <a href={v.explorer} target="_blank" rel="noreferrer" title="Open in Solana Explorer"
                 style={S("display: flex; align-items: baseline; gap: 6px; text-decoration: none; cursor: pointer; white-space: nowrap;")}>
                <CountUp value={v.txTotal} style={S("font-family: 'IBM Plex Mono', monospace; font-size: 15px; line-height: 1.1; color: #5fe3ae; font-variant-numeric: tabular-nums;")} />
                <span style={S("font-size: 10px; font-weight: 700; color: #9a9fa4;")}>tx on Solana</span>
                <span style={S("flex: 1")}></span>
                <span style={S("font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; color: #7d8287;")}>{v.txRate}/min</span>
              </a>
              {/* Newest on top. A row that arrives opens up from nothing (feedpush), which
                  pushes the ones under it down; the window is a fixed height with a fade at
                  its foot, so the oldest slide off the edge rather than being cut. Rows are
                  keyed by what they ARE (a villager's act, a signature), so only a new row
                  mounts and animates; the rest just move. */}
              <div style={S("height: 104px; overflow: hidden; display: flex; flex-direction: column; border-top: 1px solid rgba(255,255,255,.08); padding-top: 4px; mask-image: linear-gradient(180deg, #000 0, #000 60%, transparent 100%); -webkit-mask-image: linear-gradient(180deg, #000 0, #000 60%, transparent 100%);")}>
                {v.feed.map(f => (
                  <a key={f.id} href={f.url || undefined} target="_blank" rel="noreferrer" className="island-feed-row"
                     style={S("flex: none; display: grid; grid-template-columns: 5px minmax(0, 1fr) auto; gap: 6px; align-items: center; min-width: 0; height: 16px; margin-bottom: 2px; overflow: hidden; animation: feedpush .32s cubic-bezier(.2,.7,.2,1) both; text-decoration: none;")}>
                    <span title={f.short} style={S(`width: 5px; height: 5px; border-radius: 50%; background: ${f.color}; opacity: .85;`)}></span>
                    <span style={S("font-size: 10.5px; font-weight: 700; color: #d5d8db; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;")}>{f.sig}</span>
                    <span style={S("font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; color: #8e9398; white-space: nowrap;")}>{f.note}</span>
                  </a>
                ))}
              </div>
            </div>
          </div>
        </main>
        <button onClick={v.toggleUi} style={v.hideUiBtnStyle}>{v.hideUiLabel}</button>

        <footer style={v.footerStyle}>

          <div style={S("display: flex; align-items: center; gap: 10px; min-width: 0; width: 100%;")}>
            <div style={S("display: flex; align-items: center; gap: 14px; padding-right: 4px;")}>
              <button onClick={v.toggleRun} style={v.runBtnStyle}>{v.runLabel}</button>
              <button onClick={v.togglePause} style={v.pauseBtnStyle}>{v.pauseLabel}</button>
            </div>
            <div style={S("flex: 1; min-width: 0; overflow: hidden; background: rgba(16,16,18,.5); border: 1px solid rgba(255,255,255,.12); border-radius: 8px; padding: 3px 0; mask-image: linear-gradient(90deg, transparent 0, #000 22px, #000 calc(100% - 22px), transparent 100%); -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 22px, #000 calc(100% - 22px), transparent 100%);")}>
              <div data-crawl="wire" style={S("display: flex; width: max-content; will-change: transform; font-family: 'Baloo 2', cursive; font-size: 17px; font-weight: 600; color: #f2f3f4; white-space: nowrap;")}>
                <span style={S("padding-right: 46px;")}>{v.wireText}</span>
                <span style={S("padding-right: 46px;")} aria-hidden="true">{v.wireText}</span>
                <span style={S("padding-right: 46px;")} aria-hidden="true">{v.wireText}</span>
              </div>
            </div>
          </div>

          {/* The stats stand still: a row to be read, not chased. Each keeps its ticker mark,
              the change since the round before. The round and the way into the dashboard
              close the row. */}
          <div style={S("display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 0 20px; min-width: 0; width: 100%; padding: 1px 4px 0; white-space: nowrap;")}>
            <span style={S("justify-self: start; font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: #a3a8ad;")}>round {v.round} · {v.clock}</span>
            <div style={S("display: flex; align-items: baseline; justify-content: center; gap: 0 26px; min-width: 0; overflow: hidden;")}>
              {v.tape.map((t, i) => (
                <span key={i} style={S("display: inline-flex; align-items: baseline; gap: 7px; white-space: nowrap;")}>
                  <span style={S("font-size: 10.5px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; color: #a3a8ad;")}>{t.name}</span>
                  <span style={S(`font-family: 'IBM Plex Mono', monospace; font-size: 14px; color: ${t.priceColor || "#f2f3f4"}; font-variant-numeric: tabular-nums;`)}>{t.price}</span>
                  <span style={t.deltaStyle}>{t.delta}</span>
                </span>
              ))}
            </div>
            <a href="/dashboard" onClick={this.openAdmin} title="The dials, the charts, every readout (Esc)"
               style={S("justify-self: end; color: #f2f3f4; border: 1px solid rgba(255,255,255,.28); border-radius: 5px; padding: 2px 10px; font-size: 11px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; text-decoration: none; cursor: pointer;")}>Dashboard</a>
          </div>
        </footer>

        {/* The place card: the big one, flat in the place's own colour, holding the lineup. */}
        {v.selected && (
          <div onClick={v.closeLoc}
               style={S(`position: absolute; inset: 0; background: rgba(0,0,0,.5); display: grid; place-items: center; padding: 26px 22px; z-index: 40; animation: ${v.closing ? "veilout .2s ease both" : "veilin .24s ease both"};`)}>
            <div onClick={e => e.stopPropagation()}
                 style={S(`width: 100%; max-width: 1240px; height: 100%; max-height: 820px; border-radius: 12px; overflow: hidden; background: ${v.selected.color}; box-shadow: 0 24px 60px rgba(0,0,0,.5); color: #fff; display: flex; flex-direction: column; animation: ${v.closing ? "cardout .2s ease both" : "cardin .3s cubic-bezier(.2,.7,.2,1) both"};`)}>
              <div style={S("flex: none; display: flex; align-items: center; gap: 14px; padding: 16px 20px 14px;")}>
                <div style={S("min-width: 0; flex: 1;")}>
                  <div style={S("display: flex; align-items: center; gap: 10px;")}>
                    <span style={S("font-size: 17px; font-weight: 900; letter-spacing: .14em; text-transform: uppercase; color: #fff;")}>{v.selected.name}</span>
                    <span style={S(`font-family: 'IBM Plex Mono', monospace; font-size: 12px; line-height: 1; color: ${shade(v.selected.color, -0.45)}; background: #fff; padding: 4px 7px; border-radius: 3px;`)}>{v.selected.here}</span>
                  </div>
                  <div style={S("margin-top: 3px; font-size: 13px; font-weight: 700; color: rgba(255,255,255,.85);")}>{v.selected.blurb}</div>
                </div>
                <button onClick={v.closeLoc} title="Back to the island (Esc)"
                        style={S("all: unset; cursor: pointer; color: #fff; border: 1.5px solid rgba(255,255,255,.7); border-radius: 5px; padding: 3px 12px; font-size: 11px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase;")}>Back</button>
              </div>
              <Lineup key={v.selected.name} agents={v.selectedAgents} color={v.selected.color} />
            </div>
          </div>
        )}
      </div>
    );
  }
}
