import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@flow-e/mcp/core': path.resolve(import.meta.dirname, '../dist/core.js'),
      // `server-only` throws outside React Server Components; tests run the server code directly.
      'server-only': path.resolve(import.meta.dirname, 'test/server-only-stub.ts'),
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
