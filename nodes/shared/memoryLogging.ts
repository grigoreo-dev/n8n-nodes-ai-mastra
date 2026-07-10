type N8nLogPayload = Array<Array<{ json: Record<string, unknown> }>>;

export const AI_MEMORY_CONNECTION = 'ai_memory';

export interface MemoryLogInput {
	operation: 'recall' | 'saveMessages';
	messages?: unknown[];
	threadId?: string;
	resourceId?: string;
	usage?: { tokens?: number };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function textFromParts(parts: unknown): string {
	if (!Array.isArray(parts)) return '';
	return parts
		.map((part) => (isObject(part) && typeof part.text === 'string' ? part.text : ''))
		.join('');
}

function textFromContent(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!isObject(content)) return '';
	if (typeof content.content === 'string') return content.content;
	return textFromParts(content.parts);
}

function normalizeCreatedAt(value: unknown): string | undefined {
	if (value instanceof Date) {
		const timestamp = value.getTime();
		return Number.isFinite(timestamp) ? value.toISOString() : undefined;
	}
	if (typeof value === 'string') return value;
	if (typeof value === 'number') {
		const date = new Date(value);
		return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
	}
	return undefined;
}

function normalizeMessage(message: unknown): Record<string, unknown> {
	const msg = isObject(message) ? message : {};
	return {
		id: typeof msg.id === 'string' ? msg.id : undefined,
		role: typeof msg.role === 'string' ? msg.role : 'unknown',
		text: textFromContent(msg.content),
		createdAt: normalizeCreatedAt(msg.createdAt),
		threadId: typeof msg.threadId === 'string' ? msg.threadId : undefined,
		resourceId: typeof msg.resourceId === 'string' ? msg.resourceId : undefined,
	};
}

export function mapMemoryMessagesToN8n(input: MemoryLogInput): N8nLogPayload {
	const messages = Array.isArray(input.messages) ? input.messages : [];
	return [
		[
			{
				json: {
					operation: input.operation,
					threadId: input.threadId,
					resourceId: input.resourceId,
					messageCount: messages.length,
					tokenUsage:
						typeof input.usage?.tokens === 'number'
							? { totalTokens: input.usage.tokens }
							: undefined,
					messages: messages.map(normalizeMessage),
				},
			},
		],
	];
}

export interface MemoryLogContext {
	addInputData(connectionType: string, data: unknown): { index: number } | void;
	addOutputData(connectionType: string, index: number, data: unknown): void;
}

function safeAddInput(ctx: MemoryLogContext, data: unknown): number {
	try {
		const res = ctx.addInputData(AI_MEMORY_CONNECTION, data);
		return res && typeof res.index === 'number' ? res.index : 0;
	} catch {
		return 0;
	}
}

function safeAddOutput(ctx: MemoryLogContext, index: number, data: unknown): void {
	try {
		ctx.addOutputData(AI_MEMORY_CONNECTION, index, data);
	} catch {
		// logging is not on the critical path
	}
}

function firstMessageScope(messages: unknown[]): { threadId?: string; resourceId?: string } {
	const first = messages.find(isObject);
	return {
		threadId: first && typeof first.threadId === 'string' ? first.threadId : undefined,
		resourceId: first && typeof first.resourceId === 'string' ? first.resourceId : undefined,
	};
}

function safeMapPayload(build: () => N8nLogPayload, operation: MemoryLogInput['operation']): N8nLogPayload {
	try {
		return build();
	} catch {
		// Mapping must never break the store call: fall back to a minimal payload.
		return [[{ json: { operation } }]];
	}
}

// getStore('memory') is called multiple times per run; never wrap the same
// store object twice.
const wrappedMemoryStores = new WeakSet<object>();

function wrapMemoryStoreForLogging(store: Record<string, unknown>, ctx: MemoryLogContext): void {
	if (wrappedMemoryStores.has(store)) return;
	wrappedMemoryStores.add(store);

	// Monkey-patch on the instance (no Proxy): Mastra store classes may use
	// private class fields, and Proxy receivers break `#private` access.
	if (typeof store.listMessages === 'function') {
		const originalList = (store.listMessages as (args: Record<string, unknown>) => Promise<unknown>).bind(
			store,
		);
		store.listMessages = async (args: Record<string, unknown>) => {
			const threadId = typeof args?.threadId === 'string' ? args.threadId : undefined;
			const resourceId = typeof args?.resourceId === 'string' ? args.resourceId : undefined;
			const index = safeAddInput(
				ctx,
				safeMapPayload(
					() => mapMemoryMessagesToN8n({ operation: 'recall', threadId, resourceId, messages: [] }),
					'recall',
				),
			);
			try {
				const result = await originalList(args);
				const messages =
					isObject(result) && Array.isArray(result.messages) ? result.messages : [];
				safeAddOutput(
					ctx,
					index,
					safeMapPayload(
						() => mapMemoryMessagesToN8n({ operation: 'recall', threadId, resourceId, messages }),
						'recall',
					),
				);
				return result;
			} catch (error) {
				safeAddOutput(ctx, index, error);
				throw error;
			}
		};
	}

	if (typeof store.saveMessages === 'function') {
		const originalSave = (store.saveMessages as (args: { messages?: unknown[] }) => Promise<unknown>).bind(
			store,
		);
		store.saveMessages = async (args: { messages?: unknown[] }) => {
			const inputMessages = Array.isArray(args?.messages) ? args.messages : [];
			const scope = firstMessageScope(inputMessages);
			const index = safeAddInput(
				ctx,
				safeMapPayload(
					() =>
						mapMemoryMessagesToN8n({
							operation: 'saveMessages',
							threadId: scope.threadId,
							resourceId: scope.resourceId,
							messages: inputMessages,
						}),
					'saveMessages',
				),
			);
			try {
				const result = await originalSave(args);
				const resultMessages = Array.isArray(result)
					? result
					: isObject(result) && Array.isArray(result.messages)
						? result.messages
						: undefined;
				const outputMessages = resultMessages ?? inputMessages;
				const outputScope = firstMessageScope(outputMessages);
				safeAddOutput(
					ctx,
					index,
					safeMapPayload(
						() =>
							mapMemoryMessagesToN8n({
								operation: 'saveMessages',
								threadId: outputScope.threadId ?? scope.threadId,
								resourceId: outputScope.resourceId ?? scope.resourceId,
								messages: outputMessages,
							}),
						'saveMessages',
					),
				);
				return result;
			} catch (error) {
				safeAddOutput(ctx, index, error);
				throw error;
			}
		};
	}
}

/**
 * Intercept memory reads/writes at the storage store level.
 *
 * Mastra's agent chat path does NOT call `Memory.recall`/`Memory.saveMessages`:
 * the `MessageHistory` input processor calls `storage.getStore('memory')` and
 * then `store.listMessages(...)` / `store.saveMessages(...)` directly. The
 * store-domain object is the single choke point that also covers
 * `Memory.recall`/`Memory.saveMessages` side paths (title generation etc.).
 */
export function wrapMemoryStorageForLogging<T extends Record<string, unknown>>(
	storage: T,
	ctx: MemoryLogContext,
): T {
	const target = storage as Record<string, unknown>;
	if (typeof target.getStore !== 'function') return storage;
	const originalGetStore = (target.getStore as (name: string) => Promise<unknown>).bind(storage);

	target.getStore = async (name: string) => {
		const store = await originalGetStore(name);
		if (name === 'memory' && isObject(store)) {
			wrapMemoryStoreForLogging(store, ctx);
		}
		return store;
	};

	return storage;
}
