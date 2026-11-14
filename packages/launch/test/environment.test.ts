// The agent's environment (A4 3.8; A7 3.9 M2.09): the layers, the login-shell snapshot with its
// deadline and its defined results, the scrub list. A fake login shell from testkit stands in for a
// person's profile; one test on Linux runs a real bash with a home of its own, and one on Windows
// reads the real registry (read only).
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { FAKE_SHELL, readJsonLines } from "@tasks/testkit";
import {
  agentEnvironment,
  captureOutput,
  expandWindows,
  scriptOutput,
  holdFolder,
  mergeLayers,
  parseRegistryOutput,
  parseSessionEnvironment,
  parseSnapshot,
  registryEnvironment,
  REGISTRY_READS,
  REGISTRY_SCRIPT,
  RESOLVING,
  SCRUB_NAMES,
  scrubbed,
  SNAPSHOT_FILE,
  snapshotScript,
  terminalEnvironment,
  unquoteAnsiC,
  UserEnvironment,
  type Capture,
  type RegistryValue,
  type UserEnvironmentOptions,
} from "../src/index.ts";

/** A folder's identity as a launch's check carries it. */
const identityOf = (path: string): { dev: string; ino: string } => {
  const found = statSync(path, { bigint: true });
  return { dev: found.dev.toString(), ino: found.ino.toString() };
};

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "tasks-env-"));
  temps.push(dir);
  return dir;
};

const SPACE = "sp_3q7k9d2xw8f4r6t1c5v0b2n8a7";

describe("[A4.5.environment.scrub] A4 3.8's scrub and the two kinds of base", () => {
  test("the person's own environment is taken whole, scrubbed after merging; the service's goes through the allow-list", () => {
    const base = {
      PATH: "/home/mira/.nvm/versions/node/v24/bin:/usr/bin",
      HOME: "/home/mira",
      GOPATH: "/home/mira/go",
      FIXTURE_PROFILE_EXPORT: "1",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_PROJECT_DIR: "/x",
      CODEX_THREAD_ID: "t",
      CODEX_SESSION_ID: "s",
      CODEX_SANDBOX: "seatbelt",
      CODEX_SANDBOX_NETWORK_DISABLED: "1",
      T3CODE_THREAD_ID: "x",
      ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: "--require /tmp/x.js",
      TASKS_HOME: "/inherited",
      TASKS_TICKET: "Z".repeat(24),
      CODEX_HOME: "/inherited/codex",
    };
    const additions = { TASKS_TICKET: "T".repeat(24), TASKS_SPACE: SPACE };
    const user = agentEnvironment({
      platform: "linux",
      base,
      baseKind: "user",
      instance: { NODE_OPTIONS: "--inspect", FIXTURE_INSTANCE: "1", CLAUDE_CONFIG_DIR: "/c" },
      additions,
      executable: "/home/mira/.nvm/versions/node/v24/bin/codex",
    });
    expect(user).toEqual({
      CLAUDE_CONFIG_DIR: "/c",
      FIXTURE_INSTANCE: "1",
      FIXTURE_PROFILE_EXPORT: "1",
      GOPATH: "/home/mira/go",
      HOME: "/home/mira",
      TASKS_SPACE: SPACE,
      TASKS_TICKET: "T".repeat(24),
      // The executable's folder was first already: PATH unchanged.
      PATH: "/home/mira/.nvm/versions/node/v24/bin:/usr/bin",
    });
    const service = agentEnvironment({
      platform: "linux",
      base,
      instance: {},
      additions,
      executable: "/opt/agent/bin/agent",
    });
    expect(Object.keys(service).sort()).toEqual(["HOME", "PATH", "TASKS_SPACE", "TASKS_TICKET"]);
    // The executable's own folder in front of PATH (nvm keeps `node` beside it).
    expect(service["PATH"]).toBe("/opt/agent/bin:/home/mira/.nvm/versions/node/v24/bin:/usr/bin");
  });

  test("Windows names are scrubbed whatever their case, and PATH is left as the layers gave it", () => {
    const env = agentEnvironment({
      platform: "win32",
      base: {
        Path: "C:\\Windows",
        ClaudeCode: "1",
        node_options: "x",
        Tasks_Home: "C:\\k",
        JAVA_HOME: "C:\\j",
      },
      baseKind: "user",
      instance: {},
      additions: {},
      executable: "C:\\agent\\agent.exe",
    });
    expect(env["Path"]).toBe("C:\\Windows");
    expect(Object.keys(env).map((n) => n.toUpperCase())).not.toContain("CLAUDECODE");
    expect(Object.keys(env).map((n) => n.toUpperCase())).not.toContain("NODE_OPTIONS");
    expect(Object.keys(env).map((n) => n.toUpperCase())).not.toContain("TASKS_HOME");
    expect(env["JAVA_HOME"]).toBe("C:\\j");
    for (const name of SCRUB_NAMES) expect(scrubbed(name.toLowerCase(), "win32"), name).toBe(true);
    expect(scrubbed("claudecode", "linux")).toBe(false);
  });

  test("a terminal's own environment: the service's scrubbed, the session on top, of the product's only the install's home", () => {
    const env = terminalEnvironment(
      {
        PATH: "/usr/bin",
        TASKS_HOME: "/home/mira/tasks-test",
        TASKS_SERVICE_MANAGER: "systemd",
        CLAUDECODE: "1",
        DISPLAY: ":1",
      },
      { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
      "linux",
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      TASKS_HOME: "/home/mira/tasks-test",
      DISPLAY: ":0",
      WAYLAND_DISPLAY: "wayland-0",
    });
  });
});

