// The hub reads machine.toml (A2 3.2.4, M2.06): it hosts the enabled
// [[spaces]], takes [log] level, leaves a retired [roots] section as it is, and refuses a file it cannot start
// with (64) with a line that names the key and code but no value. Its problems are acted on after
// service.lock, so a second start still exits 73. Temporary homes and fixture spaces only.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import {
  createSpace,
  DEFAULT_DRIVER,
  newId,
  StorageWorker,
  UnexpectedSpace,
  type Id,
} from "@tasks/storage";
import { checkedDriver } from "@tasks/testkit";
import { afterEach, describe, expect, test } from "vitest";
import { EXIT, ServiceExit } from "../src/hub/exit.ts";
import { startService, type RunningService } from "../src/hub/service.ts";
import { WRITER_LOCK } from "../src/hub/spaces.ts";
import {
  configOf,
  diagnostics,
  EXIT_MS,
  readLog,
  removeRuntimeDir,
  serviceEnv,
  Services,
  stateOf,
  tempRoot,
  waitReady,
  within,
  type ServiceJson,
} from "./harness.ts";

const LONG = 180_000;
const SENTINEL = "SENTINEL-c0nf1g";
const PLAIN = { root: false, elevated: false, package: null } as const;

const services = new Services();
const running: RunningService[] = [];
const cleanups: (() => void)[] = [];
const runtimeDirs: (ServiceJson | undefined)[] = [];

