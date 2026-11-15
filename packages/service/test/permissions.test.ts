// The permission rule (A2 3.2.2 rule 5): who else can write
// a file or folder, what the service tells the person when it refuses (stderr names the path and
// the fix; the log names only the code), and the one place that turns a path's facts into the words
// and the command (permissions.ts).
//
// The repair table runs every command it can without root against a scratch fixture and judges the
// fixture again: the next start must pass. The cases that need root (another owner) assert the
// exact text, and the command's effect is applied to the facts to show that they pass after it.
//
// A real fixture's group is this account's, which may be its own private group, whose write the
// rule accepts: so the real fixtures here are refused for write by every user, and group write is
// judged on facts (and on this machine's own folders in group-rule.test.ts).
import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MAX_LINE_BYTES } from "@tasks/launch/shell-line";
import { editMachineToml } from "../src/config/edit.ts";
import { loadMachineConfig, type UnsafePart } from "../src/config/machine-toml.ts";
import { unsafeConfigMessage } from "../src/config/messages.ts";
import { ServiceExit } from "../src/hub/exit.ts";
import {
  currentPerson,
  factsOf,
  fixCommand,
  problemOf,
  repairOf,
  shellArg,
  shellPath,
  unsafeMessage,
  type Need,
  type PathFacts,
  type Person,
  type Unsafe,
} from "../src/hub/permissions.ts";
import { startService, type StartOptions } from "../src/hub/service.ts";
import { t3Files, T3StateUnsafe } from "../src/hub/t3.ts";
import { InstallError, refuseBeforeFinish, type InstallTarget } from "../src/version/install.ts";
import { configOf, serviceEnv, stateOf, tempRoot } from "./harness.ts";

const posix = process.platform !== "win32";
const uid = process.getuid?.() ?? 1000;
const asRoot = uid === 0;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function temp(label: string): string {
  const { root, cleanup } = tempRoot(label);
  // A fixture left without its owner's bits by a failed test is opened up before it is removed.
  cleanups.push(() => {
    openUp(root);
    cleanup();
  });
  return root;
}
function openUp(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    chmodSync(path, stat.isDirectory() ? 0o700 : 0o600);
    if (stat.isDirectory()) for (const name of readdirSync(path)) openUp(join(path, name));
  } catch {
    // Gone already.
  }
}

/** Runs a suggested command in a POSIX shell, as a person pastes it. */
function paste(command: string, cwd: string): void {
  const ran = spawnSync("/bin/sh", ["-c", command], { cwd, encoding: "utf8" });
  if (ran.status !== 0) throw new Error(`${command} failed: ${ran.stderr}`);
}

/** A root-owned file this user cannot read (Linux, not as root), for an unreadable machine.toml. */
function unreadableRootFile(): string | undefined {
  if (process.platform !== "linux" || asRoot) return undefined;
  for (const candidate of ["/etc/shadow", "/etc/gshadow", "/etc/sudoers"]) {
    if (!existsSync(candidate)) continue;
    try {
      accessSync(candidate, constants.R_OK);
    } catch {
      return candidate;
    }
  }
  return undefined;
}

const identity = () => ({ root: false, elevated: false, package: null });

/** Starts a service, and stops it again when it started. The refusal, or undefined. */
async function startOnce(
  h: string,
  lines: string[],
  more: Partial<StartOptions> = {},
): Promise<ServiceExit | undefined> {
  try {
    const running = await startService({
      env: serviceEnv(h),
      identity,
      say: (line) => lines.push(line),
      runUserBase: join(h, "no-run-user"),
      ...more,
    });
    await running.stop();
    return undefined;
  } catch (error) {
    if (!(error instanceof ServiceExit)) throw error;
    return error;
  }
}

/** The command in a refusal's line. */
const commandIn = (line: string | undefined): string | undefined =>
  /(?:To fix it|For the others), run: (.*)$/su.exec(line ?? "")?.[1];

/** Whether this account's primary group is its own private group, whose write the rule accepts. */
const ownGroup = (): boolean => currentPerson()?.ownGroup() === true;

const ME = 1000;
const ROOT = 0;
/** The primary group of the facts below: shared, as macOS's `staff` is, unless a test says not. */
const GROUP = 20;
/** A person whose primary group is shared (`staff`): no group but none may write. */
const P: Person = {
  uid: ME,
  gid: GROUP,
  ownGroup: () => false,
  groupName: (gid) => (gid === GROUP ? "staff" : undefined),
};
/** The same person with a private group of their own (`ada`), whose write the rule accepts. */
const OWN: Person = { ...P, ownGroup: () => true, groupName: () => "ada" };
const facts = (
  path: string,
  need: Need,
  mode: number,
  owner = ME,
  extra: Partial<PathFacts> = {},
): PathFacts => ({
  path,
  need,
  kind: need === "file" ? "file" : "folder",
  uid: owner,
  gid: GROUP,
  mode,
  ...extra,
});

