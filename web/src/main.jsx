// The shell. Two views, one page: the island (`/`) and the admin panel (`/dashboard`).
// The island stage is mounted once and never unmounted — in the admin view it is scaled
// into the corner as a live security camera, and clicking it expands it back out. The 3D
// scene, its walk animation and the shared /events stream survive every switch.
import React from 'react';
import { createRoot } from 'react-dom/client';
import './shell/shell.css';
import IslandApp from './island/IslandApp.jsx';
import { mountAdmin, setAdminVisible } from './admin/AdminPanel.js';

const ADMIN_PATH = '/dashboard';
const viewFor = p => (p === ADMIN_PATH || p === ADMIN_PATH + '/' ? 'admin' : 'island');

const stage = document.getElementById('island-stage');
const frame = document.getElementById('cctv-frame');
const islandRef = React.createRef();

let view = null;
let settle = 0;

// ---- the camera's geometry: where the scaled-down stage sits ----------------------
// Top right of the admin PAGE, not of the window: the inset is part of the page and scrolls
// away with it. While the stage glides between full view and inset it is position:fixed, in
// window coordinates; once it has landed it becomes position:absolute in the document
// (body.cctv-abs), so the browser scrolls it with the page itself. Following the scroll from
// script was tried first and always trailed it by a frame, which read as the inset slipping.
// The admin panel keeps a gutter of --cctv-w clear on that side at the top of the page, so
// the inset never sits on a control or a readout.
const CCTV_MAX = 230, CCTV_MIN = 140, MARGIN = 16;
let pinned = false;                  // landed: placed in the document, not the window
function layout() {
  const w = window.innerWidth || 1, h = window.innerHeight || 1;
  const cw = Math.round(Math.min(CCTV_MAX, Math.max(CCTV_MIN, w * 0.155)));
  const scale = cw / w;
  // The inset shows the picture only: the stage is clipped to the 3D scene, so the page's
  // header and dock leave no empty band. Measured in the stage's own unscaled pixels.
  let top = 0, tall = h;
  const stage = document.getElementById('island-stage'), scene = document.querySelector('island-3d');
  if (stage && scene) {
    const S = stage.getBoundingClientRect(), R = scene.getBoundingClientRect(), k = S.width / w || 1;
    if (R.height > 0) { top = Math.max(0, (R.top - S.top) / k); tall = Math.min(h - top, R.height / k); }
  }
  const x = Math.max(MARGIN, w - cw - MARGIN), y = pinned ? MARGIN : MARGIN - window.scrollY;
  const style = document.documentElement.style;
  style.setProperty('--cctv-s', String(scale));
  style.setProperty('--cctv-x', x + 'px');
  style.setProperty('--cctv-y', (y - top * scale) + 'px');
  style.setProperty('--cctv-fy', MARGIN + 'px');       // the click target is always in the document
  style.setProperty('--cctv-w', cw + 'px');
  style.setProperty('--cctv-h', Math.round(tall * scale) + 'px');
  style.setProperty('--cctv-clip', `${top}px 0 ${Math.max(0, h - top - tall)}px 0`);
}
window.addEventListener('resize', layout);
layout();
const adminRoot = document.getElementById('admin-root');
// only while it is still gliding in: once pinned, the browser does the scrolling
window.addEventListener('scroll', () => { if (!pinned) layout(); }, { passive: true });

// ---- routing ---------------------------------------------------------------------
function apply(next) {
  if (view === next) return;
  view = next;
  // The stage glides between its two sizes, but once it is the inset it must follow the
  // scroll exactly, not half a second behind it: the glide is switched off when it lands
  // (shell.css .cctv-settled) and back on the moment the view changes again.
  clearTimeout(settle);
  const body = document.body;
  if (pinned) {
    // Unpin without a jump: back to window coordinates at the spot it is showing at, with
    // the glide still off, and only then (after a reflow) let the view change start the glide.
    pinned = false; layout();
    body.classList.remove('cctv-abs');
    void stage.offsetWidth;
  }
  body.classList.remove('cctv-still');
  if (next === 'admin') settle = setTimeout(() => {
    pinned = true; layout();
    body.classList.add('cctv-still', 'cctv-abs');
  }, 560);
  document.body.classList.toggle('view-admin', next === 'admin');
  document.body.classList.toggle('view-island', next === 'island');
  frame.hidden = false;
  setAdminVisible(next === 'admin');
  syncLowPower();
  document.title = next === 'admin' ? 'agent-economy admin' : 'Settlers of Solana';
}

// The inset is a camera, not a game: a few frames a second is all it needs. The element may
// not exist yet on the first call, so this runs again once React has rendered it.
let sceneWatch = null;               // the scene's size moves with the dock, and the inset's clip with it
function syncLowPower() {
  const el = document.querySelector('island-3d');
  if (el) {
    el.lowPower = view === 'admin';
    if (!sceneWatch) { sceneWatch = new ResizeObserver(layout); sceneWatch.observe(el); }
    layout();
  } else setTimeout(syncLowPower, 50);
}

function go(next, { replace = false } = {}) {
  const path = next === 'admin' ? ADMIN_PATH : '/';
  if (location.pathname !== path) {
    if (replace) history.replaceState({ view: next }, '', path);
    else history.pushState({ view: next }, '', path);
  }
  apply(next);
}

window.addEventListener('popstate', () => apply(viewFor(location.pathname)));

window.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  if (view === 'admin') { go('island'); return; }
  // On the island, Esc closes an open place card first, then goes to the admin panel.
  if (islandRef.current?.closeOverlay()) return;
  go('admin');
});

frame.addEventListener('click', () => go('island'));

// ---- mount ------------------------------------------------------------------------
mountAdmin(adminRoot);
createRoot(document.getElementById('island-root')).render(
  <IslandApp ref={islandRef} onAdmin={() => go('admin')} />,
);

apply(viewFor(location.pathname));
history.replaceState({ view }, '', location.pathname + location.search);
