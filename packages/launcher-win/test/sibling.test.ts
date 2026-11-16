// The launchers' sibling repair (A2 3.12.3 step 10, A7 3.13 M6.13): an update cut off between the
// two renames of one stable launcher leaves the command folder without it, and the other one,
// started from there while the update's journal is there, puts it back before it runs anything,
// from the version folder current names and from nothing else. Real release builds in temporary
// installs; the stub entry reports what ran. Windows only: elsewhere every test is collected and
// skipped.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildLaunchers, type Launchers } from "../src/build.ts";
import {
  addVersion,
  launchVersion,
  makeStable,
  prepareRuntime,
  removeDir,
  run,
  stable,
  tempDir,
  versionLocal,
  windows,
} from "./install.ts";

const OLD = "0.1.0";
const NEW = "0.2.0";

describe.runIf(windows)(
  "[A2.3.12.3.launcher-win.sibling] a stable launcher puts back its missing sibling from the version current names",
  () => {
    let work: string;
    let release: Launchers;
    let other: Launchers;
    let count = 0;

    beforeAll(() => {
      work = tempDir("sibling");
      prepareRuntime(work);
      release = buildLaunchers(join(work, "release"));
      // A second set whose files differ from the release build's, so a test can tell which
      // version's launcher was put back.
      other = buildLaunchers(join(work, "other"), { testHooks: true });
    }, 300_000);

    afterAll(() => {
      removeDir(work);
    });

    /**
     * A TASKS_HOME install (home.marker, so its state folder is <root>\state) with OLD (release
     * launchers) and NEW (the other set) in versions\, `current` naming `version`, the release
     * launchers in bin\, and an update's journal in state\: an update of it was cut off (only the
     * journal's existence counts for the launcher).
     */
    function install(version: string): string {
      count += 1;
      const root = join(work, `root-${String(count)}`);
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "home.marker"), "");
      addVersion(root, OLD, release);
      addVersion(root, NEW, other);
      makeStable(root, version, release);
      mkdirSync(join(root, "state"), { recursive: true });
      writeFileSync(journal(root), "{}");
      return root;
    }

    const journal = (root: string) => join(root, "state", "update.json");

    const bin = (root: string, name: string) => join(root, "bin", name);
    const own = (root: string, version: string, name: string) =>
      join(root, "versions", version, "bin", name);
    const bytes = (path: string) => readFileSync(path);

    test("tasks.exe puts back a missing tasksw.exe, a copy of the one of the version current names, and runs as before", () => {
      const root = install(NEW);
      rmSync(bin(root, "tasksw.exe"));
      // Files only the journal could vouch for are never what it places.
      writeFileSync(bin(root, "tasksw.exe.new"), "planted new");
      writeFileSync(bin(root, "tasksw.exe.old-7"), "planted old");
      const ran = run(stable(root), ["version"]);
      expect(ran.status, ran.stderr).toBe(0);
      expect(JSON.parse(ran.stdout)).toMatchObject({ version: NEW });
      expect(ran.stderr).toMatch(/put .*tasksw\.exe back from versions\\0\.2\.0/);
      expect(bytes(bin(root, "tasksw.exe"))).toEqual(bytes(own(root, NEW, "tasksw.exe")));
      expect(bytes(bin(root, "tasksw.exe"))).not.toEqual(bytes(own(root, OLD, "tasksw.exe")));
      expect(readFileSync(bin(root, "tasksw.exe.new"), "utf8")).toBe("planted new");
      expect(readFileSync(bin(root, "tasksw.exe.old-7"), "utf8")).toBe("planted old");
      // Nothing else in bin: no temporary file is left.
      expect(readdirSync(join(root, "bin")).sort()).toEqual([
        "tasks.exe",
        "tasksw.exe",
        "tasksw.exe.new",
        "tasksw.exe.old-7",
      ]);
      // A second start finds it there and says nothing.
      const again = run(stable(root), ["version"]);
      expect(again.status).toBe(0);
      expect(again.stderr).toBe("");
    });

    test("tasksw.exe puts back a missing tasks.exe, with arguments and as the supervisor", () => {
      const root = install(OLD);
      rmSync(bin(root, "tasks.exe"));
      expect(launchVersion(stable(root, true)).version).toBe(OLD);
      expect(bytes(bin(root, "tasks.exe"))).toEqual(bytes(own(root, OLD, "tasks.exe")));

      // The supervisor (no arguments) repairs before it starts the service: the stub exits 0.
      rmSync(bin(root, "tasks.exe"));
      mkdirSync(join(root, "stub"));
      writeFileSync(join(root, "stub", "plan.json"), JSON.stringify([{ exit: 0 }]));
      const supervised = run(stable(root, true), [], {
        env: { TASKS_STUB_DIR: join(root, "stub") },
      });
      expect(supervised.status).toBe(0);
      expect(bytes(bin(root, "tasks.exe"))).toEqual(bytes(own(root, OLD, "tasks.exe")));
      expect(readdirSync(join(root, "bin")).sort()).toEqual(["tasks.exe", "tasksw.exe"]);
    });

    test("with nothing it may copy, it places nothing and the launcher goes on as it would have", () => {
      const cases: [label: string, setUp: (root: string) => void, status: number][] = [
        [
          "the version current names has no tasksw.exe",
          (root) => {
            rmSync(own(root, NEW, "tasksw.exe"));
          },
          0,
        ],
        [
          "a junction at the version's bin",
          (root) => {
            const elsewhere = join(work, `elsewhere-${String(count)}`);
            mkdirSync(elsewhere);
            copyFileSync(release.tasksw, join(elsewhere, "tasksw.exe"));
            rmSync(join(root, "versions", NEW, "bin"), { recursive: true });
            symlinkSync(elsewhere, join(root, "versions", NEW, "bin"), "junction");
          },
          0,
        ],
        [
          "current holds no valid version",
          (root) => {
            writeFileSync(join(root, "current"), "..");
          },
          70,
        ],
      ];
      for (const [label, setUp, status] of cases) {
        const root = install(NEW);
        rmSync(bin(root, "tasksw.exe"));
        setUp(root);
        const ran = run(stable(root), ["version"]);
        expect(ran.status, `${label}: ${ran.stderr}`).toBe(status);
        expect(existsSync(bin(root, "tasksw.exe")), label).toBe(false);
        expect(readdirSync(join(root, "bin")), label).toEqual(["tasks.exe"]);
        if (status === 0) {
          expect(ran.stderr, label).toMatch(/tasksw\.exe is missing and could not be put back/);
        } else {
          // Only resolve's own message: the repair says nothing about a bad current.
          expect(ran.stderr.trim().split("\n"), label).toHaveLength(1);
        }
      }
    });

    test("without an update's journal a missing sibling is left missing and nothing is said: no update is under way, and what manages bin then (install --finish and its undo, an uninstall) is not raced", () => {
      const cases: [label: string, setUp: (root: string) => void][] = [
        [
          "no journal",
          (root) => {
            rmSync(journal(root));
          },
        ],
        [
          "a journal behind a junction at state",
          (root) => {
            const elsewhere = join(work, `state-elsewhere-${String(count)}`);
            mkdirSync(elsewhere);
            writeFileSync(join(elsewhere, "update.json"), "{}");
            rmSync(join(root, "state"), { recursive: true });
            symlinkSync(elsewhere, join(root, "state"), "junction");
          },
        ],
        [
          "a folder at the journal's name",
          (root) => {
            rmSync(journal(root));
            mkdirSync(journal(root));
          },
        ],
      ];
      for (const [label, setUp] of cases) {
        const root = install(NEW);
        rmSync(bin(root, "tasksw.exe"));
        setUp(root);
        const ran = run(stable(root), ["version"]);
        expect(ran.status, `${label}: ${ran.stderr}`).toBe(0);
        expect(JSON.parse(ran.stdout), label).toMatchObject({ version: NEW });
        expect(ran.stderr, label).toBe("");
        expect(readdirSync(join(root, "bin")), label).toEqual(["tasks.exe"]);
      }
    });

    test("a present sibling, a folder at its name, a version-local launcher and a launcher outside bin are left alone", () => {
      // A sibling of another version (an update cut off after the first launcher was swapped)
      // still runs: Node's repair brings it to the journal's side, not the launcher.
      const mismatched = install(NEW);
      const before = bytes(bin(mismatched, "tasksw.exe"));
      expect(run(stable(mismatched), ["version"]).status).toBe(0);
      expect(bytes(bin(mismatched, "tasksw.exe"))).toEqual(before);

      const folder = install(NEW);
      rmSync(bin(folder, "tasksw.exe"));
      mkdirSync(bin(folder, "tasksw.exe"));
      expect(run(stable(folder), ["version"]).status).toBe(0);
      expect(readdirSync(bin(folder, "tasksw.exe"))).toEqual([]);

      const local = install(NEW);
      rmSync(own(local, NEW, "tasksw.exe"));
      expect(run(versionLocal(local, NEW), ["version"]).status).toBe(0);
      expect(existsSync(own(local, NEW, "tasksw.exe"))).toBe(false);

      // Stable dispatch from a folder that is not the root's bin: the root is its parent, but it
      // is no stable bin folder, so nothing is made beside it.
      const outside = install(NEW);
      mkdirSync(join(outside, "tools"));
      copyFileSync(release.tasks, join(outside, "tools", "tasks.exe"));
      const ran = spawnSync(join(outside, "tools", "tasks.exe"), ["version"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 60_000,
      });
      expect(ran.status, ran.stderr).toBe(0);
      expect(readdirSync(join(outside, "tools"))).toEqual(["tasks.exe"]);
    });

    test("from the daily install's command folder the journal is the data folder's, and share must be a plain folder", () => {
      // The daily layout: <base>\share\tasks with the stable launchers in <base>\bin, and a
      // stand-in profile folder, never the real one: its .tasks\state holds the journal.
      count += 1;
      const base = join(work, `daily-${String(count)}`);
      const root = join(base, "share", "tasks");
      const profile = join(base, "profile");
      mkdirSync(root, { recursive: true });
      addVersion(root, OLD, release);
      addVersion(root, NEW, other);
      makeStable(root, NEW, release);
      const command = join(base, "bin");
      expect(stable(root)).toBe(join(command, "tasks.exe"));
      const start = () => run(stable(root), ["version"], { env: { USERPROFILE: profile } });

      // A journal in <root>\state is not the daily install's: nothing is put back.
      rmSync(join(command, "tasksw.exe"));
      mkdirSync(join(root, "state"));
      writeFileSync(join(root, "state", "update.json"), "{}");
      let ran = start();
      expect([ran.status, ran.stderr]).toEqual([0, ""]);
      expect(readdirSync(command)).toEqual(["tasks.exe"]);

      // The journal in %USERPROFILE%\.tasks\state: the sibling of the version current names.
      mkdirSync(join(profile, ".tasks", "state"), { recursive: true });
      writeFileSync(join(profile, ".tasks", "state", "update.json"), "{}");
      ran = start();
      expect(ran.status, ran.stderr).toBe(0);
      expect(ran.stderr).toMatch(/put .*tasksw\.exe back from versions\\0\.2\.0/);
      expect(bytes(join(command, "tasksw.exe"))).toEqual(bytes(own(root, NEW, "tasksw.exe")));

      // A junction at share: the launcher refuses to run, and the repair reads nothing through it.
      rmSync(join(command, "tasksw.exe"));
      const moved = join(base, "share-real");
      renameSync(join(base, "share"), moved);
      symlinkSync(moved, join(base, "share"), "junction");
      ran = start();
      expect(ran.status).toBe(70);
      expect(readdirSync(command)).toEqual(["tasks.exe"]);
    });
  },
);
