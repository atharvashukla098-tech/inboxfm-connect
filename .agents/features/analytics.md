# Analytics

## Summary
The Analytics module provides platform-level reporting on automation usage: daily run counts, active flow counts, active user counts, and time-saved estimates. It powers an "Impact" dashboard for project-level drill-down. Reports are cached with a 5-minute TTL and refreshed via a distributed-lock background job; a separate daily cron tracks per-piece usage across all flows.

## Key Files
- `packages/server/api/src/app/analytics/` — backend module (controller, two services, entity)
- `packages/core/shared/src/lib/management/analytics/index.ts` — all shared Zod schemas and enums (`AnalyticsTimePeriod`, `PlatformAnalyticsReport`, `AnalyticsReportRequest`, etc.)

## Surface Notes
**Web console:** the `packages/web/src/app/` and `packages/web/src/features/` trees this doc previously pointed at are upstream code that is **not present in this fork**. The console is a thin developer surface: API clients in `packages/web/src/lib/api/`, React Query hooks in `packages/web/src/lib/query/hooks.ts`, components in `packages/web/src/components/`, pages in `packages/web/src/pages/`. Do not go looking for the old paths (issue #346).


## Edition Availability
- **Community (CE)**: Not available — gated behind `analyticsEnabled` plan flag.
- **Enterprise (EE)**: Available when `analyticsEnabled` is true on the platform plan.
- **Cloud**: Available when `analyticsEnabled` is true on the platform plan.

## Domain Terms

> Canonical term definitions live in the bounded-context glossaries — see [CONTEXT-MAP.md](../../CONTEXT-MAP.md).

- **PlatformAnalyticsReport**: Cached entity holding daily run aggregations, enabled-flow metadata, and user list for a platform.
- **AnalyticsTimePeriod**: Enum for time windows (`LAST_WEEK`, `LAST_MONTH`, `LAST_THREE_MONTHS`, `LAST_SIX_MONTHS`, `LAST_YEAR`).
- **timeSavedPerRun**: Per-flow estimate (in minutes) of manual time saved per automation run; editable by the flow owner.
- **minutesSaved**: Derived metric = `runs × timeSavedPerRun`; displayed on the impact summary.
- **outdated**: Boolean flag on the report entity indicating a background refresh is needed.
- **Pieces analytics**: Separate service that counts how many projects actively use each piece and updates `pieceMetadata.usage`.

## Entities

**PlatformAnalyticsReport**: id, platformId, cachedAt, outdated (boolean), runs (AnalyticsRunsUsageItem[]), flows (AnalyticsFlowReportItem[]), users (UserWithMetaInformation[]).

- `AnalyticsRunsUsageItem`: `{ flowId, day: Date, runs: number }` — daily aggregation
- `AnalyticsFlowReportItem`: `{ flowId, flowName, projectId, projectName, ownerId }` — enabled flows

## Pieces Analytics (`pieces-analytics.service.ts`)

**Scheduled**: Daily cron at 12:00 UTC

Tracks which pieces are actively used:
1. For each enabled flow → get published version → extract piece steps
2. Group by piece → count unique projects using each piece
3. Update `pieceMetadata.usage = projectCount`

## Platform Report Service (`platform-analytics-report.service.ts`)

**Key methods**:
- `refreshReport(platformId)` — distributed lock (400s), queries users + enabled flows + daily run counts (PRODUCTION only), merges incrementally. Stored as entity.
- `getOrGenerateReport(platformId, timePeriod?)` — returns cached report (5-min TTL), filters by time period
- `markAsOutdated(platformId)` — flags report for refresh

## Time Periods

`AnalyticsTimePeriod`: LAST_WEEK, LAST_MONTH, LAST_THREE_MONTHS, LAST_SIX_MONTHS, LAST_YEAR

Minutes saved = runs count × flow.timeSavedPerRun

## Gating

`analyticsEnabled` plan flag. Module uses `platformMustHaveFeatureEnabled((p) => p.plan.analyticsEnabled)`.

## Frontend

All analytics queries in `platformAnalyticsHooks` include `enabled: platform.plan.analyticsEnabled` to prevent firing when the feature is off. The Impact page (`/impact`) is split into Summary, Trends, and Details sub-routes. A "Refresh" button triggers `useRefreshAnalytics` mutation which calls the backend refresh endpoint and invalidates all analytics query keys.
