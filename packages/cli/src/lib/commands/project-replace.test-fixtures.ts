import { ProjectReplaceArtifact } from '@inboxfm-connect/shared'

export const DEST_BASE = 'https://dest.example.com'
export const SOURCE_BASE = 'https://source.example.com'
export const DEST_PROJECT = 'proj_dest'
export const SOURCE_PROJECT = 'proj_src'
export const DEST_TOKEN = 'dest-token-abc123'
export const SOURCE_TOKEN = 'source-token-xyz789'

/**
 * Builds an artifact that satisfies `ProjectReplaceArtifactSchema` for real, so the plan-file paths
 * under test exercise the same Zod validation a downloaded artifact would hit rather than a
 * hand-waved object.
 */
export function buildArtifact(overrides: {
    preflightPassed?: boolean
    preflightErrors?: Array<{ kind: string, message: string }>
    summary?: { created: number, updated: number, deleted: number, unchanged: number }
} = {}): ProjectReplaceArtifact {
    const preflightPassed = overrides.preflightPassed ?? true
    return {
        artifactVersion: 1,
        toolVersion: '1.0.0',
        createdAt: '2026-01-01T00:00:00.000Z',
        snapshot: buildSnapshot(),
        plan: {
            planId: 'plan_1',
            schemaVersion: 1,
            toolVersion: '1.0.0',
            createdAt: '2026-01-01T00:00:00.000Z',
            sourceActivepiecesVersion: '8.0.0',
            targetActivepiecesVersion: '8.0.0',
            targetProjectId: DEST_PROJECT,
            checksum: 'checksum_1',
            destinationStateHash: 'state_hash_1',
            signature: 'signature_1',
            preflight: {
                passed: preflightPassed,
                errors: overrides.preflightErrors ?? [],
                warnings: [],
                connections: {
                    required: [{ externalId: 'conn_src', pieceName: 'http' }],
                    matched: [],
                    missing: [],
                    mapped: [],
                },
            },
            changes: {
                creates: [{ kind: 'flow', externalId: 'flow_1' }],
                updates: [],
                deletes: [],
                unchanged: [],
            },
            summary: overrides.summary ?? { created: 1, updated: 0, deleted: 0, unchanged: 0 },
        },
    }
}

export function buildSnapshot() {
    return {
        schemaVersion: 1 as const,
        sourceActivepiecesVersion: '8.0.0',
        exportedAt: '2026-01-01T00:00:00.000Z',
        tables: [],
        agents: [],
        triggerBindings: [],
        scheduledTasks: [],
        requiredPieces: [],
        requiredConnections: [],
    }
}

export type StubCall = {
    url: string
    method: string
    headers: Record<string, string>
    body: unknown
}

export type StubResponse = {
    status: number
    body: unknown
}

/**
 * Minimal `fetch` stand-in driven by a list of responses. Returns the recorded calls so a test can
 * assert the exact URL, method, headers and body the CLI produced for each phase.
 */
export function createFetchStub(responses: StubResponse[]): {
    fetch: typeof globalThis.fetch
    calls: StubCall[]
} {
    const calls: StubCall[] = []
    let index = 0
    const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
        const spec = responses[Math.min(index, responses.length - 1)]
        index += 1
        const headers = normalizeHeaders(init?.headers)
        calls.push({
            url: String(url),
            method: init?.method ?? 'GET',
            headers,
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        })
        return new Response(JSON.stringify(spec?.body ?? {}), {
            status: spec?.status ?? 200,
            headers: { 'content-type': 'application/json' },
        })
    }) as unknown as typeof globalThis.fetch
    return { fetch: fetchStub, calls }
}

export function createFailingFetch(message = 'ECONNREFUSED'): typeof globalThis.fetch {
    return (async () => {
        throw new Error(message)
    }) as unknown as typeof globalThis.fetch
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
    const result: Record<string, string> = {}
    if (!headers) return result
    if (headers instanceof Headers) {
        headers.forEach((value, key) => {
            result[key] = value
        })
        return result
    }
    if (Array.isArray(headers)) {
        for (const [key, value] of headers) result[key] = value
        return result
    }
    return { ...headers }
}

/** Captures everything the command writes so a test can assert on the combined stream. */
export function captureConsole(): { output: () => string, restore: () => void } {
    const chunks: string[] = []
    const original = { log: console.log, error: console.error, warn: console.warn }
    const record = (...args: unknown[]) => {
        chunks.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '))
    }
    console.log = record
    console.error = record
    console.warn = record
    return {
        output: () => chunks.join('\n'),
        restore: () => {
            console.log = original.log
            console.error = original.error
            console.warn = original.warn
        },
    }
}
