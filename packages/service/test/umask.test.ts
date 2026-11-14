// The umask guard (A2 3.2.2 rule 5): the mode a file or folder is created
// with is masked by the process's umask, which differs per system (002 on a desktop with user
// private groups, 022 on CI runners, 077 on a hardened one). Every file and folder the product
// creates must have exactly its planned mode whatever the umask, and a file the product made must
// never be one it then refuses or cannot read. A umask that takes away the person's own bits is
// refused before anything is made.
//
// umask-entry.ts runs the product's own creation paths in a child process started under the umask.
// Under 000 nothing masks a bit, so a path that relied on the umask shows up as a group- or
// world-writable entry. Under 077 every group and other bit is masked, so a path that relied on
// the umask for a mode wider than 0700 (or a reader that needs one) shows up too.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { PRODUCT_ID } from "@tasks/brand";
import { ServiceCommandError } from "../src/install/errors.ts";
import { planInstall } from "../src/install/commands.ts";
import { umaskRefusal } from "../src/hub/umask.ts";
import { InstallError, refuseBeforeFinish, type InstallTarget } from "../src/version/install.ts";
import { tempRoot } from "./harness.ts";
import { fakeContext } from "./install-fakes.ts";

const ENTRY = fileURLToPath(new URL("./umask-entry.ts", import.meta.url));

interface Entry {
  readonly path: string;
  readonly type: "folder" | "file" | "socket" | "link" | "other";
  readonly mode: number;
}

interface Report {
  readonly entries: Entry[];
  readonly runtime: string | null;
  /** The launch's ID, which names its folder. */
  readonly launch: string;
  readonly space: string;
  readonly status: string | null;
  readonly statusAgain: string | null;
  readonly firstSpaces: string[];
  readonly secondSpaces: string[];
  readonly backups: number;
  readonly port: number | null;
  readonly portAgain: number | null;
  readonly paired: boolean;
  readonly t3Again: string | null;
  readonly shimExit: number | null;
  readonly exitCode: number | null;
  readonly candidate: string;
}

interface Refused {
  readonly refused: string | null;
  readonly code: number;
  readonly made: boolean;
}

/**
 * The planned mode of every file and folder the product makes (A2 3.2.2 rule 5, 3.2.3; A1: space
 * folders 0700 and their files 0600; A6 3.16.6; A4 3.6.3: launch folders 0700, launch.json and
 * exit.json 0600): folders 0700, files 0600, except service.lock and update.lock, which A2 3.2.3
 * makes 0644. The socket's own mode is listen's 0777 masked by the umask: its 0700 folder is what
 * keeps every other user from it, so no mode is set on it by path (A2 3.2.2 rule 5). A link has no
 * mode of its own on Linux; the install's `current` and stable command are the only ones. The
 * projection's files in the space's `view/` are read-only, 0400, from their creation (A1 3.13);
 * its record and journal, and their temporary files, are 0600 like every other file.
 */
function planned(entry: Entry, umask: number): number {
  if (entry.type === "folder") return 0o700;
  if (entry.type === "socket") return 0o777 & ~umask;
  if (entry.type === "link") return entry.mode;
  if (entry.path.endsWith("/service.lock") || entry.path.endsWith("/update.lock")) return 0o644;
  if (/^sp\/work\/view\//.test(entry.path)) {
    return /(^|\/)\.{1,2}projection-(files|journal)\.json/.test(entry.path) ? 0o600 : 0o400;
  }
  return 0o600;
}

/** The links the product makes: the install's `current` and its stable command (A2 3.12.2). */
const LINKS = [`inst/bin/${PRODUCT_ID}`, "inst/current"];

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function spawnEntry(umask: string): { status: number | null; stdout: string; stderr: string } {
  const { root, cleanup } = tempRoot("um");
  cleanups.push(cleanup);
  // The per-user runtime base (`/run/user/<uid>` in the product) is the system's; the test makes
  // its stand-in, private, and the product makes its own folder inside it.
  const userDir = join(root, "run", String(process.getuid?.() ?? 0));
  mkdirSync(userDir, { recursive: true, mode: 0o700 });
  chmodSync(join(root, "run"), 0o700);
  chmodSync(userDir, 0o700);
  return spawnSync(
    "/bin/sh",
    ["-c", `umask ${umask} && exec "$0" "$@"`, process.execPath, ENTRY, root],
    { encoding: "utf8", timeout: 270_000, env: process.env },
  );
}

function run(umask: string): Report {
  const ran = spawnEntry(umask);
  if (ran.status !== 0) {
    throw new Error(`the product paths failed under umask ${umask}: ${ran.stderr}`);
  }
  const line = ran.stdout.trim().split("\n").at(-1) ?? "";
  return JSON.parse(line) as Report;
}

/** Each entry as `path type mode`, so a failure names every wrong one at once. */
const listed = (entries: readonly Entry[], mode: (e: Entry) => number) =>
  entries.map((e) => `${e.path} ${e.type} ${mode(e).toString(8)}`).sort();

