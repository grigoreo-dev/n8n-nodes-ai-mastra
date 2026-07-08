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
		icon: 'file:mastra-agent.svg',
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
				const prompt = (this.getNodeParameter('prompt', itemIndex) as string)?.trim();
				const instructions = this.getNodeParameter('instructions', itemIndex, '') as string;
				const agentName = this.getNodeParameter('agentName', itemIndex, 'n8n Mastra Agent') as string;

				// Guard against an empty prompt before calling Mastra. Otherwise Mastra
				// sends `messages: []` to the model API, which fails deep in the SDK
				// with an opaque "at least one message is required" 400. Common cause:
				// a Chat Trigger whose Prompt field lost the `{{ $json.chatInput }}`
				// mapping.
				if (!prompt) {
					throw new NodeOperationError(this.getNode(), 'Prompt is empty', {
						description:
							'The Prompt field resolved to an empty string. When triggering from the Chat Trigger, set Prompt to an expression like {{ $json.chatInput }} so the incoming chat message is passed to the agent.',
						itemIndex,
					});
				}

				// Model comes strictly from a connected Mastra Model sub-node, which
				// supplies a full Mastra OpenAICompatibleConfig ({ id, url, apiKey }) so
				// the API key comes from an n8n credential instead of process.env. There
				// is no inline fallback: a model connection is required.
				const connectedModel = await this.getInputConnectionData(
					NodeConnectionTypes.AiLanguageModel,
					itemIndex,
				);

				if (connectedModel === undefined || connectedModel === null) {
					throw new NodeOperationError(this.getNode(), 'No model connected', {
						description:
							'Connect a Mastra Model sub-node to the Chat Model input. The Mastra Agent has no inline model fallback.',
						itemIndex,
					});
				}
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
				const model: ConstructorParameters<typeof AgentType>[0]['model'] = connectedModel.config;

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

				const agent = new Agent(agentConfig);

				const stream = await agent.stream(prompt, memoryScope ? { memory: memoryScope } : {});
				const text = await stream.text;

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
