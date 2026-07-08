import type {
	ICredentialType,
	INodeProperties,
	ICredentialTestRequest,
} from 'n8n-workflow';

/**
 * Credential for any OpenAI-compatible chat completions endpoint (OpenRouter,
 * OpenAI, Together, Groq, local vLLM/LM Studio, ...). The Mastra Model sub-node
 * reads `apiKey` + `baseUrl` off this and hands them to the Agent as an inline
 * `OpenAICompatibleConfig`, so no `process.env.*_API_KEY` is ever needed.
 *
 * Default base URL points at OpenRouter; change it for any other gateway.
 */
export class MastraOpenAiCompatibleApi implements ICredentialType {
	name = 'mastraOpenAiCompatibleApi';

	displayName = 'Mastra OpenAI-Compatible API';

	documentationUrl = 'https://openrouter.ai/docs';

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://openrouter.ai/api/v1',
			required: true,
			placeholder: 'https://openrouter.ai/api/v1',
			description:
				'The OpenAI-compatible API base URL (must include the version path, e.g. /v1). Examples: https://openrouter.ai/api/v1, https://api.openai.com/v1, http://localhost:11434/v1 (Ollama).',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'The API key / bearer token for the endpoint',
		},
	];

	/**
	 * Lightweight connectivity check: GET {baseUrl}/models with a Bearer token.
	 * Works for OpenRouter, OpenAI, and most compatible gateways.
	 */
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/models',
			method: 'GET',
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};
}
