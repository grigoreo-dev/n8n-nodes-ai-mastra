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

export const AI_LANGUAGE_MODEL_CONNECTION = 'ai_languageModel';

export interface ModelLogContext {
	addInputData(connectionType: string, data: unknown): { index: number } | void;
	addOutputData(connectionType: string, index: number, data: unknown): void;
}

/** Swallow logger failures — logging must never break the model call. */
function safeAddInput(ctx: ModelLogContext, data: unknown): number {
	try {
		const res = ctx.addInputData(AI_LANGUAGE_MODEL_CONNECTION, data);
		return res && typeof res.index === 'number' ? res.index : 0;
	} catch {
		return 0;
	}
}

function safeAddOutput(ctx: ModelLogContext, index: number, data: unknown): void {
	try {
		ctx.addOutputData(AI_LANGUAGE_MODEL_CONNECTION, index, data);
	} catch {
		// logging is not on the critical path
	}
}

/**
 * Wrap a LanguageModelV2 so each call records input/output onto the
 * ai_languageModel connection of the model sub-node, making it appear in the
 * n8n execution tree.
 *
 * We use a hand-written Proxy over doGenerate/doStream instead of the AI SDK's
 * official `wrapLanguageModel` + middleware. Rationale: the `ai` package is not
 * a dependency of this project (only @ai-sdk/provider types are present via
 * Mastra), and because we inline all deps into the bundle (noExternal), adding
 * `ai` would grow the bundle. If bundle size stops mattering, swap this Proxy
 * for `wrapLanguageModel` + a LanguageModelV2Middleware (wrapGenerate/wrapStream)
 * without changing callers.
 */
export function wrapModelForLogging<T extends Record<string, unknown>>(
	model: T,
	ctx: ModelLogContext,
): T {
	return new Proxy(model, {
		get(target, prop, receiver) {
			if (prop === 'doGenerate') {
				const original = target.doGenerate as (options: unknown) => Promise<unknown>;
				return async (options: { prompt?: unknown }) => {
					const index = safeAddInput(ctx, mapPromptToN8n(options ?? {}));
					try {
						const result = await original.call(target, options);
						safeAddOutput(ctx, index, mapResultToN8n(result as never));
						return result;
					} catch (error) {
						safeAddOutput(ctx, index, error);
						throw error;
					}
				};
			}
			// doStream handled in Task 3; everything else passes through.
			return Reflect.get(target, prop, receiver);
		},
	});
}
