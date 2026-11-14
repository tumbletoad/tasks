// The chain of schema steps (A1 3.17): which registered step produced a revision,
// and which steps take a space from its revision to the build's latest. Open (space.ts) and the
// migration runner (runner.ts) both read the chain here, so they always agree on it.
import { misuse } from "../errors.ts";
import { encodeRevision, type SchemaStep } from "../schema.ts";

/** Where a space's user_version stands against the registered steps. */
export type StepPosition =
  /** Newer than every registered step: this build never writes it. */
  | { state: "newer" }
  /** A revision no registered step produced: 0, or a value between two steps. */
  | { state: "unknown" }
  /** The step that produced the revision, and the steps after it, in order (empty when current). */
  | { state: "known"; step: SchemaStep; pending: readonly SchemaStep[] };

/**
 * Finds `userVersion` in `steps`. The steps must form one chain from an empty database: each
 * starts from the revision of the one before it, and the first from 0. A broken chain is a build
 * error, so it throws STORAGE_MISUSE rather than judging the space.
 */
export function stepPosition(steps: readonly SchemaStep[], userVersion: number): StepPosition {
  let from = 0;
  for (const step of steps) {
    if (step.from !== from) throw misuse("The schema steps do not form a chain");
    from = encodeRevision(step.revision);
  }
  const last = steps.at(-1);
  if (last === undefined) throw misuse("No schema step is registered");
  if (userVersion > encodeRevision(last.revision)) return { state: "newer" };
  const index = steps.findIndex((s) => encodeRevision(s.revision) === userVersion);
  const step = steps[index];
  if (step === undefined) return { state: "unknown" };
  return { state: "known", step, pending: steps.slice(index + 1) };
}
