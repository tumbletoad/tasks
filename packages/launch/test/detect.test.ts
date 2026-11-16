// Instance detection (A4 3.2) per OS, on fixture homes in an in-memory file system: one golden file
// per OS, every OS's rules checked on every OS. The fake host records every path detection looked
// at and every command it ran, so the tests prove what it never touched: nothing inside an agent
// home, no wrapper and no shim run. Fixture paths only (the user "mira").
import { describe, expect, test } from "vitest";
import { HOME_VARIABLES } from "../src/catalogue.ts";
import { detect, instanceEntry, type Detection } from "../src/detect.ts";
import type { Instance } from "../src/sections.ts";
import { fakeHost, type FakeHostSpec } from "./fake-host.ts";

const NVM = "/home/mira/.nvm/versions/node/v24.11.0";

const LINUX: FakeHostSpec = {
  platform: "linux",
  home: "/home/mira",
  env: {
    PATH: `/home/mira/.local/bin:${NVM}/bin:/usr/local/bin:/usr/bin:/bin`,
    HOME: "/home/mira",
  },
  entries: {
    "/home/mira/.local/bin/claude": { kind: "link", to: "../share/claude/versions/2.1.322" },
    "/home/mira/.local/share/claude/versions/2.1.322": { kind: "file", executable: true },
    // The fixture user's wrappers (A4 3.2): one per account.
    "/home/mira/.local/bin/codex-work": { kind: "file", executable: true },
    "/home/mira/.local/bin/codex-second": { kind: "file", executable: true },
    // Not wrappers: not executable, a name Tasks cannot turn into an ID, a folder.
    "/home/mira/.local/bin/claude-notes.txt": { kind: "file" },
    "/home/mira/.local/bin/codex-Old_Copy": { kind: "file", executable: true },
    "/home/mira/.local/bin/codex-cache": { kind: "dir" },
    "/home/mira/.local/bin/t3": { kind: "file", executable: true },
    // nvm's Codex: a link into node_modules, run as `node <entry>` with nvm's Node.
    [`${NVM}/bin/codex`]: { kind: "link", to: "../lib/node_modules/@openai/codex/bin/codex.js" },
    [`${NVM}/lib/node_modules/@openai/codex/bin/codex.js`]: { kind: "file", executable: true },
    [`${NVM}/bin/node`]: { kind: "file", executable: true },
    "/usr/bin/node": { kind: "file", executable: true },
    // Homes. Their contents exist and must never be looked at.
    "/home/mira/.codex/auth.json": { kind: "file" },
    "/home/mira/.codex/config.toml": { kind: "file" },
    "/home/mira/.codex/sessions/2026/11/13/rollout-1.jsonl": { kind: "file" },
    "/home/mira/.codex-second/auth.json": { kind: "file" },
    "/home/mira/.codex.bak/auth.json": { kind: "file" },
    "/home/mira/.claude/.credentials.json": { kind: "file" },
    "/home/mira/.claude.json": { kind: "file" },
    "/home/mira/.t3/userdata/server-runtime.json": { kind: "file" },
  },
  outputs: {
    "/home/mira/.local/bin/claude --version": "2.1.322 (Claude Code)\n",
    [`${NVM}/bin/node ${NVM}/lib/node_modules/@openai/codex/bin/codex.js --version`]:
      "codex-cli 0.166.0\n",
    "/home/mira/.local/bin/t3 --version": "0.1.7\n",
  },
};

