// Every dial in one place; each overridable by an env var.
//
// The project's .env WINS over the shell, so a stale key exported in a shell
// profile cannot silently shadow the one meant for this project.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

try {
  for (const line of readFileSync(resolve('.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m?.[1]) process.env[m[1]] = (m[2] ?? '').replace(/^["']|["']$/g, '');
  }
} catch { /* no .env yet, which is fine - the stub needs no key */ }

export const CFG = {
  WORLD:      process.env['WORLD']   ?? 'worlds/economic-sandbox.json',
  /** mix | rule | utility | hybrid | llm */
  BRAIN:      process.env['BRAIN']   ?? 'mix',
  /** stub | openai. Ignored unless the brain actually calls a model. */
  PROVIDER:   process.env['PROVIDER'] ?? (process.env['OPENAI_API_KEY'] ? 'openai' : 'stub'),
  MODEL:      process.env['MODEL']   ?? 'gpt-5.6-luna',
  LLM_CONCURRENCY: Number(process.env['LLM_CONCURRENCY'] ?? 12),
  TICK_MS:    Number(process.env['TICK_MS']   ?? 400),
  PORT:       Number(process.env['PORT']      ?? 8787),
  RPC:        process.env['RPC']     ?? 'http://127.0.0.1:8899',
  /** Off by default so the sim runs with no validator. */
  CHAIN:      process.env['CHAIN']   === '1',
  RUN_TICKS:  Number(process.env['RUN_TICKS'] ?? 0),   // 0 = run until stopped
};
