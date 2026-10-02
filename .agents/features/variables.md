# Variables

> **This doc used to describe a feature that no longer exists.** The project-scoped *Variables*
> store — user-defined `{{variables['NAME']}}` secrets in a `variable` table, with
> `variable.service` / `variable.controller` / `/v1/variables`, an engine-only
> `/v1/worker/variables/:name` route, a reveal endpoint, and the `AddVariableTable` migration — was
> **removed from this fork**. None of those files exist. If you are looking for a variables CRUD
> API, a `variable` table, or the secret-reveal flow, it is not here; do not go looking under
> `packages/server/api/src/app/variable/`.
>
> What *does* remain is the engine's variable-expression engine, documented below. Earlier
> revisions of this file mixed the two and pointed at the removed store, which cost agents accuracy
> (issue #346).

## Summary

At flow-execution time the engine resolves `{{...}}` expressions in a step's input. Tokens are
dispatched by kind — a `variables[...]` reference, a `connections[...]` reference, a step result,
or a piece output — and resolved against the execution context. Only the **expression/props
resolution** half of the original feature survives; nothing is persisted.

## Key Files
- `packages/server/engine/src/lib/variables/props-resolver.ts` — `resolveSingleToken` and `preResolveFormulaVars`; dispatches each token by kind. Contains the `variables` branch (`VARIABLES` / `VARIABLES[`), which still parses `variables[...]` tokens even though no variable store backs them
- `packages/server/engine/src/lib/variables/expression-evaluator.ts` — evaluates a resolved expression string
- `packages/server/engine/src/lib/variables/props-processor.ts` — walks nested props structures and drives resolution
- `packages/server/engine/src/lib/variables/processors/types.ts` — the per-type processor contract
- `packages/server/engine/src/lib/variables/processors/index.ts` — the processor registry
- `packages/server/engine/src/lib/variables/processors/text.ts` — text processor
- `packages/server/engine/src/lib/variables/processors/number.ts` — number processor
- `packages/server/engine/src/lib/variables/processors/json.ts` — JSON processor
- `packages/server/engine/src/lib/variables/processors/array-zipper.ts` — array/zip processor
- `packages/server/engine/src/lib/variables/processors/date-time.ts` — date/time processor
- `packages/server/engine/src/lib/variables/processors/file.ts` — file processor
- `packages/server/engine/src/lib/variables/processors/object.ts` — object processor
- `packages/server/engine/src/lib/piece-context/variable-resolver.ts` — engine-side resolver, mirrors `connection-resolver.ts`
- `packages/core/formula/src/lib/formula-evaluator.ts` — the `@inboxfm-connect/formula` evaluator used for step inputs and agent tool args

## Surface Notes
**Web console:** the `variablesQueries.useVariables(...)` frontend hook that used to render variable mention labels in the editor is **removed from this fork** — there is no variables API to call and no mention labels. The `packages/web/src/app/` and `packages/web/src/features/` trees this doc pointed at are upstream code that is **not present in this fork** (issue #346).

## Notes
- Formula arguments reuse the same `resolveSingleToken` path, so connections, step references and any `variables[...]` mention all resolve through one code path.
- `preResolveFormulaVars` and `resolveSingleToken` are real and current — unlike the store they once served.
