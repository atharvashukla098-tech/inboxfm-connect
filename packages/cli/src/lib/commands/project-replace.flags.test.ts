import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseConnectionMappings, parseProviderMappings, runProjectReplace } from './project-replace'
import {
    buildArtifact,
    captureConsole,
    createFetchStub,
    DEST_BASE,
    DEST_PROJECT,
    DEST_TOKEN,
    SOURCE_BASE,
    SOURCE_PROJECT,
    SOURCE_TOKEN,
} from './project-replace.test-fixtures'

/** Issue #139: "unit tests per command (auth, export, plan, apply, flags parsing)". */
describe('project replace flag parsing (#139)', () => {
    const base = { destUrl: DEST_BASE, destToken: DEST_TOKEN, destProject: DEST_PROJECT }

    it('parses a single --connection-map pair', () => {
        expect(parseConnectionMappings({ ...base, connectionMap: ['src=dst'] })).toEqual([
            { sourceExternalId: 'src', destExternalId: 'dst' },
        ])
    })

    it('parses repeated --connection-map occurrences and comma-separated lists', () => {
        const mappings = parseConnectionMappings({ ...base, connectionMap: ['a=1,b=2', 'c=3'] })
        expect(mappings).toEqual([
            { sourceExternalId: 'a', destExternalId: '1' },
            { sourceExternalId: 'b', destExternalId: '2' },
            { sourceExternalId: 'c', destExternalId: '3' },
        ])
    })

    it('accepts ":" as a delimiter and tolerates whitespace', () => {
        expect(parseConnectionMappings({ ...base, connectionMap: ['  src : dst  '] })).toEqual([
            { sourceExternalId: 'src', destExternalId: 'dst' },
        ])
    })

    it('rejects a --connection-map entry with no delimiter, naming the expected format', () => {
        expect(() => parseConnectionMappings({ ...base, connectionMap: ['nodelimiter'] }))
            .toThrow(/Invalid connection mapping "nodelimiter"\. Format must be sourceExternalId=destExternalId/)
    })

    it('ignores empty segments in a --connection-map list', () => {
        expect(parseConnectionMappings({ ...base, connectionMap: ['a=1,,  ,b=2'] })).toHaveLength(2)
    })

    it('parses --provider-map into the shape the API /plan endpoint accepts', () => {
        expect(parseProviderMappings({ ...base, providerMap: ['OldPiece=NewPiece', 'A=1,B=2'] })).toEqual([
            { sourceProvider: 'OldPiece', destProvider: 'NewPiece' },
            { sourceProvider: 'A', destProvider: '1' },
            { sourceProvider: 'B', destProvider: '2' },
        ])
    })

    it('rejects a --provider-map entry with no delimiter', () => {
        expect(() => parseProviderMappings({ ...base, providerMap: ['nope'] }))
            .toThrow(/Invalid provider mapping/)
    })

    it('parses a single bootstrap mapping object without mangling it', () => {
        // Regression: this documented shape used to fall through to the key→value map branch and
        // become {sourceExternalId: 'value', ...}, so the credential never reached the destination.
        const mappings = parseConnectionMappings({
            ...base,
            connectionBootstrap: JSON.stringify({ sourceExternalId: 'slack-main', value: { access_token: 'xoxb-1' } }),
        })
        expect(mappings).toEqual([{ sourceExternalId: 'slack-main', value: { access_token: 'xoxb-1' } }])
    })

    it('parses an array of bootstrap mappings', () => {
        const mappings = parseConnectionMappings({
            ...base,
            connectionBootstrap: JSON.stringify([{ sourceExternalId: 'a', destExternalId: 'b' }]),
        })
        expect(mappings).toEqual([{ sourceExternalId: 'a', destExternalId: 'b' }])
    })

    it('parses a { mappings: [...] } bootstrap envelope', () => {
        const mappings = parseConnectionMappings({
            ...base,
            connectionBootstrap: JSON.stringify({ mappings: [{ sourceExternalId: 'a', destExternalId: 'b' }] }),
        })
        expect(mappings).toEqual([{ sourceExternalId: 'a', destExternalId: 'b' }])
    })

    it('parses a flat { source: dest } bootstrap map', () => {
        const mappings = parseConnectionMappings({
            ...base,
            connectionBootstrap: JSON.stringify({ a: 'b' }),
        })
        expect(mappings).toEqual([{ sourceExternalId: 'a', destExternalId: 'b' }])
    })

    it('reads mappings from a file and fails loudly when the file is missing', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-map-'))
        const file = path.join(dir, 'map.json')
        fs.writeFileSync(file, JSON.stringify({ a: 'b' }), 'utf-8')

        expect(parseConnectionMappings({ ...base, connectionMappingFile: file }))
            .toEqual([{ sourceExternalId: 'a', destExternalId: 'b' }])
        expect(() => parseConnectionMappings({ ...base, connectionMappingFile: path.join(dir, 'nope.json') }))
            .toThrow(/Connection mapping file not found/)
    })

    it('reads INBOXFM_CONNECTION_MAPPINGS as inline JSON', () => {
        process.env.INBOXFM_CONNECTION_MAPPINGS = JSON.stringify({ env: 'mapped' })
        try {
            expect(parseConnectionMappings(base)).toEqual([{ sourceExternalId: 'env', destExternalId: 'mapped' }])
        }
        finally {
            delete process.env.INBOXFM_CONNECTION_MAPPINGS
        }
    })

    it('warns but does not throw on malformed INBOXFM_CONNECTION_MAPPINGS', () => {
        process.env.INBOXFM_CONNECTION_MAPPINGS = '{not json'
        const console_ = captureConsole()
        try {
            expect(parseConnectionMappings(base)).toEqual([])
            expect(console_.output()).toContain('Failed to parse INBOXFM_CONNECTION_MAPPINGS')
        }
        finally {
            console_.restore()
            delete process.env.INBOXFM_CONNECTION_MAPPINGS
        }
    })

    it('merges every mapping source in precedence order', () => {
        process.env.INBOXFM_CONNECTION_MAPPINGS = JSON.stringify({ fromEnv: 'e' })
        const console_ = captureConsole()
        try {
            const mappings = parseConnectionMappings({
                ...base,
                connectionMap: ['fromFlag=f'],
                connectionBootstrap: JSON.stringify({ fromBootstrap: 'b' }),
            })
            expect(mappings.map(m => m.sourceExternalId)).toEqual(['fromEnv', 'fromBootstrap', 'fromFlag'])
        }
        finally {
            console_.restore()
            delete process.env.INBOXFM_CONNECTION_MAPPINGS
        }
    })
})

