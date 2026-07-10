import { describe, expect, it } from 'vitest';

import { mapPromptToN8n, mapResultToN8n } from '../nodes/shared/modelLogging';
import { AI_LANGUAGE_MODEL_CONNECTION, wrapModelForLogging } from '../nodes/shared/modelLogging';

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

describe('wrapModelForLogging doGenerate', () => {
	it('logs input then output and returns the original result', async () => {
		const { ctx, calls } = makeCtx();
		const result = { text: 'answer', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } };
		const base = {
			provider: 'p',
			modelId: 'm',
			specificationVersion: 'v2',
			doGenerate: async (_o: unknown) => result,
			doStream: async () => ({ stream: new ReadableStream() }),
		};

		const wrapped = wrapModelForLogging(base, ctx);
		const out = await wrapped.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });

		expect(out).toBe(result);
		expect(calls.input[0][0]).toBe(AI_LANGUAGE_MODEL_CONNECTION);
		expect(calls.output[0][0]).toBe(AI_LANGUAGE_MODEL_CONNECTION);
		expect((calls.output[0][2] as any)[0][0].json.response.text).toBe('answer');
	});

	it('forwards non-intercepted members unchanged', () => {
		const { ctx } = makeCtx();
		const base = { provider: 'p', modelId: 'm', specificationVersion: 'v2', doGenerate: async () => ({}), doStream: async () => ({}) };
		const wrapped = wrapModelForLogging(base, ctx);
		expect(wrapped.provider).toBe('p');
		expect(wrapped.modelId).toBe('m');
		expect(wrapped.specificationVersion).toBe('v2');
	});

	it('logs the error and rethrows when doGenerate throws', async () => {
		const { ctx, calls } = makeCtx();
		const boom = new Error('llm failed');
		const base = { provider: 'p', modelId: 'm', specificationVersion: 'v2', doGenerate: async () => { throw boom; }, doStream: async () => ({}) };
		const wrapped = wrapModelForLogging(base, ctx);
		await expect(wrapped.doGenerate({ prompt: [] })).rejects.toBe(boom);
		expect(calls.output[0][2]).toBe(boom);
	});

	it('does not crash the call when the logger throws', async () => {
		const badCtx = {
			addInputData: () => { throw new Error('log boom'); },
			addOutputData: () => { throw new Error('log boom'); },
		};
		const base = { provider: 'p', modelId: 'm', specificationVersion: 'v2', doGenerate: async () => ({ text: 'ok', finishReason: 'stop' }), doStream: async () => ({}) };
		const wrapped = wrapModelForLogging(base, badCtx);
		await expect(wrapped.doGenerate({ prompt: [] })).resolves.toEqual({ text: 'ok', finishReason: 'stop' });
	});
});

describe('mapPromptToN8n', () => {
	it('flattens messages to role + text', () => {
		const options = {
			prompt: [
				{ role: 'system', content: 'be nice' },
				{ role: 'user', content: [{ type: 'text', text: 'hello' }] },
				{
					role: 'assistant',
					content: [
						{ type: 'text', text: 'hi ' },
						{ type: 'text', text: 'there' },
					],
				},
			],
		};

		const out = mapPromptToN8n(options);

		expect(out).toEqual([
			[
				{
					json: {
						messages: [
							{ role: 'system', text: 'be nice' },
							{ role: 'user', text: 'hello' },
							{ role: 'assistant', text: 'hi there' },
						],
					},
				},
			],
		]);
	});

	it('tolerates a missing/empty prompt', () => {
		expect(mapPromptToN8n({ prompt: undefined })).toEqual([[{ json: { messages: [] } }]]);
	});
});

describe('mapResultToN8n', () => {
	it('maps text, finishReason and token usage', () => {
		const out = mapResultToN8n({
			text: 'answer',
			finishReason: 'stop',
			usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
		});

		expect(out).toEqual([
			[
				{
					json: {
						response: { text: 'answer', finishReason: 'stop' },
						tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
					},
				},
			],
		]);
	});

	it('derives text from content parts when text is absent', () => {
		const out = mapResultToN8n({
			content: [
				{ type: 'text', text: 'a' },
				{ type: 'text', text: 'b' },
			],
			finishReason: 'stop',
		});

		expect(out[0][0].json.response).toEqual({ text: 'ab', finishReason: 'stop' });
	});

	it('tolerates missing usage', () => {
		const out = mapResultToN8n({ text: 'x', finishReason: 'stop' });
		expect(out[0][0].json.tokenUsage).toEqual({
			promptTokens: undefined,
			completionTokens: undefined,
			totalTokens: undefined,
		});
	});
});

async function drain(stream: ReadableStream): Promise<unknown[]> {
	const reader = stream.getReader();
	const chunks: unknown[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}
	return chunks;
}

function streamOf(parts: unknown[]): ReadableStream {
	return new ReadableStream({
		start(controller) {
			for (const p of parts) controller.enqueue(p);
			controller.close();
		},
	});
}

describe('wrapModelForLogging doStream', () => {
	it('passes every chunk through unchanged and logs accumulated text + usage', async () => {
		const { ctx, calls } = makeCtx();
		const parts = [
			{ type: 'text-delta', id: '1', delta: 'Hel' },
			{ type: 'text-delta', id: '1', delta: 'lo' },
			{ type: 'finish', finishReason: 'stop', usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } },
		];
		const base = {
			provider: 'p',
			modelId: 'm',
			specificationVersion: 'v2',
			doGenerate: async () => ({}),
			doStream: async (_o: unknown) => ({ stream: streamOf(parts), extra: 1 }),
		};

		const wrapped = wrapModelForLogging(base, ctx);
		const { stream, extra } = (await wrapped.doStream({ prompt: [] })) as any;

		// non-stream fields preserved
		expect(extra).toBe(1);

		const seen = await drain(stream);
		expect(seen).toEqual(parts); // chunks unchanged

		// input logged once, output logged once after close
		expect(calls.input.length).toBe(1);
		expect(calls.output.length).toBe(1);
		const logged = (calls.output[0][2] as any)[0][0].json;
		expect(logged.response.text).toBe('Hello');
		expect(logged.response.finishReason).toBe('stop');
		expect(logged.tokenUsage).toEqual({ promptTokens: 4, completionTokens: 2, totalTokens: 6 });
	});

	it('logs an error chunk and still forwards it', async () => {
		const { ctx, calls } = makeCtx();
		const err = { type: 'error', error: new Error('mid-stream') };
		const base = {
			provider: 'p', modelId: 'm', specificationVersion: 'v2',
			doGenerate: async () => ({}),
			doStream: async () => ({ stream: streamOf([{ type: 'text-delta', id: '1', delta: 'x' }, err]) }),
		};
		const wrapped = wrapModelForLogging(base, ctx);
		const { stream } = (await wrapped.doStream({ prompt: [] })) as any;
		const seen = await drain(stream);
		expect(seen).toContainEqual(err);
		expect(calls.output.length).toBe(1); // still logged something on close
	});
});
