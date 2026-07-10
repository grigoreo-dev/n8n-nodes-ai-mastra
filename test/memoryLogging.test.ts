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

	it('does not leak reasoning parts into the logged text', () => {
		const out = mapMemoryMessagesToN8n({
			operation: 'recall',
			messages: [
				{
					id: 'msg-r',
					role: 'assistant',
					content: {
						format: 2,
						parts: [
							{ type: 'reasoning', text: 'secret chain of thought' },
							{ type: 'text', text: 'visible' },
						],
					},
				},
			],
		});

		expect((out[0][0].json.messages as Array<{ text: string }>)[0].text).toBe('visible');
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

	it('normalizes invalid Date createdAt values to undefined', () => {
		const out = mapMemoryMessagesToN8n({
			operation: 'recall',
			messages: [{ id: 'msg-4', createdAt: new Date('not-a-date') }],
		});

		expect(out[0][0].json.messages).toEqual([
			{
				id: 'msg-4',
				role: 'unknown',
				text: '',
				createdAt: undefined,
				threadId: undefined,
				resourceId: undefined,
			},
		]);
	});

	it('normalizes NaN numeric createdAt values to undefined', () => {
		const out = mapMemoryMessagesToN8n({
			operation: 'recall',
			messages: [{ id: 'msg-5', createdAt: Number.NaN }],
		});

		expect(out[0][0].json.messages).toEqual([
			{
				id: 'msg-5',
				role: 'unknown',
				text: '',
				createdAt: undefined,
				threadId: undefined,
				resourceId: undefined,
			},
		]);
	});

	it('normalizes out-of-range numeric createdAt values to undefined', () => {
		expect(() =>
			mapMemoryMessagesToN8n({
				operation: 'recall',
				messages: [{ id: 'msg-6', createdAt: 8640000000000001 }],
			}),
		).not.toThrow();

		const out = mapMemoryMessagesToN8n({
			operation: 'recall',
			messages: [{ id: 'msg-6', createdAt: 8640000000000001 }],
		});

		expect(out[0][0].json.messages).toEqual([
			{
				id: 'msg-6',
				role: 'unknown',
				text: '',
				createdAt: undefined,
				threadId: undefined,
				resourceId: undefined,
			},
		]);
	});

	it('normalizes invalid string createdAt values to undefined', () => {
		const out = mapMemoryMessagesToN8n({
			operation: 'recall',
			messages: [{ id: 'msg-7', createdAt: 'not-a-date' }],
		});

		expect((out[0][0].json.messages as Array<{ createdAt?: string }>)[0].createdAt).toBe(
			undefined,
		);
	});

	it('normalizes valid ISO string createdAt values to the same ISO instant', () => {
		const out = mapMemoryMessagesToN8n({
			operation: 'recall',
			messages: [{ id: 'msg-8', createdAt: '2026-07-10T00:01:00.000Z' }],
		});

		expect((out[0][0].json.messages as Array<{ createdAt?: string }>)[0].createdAt).toBe(
			'2026-07-10T00:01:00.000Z',
		);
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

import { AI_MEMORY_CONNECTION, wrapMemoryStorageForLogging } from '../nodes/shared/memoryLogging';

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

interface FakeStore extends Record<string, unknown> {
	listMessages(args: unknown): Promise<unknown>;
	saveMessages(args: { messages?: unknown[] }): Promise<unknown>;
}

function makeStorage(overrides?: Partial<FakeStore>) {
	const listResult = {
		messages: [{ id: 'm1', role: 'user', content: { format: 2, content: 'remembered' } }],
		total: 1,
		page: 0,
		perPage: 10,
		hasMore: false,
	};
	const memoryStore: FakeStore = {
		async listMessages(_args: unknown) {
			return listResult;
		},
		async saveMessages(args: { messages?: unknown[] }) {
			return { messages: args.messages ?? [] };
		},
		...overrides,
	};
	const otherStore: FakeStore = {
		async listMessages(_args: unknown) {
			return { messages: [] };
		},
		async saveMessages(_args: { messages?: unknown[] }) {
			return { messages: [] };
		},
	};
	const storage = {
		async getStore(name: string) {
			return name === 'memory' ? memoryStore : otherStore;
		},
	};
	return { storage, memoryStore, otherStore, listResult };
}

describe('wrapMemoryStorageForLogging listMessages', () => {
	it('logs listMessages input and output and returns the original result', async () => {
		const { ctx, calls } = makeCtx();
		const { storage, listResult } = makeStorage();

		const wrapped = wrapMemoryStorageForLogging(storage, ctx);
		expect(wrapped).toBe(storage);

		const store = (await wrapped.getStore('memory')) as FakeStore;
		const out = await store.listMessages({ threadId: 'thread-1', resourceId: 'user-1' });

		expect(out).toBe(listResult);
		expect(calls.input[0][0]).toBe(AI_MEMORY_CONNECTION);
		expect(calls.output[0][0]).toBe(AI_MEMORY_CONNECTION);
		expect((calls.input[0][1] as any)[0][0].json.operation).toBe('recall');
		expect((calls.input[0][1] as any)[0][0].json.threadId).toBe('thread-1');
		expect((calls.output[0][2] as any)[0][0].json.operation).toBe('recall');
		expect((calls.output[0][2] as any)[0][0].json.messages[0].text).toBe('remembered');
	});

	it('logs and rethrows listMessages errors', async () => {
		const { ctx, calls } = makeCtx();
		const boom = new Error('list failed');
		const { storage } = makeStorage({
			async listMessages() {
				throw boom;
			},
		});

		const wrapped = wrapMemoryStorageForLogging(storage, ctx);
		const store = (await wrapped.getStore('memory')) as FakeStore;

		await expect(store.listMessages({ threadId: 'thread-1' })).rejects.toBe(boom);
		expect(calls.output[0][2]).toBe(boom);
	});
});

describe('wrapMemoryStorageForLogging saveMessages', () => {
	it('logs saveMessages input and output and returns the original result', async () => {
		const { ctx, calls } = makeCtx();
		const saved = [
			{
				id: 'm2',
				role: 'assistant',
				threadId: 'thread-1',
				resourceId: 'user-1',
				content: { format: 2, content: 'saved' },
			},
		];
		const result = { messages: saved };
		const { storage } = makeStorage({
			async saveMessages() {
				return result;
			},
		});

		const wrapped = wrapMemoryStorageForLogging(storage, ctx);
		const store = (await wrapped.getStore('memory')) as FakeStore;
		const out = await store.saveMessages({ messages: saved });

		expect(out).toBe(result);
		expect((calls.input[0][1] as any)[0][0].json.operation).toBe('saveMessages');
		expect((calls.input[0][1] as any)[0][0].json.threadId).toBe('thread-1');
		expect((calls.input[0][1] as any)[0][0].json.messages[0].text).toBe('saved');
		expect((calls.output[0][2] as any)[0][0].json.operation).toBe('saveMessages');
		expect((calls.output[0][2] as any)[0][0].json.messageCount).toBe(1);
	});

	it('handles array-shaped saveMessages results', async () => {
		const { ctx, calls } = makeCtx();
		const saved = [{ id: 'm3', role: 'assistant', content: { format: 2, content: 'arr' } }];
		const { storage } = makeStorage({
			async saveMessages() {
				return saved;
			},
		});

		const wrapped = wrapMemoryStorageForLogging(storage, ctx);
		const store = (await wrapped.getStore('memory')) as FakeStore;
		const out = await store.saveMessages({ messages: saved });

		expect(out).toBe(saved);
		expect((calls.output[0][2] as any)[0][0].json.messages[0].text).toBe('arr');
	});

	it('logs and rethrows saveMessages errors', async () => {
		const { ctx, calls } = makeCtx();
		const boom = new Error('save failed');
		const { storage } = makeStorage({
			async saveMessages() {
				throw boom;
			},
		});

		const wrapped = wrapMemoryStorageForLogging(storage, ctx);
		const store = (await wrapped.getStore('memory')) as FakeStore;

		await expect(store.saveMessages({ messages: [] })).rejects.toBe(boom);
		expect(calls.output[0][2]).toBe(boom);
	});
});

describe('wrapMemoryStorageForLogging wrapping behavior', () => {
	it('does not wrap non-memory stores', async () => {
		const { ctx, calls } = makeCtx();
		const { storage, otherStore } = makeStorage();

		const wrapped = wrapMemoryStorageForLogging(storage, ctx);
		const store = (await wrapped.getStore('other')) as FakeStore;

		expect(store).toBe(otherStore);
		await store.listMessages({ threadId: 'thread-1' });
		expect(calls.input).toHaveLength(0);
		expect(calls.output).toHaveLength(0);
	});

	it('does not double-wrap the memory store across getStore calls', async () => {
		const { ctx, calls } = makeCtx();
		const { storage } = makeStorage();

		const wrapped = wrapMemoryStorageForLogging(storage, ctx);
		const first = (await wrapped.getStore('memory')) as FakeStore;
		const second = (await wrapped.getStore('memory')) as FakeStore;
		expect(second).toBe(first);

		await second.listMessages({ threadId: 'thread-1' });

		expect(calls.input).toHaveLength(1);
		expect(calls.output).toHaveLength(1);
	});

	it('does not crash store calls when the logger throws', async () => {
		const badCtx = {
			addInputData: () => {
				throw new Error('log failed');
			},
			addOutputData: () => {
				throw new Error('log failed');
			},
		};
		const { storage, listResult } = makeStorage();

		const wrapped = wrapMemoryStorageForLogging(storage, badCtx);
		const store = (await wrapped.getStore('memory')) as FakeStore;

		await expect(store.listMessages({ threadId: 't' })).resolves.toBe(listResult);
		await expect(store.saveMessages({ messages: [] })).resolves.toEqual({ messages: [] });
	});
});
