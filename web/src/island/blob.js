// What a villager looks like: one definition, two painters. island3d.js builds the 3D blobs
// from it (an instanced lathe, a canvas face atlas, hats); the place card's lineup draws the
// same villager flat, from the same id — same build, same features, same hat, same mood.
import { SplineCurve, Vector2, LatheGeometry, CylinderGeometry, SphereGeometry, ConeGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// the pear's silhouette, [radius, height] from the ground up; the lathe turns it, the lineup mirrors it
export const BLOB_PROFILE = [[0, 0], [0.26, 0.02], [0.43, 0.12], [0.5, 0.3], [0.47, 0.5], [0.39, 0.68],
  [0.32, 0.84], [0.29, 0.98], [0.24, 1.09], [0.13, 1.17], [0, 1.2]];

export const rand = (id, salt) => { const v = Math.sin((id + 1) * (12.9898 + salt * 17.31)) * 43758.5453; return v - Math.floor(v); };

// ---- what a villager looks like -------------------------------------------------
// The face atlas: a column per mood, twice over (eyes open, eyes shut for the blink), and
// a row per set of features. A villager keeps its row for life and moves along it.
export const FACE_CELL = 128, FACE_LOOKS = 5, FACE_COLS = 12;
export const HAPPY = 0, GRIN = 1, NEUTRAL = 2, WORRIED = 3, SAD = 4, DECIDING = 5;
// plain, wide-eyed, spectacled, rosy and close-set, heavy-browed
export const LOOKS = [{ dx: 27, r: 10.5 }, { dx: 34, r: 13 }, { dx: 27, r: 7.5, specs: true }, { dx: 21, r: 9.5, blush: true }, { dx: 27, r: 10.5, brows: true }];
export function drawFace(g, mood, look, blink) {
  const L = LOOKS[look], cx = FACE_CELL / 2, ey = 44;
  const gaze = mood === DECIDING ? [4, -5] : [0, 0];
  g.lineCap = "round"; g.lineJoin = "round"; g.strokeStyle = g.fillStyle = "#0b0b0d";
  if (L.blush) { g.fillStyle = "#ef7f93"; [-1, 1].forEach(s => { g.beginPath(); g.arc(cx + s * 40, 66, 9, 0, Math.PI * 2); g.fill(); }); g.fillStyle = "#0b0b0d"; }
  [-1, 1].forEach(s => {
    const x = cx + s * L.dx;
    g.beginPath();
    if (blink) { g.lineWidth = 4.5; g.moveTo(x - L.r, ey + 1); g.lineTo(x + L.r, ey + 1); g.stroke(); }
    else { g.arc(x + gaze[0], ey + gaze[1], L.r, 0, Math.PI * 2); g.fill(); }
    if (L.specs) { g.lineWidth = 4; g.beginPath(); g.arc(x, ey, 17, 0, Math.PI * 2); g.stroke(); }
    // brows: the heavy-browed always wear them; trouble puts them on everyone, inner ends up
    const tilt = mood === WORRIED || mood === SAD ? 7 : mood === DECIDING ? -3 * s : 0;
    if (L.brows || tilt) {
      g.lineWidth = L.brows ? 7 : 4.5;
      const by = ey - L.r - (L.specs ? 16 : 9);
      g.beginPath(); g.moveTo(x - s * 11, by - tilt); g.lineTo(x + s * 11, by + (tilt > 0 ? 2 : 0)); g.stroke();
    }
  });
  if (L.specs) { g.lineWidth = 4; g.beginPath(); g.moveTo(cx - L.dx + 17, ey); g.lineTo(cx + L.dx - 17, ey); g.stroke(); }
  g.lineWidth = 5.5;
  g.beginPath();
  if (mood === HAPPY) { g.arc(cx, 70, 15, Math.PI * 0.14, Math.PI * 0.86); g.stroke(); }
  else if (mood === GRIN) { g.arc(cx, 70, 17, 0, Math.PI); g.closePath(); g.fill(); g.stroke(); }
  else if (mood === NEUTRAL) { g.moveTo(cx - 10, 80); g.lineTo(cx + 10, 80); g.stroke(); }
  else if (mood === WORRIED) { g.moveTo(cx - 13, 82); g.quadraticCurveTo(cx - 6, 74, cx, 82); g.quadraticCurveTo(cx + 6, 90, cx + 13, 82); g.stroke(); }
  else if (mood === SAD) {
    g.arc(cx, 96, 15, Math.PI * 1.17, Math.PI * 1.83); g.stroke();
    if (!blink) { g.fillStyle = "#7fd0ff"; g.beginPath(); g.arc(cx - L.dx - 3, ey + L.r + 12, 5.5, 0, Math.PI * 2); g.fill(); }
  }
  else { g.moveTo(cx + 2, 81); g.lineTo(cx + 15, 78); g.stroke(); }
}
// Read off /state the same way the villager cards do: want first, then worry, then the rest.
export const moodOf = (a) => a.hunger >= 3 || a.cold >= 2 ? SAD
  : a.hunger > 0 || (a.debt > 0 && a.dueIn != null && a.dueIn <= 2) ? WORRIED
  : a.activity === 'deciding' ? DECIDING
  : a.house ? GRIN
  : a.debt > 0 ? NEUTRAL : HAPPY;
// a body of its own, fixed by the id: proportions, a lean, a row of the atlas, maybe a hat
export const BLOB = 2;                                          // world units per unit of blob: ~2.4 tall, half a cabin
export const bodyOf = (id) => {
  const extra = rand(id, 23);
  return { tall: 0.84 + rand(id, 20) * 0.4, girth: 0.86 + rand(id, 21) * 0.34,
           leanX: (rand(id, 24) - 0.5) * 0.14, leanZ: (rand(id, 25) - 0.5) * 0.2,
           look: Math.floor(rand(id, 22) * FACE_LOOKS) % FACE_LOOKS,
           extra: extra < 0.4 ? -1 : extra < 0.6 ? 0 : extra < 0.8 ? 1 : 2,
           phase: rand(id, 26) * 6.283, aside: (rand(id, 27) - 0.5) * 0.9, blinkEvery: 2.8 + rand(id, 28) * 3 };
};

// ---- the model's parts, built once ---------------------------------------------------
// One pear of a body (a lathe of BLOB_PROFILE); the face, a patch of that same lathe a hair
// proud of the skin, facing +z; the face atlas it is textured from (mood across, twice over
// for the blink; the villager's own features down); and the hats, modelled in the body's
// space so they take the body's matrix as it is. The island instances these; the lineup's
// portrait renderer (blob3d.js) draws them one villager at a time.
let PARTS = null;
export function blobParts() {
  if (PARTS) return PARTS;
  const prof = new SplineCurve(BLOB_PROFILE.map(([r, y]) => new Vector2(r, y))).getSpacedPoints(20);
  prof.forEach(q => { q.x = Math.max(0, q.x); });
  prof[0].x = prof[prof.length - 1].x = 0;
  const bodyGeo = new LatheGeometry(prof, 16);
  const skin = prof.filter(q => q.y > 0.56 && q.y < 1.15).map(q => new Vector2(q.x + 0.012, q.y));
  const faceGeo = new LatheGeometry(skin, 8, -0.8, 1.6);

  const g = document.createElement("canvas").getContext("2d");
  g.canvas.width = FACE_CELL * FACE_COLS; g.canvas.height = FACE_CELL * FACE_LOOKS;
  for (let look = 0; look < FACE_LOOKS; look++) for (let mood = 0; mood < 6; mood++) for (let blink = 0; blink < 2; blink++) {
    g.save();
    g.translate((mood * 2 + blink) * FACE_CELL, look * FACE_CELL);
    g.beginPath(); g.rect(0, 0, FACE_CELL, FACE_CELL); g.clip();
    drawFace(g, mood, look, blink);
    g.restore();
  }

  const at = (geo, x, y, z, rz = 0, sx = 1, sy = 1, sz = 1) => geo.scale(sx, sy, sz).rotateZ(rz).translate(x, y, z);
  const extras = [
    { color: 0x5fae3b, geo: mergeGeometries([                         // a sprout
      at(new CylinderGeometry(0.016, 0.02, 0.16, 6), 0, 1.27, 0),
      at(new SphereGeometry(0.1, 8, 6), 0.09, 1.37, 0, 0.5, 1, 0.22, 0.5),
      at(new SphereGeometry(0.1, 8, 6), -0.09, 1.37, 0, -0.5, 1, 0.22, 0.5)]) },
    { color: 0xe2c275, geo: mergeGeometries([                         // a straw hat
      at(new CylinderGeometry(0.3, 0.32, 0.03, 14), 0, 1.11, 0),
      at(new CylinderGeometry(0.16, 0.2, 0.15, 12), 0, 1.19, 0)]) },
    { color: 0xd8434f, geo: mergeGeometries([                         // a bow
      at(new ConeGeometry(0.075, 0.14, 8), 0.07, 1.23, 0, Math.PI / 2),
      at(new ConeGeometry(0.075, 0.14, 8), -0.07, 1.23, 0, -Math.PI / 2),
      at(new SphereGeometry(0.04, 8, 6), 0, 1.23, 0)]) },
  ];
  return (PARTS = { bodyGeo, faceGeo, atlas: g.canvas, extras });
}

// ---- the flat painter (the fallback where WebGL will not start) ----------------------------------------------------------------
const OUTLINE = new SplineCurve(BLOB_PROFILE.map(([r, y]) => new Vector2(r, y))).getSpacedPoints(40)
  .map(q => [Math.max(0, q.x), q.y]);
const radiusAt = y => { for (let i = 1; i < OUTLINE.length; i++) if (OUTLINE[i][1] >= y) return OUTLINE[i][0]; return 0; };

// Draw villager `id` standing on (cx, base), `unit` pixels to one unit of blob. Flat colour,
// one flat shade down the far side for form — no gradients. `dark` is that shade.
export function drawBlob(g, { id, mood, blink = false, color, dark, cx, base, unit }) {
  const B = bodyOf(id), W = B.girth * unit, H = B.tall * unit;
  g.save();
  g.translate(cx, base);
  g.rotate(B.leanZ * 0.6);
  const body = () => {
    g.beginPath();
    g.moveTo(0, 0);
    for (const [r, y] of OUTLINE) g.lineTo(r * W, -y * H);
    for (let i = OUTLINE.length - 1; i >= 0; i--) g.lineTo(-OUTLINE[i][0] * W, -OUTLINE[i][1] * H);
    g.closePath();
  };
  body(); g.fillStyle = color; g.fill();
  g.save(); body(); g.clip();                               // the shaded side: the same pear, slid across
  g.translate(W * 0.34, H * 0.05); body(); g.fillStyle = dark; g.globalAlpha = 0.55; g.fill();
  g.restore();

  // the face: the atlas cell laid over the same band of the body the 3D patch covers
  const top = 1.15, bottom = 0.56, fw = 2 * Math.sin(0.8) * radiusAt(0.82) * W * 1.12, fh = (top - bottom) * H;
  g.save();
  g.translate(-fw / 2, -top * H);
  g.scale(fw / FACE_CELL, fh / FACE_CELL);
  drawFace(g, mood, B.look, blink);
  g.restore();

  // hats and the like, in the body's own space as the 3D ones are
  if (B.extra === 0) {                                      // a sprout
    g.strokeStyle = g.fillStyle = "#5fae3b"; g.lineWidth = Math.max(1.5, unit * 0.035); g.lineCap = "round";
    g.beginPath(); g.moveTo(0, -1.19 * H); g.lineTo(0, -1.35 * H); g.stroke();
    [-1, 1].forEach(sd => { g.save(); g.translate(sd * 0.09 * W, -1.37 * H); g.rotate(-sd * 0.5);
      g.beginPath(); g.ellipse(0, 0, 0.1 * W, 0.03 * H + 1.5, 0, 0, Math.PI * 2); g.fill(); g.restore(); });
  } else if (B.extra === 1) {                               // a straw hat
    g.fillStyle = "#e2c275";
    g.beginPath(); g.ellipse(0, -1.11 * H, 0.31 * W, 0.045 * H, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.moveTo(-0.2 * W, -1.11 * H); g.lineTo(-0.16 * W, -1.27 * H); g.lineTo(0.16 * W, -1.27 * H); g.lineTo(0.2 * W, -1.11 * H); g.closePath(); g.fill();
    g.fillStyle = "#b9974f"; g.fillRect(-0.195 * W, -1.15 * H, 0.39 * W, 0.03 * H);
  } else if (B.extra === 2) {                               // a bow
    g.fillStyle = "#d8434f";
    [-1, 1].forEach(sd => { g.beginPath(); g.moveTo(0, -1.23 * H); g.lineTo(sd * 0.15 * W, -1.3 * H); g.lineTo(sd * 0.15 * W, -1.16 * H); g.closePath(); g.fill(); });
    g.beginPath(); g.arc(0, -1.23 * H, 0.04 * W + 1, 0, Math.PI * 2); g.fill();
  }
  g.restore();
}
