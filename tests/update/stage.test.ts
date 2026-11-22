// The stable launchers' staging and swap (A2 3.12.6 steps 8, 10 and 14; A7 3.13 M6.13) in-process:
// the swap primitive on fixture files on every system, a running program's refusals on Windows,
// and the update's staging and the repair's use of staged copies on fixture installs. The real
// builds, kills and starts are in installed*.test.ts and launchers-*.test.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { PRODUCT_ID } from "../../packages/brand/src/index.ts";
import {
  UPDATE_JOURNAL,
  writeJournal,
  type Journal,
} from "../../packages/service/src/version/journal.ts";
import { repairLocked, supervisorReplaced } from "../../packages/service/src/version/repair.ts";
import {
  cleanLaunchers,
  currentFor,
  placeLauncher,
  stagedPath,
  stageLauncher,
  writeCurrent,
  type SwapPoint,
} from "../../packages/service/src/version/switch.ts";
import {
  rollbackUpdate,
  updateFromArchive,
  UpdateError,
} from "../../packages/service/src/version/update.ts";
import {
  currentOf,
  fakeSelfTest,
  FakeControl,
  fixtureInstall,
  fixtureRelease,
  keyLine,
  scratch,
  throwawayKey,
  windows,
} from "./fixture.ts";

const os = process.platform;
const CONSOLE = `${PRODUCT_ID}.exe`;
const GUI = `${PRODUCT_ID}w.exe`;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});

function folder(label: string): string {
  const made = scratch(label);
  cleanups.push(made.remove);
  return made.dir;
}

const sha = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/**
 * A real program that stays running from `path` (Windows): a copy of ping.exe, which Windows then
 * refuses to replace or delete through that name, as a running launcher. Stopped after the test.
 */
async function runFrom(path: string): Promise<ChildProcess> {
  const system = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32");
  copyFileSync(join(system, "PING.EXE"), path);
  const child = spawn(path, ["-n", "60", "127.0.0.1"], { stdio: "ignore", windowsHide: true });
  await once(child, "spawn");
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit");
    }
  });
  return child;
}

