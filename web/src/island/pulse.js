// The village's heartbeat, one villager at a time.
//
// Every round up to a hundred agents decide at once and their answers land spread over a
// few seconds. The island used to learn about all of them in one lump — from the 1 s /state
// poll, and from a single global "a round settled" flag — so the whole village turned and
// walked together. Here each agent's own SSE event is turned into its own little "act", and
// that act is what moves that one villager and writes their line on the
// market wire. The poll stays the source of truth (first load, reconnect, drift), but it no
// longer starts anybody moving who has already moved on their own event.
//
// Backend events used (all additive, all optional — see backend/src/world.mjs and server.mjs):
//   decision  {agent, name, round, ms, outcome, thought, activity, orders[]}  ← the whole answer
//   activity  {agent, name, task, kept?}                                      ← the shift they took
//   order     {agent, name, side, good, qty, price, reason?}                  ← an order they posted
//   borrow / repay / lifestyle / shop_plan / sale_plan / build_start          ← the rest of the turn
//   round     {round, prices, volumes, txs, ms, …}                            ← the barrier
// The first event of any kind from an agent is what starts their act; everything after it
// that round only fills the act in. If `decision` is missing (an older backend) the whole
// thing still runs off `activity` and `order`.
import { subscribe, subscribeEvents } from '../store.js';

// A burst — the stub brain, or a quorum close — is spread over at most this long, so a
// hundred answers still read as a hundred individuals rather than one lump. Nobody is held
// back further than this behind their own event, and a settling round releases the queue.
const MAX_STAGGER_MS = 1500;
const MIN_GAP_MS = 10;
const MAX_GAP_MS = 180;

// Test-only, front end only: ?jitter=1200 holds each agent's events back by its own
// deterministic slice of that many ms, so the stub brain (which answers in microseconds)
// can be made to arrive spread out the way a real model's answers do. Never used otherwise.
const JITTER_MS = (() => {
  const raw = Number(new URLSearchParams(location.search).get('jitter'));
  return Number.isFinite(raw) ? Math.max(0, Math.min(10_000, raw)) : 0;
})();

const actSubs = new Set();     // (act) => void    — one villager acting, in their own moment
const updateSubs = new Set();  // (act) => void    — more news about a villager who already acted
const roundSubs = new Set();   // (event) => void  — the barrier, never delayed
const rawSubs = new Set();     // (event) => void  — every event, never delayed

const pending = new Map();     // agent id -> the act waiting for its slot
const done = new Set();        // agent ids whose act has gone out this round
let timer = null;
let nextFree = 0;              // the earliest free slot in the stagger queue (performance.now)
let population = 30;
let settled = 0;               // the last round that settled; answers in flight are for settled + 1
let started = false;

const now = () => performance.now();
const rnd = (id, salt) => { const v = Math.sin((id + 1) * (12.9898 + salt * 17.31)) * 43758.5453; return v - Math.floor(v); };

function fan(set, arg) {
  for (const fn of set) { try { fn(arg); } catch (e) { console.error('pulse subscriber failed:', e); } }
}

/** The round the village is deciding right now (/state's round is the last one settled). */
export const decideRound = () => settled + 1;

/** How many villagers there are, so a whole village fits inside MAX_STAGGER_MS. */
export function setPopulation(n) { if (n > 0) population = n; }

// Who this round belongs to us rather than to the poll. Without this the 1 s /state poll
// would land in the middle of a staggered burst and set everybody at once — exactly the
// lump the stagger exists to break up. Both sets are emptied at every round barrier, so
// the poll takes the village back over once a round whatever happens.
/** True while we hold this villager's news for the round in progress (queued or shown). */
export const owns = id => pending.has(id) || done.has(id);
/** True while this villager's news is still waiting for its slot. */
export const queued = id => pending.has(id);

// ---- the stagger queue -------------------------------------------------------------
// One slot per act. Answers that are already spread out (a real model) find the queue empty
// and pass through untouched; a burst queues up behind itself a gap at a time.
function slot() {
  const t = now();
  const gap = Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, MAX_STAGGER_MS / Math.max(1, population)));
  let at = Math.max(t, nextFree);
  if (at > t + MAX_STAGGER_MS) at = t + MAX_STAGGER_MS;    // nobody lags further than this
  nextFree = at + gap;
  return at;
}

