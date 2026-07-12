// test/modelNodeV2.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ILoadOptionsFunctions, ISupplyDataFunctions } from 'n8n-workflow';

vi.mock('@mastra/core/llm', () => ({
	resolveModelConfig: vi.fn(async (config: unknown) => ({ mockModel: true, config })),
}));

import {
	ModelOpenAiCompatibleMastra,
	buildCustomHeaders,
	resolveModelValue,
} from '../nodes/ModelOpenAiCompatibleMastra/ModelOpenAiCompatibleMastra.node';
import { clearModelCatalogCache } from '../nodes/shared/modelCatalog';
import type { MastraModelHandoff } from '../nodes/shared/modelHandoff';

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

describe('buildCustomHeaders', () => {
	it('builds a record from fixedCollection rows', () => {
		const warn = vi.fn();
		expect(
			buildCustomHeaders({ header: [{ name: 'X-Session-Id', value: 'abc' }] }, warn),
		).toEqual({ 'X-Session-Id': 'abc' });
		expect(warn).not.toHaveBeenCalled();
	});

	it('drops Authorization case-insensitively with a warning', () => {
		const warn = vi.fn();
		expect(
			buildCustomHeaders(
				{ header: [{ name: 'authorization', value: 'Bearer hack' }, { name: 'X-A', value: '1' }] },
				warn,
			),
		).toEqual({ 'X-A': '1' });
		expect(warn).toHaveBeenCalledOnce();
	});

	it('returns undefined for empty/missing rows and skips empty names', () => {
		const warn = vi.fn();
		expect(buildCustomHeaders(undefined, warn)).toBeUndefined();
		expect(buildCustomHeaders({ header: [] }, warn)).toBeUndefined();
		expect(buildCustomHeaders({ header: [{ name: '', value: 'x' }] }, warn)).toBeUndefined();
	});
});

