import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@aw/types':  r('./packages/types/src/index.ts'),
      '@aw/engine': r('./packages/engine/src/index.ts'),
      '@aw/agents': r('./packages/agents/src/index.ts'),
      '@aw/solana': r('./packages/solana/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
  },
});
