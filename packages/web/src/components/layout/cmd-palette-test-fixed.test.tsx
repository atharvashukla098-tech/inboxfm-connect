import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { CommandPalette } from './command-palette'
import { QueryClientProvider } from '@tanstack/react-query'
import { createTestQueryClient, mount, waitFor } from '@/test/test-utils'
import { ThemeProvider } from '@/lib/theme/theme-provider'
import { AuthProvider } from '@/lib/auth/auth-context'

function LocationProbe() {
  const location = useLocation()
  return <span data-testid="pathname">{location.pathname}</span>
}

function renderPalette(open: boolean, onOpenChange: (open: boolean) => void): HTMLElement {
  const queryClient = createTestQueryClient()
  return mount(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light">
        <AuthProvider>
          <MemoryRouter initialEntries={['/']}>
            <CommandPalette open={open} onOpenChange={onOpenChange} />
            <Routes>
              <Route path="*" element={<LocationProbe />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}

describe('Minimal test with AuthProvider', () => {
  it('works', async () => {
    renderPalette(false, vi.fn())
    expect(true).toBe(true)
  })
})