describe("[A2.3.2.2.permissions.rule] who else can write a file or folder", () => {
  test("another owner, write for every user and write for a group that is not the person's own all refuse; the socket folder lets no one in", () => {
    const judge = (need: Need, mode: number, owner = ME, person = P) =>
      problemOf(facts("/p", need, mode, owner), person);
    expect(judge("file", 0o600)).toBeUndefined();
    expect(judge("file", 0o644)).toBeUndefined();
    expect(judge("file", 0o400)).toBeUndefined();
    expect(judge("file", 0o600, ROOT)).toBe("other_owner");
    expect(judge("file", 0o602)).toBe("world_writable");
    expect(judge("file", 0o666)).toBe("world_writable");
    // A shared group may hold other people: its write is refused.
    expect(judge("file", 0o664)).toBe("group_writable");
    expect(judge("file", 0o620)).toBe("group_writable");
    expect(judge("file", 0o200)).toBe("no_access");
    expect(judge("folder", 0o755)).toBeUndefined();
    expect(judge("folder", 0o775)).toBe("group_writable");
    expect(judge("folder", 0o500)).toBe("no_access");
    // A desktop with umask 002 and a private group per user makes 0664 files and 0775 folders:
    // that group is the person's own, so its write passes. Every user's write still does not, and
    // another group's does not either.
    expect(judge("file", 0o664, ME, OWN)).toBeUndefined();
    expect(judge("folder", 0o775, ME, OWN)).toBeUndefined();
    expect(judge("folder", 0o777, ME, OWN)).toBe("world_writable");
    expect(problemOf({ ...facts("/p", "folder", 0o775), gid: 27 }, OWN)).toBe("group_writable");
    // The socket folder lets no one else in at all, a private group included.
    expect(judge("private_folder", 0o700)).toBeUndefined();
    expect(judge("private_folder", 0o755)).toBe("open_to_others");
    expect(judge("private_folder", 0o775)).toBe("open_to_others");
    expect(judge("private_folder", 0o770, ME, OWN)).toBe("open_to_others");
    expect(judge("private_folder", 0o701)).toBe("open_to_others");
    expect(judge("private_folder", 0o700, ROOT)).toBe("other_owner");
    // A link where links are not followed (configuration), and the wrong kind of object.
    expect(problemOf(facts("/p", "file", 0o600, ME, { link: "/etc/x" }), P)).toBe("link");
    expect(
      problemOf(facts("/p", "folder", 0o700, ME, { link: "/d", followsLink: true }), P),
    ).toBeUndefined();
    expect(problemOf({ ...facts("/p", "folder", 0o700), kind: "file" }, P)).toBe("not_a_folder");
    expect(problemOf({ ...facts("/p", "file", 0o600), kind: "other" }, P)).toBe("not_a_file");
  });

  test("a path is written as a person types it: ~/ for home, quoted when needed", () => {
    expect(shellPath("/home/ada/.config/tasks/machine.toml", "/home/ada")).toBe(
      "~/.config/tasks/machine.toml",
    );
    expect(shellPath("/srv/a b/it's", "/home/ada")).toBe(`'/srv/a b/it'\\''s'`);
    expect(shellPath("/home/ada x/f", "/home/ada")).toBe(`'/home/ada x/f'`);
    expect(shellPath("/srv/$(id)\n`x`", "/home/ada")).toBe(`'/srv/$(id)\n\`x\`'`);
    // Any other control character: no line to paste shows it as it is (A3 3.13.7), so the
    // sentence shows it escaped and no command is given.
    expect(shellArg("/srv/a\rb", "/home/ada")).toBeUndefined();
    expect(shellPath("/srv/a\rb", "/home/ada")).toBe(`"/srv/a\\rb"`);
    expect(
      fixCommand(
        [{ facts: facts("/srv/a\rb", "folder", 0o777), problem: "world_writable" }],
        "ada",
        P,
      ),
    ).toBeUndefined();
    // A line longer than a line to paste can be (A3 3.13.7): no command, and the message says why.
    const fits = `/srv/${"d".repeat(MAX_LINE_BYTES - "chmod go-w /srv/".length)}`;
    const long = `${fits}d`;
    const world = (path: string) => [
      {
        name: "The folder",
        facts: facts(path, "folder", 0o777),
        problem: "world_writable" as const,
      },
    ];
    expect(Buffer.byteLength(fixCommand(world(fits), "ada", P) ?? "")).toBe(MAX_LINE_BYTES);
    expect(fixCommand(world(long), "ada", P)).toBeUndefined();
    expect(unsafeMessage(world(long), "Why", "ada", P)).toContain(
      `No command is given, because it would be longer than a line to paste can be (${String(MAX_LINE_BYTES)} bytes).`,
    );
  });

  test("the message says what is wrong in plain words first, naming the group, then why, then the command", () => {
    const folder = facts("/srv/k", "folder", 0o775);
    const file = facts("/srv/k/machine.toml", "file", 0o664);
    expect(
      unsafeMessage(
        [
          { name: "TT Tasks's configuration folder", facts: folder, problem: "group_writable" },
          { name: "TT Tasks's machine.toml", facts: file, problem: "group_writable" },
        ],
        "So the service does not start",
        "ada",
        P,
      ),
    ).toBe(
      "TT Tasks's configuration folder (/srv/k) and TT Tasks's machine.toml (/srv/k/machine.toml) can be changed by the members of their group staff, not only by you. So the service does not start. To fix it, run: chmod g-w /srv/k /srv/k/machine.toml",
    );
    // A group whose name cannot be read is named by its ID.
    expect(
      unsafeMessage(
        [{ name: "The folder", facts: { ...folder, gid: 27 }, problem: "group_writable" }],
        "Why",
        "ada",
        P,
      ),
    ).toBe(
      "The folder (/srv/k) can be changed by the members of its group with ID 27, not only by you. Why. To fix it, run: chmod g-w /srv/k",
    );
    expect(
      unsafeMessage(
        [
          {
            name: "The folder",
            facts: facts("/srv/k", "folder", 0o755, ROOT),
            problem: "other_owner",
          },
          { name: "The file", facts: facts("/srv/k/f", "file", 0o646), problem: "world_writable" },
        ],
        "Why",
        "ada",
        P,
      ),
    ).toBe(
      "The folder (/srv/k) belongs to another user; The file (/srv/k/f) can be changed by every user on this computer. Why. To fix it, run: sudo chown -h ada /srv/k && chmod o-w /srv/k/f",
    );
    // Every user's write goes, and a private group's stays: one change for each.
    expect(
      fixCommand(
        [
          { facts: facts("/srv/a", "folder", 0o777), problem: "world_writable" },
          { facts: { ...facts("/srv/b", "folder", 0o777), gid: 27 }, problem: "world_writable" },
        ],
        "ada",
        OWN,
      ),
    ).toBe("chmod o-w /srv/a && chmod go-w /srv/b");
  });

  test.skipIf(!posix)(
    "machine.toml and its folder as made under umask 002: passed under the person's own private group, else refused with g-w; every user's write is refused, both are named, and one command fixes both",
    () => {
      const dir = join(temp("pm"), "config");
      mkdirSync(dir, { mode: 0o700 });
      const file = join(dir, "machine.toml");
      writeFileSync(file, '[log]\nlevel = "warn"\n', { mode: 0o600 });
      expect(loadMachineConfig(dir, "linux").config.log.level).toBe("warn");
      const parts = (found: readonly UnsafePart[] | undefined) =>
        found?.map(({ what, path, problem }) => ({ what, path, problem }));
      // As `mkdir` and an editor make them under umask 002, in this account's group.
      chmodSync(dir, 0o775);
      chmodSync(file, 0o664);
      const grouped = loadMachineConfig(dir, "linux");
      if (ownGroup()) {
        expect(grouped.problems).toEqual([]);
        expect(grouped.config.log.level).toBe("warn");
      } else {
        expect(parts(grouped.unsafe)).toEqual([
          { what: "folder", path: dir, problem: "group_writable" },
          { what: "file", path: file, problem: "group_writable" },
        ]);
        const line = unsafeConfigMessage(grouped.unsafe ?? [{} as UnsafePart]);
        expect(line).toMatch(/can be changed by the members of their group .+, not only by you/u);
        expect(commandIn(line)).toBe(`chmod g-w ${shellPath(dir)} ${shellPath(file)}`);
        paste(commandIn(line) ?? "false", dir);
        expect(loadMachineConfig(dir, "linux").problems).toEqual([]);
      }
      chmodSync(dir, 0o755);
      chmodSync(file, 0o606);
      const fileOnly = loadMachineConfig(dir, "linux");
      expect(fileOnly.problems).toEqual([
        { key: "", code: "unsafe_permissions", severity: "error" },
      ]);
      expect(parts(fileOnly.unsafe)).toEqual([
        { what: "file", path: file, problem: "world_writable" },
      ]);
      chmodSync(dir, 0o757);
      chmodSync(file, 0o646);
      const both = loadMachineConfig(dir, "linux");
      expect(parts(both.unsafe)).toEqual([
        { what: "folder", path: dir, problem: "world_writable" },
        { what: "file", path: file, problem: "world_writable" },
      ]);
      const line = unsafeConfigMessage(both.unsafe ?? [{} as UnsafePart]);
      expect(line).toContain("can be changed by every user on this computer");
      expect(commandIn(line)).toBe(`chmod o-w ${shellPath(dir)} ${shellPath(file)}`);
      paste(commandIn(line) ?? "false", dir);
      expect(loadMachineConfig(dir, "linux").problems).toEqual([]);
      chmodSync(dir, 0o707);
      expect(parts(loadMachineConfig(dir, "linux").unsafe)).toEqual([
        { what: "folder", path: dir, problem: "world_writable" },
      ]);
      chmodSync(dir, 0o700);
      expect(loadMachineConfig(dir, "linux").problems).toEqual([]);
    },
  );

  test.skipIf(!posix)(
    "the service refuses such a machine.toml with 64: stderr names the file and the fix, the log only the code",
    async () => {
      const h = join(temp("ps"), "h");
      mkdirSync(configOf(h), { recursive: true, mode: 0o700 });
      const file = join(configOf(h), "machine.toml");
      writeFileSync(file, '[log]\nlevel = "warn"\n', { mode: 0o600 });
      chmodSync(file, 0o646);
      const lines: string[] = [];
      const exit = await startOnce(h, lines);
      expect(exit?.code).toBe(64);
      expect(exit?.refusal).toBe("unsafe_permissions");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("can be changed by every user on this computer");
      expect(commandIn(lines[0])).toBe(`chmod o-w ${shellPath(file)}`);
      const log = readFileSync(join(stateOf(h), "logs", "service.log"), "utf8");
      expect(log).toMatch(/"ev":"service.refused".*"reason":"unsafe_permissions"/);
      expect(log).not.toContain(h);
      expect(log).not.toContain("machine.toml");
    },
  );

  test.skipIf(!posix)(
    "a state folder every user can write: 64, and the line names the fix",
    async () => {
      const h = join(temp("pf"), "h");
      mkdirSync(stateOf(h), { recursive: true, mode: 0o700 });
      chmodSync(stateOf(h), 0o757);
      const lines: string[] = [];
      expect(await startOnce(h, lines)).toMatchObject({ code: 64, refusal: "unsafe_permissions" });
      expect(lines).toHaveLength(1);
      expect(commandIn(lines[0])).toBe(`chmod o-w ${shellPath(stateOf(h))}`);
      chmodSync(stateOf(h), 0o700);
    },
  );
});

