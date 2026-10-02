import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apiClient } from '@/lib/api/client'
import { AuthProvider, useAuth } from '@/lib/auth/auth-context'
import { stubApi } from '@/test/api-stub'
import { mount, waitFor } from '@/test/test-utils'

/**
 * Regression coverage for two defects a real browser click-through surfaced that the
 * API-stubbed page tests could not:
 *
 *  A. Session restore hit `GET /users/me`, which the backend does not expose (only
 *     `GET /users/:id` and `POST /users/me`). It always 400'd, dropping every real
 *     session into the local dev-mock fallback — which then overwrote the real
 *     `projectId` with `proj_default` and 404'd every project-scoped read.
 *  B. `signIn` receives the FLAT sign-in payload (user fields + token + projectId at
 *     the top level, no nested `user`), so the stored identity must be the payload
 *     itself, not a `.user` sub-object.
 */

let capturedAuth: ReturnType<typeof useAuth> | null = null

function AuthProbe() {
  capturedAuth = useAuth()
  return null
}

function renderAuth() {
  return mount(
    <AuthProvider>
      <AuthProbe />
    </AuthProvider>
  )
}

const REAL_PROJECT_ID = 'aI8Kiljzb25GOgHm90NZu'
const REAL_USER = {
  id: '011YVTRotpxPKCl8hx0Tx',
  email: 'dev@ap.com',
  firstName: 'Ash',
  lastName: 'Dev',
  platformId: 'yM3YotgCYYZwTkVkYS20h',
}

beforeEach(() => {
  localStorage.clear()
  apiClient.setToken(null)
  apiClient.setProjectId(null)
  capturedAuth = null
})

afterEach(() => {
  localStorage.clear()
})

describe('auth session restore', () => {
  it('shrinks a legacy PII-bearing ap-user to the non-privileged projection', async () => {
    // The apiClient is a singleton that cached storage at import time, so seed it
    // through its setters (which loadSession reads via apiClient.getToken/getProjectId).
    apiClient.setToken('real-jwt')
    apiClient.setProjectId(REAL_PROJECT_ID)
    // A copy as written by a pre-#383 build: full user object, PII included.
    localStorage.setItem('ap-user', JSON.stringify(REAL_USER))

    const { calls } = stubApi([
      {
        match: (url) => url.pathname.endsWith('/api/v1/projects'),
        respond: () => ({
          status: 200,
          body: { data: [{ id: REAL_PROJECT_ID, displayName: 'InboxFM Main Project', platformId: REAL_USER.platformId }] },
        }),
      },
    ])

    renderAuth()
    await waitFor(() => capturedAuth?.isLoading === false)

    expect(calls.some((c) => c.includes('/users/me'))).toBe(false)
    expect(capturedAuth?.isAuthenticated).toBe(true)
    expect(capturedAuth?.currentProject?.id).toBe(REAL_PROJECT_ID)
    // The dev-mock project must never clobber a valid restored session.
    expect(capturedAuth?.currentProject?.id).not.toBe('proj_default')
    expect(apiClient.getProjectId()).toBe(REAL_PROJECT_ID)

    // Issue #383: the stored blob is rewritten to the projection on sight, so the PII an older
    // build left at rest is removed instead of lingering, and it is never rehydrated in memory.
    const stored = JSON.parse(localStorage.getItem('ap-user') as string)
    expect(Object.keys(stored).sort()).toEqual(['id', 'platformId', 'platformRole'])
    expect(capturedAuth?.user?.email).toBe('')
    expect(capturedAuth?.user?.firstName).toBe('')
    expect(storageDump()).not.toContain(REAL_USER.email)
    expect(storageDump()).not.toContain(REAL_USER.firstName)
  })

  it('keeps the user PII in memory only and restores only the role', async () => {
    stubApi([
      {
        match: (url) => url.pathname.endsWith('/api/v1/projects'),
        respond: () => ({
          status: 200,
          body: { data: [{ id: REAL_PROJECT_ID, displayName: 'InboxFM Main Project', platformId: REAL_USER.platformId }] },
        }),
      },
    ])

    renderAuth()
    await waitFor(() => capturedAuth?.isLoading === false)

    // Mirrors login.tsx: the response is flat, so the whole object (sans token/projectId)
    // is the user.
    act(() => {
      capturedAuth!.signIn('real-jwt', REAL_USER, REAL_PROJECT_ID)
    })

    // The signed-in page view still has the real identity…
    expect(capturedAuth?.user?.id).toBe(REAL_USER.id)
    expect(capturedAuth?.user?.email).toBe(REAL_USER.email)
    // …but only the authorization-relevant projection is persisted. platformRole must survive a
    // reload or admin-gated surfaces render as locked; email and name must not.
    expect(JSON.parse(localStorage.getItem('ap-user') as string)).toEqual({
      id: REAL_USER.id,
      platformId: REAL_USER.platformId,
      // Absent on the fixture; the projection normalizes it so the stored shape is stable.
      platformRole: null,
    })
    expect(storageDump()).not.toContain(REAL_USER.email)
    expect(storageDump()).not.toContain(REAL_USER.firstName)
    // Token + project moved to sessionStorage (issue #383)
    expect(sessionStorage.getItem('ap-token')).toBe('real-jwt')
    expect(sessionStorage.getItem('ap-project-id')).toBe(REAL_PROJECT_ID)
    expect(localStorage.getItem('ap-token')).toBeNull()
  })

  it('signOut clears any legacy persisted identity', async () => {
    apiClient.setToken('real-jwt')
    apiClient.setProjectId(REAL_PROJECT_ID)
    localStorage.setItem('ap-user', JSON.stringify(REAL_USER))

    stubApi([
      {
        match: (url) => url.pathname.endsWith('/api/v1/projects'),
        respond: () => ({ status: 200, body: { data: [] } }),
      },
    ])

    renderAuth()
    await waitFor(() => capturedAuth?.isLoading === false)

    act(() => {
      capturedAuth!.signOut()
    })

    expect(localStorage.getItem('ap-user')).toBeNull()
    expect(localStorage.getItem('ap-token')).toBeNull()
    expect(localStorage.getItem('ap-project-id')).toBeNull()
    expect(capturedAuth?.isAuthenticated).toBe(false)
  })
})

// Everything currently sitting in either web storage, so a test can assert that a specific value
// is nowhere on disk rather than checking one known key at a time.
function storageDump(): string {
  const entries: Record<string, string | null> = {}
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i)
    if (key !== null) entries[`local:${key}`] = localStorage.getItem(key)
  }
  for (let i = 0; i < sessionStorage.length; i += 1) {
    const key = sessionStorage.key(i)
    if (key !== null) entries[`session:${key}`] = sessionStorage.getItem(key)
  }
  return JSON.stringify(entries)
}
