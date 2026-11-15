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
export { ACTIONS_MAX, parseActions, type ActionsParse } from "./actions.ts";
export {
  ACTIONS,
  ACTIONS_FILE,
  EVENTS_DIR,
  eventInstant,
  parseEvents,
  placeOfEvent,
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
  keptLines,
  parsePrototype,
  type PrototypeCounts,
  type PrototypeInput,
  type PrototypeParse,
} from "./prototype.ts";
export {
  checkMappingOptions,
  cutAtWord,
  mapPrototype,
  MappingOptionsError,
  MAPPING_LIMITS,
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
export {
  eventMillis,
  FIRST_DAY,
  inDayRange,
  INSTANT_MAX,
  isTimeZone,
  LAST_DAY,
  localDay,
  nineOClock,
} from "./local-time.ts";
export { placeFor, ROOT_ID, type PlannedPlace, type Roots } from "./places.ts";
export {
  canonicalJson,
  judgedNames,
  placeProjects,
  planHash,
  previewOf,
  previewPinned,
  previewToken,
  proposeRoots,
  type Preview,
  type PreviewRoot,
  type PreviewRun,
  type ProjectPlacement,
  type SpaceProject,
  type SpaceState,
} from "./preview.ts";
export { renderPreview } from "./report-md.ts";
export {
  BASE_FIELDS,
  comparedPlanning,
  decideApply,
  expectedOf,
  FIRST_IMPORT_KEYS,
  sourceIdentity,
  type AppliedTask,
  type ApplyDecision,
  type ApplyOp,
  type ApplyOptions,
  type ApplySpace,
  type BaseField,
  type Changed,
  type Expected,
  type ItemBase,
  type MatchedTask,
  type RecordedBase,
} from "./apply.ts";
export { groupKey, groupSlug, numberedSlug, SLUG_MAX } from "./slug.ts";
export { exactNumber } from "./json.ts";
export {
  classifyUrl,
  fileLinkPath,
  isGenericLabel,
  normaliseUrl,
  REF_MAX,
  shortUrl,
  SOURCE_KEY_MAX,
  type PlannedSourceKind,
  type UrlClass,
} from "./sources.ts";
export {
  EXPORT_FILE,
  copyActions,
  copyInput,
  hashInputs,
  readCopy,
  readInput,
  verifyActions,
  verifySource,
  type InputCopy,
  type InputFile,
} from "./input-copy.ts";
