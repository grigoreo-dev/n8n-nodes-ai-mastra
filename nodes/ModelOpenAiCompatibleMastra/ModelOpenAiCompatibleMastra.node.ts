import {
	NodeConnectionTypes,
	NodeOperationError,
	type ILoadOptionsFunctions,
	type INodeListSearchResult,
	type ISupplyDataFunctions,
	type INodeType,
	type INodeTypeDescription,
	type SupplyData,
} from 'n8n-workflow';

import { resolveModelConfig } from '@mastra/core/llm';

import { getModelCatalog, type CatalogModel } from '../shared/modelCatalog';
import type { MastraModelHandoff } from '../shared/modelHandoff';
import { wrapModelForLogging, type ModelLogContext } from '../shared/modelLogging';

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

/**
 * Mastra Model sub-node (OpenAI-compatible).
 *
 * Outputs an `ai_languageModel` connection carrying a Mastra
 * `OpenAICompatibleConfig` (`{ id: '<provider>/<model>', apiKey, url }`). The
 * Mastra Agent node picks it up via `getInputConnectionData(ai_languageModel)`
 * and constructs `new Agent({ model: config })`.
 *
 * This exists because Mastra's model router resolves a bare model-id string
 * against `process.env.<PROVIDER>_API_KEY`. By handing the Agent a full config
 * object with an inline `apiKey` + `url`, the key can live in an n8n credential
 * instead of the process environment. Works with any OpenAI-compatible gateway
 * (OpenRouter by default, plus OpenAI, Groq, Together, local vLLM/LM Studio…).
 */
export class ModelOpenAiCompatibleMastra implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Mastra Model',
		name: 'mastraModel',
		icon: 'file:model.svg',
		group: ['transform'],
		version: [1, 2],
		defaultVersion: 2,
		description: 'An OpenAI-compatible chat model (OpenRouter, OpenAI, Groq, …) for a Mastra Agent',
		defaults: {
			name: 'Mastra Model',
		},
		credentials: [
			{
				name: 'mastraOpenAiCompatibleApi',
				required: true,
			},
		],
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Language Models'],
				'Language Models': ['Chat Models (Recommended)'],
			},
		},
		// Sub-node: no main input, single ai_languageModel output.
		inputs: [],
		outputs: [NodeConnectionTypes.AiLanguageModel],
		outputNames: ['Model'],
		properties: [
			{
				displayName:
					'Connect this to the <b>Model</b> input of a <b>Mastra Agent</b> node. The Base URL and API key come from the credential.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
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
		],
	};

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
			},
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
}
