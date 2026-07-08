import { describe, expect, it, vi } from 'vitest';

import { toMastraToolSet } from '../nodes/shared/toolBridge';

describe('toMastraToolSet', () => {
	it('adapts a single n8n tool with invoke()', async () => {
		const invoke = vi.fn().mockResolvedValue('tool result');
		const tools = toMastraToolSet({
			name: 'search',
			description: 'Search documents',
			schema: { type: 'object', properties: { query: { type: 'string' } } },
			invoke,
		});

		expect(Object.keys(tools)).toEqual(['search']);
		expect(tools.search.description).toBe('Search documents');
		expect(tools.search.parameters).toEqual({
			type: 'object',
			properties: { query: { type: 'string' } },
		});
		await expect(tools.search.execute({ query: 'n8n' })).resolves.toBe('tool result');
		expect(invoke).toHaveBeenCalledWith({ query: 'n8n' });
	});

	it('flattens toolkit shapes returned by MCP Client Tool', async () => {
		const weatherInvoke = vi.fn().mockResolvedValue('sunny');
		const toolkit = {
			tools: [
				{ name: 'weather', description: 'Get weather', schema: { type: 'object' }, invoke: weatherInvoke },
			],
		};

		const tools = toMastraToolSet(toolkit);

		expect(Object.keys(tools)).toEqual(['weather']);
		await expect(tools.weather.execute({ city: 'Berlin' })).resolves.toBe('sunny');
		expect(weatherInvoke).toHaveBeenCalledWith({ city: 'Berlin' });
	});

	it('deduplicates names by suffixing later tools', () => {
		const tools = toMastraToolSet([
			{ name: 'lookup', description: 'First', invoke: vi.fn() },
			{ name: 'lookup', description: 'Second', invoke: vi.fn() },
		]);

		expect(Object.keys(tools)).toEqual(['lookup', 'lookup_2']);
		expect(tools.lookup.description).toBe('First');
		expect(tools.lookup_2.description).toBe('Second');
	});
});
