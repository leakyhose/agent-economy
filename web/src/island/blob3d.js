// The portrait renderer: the island's own 3D villager, one at a time, for the place card's
// lineup. One small WebGL renderer is shared by every portrait — a browser allows only a
// handful of WebGL contexts, and a lineup can be a hundred strong — and each villager's own
// 2D canvas is painted from it with drawImage, which stays on the GPU. The canvases are
// ordinary elements in the page, so they scroll and animate with it exactly.
import * as THREE from 'three';
import { FACE_COLS, FACE_LOOKS, bodyOf, blobParts } from './blob.js';

let rig = null, failed = false;
function build(w, h, dpr) {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, premultipliedAlpha: true });
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  // the island's light, near enough: sky and ground, a little fill, the sun from the upper left
  scene.add(new THREE.HemisphereLight(0xe8f8ff, 0x6a6f66, 1.25));
  scene.add(new THREE.AmbientLight(0xffffff, 0.3));
  const sun = new THREE.DirectionalLight(0xfff3da, 1.7);
  sun.position.set(-2.2, 3.4, 3);
  scene.add(sun);
  // a long lens from slightly above eye level: the whole figure, hat and all, feet on the bottom edge
  const camera = new THREE.PerspectiveCamera(22, w / h, 0.1, 50);
  camera.position.set(0, 1.18, 5.05);
  camera.lookAt(0, 0.9, 0);

  const parts = blobParts();
  const who = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0 });
  who.add(new THREE.Mesh(parts.bodyGeo, bodyMat));
  const atlas = new THREE.CanvasTexture(parts.atlas);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = 4;
  atlas.repeat.set(1 / FACE_COLS, 1 / FACE_LOOKS);
  who.add(new THREE.Mesh(parts.faceGeo, new THREE.MeshBasicMaterial({ map: atlas, alphaTest: 0.3, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })));
  const hats = parts.extras.map(e => {
    const m = new THREE.Mesh(e.geo, new THREE.MeshStandardMaterial({ color: e.color, roughness: 0.8, metalness: 0 }));
    who.add(m); return m;
  });
  scene.add(who);
  return { renderer, scene, camera, who, bodyMat, atlas, hats, w, h, dpr, color: new THREE.Color() };
}

// Paint villager `id` into a 2D context of w × h CSS pixels. `yaw` turns them (0 faces the
// viewer), `breath` is a squash of a few percent. Returns false if WebGL is not to be had,
// so the caller can fall back to the flat painter.
export function paintBlob(ctx, { id, mood, blink, color, yaw = 0, breath = 0, w, h, dpr }) {
  if (failed) return false;
  try { if (!rig || rig.w !== w || rig.h !== h || rig.dpr !== dpr) { rig?.renderer.dispose(); rig = build(w, h, dpr); } }
  catch { failed = true; return false; }
  const B = bodyOf(id), R = rig;
  R.who.scale.set(B.girth * (1 + breath * 0.6), B.tall * (1 - breath), B.girth * (1 + breath * 0.6));
  R.who.rotation.set(B.leanX, yaw, B.leanZ);
  R.bodyMat.color.copy(R.color.set(color));
  R.atlas.offset.set((mood * 2 + (blink ? 1 : 0)) / FACE_COLS, (FACE_LOOKS - 1 - B.look) / FACE_LOOKS);
  R.hats.forEach((m, k) => { m.visible = k === B.extra; });
  R.renderer.render(R.scene, R.camera);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w * dpr, h * dpr);
  ctx.drawImage(R.renderer.domElement, 0, 0);
  return true;
}