describe("[A4.5.environment.layers] the session layer, the snapshot's parse and the registry layers", () => {
  test("only the bytes between the two fences count, whatever a profile prints around them", () => {
    const marker = "0123456789abcdef01234567";
    const fence = `\0${marker}\0`;
    const out = Buffer.concat([
      Buffer.from("motd\n\u001b[1mnoise\u001b[0m\0half-entry\n"),
      Buffer.from(fence),
      Buffer.from("A=1\0B=two words\0C=a=b\0PWD=/home/mira\0TERM=dumb\0SHLVL=2\0_=/usr/bin/env\0"),
      Buffer.from(`${RESOLVING}=1\0COLORTERM=truecolor\0`),
      Buffer.from([0x44, 0x3d, 0xff, 0xfe, 0x00]), // D= followed by invalid UTF-8: left out
      Buffer.from("not-an-entry\0=empty-name\0"),
      Buffer.from(fence),
      Buffer.from("logout noise"),
    ]);
    expect(parseSnapshot(out, marker)).toEqual({ A: "1", B: "two words", C: "a=b" });
    expect(parseSnapshot(Buffer.from(`noise${fence}A=1\0`), marker)).toBeUndefined();
    expect(parseSnapshot(Buffer.from("A=1\0"), marker)).toBeUndefined();
    expect(() => snapshotScript("$(id)")).toThrow();
    expect(snapshotScript(marker)).toBe(
      `printf '\\0%s\\0' ${marker}; env -0; printf '\\0%s\\0' ${marker}`,
    );
  });

  test("systemctl's show-environment: the session names only, $'…' decoded exactly or left out", () => {
    const text = [
      "DISPLAY=:0",
      "WAYLAND_DISPLAY=wayland-0",
      "XDG_SESSION_TYPE=wayland",
      "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
      "SSH_AUTH_SOCK=/run/user/1000/keyring/ssh",
      "TERMINAL=ghostty",
      "XAUTHORITY=$'/run/user/1000/.mutter-Xwaylandauth.\\x41\\n'",
      "PATH=/usr/bin",
      "HOME=/home/mira",
      "XDG_BROKEN=$'unterminated\\'",
    ].join("\n");
    expect(parseSessionEnvironment(text)).toEqual({
      DISPLAY: ":0",
      WAYLAND_DISPLAY: "wayland-0",
      XDG_SESSION_TYPE: "wayland",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      SSH_AUTH_SOCK: "/run/user/1000/keyring/ssh",
      TERMINAL: "ghostty",
      XAUTHORITY: "/run/user/1000/.mutter-Xwaylandauth.A\n",
    });
    expect(unquoteAnsiC("$'a\\tb\\101\\''")).toBe("a\tbA'");
    expect(unquoteAnsiC("$'\\xff'")).toBeUndefined(); // not UTF-8
    // A character outside the BMP between escapes stays whole, never two replacement characters.
    expect(unquoteAnsiC("$'/fixture/emoji-🐸 folder\\tauth'")).toBe(
      "/fixture/emoji-🐸 folder\tauth",
    );
    expect(parseSessionEnvironment("XAUTHORITY=$'/run/user/1000/🐸\\n'")["XAUTHORITY"]).toBe(
      "/run/user/1000/🐸\n",
    );
  });

  test("systemctl --user reaches the user manager: its helper gets the account's runtime folder and bus, nothing else of the service's", async () => {
    const requests: { argv: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
    const capture: Capture = (request) => {
      requests.push({ argv: request.argv, env: request.env });
      return Promise.resolve({
        kind: "done",
        output: Buffer.from("DISPLAY=:0\nXDG_RUNTIME_DIR=/run/user/1000\nPATH=/usr/bin\n"),
        code: 0,
        ms: 1,
      });
    };
    const env = new UserEnvironment({
      platform: "linux",
      serviceEnv: {
        PATH: "/usr/bin:/bin",
        HOME: "/home/mira",
        XDG_RUNTIME_DIR: "/run/user/1000",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        SERVICE_SECRET_FIXTURE: "never",
      },
      stateDir: temp(),
      home: "/home/mira",
      systemctl: "/usr/bin/systemctl",
      capture,
    });
    expect(await env.session()).toEqual({ DISPLAY: ":0", XDG_RUNTIME_DIR: "/run/user/1000" });
    const [asked] = requests;
    expect(asked?.argv).toEqual(["/usr/bin/systemctl", "--user", "show-environment"]);
    expect(asked?.env).toMatchObject({
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      HOME: "/home/mira",
    });
    expect(asked?.env).not.toHaveProperty("SERVICE_SECRET_FIXTURE");
  });

  test("the session beats the snapshot; the snapshot's SSH agent only when its socket exists", () => {
    const session = { DISPLAY: ":0", SSH_AUTH_SOCK: "/run/user/1000/keyring/ssh" };
    const snapshot = { DISPLAY: ":9", PATH: "/nvm/bin", SSH_AUTH_SOCK: "/home/mira/.gnupg/S.ssh" };
    expect(mergeLayers(session, snapshot, () => true)).toEqual({
      DISPLAY: ":0",
      PATH: "/nvm/bin",
      SSH_AUTH_SOCK: "/home/mira/.gnupg/S.ssh",
    });
    expect(mergeLayers(session, snapshot, () => false)["SSH_AUTH_SOCK"]).toBe(
      "/run/user/1000/keyring/ssh",
    );
    expect(mergeLayers({}, snapshot, () => false)).not.toHaveProperty("SSH_AUTH_SOCK");
  });

  test("Windows: the account's names, the system's values, then the user's, expanded, Path joined", () => {
    const system = new Map<string, RegistryValue>([
      ["Path", { kind: "ExpandString", value: "%SystemRoot%\\system32;%SystemRoot%" }],
      ["ComSpec", { kind: "ExpandString", value: "%SystemRoot%\\system32\\cmd.exe" }],
      ["OS", { kind: "String", value: "Windows_NT" }],
    ]);
    const user = new Map<string, RegistryValue>([
      ["Path", { kind: "ExpandString", value: "%USERPROFILE%\\.local\\bin;%UNKNOWN%" }],
      ["TEMP", { kind: "ExpandString", value: "%USERPROFILE%\\AppData\\Local\\Temp" }],
      ["JAVA_HOME", { kind: "String", value: "C:\\jdk %NOT_EXPANDED%" }],
    ]);
    const env = registryEnvironment(system, user, {
      SystemRoot: "C:\\Windows",
      USERPROFILE: "C:\\Users\\Mira",
      SERVICE_ONLY: "never",
    });
    expect(env).toEqual({
      SystemRoot: "C:\\Windows",
      USERPROFILE: "C:\\Users\\Mira",
      Path: "C:\\Windows\\system32;C:\\Windows;C:\\Users\\Mira\\.local\\bin;%UNKNOWN%",
      ComSpec: "C:\\Windows\\system32\\cmd.exe",
      OS: "Windows_NT",
      TEMP: "C:\\Users\\Mira\\AppData\\Local\\Temp",
      JAVA_HOME: "C:\\jdk %NOT_EXPANDED%",
    });
    expect(expandWindows("%systemroot%\\x", { SystemRoot: "C:\\W" })).toBe("C:\\W\\x");

    // Windows' order, whatever order the reader listed the values in: in each scope the REG_SZ
    // values first, then the REG_EXPAND_SZ values expanded against what came before that step
    // (never against each other); the account's own names last.
    const orderedSystem = new Map<string, RegistryValue>([
      ["Path", { kind: "ExpandString", value: "%JAVA_HOME%\\bin;%SystemRoot%" }],
      ["JAVA_HOME", { kind: "String", value: "C:\\fixture-jdk" }],
      ["A_EXP", { kind: "ExpandString", value: "%B_EXP%" }],
      ["B_EXP", { kind: "ExpandString", value: "b" }],
    ]);
    const orderedUser = new Map<string, RegistryValue>([
      ["Path", { kind: "ExpandString", value: "%TOOLS%\\bin" }],
      ["TOOLS", { kind: "String", value: "C:\\tools" }],
      ["USERNAME", { kind: "String", value: "not-the-account" }],
    ]);
    const ordered = registryEnvironment(orderedSystem, orderedUser, {
      SystemRoot: "C:\\Windows",
      USERNAME: "mira",
    });
    expect(ordered["Path"]).toBe("C:\\fixture-jdk\\bin;C:\\Windows;C:\\tools\\bin");
    expect(ordered["A_EXP"]).toBe("%B_EXP%");
    expect(ordered["B_EXP"]).toBe("b");
    expect(ordered["USERNAME"]).toBe("mira");

    // The derived names at their own steps: the account's profile only after the system's values
    // (a system value cannot use it, and cannot replace it), the machine's before them.
    const staged = registryEnvironment(
      new Map<string, RegistryValue>([
        ["SYS_PROFILE", { kind: "ExpandString", value: "%USERPROFILE%\\x" }],
        ["SYS_ROOT", { kind: "ExpandString", value: "%SystemRoot%\\y" }],
        ["APPDATA", { kind: "String", value: "C:\\system-appdata" }],
      ]),
      new Map<string, RegistryValue>([
        ["TOOL_HOME", { kind: "ExpandString", value: "%APPDATA%\\tool" }],
      ]),
      {
        SystemRoot: "C:\\Windows",
        USERPROFILE: "C:\\Users\\Mira",
        APPDATA: "C:\\Users\\Mira\\AppData\\Roaming",
      },
    );
    expect(staged["SYS_PROFILE"]).toBe("%USERPROFILE%\\x");
    expect(staged["SYS_ROOT"]).toBe("C:\\Windows\\y");
    expect(staged["APPDATA"]).toBe("C:\\Users\\Mira\\AppData\\Roaming");
    expect(staged["TOOL_HOME"]).toBe("C:\\Users\\Mira\\AppData\\Roaming\\tool");
    // The reader's lines: names and values in base64 of UTF-8, then `end`.
    const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
    const output = (...lines: string[]): string => [...lines, "end"].join("\n");
    const read = parseRegistryOutput(
      output(
        `system ExpandString ${b64("Path")} ${b64("C:\\é")}`,
        `user String ${b64("TOOL")} ${b64("")}`,
      ),
    );
    expect(read?.system.get("Path")).toEqual({ kind: "ExpandString", value: "C:\\é" });
    expect(read?.user.get("TOOL")).toEqual({ kind: "String", value: "" });
    expect(parseRegistryOutput(output())).toEqual({ system: new Map(), user: new Map() });
    // Each field is its exact text: a leading U+FEFF is part of a name or a value, not a byte
    // order mark, so two names never fold into one.
    const marked = parseRegistryOutput(
      output(`user String ${b64("﻿TOOL")} ${b64("﻿x")}`, `user String ${b64("TOOL")} ${b64("y")}`),
    );
    expect(marked?.user.get("﻿TOOL")).toEqual({ kind: "String", value: "﻿x" });
    expect(marked?.user.get("TOOL")).toEqual({ kind: "String", value: "y" });
    for (const bad of [
      "not the reader's output",
      // Cut off before its end.
      `system String ${b64("A")} ${b64("1")}`,
      // A field missing, not empty: an empty one is still written, as an empty field.
      output(`user String ${b64("X")}`),
      output(`user Binary ${b64("X")} ${b64("")}`),
      output(`machine String ${b64("X")} ${b64("1")}`),
      output(`user String ${b64("X")} ${b64("1")} extra`),
      output(`user String ${b64("X")} not*base64`),
      // Base64, but not UTF-8.
      output(`user String ${b64("X")} ${Buffer.from([0xff, 0xfe]).toString("base64")}`),
    ]) {
      expect(parseRegistryOutput(bad), bad).toBeUndefined();
    }
  });

  test("the registry reader's output is checked byte by byte: a byte it never writes is no layers, and the base is the service's own environment", async () => {
    const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
    const good = `user String ${b64("TOOL")} ${b64("1")}\nend`;
    const serviceEnv = { PATH: "C:\\fixture", SystemRoot: "C:\\Windows" };
    const base = (output: Buffer) =>
      new UserEnvironment({
        platform: "win32",
        serviceEnv,
        stateDir: temp(),
        home: temp(),
        capture: () => Promise.resolve({ kind: "done", code: 0, ms: 1, output }),
      }).base();
    const read = await base(Buffer.from(good, "latin1"));
    expect(read.kind).toBe("user");
    expect(read.env["TOOL"]).toBe("1");
    for (const bad of [
      // "end" with each byte's high bit set: Node's "ascii" decoding clears it.
      Buffer.from([0xe5, 0xee, 0xe4]),
      Buffer.concat([
        Buffer.from(good.replace(/end$/, ""), "latin1"),
        Buffer.from([0xe5, 0xee, 0xe4]),
      ]),
      Buffer.from(`${good}\u0000`, "latin1"),
      Buffer.from(good.replace("user", "us\u00e9r"), "utf8"),
    ]) {
      expect(await base(bad)).toEqual({ kind: "service", env: serviceEnv });
    }
    expect(scriptOutput(Buffer.from("a b\r\nend", "latin1"))).toBe("a b\r\nend");
    expect(scriptOutput(Buffer.from([0x61, 0x09, 0x62]))).toBeUndefined();
  });

  test("the registry reader calls no cmdlet: Windows PowerShell never searches its module path for one", () => {
    // A cmdlet's name is Verb-Noun; the reader is .NET calls and PowerShell's own statements.
    expect(REGISTRY_SCRIPT).not.toMatch(/\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/);
    expect(REGISTRY_SCRIPT).not.toMatch(/\|/);
  });

  test("the registry reader reads no .NET property but through its accessor, and a key only through the shared reads", () => {
    // PowerShell 5.1 turns a getter's exception into $null: type literals aside, every `.Name` is
    // a call. `OpenSubKey` gives null for a failed open too, so only `sk`/`key` call it.
    const code = REGISTRY_SCRIPT.replace(/\[[A-Za-z][\w.]*(?:\[\])?\]/g, "");
    expect(code).not.toMatch(/[\w)\]]\.[A-Za-z_]\w*(?![\w(])/);
    expect(REGISTRY_SCRIPT.startsWith(`$ErrorActionPreference='Stop';${REGISTRY_READS};`)).toBe(
      true,
    );
    expect(REGISTRY_SCRIPT.split("OpenSubKey").length).toBe(
      REGISTRY_READS.split("OpenSubKey").length,
    );
  });
});

