# Mastra Agent Connectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Mastra Agent node expose the standard n8n AI Agent connector shape while keeping model and memory Mastra-native and bridging existing n8n tools.

**Architecture:** The Agent node keeps owning Mastra execution. Model and memory inputs continue to use branded handoff objects. Tools are accepted through a small compatibility helper that flattens n8n/LangChain tools and toolkits into a Mastra AI SDK `ToolSet`.

**Tech Stack:** TypeScript, n8n community node API, `n8n-workflow`, Mastra `@mastra/core`, Vitest.

## Global Constraints

- Repository content must be English: code, comments, docs, identifiers, log/error strings, and commit messages.
- Chat with the user can be Russian.
- Model input accepts only `MastraModelHandoff`.
- Memory input accepts only `MastraMemoryHandoff`.
- Tool input accepts stock n8n `ai_tool` outputs through a compatibility bridge.
- No output parser, fallback model, workspace connector, or stock memory/model adapter in this iteration.
- Do not leak API keys in outputs, logs, or errors.
- Use TDD for implementation tasks.

---

## File Structure

- Modify `nodes/MastraAgent/MastraAgent.node.ts`: standard Agent inputs, tool bridge integration, agent-level logs, prompt execution.
- Create `nodes/shared/toolBridge.ts`: small adapter from stock n8n/LangChain `ai_tool` payloads to Mastra `ToolSet`.
- Create `test/mastraAgent.test.ts`: Agent description, validation, execution/logging behavior.
- Create `test/toolBridge.test.ts`: tool flattening and invocation behavior.

---

### Task 1: Standard Agent Inputs And Validation Tests

**Files:**
- Modify: `nodes/MastraAgent/MastraAgent.node.ts`
- Create: `test/mastraAgent.test.ts`

**Interfaces:**
- Consumes: `isMastraModelHandoff(value: unknown): value is MastraModelHandoff`, `isMastraMemoryHandoff(value: unknown): value is MastraMemoryHandoff`.
- Produces: Agent `description.inputs` expression string that returns `main`, `Chat Model`, `Memory`, and `Tool` inputs.

- [ ] **Step 1: Write failing tests for Agent inputs and invalid handoffs**

Create `test/mastraAgent.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { NodeConnectionTypes, type IExecuteFunctions, type INode } from 'n8n-workflow';

vi.mock('@mastra/core/agent', () => ({
	Agent: class {
		async stream() {
			return { text: Promise.resolve('ok') };
		}
	},
}));

import { MastraAgent } from '../nodes/MastraAgent/MastraAgent.node';

function makeExecuteCtx(inputData: Record<string, unknown>) {
	const ctx = mock<IExecuteFunctions>();
	ctx.getNode.mockReturnValue(mock<INode>({ name: 'Mastra Agent', typeVersion: 1 }));
	ctx.getInputData.mockReturnValue([{ json: { chatInput: 'Hello' } }]);
	ctx.getNodeParameter.mockImplementation((name: string, _index: number, fallback?: unknown) => {
		switch (name) {
			case 'prompt':
				return 'Hello';
			case 'instructions':
				return 'You are helpful.';
			case 'agentName':
				return 'Test Agent';
			case 'model':
				return '';
			default:
				return fallback;
		}
	});
	ctx.getInputConnectionData.mockImplementation(async (type: string) => inputData[type]);
	ctx.continueOnFail.mockReturnValue(false);
	return ctx;
}

describe('MastraAgent description', () => {
	it('exposes the standard n8n AI Agent inputs', () => {
		const inputs = new MastraAgent().description.inputs;

		expect(typeof inputs).toBe('string');
		expect(inputs).toContain(NodeConnectionTypes.Main);
		expect(inputs).toContain(NodeConnectionTypes.AiLanguageModel);
		expect(inputs).toContain(NodeConnectionTypes.AiMemory);
		expect(inputs).toContain(NodeConnectionTypes.AiTool);
		expect(inputs).toContain('Chat Model');
		expect(inputs).toContain('Tool');
	});
});

describe('MastraAgent.execute validation', () => {
	it('rejects non-Mastra model payloads', async () => {
		const node = new MastraAgent();
		const ctx = makeExecuteCtx({ [NodeConnectionTypes.AiLanguageModel]: { invoke: vi.fn() } });

		await expect(node.execute.call(ctx)).rejects.toThrow(/not a Mastra model/i);
	});

	it('rejects non-Mastra memory payloads', async () => {
		const node = new MastraAgent();
		const ctx = makeExecuteCtx({
			[NodeConnectionTypes.AiLanguageModel]: {
				__isMastraModel: true,
				config: { providerId: 'openai-compatible', modelId: 'test', url: 'https://example.test', apiKey: 'secret' },
			},
			[NodeConnectionTypes.AiMemory]: { loadMemoryVariables: vi.fn() },
		});

		await expect(node.execute.call(ctx)).rejects.toThrow(/not a Mastra memory/i);
	});
});
```

