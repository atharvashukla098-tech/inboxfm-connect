import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Enforced whenever the suite runs with --coverage (see the test-coverage script and the CI
    // unit job). These are regression ratchets set just below the measured level, not a quality
    // target: shared is still largely untested, and pretending otherwise would only make the gate
    // something to raise in a hurry. They exist so coverage cannot silently fall further.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      thresholds: {
        statements: 9,
        lines: 9,
      },
    },
  },
})
