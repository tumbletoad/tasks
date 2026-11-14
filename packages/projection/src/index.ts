// @tasks/projection: the generated, read-only Markdown tree `view/` and `catalog.jsonl` (A1 3.13,
// A3 3.9.8), for people and file-only agents. Never a source of truth, never imported.
//
// The projection reads the space through a reader connection and writes the outbox only through
// the space's writer (ProjectionWriter), so it changes nothing in the space's state and needs no
// operation (A1 3.7: bookkeeping). What it placed in the tree, and the journal of a batch, are its
// trusted state in the product's machine state (state.ts), never in the tree. The service runs it
// in a worker thread of its own per open space (A1 3.9's maintenance worker), off the main thread.
//
// Redaction (M3.14) reaches it through the outbox like any change: a task that the reads no longer
// find renders as no file, so its file and its catalogue line go, and a task whose text changed is
// rendered again. The record holds the catalogue lines, so the same pass rewrites it. The entries
// under the space's `exchange/rescued/` are the one store the projection leaves to redaction.
export { runProjection, MAX_WAIT_MS, POLL_MS, QUIET_MS, type LoopOptions } from "./loop.ts";
export {
  Projector,
  type ProjectionWriter,
  type ProjectorOptions,
  type Reconciled,
  type StartReport,
  type StepReport,
} from "./projector.ts";
export { missingTasks, readBatch, readPending, type BatchRead, type Pending } from "./read.ts";
export {
  catalogText,
  dateIn,
  FORMAT,
  indexText,
  mdLine,
  projectionJson,
  README_TEXT,
  renderTask,
  slugOf,
  SLUG_MAX,
  sortEntries,
  taskPath,
  yamlValue,
  type CatalogEntry,
  type Groups,
  type RenderedTask,
  type SpaceIdentity,
  type TaskInput,
  type Watermark,
} from "./render.ts";
export { STEM, TrustedState, type FileRecord, type Journal, type TrustedRecord } from "./state.ts";
export {
  codeOf,
  isTempPath,
  isTreePath,
  ProjectionError,
  ROOT_FILES,
  sha256,
  Tree,
  type Act,
  type Hook,
  type Look,
} from "./tree.ts";
