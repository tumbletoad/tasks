// Golden argv per target, route and OS (A4 5.1 "Golden argv tests", A7 3.9 M2.10's Verify line):
// the command line each CLI route gives for fixed inputs, compared as arrays of decoded elements,
// and the link route's URL compared by its decoded values, never as rendered strings. The inputs
// are each OS's instances as A4 3.2 shapes them: a native binary or a wrapper on
// Linux, `node <entry>` for an npm install on Windows. Fixture data only.
import { describe, expect, test } from "vitest";
import { envVar, MCP_SERVER_KEY, PRODUCT_NAME } from "@ttasks/brand";
import {
  cliArgv,
  codexToolEnv,
  expandArgv,
  expandUrl,
  isUncPath,
  presetSession,
  RouteUnavailable,
  routeOf,
  SESSION_UUID,
  withFolder,
} from "../src/routes/index.ts";
import { instanceHome } from "../src/detect.ts";
import { launchRefCheck } from "../src/intents.ts";
import type { Instance } from "../src/sections.ts";

const REF = `L7KQ2${launchRefCheck("7KQ2") ?? ""}`;
const SESSION = presetSession("sp_0abcdefghjkmnpqrstvwxyz01", "request-0000000000000001");
const BRIEF = `${PRODUCT_NAME} task M-14 (launch ${REF}).\nRead the task.`;

const instance = (over: Partial<Instance> & Pick<Instance, "id" | "target">): Instance => ({
  label: "Fixture",
  account: "",
  spaces: [],
  exec: undefined,
  argsPrefix: [],
  configHome: undefined,
  env: {},
  openPermission: "inherit",
  runPermission: "inherit",
  extraArgs: [],
  viaLoginShell: false,
  remoteAllowed: false,
  enabled: true,
  ...over,
});

/** Each OS's instances of the two CLI targets. */
const OS = {
  linux: {
    claude: instance({
      id: "claude",
      target: "claude-cli",
      exec: "/home/mira/.local/bin/claude",
      openPermission: "full-access",
      extraArgs: ["--model", "opus"],
    }),
    codex: instance({
      id: "codex-work",
      target: "codex-cli",
      exec: "/home/mira/.local/bin/codex-work",
      configHome: "/home/mira/.codex",
      openPermission: "auto-edit",
    }),
    folder: "/home/mira/work/lumen/portal",
  },
  win32: {
    claude: instance({
      id: "claude",
      target: "claude-cli",
      exec: "C:\\Program Files\\nodejs\\node.exe",
      argsPrefix: [
        "C:\\Users\\mira\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js",
      ],
    }),
    codex: instance({
      id: "codex-second",
      target: "codex-cli",
      exec: "C:\\Program Files\\nodejs\\node.exe",
      argsPrefix: [
        "C:\\Users\\mira\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
      ],
      env: { CODEX_HOME: "C:\\Users\\mira\\.codex-second" },
      openPermission: "full-access",
    }),
    folder: "C:\\Users\\mira\\work\\R&D; tests (v2)\\Caf\u{E9}",
  },
} as const;

const values = { task: "M-14", title: "Fix appointment time zones", reference: REF } as const;