describe('supplyData v2', () => {
	const fetchMock = vi.fn();

	function supplyContext(params: Record<string, unknown>, typeVersion = 2): ISupplyDataFunctions {
		return {
			getCredentials: vi.fn(async () => ({
				baseUrl: 'https://openrouter.ai/api/v1',
				apiKey: 'sk-test',
			})),
			getNodeParameter: vi.fn((name: string, _i: number, fallback?: unknown) =>
				name in params ? params[name] : fallback,
			),
			getNode: vi.fn(() => ({ name: 'Mastra Model', typeVersion })),
			logger: { warn: vi.fn() },
		} as unknown as ISupplyDataFunctions;
	}

	beforeEach(() => {
		vi.stubGlobal('fetch', fetchMock);
		fetchMock.mockReset();
		clearModelCatalogCache();
	});

	it('populates settings and headers on the handoff', async () => {
		fetchMock.mockResolvedValue({ ok: true, json: async () => OPENROUTER_BODY } as Response);
		const node = new ModelOpenAiCompatibleMastra();
		const ctx = supplyContext({
			model: { mode: 'list', value: 'openai/gpt-4o-mini' },
			options: { temperature: 0.3 },
			customHeaders: { header: [{ name: 'X-Session-Id', value: 's-1' }] },
		});

		const { response } = await node.supplyData.call(ctx, 0);
		const handoff = response as MastraModelHandoff;

		expect(handoff.settings).toEqual({ temperature: 0.3 });
		expect((handoff.config as { headers?: Record<string, string> }).headers).toEqual({
			'X-Session-Id': 's-1',
		});
		expect((handoff.config as { modelId?: string }).modelId).toBe('openai/gpt-4o-mini');
	});

	it('omits settings and headers when nothing is configured', async () => {
		fetchMock.mockResolvedValue({ ok: true, json: async () => OPENROUTER_BODY } as Response);
		const node = new ModelOpenAiCompatibleMastra();
		const ctx = supplyContext({ model: { mode: 'id', value: 'openai/gpt-4o-mini' } });

		const { response } = await node.supplyData.call(ctx, 0);
		const handoff = response as MastraModelHandoff;

		expect(handoff.settings).toBeUndefined();
		expect((handoff.config as { headers?: unknown }).headers).toBeUndefined();
	});

	it('rejects options the model does not support (per catalog)', async () => {
		// gpt-4o-mini advertises no 'reasoning' in OPENROUTER_BODY's supported_parameters
		fetchMock.mockResolvedValue({
			ok: true,
			json: async () => ({
				data: [
					{
						id: 'openai/gpt-4o-mini',
						supported_parameters: ['temperature', 'top_p', 'max_tokens'],
					},
				],
			}),
		} as Response);
		const node = new ModelOpenAiCompatibleMastra();
		const ctx = supplyContext({
			model: { mode: 'id', value: 'openai/gpt-4o-mini' },
			options: { reasoningEffort: 'high' },
		});

		await expect(node.supplyData.call(ctx, 0)).rejects.toThrow(/Reasoning Effort/);
	});

	it('skips validation when the endpoint has no catalog', async () => {
		fetchMock.mockResolvedValue({ ok: false, status: 404 } as Response);
		const node = new ModelOpenAiCompatibleMastra();
		const ctx = supplyContext({
			model: { mode: 'id', value: 'anything/goes' },
			options: { reasoningEffort: 'high' },
		});

		const { response } = await node.supplyData.call(ctx, 0);
		expect((response as MastraModelHandoff).settings).toEqual({ reasoning: 'high' });
	});

	it('keeps v1 behavior for typeVersion 1 (plain string, no options params)', async () => {
		const node = new ModelOpenAiCompatibleMastra();
		const ctx = supplyContext({ model: 'openai/gpt-4o-mini' }, 1);

		const { response } = await node.supplyData.call(ctx, 0);
		const handoff = response as MastraModelHandoff;

		expect((handoff.config as { modelId?: string }).modelId).toBe('openai/gpt-4o-mini');
		expect(handoff.settings).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('loadOptions.getReasoningEfforts', () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		vi.stubGlobal('fetch', fetchMock);
		fetchMock.mockReset();
		clearModelCatalogCache();
	});

	function ctx(model: unknown): ILoadOptionsFunctions {
		return {
			getCredentials: vi.fn(async () => ({
				baseUrl: 'https://openrouter.ai/api/v1',
				apiKey: 'sk-test',
			})),
			getCurrentNodeParameter: vi.fn(() => model),
			getNode: vi.fn(() => ({ name: 'Mastra Model' })),
		} as unknown as ILoadOptionsFunctions;
	}

	it('returns all levels when the model supports reasoning', async () => {
		fetchMock.mockResolvedValue({
			ok: true,
			json: async () => ({
				data: [{ id: 'openai/o3', supported_parameters: ['reasoning'] }],
			}),
		} as Response);
		const node = new ModelOpenAiCompatibleMastra();
		const options = await node.methods!.loadOptions!.getReasoningEfforts.call(
			ctx({ mode: 'list', value: 'openai/o3' }),
		);
		expect(options.map((o) => o.value)).toEqual(['minimal', 'low', 'medium', 'high']);
	});

	it('returns an empty list with a hint when the model does not support reasoning', async () => {
		fetchMock.mockResolvedValue({
			ok: true,
			json: async () => ({
				data: [{ id: 'openai/gpt-4o-mini', supported_parameters: ['temperature'] }],
			}),
		} as Response);
		const node = new ModelOpenAiCompatibleMastra();
		const options = await node.methods!.loadOptions!.getReasoningEfforts.call(
			ctx({ mode: 'list', value: 'openai/gpt-4o-mini' }),
		);
		expect(options).toHaveLength(1);
		expect(options[0].value).toBe('');
		expect(options[0].name).toMatch(/not.*support/i);
	});

	it('returns all levels when the catalog is unavailable or the model unknown', async () => {
		fetchMock.mockResolvedValue({ ok: false, status: 404 } as Response);
		const node = new ModelOpenAiCompatibleMastra();
		const options = await node.methods!.loadOptions!.getReasoningEfforts.call(
			ctx({ mode: 'id', value: 'whatever' }),
		);
		expect(options.map((o) => o.value)).toEqual(['minimal', 'low', 'medium', 'high']);
	});
});
