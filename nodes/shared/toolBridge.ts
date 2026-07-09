interface N8nToolLike {
	name?: string;
	description?: string;
	schema?: unknown;
	invoke?: (input: unknown) => Promise<unknown> | unknown;
	call?: (input: unknown) => Promise<unknown> | unknown;
	func?: (input: unknown) => Promise<unknown> | unknown;
	_call?: (input: unknown) => Promise<unknown> | unknown;
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

/**
 * Reads the declared top-level properties of a tool schema, supporting both
 * JSON Schema (`{ properties: {...} }`) and Zod object schemas (`.shape`).
 * Returns the property map, or undefined when the schema is not an object schema.
 */
function schemaProperties(schema: unknown): Record<string, unknown> | undefined {
	if (!isObject(schema)) return undefined;
	const jsonProps = (schema as { properties?: unknown }).properties;
	if (isObject(jsonProps)) return jsonProps as Record<string, unknown>;
	const zodShape = (schema as { shape?: unknown }).shape;
	if (isObject(zodShape)) return zodShape as Record<string, unknown>;
	return undefined;
}

/**
 * Detects whether a (sub)schema describes an object with named fields, in either
 * JSON Schema (`type: 'object'` / has `properties`) or Zod (`.shape`) form.
 */
function isObjectSchema(schema: unknown): boolean {
	if (!isObject(schema)) return false;
	if ((schema as { type?: unknown }).type === 'object') return true;
	if (isObject((schema as { properties?: unknown }).properties)) return true;
	if (isObject((schema as { shape?: unknown }).shape)) return true;
	return false;
}

/**
 * The stock n8n MCP Client tool wraps a tool's argument object in a synthetic
 * `{ value: <realSchema> }` whenever its internal zod instance fails to
 * recognise the incoming schema as a ZodObject (a cross-package zod identity
 * mismatch). The model then generates `{ value: { ...realArgs } }`, but the MCP
 * server expects the flat arguments — leaving every field undefined otherwise.
 *
 * Strip a single `value` wrapper from the runtime input when either:
 *   - the schema does not declare a `value` field at all, or
 *   - the schema's sole field is `value` and that field is itself an object
 *     schema (the synthetic MCP wrapper).
 *
 * A genuine single scalar `value` argument is preserved untouched.
 */
function unwrapValueWrapper(input: unknown, schema: unknown): unknown {
	if (!isObject(input) || Array.isArray(input)) return input;
	const keys = Object.keys(input);
	if (keys.length !== 1 || keys[0] !== 'value') return input;

	const props = schemaProperties(schema);
	const schemaKeys = props ? Object.keys(props) : [];

	if (!schemaKeys.includes('value')) {
		return (input as { value: unknown }).value;
	}
	if (schemaKeys.length === 1 && isObjectSchema(props?.value)) {
		return (input as { value: unknown }).value;
	}
	return input;
}

export function toMastraToolSet(toolConnections: unknown): MastraToolSet {
	const usedNames = new Set<string>();
	const toolSet: MastraToolSet = {};

	for (const tool of flattenTools(toolConnections)) {
		const sourceName = tool.name?.trim() || 'tool';
		const name = uniqueName(sourceName, usedNames);
		// Prefer the tool's `_call` over invoke/call/func. n8n wraps connected
		// tools in a logging Proxy (@n8n/ai-utilities logWrapper) that only
		// intercepts `_call` — calling it is what records the sub-node's
		// input/output in the execution tree UI and emits the ai-tool-called
		// event. `_call` also runs the raw executor without langchain's schema
		// validation, which is required because MCP Client tools ship a synthetic
		// `{ value: <realSchema> }` wrapper schema (a cross-package zod identity
		// mismatch inside n8n) that would otherwise reject the real flat args.
		const execute = tool._call ?? tool.func ?? tool.invoke ?? tool.call;
		const schema = tool.schema;

		if (!execute) continue;

		toolSet[name] = {
			description: tool.description,
			parameters: schema,
			execute: async (input: unknown) => {
				const args = unwrapValueWrapper(input, schema);
				return await execute.call(tool, args);
			},
		};
	}

	return toolSet;
}
