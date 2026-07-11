# Pull-Based Back-Pressure for Model doStream Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the `doStream` passthrough in `wrapModelForLogging` so it reads the provider stream lazily (back-pressure) and handles consumer cancellation, while keeping the observable logging behaviour 1:1.

**Architecture:** The hand-written `ReadableStream` underlying source keeps its accumulate-and-log role, but reading moves from an eager `for(;;)` loop in `start()` to exactly one `reader.read()` per `pull(controller)` call, so the platform's queuing strategy paces consumption. A new `cancel(reason)` handler propagates cancellation upstream and logs the partial result. Two closure-scoped idempotency guards (`releaseReader`, `logOutputOnce`) keep the reader lock and the n8n output log correct across the three terminal paths (done / source error / cancel).

**Tech Stack:** TypeScript, Web Streams API (global on Node ≥ 22), vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-11-model-dostream-backpressure-design.md`

## Global Constraints

- Repository language policy: all committed content (code, comments, tests, commit messages) is English.
- Observable logging behaviour must stay 1:1 with the current code: the 5 existing tests in `test/modelLogging.test.ts` (`wrapModelForLogging doStream` and `doGenerate` blocks) must pass **unmodified**.
- Only the `doStream` branch of `wrapModelForLogging` in `nodes/shared/modelLogging.ts` changes. `doGenerate`, mapping helpers, `safeAddInput`/`safeAddOutput`, and all callers stay untouched.
- Exactly one `addOutputData` call per `doStream` invocation (n8n pairs one output with one input index).
- Logging must never break the model call: all logging goes through the existing `safeAddOutput`, and the new guards must swallow their own failures.
- Node/tsup target: `node22`; `ReadableStream` is used as a global (no imports).
- Verification commands: `npm test`, `npm run typecheck`, `npm run build`.

---

### Task 1: Pull-based passthrough (back-pressure)

**Files:**
- Modify: `nodes/shared/modelLogging.ts:119-162` (the `doStream` branch)
- Test: `test/modelLogging.test.ts`

**Interfaces:**
- Consumes: existing `safeAddInput`, `safeAddOutput`, `mapPromptToN8n`, `mapResultToN8n` (same file, unchanged).
- Produces: the `doStream` wrapper returns `{ ...original_result, stream: passthrough }` where `passthrough` is a pull-based `ReadableStream`. Task 2 adds a `cancel` handler and a `logOutputOnce` guard to this same underlying source object; Task 1 must leave the accumulators (`text`, `usage`, `finishReason`), the `reader`, and the `releaseReader()` helper in the per-call closure so Task 2 can reference them.

- [ ] **Step 1: Write the failing back-pressure test**

Append to `test/modelLogging.test.ts` (inside the existing `describe('wrapModelForLogging doStream', ...)` block, after the last `it`):

```ts
	it('does not drain the source ahead of the consumer (back-pressure)', async () => {
		const { ctx } = makeCtx();
		let sourcePulls = 0;
		const parts = Array.from({ length: 10 }, (_, i) => ({
			type: 'text-delta',
			id: '1',
			delta: String(i),
		}));
		let next = 0;
		const source = new ReadableStream({
			pull(controller) {
				sourcePulls += 1;
				if (next < parts.length) controller.enqueue(parts[next++]);
				else controller.close();
			},
		});
		const base = {
			provider: 'p',
			modelId: 'm',
			specificationVersion: 'v2',
			doGenerate: async () => ({}),
			doStream: async () => ({ stream: source }),
		};

		const wrapped = wrapModelForLogging(base, ctx);
		const { stream } = (await wrapped.doStream({ prompt: [] })) as any;

		// Give an eager implementation time to drain the whole source.
		await new Promise((resolve) => setTimeout(resolve, 20));

		// Pull-based wrapper with the default high-water mark (1) may prefetch
		// a chunk or two, but must not have drained all 10.
		expect(sourcePulls).toBeLessThanOrEqual(3);

		const seen = await drain(stream);
		expect(seen).toEqual(parts);
	});
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `npx vitest run test/modelLogging.test.ts -t 'back-pressure'`
Expected: FAIL — the current eager `start()` loop drains the source immediately, so `sourcePulls` is 11 (10 chunks + close) and the `toBeLessThanOrEqual(3)` assertion fails.

- [ ] **Step 3: Replace the doStream branch with the pull-based implementation**

In `nodes/shared/modelLogging.ts`, replace the whole `if (prop === 'doStream') { ... }` block (currently lines 119-163) with:

