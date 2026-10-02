import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FEATURES_DIR = path.join(REPO_ROOT, '.agents', 'features')

// Ratchet baseline: count of unresolved `packages/**` file references across
// `.agents/features/*.md`. This count must only decrease over time.
// Baseline before cleanup: 185 missing of 372 references (Issue #346).
// Final: 0.
//
// The matcher is `.tsx?` on purpose. An earlier version of this guard used `\.ts` only, which
// silently ignored every `.tsx` reference — and the web package is almost entirely `.tsx`. That
// blind spot made the docs look 86 references cleaner than they were, so a `.ts`-only ratchet would
// have reported a pass while whole UI file lists pointed into `packages/web/src/app/` and
// `packages/web/src/features/`, neither of which exists in this fork. Both extensions are counted.
const MAX_UNRESOLVED_REFS = 0

describe('feature documentation reference integrity (Issue #346)', () => {
    it('does not retain documentation for modules removed from this fork', () => {
        // Each of these describes an upstream subsystem that no longer has a module here, so the doc
        // can only mislead an agent that trusts it. Verified absent, not merely relocated:
        //   chat       - no entity, controller, service or route (only orphan migrations/assets)
        //   alerts     - no alerts module
        //   templates  - no templates module
        // `variables.md` and `knowledge-base.md` are deliberately NOT in this list: the stores they
        // described are gone, but the expression resolver and the knowledge-search endpoint are real,
        // so both were rewritten as accurate stubs rather than deleted.
        const removedDocs = [
            'workers.md',
            'flows.md',
            'flow-runs.md',
            'triggers.md',
            'chat.md',
            'alerts.md',
            'templates.md',
        ]
        const presentRemovedDocs = removedDocs.filter((doc) => fs.existsSync(path.join(FEATURES_DIR, doc)))

        assert.deepEqual(
            presentRemovedDocs,
            [],
            `Found feature documentation for modules removed from this fork: ${presentRemovedDocs.join(', ')}`,
        )
    })

    it('reports unresolved file references and enforces the ratchet threshold', () => {
        const docFiles = fs.readdirSync(FEATURES_DIR).filter((file) => file.endsWith('.md'))
        const pathRegex = /`(packages\/[^\s`*]+\.tsx?)`/g

        let totalRefs = 0
        const missingRefs = []

        for (const file of docFiles) {
            const content = fs.readFileSync(path.join(FEATURES_DIR, file), 'utf8')
            let match
            while ((match = pathRegex.exec(content)) !== null) {
                totalRefs++
                const ref = match[1].replace(/#.*$/, '').replace(/[:;,]$/, '')
                const resolved = path.join(REPO_ROOT, ref)
                if (!fs.existsSync(resolved)) {
                    missingRefs.push({ file, ref })
                }
            }
        }

        const missingCount = missingRefs.length
        console.log(`[feature-docs ratchet] Total references: ${totalRefs}, Resolved: ${totalRefs - missingCount}, Unresolved: ${missingCount}, Ceiling: ${MAX_UNRESOLVED_REFS}`)

        assert.ok(
            missingCount <= MAX_UNRESOLVED_REFS,
            `Unresolved file references in .agents/features/*.md increased from ${MAX_UNRESOLVED_REFS} to ${missingCount}. Fix or prune new broken references:\n` +
                missingRefs.map((m) => `  ${m.file}: ${m.ref}`).join('\n'),
        )
    })
})
