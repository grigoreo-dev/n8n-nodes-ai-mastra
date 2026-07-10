# Memory Sub-Node Logging Implementation Plan

> **Superseded during implementation:** live testing showed Mastra 1.49's agent chat path bypasses `Memory.recall`/`Memory.saveMessages` (it goes through the `MessageHistory` processor straight to `storage.getStore('memory')` → `store.listMessages`/`store.saveMessages`). The shipped implementation intercepts at the storage store level via instance monkey-patching (`wrapMemoryStorageForLogging`) — see the design spec `docs/superpowers/specs/2026-07-10-memory-sub-node-logging-design.md` and `nodes/shared/memoryLogging.ts` for the current architecture. The task bodies below reflect the original (pre-discovery) plan and its `normalizeCreatedAt` lacks the defensive date guards that the final code has.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Postgres Memory (Mastra) sub-node appear in n8n's execution tree when Mastra reads from or writes to memory.

**Architecture:** Add a focused shared module that maps Mastra memory messages into n8n run-data payloads and wraps the `@mastra/memory` `Memory` instance with a Proxy over `recall` and `saveMessages`. The memory sub-node will hand off the wrapped instance; the agent node remains unchanged because it already consumes `connected.memory`.

**Tech Stack:** TypeScript, n8n node SDK (`ISupplyDataFunctions`, `NodeConnectionTypes.AiMemory`), Mastra `@mastra/memory`, Vitest, tsup.

## Global Constraints

- Repository content must be English only: code, comments, docs, commit messages, identifiers, and log/error strings.
- Keep dependency footprint unchanged; do not add packages for this feature.
- Logging must be diagnostic only: failures in `addInputData` or `addOutputData` must never break memory calls.
- Preserve memory behavior: return original Mastra results unchanged and do not mutate thread/resource scope.
- Keep the implementation small and aligned with `nodes/shared/modelLogging.ts`.
- Verification commands: `npx vitest run`, `npm run typecheck`, and `npm run build`.

---

## File Structure

- Create `nodes/shared/memoryLogging.ts`: owns memory log payload mapping, safe n8n log writes, and `wrapMemoryForLogging` Proxy logic.
- Create `test/memoryLogging.test.ts`: unit tests for mapper and wrapper behavior, independent of real Postgres or real Mastra memory.
- Modify `nodes/MemoryPostgresMastra/MemoryPostgresMastra.node.ts`: wrap the constructed `Memory` instance before putting it on `MastraMemoryHandoff`.
- Modify `test/memoryPostgresMastra.test.ts`: assert the handoff carries a logging-wrapped memory object by exercising `recall` with a mocked n8n log context.
- Modify `docs/BACKLOG.md`: remove the completed memory logging backlog item or replace it with any narrower follow-up discovered during implementation.

---

### Task 1: Memory Message Mapper

**Files:**
- Create: `nodes/shared/memoryLogging.ts`
- Create: `test/memoryLogging.test.ts`

**Interfaces:**
- Consumes: MastraDBMessage-like objects with optional `id`, `role`, `createdAt`, `threadId`, `resourceId`, and `content`.
- Produces:
  - `export const AI_MEMORY_CONNECTION = 'ai_memory';`
  - `export function mapMemoryMessagesToN8n(input: MemoryLogInput): N8nLogPayload`
  - `export interface MemoryLogInput { operation: 'recall' | 'saveMessages'; messages?: unknown[]; threadId?: string; resourceId?: string; usage?: { tokens?: number }; }`

- [ ] **Step 1: Write failing mapper tests**

Create `test/memoryLogging.test.ts` with these initial tests:

