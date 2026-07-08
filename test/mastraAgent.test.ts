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