/** A capture that runs the testkit fake shell in place of the login shell, with its mode. */
function fakeShell(
  mode: string,
  extra: Record<string, string> = {},
): { capture: Capture; log: string } {
  const log = join(temp(), "shell.jsonl");
  const capture: Capture = (request) =>
    request.argv[0] === "/bin/fake-login-shell"
      ? captureOutput({
          ...request,
          argv: [process.execPath, FAKE_SHELL, ...request.argv.slice(1)],
          env: { ...request.env, FAKE_SHELL_MODE: mode, FAKE_SHELL_LOG: log, ...extra },
        })
      : Promise.resolve({ kind: "failed", ms: 0 });
  return { capture, log };
}

function environmentWith(
  capture: Capture,
  state: string,
  options: {
    now?: () => number;
    boot?: () => string;
    timeoutMs?: number;
    holdFolder?: UserEnvironmentOptions["holdFolder"];
  } = {},
): UserEnvironment {
  return new UserEnvironment({
    ...(options.holdFolder === undefined ? {} : { holdFolder: options.holdFolder }),
    platform: "linux",
    serviceEnv: {
      PATH: "/usr/bin:/bin",
      HOME: "/home/mira",
      LANG: "nl_NL.UTF-8",
      SERVICE_SECRET_FIXTURE: "never",
      CLAUDECODE: "1",
      TASKS_HOME: "/k",
    },
    stateDir: state,
    home: state,
    loginShell: "/bin/fake-login-shell",
    capture,
    systemctl: undefined,
    ...(options.now === undefined ? {} : { now: options.now }),
    bootId: options.boot ?? (() => "boot-1"),
    ...(options.timeoutMs === undefined ? {} : { snapshotTimeoutMs: options.timeoutMs }),
  });
}