- [ ] **Step 2: Run the failing tests**

Run: `npm test -- test/mastraAgent.test.ts`

Expected: the input description test fails because `ai_tool` is not present yet.

- [ ] **Step 3: Update Agent inputs**

In `nodes/MastraAgent/MastraAgent.node.ts`, replace `description.inputs` with an expression string:

```ts
		inputs: `={{
			[
				'${NodeConnectionTypes.Main}',
				{
					type: '${NodeConnectionTypes.AiLanguageModel}',
					displayName: 'Chat Model',
					required: true,
					maxConnections: 1,
				},
				{
					type: '${NodeConnectionTypes.AiMemory}',
					displayName: 'Memory',
					required: false,
					maxConnections: 1,
				},
				{
					type: '${NodeConnectionTypes.AiTool}',
					displayName: 'Tool',
					required: false,
				},
			]
		}}`,
```

Leave the current model and memory validation in place.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -- test/mastraAgent.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add nodes/MastraAgent/MastraAgent.node.ts test/mastraAgent.test.ts
git commit -m "feat(agent): expose standard AI inputs"
```

---

### Task 2: Tool Bridge

**Files:**
- Create: `nodes/shared/toolBridge.ts`
- Create: `test/toolBridge.test.ts`

**Interfaces:**
- Consumes: stock n8n `ai_tool` payloads from `getInputConnectionData(NodeConnectionTypes.AiTool, 0)`.
- Produces: `toMastraToolSet(toolConnections: unknown): Record<string, { description?: string; parameters?: unknown; execute: (input: unknown) => Promise<unknown> }>`.

- [ ] **Step 1: Write failing bridge tests**

Create `test/toolBridge.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { toMastraToolSet } from '../nodes/shared/toolBridge';

describe('toMastraToolSet', () => {
	it('adapts a single n8n tool with invoke()', async () => {
		const invoke = vi.fn().mockResolvedValue('tool result');
		const tools = toMastraToolSet({
			name: 'search',
			description: 'Search documents',
			schema: { type: 'object', properties: { query: { type: 'string' } } },
			invoke,
		});

		expect(Object.keys(tools)).toEqual(['search']);
		expect(tools.search.description).toBe('Search documents');
		expect(tools.search.parameters).toEqual({ type: 'object', properties: { query: { type: 'string' } } });
		await expect(tools.search.execute({ query: 'n8n' })).resolves.toBe('tool result');
		expect(invoke).toHaveBeenCalledWith({ query: 'n8n' });
	});

	it('flattens toolkit shapes returned by MCP Client Tool', async () => {
		const weatherInvoke = vi.fn().mockResolvedValue('sunny');
		const toolkit = {
			tools: [
				{ name: 'weather', description: 'Get weather', schema: { type: 'object' }, invoke: weatherInvoke },
			],
		};

		const tools = toMastraToolSet(toolkit);

		expect(Object.keys(tools)).toEqual(['weather']);
		await expect(tools.weather.execute({ city: 'Berlin' })).resolves.toBe('sunny');
		expect(weatherInvoke).toHaveBeenCalledWith({ city: 'Berlin' });
	});

	it('deduplicates names by suffixing later tools', () => {
		const tools = toMastraToolSet([
			{ name: 'lookup', description: 'First', invoke: vi.fn() },
			{ name: 'lookup', description: 'Second', invoke: vi.fn() },
		]);

		expect(Object.keys(tools)).toEqual(['lookup', 'lookup_2']);
		expect(tools.lookup.description).toBe('First');
		expect(tools.lookup_2.description).toBe('Second');
	});
});
```

- [ ] **Step 2: Run the failing tests**

Run: `npm test -- test/toolBridge.test.ts`

Expected: FAIL with module not found for `nodes/shared/toolBridge`.

- [ ] **Step 3: Implement bridge helper**

Create `nodes/shared/toolBridge.ts`:

```ts
interface N8nToolLike {
	name?: string;
	description?: string;
	schema?: unknown;
	invoke?: (input: unknown) => Promise<unknown> | unknown;
	call?: (input: unknown) => Promise<unknown> | unknown;
	func?: (input: unknown) => Promise<unknown> | unknown;
}

