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
