import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    exclude: ['node_modules/**'],
    env: { NEXT_PUBLIC_ERGO_NETWORK: 'mainnet' },
  },
  resolve: { alias: { '@': resolve(__dirname, '.') } },
});
