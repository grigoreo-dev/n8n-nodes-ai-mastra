# Roadmap

Ordered list of the slices we have decided to build, with rationale. Each slice
goes through its own brainstorm → spec → plan cycle before implementation.
Unscheduled ideas live in [BACKLOG.md](./BACKLOG.md).

## 1. Model node v2

Make the Mastra Model sub-node a mature, fully configurable node.

- **Dynamic model list** — fetch `GET {baseUrl}/models` from the
  OpenAI-compatible endpoint and render a searchable dropdown
  (`loadOptions`), with a manual-string fallback for endpoints that don't
  expose the list.
- **Custom headers** — key/value collection (expression-capable) sent with
  every request. Primary use case: OpenRouter session/trace headers for
  grouping multi-message sessions.
- **Options section** — temperature, max tokens, top-p and friends, following
  the stock n8n chat-model node conventions.

## 2. Semantic Recall + Session Metadata

Extend the Postgres memory beyond "last N messages" — the main functional
advantage over the stock n8n agent.

- **Semantic recall section** on the Postgres Memory node: `PgVector` (same
  connection string; requires the `pgvector` extension), embedder via a second
  optional credential of the existing `mastraOpenAiCompatibleApi` type
  (Kafka-style conditional credential), options `topK`, `messageRange`,
  `scope` (thread/resource), threshold.
  Note: OpenRouter does not host an `/embeddings` endpoint, so the embedder
  credential generally points at a different service (e.g. OpenAI direct).
- **Session metadata** on the Mastra Agent node: optional Thread Title and
  metadata (JSON / key-value with expressions, e.g. Telegram chat title),
  stored on the Mastra thread and usable as a semantic-recall `filter`.
- Dev compose switches to a `pgvector/pgvector` Postgres image.

## 3. Workspaces

The flagship feature this project was started for: give the agent a filesystem
(and later a sandbox).

- **Workspace sub-node** supplying a Mastra `Workspace` to the agent via a
  dedicated `ai_tool`-typed input labelled "Workspace" (`maxConnections: 1`)
  on the agent node; handoff marker validated at runtime (n8n's frozen
  AI-connection enum prevents a real new connection type).
- First adapter: `LocalFilesystem` (already in `@mastra/core`). Optional
  `LocalSandbox` behind an explicit "no isolation" warning.
- Cloud filesystems (S3/R2, GCS, Azure Blob) and custom sandboxes stay in the
  backlog until needed.

## 4. ACP node (o‍pencode as a tool)

Delegate whole coding tasks to an ACP-compatible agent — primarily o‍pencode
running on the worker pod (`o‍pencode acp` speaks ACP over stdio, so plain
`ssh worker-pod o‍pencode acp` is the transport; no custom sandbox needed).

- **ACP Agent sub-node** → `ai_tool` output built on `@mastra/acp`
  `createACPTool()`; the existing tool bridge consumes it unchanged.
- Parameters: command/args (with an "o‍pencode via SSH" preset), cwd, env,
  permission policy (auto-allow / deny / allowlist), `persistSession`.
- Process lifecycle: pool live ACP connections with ref-counting and idle
  eviction, mirroring the existing `poolManager` pattern; optionally keyed by
  n8n session id so an o‍pencode session survives across executions.
- Complementary to the o‍pencode MCP server (pod control-plane tools); ACP
  covers the "do the coding task over there" scenario.

## 5. Cost / usage statistics

Surface what each call actually costs, right in the n8n execution tree.

- Request usage accounting from OpenRouter (`usage: { include: true }`) and
  extend the model-logging wrapper to show tokens (cached / uncached,
  prompt / completion) and message cost per LLM call.
- Per-session running totals are out of scope here — that belongs to the
  Studio/observability layer (slice 6).

## 6. Studio integration

Central observability without building our own panel: Mastra Studio reads
everything from Mastra storage, and our nodes already write to Postgres.

- **Tracing from the nodes** — wire `Observability` +
  `MastraStorageExporter` (plus `SensitiveDataFilter`) into the same Postgres
  the memory uses, so agent runs, tool calls and usage land in Mastra's trace
  tables.
- **Studio host recipe** — a tiny companion Mastra project + docker-compose
  pointing at the same Postgres; Studio then shows threads, memory and traces
  from any number of n8n instances. Read-only observation first (chatting with
  agents from Studio would require mirroring their definitions).
- Security note: Studio has full access — keep it behind auth/VPN.