```ts
import { describe, expect, it } from 'vitest';

import { mapMemoryMessagesToN8n } from '../nodes/shared/memoryLogging';

describe('mapMemoryMessagesToN8n', () => {
	it('maps summary fields and normalized messages', () => {
		const createdAt = new Date('2026-07-10T00:00:00.000Z');

		const out = mapMemoryMessagesToN8n({
			operation: 'recall',
			threadId: 'thread-1',
			resourceId: 'user-1',
			usage: { tokens: 12 },
			messages: [
				{
					id: 'msg-1',
					role: 'user',
					createdAt,
					threadId: 'thread-1',
					resourceId: 'user-1',
					content: { format: 2, content: 'hello from memory', parts: [] },
				},
			],
		});

		expect(out).toEqual([
			[
				{
					json: {
						operation: 'recall',
						threadId: 'thread-1',
						resourceId: 'user-1',
						messageCount: 1,
						tokenUsage: { totalTokens: 12 },
						messages: [
							{
								id: 'msg-1',
								role: 'user',
								text: 'hello from memory',
								createdAt: '2026-07-10T00:00:00.000Z',
								threadId: 'thread-1',
								resourceId: 'user-1',
							},
						],
					},
				},
			],
		]);
	});

	it('joins text-like content parts and ignores non-text parts', () => {
		const out = mapMemoryMessagesToN8n({
			operation: 'saveMessages',
			messages: [
				{
					id: 'msg-2',
					role: 'assistant',
					createdAt: '2026-07-10T00:01:00.000Z',
					content: {
						format: 2,
						parts: [
							{ type: 'text', text: 'hello ' },
							{ type: 'tool-invocation', toolInvocation: { toolName: 'x' } },
							{ type: 'text', text: 'again' },
						],
					},
				},
			],
		});

		expect(out[0][0].json.messages).toEqual([
			{
				id: 'msg-2',
				role: 'assistant',
				text: 'hello again',
				createdAt: '2026-07-10T00:01:00.000Z',
				threadId: undefined,
				resourceId: undefined,
			},
		]);
	});

	it('tolerates missing content and unknown roles', () => {
		const out = mapMemoryMessagesToN8n({
			operation: 'recall',
			messages: [{ id: 'msg-3' }],
		});

		expect(out[0][0].json.messageCount).toBe(1);
		expect(out[0][0].json.messages).toEqual([
			{
				id: 'msg-3',
				role: 'unknown',
				text: '',
				createdAt: undefined,
				threadId: undefined,
				resourceId: undefined,
			},
		]);
	});

	it('handles empty message lists', () => {
		const out = mapMemoryMessagesToN8n({ operation: 'recall', messages: [] });
		expect(out).toEqual([
			[
				{
					json: {
						operation: 'recall',
						threadId: undefined,
						resourceId: undefined,
						messageCount: 0,
						tokenUsage: undefined,
						messages: [],
					},
				},
			],
		]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/memoryLogging.test.ts`

Expected: FAIL because `../nodes/shared/memoryLogging` does not exist.

- [ ] **Step 3: Implement mapper module**

Create `nodes/shared/memoryLogging.ts` with this implementation:

```ts
type N8nLogPayload = Array<Array<{ json: Record<string, unknown> }>>;

export const AI_MEMORY_CONNECTION = 'ai_memory';

export interface MemoryLogInput {
	operation: 'recall' | 'saveMessages';
	messages?: unknown[];
	threadId?: string;
	resourceId?: string;
	usage?: { tokens?: number };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function textFromParts(parts: unknown): string {
	if (!Array.isArray(parts)) return '';
	return parts
		.map((part) => (isObject(part) && typeof part.text === 'string' ? part.text : ''))
		.join('');
}

function textFromContent(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!isObject(content)) return '';
	if (typeof content.content === 'string') return content.content;
	return textFromParts(content.parts);
}

function normalizeCreatedAt(value: unknown): string | undefined {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'string') return value;
	if (typeof value === 'number') return new Date(value).toISOString();
	return undefined;
}

function normalizeMessage(message: unknown): Record<string, unknown> {
	const msg = isObject(message) ? message : {};
	return {
		id: typeof msg.id === 'string' ? msg.id : undefined,
		role: typeof msg.role === 'string' ? msg.role : 'unknown',
		text: textFromContent(msg.content),
		createdAt: normalizeCreatedAt(msg.createdAt),
		threadId: typeof msg.threadId === 'string' ? msg.threadId : undefined,
		resourceId: typeof msg.resourceId === 'string' ? msg.resourceId : undefined,
	};
}

export function mapMemoryMessagesToN8n(input: MemoryLogInput): N8nLogPayload {
	const messages = Array.isArray(input.messages) ? input.messages : [];
	return [
		[
			{
				json: {
					operation: input.operation,
					threadId: input.threadId,
					resourceId: input.resourceId,
					messageCount: messages.length,
					tokenUsage:
						typeof input.usage?.tokens === 'number'
							? { totalTokens: input.usage.tokens }
							: undefined,
					messages: messages.map(normalizeMessage),
				},
			},
		],
	];
}
```

