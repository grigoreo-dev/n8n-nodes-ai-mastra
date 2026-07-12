// test/modelNodeV2.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ILoadOptionsFunctions } from 'n8n-workflow';

vi.mock('@mastra/core/llm', () => ({
	resolveModelConfig: vi.fn(async (config: unknown) => ({ mockModel: true, config })),
}));

import {
	ModelOpenAiCompatibleMastra,
	resolveModelValue,
} from '../nodes/ModelOpenAiCompatibleMastra/ModelOpenAiCompatibleMastra.node';
import { clearModelCatalogCache } from '../nodes/shared/modelCatalog';

const OPENROUTER_BODY = {
	data: [
		{
			id: 'openai/gpt-4o-mini',
			name: 'GPT-4o Mini',
			context_length: 128000,
			pricing: { prompt: '0.00000015', completion: '0.0000006' },
		},
		{ id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', context_length: 200000 },
	],
};

describe('node description v2', () => {
	const node = new ModelOpenAiCompatibleMastra();

	it('declares versions 1 and 2 with default 2', () => {
		expect(node.description.version).toEqual([1, 2]);
		expect(node.description.defaultVersion).toBe(2);
	});

	it('has a v1 string model parameter and a v2 resourceLocator, gated by @version', () => {
		const props = node.description.properties.filter((p) => p.name === 'model');
		const v1 = props.find((p) => p.type === 'string');
		const v2 = props.find((p) => p.type === 'resourceLocator');
		expect(v1?.displayOptions?.show?.['@version']).toEqual([1]);
		expect(v2?.displayOptions?.show?.['@version']).toEqual([2]);
		const modes = (v2 as { modes?: Array<{ name: string }> }).modes?.map((m) => m.name);
		expect(modes).toEqual(['list', 'id']);
	});
});

describe('resolveModelValue', () => {
	it('returns a plain string trimmed (v1)', () => {
		expect(resolveModelValue('  openai/gpt-4o-mini ')).toBe('openai/gpt-4o-mini');
	});

	it('returns the value of a resourceLocator object (v2)', () => {
		expect(resolveModelValue({ mode: 'list', value: 'a/b', cachedResultName: 'A B' })).toBe('a/b');
		expect(resolveModelValue({ mode: 'id', value: ' c/d ' })).toBe('c/d');
	});

	it('returns an empty string for null/undefined/malformed input', () => {
		expect(resolveModelValue(undefined)).toBe('');
		expect(resolveModelValue(null)).toBe('');
		expect(resolveModelValue({ mode: 'id' })).toBe('');
	});
});

describe('listSearch.searchModels', () => {
	const fetchMock = vi.fn();

	function loadOptionsContext(): ILoadOptionsFunctions {
		return {
			getCredentials: vi.fn(async () => ({
				baseUrl: 'https://openrouter.ai/api/v1',
				apiKey: 'sk-test',
			})),
			getNode: vi.fn(() => ({ name: 'Mastra Model' })),
		} as unknown as ILoadOptionsFunctions;
	}

	beforeEach(() => {
		vi.stubGlobal('fetch', fetchMock);
		fetchMock.mockReset();
		clearModelCatalogCache();
	});

	it('lists models with context length and pricing in the description', async () => {
		fetchMock.mockResolvedValue({ ok: true, json: async () => OPENROUTER_BODY } as Response);
		const node = new ModelOpenAiCompatibleMastra();

		const result = await node.methods!.listSearch!.searchModels.call(loadOptionsContext());

		expect(result.results).toHaveLength(2);
		expect(result.results[0]).toMatchObject({ name: 'openai/gpt-4o-mini', value: 'openai/gpt-4o-mini' });
		expect(result.results[0].description).toContain('GPT-4o Mini');
		expect(result.results[0].description).toContain('128000');
	});

	it('filters by the search string (case-insensitive, id and name)', async () => {
		fetchMock.mockResolvedValue({ ok: true, json: async () => OPENROUTER_BODY } as Response);
		const node = new ModelOpenAiCompatibleMastra();

		const result = await node.methods!.listSearch!.searchModels.call(
			loadOptionsContext(),
			'claude',
		);

		expect(result.results).toHaveLength(1);
		expect(result.results[0].value).toBe('anthropic/claude-3.5-sonnet');
	});

	it('throws a clear error when the endpoint has no /models', async () => {
		fetchMock.mockResolvedValue({ ok: false, status: 404 } as Response);
		const node = new ModelOpenAiCompatibleMastra();

		await expect(
			node.methods!.listSearch!.searchModels.call(loadOptionsContext()),
		).rejects.toThrow(/By ID/);
	});
});
