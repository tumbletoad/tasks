// machine.toml read strictly (A2 3.2.4, A4 3.2, A4 3.6.1, A1 3.15): one fixture and one golden file
// per OS, each OS's path rules checked on every OS, and a fixture with every kind of problem whose
// values hold sentinels that no problem may carry. Fixture paths only.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  DEFAULT_CONFIG,
  fatalProblems,
  loadMachineConfig,
  MACHINE_TOML,
  parseMachineConfig,
  sectionOf,
  type MachineConfig,
} from "./machine-toml.ts";
import { currentPerson } from "../hub/permissions.ts";
import { unsafeConfigMessage } from "./messages.ts";
import { MAX_CONFIG_BYTES } from "./toml.ts";

const fail = (): never => {
  throw new Error("Expected the parts that fail the rule");
};

const FIXTURES = fileURLToPath(new URL("../../test/config/", import.meta.url));
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

/** The configuration as JSON: the approvals map as an object, an absent value as null. */
const json = (value: { config: MachineConfig; problems: unknown }) =>
  `${JSON.stringify(
    {
      ...value,
      config: { ...value.config, approvals: Object.fromEntries(value.config.approvals) },
    },
    (_key, v: unknown) => (v === undefined ? null : v),
    2,
  )}\n`;

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "tasks-config-"));
  temps.push(dir);
  return dir;
};

