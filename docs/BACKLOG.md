# Backlog

Future work, not yet scheduled.

## Model execution logs (like the stock n8n AI Agent)

**Goal:** Show model input/output and token usage in the n8n execution UI on the
`ai_languageModel` connection, the way the stock LangChain-based AI Agent does —
so a run of a Mastra Agent surfaces the prompt sent to the model, the model's
response, and token counts under the connected **Mastra Model** sub-node.

**Why:** Right now the `Mastra Model` sub-node just hands off a config object.
Nothing writes per-call data onto the `ai_languageModel` connection, so the model
node shows no logs/telemetry in the UI (unlike stock model nodes).

**Upstream reference (already researched):**
- n8n instruments model activity via a LangChain `BaseCallbackHandler`:
  `N8nLlmTracing` in
  `n8n/packages/@n8n/ai-utilities/src/utils/n8n-llm-tracing.ts`.
  It sets `connectionType = NodeConnectionTypes.AiLanguageModel` and calls
  `executionFunctions.addInputData(...)` / `addOutputData(...)` from
  `handleLLMStart` / `handleLLMEnd` / `handleLLMError`, plus a
  `tokensUsageParser` for per-provider token counts.
- Stock model nodes attach it via `callbacks: [new N8nLlmTracing(this)]` inside
  `supplyData` (e.g. `LMChatOpenAi/LmChatOpenAi.node.ts`).

**Mastra-side complication:** Mastra does not use LangChain callbacks. It has its
own model router (`@mastra/core` `ModelRouterLanguageModel`) and streaming stack
(`@mastra/core/stream/aisdk/v5`). So we can't reuse `N8nLlmTracing` directly.
Options to investigate:
- Hook Mastra's own telemetry / span/tracing (`serializeForSpan`, OTEL exporter)
  and translate spans into `addInputData`/`addOutputData` calls.
- Wrap the `stream`/`generate` call in the Agent node and, per item, emit the
  final messages + `usage` (Mastra streams `usage` in the final chunk — seen in
  the raw SSE from the OpenAI-compatible endpoint) onto the `ai_languageModel`
  connection via `ISupplyDataFunctions.addOutputData` from the sub-node.
- Since `supplyData` only returns a config (not a live model), we'd likely need
  the sub-node to hand off a small tracing hook the Agent calls after each run,
  or move token/telemetry reporting into the Agent node keyed to the connected
  model node.

**Acceptance:** Running a workflow with `Mastra Agent` + connected `Mastra Model`
shows, in the execution view under the model node: the input messages, the model
output, and token usage (prompt/completion/total) — matching the stock AI Agent's
log affordance.
