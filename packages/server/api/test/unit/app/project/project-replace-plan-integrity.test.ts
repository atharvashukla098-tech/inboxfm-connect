import crypto from 'crypto'
import { ConnectionMappingSchema, ProjectReplacePlan } from '@inboxfm-connect/shared'
import { describe, expect, it } from 'vitest'
import { projectReplaceTesting } from '../../../../src/app/project/replace/project-replace.service'

const {
    canonicalJson,
    computePlanSignature,
    sanitizeMappingForPlan,
    getSigningSecret,
} = projectReplaceTesting

describe('project-replace plan signing & integrity (Issue #126)', () => {
    describe('canonicalJson', () => {
        it('serializes objects with keys in sorted deterministic order', () => {
            const objA = { z: 1, a: 2, m: { y: 'hello', b: 'world' } }
            const objB = { a: 2, m: { b: 'world', y: 'hello' }, z: 1 }

            expect(canonicalJson(objA)).toBe('{"a":2,"m":{"b":"world","y":"hello"},"z":1}')
            expect(canonicalJson(objA)).toBe(canonicalJson(objB))
        })

        it('handles arrays, nulls, and primitives consistently', () => {
            expect(canonicalJson([3, 2, 1])).toBe('[3,2,1]')
            expect(canonicalJson(null)).toBe('null')
            expect(canonicalJson('test')).toBe('"test"')
            expect(canonicalJson(123)).toBe('123')
            expect(canonicalJson(true)).toBe('true')
        })

        it('ignores undefined values on object properties', () => {
            const objWithUndefined = { a: 1, b: undefined, c: 3 }
            expect(canonicalJson(objWithUndefined)).toBe('{"a":1,"c":3}')
        })
    })

    describe('sanitizeMappingForPlan', () => {
        it('strips sensitive connection values while preserving mapping coordinates', () => {
            const rawMapping: ConnectionMappingSchema = {
                sourceExternalId: 'slack-source',
                destExternalId: 'slack-dest',
                destConnectionId: 'conn-123',
                pieceName: '@inboxfm-connect/piece-slack',
                type: 'SECRET_TEXT' as const,
                displayName: 'Slack Connection',
                value: 'secret-token-xyz' as unknown as Record<string, unknown>,
            }

            const sanitized = sanitizeMappingForPlan(rawMapping)
            expect(sanitized).not.toHaveProperty('value')
            expect(sanitized).toEqual({
                sourceExternalId: 'slack-source',
                destExternalId: 'slack-dest',
                destConnectionId: 'conn-123',
                pieceName: '@inboxfm-connect/piece-slack',
                type: 'SECRET_TEXT',
                displayName: 'Slack Connection',
            })
        })
    })

    describe('computePlanSignature & tamper rejection', () => {
        const createSamplePlan = (): Omit<ProjectReplacePlan, 'signature'> => ({
            planId: 'plan-001',
            schemaVersion: 1,
            toolVersion: '1.0.0',
            createdAt: '2026-01-01T00:00:00.000Z',
            sourceActivepiecesVersion: '0.86.0',
            targetActivepiecesVersion: '0.86.0',
            targetProjectId: 'proj-dest-1',
            checksum: 'sha256:abcd1234abcd1234',
            destinationStateHash: 'hash-xyz-987',
            preflight: {
                passed: true,
                errors: [],
                warnings: [],
            },
            connectionMappings: [
                {
                    sourceExternalId: 'conn-a',
                    destExternalId: 'conn-b',
                    destConnectionId: 'dest-conn-id',
                    pieceName: '@inboxfm-connect/piece-slack',
                    type: 'SECRET_TEXT' as const,
                    displayName: 'Slack Integration',
                },
            ],
            changes: {
                creates: [{ kind: 'table', externalId: 'tbl-1' }],
                updates: [],
                deletes: [],
                unchanged: [],
            },
            summary: {
                totalCreates: 1,
                totalUpdates: 0,
                totalDeletes: 0,
                totalUnchanged: 0,
            },
        })

        it('generates consistent HMAC-SHA256 signature for identical plan content', () => {
            const planA = createSamplePlan()
            const planB = createSamplePlan()

            const sigA = computePlanSignature(planA)
            const sigB = computePlanSignature(planB)

            expect(sigA).toBe(sigB)
            expect(sigA).toMatch(/^[a-f0-9]{64}$/)
        })

        it('rejects tampered plan with any byte flipped in changes', () => {
            const basePlan = createSamplePlan()
            const originalSig = computePlanSignature(basePlan)

            const tamperedPlan = createSamplePlan()
            tamperedPlan.changes.creates.push({ kind: 'agent', externalId: 'injected-evil-agent' })
            const tamperedSig = computePlanSignature(tamperedPlan)

            expect(tamperedSig).not.toBe(originalSig)

            // Verify timingSafeEqual detection
            const origBuf = Buffer.from(originalSig, 'hex')
            const tamperedBuf = Buffer.from(tamperedSig, 'hex')
            expect(crypto.timingSafeEqual(origBuf, tamperedBuf)).toBe(false)
        })

        it('rejects tampered destination project ID or destination state hash (anti-replay)', () => {
            const basePlan = createSamplePlan()
            const originalSig = computePlanSignature(basePlan)

            const replayedPlan = createSamplePlan()
            replayedPlan.targetProjectId = 'proj-different-victim'
            const replayedSig = computePlanSignature(replayedPlan)

            expect(replayedSig).not.toBe(originalSig)

            const driftedPlan = createSamplePlan()
            driftedPlan.destinationStateHash = 'different-destination-state'
            const driftedSig = computePlanSignature(driftedPlan)

            expect(driftedSig).not.toBe(originalSig)
        })

        it('rejects tampered preflight flags or checksums', () => {
            const basePlan = createSamplePlan()
            const originalSig = computePlanSignature(basePlan)

            const tamperedPreflight = createSamplePlan()
            tamperedPreflight.preflight.passed = false
            const preflightSig = computePlanSignature(tamperedPreflight)
            expect(preflightSig).not.toBe(originalSig)

            const tamperedChecksum = createSamplePlan()
            tamperedChecksum.checksum = 'sha256:corrupted'
            const checksumSig = computePlanSignature(tamperedChecksum)
            expect(checksumSig).not.toBe(originalSig)
        })

        it('binds provider mappings, so a plan cannot be re-pointed at another provider', () => {
            // Provider mappings decide which AI provider each mirrored agent is created against.
            // While they sat outside the canonical payload, a legitimately signed plan could be
            // applied with different providers than the reviewer approved.
            const withProviders = createSamplePlan()
            withProviders.providerMappings = [
                { sourceProvider: 'openai', destProvider: 'azure-openai' },
            ]
            const signed = computePlanSignature(withProviders)

            const swapped = createSamplePlan()
            swapped.providerMappings = [
                { sourceProvider: 'openai', destProvider: 'attacker-endpoint' },
            ]
            const swappedSig = computePlanSignature(swapped)

            expect(swappedSig).not.toBe(signed)
            expect(crypto.timingSafeEqual(Buffer.from(signed, 'hex'), Buffer.from(swappedSig, 'hex'))).toBe(false)
        })

        it('binds the empty provider-mapping set too, so adding one always changes the signature', () => {
            const withoutProviders = createSamplePlan()
            const baseSig = computePlanSignature(withoutProviders)

            const withEmptyArray = createSamplePlan()
            withEmptyArray.providerMappings = []
            const emptySig = computePlanSignature(withEmptyArray)

            const withOne = createSamplePlan()
            withOne.providerMappings = [{ sourceProvider: 'openai', destProvider: 'openai' }]
            const oneSig = computePlanSignature(withOne)

            // An absent set and an explicitly empty set are the same claim, so they must agree...
            expect(emptySig).toBe(baseSig)
            // ...but any real mapping must not.
            expect(oneSig).not.toBe(baseSig)
        })
    })

    describe('fail-closed signing secret (Issue #126)', () => {
        /**
         * `getSigningSecret` reads the dedicated prop, then the two env vars, then JWT_SECRET. The
         * suite runs with AP_JWT_SECRET set, so the unconfigured case has to be simulated by
         * clearing all three, and everything restored afterwards so the other suites in this file
         * still sign normally.
         */
        function withNoSigningSecret<T>(fn: () => T): T {
            const envKeys = [
                'PROJECT_REPLACE_SIGNING_SECRET',
                'AP_PROJECT_REPLACE_SIGNING_SECRET',
                'AP_JWT_SECRET',
                'JWT_SECRET',
            ] as const
            const saved = envKeys.map(key => process.env[key])
            for (const key of envKeys) Reflect.deleteProperty(process.env, key)
            try {
                return fn()
            }
            finally {
                envKeys.forEach((key, index) => {
                    const value = saved[index]
                    if (value === undefined) Reflect.deleteProperty(process.env, key)
                    else process.env[key] = value
                })
            }
        }

        it('throws rather than signing with a default when no secret is configured', () => {
            // A silent fallback to a hardcoded or empty secret would let anyone forge plan artifacts.
            // The throw is the security property, so it is asserted directly.
            withNoSigningSecret(() => {
                expect(() => getSigningSecret()).toThrow(/Signing secret is not configured/)
            })
        })

        it('propagates the throw out of computePlanSignature rather than producing a signature', () => {
            withNoSigningSecret(() => {
                expect(() => computePlanSignature({
                    planId: 'plan-001',
                    schemaVersion: 1,
                    toolVersion: '1.0.0',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    sourceActivepiecesVersion: '0.86.0',
                    targetActivepiecesVersion: '0.86.0',
                    targetProjectId: 'proj-dest-1',
                    checksum: 'sha256:abcd',
                    destinationStateHash: 'hash-xyz',
                    preflight: { passed: true, errors: [], warnings: [] },
                    connectionMappings: [],
                    providerMappings: [],
                    changes: { creates: [], updates: [], deletes: [], unchanged: [] },
                    summary: { totalCreates: 0, totalUpdates: 0, totalDeletes: 0, totalUnchanged: 0 },
                })).toThrow(/Signing secret is not configured/)
            })
        })

        it('names both supported configuration sources in the failure message', () => {
            withNoSigningSecret(() => {
                let message = ''
                try {
                    getSigningSecret()
                }
                catch (error) {
                    message = (error as Error).message
                }
                expect(message).toContain('PROJECT_REPLACE_SIGNING_SECRET')
                expect(message).toContain('JWT_SECRET')
            })
        })

        it('still signs when a secret is present, so the throw above is not vacuous', () => {
            expect(() => getSigningSecret()).not.toThrow()
            expect(computePlanSignature({
                planId: 'plan-001',
                schemaVersion: 1,
                toolVersion: '1.0.0',
                createdAt: '2026-01-01T00:00:00.000Z',
                sourceActivepiecesVersion: '0.86.0',
                targetActivepiecesVersion: '0.86.0',
                targetProjectId: 'proj-dest-1',
                checksum: 'sha256:abcd',
                destinationStateHash: 'hash-xyz',
                preflight: { passed: true, errors: [], warnings: [] },
                connectionMappings: [],
                providerMappings: [],
                changes: { creates: [], updates: [], deletes: [], unchanged: [] },
                summary: { totalCreates: 0, totalUpdates: 0, totalDeletes: 0, totalUnchanged: 0 },
            })).toMatch(/^[a-f0-9]{64}$/)
        })
    })
})
