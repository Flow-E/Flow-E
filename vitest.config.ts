import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'html'],
      thresholds: {
        'src/engine/**': { statements: 90, branches: 90, functions: 90, lines: 90 },
        'src/kya/**': { statements: 90, branches: 90, functions: 90, lines: 90 },
        'src/crypto/**': { statements: 90, branches: 90, functions: 90, lines: 90 },
        'src/ledger/**': { statements: 90, branches: 90, functions: 90, lines: 90 },
      },
    },
  },
});
