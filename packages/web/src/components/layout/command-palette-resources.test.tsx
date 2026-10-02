import { describe, expect, it } from 'vitest'
import type { AppConnection, Execution, ScheduledTask, TriggerBinding } from '@/lib/api/types'
import {
  buildResourceMatches,
  MAX_RESULTS_PER_KIND,
  totalMatches,
} from './command-palette-resources'

/**
 * Issue #189: the palette listed only static navigation destinations, so an operator with dozens of
 * bindings, schedules and connections had to remember which page held what. The matching rules are
 * pure, so they are tested without rendering; the component tests cover the wiring.
 */

function binding(overrides: Partial<TriggerBinding> = {}): TriggerBinding {
  return {
    id: 'tb_1',
    pieceName: '@inboxfm-connect/piece-slack',
    triggerName: 'New Message',
    status: 'ENABLED',
    ...overrides,
  } as TriggerBinding
}

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'st_1',
    prompt: 'Daily revenue digest',
    cronExpression: '0 9 * * *',
    status: 'ENABLED',
    ...overrides,
  } as ScheduledTask
}

function connection(overrides: Partial<AppConnection> = {}): AppConnection {
  return {
    id: 'conn_1',
    displayName: 'Slack Prod',
    pieceName: '@inboxfm-connect/piece-slack',
    status: 'ACTIVE',
    ...overrides,
  } as AppConnection
}

function execution(overrides: Partial<Execution> = {}): Execution {
  return {
    id: 'ex_1',
    prompt: 'Summarize the incident',
    status: 'SUCCEEDED',
    ...overrides,
  } as Execution
}

function build(search: string, overrides: Partial<Parameters<typeof buildResourceMatches>[0]> = {}) {
  return buildResourceMatches({
    search,
    bindings: [binding()],
    scheduledTasks: [task()],
    connections: [connection()],
    executions: [execution()],
    ...overrides,
  })
}

describe('buildResourceMatches', () => {
  it('returns nothing for an empty term, so the palette is not cluttered before typing', () => {
    expect(totalMatches(build(''))).toBe(0)
    expect(totalMatches(build('   '))).toBe(0)
  })

  it('matches a trigger binding by trigger name and deep-links to its detail page', () => {
    const groups = build('message')

    expect(groups.binding).toHaveLength(1)
    expect(groups.binding[0].label).toBe('New Message')
    expect(groups.binding[0].to).toBe('/automations/triggers/tb_1')
  })

  it('matches a scheduled task by prompt and deep-links to its detail page', () => {
    const groups = build('revenue')

    expect(groups.schedule).toHaveLength(1)
    expect(groups.schedule[0].to).toBe('/automations/schedules/st_1')
  })

  it('matches a scheduled task by cron expression', () => {
    const groups = build('0 9 * *')

    expect(groups.schedule).toHaveLength(1)
    expect(groups.schedule[0].sublabel).toBe('0 9 * * *')
  })

  it('matches a connection by display name and deep-links to its detail page', () => {
    const groups = build('slack prod')

    expect(groups.connection).toHaveLength(1)
    expect(groups.connection[0].to).toBe('/connections/conn_1')
  })

  it('matches an execution by prompt and deep-links to the activity detail page', () => {
    const groups = build('incident')

    expect(groups.execution).toHaveLength(1)
    expect(groups.execution[0].to).toBe('/activity/ex_1')
  })

  it('matches case-insensitively', () => {
    expect(totalMatches(build('SLACK'))).toBeGreaterThan(0)
    expect(totalMatches(build('sLaCk'))).toBeGreaterThan(0)
  })

  it('surfaces hits across several kinds at once', () => {
    // 'slack' appears in the binding's pieceName and the connection's displayName/pieceName.
    const groups = build('slack')

    expect(groups.binding.length).toBeGreaterThan(0)
    expect(groups.connection.length).toBeGreaterThan(0)
    expect(totalMatches(groups)).toBeGreaterThan(1)
  })

  it('returns nothing when the term matches no resource', () => {
    expect(totalMatches(build('zzzz-no-such-thing'))).toBe(0)
  })

  it('matches on id so a copied id still finds the resource', () => {
    expect(totalMatches(build('conn_1'))).toBe(1)
  })

  it('caps hits per kind so one busy collection cannot bury the palette', () => {
    const many = Array.from({ length: 12 }, (_unused, index) =>
      binding({ id: `tb_${index}`, triggerName: `Slack Event ${index}` })
    )
    const groups = build('slack', { bindings: many })

    expect(groups.binding).toHaveLength(MAX_RESULTS_PER_KIND)
  })

  it('percent-encodes ids so an unusual id cannot break out of the route', () => {
    const groups = build('weird', {
      connections: [connection({ id: 'a b/c?d', displayName: 'Weird One' })],
    })

    expect(groups.connection[0].to).toBe(`/connections/${encodeURIComponent('a b/c?d')}`)
  })

  it('shortens a very long prompt so one result cannot fill the dialog', () => {
    const groups = build('long', {
      executions: [execution({ id: 'ex_long', prompt: 'x'.repeat(200) })],
    })

    expect(groups.execution[0].label.length).toBeLessThanOrEqual(60)
    expect(groups.execution[0].label.endsWith('…')).toBe(true)
  })

  it('prefers the cron over the bare id when a task has no prompt', () => {
    const groups = build('st_1', { scheduledTasks: [task({ id: 'st_1', prompt: '' })] })

    // A cron expression is a far more useful label than an opaque id.
    expect(groups.schedule[0].label).toBe('0 9 * * *')
  })

  it('falls back to the id only when there is nothing else to show', () => {
    const groups = build('st_bare', {
      scheduledTasks: [task({ id: 'st_bare', prompt: '', cronExpression: '' })],
    })

    expect(groups.schedule[0].label).toBe('st_bare')
  })

  it('gives every hit a unique key so React does not collide duplicate names', () => {
    const groups = build('duplicate', {
      connections: [
        connection({ id: 'c1', displayName: 'Duplicate' }),
        connection({ id: 'c2', displayName: 'Duplicate' }),
      ],
    })
    const keys = groups.connection.map((hit) => hit.key)

    expect(new Set(keys).size).toBe(keys.length)
  })

  it('ignores empty collections', () => {
    const groups = buildResourceMatches({
      search: 'anything',
      bindings: [],
      scheduledTasks: [],
      connections: [],
      executions: [],
    })

    expect(totalMatches(groups)).toBe(0)
  })
})

describe('totalMatches', () => {
  it('sums every kind', () => {
    expect(
      totalMatches({
        binding: [1, 2] as never,
        schedule: [1] as never,
        connection: [] as never,
        execution: [1, 1, 1] as never,
      })
    ).toBe(6)
  })
})
