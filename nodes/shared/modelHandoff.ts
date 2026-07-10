import type { OpenAICompatibleConfig } from '@mastra/core/llm';

/**
 * The object a Mastra model sub-node returns as its `ai_languageModel`
 * `response`.
 *
 * Mastra's Agent resolves a bare model-id string (e.g. `'openai/gpt-4o-mini'`)
 * against `process.env` for the API key — which throws
 * "Could not find API key process.env.OPENAI_API_KEY" when the key lives in an
 * n8n credential instead. To bypass that, this sub-node hands the Agent a full
 * `OpenAICompatibleConfig` object (`{ id, apiKey, url }`) so Mastra uses the
 * inline key + base URL directly:
 *
 *   new Agent({ model: { id: 'openai/gpt-4o-mini', apiKey, url } })
 *
 * Like `MastraMemoryHandoff`, this rides on the sub-node's `response` because
 * n8n's `getInputConnectionData(ai_languageModel)` returns that object verbatim
 * and drops `SupplyData.metadata`. The `__isMastraModel` brand lets the Agent
 * node fail with a clear message if an incompatible (e.g. stock LangChain)
 * model node is connected by mistake.
 */
export interface MastraModelHandoff {
	__isMastraModel: true;
	config: OpenAICompatibleConfig;
	/**
	 * The resolved LanguageModelV2, wrapped for execution-tree logging
	 * (see nodes/shared/modelLogging.ts). The Agent passes this straight to
	 * `new Agent({ model })`. `config` is retained for diagnostics.
	 */
	model: unknown;
}

export function isMastraModelHandoff(value: unknown): value is MastraModelHandoff {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value as { __isMastraModel?: unknown }).__isMastraModel === true
	);
}