- [ ] **Step 4: Run mapper tests**

Run: `npx vitest run test/memoryLogging.test.ts`

Expected: PASS for all mapper tests in `test/memoryLogging.test.ts`.

- [ ] **Step 5: Commit mapper**

Run:

```bash
git add nodes/shared/memoryLogging.ts test/memoryLogging.test.ts
git commit -m "feat(memory): map memory messages for execution logs"
```

---

### Task 2: Memory Wrapper

**Files:**
- Modify: `nodes/shared/memoryLogging.ts`
- Modify: `test/memoryLogging.test.ts`

**Interfaces:**
- Consumes from Task 1: `AI_MEMORY_CONNECTION`, `mapMemoryMessagesToN8n`, `MemoryLogInput`.
- Produces:
  - `export interface MemoryLogContext { addInputData(connectionType: string, data: unknown): { index: number } | void; addOutputData(connectionType: string, index: number, data: unknown): void; }`
  - `export function wrapMemoryForLogging<T extends Record<string, unknown>>(memory: T, ctx: MemoryLogContext): T`

- [ ] **Step 1: Add failing wrapper tests**

Append these tests to `test/memoryLogging.test.ts`:

```ts
import { AI_MEMORY_CONNECTION, wrapMemoryForLogging } from '../nodes/shared/memoryLogging';

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

describe('wrapMemoryForLogging recall', () => {
	it('logs recall input and output and returns the original result', async () => {
		const { ctx, calls } = makeCtx();
		const result = {
			messages: [{ id: 'm1', role: 'user', content: { format: 2, content: 'remembered' } }],
			usage: { tokens: 7 },
			total: 1,
			page: 0,
			perPage: 10,
			hasMore: false,
		};
		const base = {
			provider: 'memory',
			recall: async (_args: unknown) => result,
			saveMessages: async (_args: unknown) => ({ messages: [] }),
		};

		const wrapped = wrapMemoryForLogging(base, ctx);
		const out = await wrapped.recall({ threadId: 'thread-1', resourceId: 'user-1' });

		expect(out).toBe(result);
		expect(calls.input[0][0]).toBe(AI_MEMORY_CONNECTION);
		expect(calls.output[0][0]).toBe(AI_MEMORY_CONNECTION);
		expect((calls.input[0][1] as any)[0][0].json.operation).toBe('recall');
		expect((calls.input[0][1] as any)[0][0].json.threadId).toBe('thread-1');
		expect((calls.output[0][2] as any)[0][0].json.messages[0].text).toBe('remembered');
		expect((calls.output[0][2] as any)[0][0].json.tokenUsage.totalTokens).toBe(7);
	});

	it('logs and rethrows recall errors', async () => {
		const { ctx, calls } = makeCtx();
		const boom = new Error('recall failed');
		const base = {
			recall: async () => {
				throw boom;
			},
			saveMessages: async (_args: unknown) => ({ messages: [] }),
		};
		const wrapped = wrapMemoryForLogging(base, ctx);

		await expect(wrapped.recall({ threadId: 'thread-1' })).rejects.toBe(boom);
		expect(calls.output[0][2]).toBe(boom);
	});
});

describe('wrapMemoryForLogging saveMessages', () => {
	it('logs saveMessages input and output and returns the original result', async () => {
		const { ctx, calls } = makeCtx();
		const saved = [{ id: 'm2', role: 'assistant', threadId: 'thread-1', resourceId: 'user-1', content: { format: 2, content: 'saved' } }];
		const result = { messages: saved, usage: { tokens: 5 } };
		const base = {
			recall: async (_args: unknown) => ({ messages: [] }),
			saveMessages: async (_args: unknown) => result,
		};

		const wrapped = wrapMemoryForLogging(base, ctx);
		const out = await wrapped.saveMessages({ messages: saved });

		expect(out).toBe(result);
		expect((calls.input[0][1] as any)[0][0].json.operation).toBe('saveMessages');
		expect((calls.input[0][1] as any)[0][0].json.messages[0].text).toBe('saved');
		expect((calls.output[0][2] as any)[0][0].json.messageCount).toBe(1);
		expect((calls.output[0][2] as any)[0][0].json.tokenUsage.totalTokens).toBe(5);
	});

	it('does not crash memory calls when the logger throws', async () => {
		const badCtx = {
			addInputData: () => {
				throw new Error('log failed');
			},
			addOutputData: () => {
				throw new Error('log failed');
			},
		};
		const result = { messages: [] };
		const base = {
			recall: async (_args: unknown) => ({ messages: [] }),
			saveMessages: async (_args: unknown) => result,
		};
		const wrapped = wrapMemoryForLogging(base, badCtx);

		await expect(wrapped.saveMessages({ messages: [] })).resolves.toBe(result);
	});

	it('passes non-intercepted members through unchanged', () => {
		const { ctx } = makeCtx();
		const base = {
			customValue: 'keep-me',
			recall: async (_args: unknown) => ({ messages: [] }),
			saveMessages: async (_args: unknown) => ({ messages: [] }),
		};
		const wrapped = wrapMemoryForLogging(base, ctx);

		expect(wrapped.customValue).toBe('keep-me');
	});
});
```