describe("[A4.5.environment.snapshot] the login-shell snapshot: a deadline and a defined result for every outcome", () => {
  test(
    "a profile's exports are found; the shell runs in the account's minimal environment, never the service's",
    { timeout: 60_000 },
    async () => {
      const state = temp();
      const shell = fakeShell("ok", {
        FAKE_SHELL_EXPORTS: JSON.stringify({ NVM_BIN: "/nvm/bin", PATH: "/nvm/bin:/usr/bin" }),
      });
      const env = environmentWith(shell.capture, state);
      await env.prepare();
      const stored = env.snapshot();
      expect(stored?.env).toMatchObject({
        NVM_BIN: "/nvm/bin",
        PATH: "/nvm/bin:/usr/bin",
        LANG: "nl_NL.UTF-8",
      });
      // Nothing of the service's own environment, nor what the snapshot's shell had only for itself.
      expect(stored?.env).not.toHaveProperty("SERVICE_SECRET_FIXTURE");
      expect(stored?.env).not.toHaveProperty("CLAUDECODE");
      expect(stored?.env).not.toHaveProperty("TASKS_HOME");
      expect(stored?.env).not.toHaveProperty("TERM");
      expect(stored?.env).not.toHaveProperty(RESOLVING);
      const [run] = readJsonLines(shell.log) as {
        flags: string[];
        cwd: string;
        envNames: string[];
      }[];
      expect(run?.flags).toEqual(["-lic"]);
      expect(run?.envNames).toContain(RESOLVING);
      expect(run?.envNames).toContain("TERM");
      expect(run?.envNames).not.toContain("SERVICE_SECRET_FIXTURE");
      // Stored user-only, and the base is the person's: taken whole.
      const file = join(state, SNAPSHOT_FILE);
      if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ format: 1, boot: "boot-1" });
      const base = await env.base();
      expect(base.kind).toBe("user");
      expect(base.env).toMatchObject({ NVM_BIN: "/nvm/bin" });
    },
  );

  test(
    "a shell that hangs is killed at the deadline, with what it started; the previous snapshot stays in use",
    { timeout: 60_000 },
    async () => {
      const state = temp();
      let now = Date.UTC(2026, 10, 14);
      const good = fakeShell("ok", { FAKE_SHELL_EXPORTS: JSON.stringify({ FROM: "first" }) });
      const first = environmentWith(good.capture, state, { now: () => now });
      await first.prepare();
      expect(first.snapshot()?.env).toMatchObject({ FROM: "first" });

      // A day later the snapshot is stale; this time the profile hangs.
      now += 25 * 60 * 60_000;
      const hang = fakeShell("hang");
      const second = environmentWith(hang.capture, state, { now: () => now, timeoutMs: 1_500 });
      const t0 = performance.now();
      const taken = await second.take();
      expect(taken.outcome).toBe("timeout");
      expect(performance.now() - t0).toBeLessThan(10_000);
      await second.prepare();
      expect(second.snapshot()?.env).toMatchObject({ FROM: "first" });
      expect((await second.base()).kind).toBe("user");
      if (process.platform !== "win32") {
        // The shell led its own process group, which the deadline killed whole.
        const [run] = readJsonLines(hang.log) as { pid: number }[];
        const alive = (pid: number): boolean => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        };
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(run !== undefined && alive(run.pid)).toBe(false);
        const group = spawnSync("pgrep", ["-g", String(run?.pid ?? 0)], { encoding: "utf8" });
        expect(group.stdout.trim()).toBe("");
      }
    },
  );

  test(
    "a shell that prints both fences and then hangs: the snapshot is taken at once, and the shell is still ended at the deadline",
    { timeout: 60_000 },
    async () => {
      const state = temp();
      const linger = fakeShell("linger", {
        FAKE_SHELL_EXPORTS: JSON.stringify({ FROM: "linger" }),
      });
      const env = environmentWith(linger.capture, state, { timeoutMs: 1_500 });
      const t0 = performance.now();
      const taken = await env.take();
      expect(taken.outcome).toBe("ok");
      expect(taken.env).toMatchObject({ FROM: "linger" });
      expect(performance.now() - t0).toBeLessThan(1_500);
      const [run] = readJsonLines(linger.log) as { pid: number }[];
      const alive = (pid: number | undefined): boolean => {
        if (pid === undefined) return false;
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      expect(alive(run?.pid)).toBe(true);
      const until = performance.now() + 10_000;
      while (alive(run?.pid) && performance.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(alive(run?.pid)).toBe(false);
    },
  );

  test(
    "no markers, half the output, a failure or endless output: each a defined result, never a guess",
    { timeout: 60_000 },
    async () => {
      for (const [mode, outcome] of [
        ["noise", "no_markers"],
        ["half", "no_markers"],
        ["fail", "failed"],
        ["huge", "too_large"],
      ] as const) {
        const state = temp();
        const env = environmentWith(fakeShell(mode).capture, state, { timeoutMs: 20_000 });
        expect((await env.take()).outcome, mode).toBe(outcome);
        await env.prepare();
        // No snapshot at all: the base is the service's own, through the allow-list.
        expect(env.snapshot(), mode).toBeUndefined();
        const base = await env.base();
        expect(base.kind).toBe("service");
        const agent = agentEnvironment({
          platform: "linux",
          base: base.env,
          baseKind: base.kind,
          instance: {},
          additions: {},
        });
        expect(agent).not.toHaveProperty("SERVICE_SECRET_FIXTURE");
        expect(agent).not.toHaveProperty("CLAUDECODE");
      }
    },
  );

  test(
    "taken again at a new boot or a new login, and once a day; kept otherwise",
    { timeout: 60_000 },
    async () => {
      const state = temp();
      let now = Date.UTC(2026, 10, 14);
      let boot = "boot-1";
      const shell = fakeShell("ok");
      const env = environmentWith(shell.capture, state, { now: () => now, boot: () => boot });
      const runs = (): number => readJsonLines(shell.log).length;
      await env.prepare();
      await env.prepare();
      expect(runs()).toBe(1);
      now += 60 * 60_000;
      await env.prepare();
      expect(runs()).toBe(1);
      boot = "boot-2";
      await env.prepare();
      expect(runs()).toBe(2);
      now += 24 * 60 * 60_000;
      await env.prepare();
      expect(runs()).toBe(3);
      // A clock that went back a day is as stale as one that went forward.
      now -= 3 * 24 * 60 * 60_000;
      await env.prepare();
      expect(runs()).toBe(4);
    },
  );

  test(
    "via_login_shell's snapshot runs in the task's folder, over the session layer, and is never stored",
    { timeout: 60_000 },
    async () => {
      const state = temp();
      const folder = temp();
      const shell = fakeShell("ok", { FAKE_SHELL_EXPORTS: JSON.stringify({ FROM: "folder" }) });
      // Linux holds the folder for real (next test); elsewhere the seam starts it by its path.
      const hold =
        process.platform === "linux"
          ? undefined
          : (path: string) => ({ cwd: path, close: () => undefined });
      const env = environmentWith(
        shell.capture,
        state,
        hold === undefined ? {} : { holdFolder: hold },
      );
      const base = await env.inFolder(folder, identityOf(folder));
      expect(base?.kind).toBe("user");
      expect(base?.env).toMatchObject({ FROM: "folder" });
      expect(base?.env).not.toHaveProperty("SERVICE_SECRET_FIXTURE");
      const [run] = readJsonLines(shell.log) as { cwd: string; flags: string[] }[];
      expect(run?.flags).toEqual(["-lic"]);
      expect(realpathSync.native(run?.cwd ?? "")).toBe(realpathSync.native(folder));
      expect(env.snapshot()).toBeUndefined();
      expect(() => statSync(join(state, SNAPSHOT_FILE))).toThrow();
      // A profile that fails in the folder: none, and the launch's base applies.
      const failing = environmentWith(
        fakeShell("fail").capture,
        temp(),
        hold === undefined ? {} : { holdFolder: hold },
      );
      expect(await failing.inFolder(folder, identityOf(folder))).toBeUndefined();
      // Windows has no login shell.
      const windows = new UserEnvironment({
        platform: "win32",
        serviceEnv: {},
        stateDir: temp(),
        home: temp(),
        capture: shell.capture,
      });
      expect(await windows.inFolder(folder, identityOf(folder))).toBeUndefined();
    },
  );

  test.runIf(process.platform === "linux")(
    "the profile runs only in the very folder the launch resolved: one swapped for a link or for another folder runs no profile at all",
    { timeout: 60_000 },
    async () => {
      const work = temp();
      const folder = join(work, "portal");
      mkdirSync(folder);
      const identity = identityOf(folder);
      const held = holdFolder(folder, identity);
      expect(held?.cwd).toMatch(/^\/proc\/self\/fd\/\d+$/);
      held?.close();
      const shell = fakeShell("ok", { FAKE_SHELL_EXPORTS: JSON.stringify({ FROM: "folder" }) });
      const env = environmentWith(shell.capture, temp());
      expect((await env.inFolder(folder, identity))?.env).toMatchObject({ FROM: "folder" });
      const runs = (): { cwd: string }[] => readJsonLines(shell.log) as { cwd: string }[];
      expect(runs().map((r) => r.cwd)).toEqual([realpathSync.native(folder)]);
      // Swapped for a link to another folder after the launch resolved it: no profile runs.
      const elsewhere = join(work, "elsewhere");
      mkdirSync(elsewhere);
      renameSync(folder, join(work, "portal-moved"));
      symlinkSync(elsewhere, folder);
      expect(await env.inFolder(folder, identity)).toBeUndefined();
      // Swapped for another folder of the same name: no profile runs either.
      rmSync(folder);
      mkdirSync(folder);
      expect(await env.inFolder(folder, identity)).toBeUndefined();
      expect(runs()).toHaveLength(1);
    },
  );

  test.runIf(process.platform === "linux")(
    "a real bash: profile noise, an export, and the account's PATH, from a home of the test's own",
    { timeout: 60_000 },
    async () => {
      const bash = ["/bin/bash", "/usr/bin/bash"].find((p) => {
        try {
          return statSync(p).isFile();
        } catch {
          return false;
        }
      });
      if (bash === undefined) return;
      const home = temp();
      mkdirSync(join(home, ".local", "bin"), { recursive: true });
      writeFileSync(
        join(home, ".bash_profile"),
        [
          'echo "profile noise on stdout"',
          "export FIXTURE_FROM_PROFILE='a b $ ` \"q\"'",
          'export PATH="$HOME/.local/bin:$PATH"',
          "",
        ].join("\n"),
      );
      const env = new UserEnvironment({
        platform: "linux",
        serviceEnv: { PATH: "/usr/bin:/bin", HOME: home, SERVICE_ONLY: "never" },
        stateDir: home,
        home,
        loginShell: bash,
        systemctl: undefined,
      });
      const taken = await env.take();
      expect(taken.outcome).toBe("ok");
      expect(taken.env?.["FIXTURE_FROM_PROFILE"]).toBe('a b $ ` "q"');
      expect(taken.env?.["PATH"]?.split(":")[0]).toBe(join(home, ".local", "bin"));
      expect(taken.env).not.toHaveProperty("SERVICE_ONLY");
      expect(taken.env).not.toHaveProperty("TERM");
    },
  );

  test.runIf(process.platform === "win32")(
    "Windows: the registry layers read through Windows PowerShell give the account's PATH",
    { timeout: 60_000 },
    async () => {
      const env = new UserEnvironment({
        platform: "win32",
        serviceEnv: process.env,
        stateDir: temp(),
        home: temp(),
      });
      const base = await env.base();
      expect(base.kind).toBe("user");
      const path = Object.entries(base.env).find(([n]) => n.toUpperCase() === "PATH")?.[1] ?? "";
      expect(path.toLowerCase()).toContain("system32");
      expect(Object.keys(base.env).map((n) => n.toUpperCase())).toContain("SYSTEMROOT");
    },
  );
});
