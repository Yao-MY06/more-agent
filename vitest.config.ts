import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'vendor/dsh-superagent/tests/**/*.spec.ts'],
    coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['vendor/**'], reporter: ['text'] },
  },
})
