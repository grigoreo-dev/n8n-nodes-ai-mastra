import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { NodeConnectionTypes, type IExecuteFunctions, type INode } from 'n8n-workflow';

const mastraAgentMock = vi.hoisted(() => ({
	createdConfigs: [] as Array<Record<string, unknown>>,
	streamResults: [] as Array<Record<string, unknown>>,
	streamCalls: [] as Array<unknown[]>,
}));

vi.mock('@mastra/core/agent', () => ({
	Agent: class {
		constructor(config: Record<string, unknown>) {
			mastraAgentMock.createdConfigs.push(config);
		}

		async stream(...args: unknown[]) {
			mastraAgentMock.streamCalls.push(args);
			return mastraAgentMock.streamResults.shift() ?? { text: Promise.resolve('ok') };
		}
	},
}));

import { MastraAgent } from '../nodes/MastraAgent/MastraAgent.node';

function makeExecuteCtx(
	inputData: Record<string, unknown>,
	params: { prompt?: string; instructions?: string; agentName?: string } = {},
) {
	const ctx = mock<IExecuteFunctions>();
	ctx.getNode.mockReturnValue(mock<INode>({ name: 'Mastra Agent', typeVersion: 1 }));
	ctx.getInputData.mockReturnValue([{ json: { chatInput: 'Hello' } }]);
	ctx.getNodeParameter.mockImplementation((name: string, _index: number, fallback?: unknown) => {
		switch (name) {
			case 'prompt':
				return params.prompt ?? 'Hello';
			case 'instructions':
				return params.instructions ?? 'You are helpful.';
			case 'agentName':
				return params.agentName ?? 'Test Agent';
			default:
				return fallback;
		}
	});
	ctx.getInputConnectionData.mockImplementation(async (type: string) => inputData[type]);
	ctx.continueOnFail.mockReturnValue(false);
	return ctx;
}

const validModelInput = {
	[NodeConnectionTypes.AiLanguageModel]: {
		__isMastraModel: true,
		config: {
			providerId: 'openai-compatible',
			modelId: 'test-model',
			url: 'https://example.test',
			apiKey: 'secret',
		},
	},
};

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
	it('requires a connected model (no inline fallback)', async () => {
		const node = new MastraAgent();
		const ctx = makeExecuteCtx({});

		await expect(node.execute.call(ctx)).rejects.toThrow(/no model connected/i);
	});

	it('rejects non-Mastra model payloads', async () => {
		const node = new MastraAgent();
		const ctx = makeExecuteCtx({ [NodeConnectionTypes.AiLanguageModel]: { invoke: vi.fn() } });

		await expect(node.execute.call(ctx)).rejects.toThrow(/not a Mastra model/i);
	});

	it('rejects an empty prompt with a clear error (e.g. Chat Trigger with no chatInput mapping)', async () => {
		const node = new MastraAgent();
		const ctx = makeExecuteCtx(validModelInput, { prompt: '   ' });

		await expect(node.execute.call(ctx)).rejects.toThrow(/prompt is empty/i);
	});

	it('rejects non-Mastra memory payloads', async () => {
		const node = new MastraAgent();
		const ctx = makeExecuteCtx({
			[NodeConnectionTypes.AiLanguageModel]: {
				__isMastraModel: true,
				config: {
					providerId: 'openai-compatible',
					modelId: 'test',
					url: 'https://example.test',
					apiKey: 'secret',
				},
			},
			[NodeConnectionTypes.AiMemory]: { loadMemoryVariables: vi.fn() },
		});

		await expect(node.execute.call(ctx)).rejects.toThrow(/not a Mastra memory/i);
	});
});

describe('MastraAgent.execute tools and logs', () => {
	it('does not call addInputData/addOutputData on the execute context', async () => {
		// Regression: these methods only exist on ISupplyDataFunctions (sub-nodes).
		// Calling them on a root node's IExecuteFunctions throws
		// "addInputData should not be called on IExecuteFunctions".
		mastraAgentMock.createdConfigs.length = 0;
		mastraAgentMock.streamResults = [{ text: Promise.resolve('ok') }];
		const ctx = makeExecuteCtx({
			[NodeConnectionTypes.AiLanguageModel]: {
				__isMastraModel: true,
				config: {
					providerId: 'openai-compatible',
					modelId: 'safe-model',
					url: 'https://example.test',
					apiKey: 'secret-key',
				},
			},
		});

		await new MastraAgent().execute.call(ctx);

		expect(ctx.addInputData).not.toHaveBeenCalled();
		expect(ctx.addOutputData).not.toHaveBeenCalled();
	});

	it('passes bridged tools into the Mastra Agent config', async () => {
		mastraAgentMock.createdConfigs.length = 0;
		mastraAgentMock.streamResults = [{ text: Promise.resolve('ok') }];
		const ctx = makeExecuteCtx({
			[NodeConnectionTypes.AiLanguageModel]: {
				__isMastraModel: true,
				config: {
					providerId: 'openai-compatible',
					modelId: 'test-model',
					url: 'https://example.test',
					apiKey: 'secret',
				},
			},
			[NodeConnectionTypes.AiTool]: [
				{ name: 'lookup', description: 'Lookup', invoke: vi.fn().mockResolvedValue('found') },
			],
		});

		await new MastraAgent().execute.call(ctx);

		expect(mastraAgentMock.createdConfigs[0].tools).toMatchObject({
			lookup: { description: 'Lookup' },
		});
	});
});

describe('MastraAgent.execute model settings', () => {
	it('passes handoff.settings to agent.stream as modelSettings', async () => {
		mastraAgentMock.createdConfigs.length = 0;
		mastraAgentMock.streamCalls.length = 0;
		mastraAgentMock.streamResults = [{ text: Promise.resolve('ok') }];
		const ctx = makeExecuteCtx({
			[NodeConnectionTypes.AiLanguageModel]: {
				__isMastraModel: true,
				config: {
					providerId: 'openai-compatible',
					modelId: 'test-model',
					url: 'https://example.test',
					apiKey: 'secret',
				},
				settings: { temperature: 0.3, reasoning: 'low' },
			},
		});

		await new MastraAgent().execute.call(ctx);

		expect(mastraAgentMock.streamCalls).toHaveLength(1);
		const [prompt, options] = mastraAgentMock.streamCalls[0];
		expect(typeof prompt).toBe('string');
		expect(options).toMatchObject({ modelSettings: { temperature: 0.3, reasoning: 'low' } });
	});

	it('omits modelSettings when the handoff has no settings', async () => {
		mastraAgentMock.createdConfigs.length = 0;
		mastraAgentMock.streamCalls.length = 0;
		mastraAgentMock.streamResults = [{ text: Promise.resolve('ok') }];
		const ctx = makeExecuteCtx(validModelInput);

		await new MastraAgent().execute.call(ctx);

		expect(mastraAgentMock.streamCalls).toHaveLength(1);
		const options = mastraAgentMock.streamCalls[0][1] as Record<string, unknown>;
		expect(options.modelSettings).toBeUndefined();
		expect(Object.keys(options)).not.toContain('modelSettings');
	});
});
