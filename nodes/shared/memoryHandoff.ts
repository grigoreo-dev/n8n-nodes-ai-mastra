import type { Memory } from '@mastra/memory';

/**
 * The object a Mastra memory sub-node returns as its `ai_memory` `response`.
 *
 * n8n's `getInputConnectionData(ai_memory)` returns the sub-node's `response`
 * object verbatim and DROPS the `SupplyData.metadata` — so, unlike LangChain
 * (where the memory instance already carries its session id internally), the
 * Mastra thread/resource scope must travel ON this object. The Agent node reads
 * `memory`, `thread`, and `resource` off it and calls:
 *
 *   new Agent({ memory })
 *   agent.stream(prompt, { memory: { thread, resource } })
 *
 * The `__isMastraMemory` brand lets the Agent node fail with a clear message if
 * a non-Mastra (e.g. stock LangChain) memory node is connected by mistake.
 */
export interface MastraMemoryHandoff {
	__isMastraMemory: true;
	memory: Memory;
	thread: string;
	resource: string;
}

export function isMastraMemoryHandoff(value: unknown): value is MastraMemoryHandoff {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value as { __isMastraMemory?: unknown }).__isMastraMemory === true
	);
}