function arm() {
  if (timer !== null || !pending.size) return;
  let soonest = Infinity;
  for (const act of pending.values()) if (act.at < soonest) soonest = act.at;
  timer = setTimeout(() => { timer = null; release(now()); arm(); }, Math.max(0, soonest - now()));
}

/** Let go of everything due by `t`. Infinity at a round barrier: nobody waits past it. */
function release(t) {
  if (!pending.size) return;
  const due = [];
  for (const act of pending.values()) if (act.at <= t) due.push(act);
  if (!due.length) return;
  due.sort((a, b) => a.at - b.at);
  for (const act of due) { pending.delete(act.id); done.add(act.id); fan(actSubs, act); }
}

function merge(act, patch) {
  const order = patch.order;
  if (order) { act.orders.push(order); delete patch.order; }
  for (const k of Object.keys(patch)) if (patch[k] != null) act[k] = patch[k];
  if (order) patch.order = order;
}

/** News about one villager. The first of the round starts their act; the rest fill it in. */
function news(id, name, patch) {
  if (!(id >= 0)) return;
  const waiting = pending.get(id);
  if (waiting) { merge(waiting, patch); return; }
  if (done.has(id)) {
    const update = { id, name, round: decideRound(), orders: [], released: true };
    merge(update, patch);
    fan(updateSubs, update);
    return;
  }
  const act = { id, name, round: decideRound(), at: slot(), orders: [] };
  merge(act, patch);
  pending.set(id, act);
  arm();
}

// ---- the events ---------------------------------------------------------------------
function handle(e) {
  fan(rawSubs, e);
  switch (e.type) {
    case 'round':
      release(Infinity);                 // never hold a villager past the barrier
      pending.clear(); done.clear(); nextFree = 0;
      settled = typeof e.round === 'number' ? e.round : settled + 1;
      fan(roundSubs, e);
      return;
    case 'decision':
      news(e.agent, e.name, { task: e.activity || null, thought: e.thought || null,
                              outcome: e.outcome, ms: e.ms, decided: true,
                              ...(e.orders?.length ? { orders: e.orders } : {}) });
      return;
    case 'activity':
      news(e.agent, e.name, { task: e.task || null, kept: !!e.kept || null });
      return;
    case 'order':
      news(e.agent, e.name, { trading: true, order: e, reason: e.reason || null });
      return;
    case 'borrow':
    case 'repay':
      news(e.agent, e.name, { bank: true });
      return;
    case 'build_start':
      news(e.agent, e.name, { task: 'build_house' });
      return;
    case 'lifestyle':
    case 'shop_plan':
    case 'sale_plan':
      news(e.agent, e.name, {});
      return;
    default:
      return;
  }
}

/** Keep our idea of the round in step with /state, in case an SSE round event was missed. */
function syncRound(round) {
  if (typeof round !== 'number' || round <= settled) return;
  release(Infinity);
  pending.clear(); done.clear(); nextFree = 0;
  settled = round;
}

function boot() {
  if (started) return;
  started = true;
  subscribeEvents(e => {
    if (!e || typeof e !== 'object') return;
    if (JITTER_MS && e.agent >= 0 && e.type !== 'round') {
      setTimeout(() => handle(e), rnd(e.agent, 5) * JITTER_MS);    // test-only arrival spread
      return;
    }
    handle(e);
  });
  subscribe(s => {
    if (!s) return;
    if (!s.running) { pending.clear(); done.clear(); settled = 0; nextFree = 0; return; }
    setPopulation(s.agents?.length || s.config?.agents);
    syncRound(s.round);
  });
}

/** Each villager acting on their own, in their own moment. */
export function subscribeActs(fn) { boot(); actSubs.add(fn); return () => actSubs.delete(fn); }
/** More news about a villager who has already acted this round (thought, orders, the bank). */
export function subscribeUpdates(fn) { boot(); updateSubs.add(fn); return () => updateSubs.delete(fn); }
/** The round barrier, the moment it lands — prices, volumes, signatures. */
export function subscribeRound(fn) { boot(); roundSubs.add(fn); return () => roundSubs.delete(fn); }
/** Every event, undelayed, for anything that wants the raw stream. */
export function subscribeRaw(fn) { boot(); rawSubs.add(fn); return () => rawSubs.delete(fn); }
