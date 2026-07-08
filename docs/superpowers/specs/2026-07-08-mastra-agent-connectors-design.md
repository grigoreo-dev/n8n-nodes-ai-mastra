# Mastra Agent Connector Design

## Goal

Bring the Mastra Agent node closer to the standard n8n AI Agent interface while keeping the runtime Mastra-native.

The first implementation provides the standard connector shape and enough logging/tool compatibility to make the node useful with existing n8n AI workflows.

## Scope

In scope:

- Match the standard n8n AI Agent connector layout: main input, chat model, memory, and tools.
- Keep model and memory Mastra-native.
- Support existing n8n `ai_tool` nodes through a compatibility bridge.
- Preserve compatibility with MCP Client Tool through the same tool bridge.
- Add first-step agent-level execution logs, including prompt, response, model label, and token usage when Mastra exposes it.

Out of scope for this iteration:

- Supporting stock LangChain model nodes as Mastra models.
- Supporting stock LangChain memory nodes as Mastra memory.
- Adding output parser or fallback model connectors.
- Adding a separate workspace connector.
- Rewriting the existing n8n tool ecosystem as native Mastra tool nodes.

## Compatibility Policy

- Model input accepts only Mastra model handoff objects from Mastra model nodes.
- Memory input accepts only Mastra memory handoff objects from Mastra memory nodes.
- Tool input accepts existing n8n `ai_tool` outputs through a compatibility bridge.
- Future Mastra-native tool handoff objects can be added to the same bridge without changing the agent UI.

This creates a Mastra-native island inside the standard n8n AI canvas model. The UI uses n8n's built-in AI connection types, while the internal model and memory contracts remain owned by this package.

## Agent Inputs

The Mastra Agent node exposes these inputs:

- `main`: regular workflow data input.
- `ai_languageModel`: display name `Chat Model`, required, `maxConnections: 1`.
- `ai_memory`: display name `Memory`, optional, `maxConnections: 1`.
- `ai_tool`: display name `Tool`, optional, multiple connections.

The `inputs` description moves from a static array to an expression string mirroring the standard n8n Agent pattern. This keeps the door open for future dynamic inputs without changing the public shape now.

## Model Contract

The existing Mastra Model node keeps returning a `MastraModelHandoff` through `ai_languageModel`.

The agent validates the handoff before using it. If a stock LangChain model node is connected, the agent fails with a clear user-facing error explaining that only Mastra model nodes are supported.

## Memory Contract

The existing Mastra Postgres Memory node keeps returning a `MastraMemoryHandoff` through `ai_memory`.

The agent validates the handoff before using it. Stock n8n/LangChain memory nodes are not adapted in this iteration because Mastra memory uses a different runtime model: memory is attached to `new Agent({ memory })` and scoped at call time with `{ memory: { thread, resource } }`.

## Tool Bridge

The agent reads connected `ai_tool` inputs and adapts them to Mastra tools.

The bridge supports the shapes used by stock n8n tools:

- LangChain `Tool` / `DynamicTool`.
- LangChain `StructuredTool` / `DynamicStructuredTool`.
- LangChain `StructuredToolkit`, including MCP Client Tool toolkits.

For each connected tool, the bridge:

- Flatten toolkits into individual tools.
- Preserve tool name and description.
- Convert or pass through schema in the format Mastra expects.
- Call the original tool implementation when Mastra invokes the adapted tool.

Tool-level logs remain owned by the original tool nodes. Existing n8n tools already log calls through `addInputData(NodeConnectionTypes.AiTool, ...)` and `addOutputData(...)`; invoking the original tool from the bridge preserves that behavior.

## Logging

This iteration implements agent-level logs first.

The Mastra Agent execution logs:

- Prompt/messages sent to Mastra.
- Final text response.
- Model label without leaking API keys.
- Token usage when Mastra exposes usage metadata for the stream/result.
- Errors in a user-readable form.

Full sub-node parity with the stock LangChain agent can be added later if needed. The first useful target is visible agent-level usage and preserving stock tool logs through the tool bridge.

## Error Handling

Errors are explicit and actionable:

- Missing model: ask the user to connect a Mastra Model node.
- Wrong model type: explain that stock LangChain chat model nodes are not compatible.
- Wrong memory type: explain that only Mastra memory nodes are supported.
- Tool bridge failure: name the tool when possible and report that it could not be adapted or invoked.

Secrets must not be included in output data, logs, or error descriptions.

## Testing

Tests cover:

- Agent input description includes standard AI connectors.
- Agent requires a Mastra model handoff.
- Agent accepts optional Mastra memory handoff.
- Agent rejects non-Mastra model and memory payloads.
- Tool bridge flattens single tools and toolkits.
- Tool bridge invokes the original n8n tool function.
- Tool bridge supports the MCP-style toolkit shape.
- Agent output does not leak model API keys.

## Future Work

- Mastra-native tool handoff support.
- Richer sub-node logs for model and memory parity with stock n8n AI nodes.
- Optional workspace/config support using an existing n8n AI connection type or a node parameter, not a new custom connector type.
- Output parser and fallback model support if they become necessary.
