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
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'string') return value;
	if (typeof value === 'number') return new Date(value).toISOString();
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
