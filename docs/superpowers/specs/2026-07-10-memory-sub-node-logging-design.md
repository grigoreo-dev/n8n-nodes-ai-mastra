# Memory Sub-Node Execution-Tree Logging Design

## Goal

Show the Postgres Memory (Mastra) sub-node in n8n's execution tree when a
Mastra Agent reads from or writes to memory.

The log should make the memory step understandable without dumping raw storage
objects: which operation ran, which thread/resource it targeted, how many
messages were involved, and the normalized messages that were read or saved.

## Background

The Mastra Model sub-node already appears in the execution tree by wrapping the
resolved `LanguageModelV2` and writing to the captured sub-node
`SupplyDataContext` via `addInputData` and `addOutputData` on the
`ai_languageModel` connection.

Memory needs the same n8n pattern, but the wrap point is different. The memory
sub-node creates a live `@mastra/memory` `Memory` instance and passes it to the
agent through `MastraMemoryHandoff`. Mastra core calls the memory instance's
public methods during `agent.stream`:

- `memory.recall(args)` when reading prior thread messages.
- `memory.saveMessages({ messages, ... })` when persisting new messages.

Those methods are the correct interception boundary. Wrapping the lower-level
`PostgresStore` would be noisier and more coupled to storage internals, while
wrapping `agent.stream` would require extra database reads and would not show
what Mastra actually used.

## Architecture

Add a shared logging wrapper module:

- `nodes/shared/memoryLogging.ts`

It will export:

- `AI_MEMORY_CONNECTION = 'ai_memory'`
- `mapMemoryMessagesToN8n(...)`
- `wrapMemoryForLogging(memory, ctx)`

`MemoryPostgresMastra.supplyData` will continue to create the real `Memory`
instance, then wrap it before putting it on the handoff:

```ts
const memory = new Memory(...);
const wrappedMemory = wrapMemoryForLogging(memory, this);

const handoff: MastraMemoryHandoff = {
  __isMastraMemory: true,
  memory: wrappedMemory,
  thread: threadId,
  resource: resourceId,
};
```

`MastraAgent` should not need changes. It already reads `connected.memory` and
passes it into `new Agent({ memory })`, so the agent will call the wrapped
methods naturally.

## Logged Data

The n8n payload should be summary-first and stable:

```ts
{
  operation: 'recall' | 'saveMessages',
  threadId?: string,
  resourceId?: string,
  messageCount: number,
  tokenUsage?: { totalTokens?: number },
  messages: [
    {
      id?: string,
      role: string,
      text: string,
      createdAt?: string,
      threadId?: string,
      resourceId?: string,
    }
  ]
}
```

`MastraDBMessage` currently provides `id`, `role`, `createdAt`, `threadId`,
`resourceId`, and `content`. Text extraction should be defensive:

- Prefer `message.content.content` when it is a string.
- Otherwise join text-like entries from `message.content.parts`.
- If no text is available, use an empty string.

The mapper should not include raw metadata, provider metadata, tool payloads, or
storage-specific fields by default. Those values can be noisy, unstable across
Mastra versions, and may include data that is less useful in the execution tree.

## Data Flow

### Recall

When Mastra calls `memory.recall(args)`:

1. Log an input item on `ai_memory` containing operation `recall`, `threadId`,
   `resourceId`, and any query/search summary available from `args`.
2. Call the original `recall` method.
3. Log an output item on the same index containing operation `recall`,
   `threadId`, `resourceId`, message count, optional token usage, and the
   normalized messages returned by memory.
4. Return the original `recall` result unchanged.

### Save Messages

When Mastra calls `memory.saveMessages({ messages, ... })`:

1. Log an input item on `ai_memory` containing operation `saveMessages`,
   message count, and normalized messages requested for persistence.
2. Call the original `saveMessages` method.
3. Log an output item on the same index containing operation `saveMessages`,
   message count, optional token usage, and the normalized messages reported as
   saved.
4. Return the original `saveMessages` result unchanged.

Thread/resource values for `saveMessages` should be inferred from the messages
when present. The handoff's thread/resource scope is still owned by the memory
sub-node and passed separately to `agent.stream`; the wrapper should not mutate
that scope.

## Error Handling

Logging must never break the agent path.

- If `addInputData` throws, swallow the logging error and continue the memory
  operation.
- If `addOutputData` throws, swallow the logging error.
- If `recall` or `saveMessages` throws, attempt to log the original error as the
  output, then rethrow the original error.
- Non-intercepted properties and methods on the memory instance should pass
  through unchanged via `Reflect.get`.

This matches the model logging behavior: execution-tree logging is diagnostic,
not part of the correctness path.

## Testing

Add unit tests for the shared memory logging module:

- `mapMemoryMessagesToN8n` maps `id`, `role`, text, `createdAt`, `threadId`,
  `resourceId`, count, and token usage.
- Text extraction handles `content.content`, `content.parts`, missing content,
  and non-text parts without throwing.
- `wrapMemoryForLogging(...).recall(...)` logs input and output and returns the
  original result.
- `wrapMemoryForLogging(...).saveMessages(...)` logs input and output and
  returns the original result.
- Original memory errors are logged and rethrown.
- Logger failures do not break memory calls.
- Non-intercepted memory properties/methods pass through unchanged.

Existing typecheck, unit test, and build jobs should remain green.

## Acceptance Criteria

- A workflow with `Mastra Agent` connected to `Postgres Memory (Mastra)` shows
  the memory sub-node in n8n's execution tree during agent execution.
- The memory node run data shows both reads (`recall`) and writes
  (`saveMessages`) when they occur.
- Logged messages are normalized and readable: role, text, id, createdAt,
  threadId, and resourceId.
- Memory behavior is unchanged: the agent response, thread/resource scoping, and
  Postgres persistence remain the same.
- Logger failures cannot cause agent or memory failures.

## Out of Scope

- Store-level Postgres operation logging.
- Raw `MastraDBMessage` dumps, provider metadata, tool payloads, or arbitrary
  message metadata in the execution tree.
- A UI toggle for memory log verbosity.
- Real n8n E2E test harness automation.
- Native chat streaming changes.