- [ ] **Step 2: Run wrapper tests to verify they fail**

Run: `npx vitest run test/memoryLogging.test.ts`

Expected: FAIL because `wrapMemoryForLogging` is not exported yet.

- [ ] **Step 3: Implement safe logging and Proxy wrapper**

Extend `nodes/shared/memoryLogging.ts` with these exports and helpers below `mapMemoryMessagesToN8n`:

```ts
export interface MemoryLogContext {
	addInputData(connectionType: string, data: unknown): { index: number } | void;
	addOutputData(connectionType: string, index: number, data: unknown): void;
}

function safeAddInput(ctx: MemoryLogContext, data: unknown): number {
	try {
		const res = ctx.addInputData(AI_MEMORY_CONNECTION, data);
		return res && typeof res.index === 'number' ? res.index : 0;
	} catch {
		return 0;
	}
}

function safeAddOutput(ctx: MemoryLogContext, index: number, data: unknown): void {
	try {
		ctx.addOutputData(AI_MEMORY_CONNECTION, index, data);
	} catch {
		// logging is not on the critical path
	}
}

function firstMessageScope(messages: unknown[]): { threadId?: string; resourceId?: string } {
	const first = messages.find(isObject);
	return {
		threadId: first && typeof first.threadId === 'string' ? first.threadId : undefined,
		resourceId: first && typeof first.resourceId === 'string' ? first.resourceId : undefined,
	};
}

export function wrapMemoryForLogging<T extends Record<string, unknown>>(
	memory: T,
	ctx: MemoryLogContext,
): T {
	return new Proxy(memory, {
		get(target, prop, receiver) {
			if (prop === 'recall') {
				const original = target.recall as (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
				return async (args: Record<string, unknown>) => {
					const index = safeAddInput(
						ctx,
						mapMemoryMessagesToN8n({
							operation: 'recall',
							threadId: typeof args?.threadId === 'string' ? args.threadId : undefined,
							resourceId: typeof args?.resourceId === 'string' ? args.resourceId : undefined,
							messages: [],
						}),
					);
					try {
						const result = await original.call(target, args);
						safeAddOutput(
							ctx,
							index,
							mapMemoryMessagesToN8n({
								operation: 'recall',
								threadId: typeof args?.threadId === 'string' ? args.threadId : undefined,
								resourceId: typeof args?.resourceId === 'string' ? args.resourceId : undefined,
								messages: Array.isArray(result.messages) ? result.messages : [],
								usage: isObject(result.usage) ? (result.usage as { tokens?: number }) : undefined,
							}),
						);
						return result;
					} catch (error) {
						safeAddOutput(ctx, index, error);
						throw error;
					}
				};
			}

			if (prop === 'saveMessages') {
				const original = target.saveMessages as (args: { messages?: unknown[] }) => Promise<Record<string, unknown>>;
				return async (args: { messages?: unknown[] }) => {
					const inputMessages = Array.isArray(args?.messages) ? args.messages : [];
					const inputScope = firstMessageScope(inputMessages);
					const index = safeAddInput(
						ctx,
						mapMemoryMessagesToN8n({
							operation: 'saveMessages',
							threadId: inputScope.threadId,
							resourceId: inputScope.resourceId,
							messages: inputMessages,
						}),
					);
					try {
						const result = await original.call(target, args);
						const outputMessages = Array.isArray(result.messages) ? result.messages : [];
						const outputScope = firstMessageScope(outputMessages);
						safeAddOutput(
							ctx,
							index,
							mapMemoryMessagesToN8n({
								operation: 'saveMessages',
								threadId: outputScope.threadId ?? inputScope.threadId,
								resourceId: outputScope.resourceId ?? inputScope.resourceId,
								messages: outputMessages,
								usage: isObject(result.usage) ? (result.usage as { tokens?: number }) : undefined,
							}),
						);
						return result;
					} catch (error) {
						safeAddOutput(ctx, index, error);
						throw error;
					}
				};
			}

			return Reflect.get(target, prop, receiver);
		},
	});
}
```

