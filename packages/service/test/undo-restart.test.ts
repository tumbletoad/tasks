// A person's undo history is kept in the space, not in a window or a process: a change made at the
// command line is undone from the page after the service restarted. A service in this process,
// fixture text and temporary folders only.
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { startService, type RunningService } from "../src/hub/service.ts";
import { opCall, type Caller } from "../src/ops/index.ts";
import { removeRuntimeDir, serviceEnv, tempRoot } from "./harness.ts";
import { classSession } from "./ops-helpers.ts";

type Json = Record<string, unknown>;

const running: RunningService[] = [];
const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const service of running.splice(0)) {
    await service.stop();
    removeRuntimeDir(service);
  }
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const CLI: Caller = { class: "cli-interactive", env: {} };
const PAGE: Caller = { class: "ui", env: {} };

let n = 0;
const rid = () => `fixture-restart-${String((n += 1)).padStart(6, "0")}`;

async function start(home: string): Promise<RunningService> {
  const service = await startService({
    env: serviceEnv(home),
    identity: () => ({ root: false, elevated: false, package: null }),
    maintenance: false,
    say: () => undefined,
  });
  running.push(service);
  await service.spacesSettled;
  return service;
}

describe("[A1.5.history.across-restart] the undo history survives a restart and is shared by every client", () => {
  test("a change made at the command line is undone from the page after a restart, and redone there", async () => {
    const { root, cleanup } = tempRoot("undo-restart");
    cleanups.push(cleanup);
    const home = join(root, "h");
    const first = await start(home);
    const user = await classSession(home, first.endpoint.path, "cli-interactive");
    try {
      await user.call(
        "space/create",
        { name: "Mira", path: join(root, "s", "mira"), ref_prefix: "M" },
        { timeoutMs: 120_000 },
      );
    } finally {
      user.close();
    }
    const call = async (service: RunningService, caller: Caller, op: string, input: Json) =>
      (await opCall(service.ops, caller, { op, input })) as Json;
    const added = await call(first, CLI, "task.add", {
      tasks: [{ title: "Fixture task to undo" }],
      request_id: rid(),
    });
    const task = String((added["tasks"] as Json[])[0]?.["ref"]);
    const base = (await call(first, CLI, "space.status", {}))["as_of"];
    await call(first, CLI, "task.update", {
      task,
      set: { summary: "Fixture summary" },
      base,
      request_id: rid(),
    });

    // The service stops, its writer with it, and starts again.
    await first.stop();
    removeRuntimeDir(first);
    running.splice(running.indexOf(first), 1);
    const second = await start(home);
    expect(second.spaces()).toMatchObject([{ state: "open" }]);

    const undone = await call(second, PAGE, "history.undo", { request_id: rid() });
    expect(undone).toMatchObject({ result: "undone", tasks: [task] });
    const summary = async () =>
      ((await call(second, CLI, "task.get", { task }))["task"] as Json)["summary"];
    expect(await summary()).toBe("");
    expect(await call(second, CLI, "history.redo", { request_id: rid() })).toMatchObject({
      result: "redone",
      tasks: [task],
    });
    expect(await summary()).toBe("Fixture summary");
  }, 120_000);
});
