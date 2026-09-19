// One command to bring up everything: the simulation control server and the
// dashboard. After this, the browser drives the whole thing - pick a world,
// start, pause, step, reset. Nothing else needs a terminal.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const CHAIN = process.env.CHAIN ?? '1';
const RPC = process.env.RPC ?? 'http://127.0.0.1:8899';
const PORT = process.env.PORT ?? '8787';
const WEB = process.env.WEB_PORT ?? '3210';

async function validatorUp() {
  try {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch { return false; }
}

const chain = CHAIN === '1' && (await validatorUp());
if (CHAIN === '1' && !chain) {
  console.log(`\n  no validator on ${RPC} - starting off chain.`);
  console.log('  for real settlement, run this first, then restart:');
  console.log('    solana-test-validator --limit-ledger-size 50000000\n');
}
if (!existsSync('.env')) {
  console.log('  no .env - agents will use the deterministic stub.');
  console.log('  for real reasoning: echo OPENAI_API_KEY=... > .env\n');
}

const children = [];
function run(name, cmd, args, env) {
  const child = spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  child.on('exit', (code) => {
    console.log(`\n[${name}] exited (${code}). Shutting the rest down.`);
    for (const c of children) if (c !== child) c.kill('SIGTERM');
    process.exit(code ?? 0);
  });
  children.push(child);
  return child;
}

run('sim', 'npx', ['tsx', 'apps/sim/src/main.ts'], { CHAIN: chain ? '1' : '0', RPC, PORT });
run('web', 'npm', ['--prefix', 'apps/web', 'run', 'dev']);

console.log(`\n  Agentic World`);
console.log(`  dashboard   http://localhost:${WEB}`);
console.log(`  simulation  ws://localhost:${PORT}   chain: ${chain ? RPC : 'off'}`);
console.log(`  open the dashboard, switch to Live, pick a world and press Start.\n`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { for (const c of children) c.kill(sig); process.exit(0); });
}