- [ ] **Step 4: Run memory logging tests**

Run: `npx vitest run test/memoryLogging.test.ts`

Expected: PASS for mapper and wrapper tests.

- [ ] **Step 5: Commit wrapper**

Run:

```bash
git add nodes/shared/memoryLogging.ts test/memoryLogging.test.ts
git commit -m "feat(memory): wrap memory calls for execution logging"
```

---

### Task 3: Wire Wrapper Into Postgres Memory Node

**Files:**
- Modify: `nodes/MemoryPostgresMastra/MemoryPostgresMastra.node.ts`
- Modify: `test/memoryPostgresMastra.test.ts`

**Interfaces:**
- Consumes from Task 2: `wrapMemoryForLogging(memory, ctx)`.
- Produces: `MastraMemoryHandoff.memory` contains the wrapped memory instance.

- [ ] **Step 1: Add failing integration test**

In `test/memoryPostgresMastra.test.ts`, update the `@mastra/memory` mock so the fake class has `recall` and `saveMessages` methods:

```ts
vi.mock('@mastra/memory', () => ({
	Memory: class {
		constructor(public cfg: unknown) {}
		async recall(_args: unknown) {
			return { messages: [], total: 0, page: 0, perPage: false, hasMore: false };
		}
		async saveMessages(args: { messages?: unknown[] }) {
			return { messages: args.messages ?? [] };
		}
	},
}));
```

Then add this test inside `describe('MemoryPostgresMastra.supplyData', ...)`:

```ts
it('wraps the memory handoff so recall logs on the ai_memory connection', async () => {
	const ctx = makeCtx({
		sessionIdType: 'customKey',
		sessionKey: 'thread-logs',
		resourceId: 'user-logs',
		requireResourceId: true,
	});
	const inputCalls: unknown[] = [];
	const outputCalls: unknown[] = [];
	ctx.addInputData.mockImplementation((connectionType: string, data: unknown) => {
		inputCalls.push([connectionType, data]);
		return { index: 0 };
	});
	ctx.addOutputData.mockImplementation((connectionType: string, index: number, data: unknown) => {
		outputCalls.push([connectionType, index, data]);
	});

	const result = await node.supplyData.call(ctx, 0);
	const handoff = result.response as { memory: { recall(args: unknown): Promise<unknown> } };

	await handoff.memory.recall({ threadId: 'thread-logs', resourceId: 'user-logs' });

	expect(inputCalls[0][0]).toBe('ai_memory');
	expect(outputCalls[0][0]).toBe('ai_memory');
	expect((inputCalls[0][1] as any)[0][0].json.operation).toBe('recall');
});
```

- [ ] **Step 2: Run integration test to verify it fails**

