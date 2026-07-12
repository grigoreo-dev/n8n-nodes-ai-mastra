# Design: pull-based back-pressure for the model logging stream wrapper

Date: 2026-07-11
Status: approved (design discussion in session; user delegated details after
sections 1–3 were approved individually)

## Problem

`wrapModelForLogging` (`nodes/shared/modelLogging.ts`) wraps `doStream` in a
passthrough `ReadableStream` so the accumulated text/usage can be logged onto
the model sub-node's `ai_languageModel` connection. The current implementation
reads the entire source stream inside the underlying source's `start()`
callback in an unconditional `for (;;)` loop.

Consequences:

- **No back-pressure.** `controller.enqueue()` never blocks, and the loop never
  consults `desiredSize`, so the wrapper eagerly drains the provider stream
  regardless of how fast the consumer reads.
- **Unbounded buffering.** If the consumer is slower than the provider, every
  chunk accumulates in the passthrough stream's internal queue.
- **Streaming semantics lost.** The wrapper effectively converts the stream
  into an eager buffered download.
- **No `cancel()` handler.** If the consumer cancels the passthrough stream
  (e.g. the agent aborts generation), the source reader keeps its lock and the
  upstream provider stream is never cancelled — a connection/resource leak.

In practice the Mastra agent drains the stream promptly, so this has not caused
a visible bug — this is a correctness/robustness fix, not a bug fix.

## Decision

Keep the hand-written `ReadableStream` underlying source, but:

1. Move reading from `start()` to `pull(controller)` — one `reader.read()` per
   `pull` call, so the platform's queuing strategy drives when the source is
   read. This restores natural back-pressure.
2. Add a `cancel(reason)` handler that cancels the source reader and logs the
   partially accumulated result.
3. Preserve the observable logging behaviour **1:1** (explicit user
   requirement).

`TransformStream` + `pipeThrough` was considered and rejected: `flush()` does
not run when the source errors, so preserving the current error logging would
require a separate interception mechanism — more risk for no behavioural gain.
Keeping the current code unchanged was rejected because it does not fix
back-pressure.

## Design

All per-call state lives in a closure created per `doStream` invocation:

- `reader` — `sourceStream.getReader()`, obtained once.
- Accumulators: `text` (from `text-delta` parts), `usage` and `finishReason`
  (from the `finish` part) — unchanged from the current code.
- `released` flag — idempotent reader release guard.
- `logged` flag — output-once guard.

### Helpers (closure-scoped)

```text
releaseReader():
  if released → return
  released = true
  try { reader.releaseLock() } catch {}

logOutputOnce(data):
  if logged → return
  logged = true
  safeAddOutput(ctx, index, data)
```

`logged` exists because `addOutputData` may now be reachable from three
terminal paths (`pull` done, `pull` catch, `cancel`), and n8n expects exactly
one output per input index.

### `pull(controller)`

```text
try:
  { done, value } = await reader.read()      // exactly one read per pull
  if done:
    controller.close()
    logOutputOnce(mapResultToN8n({ text, finishReason, usage }))
    releaseReader()
    return
  if value.type === 'text-delta' and delta is string: text += delta
  else if value.type === 'finish': usage = value.usage; finishReason = value.finishReason
  controller.enqueue(value)
catch error:                                  // source errored (reader.read() rejected)
  logOutputOnce(error)                        // log the error object, same as today
  controller.error(error)
  releaseReader()
```

The platform calls `pull` only when the consumer needs data (`desiredSize > 0`),
which is what provides back-pressure. Chunks pass through unchanged.

### `cancel(reason)`

```text
logOutputOnce(mapResultToN8n({ text, finishReason, usage }))  // partial result
upstreamCancelled = reader.cancel(reason)     // propagate cancellation upstream
releaseReader()                               // do not wait for upstream
await upstreamCancelled                       // surface upstream failures
```

Rationale: cancelling downstream must cancel the provider stream (no leak), and
the partially generated text still lands in the execution tree. The lock is
released immediately after starting the upstream cancellation — not after it
settles — so a slow or hung upstream `cancel()` cannot keep the source locked.

### Observable behaviour (must stay 1:1 with current code)

| Scenario | Logged output |
| --- | --- |
| Stream completes normally | `mapResultToN8n({ text, finishReason, usage })` |
| In-band `{type:'error'}` chunk | chunk forwarded as-is; accumulated result logged at close |
| Source stream errors (`controller.error`) | the error object itself; error propagated to consumer |
| Consumer cancels (new) | partial `mapResultToN8n(...)`; source cancelled |

The first three rows are covered by existing tests in
`test/modelLogging.test.ts` (`wrapModelForLogging doStream` describe block) and
those tests must pass unchanged.

## Scope

- Only the `doStream` branch of `wrapModelForLogging` changes.
- `doGenerate`, the mapping helpers, `safeAddInput`/`safeAddOutput`, and the
  caller (`ModelOpenAiCompatibleMastra.node.ts`) are untouched.
- No new dependencies; `ReadableStream` is global on Node ≥ 22 (tsup target
  `node22`).

## Testing

TDD. Existing 5 `doStream` tests must pass without modification. New tests:

1. **Back-pressure:** with an instrumented source that counts reads, assert the
   wrapper does not drain the source before the consumer reads (allowing for
   the queue's high-water mark of 1: at most `consumed + HWM` reads).
2. **Cancel:** consumer cancels mid-stream → source received the cancellation,
   reader lock released, partial accumulated text logged exactly once.
3. **Output-once:** across done/error/cancel permutations, `addOutputData` is
   called at most once per `doStream` call.

## Acceptance

- All unit tests green (`npm test`), typecheck and build green.
- Live smoke: chat workflow `JZcX1sfCJoGJH9Xx` still shows the model sub-node
  in the execution tree with text + token usage.
