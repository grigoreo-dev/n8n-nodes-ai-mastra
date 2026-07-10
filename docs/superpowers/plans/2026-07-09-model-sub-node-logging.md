# Mastra Model Sub-Node Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the connected Mastra Model sub-node appear in the n8n execution tree with the prompt (input) and the model's answer plus token usage (output) on every LLM call.

**Architecture:** The Model sub-node builds a real `LanguageModelV2` from its config via Mastra's `resolveModelConfig`, wraps it in a hand-written Proxy that intercepts `doGenerate`/`doStream` and logs to the sub-node's captured `SupplyDataContext` via `addInputData`/`addOutputData` (`ai_languageModel`). Pure mapper functions convert AI-SDK shapes to n8n's `[[{ json }]]` shape. The Agent node consumes the already-wrapped model unchanged.

**Tech Stack:** TypeScript, n8n-workflow (`ISupplyDataFunctions`), `@mastra/core/llm` (`resolveModelConfig`), `@ai-sdk/provider` types (`LanguageModelV2`), vitest, tsup.

## Global Constraints

- Repo content is English only (code, comments, docs, identifiers, log/error strings). Chat may be Russian.
- No new runtime dependencies. Do NOT add the `ai` package. Wrap the model with a hand-written Proxy over `doGenerate`/`doStream`, not `wrapLanguageModel`. Document this choice and the alternative in code comments.
- Build stays tsup with `noExternal: [/@mastra\/.*/, 'pg', 'zod']`, `minify: true`.
- Logging must never crash the agent: any throw from `addInputData`/`addOutputData` is swallowed.
- The stream returned by `doStream` must be forwarded to the agent unchanged; logging happens on the side.
- Tests are vitest; follow TDD (failing test first). Prefer real code over mocks except for the n8n context and the model, which are unavoidable to fake.

---

## File Structure

- `nodes/shared/modelLogging.ts` (create): the mapper functions (`mapPromptToN8n`, `mapResultToN8n`) and `wrapModelForLogging(model, ctx)`.
- `nodes/shared/modelHandoff.ts` (modify): extend `MastraModelHandoff` to carry the wrapped model.
- `nodes/ModelOpenAiCompatibleMastra/ModelOpenAiCompatibleMastra.node.ts` (modify): resolve + wrap the model in `supplyData`.
- `nodes/MastraAgent/MastraAgent.node.ts` (modify): use `handoff.model` instead of `handoff.config`.
- `test/modelLogging.test.ts` (create): unit tests for mappers and wrapper.

---

## Task 1: Prompt/result mapper functions

**Files:**
- Create: `nodes/shared/modelLogging.ts`
- Test: `test/modelLogging.test.ts`

**Interfaces:**
- Consumes: `@ai-sdk/provider` types `LanguageModelV2CallOptions`, `LanguageModelV2Usage` (types only, already present transitively).
- Produces:
  - `mapPromptToN8n(options: { prompt: unknown }): Array<Array<{ json: Record<string, unknown> }>>`
  - `mapResultToN8n(result: { content?: unknown; text?: string; finishReason?: unknown; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }): Array<Array<{ json: Record<string, unknown> }>>`
  - Both return the n8n `addInputData`/`addOutputData` payload shape: a single item wrapped as `[[{ json }]]`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/modelLogging.test.ts
import { describe, expect, it } from 'vitest';

import { mapPromptToN8n, mapResultToN8n } from '../nodes/shared/modelLogging';

describe('mapPromptToN8n', () => {
	it('flattens messages to role + text', () => {
		const options = {
			prompt: [
				{ role: 'system', content: 'be nice' },
				{ role: 'user', content: [{ type: 'text', text: 'hello' }] },
				{
					role: 'assistant',
					content: [
						{ type: 'text', text: 'hi ' },
						{ type: 'text', text: 'there' },
					],
				},
			],
		};

		const out = mapPromptToN8n(options);

		expect(out).toEqual([
			[
				{
					json: {
						messages: [
							{ role: 'system', text: 'be nice' },
							{ role: 'user', text: 'hello' },
							{ role: 'assistant', text: 'hi there' },
						],
					},
				},
			],
		]);
	});

	it('tolerates a missing/empty prompt', () => {
		expect(mapPromptToN8n({ prompt: undefined })).toEqual([[{ json: { messages: [] } }]]);
	});
});

