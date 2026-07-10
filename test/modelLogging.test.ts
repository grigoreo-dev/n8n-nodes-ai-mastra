import { describe, expect, it } from 'vitest';

import { mapPromptToN8n, mapResultToN8n } from '../nodes/shared/modelLogging';

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
