# Mastra Model Sub-Node Logging Design

## Goal

Make the connected **Mastra Model** sub-node appear in the n8n execution
tree with its input (the prompt sent to the LLM) and output (the model's
answer plus token usage) on every LLM call the agent makes — matching how
native n8n chat-model nodes surface in the tree.

Today the Model sub-node returns a static config object and never runs any
langchain method, so n8n has nothing to log for it. The MCP Client tool
already logs correctly because we call its `logWrapper`-intercepted `_call`;
the model needs an equivalent path.

## Scope

In scope:

- A logging wrapper around the resolved `LanguageModelV2` that records
  input/output to the execution tree on each `doGenerate` / `doStream` call.
- Format mapping from the AI-SDK shapes to the shape n8n renders.
- Correct behaviour under `agent.stream()` (our current call path).

Out of scope for this iteration:

- Memory sub-node logging (same technique, tackled separately).
- Real-time streaming of the answer into the chat UI (the native
  `enableStreaming` toggle) — a distinct feature, deferred.
- Internal agent-as-node AI events beyond the model node.

## Background: how n8n logs a model

n8n renders a model sub-node in the tree when that sub-node's own
`SupplyDataContext` calls `addInputData` / `addOutputData` with the
`ai_languageModel` connection type. For native langchain models this is done
by `N8nNonEstimatingTracing` (a `BaseCallbackHandler`) via `handleLLMStart` /
`handleLLMEnd`. `addInputData`/`addOutputData` **throw** on the root node's
`IExecuteFunctions` (`ExecuteContext`) and only work on a sub-node's
`SupplyDataContext`. That context is a plain object that writes into the
shared `runExecutionData.runData`, so it stays usable until the parent run
finishes — proven by the MCP tool logWrapper, which captures the context in a
closure and is invoked much later.

Our agent is Mastra, not langchain, so no native tracer ever runs for our
model. We reproduce the mechanism ourselves.

## Architecture

### Handoff contract

`MastraModelHandoff` carries a ready-to-use wrapped `LanguageModelV2`
instance (plus the original `config` for diagnostics / backward reference),
instead of only the static config.

### Model sub-node (`supplyData`)

1. Read credentials and the `model` parameter (unchanged).
2. Build the real model: `const base = await resolveModelConfig(config)`.
   Mastra's `resolveModelConfig` returns a full `LanguageModelV2`
   (`specificationVersion: 'v2'`, `provider`, `modelId`, `doGenerate`,
   `doStream`) from our `OpenAICompatibleConfig` — no new dependency needed.
3. Wrap it: `const model = wrapModelForLogging(base, this)`, capturing `this`
   (the `SupplyDataContext`) in a closure.
4. Return the handoff carrying `model`.

### Logging wrapper (`nodes/shared/modelLogging.ts`)

A hand-written Proxy over the `LanguageModelV2` that intercepts `doGenerate`
and `doStream`, and forwards every other property/method
(`provider`, `modelId`, `supportedUrls`, `specificationVersion`, …)
unchanged.

- `doGenerate(options)`:
  1. `ctx.addInputData(ai_languageModel, mapPrompt(options))`
  2. call the original `doGenerate`
  3. `ctx.addOutputData(..., mapResult(result))`
  4. return the original result.
- `doStream(options)`:
  1. `ctx.addInputData(ai_languageModel, mapPrompt(options))`
  2. call the original `doStream`
  3. forward the stream to the agent **immediately and unchanged**, while
     accumulating chunks on the side (tee/accumulator)
  4. on stream completion, `ctx.addOutputData(..., mapResult(accumulated))`.

#### Why a hand-written Proxy, not `wrapLanguageModel`

The AI-SDK ships an official `wrapLanguageModel` + `LanguageModelV2Middleware`
(`wrapGenerate` / `wrapStream`) that does exactly this kind of wrapping.
We deliberately do **not** use it here: the `ai` package is not a dependency
of this project (only `@ai-sdk/provider` types are present, via Mastra), and
because we inline all deps into the bundle (`noExternal`), adding `ai` would
grow the bundle. A small Proxy over `doGenerate`/`doStream` achieves the same
result with no new dependency.

If bundle size stops being a concern, the wrapper can be swapped for the
official `wrapLanguageModel` + middleware without changing the handoff
contract or the agent. This tradeoff is also noted in the wrapper's source
comments.

### Agent (central node)

Unchanged in logic: it receives `handoff.model` (already wrapped) and passes
it to `new Agent({ model })`. The wrapping is transparent to the agent.

## Format mapping

Two pure functions, mapping AI-SDK shapes to the `[[{ json: {...} }]]` shape
n8n's tracer uses.

- `mapPrompt(options)` → `[[{ json: { messages: [{ role, text }, …],
  options: {...} } }]]`. `LanguageModelV2Prompt` is an array of messages
  whose `content` is an array of parts (text / tool-call / …); flatten each
  message to role + text for a readable card.
- `mapResult(result)` →
  `[[{ json: { response: { text, finishReason },
  tokenUsage: { promptTokens, completionTokens, totalTokens } } }]]`.
  Tokens come from `result.usage` (`LanguageModelV2Usage`) when the provider
  returns them (OpenRouter does).

Caveat: pixel-for-pixel parity with the native OpenAI node's card is not
guaranteed — n8n renders by heuristics. The goal is a node with readable
prompt, answer, and token usage. Final polish is done after the first live
run.

## Error handling and streaming

- LLM error: wrap the call in try/catch, then
  `ctx.addOutputData(ai_languageModel, error)` (as the native tracer does)
  and re-throw so the agent fails normally.
- Streaming: the stream is handed to the agent immediately and unchanged;
  chunk accumulation happens on the side, and the log is written on stream
  close. If the stream errors mid-flight, log the error. This is the most
  delicate part and **must be verified with a live run** (it is easy to
  silently break the stream).
- Logging must never crash the agent: if `addInputData` / `addOutputData`
  itself throws, swallow it and continue — logging is not on the critical
  path.

## Testing

- Unit (mocks): `wrapModelForLogging` with a fake `LanguageModelV2`
  (`doGenerate` / `doStream`) and a fake context. Assert:
  (a) the original is called with the same args;
  (b) `addInputData` / `addOutputData` are called with the correctly mapped
  shape;
  (c) the stream is proxied in full;
  (d) an LLM error is logged and re-thrown;
  (e) a logger failure does not break the call.
- Mapping: test the pure `mapPrompt` / `mapResult` functions in isolation.
- Live run: the "Mastra Model" node appears in the execution tree with
  prompt, answer, and token usage, and the streamed answer is not broken.