const WINDOWS: FakeHostSpec = {
  platform: "win32",
  home: "C:\\Users\\mira",
  env: {
    Path: "C:\\Users\\mira\\.local\\bin;C:\\Users\\mira\\npm-global;C:\\Program Files\\nodejs;C:\\Windows\\System32",
    PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.JS",
    USERPROFILE: "C:\\Users\\mira",
  },
  entries: {
    "C:\\Users\\mira\\.local\\bin\\claude.exe": { kind: "file" },
    // npm's global layout: a .cmd shim beside node_modules. Tasks runs the entry with Node.
    "C:\\Users\\mira\\npm-global\\codex": { kind: "file" },
    "C:\\Users\\mira\\npm-global\\codex.cmd": { kind: "file" },
    "C:\\Users\\mira\\npm-global\\codex.ps1": { kind: "file" },
    "C:\\Users\\mira\\npm-global\\node_modules\\@openai\\codex\\bin\\codex.js": { kind: "file" },
    "C:\\Program Files\\nodejs\\node.exe": { kind: "file" },
    // T3's shim is not on PATH and is a .cmd: found in its folder, never run (M2.09 reads it).
    "C:\\Users\\mira\\.t3\\bin\\t3.cmd": { kind: "file" },
    "C:\\Users\\mira\\.Codex\\auth.json": { kind: "file" },
    "C:\\Users\\mira\\.codex-second\\auth.json": { kind: "file" },
    "C:\\Users\\mira\\.claude\\.credentials.json": { kind: "file" },
    // A second home named as T3 Code's documentation suggests, with `_`.
    "C:\\Users\\mira\\.claude_second\\.credentials.json": { kind: "file" },
  },
  outputs: {
    "C:\\Users\\mira\\.local\\bin\\claude.exe --version": "2.1.322 (Claude Code)\r\n",
    "C:\\Program Files\\nodejs\\node.exe C:\\Users\\mira\\npm-global\\node_modules\\@openai\\codex\\bin\\codex.js --version":
      "codex-cli 0.201.0\r\n",
  },
};

const MACOS: FakeHostSpec = {
  platform: "darwin",
  home: "/Users/mira",
  env: { PATH: "/Users/mira/.local/bin:/opt/homebrew/bin:/usr/bin:/bin" },
  entries: {
    "/Users/mira/.local/bin/claude": { kind: "file", executable: true },
    "/Users/mira/.local/bin/claude-work": { kind: "file", executable: true },
    "/opt/homebrew/bin/codex": { kind: "link", to: "../Caskroom/codex/0.167.1/codex" },
    "/opt/homebrew/Caskroom/codex/0.167.1/codex": { kind: "file", executable: true },
    "/Users/mira/.claude-work/settings.json": { kind: "file" },
    "/Users/mira/.codex/auth.json": { kind: "file" },
    // Named by CODEX_HOME in the agent environment below.
    "/Users/mira/codex-homes/lab/config.toml": { kind: "file" },
  },
  outputs: {
    // Claude's --version fails here: detection reports no version, and no tested flag.
    "/opt/homebrew/bin/codex --version": "codex-cli 0.167.1\n",
  },
};

const FIXTURES: Record<string, FakeHostSpec> = {
  linux: LINUX,
  win32: WINDOWS,
  darwin: {
    ...MACOS,
    env: { ...MACOS.env, CODEX_HOME: "/Users/mira/codex-homes/lab" },
  },
};

/** The homes whose contents detection must never look at (T3's own command folder aside). */
const HOMES: Record<string, string[]> = {
  linux: [
    "/home/mira/.codex",
    "/home/mira/.codex-second",
    "/home/mira/.codex.bak",
    "/home/mira/.claude",
    "/home/mira/.t3/userdata",
  ],
  win32: [
    "C:\\Users\\mira\\.Codex",
    "C:\\Users\\mira\\.codex-second",
    "C:\\Users\\mira\\.claude",
    "C:\\Users\\mira\\.claude_second",
    "C:\\Users\\mira\\.t3\\userdata",
  ],
  darwin: ["/Users/mira/.claude-work", "/Users/mira/.codex", "/Users/mira/codex-homes/lab"],
};

function inside(platform: NodeJS.Platform, path: string, home: string): boolean {
  const sep = platform === "win32" ? "\\" : "/";
  const fold = (s: string) => (platform === "win32" ? s.toLowerCase() : s);
  return fold(path).startsWith(fold(home) + sep);
}

