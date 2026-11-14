// @tasks/contracts: the one place where shapes live (AGENTS.md). Registry entries with Zod 4
// schemas, their metadata, error codes and the generated faces (A3 3.2, A6 3.3).
export * from "./a1-errors.ts";
export * from "./define.ts";
export * from "./errors.ts";
export * from "./http.ts";
export * from "./operations.ts";
export * from "./registry.ts";
export * from "./runs.ts";
export * from "./safe-text.ts";
export * from "./schemas.ts";
export { checkRegistry, LIMITS, type CheckOptions } from "./check.ts";
export {
  agentInputJsonSchema,
  annotationsFor,
  definitionTokens,
  estimateTokens,
  inputJsonSchema,
  mcpTool,
  outputJsonSchema,
  resultTokens,
  ALWAYS_LOAD_META,
  BYTES_PER_TOKEN,
  JSON_SCHEMA_DIALECT,
  type JsonSchema,
  type McpAnnotations,
  type McpTool,
} from "./json-schema.ts";
export { definitionReport, type DefinitionReport } from "./gen/report.ts";
export { createCaller, type Caller, type ClientTransport } from "./client-runtime.ts";
export { entryAdd, EntryAddInput, EntryAddResult } from "./entries/entry-add.ts";
export {
  receiptGet,
  ReceiptGetInput,
  ReceiptGetResult,
  receiptResult,
  type StoredReceiptLike,
} from "./entries/receipt-get.ts";
export { spaceStatus, SpaceStatusInput, SpaceStatusResult } from "./entries/space-status.ts";
export { taskAdd, TaskAddInput, TaskAddResult } from "./entries/task-add.ts";
export { taskFinish, TaskFinishInput, TaskFinishResult } from "./entries/task-finish.ts";
export {
  TaskDetail,
  taskGet,
  TaskGetInput,
  TaskGetResult,
  TaskSections,
} from "./entries/task-get.ts";
export { taskReopen, TaskReopenInput, TaskReopenResult } from "./entries/task-reopen.ts";
export { taskUpdate, TaskUpdateInput, TaskUpdateResult } from "./entries/task-update.ts";
