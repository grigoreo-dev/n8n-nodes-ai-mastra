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
			if (prop === 'doStream') {
				const original = target.doStream as (options: unknown) => Promise<Record<string, unknown>>;
				return async (options: { prompt?: unknown }) => {
					const index = safeAddInput(ctx, mapPromptToN8n(options ?? {}));
					const original_result = await original.call(target, options);
					const sourceStream = original_result.stream as ReadableStream;
					const reader = sourceStream.getReader();

					let text = '';
					let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
					let finishReason: unknown;
					let released = false;

					/** Release the source reader lock exactly once, on any terminal path. */
					const releaseReader = () => {
						if (released) return;
						released = true;
						try {
							reader.releaseLock();
						} catch {
							// lock already gone — nothing to release
						}
					};

					let logged = false;

					/**
					 * n8n pairs exactly one output with each input index, and the output
					 * is now reachable from three terminal paths (done, source error,
					 * consumer cancel) — log at most once.
					 */
					const logOutputOnce = (data: unknown) => {
						if (logged) return;
						logged = true;
						safeAddOutput(ctx, index, data);
					};

					const passthrough = new ReadableStream({
						// One source read per pull: the platform calls pull only when the
						// consumer needs data, which is what provides back-pressure.
						async pull(controller) {
							try {
								const { done, value } = await reader.read();
								if (done) {
									controller.close();
									logOutputOnce(mapResultToN8n({ text, finishReason, usage }));
									releaseReader();
									return;
								}
								const part = value as Record<string, unknown>;
								if (part?.type === 'text-delta' && typeof part.delta === 'string') {
									text += part.delta;
								} else if (part?.type === 'finish') {
									usage = part.usage as typeof usage;
									finishReason = part.finishReason;
								}
								controller.enqueue(value);
							} catch (error) {
								logOutputOnce(error);
								controller.error(error);
								releaseReader();
							}
						},
						// The consumer gave up (e.g. the agent aborted generation):
						// propagate cancellation upstream so the provider stops, and log
						// whatever was accumulated so the run still shows in the tree.
						async cancel(reason: unknown) {
							logOutputOnce(mapResultToN8n({ text, finishReason, usage }));
							try {
								await reader.cancel(reason);
							} finally {
								releaseReader();
							}
						},
					});

					return { ...original_result, stream: passthrough };
				};
			}
			// everything else passes through.
			return Reflect.get(target, prop, receiver);
		},
	});
}
