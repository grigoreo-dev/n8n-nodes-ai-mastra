import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { NodeConnectionTypes, type IExecuteFunctions, type INode } from 'n8n-workflow';

const mastraAgentMock = vi.hoisted(() => ({
	createdConfigs: [] as Array<Record<string, unknown>>,
	streamResults: [] as Array<Record<string, unknown>>,
}));

vi.mock('@mastra/core/agent', () => ({
	Agent: class {
		constructor(config: Record<string, unknown>) {
			mastraAgentMock.createdConfigs.push(config);
		}

		async stream() {
			return mastraAgentMock.streamResults.shift() ?? { text: Promise.resolve('ok') };
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
