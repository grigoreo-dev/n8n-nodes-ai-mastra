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
		return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
	}
	if (typeof value === 'string') return value;
	if (typeof value === 'number') {
		return Number.isFinite(value) ? new Date(value).toISOString() : undefined;
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

export function wrapMemoryForLogging<T extends Record<string, unknown>>(
	memory: T,
	ctx: MemoryLogContext,
): T {
	return new Proxy(memory, {
		get(target, prop, receiver) {
			if (prop === 'recall') {
				const original = target.recall as (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
				return async (args: Record<string, unknown>) => {
					const index = safeAddInput(
						ctx,
						mapMemoryMessagesToN8n({
							operation: 'recall',
							threadId: typeof args?.threadId === 'string' ? args.threadId : undefined,
							resourceId: typeof args?.resourceId === 'string' ? args.resourceId : undefined,
							messages: [],
						}),
					);
					try {
						const result = await original.call(target, args);
						safeAddOutput(
							ctx,
							index,
							mapMemoryMessagesToN8n({
								operation: 'recall',
								threadId: typeof args?.threadId === 'string' ? args.threadId : undefined,
								resourceId: typeof args?.resourceId === 'string' ? args.resourceId : undefined,
								messages: Array.isArray(result.messages) ? result.messages : [],
								usage: isObject(result.usage) ? (result.usage as { tokens?: number }) : undefined,
							}),
						);
						return result;
					} catch (error) {
						safeAddOutput(ctx, index, error);
						throw error;
					}
				};
			}

			if (prop === 'saveMessages') {
				const original = target.saveMessages as (args: { messages?: unknown[] }) => Promise<Record<string, unknown>>;
				return async (args: { messages?: unknown[] }) => {
					const inputMessages = Array.isArray(args?.messages) ? args.messages : [];
					const inputScope = firstMessageScope(inputMessages);
					const index = safeAddInput(
						ctx,
						mapMemoryMessagesToN8n({
							operation: 'saveMessages',
							threadId: inputScope.threadId,
							resourceId: inputScope.resourceId,
							messages: inputMessages,
						}),
					);
					try {
						const result = await original.call(target, args);
						const outputMessages = Array.isArray(result.messages) ? result.messages : [];
						const outputScope = firstMessageScope(outputMessages);
						safeAddOutput(
							ctx,
							index,
							mapMemoryMessagesToN8n({
								operation: 'saveMessages',
								threadId: outputScope.threadId ?? inputScope.threadId,
								resourceId: outputScope.resourceId ?? inputScope.resourceId,
								messages: outputMessages,
								usage: isObject(result.usage) ? (result.usage as { tokens?: number }) : undefined,
							}),
						);
						return result;
					} catch (error) {
						safeAddOutput(ctx, index, error);
						throw error;
					}
				};
			}

			return Reflect.get(target, prop, receiver);
		},
	});
}
