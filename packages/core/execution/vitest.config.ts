import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Regression ratchet, set just below the measured 49.78% so a drop fails and an improvement
    // does not. Enforced by the test-coverage script and the CI unit job.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      thresholds: {
        statements: 48,
        lines: 48,
      },
    },
  },
})
