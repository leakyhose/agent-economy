// The front door of a server that holds no API key of its own (the hosted site): nothing is
// running, so say what this is and let the visitor start a village — on scripted villagers
// for free, or on a model with their own key. A server with a key in its .env never shows
// this; a village already running is simply watched.
import './keygate.css';
import { subscribe, refresh } from './store.js';

const CHOICES = [
  { id: 'stub', name: 'Scripted villagers', cost: 'Free' },
  { id: 'openai', name: 'GPT-6 Luna', cost: 'About $1, your OpenAI key', hint: 'OpenAI API key' },
];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function mountKeyGate(host) {
  let picked = 'stub', busy = false, error = '', dismissed = false, shown = false, last = null;
  const el = document.createElement('div');
  el.id = 'keygate'; el.hidden = true;
  host.appendChild(el);

  function draw() {
    const s = last, choice = CHOICES.find(c => c.id === picked);
    const offered = CHOICES.filter(c => c.id === 'stub' || s.providers?.includes(c.id));
    const needsKey = picked !== 'stub' && !s.keys?.[picked];
    el.innerHTML = `<form class="kg-card" autocomplete="off">
      <h1>Settlers of Solana</h1>
      <p class="kg-lede">30 villagers trading on Solana. Pick who plays them.</p>
      <fieldset ${busy ? 'disabled' : ''}>
        ${offered.map(c => `<label class="kg-opt ${c.id === picked ? 'on' : ''}">
          <input type="radio" name="who" value="${c.id}" ${c.id === picked ? 'checked' : ''}>
          <span class="kg-name">${esc(c.name)}</span><span class="kg-cost">${esc(c.cost)}</span></label>`).join('')}
        ${needsKey ? `<input class="kg-key" type="password" name="key" placeholder="${esc(choice.hint)}" aria-label="${esc(choice.hint)}" spellcheck="false" autocapitalize="off" required>
          <p class="kg-fine">Used for this run only. Not stored.</p>` : ''}
        ${error ? `<p class="kg-error" role="alert">${esc(error)}</p>` : ''}
        <div class="kg-actions">
          <button type="submit" class="kg-go">${busy ? 'Starting…' : 'Start'}</button>
          <button type="button" class="kg-skip">Skip</button>
        </div>
      </fieldset></form>`;
  }

  el.addEventListener('change', e => {
    if (e.target.name !== 'who') return;
    picked = e.target.value; error = ''; draw();
    el.querySelector('input[name=key]')?.focus();
  });
  el.addEventListener('click', e => { if (e.target.classList.contains('kg-skip')) { dismissed = true; el.hidden = true; shown = false; } });
  el.addEventListener('submit', async e => {
    e.preventDefault();
    if (busy) return;
    const key = el.querySelector('input[name=key]')?.value.trim();
    busy = true; error = ''; draw();
    try {
      const res = await fetch('/start', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: picked, ...(key ? { apiKey: key } : {}) }) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || out.error) throw new Error(out.error || 'The village could not be started.');
      if (out.result === 'already running') throw new Error('Someone else just started a village. You are watching theirs.');
    } catch (err) { error = err.message; }
    busy = false;
    await refresh();
    if (!el.hidden) draw();
  });

  subscribe(s => {
    if (!s) return;
    last = s;
    // only where the server has no key of its own, and only between runs
    const want = !s.running && !dismissed && !Object.values(s.keys ?? { none: true }).some(Boolean);
    if (s.running) dismissed = false;          // when this run ends, the door is shown again
    if (want && !shown) { shown = true; el.hidden = false; draw(); }
    else if (!want && shown && !busy) { shown = false; el.hidden = true; }
  });
}
