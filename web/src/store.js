// One /state poll and one /events stream for the whole app.
//
// Before this was a single page, three things each polled the backend on their own: the
// island page every 3s, the 3D scene every 2s, the dashboard every 1s, and two of them
// opened an EventSource of their own. Here there is one of each, shared by every view and
// kept alive across a switch, so the scene and the feed never restart.

const POLL_MS = 1000;

let snapshot = null;        // the last successful /state
let error = null;           // the last fetch error, or null
let inFlight = false;
let timer = null;
const subs = new Set();     // (snapshot, error) => void
const sseSubs = new Set();  // (message) => void
let events = null;

function emit() {
  for (const fn of subs) {
    try { fn(snapshot, error); } catch (e) { console.error('store subscriber failed:', e); }
  }
}

export async function refresh() {
  if (inFlight) return snapshot;
  inFlight = true;
  try {
    const res = await fetch('/state', { cache: 'no-store' });
    if (!res.ok) throw new Error(`state request failed (${res.status})`);
    snapshot = await res.json();
    error = null;
  } catch (e) {
    error = e.message || String(e);
  } finally {
    inFlight = false;
  }
  emit();
  return snapshot;
}

function openEvents() {
  if (events) return;
  events = new EventSource('/events');
  events.onmessage = ev => {
    let message;
    try { message = JSON.parse(ev.data); } catch { return; }   // the poll is the fallback
    for (const fn of sseSubs) {
      try { fn(message); } catch (e) { console.error('sse subscriber failed:', e); }
    }
    if (message.type === 'round' || message.type === 'error') refresh();
  };
  events.onerror = () => { /* EventSource reconnects by itself; the poll covers the gap */ };
}

function start() {
  if (timer) return;
  openEvents();
  refresh();
  timer = setInterval(refresh, POLL_MS);
}

/** Subscribe to every snapshot. Called at once with what we already have. */
export function subscribe(fn) {
  subs.add(fn);
  start();
  if (snapshot || error) { try { fn(snapshot, error); } catch (e) { console.error(e); } }
  return () => subs.delete(fn);
}

/** Subscribe to the raw SSE messages (round, error, policy…). */
export function subscribeEvents(fn) {
  sseSubs.add(fn);
  start();
  return () => sseSubs.delete(fn);
}

export const getState = () => snapshot;
export const getError = () => error;

/** POST one of the backend's control endpoints, then refresh. Throws on a refusal. */
export async function command(endpoint, body) {
  const res = await fetch(endpoint, {
    method: 'POST',
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* an empty body is fine */ }
  if (!res.ok) throw new Error(parsed?.error || `${endpoint} failed`);
  await refresh();
  return parsed;
}