describe("[A4.5.routes.golden-argv] golden argv per target, route and OS, compared as arrays", () => {
  test("Claude Code's terminal route: --session-id, -n with the task's reference and title, the permission, extra arguments, then the brief in its prompt box with --prefill=", () => {
    const linux = cliArgv(OS.linux.claude, {
      ...values,
      session: SESSION,
      brief: BRIEF,
      toolEnv: [],
    });
    expect(linux).toEqual({
      argv: [
        "/home/mira/.local/bin/claude",
        "--session-id",
        SESSION,
        "-n",
        "M-14 Fix appointment time zones",
        "--permission-mode",
        "bypassPermissions",
        "--model",
        "opus",
        `--prefill=${BRIEF}`,
      ],
      folderArgs: [],
    });
    const windows = cliArgv(OS.win32.claude, {
      ...values,
      session: SESSION,
      brief: BRIEF,
      toolEnv: [],
    });
    expect(windows).toEqual({
      argv: [
        "C:\\Program Files\\nodejs\\node.exe",
        "C:\\Users\\mira\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js",
        "--session-id",
        SESSION,
        "-n",
        "M-14 Fix appointment time zones",
        `--prefill=${BRIEF}`,
      ],
      folderArgs: [],
    });
  });

  test("Codex's terminal route: -C with the folder filled at the claim, --no-daemon, the permission, then the brief after --", () => {
    const linux = cliArgv(OS.linux.codex, { ...values, brief: BRIEF, toolEnv: [] });
    expect(linux).toEqual({
      argv: [
        "/home/mira/.local/bin/codex-work",
        "-C",
        "",
        "--no-daemon",
        "-s",
        "workspace-write",
        "-a",
        "on-request",
        "--",
        BRIEF,
      ],
      folderArgs: [2],
    });
    expect(withFolder(linux.argv, linux.folderArgs, OS.linux.folder)).toEqual([
      "/home/mira/.local/bin/codex-work",
      "-C",
      OS.linux.folder,
      "--no-daemon",
      "-s",
      "workspace-write",
      "-a",
      "on-request",
      "--",
      BRIEF,
    ]);
    const windows = cliArgv(OS.win32.codex, {
      ...values,
      brief: BRIEF,
      toolEnv: codexToolEnv(),
    });
    expect(withFolder(windows.argv, windows.folderArgs, OS.win32.folder)).toEqual([
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\Users\\mira\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
      "-C",
      OS.win32.folder,
      "--no-daemon",
      "-c",
      `mcp_servers.${MCP_SERVER_KEY}.env_vars=["${envVar("TICKET")}"]`,
      "--dangerously-bypass-approvals-and-sandbox",
      "--",
      BRIEF,
    ]);
  });

  test("the claude-cli:// link: the folder and the brief, each percent-encoded once, decoded back exactly", () => {
    const template = routeOf("claude-cli", "link")?.url ?? "";
    for (const os of ["linux", "win32"] as const) {
      const url = expandUrl(template, { cwd: OS[os].folder, brief: BRIEF });
      expect(url.startsWith("claude-cli://open?cwd=")).toBe(true);
      // Nothing a command line could re-split: no space, quote, ampersand inside a value or caret.
      const values = url.slice("claude-cli://open?".length).split("&");
      expect(values.map((pair) => pair.split("=")[0])).toEqual(["cwd", "q"]);
      expect(values.map((pair) => decodeURIComponent(pair.split("=")[1] ?? ""))).toEqual([
        OS[os].folder,
        BRIEF,
      ]);
      expect(url).toMatch(/^[A-Za-z0-9:/?&=%._~-]+$/u);
    }
    expect(isUncPath("\\\\server\\share\\portal")).toBe(true);
    expect(isUncPath("\\\\?\\UNC\\server\\share")).toBe(true);
    expect(isUncPath("\\\\?\\C:\\work")).toBe(false);
    expect(isUncPath("C:\\work")).toBe(false);
    expect(isUncPath("/home/mira/work")).toBe(false);
  });

  test("hostile values stay one element each: a brief or title is never split or read as an option", () => {
    const hostile = '--help "; rm -rf ~ & echo %PATH% ^| `x` $(y)\ntwo\\';
    const built = cliArgv(OS.linux.claude, {
      ...values,
      title: hostile.replace(/\n/gu, " "),
      session: SESSION,
      brief: hostile,
      toolEnv: [],
    });
    expect(built.argv.at(-1)).toBe(`--prefill=${hostile}`);
    expect(built.argv[4]).toBe(`M-14 ${hostile.replace(/\n/gu, " ")}`);
    expect(built.argv).toHaveLength(10);
  });

  test("Codex's env_vars override keeps the names the home's entry lists, and adds the ticket's", () => {
    const ticket = envVar("TICKET");
    expect(codexToolEnv()).toEqual(["-c", `mcp_servers.${MCP_SERVER_KEY}.env_vars=["${ticket}"]`]);
    expect(codexToolEnv(["HTTPS_PROXY", "SSL_CERT_FILE"])).toEqual([
      "-c",
      `mcp_servers.${MCP_SERVER_KEY}.env_vars=["HTTPS_PROXY","SSL_CERT_FILE","${ticket}"]`,
    ]);
    // A name TTasks could not write back exactly is never written at all.
    expect(() => codexToolEnv(['A"]', "B"])).toThrow(RouteUnavailable);
    expect(() => codexToolEnv(["PATH\n"])).toThrow(RouteUnavailable);
  });

  test("a session ID is a version 4 UUID, the same for a repeated request and new for a new one", () => {
    expect(SESSION).toMatch(SESSION_UUID);
    expect(presetSession("sp_0abcdefghjkmnpqrstvwxyz01", "request-0000000000000001")).toBe(SESSION);
    expect(presetSession("sp_0abcdefghjkmnpqrstvwxyz01", "request-0000000000000002")).not.toBe(
      SESSION,
    );
  });

  test("refused before anything starts: no executable, a session or reference of the wrong form, {cwd} inside an element", () => {
    expect(() =>
      cliArgv(instance({ id: "x", target: "claude-cli" }), {
        ...values,
        session: SESSION,
        brief: BRIEF,
        toolEnv: [],
      }),
    ).toThrow(RouteUnavailable);
    expect(() =>
      cliArgv(OS.linux.claude, {
        ...values,
        session: "not-a-uuid",
        brief: BRIEF,
        toolEnv: [],
      }),
    ).toThrow(RouteUnavailable);
    expect(() =>
      expandArgv(["{exec}", "--dir={cwd}"], {
        exec: ["/bin/x"],
        permission: [],
        extraArgs: [],
        toolEnv: [],
        ...values,
      }),
    ).toThrow(RouteUnavailable);
    expect(() =>
      expandArgv(["{exec}", "-n", "{launch.ref}"], {
        exec: ["/bin/x"],
        permission: [],
        extraArgs: [],
        toolEnv: [],
        ...values,
        // "L00000" would be a valid reference: its check character is 0.
        reference: "L0000X",
      }),
    ).toThrow(RouteUnavailable);
  });
});

