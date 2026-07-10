type N8nLogPayload = Array<Array<{ json: Record<string, unknown> }>>;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/** Join the `.text` of every text-like content part in a message. */
function partsToText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.map((part) =>
			isObject(part) && typeof (part as { text?: unknown }).text === 'string'
				? (part as { text: string }).text
				: '',
		)
		.join('');
}

/** Map a LanguageModelV2 call's prompt to the n8n addInputData payload shape. */
export function mapPromptToN8n(options: { prompt?: unknown }): N8nLogPayload {
	const prompt = Array.isArray(options?.prompt) ? options.prompt : [];
	const messages = prompt.map((message) => {
		const role = isObject(message) ? (message as { role?: unknown }).role : undefined;
		return {
			role: typeof role === 'string' ? role : 'unknown',
			text: partsToText(isObject(message) ? (message as { content?: unknown }).content : ''),
		};
	});
	return [[{ json: { messages } }]];
}

/** Map a LanguageModelV2 generate/stream result to the n8n addOutputData payload shape. */
export function mapResultToN8n(result: {
	content?: unknown;
	text?: string;
	finishReason?: unknown;
	usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}): N8nLogPayload {
	const text =
		typeof result.text === 'string' && result.text.length > 0
			? result.text
			: partsToText(result.content);
	const usage = result.usage ?? {};
	return [
		[
			{
				json: {
					response: { text, finishReason: result.finishReason },
					tokenUsage: {
						promptTokens: usage.inputTokens,
						completionTokens: usage.outputTokens,
						totalTokens: usage.totalTokens,
					},
				},
			},
		],
	];
}
