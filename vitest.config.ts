import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@aw/types': `${here}packages/types/src/index.ts`,
      '@aw/engine': `${here}packages/engine/src/index.ts`,
      '@aw/solana': `${here}packages/solana/src/index.ts`,
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    environment: 'node',
  },
});
