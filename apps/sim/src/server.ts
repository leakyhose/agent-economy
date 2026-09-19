// Streams the running world to the dashboard and accepts control commands.
// The message contract here is the one apps/web codes against.
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { WorldDefinition } from '@aw/types';

export interface TickResult {
  state: unknown;
  events: unknown[];
  metrics: Record<string, number>;
  settlements: unknown[];
}

export function startServer(port: number, ctx: { engine: any; world: WorldDefinition; agents: Map<string, any> }) {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  const clients = new Set<WebSocket>();

  const api = {
    running: true,
    tickMs: ctx.world.time?.tickMs ?? 400,
    broadcast(result: TickResult) {
      if (!clients.size) return;
      send({ type: 'tick', tick: ctx.engine.state.tick, ...result });
    },
  };

  function send(msg: unknown) {
    const s = JSON.stringify(msg);
    for (const c of clients) if (c.readyState === 1) c.send(s);
  }

  wss.on('connection', ws => {
    clients.add(ws);
    // A new dashboard needs the world definition before it can render anything.
    ws.send(JSON.stringify({ type: 'world', world: ctx.world }));
    ws.send(JSON.stringify({ type: 'state', state: ctx.engine.state }));

    ws.on('message', buf => {
      let msg: any;
      try { msg = JSON.parse(String(buf)); } catch { return; }
      switch (msg.cmd) {
        case 'pause':  api.running = false; break;
        case 'resume': api.running = true;  break;
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