Run: `npx vitest run test/memoryPostgresMastra.test.ts`

Expected: FAIL because the memory instance is not wrapped, so `addInputData` is not called.

- [ ] **Step 3: Wire wrapper into MemoryPostgresMastra**

Modify `nodes/MemoryPostgresMastra/MemoryPostgresMastra.node.ts`:

Add the import near the other shared imports:

```ts
import { wrapMemoryForLogging } from '../shared/memoryLogging';
```

Replace the handoff construction section after `const memory = new Memory(...)` with:

```ts
		const wrappedMemory = wrapMemoryForLogging(memory as unknown as Record<string, unknown>, this) as typeof memory;

		// n8n's getInputConnectionData returns this `response` object verbatim and
		// drops SupplyData.metadata, so thread/resource must ride ON the response.
		const handoff: MastraMemoryHandoff = {
			__isMastraMemory: true,
			memory: wrappedMemory,
			thread: threadId,
			resource: resourceId,
		};
```

- [ ] **Step 4: Run memory node tests**

Run: `npx vitest run test/memoryPostgresMastra.test.ts test/memoryLogging.test.ts`

Expected: PASS for both files.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`

Expected: PASS with exit code 0.

- [ ] **Step 6: Commit integration**

Run:

```bash
git add nodes/MemoryPostgresMastra/MemoryPostgresMastra.node.ts test/memoryPostgresMastra.test.ts
git commit -m "feat(memory): log memory sub-node calls in the execution tree"
```

---

### Task 4: Backlog Cleanup And Full Verification

**Files:**
- Modify: `docs/BACKLOG.md`
- Existing verification targets: `test/memoryLogging.test.ts`, `test/memoryPostgresMastra.test.ts`, full test suite, typecheck, build.

**Interfaces:**
- Consumes from Tasks 1-3: completed memory execution-tree logging.
- Produces: backlog no longer lists Memory sub-node execution logs as future work.

- [ ] **Step 1: Update backlog**

Edit `docs/BACKLOG.md` and remove the section starting at:

```md
## Memory sub-node execution logs
```

through its acceptance paragraph. Leave the E2E workflow tests section unchanged.

- [ ] **Step 2: Run full unit test suite**

Run: `npx vitest run`

Expected: PASS. The expected summary should show all existing tests plus new memory logging tests passing.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`

Expected: PASS with exit code 0.

- [ ] **Step 4: Run build**

Run: `npm run build`

Expected: PASS with tsup build success for the package.

- [ ] **Step 5: Inspect final diff**

Run: `git status --short` and `git diff --stat HEAD`.

Expected: only the intended backlog change remains unstaged before this task's commit.

- [ ] **Step 6: Commit backlog cleanup**

Run:

```bash
git add docs/BACKLOG.md
git commit -m "docs(backlog): remove completed memory logging item"
```

- [ ] **Step 7: Prepare PR summary**

Use this PR summary after pushing the implementation branch:

```md
## What

Shows the Postgres Memory (Mastra) sub-node in the n8n execution tree when the Mastra Agent reads from or writes to memory.

## How

- Adds `nodes/shared/memoryLogging.ts` with normalized message mapping and a Proxy wrapper over `memory.recall` / `memory.saveMessages`.
- Wraps the Memory instance in `MemoryPostgresMastra.supplyData` before handing it to the Agent.
- Logs summary-first payloads on `ai_memory`: operation, thread/resource, count, optional token usage, and normalized messages.

## Verification

- `npx vitest run`
- `npm run typecheck`
- `npm run build`

## Out of scope

- Store-level Postgres logs
- Raw MastraDBMessage metadata dumps
- Real n8n E2E harness automation
```

---

## Self-Review Notes

- Spec coverage: mapper, wrapper, node integration, error handling, tests, and backlog cleanup are each covered by a task.
- Placeholder scan: no placeholders or deferred implementation details remain.
- Type consistency: `AI_MEMORY_CONNECTION`, `MemoryLogContext`, `MemoryLogInput`, `mapMemoryMessagesToN8n`, and `wrapMemoryForLogging` are defined before later tasks consume them.
