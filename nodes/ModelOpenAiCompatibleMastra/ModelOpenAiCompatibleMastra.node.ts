import {
	NodeConnectionTypes,
	NodeOperationError,
	type ISupplyDataFunctions,
	type INodeType,
	type INodeTypeDescription,
	type SupplyData,
} from 'n8n-workflow';

import type { MastraModelHandoff } from '../shared/modelHandoff';

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
		icon: 'file:mastra.svg',
		group: ['transform'],
		version: [1],
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
				displayName: 'Model',
				name: 'model',
				type: 'string',
				default: 'openai/gpt-4o-mini',
				required: true,
				placeholder: 'openai/gpt-4o-mini',
				description:
					"The model name EXACTLY as your endpoint expects it — it is sent verbatim to {baseUrl}/chat/completions. Any slashes are kept (e.g. 'openai/gpt-4o-mini', 'antigravity/gemini-3.5-flash-medium', 'auto/fast').",
			},
		],
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const credentials = (await this.getCredentials('mastraOpenAiCompatibleApi')) as {
			baseUrl?: string;
			apiKey?: string;
		};

		const model = (this.getNodeParameter('model', itemIndex) as string)?.trim();
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
		const handoff: MastraModelHandoff = {
			__isMastraModel: true,
			config: {
				providerId: 'openai-compatible',
				modelId: model,
				url,
				apiKey,
			},
		};

		return {
			response: handoff,
		};
	}
}
