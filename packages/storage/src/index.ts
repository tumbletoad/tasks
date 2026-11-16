// @tasks/storage: the SQLite storage adapter (A1 3.19) and its worker threads (A1 3.9).
//
// Worker-side code (the writer, reader and maintenance workers) loads a driver with loadDriver(),
// passes it through CheckedDriver.check() and opens space connections with openWriter() and
// openReader(), and creates or opens a space folder with createSpace() and openSpace(). The main
// thread uses StorageWorker and never holds a connection. This module does not import node:sqlite
// itself.
export {
  MEMORY,
  SINGLE_STEP,
  runTransaction,
  type BackupOptions,
  type Connection,
  type DriverName,
  type NotPromise,
  type OpenOptions,
  type Params,
  type Row,
  type RunResult,
  type SqlValue,
  type SqliteDriver,
  type Statement,
  type TransactionHost,
  type TransactionMode,
} from "./driver.ts";
export { DEFAULT_DRIVER, loadDriver } from "./drivers.ts";
export {
  STORAGE_ERROR_CODES,
  StorageError,
  UnexpectedSpace,
  type MigrationAttempt,
  type SerializedStorageError,
  type StorageErrorCode,
} from "./errors.ts";
export {
  BUSY_TIMEOUT_MS,
  READER_PRAGMAS,
  WRITER_PRAGMAS,
  openReader,
  openSpaceConnection,
  openWriter,
  type PragmaSetting,
  type Role,
  type SpaceOpenOptions,
} from "./open.ts";
export {
  decodeIdBody,
  encodeIdBody,
  ID_ALPHABET,
  ID_PREFIXES,
  isId,
  newId,
  osRandom,
  parseId,
  type Id,
  type IdKind,
  type IdPrefix,
  type RandomSource,
} from "./ids.ts";
export {
  compareAppVersions,
  DATABASE_FILE,
  isAppVersion,
  MANIFEST_FILE,
  readManifest,
  type ManifestRead,
  type SpaceManifest,
} from "./manifest.ts";
export {
  defaultRefPrefix,
  formatEntryRef,
  formatTaskRef,
  isRefPrefix,
  nextEntryOrdinal,
  parseEntryRef,
  parseTaskRef,
  takeTaskRef,
  type EntryKind,
} from "./refs.ts";
export {
  decodeLineage,
  decodeSpaceRow,
  inRange,
  invalidValue,
  isSpaceName,
  LINEAGE_KINDS,
  RANGES,
  REF_PREFIX,
  RowReader,
  type Lineage,
  type LineageEntry,
  type LineageKind,
  type RangeName,
  type SpaceFormat,
  type SpaceRow,
} from "./rows.ts";
export {
  APP_ID,
  CLOSED_ENUMS,
  decodeRevision,
  encodeRevision,
  FORBIDDEN_COLUMN_WORDS,
  formatRevision,
  JSON_COLUMNS,
  OPEN_SETS,
  WITHOUT_ROWID_TABLES,
  type Revision,
  type SchemaStep,
} from "./schema.ts";
export {
  createSpace,
  LATEST_REVISION,
  openSpace,
  SOURCE_APP_VERSION,
  type CreatedSpace,
  type CreateSpaceOptions,
  type OpenedSpace,
  type OpenSpaceOptions,
  type ReadOnlyReason,
  type SpaceActors,
} from "./space.ts";
export { checkSpacePath, isSpaceSlug, SLUG_MAX, slugFromName } from "./space-path.ts";
// The search index: its tables, which schema 0.4 adds and the writer keeps current, the rebuild,
// and the pages by frozen IDs that search cursors read.
export {
  expectedDocuments,
  indexChanges,
  rebuildSearchIndex,
  storedDocuments,
  type IndexedChange,
  type SearchDocument,
  type StoredDocument,
} from "./search/documents.ts";
export {
  decodeRowsByIds,
  ROWS_BY_IDS_SQL,
  type FrozenEntry,
  type FrozenKind,
} from "./search/rows.ts";
export {
  HAS_SEARCH_TABLES_SQL,
  hasSearchTables,
  isSearchObject,
  SEARCH_DOC_KINDS,
  type SearchDocKind,
} from "./search/tables.ts";
export { SCHEMA_STEPS } from "../migrations/index.ts";
export {
  CheckedDriver,
  MIN_SQLITE_VERSION,
  type Capabilities,
  type DriverReport,
} from "./startup-check.ts";
export {
  StorageWorker,
  WorkerConnection,
  openSpaceConnections,
  type SpaceConnections,
  type StartOptions,
} from "./worker/client.ts";
export {
  REQUEST_TIMEOUT_MS,
  SpaceWriterHandle,
  WRITER_QUEUE_LIMIT,
  type ClaimCopyOptions,
  type InPlaceRestoreOptions,
  type SpaceWriterOptions,
} from "./worker/client.ts";
export type {
  LockedFile,
  MigrationReport,
  Query,
  QueryMode,
  QueryResult,
} from "./worker/protocol.ts";
// One writer per space across processes (A2 3.4): writer.lock and writer.json, which every
// StorageWorker route that opens a space for writing takes. takeFileLock is the same technique for
// another lock file, the service's (M1.08).
export {
  fileIdentity,
  LOCK_SETTLE_MS,
  readWriterHolder,
  SpaceLockedElsewhere,
  takeFileLock,
  WRITER_HOLDER_FILE,
  WRITER_LOCK_FILE,
  type FileIdentity,
  type FileLock,
  type HolderFacts,
  type WriterHolder,
} from "./writer-lock.ts";
// Migrations, backups and restore (M1.06). M1.10 wires the CLI verbs to these. Everything that
// writes a live space or moves its folder goes through a StorageWorker under the space's claim:
// openSpaceWriter (which migrates first), claimSpace, restoreInPlace and recoverSpace. The
// functions below read a space or write only new files.
export {
  backupSpace,
  backupsFolder,
  type BackupRecord,
  type BackupSeams,
  type SpaceBackupOptions,
} from "./backup/backup.ts";
export {
  listBackups,
  removeBackupLeftovers,
  verifyBackup,
  type BackupListing,
  type ListedBackup,
  type ListedState,
} from "./backup/list.ts";
export { BUNDLE_POLICY, type BundlePolicy } from "./backup/policy.ts";
export {
  applyRetention,
  dailyBackupDue,
  planRetention,
  RETENTION,
  type LocalClock,
  type RetentionPlan,
  type RetentionResult,
  type RetentionRules,
} from "./backup/retention.ts";
export {
  BACKUP_KINDS,
  BACKUPS_FOLDER,
  type BackupKind,
  type BackupSidecar,
} from "./backup/sidecar.ts";
export { finishInterruptedRestore, type ResumeReport } from "./restore/folders.ts";
export type { RecoveredSpace } from "./restore/recover.ts";
export {
  READ_ONLY_COPY,
  restoreBackup,
  type RestoredInPlace,
  type RestoredSpace,
  type RestoreOptions,
} from "./restore/restore.ts";
export { isBundleFile, type RestoreSource } from "./restore/unpack.ts";
// The ways out of a space whose check failed (A1 3.2).
export { restoreLatest, rescueSpace, RESCUED_FOLDER, type RescueRecord } from "./restore/rescue.ts";
// Export bundles (M3.07): the exporter, and the reader every side that opens a bundle shares. M3.08
// builds transfer and import on these.
export {
  exportBundle,
  exportName,
  exportsFolder,
  EXPORTS_FOLDER,
  type ExportOptions,
  type ExportRecord,
} from "./bundle/export.ts";
export {
  decodeExport,
  EXPORT_MODES,
  type ExportManifest,
  type ExportMode,
  type TransferStatement,
} from "./bundle/export-file.ts";
export { readBundle, type ReadBundle, type ReadBundleOptions } from "./bundle/read.ts";
export { findSecret, SECRET_KINDS, type SecretKind } from "./secrets.ts";
export type { Claim } from "./restore/claim.ts";
export type { OpenedSpaceInfo } from "./worker/protocol.ts";
export {
  fieldValue,
  PATCHABLE_FIELDS,
  TASK_FIELDS,
  type PatchableField,
  type TaskField,
} from "./write/fields.ts";
export { FIRST_POSITION, isPosition, positionBetween } from "./write/positions.ts";
// Folders (schema 0.5): their form on each OS, the case rule, and the folder a launch uses.
export {
  carriedTo,
  decideLaunchFolder,
  FOLDER_PATH_MAX,
  folderKey,
  folderProblem,
  folderView,
  foldersOf,
  isFolderForm,
  launchFolder,
  rebased,
  segmentsOf,
  separatorOf,
  type FolderOs,
  type FolderView,
  type LaunchFolder,
} from "./write/folders.ts";
export {
  ADDRESSEES,
  checkRequest,
  DEDUPE_MODES,
  DEDUPE_WINDOW_DAYS,
  EXT_KEY,
  formatAsOf,
  IMPORT_OPERATIONS,
  incarnationTag,
  isImportRequest,
  isRelPath,
  LAUNCH_EVIDENCE_FIELDS,
  LAUNCH_EVIDENCE_ID,
  LAUNCH_FAIL_REASONS,
  LAUNCH_STATES,
  LAUNCH_UNKNOWN_REASONS,
  LINK_ROLES,
  LOG_KINDS,
  normaliseSourceKey,
  normaliseStored,
  OPERATION_KINDS,
  parseAsOf,
  PLACE_KINDS,
  SOURCE_KINDS,
  WRITE_ERROR_CODES,
  WRITE_LIMITS,
  FOLDER_OPERATIONS,
  type ActorKind,
  type Addressee,
  type AliasAdd,
  type AreaCreate,
  type AreaPatch,
  type AreaUpsert,
  type FolderClear,
  type FolderSet,
  type GroupArchive,
  type GroupValues,
  type ProjectCreate,
  type ProjectDelete,
  type ProjectMove,
  type ProjectPatch,
  type ExchangeCreate,
  type ExchangeItem,
  type ImportUndo,
  type JsonValue,
  type PreviewGuard,
  type ProjectUpsert,
  type AsOf,
  type Base,
  type ConflictEntity,
  type Credential,
  type DedupeMode,
  type Due,
  type FieldConflict,
  type Intent,
  type LaunchCreate,
  type LaunchEvidence,
  type LaunchState,
  type LaunchTransition,
  type LinkRole,
  type LogAdd,
  type LogKind,
  type NoteAdd,
  type Operation,
  type OperationKind,
  type OpResult,
  type Origin,
  type PlaceClear,
  type PlaceKind,
  type PlaceSet,
  type Placement,
  type PrefSet,
  type RunCreate,
  type RunTransition,
  type SourceAdd,
  type SourceFields,
  type SourceKind,
  type TaskComplete,
  type TaskContextAppend,
  type TaskCreate,
  type TaskLifecycle,
  type TaskMove,
  type TaskPatch,
  type TaskReopen,
  type TaskValues,
  type WriteErrorCode,
  type WriteProblem,
  type WriteRequest,
  type WriteResult,
  type WriteStatus,
} from "./write/request.ts";
export { canonicalJson, isJsonData } from "./write/canonical.ts";
export { readSpacePreference, readSpacePreferences, storedPreference } from "./preferences.ts";
export {
  markProjected,
  PROJECTION_ALL,
  PROJECTION_BATCH,
  PROJECTION_QUEUE_KEYS,
  queueProjection,
  type ProjectedBatch,
} from "./write/outbox.ts";
export {
  FOCUS_MS,
  isLaunchRef,
  LAUNCH_EDGES,
  launchRefCheck,
  OPEN_LAUNCH_STATES,
  REFERENCE_WINDOW_MS,
  type LaunchDetail,
  type LaunchRecord,
} from "./write/launches.ts";
export {
  FINAL_RUN_STATES,
  OPEN_RUN_STATES,
  RUN_APP_TOOLS,
  RUN_EDGES,
  RUN_EVIDENCE_FIELDS,
  RUN_EVIDENCE_ID,
  RUN_LIMIT_BOUNDS,
  RUN_OUTCOMES,
  RUN_PERMISSIONS,
  RUN_REASONS,
  RUN_REQUEST_MAX_BYTES,
  RUN_STATES,
  RUN_TEXT_MAX_BYTES,
  RUN_USAGE_KEYS,
  type RunDetail,
  type RunEvidence,
  type RunLimitsRow,
  type RunResultRow,
  type RunRow,
  type RunSpec,
  type RunState,
} from "./write/runs.ts";
export {
  decodeReceipt,
  intentFingerprint,
  readReceipt,
  RECEIPT_SQL,
  requestFingerprint,
  type IntentParts,
  type Receipt,
  type ReceiptLookup,
} from "./write/receipts.ts";
export {
  MACHINE_OS,
  readAsOf,
  SpaceWriter,
  SYSTEM_SCOPE,
  type MachineInfo,
  type MachineOs,
  type SubmitOptions,
  type WriterOptions,
  type WriteSeams,
} from "./write/writer.ts";
export { planImportRevert, recomputeToken, type ImportRevert } from "./write/imports.ts";
export { submitBehindBackup, type BarrierOptions, type BarrierResult } from "./backup/barrier.ts";
