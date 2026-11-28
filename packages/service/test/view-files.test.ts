// A tree space's readable files in the service: open as this machine's, it gets the tree's layout
// in its `view/`, kept by a worker of its own with its record beside the space's settings; a task
// added through the request path shows in it; `ttasks view rebuild` reads every file and puts back
// what a person changed, rescued first. Services run in this process on temporary homes; fixture
// spaces only.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createSpace, newId, type Id } from "@ttasks/storage";
import { checkedDriver } from "@ttasks/testkit";
import { afterEach, describe, expect, test } from "vitest";
import { startService, type RunningService } from "../src/hub/service.ts";
import { filesRecordOf } from "../src/hub/space-settings.ts";
import {
  registerSpaces,
  removeRuntimeDir,
  serviceEnv,
  stateOf,
  tempRoot,
  waitFor,
} from "./harness.ts";
import { classSession } from "./ops-helpers.ts";

const running: RunningService[] = [];
const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const service of running.splice(0)) {
    await service.stop();
    removeRuntimeDir(service);
  }
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("[S3.files.service] the service keeps a tree space's readable files, in the tree's layout", () => {
  test("an open tree space gets the tree's files and their record; a new task shows; a rebuild puts back an edit", async () => {
    const { root, cleanup } = tempRoot("view-files");
    cleanups.push(cleanup);
    const machine = newId("m");
    const home = join(root, "h");
    mkdirSync(stateOf(home), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(stateOf(home), "machine.json"),
      JSON.stringify({
        machine_id: machine,
        name: "fixture-machine",
        created_at: "2026-11-13T08:00:00.000Z",
      }),
      { mode: 0o600 },
    );
    mkdirSync(join(root, "spaces"));
    const folder = join(root, "spaces", "tree");
    createSpace(await checkedDriver(), folder, {
      name: "Mira",
      refPrefix: "M",
      machineId: machine,
      ownerLabel: "user",
      tree: true,
    });
    registerSpaces(home, [folder]);
    const service = await startService({
      env: serviceEnv(home),
      identity: () => ({ root: false, elevated: false, package: null }),
      say: () => undefined,
    });
    running.push(service);
    await service.spacesSettled;

    const view = join(folder, "view");
    await waitFor(
      () => (existsSync(join(view, "README.md")) ? true : undefined),
      30_000,
      "the first pass",
    );
    expect(existsSync(join(view, "_index.md"))).toBe(true);
    // Nothing of today's layout.
    expect(
      readdirSync(view).filter((name) => ["open", "catalog.jsonl", "index.md"].includes(name)),
    ).toEqual([]);
    const manifest = JSON.parse(readFileSync(join(folder, "space.json"), "utf8")) as {
      space_id: Id<"sp">;
    };
    expect(existsSync(filesRecordOf(stateOf(home), manifest.space_id, folder))).toBe(true);

    const s = await classSession(home, service.endpoint.path, "cli-script");
    try {
      await s.call(
        "op/call",
        {
          op: "task.add",
          input: {
            tasks: [{ title: "Added through the service" }],
            request_id: "view-files-000001",
          },
        },
        { timeoutMs: 30_000 },
      );
    } finally {
      s.close();
    }
    const file = await waitFor(
      () => readdirSync(view).find((name) => name.endsWith("-added-through-the-service.md")),
      30_000,
      "the new task's file",
    );
    const abs = join(view, file);
    expect(readFileSync(abs, "utf8")).toContain("# Added through the service");

    chmodSync(abs, 0o600);
    writeFileSync(abs, "A person's edit.\n");
    const user = await classSession(home, service.endpoint.path, "cli-interactive");
    try {
      const result = (await user.call(
        "view/rebuild",
        { space: folder },
        { timeoutMs: 30_000 },
      )) as Record<string, unknown>;
      expect(result).toMatchObject({ queued: 1, forgotten: 0 });
      expect(Number(result["checked"])).toBeGreaterThanOrEqual(3);
    } finally {
      user.close();
    }
    expect(readFileSync(abs, "utf8")).toContain("# Added through the service");
    const rescued = join(folder, "rescued");
    const [box] = readdirSync(rescued);
    expect(readFileSync(join(rescued, box ?? "", file), "utf8")).toBe("A person's edit.\n");
  }, 120_000);
});