describe('mapResultToN8n', () => {
	it('maps text, finishReason and token usage', () => {
		const out = mapResultToN8n({
			text: 'answer',
			finishReason: 'stop',
			usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
		});

		expect(out).toEqual([
			[
				{
					json: {
						response: { text: 'answer', finishReason: 'stop' },
						tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
					},
				},
			],
		]);
	});

	it('derives text from content parts when text is absent', () => {
		const out = mapResultToN8n({
			content: [
				{ type: 'text', text: 'a' },
				{ type: 'text', text: 'b' },
			],
			finishReason: 'stop',
		});

		expect(out[0][0].json.response).toEqual({ text: 'ab', finishReason: 'stop' });
	});

	it('tolerates missing usage', () => {
		const out = mapResultToN8n({ text: 'x', finishReason: 'stop' });
		expect(out[0][0].json.tokenUsage).toEqual({
			promptTokens: undefined,
			completionTokens: undefined,
			totalTokens: undefined,
		});
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/modelLogging.test.ts`
Expected: FAIL — cannot find module `../nodes/shared/modelLogging` (mapPromptToN8n/mapResultToN8n not defined).

- [ ] **Step 3: Write minimal implementation**

```typescript
// nodes/shared/modelLogging.ts
type N8nLogPayload = Array<Array<{ json: Record<string, unknown> }>>;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/** Join the `.text` of every text-like content part in a message. */
function partsToText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.map((part) =>
			isObject(part) && typeof (part as { text?: unknown }).text === 'string'
				? (part as { text: string }).text
				: '',
		)
		.join('');
}

/** Map a LanguageModelV2 call's prompt to the n8n addInputData payload shape. */
export function mapPromptToN8n(options: { prompt?: unknown }): N8nLogPayload {
	const prompt = Array.isArray(options?.prompt) ? options.prompt : [];
	const messages = prompt.map((message) => {
		const role = isObject(message) ? (message as { role?: unknown }).role : undefined;
		return {
			role: typeof role === 'string' ? role : 'unknown',
			text: partsToText(isObject(message) ? (message as { content?: unknown }).content : ''),
		};
	});
	return [[{ json: { messages } }]];
}

/** Map a LanguageModelV2 generate/stream result to the n8n addOutputData payload shape. */
export function mapResultToN8n(result: {
	content?: unknown;
	text?: string;
	finishReason?: unknown;
	usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}): N8nLogPayload {
	const text =
		typeof result.text === 'string' && result.text.length > 0
			? result.text
			: partsToText(result.content);
	const usage = result.usage ?? {};
	return [
		[
			{
				json: {
					response: { text, finishReason: result.finishReason },
					tokenUsage: {
						promptTokens: usage.inputTokens,
						completionTokens: usage.outputTokens,
						totalTokens: usage.totalTokens,
					},
				},
			},
		],
	];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/modelLogging.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add nodes/shared/modelLogging.ts test/modelLogging.test.ts
git commit -m "feat(model): add n8n log payload mappers for model prompt/result"
```

---

## Task 2: `wrapModelForLogging` — doGenerate path

**Files:**
- Modify: `nodes/shared/modelLogging.ts`
- Test: `test/modelLogging.test.ts`

**Interfaces:**
- Consumes: `mapPromptToN8n`, `mapResultToN8n` from Task 1.
- Produces:
  - `interface ModelLogContext { addInputData(connectionType: string, data: unknown): { index: number } | void; addOutputData(connectionType: string, index: number, data: unknown): void; }`
  - `wrapModelForLogging<T extends { doGenerate: Function; doStream: Function }>(model: T, ctx: ModelLogContext): T` — returns a Proxy that logs `doGenerate` input/output on the `ai_languageModel` connection and forwards all other members unchanged. (`doStream` handled in Task 3.)
  - Exported constant `AI_LANGUAGE_MODEL_CONNECTION = 'ai_languageModel'`.

- [ ] **Step 1: Write the failing test**

```typescript
// append to test/modelLogging.test.ts
import { AI_LANGUAGE_MODEL_CONNECTION, wrapModelForLogging } from '../nodes/shared/modelLogging';

function makeCtx() {
	const calls: { input: unknown[]; output: unknown[] } = { input: [], output: [] };
	const ctx = {
		addInputData: (type: string, data: unknown) => {
			calls.input.push([type, data]);
			return { index: 0 };
		},
		addOutputData: (type: string, index: number, data: unknown) => {
			calls.output.push([type, index, data]);
		},
	};
	return { ctx, calls };
}

describe('wrapModelForLogging doGenerate', () => {
	it('logs input then output and returns the original result', async () => {
		const { ctx, calls } = makeCtx();
		const result = { text: 'answer', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } };
		const base = {
			provider: 'p',
			modelId: 'm',
			specificationVersion: 'v2',
			doGenerate: async (_o: unknown) => result,
			doStream: async () => ({ stream: new ReadableStream() }),
		};

		const wrapped = wrapModelForLogging(base, ctx);
		const out = await wrapped.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });

		expect(out).toBe(result);
		expect(calls.input[0][0]).toBe(AI_LANGUAGE_MODEL_CONNECTION);
		expect(calls.output[0][0]).toBe(AI_LANGUAGE_MODEL_CONNECTION);
		expect((calls.output[0][2] as any)[0][0].json.response.text).toBe('answer');
	});

	it('forwards non-intercepted members unchanged', () => {
		const { ctx } = makeCtx();
		const base = { provider: 'p', modelId: 'm', specificationVersion: 'v2', doGenerate: async () => ({}), doStream: async () => ({}) };
		const wrapped = wrapModelForLogging(base, ctx);
		expect(wrapped.provider).toBe('p');
		expect(wrapped.modelId).toBe('m');
		expect(wrapped.specificationVersion).toBe('v2');
	});

	it('logs the error and rethrows when doGenerate throws', async () => {
		const { ctx, calls } = makeCtx();
		const boom = new Error('llm failed');
		const base = { provider: 'p', modelId: 'm', specificationVersion: 'v2', doGenerate: async () => { throw boom; }, doStream: async () => ({}) };
		const wrapped = wrapModelForLogging(base, ctx);
		await expect(wrapped.doGenerate({ prompt: [] })).rejects.toBe(boom);
		expect(calls.output[0][2]).toBe(boom);
	});

	it('does not crash the call when the logger throws', async () => {
		const badCtx = {
			addInputData: () => { throw new Error('log boom'); },
			addOutputData: () => { throw new Error('log boom'); },
		};
		const base = { provider: 'p', modelId: 'm', specificationVersion: 'v2', doGenerate: async () => ({ text: 'ok', finishReason: 'stop' }), doStream: async () => ({}) };
		const wrapped = wrapModelForLogging(base, badCtx);
		await expect(wrapped.doGenerate({ prompt: [] })).resolves.toEqual({ text: 'ok', finishReason: 'stop' });
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/modelLogging.test.ts`
Expected: FAIL — `wrapModelForLogging` / `AI_LANGUAGE_MODEL_CONNECTION` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `nodes/shared/modelLogging.ts`:

```typescript
export const AI_LANGUAGE_MODEL_CONNECTION = 'ai_languageModel';

export interface ModelLogContext {
	addInputData(connectionType: string, data: unknown): { index: number } | void;
	addOutputData(connectionType: string, index: number, data: unknown): void;
}

/** Swallow logger failures — logging must never break the model call. */
function safeAddInput(ctx: ModelLogContext, data: unknown): number {
	try {
		const res = ctx.addInputData(AI_LANGUAGE_MODEL_CONNECTION, data);
		return res && typeof res.index === 'number' ? res.index : 0;
	} catch {
		return 0;
	}
}

function safeAddOutput(ctx: ModelLogContext, index: number, data: unknown): void {
	try {
		ctx.addOutputData(AI_LANGUAGE_MODEL_CONNECTION, index, data);
	} catch {
		// logging is not on the critical path
	}
}

/**
 * Wrap a LanguageModelV2 so each call records input/output onto the
 * ai_languageModel connection of the model sub-node, making it appear in the
 * n8n execution tree.
 *
 * We use a hand-written Proxy over doGenerate/doStream instead of the AI SDK's
 * official `wrapLanguageModel` + middleware. Rationale: the `ai` package is not
 * a dependency of this project (only @ai-sdk/provider types are present via
 * Mastra), and because we inline all deps into the bundle (noExternal), adding
 * `ai` would grow the bundle. If bundle size stops mattering, swap this Proxy
 * for `wrapLanguageModel` + a LanguageModelV2Middleware (wrapGenerate/wrapStream)
 * without changing callers.
 */
export function wrapModelForLogging<T extends Record<string, unknown>>(
	model: T,
	ctx: ModelLogContext,
): T {
	return new Proxy(model, {
		get(target, prop, receiver) {
			if (prop === 'doGenerate') {
				const original = target.doGenerate as (options: unknown) => Promise<unknown>;
				return async (options: { prompt?: unknown }) => {
					const index = safeAddInput(ctx, mapPromptToN8n(options ?? {}));
					try {
						const result = await original.call(target, options);
						safeAddOutput(ctx, index, mapResultToN8n(result as never));
						return result;
					} catch (error) {
						safeAddOutput(ctx, index, error);
						throw error;
					}
				};
			}
			// doStream handled in Task 3; everything else passes through.
			return Reflect.get(target, prop, receiver);
		},
	});
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/modelLogging.test.ts`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add nodes/shared/modelLogging.ts test/modelLogging.test.ts
git commit -m "feat(model): wrap doGenerate to log model input/output to the tree"
```

---

## Task 3: `wrapModelForLogging` — doStream path

**Files:**
- Modify: `nodes/shared/modelLogging.ts`
- Test: `test/modelLogging.test.ts`

**Interfaces:**
- Consumes: everything from Task 2.
- Produces: the same `wrapModelForLogging`, now also intercepting `doStream`. It forwards the original `{ stream, ... }` result to the caller with the `stream` replaced by a pass-through `ReadableStream` that emits identical chunks while accumulating `text-delta` deltas and the final `finish` chunk's `usage`/`finishReason`; on stream close it logs via `mapResultToN8n`.

- [ ] **Step 1: Write the failing test**

```typescript
// append to test/modelLogging.test.ts
async function drain(stream: ReadableStream): Promise<unknown[]> {
	const reader = stream.getReader();
	const chunks: unknown[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}
	return chunks;
}

function streamOf(parts: unknown[]): ReadableStream {
	return new ReadableStream({
		start(controller) {
			for (const p of parts) controller.enqueue(p);
			controller.close();
		},
	});
}

describe('wrapModelForLogging doStream', () => {
	it('passes every chunk through unchanged and logs accumulated text + usage', async () => {
		const { ctx, calls } = makeCtx();
		const parts = [
			{ type: 'text-delta', id: '1', delta: 'Hel' },
			{ type: 'text-delta', id: '1', delta: 'lo' },
			{ type: 'finish', finishReason: 'stop', usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } },
		];
		const base = {
			provider: 'p',
			modelId: 'm',
			specificationVersion: 'v2',
			doGenerate: async () => ({}),
			doStream: async (_o: unknown) => ({ stream: streamOf(parts), extra: 1 }),
		};

		const wrapped = wrapModelForLogging(base, ctx);
		const { stream, extra } = (await wrapped.doStream({ prompt: [] })) as any;

		// non-stream fields preserved
		expect(extra).toBe(1);

		const seen = await drain(stream);
		expect(seen).toEqual(parts); // chunks unchanged

		// input logged once, output logged once after close
		expect(calls.input.length).toBe(1);
		expect(calls.output.length).toBe(1);
		const logged = (calls.output[0][2] as any)[0][0].json;
		expect(logged.response.text).toBe('Hello');
		expect(logged.response.finishReason).toBe('stop');
		expect(logged.tokenUsage).toEqual({ promptTokens: 4, completionTokens: 2, totalTokens: 6 });
	});

	it('logs an error chunk and still forwards it', async () => {
		const { ctx, calls } = makeCtx();
		const err = { type: 'error', error: new Error('mid-stream') };
		const base = {
			provider: 'p', modelId: 'm', specificationVersion: 'v2',
			doGenerate: async () => ({}),
			doStream: async () => ({ stream: streamOf([{ type: 'text-delta', id: '1', delta: 'x' }, err]) }),
		};
		const wrapped = wrapModelForLogging(base, ctx);
		const { stream } = (await wrapped.doStream({ prompt: [] })) as any;
		const seen = await drain(stream);
		expect(seen).toContainEqual(err);
		expect(calls.output.length).toBe(1); // still logged something on close
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/modelLogging.test.ts`
Expected: FAIL — `doStream` currently passes through (no accumulation/logging), so `calls.output.length` is 0.

- [ ] **Step 3: Write minimal implementation**

In `wrapModelForLogging`'s `get` handler, add a `doStream` branch before the pass-through `return`:

```typescript
			if (prop === 'doStream') {
				const original = target.doStream as (options: unknown) => Promise<Record<string, unknown>>;
				return async (options: { prompt?: unknown }) => {
					const index = safeAddInput(ctx, mapPromptToN8n(options ?? {}));
					const original_result = await original.call(target, options);
					const sourceStream = original_result.stream as ReadableStream;

					let text = '';
					let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
					let finishReason: unknown;

					const passthrough = new ReadableStream({
						async start(controller) {
							const reader = sourceStream.getReader();
							try {
								for (;;) {
									const { done, value } = await reader.read();
									if (done) break;
									const part = value as Record<string, unknown>;
									if (part?.type === 'text-delta' && typeof part.delta === 'string') {
										text += part.delta;
									} else if (part?.type === 'finish') {
										usage = part.usage as typeof usage;
										finishReason = part.finishReason;
									}
									controller.enqueue(value);
								}
							} catch (error) {
								safeAddOutput(ctx, index, error);
								controller.error(error);
								return;
							}
							controller.close();
							safeAddOutput(ctx, index, mapResultToN8n({ text, finishReason, usage }));
						},
					});

					return { ...original_result, stream: passthrough };
				};
			}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/modelLogging.test.ts`
Expected: PASS (Task 1–3 tests).

- [ ] **Step 5: Commit**

```bash
git add nodes/shared/modelLogging.ts test/modelLogging.test.ts
git commit -m "feat(model): wrap doStream to log accumulated answer + usage"
```

---

## Task 4: Extend the model handoff to carry the wrapped model

**Files:**
- Modify: `nodes/shared/modelHandoff.ts`
- Test: `test/modelLogging.test.ts` (add a small guard test) OR none if only a type change — include the guard test to keep `isMastraModelHandoff` honest.

**Interfaces:**
- Consumes: existing `MastraModelHandoff` / `isMastraModelHandoff`.
- Produces: `MastraModelHandoff` now has a `model: unknown` field (the wrapped `LanguageModelV2`) alongside the existing `config`. `isMastraModelHandoff` unchanged (still brands on `__isMastraModel`).

- [ ] **Step 1: Write the failing test**

This test constructs a `MastraModelHandoff` through its type, so it only
compiles once the `model` field exists — that is the failing signal.

```typescript
// append to test/modelLogging.test.ts
import { isMastraModelHandoff, type MastraModelHandoff } from '../nodes/shared/modelHandoff';

describe('MastraModelHandoff with model', () => {
	it('recognises a handoff carrying a wrapped model', () => {
		const handoff: MastraModelHandoff = {
			__isMastraModel: true,
			config: { providerId: 'openai-compatible', modelId: 'm', url: 'http://x/v1', apiKey: 'k' },
			model: { provider: 'p' },
		};
		expect(isMastraModelHandoff(handoff)).toBe(true);
		expect(handoff.model).toBeDefined();
	});
});
```

- [ ] **Step 2: Run typecheck to verify it fails**

Run: `npm run typecheck`
Expected: FAIL — `Object literal may only specify known properties, and 'model' does not exist in type 'MastraModelHandoff'`.

- [ ] **Step 3: Add the field**

In `nodes/shared/modelHandoff.ts`, extend the interface:

```typescript
export interface MastraModelHandoff {
	__isMastraModel: true;
	config: OpenAICompatibleConfig;
	/**
	 * The resolved LanguageModelV2, wrapped for execution-tree logging
	 * (see nodes/shared/modelLogging.ts). The Agent passes this straight to
	 * `new Agent({ model })`. `config` is retained for diagnostics.
	 */
	model: unknown;
}
```

- [ ] **Step 4: Run test + typecheck to verify pass**

Run: `npx vitest run test/modelLogging.test.ts && npm run typecheck`
Expected: PASS and no type errors.

- [ ] **Step 5: Commit**

```bash
git add nodes/shared/modelHandoff.ts test/modelLogging.test.ts
git commit -m "feat(model): carry the wrapped LanguageModelV2 on the handoff"
```

---

## Task 5: Resolve + wrap the model in the sub-node's supplyData

**Files:**
- Modify: `nodes/ModelOpenAiCompatibleMastra/ModelOpenAiCompatibleMastra.node.ts`

**Interfaces:**
- Consumes: `resolveModelConfig` from `@mastra/core/llm`, `wrapModelForLogging` from `nodes/shared/modelLogging`, extended `MastraModelHandoff` from Task 4.
- Produces: `supplyData` returns a handoff whose `model` is the wrapped `LanguageModelV2`, capturing `this` (the `ISupplyDataFunctions`) as the log context.

- [ ] **Step 1: Add imports**

At the top of `ModelOpenAiCompatibleMastra.node.ts`, add:

```typescript
import { resolveModelConfig } from '@mastra/core/llm';

import { wrapModelForLogging, type ModelLogContext } from '../shared/modelLogging';
```

- [ ] **Step 2: Resolve and wrap the model before returning the handoff**

Replace the `return { response: handoff };` block. After building `handoff.config` (the `MastraModelHandoff` `config` object), insert:

```typescript
		// Build the real LanguageModelV2 from our config, then wrap it so each
		// LLM call logs prompt/response/usage onto this sub-node's
		// ai_languageModel connection (making the Mastra Model node show up in
		// the execution tree, like stock n8n chat-model nodes).
		const resolved = await resolveModelConfig(handoff.config);
		const model = wrapModelForLogging(
			resolved as unknown as Record<string, unknown>,
			this as unknown as ModelLogContext,
		);

		return {
			response: { ...handoff, model },
		};
```

Ensure the constructed handoff object no longer sets a `model` placeholder before this point; `handoff` from earlier in the function keeps `__isMastraModel` + `config`, and `model` is added here.

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: no type errors; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add nodes/ModelOpenAiCompatibleMastra/ModelOpenAiCompatibleMastra.node.ts
git commit -m "feat(model): resolve and wrap the model for logging in supplyData"
```

---

## Task 6: Agent consumes the wrapped model

**Files:**
- Modify: `nodes/MastraAgent/MastraAgent.node.ts:153`

**Interfaces:**
- Consumes: `MastraModelHandoff.model` from Task 4/5.
- Produces: the Agent builds `new Agent({ model })` from `connectedModel.model` (falling back to `connectedModel.config` if `model` is absent, for safety).

- [ ] **Step 1: Use the wrapped model**

Replace line 153:

```typescript
				const model: ConstructorParameters<typeof AgentType>[0]['model'] = connectedModel.config;
```

with:

```typescript
				// Prefer the wrapped, logging-enabled model; fall back to the raw
				// config if an older handoff without `model` is connected.
				const model: ConstructorParameters<typeof AgentType>[0]['model'] = (connectedModel.model ??
					connectedModel.config) as ConstructorParameters<typeof AgentType>[0]['model'];
```

- [ ] **Step 2: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: no type errors; build succeeds.

- [ ] **Step 3: Run the full unit suite**

Run: `npx vitest run`
Expected: PASS — all existing tests plus the new `modelLogging` tests.

- [ ] **Step 4: Commit**

```bash
git add nodes/MastraAgent/MastraAgent.node.ts
git commit -m "feat(agent): use the wrapped logging model from the handoff"
```

---

## Task 7: Live verification in a real n8n

**Files:** none (verification only).

**Interfaces:** consumes the fully built package.

- [ ] **Step 1: Restart dev n8n with the fresh build**

Run (kill the n8n process group on :5678, then relaunch detached):

```bash
PID=$(ss -ltnp 2>/dev/null | grep ":5678" | grep -oP 'pid=\K[0-9]+' | head -1)
PGID=$(ps -o pgid= -p "$PID" 2>/dev/null | tr -d ' ')
[ -n "$PGID" ] && kill -KILL -"$PGID" 2>/dev/null
sleep 5
rm -f /tmp/n8n-dev.log
setsid bash -c 'npm run dev > /tmp/n8n-dev.log 2>&1' < /dev/null >/dev/null 2>&1 & disown
```

Wait ~35s, then: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5678/healthz`
Expected: `200`.

- [ ] **Step 2: Execute the test workflow via n8n MCP**

Use the n8n MCP `execute_workflow` on workflow `JZcX1sfCJoGJH9Xx` with a chat input, then `get_execution` with `includeData: true`.

Expected: a `Mastra Model` entry appears in `runData` with input messages and output (text + token usage), and `status: success`.

- [ ] **Step 3: Confirm streaming is not broken**

In the same execution, confirm the agent's final `output` text is present and complete (not empty/truncated), proving the pass-through stream still feeds the agent.

Expected: non-empty, coherent agent answer.

- [ ] **Step 4: Update the backlog**

Remove the now-implemented "Model execution logs" item from `docs/BACKLOG.md` (it is superseded by this feature).

```bash
git add docs/BACKLOG.md
git commit -m "docs(backlog): drop model execution logs item (implemented)"
```

---

## Self-Review

- **Spec coverage:** wrapper (Tasks 2–3), mapping (Task 1), streaming under `agent.stream()` (Task 3 + Task 7 Step 3), handoff change (Task 4), sub-node resolve+wrap capturing context (Task 5), agent transparency (Task 6), error handling + logger-never-crashes (Task 2 tests), live tree verification (Task 7). Out-of-scope items (memory, chat streaming toggle) are not tasked — correct.
- **No-new-dependency constraint:** Task 2 comment documents the Proxy-vs-`wrapLanguageModel` choice and the alternative, per the spec.
- **Type consistency:** `mapPromptToN8n`/`mapResultToN8n` names match across Tasks 1–3; `wrapModelForLogging`/`ModelLogContext`/`AI_LANGUAGE_MODEL_CONNECTION` consistent Tasks 2–5; `MastraModelHandoff.model` consistent Tasks 4–6.
