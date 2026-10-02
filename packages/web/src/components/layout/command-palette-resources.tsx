import { Activity, CalendarClock, KeyRound, Radio } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from '@/components/ui/command'
import {
  useConnectionsQuery,
  useExecutionsQuery,
  useScheduledTasksQuery,
  useTriggerBindingsQuery,
} from '@/lib/query/hooks'
import type {
  AppConnection,
  Execution,
  ScheduledTask,
  TriggerBinding,
} from '@/lib/api/types'

/**
 * How many hits to show per resource kind. A project with hundreds of trigger bindings would
 * otherwise bury the navigation entries the palette also has to offer, and the point of the
 * palette is a fast jump, not a data dump.
 */
export const MAX_RESULTS_PER_KIND = 5

export type PaletteResourceKind = 'binding' | 'schedule' | 'connection' | 'execution'

export interface ResourceMatch {
  key: string
  kind: PaletteResourceKind
  label: string
  sublabel: string
  to: string
}

const SHORTEN_AT = 60

function shorten(value: string): string {
  const trimmed = value.trim()
  return trimmed.length > SHORTEN_AT ? `${trimmed.slice(0, SHORTEN_AT - 1)}…` : trimmed
}

function matches(term: string, ...haystack: Array<string | undefined | null>): boolean {
  return haystack.some((value) => Boolean(value) && value!.toLowerCase().includes(term))
}

function take<T>(items: T[], limit = MAX_RESULTS_PER_KIND): T[] {
  return items.slice(0, limit)
}

/**
 * Pure: given the search term and the four resource collections, return the grouped, deep-linkable
 * hits. Kept free of React so the matching rules are unit-testable without rendering, and so the
 * component stays presentational.
 */
export function buildResourceMatches(params: BuildResourceMatchesParams): Record<
  PaletteResourceKind,
  ResourceMatch[]
> {
  const { search, bindings, scheduledTasks, connections, executions } = params
  const term = search.trim().toLowerCase()

  const empty: Record<PaletteResourceKind, ResourceMatch[]> = {
    binding: [],
    schedule: [],
    connection: [],
    execution: [],
  }
  if (term === '') {
    return empty
  }

  return {
    binding: take(bindings)
      .filter((binding) => matches(term, binding.triggerName, binding.pieceName, binding.id))
      .map((binding) => ({
        key: `binding:${binding.id}`,
        kind: 'binding' as const,
        label: shorten(binding.triggerName || binding.pieceName || binding.id),
        sublabel: binding.pieceName,
        to: `/automations/triggers/${encodeURIComponent(binding.id)}`,
      })),
    schedule: take(scheduledTasks)
      .filter((task) => matches(term, task.prompt, task.cronExpression, task.id))
      .map((task) => ({
        key: `schedule:${task.id}`,
        kind: 'schedule' as const,
        label: shorten(task.prompt || task.cronExpression || task.id),
        sublabel: task.cronExpression,
        to: `/automations/schedules/${encodeURIComponent(task.id)}`,
      })),
    connection: take(connections)
      .filter((connection) => matches(term, connection.displayName, connection.pieceName, connection.id))
      .map((connection) => ({
        key: `connection:${connection.id}`,
        kind: 'connection' as const,
        label: shorten(connection.displayName || connection.pieceName || connection.id),
        sublabel: connection.pieceName,
        to: `/connections/${encodeURIComponent(connection.id)}`,
      })),
    execution: take(executions)
      .filter((execution) => matches(term, execution.prompt, execution.id))
      .map((execution) => ({
        key: `execution:${execution.id}`,
        kind: 'execution' as const,
        label: shorten(execution.prompt || execution.id),
        sublabel: execution.status,
        to: `/activity/${encodeURIComponent(execution.id)}`,
      })),
  }
}

export function totalMatches(groups: Record<PaletteResourceKind, ResourceMatch[]>): number {
  return Object.values(groups).reduce((sum, hits) => sum + hits.length, 0)
}

