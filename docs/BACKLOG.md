# Backlog

Future work, not yet scheduled. Scheduled work lives in
[ROADMAP.md](./ROADMAP.md).

## Streaming

Stream agent output token-by-token into n8n. Nice to have, explicitly not a
priority right now.

## Reasoning capture and `<think>` stripping

Two related gaps observed with reasoning models on OpenAI-compatible
endpoints:

- **Structured reasoning is dropped, not logged.** Mastra's OpenAI-compatible
  model parses `reasoning_content` into `reasoning-delta` stream parts, but
  our `modelLogging.ts` wrapper only accumulates `text-delta` — reasoning
  never shows in the execution tree. Fix: accumulate `reasoning-delta` parts
  and include a `reasoning` field in the logged model output.
- **Inline `<think>` leaks into the agent output.** Some models/providers
  (DeepSeek-R1 distills, Qwen, GLM via certain gateways) return reasoning
  inline in `content` as `<think>...</think>` tags; for us it is
  indistinguishable from text and ends up in the final output. Fix: strip
  `<think>` blocks in the logging wrapper (decide: always vs. opt-in node
  toggle), log them as reasoning, and optionally expose `reasoning` in the
  agent node's JSON output. Handle the edge case of an unclosed `<think>`
  tag.

## SSH sandbox / remote workspace adapters

Custom `MastraSandbox` executing commands in a remote container over SSH
(`ssh2`), plus an SFTP-backed `MastraFilesystem`. Only needed if, after the
ACP node ships, we still want our own agent to run raw commands on the worker
pod (ACP already covers "delegate the coding task there"). Cloud filesystem
adapters (S3/R2, GCS, Azure Blob — separate `@mastra/*` packages) also live
here until someone needs them.

## Supervisor / sub-agents

Expose Mastra's `agents:` map (e.g. `AcpAgent` as a delegatable sub-agent, or
Mastra-native sub-agents) on the agent node. Multi-agent orchestration is its
own design conversation.

## Mastra Tool omni-node

A sub-node where the user writes custom tool code inline. Probably redundant
next to n8n's stock Code Tool + MCP; revisit only if a concrete need appears.

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
