// The Planning prototype importer (A7 3.15). M7.02: the pure parsers and the input copy. The
// mapping to operations (M7.03), the dry run (M7.04) and apply (M7.05) build on these.
//
// The shapes here are local to the importer. Those that cross the service boundary (the report,
// the preview) move to packages/contracts with M7.03 and M7.04.

export { fallbackId, fnv1aCodePoints } from "./fallback-id.ts";
export { LIMITS, type Limits } from "./limits.ts";
export {
  PROBLEM_CODES,
  PROBLEM_FIELDS,
  type Problem,
  type ProblemCode,
  type ProblemField,
  type Severity,
} from "./problems.ts";
export { eachLine, splitLines, type Line, type Source } from "./text.ts";
export {
  DEFAULT_GROUP,
  LEDGER_FILES,
  parseLedger,
  type AddedClause,
  type DoneClause,
  type LedgerFile,
  type LedgerParse,
  type LedgerTask,
} from "./ledger.ts";
export {
  METADATA_FILE,
  STATUSES,
  parseMetadata,
  type MetadataEntry,
  type MetadataParse,
  type MetadataSource,
  type PrototypeStatus,
} from "./metadata.ts";
export {
  ACTIONS,
  EVENTS_DIR,
  eventInstant,
  parseEvents,
  type EventAction,
  type EventFileInput,
  type EventFileResult,
  type EventsParse,
  type PrototypeEvent,
  type TaskEventState,
} from "./events.ts";
export {
  AUDIT_FILE,
  JIRA_FILE,
  parseAudit,
  parseJira,
  type AuditParse,
  type JiraParse,
  type JiraTicket,
} from "./optional.ts";
export {
  parsePrototype,
  type PrototypeCounts,
  type PrototypeInput,
  type PrototypeParse,
} from "./prototype.ts";
export {
  EXPORT_FILE,
  copyInput,
  hashInputs,
  readInput,
  verifySource,
  type InputCopy,
  type InputFile,
} from "./input-copy.ts";