```ts
			if (prop === 'doStream') {
				const original = target.doStream as (options: unknown) => Promise<Record<string, unknown>>;
				return async (options: { prompt?: unknown }) => {
					const index = safeAddInput(ctx, mapPromptToN8n(options ?? {}));
					const original_result = await original.call(target, options);
					const sourceStream = original_result.stream as ReadableStream;
					const reader = sourceStream.getReader();

					let text = '';
					let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
					let finishReason: unknown;
					let released = false;

					/** Release the source reader lock exactly once, on any terminal path. */
					const releaseReader = () => {
						if (released) return;
						released = true;
						try {
							reader.releaseLock();
						} catch {
							// lock already gone — nothing to release
						}
					};

					const passthrough = new ReadableStream({
						// One source read per pull: the platform calls pull only when the
						// consumer needs data, which is what provides back-pressure.
						async pull(controller) {
							try {
								const { done, value } = await reader.read();
								if (done) {
									controller.close();
									safeAddOutput(ctx, index, mapResultToN8n({ text, finishReason, usage }));
									releaseReader();
									return;
								}
								const part = value as Record<string, unknown>;
								if (part?.type === 'text-delta' && typeof part.delta === 'string') {
									text += part.delta;
								} else if (part?.type === 'finish') {
									usage = part.usage as typeof usage;
									finishReason = part.finishReason;
								}
								controller.enqueue(value);
							} catch (error) {
								safeAddOutput(ctx, index, error);
								controller.error(error);
								releaseReader();
							}
						},
					});

					return { ...original_result, stream: passthrough };
				};
			}
```

Notes for the implementer:
- `controller.close()` and `controller.enqueue()` are inside the `try` on purpose: if the passthrough was cancelled while `reader.read()` was pending (relevant after Task 2), `close()` throws and the `catch` path degrades safely (`controller.error()` is a spec-level no-op on a non-readable stream).
- Do not add a `start()` callback; the accumulators and `reader` live in the surrounding closure.

- [ ] **Step 4: Run the full model logging test file**

Run: `npx vitest run test/modelLogging.test.ts`
Expected: PASS — all pre-existing tests (chunk passthrough, in-band error chunk, source stream error, doGenerate suite) plus the new back-pressure test.

- [ ] **Step 5: Run the whole suite, typecheck, build**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green (65 existing tests + 1 new).

- [ ] **Step 6: Commit**

```bash
git add nodes/shared/modelLogging.ts test/modelLogging.test.ts
git commit -m "fix(model-logging): read the doStream source lazily via pull() for back-pressure"
```

---

### Task 2: cancel() propagation and output-once guard

**Files:**
- Modify: `nodes/shared/modelLogging.ts` (the `doStream` branch produced by Task 1)
- Test: `test/modelLogging.test.ts`

**Interfaces:**
- Consumes: from Task 1's closure — `reader`, `text`, `usage`, `finishReason`, `releaseReader()`, `index`, and the `passthrough` underlying source object.
- Produces: the passthrough stream additionally supports consumer cancellation: `cancel(reason)` logs the partially accumulated result via `logOutputOnce`, cancels the source reader, and releases the lock. All output logging (done / error / cancel paths) goes through `logOutputOnce(data: unknown): void`.

- [ ] **Step 1: Write the failing cancel test**

Append to `test/modelLogging.test.ts` (inside `describe('wrapModelForLogging doStream', ...)`):

```ts
	it('cancels the source and logs the partial result exactly once when the consumer cancels', async () => {
		const { ctx, calls } = makeCtx();
		let cancelReason: unknown;
		const source = new ReadableStream({
			start(controller) {
				controller.enqueue({ type: 'text-delta', id: '1', delta: 'par' });
				controller.enqueue({ type: 'text-delta', id: '1', delta: 'tial' });
				// never closes — simulates an ongoing generation
			},
			cancel(reason) {
				cancelReason = reason;
			},
		});
		const base = {
			provider: 'p',
			modelId: 'm',
			specificationVersion: 'v2',
			doGenerate: async () => ({}),
			doStream: async () => ({ stream: source }),
		};

		const wrapped = wrapModelForLogging(base, ctx);
		const { stream } = (await wrapped.doStream({ prompt: [] })) as any;

		const reader = stream.getReader();
		expect((await reader.read()).value).toEqual({ type: 'text-delta', id: '1', delta: 'par' });
		expect((await reader.read()).value).toEqual({ type: 'text-delta', id: '1', delta: 'tial' });
		await reader.cancel('user abort');

		// Let any in-flight pull settle before asserting.
		await new Promise((resolve) => setTimeout(resolve, 0));

		// Cancellation propagated upstream.
		expect(cancelReason).toBe('user abort');
		// Partial text logged exactly once, via the normal result mapping.
		expect(calls.output.length).toBe(1);
		const logged = (calls.output[0][2] as any)[0][0].json;
		expect(logged.response.text).toBe('partial');
	});
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `npx vitest run test/modelLogging.test.ts -t 'consumer cancels'`
Expected: FAIL — Task 1's stream has no `cancel` handler, so `cancelReason` stays `undefined` and `calls.output.length` is 0.

- [ ] **Step 3: Add logOutputOnce and the cancel handler**

In the `doStream` branch of `nodes/shared/modelLogging.ts`, make three edits.

3a. After the `releaseReader` helper, add:

```ts
					let logged = false;

					/**
					 * n8n pairs exactly one output with each input index, and the output
					 * is now reachable from three terminal paths (done, source error,
					 * consumer cancel) — log at most once.
					 */
					const logOutputOnce = (data: unknown) => {
						if (logged) return;
						logged = true;
						safeAddOutput(ctx, index, data);
					};
