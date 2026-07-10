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

## End-to-end workflow tests inside a real n8n (needs research)

**Goal:** Full integration tests that run our nodes inside a real n8n instance,
not just unit tests. Ship a set of pre-built fixture workflows (with
webhook/chat triggers), import them into n8n, provision the credentials they
need, execute them via their trigger, and assert on the result. Ideally the
same machinery runs both locally during development and automatically on GitHub
(CI on every commit/PR).

**Why:** Our unit tests cover the bridge/handoff logic in isolation, but the
bugs that actually hurt (MCP `{value}` wrapper, empty prompt, hot-reload, model
resolution) only surfaced in a live n8n run driven by hand through the MCP
tools. An automated end-to-end harness would catch these before commit and
prove the nodes work against the n8n version we target.

**Concept:**
- Keep fixture workflows in-repo as JSON (chat trigger and/or webhook trigger →
  Mastra Agent → Model/Memory/MCP tool).
- On test start: spin up n8n (local process or container), import the fixtures,
  create/attach the required credentials, and activate the workflows.
- Drive each workflow through its trigger (HTTP webhook call, or the chat/manual
  execution API) and assert on the execution output / node run data.
- Tear everything down cleanly afterwards.

**Research needed (open questions):**
- How to programmatically import workflows + create credentials: n8n public
  REST API vs. the CLI (`n8n import:workflow`) vs. direct DB seeding. Which is
  stable across n8n versions?
- How to inject secrets safely in CI (context7/OpenRouter/Postgres creds) —
  GitHub Actions secrets, and whether external LLM/MCP calls should be mocked or
  hit live (cost, flakiness, rate limits).
- Postgres for memory in CI: reuse the dev `docker-compose.dev.yml` as a
  service container.
- Whether n8n's own Playwright test harness (`n8n/packages/testing/playwright`)
  can be reused, or we build a thin custom runner.
- Determinism: LLM output varies, so assertions should target structure
  (tool was called, node ran, memory row written, no error) rather than exact
  model text — possibly with a fixed/mock model for stable assertions.
- How to pin the n8n version under test and keep the custom-node symlink
  (`scripts/setup-custom.mjs`) working in CI.

**Acceptance:** A single command (and a GitHub Actions job) that imports the
fixture workflows into a real n8n, runs them end-to-end with credentials wired
up, and passes/fails based on their execution results.
