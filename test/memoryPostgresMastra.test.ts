import { mock } from 'vitest-mock-extended';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ISupplyDataFunctions, INode } from 'n8n-workflow';

// Keep the store/memory construction inert — we test OUR wiring, not Mastra.
vi.mock('pg', () => {
	class FakePool {
		on() {
			return this;
		}
		async end() {}
	}
	return { Pool: FakePool };
});
vi.mock('@mastra/pg', () => ({
	PostgresStore: class {
		constructor(public cfg: unknown) {}
	},
}));
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

import { MemoryPostgresMastra } from '../nodes/MemoryPostgresMastra/MemoryPostgresMastra.node';
import { isMastraMemoryHandoff } from '../nodes/shared/memoryHandoff';
import { pgPoolManager } from '../nodes/shared/poolManager';

interface Params {
	sessionIdType?: string;
	sessionKey?: string;
	resourceId?: string;
	requireResourceId?: boolean;
	schemaName?: string;
	options?: Record<string, unknown>;
	json?: Record<string, unknown>;
}

function makeCtx(params: Params) {
	const ctx = mock<ISupplyDataFunctions>();
	ctx.getNode.mockReturnValue(mock<INode>({ name: 'PG Memory', typeVersion: 1 }));
	ctx.getCredentials.mockResolvedValue({
		host: 'db',
		port: 5432,
		database: 'app',
		user: 'app',
		password: 'pw',
		ssl: 'disable',
	});
	ctx.getNodeParameter.mockImplementation((name: string, _i: unknown, fallback?: unknown) => {
		switch (name) {
			case 'sessionIdType':
				return params.sessionIdType ?? 'customKey';
			case 'sessionKey':
				return params.sessionKey ?? '';
			case 'resourceId':
				return params.resourceId ?? '';
			case 'requireResourceId':
				return params.requireResourceId ?? true;
			case 'schemaName':
				return params.schemaName ?? 'public';
			case 'options':
				return params.options ?? {};
			default:
				return fallback;
		}
	});
	ctx.evaluateExpression.mockImplementation(() => (params.json?.sessionId as string) ?? '');
	return ctx;
}

describe('MemoryPostgresMastra.supplyData', () => {
	const node = new MemoryPostgresMastra();

	afterEach(async () => {
		await pgPoolManager.closeAll();
	});

	it('returns a branded Mastra memory handoff with resolved thread + resource', async () => {
		const ctx = makeCtx({
			sessionIdType: 'customKey',
			sessionKey: 'thread-123',
			resourceId: 'user-42',
			requireResourceId: true,
		});

		const result = await node.supplyData.call(ctx, 0);

		expect(isMastraMemoryHandoff(result.response)).toBe(true);
		const handoff = result.response as { thread: string; resource: string };
		expect(handoff.thread).toBe('thread-123');
		expect(handoff.resource).toBe('user-42');
		expect(typeof result.closeFunction).toBe('function');
	});

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

	it('resolves the thread from $json.sessionId in fromInput mode', async () => {
		const ctx = makeCtx({
			sessionIdType: 'fromInput',
			resourceId: 'user-1',
			json: { sessionId: 'sess-from-input' },
		});
		const result = await node.supplyData.call(ctx, 0);
		expect((result.response as { thread: string }).thread).toBe('sess-from-input');
	});

	it('throws when resource is empty and Require Resource ID is ON', async () => {
		const ctx = makeCtx({
			sessionIdType: 'customKey',
			sessionKey: 'thread-x',
			resourceId: '',
			requireResourceId: true,
		});
		await expect(node.supplyData.call(ctx, 0)).rejects.toThrow(/Resource ID/i);
	});

	it('falls back resource=thread when empty and Require Resource ID is OFF (never a shared bucket)', async () => {
		const ctx = makeCtx({
			sessionIdType: 'customKey',
			sessionKey: 'thread-y',
			resourceId: '',
			requireResourceId: false,
		});
		const result = await node.supplyData.call(ctx, 0);
		const handoff = result.response as { thread: string; resource: string };
		expect(handoff.resource).toBe('thread-y');
		expect(handoff.resource).toBe(handoff.thread);
	});

	it('rejects SSH-tunnel credentials', async () => {
		const ctx = makeCtx({ sessionKey: 't', resourceId: 'u' });
		ctx.getCredentials.mockResolvedValue({
			host: 'db',
			port: 5432,
			database: 'app',
			user: 'app',
			password: 'pw',
			sshTunnel: true,
		});
		await expect(node.supplyData.call(ctx, 0)).rejects.toThrow(/SSH tunnel/i);
	});

	it('closeFunction releases the pool ref so it can be evicted', async () => {
		const ctx = makeCtx({ sessionKey: 't', resourceId: 'u', schemaName: 'public' });
		const result = await node.supplyData.call(ctx, 0);
		expect(pgPoolManager.size).toBe(1);
		await result.closeFunction?.();
		// After release, sweeping past the TTL evicts it.
		pgPoolManager.sweep(Date.now() + 60 * 60 * 1000);
		expect(pgPoolManager.size).toBe(0);
	});
});
