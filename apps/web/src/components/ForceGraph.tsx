'use client';

import { useEffect, useRef } from 'react';
import type { WorldState } from '@aw/types';
import type { ViewConfig } from '../derive/viewConfig.ts';
import { withAlpha } from '../derive/palette.ts';

interface Node {
  id: string;
  type: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  color: string;
}

interface Edge {
  a: Node;
  b: Node;
  color: string;
}

interface Props {
  state: WorldState;
  config: ViewConfig;
  selected: string | null;
  highlight: string | null;
  onSelect: (id: string | null) => void;
}

const REPEL = 780;
const SPRING = 0.014;
const SPRING_LEN = 46;
const CLUSTER = 0.018;
const DAMP = 0.86;
const CELL = 58;
const MAX_EDGES = 1600;

export function ForceGraph({ state, config, selected, highlight, onSelect }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const nodesRef = useRef(new Map<string, Node>());
  const edgesRef = useRef<Edge[]>([]);
  const sizeRef = useRef({ w: 800, h: 520 });
  const alphaRef = useRef(1);
  const hoverRef = useRef<string | null>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const selectedRef = useRef<string | null>(selected);
  const highlightRef = useRef<string | null>(highlight);
  const configRef = useRef(config);
  const anchorsRef = useRef(new Map<string, { x: number; y: number }>());
  const viewRef = useRef({ k: 1, tx: 0, ty: 0 });

  /** One anchor per entity type, spread on an ellipse that fills the panel. */
  const layoutAnchors = (): Map<string, { x: number; y: number }> => {
    const { w, h } = sizeRef.current;
    const types = configRef.current.entityTypes;
    const anchors = new Map<string, { x: number; y: number }>();
    const cx = w / 2;
    const cy = h / 2;
    const rx = types.length > 1 ? w * 0.3 : 0;
    const ry = types.length > 1 ? h * 0.32 : 0;
    types.forEach((type, index) => {
      const angle = (index / Math.max(1, types.length)) * Math.PI * 2 - Math.PI / 2;
      anchors.set(type.id, { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry });
    });
    anchorsRef.current = anchors;
    return anchors;
  };

  selectedRef.current = selected;
  highlightRef.current = highlight;
  configRef.current = config;

  // Keep the node set, radii and edges in step with incoming state.
  useEffect(() => {
    const nodes = nodesRef.current;
    const anchors = layoutAnchors();
    const { w, h } = sizeRef.current;

    const entities = Object.values(state.entities);
    let ceiling = 1;
    for (const entity of entities) {
      const held = entity.resources[config.currency] ?? 0;
      if (held > ceiling) ceiling = held;
    }

    const before = nodes.size;
    const live = new Set<string>();
    for (const entity of entities) {
      live.add(entity.id);
      const anchor = anchors.get(entity.type) ?? { x: w / 2, y: h / 2 };
      const held = entity.resources[config.currency] ?? 0;
      const r = 2.4 + 9 * Math.sqrt(Math.max(0, held) / ceiling);
      let node = nodes.get(entity.id);
      if (!node) {
        node = {
          id: entity.id,
          type: entity.type,
          x: anchor.x + (Math.random() - 0.5) * 70,
          y: anchor.y + (Math.random() - 0.5) * 70,
          vx: 0,
          vy: 0,
          r,
          color: config.entityTypeById[entity.type]?.color ?? '#8A98A8',
        };
        nodes.set(entity.id, node);
      }
      node.r = r;
      node.type = entity.type;
      node.color = config.entityTypeById[entity.type]?.color ?? '#8A98A8';
    }
    for (const id of Array.from(nodes.keys())) if (!live.has(id)) nodes.delete(id);

    const edges: Edge[] = [];
    const relationColor = new Map(config.relations.map((r) => [r.kind, r.color]));
    for (const entity of entities) {
      const a = nodes.get(entity.id);
      if (!a) continue;
      for (const [kind, ids] of Object.entries(entity.relationships)) {
        const color = relationColor.get(kind) ?? '#4A5A68';
        for (const id of ids) {
          const b = nodes.get(id);
          if (b) edges.push({ a, b, color });
          if (edges.length >= MAX_EDGES) break;
        }
      }
      if (entity.ownedBy) {
        const b = nodes.get(entity.ownedBy);
        if (b) edges.push({ a, b, color: '#55707F' });
      }
      if (edges.length >= MAX_EDGES) break;
    }
    edgesRef.current = edges;

    if (before !== nodes.size) alphaRef.current = Math.max(alphaRef.current, 0.7);
  }, [state, config]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    let frame = 0;
    let disposed = false;

    const resize = (): void => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w === 0 || h === 0) return;
      sizeRef.current = { w, h };
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      alphaRef.current = Math.max(alphaRef.current, 0.5);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    const simulate = (): void => {
      const nodes = Array.from(nodesRef.current.values());
      const alpha = alphaRef.current;
      if (nodes.length === 0) return;
      const { w, h } = sizeRef.current;
      const anchors = layoutAnchors();

      const buckets = new Map<number, Node[]>();
      const columns = Math.ceil(w / CELL) + 2;
      for (const node of nodes) {
        const key = Math.floor(node.y / CELL) * columns + Math.floor(node.x / CELL);
        const bucket = buckets.get(key);
        if (bucket) bucket.push(node);
        else buckets.set(key, [node]);
      }

      for (const node of nodes) {
        const col = Math.floor(node.x / CELL);
        const row = Math.floor(node.y / CELL);
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const bucket = buckets.get((row + dy) * columns + (col + dx));
            if (!bucket) continue;
            for (const other of bucket) {
              if (other === node) continue;
              let ox = node.x - other.x;
              let oy = node.y - other.y;
              let d2 = ox * ox + oy * oy;
              if (d2 > CELL * CELL * 2.25) continue;
              if (d2 < 0.01) {
                ox = (Math.random() - 0.5) * 0.6;
                oy = (Math.random() - 0.5) * 0.6;
                d2 = 0.36;
              }
              const force = (REPEL * alpha) / d2;
              node.vx += ox * force * 0.02;
              node.vy += oy * force * 0.02;
            }
          }
        }
        const anchor = anchors.get(node.type);
        if (anchor) {
          node.vx += (anchor.x - node.x) * CLUSTER * alpha;
          node.vy += (anchor.y - node.y) * CLUSTER * alpha;
        }
      }

      for (const edge of edgesRef.current) {
        const dx = edge.b.x - edge.a.x;
        const dy = edge.b.y - edge.a.y;
        const distance = Math.sqrt(dx * dx + dy * dy) || 1;
        const pull = ((distance - SPRING_LEN) / distance) * SPRING * alpha;
        edge.a.vx += dx * pull;
        edge.a.vy += dy * pull;
        edge.b.vx -= dx * pull;
        edge.b.vy -= dy * pull;
      }

      const margin = 14;
      for (const node of nodes) {
        node.vx *= DAMP;
        node.vy *= DAMP;
        node.x += Math.max(-8, Math.min(8, node.vx));
        node.y += Math.max(-8, Math.min(8, node.vy));
        if (node.x < margin) { node.x = margin; node.vx *= -0.4; }
        if (node.x > w - margin) { node.x = w - margin; node.vx *= -0.4; }
        if (node.y < margin) { node.y = margin; node.vy *= -0.4; }
        if (node.y > h - margin) { node.y = h - margin; node.vy *= -0.4; }
      }

      alphaRef.current = Math.max(0.06, alpha * 0.994);
    };

    const draw = (): void => {
      const { w, h } = sizeRef.current;
      const cfg = configRef.current;
      context.clearRect(0, 0, w, h);

      // Fit whatever the simulation settled on into the panel, so the layout
      // fills the space at any population and never drifts into a corner.
      let lo = { x: Infinity, y: Infinity };
      let hi = { x: -Infinity, y: -Infinity };
      for (const node of nodesRef.current.values()) {
        if (node.x - node.r < lo.x) lo = { ...lo, x: node.x - node.r };
        if (node.y - node.r < lo.y) lo = { ...lo, y: node.y - node.r };
        if (node.x + node.r > hi.x) hi = { ...hi, x: node.x + node.r };
        if (node.y + node.r > hi.y) hi = { ...hi, y: node.y + node.r };
      }
      const margin = 26;
      const spanX = Math.max(1, hi.x - lo.x);
      const spanY = Math.max(1, hi.y - lo.y);
      const target = Number.isFinite(spanX) && Number.isFinite(spanY)
        ? Math.min((w - margin * 2) / spanX, (h - margin * 2) / spanY)
        : 1;
      const k = Math.max(0.5, Math.min(2.2, Number.isFinite(target) ? target : 1));
      const previous = viewRef.current;
      const cold = previous.tx === 0 && previous.ty === 0;
      const eased = cold ? k : previous.k + (k - previous.k) * 0.08;
      const tx = w / 2 - ((lo.x + hi.x) / 2) * eased;
      const ty = h / 2 - ((lo.y + hi.y) / 2) * eased;
      const blend = cold ? 1 : 0.12;
      const view = {
        k: eased,
        tx: Number.isFinite(tx) ? previous.tx + (tx - previous.tx) * blend : previous.tx,
        ty: Number.isFinite(ty) ? previous.ty + (ty - previous.ty) * blend : previous.ty,
      };
      viewRef.current = view;
      const toScreen = (x: number, y: number) => ({ x: x * view.k + view.tx, y: y * view.k + view.ty });

      context.strokeStyle = 'rgba(148, 163, 178, 0.045)';
      context.lineWidth = 1;
      context.beginPath();
      for (let x = 0; x <= w; x += 64) { context.moveTo(x + 0.5, 0); context.lineTo(x + 0.5, h); }
      for (let y = 0; y <= h; y += 64) { context.moveTo(0, y + 0.5); context.lineTo(w, y + 0.5); }
      context.stroke();

      const focus = highlightRef.current;
      const chosen = selectedRef.current;
      const hovered = hoverRef.current;

      context.save();
      context.translate(view.tx, view.ty);
      context.scale(view.k, view.k);

      context.lineWidth = 0.7 / view.k;
      for (const edge of edgesRef.current) {
        const muted = focus !== null && edge.a.type !== focus && edge.b.type !== focus;
        context.strokeStyle = withAlpha(edge.color, muted ? 0.05 : 0.22);
        context.beginPath();
        context.moveTo(edge.a.x, edge.a.y);
        context.lineTo(edge.b.x, edge.b.y);
        context.stroke();
      }

      const centroids = new Map<string, { x: number; y: number; n: number }>();
      for (const node of nodesRef.current.values()) {
        const centroid = centroids.get(node.type) ?? { x: 0, y: 0, n: 0 };
        centroid.x += node.x;
        centroid.y += node.y;
        centroid.n += 1;
        centroids.set(node.type, centroid);
        const muted = focus !== null && node.type !== focus;
        context.beginPath();
        context.arc(node.x, node.y, node.r, 0, Math.PI * 2);
        context.fillStyle = muted ? withAlpha(node.color, 0.12) : node.color;
        context.fill();
        if (!muted) {
          context.strokeStyle = 'rgba(7, 10, 14, 0.85)';
          context.lineWidth = 1 / view.k;
          context.stroke();
        }
      }

      context.restore();

      if (chosen) {
        const node = nodesRef.current.get(chosen);
        if (node) {
          const at = toScreen(node.x, node.y);
          context.strokeStyle = 'rgba(232, 179, 60, 0.28)';
          context.lineWidth = 1;
          context.beginPath();
          context.moveTo(0, at.y + 0.5);
          context.lineTo(w, at.y + 0.5);
          context.moveTo(at.x + 0.5, 0);
          context.lineTo(at.x + 0.5, h);
          context.stroke();
          context.strokeStyle = '#E8B33C';
          context.lineWidth = 1.4;
          context.beginPath();
          context.arc(at.x, at.y, node.r * view.k + 4.5, 0, Math.PI * 2);
          context.stroke();
        }
      }

      context.font = '500 10px "Spline Sans Mono", ui-monospace, monospace';
      context.textBaseline = 'middle';
      for (const type of cfg.entityTypes) {
        const centroid = centroids.get(type.id);
        if (!centroid || centroid.n === 0) continue;
        context.fillStyle = focus !== null && focus !== type.id ? 'rgba(99, 113, 127, 0.3)' : withAlpha(type.color, 0.7);
        context.textAlign = 'center';
        const label = `${type.label.toLowerCase()} ${centroid.n}`;
        const at = toScreen(centroid.x / centroid.n, centroid.y / centroid.n);
        const lx = at.x;
        const ly = at.y;
        context.strokeStyle = 'rgba(7, 10, 14, 0.92)';
        context.lineWidth = 3.5;
        context.lineJoin = 'round';
        context.strokeText(label, lx, ly);
        context.fillText(label, lx, ly);
      }

      const labelId = hovered ?? chosen;
      if (labelId) {
        const node = nodesRef.current.get(labelId);
        if (node) {
          const at = toScreen(node.x, node.y);
          context.textAlign = 'left';
          context.strokeStyle = 'rgba(7, 10, 14, 0.92)';
          context.lineWidth = 3.5;
          context.strokeText(node.id, at.x + node.r * view.k + 6, at.y);
          context.fillStyle = '#DEE6EE';
          context.fillText(node.id, at.x + node.r * view.k + 6, at.y);
        }
      }
    };

    const loop = (): void => {
      if (disposed) return;
      simulate();
      const pointer = pointerRef.current;
      if (pointer) {
        const view = viewRef.current;
        const wx = (pointer.x - view.tx) / (view.k || 1);
        const wy = (pointer.y - view.ty) / (view.k || 1);
        let best: string | null = null;
        let bestDistance = 144 / ((view.k || 1) * (view.k || 1));
        for (const node of nodesRef.current.values()) {
          const dx = node.x - wx;
          const dy = node.y - wy;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestDistance) { bestDistance = d2; best = node.id; }
        }
        hoverRef.current = best;
        canvas.style.cursor = best ? 'pointer' : 'default';
      }
      draw();
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  const toLocal = (event: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  return (
    <div className="canvas-host" ref={hostRef}>
      <canvas
        ref={canvasRef}
        onMouseMove={(event) => { pointerRef.current = toLocal(event); }}
        onMouseLeave={() => { pointerRef.current = null; hoverRef.current = null; }}
        onClick={() => onSelect(hoverRef.current)}
      />
    </div>
  );
}
