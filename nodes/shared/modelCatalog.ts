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