// @ttasks/contracts: the one place where shapes live (AGENTS.md). Registry entries with Zod 4
// schemas, their metadata, error codes and the generated faces (A3 3.2, A6 3.3).
export * from "./a1-errors.ts";
export * from "./define.ts";
export * from "./errors.ts";
export * from "./http.ts";
export * from "./later.ts";
export * from "./operations.ts";
export * from "./preferences.ts";
export * from "./query-terms.ts";
export * from "./day.ts";
export * from "./registry.ts";
export type * from "./remote.ts";
export { REMOTE_MAX_VALIDITY_S, REMOTE_USER_TEXT_MAX, REMOTE_VALIDITY_S } from "./remote.ts";
export * from "./monitor.ts";
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
export { historyRedo, HistoryRedoInput, HistoryRedoResult } from "./entries/history-redo.ts";
export { historyUndo, HistoryUndoInput, HistoryUndoResult } from "./entries/history-undo.ts";
export {
  GROUP_ACTIONS,
  GROUP_CURSOR,
  GROUP_PAGE,
  groupManage,
  GroupListResult,
  GroupManageInput,
  GroupManageResult,
} from "./entries/group-manage.ts";
export {
  FOLDER_ACTIONS,
  folderManage,
  FolderManageInput,
  FolderManageResult,
} from "./entries/folder-manage.ts";
export {
  PREFS_ACTIONS,
  prefsManage,
  PrefsManageInput,
  PrefsManageResult,
  PrefsReadResult,
} from "./entries/prefs-manage.ts";
export { runReport, RunReportInput, RunReportResult } from "./entries/run-report.ts";
export {
  newerWorkJson,
  receiptGet,
  ReceiptGetInput,
  ReceiptGetResult,
  receiptResult,
  type StoredReceiptLike,
} from "./entries/receipt-get.ts";
export {
  NoteNumber,
  noteRemove,
  NoteRemoveInput,
  NoteRemoveResult,
} from "./entries/note-remove.ts";
export { spaceStatus, SpaceStatusInput, SpaceStatusResult } from "./entries/space-status.ts";
export { taskAdd, TaskAddInput, TaskAddResult } from "./entries/task-add.ts";
export {
  DELETE_MAX,
  RestoredTask,
  taskDelete,
  TaskDeleteInput,
  TaskDeleteResult,
} from "./entries/task-delete.ts";
export {
  TRASH_CURSOR,
  TrashChange,
  TrashRow,
  taskTrash,
  TaskTrashInput,
  TaskTrashResult,
} from "./entries/task-trash.ts";
export { taskFinish, TaskFinishInput, TaskFinishResult } from "./entries/task-finish.ts";
export {
  FINISHED_CURSOR,
  FinishedRow,
  taskFinished,
  TaskFinishedInput,
  TaskFinishedResult,
} from "./entries/task-finished.ts";
export {
  REMOVED_NOTES,
  REQUEST_CHARS,
  REQUEST_LAUNCHES,
  TaskDetail,
  taskGet,
  TaskGetInput,
  TaskGetResult,
  TaskSections,
} from "./entries/task-get.ts";
export { taskReopen, TaskReopenInput, TaskReopenResult } from "./entries/task-reopen.ts";
export {
  CURSOR_PATTERN,
  SEARCH_IDS,
  SEARCH_SCOPES,
  SearchGoneRow,
  SearchLearningRow,
  SearchRow,
  SearchTaskRow,
  taskSearch,
  TaskSearchInput,
  TaskSearchResult,
} from "./entries/task-search.ts";
export { taskUpdate, TaskUpdateInput, TaskUpdateResult } from "./entries/task-update.ts";
// Step 1's pages: shapes and examples first; each entry joins the registry with its handler.
export * from "./pages.ts";
export { NodeInstructInput, NodeInstructResult, nodeInstruct } from "./entries/node-instruct.ts";
export {
  PAGE_CONFLICT_EXAMPLE,
  PAGE_ENTRIES,
  PAGE_FEED_EXAMPLES,
} from "./entries/page-examples.ts";
export {
  HISTORY_CURSOR,
  PageHistoryInput,
  PageHistoryResult,
  pageHistory,
} from "./entries/page-history.ts";
export { PageReadInput, PageReadResult, pageRead } from "./entries/page-read.ts";
export {
  PageTrashedInput,
  PageTrashedResult,
  TrashedPage,
  pageTrashed,
} from "./entries/page-trashed.ts";
export {
  PAGE_ACTIONS,
  PAGE_RESULTS,
  PageWriteInput,
  PageWriteResult,
  pageWrite,
} from "./entries/page-write.ts";
