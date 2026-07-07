import { NodeOperationError, type ISupplyDataFunctions } from 'n8n-workflow';

/**
 * Resolve the Mastra `thread` id (n8n calls this the session id) for a memory
 * sub-node. Ported from n8n's own `getSessionId` (nodes-langchain/utils/helpers.ts)
 * — we can't import it (internal `@utils` alias), so we replicate the two supported
 * modes:
 *   - `fromInput`  → read `$json.sessionId` from the incoming item (chat-trigger shape)
 *   - `customKey`  → use a user-provided expression/value
 * Both throw a NodeOperationError when empty, matching stock behaviour so the
 * failure mode is identical to the native Postgres Chat Memory node.
 */
export function getThreadId(ctx: ISupplyDataFunctions, itemIndex: number): string {
	const selectorType = ctx.getNodeParameter('sessionIdType', itemIndex, 'fromInput') as string;

	let sessionId = '';

	if (selectorType === 'fromInput') {
		sessionId = ctx.evaluateExpression('{{ $json.sessionId }}', itemIndex) as string;

		if (!sessionId) {
			// Chat Trigger nodes expose sessionId via body data in webhook context.
			try {
				const chatTrigger = ctx.getChatTrigger();
				if (chatTrigger) {
					sessionId = ctx.evaluateExpression(
						`{{ $('${chatTrigger.name}').first().json.sessionId }}`,
						itemIndex,
					) as string;
				}
			} catch {
				// getChatTrigger not available in this context — fall through to the error below.
			}
		}

		if (!sessionId) {
			throw new NodeOperationError(ctx.getNode(), 'No session ID found', {
				description:
					"Expected a 'sessionId' field on the input (this is what the Chat Trigger node outputs). To use a different value, switch the 'Session ID' parameter to 'Define below'.",
				itemIndex,
			});
		}
	} else {
		sessionId = ctx.getNodeParameter('sessionKey', itemIndex, '') as string;
		if (!sessionId) {
			throw new NodeOperationError(ctx.getNode(), 'Session key is empty', {
				description:
					"Provide a value in the 'Key' parameter, or switch to 'Connected Chat Trigger Node' to inherit the session ID from a Chat Trigger.",
				itemIndex,
			});
		}
	}

	return sessionId;
}

/**
 * Resolve the Mastra `resource` id (n8n userId). Locked design, Finding 5:
 *   - non-empty          → use it
 *   - empty + require ON → throw (prevents a client-facing briefing agent from
 *                          silently sharing one memory bucket across users)
 *   - empty + require OFF → fall back to the thread id (per-session isolation,
 *                          NEVER a shared 'default' bucket)
 */
export function getResourceId(
	ctx: ISupplyDataFunctions,
	itemIndex: number,
	threadId: string,
): string {
	const resourceId = (ctx.getNodeParameter('resourceId', itemIndex, '') as string).trim();
	const requireResource = ctx.getNodeParameter('requireResourceId', itemIndex, true) as boolean;

	if (resourceId) return resourceId;

	if (requireResource) {
		throw new NodeOperationError(ctx.getNode(), 'Resource ID (user ID) is required but empty', {
			description:
				"This memory node has 'Require Resource ID' enabled. Provide a Resource ID (e.g. the end user's ID) so memory can't leak between users, or disable the option to fall back to per-session isolation.",
			itemIndex,
		});
	}

	// Fallback: scope memory to the thread itself. Distinct sessions stay isolated.
	return threadId;
}
