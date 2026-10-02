# AI Agents

> **⚠️ STALE — needs human review.** This doc describes agents as a step inside the old visual flow builder (`packages/web/src/app/builder/`), which no longer exists in this codebase (see `README.md`: "stripped of its visual flow builder"). There is now a real backend entity for this — `packages/server/api/src/app/ai/ai-tool-config-entity.ts` / `ai-tool-config-service.ts` / `ai-tool-config-controller.ts` — contradicting this doc's "does not have its own backend entity" claim below. No `@inboxfm-connect/piece-agent` package or `packages/server/api/src/app/trigger/` / `packages/server/api/src/app/flows/` module exists in the current source tree. The rest of this file was left as-is pending a rewrite by someone with full context on the current agent-configuration model (see `.agents/features/ai-providers.md` and the `agents` app module for verified current starting points).

## Summary
Agents is a flow step type (backed by `@inboxfm-connect/piece-agent`) that executes an LLM-driven autonomous loop. The agent is given a prompt, a set of tools, an AI provider/model, and optional structured-output fields. It runs a ReAct-style loop (up to `maxSteps`) where the model can call any configured tool before producing a final answer. Tools can be piece actions, other flows, MCP servers, or knowledge-base files. The feature is entirely configured inside the Flow Builder as a special step and does not have its own backend entity — the agent configuration lives inside the flow version's step settings.

## Key Files

## Surface Notes
**Web console:** the `packages/web/src/app/` and `packages/web/src/features/` trees this doc previously pointed at are upstream code that is **not present in this fork**. The console is a thin developer surface: API clients in `packages/web/src/lib/api/`, React Query hooks in `packages/web/src/lib/query/hooks.ts`, components in `packages/web/src/components/`, pages in `packages/web/src/pages/`. Do not go looking for the old paths (issue #346).


### Shared Types
- `packages/core/execution/src/lib/agents/index.ts` — enums (`AgentToolType`, `AgentTaskStatus`, `ContentBlockType`, `ToolCallType`, `AgentOutputFieldType`), types (`AgentProviderModel`, `AgentResult`, `AgentStepBlock`, `AgentOutputField`), and `AgentPieceProps` property name enum
- `packages/core/execution/src/lib/agents/tools.ts` — all tool Zod schemas: `AgentPieceTool`, `AgentFlowTool`, `AgentMcpTool`, `AgentKnowledgeBaseTool`, `AgentTool` discriminated union; `McpAuthConfig`, `PredefinedInputsStructure`

### Frontend
- `packages/web/src/features/agents/agent-tools/` — tool management UI (add dropdown, per-tool dialogs, stores)
- `packages/web/src/features/agents/agent-tools/stores/` — Zustand stores for piece-tools dialog (`pieces-tools.ts`) and knowledge-base tools (`knowledge-base-tools.ts`)
- `packages/web/src/features/agents/agent-tools/piece-tool-dialog/` — multi-page dialog: piece list → action list → predefined inputs form → connection picker
- `packages/web/src/features/agents/agent-tools/flow-tool-dialog/` — dialog to attach another flow as a tool
- `packages/web/src/features/agents/agent-tools/mcp-tool-dialog/` — MCP server URL + auth config dialog; calls `mcpToolApi.validateAgentMcpTool` to verify connectivity
- `packages/web/src/features/agents/agent-tools/knowledge-base-dialog/` — dialog to attach a knowledge-base file
- `packages/web/src/features/agents/agent-timeline/` — `AgentTimeline` component that renders step-by-step execution blocks (markdown + tool calls) from `AgentResult.steps`
- `packages/web/src/features/agents/ai-model/` — `AIModelSelector` component; `PROVIDER_EMBEDDING_MODELS` constant
- `packages/web/src/features/agents/structured-output/` — `AgentStructuredOutput` component for defining output field schema

## Edition Availability
Gated by `platform.plan.agentsEnabled`. When disabled, the agent step type is hidden from the piece selector. All editions can run agents if the flag is enabled; by default it is off on Community, on on Cloud plans that include it.

## Domain Terms

> Canonical term definitions live in the bounded-context glossaries — see [CONTEXT-MAP.md](../../CONTEXT-MAP.md).

- **AgentTool** — a discriminated union of the four tool types a user can attach to an agent step
- **AgentToolType** — `PIECE`, `FLOW`, `MCP`, `KNOWLEDGE_BASE`
- **AgentPieceTool** — references a specific piece action by `pieceName`, `pieceVersion`, `actionName`; can carry `predefinedInput` locking certain fields
- **AgentFlowTool** — calls another flow by `externalFlowId`; the flow is executed as a child run
- **AgentMcpTool** — connects to an MCP (Model Context Protocol) server; supports SSE, StreamableHTTP, and SimpleHTTP protocols with None/Bearer/ApiKey/Headers auth
- **AgentKnowledgeBaseTool** — performs semantic search over a knowledge-base file or table; uses cosine similarity on 768-dim embeddings
- **PredefinedInputsStructure** — per-field config (`AGENT_DECIDE`, `CHOOSE_YOURSELF`, `LEAVE_EMPTY`) baked into the tool so the agent knows which inputs it controls
- **AgentResult** — runtime output containing `prompt`, `steps[]`, `status`, and optional `structuredOutput`
- **AgentStepBlock** — either `MarkdownContentBlock` or `ToolCallContentBlock` describing one turn in the agent loop
- **ToolCallStatus** — `IN_PROGRESS` (streaming) or `COMPLETED`
- **AgentTaskStatus** — `COMPLETED`, `FAILED`, `IN_PROGRESS`

## Agent Step Configuration (stored in flow version)
The agent step is a `PIECE` action on `@inboxfm-connect/piece-agent`. Its `settings.input` contains:
- `agentTools` — `AgentTool[]`
- `structuredOutput` — `AgentOutputField[]`
- `prompt` — string (may include `{{variables}}`)
- `maxSteps` — number
- `aiProviderModel` — `AgentProviderModel` (`{ provider, model }`)
- `webSearch` / `webSearchOptions` — optional web search tool configuration

## Tool Validation
External MCP servers configured as agent tools are validated server-side via `POST /v1/projects/:projectId/agent-tools/mcp/validate` (see `packages/server/api/src/app/agents/`). The handler performs the JSON-RPC `initialize` → `notifications/initialized` → `tools/list` handshake against the target and returns its tool names. The outbound call is routed through `apAxios`, whose http/https agents are built by `ssrf-agents.ts` to reject private / loopback / link-local / meta IPs by default. Operators can allow specific ranges via `AP_SSRF_ALLOW_LIST` (CIDR supported). All error paths collapse to a single generic message to avoid leaking reachability signal.

The validator lives under `agents/` (not `mcp/`) because it belongs to the **agent piece** domain — validating an external MCP server the agent will connect to at flow-execution time. The `mcp/` module handles the **opposite direction**: exposing Activepieces itself as an MCP server to external clients.

## Timeline Rendering
`AgentTimeline` receives `AgentStepBlock[]` from the step output and renders:
- Markdown blocks as formatted text
- Tool call blocks as expandable cards showing tool name, type-specific metadata (piece icon, flow name, MCP URL, KB name), input, output, and status badge
