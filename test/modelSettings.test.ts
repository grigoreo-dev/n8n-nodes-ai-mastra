// test/modelSettings.test.ts
import { describe, expect, it } from 'vitest';

import type { CatalogModel } from '../nodes/shared/modelCatalog';
import {
	buildModelSettings,
	findUnsupportedOptions,
} from '../nodes/shared/modelSettings';

describe('buildModelSettings', () => {
	it('returns undefined for an empty options object', () => {
		expect(buildModelSettings({})).toBeUndefined();
	});

	it('maps plain numeric options one-to-one', () => {
		expect(
			buildModelSettings({
				temperature: 0.7,
				maxOutputTokens: 1024,
				topP: 0.9,
				frequencyPenalty: 0.5,
				presencePenalty: -0.5,
			}),
		).toEqual({
			temperature: 0.7,
			maxOutputTokens: 1024,
			topP: 0.9,
			frequencyPenalty: 0.5,
			presencePenalty: -0.5,
		});
	});

	it('splits comma-separated stop sequences and trims whitespace', () => {
		expect(buildModelSettings({ stopSequences: 'END, STOP ,\nDONE' })).toEqual({
			stopSequences: ['END', 'STOP', 'DONE'],
		});
	});

	it('ignores an empty stop-sequences string', () => {
		expect(buildModelSettings({ stopSequences: '  ' })).toBeUndefined();
	});

	it('maps reasoningEffort to reasoning', () => {
		expect(buildModelSettings({ reasoningEffort: 'high' })).toEqual({
			reasoning: 'high',
		});
	});

	it('ignores zero-as-unset numbers only when the field is absent, keeps explicit 0', () => {
		expect(buildModelSettings({ temperature: 0 })).toEqual({ temperature: 0 });
	});
});

describe('findUnsupportedOptions', () => {
	const model: CatalogModel = {
		id: 'openai/gpt-4o-mini',
		supportedParameters: ['temperature', 'top_p', 'max_tokens', 'stop'],
	};

	it('returns [] when everything is supported', () => {
		expect(
			findUnsupportedOptions(model, { temperature: 1, topP: 0.5, maxOutputTokens: 10 }),
		).toEqual([]);
	});

	it('reports unsupported options by display name', () => {
		expect(
			findUnsupportedOptions(model, { reasoning: 'low', frequencyPenalty: 1 }),
		).toEqual(['Reasoning Effort', 'Frequency Penalty']);
	});

	it('returns [] when the model is unknown', () => {
		expect(findUnsupportedOptions(undefined, { reasoning: 'low' })).toEqual([]);
	});

	it('returns [] when the model advertises no supported_parameters', () => {
		expect(findUnsupportedOptions({ id: 'x' }, { reasoning: 'low' })).toEqual([]);
	});
});
