import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: { include: ['**/*.test.ts'], exclude: ['node_modules/**'] },
  resolve: { alias: { '@': resolve(__dirname, '.') } },
});
