import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Process-heavy integration tests need a bounded worker pool on Windows.
    maxWorkers: 2,
    include: ['test/**/*.test.ts', 'vendor/dsh-superagent/tests/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'desktop/src/**/*.mjs'],
      exclude: ['vendor/**'],
      reporter: ['text'],
    },
  },
})
