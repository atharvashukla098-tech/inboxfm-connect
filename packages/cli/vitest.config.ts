import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        // The CLI drives a live HTTP contract in a few tests, but every network call is stubbed, so
        // no suite here may depend on a real server or a real registry.
        include: ['src/**/*.test.ts'],
    },
})
