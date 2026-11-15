// The projection in the service (A1 3.13, A1 3.9's maintenance worker): each space open as this
// machine's keeps its `view/` in a worker of its own, with its trusted record beside the space's
// machine-local settings; `tasks view rebuild` (`view/rebuild`) renders what is missing or
// different again, for the user only; a close stops the worker. Services run in this process on
// temporary homes; fixture spaces only.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { RpcError } from "@tasks/bridge/protocol";
import { backupSpace, newId, type Id } from "@tasks/storage";
import { checkedDriver, seedMira } from "@tasks/testkit";
import { afterEach, describe, expect, test } from "vitest";
import { startService, type RunningService } from "../src/hub/service.ts";
import { projectionStateOf } from "../src/hub/space-settings.ts";
import {
  readLog,
  registerSpaces,
  removeRuntimeDir,
  serviceEnv,
  stateOf,
  tempRoot,
  waitFor,
} from "./harness.ts";
import { classSession, errorOf } from "./ops-helpers.ts";

const running: RunningService[] = [];
const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const service of running.splice(0)) {
    await service.stop();
    removeRuntimeDir(service);
  }
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A home whose machine.json names `machine`, and the Mira sample in `<root>/spaces/mira`. */
async function setUp(label: string) {
  const { root, cleanup } = tempRoot(label);
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
  const seeded = await seedMira(join(root, "spaces"), { tasks: 12, machineId: machine });
  const manifest = JSON.parse(readFileSync(join(seeded.folder, "space.json"), "utf8")) as {
    space_id: Id<"sp">;
  };
  return { root, home, folder: seeded.folder, spaceId: manifest.space_id };
}

async function start(home: string, folder: string): Promise<RunningService> {
  registerSpaces(home, [folder]);
  const service = await startService({
    env: serviceEnv(home),
    identity: () => ({ root: false, elevated: false, package: null }),
    say: () => undefined,
  });
  running.push(service);
  await service.spacesSettled;
  return service;
}