describe("[A2.3.12.6.update.stage] launchers staged before the switch, replaced by one rename where the OS allows it, and cleaned once no journal names them", () => {
  test("the swap: a missing launcher is renamed in; one a version folder holds is replaced by one rename; any other is kept aside", () => {
    const dir = folder("swap");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const path = join(bin, CONSOLE);
    const keeper = join(dir, "kept.exe");
    writeFileSync(keeper, "old launcher");
    const steps: SwapPoint[] = [];
    const at = (point: SwapPoint) => steps.push(point);

    // Nothing there: the staged copy is renamed in.
    writeFileSync(stagedPath(path), "new launcher");
    expect(placeLauncher(path, stagedPath(path), sha("new launcher"), { at })).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe("new launcher");
    expect(existsSync(stagedPath(path))).toBe(false);
    expect(steps.splice(0)).toEqual(["placed"]);

    // A launcher that a version folder holds and that does not run: one rename, no aside copy,
    // and no moment at which the stable path is missing.
    writeFileSync(path, "old launcher");
    writeFileSync(stagedPath(path), "new launcher");
    expect(
      placeLauncher(path, stagedPath(path), sha("new launcher"), { keptIn: [keeper], at }),
    ).toBeUndefined();
    expect(steps.splice(0)).toEqual(["placed"]);
    expect(readdirSync(bin)).toEqual([CONSOLE]);

    // One nothing else holds is kept aside, for a rollback or an undo that needs it back.
    writeFileSync(path, "someone's launcher");
    writeFileSync(stagedPath(path), "new launcher");
    expect(
      placeLauncher(path, stagedPath(path), sha("new launcher"), { keptIn: [keeper], at }),
    ).toBe(`${path}.old-1`);
    expect(steps.splice(0)).toEqual(["aside", "placed"]);
    expect(readFileSync(`${path}.old-1`, "utf8")).toBe("someone's launcher");

    // A source that does not hold the digest is refused, and nothing changes.
    writeFileSync(stagedPath(path), "tampered");
    expect(() => placeLauncher(path, stagedPath(path), sha("other"), { at })).toThrow(
      /does not match/,
    );
    expect(readFileSync(path, "utf8")).toBe("new launcher");
    // A copy from elsewhere goes through a checked temporary file that does not stay behind.
    expect(placeLauncher(path, keeper, sha("old launcher"), { keptIn: [keeper] })).toBeDefined();
    expect(readFileSync(path, "utf8")).toBe("old launcher");
    expect(readdirSync(bin).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("staging writes a checked copy beside the stable launcher; the clean-up removes aside, staged and temporary launchers, and only the stable launchers' own", () => {
    const dir = folder("stage");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const source = join(dir, "source.exe");
    writeFileSync(source, "new launcher");
    stageLauncher(join(bin, CONSOLE), source, sha("new launcher"));
    expect(readFileSync(stagedPath(join(bin, CONSOLE)), "utf8")).toBe("new launcher");
    expect(() => {
      stageLauncher(join(bin, GUI), source, sha("something else"));
    }).toThrow(/does not match/);
    expect(existsSync(stagedPath(join(bin, GUI)))).toBe(false);

    writeFileSync(join(bin, CONSOLE), "current launcher");
    writeFileSync(join(bin, `${CONSOLE}.old-1`), "aside");
    writeFileSync(join(bin, `${GUI}.old-12`), "aside");
    writeFileSync(join(bin, `.${GUI}.1234-5678-0.tmp`), "a sibling repair's leftover");
    writeFileSync(join(bin, `.${CONSOLE}.99.0a1b2c3d.tmp`), "a swap's leftover");
    // Not the stable launchers' own: kept.
    writeFileSync(join(bin, "notes.txt.old-1"), "someone's");
    writeFileSync(join(bin, `${CONSOLE}.old-x`), "someone's");
    mkdirSync(join(bin, `${GUI}.new`));
    // An aside copy with another hard link: a refused delete would prove nothing, so it is kept.
    writeFileSync(join(dir, "linked"), "aside");
    linkSync(join(dir, "linked"), join(bin, `${CONSOLE}.old-2`));
    expect(cleanLaunchers(dir)).toBe(5);
    expect(readdirSync(bin).sort()).toEqual(
      [CONSOLE, `${CONSOLE}.old-2`, `${CONSOLE}.old-x`, `${GUI}.new`, "notes.txt.old-1"].sort(),
    );
  });

  test.runIf(windows)(
    "a running launcher cannot be replaced: it is renamed aside and the new one renamed in; its aside copy is kept while it runs; one a sibling repair put in place counts as swapped",
    async () => {
      const dir = folder("running");
      const bin = join(dir, "bin");
      mkdirSync(bin);
      const path = join(bin, CONSOLE);
      const running = await runFrom(path);
      const old = sha(readFileSync(path));
      const keeper = join(dir, "kept.exe");
      copyFileSync(path, keeper);
      writeFileSync(stagedPath(path), "new launcher");
      const steps: SwapPoint[] = [];
      expect(
        placeLauncher(path, stagedPath(path), sha("new launcher"), {
          keptIn: [keeper],
          at: (point) => steps.push(point),
        }),
      ).toBe(`${path}.old-1`);
      // The one rename was refused (it runs), so the two renames ran.
      expect(steps).toEqual(["aside", "placed"]);
      expect(readFileSync(path, "utf8")).toBe("new launcher");
      expect(sha(readFileSync(`${path}.old-1`))).toBe(old);
      // The clean-up cannot remove the aside copy while the program runs from it...
      expect(cleanLaunchers(dir)).toBe(0);
      expect(existsSync(`${path}.old-1`)).toBe(true);
      // ...and removes it once it ended.
      running.kill();
      await once(running, "exit");
      expect(cleanLaunchers(dir)).toBe(1);
      expect(readdirSync(bin)).toEqual([CONSOLE]);

      // Between the two renames a launcher's sibling repair puts the wanted launcher in place, and
      // a client starts it at once: the rename onto it is refused, and the swap counts as done.
      const gui = join(bin, GUI);
      writeFileSync(gui, "old gui");
      const system = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32");
      copyFileSync(join(system, "PING.EXE"), stagedPath(gui));
      const want = sha(readFileSync(stagedPath(gui)));
      let client: ChildProcess | undefined;
      try {
        expect(
          placeLauncher(gui, stagedPath(gui), want, {
            at: (point) => {
              if (point !== "aside") return;
              copyFileSync(stagedPath(gui), gui);
              client = spawn(gui, ["-n", "60", "127.0.0.1"], { stdio: "ignore" });
            },
          }),
        ).toBe(`${gui}.old-1`);
        expect(sha(readFileSync(gui))).toBe(want);
        expect(readFileSync(`${gui}.old-1`, "utf8")).toBe("old gui");
        // The staged copy stays for the clean-up.
        expect(existsSync(stagedPath(gui))).toBe(true);
      } finally {
        if (client !== undefined) {
          client.kill();
          await once(client, "exit");
        }
      }
    },
    60_000,
  );
});

describe.runIf(windows)(
  "[A2.3.12.6.update.stage] an update stages its launchers before current changes, and a repair finishes from the staged copies",
  () => {
    const key = throwawayKey();
    const KEYS = [keyLine(key)];

    async function world(label: string) {
      const dir = folder(label);
      const { root, facts } = await fixtureInstall(dir, os);
      const control = new FakeControl(root, os, false);
      const options = { facts, keys: KEYS, control, selfTest: fakeSelfTest(), lockWaitMs: 20_000 };
      return { dir, root, state: join(root, "state"), bin: join(root, "bin"), options };
    }

    test("each changed launcher is staged, checked, before current changes, then swapped from its staged copy", async () => {
      const w = await world("staging");
      const release = fixtureRelease(join(w.dir, "r2"), "0.2.0", os, key, { launcher: "two" });
      const seen: string[] = [];
      const state = () =>
        [
          currentOf(w.root, os),
          ...[CONSOLE, GUI].map((name) =>
            existsSync(stagedPath(join(w.bin, name))) ? `${name}.new` : "-",
          ),
        ].join(" ");
      await updateFromArchive(release.archive, {
        ...w.options,
        seams: {
          update: (point) => {
            if (["staged", "current", "launchers_done", "done"].includes(point)) {
              seen.push(`${point}: ${state()}`);
            }
          },
          launcher: (point, name) => {
            seen.push(`${point} ${name}: ${state()}`);
          },
        },
      });
      // Idle launchers: each one replaced by one rename (no `aside` step).
      expect(seen).toEqual([
        `staged ${CONSOLE}: 0.1.0 ${CONSOLE}.new -`,
        `staged ${GUI}: 0.1.0 ${CONSOLE}.new ${GUI}.new`,
        `staged: 0.1.0 ${CONSOLE}.new ${GUI}.new`,
        `current: 0.2.0 ${CONSOLE}.new ${GUI}.new`,
        `placed ${CONSOLE}: 0.2.0 - ${GUI}.new`,
        `placed ${GUI}: 0.2.0 - -`,
        "launchers_done: 0.2.0 - -",
        "done: 0.2.0 - -",
      ]);
      expect(readdirSync(w.bin).sort()).toEqual([CONSOLE, GUI]);
      expect(readFileSync(join(w.bin, CONSOLE), "utf8")).toBe("console launcher two");
    });

    test("a launcher that cannot be staged stops the update before current changes, with nothing left to repair", async () => {
      const w = await world("stage-fails");
      mkdirSync(stagedPath(join(w.bin, GUI)));
      const release = fixtureRelease(join(w.dir, "r2"), "0.2.0", os, key, { launcher: "two" });
      const failed = await updateFromArchive(release.archive, w.options).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failed).toBeInstanceOf(UpdateError);
      expect(currentOf(w.root, os)).toBe("0.1.0");
      expect(existsSync(join(w.state, UPDATE_JOURNAL))).toBe(false);
      expect(readdirSync(w.bin).sort()).toEqual([CONSOLE, GUI, `${GUI}.new`]);
      expect(readFileSync(join(w.bin, CONSOLE), "utf8")).toBe("console launcher 0.1.0");
    });

    test("a repair of a half-replaced bin uses the staged copy going forward, the aside copy going back, and removes the staged copies", async () => {
      const w = await world("half");
      const release = fixtureRelease(join(w.dir, "r2"), "0.2.0", os, key, { launcher: "two" });
      // Installs 0.2.0 beside 0.1.0, then goes back, so both version folders are there.
      await updateFromArchive(release.archive, w.options);
      await rollbackUpdate(w.options);
      const own = (version: string, name: string) => join(w.root, "versions", version, "bin", name);
      const journal: Journal = {
        format: 1,
        kind: "update",
        from: "0.1.0",
        to: "0.2.0",
        phase: "switched",
        pid: 1,
        started_at: new Date(0).toISOString(),
        staging: null,
        service: false,
        tested: true,
        launchers: [CONSOLE, GUI].map((name) => ({
          name,
          old: sha(readFileSync(own("0.1.0", name))),
          new: sha(readFileSync(own("0.2.0", name))),
        })),
      };
      for (const side of ["0.2.0", "0.1.0"]) {
        // A kill between the two renames of ttasks.exe: renamed aside, its staged copy not yet in;
        // ttasksw.exe still the old one, with its staged copy beside it.
        for (const name of readdirSync(w.bin)) rmSync(join(w.bin, name));
        copyFileSync(own("0.1.0", CONSOLE), join(w.bin, `${CONSOLE}.old-1`));
        copyFileSync(own("0.2.0", CONSOLE), stagedPath(join(w.bin, CONSOLE)));
        copyFileSync(own("0.1.0", GUI), join(w.bin, GUI));
        copyFileSync(own("0.2.0", GUI), stagedPath(join(w.bin, GUI)));
        writeCurrent(w.root, currentFor(side, os), os);
        writeJournal(w.state, journal);
        const outcome = repairLocked({ root: w.root, state: w.state, platform: os });
        expect(outcome.kind, side).toBe(side === "0.2.0" ? "rolled_forward" : "rolled_back");
        for (const name of [CONSOLE, GUI]) {
          expect(readFileSync(join(w.bin, name)), `${side} ${name}`).toEqual(
            readFileSync(own(side, name)),
          );
          expect(existsSync(stagedPath(join(w.bin, name))), `${side} ${name}.new`).toBe(false);
        }
        expect(existsSync(join(w.state, UPDATE_JOURNAL)), side).toBe(false);
        // Going back renamed the old ttasks.exe in from its aside copy: none is left of it.
        if (side === "0.1.0") expect(existsSync(join(w.bin, `${CONSOLE}.old-1`))).toBe(false);
        cleanLaunchers(w.root);
        expect(readdirSync(w.bin).sort(), side).toEqual([CONSOLE, GUI]);
      }
    });

    test("a repair says when it may have replaced the supervisor: a journal that names ttasksw.exe, or any unreadable journal", async () => {
      const w = await world("supervisor");
      const own = (name: string) => join(w.root, "versions", "0.1.0", "bin", name);
      // An unreadable journal, and a bin\ttasksw.exe that is not current's: the repair keeps current
      // and brings the launchers to it, so a supervisor that ran from the old file is outdated.
      writeFileSync(join(w.bin, GUI), "another supervisor");
      writeFileSync(join(w.state, UPDATE_JOURNAL), "not a journal");
      const kept = repairLocked({ root: w.root, state: w.state, platform: os });
      expect(kept).toMatchObject({ kind: "kept", current: "0.1.0", launchers: [CONSOLE, GUI] });
      expect(readFileSync(join(w.bin, GUI))).toEqual(readFileSync(own(GUI)));
      expect(supervisorReplaced(kept)).toBe(true);
      // The same with both launchers already current's: the journal cannot say whether its update
      // replaced ttasksw.exe (and a sibling repair put the new one back) while a supervisor ran from
      // the old file, so it counts as replaced too: one restart more at most, once.
      writeFileSync(join(w.state, UPDATE_JOURNAL), "not a journal");
      const again = repairLocked({ root: w.root, state: w.state, platform: os });
      expect(again.kind).toBe("kept");
      expect(supervisorReplaced(again)).toBe(true);
      // A finished or rolled-back update: whenever its journal names ttasksw.exe, whichever file
      // the supervisor runs from now.
      const journal: Journal = {
        format: 1,
        kind: "update",
        from: "0.1.0",
        to: "0.2.0",
        phase: "switched",
        pid: 1,
        started_at: new Date(0).toISOString(),
        staging: null,
        service: false,
        tested: true,
        launchers: [{ name: CONSOLE, old: sha("a"), new: sha("b") }],
      };
      expect(supervisorReplaced({ kind: "rolled_forward", journal, current: "0.2.0" })).toBe(false);
      const both = {
        ...journal,
        launchers: [...journal.launchers, { name: GUI, old: null, new: sha("c") }],
      };
      expect(supervisorReplaced({ kind: "rolled_back", journal: both, current: "0.1.0" })).toBe(
        true,
      );
      // Linux and macOS: no stable launcher, no supervisor file.
      expect(supervisorReplaced({ kind: "kept", current: "0.1.0", launchers: [] })).toBe(false);
      expect(supervisorReplaced({ kind: "nothing" })).toBe(false);
      expect(supervisorReplaced({ kind: "stuck", problems: ["x"] })).toBe(false);
    });
  },
);
