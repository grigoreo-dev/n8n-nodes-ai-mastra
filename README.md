# n8n-nodes-ai-mastra

Run AI agents on the [Mastra](https://mastra.ai) framework inside n8n, with
PostgreSQL-backed memory. An alternative to the stock (LangChain) AI Agent node.

This is v0.2 — the **PostgreSQL memory slice**:

- **Mastra Agent** (root node) — runs a prompt through a `@mastra/core` Agent.
- **Postgres Memory (Mastra)** (sub-node) — Mastra memory on `@mastra/pg`
  `PostgresStore`, wired into the agent via the `ai_memory` connection.

## Install (private / Docker only)

This node depends on `@mastra/core` (an external runtime dependency) and is
therefore **not eligible for the n8n verified community registry**. Install it
as a private community node (Docker / self-hosted):

```bash
# in your n8n custom nodes directory
npm install n8n-nodes-ai-mastra
```

Set the provider API key for whatever model you use (e.g. `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`) in the n8n environment.

## Usage

1. Add a **Mastra Agent** node.
2. Set **Model** to a Mastra model-router id, e.g. `openai/gpt-4o-mini` or
   `anthropic/claude-3-5-sonnet-latest`.
3. (Optional) Add a **Postgres Memory (Mastra)** node and connect it to the
   agent's **Memory** input. Pick the native n8n `postgres` credential.

### Memory scope

Mastra scopes memory by **thread** (n8n session id) and **resource** (user id):

- **Session ID** → Mastra `thread`. `Connected Chat Trigger Node` reads
  `sessionId` off the incoming item; `Define below` lets you set it explicitly.
- **Resource ID (User ID)** → Mastra `resource`. Memory is isolated per resource.
- **Require Resource ID** (default **on**) — errors if the resource is empty, so
  a client-facing agent can't silently share one memory bucket across users. When
  off, an empty resource falls back to per-session isolation (never a shared
  `default` bucket).

## Design notes / deliberate deviations

- **`@mastra/core` is pinned to `1.49.0` (exact), not latest.** `1.50.0` and
  `1.48.2` are **broken publishes that ship zero `.d.ts` files** (only orphan
  `.d.ts.map`), so they don't typecheck against consumers. `1.49.0` ships 980
  intact declarations. Do not bump `@mastra/core` without verifying the tarball
  actually contains `dist/**/*.d.ts`.
- **Own `pg.Pool` manager, not `n8n-nodes-base` internals.** We read the native
  `postgres` credential directly and build our own singleton pool
  (`nodes/shared/poolManager.ts`) rather than importing `configurePostgres` from
  `n8n-nodes-base/dist/...` — that deep import has no stability guarantee, and
  Mastra's `PostgresStore` wants a raw pool under our lifecycle control. Pools are
  keyed by host+port+db+user+schema+ssl+password-hash, reference-counted, and
  idle-evicted so a credential rotation on a long-running instance can't leak
  connections. Default pool `max` is **5** (override per-node).
- **SSH-tunnel Postgres credentials are rejected** — Mastra owns the connection
  pool, which is incompatible with the per-execution SSH proxy.
- **`moduleResolution: nodenext`** is required (Mastra ships `exports` maps);
  output is still CommonJS for n8n.

## Not in scope (this slice)

- Workspace / Sandbox sub-nodes (blocked by n8n's frozen AI-connection-type enum;
  needs its own decision).
- Semantic recall / `PgVector`, observational memory, tools bridge — later slices.
- Real-Postgres integration tests (unit tests mock the DB; no n8n precedent for
  containerized memory-node tests).

## Development

Requires `n8n` on your PATH (`npm i -g n8n` or your usual install) and Docker
(for the local memory database).

```bash
npm install
npm run dev         # setup ~/.n8n/custom stub, start dev Postgres, tsup --watch + N8N_DEV_RELOAD n8n (http://localhost:5678)
npm run build       # one-off bundle into dist/
npm run dev:watch   # watch only, no n8n
npm run dev:db      # start the local dev Postgres only (docker compose)
npm run dev:db:down # stop the local dev Postgres (keeps data)
npm run setup:custom # re-link package.json + dist into ~/.n8n/custom (avoid npm link — scans node_modules)
npm run typecheck
npm test            # vitest (pool lifecycle, credentials, supplyData, isolation)
```

### Local memory database

`npm run dev` (and `npm run dev:db`) start a throwaway PostgreSQL 17 container
via `docker-compose.dev.yml` for testing agent memory. These are **local dev
credentials, not secrets**:

| Field    | Value           |
| -------- | --------------- |
| Host     | `localhost`     |
| Port     | `5544`          |
| Database | `mastra_memory` |
| User     | `mastra`        |
| Password | `mastra`        |

Create an n8n **Postgres** credential with these values, connect a
**Postgres Memory (Mastra)** node to a **Mastra Agent**, and the memory node
creates its tables on first run. Wipe the data with
`docker compose -f docker-compose.dev.yml down -v`.
