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

	it('unwraps a spurious { value } wrapper before calling invoke()', async () => {
		// Mastra can hand the bridged execute() an argument object wrapped in a
		// single `value` key (observed with MCP Client tools whose schema has
		// multiple fields). The underlying n8n tool expects the flat arguments,
		// so the wrapper must be stripped or the tool receives undefined fields.
		const invoke = vi.fn().mockResolvedValue('ok');
		const tools = toMastraToolSet({
			name: 'resolve',
			description: 'Resolve a library id',
			schema: {
				type: 'object',
				properties: { query: { type: 'string' }, libraryName: { type: 'string' } },
			},
			invoke,
		});

		await tools.resolve.execute({ value: { query: 'server function', libraryName: 'TanStack' } });

		expect(invoke).toHaveBeenCalledWith({ query: 'server function', libraryName: 'TanStack' });
	});

	it('preserves a scalar single "value" argument declared by the schema', async () => {
		// A schema whose sole `value` field is a scalar is a real single-arg tool.
		// The wrapper is genuine data and must be passed through untouched.
		const invoke = vi.fn().mockResolvedValue('ok');
		const tools = toMastraToolSet({
			name: 'echo',
			description: 'Echo the value',
			schema: { type: 'object', properties: { value: { type: 'string' } } },
			invoke,
		});

		await tools.echo.execute({ value: 'literal' });

		expect(invoke).toHaveBeenCalledWith({ value: 'literal' });
	});

	it('unwraps the n8n MCP Client "value" object wrapper', async () => {
		// The stock n8n MCP Client tool wraps a tool's real object schema in a
		// synthetic { value: <realSchema> } when its internal zod instance does
		// not recognise the schema as a ZodObject. The model then produces
		// { value: { ...realArgs } }, but the MCP server expects the flat args.
		// Detect this by the schema's sole `value` property being an object and
		// unwrap so the MCP server receives the real arguments.
		const invoke = vi.fn().mockResolvedValue('ok');
		const tools = toMastraToolSet({
			name: 'resolve',
			description: 'Resolve a library id',
			schema: {
				type: 'object',
				properties: {
					value: {
						type: 'object',
						properties: { query: { type: 'string' }, libraryName: { type: 'string' } },
					},
				},
			},
			invoke,
		});

		await tools.resolve.execute({ value: { query: 'server function', libraryName: 'TanStack' } });

		expect(invoke).toHaveBeenCalledWith({ query: 'server function', libraryName: 'TanStack' });
	});

	it('prefers _call() over func()/invoke() to keep sub-node logging and skip schema validation', async () => {
		// n8n wraps connected tools in a logging Proxy that only intercepts
		// `_call`; calling it records the sub-node in the execution tree UI.
		// `_call` also skips langchain's schema validation, which is required for
		// MCP Client tools whose synthetic { value } wrapper schema rejects the
		// real flat args passed through invoke().
		const _call = vi.fn().mockResolvedValue('from _call');
		const func = vi.fn().mockResolvedValue('from func');
		const invoke = vi.fn().mockResolvedValue('from invoke');
		const tools = toMastraToolSet({
			name: 'mcp',
			description: 'MCP tool',
			schema: {
				type: 'object',
				properties: { value: { type: 'object', properties: { q: { type: 'string' } } } },
			},
			_call,
			func,
			invoke,
		});

		await expect(tools.mcp.execute({ value: { q: 'hi' } })).resolves.toBe('from _call');
		expect(_call).toHaveBeenCalledWith({ q: 'hi' });
		expect(func).not.toHaveBeenCalled();
		expect(invoke).not.toHaveBeenCalled();
	});

	it('falls back to func()/invoke() when no _call is present', async () => {
		const func = vi.fn().mockResolvedValue('from func');
		const invoke = vi.fn().mockResolvedValue('from invoke');
		const tools = toMastraToolSet({
			name: 'plain',
			description: 'Plain tool',
			schema: { type: 'object', properties: { q: { type: 'string' } } },
			func,
			invoke,
		});

		await expect(tools.plain.execute({ q: 'hi' })).resolves.toBe('from func');
		expect(func).toHaveBeenCalledWith({ q: 'hi' });
		expect(invoke).not.toHaveBeenCalled();
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
