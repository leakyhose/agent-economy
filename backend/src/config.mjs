// Every dial in one place. Override any of them with an env var.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env yet */ }
const env = process.env;

export const GOODS = ['food', 'wood', 'nets'];
export const FOOD = 0, WOOD = 1, NETS = 2;

export const CFG = {
  AGENTS:      +env.AGENTS      || 100,
  BRAIN:        env.BRAIN        || 'stub',            // stub | claude
  MODEL:        env.MODEL        || 'claude-haiku-4-5',
  TICK_MS:     +env.TICK_MS     || 500,               // one game tick
  ROUND_TICKS: +env.ROUND_TICKS || 6,                 // market clears every N ticks
  EAT_TICKS:   +env.EAT_TICKS   || 12,                // each agent eats 1 food every N ticks
  STAGGER_MS:  +env.STAGGER_MS  || 6000,              // agents wake up spread over this window
  START_CASH:  +env.START_CASH  || 5000,              // cents
  START_FOOD:  +env.START_FOOD  || 6,
  LLM_CONCURRENCY: +env.LLM_CONCURRENCY || 12,
  RUN_SECONDS: +env.RUN_SECONDS || 0,                 // 0 = run forever
  PORT:        +env.PORT        || 8787,
  RPC:          env.RPC          || 'http://127.0.0.1:8899',

  TASKS: {
    gather_food: { ticks: 6, yield: 3, netYield: 6, place: 'docks' },
    gather_wood: { ticks: 6, yield: 3,               place: 'forest' },
    craft_net:   { ticks: 4, wood: 4,                place: 'workshop' },
    idle:        { ticks: 6,                          place: 'square' },
  },
  NET_WEAR: 0.05,          // chance a net breaks on each fishing shift
  HUNGRY_PENALTY: 0.5,     // hungry agents gather half as much
  START_PRICES: [500, 300, 2000],   // cents: food, wood, nets
};
