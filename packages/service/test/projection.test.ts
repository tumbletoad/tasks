// The projection in the service (A1 3.13, A1 3.9's maintenance worker): each space open as this
// machine's keeps its `view/` in a worker of its own, or the folder `projection.dir` names; a
// projection.dir among the space's own files is refused; a close stops the worker. Services run
// in this process on temporary homes; fixture spaces only.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId, type Id } from "@tasks/storage";
import { seedMira } from "@tasks/testkit";
import { afterEach, describe, expect, test } from "vitest";
import { startService, type RunningService } from "../src/hub/service.ts";
import {
  readLog,
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

/** This machine's settings for a space, as the preferences step will write them. */
function writeSettings(home: string, spaceId: Id<"sp">, value: object): void {
  mkdirSync(join(stateOf(home), "spaces"), { recursive: true, mode: 0o700 });
  writeFileSync(join(stateOf(home), "spaces", `${spaceId}.json`), JSON.stringify(value), {
    mode: 0o600,
  });
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

const catalogIds = (dir: string): string[] =>
  readFileSync(join(dir, "catalog.jsonl"), "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => (JSON.parse(line) as { id: string }).id);

describe("[A1.5.projection.service] the service keeps each open space's projection in a worker of its own, in view/ or projection.dir", () => {
  test("an open space gets its view/, and a task added through the request path shows in it", async () => {
    const { home, folder } = await setUp("proj");
    const service = await start(home, folder);
    const view = join(folder, "view");
    await waitFor(
      () => (existsSync(join(view, ".projection.json")) ? true : undefined),
      30_000,
      "the first render",
    );
    expect(catalogIds(view)).toHaveLength(12);
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
    await waitFor(
      () => (catalogIds(view).length === 13 ? true : undefined),
      10_000,
      "the catalogue",
    );
    const events = readLog(home).map((e) => e["ev"]);
    expect(events).toContain("space.projection_started");
  });

  test("projection.dir moves the projection out of the space's folder; one inside it is refused and writes nothing", async () => {
    const { root, home, folder, spaceId } = await setUp("projdir");
    const elsewhere = join(root, "synced", "Mira view");
    writeSettings(home, spaceId, { format: 1, projection: { dir: elsewhere } });
    await start(home, folder);
    await waitFor(
      () => (existsSync(join(elsewhere, ".projection.json")) ? true : undefined),
      30_000,
      "the render in projection.dir",
    );
    expect(catalogIds(elsewhere)).toHaveLength(12);
    expect(existsSync(join(folder, "view"))).toBe(false);
    for (const service of running.splice(0)) {
      await service.stop();
      removeRuntimeDir(service);
    }

    // Inside the space's folder, beside its backups: refused.
    const inside = join(folder, "backups", "view");
    writeSettings(home, spaceId, { format: 1, projection: { dir: inside } });
    await start(home, folder);
    await waitFor(
      () =>
        readLog(home).some((e) => e["ev"] === "space.projection_failed" && e["code"] === "EINVAL")
          ? true
          : undefined,
      10_000,
      "the refusal",
    );
    expect(existsSync(inside)).toBe(false);
  });
});
