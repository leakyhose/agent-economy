// Every dial in one place; each overridable by env var.
export const CFG = {
  WORLD:      process.env.WORLD      ?? 'worlds/economic-sandbox.json',
  BRAIN:      process.env.BRAIN      ?? 'stub',        // stub | rule | utility | hybrid | llm
  TICK_MS:   +(process.env.TICK_MS   ?? 400),
  PORT:      +(process.env.PORT      ?? 8787),
  RPC:        process.env.RPC        ?? 'http://127.0.0.1:8899',
  /** Off by default so the sim runs with no validator. */
  CHAIN:      process.env.CHAIN      === '1',
  RUN_TICKS: +(process.env.RUN_TICKS ?? 0),            // 0 = run until stopped
  AUTOSTART:  process.env.AUTOSTART  !== '0',
};
