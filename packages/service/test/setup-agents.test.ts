// `ttasks setup agents` (A3 3.13.1, 3.13.2, 3.13.4; A7 3.9 M2.14): on scratch homes, apply then
// remove leaves every file key-identical, and the preview shows the exact command and diff.
//
// Every home here is a folder this test made under the OS's temporary folder, and the apps'
// commands are testkit's fakes, run as real processes from a scratch PATH. No test reads or
// changes a real agent home or runs a real `claude` or `codex` (A3 3.13.1).
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { envVar, MCP_SERVER_KEY } from "@ttasks/brand";
import { detect, nodeDetectHost, type Instance } from "@ttasks/launch";
import { installFakeAgents, type FakeAgents } from "@ttasks/testkit/fake-agents";
import { parseToml } from "../src/config/toml.ts";
import {
  applyHome,
  planChange,
  planOf,
  planToken,
  readRecords,
  removeHome,
  runCommand,
  setupDir,
  SETUP_FILE,
  survey,
  writeRecords,
  type Change,
  type HomeView,
  type SetupInput,
} from "../src/setup/index.ts";

const SLOW = 180_000;
const SPACE = "sp_3z8sm956jp8dajmtsar5kx026c";
const windows = process.platform === "win32";
const BOM = "\u{FEFF}";