describe('project replace request contract (#139)', () => {
    const console_ = { restore: () => {} }
    afterEach(() => console_.restore())

    async function runQuiet(options: Record<string, unknown>) {
        const capture = captureConsole()
        const stub = createFetchStub([
            { status: 200, body: {} },
            { status: 200, body: buildArtifact() },
            { status: 200, body: { applied: {}, failed: [] } },
        ])
        await runProjectReplace({
            sourceUrl: SOURCE_BASE,
            sourceToken: SOURCE_TOKEN,
            sourceProject: SOURCE_PROJECT,
            destUrl: DEST_BASE,
            destToken: DEST_TOKEN,
            destProject: DEST_PROJECT,
            // Commander fills these in from the option declarations, so the real command always
            // receives booleans rather than undefined. Mirroring that keeps the asserted request
            // bodies honest instead of describing a shape the CLI can never produce.
            dryRun: false,
            force: false,
            deployIntegrations: false,
            inspectOnly: false,
            rotateMcpToken: false,
            json: false,
            ...options,
        } as never, { fetch: stub.fetch })
        capture.restore()
        return stub.calls
    }

    it('exports the snapshot from the source with the source token only', async () => {
        const calls = await runQuiet({})
        expect(calls[0].method).toBe('GET')
        expect(calls[0].url).toBe(`${SOURCE_BASE}/api/v1/projects/${SOURCE_PROJECT}/replace/export`)
        expect(calls[0].headers.Authorization).toBe(`Bearer ${SOURCE_TOKEN}`)
    })

    it('never sends the source token to the destination, or the destination token to the source', async () => {
        const calls = await runQuiet({})
        const sourceCalls = calls.filter(c => c.url.startsWith(SOURCE_BASE))
        const destCalls = calls.filter(c => c.url.startsWith(DEST_BASE))
        expect(sourceCalls.every(c => c.headers.Authorization === `Bearer ${SOURCE_TOKEN}`)).toBe(true)
        expect(destCalls.every(c => c.headers.Authorization === `Bearer ${DEST_TOKEN}`)).toBe(true)
        expect(destCalls.some(c => c.headers.Authorization === `Bearer ${SOURCE_TOKEN}`)).toBe(false)
    })

    it('plans against the destination with the snapshot and the resolved mappings', async () => {
        const calls = await runQuiet({
            connectionMap: ['conn=dest-conn'],
            providerMap: ['OldPiece=NewPiece'],
        })
        const plan = calls.find(c => c.url.endsWith('/replace/plan'))
        expect(plan?.method).toBe('POST')
        expect(plan?.url).toBe(`${DEST_BASE}/api/v1/projects/${DEST_PROJECT}/replace/plan`)
        expect(plan?.body).toMatchObject({
            connectionMappings: [{ sourceExternalId: 'conn', destExternalId: 'dest-conn' }],
            providerMappings: [{ sourceProvider: 'OldPiece', destProvider: 'NewPiece' }],
        })
    })

    it('omits the mapping keys entirely when no mappings were supplied', async () => {
        const calls = await runQuiet({})
        const plan = calls.find(c => c.url.endsWith('/replace/plan'))
        expect(plan?.body).not.toHaveProperty('connectionMappings')
        expect(plan?.body).not.toHaveProperty('providerMappings')
    })

    it('applies with the plan, the snapshot and the action flags', async () => {
        const calls = await runQuiet({ force: true, deployIntegrations: true, rotateMcpToken: true })
        const apply = calls.find(c => c.url.endsWith('/replace/apply'))
        expect(apply?.method).toBe('POST')
        expect(apply?.url).toBe(`${DEST_BASE}/api/v1/projects/${DEST_PROJECT}/replace/apply`)
        expect(apply?.body).toMatchObject({
            force: true,
            deployCustomIntegrations: true,
            inspectOnly: false,
            rotateMcpToken: true,
        })
    })

    it('strips a trailing slash from both base URLs so paths do not double up', async () => {
        const calls = await runQuiet({ sourceUrl: `${SOURCE_BASE}/`, destUrl: `${DEST_BASE}/` })
        expect(calls[0].url).toBe(`${SOURCE_BASE}/api/v1/projects/${SOURCE_PROJECT}/replace/export`)
        expect(calls.some(c => c.url.includes('//api'))).toBe(false)
    })
})