function checkModes(report: Report, umask: number): void {
  expect(report.entries.length).toBeGreaterThan(10);
  const entries = report.entries;
  expect(entries.filter((e) => e.type === "other")).toEqual([]);
  expect(entries.filter((e) => e.type === "link").map((e) => e.path)).toEqual(LINKS);
  expect(listed(entries, (e) => e.mode)).toEqual(listed(entries, (e) => planned(e, umask)));
  // The walk saw what the product makes, so the comparison is not empty of meaning.
  const names = report.entries.map((e) => e.path);
  const runtime = report.runtime ?? "";
  const launch = `${runtime}/launch/${report.launch}`;
  for (const expected of [
    "h",
    "h/config",
    "h/config/machine.toml",
    "h/state",
    "h/state/service.lock",
    "h/state/service.json",
    "h/state/service.sqlite",
    "h/state/ipc.key",
    "h/state/machine.json",
    "h/state/logs/service.log",
    // T3's pairing (M2.11).
    "h/state/t3",
    "h/state/t3/pairing.json",
    // The space: its folder, the folder for spaces above it, and the files its writer keeps.
    "sp",
    "sp/work",
    "sp/work/space.json",
    "sp/work/space.db",
    "sp/work/writer.lock",
    "sp/work/writer.json",
    // A launch through the shim (M2.08): its work folder, launch folder and files.
    "h/state/workdirs",
    `h/state/workdirs/space-${report.space}`,
    runtime,
    `${runtime}/launch`,
    launch,
    `${launch}/launch.json`,
    `${launch}/exit.json`,
    // An install's own writes (M1.14).
    "inst/state",
    "inst/state/tmp",
    "inst/state/update.lock",
    "inst/state/install.json",
    "inst/bin",
    ...LINKS,
  ]) {
    expect(names, expected).toContain(expected);
  }
  expect(names.filter((n) => n.startsWith("h/state/crash/") && n.endsWith(".json"))).toHaveLength(
    1,
  );
  expect(names.filter((n) => n.startsWith("sp/work/backups/") && n.endsWith(".db.gz")).length).toBe(
    report.backups,
  );
  expect(report.entries.filter((e) => e.type === "socket")).toHaveLength(1);
  expect(report.runtime).not.toBeNull();
  // The first start chose a port and wrote it to the machine.toml it made; later starts serve it.
  expect(report.port).toBeGreaterThan(0);
  expect(report.portAgain).toBe(report.port);
}

describe.skipIf(process.platform === "win32")(
  "[A2.3.2.2.permissions.umask] the product's files and folders whatever the umask",
  () => {
    test("umask 000: every file and folder the product made has exactly its planned mode", () => {
      const report = run("000");
      checkModes(report, 0o000);
      expect(report.firstSpaces).toEqual(["open"]);
    }, 300_000);

    test("umask 077: the same modes, and the product reads, opens and serves all it made", () => {
      const report = run("077");
      checkModes(report, 0o077);
      expect(report.status).toBe("ready");
      expect(report.firstSpaces).toEqual(["open"]);
      // A second start reads machine.toml, machine.json and ipc.key, opens the space and lists its
      // backup; a client proves ipc.key.
      expect(report.statusAgain).toBe("ready");
      expect(report.secondSpaces).toEqual(["open"]);
      expect(report.backups).toBeGreaterThanOrEqual(1);
      // It reads the pairing it kept, and the shim's exit.json from the launch folder it made; the
      // candidate's temporary space was made, written and backed up.
      expect(report.paired).toBe(true);
      expect(report.t3Again).toBe("ready");
      expect(report.shimExit).toBe(0);
      expect(report.exitCode).toBe(0);
      expect(report.candidate).toBe("ok");
    }, 300_000);

    test("a umask that takes away the person's own bits is refused with 64 before anything is made", () => {
      for (const umask of ["0400", "0200", "0100", "0700"]) {
        const ran = spawnEntry(umask);
        expect(ran.status, ran.stderr).toBe(0);
        const report = JSON.parse(ran.stdout.trim().split("\n").at(-1) ?? "") as Refused;
        expect(report, umask).toEqual({ refused: "unsafe_umask", code: 64, made: false });
        expect(ran.stderr).toContain(`Your umask (${umask})`);
        expect(ran.stderr).toContain("umask 022");
      }
    }, 180_000);
  },
);

describe("[A2.3.2.2.permissions.umask] tasks service install and such a umask", () => {
  test("the line says what is wrong and what to do; a umask that keeps the owner's bits passes", () => {
    for (const mask of [0o000, 0o002, 0o022, 0o027, 0o077, 0o007]) {
      expect(umaskRefusal(mask, "it stops")).toBeUndefined();
    }
    expect(umaskRefusal(undefined, "it stops")).toBeUndefined();
    expect(umaskRefusal(0o477, "it stops")).toBe(
      "Your umask (0477) takes away your own access to every new file or folder, so it stops: TT Tasks could not use the files it creates. Set the usual umask first, for example: umask 022",
    );
  });

  test("install refuses it before it plans anything", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tasks-um-install-"));
    cleanups.push(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const fake = fakeContext({ platform: "linux", dir });
    const error = await planInstall({ ...fake.ctx, umask: () => 0o400 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceCommandError);
    expect(error).toMatchObject({ errorClass: "forbidden", code: "unsafe_umask" });
    expect((error as Error).message).toContain("Your umask (0400)");
    expect(fake.tools.calls).toEqual([]);
  });

  test("install --finish refuses it, and one it cannot read, before its self-test makes anything", () => {
    const dir = mkdtempSync(join(tmpdir(), "tasks-um-finish-"));
    cleanups.push(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const state = join(dir, "state");
    const target = { layout: { state } } as unknown as InstallTarget;
    for (const [read, words] of [
      [0o200, "Your umask (0200)"],
      [{ unreadable: "failed" }, "Your umask could not be read"],
    ] as const) {
      let thrown: unknown;
      try {
        refuseBeforeFinish(target, "linux", () => read);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(InstallError);
      expect(thrown).toMatchObject({ exitCode: 5 });
      expect((thrown as Error).message).toContain(words);
      expect((thrown as Error).message).toContain("the install does not finish");
      expect(existsSync(state)).toBe(false);
    }
    expect(() => {
      refuseBeforeFinish(target, "linux", () => 0o077);
    }).not.toThrow();
    expect(existsSync(state)).toBe(false);
  });
});
