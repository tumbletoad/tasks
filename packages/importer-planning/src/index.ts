// The Planning prototype importer (A7 3.15): the pure parsers and the input copy (M7.02), and the
// pure mapping from a parse to a plan of A1 operations (M7.03). The dry run (M7.04) and apply
// (M7.05) build on these.
//
// The shapes that cross the service boundary live in packages/contracts: the problem table and
// one problem now (import-planning.ts), the report and the preview with M7.04.

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
  cutAtWord,
  mapPrototype,
  MappingOptionsError,
  MAPPING_LIMITS,
  UNTITLED,
  type MappingOptions,
} from "./mapping.ts";
export {
  bindOperations,
  CHECKED_AS,
  IMPORT_LOG,
  PLANNING_EXT_KEYS,
  type BoundOp,
  type CheckedAs,
  type Draft,
  type ImportPlan,
  type PlanCounts,
  type PlannedAliasAdd,
  type PlannedArea,
  type PlannedLogAdd,
  type PlannedOp,
  type PlannedOwner,
  type PlannedPlaceSet,
  type PlannedProject,
  type PlannedSource,
  type PlannedSourceAdd,
  type PlannedSourceFields,
  type PlannedTask,
  type PlannedTaskComplete,
  type PlannedTaskCreate,
  type PlanningExt,
} from "./plan.ts";
export { eventMillis, isTimeZone, localDay, nineOClock } from "./local-time.ts";
export { placeFor, ROOT_ID, type PlannedPlace, type Roots } from "./places.ts";
export { groupSlug, SLUG_MAX } from "./slug.ts";
export {
  classifyUrl,
  isGenericLabel,
  normaliseUrl,
  shortUrl,
  SOURCE_KEY_MAX,
  type PlannedSourceKind,
  type UrlClass,
} from "./sources.ts";
export {
  EXPORT_FILE,
  copyInput,
  hashInputs,
  readInput,
  verifySource,
  type InputCopy,
  type InputFile,
} from "./input-copy.ts";
