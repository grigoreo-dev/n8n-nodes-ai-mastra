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
		inputs: [
			{ type: NodeConnectionTypes.Main },
			{
				type: NodeConnectionTypes.AiMemory,
				displayName: 'Memory',
				required: false,
				maxConnections: 1,
			},
		],
		outputs: [NodeConnectionTypes.Main],
		credentials: [],
		properties: [
			{
				displayName: 'Model',
				name: 'model',
				type: 'string',
				default: 'openai/gpt-4o-mini',
				required: true,
				placeholder: 'openai/gpt-4o-mini',
				description:
					"Mastra model router ID in '<provider>/<model>' form, e.g. 'openai/gpt-4o-mini' or 'anthropic/claude-3-5-sonnet-latest'. Requires the matching provider API key in the environment.",
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
				const model = this.getNodeParameter('model', itemIndex) as string;
				const prompt = this.getNodeParameter('prompt', itemIndex) as string;
				const instructions = this.getNodeParameter('instructions', itemIndex, '') as string;
				const agentName = this.getNodeParameter('agentName', itemIndex, 'n8n Mastra Agent') as string;

				if (!model.includes('/')) {
					throw new NodeOperationError(
						this.getNode(),
						`Model must be in '<provider>/<model>' form (got '${model}')`,
						{ itemIndex },
					);
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
					model: model as `${string}/${string}`,
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

				const agent = new Agent(agentConfig);

				const stream = await agent.stream(prompt, memoryScope ? { memory: memoryScope } : {});
				const text = await stream.text;

				returnData.push({
					json: {
						output: text,
						model,
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