describe("[A2.3.2.4.config.golden] machine.toml read strictly into typed values and problems", () => {
  for (const os of ["linux", "win32", "darwin"] as const) {
    test(`${os}: the golden configuration`, async () => {
      const result = parseMachineConfig(fixture(`machine.${os}.toml`), os);
      await expect(json(result)).toMatchFileSnapshot(`../../test/golden/config.${os}.json`);
      expect(fatalProblems(result.problems)).toEqual([]);
    });
  }

  test("remote_allowed is false unless an instance sets it, and enabled is true unless it is cleared", () => {
    const { config } = parseMachineConfig(fixture("machine.linux.toml"), "linux");
    expect(config.instances.map((i) => [i.id, i.remoteAllowed, i.enabled])).toEqual([
      ["codex-work", false, true],
      ["codex-second", false, false],
      ["t3-codex-work", true, true],
      ["codex-app", false, true],
    ]);
  });

  test("[A2.3.2.4.config.space-copies] copies of one space share its ID in [[spaces]]; a folder named twice is refused", () => {
    const id = "sp_43f0gjcvzgaa1gh5my6qxwcj7m";
    const copies = [
      "[[spaces]]",
      `id = "${id}"`,
      'path = "/home/mira/Tasks/mira"',
      "enabled = false",
      "",
      "[[spaces]]",
      `id = "${id}"`,
      'path = "/home/mira/Tasks/mira-copy"',
      "",
    ].join("\n");
    const read = parseMachineConfig(copies, "linux");
    expect(read.problems).toEqual([]);
    expect(read.config.spaces).toEqual([
      { id, path: "/home/mira/Tasks/mira", enabled: false },
      { id, path: "/home/mira/Tasks/mira-copy", enabled: true },
    ]);
    // One folder named twice, under any spelling Windows reads as the same: fatal for the start.
    const twice = `${copies}\n[[spaces]]\nid = "sp_3z8sm956jp8dajmtsar5kx026c"\npath = "/home/mira/Tasks/mira"\n`;
    expect(fatalProblems(parseMachineConfig(twice, "linux").problems)).toEqual([
      { key: "spaces[3].path", code: "duplicate", severity: "error" },
    ]);
    const windows = `[[spaces]]\nid = "${id}"\npath = 'C:\\Tasks\\Mira'\n\n[[spaces]]\nid = "${id}"\npath = 'c:\\tasks\\mira'\n`;
    expect(fatalProblems(parseMachineConfig(windows, "win32").problems)).toHaveLength(1);
  });

  test("an instance may not be called manual: the word is the hand-made MCP entry's (A3 3.7.4)", () => {
    const text = (id: string) =>
      `[[instance]]\nid = "${id}"\ntarget = "codex-cli"\nlabel = "Codex"\n`;
    const manual = parseMachineConfig(text("manual"), "linux");
    expect(manual.config.instances).toEqual([]);
    expect(manual.problems).toEqual([
      { key: "instance[1].id", code: "invalid_value", severity: "error" },
    ]);
    const other = parseMachineConfig(text("manual-codex"), "linux");
    expect(other.config.instances.map((i) => i.id)).toEqual(["manual-codex"]);
    expect(other.problems).toEqual([]);
  });

  test("paths are judged by the machine's own OS: a Windows path is not absolute on Linux, and the reverse", () => {
    const windows = parseMachineConfig(fixture("machine.win32.toml"), "linux");
    expect(windows.config.spaces).toEqual([]);
    expect(fatalProblems(windows.problems)).toEqual([
      { key: "spaces[1].path", code: "not_absolute", severity: "error" },
    ]);
    const linux = parseMachineConfig(fixture("machine.linux.toml"), "win32");
    expect(linux.config.roots).toEqual([]);
    expect(linux.problems.filter((p) => p.code === "not_absolute").map((p) => p.key)).toEqual(
      expect.arrayContaining(["spaces[1].path", "roots.work.path", "instance[1].exec"]),
    );
  });

  test("an instance's home variable names an absolute folder, and on Windows no two env names differ only in case", () => {
    const read = (env: string, os: NodeJS.Platform) =>
      parseMachineConfig(
        `[[instance]]\nid = "codex-x"\ntarget = "codex-cli"\nlabel = "Codex x"\nenv = { ${env} }\n`,
        os,
      );
    // The agent's environment holds one of two case aliases on Windows by their order alone.
    const aliases = read(String.raw`CODEX_HOME = 'C:\a', codex_home = 'C:\b'`, "win32");
    expect(aliases.config.instances).toEqual([]);
    expect(aliases.problems).toEqual([
      { key: "instance[1].env.codex_home", code: "duplicate", severity: "error" },
    ]);
    // On Linux they are two variables, and only CODEX_HOME selects the home.
    expect(read(`CODEX_HOME = "/a", codex_home = "b"`, "linux").config.instances).toHaveLength(1);
    // A relative or empty home resolves against the task's folder in the agent, and elsewhere in
    // Tasks; on Windows the variable counts in any case.
    for (const [env, os, name] of [
      [`CODEX_HOME = "codex-home"`, "linux", "CODEX_HOME"],
      [`CODEX_HOME = ""`, "linux", "CODEX_HOME"],
      [`CLAUDE_CONFIG_DIR = "./claude"`, "linux", "CLAUDE_CONFIG_DIR"],
      [`codex_home = 'codex-home'`, "win32", "codex_home"],
      [`CODEX_HOME = '/home/mira/.codex'`, "win32", "CODEX_HOME"],
    ] as const) {
      const relative = read(env, os);
      expect(relative.config.instances).toEqual([]);
      expect(relative.problems).toEqual([
        { key: `instance[1].env.${name}`, code: "not_absolute", severity: "error" },
      ]);
    }
    expect(read(String.raw`CODEX_HOME = 'D:\codex-b'`, "win32").config.instances).toHaveLength(1);
  });

  test("every kind of problem names a key and a fixed code, never a value", async () => {
    const text = fixture("machine.problems.toml");
    const result = parseMachineConfig(text, "linux");
    await expect(json(result)).toMatchFileSnapshot("../../test/golden/config.problems.json");
    const problems = JSON.stringify(result.problems);
    expect(problems).not.toContain("SENTINEL");
    // Only the entries without an error remain.
    expect(result.config.spaces.map((s) => s.path)).toEqual(["/home/mira/Tasks/b"]);
    expect(result.config.instances.map((i) => i.id)).toEqual(["good", "app-one"]);
    expect(result.config.approvals.size).toBe(0);
    expect(result.config.log.level).toBe("info");
    expect(result.config.terminal).toEqual(DEFAULT_CONFIG.terminal);
    // [[spaces]] errors stop the service; the others only drop their entry.
    expect(new Set(fatalProblems(result.problems).map(sectionOf))).toEqual(new Set(["spaces"]));
    expect(new Set(result.problems.map(sectionOf))).toEqual(
      new Set([
        "other",
        "log",
        "http",
        "spaces",
        "roots",
        "terminal",
        "instance",
        "approvals",
        "setup",
      ]),
    );
  });

  test("the file: missing gives the defaults; unreadable, too large, not UTF-8 and not TOML are fatal without content", () => {
    const dir = tempDir();
    expect(loadMachineConfig(dir, "linux")).toEqual({
      present: false,
      config: DEFAULT_CONFIG,
      problems: [],
    });
    const file = join(dir, MACHINE_TOML);
    const codeOf = () => loadMachineConfig(dir, "linux").problems.map((p) => p.code);

    writeFileSync(file, Buffer.from([0x5b, 0x6c, 0x6f, 0x67, 0x5d, 0x0a, 0xff, 0xfe]), {
      mode: 0o600,
    });
    expect(codeOf()).toEqual(["encoding"]);
    writeFileSync(file, "#".repeat(MAX_CONFIG_BYTES + 1), { mode: 0o600 });
    expect(codeOf()).toEqual(["too_large"]);
    writeFileSync(file, '[log]\nlevel = "info"\nSENTINEL secret = 1\n', { mode: 0o600 });
    const syntax = loadMachineConfig(dir, "linux").problems;
    expect(syntax).toEqual([{ key: "", code: "syntax", severity: "error", line: 3, column: 10 }]);
    expect(fatalProblems(syntax)).toHaveLength(1);
    // A byte order mark is allowed.
    writeFileSync(file, `${String.fromCharCode(0xfeff)}[log]\nlevel = "warn"\n`, { mode: 0o600 });
    expect(loadMachineConfig(dir, "linux").config.log.level).toBe("warn");
    rmSync(file);
    mkdirSync(file);
    expect(codeOf()).toEqual(["unreadable"]);
  });

  test("nesting is bounded over the whole document: headers and dotted keys count, not only inline values", () => {
    const deepHeader = `[remote.${"x.".repeat(5000)}x]\nk = 1\n`;
    const deepDotted = `[security]\n${"k.".repeat(200)}v = 1\n`;
    const deepArrays = `[[remote.${"a.".repeat(40)}a]]\n`;
    for (const text of [deepHeader, deepDotted, deepArrays]) {
      const result = parseMachineConfig(text, "linux");
      expect(result.problems).toEqual([{ key: "", code: "too_large", severity: "error" }]);
      expect(fatalProblems(result.problems)).toHaveLength(1);
      expect(result.config).toBe(DEFAULT_CONFIG);
    }
    // Within the bound, a reserved section nests as it likes.
    const fine = parseMachineConfig(`[remote.${"x.".repeat(20)}x]\nk = 1\n`, "linux");
    expect(fine.problems).toEqual([]);
  });

  test("a configuration folder that is a link is named as a link to its target, on every OS", () => {
    const dir = tempDir();
    const real = join(dir, "real");
    mkdirSync(real, { mode: 0o700 });
    writeFileSync(join(real, MACHINE_TOML), '[log]\nlevel = "warn"\n', { mode: 0o600 });
    // A junction on Windows needs no privilege; elsewhere the type is ignored.
    const folder = join(dir, "config");
    symlinkSync(real, folder, "junction");
    const linked = loadMachineConfig(folder, "linux");
    expect(linked.problems).toEqual([{ key: "", code: "unsafe_permissions", severity: "error" }]);
    expect(linked.config).toBe(DEFAULT_CONFIG);
    const said = unsafeConfigMessage(linked.unsafe ?? fail());
    expect(said).toMatch(/configuration folder \(.+\) is a link to .+real/u);
    expect(said).toContain("does not follow links for its configuration");
  });

  test("a machine.toml that is a link is named as a link to its target, on every OS", (context) => {
    const dir = tempDir();
    const real = join(dir, "real");
    mkdirSync(real, { mode: 0o700 });
    writeFileSync(join(real, MACHINE_TOML), '[log]\nlevel = "warn"\n', { mode: 0o600 });
    const config = join(dir, "plain");
    mkdirSync(config, { mode: 0o700 });
    try {
      symlinkSync(join(real, MACHINE_TOML), join(config, MACHINE_TOML), "file");
    } catch (error) {
      // A file link on Windows needs Developer Mode or an administrator.
      if ((error as NodeJS.ErrnoException).code === "EPERM") context.skip();
      throw error;
    }
    const file = loadMachineConfig(config, "linux");
    expect(file.problems).toEqual([{ key: "", code: "unsafe_permissions", severity: "error" }]);
    expect(unsafeConfigMessage(file.unsafe ?? fail())).toMatch(
      /machine\.toml \(.+\) is a link to .+machine\.toml/u,
    );
  });

  test.skipIf(process.platform === "win32")(
    "Linux and macOS: the file's size and kind are checked before a byte is read (a huge sparse file, a FIFO)",
    () => {
      const dir = tempDir();
      const file = join(dir, MACHINE_TOML);
      // 4 GiB without data: reading it whole would fail (or exhaust memory) before any check.
      writeFileSync(file, "", { mode: 0o600 });
      truncateSync(file, 4 * 1024 * 1024 * 1024);
      expect(loadMachineConfig(dir, "linux").problems).toEqual([
        { key: "", code: "too_large", severity: "error" },
      ]);
      rmSync(file);
      // A FIFO would block a plain read until a writer came.
      const made = spawnSync("mkfifo", ["-m", "600", file]);
      expect(made.status).toBe(0);
      expect(loadMachineConfig(dir, "linux").problems).toEqual([
        { key: "", code: "unreadable", severity: "error" },
      ]);
    },
  );

  test.skipIf(process.platform === "win32")(
    "Linux and macOS: a file or folder others can write is not used, since it names commands Tasks runs",
    () => {
      const dir = tempDir();
      const file = join(dir, MACHINE_TOML);
      writeFileSync(file, '[log]\nlevel = "warn"\n', { mode: 0o600 });
      // Group write is refused unless the group is the person's own private group, which a new
      // file's group is when this account has one (permissions.ts, A2 3.2.2 rule 5).
      const own = currentPerson()?.ownGroup();
      const ownGroup = (path: string) => own !== undefined && own === statSync(path).gid;
      expect(loadMachineConfig(dir, "linux").config.log.level).toBe("warn");
      for (const [path, mode, restore, refused] of [
        [file, 0o620, 0o600, !ownGroup(file)],
        [file, 0o602, 0o600, true],
        [dir, 0o770, 0o700, !ownGroup(dir)],
        [dir, 0o707, 0o700, true],
      ] as const) {
        chmodSync(path, mode);
        const loaded = loadMachineConfig(dir, "linux");
        if (refused) {
          expect(loaded.problems).toEqual([
            { key: "", code: "unsafe_permissions", severity: "error" },
          ]);
          expect(loaded.config).toBe(DEFAULT_CONFIG);
          expect(fatalProblems(loaded.problems)).toHaveLength(1);
        } else {
          expect(loaded.problems).toEqual([]);
          expect(loaded.config.log.level).toBe("warn");
        }
        chmodSync(path, restore);
      }
    },
  );
});
