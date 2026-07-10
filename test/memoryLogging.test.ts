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