afterEach(async () => {
  for (const service of running.splice(0)) {
    await service.stop();
    removeRuntimeDir(service);
  }
  await services.stopAll();
  for (const json of runtimeDirs.splice(0)) removeRuntimeDir(json);
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function writeToml(home: string, text: string): void {
  mkdirSync(configOf(home), { recursive: true, mode: 0o700 });
  writeFileSync(join(configOf(home), "machine.toml"), text, { mode: 0o600 });
}

/** A TOML string for a path: a literal string, so Windows backslashes read as written. */
const lit = (path: string) => `'${path}'`;

describe("[A2.3.2.4.hub.spaces] the hub hosts machine.toml's spaces and refuses a file it cannot start with", () => {
  test(
    "the enabled [[spaces]] open in order and a disabled one is listed closed, [log] level, and a retired [roots] section is named and left as it is",
    async () => {
      const { root, cleanup } = tempRoot("cfg");
      cleanups.push(cleanup);
      const home = join(root, "h");
      // This machine is the spaces' authority, so the open space is "open".
      const machine = newId("m");
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
      const driver = await checkedDriver();
      const opts = { ownerLabel: "Mira Okafor", machineId: machine };
      const work = createSpace(driver, join(root, "work"), { name: "Work", ...opts });
      const life = createSpace(driver, join(root, "life"), { name: "Life", ...opts });
      writeToml(
        home,
        [
          "# Mira's machine",
          "[log]",
          'level = "debug"',
          "",
          "[[spaces]]",
          `id = "${life.space.spaceId}"`,
          `path = ${lit(life.folder)}`,
          "enabled = false",
          "",
          "[[spaces]]",
          `id = "${work.space.spaceId}"`,
          `path = ${lit(work.folder)}`,
          "",
          "[roots.work]",
          `path = ${lit(root)}`,
          "",
        ].join("\n"),
      );
      // The roots' revisions an older build kept: no longer read or written, and left where it is.
      const revisions = join(stateOf(home), "roots.json");
      const oldRevisions = '{"format":1,"roots":{"work":{"rev":3}}}\n';
      writeFileSync(revisions, oldRevisions, { mode: 0o600 });
      const tomlBefore = readFileSync(join(configOf(home), "machine.toml"));
      const service = await startService({
        env: serviceEnv(home),
        identity: () => PLAIN,
        say: () => undefined,
      });
      running.push(service);
      await service.spacesSettled;
      // A disabled entry is the person's closed space: listed closed, not opened (A2 3.1).
      expect(service.spaces()).toEqual([
        { entry: 0, state: "closed" },
        { entry: 1, state: "open", id: work.space.spaceId },
      ]);
      expect(service.config.spaces.map((s) => [s.id, s.enabled])).toEqual([
        [life.space.spaceId, false],
        [work.space.spaceId, true],
      ]);
      const events = readLog(home);
      // Debug events are logged at [log] level = "debug".
      expect(events.some((e) => e["ev"] === "service.lock_acquired")).toBe(true);
      expect(events.find((e) => e["ev"] === "config.loaded")).toMatchObject({
        present: true,
        spaces: 2,
        instances: 0,
        problems: 1,
      });
      expect(events.filter((e) => e["ev"] === "config.problem")).toEqual([
        expect.objectContaining({ section: "roots", code: "retired", severity: "warning" }),
      ]);
      expect(readFileSync(revisions, "utf8")).toBe(oldRevisions);
      expect(readFileSync(join(configOf(home), "machine.toml")).equals(tomlBefore)).toBe(true);
    },
    LONG,
  );

  test(
    "an invalid [[spaces]] or a file that is not TOML refuses the start with 64, naming keys and codes, never values",
    async () => {
      const { root, cleanup } = tempRoot("cfgbad");
      cleanups.push(cleanup);
      const cases: [string, string][] = [
        [
          `[[spaces]]\nid = "${newId("sp")}"\npath = "${SENTINEL}/relative"\n`,
          "spaces[1].path (not_absolute)",
        ],
        [`[log]\nlevel = "info"\n${SENTINEL} secret = 1\n`, "syntax at line 3, column"],
      ];
      for (const [i, [text, named]] of cases.entries()) {
        const home = join(root, `h${String(i)}`);
        writeToml(home, text);
        const lines: string[] = [];
        const refused = await startService({
          env: serviceEnv(home),
          identity: () => PLAIN,
          say: (line) => lines.push(line),
        }).then(
          (service) => {
            running.push(service);
            return undefined;
          },
          (error: unknown) => error,
        );
        expect(refused).toBeInstanceOf(ServiceExit);
        expect((refused as ServiceExit).code).toBe(EXIT.refused);
        expect(lines.join("\n")).toContain(named);
        expect(lines.join("\n")).not.toContain(SENTINEL);
        const events = readLog(home);
        expect(events.find((e) => e["ev"] === "service.refused")).toMatchObject({
          reason: "invalid_config",
        });
        expect(events.some((e) => e["ev"] === "config.problem" && e["severity"] === "error")).toBe(
          true,
        );
        for (const { text: written } of diagnostics(home)) expect(written).not.toContain(SENTINEL);
        // Refused before machine.json or service.json: nothing of a running service was written.
        expect(readServiceJsonExists(home)).toBe(false);
      }
    },
    LONG,
  );

  test(
    "as processes: a running service keeps its lock, so a second start with a broken file exits 73; alone it exits 64",
    async () => {
      const { root, cleanup } = tempRoot("cfgp");
      cleanups.push(cleanup);
      const home = join(root, "h");
      writeToml(home, "# nothing yet\n");
      const first = services.start(home);
      runtimeDirs.push(await waitReady(home, first.pid));

      writeToml(home, `[[spaces]]\nid = "nope"\npath = "${SENTINEL}"\n`);
      const second = services.start(home);
      expect((await within(second.exit, EXIT_MS, "the second start")).code).toBe(EXIT.locked);

      first.send("stop");
      expect((await within(first.exit, EXIT_MS, "the first stops")).code).toBe(EXIT.ok);
      const third = services.start(home);
      expect((await within(third.exit, EXIT_MS, "the third start")).code).toBe(EXIT.refused);
      expect(third.stderr()).toContain("spaces[1].id (invalid_value)");
      expect(third.stderr()).toContain("spaces[1].path (not_absolute)");
      expect(third.stderr()).not.toContain(SENTINEL);
      for (const { text } of diagnostics(home)) expect(text).not.toContain(SENTINEL);
    },
    LONG,
  );
});

function readServiceJsonExists(home: string): boolean {
  try {
    readFileSync(join(stateOf(home), "service.json"));
    return true;
  } catch {
    return false;
  }
}

/** Every file under `dir` by its path relative to `dir`, with a hash of its bytes. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const name = relative(dir, path).split("\\").join("/");
    files[name] = createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  return files;
}

/**
 * `after` is `before` byte for byte, and nothing is new but the sidecars a read-only open of a
 * closed WAL space leaves (A1 3.1): an empty -wal and the -shm.
 */
function expectUnchanged(before: Record<string, string>, after: Record<string, string>): void {
  const sidecars = ["space.db-wal", "space.db-shm"];
  const kept = Object.fromEntries(
    Object.entries(after).filter(([name]) => !(sidecars.includes(name) && !(name in before))),
  );
  expect(kept).toEqual(before);
}

/** A home whose machine.json names `machine`, so that machine is the spaces' authority. */
function homeWith(root: string, label: string, machine: Id<"m">): string {
  const home = join(root, label);
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
  return home;
}

const spacesToml = (entries: readonly { id: string; path: string }[]): string =>
  entries.map((e) => `[[spaces]]\nid = "${e.id}"\npath = ${lit(e.path)}\n`).join("\n");

describe("[A2.3.2.4.hub.space-id] a [[spaces]] entry opens only the space its ID names (review R2-5)", () => {
  test(
    "the right ID opens; another ID is unavailable(other_space), the folder as it was and its writer.lock free",
    async () => {
      const { root, cleanup } = tempRoot("sid");
      cleanups.push(cleanup);
      const machine = newId("m");
      const work = createSpace(await checkedDriver(), join(root, "work"), {
        name: "Work",
        ownerLabel: "Mira Okafor",
        machineId: machine,
      });
      const before = snapshot(work.folder);

      // Another ID for the folder, with backup upkeep on, so a space opened by mistake would show.
      const wrong = homeWith(root, "wrong", machine);
      writeToml(wrong, spacesToml([{ id: newId("sp"), path: work.folder }]));
      const service = await startService({
        env: serviceEnv(wrong),
        identity: () => PLAIN,
        say: () => undefined,
      });
      running.push(service);
      await service.spacesSettled;
      expect(service.spaces()).toMatchObject([
        { entry: 0, state: "unavailable", reason: "other_space", code: "SPACE_ID_MISMATCH" },
      ]);
      // No registration, migration, backup or leftovers cleanup: the folder is as it was.
      expectUnchanged(before, snapshot(work.folder));
      expect(existsSync(join(work.folder, WRITER_LOCK))).toBe(false);
      const events = readLog(wrong);
      const refused = events.find((e) => e["ev"] === "space.unavailable");
      expect(refused).toEqual(
        expect.objectContaining({ entry: 0, reason: "other_space", code: "SPACE_ID_MISMATCH" }),
      );
      expect(refused).not.toHaveProperty("space");
      for (const ev of ["space.open", "space.read_only", "space.maintained", "space.migrated"]) {
        expect(events.some((e) => e["ev"] === ev)).toBe(false);
      }
      // Nor is the folder changed through that entry later, by a restore in place or a claim.
      await expect(
        service.spaceManager.restoreInPlace(0, join(root, "backup.db.gz")),
      ).rejects.toBeInstanceOf(UnexpectedSpace);
      await expect(service.spaceManager.claim(0)).rejects.toMatchObject({
        code: "STORAGE_MISUSE",
      });
      expectUnchanged(before, snapshot(work.folder));

      // The service still runs and holds nothing of the folder: another writer takes it.
      const worker = await StorageWorker.start({ driver: DEFAULT_DRIVER });
      try {
        const writer = await worker.openSpaceWriter(work.folder, {
          machine: { id: machine, name: "fixture-machine", os: "linux" },
        });
        expect(writer.spaceId).toBe(work.space.spaceId);
        await writer.close();
      } finally {
        await worker.close();
      }
      expect(service.status().state).toBe("ready");

      // The right ID opens it.
      const right = homeWith(root, "right", machine);
      writeToml(right, spacesToml([{ id: work.space.spaceId, path: work.folder }]));
      const opened = await startService({
        env: serviceEnv(right),
        identity: () => PLAIN,
        say: () => undefined,
        maintenance: false,
      });
      running.push(opened);
      await opened.spacesSettled;
      expect(opened.spaces()).toEqual([{ entry: 0, state: "open", id: work.space.spaceId }]);
    },
    LONG,
  );

  test(
    "two entries that reach one folder under two IDs: the one its space names opens, the other is unavailable",
    async () => {
      const { root, cleanup } = tempRoot("sid2");
      cleanups.push(cleanup);
      const machine = newId("m");
      mkdirSync(join(root, "spaces"));
      const work = createSpace(await checkedDriver(), join(root, "spaces", "work"), {
        name: "Work",
        ownerLabel: "Mira Okafor",
        machineId: machine,
      });
      // A second path to the same folder (a junction on Windows, which needs no privilege).
      const alias = join(root, "spaces", "alias");
      symlinkSync(work.folder, alias, process.platform === "win32" ? "junction" : "dir");
      const home = homeWith(root, "h", machine);
      // The entry with the other ID first, so it starts before the right one.
      writeToml(
        home,
        spacesToml([
          { id: newId("sp"), path: alias },
          { id: work.space.spaceId, path: work.folder },
        ]),
      );
      const service = await startService({
        env: serviceEnv(home),
        identity: () => PLAIN,
        say: () => undefined,
        maintenance: false,
      });
      running.push(service);
      await service.spacesSettled;
      expect(service.spaces()).toMatchObject([
        { entry: 0, state: "unavailable", reason: "other_space", code: "SPACE_ID_MISMATCH" },
        { entry: 1, state: "open", id: work.space.spaceId },
      ]);
      expect(
        readLog(home)
          .filter((e) => e["ev"] === "space.open")
          .map((e) => e["entry"]),
      ).toEqual([1]);
    },
    LONG,
  );

  test(
    "an entry whose folder holds no space is unavailable(missing), and the folder stays as it was",
    async () => {
      const { root, cleanup } = tempRoot("sid3");
      cleanups.push(cleanup);
      const empty = join(root, "empty");
      mkdirSync(empty);
      const other = join(root, "other");
      mkdirSync(other);
      writeFileSync(join(other, "notes.txt"), "not a space\n");
      const before = snapshot(other);
      const home = join(root, "h");
      writeToml(
        home,
        spacesToml([
          { id: newId("sp"), path: empty },
          { id: newId("sp"), path: other },
        ]),
      );
      const service = await startService({
        env: serviceEnv(home),
        identity: () => PLAIN,
        say: () => undefined,
      });
      running.push(service);
      await service.spacesSettled;
      expect(service.spaces()).toMatchObject([
        { entry: 0, state: "unavailable", reason: "missing", code: "SPACE_NOT_FOUND" },
        { entry: 1, state: "unavailable", reason: "missing", code: "SPACE_NOT_FOUND" },
      ]);
      expect(readdirSync(empty)).toEqual([]);
      expect(snapshot(other)).toEqual(before);
    },
    LONG,
  );

  test(
    "an entry without an ID refuses the start with 64, and machine.toml is not rewritten to add one",
    async () => {
      const { root, cleanup } = tempRoot("sid4");
      cleanups.push(cleanup);
      const work = createSpace(await checkedDriver(), join(root, "work"), {
        name: "Work",
        ownerLabel: "Mira Okafor",
        machineId: newId("m"),
      });
      const home = join(root, "h");
      const text = `# no ID yet\n[[spaces]]\npath = ${lit(work.folder)}\n`;
      writeToml(home, text);
      const lines: string[] = [];
      const refused = await startService({
        env: serviceEnv(home),
        identity: () => PLAIN,
        say: (line) => lines.push(line),
      }).then(
        (service) => {
          running.push(service);
          return undefined;
        },
        (error: unknown) => error,
      );
      expect((refused as ServiceExit).code).toBe(EXIT.refused);
      expect(lines.join("\n")).toContain("spaces[1].id (missing)");
      expect(readFileSync(join(configOf(home), "machine.toml"), "utf8")).toBe(text);
    },
    LONG,
  );
});
