// <island-3d> — orbitable volcanic island, one blob per agent. Each round plays as a day:
// when a round settles everyone walks to the market (dusk), then back out to the area where
// their next shift happens. Blobs walk the coast road at a steady pace, on the ground.
// Drag to orbit, scroll to zoom, click a place to open it (dispatches "moku:location").
(function () {
  const SEA = 0;
  // Where each task happens. An agent that is deciding (no task yet this round) stays put.
  const AREAS = [
    { id: "docks",    name: "Docks — fishing",          color: "#1f9fb5", x: -70, z: 38,  tasks: ["gather_food"] },
    { id: "forest",   name: "Forest — chopping wood",   color: "#3f9450", x: 40,  z: -48, tasks: ["gather_wood"] },
    { id: "workshop", name: "Workshop — crafting",      color: "#d98c2b", x: 60,  z: 8,   tasks: ["craft_net"] },
    { id: "site",     name: "Building site — houses",   color: "#cf6046", x: -16, z: -50, tasks: ["build_house"] },
    { id: "market",   name: "Market",                   color: "#8a8f98", x: 18,  z: 56,  tasks: ["idle"] },
  ];
  const MARKET = AREAS.at(-1);
  const areaOf = task => AREAS.find(a => a.tasks.includes(task));

  function hash2(x, y) {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
    return s - Math.floor(s);
  }
  function smooth(t) { return t * t * (3 - 2 * t); }
  function vnoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = smooth(xf), v = smooth(yf);
    const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  }
  function fbm(x, y, oct) {
    let amp = 0.5, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < oct; i++) { sum += amp * vnoise(x * freq, y * freq); norm += amp; amp *= 0.5; freq *= 2.03; }
    return sum / norm;
  }
  function sstep(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

  function height(x, z) {
    const d = Math.hypot(x, z);
    const ang = Math.atan2(z, x);
    const coast = fbm(Math.cos(ang) * 1.9 + 5, Math.sin(ang) * 1.9 + 9, 4);
    const R = 62 + coast * 30;
    const inland = 1 - sstep(R * 0.5, R, d);
    const base = fbm(x * 0.032 + 11, z * 0.032 + 7, 5);
    let y = (base * 0.8 + 0.2) * inland * 19;
    const dc = Math.hypot((x + 46) * 1.05, (z + 26) * 0.95);        // eroded crater ridge
    y += Math.exp(-Math.pow(dc - 14, 2) / 62) * 21 * inland;
    y -= Math.exp(-Math.pow(dc, 2) / 90) * 7 * inland;               // crater bowl
    const spine = Math.max(0, 1 - Math.hypot((x - 10) * 0.85, (z + 2) * 1.25) / 44);
    y += Math.pow(spine, 1.8) * 25 * inland;                          // main ridge
    y += fbm(x * 0.11 + 3, z * 0.11 + 2, 4) * 3.4 * inland;           // gullies
    const ridged = 1 - Math.abs(fbm(x * 0.05 + 21, z * 0.05 + 13, 4) * 2 - 1);
    y += Math.pow(ridged, 2.2) * 5.5 * inland;                        // eroded spurs
    y += fbm(x * 0.34 + 41, z * 0.34 + 29, 3) * 1.1 * inland;         // fine surface detail
    y -= 11 * sstep(R * 0.93, R + 30, d);                             // shelf drops under water
    y -= 14 * sstep(R + 26, R + 90, d);
    return y;
  }

  // The coast road: a loop of waypoints just above the beach. Blobs walk area -> road -> along
  // it -> area, so nobody climbs the mountain or swims.
  const ROAD = Array.from({ length: 36 }, (_, i) => {
    const t = i / 36 * Math.PI * 2;
    let r = 120;
    while (r > 10 && height(Math.cos(t) * r, Math.sin(t) * r) < 3.5) r--;
    return [Math.cos(t) * (r - 3), Math.sin(t) * (r - 3)];
  });
  const nearestRoad = (x, z) => ROAD.reduce((best, p, i) =>
    Math.hypot(p[0] - x, p[1] - z) < Math.hypot(ROAD[best][0] - x, ROAD[best][1] - z) ? i : best, 0);
  // waypoints from (x0,z0) to (x1,z1); (ox,oz) keeps each blob in its own lane on the road
  function route(x0, z0, x1, z1, ox, oz) {
    const path = [];
    if (Math.hypot(x1 - x0, z1 - z0) > 40) {
      const a = nearestRoad(x0, z0), b = nearestRoad(x1, z1), n = ROAD.length;
      const step = (b - a + n) % n <= n / 2 ? 1 : n - 1;         // the shorter way round
      for (let i = a; ; i = (i + step) % n) { path.push([ROAD[i][0] + ox, ROAD[i][1] + oz]); if (i === b) break; }
    }
    path.push([x1, z1]);
    return path;
  }
  const rand = (id, salt) => { const v = Math.sin((id + 1) * (12.9898 + salt * 17.31)) * 43758.5453; return v - Math.floor(v); };
  // an agent's own standing spot in an area — the same every visit
  function spot(id, area) {
    let jx = (rand(id, 1) * 2 - 1) * 11, jz = (rand(id, 2) * 2 - 1) * 11;
    for (let k = 0; k < 6 && height(area.x + jx, area.z + jz) < 1.2; k++) { jx *= 0.6; jz *= 0.6; }   // stay on dry land
    return [area.x + jx, area.z + jz];
  }

  const TEMPLATE_CSS = `
    :host, island-3d { display:block; position:absolute; inset:0; }
    .i3d-canvas { position:absolute; inset:0; cursor:grab; }
    .i3d-canvas:active { cursor:grabbing; }
    .i3d-overlay { position:absolute; inset:0; pointer-events:none; overflow:hidden; }
    .i3d-pin { position:absolute; transform-origin:50% 100%; display:flex; flex-direction:column; align-items:center; gap:4px;
      transform:translate(-50%,-100%); font-family:system-ui, sans-serif; background:none; border:0; padding:0; cursor:pointer;
      pointer-events:auto; transition:opacity .25s ease; }
    .i3d-count { min-width:26px; height:26px; padding:0 6px; border-radius:999px; color:#fff; font-size:13px; font-weight:800;
      display:grid; place-items:center; border:3px solid #fff; box-shadow:0 4px 10px rgba(3,28,40,.45); }
    .i3d-name { background:rgba(255,255,255,.94); color:#0d4a5e; font-size:11px; font-weight:800; padding:2px 8px;
      border-radius:999px; white-space:nowrap; }
    .i3d-hint { position:absolute; left:14px; top:8px; font-family:system-ui, sans-serif; background:rgba(7,40,56,.6);
      border:1px solid rgba(255,255,255,.14); border-radius:10px; padding:5px 9px; font-size:10px; font-weight:800;
      letter-spacing:.14em; text-transform:uppercase; color:#dff2f7; transition:opacity .5s ease; }
  `;

  class Island3D extends HTMLElement {
    connectedCallback() {
      if (this._booted) return;
      this._booted = true;
      const style = document.createElement("style");
      style.textContent = TEMPLATE_CSS;
      this.appendChild(style);
      this.canvasHost = document.createElement("div");
      this.canvasHost.className = "i3d-canvas";
      this.overlay = document.createElement("div");
      this.overlay.className = "i3d-overlay";
      const hint = document.createElement("div");
      hint.className = "i3d-hint";
      hint.textContent = "drag to orbit · scroll to zoom · click a place";
      this.overlay.appendChild(hint);
      this.appendChild(this.canvasHost);
      this.appendChild(this.overlay);
      this.areas = AREAS.map(a => ({ ...a, y: height(a.x, a.z) + 3, count: 0 }));
      this.blobs = new Map();           // agent id -> { id, x, z, job, dest, path }
      this.round = null;
      this.marketUntil = 0;             // everyone is at the market until this time (ms, performance.now)
      this.speed = 30;                  // walking speed, world units a second
      this.areas.forEach(a => {
        a.pin = document.createElement("button");
        a.pin.className = "i3d-pin";
        a.pin.innerHTML = `<span class="i3d-count" style="background:${a.color}">0</span><span class="i3d-name">${a.name}</span>`;
        a.pin.addEventListener("click", () => window.dispatchEvent(new CustomEvent("moku:location", { detail: a.id })));
        this.overlay.appendChild(a.pin);
      });
      this.boot();
    }
    disconnectedCallback() {
      clearInterval(this._poll);
      this._events?.close();
      cancelAnimationFrame(this._raf);
      if (this.renderer) this.renderer.dispose();
    }

    async boot() {
      const THREE = await import("https://esm.sh/three@0.161.0");
      this.THREE = THREE;
      const scene = new THREE.Scene();
      scene.fog = new THREE.FogExp2(0x146b87, 0.0022);
      this.scene = scene;

      const camera = new THREE.PerspectiveCamera(42, 1, 1, 1600);
      this.camera = camera;
      this.orbit = { r: 190, theta: -0.46, phi: 0.92, tr: 190, ttheta: -0.46, tphi: 0.92 };

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      // Restore the high-density surface that makes the water read as water rather
      // than a flat blue plane. The expensive CPU work from the old scene (pin
      // projection and terrain lookups every frame) remains throttled below.
      renderer.setPixelRatio(Math.min(1.8, window.devicePixelRatio || 1));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.setClearColor(0x0b4a64, 1);
      this.renderer = renderer;
      this.canvasHost.appendChild(renderer.domElement);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      renderer.domElement.style.display = "block";

      this.hemi = new THREE.HemisphereLight(0xe8f8ff, 0x51704a, 1.25);
      scene.add(this.hemi);
      scene.add(new THREE.AmbientLight(0xffffff, 0.25));
      const sun = new THREE.DirectionalLight(0xfff3da, 1.7);
      sun.position.set(-90, 130, 70);
      sun.castShadow = true;
      sun.shadow.mapSize.set(1024, 1024);
      sun.shadow.camera.left = -170; sun.shadow.camera.right = 170;
      sun.shadow.camera.top = 170; sun.shadow.camera.bottom = -170;
      sun.shadow.camera.far = 420;
      sun.shadow.bias = -0.0012;
      scene.add(sun);
      this.sun = sun;

      // ---- terrain ----
      const SIZE = 340, SEG = 330;
      const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
      geo.rotateX(-Math.PI / 2);
      const pos = geo.attributes.position;
      const colors = new Float32Array(pos.count * 3);
      const c = new THREE.Color();
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), z = pos.getZ(i);
        const y = height(x, z);
        pos.setY(i, y);
        const hx = height(x + 1.4, z), hz = height(x, z + 1.4);
        const slope = Math.min(1, (Math.abs(y - hx) + Math.abs(y - hz)) / 2.6);
        if (y < -3) c.set(0x2c7f92);
        else if (y < 1.3) c.set(0xeadcae);
        else if (y < 3) c.setHex(0xdfd0a0).lerp(new THREE.Color(0x8fbf62), (y - 1.3) / 1.7);
        else if (y < 9) c.setHex(0x86c266).lerp(new THREE.Color(0x5da14b), (y - 3) / 6);
        else if (y < 19) c.setHex(0x5da14b).lerp(new THREE.Color(0x7d8348), (y - 9) / 10);
        else if (y < 30) c.setHex(0x7a6a4e).lerp(new THREE.Color(0x6b5643), (y - 19) / 11);
        else c.setHex(0x584639);
        if (slope > 0.45 && y > 2) c.lerp(new THREE.Color(0x7d6a55), (slope - 0.45) * 1.5);
        if (y > -0.9 && y < 0.9) c.lerp(new THREE.Color(0xf4fbff), 0.42 - Math.abs(y) * 0.3);   // surf line
        const band = Math.abs((y % 3.5)) < 0.22 && y > 1 ? 0.9 : 1;      // faint topographic contours
        c.multiplyScalar(band * (0.94 + fbm(x * 0.5, z * 0.5, 2) * 0.12));
        colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
      }
      geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      geo.computeVertexNormals();
      // The per-vertex palette above sets the broad bands; this shader adds the
      // per-pixel detail they cannot carry — sand grain, grass clumping and rock
      // strata — the same way the water surface is upscaled. No extra geometry.
      const landMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
      landMat.onBeforeCompile = (sh) => {
        sh.vertexShader = sh.vertexShader
          .replace("#include <common>", "#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;")
          .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\n  vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\n  vWNrm = normalize(mat3(modelMatrix) * objectNormal);");
        sh.fragmentShader = sh.fragmentShader
          .replace("#include <common>", `#include <common>
            varying vec3 vWPos;
            varying vec3 vWNrm;
            float vRough = 0.9;
            float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
            float vn(vec2 p){
              vec2 i = floor(p), f = fract(p);
              vec2 u = f * f * (3.0 - 2.0 * f);
              return mix(mix(h21(i), h21(i + vec2(1,0)), u.x), mix(h21(i + vec2(0,1)), h21(i + vec2(1,1)), u.x), u.y);
            }
            float fb(vec2 p, int oct){
              float s = 0.0, a = 0.5;
              for (int i = 0; i < 6; i++) { if (i >= oct) break; s += a * vn(p); p *= 2.07; a *= 0.5; }
              return s;
            }
            // worley-ish cell noise for grass clumps and rock facets
            float cells(vec2 p){
              vec2 ip = floor(p), fp = fract(p);
              float d = 1.0;
              for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
                vec2 g = vec2(float(x), float(y));
                vec2 o = vec2(h21(ip + g), h21(ip + g + 7.3));
                d = min(d, length(g + o - fp));
              }
              return d;
            }`)
          .replace("#include <color_fragment>", `#include <color_fragment>
            {
              vec3 wp = vWPos;
              float alt = wp.y;
              float slope = 1.0 - clamp(vWNrm.y, 0.0, 1.0);

              // --- sand: fine grain + wind ripples parallel to the shore ---
              float grain = fb(wp.xz * 9.0, 3);
              float ripple = sin(wp.x * 1.1 + wp.z * 0.7 + fb(wp.xz * 0.35, 2) * 6.0) * 0.5 + 0.5;
              float sandMask = 1.0 - smoothstep(0.8, 3.4, alt);
              vec3 sandDetail = vec3(0.09, 0.075, 0.05) * (grain - 0.5) * 2.0
                              + vec3(0.05, 0.045, 0.03) * (ripple - 0.5);

              // --- grass: clumped cells + blade-scale speckle, dries out with altitude ---
              float clump = 1.0 - cells(wp.xz * 0.55);
              float blades = fb(wp.xz * 14.0, 3);
              float grassMask = smoothstep(1.8, 4.0, alt) * (1.0 - smoothstep(13.0, 21.0, alt)) * (1.0 - smoothstep(0.42, 0.72, slope));
              vec3 grassDetail = vec3(-0.07, 0.10, -0.05) * (clump - 0.45) * 1.25
                               + vec3(0.045, 0.06, 0.03) * (blades - 0.5) * 0.9;

              // --- rock: stratified bands + facet breakup on steep or high ground ---
              float strata = fb(vec2(wp.x * 0.35 + wp.z * 0.12, alt * 1.45), 4);
              float facet = 1.0 - cells(wp.xz * 1.25 + alt * 0.4);
              float rockMask = clamp(smoothstep(0.38, 0.78, slope) + smoothstep(15.0, 27.0, alt), 0.0, 1.0);
              vec3 rockDetail = vec3(0.13, 0.115, 0.10) * (strata - 0.5) * 1.5
                              + vec3(0.08, 0.075, 0.07) * (facet - 0.5);

              // --- damp sand right at the tideline ---
              float wet = (1.0 - smoothstep(0.0, 1.7, alt)) * step(0.02, alt);
              diffuseColor.rgb *= mix(1.0, 0.72, wet);

              diffuseColor.rgb += sandDetail * sandMask
                                + grassDetail * grassMask
                                + rockDetail * rockMask;

              // large-scale mottling so the whole island never reads flat
              diffuseColor.rgb *= 0.9 + fb(wp.xz * 0.075, 4) * 0.22;
              diffuseColor.rgb = clamp(diffuseColor.rgb, 0.0, 1.0);

              vRough = clamp(0.62 + (1.0 - wet) * 0.3 + (strata - 0.5) * 0.25 * rockMask, 0.35, 1.0);
            }`)
          .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n  roughnessFactor = vRough;");
      };
      const land = new THREE.Mesh(geo, landMat);
      land.castShadow = true;
      land.receiveShadow = true;
      scene.add(land);

      // ---- vegetation: instanced low-poly canopy on gentle mid slopes ----
      const treeGeo = new THREE.SphereGeometry(1.5, 8, 6);
      treeGeo.scale(1, 0.78, 1);
      treeGeo.translate(0, 3.0, 0);
      const trees = new THREE.InstancedMesh(treeGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 }), 120);
      trees.castShadow = true;
      trees.receiveShadow = true;
      const trunkGeo = new THREE.CylinderGeometry(0.17, 0.26, 2.2, 6);
      trunkGeo.translate(0, 1.1, 0);
      const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x6b4c33, roughness: 1, metalness: 0 }), 120);
      trunks.castShadow = true;
      trunks.receiveShadow = true;
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), tp = new THREE.Vector3();
      const tcol = new THREE.Color();
      let placed = 0;
      for (let i = 0; i < 26000 && placed < 120; i++) {
        const x = (hash2(i * 1.7, 3.1) - 0.5) * 210;
        const z = (hash2(i * 2.3, 9.7) - 0.5) * 210;
        const hgt = height(x, z);
        if (hgt < 2.4 || hgt > 18) continue;
        const sl = Math.abs(hgt - height(x + 1.5, z)) + Math.abs(hgt - height(x, z + 1.5));
        if (sl > 3.4) continue;
        if (hash2(i * 5.3, 1.9) > 0.018) continue;
        const s = 1.25 + hash2(i * 0.9, 4.4) * 1.0;
        tp.set(x, hgt - 0.3, z);
        sc.set(s, s * (0.8 + hash2(i, 7) * 0.7), s);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), hash2(i, 2) * 6.28);
        m4.compose(tp, q, sc);
        trees.setMatrixAt(placed, m4);
        trunks.setMatrixAt(placed, m4);
        tcol.setHSL(0.245 + hash2(i, 11) * 0.055, 0.44 + hash2(i, 13) * 0.16, 0.2 + hash2(i, 17) * 0.1);
        trees.setColorAt(placed, tcol);
        placed++;
      }
      trees.count = placed;
      trunks.count = placed;
      trees.instanceMatrix.needsUpdate = true;
      trunks.instanceMatrix.needsUpdate = true;
      if (trees.instanceColor) trees.instanceColor.needsUpdate = true;
      scene.add(trees);
      scene.add(trunks);

      // ---- ground cover ------------------------------------------------------
      // Instanced tufts: over a thousand distinct blades in a single draw call.
      // Rock on the upper slopes is left to the terrain shader rather than to
      // scattered boulders, which read as floating on steep faces.
      const grassGeo = new THREE.ConeGeometry(0.42, 1.7, 4);
      grassGeo.translate(0, 0.84, 0);
      const grass = new THREE.InstancedMesh(grassGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true }), 1500);
      const grassCol = new THREE.Color();
      let grassPlaced = 0;
      for (let i = 0; i < 64000 && grassPlaced < 1500; i++) {
        const x = (hash2(i * 1.11, 38.7) - 0.5) * 205;
        const z = (hash2(i * 1.93, 21.4) - 0.5) * 205;
        const hgt = height(x, z);
        const slope = Math.abs(hgt - height(x + 1.2, z)) + Math.abs(hgt - height(x, z + 1.2));
        if (hgt < 2.1 || hgt > 19 || slope > 2.55 || hash2(i * 3.7, 14.9) > 0.052) continue;
        const s = 0.42 + hash2(i * 5.1, 3.2) * 0.75;
        tp.set(x, hgt - 0.06, z);
        sc.set(s * (0.75 + hash2(i, 31) * 0.55), s * (0.65 + hash2(i, 33) * 0.8), s);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), hash2(i, 35) * 6.28);
        m4.compose(tp, q, sc);
        grass.setMatrixAt(grassPlaced, m4);
        grassCol.setHSL(0.22 + hash2(i, 37) * 0.12, 0.42 + hash2(i, 39) * 0.22, 0.26 + hash2(i, 41) * 0.16);
        grass.setColorAt(grassPlaced, grassCol);
        grassPlaced++;
      }
      grass.count = grassPlaced;
      grass.instanceMatrix.needsUpdate = true;
      if (grass.instanceColor) grass.instanceColor.needsUpdate = true;
      scene.add(grass);

      // ---- water: shader surface with waves, depth shading and shoreline foam ----
      const HMAP = 256;
      const hdata = new Uint8Array(HMAP * HMAP * 4);
      for (let j = 0; j < HMAP; j++) {
        for (let k = 0; k < HMAP; k++) {
          const wx = (k / (HMAP - 1) - 0.5) * SIZE;
          const wz = (j / (HMAP - 1) - 0.5) * SIZE;
          const hh = height(wx, wz);
          const v = Math.max(0, Math.min(255, Math.round((hh + 40) * 3.1)));  // -40..42 -> 0..255
          const o = (j * HMAP + k) * 4;
          hdata[o] = v; hdata[o + 1] = v; hdata[o + 2] = v; hdata[o + 3] = 255;
        }
      }
      const hTex = new THREE.DataTexture(hdata, HMAP, HMAP, THREE.RGBAFormat);
      hTex.minFilter = hTex.magFilter = THREE.LinearFilter;
      hTex.needsUpdate = true;

      const waterUniforms = {
        uTime: { value: 0 },
        uHeight: { value: hTex },
        uSize: { value: SIZE },
        uSun: { value: new THREE.Vector3(-90, 130, 70).normalize() },
        uDeep: { value: new THREE.Color(0x0a4c6b) },
        uMid: { value: new THREE.Color(0x189fbd) },
        uShallow: { value: new THREE.Color(0x7de3d4) },
        uFoam: { value: new THREE.Color(0xf2fbff) },
        uCam: { value: new THREE.Vector3() }
      };
      const waterMat = new THREE.ShaderMaterial({
        uniforms: waterUniforms,
        vertexShader: `
          uniform float uTime;
          varying vec3 vWorld;
          varying vec2 vWave;
          void main() {
            vec3 p = position;
            float w1 = sin(p.x * 0.055 + uTime * 0.9) * cos(p.y * 0.041 - uTime * 0.7);
            float w2 = sin((p.x + p.y) * 0.031 - uTime * 1.3);
            float w3 = sin(p.y * 0.12 + uTime * 1.9) * 0.35;
            float disp = w1 * 0.55 + w2 * 0.4 + w3 * 0.18;
            p.z += disp;
            vWave = vec2(w1, w2);
            vec4 wp = modelMatrix * vec4(p, 1.0);
            vWorld = wp.xyz;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: `
          uniform float uTime;
          uniform float uSize;
          uniform sampler2D uHeight;
          uniform vec3 uSun, uCam, uDeep, uMid, uShallow, uFoam;
          varying vec3 vWorld;
          varying vec2 vWave;

          float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float noise(vec2 p){
            vec2 i = floor(p), f = fract(p);
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(mix(hash(i), hash(i + vec2(1,0)), u.x),
                       mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
          }
          float fbm(vec2 p){
            float s = 0.0, a = 0.5;
            for (int i = 0; i < 4; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; }
            return s;
          }
          float terrainAt(vec2 xz){
            vec2 uv = xz / uSize + 0.5;
            if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return -40.0;
            return texture2D(uHeight, uv).r * 255.0 / 3.1 - 40.0;
          }
          void main() {
            vec2 xz = vWorld.xz;
            float depth = -terrainAt(xz);                       // metres of water
            float shore = smoothstep(0.0, 16.0, depth);
            float mid = smoothstep(10.0, 34.0, depth);
            vec3 col = mix(mix(uShallow, uMid, shore), uDeep, mid);

            // Two scrolling fractal fields give the old water its fine choppy
            // highlights and keep the foam from reading as a uniform ring.
            float n1 = fbm(xz * 0.19 + vec2(uTime * 0.16, uTime * 0.11));
            float n2 = fbm(xz * 0.46 - vec2(uTime * 0.23, uTime * 0.19));
            float e = 0.55;
            float hxa = fbm((xz + vec2(e, 0.0)) * 0.19 + vec2(uTime * 0.16, uTime * 0.11));
            float hza = fbm((xz + vec2(0.0, e)) * 0.19 + vec2(uTime * 0.16, uTime * 0.11));
            vec3 nrm = normalize(vec3((n1 - hxa) * 5.0, 1.0, (n1 - hza) * 5.0));

            // lighting: diffuse tint + sharp sun glint + fresnel sky
            vec3 viewDir = normalize(uCam - vWorld);
            vec3 halfv = normalize(uSun + viewDir);
            float spec = pow(max(dot(nrm, halfv), 0.0), 220.0) * 1.5;
            float sparkle = pow(max(dot(nrm, halfv), 0.0), 40.0) * 0.14 * (0.4 + n2);
            float fres = pow(1.0 - max(dot(nrm, viewDir), 0.0), 3.0);
            col += vec3(0.10, 0.14, 0.18) * (n1 - 0.5) * 1.1;
            col = mix(col, vec3(0.62, 0.84, 0.92), fres * 0.28);
            col += vec3(1.0, 0.97, 0.88) * (spec + sparkle);

            // shoreline foam: band over shallow ground, broken up by noise and swell
            float band = 1.0 - smoothstep(0.0, 4.2, depth);
            float swell = 0.5 + 0.5 * sin(depth * 2.1 - uTime * 2.2 + n1 * 5.0);
            float foam = band * smoothstep(0.35, 0.85, swell * (0.55 + 0.7 * fbm(xz * 0.7 + uTime * 0.08)));
            foam += (1.0 - smoothstep(0.0, 0.7, depth)) * 0.55;
            col = mix(col, uFoam, clamp(foam, 0.0, 0.9));

            float alpha = clamp(0.62 + shore * 0.38 + foam * 0.4, 0.0, 1.0);
            gl_FragColor = vec4(col, alpha);
          }`,
        transparent: true,
        depthWrite: true
      });
      const water = new THREE.Mesh(new THREE.PlaneGeometry(1100, 1100, 150, 150), waterMat);
      water.rotation.x = -Math.PI / 2;
      water.position.y = SEA;
      water.receiveShadow = false;
      scene.add(water);
      this.water = water;
      this.waterUniforms = waterUniforms;

      // ---- agent dots ----
      const cvs = document.createElement("canvas");
      cvs.width = cvs.height = 64;
      const g = cvs.getContext("2d");
      g.beginPath(); g.arc(32, 32, 26, 0, Math.PI * 2);
      g.fillStyle = "#fff"; g.fill();
      g.lineWidth = 8; g.strokeStyle = "rgba(255,255,255,.95)"; g.stroke();
      const sprite = new THREE.CanvasTexture(cvs);
      this.dotGeo = new THREE.BufferGeometry();
      this.dotMat = new THREE.PointsMaterial({ size: 9, map: sprite, vertexColors: true, transparent: true, alphaTest: 0.35, sizeAttenuation: true, depthWrite: false });
      this.dots = new THREE.Points(this.dotGeo, this.dotMat);
      this.dots.frustumCulled = false;
      scene.add(this.dots);

      // ---- pier off the beach by the docks ----
      {
        const dirx = -0.879, dirz = 0.477;
        let sx = 0, sz = 0;
        for (let t = 0; t < 120; t++) {
          const px = -70 + dirx * t * 0.6, pz = 38 + dirz * t * 0.6;
          if (height(px, pz) < 0.35) { sx = px; sz = pz; break; }
        }
        const len = 30, wdt = 5.4, deckY = 2.1;
        const ang = Math.atan2(dirz, dirx);
        const wood = new THREE.MeshStandardMaterial({ color: 0xb08a5e, roughness: 0.95, metalness: 0 });
        const woodDark = new THREE.MeshStandardMaterial({ color: 0x7d5c3c, roughness: 1, metalness: 0 });
        const pier = new THREE.Group();
        const planks = 14;
        for (let i = 0; i < planks; i++) {
          const p = new THREE.Mesh(new THREE.BoxGeometry(len / planks * 0.86, 0.35, wdt), i % 3 === 0 ? woodDark : wood);
          p.position.set(-len / 2 + (i + 0.5) * (len / planks), deckY, 0);
          p.castShadow = true; p.receiveShadow = true;
          pier.add(p);
        }
        const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.3, 0.3), woodDark);
        rail.position.set(0, deckY + 1.1, wdt / 2 - 0.2); pier.add(rail);
        const rail2 = rail.clone(); rail2.position.z = -wdt / 2 + 0.2; pier.add(rail2);
        for (let i = 0; i <= 5; i++) {
          const px = -len / 2 + (i * len) / 5;
          [-1, 1].forEach(s => {
            const post = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.38, 9, 7), woodDark);
            post.position.set(px, deckY - 3.6, s * (wdt / 2 - 0.4));
            post.castShadow = true;
            pier.add(post);
            if (i % 5 === 0 || i === 2) {
              const railPost = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.5, 0.3), woodDark);
              railPost.position.set(px, deckY + 0.6, s * (wdt / 2 - 0.2));
              pier.add(railPost);
            }
          });
        }
        const hut = new THREE.Mesh(new THREE.BoxGeometry(5, 3.2, 4.6), new THREE.MeshStandardMaterial({ color: 0xe4d3ad, roughness: 1 }));
        hut.position.set(-len / 2 + 3.4, deckY + 1.8, 0);
        hut.castShadow = true;
        const roof = new THREE.Mesh(new THREE.ConeGeometry(4.2, 2.1, 4), new THREE.MeshStandardMaterial({ color: 0x9a5f45, roughness: 1 }));
        roof.position.set(hut.position.x, deckY + 4.4, 0);
        roof.rotation.y = Math.PI / 4;
        roof.castShadow = true;
        pier.add(hut); pier.add(roof);
        const boat = new THREE.Mesh(new THREE.SphereGeometry(1.9, 10, 7, 0, Math.PI * 2, Math.PI * 0.42, Math.PI * 0.58), new THREE.MeshStandardMaterial({ color: 0xf0f3ef, roughness: 0.8, side: THREE.DoubleSide }));
        boat.scale.set(1.5, 0.8, 0.8);
        boat.position.set(len / 2 - 6, 0.6, wdt / 2 + 2.6);
        pier.add(boat);
        pier.position.set(sx + dirx * len / 2, 0, sz + dirz * len / 2);
        pier.rotation.y = -ang;
        scene.add(pier);
      }

      this._frame = 0;
      this.bindInput();
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(this);
      this.resize();
      this.loop();
      // the road: a sandy ribbon laid on the ground along the waypoints
      {
        const pts = [];
        ROAD.forEach(([x, z], i) => {
          const [nx, nz] = ROAD[(i + 1) % ROAD.length], steps = Math.ceil(Math.hypot(nx - x, nz - z) / 3);
          for (let k = 0; k < steps; k++) pts.push([x + (nx - x) * k / steps, z + (nz - z) * k / steps]);
        });
        const verts = [], index = [], n = pts.length;
        pts.forEach(([x, z], i) => {
          const [ax, az] = pts[(i + n - 1) % n], [bx, bz] = pts[(i + 1) % n];
          const len = Math.hypot(bx - ax, bz - az), px = -(bz - az) / len * 1.8, pz = (bx - ax) / len * 1.8;
          for (const side of [-1, 1]) { const vx = x + px * side, vz = z + pz * side; verts.push(vx, height(vx, vz) + 0.35, vz); }
          const a = i * 2, b = (i + 1) % n * 2;
          index.push(a, a + 1, b, b, a + 1, b + 1);
        });
        const roadGeo = new THREE.BufferGeometry();
        roadGeo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
        roadGeo.setIndex(index);
        roadGeo.computeVertexNormals();
        const road = new THREE.Mesh(roadGeo, new THREE.MeshStandardMaterial({ color: 0xe6d6a4, roughness: 1, side: THREE.DoubleSide }));
        road.receiveShadow = true;
        scene.add(road);
      }

      this.refresh();
      this._poll = setInterval(() => this.refresh(), 2000);
      this._events = new EventSource("/events");       // a settled round starts the walk to market at once
      this._events.onmessage = e => { if (JSON.parse(e.data).type === "round") this.refresh(); };
    }

    async refresh() {
      let s;
      try { s = await (await fetch("/state", { cache: "no-store" })).json(); }
      catch { return; }                                  // server down: keep the last picture
      if (!s.running) { this.blobs.clear(); this.round = null; this.syncBlobs(); return; }
      // A new round has settled: market time. Rounds too quick to fit the trip skip it.
      if (this.round !== null && s.round !== this.round && s.roundMs >= 3000) {
        const stay = Math.min(9000, Math.max(3000, s.roundMs * 0.45));
        this.marketUntil = performance.now() + stay;
        this.speed = Math.max(30, 200 / (stay / 1000 * 0.6));   // quick enough to get there and linger
      }
      if (s.roundMs < 3000) this.speed = 60;
      this.round = s.round;
      const n = this.blobs.size;
      for (const a of s.agents) {
        let b = this.blobs.get(a.id);
        if (!b) {
          const job = areaOf(a.activity) || MARKET, [x, z] = spot(a.id, job);
          this.blobs.set(a.id, b = { id: a.id, x, z, job, dest: job, path: [] });
        }
        b.job = areaOf(a.activity) || b.job;             // still deciding: last round's job stands
      }
      if (this.blobs.size !== n) this.syncBlobs();
    }

    bindInput() {
      const el = this.renderer.domElement;
      let dragging = false, px = 0, py = 0;
      const fade = () => { const hint = this.querySelector(".i3d-hint"); if (hint) hint.style.opacity = "0"; };
      el.addEventListener("pointerdown", (e) => { fade(); dragging = true; px = e.clientX; py = e.clientY; el.setPointerCapture(e.pointerId); });
      el.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const o = this.orbit;
        o.ttheta += (e.clientX - px) * 0.006;
        o.tphi = Math.min(1.42, Math.max(0.16, o.tphi + (e.clientY - py) * 0.005));
        px = e.clientX; py = e.clientY;
      });
      const stop = () => { dragging = false; };
      el.addEventListener("pointerup", stop);
      el.addEventListener("pointercancel", stop);
      el.addEventListener("wheel", (e) => {
        e.preventDefault();
        fade();
        const o = this.orbit;
        o.tr = Math.min(400, Math.max(48, o.tr * (1 + Math.sign(e.deltaY) * 0.09)));
      }, { passive: false });
    }

    resize() {
      if (!this.renderer) return;
      const w = this.clientWidth || 1, h = this.clientHeight || 1;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }

    // one point per blob; positions are written every frame in loop()
    syncBlobs() {
      if (!this.dotGeo) return;
      const THREE = this.THREE, n = this.blobs.size;
      this.dotGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      this.dotGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    }

    // walk every blob toward where it should be: the market while it is open, else its job
    walk(dt, now) {
      const pos = this.dotGeo.attributes.position, col = this.dotGeo.attributes.color;
      if (!pos || pos.count !== this.blobs.size) return;
      const atMarket = now < this.marketUntil, c = this._c || (this._c = new this.THREE.Color());
      this.areas.forEach(l => { l.count = 0; });
      let i = 0;
      for (const b of this.blobs.values()) {
        const dest = atMarket ? MARKET : b.job;
        if (dest !== b.dest) {
          b.dest = dest;
          b.path = route(b.x, b.z, ...spot(b.id, dest), (rand(b.id, 3) - 0.5) * 5, (rand(b.id, 4) - 0.5) * 5);
        }
        let left = this.speed * dt;
        while (b.path.length && left > 0) {
          const [tx, tz] = b.path[0], d = Math.hypot(tx - b.x, tz - b.z);
          if (d <= left) { b.x = tx; b.z = tz; left -= d; b.path.shift(); }
          else { b.x += (tx - b.x) / d * left; b.z += (tz - b.z) / d * left; left = 0; }
        }
        const working = !b.path.length && dest !== MARKET;
        const hop = working ? Math.abs(Math.sin(now * 0.006 + b.id)) * 1.2 : 0;
        pos.setXYZ(i, b.x, Math.max(0.8, height(b.x, b.z)) + 2.2 + hop, b.z);
        c.set(b.job.color);                              // coloured by job, so the market crowd shows who does what
        col.setXYZ(i, c.r, c.g, c.b);
        if (!b.path.length) this.areas.find(l => l.id === dest.id).count++;
        i++;
      }
      pos.needsUpdate = col.needsUpdate = true;
      this.areas.forEach(l => { if (l.pin.firstChild.textContent !== String(l.count)) l.pin.firstChild.textContent = l.count; });

      // dusk while the market is open
      this.dusk = (this.dusk || 0) + ((atMarket ? 1 : 0) - (this.dusk || 0)) * Math.min(1, dt * 1.5);
      this.sun.color.setRGB(1, 0.95 - 0.35 * this.dusk, 0.85 - 0.55 * this.dusk);
      this.sun.intensity = 1.7 - 0.5 * this.dusk;
      this.hemi.intensity = 1.25 - 0.55 * this.dusk;
    }

    loop() {
      this._raf = requestAnimationFrame(() => this.loop());
      this._frame = (this._frame || 0) + 1;
      if (this._frame === 3) { this.renderer.shadowMap.autoUpdate = false; this.renderer.shadowMap.needsUpdate = true; }
      const o = this.orbit;
      o.r += (o.tr - o.r) * 0.09;
      o.theta += (o.ttheta - o.theta) * 0.12;
      o.phi += (o.tphi - o.phi) * 0.12;
      const w0 = this.clientWidth || 1, h0 = this.clientHeight || 1;
      if (w0 !== this._w || h0 !== this._h) { this._w = w0; this._h = h0; this.resize(); }
      const cy = Math.cos(o.phi) * o.r;
      const cr = Math.sin(o.phi) * o.r;
      this.camera.position.set(Math.cos(o.theta) * cr, Math.max(14, cy), Math.sin(o.theta) * cr);
      this.camera.lookAt(0, 7, 0);
      this.camera.updateMatrixWorld(true);

      const now = performance.now();
      this.walk(Math.min(0.1, (now - (this._last || now)) / 1000), now);
      this._last = now;
      if (this.dotMat) this.dotMat.size = Math.max(8, 1300 / Math.max(60, o.r));

      // Area labels follow their spot on the island, hidden behind the camera, off-screen,
      // or behind the mountain along the view ray, and decluttered when two overlap.
      // Projection mixes terrain checks and DOM writes, so 20 Hz is plenty even while the
      // WebGL camera continues to animate at the display refresh rate.
      if (this._frame % 3 === 0) {
        const w = this.clientWidth, h = this.clientHeight;
        const v = this._pinVector || (this._pinVector = new this.THREE.Vector3());
        const cam = this.camera.position;
        const placedBoxes = [];
        const projected = this.areas.map(l => {
          v.set(l.x, l.y, l.z).project(this.camera);
          const sx = (v.x * 0.5 + 0.5) * w, sy = (-v.y * 0.5 + 0.5) * h;
          const dist = Math.hypot(cam.x - l.x, cam.y - l.y, cam.z - l.z);
          let hidden = v.z > 1 || sx < -20 || sx > w + 20 || sy < -10 || sy > h + 30;
          if (!hidden) {                                  // terrain occlusion along the view ray
            for (let t = 0.12; t < 0.94; t += 0.06) {
              const px = cam.x + (l.x - cam.x) * t;
              const py = cam.y + (l.y - cam.y) * t;
              const pz = cam.z + (l.z - cam.z) * t;
              if (height(px, pz) > py + 1.2) { hidden = true; break; }
            }
          }
          return { l, sx, sy, dist, hidden, scale: Math.min(1.6, Math.max(0.45, 135 / dist)) };
        }).sort((a, b) => a.dist - b.dist);

        projected.forEach(p => {
          let show = !p.hidden, labelled = true;
          if (show) {
            const hits = (bw, bh) => {
              const box = { x0: p.sx - bw / 2, x1: p.sx + bw / 2, y0: p.sy - bh, y1: p.sy + 6 };
              return { box, clash: placedBoxes.some(b => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0) };
            };
            const full = hits(72 * p.scale, 52 * p.scale);
            if (full.clash) {
              const badge = hits(30 * p.scale, 30 * p.scale);   // keep the marker, drop the label
              if (badge.clash) show = false; else { labelled = false; placedBoxes.push(badge.box); }
            } else placedBoxes.push(full.box);
          }
          const nameEl = p.l.pin.querySelector(".i3d-name");
          nameEl.style.display = labelled ? "" : "none";
          p.l.pin.style.opacity = show ? 1 : 0;
          p.l.pin.style.pointerEvents = show ? "auto" : "none";
          if (show) {
            p.l.pin.style.left = p.sx + "px";
            p.l.pin.style.top = p.sy + "px";
            p.l.pin.style.transform = `translate(-50%,-100%) scale(${p.scale.toFixed(3)})`;
            p.l.pin.style.zIndex = String(1000 - Math.round(p.dist));
          }
        });
      }

      if (this.waterUniforms) {
        this.waterUniforms.uTime.value = performance.now() * 0.001;
        this.waterUniforms.uCam.value.copy(this.camera.position);
      }
      this.renderer.render(this.scene, this.camera);
    }
  }

  if (!customElements.get("island-3d")) customElements.define("island-3d", Island3D);
})();
