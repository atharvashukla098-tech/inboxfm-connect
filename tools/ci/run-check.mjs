import { execFileSync } from 'node:child_process'

const turbo = (...args) => execFileSync('bun', ['x', 'turbo', 'run', ...args], { stdio: 'inherit' })
const node = (file) => execFileSync(process.execPath, [file], { stdio: 'inherit' })
const suite = process.argv[2]

switch (suite) {
    case 'quality':
        turbo('lint', '--filter=!@inboxfm-connect/piece-*')
        turbo('typecheck', 'generate:check', '--filter=@inboxfm-connect/web', '--filter=@inboxfm-connect/sdk')
        turbo('build', '--filter=api', '--filter=@inboxfm-connect/web', '--filter=@inboxfm-connect/engine')
        execFileSync('npm', ['run', 'pack:verify', '--workspace=@inboxfm-connect/sdk'], { stdio: 'inherit' })
        break
    case 'unit':
        turbo('test', '--concurrency=2', '--filter=@inboxfm-connect/shared', '--filter=@inboxfm-connect/core-execution', '--filter=@inboxfm-connect/core-utils', '--filter=@inboxfm-connect/sdk', '--filter=@inboxfm-connect/web', '--filter=@inboxfm-connect/scheduler', '--filter=@inboxfm-connect/pieces-common', '--filter=@inboxfm-connect/piece-bexio', '--filter=@inboxfm-connect/cli')
        turbo('test-unit', '--filter=api', '--filter=@inboxfm-connect/engine')
        // Enforces the per-package coverage ratchets declared in each vitest.config.ts. Separate
        // from the run above so a normal test run stays fast and only CI pays for instrumentation;
        // a coverage drop fails this suite rather than being noticed in an uploaded artifact.
        turbo('test-coverage', '--filter=@inboxfm-connect/shared', '--filter=@inboxfm-connect/core-execution', '--filter=@inboxfm-connect/core-utils')
        break
    case 'engine-integration':
        execFileSync(process.execPath, ['-e', "require('isolated-vm')"], { cwd: 'packages/server/engine', stdio: 'inherit' })
        turbo('test-integration', '--filter=@inboxfm-connect/engine')
        break
    case 'ce':
    case 'ee':
    case 'cloud':
        turbo(`test-${suite}`, '--filter=api')
        break
    case 'migrations':
        turbo('build', '--filter=api')
        node('tools/ci/check-migrations.mjs')
        execFileSync('bun', ['x', 'tsx', 'tools/scripts/check-migration-rollback.ts'], { stdio: 'inherit' })
        break
    case 'integrations':
        node('tools/ci/check-integrations.mjs')
        break
    default:
        throw new Error(`Unknown CI suite: ${suite}`)
}
