// `ttasks setup agents` (A3 3.13.1, 3.13.2, 3.13.4; A7 3.9 M2.14): on scratch homes, apply then
// remove gives back every file byte for byte, and the preview shows the exact entry and its diff.
// Setup writes each entry itself: no app's command runs (setup-fixtures.test.ts has the table of
// files and events for every app).
//
// Every home here is a folder this test made under the OS's temporary folder. No test reads or
// changes a real agent home (A3 3.13.1).
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
import { valueText } from "../src/config/edit.ts";
import { parseToml } from "../src/config/toml.ts";
import {
  applyHome,
  planChange,
  planOf,
  planToken,
  readRecords,
  removeHome,
  setupDir,
  SETUP_FILE,
  survey,
  type Change,
  type HomeView,
  type SetupInput,
} from "../src/setup/index.ts";
import { keptRows } from "./setup-rows.ts";

const SLOW = 180_000;
const SPACE = "sp_3z8sm956jp8dajmtsar5kx026c";
const windows = process.platform === "win32";
const BOM = "\u{FEFF}";
/** The service's rows, as these tests keep them. */
const ROWS = keptRows();

const temps: string[] = [];
afterEach(() => {
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
  };
}

async function inputOf(w: World): Promise<SetupInput> {
  // The person's shell names other homes: setup never follows them.
  const env = {
    CLAUDE_CONFIG_DIR: join(w.root, "elsewhere-claude"),
    CODEX_HOME: join(w.root, "elsewhere-codex"),
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
    run: () => Promise.reject(new Error("setup runs no command")),
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

describe("[A3.3.13.setup.exact] apply then remove gives back every file byte for byte; the preview shows the exact entry and its diff", () => {
  test(
    "Claude Code's user scope and two Codex homes: the entries, their diffs, then back exactly",
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
      // A second Codex home without a config.toml: setup creates it, and its removal deletes it.
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

      // The preview: the exact entry, the lines its file gains, the hash of the file read.
      const claude = byHome(views, "claude-code", ".claude");
      const argv = (instance: string, app: string) => [
        "mcp",
        "--space",
        SPACE,
        "--instance",
        instance,
        "--app",
        app,
      ];
      expect(claude.home.file).toBe(join(w.home, ".claude.json"));
      const claudeChange = changeOf(input, claude);
      expect(claudeChange.entry).toEqual({ command: w.tasks, args: argv("claude", "claude-code") });
      expect(claudeChange.diff).toEqual([
        `+ mcpServers.${MCP_SERVER_KEY}.command = ${JSON.stringify(w.tasks)}`,
        `+ mcpServers.${MCP_SERVER_KEY}.args = ${JSON.stringify(argv("claude", "claude-code"))}`,
      ]);
      expect(claude.sha256).toMatch(/^[0-9a-f]{64}$/u);
      const codex = byHome(views, "codex", ".codex");
      const codexChange = changeOf(input, codex);
      expect(codexChange.entry).toEqual({
        command: w.tasks,
        args: argv("codex", "codex"),
        env_vars: [envVar("TICKET")],
        startup_timeout_sec: 20,
      });
      expect(codexChange.diff.slice(0, 1)).toEqual([`+ [mcp_servers.${MCP_SERVER_KEY}]`]);
      expect(codexChange.diff.slice(-2)).toEqual([
        `+ env_vars = ["${envVar("TICKET")}"]`,
        "+ startup_timeout_sec = 20",
      ]);
      expect(byHome(views, "codex", ".codex-work").sha256).toBeNull();
      // Nothing was written by looking.
      expect(files.map(snapshot)).toEqual(before);
      expect(existsSync(join(setupDir(w.state), SETUP_FILE))).toBe(false);

      for (const view of views) {
        const outcome = await applyHome(input, view, SPACE, ROWS);
        expect(outcome, view.home.home).toMatchObject({ result: "applied", access: "on" });
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
      expect(claudeJson.mcpServers[MCP_SERVER_KEY]).toEqual(claudeChange.entry);
      expect(claudeJson.mcpServers["other"]).toEqual(OTHER);
      // Codex: one table at the end, in the file's own CRLF, every byte before it kept.
      const codexText = readFileSync(codexFile, "utf8");
      expect(codexText.startsWith(CODEX_TOML)).toBe(true);
      expect(codexText.slice(CODEX_TOML.length)).toBe(
        [
          "",
          `[mcp_servers.${MCP_SERVER_KEY}]`,
          `command = ${valueText(w.tasks)}`,
          `args = ${valueText(argv("codex", "codex"))}`,
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
      expect(readRecords(w.state)).toHaveLength(4);
      // The homes the person's shell names were never touched.
      expect(existsSync(join(w.root, "elsewhere-claude"))).toBe(false);
      expect(existsSync(join(w.root, "elsewhere-codex"))).toBe(false);

      // Applying again changes nothing.
      for (const view of afterApply) {
        expect((await applyHome(input, view, SPACE, ROWS)).result).toBe("unchanged");
      }

      // Remove: every file as it was, byte for byte; the file setup created is gone again.
      for (const view of await survey(input)) {
        const outcome = await removeHome(input, view, ROWS);
        expect(outcome, view.home.home).toMatchObject({ result: "removed", access: "off" });
      }
      expect(files.map(snapshot)).toEqual(before);
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
    "a fresh Claude home: setup creates `.claude.json` with only its entry, and its removal deletes the file again; once Claude Code has added to it, the file stays",
    async () => {
      const w = world("fresh");
      mkdirSync(join(w.home, ".claude-x"));
      const file = join(w.home, ".claude-x", ".claude.json");
      const input = await inputOf(w);
      const [view] = await survey(input);
      expect(view?.state).toBe("not_registered");
      if (view === undefined) return;
      expect(changeOf(input, view).diff[0]).toBe("+ mcpServers = {}");
      expect((await applyHome(input, view, SPACE, ROWS)).result).toBe("applied");
      expect(Object.keys(JSON.parse(readFileSync(file, "utf8")) as object)).toEqual(["mcpServers"]);
      expect(await removeHome(input, (await survey(input))[0] ?? view, ROWS)).toMatchObject({
        result: "removed",
      });
      expect(existsSync(file)).toBe(false);

      // Claude Code starts and writes its own keys: the file is its own from then on.
      expect((await applyHome(input, (await survey(input))[0] ?? view, SPACE, ROWS)).result).toBe(
        "applied",
      );
      const started = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      writeFileSync(file, JSON.stringify({ numStartups: 1, ...started }, null, 2));
      expect(await removeHome(input, (await survey(input))[0] ?? view, ROWS)).toMatchObject({
        result: "removed",
      });
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ numStartups: 1 });
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
      expect((await applyHome(input, view, SPACE, ROWS)).result).toBe("applied");
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
        (await applyHome(plain, byHome(await survey(plain), "claude-code", ".claude"), SPACE, ROWS))
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
      expect(await removeHome(named, view, ROWS)).toMatchObject({ result: "removed" });
      expect(readFileSync(defaultFile, "utf8")).toBe("{}");
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
    "unparseable, duplicate keys, managed, inline servers and a foreign entry: refused, nothing written; an app whose command is missing is registered all the same",
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
      const rows = keptRows();
      for (const [folder, name, , reason] of cases) {
        const view = byHome(views, folder.startsWith(".codex") ? "codex" : "claude-code", folder);
        const file = join(w.home, folder, name);
        const before = readFileSync(file);
        expect([folder, view.state, view.refusal]).toEqual([folder, "refused", reason]);
        expect(await applyHome(input, view, SPACE, rows)).toMatchObject({ result: "left", reason });
        expect(readFileSync(file)).toEqual(before);
      }
      expect(rows.asked).toEqual([]);
      expect(existsSync(join(setupDir(w.state), SETUP_FILE))).toBe(false);

      // No app's command on this PATH: the home is registered all the same, for when the app runs.
      mkdirSync(join(w.home, ".codex"));
      const fresh = await inputOf(w);
      expect(fresh.detection.commands).toEqual([]);
      const view = byHome(await survey(fresh), "codex", ".codex");
      expect(await applyHome(fresh, view, SPACE, rows)).toMatchObject({ result: "applied" });
      expect(readFileSync(join(w.home, ".codex", "config.toml"), "utf8")).toContain(
        `[mcp_servers.${MCP_SERVER_KEY}]`,
      );
    },
    SLOW,
  );

  test(
    "an entry changed by hand stays and loses its access; one removed by hand is forgotten",
    async () => {
      const w = world("edits");
      mkdirSync(join(w.home, ".codex"));
      const file = join(w.home, ".codex", "config.toml");
      writeFileSync(file, 'model = "m"\n');
      const input = await inputOf(w);

      // Changed by hand after apply: status says so; remove takes the access away and leaves the
      // entry, which is the person's from then on.
      expect(
        (await applyHome(input, byHome(await survey(input), "codex", ".codex"), SPACE, ROWS))
          .result,
      ).toBe("applied");
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace("startup_timeout_sec = 20", "startup_timeout_sec = 45"),
      );
      const edited = byHome(await survey(input), "codex", ".codex");
      expect(edited.state).toBe("edited");
      const changed = readFileSync(file, "utf8");
      expect(await removeHome(input, edited, ROWS)).toMatchObject({
        result: "left",
        reason: "edited",
        access: "off",
        kept: "edited",
      });
      expect(readFileSync(file, "utf8")).toBe(changed);
      expect(ROWS.live.filter((row) => row.home === edited.home.home)).toEqual([]);
      expect(readRecords(w.state)).toEqual([]);
      expect(byHome(await survey(input), "codex", ".codex")).toMatchObject({
        state: "refused",
        refusal: "foreign_entry",
      });

      // Removed by hand: the record goes, and nothing is written.
      writeFileSync(file, 'model = "m"\n');
      expect(
        (await applyHome(input, byHome(await survey(input), "codex", ".codex"), SPACE, ROWS))
          .result,
      ).toBe("applied");
      writeFileSync(file, 'model = "m"\n');
      const gone = byHome(await survey(input), "codex", ".codex");
      expect(gone.state).toBe("missing");
      expect(await removeHome(input, gone, ROWS)).toMatchObject({
        result: "removed",
        reason: "missing",
      });
      expect(readFileSync(file, "utf8")).toBe('model = "m"\n');
      expect(readRecords(w.state)).toEqual([]);
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
        expect(await applyHome(input, view, SPACE, ROWS)).toMatchObject({ result: "left", reason });
      }
      expect(readFileSync(join(kept, "config.toml"), "utf8")).toBe('model = "m"\n');
      if (!windows) expect(existsSync(join(w.home, ".codex-open", "config.toml"))).toBe(false);
      expect(existsSync(join(setupDir(w.state), SETUP_FILE))).toBe(false);
    },
    SLOW,
  );
});