const temps: string[] = [];
afterEach(() => {
  // Each test's own folder, by its full name. Retried: on Windows a fake's working folder can stay
  // in use for a moment after it ends.
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

/** Another server's entry, whose secret must never leave its file. */
const SENTINEL = "sentinel-secret-7f3a";

const OTHER = { type: "stdio", command: "/opt/other", args: ["serve"], env: { TOKEN: SENTINEL } };

const CLAUDE_JSON = JSON.stringify(
  { numStartups: 3, mcpServers: { other: OTHER }, projects: { "/work/x": { allowedTools: [] } } },
  null,
  2,
);

const CODEX_TOML = [
  `${BOM}# The person's own Codex settings.`,
  'model = "fixture-model"',
  'approval_policy = "on-request"',
  "",
  "[mcp_servers.other]",
  'command = "/opt/other"   # kept as written',
  'args = ["serve"]',
  `env = { OTHER_KEY = "${SENTINEL}" }`,
  "",
  "[projects.'C:\\work\\x']",
  'trust_level = "trusted"',
  "",
].join("\r\n");

interface World {
  readonly root: string;
  readonly home: string;
  readonly state: string;
  readonly tasks: string;
  readonly fakes: FakeAgents;
}

function world(label: string): World {
  const root = mkdtempSync(join(tmpdir(), `ttasks-setup-${label}-`));
  temps.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  return {
    root,
    home,
    state: join(root, "state"),
    tasks: join(root, "install", "bin", windows ? "ttasks.exe" : "ttasks"),
    fakes: installFakeAgents(join(root, "tools"), home),
  };
}

async function inputOf(w: World, extra: Record<string, string> = {}): Promise<SetupInput> {
  // The person's shell names other homes: the commands must never see them.
  const env = {
    ...w.fakes.env,
    CLAUDE_CONFIG_DIR: join(w.root, "elsewhere-claude"),
    CODEX_HOME: join(w.root, "elsewhere-codex"),
    ...extra,
  };
  return {
    platform: process.platform,
    userHome: w.home,
    env,
    stateDir: w.state,
    tasks: w.tasks,
    detection: await detect(nodeDetectHost({ env, home: w.home, timeoutMs: 30_000 })),
    instances: [],
    // macOS: never the machine's own Applications folder.
    systemApplications: join(w.root, "Applications"),
    isFolder: (path) => existsSync(path) && statSync(path).isDirectory(),
    run: (argv, childEnv) => runCommand(argv, childEnv, w.home),
  };
}

/** A file as bytes and as a document, keys in their order; null when it is not there. */
function snapshot(path: string): { bytes: string; doc: string } | null {
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path).toString("latin1");
  const text = readFileSync(path, "utf8").replace(/^\u{FEFF}/u, "");
  const doc = path.endsWith(".toml")
    ? (() => {
        const parsed = parseToml(text);
        if (!parsed.ok) throw new Error("fixture is not TOML");
        return JSON.stringify(parsed.doc);
      })()
    : JSON.stringify(JSON.parse(text));
  return { bytes, doc };
}

const byHome = (views: readonly HomeView[], app: string, folder: string) => {
  const view = views.find((v) => v.home.app === app && v.home.home.endsWith(folder));
  if (view === undefined) throw new Error(`no ${app} home ${folder}`);
  return view;
};

/** An enabled Claude Code instance of machine.toml with the variables it sets. */
function claudeInstance(id: string, env: Record<string, string>): Instance {
  return {
    id,
    target: "claude-cli",
    label: id,
    account: "main",
    spaces: [],
    exec: undefined,
    argsPrefix: [],
    configHome: undefined,
    env,
    openPermission: "inherit",
    runPermission: "inherit",
    extraArgs: [],
    prompt: "sent",
    viaLoginShell: false,
    remoteAllowed: false,
    enabled: true,
  };
}

function changeOf(input: SetupInput, view: HomeView): Change {
  const change = planChange(input, view, SPACE);
  if (typeof change === "string") throw new Error(`no change: ${change}`);
  return change;
}

describe("[A3.3.13.setup.exact] apply then remove leaves every file key-identical; the preview shows the exact command and diff", () => {
  test(
    "Claude Code's user scope and two Codex homes: commands, diff, entries, then back exactly",
    async () => {
      const w = world("exact");
      // Claude Code's default home: `.claude.json` in the user's home, with another server.
      mkdirSync(join(w.home, ".claude"));
      writeFileSync(join(w.home, ".claude.json"), CLAUDE_JSON);
      // A second Claude home whose file has an empty server table.
      mkdirSync(join(w.home, ".claude-work"));
      writeFileSync(join(w.home, ".claude-work", ".claude.json"), '{\n  "mcpServers": {}\n}');
      // Codex's default home: CRLF, a byte order mark, comments, another server and a trust key.
      mkdirSync(join(w.home, ".codex"));
      const codexFile = join(w.home, ".codex", "config.toml");
      writeFileSync(codexFile, CODEX_TOML);
      if (!windows) chmodSync(codexFile, 0o640);
      // A second Codex home without a config.toml: the command makes it, the undo empties it.
      mkdirSync(join(w.home, ".codex-work"));
      // Sign-in files setup must never open.
      writeFileSync(join(w.home, ".codex", "auth.json"), "{not json, never read}");
      writeFileSync(join(w.home, ".claude", ".credentials.json"), "{not json, never read}");

      const files = [
        join(w.home, ".claude.json"),
        join(w.home, ".claude-work", ".claude.json"),
        codexFile,
        join(w.home, ".codex-work", "config.toml"),
      ];
      const before = files.map(snapshot);
      const input = await inputOf(w);
      const views = await survey(input);
      expect(views.map((v) => [v.home.app, v.home.instance, v.state]).sort()).toEqual([
        ["claude-code", "claude", "not_registered"],
        ["claude-code", "claude-work", "not_registered"],
        ["codex", "codex", "not_registered"],
        ["codex", "codex-work", "not_registered"],
      ]);

      // The preview: the exact argv and environment, the diff, the hash of the file read.
      const claude = byHome(views, "claude-code", ".claude");
      const claudeChange = changeOf(input, claude);
      const entry = [
        w.tasks,
        "mcp",
        "--space",
        SPACE,
        "--instance",
        "claude",
        "--app",
        "claude-code",
      ];
      expect(claude.home.file).toBe(join(w.home, ".claude.json"));
      expect(claudeChange.exec).toHaveLength(2); // Node and the npm entry, never a shim
      expect(claudeChange.args).toEqual([
        "mcp",
        "add",
        "--scope",
        "user",
        MCP_SERVER_KEY,
        "--",
        ...entry,
      ]);
      expect(claudeChange.undo).toEqual(["mcp", "remove", MCP_SERVER_KEY, "--scope", "user"]);
      // The default home is selected by no variable: the person's CLAUDE_CONFIG_DIR is taken out.
      expect(claudeChange.set).toEqual({});
      expect(claudeChange.unset).toEqual(["CLAUDE_CONFIG_DIR", "CODEX_HOME"]);
      expect(claudeChange.diff).toEqual([
        `+ mcpServers.${MCP_SERVER_KEY}.command = ${JSON.stringify(w.tasks)}`,
        `+ mcpServers.${MCP_SERVER_KEY}.args = ${JSON.stringify(entry.slice(1))}`,
      ]);
      expect(claude.sha256).toMatch(/^[0-9a-f]{64}$/u);
      const work = byHome(views, "claude-code", ".claude-work");
      expect(changeOf(input, work).set).toEqual({
        CLAUDE_CONFIG_DIR: join(w.home, ".claude-work"),
      });
      const codex = byHome(views, "codex", ".codex");
      const codexChange = changeOf(input, codex);
      expect(codexChange.args.slice(0, 4)).toEqual(["mcp", "add", MCP_SERVER_KEY, "--"]);
      expect(codexChange.set).toEqual({ CODEX_HOME: join(w.home, ".codex") });
      expect(codexChange.diff.slice(-2)).toEqual([
        `+ env_vars = ["${envVar("TICKET")}"]`,
        "+ startup_timeout_sec = 20",
      ]);
      const codexWork = byHome(views, "codex", ".codex-work");
      expect(codexWork.sha256).toBeNull();
      // Nothing was written by looking.
      expect(files.map(snapshot)).toEqual(before);
      expect(existsSync(join(setupDir(w.state), SETUP_FILE))).toBe(false);

      // Apply each home.
      for (const view of views) {
        const outcome = await applyHome(input, view, SPACE, `gr_${"a".repeat(26)}`);
        expect(outcome, view.home.home).toMatchObject({ result: "applied" });
      }
      const afterApply = await survey(input);
      expect(afterApply.map((v) => v.state)).toEqual([
        "registered",
        "registered",
        "registered",
        "registered",
      ]);
      const claudeJson = JSON.parse(readFileSync(files[0] ?? "", "utf8")) as {
        mcpServers: Record<string, unknown>;
      };
      expect(claudeJson.mcpServers[MCP_SERVER_KEY]).toEqual({
        type: "stdio",
        command: w.tasks,
        args: entry.slice(1),
        env: {},
      });
      expect(claudeJson.mcpServers["other"]).toEqual(OTHER);
      // Codex: the command's table plus TTasks's two keys, in the file's own CRLF, the rest kept.
      const codexText = readFileSync(codexFile, "utf8");
      expect(codexText.startsWith(CODEX_TOML)).toBe(true);
      expect(codexText.replace(/\r\n/gu, "")).not.toContain("\n");
      expect(codexText.slice(CODEX_TOML.length)).toBe(
        [
          "",
          `[mcp_servers.${MCP_SERVER_KEY}]`,
          `command = ${JSON.stringify(w.tasks)}`,
          `args = [${codexChange.entry
            .slice(1)
            .map((a) => JSON.stringify(a))
            .join(", ")}]`,
          `env_vars = ["${envVar("TICKET")}"]`,
          "startup_timeout_sec = 20",
          "",
        ].join("\r\n"),
      );
      if (!windows) {
        expect(statSync(codexFile).mode & 0o777).toBe(0o640);
        expect(statSync(join(setupDir(w.state), SETUP_FILE)).mode & 0o777).toBe(0o600);
        expect(statSync(setupDir(w.state)).mode & 0o777).toBe(0o700);
      }
      // The record holds TTasks's own entries, never another server's secret or a file's copy.
      const recordText = readFileSync(join(setupDir(w.state), SETUP_FILE), "utf8");
      expect(recordText).not.toContain(SENTINEL);
      expect(recordText).not.toContain("fixture-model");
      const records = readRecords(w.state);
      expect(records.map((r) => [r.app, r.instance, r.state, r.space])).toHaveLength(4);
      expect(records.find((r) => r.instance === "codex")?.patches).toEqual([
        { key: "env_vars", before: null, after: [envVar("TICKET")] },
        { key: "startup_timeout_sec", before: null, after: 20 },
      ]);
      // Each command ran with its own home and nothing else: never the person's other homes.
      const mcpCalls = w.fakes.calls().filter((c) => c.args[0] === "mcp");
      expect(
        mcpCalls.map((c) => [c.tool, c.env.CLAUDE_CONFIG_DIR, c.env.CODEX_HOME]).sort(),
      ).toEqual(
        [
          ["claude", join(w.home, ".claude-work"), null],
          ["claude", null, null],
          ["codex", null, join(w.home, ".codex")],
          ["codex", null, join(w.home, ".codex-work")],
        ].sort(),
      );

      // Applying again changes nothing.
      for (const view of afterApply) {
        expect((await applyHome(input, view, SPACE, `gr_${"a".repeat(26)}`)).result).toBe(
          "unchanged",
        );
      }

      // Remove: every file as it was, key for key; here byte for byte too.
      for (const view of await survey(input)) {
        const outcome = await removeHome(input, view);
        expect(outcome, view.home.home).toMatchObject({ result: "removed" });
        expect(outcome.notes).toBeUndefined();
      }
      const after = files.map(snapshot);
      expect(after.map((s) => s?.doc ?? null)).toEqual(before.map((s) => s?.doc ?? null));
      expect(after).toEqual(before);
      expect(readRecords(w.state)).toEqual([]);
      expect((await survey(input)).map((v) => v.state)).toEqual([
        "not_registered",
        "not_registered",
        "not_registered",
        "not_registered",
      ]);
      // The sign-in files were never touched.
      expect(readFileSync(join(w.home, ".codex", "auth.json"), "utf8")).toBe(
        "{not json, never read}",
      );
    },
    SLOW,
  );

  test(
    "a fresh Claude home: the command makes `.claude.json`, its own remove keeps an empty table, and setup says so",
    async () => {
      const w = world("fresh");
      mkdirSync(join(w.home, ".claude-x"));
      const input = await inputOf(w);
      const [view] = await survey(input);
      expect(view?.state).toBe("not_registered");
      if (view === undefined) return;
      expect(planChange(input, view, SPACE)).toMatchObject({
        diff: [
          expect.stringMatching(/^\+ mcpServers = \{\}$/u),
          expect.any(String),
          expect.any(String),
        ],
      });
      expect((await applyHome(input, view, SPACE, null)).result).toBe("applied");
      const [registered] = await survey(input);
      if (registered === undefined) return;
      const removed = await removeHome(input, registered);
      expect(removed).toMatchObject({ result: "removed", notes: ["empty_parent_kept"] });
      expect(JSON.parse(readFileSync(join(w.home, ".claude-x", ".claude.json"), "utf8"))).toEqual({
        mcpServers: {},
      });
    },
    SLOW,
  );

  test(
    "an instance that names Claude Code's default folder by its variable gets its entry where it reads it",
    async () => {
      const w = world("named");
      const folder = join(w.home, ".claude");
      mkdirSync(folder);
      writeFileSync(join(w.home, ".claude.json"), "{}");
      const base = await inputOf(w);
      const input: SetupInput = {
        ...base,
        instances: [claudeInstance("claude-main", { CLAUDE_CONFIG_DIR: folder })],
      };
      const view = byHome(await survey(input), "claude-code", ".claude");
      expect(view.home).toMatchObject({
        instance: "claude-main",
        isDefault: false,
        file: join(folder, ".claude.json"),
      });
      expect(changeOf(input, view).set).toEqual({ CLAUDE_CONFIG_DIR: folder });
      expect((await applyHome(input, view, SPACE, null)).result).toBe("applied");
      expect(JSON.parse(readFileSync(join(folder, ".claude.json"), "utf8"))).toMatchObject({
        mcpServers: { [MCP_SERVER_KEY]: { command: w.tasks } },
      });
      // The default file, which that instance never reads, is untouched.
      expect(readFileSync(join(w.home, ".claude.json"), "utf8")).toBe("{}");
    },
    SLOW,
  );

  test(
    "a registered home stays the recorded one when machine.toml names it otherwise; remove, then apply, moves it",
    async () => {
      const w = world("moved");
      const folder = join(w.home, ".claude");
      mkdirSync(folder);
      const defaultFile = join(w.home, ".claude.json");
      writeFileSync(defaultFile, "{}");
      const plain = await inputOf(w);
      expect(
        (await applyHome(plain, byHome(await survey(plain), "claude-code", ".claude"), SPACE, null))
          .result,
      ).toBe("applied");

      // An instance now selects the same folder by its variable, under another ID.
      const named: SetupInput = {
        ...plain,
        instances: [claudeInstance("claude-main", { CLAUDE_CONFIG_DIR: folder })],
      };
      const view = byHome(await survey(named), "claude-code", ".claude");
      expect(view.home).toMatchObject({ file: defaultFile, instance: "claude", isDefault: true });
      expect(view.state).toBe("registered");
      expect(await removeHome(named, view)).toMatchObject({ result: "removed" });
      expect(JSON.parse(readFileSync(defaultFile, "utf8"))).toEqual({ mcpServers: {} });
      expect(readRecords(w.state)).toEqual([]);
      // Now the home is what the machine says: the instance's own file and ID.
      expect(byHome(await survey(named), "claude-code", ".claude").home).toMatchObject({
        file: join(folder, ".claude.json"),
        instance: "claude-main",
      });

      // The plan's token covers everything the home's row names, the account included.
      const views = await survey(named);
      const token = planToken(SPACE, planOf(named, views, SPACE));
      const relabelled = views.map((v) => ({ ...v, home: { ...v.home, account: "other" } }));
      expect(planToken(SPACE, planOf(named, relabelled, SPACE))).not.toBe(token);
      expect(planToken(SPACE, planOf(named, await survey(named), SPACE))).toBe(token);
    },
    SLOW,
  );
});

describe("[A3.3.13.setup.refuse] a home setup does not understand is refused untouched; an entry changed by hand is left alone", () => {
  test(
    "unparseable, duplicate keys, managed, inline servers, a foreign entry and no command: refused, nothing runs",
    async () => {
      const w = world("refuse");
      const cases: [string, string, string, string][] = [
        [".codex-dup", "config.toml", "a = 1\na = 2\n", "invalid_file"],
        [
          ".codex-managed",
          "config.toml",
          '# Generated by a dotfiles tool. Do not edit.\nmodel = "x"\n',
          "managed",
        ],
        [
          ".codex-inline",
          "config.toml",
          'mcp_servers = { other = { command = "x" } }\n',
          "unsupported_layout",
        ],
        [
          ".codex-dotted",
          "config.toml",
          '[mcp_servers]\nother.command = "x"\n',
          "unsupported_layout",
        ],
        [
          ".codex-foreign",
          "config.toml",
          `[mcp_servers.${MCP_SERVER_KEY}]\ncommand = "/elsewhere"\n`,
          "foreign_entry",
        ],
        [".codex-utf", "config.toml", "\u00ff", "encoding"],
        [
          ".claude-dup",
          ".claude.json",
          '{"mcpServers": {}, "mcpServers": {"x": {}}}',
          "duplicate_key",
        ],
        [".claude-bad", ".claude.json", "{ not json", "invalid_file"],
        [".claude-type", ".claude.json", '{"mcpServers": []}', "wrong_type"],
      ];
      for (const [folder, name, text] of cases) {
        mkdirSync(join(w.home, folder));
        writeFileSync(
          join(w.home, folder, name),
          name === "config.toml" && text === "\u00ff" ? Buffer.from([0xff, 0xfe]) : text,
        );
      }
      // A home without a file, for the case without a command below.
      mkdirSync(join(w.home, ".codex"));
      if (!windows) {
        // A file that is a link: another tool keeps it.
        mkdirSync(join(w.home, ".claude-link"));
        writeFileSync(join(w.root, "kept-elsewhere.json"), "{}");
        symlinkSync(
          join(w.root, "kept-elsewhere.json"),
          join(w.home, ".claude-link", ".claude.json"),
        );
        cases.push([".claude-link", ".claude.json", "{}", "managed"]);
      }
      const input = await inputOf(w);
      const views = await survey(input);
      for (const [folder, , , reason] of cases) {
        const view = byHome(views, folder.startsWith(".codex") ? "codex" : "claude-code", folder);
        expect([folder, view.state, view.refusal]).toEqual([folder, "refused", reason]);
        expect(await applyHome(input, view, SPACE, null)).toMatchObject({ result: "left", reason });
      }
      expect(w.fakes.calls().filter((c) => c.args[0] === "mcp")).toEqual([]);
      expect(existsSync(join(setupDir(w.state), SETUP_FILE))).toBe(false);

      // No usable command of the app: refused before anything runs.
      const noCommand = { ...input, detection: { ...input.detection, commands: [] } };
      const view = byHome(await survey(noCommand), "codex", ".codex");
      expect(planChange(noCommand, view, SPACE)).toBe("no_command");
      expect(await applyHome(noCommand, view, SPACE, null)).toMatchObject({
        result: "left",
        reason: "no_command",
      });
      expect(existsSync(join(w.home, ".codex", "config.toml"))).toBe(false);
    },
    SLOW,
  );

  test(
    "an entry changed by hand stays; one removed by hand is forgotten; a failed command is taken back",
    async () => {
      const w = world("edits");
      mkdirSync(join(w.home, ".codex"));
      const file = join(w.home, ".codex", "config.toml");
      writeFileSync(file, 'model = "m"\n');
      const input = await inputOf(w);

      // Changed by hand after apply: status says so, remove leaves it and keeps the record.
      expect(
        (await applyHome(input, byHome(await survey(input), "codex", ".codex"), SPACE, null))
          .result,
      ).toBe("applied");
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace("startup_timeout_sec = 20", "startup_timeout_sec = 45"),
      );
      const edited = byHome(await survey(input), "codex", ".codex");
      expect(edited.state).toBe("edited");
      const changed = readFileSync(file, "utf8");
      expect(await removeHome(input, edited)).toMatchObject({ result: "left", reason: "edited" });
      expect(readFileSync(file, "utf8")).toBe(changed);
      expect(readRecords(w.state)).toHaveLength(1);

      // Removed by hand: the record goes, nothing runs.
      writeFileSync(file, 'model = "m"\n');
      const gone = byHome(await survey(input), "codex", ".codex");
      expect(gone.state).toBe("missing");
      const runs = w.fakes.calls().length;
      expect(await removeHome(input, gone)).toMatchObject({ result: "removed", reason: "missing" });
      expect(w.fakes.calls().length).toBe(runs);
      expect(readRecords(w.state)).toEqual([]);

      // The command fails before writing: nothing to take back, no record.
      const failing = await inputOf(w, { FAKE_AGENT_FAIL: "codex" });
      expect(
        await applyHome(failing, byHome(await survey(failing), "codex", ".codex"), SPACE, null),
      ).toMatchObject({ result: "failed", reason: "command_failed" });
      expect(readFileSync(file, "utf8")).toBe('model = "m"\n');
      expect(readRecords(w.state)).toEqual([]);

      // The command writes, then fails: its own undo takes the entry back.
      const half = await inputOf(w, { FAKE_AGENT_FAIL: "codex:add-after" });
      expect(
        await applyHome(half, byHome(await survey(half), "codex", ".codex"), SPACE, null),
      ).toMatchObject({
        result: "failed",
        reason: "command_failed",
      });
      expect(readFileSync(file, "utf8")).toBe('model = "m"\n');
      expect(readRecords(w.state)).toEqual([]);
    },
    SLOW,
  );

  test(
    "a take-back runs only on an entry that is provably setup's: never one that appeared, or was changed, meanwhile",
    async () => {
      const w = world("owned");
      const removes = () =>
        w.fakes.calls().filter((c) => c.args[0] === "mcp" && c.args[1] === "remove").length;

      // Another entry of TTasks's name appears after apply's check and before the command: the app
      // refuses to overwrite it, and setup must not take it back.
      mkdirSync(join(w.home, ".codex"));
      const codexFile = join(w.home, ".codex", "config.toml");
      writeFileSync(codexFile, 'model = "m"\n');
      mkdirSync(join(w.home, ".claude-x"));
      const base = await inputOf(w);
      const foreign = `model = "m"\n\n[mcp_servers.${MCP_SERVER_KEY}]\ncommand = "/elsewhere"\n`;
      const racing: SetupInput = {
        ...base,
        run: (argv, env) => {
          if (argv.includes("add")) writeFileSync(codexFile, foreign);
          return base.run(argv, env);
        },
      };
      expect(
        await applyHome(racing, byHome(await survey(racing), "codex", ".codex"), SPACE, null),
      ).toMatchObject({ result: "failed", reason: "changed_meanwhile" });
      expect(readFileSync(codexFile, "utf8")).toBe(foreign);
      expect(readRecords(w.state)).toEqual([]);
      expect(removes()).toBe(0);

      // An entry changed after remove's survey: remove reads it again and leaves it.
      writeFileSync(codexFile, 'model = "m"\n');
      expect(
        (await applyHome(base, byHome(await survey(base), "codex", ".codex"), SPACE, null)).result,
      ).toBe("applied");
      const stale = byHome(await survey(base), "codex", ".codex");
      expect(stale.state).toBe("registered");
      const edited = `${readFileSync(codexFile, "utf8")}tool_timeout_sec = 99\n`;
      writeFileSync(codexFile, edited);
      expect(await removeHome(base, stale)).toMatchObject({ result: "left", reason: "edited" });
      expect(readFileSync(codexFile, "utf8")).toBe(edited);
      expect(readRecords(w.state)).toHaveLength(1);
      expect(removes()).toBe(0);

      // An apply cut off after its patches were written, before its record said so: the checkpoint
      // (the command's entry and the patches) makes the patched entry setup's, and only that one.
      const [applied] = readRecords(w.state);
      if (applied === undefined) throw new Error("no record");
      const keys = new Set(applied.patches.map((p) => p.key));
      const commandEntry = Object.fromEntries(
        Object.entries(applied.entry as Record<string, unknown>).filter(([k]) => !keys.has(k)),
      );
      writeRecords(w.state, [{ ...applied, state: "applying", entry: commandEntry }]);
      writeFileSync(codexFile, edited);
      const cut = byHome(await survey(base), "codex", ".codex");
      expect(cut.state).toBe("interrupted");
      expect(await removeHome(base, cut)).toMatchObject({ result: "left", reason: "edited" });
      expect(readFileSync(codexFile, "utf8")).toBe(edited);
      writeFileSync(codexFile, edited.replace("tool_timeout_sec = 99\n", ""));
      expect(await removeHome(base, byHome(await survey(base), "codex", ".codex"))).toMatchObject({
        result: "removed",
      });
      expect(readFileSync(codexFile, "utf8")).toBe('model = "m"\n');
      expect(readRecords(w.state)).toEqual([]);

      // An apply cut off while the command ran (no entry recorded yet), whose entry the person then
      // changed: only an entry exactly as asked is setup's.
      const claudeFile = join(w.home, ".claude-x", ".claude.json");
      const crashing: SetupInput = {
        ...base,
        run: async (argv, env) => {
          const ran = await base.run(argv, env);
          if (argv.includes("add")) throw new Error("cut off");
          return ran;
        },
      };
      await expect(
        applyHome(
          crashing,
          byHome(await survey(crashing), "claude-code", ".claude-x"),
          SPACE,
          null,
        ),
      ).rejects.toThrow("cut off");
      expect(readRecords(w.state).map((r) => [r.state, r.entry])).toEqual([["applying", null]]);
      const asWritten = readFileSync(claudeFile, "utf8");
      const doc = JSON.parse(asWritten) as { mcpServers: Record<string, { env: unknown }> };
      const entry = doc.mcpServers[MCP_SERVER_KEY];
      if (entry === undefined) throw new Error("no entry");
      entry.env = { PERSON: "1" };
      const changed = JSON.stringify(doc, null, 2);
      writeFileSync(claudeFile, changed);
      expect(
        await removeHome(base, byHome(await survey(base), "claude-code", ".claude-x")),
      ).toMatchObject({ result: "left", reason: "edited" });
      expect(readFileSync(claudeFile, "utf8")).toBe(changed);
      writeFileSync(claudeFile, asWritten);
      expect(
        await removeHome(base, byHome(await survey(base), "claude-code", ".claude-x")),
      ).toMatchObject({ result: "removed" });
      expect(readRecords(w.state)).toEqual([]);
    },
    SLOW,
  );

  test(
    "after a successful add, a take-back still needs a file setup accepts and an entry that is its own",
    async () => {
      const w = world("after-add");
      mkdirSync(join(w.home, ".codex"));
      const file = join(w.home, ".codex", "config.toml");
      writeFileSync(file, 'model = "m"\n');
      const base = await inputOf(w);
      const removes = () =>
        w.fakes.calls().filter((c) => c.args[0] === "mcp" && c.args[1] === "remove").length;
      /** The add runs and succeeds, then `after` changes the file before setup reads it. */
      const adding = (after: () => void): SetupInput => ({
        ...base,
        run: async (argv, env) => {
          const ran = await base.run(argv, env);
          if (argv.includes("add")) after();
          return ran;
        },
      });

      // Another entry takes the place of the command's: it is not setup's, so it stays, and so does
      // the record (`--remove` reports it as changed).
      const foreign = `model = "m"\n\n[mcp_servers.${MCP_SERVER_KEY}]\ncommand = "/elsewhere"\n`;
      const replaced = adding(() => {
        writeFileSync(file, foreign);
      });
      expect(
        await applyHome(replaced, byHome(await survey(replaced), "codex", ".codex"), SPACE, null),
      ).toMatchObject({ result: "failed", reason: "unexpected_entry", notes: ["entry_left"] });
      expect(readFileSync(file, "utf8")).toBe(foreign);
      expect(removes()).toBe(0);
      expect(readRecords(w.state).map((r) => r.state)).toEqual(["applying"]);
      expect(await removeHome(base, byHome(await survey(base), "codex", ".codex"))).toMatchObject({
        result: "left",
        reason: "edited",
      });
      expect(readFileSync(file, "utf8")).toBe(foreign);
      // The person takes it out by hand: the record goes, nothing runs.
      writeFileSync(file, 'model = "m"\n');
      expect(await removeHome(base, byHome(await survey(base), "codex", ".codex"))).toMatchObject({
        result: "removed",
        reason: "missing",
      });
      expect(readRecords(w.state)).toEqual([]);

      // The file turns into one setup does not accept: nothing runs there, the record stays.
      const broken = adding(() => {
        writeFileSync(file, `${readFileSync(file, "utf8")}[[[\n`);
      });
      expect(
        await applyHome(broken, byHome(await survey(broken), "codex", ".codex"), SPACE, null),
      ).toMatchObject({ result: "failed", reason: "unexpected_entry", notes: ["undo_failed"] });
      expect(removes()).toBe(0);
      expect(readRecords(w.state).map((r) => r.state)).toEqual(["applying"]);
    },
    SLOW,
  );

  test(
    "a home that is a link, and on Linux and macOS a file anyone can change, are refused untouched",
    async () => {
      const w = world("links");
      // A Codex home that is a link (a junction on Windows) to a folder another tool keeps.
      const kept = join(w.root, "kept");
      mkdirSync(kept);
      writeFileSync(join(kept, "config.toml"), 'model = "m"\n');
      symlinkSync(kept, join(w.home, ".codex-linked"), windows ? "junction" : "dir");
      // A Claude home whose file anyone can write, and a Codex home anyone can write into.
      if (!windows) {
        mkdirSync(join(w.home, ".claude-open"));
        writeFileSync(join(w.home, ".claude-open", ".claude.json"), "{}");
        chmodSync(join(w.home, ".claude-open", ".claude.json"), 0o646);
        mkdirSync(join(w.home, ".codex-open"));
        chmodSync(join(w.home, ".codex-open"), 0o777);
      }
      const input = await inputOf(w);
      const views = await survey(input);
      const cases: [string, string, string][] = [["codex", ".codex-linked", "managed"]];
      if (!windows) {
        cases.push(["claude-code", ".claude-open", "unsafe"], ["codex", ".codex-open", "unsafe"]);
      }
      for (const [app, folder, reason] of cases) {
        const view = byHome(views, app, folder);
        expect([folder, view.state, view.refusal]).toEqual([folder, "refused", reason]);
        expect(await applyHome(input, view, SPACE, null)).toMatchObject({ result: "left", reason });
      }
      expect(w.fakes.calls().filter((c) => c.args[0] === "mcp")).toEqual([]);
      expect(readFileSync(join(kept, "config.toml"), "utf8")).toBe('model = "m"\n');
      if (!windows) expect(existsSync(join(w.home, ".codex-open", "config.toml"))).toBe(false);
      expect(existsSync(join(setupDir(w.state), SETUP_FILE))).toBe(false);
    },
    SLOW,
  );
});
