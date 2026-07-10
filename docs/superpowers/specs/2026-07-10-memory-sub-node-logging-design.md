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
sub-node creates a live `@mastra/memory` `Memory` instance (backed by a
`PostgresStore`) and passes it to the agent through `MastraMemoryHandoff`.

In Mastra 1.49 the agent's normal chat path does NOT call `Memory.recall` or
`Memory.saveMessages`. Instead, `memory.getInputProcessors()` creates a
`MessageHistory` processor with `storage.getStore('memory')` — a store-domain
object. Reads go `MessageHistory.processInput` → `store.listMessages(...)` and
writes go `MessageHistory.processOutputResult` → `store.saveMessages(...)`,
bypassing the `Memory` methods entirely.

The correct single choke point is therefore the store-domain object returned
by `storage.getStore('memory')`: both the `MessageHistory` processor AND
`Memory.recall`/`Memory.saveMessages` (used for side paths such as title
generation) funnel through its `listMessages` and `saveMessages`.

## Architecture

Add a shared logging wrapper module:

- `nodes/shared/memoryLogging.ts`

It will export:

- `AI_MEMORY_CONNECTION = 'ai_memory'`
- `mapMemoryMessagesToN8n(...)`
- `wrapMemoryStorageForLogging(storage, ctx)`

`wrapMemoryStorageForLogging` monkey-patches `storage.getStore` on the
instance (binding the original first). When `getStore('memory')` resolves, the
returned store's `listMessages` and `saveMessages` are monkey-patched in place
to log input/output on the `ai_memory` connection; other store names pass
through untouched. A module-level `WeakSet` keeps the same store object from
being wrapped twice, since `getStore` is called multiple times per run.

Proxies are avoided in favor of instance monkey-patching because Mastra store
classes may use private class fields (`#private`), and Proxy receivers break
private-field access.

`MemoryPostgresMastra.supplyData` wraps the storage before constructing the
`Memory` instance and hands off the plain memory:

```ts
const storage = new PostgresStore(...);
wrapMemoryStorageForLogging(storage, this);
const memory = new Memory({ storage, ... });

const handoff: MastraMemoryHandoff = {
  __isMastraMemory: true,
  memory,
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

When Mastra calls `store.listMessages(args)`:

1. Log an input item on `ai_memory` containing operation `recall`, `threadId`,
   `resourceId`, and any query/search summary available from `args`.
2. Call the original `listMessages` method.
3. Log an output item on the same index containing operation `recall`,
   `threadId`, `resourceId`, message count, optional token usage, and the
   normalized messages returned by the store.
4. Return the original `listMessages` result unchanged.

### Save Messages

When Mastra calls `store.saveMessages({ messages, ... })`:

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
- If `listMessages` or `saveMessages` throws, attempt to log the original error
  as the output, then rethrow the original error.
- If building the mapped payload throws, fall back to a minimal
  `{ operation }` payload so the store call is never broken by the mapper.
- Only `getStore`, `listMessages`, and `saveMessages` are patched; everything
  else on the storage and store instances is untouched.

This matches the model logging behavior: execution-tree logging is diagnostic,
not part of the correctness path.

## Testing

Add unit tests for the shared memory logging module:

- `mapMemoryMessagesToN8n` maps `id`, `role`, text, `createdAt`, `threadId`,
  `resourceId`, count, and token usage.
- Text extraction handles `content.content`, `content.parts`, missing content,
  and non-text parts without throwing.
- The store returned by `getStore('memory')` logs input and output for
  `listMessages` (operation `recall`) and `saveMessages`, returning the
  original results unchanged.
- Stores returned for other names are not wrapped.
- Calling `getStore('memory')` twice does not double-wrap the store.
- Original store errors are logged and rethrown.
- Logger failures do not break store calls.

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

- Raw SQL / Postgres query-level logging (only the store-domain
  `listMessages`/`saveMessages` calls are logged).
- Raw `MastraDBMessage` dumps, provider metadata, tool payloads, or arbitrary
  message metadata in the execution tree.
- A UI toggle for memory log verbosity.
- Real n8n E2E test harness automation.
- Native chat streaming changes.
