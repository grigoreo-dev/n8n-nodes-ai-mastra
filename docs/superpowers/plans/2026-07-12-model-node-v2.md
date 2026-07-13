# Mastra Model Sub-Node v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the Mastra Model sub-node to v2: model picker backed by `GET /models` with a TTL cache, an Options section (temperature, reasoning, …) delivered to the agent via the handoff, custom headers, and soft runtime validation.

**Architecture:** A new shared `modelCatalog.ts` module (module-level TTL cache, same singleton pattern as `poolManager.ts`) serves both the UI model list (`listSearch`) and runtime option validation. The node gets `version: [1, 2]`; v2 swaps the plain `model` string for a `resourceLocator` and adds `options` + `customHeaders` parameters. Model call settings ride on a new `settings` field of `MastraModelHandoff`; the agent node passes them to `stream(prompt, { modelSettings })`. Custom headers go into `config.headers` (native `OpenAICompatibleConfig` field).

**Tech Stack:** TypeScript (CommonJS output, `moduleResolution: nodenext`), n8n-workflow node API, `@mastra/core` 1.49.0 (pinned), vitest.

**Spec:** `docs/superpowers/specs/2026-07-12-model-node-v2-design.md`

## Global Constraints

- `@mastra/core` stays pinned to `1.49.0` exactly — do not bump.
- All committed content (code, comments, commit messages, docs) is English.
- No new runtime npm dependencies (use Node's built-in `fetch` and `crypto`).
- Existing v1 workflows must keep working unchanged (`version: [1, 2]`, v1 keeps the plain string parameter).
- Run `npm run typecheck` and `npm test` before every commit.

---

### Task 1: Model catalog shared module with TTL cache

**Files:**
- Create: `nodes/shared/modelCatalog.ts`
- Test: `test/modelCatalog.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (global `fetch`, `node:crypto`).
- Produces:
  - `interface CatalogModel { id: string; name?: string; contextLength?: number; pricing?: { prompt?: string; completion?: string }; supportedParameters?: string[] }`
  - `getModelCatalog(baseUrl: string, apiKey: string): Promise<CatalogModel[] | null>` — `null` means "endpoint has no usable /models" (negative-cached).
  - `findModel(models: CatalogModel[] | null, id: string): CatalogModel | undefined`
  - `clearModelCatalogCache(): void` (tests only)

- [ ] **Step 1: Write the failing tests**

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/modelCatalog.test.ts`
Expected: FAIL — `Cannot find module '../nodes/shared/modelCatalog'`.

- [ ] **Step 3: Implement the module**

```typescript
// nodes/shared/modelCatalog.ts
import { createHash } from 'node:crypto';

/**
 * Model catalog fetched from an OpenAI-compatible `GET {baseUrl}/models`,
 * cached in-process with a TTL — same module-level-singleton pattern as
 * poolManager.ts. One catalog serves both the UI model list (listSearch)
 * and the soft runtime validation of model options.
 *
 * The cache is per Node.js process: each n8n queue-mode worker warms its
 * own copy, and a restart just costs one extra fetch. Failures are cached
 * briefly (negative cache) so a broken endpoint isn't hammered by UI
 * loadOptions retries.
 */
export interface CatalogModel {
	id: string;
	name?: string;
	contextLength?: number;
	pricing?: { prompt?: string; completion?: string };
	/** OpenRouter extension; absent on plain OpenAI/vLLM endpoints. */
	supportedParameters?: string[];
}

interface CacheEntry {
	/** null = endpoint has no usable /models (negative-cached). */
	models: CatalogModel[] | null;
	fetchedAt: number;
}

const TTL_MS = 10 * 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 1000;

const cache = new Map<string, CacheEntry>();

function cacheKey(baseUrl: string, apiKey: string): string {
	const keyHash = createHash('sha256').update(apiKey).digest('hex');
	return `${baseUrl}::${keyHash}`;
}

function parseModel(raw: Record<string, unknown>): CatalogModel | undefined {
	if (typeof raw?.id !== 'string' || raw.id.length === 0) return undefined;
	const model: CatalogModel = { id: raw.id };
	if (typeof raw.name === 'string') model.name = raw.name;
	if (typeof raw.context_length === 'number') model.contextLength = raw.context_length;
	const pricing = raw.pricing as { prompt?: unknown; completion?: unknown } | undefined;
	if (pricing && (typeof pricing.prompt === 'string' || typeof pricing.completion === 'string')) {
		model.pricing = {
			...(typeof pricing.prompt === 'string' ? { prompt: pricing.prompt } : {}),
			...(typeof pricing.completion === 'string' ? { completion: pricing.completion } : {}),
		};
	}
	if (
		Array.isArray(raw.supported_parameters) &&
		raw.supported_parameters.every((p) => typeof p === 'string')
	) {
		model.supportedParameters = raw.supported_parameters as string[];
	}
	return model;
}

/**
 * Fetch (or serve from cache) the model list of an OpenAI-compatible
 * endpoint. Returns `null` when the endpoint has no usable `/models`
 * (404, network error, non-OpenAI body shape) — never throws.
 */
export async function getModelCatalog(
	baseUrl: string,
	apiKey: string,
): Promise<CatalogModel[] | null> {
	const key = cacheKey(baseUrl, apiKey);
	const hit = cache.get(key);
	if (hit) {
		const ttl = hit.models === null ? NEGATIVE_TTL_MS : TTL_MS;
		if (Date.now() - hit.fetchedAt < ttl) return hit.models;
	}

	let models: CatalogModel[] | null = null;
	try {
		const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
			headers: { Authorization: `Bearer ${apiKey}` },
		});
		if (response.ok) {
			const body = (await response.json()) as { data?: unknown };
			if (Array.isArray(body?.data)) {
				models = body.data
					.map((raw) => parseModel(raw as Record<string, unknown>))
					.filter((m): m is CatalogModel => m !== undefined);
			}
		}
	} catch {
		// Network/parse failure → negative cache below.
	}

	cache.set(key, { models, fetchedAt: Date.now() });
	return models;
}

export function findModel(
	models: CatalogModel[] | null,
	id: string,
): CatalogModel | undefined {
	return models?.find((m) => m.id === id);
}

/** Test hook. */
export function clearModelCatalogCache(): void {
	cache.clear();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/modelCatalog.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add nodes/shared/modelCatalog.ts test/modelCatalog.test.ts
git commit -m "feat(model): add model catalog module with in-process TTL cache"
```

---

### Task 2: Handoff `settings` type + option/settings mapping and validation helpers

**Files:**
- Modify: `nodes/shared/modelHandoff.ts`
- Create: `nodes/shared/modelSettings.ts`
- Test: `test/modelSettings.test.ts`

**Interfaces:**
- Consumes: `CatalogModel`, `findModel` from Task 1.
- Produces:
  - `interface MastraModelSettings { temperature?: number; topP?: number; maxOutputTokens?: number; frequencyPenalty?: number; presencePenalty?: number; stopSequences?: string[]; reasoning?: 'minimal' | 'low' | 'medium' | 'high' }` (exported from `modelSettings.ts`)
  - `MastraModelHandoff` gains optional field `settings?: MastraModelSettings`.
  - `buildModelSettings(raw: ModelNodeOptions): MastraModelSettings | undefined` — returns `undefined` when no option is set.
  - `interface ModelNodeOptions { temperature?: number; maxOutputTokens?: number; topP?: number; frequencyPenalty?: number; presencePenalty?: number; reasoningEffort?: string; stopSequences?: string }` (the node's raw `options` collection value)
  - `findUnsupportedOptions(model: CatalogModel | undefined, settings: MastraModelSettings): string[]` — returns human-readable option names not supported by the model; empty array when the model is unknown or advertises no `supportedParameters`.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/modelSettings.test.ts
import { describe, expect, it } from 'vitest';

import type { CatalogModel } from '../nodes/shared/modelCatalog';
import {
	buildModelSettings,
	findUnsupportedOptions,
} from '../nodes/shared/modelSettings';

describe('buildModelSettings', () => {
	it('returns undefined for an empty options object', () => {
		expect(buildModelSettings({})).toBeUndefined();
	});

	it('maps plain numeric options one-to-one', () => {
		expect(
			buildModelSettings({
				temperature: 0.7,
				maxOutputTokens: 1024,
				topP: 0.9,
				frequencyPenalty: 0.5,
				presencePenalty: -0.5,
			}),
		).toEqual({
			temperature: 0.7,
			maxOutputTokens: 1024,
			topP: 0.9,
			frequencyPenalty: 0.5,
			presencePenalty: -0.5,
		});
	});

	it('splits comma-separated stop sequences and trims whitespace', () => {
		expect(buildModelSettings({ stopSequences: 'END, STOP ,\nDONE' })).toEqual({
			stopSequences: ['END', 'STOP', 'DONE'],
		});
	});

	it('ignores an empty stop-sequences string', () => {
		expect(buildModelSettings({ stopSequences: '  ' })).toBeUndefined();
	});

	it('maps reasoningEffort to reasoning', () => {
		expect(buildModelSettings({ reasoningEffort: 'high' })).toEqual({
			reasoning: 'high',
		});
	});

	it('ignores zero-as-unset numbers only when the field is absent, keeps explicit 0', () => {
		expect(buildModelSettings({ temperature: 0 })).toEqual({ temperature: 0 });
	});
});

describe('findUnsupportedOptions', () => {
	const model: CatalogModel = {
		id: 'openai/gpt-4o-mini',
		supportedParameters: ['temperature', 'top_p', 'max_tokens', 'stop'],
	};

	it('returns [] when everything is supported', () => {
		expect(
			findUnsupportedOptions(model, { temperature: 1, topP: 0.5, maxOutputTokens: 10 }),
		).toEqual([]);
	});

	it('reports unsupported options by display name', () => {
		expect(
			findUnsupportedOptions(model, { reasoning: 'low', frequencyPenalty: 1 }),
		).toEqual(['Reasoning Effort', 'Frequency Penalty']);
	});

	it('returns [] when the model is unknown', () => {
		expect(findUnsupportedOptions(undefined, { reasoning: 'low' })).toEqual([]);
	});

	it('returns [] when the model advertises no supported_parameters', () => {
		expect(findUnsupportedOptions({ id: 'x' }, { reasoning: 'low' })).toEqual([]);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/modelSettings.test.ts`
Expected: FAIL — `Cannot find module '../nodes/shared/modelSettings'`.

- [ ] **Step 3: Implement `modelSettings.ts` and extend the handoff type**

```typescript
// nodes/shared/modelSettings.ts
import type { CatalogModel } from './modelCatalog';

/**
 * Model call settings configured on the Mastra Model sub-node and delivered
 * to the Agent node via `MastraModelHandoff.settings`. The agent passes them
 * verbatim to `agent.stream(prompt, { modelSettings })` — they are CALL
 * options in Mastra's API, not constructor options, which is why they ride
 * the handoff instead of being baked into the model instance.
 *
 * Field names follow Mastra's `modelSettings` (AI SDK `CallSettings` +
 * `reasoning`).
 */
export interface MastraModelSettings {
	temperature?: number;
	topP?: number;
	maxOutputTokens?: number;
	frequencyPenalty?: number;
	presencePenalty?: number;
	stopSequences?: string[];
	reasoning?: 'minimal' | 'low' | 'medium' | 'high';
}

/** Raw value of the node's `options` collection parameter. */
export interface ModelNodeOptions {
	temperature?: number;
	maxOutputTokens?: number;
	topP?: number;
	frequencyPenalty?: number;
	presencePenalty?: number;
	reasoningEffort?: string;
	stopSequences?: string;
}

const REASONING_LEVELS = ['minimal', 'low', 'medium', 'high'] as const;

export function buildModelSettings(raw: ModelNodeOptions): MastraModelSettings | undefined {
	const settings: MastraModelSettings = {};

	if (typeof raw.temperature === 'number') settings.temperature = raw.temperature;
	if (typeof raw.maxOutputTokens === 'number') settings.maxOutputTokens = raw.maxOutputTokens;
	if (typeof raw.topP === 'number') settings.topP = raw.topP;
	if (typeof raw.frequencyPenalty === 'number') settings.frequencyPenalty = raw.frequencyPenalty;
	if (typeof raw.presencePenalty === 'number') settings.presencePenalty = raw.presencePenalty;

	if (typeof raw.stopSequences === 'string') {
		const sequences = raw.stopSequences
			.split(',')
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		if (sequences.length > 0) settings.stopSequences = sequences;
	}

	if (
		typeof raw.reasoningEffort === 'string' &&
		(REASONING_LEVELS as readonly string[]).includes(raw.reasoningEffort)
	) {
		settings.reasoning = raw.reasoningEffort as MastraModelSettings['reasoning'];
	}

	return Object.keys(settings).length > 0 ? settings : undefined;
}

/**
 * Which `supported_parameters` entry (OpenRouter naming) each of our
 * settings needs, plus the display name used in error messages.
 */
const PARAMETER_MAP: Array<{
	key: keyof MastraModelSettings;
	providerParam: string;
	displayName: string;
}> = [
	{ key: 'temperature', providerParam: 'temperature', displayName: 'Temperature' },
	{ key: 'topP', providerParam: 'top_p', displayName: 'Top P' },
	{ key: 'maxOutputTokens', providerParam: 'max_tokens', displayName: 'Max Output Tokens' },
	{ key: 'frequencyPenalty', providerParam: 'frequency_penalty', displayName: 'Frequency Penalty' },
	{ key: 'presencePenalty', providerParam: 'presence_penalty', displayName: 'Presence Penalty' },
	{ key: 'stopSequences', providerParam: 'stop', displayName: 'Stop Sequences' },
	{ key: 'reasoning', providerParam: 'reasoning', displayName: 'Reasoning Effort' },
];

/**
 * Soft validation: compare configured settings against the model's advertised
 * `supported_parameters`. Empty result when the catalog knows nothing about
 * the model or the field is absent (plain OpenAI/vLLM endpoints) — validation
 * must never block endpoints that don't advertise capabilities.
 */
export function findUnsupportedOptions(
	model: CatalogModel | undefined,
	settings: MastraModelSettings,
): string[] {
	const supported = model?.supportedParameters;
	if (!supported || supported.length === 0) return [];
	return PARAMETER_MAP.filter(
		({ key, providerParam }) => settings[key] !== undefined && !supported.includes(providerParam),
	).map(({ displayName }) => displayName);
}
```

Extend the handoff (`nodes/shared/modelHandoff.ts`) — add the import at the top and the field before the closing brace of the interface:

```typescript
// at the top of nodes/shared/modelHandoff.ts
import type { MastraModelSettings } from './modelSettings';
```

```typescript
// inside interface MastraModelHandoff, after `model: unknown;`
	/**
	 * Model call settings (temperature, reasoning, …) configured on the model
	 * sub-node. The Agent node forwards them to
	 * `agent.stream(prompt, { modelSettings })`; absent when the user set no
	 * options.
	 */
	settings?: MastraModelSettings;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/modelSettings.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, run the full suite, commit**

```bash
npm run typecheck
npm test
git add nodes/shared/modelSettings.ts nodes/shared/modelHandoff.ts test/modelSettings.test.ts
git commit -m "feat(model): settings mapping, soft validation, handoff settings field"
```

---

### Task 3: Node v2 — resourceLocator model picker + listSearch

**Files:**
- Modify: `nodes/ModelOpenAiCompatibleMastra/ModelOpenAiCompatibleMastra.node.ts`
- Test: `test/modelNodeV2.test.ts`

**Interfaces:**
- Consumes: `getModelCatalog`, `CatalogModel` from Task 1.
- Produces:
  - Node `description.version` becomes `[1, 2]`, `defaultVersion: 2`.
  - v2 parameter `model` of type `resourceLocator` with modes `list` (searchListMethod `searchModels`) and `id`.
  - `methods.listSearch.searchModels(this: ILoadOptionsFunctions, filter?: string): Promise<INodeListSearchResult>`.
  - `resolveModelParameter(ctx, itemIndex): string` — internal helper reading either the v1 string or the v2 resourceLocator (used by Task 4's `supplyData` changes; keep it a module-scope function in the node file, exported for tests: `export function resolveModelValue(param: unknown): string`).

- [ ] **Step 1: Write the failing tests**

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/modelNodeV2.test.ts`
Expected: FAIL — `resolveModelValue` is not exported; description still `version: [1]`.

- [ ] **Step 3: Implement the v2 description, `resolveModelValue`, and `listSearch`**

In `nodes/ModelOpenAiCompatibleMastra/ModelOpenAiCompatibleMastra.node.ts`:

Add imports:

```typescript
import type {
	ILoadOptionsFunctions,
	INodeListSearchResult,
} from 'n8n-workflow';

import { getModelCatalog, type CatalogModel } from '../shared/modelCatalog';
```

Change the version fields in `description`:

```typescript
		version: [1, 2],
		defaultVersion: 2,
```

Replace the single `model` property with a version-gated pair (v1 keeps the exact current definition plus `displayOptions`; v2 is new):

```typescript
			{
				// v1 (legacy): plain string, kept for existing workflows.
				displayName: 'Model',
				name: 'model',
				type: 'string',
				default: 'openai/gpt-4o-mini',
				required: true,
				placeholder: 'openai/gpt-4o-mini',
				displayOptions: { show: { '@version': [1] } },
				description:
					"The model name EXACTLY as your endpoint expects it — it is sent verbatim to {baseUrl}/chat/completions. Any slashes are kept (e.g. 'openai/gpt-4o-mini', 'antigravity/gemini-3.5-flash-medium', 'auto/fast').",
			},
			{
				// v2: pick from the endpoint's /models list, or type a raw id.
				displayName: 'Model',
				name: 'model',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				required: true,
				displayOptions: { show: { '@version': [2] } },
				description:
					'The model to use. "From list" fetches GET {baseUrl}/models from the credential\'s endpoint; if your endpoint does not expose a model list, use "By ID". The id is sent verbatim to {baseUrl}/chat/completions (slashes kept).',
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						typeOptions: {
							searchListMethod: 'searchModels',
							searchable: true,
						},
					},
					{
						displayName: 'By ID',
						name: 'id',
						type: 'string',
						placeholder: 'openai/gpt-4o-mini',
					},
				],
			},
```

Add the module-scope helper (exported for tests) below the imports:

```typescript
/**
 * Read the model id off either node version: v1 stores a plain string, v2 a
 * resourceLocator object ({ mode, value }). Returns '' when unset.
 */
export function resolveModelValue(param: unknown): string {
	if (typeof param === 'string') return param.trim();
	if (typeof param === 'object' && param !== null) {
		const value = (param as { value?: unknown }).value;
		if (typeof value === 'string') return value.trim();
	}
	return '';
}

function describeModel(model: CatalogModel): string {
	const parts: string[] = [];
	if (model.name) parts.push(model.name);
	if (model.contextLength) parts.push(`ctx ${model.contextLength}`);
	if (model.pricing?.prompt) parts.push(`$${model.pricing.prompt}/in`);
	if (model.pricing?.completion) parts.push(`$${model.pricing.completion}/out`);
	return parts.join(' · ');
}
```

Add `methods` to the class (before `supplyData`):

```typescript
	methods = {
		listSearch: {
			async searchModels(
				this: ILoadOptionsFunctions,
				filter?: string,
			): Promise<INodeListSearchResult> {
				const credentials = (await this.getCredentials('mastraOpenAiCompatibleApi')) as {
					baseUrl?: string;
					apiKey?: string;
				};
				const models = await getModelCatalog(
					credentials.baseUrl?.trim() ?? '',
					credentials.apiKey?.trim() ?? '',
				);
				if (models === null) {
					throw new NodeOperationError(
						this.getNode(),
						'This endpoint does not expose a usable GET /models list. Switch the Model field to "By ID" and type the model name manually.',
					);
				}
				const needle = filter?.toLowerCase();
				const results = models
					.filter(
						(m) =>
							!needle ||
							m.id.toLowerCase().includes(needle) ||
							m.name?.toLowerCase().includes(needle),
					)
					.map((m) => ({
						name: m.id,
						value: m.id,
						description: describeModel(m),
					}));
				return { results };
			},
		},
	};
```

In `supplyData`, replace the `model` read:

```typescript
		const model = resolveModelValue(this.getNodeParameter('model', itemIndex));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/modelNodeV2.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite, typecheck, commit**

```bash
npm run typecheck
npm test
git add nodes/ModelOpenAiCompatibleMastra/ModelOpenAiCompatibleMastra.node.ts test/modelNodeV2.test.ts
git commit -m "feat(model): v2 resourceLocator model picker backed by GET /models"
```

---

### Task 4: Node v2 — Options, Custom Headers, runtime validation in supplyData

**Files:**
- Modify: `nodes/ModelOpenAiCompatibleMastra/ModelOpenAiCompatibleMastra.node.ts`
- Test: `test/modelNodeV2.test.ts` (extend)

**Interfaces:**
- Consumes: `buildModelSettings`, `findUnsupportedOptions`, `ModelNodeOptions` (Task 2); `getModelCatalog`, `findModel` (Task 1); `resolveModelValue` (Task 3).
- Produces:
  - v2 node parameters `options` (collection) and `customHeaders` (fixedCollection `header` → `{ name, value }[]`).
  - `methods.loadOptions.getReasoningEfforts(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]>`.
  - `buildCustomHeaders(raw: unknown, warn: (msg: string) => void): Record<string, string> | undefined` — module-scope, exported for tests; drops `Authorization` (case-insensitive) with a warning.
  - `supplyData` returns handoff with `config.headers` and `settings` populated.

- [ ] **Step 1: Write the failing tests (append to `test/modelNodeV2.test.ts`)**

```typescript
import { NodeOperationError } from 'n8n-workflow';
import type { ISupplyDataFunctions } from 'n8n-workflow';

import { buildCustomHeaders } from '../nodes/ModelOpenAiCompatibleMastra/ModelOpenAiCompatibleMastra.node';
import type { MastraModelHandoff } from '../nodes/shared/modelHandoff';

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
```

Note: the `getReasoningEfforts` loadOptions method is covered by a small test too:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/modelNodeV2.test.ts`
Expected: FAIL — `buildCustomHeaders` not exported, `options`/`customHeaders` parameters missing, no validation.

- [ ] **Step 3: Implement parameters, loadOptions, headers builder, and the new supplyData**

Add imports to the node file:

```typescript
import type { INodePropertyOptions } from 'n8n-workflow';

import { findModel } from '../shared/modelCatalog';
import {
	buildModelSettings,
	findUnsupportedOptions,
	type ModelNodeOptions,
} from '../shared/modelSettings';
```

Append the two v2 properties after the resourceLocator `model` property:

```typescript
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { '@version': [2] } },
				options: [
					{
						displayName: 'Frequency Penalty',
						name: 'frequencyPenalty',
						type: 'number',
						default: 0,
						typeOptions: { minValue: -2, maxValue: 2, numberPrecision: 2 },
						description: 'Penalizes tokens proportionally to their existing frequency',
					},
					{
						displayName: 'Max Output Tokens',
						name: 'maxOutputTokens',
						type: 'number',
						default: 1024,
						typeOptions: { minValue: 1 },
						description: 'Upper bound on the number of tokens the model may generate',
					},
					{
						displayName: 'Presence Penalty',
						name: 'presencePenalty',
						type: 'number',
						default: 0,
						typeOptions: { minValue: -2, maxValue: 2, numberPrecision: 2 },
						description: 'Penalizes tokens that already appeared at all',
					},
					{
						displayName: 'Reasoning Effort',
						name: 'reasoningEffort',
						type: 'options',
						default: 'medium',
						typeOptions: {
							loadOptionsMethod: 'getReasoningEfforts',
							loadOptionsDependsOn: ['model.value'],
						},
						description:
							'How much reasoning the model performs before answering. The list reflects what the selected model supports (when the endpoint advertises it).',
					},
					{
						displayName: 'Stop Sequences',
						name: 'stopSequences',
						type: 'string',
						default: '',
						placeholder: 'END,STOP',
						description: 'Comma-separated sequences that stop generation',
					},
					{
						displayName: 'Temperature',
						name: 'temperature',
						type: 'number',
						default: 1,
						typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 2 },
						description: 'Sampling temperature; higher is more random',
					},
					{
						displayName: 'Top P',
						name: 'topP',
						type: 'number',
						default: 1,
						typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
						description: 'Nucleus-sampling probability mass',
					},
				],
			},
			{
				displayName: 'Custom Headers',
				name: 'customHeaders',
				type: 'fixedCollection',
				default: {},
				typeOptions: { multipleValues: true },
				displayOptions: { show: { '@version': [2] } },
				description:
					'Extra HTTP headers sent with every model request, e.g. an OpenRouter session id. Values support expressions. The Authorization header is managed by the credential and cannot be overridden here.',
				options: [
					{
						displayName: 'Header',
						name: 'header',
						values: [
							{
								displayName: 'Name',
								name: 'name',
								type: 'string',
								default: '',
								placeholder: 'X-Session-Id',
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
								placeholder: '={{ $json.sessionId }}',
							},
						],
					},
				],
			},
```

Add the exported headers builder at module scope:

```typescript
/**
 * Turn the customHeaders fixedCollection value into a plain header record.
 * `Authorization` is silently owned by the credential: a user-supplied value
 * is dropped with a warning instead of overriding the Bearer token.
 */
export function buildCustomHeaders(
	raw: unknown,
	warn: (message: string) => void,
): Record<string, string> | undefined {
	const rows = (raw as { header?: Array<{ name?: string; value?: string }> } | undefined)?.header;
	if (!Array.isArray(rows) || rows.length === 0) return undefined;

	const headers: Record<string, string> = {};
	for (const row of rows) {
		const name = row.name?.trim();
		if (!name) continue;
		if (name.toLowerCase() === 'authorization') {
			warn(
				'Custom header "Authorization" is ignored — that header is managed by the credential.',
			);
			continue;
		}
		headers[name] = row.value ?? '';
	}
	return Object.keys(headers).length > 0 ? headers : undefined;
}

const REASONING_OPTIONS: INodePropertyOptions[] = [
	{ name: 'Minimal', value: 'minimal' },
	{ name: 'Low', value: 'low' },
	{ name: 'Medium', value: 'medium' },
	{ name: 'High', value: 'high' },
];
```

Add `getReasoningEfforts` to `methods` (a `loadOptions` group next to the existing `listSearch`):

```typescript
		loadOptions: {
			async getReasoningEfforts(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const credentials = (await this.getCredentials('mastraOpenAiCompatibleApi')) as {
					baseUrl?: string;
					apiKey?: string;
				};
				const modelId = resolveModelValue(this.getCurrentNodeParameter('model'));
				const catalog = await getModelCatalog(
					credentials.baseUrl?.trim() ?? '',
					credentials.apiKey?.trim() ?? '',
				);
				const model = findModel(catalog, modelId);
				// Only restrict when the endpoint explicitly advertises capabilities.
				if (model?.supportedParameters && !model.supportedParameters.includes('reasoning')) {
					return [
						{
							name: 'This model does not support reasoning effort',
							value: '',
						},
					];
				}
				return REASONING_OPTIONS;
			},
		},
```

Rewrite `supplyData` (full replacement of the method body after the credential/model/url/apiKey reads and their guards, which stay as-is):

```typescript
	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const credentials = (await this.getCredentials('mastraOpenAiCompatibleApi')) as {
			baseUrl?: string;
			apiKey?: string;
		};

		const model = resolveModelValue(this.getNodeParameter('model', itemIndex));
		const url = credentials.baseUrl?.trim();
		const apiKey = credentials.apiKey?.trim();

		if (!model) {
			throw new NodeOperationError(this.getNode(), 'Model is required', { itemIndex });
		}
		if (!url) {
			throw new NodeOperationError(this.getNode(), 'Base URL is required on the credential', {
				itemIndex,
			});
		}
		if (!apiKey) {
			throw new NodeOperationError(this.getNode(), 'API Key is required on the credential', {
				itemIndex,
			});
		}

		const isV2 = this.getNode().typeVersion >= 2;

		// v2-only: model options and custom headers.
		let settings: MastraModelHandoff['settings'];
		let headers: Record<string, string> | undefined;
		if (isV2) {
			const rawOptions = this.getNodeParameter('options', itemIndex, {}) as ModelNodeOptions;
			settings = buildModelSettings(rawOptions);
			headers = buildCustomHeaders(
				this.getNodeParameter('customHeaders', itemIndex, {}),
				(message) => this.logger.warn(message),
			);

			// Soft validation against the endpoint's advertised capabilities.
			// No catalog / no supported_parameters → skip silently.
			if (settings) {
				const catalog = await getModelCatalog(url, apiKey);
				const unsupported = findUnsupportedOptions(findModel(catalog, model), settings);
				if (unsupported.length > 0) {
					throw new NodeOperationError(
						this.getNode(),
						`Model ${model} does not support: ${unsupported.join(', ')}`,
						{
							description:
								'The endpoint reports these parameters as unsupported for this model (supported_parameters). Remove them from Options or pick a different model.',
							itemIndex,
						},
					);
				}
			}
		}

		// Mastra's OpenAICompatibleConfig `{ providerId, modelId }` form. Unlike the
		// `{ id: 'a/b' }` form (which Mastra SPLITS on the first '/' — sending only
		// 'b' as the model), `modelId` is sent to the endpoint VERBATIM. That's what
		// custom gateways need when the model name itself contains slashes
		// (e.g. 'antigravity/gemini-3.5-flash-medium'). `providerId` is just an
		// internal routing tag for Mastra's OpenAI-compatible provider.
		const handoff: Omit<MastraModelHandoff, 'model'> = {
			__isMastraModel: true,
			config: {
				providerId: 'openai-compatible',
				modelId: model,
				url,
				apiKey,
				...(headers ? { headers } : {}),
			},
			...(settings ? { settings } : {}),
		};

		// Build the real LanguageModelV2 from our config, then wrap it so each
		// LLM call logs prompt/response/usage onto this sub-node's
		// ai_languageModel connection (making the Mastra Model node show up in
		// the execution tree, like stock n8n chat-model nodes).
		const resolved = await resolveModelConfig(handoff.config);
		const wrappedModel = wrapModelForLogging(
			resolved as unknown as Record<string, unknown>,
			this as unknown as ModelLogContext,
		);

		return {
			response: { ...handoff, model: wrappedModel },
		};
	}
```

Also update the import of the handoff type to a value import if needed and make sure `MastraModelHandoff` is imported as a type (it already is).

Note on `buildModelSettings` and the empty reasoning value: `getReasoningEfforts` returns `{ value: '' }` for unsupported models; `buildModelSettings` already ignores non-level strings (`''` is not in `REASONING_LEVELS`), so a stale empty selection cannot leak into settings.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/modelNodeV2.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite, typecheck, commit**

```bash
npm run typecheck
npm test
git add nodes/ModelOpenAiCompatibleMastra/ModelOpenAiCompatibleMastra.node.ts test/modelNodeV2.test.ts
git commit -m "feat(model): v2 options, custom headers, and soft capability validation"
```

---

### Task 5: Agent node forwards `handoff.settings` as `modelSettings`

**Files:**
- Modify: `nodes/MastraAgent/MastraAgent.node.ts:207` (the `agent.stream(...)` call)
- Test: `test/mastraAgent.test.ts` (extend)

**Interfaces:**
- Consumes: `MastraModelHandoff.settings` (Task 2).
- Produces: `agent.stream(prompt, { memory?, modelSettings? })` — settings applied per call.

- [ ] **Step 1: Write the failing test**

Open `test/mastraAgent.test.ts`, find how the existing tests mock `@mastra/core/agent` and build the execute context (reuse those helpers/mocks exactly — they already exist for the model/memory handoff tests). Add:

```typescript
it('passes handoff.settings to agent.stream as modelSettings', async () => {
	// Arrange: model handoff carrying settings (reuse the existing model handoff
	// fixture from this file, extended with `settings`).
	const handoffWithSettings = {
		__isMastraModel: true,
		config: { providerId: 'openai-compatible', modelId: 'openai/gpt-4o-mini', url: 'u', apiKey: 'k' },
		model: { specificationVersion: 'v2' },
		settings: { temperature: 0.3, reasoning: 'low' },
	};
	// ...wire handoffWithSettings into the AiLanguageModel input the same way
	// the existing "runs with a connected model" test does.

	await node.execute.call(ctx);

	// streamMock is the vi.fn() the file's Agent mock exposes for stream()
	expect(streamMock).toHaveBeenCalledWith(
		expect.any(String),
		expect.objectContaining({ modelSettings: { temperature: 0.3, reasoning: 'low' } }),
	);
});

it('omits modelSettings when the handoff has no settings', async () => {
	// Reuse the existing plain handoff fixture (no `settings`).
	await node.execute.call(ctx);
	const optionsArg = streamMock.mock.calls[0][1];
	expect(optionsArg.modelSettings).toBeUndefined();
});
```

(Adapt fixture names to the file's actual helpers — the assertion targets are the contract: `stream` receives `modelSettings` exactly when the handoff carries `settings`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/mastraAgent.test.ts`
Expected: the new tests FAIL (stream called without `modelSettings`).

- [ ] **Step 3: Implement the forwarding**

In `nodes/MastraAgent/MastraAgent.node.ts`, replace the stream call (line ~207):

```typescript
				const streamOptions: {
					memory?: { thread: string; resource: string };
					modelSettings?: NonNullable<MastraModelHandoff['settings']>;
				} = {};
				if (memoryScope) streamOptions.memory = memoryScope;
				if (connectedModel.settings) streamOptions.modelSettings = connectedModel.settings;

				const stream = await agent.stream(prompt, streamOptions);
```

Add the type import at the top:

```typescript
import type { MastraModelHandoff } from '../shared/modelHandoff';
```

(Replace the existing `import { isMastraModelHandoff }` line with one importing both: `import { isMastraModelHandoff, type MastraModelHandoff } from '../shared/modelHandoff';`)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/mastraAgent.test.ts`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Full suite, typecheck, commit**

```bash
npm run typecheck
npm test
git add nodes/MastraAgent/MastraAgent.node.ts test/mastraAgent.test.ts
git commit -m "feat(agent): forward model-node settings to agent.stream modelSettings"
```

---

### Task 6: Docs + manual end-to-end verification

**Files:**
- Modify: `README.md` (Usage section)

**Interfaces:** none (docs + manual QA).

- [ ] **Step 1: Update README**

In `README.md`, replace the Usage step 2 (`Set **Model** to a Mastra model-router id...`) with:

```markdown
2. In the **Mastra Model** node, pick a model **From list** (fetched live from
   your endpoint's `GET /models`) or switch to **By ID** and type the model
   name exactly as the endpoint expects it (slashes kept). Optional:
   - **Options** — temperature, max output tokens, top-p, penalties,
     reasoning effort, stop sequences. When the endpoint advertises
     per-model capabilities (OpenRouter `supported_parameters`), unsupported
     options fail fast with a clear error.
   - **Custom Headers** — extra headers on every model request (expression
     values supported), e.g. an OpenRouter session id. `Authorization` is
     always taken from the credential.
```

- [ ] **Step 2: Build and manually verify against live n8n**

```bash
npm run build
npm run dev
```

Checklist (requires an OpenRouter credential):
1. Add a fresh Mastra Model node → it is v2; **From list** shows models with name/context/price descriptions; search filters.
2. Switch to **By ID**, type `openai/gpt-4o-mini`, run a Mastra Agent → works.
3. Add Options → Temperature 0.1 → agent answers deterministically; execution log unchanged.
4. Add Reasoning Effort on a non-reasoning model → node errors with "does not support: Reasoning Effort".
5. Add Custom Header `X-Session-Id` = expression → check OpenRouter dashboard groups requests by session.
6. Open a pre-existing workflow with a v1 Mastra Model node → still renders the plain string field and runs unchanged.
7. Point a credential at an endpoint without `/models` (e.g. a bare vLLM) → From list shows the "switch to By ID" error; By ID works; options skip validation.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document Mastra Model v2 (model picker, options, custom headers)"
```
