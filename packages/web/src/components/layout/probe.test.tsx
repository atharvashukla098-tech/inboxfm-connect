import { act } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { QueryClientProvider } from '@tanstack/react-query'
import { CommandPalette } from './command-palette'
import { buildResourceMatches } from './command-palette-resources'
import { apiClient } from '@/lib/api/client'
import { stubApi, StubRoute } from '@/test/api-stub'
import { testProject } from '@/test/fixtures/api-keys'
import { createTestQueryClient, mount, waitFor } from '@/test/test-utils'

function Probe() {
  const l = useLocation()
  return <span data-testid="pathname">{l.pathname}</span>
}

describe('PROBE', () => {
  it('shows what actually happened', async () => {
    apiClient.setToken('test-token')
    apiClient.setProjectId(testProject().id)
    const routes: StubRoute[] = [
      { match: (u) => u.pathname.includes('trigger-bindings'), respond: () => ({ status: 200, body: { data: [{ id: 'tb_slack', pieceName: 'piece-slack', triggerName: 'New Slack Message', status: 'ENABLED' }] } }) },
      { match: (u) => u.pathname.includes('scheduled-tasks'), respond: () => ({ status: 200, body: { data: [] } }) },
      { match: (u) => u.pathname.includes('/connections'), respond: () => ({ status: 200, body: { data: [{ id: 'conn_1', displayName: 'Slack Prod', pieceName: 'piece-slack', status: 'ACTIVE' }] } }) },
      { match: (u) => u.pathname.includes('/executions'), respond: () => ({ status: 200, body: { data: [] } }) },
    ]
    const stub = stubApi(routes)
    const qc = createTestQueryClient()
    mount(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/']}>
          <CommandPalette open onOpenChange={vi.fn()} />
          <Routes><Route path="*" element={<Probe />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )
    await waitFor(() => document.querySelector('[cmdk-input]') !== null)
    const input = document.querySelector<HTMLInputElement>('[cmdk-input]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'Slack')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await new Promise((r) => setTimeout(r, 400))
    console.log('=== FETCH CALLS ===')
    stub.calls.forEach((c) => console.log('   ' + c))
    console.log('=== cmdk-item count: ' + document.querySelectorAll('[cmdk-item]').length)
    console.log('=== items: ' + Array.from(document.querySelectorAll('[cmdk-item]')).map((i) => i.textContent).join(' | '))
    console.log('=== cmdk-input value: ' + (document.querySelector('[cmdk-input]') as HTMLInputElement)?.value)
    console.log('=== ALL items (incl hidden): ' + Array.from(document.querySelectorAll('[cmdk-item]')).map((i) => JSON.stringify({t: i.textContent, hidden: i.getAttribute('hidden') !== null, aria: i.getAttribute('aria-selected')})).join(' ;; '))
    console.log('=== body contains New Slack Message: ' + (document.body.textContent?.includes('New Slack Message') ?? false))
    const groups = buildResourceMatches({
      search: 'Slack',
      bindings: [{ id: 'tb_slack', pieceName: 'piece-slack', triggerName: 'New Slack Message', status: 'ENABLED' } as never],
      scheduledTasks: [],
      connections: [{ id: 'conn_1', displayName: 'Slack Prod', pieceName: 'piece-slack', status: 'ACTIVE' } as never],
      executions: [],
    })
    console.log('=== PURE binding hits: ' + JSON.stringify(groups.binding))
    expect(true).toBe(true)
  })
})
