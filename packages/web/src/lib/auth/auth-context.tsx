import React, { createContext, useContext, useEffect, useState } from 'react'
import { apiClient } from '../api/client'
import { Project, User } from '../api/types'

interface AuthContextType {
  user: User | null
  currentProject: Project | null
  projects: Project[]
  token: string | null
  isAuthenticated: boolean
  isLoading: boolean
  signIn: (token: string, user: User, projectId?: string) => void
  signOut: () => void
  setCurrentProject: (project: Project) => void
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(() => apiClient.getToken())
  const [user, setUser] = useState<User | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [currentProject, setCurrentProjectState] = useState<Project | null>(null)
  const [isLoading, setIsLoading] = useState<boolean>(true)

  const setCurrentProject = (project: Project) => {
    setCurrentProjectState(project)
    apiClient.setProjectId(project.id)
  }

  const signIn = (newToken: string, newUser: User, projectId?: string) => {
    apiClient.setToken(newToken)
    setToken(newToken)
    setUser(newUser)
    persistIdentity(newUser)
    if (projectId) {
      apiClient.setProjectId(projectId)
      const proj = projects.find((p) => p.id === projectId) || {
        id: projectId,
        displayName: 'Default Project',
        platformId: newUser.platformId ?? 'default',
      }
      setCurrentProjectState(proj)
    }
  }

  const signOut = () => {
    apiClient.setToken(null)
    apiClient.setProjectId(null)
    clearPersistedIdentity()
    setToken(null)
    setUser(null)
    setProjects([])
    setCurrentProjectState(null)
  }

  useEffect(() => {
    async function loadSession() {
      const storedToken = apiClient.getToken()
      if (!storedToken) {
        // In browser dev mode, automatically sign into the seeded dev account
        // so the developer console is immediately usable without manual sign-in
        if (import.meta.env.DEV && import.meta.env.MODE !== 'test') {
          try {
            const res = await apiClient.post<{
              id: string
              email: string
              firstName: string
              lastName: string
              platformRole?: string
              token: string
              projectId: string
            }>('/authentication/sign-in', {
              email: 'dev@ap.com',
              password: '12345678',
            })
            const { token: devToken, projectId: devProjectId, ...devUser } = res
            signIn(devToken, devUser, devProjectId)
            try {
              const projectsData = await apiClient.get<{ data: Project[] }>('/projects')
              if (projectsData?.data?.length) {
                setProjects(projectsData.data)
                const matched = projectsData.data.find((p) => p.id === devProjectId) || projectsData.data[0]
                if (matched) setCurrentProject(matched)
              }
            } catch {
              // Ignore projects fetch error in dev fallback
            }
            setIsLoading(false)
            return
          } catch {
            // Auto-login failed, fall through to unauthenticated state
          }
        }

        setUser(null)
        setProjects([])
        setCurrentProjectState(null)
        setIsLoading(false)
        return
      }

      try {
        const persistedIdentity = readPersistedIdentity()
        const projectsData = await apiClient.get<{ data: Project[] }>('/projects')
        const loadedProjects = projectsData.data || []
        setProjects(loadedProjects)

        const storedProjectId = apiClient.getProjectId()
        const matched = loadedProjects.find((p) => p.id === storedProjectId) || loadedProjects[0]
        if (matched) {
          setCurrentProject(matched)
        }

        // Only the authorization-relevant identity survives a reload. Email and name stay in
        // memory for the current page view and are never written to storage, so consumers render
        // their neutral placeholder until the next sign-in (issue #383).
        setUser({
          ...(persistedIdentity ?? { id: 'session', platformId: null, platformRole: null }),
          email: '',
          firstName: '',
          lastName: '',
        })
      } catch (err) {
        console.warn('Session load failed, clearing session', err)
        signOut()
      } finally {
        setIsLoading(false)
      }
    }

    void loadSession()
  }, [])

  return (
    <AuthContext.Provider
      value={{
        user,
        currentProject,
        projects,
        token,
        isAuthenticated: Boolean(user && token),
        isLoading,
        signIn,
        signOut,
        setCurrentProject,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useOptionalAuth(): AuthContextType | undefined {
  return useContext(AuthContext)
}

export function useAuth(): AuthContextType {
  const context = useOptionalAuth()
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}

const IDENTITY_KEY = 'ap-user'

/**
 * Only the fields the UI needs to authorize itself are persisted. Email and name are deliberately
 * dropped: `localStorage` is readable by any script on the origin, so writing PII there parks it
 * for anything that ever runs on the page (issue #383). `platformId`/`platformRole` add no
 * privilege beyond the session JWT the browser already holds — they only stop the console from
 * rendering admin-gated surfaces wrongly after a reload — so keeping them costs no exposure.
 */
type PersistedIdentity = Pick<User, 'id' | 'platformId' | 'platformRole'>

function persistIdentity(user: User): void {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(toPersistedIdentity(user)))
}

function readPersistedIdentity(): PersistedIdentity | null {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(IDENTITY_KEY)
    if (!raw) return null
    try {
        const parsed: unknown = JSON.parse(raw)
        if (typeof parsed !== 'object' || parsed === null || !('id' in parsed)) {
            return null
        }
        const identity = toPersistedIdentity(parsed)
        // Rewrite immediately so a copy written by an older build — which carried email and name —
        // is shrunk to the projection instead of lingering on disk.
        persistIdentity(identity)
        return identity
    }
    catch {
        return null
    }
}

function toPersistedIdentity(user: User): PersistedIdentity {
    return {
        id: user.id,
        platformId: user.platformId ?? null,
        platformRole: user.platformRole ?? null,
    }
}

function clearPersistedIdentity(): void {
    if (typeof localStorage === 'undefined') return
    localStorage.removeItem(IDENTITY_KEY)
}
