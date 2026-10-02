import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

/**
 * Issue #139: "integration smoke test against `createTestContext` API".
 *
 * The CLI's unit tests stub `fetch`, so on their own they would keep passing even if the API moved
 * a route, renamed a field, or started rejecting the payload the CLI builds. This suite drives the
 * real Fastify app and asserts the server accepts exactly the request shape the CLI emits and
 * answers in exactly the shape the CLI parses — the two halves of the contract meet here.
 *
 * The request bodies below are written by hand rather than generated from the CLI so that a change
 * on either side shows up as a failure instead of silently following along.
 */
let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment({ fresh: true })
})

afterAll(async () => {
    await teardownTestEnvironment()
})

// Mirrors the snapshot the CLI receives from GET /replace/export and hands straight to /plan.
const MINIMAL_SNAPSHOT = {
    schemaVersion: 1 as const,
    sourceActivepiecesVersion: '0.120.0',
    exportedAt: new Date().toISOString(),
    tables: [],
    triggerBindings: [],
    scheduledTasks: [],
    requiredPieces: [],
    requiredConnections: [],
}

describe('CLI project-replace contract against the live API (#139)', () => {
    let ctx: TestContext

    beforeAll(async () => {
        ctx = await createTestContext(app!)
    })

    it('exports a snapshot in the shape the CLI forwards to /plan', async () => {
        const res = await ctx.get(`/v1/projects/${ctx.project.id}/replace/export`)

        expect(res.statusCode).toBe(StatusCodes.OK)
        const snapshot = res.json()
        // Every field the CLI's own fixture and its zod validation rely on.
        expect(snapshot).toMatchObject({
            schemaVersion: 1,
            sourceActivepiecesVersion: expect.any(String),
            exportedAt: expect.any(String),
            tables: expect.any(Array),
            triggerBindings: expect.any(Array),
            scheduledTasks: expect.any(Array),
            requiredPieces: expect.any(Array),
            requiredConnections: expect.any(Array),
        })
    })

    it('accepts the bare-snapshot /plan body the CLI sends when no mappings are supplied', async () => {
        const res = await ctx.post(`/v1/projects/${ctx.project.id}/replace/plan`, {
            snapshot: MINIMAL_SNAPSHOT,
        })

        // An empty project plans cleanly, so the destination answers 200 with the artifact envelope.
        expect(res.statusCode).toBe(StatusCodes.OK)
        expect(res.json()).toMatchObject({
            artifactVersion: 1,
            toolVersion: expect.any(String),
            snapshot: expect.any(Object),
            plan: {
                planId: expect.any(String),
                checksum: expect.any(String),
                signature: expect.any(String),
                preflight: { passed: expect.any(Boolean), errors: expect.any(Array) },
                summary: {
                    created: expect.any(Number),
                    updated: expect.any(Number),
                    deleted: expect.any(Number),
                    unchanged: expect.any(Number),
                },
            },
        })
    })

    it('accepts the connectionMappings and providerMappings the CLI now sends', async () => {
        const res = await ctx.post(`/v1/projects/${ctx.project.id}/replace/plan`, {
            snapshot: MINIMAL_SNAPSHOT,
            connectionMappings: [{ sourceExternalId: 'conn-a', destExternalId: 'conn-b' }],
            providerMappings: [{ sourceProvider: 'OldPiece', destProvider: 'NewPiece' }],
        })

        expect(res.statusCode).toBe(StatusCodes.OK)
        expect(res.json().plan.preflight.passed).toBe(true)
    })

    it('accepts a bootstrap credential mapping of the shape --connection-bootstrap produces', async () => {
        // The CLI forwards `{ sourceExternalId, value }` for a bootstrap entry; the API must take it
        // rather than rejecting or reshaping it.
        const res = await ctx.post(`/v1/projects/${ctx.project.id}/replace/plan`, {
            snapshot: {
                ...MINIMAL_SNAPSHOT,
                requiredConnections: [{ externalId: 'conn-a', pieceName: '@inboxfm-connect/piece-slack' }],
            },
            connectionMappings: [
                { sourceExternalId: 'conn-a', value: { access_token: 'xoxb-cli-smoke' } },
            ],
        })

        expect(res.statusCode).toBe(StatusCodes.OK)
        expect(res.json().plan.preflight.passed).toBe(true)
        // The preflight report is where the CLI reads the "Connections" summary block from.
        expect(res.json().plan.preflight.connections).toMatchObject({
            required: expect.any(Array),
            matched: expect.any(Array),
            missing: expect.any(Array),
            mapped: expect.any(Array),
        })
    })

    it('answers /inspect with the applied/failed shape the CLI reads on the dry-run path', async () => {
        const planRes = await ctx.post(`/v1/projects/${ctx.project.id}/replace/plan`, { snapshot: MINIMAL_SNAPSHOT })
        expect(planRes.statusCode).toBe(StatusCodes.OK)

        const res = await ctx.post(`/v1/projects/${ctx.project.id}/replace/inspect`, {
            plan: planRes.json().plan,
            snapshot: planRes.json().snapshot,
        })

        expect(res.statusCode).toBe(StatusCodes.OK)
        expect(res.json()).toMatchObject({
            applied: expect.any(Object),
            failed: expect.any(Array),
        })
    })

    it('answers /apply with the applied/failed/mcpCredentials shape the CLI prints', async () => {
        const planRes = await ctx.post(`/v1/projects/${ctx.project.id}/replace/plan`, { snapshot: MINIMAL_SNAPSHOT })
        expect(planRes.statusCode).toBe(StatusCodes.OK)

        const res = await ctx.post(`/v1/projects/${ctx.project.id}/replace/apply`, {
            plan: planRes.json().plan,
            snapshot: planRes.json().snapshot,
            force: false,
            deployCustomIntegrations: false,
            inspectOnly: false,
            rotateMcpToken: false,
        })

        expect([StatusCodes.OK, StatusCodes.MULTI_STATUS]).toContain(res.statusCode)
        expect(res.json()).toMatchObject({
            applied: expect.any(Object),
            failed: expect.any(Array),
        })
        // The CLI dereferences this without a guard, so the key must always be present.
        expect(res.json()).toHaveProperty('mcpCredentials')
    })

    it('refuses to apply a plan that has been altered after it was signed', async () => {
        const planRes = await ctx.post(`/v1/projects/${ctx.project.id}/replace/plan`, { snapshot: MINIMAL_SNAPSHOT })
        const plan = planRes.json().plan

        // Re-signing is the destination's job, so any client-side edit is a tampered artifact. The
        // API rejects it outright rather than applying it — and because the edit names a different
        // target project it is caught by the cross-project guard (403) before the signature check
        // even matters. The CLI maps 400/401/403/409 onto distinct exit codes, so all four are
        // acceptable "refused" answers here; the point is that none of them is a success.
        const tampered = { ...plan, targetProjectId: 'some-other-project' }

        const res = await ctx.post(`/v1/projects/${ctx.project.id}/replace/apply`, {
            plan: tampered,
            snapshot: planRes.json().snapshot,
        })

        expect([
            StatusCodes.BAD_REQUEST,
            StatusCodes.FORBIDDEN,
            StatusCodes.CONFLICT,
        ]).toContain(res.statusCode)
    })

    describe('provider mappings are bound to the signed plan (Issue #126)', () => {
        it('echoes the provider mappings into the signed plan artifact', async () => {
            const res = await ctx.post(`/v1/projects/${ctx.project.id}/replace/plan`, {
                snapshot: MINIMAL_SNAPSHOT,
                providerMappings: [{ sourceProvider: 'openai', destProvider: 'azure-openai' }],
            })

            expect(res.statusCode).toBe(StatusCodes.OK)
            // The reviewer sees, and signs, the provider set the plan will be applied with.
            expect(res.json().plan.providerMappings).toEqual([
                { sourceProvider: 'openai', destProvider: 'azure-openai' },
            ])
        })

        it('rejects an apply whose provider mappings differ from the signed plan', async () => {
            const planRes = await ctx.post(`/v1/projects/${ctx.project.id}/replace/plan`, {
                snapshot: MINIMAL_SNAPSHOT,
                providerMappings: [{ sourceProvider: 'openai', destProvider: 'azure-openai' }],
            })
            expect(planRes.statusCode).toBe(StatusCodes.OK)

            // The plan is untouched and still validly signed; only the apply-time provider set is
            // swapped. Before the binding this silently re-pointed every mirrored agent.
            const res = await ctx.post(`/v1/projects/${ctx.project.id}/replace/apply`, {
                plan: planRes.json().plan,
                snapshot: planRes.json().snapshot,
                providerMappings: [{ sourceProvider: 'openai', destProvider: 'attacker-endpoint' }],
            })

            expect(res.statusCode).toBe(StatusCodes.BAD_REQUEST)
            expect(res.json().message ?? res.json().error).toMatch(/provider mappings supplied at apply time do not match the signed plan/i)
        })

        it('accepts an apply that echoes the signed provider mappings unchanged', async () => {
            const providerMappings = [{ sourceProvider: 'openai', destProvider: 'azure-openai' }]
            const planRes = await ctx.post(`/v1/projects/${ctx.project.id}/replace/plan`, {
                snapshot: MINIMAL_SNAPSHOT,
                providerMappings,
            })
            expect(planRes.statusCode).toBe(StatusCodes.OK)

            const res = await ctx.post(`/v1/projects/${ctx.project.id}/replace/apply`, {
                plan: planRes.json().plan,
                snapshot: planRes.json().snapshot,
                providerMappings,
            })

            expect([StatusCodes.OK, StatusCodes.MULTI_STATUS]).toContain(res.statusCode)
        })

        it('treats a reordered but equivalent provider set as matching', async () => {
            // The comparison is order-insensitive, so a client that re-serializes its mappings in a
            // different order is not treated as tampering.
            const planRes = await ctx.post(`/v1/projects/${ctx.project.id}/replace/plan`, {
                snapshot: MINIMAL_SNAPSHOT,
                providerMappings: [
                    { sourceProvider: 'openai', destProvider: 'azure-openai' },
                    { sourceProvider: 'anthropic', destProvider: 'bedrock' },
                ],
            })
            expect(planRes.statusCode).toBe(StatusCodes.OK)

            const res = await ctx.post(`/v1/projects/${ctx.project.id}/replace/apply`, {
                plan: planRes.json().plan,
                snapshot: planRes.json().snapshot,
                providerMappings: [
                    { sourceProvider: 'anthropic', destProvider: 'bedrock' },
                    { sourceProvider: 'openai', destProvider: 'azure-openai' },
                ],
            })

            expect([StatusCodes.OK, StatusCodes.MULTI_STATUS]).toContain(res.statusCode)
        })

        it('rejects an apply that adds a provider mapping the plan never carried', async () => {
            const planRes = await ctx.post(`/v1/projects/${ctx.project.id}/replace/plan`, {
                snapshot: MINIMAL_SNAPSHOT,
            })
            expect(planRes.statusCode).toBe(StatusCodes.OK)

            const res = await ctx.post(`/v1/projects/${ctx.project.id}/replace/apply`, {
                plan: planRes.json().plan,
                snapshot: planRes.json().snapshot,
                providerMappings: [{ sourceProvider: 'openai', destProvider: 'attacker-endpoint' }],
            })

            expect(res.statusCode).toBe(StatusCodes.BAD_REQUEST)
        })
    })

    describe('--force with dangling agent tool connection refs (Issue #126)', () => {
        // An agent tool that authenticates through a connection which does not exist on the
        // destination is the agent-tool equivalent of a trigger binding pointing at a missing
        // connection. The criterion is that the two are gated alike: surfaced by preflight, waived
        // only by an explicit --force, and never reported as a clean success.
        const snapshotWithDanglingAgentTool = {
            ...MINIMAL_SNAPSHOT,
            agents: [
                {
                    externalId: 'agent-1',
                    displayName: 'Ops Agent',
                    prompt: 'help',
                    model: { provider: 'openai', model: 'gpt-4o' },
                    tools: [
                        {
                            type: 'PIECE',
                            toolName: 'send_slack',
                            pieceMetadata: {
                                pieceName: '@inboxfm-connect/piece-slack',
                                pieceVersion: '1.0.0',
                                actionName: 'sendMessage',
                                predefinedInput: {
                                    fields: { channel: { mode: 'agent-decide', value: 'C123' } },
                                    auth: '{{connections[\'missing-connection\']}}',
                                },
                            },
                        },
                    ],
                },
            ],
        }

        it('fails preflight with MISSING_CONNECTION naming the agent and its tool', async () => {
            const res = await ctx.post(`/v1/projects/${ctx.project.id}/replace/plan`, {
                snapshot: snapshotWithDanglingAgentTool,
            })

            expect(res.statusCode).toBe(StatusCodes.BAD_REQUEST)
            const preflight = res.json().plan?.preflight
            expect(preflight).toBeDefined()
            expect(preflight.passed).toBe(false)
            const missing = preflight.errors.filter((e: { kind: string }) => e.kind === 'MISSING_CONNECTION')
            expect(missing.length).toBeGreaterThan(0)
            // The message names the agent by display name; the machine-readable identity is on
            // details.agentExternalId, so both are asserted.
            expect(missing.some((e: { message: string }) => e.message.includes('Ops Agent'))).toBe(true)
            expect(missing.some((e: { message: string }) => e.message.includes('missing-connection'))).toBe(true)
            expect(missing.some((e: { details?: { agentExternalId?: string } }) => e.details?.agentExternalId === 'agent-1')).toBe(true)
        })

        it('waives the dangling ref only under an explicit --force, like trigger bindings', async () => {
            const planRes = await ctx.post(`/v1/projects/${ctx.project.id}/replace/plan`, {
                snapshot: snapshotWithDanglingAgentTool,
            })
            expect(planRes.statusCode).toBe(StatusCodes.BAD_REQUEST)
            const plan = planRes.json().plan

            // Without --force the failed preflight blocks the whole apply.
            const blocked = await ctx.post(`/v1/projects/${ctx.project.id}/replace/apply`, {
                plan,
                snapshot: planRes.json().snapshot,
                force: false,
            })
            expect(blocked.statusCode).toBe(StatusCodes.BAD_REQUEST)

            // With --force it proceeds, and the agent lands in failed[] rather than being reported
            // as applied — the same degradation a dangling trigger binding gets.
            const forced = await ctx.post(`/v1/projects/${ctx.project.id}/replace/apply`, {
                plan,
                snapshot: planRes.json().snapshot,
                force: true,
            })
            expect([StatusCodes.OK, StatusCodes.MULTI_STATUS]).toContain(forced.statusCode)
            expect(Array.isArray(forced.json().failed)).toBe(true)
        })

        it('never reports a forced apply with a dangling agent tool as fully clean', async () => {
            const planRes = await ctx.post(`/v1/projects/${ctx.project.id}/replace/plan`, {
                snapshot: snapshotWithDanglingAgentTool,
            })
            const forced = await ctx.post(`/v1/projects/${ctx.project.id}/replace/apply`, {
                plan: planRes.json().plan,
                snapshot: planRes.json().snapshot,
                force: true,
            })

            expect([StatusCodes.OK, StatusCodes.MULTI_STATUS]).toContain(forced.statusCode)
            const body = forced.json()
            // Either the agent was skipped or it failed; what must not happen is an empty failed[]
            // paired with a claimed agent create.
            const agentFailure = (body.failed ?? []).some((f: { kind: string }) => f.kind === 'agent')
            const agentCreated = (body.applied?.agents ?? 0) > 0
            expect(agentFailure || !agentCreated).toBe(true)
        })
    })
})
