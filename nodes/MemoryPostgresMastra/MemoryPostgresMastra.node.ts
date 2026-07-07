import {
	NodeConnectionTypes,
	NodeOperationError,
	type ISupplyDataFunctions,
	type INodeType,
	type INodeTypeDescription,
	type SupplyData,
} from 'n8n-workflow';

import { DEFAULT_MAX_CONNECTIONS, pgPoolManager } from '../shared/poolManager';
import type { PostgresCredential } from '../shared/pgCredentials';
import type { MastraMemoryHandoff } from '../shared/memoryHandoff';
import { getResourceId, getThreadId } from '../shared/session';

/**
 * Postgres-backed Mastra memory sub-node.
 *
 * Outputs an `ai_memory` connection carrying a LIVE `@mastra/memory` `Memory`
 * instance (backed by `@mastra/pg` `PostgresStore`). The Mastra Agent node picks
 * it up via `getInputConnectionData(ai_memory)` and constructs
 * `new Agent({ memory })`. Unlike LangChain memory (which lives beside the chain),
 * Mastra memory lives INSIDE the agent, and scope (thread/resource) is passed at
 * call time — so this node's job is: build the store + memory and resolve the
 * thread/resource ids for the current item.
 */
export class MemoryPostgresMastra implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Postgres Memory (Mastra)',
		name: 'memoryPostgresMastra',
		icon: 'file:postgres.svg',
		group: ['transform'],
		version: [1],
		description: 'Stores agent memory in Postgres using the Mastra framework',
		defaults: {
			name: 'Postgres Memory (Mastra)',
		},
		credentials: [
			{
				name: 'postgres',
				required: true,
			},
		],
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Memory'],
			},
		},
		// Sub-node: no main input, single ai_memory output.
		inputs: [],
		outputs: [NodeConnectionTypes.AiMemory],
		outputNames: ['Memory'],
		properties: [
			{
				displayName:
					'Connect this to the <b>Memory</b> input of a <b>Mastra Agent</b> node. Memory is stored in Postgres and scoped by session (thread) and resource (user).',
				name: 'notice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Session ID',
				name: 'sessionIdType',
				type: 'options',
				options: [
					{
						name: 'Connected Chat Trigger Node',
						value: 'fromInput',
						description: "Use the session ID from the input's 'sessionId' field",
					},
					{
						name: 'Define Below',
						value: 'customKey',
						description: 'Provide the session ID as a value or expression',
					},
				],
				default: 'fromInput',
				description: 'The session ID becomes the Mastra thread. Distinct sessions have separate history.',
			},
			{
				displayName: 'Key',
				name: 'sessionKey',
				type: 'string',
				default: '',
				description: 'The key (thread ID) to use to store the memory',
				displayOptions: {
					show: {
						sessionIdType: ['customKey'],
					},
				},
			},
			{
				displayName: 'Resource ID (User ID)',
				name: 'resourceId',
				type: 'string',
				default: '',
				description:
					'The Mastra resource (typically an end-user ID). Memory is isolated per resource. Leave empty only if every session is a distinct user.',
			},
			{
				displayName: 'Require Resource ID',
				name: 'requireResourceId',
				type: 'boolean',
				default: true,
				description:
					'Whether to error when Resource ID is empty. Keep on for client-facing agents so memory can never leak between users. When off, an empty Resource ID falls back to per-session isolation (never a shared bucket).',
			},
			{
				displayName: 'Schema Name',
				name: 'schemaName',
				type: 'string',
				default: 'public',
				description: 'The Postgres schema Mastra creates its memory tables in',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Last Messages',
						name: 'lastMessages',
						type: 'number',
						default: 10,
						description:
							'How many recent messages to include as conversation history on each request',
						typeOptions: {
							minValue: 1,
						},
					},
					{
						displayName: 'Max Pool Connections',
						name: 'maxConnections',
						type: 'number',
						default: DEFAULT_MAX_CONNECTIONS,
						description:
							'Maximum size of the shared Postgres connection pool for this target. Keep low on shared databases.',
						typeOptions: {
							minValue: 1,
						},
					},
				],
			},
		],
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const credentials = (await this.getCredentials('postgres')) as unknown as PostgresCredential;

		if (credentials.sshTunnel) {
			throw new NodeOperationError(
				this.getNode(),
				'SSH tunnel Postgres credentials are not supported by this memory node',
				{
					description:
						'Use a directly reachable Postgres credential (no SSH tunnel). Mastra manages its own connection pool, which is incompatible with the per-execution SSH proxy.',
					itemIndex,
				},
			);
		}

		const schemaName = (this.getNodeParameter('schemaName', itemIndex, 'public') as string) || 'public';
		const options = this.getNodeParameter('options', itemIndex, {}) as {
			lastMessages?: number;
			maxConnections?: number;
		};
		const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;

		const threadId = getThreadId(this, itemIndex);
		const resourceId = getResourceId(this, itemIndex, threadId);

		const { pool, release } = pgPoolManager.acquire(credentials, schemaName, maxConnections);

		// Lazy-load Mastra: it (transitively) pulls ESM-only packages that break
		// when n8n loads the node class via synchronous require() in a VM. Loading
		// them here — inside supplyData — keeps class loading synchronous and lets
		// the native dynamic import() resolve the ESM graph at execution time.
		const { PostgresStore } = await import('@mastra/pg');
		const { Memory } = await import('@mastra/memory');

		const storage = new PostgresStore({
			id: `n8n-mastra-${schemaName}`,
			pool,
			schemaName,
		});

		const memory = new Memory({
			storage,
			options: {
				lastMessages: options.lastMessages ?? 10,
			},
		});

		// n8n's getInputConnectionData returns this `response` object verbatim and
		// drops SupplyData.metadata, so thread/resource must ride ON the response.
		const handoff: MastraMemoryHandoff = {
			__isMastraMemory: true,
			memory,
			thread: threadId,
			resource: resourceId,
		};

		return {
			response: handoff,
			// n8n calls this when the execution finishes: drop our pool ref so the
			// idle sweeper can evict the pool if nobody else is using it.
			closeFunction: async () => {
				release();
			},
		};
	}
}
