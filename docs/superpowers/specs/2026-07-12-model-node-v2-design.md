# Mastra Model sub-node v2 — design

Roadmap slice 1 ([ROADMAP.md](../../ROADMAP.md)). Make the Mastra Model
sub-node a mature, fully configurable node: pick the model from a live list
fetched off the endpoint, tune model settings, and send custom headers
(OpenRouter session tracking) — all without breaking existing v1 workflows.

## Goals

1. **Model picker** backed by `GET {baseUrl}/models` with a manual-ID fallback.
2. **Options section** for model call settings (temperature, reasoning, …).
3. **Custom headers** per node, expression-capable (e.g. OpenRouter
   session-ID header).
4. Soft **runtime validation** of options against the endpoint's advertised
   `supported_parameters`, when available.

Out of scope: cost/usage statistics (roadmap slice 5), headers on the
credential, persistent model-catalog cache, dynamic form generation per model
(n8n cannot rebuild node properties from API responses).

## 1. Model selection (`resourceLocator`)

The `model` parameter changes from `string` to `resourceLocator` with two
modes:

- **From list** — a searchable list via `methods.listSearch`. Entries come
  from the model catalog (below). Item name is the model id (sent verbatim);
  description shows display name, context length, and pricing when the
  endpoint provides them (OpenRouter does).
- **By ID** — raw string, expression-capable, sent verbatim including slashes
  (current v1 behavior).

If the endpoint has no usable `/models` (404, error, non-OpenAI shape), the
list mode surfaces a clear error telling the user to switch to By ID. At
runtime a missing catalog is never an error.

**Versioning:** node `version` becomes `[1, 2]`. v1 keeps the plain string
parameter and current behavior; v2 is the default for newly added nodes.
Existing workflows are untouched.

## 2. Model catalog with in-process TTL cache

New shared module `nodes/shared/modelCatalog.ts`:

- `getModelCatalog(baseUrl, apiKey)` fetches `GET {baseUrl}/models`
  (Authorization: Bearer), parses the OpenAI-style `{ data: [...] }` list,
  and caches it in a module-level `Map` keyed by
  `baseUrl + sha256(apiKey)` with a ~10-minute TTL — same in-process
  singleton pattern as `poolManager.ts`.
- Parsed per-model fields (all optional): `id`, `name`, `context_length`,
  `pricing` (prompt/completion), `supported_parameters` (OpenRouter
  extension; absent on plain OpenAI/vLLM).
- One catalog serves both the UI list (`listSearch`) and runtime validation.
- Cache is per Node.js process (each queue-mode worker warms its own copy);
  restart means one extra fetch. No persistence, no invalidation API — TTL
  only.
- Errors: fetch/parse failures are cached briefly (negative cache, ~30s) to
  avoid hammering a broken endpoint from `loadOptions` retries; runtime
  treats any failure as "no catalog".

## 3. Options (model call settings)

New `Options` parameter, n8n `collection` type ("Add Option"), empty by
default:

| Option            | Type                                     | Notes |
| ----------------- | ---------------------------------------- | ----- |
| Temperature       | number, 0–2                              |       |
| Max Output Tokens | number                                   |       |
| Top P             | number, 0–1                              |       |
| Frequency Penalty | number, −2–2                             |       |
| Presence Penalty  | number, −2–2                             |       |
| Reasoning Effort  | options: minimal / low / medium / high   | values loaded via `loadOptionsDependsOn: ['model']`; when the catalog knows the model does not support reasoning, the list is empty with a hint |
| Stop Sequences    | comma-separated string                   |       |

**Placement rationale:** options live on the model node (not the agent) —
n8n convention (stock chat-model nodes carry these), settings are only
meaningful next to the concrete model, and `loadOptionsDependsOn` needs the
`model` parameter on the same node.

**Transport:** `MastraModelHandoff` gains an optional `settings` field
(subset of Mastra's `ModelFallbackSettings`: `temperature`, `topP`,
`maxOutputTokens`, `frequencyPenalty`, `presencePenalty`, `stopSequences`,
`reasoning`). The Agent node passes it to
`agent.generate(prompt, { modelSettings: handoff.settings })` — a confirmed
`@mastra/core` API. Custom headers do NOT ride in `settings` (see below).

**Runtime validation (soft):** before the call, if the catalog is cached and
the selected model advertises `supported_parameters`, configured options are
checked against it; an unsupported option raises `NodeOperationError` with a
clear message (e.g. "Model X does not support reasoning"). When the catalog
or the `supported_parameters` field is missing, validation is silently
skipped — plain OpenAI/vLLM endpoints are unaffected. In By-ID mode with
expressions the same check runs after the expression resolves.

## 4. Custom headers

Separate `Custom Headers` parameter (`fixedCollection`, key/value,
`multipleValues`, expressions supported), NOT inside Options — transport
concerns stay apart from model settings. Values resolve per execution and go
into `config.headers` (`OpenAICompatibleConfig.headers` is native Mastra
API), so they apply on the model-node side; the agent is unaware.

Primary use case: OpenRouter session grouping, e.g.
`X-Session-Id: {{ $json.sessionId }}`.

**Guard:** a user-supplied `Authorization` header is ignored (with a warning
in the node output log) — that header belongs to the credential.

## 5. Architecture recap

```
ModelOpenAiCompatibleMastra (v2)
  ├─ resourceLocator "model"  ── listSearch ──► modelCatalog (TTL cache) ──► GET /models
  ├─ collection "options"     ── reasoning values via loadOptionsDependsOn
  ├─ fixedCollection "customHeaders"
  └─ supplyData():
       config = { providerId, modelId, url, apiKey, headers }   // headers merged here
       settings = { temperature?, topP?, reasoning?, ... }       // validated vs catalog
       handoff = { __isMastraModel, config, model: wrapped, settings }

MastraAgent
  └─ agent.generate(prompt, { modelSettings: handoff.settings, memory, ... })
```

## 6. Error handling

- Model empty → error (as today).
- List mode, `/models` unreachable → clear UI error suggesting By ID.
- Unsupported option per catalog → `NodeOperationError`, fail fast.
- Catalog fetch failure at runtime → proceed without validation.
- `Authorization` in custom headers → dropped with warning.

## 7. Testing

Unit (vitest, existing harness):

- `modelCatalog`: cache hit/miss, TTL expiry, key isolation (different
  baseUrl/apiKey), negative cache, OpenAI-shape parsing, missing
  `supported_parameters`.
- resourceLocator resolution: list value vs. raw ID vs. expression result.
- Options → `handoff.settings` mapping; empty options → no `settings`.
- Validation: unsupported option fails, no catalog skips, no
  `supported_parameters` skips.
- Header merge: custom headers land in `config.headers`; `Authorization`
  stripped with warning.
- Agent side: `modelSettings` passed through to `generate`.
- v1 compatibility: version-1 nodes still resolve the plain string.

Manual: OpenRouter (list + reasoning + session header), plus one endpoint
without `/models` (By ID path).
