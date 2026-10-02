import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { PROJECT_REPLACE_EXIT, runProjectReplace } from './project-replace'
import {
    buildArtifact,
    captureConsole,
    createFailingFetch,
    createFetchStub,
    DEST_BASE,
    DEST_PROJECT,
    SOURCE_BASE,
    SOURCE_PROJECT,
    SOURCE_TOKEN,
    DEST_TOKEN,
} from './project-replace.test-fixtures'

/**
 * Issue #139: "exit-code contract: distinct codes for distinct failure classes, locked by test".
 *
 * Before this the command terminated through `process.exit` at 20+ points, so none of it was
 * reachable from a test, and code `1` was overloaded across three unrelated outcomes. These tests
 * lock one code per outcome and, separately, assert the codes are actually distinct.
 */
describe('project replace exit-code contract (#139)', () => {
    it('gives every distinct outcome its own code', () => {
        const codes = Object.values(PROJECT_REPLACE_EXIT)
        expect(new Set(codes).size).toBe(codes.length)
    })

    it('keeps 0-6 on their original values so existing callers do not break', () => {
        expect(PROJECT_REPLACE_EXIT.SUCCESS).toBe(0)
        expect(PROJECT_REPLACE_EXIT.PREFLIGHT_FAILED).toBe(1)
        expect(PROJECT_REPLACE_EXIT.VALIDATION_FAILED).toBe(2)
        expect(PROJECT_REPLACE_EXIT.DESTINATION_DRIFT).toBe(3)
        expect(PROJECT_REPLACE_EXIT.AUTH_FAILED).toBe(4)
        expect(PROJECT_REPLACE_EXIT.TRANSPORT_FAILED).toBe(5)
        expect(PROJECT_REPLACE_EXIT.SERVER_ERROR).toBe(6)
    })

    it('returns AUTH_FAILED when no source details and no plan file are given', async () => {
        const console_ = captureConsole()
        try {
            const code = await runProjectReplace(
                { destUrl: DEST_BASE, destToken: DEST_TOKEN, destProject: DEST_PROJECT },
                { fetch: createFetchStub([]) },
            )
            expect(code).toBe(PROJECT_REPLACE_EXIT.AUTH_FAILED)
        }
        finally {
            console_.restore()
        }
    })

    it('returns AUTH_FAILED when the destination rejects the credentials with 401', async () => {
        const console_ = captureConsole()
        try {
            const { fetch } = createFetchStub([
                { status: 200, body: {} },
                { status: 401, body: { error: 'nope' } },
            ])
            const code = await runProjectReplace(sourceToDest(), { fetch })
            expect(code).toBe(PROJECT_REPLACE_EXIT.AUTH_FAILED)
        }
        finally {
            console_.restore()
        }
    })

    it('returns DESTINATION_DRIFT on a 409 from plan', async () => {
        const console_ = captureConsole()
        try {
            const { fetch } = createFetchStub([
                { status: 200, body: {} },
                { status: 409, body: { error: 'drift' } },
            ])
            const code = await runProjectReplace(sourceToDest(), { fetch })
            expect(code).toBe(PROJECT_REPLACE_EXIT.DESTINATION_DRIFT)
        }
        finally {
            console_.restore()
        }
    })

    it('returns SERVER_ERROR on a 5xx from plan', async () => {
        const console_ = captureConsole()
        try {
            const { fetch } = createFetchStub([
                { status: 200, body: {} },
                { status: 503, body: { error: 'unavailable' } },
            ])
            const code = await runProjectReplace(sourceToDest(), { fetch })
            expect(code).toBe(PROJECT_REPLACE_EXIT.SERVER_ERROR)
        }
        finally {
            console_.restore()
        }
    })

    it('returns PREFLIGHT_FAILED for a 400 carrying a preflight report', async () => {
        const console_ = captureConsole()
        try {
            const artifact = buildArtifact({ preflightPassed: false, preflightErrors: [{ kind: 'MISSING_PIECE', message: 'absent' }] })
            const { fetch } = createFetchStub([
                { status: 200, body: {} },
                { status: 400, body: artifact },
            ])
            const code = await runProjectReplace(sourceToDest(), { fetch })
            expect(code).toBe(PROJECT_REPLACE_EXIT.PREFLIGHT_FAILED)
        }
        finally {
            console_.restore()
        }
    })

    it('returns VALIDATION_FAILED for a 400 that is not a preflight report', async () => {
        const console_ = captureConsole()
        try {
            const { fetch } = createFetchStub([
                { status: 200, body: {} },
                { status: 400, body: { error: 'malformed snapshot' } },
            ])
            const code = await runProjectReplace(sourceToDest(), { fetch })
            expect(code).toBe(PROJECT_REPLACE_EXIT.VALIDATION_FAILED)
        }
        finally {
            console_.restore()
        }
    })

    it('returns VALIDATION_FAILED for an unparseable plan file', async () => {
        const console_ = captureConsole()
        try {
            const file = writeTemp('not json at all')
            const code = await runProjectReplace(
                { destUrl: DEST_BASE, destToken: DEST_TOKEN, destProject: DEST_PROJECT, planFile: file, dryRun: true },
                { fetch: createFetchStub([]) },
            )
            expect(code).toBe(PROJECT_REPLACE_EXIT.VALIDATION_FAILED)
        }
        finally {
            console_.restore()
        }
    })

    it('returns TRANSPORT_FAILED when the destination is unreachable', async () => {
        const console_ = captureConsole()
        try {
            const code = await runProjectReplace(sourceToDest(), { fetch: createFailingFetch() })
            expect(code).toBe(PROJECT_REPLACE_EXIT.TRANSPORT_FAILED)
        }
        finally {
            console_.restore()
        }
    })

    it('returns SUCCESS when apply reports nothing failed', async () => {
        const console_ = captureConsole()
        try {
            const { fetch } = createFetchStub([
                { status: 200, body: {} },
                { status: 200, body: buildArtifact() },
                { status: 200, body: { applied: { flows: 1 }, failed: [] } },
            ])
            const code = await runProjectReplace(sourceToDest(), { fetch })
            expect(code).toBe(PROJECT_REPLACE_EXIT.SUCCESS)
        }
        finally {
            console_.restore()
        }
    })

    it('returns PARTIAL_APPLY — not PREFLIGHT_FAILED — when apply partially succeeds', async () => {
        const console_ = captureConsole()
        try {
            const { fetch } = createFetchStub([
                { status: 200, body: {} },
                { status: 200, body: buildArtifact() },
                { status: 207, body: { applied: { flows: 1 }, failed: [{ kind: 'mcp_server', error: 'rotate failed' }] } },
            ])
            const code = await runProjectReplace(sourceToDest(), { fetch })
            expect(code).toBe(PROJECT_REPLACE_EXIT.PARTIAL_APPLY)
        }
        finally {
            console_.restore()
        }
    })

    it('returns CHANGES_PENDING — not PREFLIGHT_FAILED — when a clean dry run finds work to do', async () => {
        const console_ = captureConsole()
        try {
            const { fetch } = createFetchStub([
                { status: 200, body: {} },
                { status: 200, body: buildArtifact({ summary: { created: 2, updated: 0, deleted: 0, unchanged: 0 } }) },
            ])
            const code = await runProjectReplace({ ...sourceToDest(), dryRun: true }, { fetch })
            expect(code).toBe(PROJECT_REPLACE_EXIT.CHANGES_PENDING)
        }
        finally {
            console_.restore()
        }
    })

    it('returns SUCCESS when a dry run finds nothing to do', async () => {
        const console_ = captureConsole()
        try {
            const { fetch } = createFetchStub([
                { status: 200, body: {} },
                { status: 200, body: buildArtifact({ summary: { created: 0, updated: 0, deleted: 0, unchanged: 5 } }) },
            ])
            const code = await runProjectReplace({ ...sourceToDest(), dryRun: true }, { fetch })
            expect(code).toBe(PROJECT_REPLACE_EXIT.SUCCESS)
        }
        finally {
            console_.restore()
        }
    })
})

function sourceToDest() {
    return {
        sourceUrl: SOURCE_BASE,
        sourceToken: SOURCE_TOKEN,
        sourceProject: SOURCE_PROJECT,
        destUrl: DEST_BASE,
        destToken: DEST_TOKEN,
        destProject: DEST_PROJECT,
    }
}

function writeTemp(contents: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-cli-'))
    const file = path.join(dir, 'plan.json')
    fs.writeFileSync(file, contents, 'utf-8')
    return file
}