interface N8nToolkitLike {
	tools?: unknown[];
	getTools?: () => unknown[];
}

export interface MastraToolBridgeEntry {
	description?: string;
	parameters?: unknown;
	execute: (input: unknown) => Promise<unknown>;
}

export type MastraToolSet = Record<string, MastraToolBridgeEntry>;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function asToolkit(value: unknown): N8nToolkitLike | undefined {
	if (!isObject(value)) return undefined;
	if (Array.isArray(value.tools)) return value as N8nToolkitLike;
	if (typeof value.getTools === 'function') return value as N8nToolkitLike;
	return undefined;
}

function asTool(value: unknown): N8nToolLike | undefined {
	if (!isObject(value)) return undefined;
	if (typeof value.name !== 'string' || !value.name.trim()) return undefined;
	if (
		typeof value.invoke !== 'function' &&
		typeof value.call !== 'function' &&
		typeof value.func !== 'function'
	) {
		return undefined;
	}
	return value as N8nToolLike;
}

function flattenTools(value: unknown): N8nToolLike[] {
	if (value === undefined || value === null) return [];
	if (Array.isArray(value)) return value.flatMap((entry) => flattenTools(entry));

	const toolkit = asToolkit(value);
	if (toolkit) {
		const tools = typeof toolkit.getTools === 'function' ? toolkit.getTools() : toolkit.tools;
		return flattenTools(tools ?? []);
	}

	const tool = asTool(value);
	return tool ? [tool] : [];
}

function uniqueName(baseName: string, usedNames: Set<string>): string {
	let name = baseName.replace(/[^A-Za-z0-9_-]/g, '_');
	if (!name) name = 'tool';
	if (!usedNames.has(name)) {
		usedNames.add(name);
		return name;
	}

	let suffix = 2;
	while (usedNames.has(`${name}_${suffix}`)) suffix++;
	const unique = `${name}_${suffix}`;
	usedNames.add(unique);
	return unique;
}

