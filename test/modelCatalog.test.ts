// test/modelCatalog.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	clearModelCatalogCache,
	findModel,
	getModelCatalog,
} from '../nodes/shared/modelCatalog';

const OPENROUTER_BODY = {
	data: [
		{
			id: 'openai/gpt-4o-mini',
			name: 'GPT-4o Mini',
			context_length: 128000,
			pricing: { prompt: '0.00000015', completion: '0.0000006' },
			supported_parameters: ['temperature', 'top_p', 'max_tokens'],
		},
		{
			id: 'anthropic/claude-3.5-sonnet',
			name: 'Claude 3.5 Sonnet',
			context_length: 200000,
			pricing: { prompt: '0.000003', completion: '0.000015' },
			supported_parameters: ['temperature', 'top_p', 'max_tokens', 'reasoning'],
		},
	],
};

function okResponse(body: unknown) {
	return { ok: true, json: async () => body } as Response;
}

describe('getModelCatalog', () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		vi.stubGlobal('fetch', fetchMock);
		fetchMock.mockReset();
		clearModelCatalogCache();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it('fetches {baseUrl}/models with a Bearer token and parses the list', async () => {
		fetchMock.mockResolvedValue(okResponse(OPENROUTER_BODY));

		const models = await getModelCatalog('https://openrouter.ai/api/v1', 'sk-test');

		expect(fetchMock).toHaveBeenCalledWith('https://openrouter.ai/api/v1/models', {
			headers: { Authorization: 'Bearer sk-test' },
		});
		expect(models).toHaveLength(2);
		expect(models![0]).toEqual({
			id: 'openai/gpt-4o-mini',
			name: 'GPT-4o Mini',
			contextLength: 128000,
			pricing: { prompt: '0.00000015', completion: '0.0000006' },
			supportedParameters: ['temperature', 'top_p', 'max_tokens'],
		});
	});

	it('strips a trailing slash off the base URL', async () => {
		fetchMock.mockResolvedValue(okResponse(OPENROUTER_BODY));
		await getModelCatalog('https://openrouter.ai/api/v1/', 'sk-test');
		expect(fetchMock).toHaveBeenCalledWith(
			'https://openrouter.ai/api/v1/models',
			expect.anything(),
		);
	});

	it('serves repeat calls from cache within the TTL', async () => {
		fetchMock.mockResolvedValue(okResponse(OPENROUTER_BODY));
		await getModelCatalog('https://openrouter.ai/api/v1', 'sk-test');
		await getModelCatalog('https://openrouter.ai/api/v1', 'sk-test');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('refetches after the TTL expires', async () => {
		fetchMock.mockResolvedValue(okResponse(OPENROUTER_BODY));
		await getModelCatalog('https://openrouter.ai/api/v1', 'sk-test');
		vi.advanceTimersByTime(10 * 60 * 1000 + 1);
		await getModelCatalog('https://openrouter.ai/api/v1', 'sk-test');
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('isolates cache entries per baseUrl and per apiKey', async () => {
		fetchMock.mockResolvedValue(okResponse(OPENROUTER_BODY));
		await getModelCatalog('https://openrouter.ai/api/v1', 'sk-a');
		await getModelCatalog('https://openrouter.ai/api/v1', 'sk-b');
		await getModelCatalog('https://api.openai.com/v1', 'sk-a');
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it('returns null (negative cache) on a non-OK response and retries only after 30s', async () => {
		fetchMock.mockResolvedValue({ ok: false, status: 404 } as Response);

		expect(await getModelCatalog('https://gw.local/v1', 'k')).toBeNull();
		expect(await getModelCatalog('https://gw.local/v1', 'k')).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(30 * 1000 + 1);
		fetchMock.mockResolvedValue(okResponse(OPENROUTER_BODY));
		expect(await getModelCatalog('https://gw.local/v1', 'k')).toHaveLength(2);
	});

	it('returns null when fetch throws (network error)', async () => {
		fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
		expect(await getModelCatalog('https://down.local/v1', 'k')).toBeNull();
	});

	it('returns null when the body is not an OpenAI-style list', async () => {
		fetchMock.mockResolvedValue(okResponse({ hello: 'world' }));
		expect(await getModelCatalog('https://weird.local/v1', 'k')).toBeNull();
	});

	it('tolerates models without name/context/pricing/supported_parameters', async () => {
		fetchMock.mockResolvedValue(okResponse({ data: [{ id: 'local-model' }] }));
		const models = await getModelCatalog('http://localhost:8000/v1', 'k');
		expect(models).toEqual([{ id: 'local-model' }]);
	});
});

describe('findModel', () => {
	it('finds a model by exact id', () => {
		const models = [{ id: 'a/b' }, { id: 'c/d' }];
		expect(findModel(models, 'c/d')).toEqual({ id: 'c/d' });
	});

	it('returns undefined for a null catalog or unknown id', () => {
		expect(findModel(null, 'a/b')).toBeUndefined();
		expect(findModel([{ id: 'a/b' }], 'zzz')).toBeUndefined();
	});
});