describe("[A2.3.2.2.permissions.repair] one place turns a path's facts into the words and the command", () => {
  test.skipIf(!posix)(
    "an existing config folder is judged before machine.toml exists: the same answer before and after Tasks writes one",
    async () => {
      const h = join(temp("cf"), "h");
      const dir = configOf(h);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o757);
      const file = join(dir, "machine.toml");
      // The loader, the editor and a first start with the HTTP listener, which persists its port.
      const loaded = loadMachineConfig(dir, "linux");
      expect(loaded.present).toBe(false);
      expect(loaded.problems).toEqual([{ key: "", code: "unsafe_permissions", severity: "error" }]);
      expect(loaded.unsafe?.map((p) => [p.what, p.problem])).toEqual([
        ["folder", "world_writable"],
      ]);
      expect(
        editMachineToml(dir, [{ op: "set", table: ["log"], key: "level", value: "warn" }]),
      ).toEqual({ ok: false, reason: "unsafe" });
      const http = { ports: [0], persist: true, holders: () => [] };
      const lines: string[] = [];
      expect(await startOnce(h, lines, { http })).toMatchObject({
        code: 64,
        refusal: "unsafe_permissions",
      });
      expect(existsSync(file)).toBe(false);
      expect(commandIn(lines[0])).toBe(`chmod o-w ${shellPath(dir)}`);
      // The one command, and the start passes: it writes machine.toml with its port.
      paste(commandIn(lines[0]) ?? "false", h);
      expect(await startOnce(h, lines, { http })).toBeUndefined();
      expect(loadMachineConfig(dir, "linux").config.http.port).toBeGreaterThan(0);
      expect(lstatSync(file).mode & 0o777).toBe(0o600);
    },
    60_000,
  );

  test.skipIf(!posix)(
    "a socket folder that lets others in: the one command makes the next start pass",
    async () => {
      const h = join(temp("sk"), "h");
      mkdirSync(stateOf(h), { recursive: true, mode: 0o700 });
      const run = join(stateOf(h), "run");
      for (const mode of [0o775, 0o755, 0o711]) {
        mkdirSync(run, { recursive: true, mode: 0o700 });
        chmodSync(run, mode);
        const lines: string[] = [];
        expect(await startOnce(h, lines), mode.toString(8)).toMatchObject({
          code: 64,
          refusal: "unsafe_permissions",
        });
        expect(lines[0]).toContain("can be opened by other users, not only by you");
        expect(commandIn(lines[0])).toBe(`chmod go-rwx ${shellPath(run)}`);
        paste(commandIn(lines[0]) ?? "false", h);
        expect(await startOnce(h, lines), mode.toString(8)).toBeUndefined();
      }
    },
    60_000,
  );

  test.skipIf(!posix)(
    "state, log and crash folders are judged together: one command fixes every one that is there",
    async () => {
      const h = join(temp("sl"), "h");
      const logs = join(stateOf(h), "logs");
      const crash = join(stateOf(h), "crash");
      mkdirSync(logs, { recursive: true, mode: 0o700 });
      mkdirSync(crash, { mode: 0o700 });
      chmodSync(stateOf(h), 0o707);
      chmodSync(logs, 0o757);
      chmodSync(crash, 0o500);
      const lines: string[] = [];
      expect(await startOnce(h, lines)).toMatchObject({ code: 64 });
      expect(commandIn(lines[0])).toBe(
        `chmod o-w ${shellPath(stateOf(h))} ${shellPath(logs)} && chmod u+rwx ${shellPath(crash)}`,
      );
      paste(commandIn(lines[0]) ?? "false", h);
      expect(await startOnce(h, lines)).toBeUndefined();
    },
    60_000,
  );

  test.skipIf(!posix)(
    "the state's own folders of space settings, T3 and temporary files are judged with it before anything reads them: one command",
    async () => {
      const h = join(temp("ss"), "h");
      const state = stateOf(h);
      const tmp = join(state, "tmp");
      const settings = join(state, "spaces");
      const t3 = join(state, "t3");
      for (const dir of [tmp, settings, t3]) mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(state, 0o700);
      chmodSync(tmp, 0o500);
      chmodSync(settings, 0o757);
      chmodSync(t3, 0o707);
      const lines: string[] = [];
      expect(await startOnce(h, lines)).toMatchObject({ code: 64, refusal: "unsafe_permissions" });
      expect(lines[0]).toContain(`TT Tasks's temporary folder (${shellPath(tmp)})`);
      expect(lines[0]).toContain(`TT Tasks's folder of space settings (${shellPath(settings)})`);
      expect(lines[0]).toContain(`TT Tasks's T3 folder (${shellPath(t3)})`);
      // Nothing was read from them or written: no log, no service.json.
      expect(existsSync(join(state, "service.json"))).toBe(false);
      expect(commandIn(lines[0])).toBe(
        `chmod u+rwx ${shellPath(tmp)} && chmod o-w ${[settings, t3].map((p) => shellPath(p)).join(" ")}`,
      );
      paste(commandIn(lines[0]) ?? "false", h);
      expect(await startOnce(h, lines)).toBeUndefined();
    },
    60_000,
  );

  test.skipIf(!posix)(
    "a launch folder another user can change refuses the start before a launch is read from it; the one command fixes it",
    async () => {
      const h = join(temp("lr"), "h");
      // No per-user runtime folder here: the launch folders are `<state>/launch` (A2 3.2.1).
      const launch = join(stateOf(h), "launch");
      mkdirSync(launch, { recursive: true, mode: 0o700 });
      chmodSync(stateOf(h), 0o700);
      chmodSync(launch, 0o757);
      const lines: string[] = [];
      expect(await startOnce(h, lines)).toMatchObject({ code: 64, refusal: "unsafe_permissions" });
      expect(lines[0]).toContain(
        `TT Tasks's launch folder (${shellPath(launch)}) can be changed by every user on this computer.`,
      );
      expect(lines[0]).toContain("could choose what TT Tasks starts as you");
      expect(readFileSync(join(stateOf(h), "logs", "service.log"), "utf8")).not.toContain(launch);
      expect(commandIn(lines[0])).toBe(`chmod o-w ${shellPath(launch)}`);
      paste(commandIn(lines[0]) ?? "false", h);
      expect(await startOnce(h, lines)).toBeUndefined();
    },
    60_000,
  );

  test.skipIf(!posix)(
    "a T3 folder others can change keeps no token, and the refusal names the folder and the command",
    () => {
      const state = join(temp("t3"), "state");
      const t3 = join(state, "t3");
      mkdirSync(t3, { recursive: true, mode: 0o700 });
      chmodSync(state, 0o700);
      chmodSync(t3, 0o757);
      const files = t3Files(state, "linux");
      let thrown: unknown;
      try {
        files.write("pairing", '{"format":1}\n');
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(T3StateUnsafe);
      expect(readdirSync(t3)).toEqual([]);
      const line = (thrown as T3StateUnsafe).line;
      expect(line).toContain(
        `TT Tasks's T3 folder (${shellPath(t3)}) can be changed by every user`,
      );
      expect(line).toContain("so no token was kept");
      expect(commandIn(line)).toBe(`chmod o-w ${shellPath(t3)}`);
      paste(commandIn(line) ?? "false", state);
      files.write("pairing", '{"format":1}\n');
      expect(lstatSync(join(t3, "pairing.json")).mode & 0o777).toBe(0o600);
    },
  );

  test.skipIf(!posix)(
    "install --finish judges the state folder and its tmp before its self-test writes there: one command",
    () => {
      const state = join(temp("if"), "state");
      const tmp = join(state, "tmp");
      mkdirSync(tmp, { recursive: true, mode: 0o700 });
      chmodSync(state, 0o757);
      chmodSync(tmp, 0o707);
      const target = { layout: { state } } as unknown as InstallTarget;
      const refusal = (): InstallError | undefined => {
        try {
          refuseBeforeFinish(target, "linux", () => 0o022);
          return undefined;
        } catch (error) {
          if (error instanceof InstallError) return error;
          throw error;
        }
      };
      const first = refusal();
      expect(first?.exitCode).toBe(5);
      expect(first?.message).toContain(`TT Tasks's state folder (${shellPath(state)})`);
      expect(first?.message).toContain(`TT Tasks's temporary folder (${shellPath(tmp)})`);
      expect(first?.message).toContain("so the install does not finish");
      expect(commandIn(first?.message)).toBe(`chmod o-w ${shellPath(state)} ${shellPath(tmp)}`);
      expect(readdirSync(tmp)).toEqual([]);
      paste(commandIn(first?.message) ?? "false", state);
      expect(refusal()).toBeUndefined();
    },
  );

  /** A fixture the rule judges, made without root, and the command expected for it. */
  interface Row {
    readonly title: string;
    readonly need: Need;
    readonly follow: boolean;
    /** Makes the fixture under `root` and returns the path judged. */
    readonly make: (root: string) => string;
    readonly problem: Unsafe;
    /** The command, for the path as shellPath writes it; undefined: none can be given. */
    readonly command: ((path: string) => string) | undefined;
  }
  const folderAt =
    (mode: number, name = "f") =>
    (root: string) => {
      const path = join(root, name);
      mkdirSync(path);
      chmodSync(path, mode);
      return path;
    };
  const fileAt = (mode: number) => (root: string) => {
    const path = join(root, "machine.toml");
    writeFileSync(path, '[log]\nlevel = "warn"\n');
    chmodSync(path, mode);
    return path;
  };
  // Group write of a real fixture depends on this account's group (group-rule.test.ts): these
  // rows leave the group's bits alone.
  const rows: Row[] = [
    ...(
      [
        [0o757, "world_writable", "o-w"],
        [0o707, "world_writable", "o-w"],
        [0o507, "world_writable", "u+rwx,o-w"],
        [0o500, "no_access", "u+rwx"],
        [0o000, "no_access", "u+rwx"],
      ] as const
    ).map(([mode, problem, spec]): Row => ({
      title: `a folder ${mode.toString(8)}`,
      need: "folder",
      follow: true,
      make: folderAt(mode),
      problem,
      command: (p) => `chmod ${spec} ${p}`,
    })),
    ...(
      [
        [0o775, "open_to_others", "go-rwx"],
        [0o755, "open_to_others", "go-rwx"],
        [0o701, "open_to_others", "go-rwx"],
        [0o070, "open_to_others", "u+rwx,go-rwx"],
        [0o300, "no_access", "u+rwx"],
      ] as const
    ).map(([mode, problem, spec]): Row => ({
      title: `the socket folder ${mode.toString(8)}`,
      need: "private_folder",
      follow: true,
      make: folderAt(mode),
      problem,
      command: (p) => `chmod ${spec} ${p}`,
    })),
    ...(
      [
        [0o646, "world_writable", "o-w"],
        [0o606, "world_writable", "o-w"],
        [0o202, "world_writable", "u+rw,o-w"],
        [0o200, "no_access", "u+rw"],
        [0o000, "no_access", "u+rw"],
      ] as const
    ).map(([mode, problem, spec]): Row => ({
      title: `machine.toml ${mode.toString(8)}`,
      need: "file",
      follow: false,
      make: fileAt(mode),
      problem,
      command: (p) => `chmod ${spec} ${p}`,
    })),
    {
      title: "a state folder that is a link (followed) to a folder of this user's, 0757",
      need: "folder",
      follow: true,
      make: (root) => {
        const real = folderAt(0o757, "real")(root);
        symlinkSync(real, join(root, "state"));
        return join(root, "state");
      },
      problem: "world_writable",
      command: (p) => `chmod o-w ${p}`,
    },
    {
      title: "a folder below a link, 0757",
      need: "folder",
      follow: true,
      make: (root) => {
        mkdirSync(join(root, "real"), { mode: 0o700 });
        symlinkSync(join(root, "real"), join(root, "via"));
        return folderAt(0o757, "f")(join(root, "via"));
      },
      problem: "world_writable",
      command: (p) => `chmod o-w ${p}`,
    },
    {
      title: "a folder whose name holds a space, quotes, a substitution and a newline",
      need: "folder",
      follow: true,
      make: folderAt(0o757, "a b'c $(touch pwned) `touch pwned`\nd"),
      problem: "world_writable",
      command: (p) => `chmod o-w ${p}`,
    },
    {
      title: "machine.toml that is a link to a file of this user's",
      need: "file",
      follow: false,
      make: (root) => {
        const real = join(root, "elsewhere.toml");
        writeFileSync(real, "", { mode: 0o600 });
        symlinkSync(real, join(root, "machine.toml"));
        return join(root, "machine.toml");
      },
      problem: "link",
      command: undefined,
    },
    {
      title: "a configuration folder that is a link to a folder of this user's",
      need: "folder",
      follow: false,
      make: (root) => {
        mkdirSync(join(root, "real"), { mode: 0o700 });
        symlinkSync(join(root, "real"), join(root, "config"));
        return join(root, "config");
      },
      problem: "link",
      command: undefined,
    },
  ];

  test.skipIf(!posix || asRoot).each(rows)(
    "without root: $title — the command, run, makes the check pass",
    (row) => {
      const root = temp("rp");
      const path = row.make(root);
      const before = factsOf(path, row.need, { followLink: row.follow });
      if (typeof before !== "object") throw new Error(`no facts for ${path}`);
      const person = currentPerson();
      if (person === undefined) throw new Error("no person on a POSIX host");
      const problem = problemOf(before, person);
      expect(problem).toBe(row.problem);
      const thing = { name: "It", facts: before, problem: problem ?? row.problem };
      const command = fixCommand([thing], "ada");
      expect(command).toBe(row.command?.(shellPath(path)));
      expect(command ?? "").not.toContain("sudo");
      if (command === undefined) {
        // A link: no command, and the line says what it is and why nothing is given.
        const line = unsafeMessage([thing], "Why", "ada");
        expect(line).toContain(`(${shellPath(path)}) is a link to ${shellPath(before.link ?? "")}`);
        expect(line).toContain("TT Tasks does not follow links for its configuration");
        expect(line).not.toContain("run:");
        return;
      }
      paste(command, root);
      const after = factsOf(path, row.need, { followLink: row.follow });
      if (typeof after !== "object") throw new Error(`no facts for ${path} after ${command}`);
      expect(problemOf(after, person), command).toBeUndefined();
      // What Tasks needs of it works: a folder takes a new file, the file reads.
      if (row.need === "file") expect(readFileSync(path, "utf8")).toContain("[log]");
      else writeFileSync(join(path, "probe"), "");
      // A name full of shell syntax ran nothing.
      expect(existsSync(join(root, "pwned"))).toBe(false);
    },
  );

  /** A command's effect on the facts, for the cases a test cannot run without root. */
  function applied(f: PathFacts, command: string): PathFacts {
    let next = f;
    for (const step of command.split(" && ")) {
      const chown = /^sudo chown -h \S+ /u.exec(step);
      if (chown !== null) {
        next = { ...next, uid: ME };
        continue;
      }
      const spec = /^chmod (\S+) /u.exec(step)?.[1] ?? "";
      for (const clause of spec.split(",")) {
        const [, who = "", op, perms = ""] = /^([ugo]+)([+-])([rwx]+)$/u.exec(clause) ?? [];
        let bits = 0;
        for (const w of who) {
          for (const p of perms) {
            bits |=
              { r: 4, w: 2, x: 1 }[p as "r" | "w" | "x"] <<
              { u: 6, g: 3, o: 0 }[w as "u" | "g" | "o"];
          }
        }
        next = { ...next, mode: op === "+" ? next.mode | bits : next.mode & ~bits };
      }
    }
    return next;
  }

  const rootRows: readonly (readonly [string, PathFacts, Unsafe, string | undefined])[] = [
    [
      "a folder of root, 0755",
      facts("/srv/k", "folder", 0o755, ROOT),
      "other_owner",
      "sudo chown -h ada /srv/k",
    ],
    [
      "a folder of root, 0775",
      facts("/srv/k", "folder", 0o775, ROOT),
      "other_owner",
      "sudo chown -h ada /srv/k && chmod g-w /srv/k",
    ],
    [
      "a folder of root, 0777",
      facts("/srv/k", "folder", 0o777, ROOT),
      "other_owner",
      "sudo chown -h ada /srv/k && chmod go-w /srv/k",
    ],
    [
      "a folder of root, 0500",
      facts("/srv/k", "folder", 0o500, ROOT),
      "other_owner",
      "sudo chown -h ada /srv/k && chmod u+rwx /srv/k",
    ],
    [
      "a folder of root, 0000",
      facts("/srv/k", "folder", 0o000, ROOT),
      "other_owner",
      "sudo chown -h ada /srv/k && chmod u+rwx /srv/k",
    ],
    [
      "the socket folder of root, 0775",
      facts("/srv/r", "private_folder", 0o775, ROOT),
      "other_owner",
      "sudo chown -h ada /srv/r && chmod go-rwx /srv/r",
    ],
    [
      "the socket folder of root, 0700",
      facts("/srv/r", "private_folder", 0o700, ROOT),
      "other_owner",
      "sudo chown -h ada /srv/r",
    ],
    [
      "machine.toml of root, 0000",
      facts("/srv/k/machine.toml", "file", 0o000, ROOT),
      "other_owner",
      "sudo chown -h ada /srv/k/machine.toml && chmod u+rw /srv/k/machine.toml",
    ],
    [
      "machine.toml of root, 0440",
      facts("/srv/k/machine.toml", "file", 0o440, ROOT),
      "other_owner",
      "sudo chown -h ada /srv/k/machine.toml && chmod u+rw /srv/k/machine.toml",
    ],
    [
      "machine.toml of root, 0644",
      facts("/srv/k/machine.toml", "file", 0o644, ROOT),
      "other_owner",
      "sudo chown -h ada /srv/k/machine.toml",
    ],
    [
      "machine.toml of root, 0666",
      facts("/srv/k/machine.toml", "file", 0o666, ROOT),
      "other_owner",
      "sudo chown -h ada /srv/k/machine.toml && chmod go-w /srv/k/machine.toml",
    ],
    [
      "a file of root named with shell syntax",
      facts("/srv/a b/it's $(id)", "file", 0o644, ROOT),
      "other_owner",
      `sudo chown -h ada '/srv/a b/it'\\''s $(id)'`,
    ],
    [
      "a state folder of root that is a link",
      facts("/srv/s", "folder", 0o755, ROOT, { link: "/mnt/d/s", followsLink: true }),
      "other_owner",
      undefined,
    ],
    [
      "a folder of root below a link",
      facts("/srv/k", "folder", 0o755, ROOT, { linkAbove: { at: "/srv", to: "/data/srv" } }),
      "other_owner",
      undefined,
    ],
    [
      "machine.toml that is a link to a file of root",
      facts("/srv/k/machine.toml", "file", 0o777, ME, { link: "/etc/shadow" }),
      "link",
      undefined,
    ],
  ];

  test.each(rootRows)(
    "needs root: %s — the exact command, and the facts pass after it",
    (_, f, problem, command) => {
      expect(problemOf(f, P)).toBe(problem);
      expect(fixCommand([{ facts: f, problem }], "ada", P)).toBe(command);
      if (command !== undefined) expect(problemOf(applied(f, command), P)).toBeUndefined();
      else expect(repairOf(f, problem, P).chown).toBe(false);
    },
  );

  test("needs root: the exact lines for another owner, a link and a folder this user cannot look into", () => {
    const why =
      "TT Tasks uses machine.toml only when no one else can change it, because it names commands TT Tasks runs as you, so the service does not start.";
    const folder = facts("/srv/k", "folder", 0o700, ROOT);
    const file = facts("/srv/k/machine.toml", "file", 0o000, ROOT);
    const part = (
      what: "folder" | "file",
      f: PathFacts,
      problem: Unsafe,
      hides?: true,
    ): UnsafePart => ({
      what,
      path: f.path,
      problem,
      facts: f,
      ...(hides === undefined ? {} : { hides }),
    });
    // A root-owned 0700 folder: machine.toml inside it cannot be seen, and is checked next time.
    expect(unsafeConfigMessage([part("folder", folder, "other_owner", true)], "ada", P)).toBe(
      `TT Tasks's configuration folder (/srv/k) belongs to another user. ${why} TT Tasks cannot look inside /srv/k until that is fixed, so what is inside it (TT Tasks's machine.toml) is checked on the next start. To fix it, run: sudo chown -h ada /srv/k`,
    );
    // A root-owned 000 machine.toml: it becomes this user's and readable in one go.
    expect(unsafeConfigMessage([part("file", file, "other_owner")], "ada", P)).toBe(
      `TT Tasks's machine.toml (/srv/k/machine.toml) belongs to another user. ${why} To fix it, run: sudo chown -h ada /srv/k/machine.toml && chmod u+rw /srv/k/machine.toml`,
    );
    // Both, as root's mkdir and editor make them: one sudo, then what each needs.
    expect(
      unsafeConfigMessage(
        [
          part("folder", facts("/srv/k", "folder", 0o775, ROOT), "other_owner"),
          part("file", facts("/srv/k/machine.toml", "file", 0o640, ROOT), "other_owner"),
        ],
        "ada",
        P,
      ),
    ).toBe(
      `TT Tasks's configuration folder (/srv/k) and TT Tasks's machine.toml (/srv/k/machine.toml) belong to another user. ${why} To fix it, run: sudo chown -h ada /srv/k /srv/k/machine.toml && chmod g-w /srv/k`,
    );
    // A link: never a chown, which would change what it points to.
    const link = facts("/srv/k/machine.toml", "file", 0o777, ME, { link: "/etc/shadow" });
    expect(unsafeConfigMessage([part("file", link, "link")], "ada", P)).toBe(
      `TT Tasks's machine.toml (/srv/k/machine.toml) is a link to /etc/shadow. ${why} TT Tasks does not follow links for its configuration: put a real file in place of the link.`,
    );
    // A folder that fails beside a link: the command fixes the folder, and the link is named.
    expect(
      unsafeConfigMessage(
        [
          part("folder", facts("/srv/k", "folder", 0o775), "group_writable"),
          part("file", link, "link"),
        ],
        "ada",
        P,
      ),
    ).toBe(
      `TT Tasks's configuration folder (/srv/k) can be changed by the members of its group staff, not only by you; TT Tasks's machine.toml (/srv/k/machine.toml) is a link to /etc/shadow. ${why} TT Tasks does not follow links for its configuration: put a real file in place of the link. For the others, run: chmod g-w /srv/k`,
    );
    // Another owner through a link: no command, and the line says why.
    expect(
      unsafeMessage(
        [
          {
            name: "TT Tasks's state folder",
            facts: facts("/srv/s", "folder", 0o755, ROOT, { link: "/mnt/d/s", followsLink: true }),
            problem: "other_owner",
          },
        ],
        "Why",
        "ada",
        P,
      ),
    ).toBe(
      "TT Tasks's state folder (/srv/s) belongs to another user. Why. /srv/s is a link to /mnt/d/s, and TT Tasks gives no command that changes an owner through a link.",
    );
    expect(
      unsafeMessage(
        [
          {
            name: "TT Tasks's state folder",
            facts: facts("/srv/k", "folder", 0o755, ROOT, {
              linkAbove: { at: "/srv", to: "/data/srv" },
            }),
            problem: "other_owner",
          },
        ],
        "Why",
        "ada",
        P,
      ),
    ).toBe(
      "TT Tasks's state folder (/srv/k) belongs to another user. Why. /srv, on the way to /srv/k, is a link to /data/srv, and TT Tasks gives no command that changes an owner through a link.",
    );
  });

  test.skipIf(!posix || asRoot)(
    "a config folder this user cannot enter: it says so, and after its command the file inside is judged",
    () => {
      const dir = join(temp("ce"), "config");
      mkdirSync(dir, { mode: 0o700 });
      const file = join(dir, "machine.toml");
      writeFileSync(file, '[log]\nlevel = "warn"\n', { mode: 0o600 });
      chmodSync(dir, 0o000);
      const loaded = loadMachineConfig(dir, "linux");
      expect(loaded.unsafe?.map((p) => [p.what, p.problem, p.hides])).toEqual([
        ["folder", "no_access", true],
      ]);
      const line = unsafeConfigMessage(loaded.unsafe ?? [{} as UnsafePart]);
      expect(line).toContain(
        `TT Tasks cannot look inside ${shellPath(dir)} until that is fixed, so what is inside it (TT Tasks's machine.toml) is checked on the next start.`,
      );
      expect(commandIn(line)).toBe(`chmod u+rwx ${shellPath(dir)}`);
      paste(commandIn(line) ?? "false", dirname(dir));
      expect(loadMachineConfig(dir, "linux").config.log.level).toBe("warn");
      // A machine.toml of this user's that this user cannot read: named, with its command.
      chmodSync(file, 0o000);
      const unread = unsafeConfigMessage(
        loadMachineConfig(dir, "linux").unsafe ?? [{} as UnsafePart],
      );
      expect(unread).toContain("TT Tasks's machine.toml");
      expect(unread).toContain("cannot be read by you");
      paste(commandIn(unread) ?? "false", dir);
      expect(loadMachineConfig(dir, "linux").config.log.level).toBe("warn");
    },
  );

  test.skipIf(!posix)(
    "configuration is never read or written through a link: the link is named with its target, and nothing is followed",
    () => {
      const root = temp("ln");
      const dir = join(root, "config");
      mkdirSync(dir, { mode: 0o700 });
      const real = join(root, "real.toml");
      writeFileSync(real, '[log]\nlevel = "warn"\n', { mode: 0o600 });
      const file = join(dir, "machine.toml");
      symlinkSync(real, file);
      const loaded = loadMachineConfig(dir, "linux");
      expect(loaded.config.log.level).toBe("info");
      expect(loaded.unsafe?.map((p) => [p.what, p.problem, p.facts.link])).toEqual([
        ["file", "link", real],
      ]);
      expect(
        editMachineToml(dir, [{ op: "set", table: ["log"], key: "level", value: "debug" }]),
      ).toEqual({ ok: false, reason: "unsafe" });
      expect(readFileSync(real, "utf8")).toBe('[log]\nlevel = "warn"\n');
      expect(lstatSync(file).isSymbolicLink()).toBe(true);
      // The config folder itself as a link to a real, private folder with a valid file.
      const elsewhere = join(root, "elsewhere");
      mkdirSync(elsewhere, { mode: 0o700 });
      writeFileSync(join(elsewhere, "machine.toml"), '[log]\nlevel = "warn"\n', { mode: 0o600 });
      const linked = join(root, "linked-config");
      symlinkSync(elsewhere, linked);
      expect(loadMachineConfig(linked, "linux").unsafe?.map((p) => [p.what, p.problem])).toEqual([
        ["folder", "link"],
      ]);
    },
  );

  const rootFile = unreadableRootFile();
  test.skipIf(rootFile === undefined)(
    "a machine.toml that is a link to a root-owned file: named as a link, and never a chown that would change that file",
    () => {
      const dir = join(temp("pr"), "config");
      mkdirSync(dir, { mode: 0o700 });
      const file = join(dir, "machine.toml");
      symlinkSync(rootFile ?? "", file);
      const loaded = loadMachineConfig(dir, "linux");
      expect(loaded.problems).toEqual([{ key: "", code: "unsafe_permissions", severity: "error" }]);
      expect(loaded.unsafe?.map((p) => [p.what, p.path, p.problem])).toEqual([
        ["file", file, "link"],
      ]);
      const line = unsafeConfigMessage(loaded.unsafe ?? [{} as UnsafePart], "ada");
      expect(line).toContain(`is a link to ${rootFile ?? ""}`);
      expect(line).toContain("TT Tasks does not follow links for its configuration");
      expect(line).not.toContain("chown");
      expect(line).not.toContain("run:");
    },
  );
});