describe("[A4.3.2.detect.golden] instance detection per OS on fixture homes", () => {
  for (const [os, spec] of Object.entries(FIXTURES)) {
    test(`${os}: the golden detection, nothing read inside a home, no wrapper or shim run`, async () => {
      const host = fakeHost(spec);
      const detection = await detect(host);
      await expect(`${JSON.stringify(detection, null, 2)}\n`).toMatchFileSnapshot(
        `./golden/detect.${os}.json`,
      );
      for (const home of HOMES[os] ?? []) {
        expect(host.touched.filter((path) => inside(spec.platform, path, home))).toEqual([]);
      }
      // Only the raw commands ran, each with --version alone: never a wrapper or a shim.
      for (const line of host.ran) {
        expect(line).toMatch(/ --version$/u);
        expect(line).not.toMatch(/codex-(work|second)|\.cmd|\.ps1/u);
      }
    });
  }

  test("linux: wrappers win, a wrapper without a home of its name asks for one, unusable names are left out", async () => {
    const detection = await detect(fakeHost(LINUX));
    const ids = detection.proposals.map((p) => p.id);
    expect(ids).toEqual(["claude", "codex-second", "codex-work", "codex", "t3"]);
    const work = detection.proposals.find((p) => p.id === "codex-work");
    expect(work?.needs).toEqual(["config_home"]);
    const second = detection.proposals.find((p) => p.id === "codex-second");
    expect(second).toMatchObject({
      source: "wrapper",
      configHome: "/home/mira/.codex-second",
      needs: [],
    });
    // The raw default home runs nvm's Node with the npm entry, and needs no CODEX_HOME.
    const raw = detection.proposals.find((p) => p.id === "codex");
    expect(raw).toMatchObject({
      exec: `${NVM}/bin/node`,
      argsPrefix: [`${NVM}/lib/node_modules/@openai/codex/bin/codex.js`],
    });
    expect(raw?.env).toBeUndefined();
  });

  test("configured instances are not proposed again: the same ID, wrapper or config home", async () => {
    const existing: Instance[] = [
      {
        id: "work",
        target: "codex-cli",
        label: "Codex · work",
        account: "work",
        spaces: [],
        exec: "/home/mira/.local/bin/codex-work",
        argsPrefix: [],
        configHome: "/home/mira/.codex",
        env: {},
        openPermission: "inherit",
        runPermission: "full-access",
        extraArgs: [],
        prompt: "sent",
        viaLoginShell: false,
        remoteAllowed: false,
        enabled: true,
      },
    ];
    const detection: Detection = await detect(fakeHost(LINUX), existing);
    expect(detection.proposals.map((p) => p.id)).toEqual(["claude", "codex-second", "t3"]);
    expect(detection.configured).toEqual(["codex-work", "codex"]);
  });

  test("a second home named with `_` (T3 Code's documented form) is found like one with `-`", async () => {
    const entries = {
      ...LINUX.entries,
      "/home/mira/.claude_second/settings.json": { kind: "file" as const },
      "/home/mira/.codex_lab/config.toml": { kind: "file" as const },
      // Not a home: no suffix after the separator, or one Tasks cannot turn into an ID.
      "/home/mira/.codex_/x": { kind: "file" as const },
      "/home/mira/.codex_Old_Copy/x": { kind: "file" as const },
    };
    const detection = await detect(fakeHost({ ...LINUX, entries }));
    expect(detection.homes.map((h) => [h.path, h.suffix])).toEqual([
      ["/home/mira/.claude", ""],
      ["/home/mira/.claude_second", "second"],
      ["/home/mira/.codex", ""],
      ["/home/mira/.codex-second", "second"],
      ["/home/mira/.codex_lab", "lab"],
    ]);
    expect(detection.proposals.find((p) => p.id === "claude-second")).toMatchObject({
      configHome: "/home/mira/.claude_second",
      env: { CLAUDE_CONFIG_DIR: "/home/mira/.claude_second" },
      needs: [],
    });
    expect(detection.proposals.find((p) => p.id === "codex-lab")?.configHome).toBe(
      "/home/mira/.codex_lab",
    );
  });

  test("T3 Code's folder is where T3CODE_HOME names it, as setup reads its settings, without a t3 command", async () => {
    // No t3 on PATH and no `~/.t3`: only the folder T3CODE_HOME names shows T3 is there.
    const entries = Object.fromEntries(
      Object.entries(LINUX.entries).filter(
        ([path]) => !path.startsWith("/home/mira/.t3/") && !path.endsWith("/t3"),
      ),
    );
    const bare = { ...LINUX, entries };
    expect((await detect(fakeHost(bare))).t3Folder).toBe(false);
    const named = {
      ...bare,
      env: { ...LINUX.env, T3CODE_HOME: "/srv/t3-home" },
      entries: { ...entries, "/srv/t3-home/userdata/settings.json": { kind: "file" as const } },
    };
    const detection = await detect(fakeHost(named));
    expect(detection.t3Folder).toBe(true);
    expect(detection.proposals.find((p) => p.target === "t3")).toMatchObject({ id: "t3" });
    // A relative value names no folder: the home folder's `.t3` decides, and there is none.
    const relative = { ...named, env: { ...LINUX.env, T3CODE_HOME: "t3-home" } };
    expect((await detect(fakeHost(relative))).t3Folder).toBe(false);
  });

  test("a home is selected by the instance alone: the inherited home variables are scrubbed, every other home names its variable, and a chosen home moves the variable with it", async () => {
    // The launch removes these from the inherited environment (A4 3.8), so an instance without
    // one runs the default home. Pinning the default instead would move Claude's .claude.json.
    expect(HOME_VARIABLES).toEqual(["CLAUDE_CONFIG_DIR", "CODEX_HOME"]);
    // Both homes in the home folder, and the agent environment selecting the second one, as an
    // absolute or a relative value: the raw default proposal stays the default home with no
    // variable (it is scrubbed at launch), and every other home names its own.
    const entries = Object.fromEntries(
      Object.entries(LINUX.entries).filter(([path]) => !path.includes("/.local/bin/codex-")),
    );
    const proposals = [];
    for (const env of [
      LINUX.env,
      { ...LINUX.env, CODEX_HOME: "/home/mira/.codex-second" },
      { ...LINUX.env, CODEX_HOME: ".codex" },
      { ...LINUX.env, CLAUDE_CONFIG_DIR: "/home/mira/.claude-work" },
    ]) {
      const detection = await detect(fakeHost({ ...LINUX, env, entries }));
      const raw = detection.proposals.find((p) => p.id === "codex");
      expect(raw).toMatchObject({ configHome: "/home/mira/.codex", needs: [] });
      expect(raw?.env).toBeUndefined();
      expect(detection.proposals.find((p) => p.id === "claude")?.env).toBeUndefined();
      expect(detection.proposals.find((p) => p.id === "codex-second")?.env).toEqual({
        CODEX_HOME: "/home/mira/.codex-second",
      });
      proposals.push(raw);
    }

    // A home the person picks instead is what the variable selects, for the default home too.
    for (const proposal of proposals) {
      if (proposal === undefined) throw new Error("no codex proposal");
      const chosen = instanceEntry(proposal, { configHome: "/home/mira/codex-homes/lab" });
      expect(chosen.ok && chosen.entry.get("config_home")).toBe("/home/mira/codex-homes/lab");
      expect(chosen.ok && chosen.entry.get("env")).toEqual({
        CODEX_HOME: "/home/mira/codex-homes/lab",
      });
    }
  });

  test("a command on PATH that resolves to a wrapper is never run and never proposed as the raw command", async () => {
    // ~/.local/bin/codex is a link to the second wrapper: running `codex --version` would run it.
    const spec: FakeHostSpec = {
      ...LINUX,
      entries: {
        ...LINUX.entries,
        "/home/mira/.local/bin/codex": { kind: "link", to: "codex-second" },
      },
    };
    const host = fakeHost(spec);
    const detection = await detect(host);
    expect(host.ran.filter((line) => line.includes("/.local/bin/codex"))).toEqual([]);
    expect(detection.commands.find((c) => c.target === "codex-cli")).toMatchObject({
      exec: [],
      unusable: "wrapper",
    });
    // The homes then need their command from the person.
    expect(detection.proposals.find((p) => p.id === "codex")?.needs).toEqual(["exec"]);
  });

  test("a confirmed proposal becomes an [[instance]] entry only once its needs are given", async () => {
    const detection = await detect(fakeHost(LINUX));
    const work = detection.proposals.find((p) => p.id === "codex-work");
    if (work === undefined) throw new Error("no codex-work proposal");
    expect(instanceEntry(work)).toEqual({ ok: false, needs: ["config_home"] });
    const confirmed = instanceEntry(work, { configHome: "/home/mira/.codex" });
    expect(confirmed.ok && [...confirmed.entry]).toEqual([
      ["id", "codex-work"],
      ["target", "codex-cli"],
      ["label", "Codex · work"],
      ["account", "work"],
      ["exec", "/home/mira/.local/bin/codex-work"],
      ["config_home", "/home/mira/.codex"],
      ["remote_allowed", false],
    ]);
    const t3 = detection.proposals.find((p) => p.id === "t3");
    if (t3 === undefined) throw new Error("no t3 proposal");
    expect(instanceEntry(t3)).toEqual({ ok: false, needs: ["t3_provider_instance"] });
  });
});
