// Streams the running world to the dashboard and accepts control commands.
// This message contract is what apps/web codes against.
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Engine, TickResult as EngineTick } from '@aw/engine';
import type { WorldDefinition, WorldState } from '@aw/types';

export interface Broadcast extends EngineTick {
  state: WorldState;
  metrics: Record<string, number>;
}

export function startServer(port: number, ctx: { engine: Engine; world: WorldDefinition }) {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  const clients = new Set<WebSocket>();

  const api = {
    running: true,
    tickMs: ctx.world.time?.tickMs ?? 400,
    broadcast(result: Broadcast) {
      if (clients.size === 0) return;
      send({ type: 'tick', tick: result.tick, state: result.state,
             events: result.events, metrics: result.metrics });
    },
  };

  function send(msg: unknown) {
    const payload = JSON.stringify(msg);
    for (const c of clients) if (c.readyState === 1) c.send(payload);
  }

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws);
    // A fresh dashboard needs the world definition before it can render anything.
    ws.send(JSON.stringify({ type: 'world', world: ctx.world }));
    ws.send(JSON.stringify({ type: 'state', state: ctx.engine.state }));

    ws.on('message', (buf: Buffer) => {
      let msg: { cmd?: string; n?: number; tickMs?: number };
      try { msg = JSON.parse(String(buf)); } catch { return; }
      switch (msg.cmd) {
        case 'pause':  api.running = false; ctx.engine.pause(); break;
        case 'resume': api.running = true;  ctx.engine.resume(); break;
        case 'step':   api.running = false; ctx.engine.step(msg.n ?? 1); break;
        case 'speed':  api.tickMs = Math.max(16, Number(msg.tickMs) || 400); break;
      }
      send({ type: 'control', running: api.running, tickMs: api.tickMs });
    });

    ws.on('close', () => clients.delete(ws));
  });

  http.listen(port);
  return api;
}
