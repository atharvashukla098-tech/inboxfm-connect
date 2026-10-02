# Human Input (Forms & Chat)

> **⚠️ STALE — needs human review.** Verified against the current source tree: `packages/server/api/src/app/flows/flow/human-input/` no longer exists (the flow module it belongs to is gone entirely). Left as-is rather than rewritten speculatively — needs review by someone with full context on whether/how forms and chat triggers exist in the current headless execution model.

## Summary
The Human Input feature exposes public-facing endpoints that allow external users to interact with flows via two interaction modes: **Forms** (structured input fields that trigger a flow and optionally wait for a response) and **Chat** (a conversational UI backed by a flow). Both modes use flows whose trigger is the `@inboxfm-connect/piece-forms` piece. The backend endpoints are read-only and fully public — they return metadata about the form or chat UI (title, input schema, platform branding) that the frontend uses to render the interaction. Flows must be published (or the `useDraft` flag must be set) for the endpoints to return data. The frontend renders the form at `/forms/<flowId>` and the chat at `/chat/<flowId>`.

## Key Files
- `packages/core/execution/src/lib/flows/form.ts` — `FormInputType`, `FormInput`, `FormProps`, `FormResponse`, `ChatUIProps`, `ChatUIResponse`, `USE_DRAFT_QUERY_PARAM_NAME`
- `packages/web/src/features/forms/api/` — frontend API client for form metadata
- `packages/web/src/features/forms/hooks/` — TanStack Query hooks
- `packages/web/src/features/chat/` — chat UI components (bubble, input, message list, intro)
- `packages/web/src/app/routes/forms/` — public-facing form page (`index.tsx`)
- `packages/web/src/app/routes/chat/` — public-facing chat page (`index.tsx`), the reusable chat shell (`flow-chat.tsx`), and the in-builder Drawer wrapper used for testing `chat_submission`-trigger flows from the builder (`chat-drawer.tsx`, paired with `builder/state/chat-state.ts`)

## Surface Notes
**Web console:** the `packages/web/src/app/` and `packages/web/src/features/` trees this doc previously pointed at are upstream code that is **not present in this fork**. The console is a thin developer surface: API clients in `packages/web/src/lib/api/`, React Query hooks in `packages/web/src/lib/query/hooks.ts`, components in `packages/web/src/components/`, pages in `packages/web/src/pages/`. Do not go looking for the old paths (issue #346).


## Edition Availability
- **Community (CE)**: Fully available — no plan flag required.
- **Enterprise (EE)**: Fully available.
- **Cloud**: Fully available.

## Domain Terms

> Canonical term definitions live in the bounded-context glossaries — see [CONTEXT-MAP.md](../../CONTEXT-MAP.md).

- **Forms piece** (`@inboxfm-connect/piece-forms`): The Activepieces piece that provides three triggers: `form_submission`, `file_submission`, and `chat_submission`.
- **form_submission trigger**: Accepts structured text/toggle/textarea fields defined by the flow author. `waitForResponse` controls whether the flow pauses to return a value to the form submitter.
- **file_submission trigger**: Simplified single-file upload form. The field schema is hardcoded server-side (one required FILE input with `waitForResponse: true`).
- **chat_submission trigger**: Enables a chat-style UI. Props contain `botName` for display.
- **FormResponse**: The metadata object returned for form flows — includes `id` (flowId), `title` (flow display name), `props` (FormProps with inputs and waitForResponse), `projectId`, and piece `version`.
- **ChatUIResponse**: The metadata object returned for chat flows — includes `id`, `title`, `props` (botName), `projectId`, `platformLogoUrl`, `platformName`.
- **useDraft**: Query parameter (`boolean`) that, when true, loads the draft flow version instead of the published version. Used during flow testing in the builder.
- **waitForResponse**: When true on a form, the flow run is paused after triggering and the frontend polls/waits for a response value to display back to the submitter.

## Endpoints

Routes registered under the human-input module prefix.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/v1/human-input/form/:flowId` | public | Get form metadata for a flow |
| GET | `/v1/human-input/chat/:flowId` | public | Get chat UI metadata for a flow |

Both accept query parameter: `useDraft: boolean` (optional, defaults to false).

## Service Methods

**humanInputService**
- `getFormByFlowIdOrThrow(flowId, useDraft)`:
  1. Loads the flow from the repository.
  2. If no published version and `useDraft` is false, returns null → throws ENTITY_NOT_FOUND.
  3. Asserts the trigger is from `@inboxfm-connect/piece-forms` with name `form_submission` or `file_submission`.
  4. Resolves the exact piece version via `pieceMetadataService.resolveExactVersion`.
  5. For `file_submission`, returns a hardcoded single-file-input schema (`SIMPLE_FILE_PROPS`).
  6. For `form_submission`, returns `trigger.settings.input` as the props.

- `getChatUIByFlowIdOrThrow(flowId, useDraft)`:
  1. Loads the flow and resolves its version.
  2. Asserts trigger is `chat_submission` from `@inboxfm-connect/piece-forms`.
  3. Fetches platform to include `logoIconUrl` and `name` for branding.
  4. Returns `ChatUIResponse` with platform branding embedded.

## Form Input Types

| Type | Description |
|---|---|
| `text` | Single-line text input |
| `text_area` | Multi-line textarea |
| `toggle` | Boolean toggle/checkbox |
| `file` | File upload |

## Notes

- Both endpoints are `securityAccess.public()` — no authentication is required. Anyone with the flow ID can access the form/chat metadata.
- The form submission itself (actually triggering the flow) goes through the webhook endpoint, not these endpoints. These endpoints only return the UI definition.
- Platform branding (logo, name) is included in the chat response to support white-labeled chat UIs.
- A flow without a published version returns a 404 unless `useDraft=true` is passed — this protects unpublished forms from being accidentally exposed.
