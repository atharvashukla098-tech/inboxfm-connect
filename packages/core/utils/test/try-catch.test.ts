import { describe, expect, it } from 'vitest'
import { tryCatch, tryCatchSync } from '../src/lib/try-catch'

/**
 * Issue #141: shared/core utils are thin on tests. `tryCatch`/`tryCatchSync` are the repo's
 * Go-style error primitive, used by the API server, the CLI and the engine, and they had no tests
 * at all. The properties below are the ones callers actually rely on.
 */
describe('tryCatch (async)', () => {
    it('returns the resolved value with a null error', async () => {
        const { data, error } = await tryCatch(async () => 'ok')

        expect(data).toBe('ok')
        expect(error).toBeNull()
    })

    it('returns the error with a null data when the promise rejects', async () => {
        const boom = new Error('boom')
        const { data, error } = await tryCatch(async () => {
            throw boom
        })

        expect(data).toBeNull()
        expect(error).toBe(boom)
    })

    it('surfaces a synchronous throw from an async callback as an error, not a rejection', async () => {
        const { data, error } = await tryCatch(async () => {
            // Throwing before the first await is still a throw inside the async function.
            throw new TypeError('sync throw inside async fn')
        })

        expect(data).toBeNull()
        expect(error).toBeInstanceOf(TypeError)
    })

    it('awaits the promise rather than adopting it as the data', async () => {
        const { data, error } = await tryCatch(async () => {
            await new Promise(resolve => setTimeout(resolve, 5))
            return 'after-await'
        })

        expect(error).toBeNull()
        expect(data).toBe('after-await')
    })

    it('preserves the exact thrown value so instanceof checks still work', async () => {
        class DomainError extends Error {
            constructor(readonly code: string) {
                super(`domain: ${code}`)
            }
        }
        const thrown = new DomainError('E_DUPLICATE')

        const { error } = await tryCatch(async () => {
            throw thrown
        })

        // Wrapping the error would break every `error instanceof DomainError` in the codebase.
        expect(error).toBe(thrown)
        expect(error).toBeInstanceOf(DomainError)
        expect((error as DomainError).code).toBe('E_DUPLICATE')
    })

    it('preserves non-Error throwables instead of coercing them', async () => {
        const thrown = { code: 'PLAIN_OBJECT' }

        const { data, error } = await tryCatch(async () => {
            throw thrown
        })

        expect(data).toBeNull()
        expect(error).toBe(thrown)
    })

    it('distinguishes a falsy result from a failure', async () => {
        // A `if (!data)` style check on the result would misread these as errors.
        const zero = await tryCatch(async () => 0)
        const empty = await tryCatch(async () => '')
        const no = await tryCatch(async () => false)
        const nil = await tryCatch(async () => null)

        expect(zero).toEqual({ data: 0, error: null })
        expect(empty).toEqual({ data: '', error: null })
        expect(no).toEqual({ data: false, error: null })
        expect(nil).toEqual({ data: null, error: null })
    })

    it('returns undefined data with a null error for a void callback', async () => {
        const { data, error } = await tryCatch(async () => {
            // no return
        })

        expect(error).toBeNull()
        expect(data).toBeUndefined()
    })
})

describe('tryCatchSync', () => {
    it('returns the value with a null error', () => {
        const { data, error } = tryCatchSync(() => 'ok')

        expect(data).toBe('ok')
        expect(error).toBeNull()
    })

    it('returns the error with a null data when the callback throws', () => {
        const boom = new Error('boom')
        const { data, error } = tryCatchSync(() => {
            throw boom
        })

        expect(data).toBeNull()
        expect(error).toBe(boom)
    })

    it('preserves the exact thrown value so instanceof checks still work', () => {
        const thrown = new RangeError('out of range')
        const { error } = tryCatchSync(() => {
            throw thrown
        })

        expect(error).toBe(thrown)
        expect(error).toBeInstanceOf(RangeError)
    })

    it('preserves a thrown string, which is a common JSON.parse-adjacent mistake', () => {
        const { data, error } = tryCatchSync(() => {
            throw 'just a string'
        })

        expect(data).toBeNull()
        expect(error).toBe('just a string')
    })

    it('distinguishes a falsy result from a failure', () => {
        expect(tryCatchSync(() => 0)).toEqual({ data: 0, error: null })
        expect(tryCatchSync(() => false)).toEqual({ data: false, error: null })
        expect(tryCatchSync(() => '')).toEqual({ data: '', error: null })
    })

    it('captures JSON.parse failures, its main caller in the request schemas', () => {
        const { data, error } = tryCatchSync<unknown>(() => JSON.parse('{not json'))

        expect(data).toBeNull()
        expect(error).toBeInstanceOf(SyntaxError)
    })
})
