// Run a world for N ticks without a browser and report what the economy did.
// Useful for checking a world's rules produce the dynamics they intend.
import { readFileSync } from 'node:fs';
import { Simulation } from './apps/sim/src/runtime.ts';

const world = process.env['WORLD'] ?? 'economic-sandbox';
const ticks = Number(process.env['RUN_TICKS'] ?? 150);

const seen: Record<string, number> = {};
const sim = new Simulation(
  (frame) => {
    for (const e of frame.events) {
      seen[e.type] = (seen[e.type] ?? 0) + 1;
      if (e.type === 'action_rejected') {
        const k = `reject:${e.data['action']}:${e.data['rejectedBy']}`;
        seen[k] = (seen[k] ?? 0) + 1;
      }
      if (e.type === 'action_applied') {
        const k = `did:${e.data['action']}`;
        seen[k] = (seen[k] ?? 0) + 1;
      }
    }
  },
  () => {},
);
await sim.load(world, process.env['AGENTS'] ? Number(process.env['AGENTS']) : null,
               process.env['MODEL'] ?? 'stub', process.env['BRAIN'] ?? 'mix');
for (let i = 0; i < ticks; i++) await sim.step();

const state = sim.engine!.state;
const byType: Record<string, number> = {};
for (const e of Object.values(state.entities)) byType[e.type] = (byType[e.type] ?? 0) + 1;

const firmEvents = ['company_founded', 'hired', 'salary_paid', 'laid_off',
                    'dividend_paid', 'company_failed', 'equity_purchased'];
console.log(`\n${sim.world!.name}: ${ticks} ticks, model ${process.env['MODEL'] ?? 'stub'}`);
console.log('population :', byType);
console.log('firms      :', Object.fromEntries(firmEvents.map((k) => [k, seen[k] ?? 0])));
console.log('market     :', { clears: seen['market_cleared'] ?? 0, fills: seen['order_filled'] ?? 0,
                              bids: seen['bid_posted'] ?? 0, asks: seen['ask_posted'] ?? 0 });
console.log('prices     :', state.prices);
console.log('actions    :', Object.fromEntries(Object.entries(seen).filter(([k]) => k.startsWith('did:'))));
console.log('rejections :', Object.fromEntries(Object.entries(seen).filter(([k]) => k.startsWith('reject:')).slice(0, 8)));
const u = sim.usage;
if (u) console.log('spend      :', `$${u.costUsd.toFixed(4)}`, `${u.calls} calls`);
