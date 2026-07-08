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
			case 'model':
				return '';
			default:
				return fallback;
		}
	});
	ctx.getInputConnectionData.mockImplementation(async (type: string) => inputData[type]);
	ctx.continueOnFail.mockReturnValue(false);
	ctx.addInputData.mockReturnValue({ index: 0 });
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

	it('writes agent-level input and output logs without API keys', async () => {
		mastraAgentMock.streamResults = [
			{
				text: Promise.resolve('Logged response'),
				usage: Promise.resolve({ totalTokens: 3 }),
			},
		];
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

		expect(ctx.addInputData).toHaveBeenCalledWith(NodeConnectionTypes.AiAgent, [
			[{ json: { prompt: 'Hello', instructions: 'You are helpful.', model: 'safe-model' } }],
		]);
		expect(ctx.addOutputData).toHaveBeenCalled();
		const outputPayload = JSON.stringify(ctx.addOutputData.mock.calls);
		expect(outputPayload).toContain('safe-model');
		expect(outputPayload).toContain('totalTokens');
		expect(outputPayload).not.toContain('secret-key');
	});
});
