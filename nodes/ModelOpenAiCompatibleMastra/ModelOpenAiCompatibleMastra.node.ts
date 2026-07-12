import {
	NodeConnectionTypes,
	NodeOperationError,
	type ILoadOptionsFunctions,
	type INodeListSearchResult,
	type INodePropertyOptions,
	type ISupplyDataFunctions,
	type INodeType,
	type INodeTypeDescription,
	type SupplyData,
} from 'n8n-workflow';

import { resolveModelConfig } from '@mastra/core/llm';

import { findModel, getModelCatalog, type CatalogModel } from '../shared/modelCatalog';
import type { MastraModelHandoff } from '../shared/modelHandoff';
import { wrapModelForLogging, type ModelLogContext } from '../shared/modelLogging';
import {
	buildModelSettings,
	findUnsupportedOptions,
	type ModelNodeOptions,
} from '../shared/modelSettings';

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
		// Never use prototype-polluting names as computed object keys (security guidance).
		if (['__proto__', 'constructor', 'prototype'].includes(name.toLowerCase())) continue;
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
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
							},
						],
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
}
