// <island-3d>: an orbitable volcanic island, one blob per agent. Each round plays as a day:
// when a round settles everyone walks to the market (dusk), then back out to the area where
// their next shift happens. Blobs walk the coast road at a steady pace, on the ground.
// Drag to orbit, scroll to zoom, click a place to open it (dispatches "moku:location").
(function () {
  const SEA = 0;
  // Where each task happens. An agent that is deciding (no task yet this round) stays put.
  const AREAS = [
    { id: "docks",    name: "Docks: fishing",           color: "#1f9fb5", x: -70, z: 38,  tasks: ["gather_food"] },
    { id: "forest",   name: "Forest: chopping wood",    color: "#3f9450", x: 40,  z: -48, tasks: ["gather_wood"] },
    { id: "workshop", name: "Workshop: crafting",       color: "#d98c2b", x: 60,  z: 8,   tasks: ["craft_net"] },
    { id: "site",     name: "Building site: houses",    color: "#cf6046", x: -16, z: -50, tasks: ["build_house"] },
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

  // the raw landscape, with no road graded into it. ROAD is laid out on this field; height()
  // below is the same field with the road's corridor levelled, and is what everything draws on.
  function baseHeight(x, z) {
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
  // it -> area, so nobody climbs the mountain or swims. ROAD_HALF_W is the ribbon's half-width
  // (see the "sandy ribbon" mesh below). Every lane offset below is clamped inside it, so a
  // blob's path and its standing spot both always stay on the road, never spilling into the grass.
  const ROAD_HALF_W = 3.2;
  // 2.2m is the top of the beach: walking in from the sea the raw ground first clears it about
  // 7 units inland of the waterline, still on the flat backshore. The loop stops right there
  // and takes no further step inland, which is what used to carry it up the hillside.
  const ROAD_LEVEL = 2.2;
  const ROAD = Array.from({ length: 36 }, (_, i) => {
    const t = i / 36 * Math.PI * 2;
    let r = 120;
    while (r > 10 && baseHeight(Math.cos(t) * r, Math.sin(t) * r) < ROAD_LEVEL) r--;
    return [Math.cos(t) * r, Math.sin(t) * r];
  });
  // the level the ground is graded to under each waypoint, so the path is level across its
  // width instead of tilted. Averaged with its neighbours so the road does not step from one
  // waypoint to the next, and never below ROAD_LEVEL so a dip can never take it into the sea.
  const ROAD_RAW_Y = ROAD.map(([x, z]) => baseHeight(x, z));
  const ROAD_Y = ROAD_RAW_Y.map((y, i) => Math.max(ROAD_LEVEL,
    (ROAD_RAW_Y[(i + 35) % 36] + 2 * y + ROAD_RAW_Y[(i + 1) % 36]) / 4));
  const nearestRoad = (x, z) => ROAD.reduce((best, p, i) =>
    Math.hypot(p[0] - x, p[1] - z) < Math.hypot(ROAD[best][0] - x, ROAD[best][1] - z) ? i : best, 0);
  // the nearest point on the road as a polyline (not just the nearest waypoint, which
  // under-measures on the straight stretch between two of them): how far off the road (x,z)
  // lies, and the level the road has been graded to there.
  function roadNear(x, z) {
    let best = Infinity, y = 0;
    for (let i = 0; i < ROAD.length; i++) {
      const j = (i + 1) % ROAD.length, [ax, az] = ROAD[i], [bx, bz] = ROAD[j];
      const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz || 1;
      const t = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / len2));
      const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
      if (d < best) { best = d; y = ROAD_Y[i] + (ROAD_Y[j] - ROAD_Y[i]) * t; }
    }
    return { d: best, y };
  }
  // used to keep trees, grass and rocks from clipping through the ribbon
  const distToRoad = (x, z) => roadNear(x, z).d;
  const ROAD_R = ROAD.map(([x, z]) => Math.hypot(x, z));
  const ROAD_R_IN = Math.min(...ROAD_R) - ROAD_HALF_W * 2, ROAD_R_OUT = Math.max(...ROAD_R) + ROAD_HALF_W * 2;
  // the raw field with the road's corridor graded flat across its width, easing back out to
  // 1.5x the ribbon's half-width so the cut meets the hillside without a step. Never build
  // ROAD from this one, it reads ROAD; use baseHeight. The pads below sit on top of it.
  function roadHeight(x, z) {
    const b = baseHeight(x, z);
    // the corridor only ever lies in a ring around the island, so the mountain, the lagoon and
    // the sea skip the polyline scan: this runs three times per terrain vertex
    const r = Math.hypot(x, z);
    if (r < ROAD_R_IN || r > ROAD_R_OUT) return b;
    const { d, y } = roadNear(x, z);
    return b + (y - b) * (1 - sstep(ROAD_HALF_W, ROAD_HALF_W * 1.5, d));
  }
  // the road's direction and sideways normal at waypoint i, so a lane offset can be applied
  // perpendicular to the road no matter which way it is curving at that point
  function roadFrame(i) {
    const n = ROAD.length, p = ROAD[i], nxt = ROAD[(i + 1) % n], prv = ROAD[(i - 1 + n) % n];
    const dx = nxt[0] - prv[0], dz = nxt[1] - prv[1], len = Math.hypot(dx, dz) || 1;
    const tx = dx / len, tz = dz / len;
    return { x: p[0], z: p[1], tx, tz, nx: -tz, nz: tx };
  }
  // Each destination stands on a graded pad beside the road. The raw slope runs several
  // units across a building's footprint here, and the dry strip seaward of the road is only
  // two or three units wide, so there is nowhere flat to stand: the village is terraced in
  // instead. Sited against the road's normal from the road-graded field, then cut into the
  // field everything is drawn on, the same two-pass order the road itself uses.
  const PADS = [
    { x: 40, z: -48, w: 4.4, d: 4 },      // forest: woodcutter's cabin
    { x: 60, z: 8, w: 6, d: 5 },          // workshop
    { x: -16, z: -50, w: 6, d: 4.8 },     // building site
    { x: 18, z: 56, w: 5.4, d: 4.4 }      // market stall
  ].map(p => {
    const f = roadFrame(nearestRoad(p.x, p.z));
    const span = Math.hypot(p.w, p.d);
    // inland of the ribbon by half a footprint plus clearance, on whichever side the area
    // itself lies, so the building fronts the road instead of standing in it
    const side = Math.sign((p.x - f.x) * f.nx + (p.z - f.z) * f.nz) || 1;
    const off = ROAD_HALF_W + span / 2 + 0.6;
    const x = f.x + f.nx * off * side, z = f.z + f.nz * off * side;
    // level with the road it fronts, so there is no step from the path to the door
    const y = roadHeight(f.x, f.z);
    // the deeper the cut into the hillside, the further the ease-out runs: a fixed skirt
    // leaves a near vertical bank behind the taller sites and the village reads as a quarry
    const cut = Math.abs(y - roadHeight(x, z));
    const r = span / 2 + 0.8;
    // cutting and filling need very different reaches. A cut runs out far so the bank behind
    // the building is a slope and not a quarry wall; a fill is kept to a tight skirt, since
    // out past the road the ground is dropping to the water and a wide one would silt up the
    // shallows with new land.
    return { x, z, y, r, rCut: r + Math.max(6, cut * 2.6), rFill: r + 1.6 };
  });
  // the ground everything is drawn on: the road-graded field with the village pads cut in,
  // each easing out to meet the hillside without a rim
  function height(x, z) {
    let y = roadHeight(x, z);
    for (const p of PADS) {
      const d = Math.hypot(x - p.x, z - p.z);
      const reach = p.y < y ? p.rCut : p.rFill;
      if (d < reach) y += (p.y - y) * (1 - sstep(p.r, reach, d));
    }
    return y;
  }
  // the pad a destination stands on, or null where there is none: the docks builds its hut
  // out on the pier, and picking the merely nearest pad would fling its label across the bay
  const padFor = (cx, cz) => {
    let best = null, bd = 20;
    for (const p of PADS) {
      const d = Math.hypot(p.x - cx, p.z - cz);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  };

  // waypoints from (x0,z0) to (x1,z1); lane (a signed distance across the ribbon) keeps each
  // blob in its own strip of the road, offset sideways at every waypoint rather than in one
  // fixed world direction, so it tracks the road through curves instead of cutting corners.
  function route(x0, z0, x1, z1, lane) {
    const path = [];
    if (Math.hypot(x1 - x0, z1 - z0) > 40) {
      const a = nearestRoad(x0, z0), b = nearestRoad(x1, z1), n = ROAD.length;
      const step = (b - a + n) % n <= n / 2 ? 1 : n - 1;         // the shorter way round
      for (let i = a; ; i = (i + step) % n) {
        const f = roadFrame(i);
        path.push([f.x + f.nx * lane, f.z + f.nz * lane]);
        if (i === b) break;
      }
    }
    path.push([x1, z1]);
    return path;
  }
  const rand = (id, salt) => { const v = Math.sin((id + 1) * (12.9898 + salt * 17.31)) * 43758.5453; return v - Math.floor(v); };
  // a blob's own lane across the road, stable per agent, always inside the ribbon
  const laneFor = id => (rand(id, 3) * 2 - 1) * (ROAD_HALF_W - 0.6);
  // an agent's own standing spot for an area: the point on the road nearest that area, nudged
  // along the road (so a crowd queues rather than stacking) and across it into its own lane,
  // always on the road itself, never out on the grass around the area.
  function spot(id, area) {
    const f = roadFrame(nearestRoad(area.x, area.z));
    const along = (rand(id, 1) * 2 - 1) * 8;
    return [f.x + f.tx * along + f.nx * laneFor(id), f.z + f.tz * along + f.nz * laneFor(id)];
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
      // the pin rides over the building rather than over the area's nominal centre, which
      // can sit a dozen units inland of the pad the hut ended up on. Only the label moves:
      // spot() still routes blobs from AREAS, and the pad was cut at the road waypoint
      // nearest that same centre, so the crowd already gathers at the door.
      this.areas = AREAS.map(a => {
        const pad = padFor(a.x, a.z);
        return pad ? { ...a, x: pad.x, z: pad.z, y: pad.y + 7, count: 0 }
          : { ...a, y: height(a.x, a.z) + 3, count: 0 };
      });
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
      // per-pixel detail they cannot carry (sand grain, grass clumping and rock
      // strata), the same way the water surface is upscaled. No extra geometry.
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

      // ---- vegetation: instanced low-poly palms on gentle mid slopes ----
      // Built from primitives rather than loaded as a model: 120 palms ride in two
      // draw calls this way, each with its own tint, and there is no asset to fetch.
      const mergeGeos = geos => {
        const parts = geos.map(g => g.index ? g.toNonIndexed() : g);
        const total = parts.reduce((n, g) => n + g.attributes.position.count, 0);
        const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3);
        let o = 0;
        for (const g of parts) {
          pos.set(g.attributes.position.array, o * 3);
          nor.set(g.attributes.normal.array, o * 3);
          o += g.attributes.position.count;
        }
        const out = new THREE.BufferGeometry();
        out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        out.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
        return out;
      };
      const TRUNK_H = 4.6;
      // one frond: a long flattened cone, tipped outward and drooping at the end
      const frondGeo = () => {
        const g = new THREE.ConeGeometry(0.42, 3.5, 4, 5);
        g.scale(0.16, 1, 1);              // thin axis becomes the vertical one below
        g.rotateZ(-Math.PI / 2);          // lie along +x, base at the crown
        g.translate(1.75, 0, 0);
        const pos = g.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i), t = Math.max(0, x / 3.5);
          pos.setY(i, pos.getY(i) - t * t * 2.1);      // the droop grows toward the tip
          pos.setX(i, x * (1 - t * t * 0.18));
        }
        g.computeVertexNormals();
        return g;
      };
      const fronds = [];
      for (let f = 0; f < 9; f++) {
        const g = frondGeo();
        g.rotateZ((0.26 + (f % 3) * 0.12));           // some fronds ride higher than others
        g.rotateY(f / 9 * Math.PI * 2 + 0.35);
        fronds.push(g);
      }
      const treeGeo = mergeGeos(fronds);
      treeGeo.translate(0, TRUNK_H, 0);
      const PALMS = 300;
      const trees = new THREE.InstancedMesh(treeGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0, side: THREE.DoubleSide }), PALMS);
      trees.castShadow = true;
      trees.receiveShadow = true;
      // the trunk leans and thins as it climbs, the way a palm does
      const trunkGeo = new THREE.CylinderGeometry(0.14, 0.30, TRUNK_H, 6, 7);
      trunkGeo.translate(0, TRUNK_H / 2, 0);
      {
        const pos = trunkGeo.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          const t = pos.getY(i) / TRUNK_H;
          pos.setX(i, pos.getX(i) + t * t * 0.85);
        }
        trunkGeo.computeVertexNormals();
      }
      const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x6b4c33, roughness: 1, metalness: 0 }), PALMS);
      trunks.castShadow = true;
      trunks.receiveShadow = true;
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), tp = new THREE.Vector3();
      const tcol = new THREE.Color();
      let placed = 0;
      for (let i = 0; i < 60000 && placed < PALMS; i++) {
        const x = (hash2(i * 1.7, 3.1) - 0.5) * 210;
        const z = (hash2(i * 2.3, 9.7) - 0.5) * 210;
        const hgt = height(x, z);
        if (hgt < 2.2 || hgt > 21) continue;
        const sl = Math.abs(hgt - height(x + 1.5, z)) + Math.abs(hgt - height(x, z + 1.5));
        if (sl > 4.2) continue;
        if (hash2(i * 5.3, 1.9) > 0.055) continue;
        if (distToRoad(x, z) < ROAD_HALF_W + 4.5) continue; // clear of the road, fronds included
        const s = 0.78 + hash2(i * 0.9, 4.4) * 0.5;
        tp.set(x, hgt - 0.3, z);
        sc.set(s, s * (0.85 + hash2(i, 7) * 0.45), s);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), hash2(i, 2) * 6.28);
        m4.compose(tp, q, sc);
        trees.setMatrixAt(placed, m4);
        trunks.setMatrixAt(placed, m4);
        tcol.setHSL(0.255 + hash2(i, 11) * 0.045, 0.40 + hash2(i, 13) * 0.18, 0.26 + hash2(i, 17) * 0.11);
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
      this.dotMat = new THREE.PointsMaterial({ size: 5, map: sprite, vertexColors: true, transparent: true, alphaTest: 0.35, sizeAttenuation: true, depthWrite: false });
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

      // ---- one small low-poly building at each of the other destinations, same
      // box-walls-and-pyramid-roof style as the dock hut above ----
      {
        const strut = (a, b, thick, mat) => {
          const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], len = Math.hypot(dx, dy, dz);
          const m = new THREE.Mesh(new THREE.BoxGeometry(thick, len, thick), mat);
          m.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
          m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx, dy, dz).normalize());
          m.castShadow = true; m.receiveShadow = true;
          return m;
        };
        // the ground under a rotated footprint, corner to corner. A single centre sample
        // says nothing about what the far corners sit on, which is how a building ends up
        // with one wall buried and the opposite one hanging in the air.
        const groundUnder = (x, z, w, d, rot) => {
          const c = Math.cos(rot), sn = Math.sin(rot);
          let lo = Infinity, hi = -Infinity;
          for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
            const lx = a * w / 2, lz = b * d / 2;
            const y = height(x + lx * c + lz * sn, z - lx * sn + lz * c);
            if (y < lo) lo = y;
            if (y > hi) hi = y;
          }
          return { lo, hi };
        };
        // the graded pad for this destination. Standing on the high corner of what the
        // pad actually came out as, rather than on its nominal level, keeps the floor clear
        // of the ground even where the ease-out clips a corner of the footprint.
        const flatSpot = (cx, cz, w = 5, d = 4.6, rot = 0) => {
          const p = padFor(cx, cz) || { x: cx, z: cz };
          const g = groundUnder(p.x, p.z, w, d, rot);
          return [p.x, p.z, g.hi, g.hi - g.lo];
        };
        const cabin = (cx, cz, { w = 5, d = 4.6, h = 3.2, roofH = 2.1, wall = 0xe4d3ad, roof = 0x9a5f45, rot = 0 } = {}) => {
          const [x, z, gy, relief] = flatSpot(cx, cz, w, d, rot);
          const group = new THREE.Group();
          const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color: wall, roughness: 1 }));
          box.position.y = h / 2; box.castShadow = true; box.receiveShadow = true;
          const cone = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.62, roofH, 4), new THREE.MeshStandardMaterial({ color: roof, roughness: 1 }));
          cone.position.y = h + roofH / 2 - 0.1; cone.rotation.y = Math.PI / 4; cone.castShadow = true;
          // a stone footing carries the drop on the downhill side: the floor stays level
          // on the high corner and nothing is left hanging over the slope
          const foot = relief + 0.9;
          const plinth = new THREE.Mesh(new THREE.BoxGeometry(w * 1.08, foot, d * 1.08), new THREE.MeshStandardMaterial({ color: 0x9b9081, roughness: 1 }));
          plinth.position.y = -foot / 2 + 0.06;
          plinth.castShadow = true; plinth.receiveShadow = true;
          group.add(box, cone, plinth);
          group.position.set(x, gy, z);
          group.rotation.y = rot;
          scene.add(group);
          return { x, y: gy, z };
        };

        // forest: a woodcutter's cabin with a log pile stacked outside
        {
          const b = cabin(40, -48, { w: 4.4, d: 4, h: 2.9, roofH: 1.9, wall: 0x8a6a45, roof: 0x4a3a26, rot: 0.6 });
          const logMat = [new THREE.MeshStandardMaterial({ color: 0xb08a5e, roughness: 1 }), new THREE.MeshStandardMaterial({ color: 0x7d5c3c, roughness: 1 })];
          const logGeo = new THREE.CylinderGeometry(0.32, 0.32, 3, 7);
          [[0, 0], [1, 0], [2, 0], [0.5, 1], [1.5, 1], [1, 2]].forEach(([col, row], i) => {
            const log = new THREE.Mesh(logGeo, logMat[i % 2]);
            log.rotation.z = Math.PI / 2;
            log.position.set(b.x + 3.6 + col * 0.66, b.y + 0.32 + row * 0.58, b.z - 1.2);
            log.castShadow = true; log.receiveShadow = true;
            scene.add(log);
          });
        }

        // workshop: a bigger shed with a stone chimney and a workbench
        {
          const b = cabin(60, 8, { w: 6, d: 5, h: 3.6, roofH: 2.3, wall: 0xd9c9a0, roof: 0xb5652f, rot: -0.4 });
          const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.9, 3.4, 0.9), new THREE.MeshStandardMaterial({ color: 0x8f8378, roughness: 1 }));
          chimney.position.set(b.x - 2, b.y + 3.6, b.z + 1.6);
          chimney.castShadow = true;
          scene.add(chimney);
          const bench = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.9, 1.1), new THREE.MeshStandardMaterial({ color: 0x7d5c3c, roughness: 1 }));
          bench.position.set(b.x + 3.6, b.y + 0.45, b.z - 1);
          bench.castShadow = true; bench.receiveShadow = true;
          scene.add(bench);
        }

        // building site: just a frame going up, beams and a stack of spare boards, no walls yet
        {
          const frameRot = 0.3;
          const wx = 3, dz = 2.4, wallH = 3.2, ridgeH = 4.7;
          const [x, z, y] = flatSpot(-16, -50, wx * 2, dz * 2, frameRot);
          // each post reaches down to the ground it actually stands on, so a corner over
          // lower ground grows a longer leg instead of floating
          const fc = Math.cos(frameRot), fsn = Math.sin(frameRot);
          const footY = (lx, lz) => Math.min(0, height(x + lx * fc + lz * fsn, z - lx * fsn + lz * fc) - y) - 0.15;
          const corners = [[-wx, 0, -dz], [wx, 0, -dz], [wx, 0, dz], [-wx, 0, dz]]
            .map(([a, , b]) => [a, footY(a, b), b]);
          const tops = corners.map(([cx, , cz]) => [cx, wallH, cz]);
          const ridgeA = [0, ridgeH, -dz], ridgeB = [0, ridgeH, dz];
          const beam = new THREE.MeshStandardMaterial({ color: 0xc79a5e, roughness: 1 });
          const beamDark = new THREE.MeshStandardMaterial({ color: 0x8a6a45, roughness: 1 });
          const frame = new THREE.Group();
          corners.forEach((c, i) => frame.add(strut(c, tops[i], 0.34, i % 2 ? beamDark : beam)));
          tops.forEach((t, i) => frame.add(strut(t, tops[(i + 1) % 4], 0.3, beam)));
          frame.add(strut(ridgeA, ridgeB, 0.32, beamDark));
          frame.add(strut(tops[0], ridgeA, 0.28, beam));
          frame.add(strut(tops[1], ridgeA, 0.28, beam));
          frame.add(strut(tops[2], ridgeB, 0.28, beam));
          frame.add(strut(tops[3], ridgeB, 0.28, beam));
          frame.position.set(x, y, z);
          frame.rotation.y = frameRot;
          scene.add(frame);
          const boardGeo = new THREE.BoxGeometry(3.2, 0.24, 0.7);
          const boardMat = new THREE.MeshStandardMaterial({ color: 0xd9b26a, roughness: 1 });
          for (let i = 0; i < 4; i++) {
            const board = new THREE.Mesh(boardGeo, boardMat);
            board.position.set(x + 4.4, y + 0.14 + i * 0.26, z + 1.4);
            board.rotation.y = 0.15;
            board.castShadow = true; board.receiveShadow = true;
            scene.add(board);
          }
        }

        // market: an open-sided stall, posts and a canopy, no walls, a table underneath
        {
          const w = 5.4, d = 4.4, postH = 2.6, stallRot = -0.5;
          const [x, z, y] = flatSpot(18, 56, w, d, stallRot);
          const postMat = new THREE.MeshStandardMaterial({ color: 0x8a6a45, roughness: 1 });
          const stall = new THREE.Group();
          // same trick as the frame: the canopy stays level while the legs take up the slope
          const sc2 = Math.cos(stallRot), ssn = Math.sin(stallRot);
          const postFoot = (lx, lz) => Math.min(0, height(x + lx * sc2 + lz * ssn, z - lx * ssn + lz * sc2) - y) - 0.1;
          [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].forEach(([px, pz]) => {
            const base = postFoot(px, pz), len = postH - base;
            const post = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, len, 7), postMat);
            post.position.set(px, base + len / 2, pz);
            post.castShadow = true;
            stall.add(post);
          });
          const canopy = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.72, 1.6, 4), new THREE.MeshStandardMaterial({ color: 0xcf6a4a, roughness: 1 }));
          canopy.position.y = postH + 0.7;
          canopy.rotation.y = Math.PI / 4;
          canopy.castShadow = true;
          stall.add(canopy);
          const table = new THREE.Mesh(new THREE.BoxGeometry(w * 0.7, 0.9, d * 0.6), new THREE.MeshStandardMaterial({ color: 0xe6d6a4, roughness: 1 }));
          table.position.y = 0.45;
          table.castShadow = true; table.receiveShadow = true;
          stall.add(table);
          stall.position.set(x, y, z);
          stall.rotation.y = stallRot;
          scene.add(stall);
        }
      }

      this._frame = 0;
      this.bindInput();
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(this);
      this.resize();
      this.loop();
      // the road: a sandy ribbon laid on the ground along the waypoints. Each slice samples
      // several points across the width, not just the two edges. On a slope the terrain
      // between two edge samples can bulge up above the straight line joining them, which is
      // what pokes the mountain through a wide, coarsely-sliced ribbon.
      {
        const pts = [];
        ROAD.forEach(([x, z], i) => {
          const [nx, nz] = ROAD[(i + 1) % ROAD.length], steps = Math.ceil(Math.hypot(nx - x, nz - z) / 2.4);
          for (let k = 0; k < steps; k++) pts.push([x + (nx - x) * k / steps, z + (nz - z) * k / steps]);
        });
        // SPAN is wider than following the ground needs: the spare vertices are what carry the
        // worn-pale centre and gritty shoulders, which two edge samples per slice cannot hold.
        const n = pts.length, SPAN = 9;      // cross-section samples per slice, edge to edge
        // the worn strip wanders instead of running dead centre, and stones gather in stretches
        // rather than evenly. Both are read off the compass bearing so they close at the seam.
        const alongNoise = (x, z, f, sx, sy) => {
          const a = Math.atan2(z, x);
          return vnoise(Math.cos(a) * f + sx, Math.sin(a) * f + sy);
        };
        const verts = [], index = [], rcol = [];
        const worn = new THREE.Color(0xefe2bd), grit = new THREE.Color(0xa1957c), pale = new THREE.Color(0xc2bdb1);
        const rc = new THREE.Color();
        const frames = pts.map(([x, z], i) => {
          const [ax, az] = pts[(i + n - 1) % n], [bx, bz] = pts[(i + 1) % n];
          const len = Math.hypot(bx - ax, bz - az) || 1;
          return {
            x, z, px: -(bz - az) / len, pz: (bx - ax) / len,
            wander: (alongNoise(x, z, 3.1, 5, 2) * 2 - 1) * 0.45,
            clump: alongNoise(x, z, 8.4, 13, 7),
          };
        });
        const rings = frames.map(f => {
          const ring = [];
          for (let s = 0; s < SPAN; s++) {
            const across = s / (SPAN - 1) * 2 - 1;
            const vx = f.x + f.px * across * ROAD_HALF_W, vz = f.z + f.pz * across * ROAD_HALF_W;
            ring.push([vx, height(vx, vz) + 0.4, vz]);
            const g = fbm(vx * 0.55 + 3, vz * 0.55 + 8, 3);
            const wear = smooth(1 - Math.min(1, Math.abs(across - f.wander) / 0.95));
            rc.copy(grit).lerp(worn, Math.min(1, wear * (0.55 + g * 0.5)));
            rc.lerp(pale, Math.max(0, g - 0.52) * 1.25);                   // bare stone showing through
            rc.multiplyScalar(Math.min(1.12, 0.9 + fbm(vx * 1.7 + 21, vz * 1.7 + 13, 2) * 0.24));
            rcol.push(rc.r, rc.g, rc.b);
          }
          return ring;
        });
        rings.forEach(ring => ring.forEach(([vx, vy, vz]) => verts.push(vx, vy, vz)));
        for (let i = 0; i < n; i++) {
          const ni = (i + 1) % n;
          for (let s = 0; s < SPAN - 1; s++) {
            const a = i * SPAN + s, b = a + 1, c = ni * SPAN + s, d = c + 1;
            index.push(a, b, c, b, d, c);
          }
        }
        const roadGeo = new THREE.BufferGeometry();
        roadGeo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
        roadGeo.setAttribute("color", new THREE.Float32BufferAttribute(rcol, 3));
        roadGeo.setIndex(index);
        roadGeo.computeVertexNormals();
        // The vertex tones above set the broad wear pattern; this adds what they are far too
        // coarse to hold, grit at sand scale and a pebble-sized mottle, the same upscaling
        // trick the land uses. Nothing to fetch and no extra triangles.
        const roadMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide });
        roadMat.onBeforeCompile = (sh) => {
          sh.vertexShader = sh.vertexShader
            .replace("#include <common>", "#include <common>\nvarying vec3 vRPos;")
            .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\n  vRPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
          sh.fragmentShader = sh.fragmentShader
            .replace("#include <common>", `#include <common>
              varying vec3 vRPos;
              float rRough = 1.0;
              float rh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
              float rvn(vec2 p){
                vec2 i = floor(p), f = fract(p);
                vec2 u = f * f * (3.0 - 2.0 * f);
                return mix(mix(rh(i), rh(i + vec2(1,0)), u.x), mix(rh(i + vec2(0,1)), rh(i + vec2(1,1)), u.x), u.y);
              }
              float rfb(vec2 p, int oct){
                float s = 0.0, a = 0.5;
                for (int i = 0; i < 5; i++) { if (i >= oct) break; s += a * rvn(p); p *= 2.07; a *= 0.5; }
                return s;
              }
              // cell noise sized to a pebble: the fill breaks into stones with dark gaps
              // between them instead of dithering into uniform speckle
              float rcell(vec2 p){
                vec2 ip = floor(p), fp = fract(p);
                float d = 1.0;
                for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
                  vec2 g = vec2(float(x), float(y));
                  vec2 o = vec2(rh(ip + g), rh(ip + g + 7.3));
                  d = min(d, length(g + o - fp));
                }
                return d;
              }`)
            .replace("#include <color_fragment>", `#include <color_fragment>
              {
                vec2 wp = vRPos.xz;
                float grit = rfb(wp * 11.0, 3);
                float top = 1.0 - smoothstep(0.04, 0.30, rcell(wp * 2.6));     // a pebble's crown
                float bed = 1.0 - rcell(wp * 0.8);                             // drifts of loose stone
                float stony = clamp(0.25 + bed * 1.1, 0.0, 1.0);               // bare stretches between them
                top *= stony;
                diffuseColor.rgb += vec3(0.055, 0.05, 0.038) * (grit - 0.5) * 2.0;
                diffuseColor.rgb *= 0.88 + top * 0.2;
                diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.72, 0.71, 0.67), top * 0.36);
                diffuseColor.rgb = clamp(diffuseColor.rgb, 0.0, 1.0);
                // trodden stone takes a sheen, the loose grit around it does not
                rRough = clamp(1.0 - top * 0.36 - (grit - 0.5) * 0.16, 0.45, 1.0);
              }`)
            .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n  roughnessFactor = rRough;");
        };
        const road = new THREE.Mesh(roadGeo, roadMat);
        road.receiveShadow = true;
        scene.add(road);

        // real stones set into the path, so it reads as a footpath and not a painted strip.
        // Clustered along the same worn centre line the vertex colours follow, with a few
        // strays out to the shoulders, and sunk in rather than dropped on top. One draw call,
        // and small enough that a blob reads as walking over them, not round them.
        const pebGeo = new THREE.IcosahedronGeometry(0.5, 0);
        const MAX_PEB = 420;
        const pebbles = new THREE.InstancedMesh(pebGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.66, flatShading: true }), MAX_PEB);
        const pcol = new THREE.Color(), eu = new THREE.Euler();
        let pebPlaced = 0;
        for (let i = 0; i < 2600 && pebPlaced < MAX_PEB; i++) {
          const f = frames[Math.floor(hash2(i * 0.731, 12.4) * n) % n];
          if (hash2(i * 1.37, 5.9) > 0.012 + f.clump * f.clump * 0.44) continue;   // stony stretches, bare stretches
          const r = hash2(i * 2.17, 31.3) * 2 - 1;
          // cubed and measured off the wandering centre rather than the ribbon's, so the trail
          // winds with the worn strip and only the odd stray reaches a shoulder
          const across = f.wander + r * r * r * (0.93 - Math.abs(f.wander));
          const x = f.x + f.px * across * ROAD_HALF_W, z = f.z + f.pz * across * ROAD_HALF_W;
          const top = height(x, z) + 0.4;
          if (top < SEA + 0.6) continue;                  // never a stone standing in the water
          const s = 0.2 + hash2(i * 3.91, 8.2) * 0.34;
          const ys = 0.5 + hash2(i * 4.53, 19.7) * 0.32;  // squashed: worn flat, not tumbled
          tp.set(x, top - 0.2 * s * ys, z);
          sc.set(s * (0.85 + hash2(i, 51) * 0.4), s * ys, s * (0.85 + hash2(i, 53) * 0.4));
          eu.set(hash2(i, 55) * 6.28, hash2(i, 57) * 6.28, hash2(i, 59) * 6.28);
          q.setFromEuler(eu);
          m4.compose(tp, q, sc);
          pebbles.setMatrixAt(pebPlaced, m4);
          pcol.setHSL(0.09 + hash2(i, 63) * 0.05, 0.04 + hash2(i, 65) * 0.07, 0.44 + hash2(i, 61) * 0.26);
          pebbles.setColorAt(pebPlaced, pcol);
          pebPlaced++;
        }
        pebbles.count = pebPlaced;
        pebbles.instanceMatrix.needsUpdate = true;
        if (pebbles.instanceColor) pebbles.instanceColor.needsUpdate = true;
        pebbles.receiveShadow = true;
        scene.add(pebbles);
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
          b.path = route(b.x, b.z, ...spot(b.id, dest), laneFor(b.id));
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
      if (this.dotMat) this.dotMat.size = Math.max(4.5, 750 / Math.max(60, o.r));

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