const catalog = (dir: string): { id: string; path: string }[] =>
  readFileSync(join(dir, "catalog.jsonl"), "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => JSON.parse(line) as { id: string; path: string });

describe("[A1.5.projection.service] the service keeps each open space's projection in a worker of its own, in its view/, with its trusted state in machine state", () => {
  test("an open space gets its view/ and its record beside its settings, and a task added through the request path shows in it", async () => {
    const { home, folder, spaceId } = await setUp("proj");
    const service = await start(home, folder);
    const view = join(folder, "view");
    await waitFor(
      () => (existsSync(join(view, ".projection.json")) ? true : undefined),
      30_000,
      "the first render",
    );
    expect(catalog(view)).toHaveLength(12);
    // The record that authorizes the projection's acts is the product's state, not the tree's,
    // and the space's folder's own: two folders that hold one space never share one.
    const state = projectionStateOf(stateOf(home), spaceId, folder);
    expect(existsSync(state.record)).toBe(true);
    expect(state.record).not.toBe(projectionStateOf(stateOf(home), spaceId, `${folder}-copy`).record);
    expect(readdirSync(view).filter((name) => name.startsWith(".projection-"))).toEqual([]);
    const s = await classSession(home, service.endpoint.path, "cli-script");
    try {
      await s.call(
        "op/call",
        {
          op: "task.add",
          input: {
            tasks: [{ title: "Added through the service" }],
            request_id: "projection-service-000001",
          },
        },
        { timeoutMs: 30_000 },
      );
    } finally {
      s.close();
    }
    const t0 = performance.now();
    const name = await waitFor(
      () =>
        readdirSync(join(view, "open")).find((file) =>
          file.endsWith("-added-through-the-service.md"),
        ),
      10_000,
      "the new task's file",
      5,
    );
    const ms = performance.now() - t0;
    expect(name).toMatch(/^M-13-added-through-the-service\.md$/);
    // The Verify line's 1 s is asserted where nothing but the projection runs (loop.test.ts);
    // here the request path's answer and the worker's hops come on top, on a loaded machine.
    expect(ms).toBeLessThan(10_000);
    await waitFor(() => (catalog(view).length === 13 ? true : undefined), 10_000, "the catalogue");
    const events = readLog(home).map((e) => e["ev"]);
    expect(events).toContain("space.projection_started");
    expect(events).toContain("space.projection_reconciled");
  }, 120_000);

  test("tasks view rebuild: a deleted file comes back and an edited one is moved aside and rendered again; only the user may ask", async () => {
    const { home, folder, spaceId } = await setUp("projreb");
    const service = await start(home, folder);
    const view = join(folder, "view");
    await waitFor(
      () => (existsSync(join(view, ".projection.json")) ? true : undefined),
      30_000,
      "the first render",
    );
    const [first, second] = catalog(view);
    const deleted = join(view, ...(first?.path ?? "").split("/"));
    const edited = join(view, ...(second?.path ?? "").split("/"));
    chmodSync(deleted, 0o600);
    rmSync(deleted);
    chmodSync(edited, 0o600);
    writeFileSync(edited, "A person's edit.\n");
    for (const cls of ["cli-script", "cli-agent"] as const) {
      const s = await classSession(
        home,
        service.endpoint.path,
        cls,
        cls === "cli-agent" ? { CLAUDECODE: "1" } : {},
      );
      try {
        const error = await s.call("view/rebuild", { space: folder }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(RpcError);
        expect(errorOf(error)).toMatchObject({ code: "forbidden" });
      } finally {
        s.close();
      }
    }
    const user = await classSession(home, service.endpoint.path, "cli-interactive");
    try {
      const result = (await user.call(
        "view/rebuild",
        { space: folder },
        { timeoutMs: 30_000 },
      )) as Record<string, unknown>;
      expect(result).toMatchObject({ checked: 16, queued: 12, forgotten: 0 });
    } finally {
      user.close();
    }
    await waitFor(
      () =>
        existsSync(deleted) && readFileSync(edited, "utf8").startsWith("---\ngenerated: true\n")
          ? true
          : undefined,
      30_000,
      "the rebuild",
    );
    const rescued = join(folder, "exchange", "rescued");
    const [box] = readdirSync(rescued);
    expect(
      readFileSync(join(rescued, box ?? "", "view", ...(second?.path ?? "").split("/")), "utf8"),
    ).toBe("A person's edit.\n");
    // The rescue is in the space's settings for the UI to show once, by its batch's stem.
    const settings = join(stateOf(home), "spaces", `${spaceId}.json`);
    const listed = await waitFor(
      () => {
        if (!existsSync(settings)) return undefined;
        const value = JSON.parse(readFileSync(settings, "utf8")) as {
          projection_rescues?: { stem: string; files: number }[];
        };
        return value.projection_rescues?.length === 1 ? value.projection_rescues : undefined;
      },
      30_000,
      "the record of the rescue",
    );
    expect(listed).toEqual([
      expect.objectContaining({ stem: `exchange/rescued/${(box ?? "").replace(/-1$/, "")}`, files: 1 }),
    ]);
  }, 120_000);

  test("a restore in place stops the projection before the swap, and the restored space is projected anew", async () => {
    const { home, folder } = await setUp("projrip");
    const backup = await backupSpace(await checkedDriver(), folder, { kind: "manual" });
    const service = await start(home, folder);
    const claim = join(folder, "view", ".projection.json");
    await waitFor(() => (existsSync(claim) ? true : undefined), 30_000, "the first render");
    const before = (JSON.parse(readFileSync(claim, "utf8")) as { incarnation: string }).incarnation;
    // The projection's worker holds a reader of the database and files of the folder: the swap
    // fails on Windows unless the close stopped it first.
    const change = await service.spaceManager.restoreInPlace(0, backup.file);
    expect(change.incarnation).not.toBe(before);
    await waitFor(
      () =>
        existsSync(claim) &&
        (JSON.parse(readFileSync(claim, "utf8")) as { incarnation: string }).incarnation ===
          change.incarnation
          ? true
          : undefined,
      30_000,
      "the restored space's render",
    );
    expect(catalog(join(folder, "view"))).toHaveLength(12);
  }, 120_000);
});
