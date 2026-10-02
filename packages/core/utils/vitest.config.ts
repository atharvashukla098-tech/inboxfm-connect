import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Regression ratchet, set just below the measured 6.85% so a drop fails and an improvement does
    // not. Deliberately low: this package is bundled into every piece, so a large untested surface
    // is the known state to be ratcheted upward, not a number to invent. Enforced by the
    // test-coverage script and the CI unit job.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      thresholds: {
        statements: 5,
        lines: 5,
      },
    },
  },
})