export interface CommandPaletteResourcesProps {
  search: string
  onNavigate: (to: string) => void
}

/**
 * Rendered only while the palette is open, so the four list queries are not fired on every page
 * load. React Query keeps whatever was fetched, so reopening the palette is instant.
 */
export function CommandPaletteResources({ search, onNavigate }: CommandPaletteResourcesProps) {
  const { t } = useTranslation()
  // The list hooks are not uniform: `useTriggerBindingsQuery` and `useScheduledTasksQuery` apply
  // `select: (page) => page.data` and hand back an array, while `useConnectionsQuery` and
  // `useExecutionsQuery` return the raw SeekPage. Reading `.data` off an already-unwrapped hook
  // yields undefined and the resource group silently renders nothing.
  const { data: bindings } = useTriggerBindingsQuery()
  const { data: scheduledTasks } = useScheduledTasksQuery()
  const { data: connectionsPage } = useConnectionsQuery()
  const { data: executionsPage } = useExecutionsQuery({ limit: 50 })

  const groups = React.useMemo(
    () =>
      buildResourceMatches({
        search,
        bindings: bindings ?? [],
        scheduledTasks: scheduledTasks ?? [],
        connections: connectionsPage?.data ?? [],
        executions: executionsPage?.data ?? [],
      }),
    [search, bindings, scheduledTasks, connectionsPage, executionsPage]
  )

  const isSearching = search.trim() !== ''
  const found = totalMatches(groups)

  if (!isSearching) {
    return null
  }

  if (found === 0) {
    return (
      <CommandGroup heading={t('Project resources')}>
        <div
          data-testid="command-palette-no-resource-match"
          className="px-2 py-6 text-center text-sm text-muted-foreground"
        >
          {t('No project resources match your search')}
        </div>
      </CommandGroup>
    )
  }

  return (
    <>
      <CommandSeparator />
      <CommandGroup heading={t('Project resources')}>
        {groups.binding.map((hit) => (
          <ResourceItem key={hit.key} hit={hit} icon={<Radio className="mr-2 h-4 w-4 text-muted-foreground" />} onNavigate={onNavigate} />
        ))}
        {groups.schedule.map((hit) => (
          <ResourceItem key={hit.key} hit={hit} icon={<CalendarClock className="mr-2 h-4 w-4 text-muted-foreground" />} onNavigate={onNavigate} />
        ))}
        {groups.connection.map((hit) => (
          <ResourceItem key={hit.key} hit={hit} icon={<KeyRound className="mr-2 h-4 w-4 text-muted-foreground" />} onNavigate={onNavigate} />
        ))}
        {groups.execution.map((hit) => (
          <ResourceItem key={hit.key} hit={hit} icon={<Activity className="mr-2 h-4 w-4 text-muted-foreground" />} onNavigate={onNavigate} />
        ))}
      </CommandGroup>
    </>
  )
}

function ResourceItem({ hit, icon, onNavigate }: ResourceItemProps) {
  return (
    <CommandItem
      value={`${hit.kind} ${hit.label} ${hit.sublabel}`}
      onSelect={() => onNavigate(hit.to)}
      className="cursor-pointer"
      data-testid={`command-palette-result-${hit.kind}`}
    >
      {icon}
      <span className="truncate">{hit.label}</span>
      {hit.sublabel ? (
        <span className="ml-2 truncate text-xs text-muted-foreground">{hit.sublabel}</span>
      ) : null}
    </CommandItem>
  )
}

type BuildResourceMatchesParams = {
  search: string
  bindings: TriggerBinding[]
  scheduledTasks: ScheduledTask[]
  connections: AppConnection[]
  executions: Execution[]
}

type ResourceItemProps = {
  hit: ResourceMatch
  icon: React.ReactNode
  onNavigate: (to: string) => void
}
