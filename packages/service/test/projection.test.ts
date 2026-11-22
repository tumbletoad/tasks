// The projection in the service (A1 3.13, A1 3.9's maintenance worker): each space open as this
// machine's keeps its `view/` in a worker of its own, with its trusted record beside the space's
// machine-local settings; `ttasks view rebuild` (`view/rebuild`) renders what is missing or
// different again, for the user only; a close stops the worker. Services run in this process on
// temporary homes; fixture spaces only.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { RpcError } from "@ttasks/bridge/protocol";
import { backupSpace, newId, type Id } from "@ttasks/storage";
import { checkedDriver, seedMira } from "@ttasks/testkit";
import { afterEach, describe, expect, test } from "vitest";
import { startService, type RunningService } from "../src/hub/service.ts";
import { projectionStateOf, recordProjectionRescue } from "../src/hub/space-settings.ts";
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
    expect(state.record).not.toBe(
      projectionStateOf(stateOf(home), spaceId, `${folder}-copy`).record,
    );
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

  test("ttasks view rebuild: a deleted file comes back and an edited one is moved aside and rendered again; only the user may ask", async () => {
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
    // The edited file is moved aside before it is rendered again, so a poll may find none there.
    const renderedAgain = (): boolean => {
      try {
        return readFileSync(edited, "utf8").startsWith("---\ngenerated: true\n");
      } catch {
        return false;
      }
    };
    await waitFor(
      () => (existsSync(deleted) && renderedAgain() ? true : undefined),
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
      expect.objectContaining({
        stem: `exchange/rescued/${(box ?? "").replace(/-1$/, "")}`,
        files: 1,
      }),
    ]);
  }, 120_000);

  test("a folder a person left at the projection's journal path (a mistaken restore of the machine state) is moved aside beside it, whole, and logged; the space's view renders", async () => {
    const { home, folder, spaceId } = await setUp("projaside");
    const state = projectionStateOf(stateOf(home), spaceId, folder);
    // The folder of space settings as the service makes it (0700, which it checks at start, A2
    // 3.2.2 rule 5), and in it the person's folder with whatever mode the umask gives it.
    mkdirSync(join(stateOf(home), "spaces"), { mode: 0o700 });
    mkdirSync(state.journal);
    writeFileSync(join(state.journal, "notes.txt"), "A person's notes.\n");
    await start(home, folder);
    const view = join(folder, "view");
    await waitFor(
      () => (existsSync(join(view, ".projection.json")) ? true : undefined),
      30_000,
      "the first render",
    );
    expect(catalog(view)).toHaveLength(12);
    const spaces = join(stateOf(home), "spaces");
    const name = basename(state.journal);
    const [aside, ...more] = readdirSync(spaces).filter((entry) =>
      entry.startsWith(`${name}.moved-aside-`),
    );
    expect(more).toEqual([]);
    expect(readFileSync(join(spaces, aside ?? "", "notes.txt"), "utf8")).toBe(
      "A person's notes.\n",
    );
    // The projector may already have written a new journal file there for its next batch.
    expect(statSync(state.journal, { throwIfNoEntry: false })?.isDirectory() ?? false).toBe(false);
    const logged = readLog(home).filter((e) => e["ev"] === "space.projection_state_moved_aside");
    expect(logged).toEqual([expect.objectContaining({ file: "journal" })]);
    expect(readLog(home).some((e) => e["ev"] === "space.projection_failed")).toBe(false);
  }, 120_000);

  test("a batch's rescues told again after a kill are listed once, by their stem", () => {
    const { root, cleanup } = tempRoot("projrsc");
    cleanups.push(cleanup);
    const state = join(root, "state");
    const spaceId = newId("sp");
    const stem = "exchange/rescued/20261114T080000000Z-0a1b";
    recordProjectionRescue(state, spaceId, { stem, files: 2 });
    recordProjectionRescue(state, spaceId, { stem, files: 2 });
    recordProjectionRescue(state, spaceId, {
      stem: "exchange/rescued/20261114T080001000Z-0a1c",
      files: 1,
    });
    const value = JSON.parse(readFileSync(join(state, "spaces", `${spaceId}.json`), "utf8")) as {
      projection_rescues: { stem: string; files: number }[];
    };
    expect(value.projection_rescues.map((r) => [r.stem, r.files])).toEqual([
      [stem, 2],
      ["exchange/rescued/20261114T080001000Z-0a1c", 1],
    ]);
  });

  test("a rescue is answered only once it is saved: one whose save failed is told again at the next start, and a settings file that does not read back is never written over", async () => {
    const { home, folder, spaceId } = await setUp("projsave");
    const first = await start(home, folder);
    const view = join(folder, "view");
    await waitFor(
      () => (existsSync(join(view, ".projection.json")) ? true : undefined),
      30_000,
      "the first render",
    );
    // The space's settings stop reading back (a tool wrote over them, a cut copy): saving the
    // rescue must fail rather than write over what they held.
    const settings = join(stateOf(home), "spaces", `${spaceId}.json`);
    writeFileSync(settings, '{"backup": {"dir": ', { mode: 0o600 });
    const [line] = catalog(view);
    const edited = join(view, ...(line?.path ?? "").split("/"));
    chmodSync(edited, 0o600);
    writeFileSync(edited, "A person's edit while the settings are broken.\n");
    const user = await classSession(home, first.endpoint.path, "cli-interactive");
    try {
      await user.call("view/rebuild", { space: folder }, { timeoutMs: 30_000 });
    } finally {
      user.close();
    }
    await waitFor(
      () =>
        readLog(home).some((e) => e["ev"] === "space.projection_failed" && e["code"] === "EIO")
          ? true
          : undefined,
      30_000,
      "the failed save",
    );
    expect(readFileSync(settings, "utf8")).toBe('{"backup": {"dir": ');
    const rescued = join(folder, "exchange", "rescued");
    const [box] = readdirSync(rescued);
    expect(
      readFileSync(join(rescued, box ?? "", "view", ...(line?.path ?? "").split("/")), "utf8"),
    ).toBe("A person's edit while the settings are broken.\n");
    await first.stop();
    removeRuntimeDir(first);
    running.splice(running.indexOf(first), 1);
    // The person repairs the settings; the next start tells the rescue its folders still show.
    rmSync(settings);
    await start(home, folder);
    const listed = await waitFor(
      () => {
        if (!existsSync(settings)) return undefined;
        const value = JSON.parse(readFileSync(settings, "utf8")) as {
          projection_rescues?: { stem: string; files: number }[];
        };
        return value.projection_rescues?.length === 1 ? value.projection_rescues : undefined;
      },
      30_000,
      "the rescue told again",
    );
    expect(listed).toEqual([
      expect.objectContaining({
        stem: `exchange/rescued/${(box ?? "").replace(/-1$/, "")}`,
        files: 1,
      }),
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
