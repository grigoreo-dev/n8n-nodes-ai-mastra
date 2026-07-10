# Backlog

Future work, not yet scheduled.

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
