// A task's place written straight to its space's writer. The launch, `here` and the feed's rows
// still read places, and no tool binds one: their tests place a task this way. Tests only.
import { randomBytes } from "node:crypto";
import type { Id, Operation } from "@tasks/storage";
import type { OpsHost } from "../src/ops/index.ts";
import { readSpace } from "../src/ops/read.ts";

/** Places `task` (a reference or an ID) at `root` and `path` in the service's open space. */
export function placeTask(
  ops: OpsHost,
  task: string,
  root: string,
  path: string,
  space?: string,
): Promise<void> {
  return placeTasks(ops, [{ task, root, path }], space);
}

/** Places each task, in one request. */
export function placeTasks(
  ops: OpsHost,
  places: readonly { readonly task: string; readonly root: string; readonly path: string }[],
  space?: string,
): Promise<void> {
  return write(
    ops,
    places.map(({ task, root, path }) => ({ kind: "place.set" as const, task, root, path })),
    space,
  );
}

/** Takes the task's place away. */
export function unplaceTask(ops: OpsHost, task: string, space?: string): Promise<void> {
  return write(ops, [{ kind: "place.clear", task }], space);
}

async function write(ops: OpsHost, sent: Operation[], space: string | undefined): Promise<void> {
  const served = ops
    .spaces()
    .find((s) => s.writer !== undefined && (space === undefined || s.id === space));
  const writer = served?.writer;
  const reader = served?.reader;
  if (writer === undefined || reader === undefined) throw new Error("no space is open for writing");
  const principal = await writer.actor("human", "fixture-places");
  const result = await writer.submit({
    space_id: writer.spaceId,
    request_id: `fixture-place-${randomBytes(8).toString("hex")}`,
    // A place there already is replaced as the person would, after a read.
    base: (await readSpace(reader)).asOf,
    actor: {
      scope_id: "cli:fixture-places",
      principal_id: principal,
      actor_kind: "human",
      machine_id: ops.machine.id as Id<"m">,
      origin: "cli",
    },
    ops: sent,
  });
  if (result.status !== "applied") throw new Error(`the fixture place was ${result.status}`);
}
