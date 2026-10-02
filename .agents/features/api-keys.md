# API Keys (Platform `sk-` and Connect `cak-`)

## Summary
Two families of API key share one lifecycle model (issue #28):
- **Platform API Keys** (`sk-`, table `api_key`): platform-wide service credentials, Enterprise/Cloud only to create.
- **Connect API Keys** (`cak-`, table `connect_api_key`): single-project-scoped credentials, available in **every edition** including CE — this is the only key type CE can currently mint.

Both are 64 characters, stored only as a SHA-256 hash (plaintext returned once on creation), with a `truncatedValue` (last 4 chars) for display. Both track `lastUsedAt` (updated on every authenticated request) and an optional `expiresAt` (ISO timestamp, nullable — no expiry by default, so existing/self-hosted keys keep working with zero setup per `.claude/rules/self-hosting.md`). An expired key is treated as invalid at auth time (`getByValue` returns `null` without leaking "expired vs. never existed" through the error).

## Key Files
- `packages/server/api/src/app/ee/api-keys/api-key-module.ts` — `sk-` controller + `platformMustHaveFeatureEnabled` guard
- `packages/server/api/src/app/ee/api-keys/api-key-service.ts` — `sk-` management service (add, list, delete, rotate) — ee/cloud only
- `packages/server/api/src/app/api-keys/api-key.entity.ts` / `api-key.service.ts` — `sk-` entity + non-ee `getByValue` lookup, used by `authenticate.ts` in every edition
- `packages/server/api/src/app/connect-api-keys/connect-api-key.controller.ts` / `connect-api-key.service.ts` / `connect-api-key.entity.ts` — `cak-` entity + service (add, list, delete, rotate, getByValue) — non-ee, every edition
- `packages/server/api/src/app/core/security/v2/authn/authenticate.ts` — routes `Bearer sk-...` / `Bearer cak-...` to the right lookup
- `packages/server/api/src/app/core/security/v2/authz/api-key-rate-limit-middleware.ts` — per-key rate limiting (both prefixes)
- `packages/server/api/src/app/helper/audit-events.ts` — `apiKeyCreated/Revoked/Rotated` (`sk-`) and `connectApiKeyCreated/Revoked/Rotated` (`cak-`) evlog audit actions
- `packages/core/shared/src/lib/ee/api-key/index.ts` — `ApiKey`, `ApiKeyResponseWithValue`, `ApiKeyResponseWithoutValue`, `CreateApiKeyRequest` (+ `isApiKeyExpiryValid` helper)
- `packages/core/shared/src/lib/connect-api-key/index.ts` — `ConnectApiKey`, `ConnectApiKeyResponseWithValue`, `ConnectApiKeyResponseWithoutValue`, `CreateConnectApiKeyRequest`
- `packages/server/api/src/app/database/migration/postgres/1790152916876-AddApiKeyExpiry.ts` — adds `expiresAt` to both tables

## Surface Notes
**Web console:** the `packages/web/src/app/` and `packages/web/src/features/` trees this doc previously pointed at are upstream code that is **not present in this fork**. The console is a thin developer surface: API clients in `packages/web/src/lib/api/`, React Query hooks in `packages/web/src/lib/query/hooks.ts`, components in `packages/web/src/components/`, pages in `packages/web/src/pages/`. Do not go looking for the old paths (issue #346).


## Edition Availability
- `sk-` create/list/delete/rotate: Enterprise and Cloud only, gated by `platform.plan.apiKeysEnabled`. CE has no registered endpoint to mint `sk-` keys.
- `cak-` create/list/delete/rotate: **every edition**, non-ee, project-scoped (`POST/GET/DELETE /v1/connect-api-keys`, `POST /v1/connect-api-keys/:id/rotate`), gated only by the standard `WRITE_API_KEY`/`READ_API_KEY` project permission.
- Authenticating a request with either prefix: all editions, via the non-ee `api-keys/api-key.service.ts#getByValue` / `connect-api-keys/connect-api-key.service.ts#getByValue`, so CE never reaches into `ee/` on the authentication hot path (see issue #9 / `.claude/rules/edition-safety.md`).

## Scoping (investigated, not changed — see PR for #28)
Authorization for a `SERVICE` principal (either key type) does **not** check `Permission` at all — `authorize.ts#assertAccessToProject` only checks platform/project membership; the per-permission check (`role.permissions?.includes(permission)`) only runs for `USER` principals. So:
- `cak-` keys are scoped to exactly one project (`assertServicePrincipalScope` in `authorize.ts`) but have **full** access within that project — no narrower permission scoping exists.
- `sk-` keys have `principal.projectId` unset, so `assertServicePrincipalScope` is a no-op — full platform access, every project.
Adding granular (per-permission) scopes would mean a `scopes` column, wiring `Principal` to carry them, and changing `assertAccessToProject`/`communityProjectAccess` to check them for `SERVICE` the way they already do for `USER` — a cross-cutting authz change, deferred as out of scope for #28.

## Rate limiting
`apiKeyRateLimitMiddleware` — disabled by default (`AP_API_KEY_RATE_LIMITER_ENABLED=false`), fixed-window Redis counter keyed by `principal.id` (the key's own row id, so two different keys — even from the same IP/project — are throttled independently). See `.claude/rules` pattern from PR #80 (`project-rate-limit-middleware.ts`).

## Rotation
`rotate({ id, platformId|projectId })` — creates a full replacement key, then pushes the *old* key's `expiresAt` out to `now + AP_API_KEY_ROTATION_GRACE_PERIOD_SECONDS` (default 24h; never further out than an expiry it already had) instead of deleting it. The old key keeps authenticating until the grace period elapses, then `getByValue`'s expiry check starts rejecting it — no separate "revoked" state needed.

## Domain Terms

> Canonical term definitions live in the bounded-context glossaries — see [CONTEXT-MAP.md](../../CONTEXT-MAP.md).

- **API Key**: A service credential used for programmatic access — platform-scoped (`sk-`) or project-scoped (`cak-`).
- **hashedValue**: SHA-256 hash of the raw key, used for lookup on every request.
- **truncatedValue**: Last 4 characters of the raw key, shown in the UI for identification.
- **lastUsedAt**: ISO timestamp updated each time the key is successfully authenticated.
- **expiresAt**: ISO timestamp after which the key stops authenticating; `null` means no expiry.

## Entities

Table `api_key` (`sk-`) and `connect_api_key` (`cak-`, additionally has `projectId`):

| Column | Type | Notes |
|---|---|---|
| id | ApId (string) | PK |
| created / updated | string | From BaseColumnSchemaPart |
| platformId | ApId | FK to `platform` (CASCADE DELETE) |
| projectId | ApId | `connect_api_key` only — FK to `project` (CASCADE DELETE) |
| displayName | string | Human-readable label |
| hashedValue | string | SHA-256 of the secret key |
| truncatedValue | string | Last 4 chars for display |
| lastUsedAt | string (nullable) | ISO timestamp of last use |
| expiresAt | string (nullable) | ISO timestamp; `null` = no expiry |

## Endpoints

| Method | Path | Auth | Response | Description |
|---|---|---|---|---|
| POST | `/v1/api-keys` | USER (platform admin) | `ApiKeyResponseWithValue` (201) | Create a new `sk-` key; returns raw value once |
| GET | `/v1/api-keys` | USER (platform admin) | `SeekPage<ApiKeyResponseWithoutValue>` (200) | List `sk-` keys for platform |
| POST | `/v1/api-keys/:id/rotate` | USER (platform admin) | `ApiKeyResponseWithValue` (201) | Create replacement + grace-period-expire the old key |
| DELETE | `/v1/api-keys/:id` | USER (platform admin) | 200 | Revoke (delete) a key immediately |
| POST | `/v1/connect-api-keys` | USER (`WRITE_API_KEY` on project) | `ConnectApiKeyResponseWithValue` (201) | Create a new `cak-` key; returns raw value once |
| GET | `/v1/connect-api-keys` | USER (`READ_API_KEY` on project) | `{ data, next, previous }` (200) | List `cak-` keys for a project |
| POST | `/v1/connect-api-keys/:id/rotate` | USER (`WRITE_API_KEY` on project) | `ConnectApiKeyResponseWithValue` (201) | Create replacement + grace-period-expire the old key |
| DELETE | `/v1/connect-api-keys/:id` | USER (`WRITE_API_KEY` on project) | 200 | Revoke (delete) a key immediately |

## Key Generation
`sk-` keys: `secureApId(61)` prefixed with `sk-` to reach 64 characters. `cak-` keys: `secureApId(60)` prefixed with `cak-`. Both hashed with `cryptoUtils.hashSHA256` for storage; truncated display value is the raw key's last 4 characters.
