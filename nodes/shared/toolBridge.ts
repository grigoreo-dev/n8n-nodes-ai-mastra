interface N8nToolLike {
	name?: string;
	description?: string;
	schema?: unknown;
	invoke?: (input: unknown) => Promise<unknown> | unknown;
	call?: (input: unknown) => Promise<unknown> | unknown;
	func?: (input: unknown) => Promise<unknown> | unknown;
}

interface N8nToolkitLike {
	tools?: unknown[];
	getTools?: () => unknown[];
}

export interface MastraToolBridgeEntry {
	description?: string;
	parameters?: unknown;
	execute: (input: unknown) => Promise<unknown>;
}

export type MastraToolSet = Record<string, MastraToolBridgeEntry>;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function asToolkit(value: unknown): N8nToolkitLike | undefined {
	if (!isObject(value)) return undefined;
	if (Array.isArray(value.tools)) return value as N8nToolkitLike;
	if (typeof value.getTools === 'function') return value as N8nToolkitLike;
	return undefined;
}

function asTool(value: unknown): N8nToolLike | undefined {
	if (!isObject(value)) return undefined;
	if (typeof value.name !== 'string' || !value.name.trim()) return undefined;
	if (
		typeof value.invoke !== 'function' &&
		typeof value.call !== 'function' &&
		typeof value.func !== 'function'
	) {
		return undefined;
	}
	return value as N8nToolLike;
}

function flattenTools(value: unknown): N8nToolLike[] {
	if (value === undefined || value === null) return [];
	if (Array.isArray(value)) return value.flatMap((entry) => flattenTools(entry));

	const toolkit = asToolkit(value);
	if (toolkit) {
		const tools = typeof toolkit.getTools === 'function' ? toolkit.getTools() : toolkit.tools;
		return flattenTools(tools ?? []);
	}

	const tool = asTool(value);
	return tool ? [tool] : [];
}

function uniqueName(baseName: string, usedNames: Set<string>): string {
	let name = baseName.replace(/[^A-Za-z0-9_-]/g, '_');
	if (!name) name = 'tool';
	if (!usedNames.has(name)) {
		usedNames.add(name);
		return name;
	}

	let suffix = 2;
	while (usedNames.has(`${name}_${suffix}`)) suffix++;
	const unique = `${name}_${suffix}`;
	usedNames.add(unique);
	return unique;
}

export function toMastraToolSet(toolConnections: unknown): MastraToolSet {
	const usedNames = new Set<string>();
	const toolSet: MastraToolSet = {};

	for (const tool of flattenTools(toolConnections)) {
		const sourceName = tool.name?.trim() || 'tool';
		const name = uniqueName(sourceName, usedNames);
		const execute = tool.invoke ?? tool.call ?? tool.func;

		if (!execute) continue;

		toolSet[name] = {
			description: tool.description,
			parameters: tool.schema,
			execute: async (input: unknown) => await execute.call(tool, input),
		};
	}

	return toolSet;
}
