// nodes/shared/modelSettings.ts
import type { CatalogModel } from './modelCatalog';

/**
 * Model call settings configured on the Mastra Model sub-node and delivered
 * to the Agent node via `MastraModelHandoff.settings`. The agent passes them
 * verbatim to `agent.stream(prompt, { modelSettings })` — they are CALL
 * options in Mastra's API, not constructor options, which is why they ride
 * the handoff instead of being baked into the model instance.
 *
 * Field names follow Mastra's `modelSettings` (AI SDK `CallSettings` +
 * `reasoning`).
 */
export interface MastraModelSettings {
	temperature?: number;
	topP?: number;
	maxOutputTokens?: number;
	frequencyPenalty?: number;
	presencePenalty?: number;
	stopSequences?: string[];
	reasoning?: 'minimal' | 'low' | 'medium' | 'high';
}

/** Raw value of the node's `options` collection parameter. */
export interface ModelNodeOptions {
	temperature?: number;
	maxOutputTokens?: number;
	topP?: number;
	frequencyPenalty?: number;
	presencePenalty?: number;
	reasoningEffort?: string;
	stopSequences?: string;
}

const REASONING_LEVELS = ['minimal', 'low', 'medium', 'high'] as const;

export function buildModelSettings(raw: ModelNodeOptions): MastraModelSettings | undefined {
	const settings: MastraModelSettings = {};

	if (typeof raw.temperature === 'number') settings.temperature = raw.temperature;
	if (typeof raw.maxOutputTokens === 'number') settings.maxOutputTokens = raw.maxOutputTokens;
	if (typeof raw.topP === 'number') settings.topP = raw.topP;
	if (typeof raw.frequencyPenalty === 'number') settings.frequencyPenalty = raw.frequencyPenalty;
	if (typeof raw.presencePenalty === 'number') settings.presencePenalty = raw.presencePenalty;

	if (typeof raw.stopSequences === 'string') {
		const sequences = raw.stopSequences
			.split(',')
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		if (sequences.length > 0) settings.stopSequences = sequences;
	}

	if (
		typeof raw.reasoningEffort === 'string' &&
		(REASONING_LEVELS as readonly string[]).includes(raw.reasoningEffort)
	) {
		settings.reasoning = raw.reasoningEffort as MastraModelSettings['reasoning'];
	}

	return Object.keys(settings).length > 0 ? settings : undefined;
}

/**
 * Which `supported_parameters` entry (OpenRouter naming) each of our
 * settings needs, plus the display name used in error messages.
 */
const PARAMETER_MAP: Array<{
	key: keyof MastraModelSettings;
	providerParam: string;
	displayName: string;
}> = [
	{ key: 'temperature', providerParam: 'temperature', displayName: 'Temperature' },
	{ key: 'topP', providerParam: 'top_p', displayName: 'Top P' },
	{ key: 'maxOutputTokens', providerParam: 'max_tokens', displayName: 'Max Output Tokens' },
	{ key: 'reasoning', providerParam: 'reasoning', displayName: 'Reasoning Effort' },
	{ key: 'frequencyPenalty', providerParam: 'frequency_penalty', displayName: 'Frequency Penalty' },
	{ key: 'presencePenalty', providerParam: 'presence_penalty', displayName: 'Presence Penalty' },
	{ key: 'stopSequences', providerParam: 'stop', displayName: 'Stop Sequences' },
];

/**
 * Soft validation: compare configured settings against the model's advertised
 * `supported_parameters`. Empty result when the catalog knows nothing about
 * the model or the field is absent (plain OpenAI/vLLM endpoints) — validation
 * must never block endpoints that don't advertise capabilities.
 */
export function findUnsupportedOptions(
	model: CatalogModel | undefined,
	settings: MastraModelSettings,
): string[] {
	const supported = model?.supportedParameters;
	if (!supported || supported.length === 0) return [];
	return PARAMETER_MAP.filter(
		({ key, providerParam }) => settings[key] !== undefined && !supported.includes(providerParam),
	).map(({ displayName }) => displayName);
}
