// The child process of the tree writer's crash test (tree.test.ts): it opens the tree space its
// plan names, sends the plan's requests one by one through an in-thread TreeWriter, and reports
// each result reduced to statuses, sequence numbers and IDs. At the armed write point it reports
// the request it is deciding and waits to be killed. No message carries task text.
import "../../packages/bridge/src/safe-exit.ts";
import { nodeSqliteDriver } from "../../packages/storage/src/node-sqlite.ts";
import { CheckedDriver } from "../../packages/storage/src/startup-check.ts";
import type { TreeResult } from "../../packages/storage/src/tree/core.ts";
import { openTree } from "../../packages/storage/test/tree-helpers.ts";
import { writeSync } from "node:fs";
import { KILL_WAIT_MS } from "./protocol.ts";

export interface TreePlanned {
  request_id: string;
  agent: boolean;
  /**
   * `fresh`: the newest as_of this child saw. `stale`: the first one it saw. An as_of: the one the
   * request was first sent with, as a client resends it.
   */
  base: "none" | "fresh" | "stale" | { as_of: string };
  command: string;
  input: Record<string, unknown>;
}

export interface TreePlan {
  folder: string;
  arm: { point: "before-commit" | "after-commit"; nth: number } | null;
  requests: TreePlanned[];
}

export type TreeMessage =
  | { t: "ready" }
  | { t: "send"; request_id: string; base?: string }
  | { t: "ack"; request_id: string; status: string; seq: number; commit?: string; replayed?: true }
  | { t: "at"; point: string; request_id: string; status: string }
  | { t: "done" }
  | { t: "error"; during: string; code: string };

/** One message per line, written synchronously so it is out before the process waits to be killed. */
function emit(message: TreeMessage): void {
  const line = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
  let offset = 0;
  while (offset < line.length) offset += writeSync(1, line, offset, line.length - offset);
}

const reduce = (request_id: string, r: TreeResult): TreeMessage => ({
  t: "ack",
  request_id,
  status: r.status,
  seq: r.seq,
  ...(r.commit === undefined ? {} : { commit: r.commit }),
  ...(r.replayed === true ? { replayed: true } : {}),
});

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const plan = JSON.parse(Buffer.concat(chunks).toString("utf8")) as TreePlan;
  let current = "";
  const counts = new Map<string, number>();
  const at = (point: "before-commit" | "after-commit", result: TreeResult): void => {
    const nth = (counts.get(point) ?? 0) + 1;
    counts.set(point, nth);
    if (plan.arm?.point !== point || plan.arm.nth !== nth) return;
    emit({ t: "at", point, request_id: current, status: result.status });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, KILL_WAIT_MS);
    throw new Error("The crash test did not kill the child at its point");
  };
  const fx = openTree(await CheckedDriver.check(nodeSqliteDriver), plan.folder, false, at);
  emit({ t: "ready" });
  const seen: string[] = [];
  for (const planned of plan.requests) {
    current = planned.request_id;
    const base =
      typeof planned.base === "object"
        ? planned.base.as_of
        : planned.base === "fresh"
          ? seen.at(-1)
          : planned.base === "stale"
            ? seen[0]
            : undefined;
    emit({ t: "send", request_id: planned.request_id, ...(base === undefined ? {} : { base }) });
    const result = fx.send(planned.command, planned.input, {
      request_id: planned.request_id,
      who: planned.agent ? fx.agent : fx.human,
      base: base ?? null,
    });
    seen.push(result.as_of);
    emit(reduce(planned.request_id, result));
  }
  fx.close();
  emit({ t: "done" });
}

main().catch((error: unknown) => {
  emit({ t: "error", during: "run", code: error instanceof Error ? error.name : "unknown" });
  process.exit(1);
});
