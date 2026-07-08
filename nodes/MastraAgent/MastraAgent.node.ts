import {
	NodeConnectionTypes,
	NodeOperationError,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';
import type { Agent as AgentType } from '@mastra/core/agent';

import { isMastraMemoryHandoff } from '../shared/memoryHandoff';
import { isMastraModelHandoff } from '../shared/modelHandoff';
import { toMastraToolSet } from '../shared/toolBridge';

/**
 * Mastra Agent root node.
 *
 * Runs a prompt through a `@mastra/core` Agent. Optionally accepts a Mastra
 * memory sub-node on the `ai_memory` input: when connected, memory lives INSIDE
 * the agent (`new Agent({ memory })`) and scope is passed at call time
 * (`stream(prompt, { memory: { thread, resource } })`) — the thread/resource ids
 * are resolved by the memory sub-node and travel on the handoff object.
 */
export class MastraAgent implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Mastra Agent',
		name: 'mastraAgent',
		icon: 'file:mastra.svg',
		group: ['transform'],
		version: [1],
		description: 'Run an AI agent on the Mastra framework',
		defaults: {
			name: 'Mastra Agent',
		},
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Agents'],
			},
		},
		inputs: `={{
			[
				'${NodeConnectionTypes.Main}',
				{
					type: '${NodeConnectionTypes.AiLanguageModel}',
					displayName: 'Chat Model',
					required: true,
					maxConnections: 1,
				},
				{
					type: '${NodeConnectionTypes.AiMemory}',
					displayName: 'Memory',
					required: false,
					maxConnections: 1,
				},
				{
					type: '${NodeConnectionTypes.AiTool}',
					displayName: 'Tool',
					required: false,
				},
			]
		}}`,
		outputs: [NodeConnectionTypes.Main],
		credentials: [],
		properties: [
			{
				displayName: 'Model (Fallback)',
				name: 'model',
				type: 'string',
				default: '',
				required: false,
				placeholder: 'openai/gpt-4o-mini',
				description:
					"Leave empty when a Mastra Model sub-node is connected (recommended). Used ONLY as a fallback when nothing is connected: a Mastra model router ID in '<provider>/<model>' form, resolved against a provider API key in the environment (e.g. OPENAI_API_KEY).",
			},
			{
				displayName: 'Prompt',
				name: 'prompt',
				type: 'string',
				default: '={{ $json.chatInput }}',
				required: true,
				typeOptions: {
					rows: 3,
				},
				description: 'The user message to send to the agent',
			},
			{
				displayName: 'Instructions (System Prompt)',
				name: 'instructions',
				type: 'string',
				default: 'You are a helpful assistant.',
				typeOptions: {
					rows: 3,
				},
				description: "The agent's system instructions",
			},
			{
				displayName: 'Agent Name',
				name: 'agentName',
				type: 'string',
				default: 'n8n Mastra Agent',
				description: 'A label for the agent (used by Mastra for tracing)',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		// Lazy-load Mastra once per execution: importing @mastra/core at module
		// scope breaks n8n's synchronous require()-in-VM node-class loading because
		// Mastra pulls ESM-only transitive deps. The native dynamic import()
		// resolves that ESM graph here at execution time instead.
		const { Agent } = await import('@mastra/core/agent');

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const modelParam = this.getNodeParameter('model', itemIndex) as string;
				const prompt = this.getNodeParameter('prompt', itemIndex) as string;
				const instructions = this.getNodeParameter('instructions', itemIndex, '') as string;
				const agentName = this.getNodeParameter('agentName', itemIndex, 'n8n Mastra Agent') as string;

				// Optional Model sub-node. When connected, it supplies a full Mastra
				// OpenAICompatibleConfig ({ id, url, apiKey }) so the API key comes from
				// an n8n credential instead of process.env. Otherwise fall back to the
				// bare model-id string param (which Mastra resolves against the env).
				const connectedModel = await this.getInputConnectionData(
					NodeConnectionTypes.AiLanguageModel,
					itemIndex,
				);

				let model: ConstructorParameters<typeof AgentType>[0]['model'];
				if (connectedModel !== undefined && connectedModel !== null) {
					if (!isMastraModelHandoff(connectedModel)) {
						throw new NodeOperationError(
							this.getNode(),
							'Connected model is not a Mastra model node',
							{
								description:
									'The Mastra Agent only works with Mastra model sub-nodes (e.g. Mastra Model). Stock LangChain chat-model nodes are not compatible.',
								itemIndex,
							},
						);
					}
					model = connectedModel.config;
				} else {
					const fallback = modelParam?.trim();
					if (!fallback) {
						throw new NodeOperationError(
							this.getNode(),
							'No model available',
							{
								description:
									'Connect a Mastra Model sub-node to the Model input (recommended), or set the Model (Fallback) field to a Mastra model router ID like "openai/gpt-4o-mini".',
								itemIndex,
							},
						);
					}
					if (!fallback.includes('/')) {
						throw new NodeOperationError(
							this.getNode(),
							`Fallback model must be in '<provider>/<model>' form (got '${fallback}')`,
							{ itemIndex },
						);
					}
					model = fallback as `${string}/${string}`;
				}

				// Optional memory sub-node. getInputConnectionData returns the memory
				// node's `response` object verbatim (or undefined if nothing connected).
				const connected = await this.getInputConnectionData(
					NodeConnectionTypes.AiMemory,
					itemIndex,
				);

				let memoryScope: { thread: string; resource: string } | undefined;
				const agentConfig: ConstructorParameters<typeof AgentType>[0] = {
					id: 'n8n-mastra-agent',
					name: agentName,
					instructions,
					model,
				};

				if (connected !== undefined && connected !== null) {
					if (!isMastraMemoryHandoff(connected)) {
						throw new NodeOperationError(
							this.getNode(),
							'Connected memory is not a Mastra memory node',
							{
								description:
									'The Mastra Agent only works with Mastra memory sub-nodes (e.g. Postgres Memory (Mastra)). Stock LangChain memory nodes are not compatible.',
								itemIndex,
							},
						);
					}
					agentConfig.memory = connected.memory;
					memoryScope = { thread: connected.thread, resource: connected.resource };
				}

				const connectedTools = await this.getInputConnectionData(
					NodeConnectionTypes.AiTool,
					itemIndex,
				);
				const tools = toMastraToolSet(connectedTools);
				if (Object.keys(tools).length > 0) {
					(agentConfig as typeof agentConfig & { tools: typeof tools }).tools = tools;
				}

				const modelLabel =
					typeof model === 'string'
						? model
						: (model as { modelId?: string; id?: string }).modelId ??
							(model as { id?: string }).id ??
							'connected-model';

				const { index: aiLogIndex } = this.addInputData(NodeConnectionTypes.AiAgent, [
					[{ json: { prompt, instructions, model: modelLabel } }],
				]);

				const agent = new Agent(agentConfig);

				const stream = await agent.stream(prompt, memoryScope ? { memory: memoryScope } : {});
				const text = await stream.text;
				const tokenUsage =
					'usage' in stream && stream.usage instanceof Promise ? await stream.usage : undefined;

				this.addOutputData(NodeConnectionTypes.AiAgent, aiLogIndex, [
					[{ json: { response: text, model: modelLabel, ...(tokenUsage ? { tokenUsage } : {}) } }],
				]);

				returnData.push({
					json: {
						output: text,
						model: modelLabel,
						...(memoryScope
							? { thread: memoryScope.thread, resource: memoryScope.resource }
							: {}),
					},
					pairedItem: { item: itemIndex },
				});
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}
