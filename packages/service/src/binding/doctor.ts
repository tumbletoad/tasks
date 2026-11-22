// `doctor/sessions` (A3 3.14 `sessions`): what doctor's sessions row reads of the binding service,
// through its public surface only: the bridge connections open now (`open()`), which of them carry
// more than one conversation (shared mode, A3 3.7.5), and how many session records the store could
// not read back at this start (`dropped`, logged as `binding.store_dropped`). Counts and instance
// IDs only: an instance is an A4 instance ID or `manual` (bindings.ts `instanceIn`), never a path,
// a native ID, a handle or a task.
import type { JsonObject } from "@ttasks/bridge/protocol";
import type { Slot } from "../ops/index.ts";

export interface SessionSource {
  open(): readonly Slot[];
  readonly dropped: number;
}

/** The sessions row's facts: open bridge connections, the shared ones by instance, the dropped. */
export function sessionFacts(bindings: SessionSource): JsonObject {
  const open = bindings.open().filter((slot) => slot.kind === "bridge");
  const shared = new Map<string, number>();
  for (const slot of open) {
    if (slot.shared) shared.set(slot.instance, (shared.get(slot.instance) ?? 0) + 1);
  }
  return {
    open: open.length,
    shared: [...shared]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([instance, count]) => ({ instance, count })),
    dropped: bindings.dropped,
  };
}
