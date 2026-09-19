// The control server. Comes up idle and does exactly what the dashboard tells
// it, speaking the wire contract defined in apps/web/src/data/contract.ts.
//
// Inbound:  { type:'load', world } | { type:'control', command } | { type:'speed', multiplier }
// Outbound: world | state | events | metrics | chain
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { Simulation, availableWorlds, type Frame } from './runtime.ts';
import { CFG } from './config.ts';

type ClientCommand =
  | { type: 'control'; command: 'start' | 'pause' | 'step' | 'reset' }
  | { type: 'speed'; multiplier: number }
  | { type: 'load'; world: string; agents?: number; model?: string; brain?: string };

export function startServer(port: number) {
  const http = createServer((req, res) => {
    // A tiny REST surface so the page can discover worlds before opening a socket.
    if (req.url === '/worlds') {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ worlds: availableWorlds(), loaded: sim.worldName }));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server: http });
  const clients = new Set<WebSocket>();

  const broadcast = (msg: unknown) => {
    const payload = JSON.stringify(msg);
    for (const c of clients) if (c.readyState === 1) c.send(payload);
  };

  const onFrame = (frame: Frame) => {
    broadcast({ type: 'world', world: frame.world });
    broadcast({ type: 'state', state: frame.state });
    if (frame.events.length > 0) broadcast({ type: 'events', events: frame.events });
    broadcast({ type: 'metrics', metrics: frame.metrics });
  };

  const sim = new Simulation(onFrame);
  // Building a population means a real keypair and token accounts per agent, so
  // a large world takes visible seconds. Say so, or the page looks frozen.
  let loading = false;
  // Confirmation events are minted here, so they need their own sequence space.
  let confirmSeq = 1_000_000;

  const status = () => ({
    type: 'status',
    running: sim.running,
    world: sim.worldName,
    worlds: availableWorlds(),
    tick: sim.engine?.state.tick ?? 0,
    loading,
    agents: sim.agentCount,
    agentLimits: sim.agentLimits,
    agentNote: sim.agentNote,
    speed: sim.speed,
    chain: CFG.CHAIN ? CFG.RPC : null,
    model: sim.model,
    brain: sim.brain,
    catalogue: sim.catalogue,
    // A model can only be chosen if the server actually has a key for it.
    hasKey: Boolean(process.env['OPENAI_API_KEY']),
    usage: sim.usage,
  });

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws);
    ws.send(JSON.stringify(status()));
    // A dashboard that connects mid-run needs the whole picture, not the next delta.
    if (sim.world && sim.engine) {
      ws.send(JSON.stringify({ type: 'world', world: sim.world }));
      ws.send(JSON.stringify({ type: 'state', state: sim.engine.state }));
    }

    ws.on('message', async (buf: Buffer) => {
      let msg: ClientCommand;
      try { msg = JSON.parse(String(buf)) as ClientCommand; } catch { return; }
      try {
        if (msg.type === 'load') {
          loading = true;
          broadcast(status());
          try {
            await sim.load(msg.world, msg.agents ?? null, msg.model ?? null, msg.brain ?? null);
          } finally {
            loading = false;
          }
        } else if (msg.type === 'speed') {
          sim.setSpeed(msg.multiplier);
        } else if (msg.type === 'control') {
          if (msg.command === 'start') {
            // Starting with nothing loaded should just work: pick the first world.
            if (!sim.world) await sim.load(availableWorlds()[0] ?? CFG.WORLD, null, null, null);
            sim.start();
          } else if (msg.command === 'pause') sim.pause();
          else if (msg.command === 'step') { sim.pause(); await sim.step(); }
          else if (msg.command === 'reset') await sim.reset();
        }
      } catch (error) {
        // A bad command must never take the server down mid-demo.
        const detail = error instanceof Error ? error.message : String(error);
        console.error('[sim] command failed:', detail);
        ws.send(JSON.stringify({ type: 'error', detail }));
      }
      broadcast(status());
    });

    ws.on('close', () => {
      clients.delete(ws);
      // Nobody is watching. A model-backed run would keep spending into an empty
      // room, so the clock stops until someone comes back and presses Run.
      if (clients.size === 0 && sim.running) {
        sim.pause();
        console.log('[sim] last client disconnected - paused');
      }
    });
  });

  // The clock. Runs forever; ticks only while the dashboard says to.
  void (async () => {
    let lastStatus = 0;
    for (;;) {
      if (sim.running && sim.engine) {
        // Spend and tick count change every tick, and the console shows both, so
        // status has to stream rather than only answer commands. Once a second
        // is often enough to read and cheap enough to ignore.
        const now = Date.now();
        if (now - lastStatus > 1000) { lastStatus = now; broadcast(status()); }
        await sim.step();
        // Confirmations arrive after the tick that caused them, because the queue
        // never blocks the simulation. The dashboard reads signatures off events
        // (SimEvent.signature), so they go back as events rather than as a
        // bespoke message its contract does not define.
        const fresh = await sim.drainSignatures();
        if (fresh.length > 0) {
          broadcast({
            type: 'events',
            events: fresh.map((signature) => ({
              seq: confirmSeq++,
              tick: sim.engine?.state.tick ?? 0,
    loading,
    agents: sim.agentCount,
    agentLimits: sim.agentLimits,
    agentNote: sim.agentNote,
              type: 'settlement_confirmed',
              data: { rpc: CFG.RPC },
              signature,
            })),
          });
        }
      }
      await new Promise((r) => setTimeout(r, Math.max(16, sim.tickMs / sim.speed)));
    }
  })();

  http.listen(port, () => {
    console.log(`[sim] control server on ws://localhost:${port} — idle, waiting for the dashboard`);
    console.log(`[sim] worlds: ${availableWorlds().join(', ') || '(none found)'}`);
  });

  return { sim, broadcast };
}
