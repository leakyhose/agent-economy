// Every dial in one place. Override any of them with an env var.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');
// The project's .env WINS over the shell, so a stale key exported in ~/.zshrc can't
// silently shadow the one meant for this project. (process.loadEnvFile won't override.)
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) process.env[m[1]] = m[2];
  }
} catch { /* no .env yet */ }
const env = process.env;

export const GOODS = ['food', 'wood', 'nets'];
export const FOOD = 0, WOOD = 1, NETS = 2;

export const CFG = {
  AGENTS:      +env.AGENTS      || 10,
  BRAIN:        env.BRAIN        || 'stub',            // stub | openai | claude
  MODEL:        env.MODEL        || (env.BRAIN === 'claude' ? 'claude-haiku-4-5' : 'gpt-5.6-luna'),
  TICK_MS:     +env.TICK_MS     || 500,               // one game tick
  ROUND_TICKS: +env.ROUND_TICKS || 6,                 // market clears every N ticks
  EAT_TICKS:   +env.EAT_TICKS   || 8,                 // each agent eats 1 food every N ticks
  STAGGER_MS:  +env.STAGGER_MS  || 6000,              // agents wake up spread over this window
  START_CASH:  +env.START_CASH  || 5000,              // cents
  START_FOOD:  +env.START_FOOD  || 6,
  LLM_CONCURRENCY: +env.LLM_CONCURRENCY || 12,
  RUN_SECONDS: +env.RUN_SECONDS || 0,                 // 0 = run forever
  PORT:        +env.PORT        || 8787,
  RPC:          env.RPC          || 'http://127.0.0.1:8899',

  TASKS: {
    gather_food: { ticks: 6, yield: 2, netYield: 4, place: 'docks' },   // one fisher feeds ~2 people
    gather_wood: { ticks: 6, yield: 3,               place: 'forest' },
    craft_net:   { ticks: 4, wood: 4,                place: 'workshop' },
    idle:        { ticks: 6,                          place: 'square' },
  },
  NET_WEAR: 0.05,          // chance a net breaks on each fishing shift
  // Share of an agent's FREE stock that rots every market round: food, wood, nets.
  // Coins never spoil — so holding money is the way to store value, and surplus
  // goods have to be sold before they rot.
  SPOIL: [0.10, 0.02, 0],
  HUNGRY_PENALTY: 0.5,     // hungry agents gather half as much
  START_PRICES: [500, 300, 2000],   // cents: food, wood, nets
};
