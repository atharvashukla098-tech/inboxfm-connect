import { describe, expect, it } from 'vitest'
import { collectSecretValues, parseConnectionMappings, redactSecrets, runProjectReplace } from './project-replace'
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

const SLACK_TOKEN = 'xoxb-super-secret-slack-token-9f3a'
const OPENAI_KEY = 'sk-proj-do-not-leak-me-4242'

/**
 * Issue #139: "no-secrets-in-stdout assertion (regression: token leak)".
 *
 * Bootstrap credentials arrive via `--connection-bootstrap` / `--connection-mapping-file` and are
 * forwarded to the destination, but they must never be echoed back to the operator. The widest leak
 * path is `--json`, which prints a destination response verbatim and would carry a credential if the
 * server quoted the submitted payload back in a validation error.
 */
describe('no secrets on stdout (#139)', () => {
    it('collects every string leaf of a bootstrap credential, including nested ones', () => {
        const secrets = collectSecretValues([
            { sourceExternalId: 'a', value: { access_token: SLACK_TOKEN } },
            { sourceExternalId: 'b', value: { nested: { deep: OPENAI_KEY }, list: [OPENAI_KEY] } },
            { sourceExternalId: 'c', destExternalId: 'd' },
        ])
        expect(secrets).toContain(SLACK_TOKEN)
        expect(secrets).toContain(OPENAI_KEY)
        // Repeated across two leaves, and reported once.
        expect(secrets.filter(s => s === OPENAI_KEY)).toHaveLength(1)
        // An alias-only mapping carries no credential and must not register a blank "secret" that
        // would redact every empty match.
        expect(secrets.every(s => s.length > 0)).toBe(true)
        expect(secrets).toHaveLength(2)
    })

    it('redacts each occurrence of a secret in a string', () => {
        const out = redactSecrets(`a=${SLACK_TOKEN} b=${SLACK_TOKEN}`, [SLACK_TOKEN])
        expect(out).not.toContain(SLACK_TOKEN)
        expect(out).toBe('a=[REDACTED] b=[REDACTED]')
    })

    it('never prints a bootstrap credential on the apply path', async () => {
        const console_ = captureConsole()
        try {
            const { fetch } = createFetchStub([
                { status: 200, body: {} },
                { status: 200, body: buildArtifact() },
                { status: 200, body: { applied: { flows: 1 }, failed: [] } },
            ])
            const code = await runProjectReplace({
                sourceUrl: SOURCE_BASE,
                sourceToken: SOURCE_TOKEN,
                sourceProject: SOURCE_PROJECT,
                destUrl: DEST_BASE,
                destToken: DEST_TOKEN,
                destProject: DEST_PROJECT,
                connectionBootstrap: JSON.stringify({ sourceExternalId: 'slack-main', value: { access_token: SLACK_TOKEN } }),
            }, { fetch })

            expect(code).toBe(0)
            expect(console_.output()).not.toContain(SLACK_TOKEN)
        }
        finally {
            console_.restore()
        }
    })

    it('never prints a bootstrap credential on the dry-run path', async () => {
        const console_ = captureConsole()
        try {
            const { fetch } = createFetchStub([
                { status: 200, body: {} },
                { status: 200, body: buildArtifact() },
            ])
            await runProjectReplace({
                sourceUrl: SOURCE_BASE,
                sourceToken: SOURCE_TOKEN,
                sourceProject: SOURCE_PROJECT,
                destUrl: DEST_BASE,
                destToken: DEST_TOKEN,
                destProject: DEST_PROJECT,
                dryRun: true,
                connectionBootstrap: JSON.stringify({ sourceExternalId: 'openai', value: { api_key: OPENAI_KEY } }),
            }, { fetch })

            const output = console_.output()
            expect(output).not.toContain(OPENAI_KEY)
            // The count line still reports that a credential was supplied, without revealing it.
            expect(output).toContain('[REDACTED]')
        }
        finally {
            console_.restore()
        }
    })

    it('scrubs a credential that a destination error response quotes back in --json mode', async () => {
        const console_ = captureConsole()
        try {
            // A destination that echoes the submitted bootstrap inside its validation error.
            const { fetch } = createFetchStub([
                { status: 200, body: {} },
                { status: 400, body: { error: 'rejected', submitted: { value: { access_token: SLACK_TOKEN } } } },
            ])
            await runProjectReplace({
                sourceUrl: SOURCE_BASE,
                sourceToken: SOURCE_TOKEN,
                sourceProject: SOURCE_PROJECT,
                destUrl: DEST_BASE,
                destToken: DEST_TOKEN,
                destProject: DEST_PROJECT,
                json: true,
                connectionBootstrap: JSON.stringify({ sourceExternalId: 'slack-main', value: { access_token: SLACK_TOKEN } }),
            }, { fetch })

            expect(console_.output()).not.toContain(SLACK_TOKEN)
        }
        finally {
            console_.restore()
        }
    })

    it('never prints the source or destination bearer tokens', async () => {
        const console_ = captureConsole()
        try {
            const { fetch } = createFetchStub([
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
            }, { fetch })

            const output = console_.output()
            expect(output).not.toContain(SOURCE_TOKEN)
            expect(output).not.toContain(DEST_TOKEN)
        }
        finally {
            console_.restore()
        }
    })

    it('still forwards the credential to the destination — redaction is output-only', async () => {
        const console_ = captureConsole()
        try {
            const { fetch, calls } = createFetchStub([
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
                connectionBootstrap: JSON.stringify({ sourceExternalId: 'slack-main', value: { access_token: SLACK_TOKEN } }),
            }, { fetch })

            // A redactor that also rewrote the request body would make the command useless; the
            // credential must still reach the API.
            const planBody = JSON.stringify(calls[1].body)
            expect(planBody).toContain(SLACK_TOKEN)
        }
        finally {
            console_.restore()
        }
    })

    it('parses bootstrap credentials from the flag so they are known to the redactor', () => {
        const mappings = parseConnectionMappings({
            destUrl: DEST_BASE,
            destToken: DEST_TOKEN,
            destProject: DEST_PROJECT,
            connectionBootstrap: JSON.stringify({ sourceExternalId: 'slack-main', value: { access_token: SLACK_TOKEN } }),
        })
        expect(collectSecretValues(mappings)).toContain(SLACK_TOKEN)
    })
})