describe("[A4.5.routes.homes] the agent home an instance launches with, one rule for launch and setup", () => {
  const claude = (over: Partial<Instance>): Instance =>
    instance({ id: "claude", target: "claude-cli", ...over });
  const codex = (over: Partial<Instance>): Instance =>
    instance({ id: "codex", target: "codex-cli", ...over });

  test("the home variable of the instance's env wins, in any case on Windows; then config_home; then the default", () => {
    const winHome = "C:\\Users\\mira";
    // Windows names are case-insensitive: the agent's environment applies `claude_config_dir`.
    expect(
      instanceHome(claude({ env: { claude_config_dir: "D:\\claude-work" } }), winHome, "win32"),
    ).toEqual({ path: "D:\\claude-work", isDefault: false });
    expect(
      instanceHome(claude({ env: { claude_config_dir: "/srv/claude" } }), "/home/mira", "linux"),
    ).toEqual({ path: "/home/mira/.claude", isDefault: true });
    // The variable wins over config_home, which only a wrapper's own selection needs.
    expect(
      instanceHome(
        codex({ configHome: "C:\\Users\\mira\\.codex-a", env: { Codex_Home: "D:\\codex-b" } }),
        winHome,
        "win32",
      ),
    ).toEqual({ path: "D:\\codex-b", isDefault: false });
    expect(
      instanceHome(codex({ configHome: "/home/mira/.codex-work" }), "/home/mira", "linux"),
    ).toEqual({ path: "/home/mira/.codex-work", isDefault: false });
    // The default folder, named or not, in any case on Windows.
    expect(instanceHome(codex({}), "/home/mira", "linux")).toEqual({
      path: "/home/mira/.codex",
      isDefault: true,
    });
    expect(
      instanceHome(claude({ configHome: "c:\\users\\MIRA\\.Claude" }), winHome, "win32"),
    ).toEqual({ path: "c:\\users\\MIRA\\.Claude", isDefault: true });
    // A variable that names the default folder still selects it by variable: not the default.
    expect(
      instanceHome(
        claude({ env: { CLAUDE_CONFIG_DIR: "/home/mira/.claude" } }),
        "/home/mira",
        "linux",
      ),
    ).toEqual({ path: "/home/mira/.claude", isDefault: false });
    // No account home: only a named home has a path.
    expect(instanceHome(codex({}), undefined, "linux")).toEqual({
      path: undefined,
      isDefault: true,
    });
    // A target without homes.
    expect(
      instanceHome(instance({ id: "t3", target: "t3" }), "/home/mira", "linux"),
    ).toBeUndefined();
  });
});
