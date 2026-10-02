# Knowledge Search

> **This feature was renamed.** The original *Knowledge Base* feature — per-project document upload
> (PDF/DOCX/TXT/CSV), chunking, embeddings, and the `knowledge_base_file` / `knowledge_base_chunk`
> entities behind `/v1/knowledge-base/files` — **no longer exists in this fork**. It was replaced by
> a much smaller, query-only surface. If you are looking for document upload, file management,
> chunk storage, or the pgvector `vector(768)` tables, none of that is here; do not go looking for
> files under `packages/server/api/src/app/knowledge-base/`.
>
> Earlier revisions of this file described that removed subsystem in detail. The description was
> upstream Activepieces architecture, not this fork, and pointing an agent at it cost accuracy
> (issue #346).

## Summary

`knowledge-search` exposes a single authenticated endpoint that runs a semantic search across a
caller-supplied set of pieces and returns ranked context. There is no document store: the corpus is
whatever the caller passes in, and embeddings come from a configured AI provider rather than from
chunks persisted by this platform.

## Key Files
- `packages/server/api/src/app/knowledge-search/knowledge-search.module.ts` — registers the controller under the `/v1/knowledge-search` prefix
- `packages/server/api/src/app/knowledge-search/knowledge-search.controller.ts` — the single `POST /query` route
- `packages/server/api/src/app/knowledge-search/knowledge-search.service.ts` — `query()`: builds the embedder, searches, and returns the ranked response

## Request / Response Contract
- **Request**: `POST /v1/knowledge-search/query` with the `KnowledgeSearchQuery` body (`query`, plus the piece/scope selectors).
- **Response**: `KnowledgeSearchQueryResponse`.
- `action: 'trigger'` narrows to trigger-visible content; `action: 'all'` spans both actions and triggers.

## Surface Notes
**Web console:** no UI surface in this fork. The `packages/web/src/app/` and `packages/web/src/features/` trees this doc previously pointed at are upstream code that is **not present in this fork** (issue #346).

## Behaviour worth knowing
- **Embedder resolution**: the service resolves an embedder per query from the platform's AI provider configuration. A platform with no usable provider fails the query rather than silently returning nothing.
- **The query text is embedded once.** The resolved embedder is memoized per call, so `objectKind: 'all'` — which searches actions and triggers in one pass — embeds the query a single time rather than once per branch. Getting this wrong doubles OpenAI embedding cost on the default unified path, so the memo is load-bearing (issue #404).
- **Tenant scoping is enforced**, not caller-supplied: results are confined to the caller's platform, and a piece-name filter excludes other matching pieces.

## Tests
- `packages/server/api/test/integration/ce/knowledge-search/knowledge-search.test.ts` — cross-tenant isolation, empty-query rejection, non-existent KB, and an unauthenticated call
- `packages/server/api/test/unit/app/knowledge-search/knowledge-search.service.test.ts` — `query()` across the `action` / `trigger` / `all` paths
- `packages/server/api/test/unit/app/knowledge-search/query-embed-dedup.test.ts` — the single-embed guarantee above
- `packages/server/api/test/unit/app/knowledge-search/knowledge-search.controller.test.ts`
