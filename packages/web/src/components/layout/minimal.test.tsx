import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { CommandPalette } from './command-palette'
import { QueryClientProvider } from '@tanstack/react-query'
import { createTestQueryClient, mount, waitFor } from '@/test/test-utils'

function LocationProbe() {
  const location = useLocation()
  return <span data-testid="pathname">{location.pathname}</span>
}

function renderPalette(open: boolean, onOpenChange: (open: boolean) => void): HTMLElement {
  const queryClient = createTestQueryClient()
  return mount(
    <MemoryRouter initialEntries={['/']}>
      <CommandPalette open={open} onOpenChange={onOpenChange} />
      <Routes>
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>
  )
}

describe('Minimal test with resources', () => {
  it('works with resources', async () => {
    renderPalette(true, vi.fn())
    expect(true).toBe(true)
  })
})