```

3b. In `pull(controller)`, replace both `safeAddOutput(ctx, index, ...)` calls with `logOutputOnce(...)`:

```ts
								if (done) {
									controller.close();
									logOutputOnce(mapResultToN8n({ text, finishReason, usage }));
									releaseReader();
									return;
								}
```

```ts
							} catch (error) {
								logOutputOnce(error);
								controller.error(error);
								releaseReader();
							}
```

3c. Add a `cancel` handler to the underlying source object, after `pull`:

```ts
						// The consumer gave up (e.g. the agent aborted generation):
						// propagate cancellation upstream so the provider stops, and log
						// whatever was accumulated so the run still shows in the tree.
						async cancel(reason: unknown) {
							logOutputOnce(mapResultToN8n({ text, finishReason, usage }));
							try {
								await reader.cancel(reason);
							} finally {
								releaseReader();
							}
						},
```

- [ ] **Step 4: Run the full model logging test file**

Run: `npx vitest run test/modelLogging.test.ts`
Expected: PASS — all previous tests plus the cancel test. The pre-existing error/done tests double as the output-once regression check because `logOutputOnce` now sits on those paths and each still asserts `calls.output.length === 1`.

- [ ] **Step 5: Run the whole suite, typecheck, build**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add nodes/shared/modelLogging.ts test/modelLogging.test.ts
git commit -m "fix(model-logging): propagate consumer cancellation and log the stream output once"
```

---

### Task 3: Live smoke test in n8n

**Files:**
- No file changes — manual verification against the running dev instance.

**Interfaces:**
- Consumes: the built bundle from Tasks 1-2 (`npm run build` output in `dist/`, symlinked into `~/.n8n/custom/node_modules/n8n-nodes-ai-mastra/dist`).
- Produces: confirmation that the acceptance criterion from the spec holds ("chat workflow `JZcX1sfCJoGJH9Xx` still shows the model sub-node in the execution tree with text + token usage").

- [ ] **Step 1: Restart the n8n dev process on the new build**

Hot reload is unreliable for this bundle; restart fully. From the repo root:

```bash
fuser -k 5678/tcp || pkill -f 'n8n start' || true
pkill -f 'TSUP_WATCH=1' || true
sleep 2
setsid bash -c 'npm exec -- concurrently -k -n build,n8n -c blue,green "cross-env TSUP_WATCH=1 tsup" "cross-env NODE_OPTIONS=--max-old-space-size=4096 N8N_DEV_RELOAD=true N8N_SECURE_COOKIE=false n8n start" > /tmp/n8n-dev.log 2>&1' < /dev/null &
sleep 35
curl -fsS http://localhost:5678/healthz
```

Expected: `{"status":"ok"}`.

- [ ] **Step 2: Run the chat workflow and inspect the execution tree**

Trigger a chat message through workflow `JZcX1sfCJoGJH9Xx` (n8n MCP tools or the editor UI at `http://localhost:5678`), then open the resulting execution.

Expected:
- The agent answers normally (streaming unaffected).
- The `OpenAI-compatible Model (Mastra)` sub-node appears in the execution tree with an input run (`messages`) and an output run containing `response.text` (non-empty) and `tokenUsage` (`promptTokens`/`completionTokens`/`totalTokens` populated).
- The `Postgres Memory (Mastra)` sub-node still shows its `recall`/`saveMessages` runs (no regression from this change).

- [ ] **Step 3: Record the result**

No commit — report the execution id and observed tree entries in the task summary so the reviewer can verify.
