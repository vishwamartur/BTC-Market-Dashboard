import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/features/**', 'src/strategies/**', 'src/risk/**'],
      thresholds: { lines: 90, functions: 90, branches: 85 },
    },
  },
});