export function toMastraToolSet(toolConnections: unknown): MastraToolSet {
	const usedNames = new Set<string>();
	const toolSet: MastraToolSet = {};

	for (const tool of flattenTools(toolConnections)) {
		const sourceName = tool.name?.trim() || 'tool';
		const name = uniqueName(sourceName, usedNames);
		const execute = tool.invoke ?? tool.call ?? tool.func;

		if (!execute) continue;

		toolSet[name] = {
			description: tool.description,
			parameters: tool.schema,
			execute: async (input: unknown) => await execute.call(tool, input),
		};
	}

	return toolSet;
}
```

- [ ] **Step 4: Run bridge tests and typecheck**

Run: `npm test -- test/toolBridge.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add nodes/shared/toolBridge.ts test/toolBridge.test.ts
git commit -m "feat(agent): bridge n8n tools to Mastra"
```

---

### Task 3: Agent Tool Integration And Agent-Level Logs

**Files:**
- Modify: `nodes/MastraAgent/MastraAgent.node.ts`
- Modify: `test/mastraAgent.test.ts`

**Interfaces:**
- Consumes: `toMastraToolSet(toolConnections: unknown): MastraToolSet` from Task 2.
- Produces: Agent config includes `tools` when connected tools are present; Agent execution records agent-level input/output logs without leaking API keys.

- [ ] **Step 1: Extend Agent tests for tools and logs**

Append these tests to `test/mastraAgent.test.ts`:

```ts
describe('MastraAgent.execute tools and logs', () => {
	it('passes bridged tools into the Mastra Agent config', async () => {
		const createdConfigs: Array<Record<string, unknown>> = [];
		vi.doMock('@mastra/core/agent', () => ({
			Agent: class {
				constructor(config: Record<string, unknown>) {
					createdConfigs.push(config);
				}
				async stream() {
					return { text: Promise.resolve('ok'), usage: Promise.resolve({ totalTokens: 3 }) };
				}
			},
		}));

		const { MastraAgent: ReloadedMastraAgent } = await import('../nodes/MastraAgent/MastraAgent.node');
		const ctx = makeExecuteCtx({
			[NodeConnectionTypes.AiLanguageModel]: {
				__isMastraModel: true,
				config: { providerId: 'openai-compatible', modelId: 'test-model', url: 'https://example.test', apiKey: 'secret' },
			},
			[NodeConnectionTypes.AiTool]: [{ name: 'lookup', description: 'Lookup', invoke: vi.fn() }],
		});

		await new ReloadedMastraAgent().execute.call(ctx);

		expect(createdConfigs[0].tools).toMatchObject({ lookup: { description: 'Lookup' } });
	});

	it('writes agent-level input and output logs without API keys', async () => {
		const node = new MastraAgent();
		const ctx = makeExecuteCtx({
			[NodeConnectionTypes.AiLanguageModel]: {
				__isMastraModel: true,
				config: { providerId: 'openai-compatible', modelId: 'safe-model', url: 'https://example.test', apiKey: 'secret-key' },
			},
		});
		ctx.addInputData.mockReturnValue({ index: 0 });

		await node.execute.call(ctx);

		expect(ctx.addInputData).toHaveBeenCalledWith(NodeConnectionTypes.AiAgent, [
			[{ json: { prompt: 'Hello', instructions: 'You are helpful.', model: 'safe-model' } }],
		]);
		expect(ctx.addOutputData).toHaveBeenCalled();
		const outputPayload = JSON.stringify(ctx.addOutputData.mock.calls);
		expect(outputPayload).toContain('safe-model');
		expect(outputPayload).not.toContain('secret-key');
	});
});
```

- [ ] **Step 2: Run the failing tests**

Run: `npm test -- test/mastraAgent.test.ts`

Expected: FAIL because tools are not yet passed to Agent config and agent-level `AiAgent` logs are not written.

- [ ] **Step 3: Integrate tool bridge and logs**

In `nodes/MastraAgent/MastraAgent.node.ts`:

```ts
import { toMastraToolSet } from '../shared/toolBridge';
```

Inside `execute`, after memory handling and before constructing `new Agent(agentConfig)`, add:

```ts
				const connectedTools = await this.getInputConnectionData(
					NodeConnectionTypes.AiTool,
					itemIndex,
				);
				const tools = toMastraToolSet(connectedTools);
				if (Object.keys(tools).length > 0) {
					agentConfig.tools = tools;
				}

				const modelLabel =
					typeof model === 'string'
						? model
						: (model as { modelId?: string; id?: string }).modelId ??
							(model as { id?: string }).id ??
							'connected-model';

				const { index: aiLogIndex } = this.addInputData(NodeConnectionTypes.AiAgent, [
					[{ json: { prompt, instructions, model: modelLabel } }],
				]);
```

After `const text = await stream.text;`, collect optional usage and add output log:

```ts
				const tokenUsage =
					'usage' in stream && stream.usage instanceof Promise ? await stream.usage : undefined;

				this.addOutputData(NodeConnectionTypes.AiAgent, aiLogIndex, [
					[{ json: { response: text, model: modelLabel, ...(tokenUsage ? { tokenUsage } : {}) } }],
				]);
```

Remove the duplicate later `modelLabel` declaration and keep output JSON using the sanitized label.

- [ ] **Step 4: Run tests, typecheck, and build**

Run: `npm test -- test/mastraAgent.test.ts test/toolBridge.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add nodes/MastraAgent/MastraAgent.node.ts test/mastraAgent.test.ts
git commit -m "feat(agent): add tools and agent logs"
```

---

### Task 4: Full Verification

**Files:**
- No new files.

**Interfaces:**
- Consumes: completed Tasks 1-3.
- Produces: verified working tree ready for user review.

- [ ] **Step 1: Run all tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: no TypeScript errors.

- [ ] **Step 3: Run build**

Run: `npm run build`

Expected: `tsup` completes successfully and SVG assets are copied.

- [ ] **Step 4: Inspect git status**

Run: `git status --short`

Expected: clean working tree after committed task changes.

---

## Self-Review

- Spec coverage: inputs, Mastra-only model/memory, n8n tool bridge, MCP toolkit shape, agent-level logs, and no secret leakage are covered by Tasks 1-4.
- Placeholder scan: no TBD/TODO placeholders remain.
- Type consistency: the bridge returns `MastraToolSet`; Agent consumes it as `agentConfig.tools`.
