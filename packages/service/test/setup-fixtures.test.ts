// Agent setup's fixture table: each file and event below, run through the production planner
// (survey, planOf), writer (applyHome, removeHome, settleHomes) and grant logic, for every app setup
// writes. After each action it compares the file's raw bytes, the home's access, and the other home
// of the same app, which nothing may change. Every home is a folder under this file's own temporary
// folder; no app's command runs, and the grants table is the test's own (setup-rows.ts).
import fs, {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { envVar, MCP_SERVER_KEY } from "@ttasks/brand";
import { detect, nodeDetectHost } from "@ttasks/launch";
import { parseToml } from "../src/config/toml.ts";
import { withAppLock } from "../src/setup/app-lock.ts";
import {
  applyFiles,
  applyHome,
  FURTHER_FILE,
  homeAnswer,
  planOf,
  planToken,
  readRecords,
  removeFiles,
  removeHome,
  setupDir,
  SETUP_FILE,
  settleHomes,
  survey,
  toolsOf,
  writeRecords,
  type Access,
  type AgentApp,
  type HomeRecord,
  type HomeView,
  type SetupInput,
} from "../src/setup/index.ts";
import { keptRows, type KeptRows } from "./setup-rows.ts";
import { installedTasks } from "./harness.ts";

const SLOW = 120_000;
const SPACE = "sp_3z8sm956jp8dajmtsar5kx026c";
const windows = process.platform === "win32";
/** Root ignores a file's mode: the rows that need an unwritable file cannot be made. */
const root = process.getuid?.() === 0;
const BOM = "\u{FEFF}";
/** Another server's secret: it never leaves its file. */
const SECRET = "sentinel-secret-41c7";

let base: string;
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "ttasks-setup-fixtures-"));
});
afterAll(() => {
  rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

/** One app setup writes: where its selected home's file is, and another home's of the same app. */
interface Adapter {
  readonly app: AgentApp;
  readonly format: "json" | "toml";
  /** The selected home's folder, under the user's home; Claude Desktop's is found by the OS's rule. */
  readonly folder?: string;
  file(w: World): string;
  /** Another home of the same app, which setup must never change; none for Claude Desktop. */
  other?(w: World): string;
  /** The app makes its file itself: setup never creates it. */
  readonly needsFile?: true;
}

interface World {
  readonly dir: string;
  readonly home: string;
  readonly input: SetupInput;
  readonly rows: KeptRows;
  readonly desktop: string;
}

const ADAPTERS: readonly Adapter[] = [
  {
    app: "claude-code",
    format: "json",
    folder: ".claude-work",
    file: (w) => join(w.home, ".claude-work", ".claude.json"),
    // The default home: its file sits in the user's home, read when no variable selects a home.
    other: (w) => join(w.home, ".claude.json"),
  },
  {
    app: "codex",
    format: "toml",
    folder: ".codex-work",
    file: (w) => join(w.home, ".codex-work", "config.toml"),
    other: (w) => join(w.home, ".codex", "config.toml"),
  },
  {
    app: "claude-desktop",
    format: "json",
    file: (w) => join(w.desktop, "claude_desktop_config.json"),
    needsFile: true,
  },
];

let worlds = 0;
async function world(wait?: (ms: number) => Promise<void>): Promise<World> {
  worlds += 1;
  const dir = join(base, String(worlds));
  const home = join(dir, "home");
  for (const folder of [".claude", ".claude-work", ".codex", ".codex-work"]) {
    mkdirSync(join(home, folder), { recursive: true });
  }
  // No PATH: no app's command can be found, and none is needed.
  const env: Record<string, string> = {};
  let desktop: string;
  if (windows) {
    env["APPDATA"] = join(dir, "roaming");
    env["LOCALAPPDATA"] = join(dir, "local");
    desktop = join(dir, "roaming", "Claude");
  } else if (process.platform === "darwin") {
    desktop = join(home, "Library", "Application Support", "Claude");
  } else {
    env["XDG_CONFIG_HOME"] = join(dir, "xdg");
    desktop = join(dir, "xdg", "Claude");
  }
  mkdirSync(desktop, { recursive: true });
  return {
    dir,
    home,
    desktop,
    rows: keptRows(),
    input: {
      platform: process.platform,
      userHome: home,
      env,
      stateDir: join(dir, "state"),
      tasks: installedTasks(dir),
      detection: await detect(nodeDetectHost({ env, home, timeoutMs: 30_000 })),
      instances: [],
      systemApplications: join(dir, "Applications"),
      isFolder: (path) => existsSync(path) && statSync(path).isDirectory(),
      run: () => Promise.reject(new Error("setup runs no command")),
      ...(wait === undefined ? {} : { wait }),
    },
  };
}

/** A file's bytes, or null when it is not there. */
const bytesOf = (file: string): Buffer | null => (existsSync(file) ? readFileSync(file) : null);

function seed(file: string, text: string | null): void {
  if (text === null) rmSync(file, { force: true });
  else writeFileSync(file, text);
}

async function viewOf(w: World, a: Adapter): Promise<HomeView> {
  const views = await survey(w.input);
  const found = views.find(
    (v) => v.home.app === a.app && (a.folder === undefined || v.home.home.endsWith(a.folder)),
  );
  if (found === undefined) throw new Error(`no ${a.app} home`);
  return found;
}

async function apply(w: World, a: Adapter) {
  const view = await viewOf(w, a);
  const [item] = planOf(w.input, [view], SPACE);
  return applyHome(w.input, view, SPACE, w.rows, item?.change);
}

async function remove(w: World, a: Adapter) {
  return removeHome(w.input, await viewOf(w, a), w.rows);
}

const recordPath = (w: World): string => join(setupDir(w.input.stateDir), SETUP_FILE);

/** Whether the selected home has access: a live row of the test's grants table. */
const accessOf = (w: World, a: Adapter, file: string): boolean =>
  w.rows.live.some((row) => row.app === a.app && file.startsWith(row.home));

/** TTasks's entry in a file's document, read as the app would. */
function entryIn(a: Adapter, file: string): unknown {
  const raw = readFileSync(file, "utf8").replace(/^\u{FEFF}/u, "");
  const doc =
    a.format === "toml"
      ? (() => {
          const parsed = parseToml(raw);
          if (!parsed.ok) throw new Error("not TOML");
          return parsed.doc;
        })()
      : (JSON.parse(raw) as Record<string, unknown>);
  const servers = doc[a.format === "toml" ? "mcp_servers" : "mcpServers"] as
    Record<string, unknown> | undefined;
  return servers?.[MCP_SERVER_KEY];
}

/** What setup writes for an app: the command, the bridge's arguments, and Codex's two keys. */
function expectedEntry(w: World, a: Adapter, instance: string): Record<string, unknown> {
  const entry = {
    command: w.input.tasks,
    args: ["mcp", "--space", SPACE, "--instance", instance, "--app", a.app],
  };
  return a.format === "toml"
    ? { ...entry, env_vars: [envVar("TICKET")], startup_timeout_sec: 20 }
    : entry;
}

/** The files each row starts from, per format: what a person's file may look like. */
const FILES: Readonly<Record<"json" | "toml", readonly [string, string | null][]>> = {
  json: [
    [
      "a byte order mark, CRLF, four spaces, unknown keys around an empty servers object with spaces inside, no final newline",
      `${BOM}{\r\n    "zeta": {"deep": [1, 2.5, null]},\r\n    "mcpServers": {  },\r\n    "alpha": "${SECRET}"\r\n}`,
    ],
    [
      "one line, another server first",
      `{"mcpServers":{"other":{"command":"/opt/other","args":["serve"],"env":{"TOKEN":"${SECRET}"}}},"numStartups":3}`,
    ],
    ["tabs, no servers object yet", '{\n\t"theme": "dark",\n\t"tips": false\n}\n'],
    ["an empty object without a newline", "{}"],
    ["no file", null],
  ],
  toml: [
    [
      "a byte order mark, CRLF, comments, another server with inline comments, a trust table, no final newline",
      [
        `${BOM}# The person's own settings.`,
        'model = "fixture-model"',
        "",
        "[mcp_servers.other]",
        'command = "/opt/other"   # kept as written',
        'args = ["serve"]         # and this',
        `env = { OTHER_KEY = "${SECRET}" }`,
        "unknown_field = 7",
        "",
        "[projects.'C:\\work\\x']",
        'trust_level = "trusted"',
      ].join("\r\n"),
    ],
    ["an explicit empty servers table", '[mcp_servers]\n\n[profiles.fast]\nmodel = "m"\n'],
    ["only a comment, no final newline", "# nothing yet"],
    ["an empty file", ""],
    ["no file", null],
  ],
};

describe("[A3.3.13.setup.fixtures] agent setup's fixture table: each file and event, every app, raw bytes, access and the other home", () => {
  test(
    "add then remove gives back every byte; the entry is exactly setup's; the other home and other servers stay",
    async () => {
      for (const a of ADAPTERS) {
        for (const [label, text] of FILES[a.format]) {
          const w = await world();
          const file = a.file(w);
          const other = a.other?.(w);
          const otherText =
            a.format === "toml" ? '[mcp_servers.mine]\ncommand = "mine"\n' : '{"mcpServers": {}}';
          if (other !== undefined) seed(other, otherText);
          seed(file, text);
          const before = bytesOf(file);
          const what = `${a.app}: ${label}`;
          const applied = await apply(w, a);
          if (a.needsFile === true && text === null) {
            // Claude Desktop makes its own file: setup never does.
            expect(applied, what).toMatchObject({ result: "left", reason: "not_set_up" });
            expect(bytesOf(file), what).toBeNull();
            expect(w.rows.asked, what).toEqual([]);
            continue;
          }
          expect(applied, what).toMatchObject({ result: "applied", access: "on" });
          expect(accessOf(w, a, file), what).toBe(true);
          const instance = (await viewOf(w, a)).home.instance;
          expect(entryIn(a, file), what).toEqual(expectedEntry(w, a, instance));
          // The record holds the entry as setup intended it, never another server's value.
          const recordText = readFileSync(join(setupDir(w.input.stateDir), SETUP_FILE), "utf8");
          expect(recordText, what).not.toContain(SECRET);
          expect(readRecords(w.input.stateDir), what).toMatchObject([
            { state: "applied", entry: expectedEntry(w, a, instance) },
          ]);
          if (before !== null) {
            const kept = readFileSync(file).toString("latin1");
            expect(kept.startsWith(BOM) || !before.toString("latin1").startsWith(BOM), what).toBe(
              true,
            );
            // CRLF stays CRLF.
            if (before.includes("\r\n")) {
              expect(kept.replaceAll("\r\n", "").includes("\n"), what).toBe(false);
            }
          }

          expect(await remove(w, a), what).toMatchObject({ result: "removed", access: "off" });
          expect(bytesOf(file), what).toEqual(before);
          expect(accessOf(w, a, file), what).toBe(false);
          expect(readRecords(w.input.stateDir), what).toEqual([]);
          if (other !== undefined) expect(readFileSync(other, "utf8"), what).toBe(otherText);
        }
      }
    },
    SLOW,
  );

  test(
    "the access is given once the entry is in place, and taken back before the entry comes out",
    async () => {
      for (const a of ADAPTERS) {
        const w = await world();
        const file = a.file(w);
        seed(file, a.format === "json" ? "{}\n" : "");
        const seen: string[] = [];
        const rows = keptRows((verb) => {
          seen.push(
            `${verb} with the entry ${entryIn(a, file) === undefined ? "out of" : "in"} its file`,
          );
        });
        const view = await viewOf(w, a);
        const [item] = planOf(w.input, [view], SPACE);
        expect((await applyHome(w.input, view, SPACE, rows, item?.change)).result).toBe("applied");
        expect(readRecords(w.input.stateDir)).toMatchObject([
          { state: "applied", grant: rows.live[0]?.grant },
        ]);
        expect((await removeHome(w.input, await viewOf(w, a), rows)).result).toBe("removed");
        expect(seen, a.app).toEqual([
          "grant with the entry in its file",
          "revoke with the entry in its file",
        ]);
      }
    },
    SLOW,
  );

  test(
    "a file setup does not accept stays byte for byte, with no record and no access",
    async () => {
      const cases: Readonly<Record<"json" | "toml", readonly string[]>> = {
        json: [
          '{"mcpServers": {}, "mcpServers": {"x": {}}}',
          "{ not json",
          '{"mcpServers": []}',
          '{"a": 1} // note',
        ],
        toml: [
          "a = 1\na = 2\n",
          'mcp_servers = { other = { command = "x" } }\n',
          '[mcp_servers]\nother.command = "x"\n',
        ],
      };
      for (const a of ADAPTERS) {
        for (const text of cases[a.format]) {
          const w = await world();
          const file = a.file(w);
          seed(file, text);
          expect(await apply(w, a), `${a.app}: ${text}`).toMatchObject({ result: "left" });
          expect(readFileSync(file, "utf8")).toBe(text);
          expect(w.rows.asked).toEqual([]);
          expect(existsSync(join(setupDir(w.input.stateDir), SETUP_FILE))).toBe(false);
        }
      }
    },
    SLOW,
  );

  test(
    "an entry the person changed, a comment on it included, loses its access and stays as it is; none of the change is ever taken for setup's",
    async () => {
      const edits: Readonly<
        Record<"json" | "toml", readonly [string, (text: string) => string][]>
      > = {
        json: [
          [
            "an extra field",
            (t) => t.replace(`"args": [`, `"env": {"PERSON": "1"},\n      "args": [`),
          ],
          ["a changed argument", (t) => t.replace('"--app"', '"--app-x"')],
        ],
        toml: [
          ["an extra key", (t) => `${t}tool_timeout_sec = 99\n`],
          [
            "a changed value",
            (t) => t.replace("startup_timeout_sec = 20", "startup_timeout_sec = 45"),
          ],
          [
            "a comment inside its table",
            (t) => t.replace("startup_timeout_sec = 20", "startup_timeout_sec = 20 # slow disk"),
          ],
          [
            "a comment right above its table",
            (t) =>
              t.replace(
                `[mcp_servers.${MCP_SERVER_KEY}]`,
                `# mine now\n[mcp_servers.${MCP_SERVER_KEY}]`,
              ),
          ],
        ],
      };
      for (const a of ADAPTERS) {
        for (const [label, edit] of edits[a.format]) {
          const w = await world();
          const file = a.file(w);
          seed(file, a.format === "json" ? "{}\n" : 'model = "m"\n');
          expect((await apply(w, a)).result).toBe("applied");
          const changed = edit(readFileSync(file, "utf8"));
          expect(changed).not.toBe(readFileSync(file, "utf8"));
          writeFileSync(file, changed);
          expect((await viewOf(w, a)).state, label).toBe("edited");
          expect(await remove(w, a), `${a.app}: ${label}`).toMatchObject({
            result: "left",
            reason: "edited",
            access: "off",
            kept: "edited",
          });
          expect(readFileSync(file, "utf8")).toBe(changed);
          expect(accessOf(w, a, file)).toBe(false);
          expect(readRecords(w.input.stateDir)).toEqual([]);
        }
      }
    },
    SLOW,
  );

  test(
    "a save while setup asks for the access that changes or takes out the entry: setup looks again, takes the access back, and leaves what the save left",
    async () => {
      for (const a of ADAPTERS) {
        for (const save of ["changes the entry", "takes the entry out"] as const) {
          const w = await world();
          const file = a.file(w);
          seed(file, a.format === "json" ? "{}\n" : "");
          const before = readFileSync(file, "utf8");
          let saved = "";
          // Another save lands right after setup checked its entry, before the service answers.
          const rows = keptRows((verb) => {
            if (verb !== "grant") return;
            const text = readFileSync(file, "utf8");
            saved =
              save === "takes the entry out"
                ? before
                : a.format === "json"
                  ? text.replace(`"args": [`, `"env": {"PERSON": "1"},\n      "args": [`)
                  : `${text}tool_timeout_sec = 99\n`;
            writeFileSync(file, saved);
          });
          const view = await viewOf(w, a);
          const [item] = planOf(w.input, [view], SPACE);
          const what = `${a.app}: a save that ${save}`;
          expect(await applyHome(w.input, view, SPACE, rows, item?.change), what).toMatchObject({
            result: "failed",
            reason: "changed_meanwhile",
            access: "off",
          });
          expect(
            rows.asked.map((x) => x.verb),
            what,
          ).toEqual(["grant", "revoke"]);
          expect(rows.live, what).toEqual([]);
          expect(readFileSync(file, "utf8"), what).toBe(saved);
          expect(readRecords(w.input.stateDir), what).toEqual([]);
        }
      }
    },
    SLOW,
  );

  test(
    "giving an intact entry its access back is done once the service confirms it: a save meanwhile stays the person's, a record that cannot be written takes nothing back, and a grant not confirmed leaves the entry",
    async () => {
      for (const a of ADAPTERS) {
        for (const event of [
          "a save before the grant",
          "a save during the grant",
          "the record cannot be written",
          "the service does not confirm the grant",
        ] as const) {
          const what = `${a.app}: ${event}`;
          const w = await world();
          const file = a.file(w);
          seed(file, a.format === "json" ? "{}\n" : 'model = "m"\n');
          let armed = false;
          let saved = "";
          const change = () => {
            const text = readFileSync(file, "utf8");
            saved =
              a.format === "json"
                ? text.replace(`"args": [`, `"env": {"PERSON": "1"},\n      "args": [`)
                : `${text}tool_timeout_sec = 99\n`;
            writeFileSync(file, saved);
          };
          const rows = keptRows((verb) => {
            if (armed && verb === "grant" && event === "a save during the grant") change();
          });
          const first = await viewOf(w, a);
          const [item] = planOf(w.input, [first], SPACE);
          expect((await applyHome(w.input, first, SPACE, rows, item?.change)).result).toBe(
            "applied",
          );
          // The "off until asked" row: registered, and its access gone.
          await rows.revoke(first.home);
          const view = await viewOf(w, a);
          expect(view.state, what).toBe("registered");
          rows.asked.length = 0;
          armed = true;
          if (event === "a save before the grant") change();
          if (event === "the service does not confirm the grant")
            rows.refuse.grant = "grant_failed";
          const withEntry = readFileSync(file);
          const restore =
            event === "the record cannot be written" ? unwritable(recordPath(w)) : null;
          let outcome;
          try {
            outcome = await applyHome(w.input, view, "", rows);
          } finally {
            restore?.();
          }
          expect(
            rows.asked.map((x) => x.verb),
            what,
          ).toEqual(["grant"]);
          if (event === "the service does not confirm the grant") {
            expect(outcome, what).toMatchObject({ result: "failed", reason: "grant_failed" });
            expect(readFileSync(file), what).toEqual(withEntry);
            expect(readRecords(w.input.stateDir), what).toMatchObject([{ state: "applied" }]);
            continue;
          }
          expect(outcome, what).toMatchObject({ result: "unchanged", access: "on" });
          expect(rows.live, what).toHaveLength(1);
          if (event === "the record cannot be written") {
            expect(readFileSync(file), what).toEqual(withEntry);
          } else {
            // The person's save stays, and is theirs from then on.
            expect(readFileSync(file, "utf8"), what).toBe(saved);
          }
        }
      }
    },
    SLOW,
  );

  test(
    "a read that fails once right after the entry is written: access stays off, the record stays to take the entry out, and the next run does",
    async () => {
      for (const a of ADAPTERS) {
        const w = await world();
        const file = a.file(w);
        seed(file, a.format === "json" ? "{}\n" : 'model = "m"\n');
        const before = readFileSync(file);
        const view = await viewOf(w, a);
        const [item] = planOf(w.input, [view], SPACE);
        // A scanner holds the just-written file: the first open after it is in place fails once.
        const outcome = await failingReadAfterWrite(file, () =>
          applyHome(w.input, view, SPACE, w.rows, item?.change),
        );
        expect(outcome, a.app).toMatchObject({
          result: "failed",
          reason: "unreadable",
          access: "off",
          notes: ["undo_failed"],
        });
        expect(w.rows.asked, a.app).toEqual([]);
        expect(readRecords(w.input.stateDir), a.app).toMatchObject([{ state: "removing" }]);
        expect(entryIn(a, file), a.app).toBeDefined();
        // Another app's setup settles it first: the entry comes out, the file is as it was.
        expect(await settleHomes(w.input, w.rows), a.app).toMatchObject([
          { result: "removed", access: "off" },
        ]);
        expect(readFileSync(file), a.app).toEqual(before);
        expect(readRecords(w.input.stateDir), a.app).toEqual([]);
      }
    },
    SLOW,
  );

  test(
    "a file changed since the plan was read is not written, and its newer bytes stay; Claude Code's file takes the entry as it is then",
    async () => {
      for (const a of ADAPTERS) {
        const w = await world();
        const file = a.file(w);
        seed(file, a.format === "json" ? '{"k": 1}\n' : "k = 1\n");
        const view = await viewOf(w, a);
        const [item] = planOf(w.input, [view], SPACE);
        const newer = a.format === "json" ? '{"k": 2}\n' : "k = 2\n";
        writeFileSync(file, newer);
        const outcome = await applyHome(w.input, view, SPACE, w.rows, item?.change);
        if (a.app === "claude-code") {
          // Claude Code rewrites its file while a session runs: the entry joins the newer bytes.
          expect(outcome).toMatchObject({ result: "applied", access: "on" });
          expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ k: 2 });
        } else {
          expect(outcome).toMatchObject({
            result: "failed",
            reason: "changed_meanwhile",
            access: "off",
          });
          expect(readFileSync(file, "utf8")).toBe(newer);
          expect(w.rows.asked).toEqual([]);
          expect(readRecords(w.input.stateDir)).toEqual([]);
        }
      }
    },
    SLOW,
  );

  test(
    "Claude Code: a running session that saves during setup keeps its save, and setup's entry stays",
    async () => {
      const a = ADAPTERS[0] as Adapter;
      // A session holds Claude Code's lock while it saves: setup waits, then the session saves (it
      // reads the file again under its lock), releases the lock, and setup goes on with its bytes.
      let file = "";
      let waited = 0;
      const w = await world(() => {
        waited += 1;
        const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
        writeFileSync(file, JSON.stringify({ ...doc, numStartups: 8 }, null, 2));
        rmSync(`${file}.lock`, { recursive: true });
        return Promise.resolve();
      });
      file = a.file(w);
      seed(
        file,
        JSON.stringify({ numStartups: 7, mcpServers: { other: { command: "o" } } }, null, 2),
      );
      mkdirSync(`${file}.lock`);
      expect(await apply(w, a)).toMatchObject({ result: "applied", access: "on" });
      expect(waited).toBe(1);
      const doc = JSON.parse(readFileSync(file, "utf8")) as {
        numStartups: number;
        mcpServers: Record<string, unknown>;
      };
      expect(doc.numStartups).toBe(8);
      expect(Object.keys(doc.mcpServers)).toEqual(["other", MCP_SERVER_KEY]);
      expect(existsSync(`${file}.lock`)).toBe(false);

      // A session that keeps the lock through every pause: nothing is written, no access is given.
      const held = await world(() => Promise.resolve());
      const heldFile = a.file(held);
      seed(heldFile, "{}\n");
      mkdirSync(`${heldFile}.lock`);
      expect(await apply(held, a)).toMatchObject({
        result: "failed",
        reason: "busy",
        access: "off",
      });
      expect(readFileSync(heldFile, "utf8")).toBe("{}\n");
      expect(held.rows.asked).toEqual([]);
      expect(existsSync(`${heldFile}.lock`)).toBe(true);

      // A lock a session left when it ended (its time not refreshed for longer than Claude Code
      // allows) is taken over, as Claude Code's own writers do.
      const left = await world(() => Promise.resolve());
      const leftFile = a.file(left);
      seed(leftFile, "{}\n");
      mkdirSync(`${leftFile}.lock`);
      const old = new Date(Date.now() - 60_000);
      utimesSync(`${leftFile}.lock`, old, old);
      expect(await apply(left, a)).toMatchObject({ result: "applied" });
      expect(existsSync(`${leftFile}.lock`)).toBe(false);
    },
    SLOW,
  );

  test("a lock that cannot be made where the file is (a folder setup may not write in) is a file that cannot be written: the work does not run", async () => {
    const w = await world();
    // No such folder: making the lock fails as it does in a folder that takes no new entry.
    const file = join(w.input.stateDir, "no-such-folder", ".claude.json");
    let ran = false;
    const outcome = await withAppLock(
      file,
      () => Promise.resolve(),
      () => {
        ran = true;
      },
    );
    expect(outcome).toEqual({ held: false, why: "unwritable" });
    expect(ran).toBe(false);
  });

  test("a lock taken over while setup held it (past its expiry) is the new holder's: setup leaves it", async () => {
    const w = await world();
    const file = join(w.home, ".claude-work", ".claude.json");
    const lock = `${file}.lock`;
    const outcome = await withAppLock(
      file,
      () => Promise.resolve(),
      () => {
        // Another writer found setup's lock stale, removed it and made its own, more than ten
        // seconds after setup made its.
        rmdirSync(lock);
        mkdirSync(lock);
        const later = new Date(Date.now() + 11_000);
        utimesSync(lock, later, later);
        return "done";
      },
    );
    expect(outcome).toEqual({ held: true, value: "done" });
    expect(existsSync(lock)).toBe(true);
  });

  test.skipIf(root)(
    "a file that cannot be written: it is said before the apply, no access is given; turning off takes the access away, and the next setup takes the entry out once",
    async () => {
      for (const a of ADAPTERS) {
        const w = await world();
        const file = a.file(w);
        seed(file, a.format === "json" ? "{}\n" : 'model = "m"\n');
        const before = readFileSync(file);
        const restore = unwritable(file);
        try {
          const view = await viewOf(w, a);
          expect(planOf(w.input, [view], SPACE)[0]?.change, a.app).toBe("read_only");
          expect(await apply(w, a), a.app).toMatchObject({
            result: "left",
            reason: "read_only",
            access: "off",
          });
        } finally {
          restore();
        }
        expect(readFileSync(file)).toEqual(before);
        expect(readdirSync(dirname(file)).filter((n) => n !== basename(file))).toEqual([]);
        expect(w.rows.asked).toEqual([]);
        expect(readRecords(w.input.stateDir)).toEqual([]);

        expect((await apply(w, a)).result).toBe("applied");
        const again = unwritable(file);
        try {
          expect(await remove(w, a), a.app).toMatchObject({
            result: "failed",
            reason: "unwritable",
            access: "off",
            kept: "own",
          });
        } finally {
          again();
        }
        expect(accessOf(w, a, file)).toBe(false);
        expect((await viewOf(w, a)).state).toBe("interrupted");
        expect(await settleHomes(w.input, w.rows)).toMatchObject([
          { result: "removed", access: "off" },
        ]);
        expect(readFileSync(file)).toEqual(before);
        expect(await settleHomes(w.input, w.rows)).toEqual([]);
      }
    },
    SLOW,
  );

  test(
    "a run that ended midway is settled once by the next setup, always as a removal: a later run never gives access",
    async () => {
      for (const a of ADAPTERS) {
        const w = await world();
        const file = a.file(w);
        seed(file, a.format === "json" ? "{}\n" : 'model = "m"\n');
        const before = readFileSync(file);
        expect((await apply(w, a)).result).toBe("applied");
        const [record] = readRecords(w.input.stateDir);
        if (record === undefined) throw new Error("no record");
        const withEntry = readFileSync(file);

        // Ended after the entry was written, before its access, and after its access, before the
        // record said so, in an apply that asked for the access: the entry comes out and the access
        // is off. The person turns it on again.
        for (const granted of [false, true]) {
          writeFileSync(file, withEntry);
          await w.rows.revoke((await viewOf(w, a)).home);
          if (granted) await w.rows.grant((await viewOf(w, a)).home, SPACE);
          writeRecords(w.input.stateDir, [
            { ...record, state: "applying", gives_access: true, grant: null },
          ]);
          const asked = w.rows.asked.length;
          expect(await settleHomes(w.input, w.rows), a.app).toMatchObject([
            { result: "removed", access: "off" },
          ]);
          expect(w.rows.asked.slice(asked).map((x) => x.verb)).toEqual(["revoke"]);
          expect(accessOf(w, a, file)).toBe(false);
          expect(readFileSync(file)).toEqual(before);
          expect(readRecords(w.input.stateDir)).toEqual([]);
          expect(await settleHomes(w.input, w.rows)).toEqual([]);
        }

        // The same in an apply that found the access live and did not ask for it: the entry comes
        // out, and the access it did not give stays.
        writeFileSync(file, withEntry);
        await w.rows.grant((await viewOf(w, a)).home, SPACE);
        writeRecords(w.input.stateDir, [{ ...record, state: "applying", grant: null }]);
        const asked = w.rows.asked.length;
        expect(await settleHomes(w.input, w.rows), a.app).toMatchObject([
          { result: "removed", access: "on" },
        ]);
        expect(w.rows.asked.slice(asked), a.app).toEqual([]);
        expect(readFileSync(file)).toEqual(before);
        await w.rows.revoke((await viewOf(w, a)).home);

        // Ended after its record, before the entry was written: nothing to finish.
        writeFileSync(file, before);
        await w.rows.revoke((await viewOf(w, a)).home);
        writeRecords(w.input.stateDir, [{ ...record, state: "applying", grant: null }]);
        expect(await settleHomes(w.input, w.rows), a.app).toMatchObject([
          { result: "removed", access: "off" },
        ]);
        expect(readRecords(w.input.stateDir)).toEqual([]);
        expect(readFileSync(file)).toEqual(before);

        // Ended while turning off, after the access went: the entry comes out.
        writeFileSync(file, withEntry);
        writeRecords(w.input.stateDir, [{ ...record, state: "removing" }]);
        expect(await settleHomes(w.input, w.rows), a.app).toMatchObject([
          { result: "removed", access: "off" },
        ]);
        expect(readFileSync(file)).toEqual(before);
        expect(accessOf(w, a, file)).toBe(false);
      }
    },
    SLOW,
  );

  test(
    "a refused row takes the entry back",
    async () => {
      for (const a of ADAPTERS) {
        const w = await world();
        const file = a.file(w);
        seed(file, a.format === "json" ? "{}\n" : 'model = "m"\n');
        const before = readFileSync(file);
        w.rows.refuse.grant = "instance_taken";
        // The outcome says what the cleanup did: the entry was taken out again.
        expect(await apply(w, a), a.app).toMatchObject({
          result: "failed",
          reason: "instance_taken",
          access: "off",
          notes: ["undone"],
        });
        expect(readFileSync(file)).toEqual(before);
        expect(readRecords(w.input.stateDir)).toEqual([]);
      }
    },
    SLOW,
  );

  test(
    "a refused row whose revoke fails too: the entry stays until a revoke is confirmed, the access is said as not confirmed, and the next run takes both out",
    async () => {
      for (const a of ADAPTERS) {
        const w = await world();
        const file = a.file(w);
        seed(file, a.format === "json" ? "{}\n" : 'model = "m"\n');
        const before = readFileSync(file);
        // The service is gone once it refused the row: it confirms nothing after that.
        w.rows.refuse = { grant: "grant_failed", revoke: true };
        const view = await viewOf(w, a);
        const [item] = planOf(w.input, [view], SPACE);
        const rows: Access = {
          read: (home) => w.rows.read(home),
          revoke: (home) => w.rows.revoke(home),
          grant: (home, space) => {
            w.rows.refuse.read = true;
            return w.rows.grant(home, space);
          },
        };
        // Nothing claims the entry went: it stays, and the outcome says so.
        expect(await applyHome(w.input, view, SPACE, rows, item?.change), a.app).toMatchObject({
          result: "failed",
          reason: "grant_failed",
          access: "unknown",
          notes: ["undo_failed"],
        });
        expect(entryIn(a, file), a.app).toBeDefined();
        expect(readRecords(w.input.stateDir), a.app).toMatchObject([{ state: "removing" }]);
        w.rows.refuse = {};
        expect(await settleHomes(w.input, w.rows), a.app).toMatchObject([
          { result: "removed", access: "off" },
        ]);
        expect(readFileSync(file), a.app).toEqual(before);
        expect(readRecords(w.input.stateDir), a.app).toEqual([]);
      }
    },
    SLOW,
  );

  test(
    "a refused row whose undo cannot write the file: the record says it is being taken back, and no later run gives the home access",
    async () => {
      for (const a of ADAPTERS) {
        const w = await world();
        const file = a.file(w);
        seed(file, a.format === "json" ? "{}\n" : 'model = "m"\n');
        const before = readFileSync(file);
        let restore = (): void => undefined;
        // The file becomes one setup cannot write right as the service refuses the row.
        const rows = keptRows((verb) => {
          if (verb === "grant") restore = unwritable(file);
        });
        rows.refuse.grant = "grant_failed";
        const view = await viewOf(w, a);
        const [item] = planOf(w.input, [view], SPACE);
        try {
          expect(await applyHome(w.input, view, SPACE, rows, item?.change), a.app).toMatchObject({
            result: "failed",
            reason: "grant_failed",
            access: "off",
          });
          expect(readRecords(w.input.stateDir), a.app).toMatchObject([{ state: "removing" }]);
          // The next run, which may be another app's: it takes the access back, never gives it.
          rows.refuse = {};
          const asked = rows.asked.length;
          await settleHomes(w.input, rows);
          expect(
            rows.asked.slice(asked).map((x) => x.verb),
            a.app,
          ).toEqual(["revoke"]);
          expect(rows.live, a.app).toEqual([]);
        } finally {
          restore();
        }
        expect(await settleHomes(w.input, rows), a.app).toMatchObject([
          { result: "removed", access: "off" },
        ]);
        expect(readFileSync(file)).toEqual(before);
        expect(readRecords(w.input.stateDir)).toEqual([]);
        expect(rows.asked.filter((x) => x.verb === "grant")).toHaveLength(1);
      }
    },
    SLOW,
  );

  test(
    "turning off asks for the revoke first and alone: one that fails changes nothing and says the access could not be confirmed off; a record that cannot be written never stops it",
    async () => {
      for (const a of ADAPTERS) {
        const w = await world();
        const file = a.file(w);
        seed(file, a.format === "json" ? "{}\n" : 'model = "m"\n');
        const before = readFileSync(file);
        expect((await apply(w, a)).result).toBe("applied");
        const withEntry = readFileSync(file);
        const recorded = readFileSync(recordPath(w));

        w.rows.refuse.revoke = true;
        expect(await remove(w, a), a.app).toMatchObject({
          result: "failed",
          reason: "revoke_failed",
          access: "unknown",
        });
        expect(readFileSync(file)).toEqual(withEntry);
        expect(readFileSync(recordPath(w))).toEqual(recorded);
        expect(accessOf(w, a, file)).toBe(true);
        w.rows.refuse = {};
        // Nothing is left for a later run: the home is as it was, on.
        expect(await settleHomes(w.input, w.rows)).toEqual([]);
        expect(accessOf(w, a, file)).toBe(true);

        // Setup's own record cannot be written (a full disk): the access goes all the same.
        const restore = unwritable(recordPath(w));
        try {
          expect(await remove(w, a), a.app).toMatchObject({
            result: "failed",
            reason: "state_unwritable",
            access: "off",
            kept: "own",
          });
        } finally {
          restore();
        }
        expect(w.rows.asked.at(-1)).toMatchObject({ verb: "revoke" });
        expect(accessOf(w, a, file)).toBe(false);
        expect(readFileSync(file)).toEqual(withEntry);
        expect(await remove(w, a), a.app).toMatchObject({ result: "removed", access: "off" });
        expect(readFileSync(file)).toEqual(before);
        expect(readRecords(w.input.stateDir)).toEqual([]);
      }
    },
    SLOW,
  );

  test(
    "a home whose folder is gone: no file is no entry, so turning off is done and the record goes",
    async () => {
      for (const a of ADAPTERS) {
        const w = await world();
        const file = a.file(w);
        seed(file, a.format === "json" ? "{}\n" : 'model = "m"\n');
        expect((await apply(w, a)).result).toBe("applied");
        const [record] = readRecords(w.input.stateDir);
        if (record === undefined) throw new Error("no record");
        const folder = dirname(file);
        renameSync(folder, `${folder}-moved`);
        expect(await remove(w, a), a.app).toMatchObject({ result: "removed", access: "off" });
        expect(accessOf(w, a, file)).toBe(false);
        expect(readRecords(w.input.stateDir)).toEqual([]);
        // A removal an earlier run left for such a home is done too, once.
        writeRecords(w.input.stateDir, [{ ...record, state: "removing" }]);
        expect(await settleHomes(w.input, w.rows), a.app).toMatchObject([
          { result: "removed", access: "off" },
        ]);
        expect(readRecords(w.input.stateDir)).toEqual([]);
        expect(await settleHomes(w.input, w.rows)).toEqual([]);
      }
    },
    SLOW,
  );

  test(
    "a new file is never left half written: a short write on a full disk, or a failed flush, leaves no file; one that appeared meanwhile is never replaced",
    async () => {
      for (const a of ADAPTERS.filter((x) => x.needsFile !== true)) {
        for (const label of ["a short write, then a full disk", "a failed flush"] as const) {
          const w = await world();
          const file = a.file(w);
          const what = `${a.app}: ${label}`;
          let writes = 0;
          const outcome = await faulty(
            file,
            label === "a failed flush"
              ? { sync: true }
              : {
                  write: (write, fd, bytes, offset) => {
                    writes += 1;
                    if (writes === 1) return write(fd, bytes, offset, 4);
                    throw Object.assign(new Error("no space"), { code: "ENOSPC" });
                  },
                },
            () => apply(w, a),
          );
          expect(outcome, what).toMatchObject({ result: "failed", access: "off" });
          expect(existsSync(file), what).toBe(false);
          expect(readdirSync(dirname(file)), what).toEqual([]);
          expect(readRecords(w.input.stateDir), what).toEqual([]);
          expect(w.rows.asked, what).toEqual([]);
        }
        {
          // Another program makes the file while setup writes its own.
          const w = await world();
          const file = a.file(w);
          const theirs = a.format === "json" ? '{"theirs": 1}\n' : "theirs = 1\n";
          let made = false;
          const outcome = await faulty(
            file,
            {
              write: (write, fd, ...rest) => {
                if (!made) {
                  made = true;
                  writeFileSync(file, theirs);
                }
                return write(fd, ...rest);
              },
            },
            () => apply(w, a),
          );
          if (a.app === "claude-code") {
            // Claude Code's file is the app's own state: the entry joins it as it is then.
            expect(outcome).toMatchObject({ result: "applied" });
            expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ theirs: 1 });
          } else {
            expect(outcome).toMatchObject({ result: "failed", reason: "changed_meanwhile" });
            expect(readFileSync(file, "utf8")).toBe(theirs);
          }
        }
      }
    },
    SLOW,
  );

  test(
    "setup's own record unreadable: each home with access is turned off by its live row, nothing is turned on, and the record and the files stay as they are",
    async () => {
      for (const a of ADAPTERS) {
        const w = await world();
        const file = a.file(w);
        seed(file, a.format === "json" ? "{}\n" : 'model = "m"\n');
        expect((await apply(w, a)).result, a.app).toBe("applied");
        const selected = (await viewOf(w, a)).home;
        const damaged = Buffer.from('{"format": 2, "homes": [');
        writeFileSync(recordPath(w), damaged);
        const before = readFileSync(file);
        // A home that only the service's row still names, as after its folder was renamed.
        const gone = join(w.home, ".codex-gone");
        await w.rows.grant(
          { ...selected, app: "codex", home: gone, instance: "codex-gone" },
          SPACE,
        );
        const input: SetupInput = {
          ...w.input,
          rows: w.rows.live.map(({ app, home, instance }) => ({ app, home, instance })),
        };
        expect(await settleHomes(input, w.rows)).toEqual([]);
        const views = await survey(input);
        for (const v of views) {
          expect(v, a.app).toMatchObject({ state: "refused", refusal: "record_unreadable" });
        }
        const view = views.find((v) => v.home.app === a.app && v.home.home === selected.home);
        const rowOnly = views.find((v) => v.home.home === gone);
        if (view === undefined || rowOnly === undefined) throw new Error(`no ${a.app} home`);
        // Nothing is turned on.
        expect(planOf(input, [view], SPACE)[0]?.change, a.app).toBeUndefined();
        expect(await applyHome(input, view, SPACE, w.rows), a.app).toMatchObject({
          result: "left",
          reason: "record_unreadable",
        });
        for (const v of [view, rowOnly]) {
          expect(await removeHome(input, v, w.rows), a.app).toMatchObject({
            result: "left",
            reason: "record_unreadable",
            access: "off",
          });
        }
        expect(w.rows.live, a.app).toEqual([]);
        expect(readFileSync(file), a.app).toEqual(before);
        expect(readFileSync(recordPath(w)), a.app).toEqual(damaged);
      }
    },
    SLOW,
  );

  test(
    "on a volume without hard links (FAT, exFAT, a share) setup still creates a missing file whole, and removes it again",
    async () => {
      const real = fs.linkSync;
      // Windows' FAT driver as Node reports it, then Linux's.
      for (const code of ["EISDIR", "EPERM"]) {
        fs.linkSync = () => {
          throw Object.assign(new Error("no link"), { code });
        };
        syncBuiltinESMExports();
        try {
          for (const a of ADAPTERS.filter((x) => x.needsFile !== true)) {
            const w = await world();
            const file = a.file(w);
            const what = `${a.app}: ${code}`;
            expect(await apply(w, a), what).toMatchObject({ result: "applied", access: "on" });
            expect(readdirSync(dirname(file)), what).toEqual([basename(file)]);
            expect(accessOf(w, a, file), what).toBe(true);
            expect(await remove(w, a), what).toMatchObject({ result: "removed", access: "off" });
            expect(existsSync(file), what).toBe(false);
          }
        } finally {
          fs.linkSync = real;
          syncBuiltinESMExports();
        }
      }
    },
    SLOW,
  );

  test(
    "the bytes around the entry: after a removal every line the person wrote is a line of its own, with the bytes they gave it",
    async () => {
      const toml: readonly [string, string, (text: string) => string, string][] = [
        [
          "a table appended after the entry, no final newline before",
          'model="m"',
          (t) => `${t}[mcp_servers.x]\ncommand = "x"\n`,
          'model="m"\n[mcp_servers.x]\ncommand = "x"\n',
        ],
        [
          "a comment appended after the entry, no final newline before",
          'model="m"',
          (t) => `${t}# mine\n`,
          'model="m"\n# mine\n',
        ],
        [
          "a comment appended without a newline, after a comment without one",
          "# c",
          (t) => `${t}# mine`,
          "# c\n# mine",
        ],
        [
          "a table appended after the entry",
          'model="m"\n',
          (t) => `${t}[mcp_servers.x]\ncommand = "x"\n`,
          'model="m"\n[mcp_servers.x]\ncommand = "x"\n',
        ],
        [
          "a table inserted right before the entry",
          'model="m"\n',
          (t) =>
            t.replace(
              `[mcp_servers.${MCP_SERVER_KEY}]`,
              `[mcp_servers.y]\ncommand = "y"\n[mcp_servers.${MCP_SERVER_KEY}]`,
            ),
          'model="m"\n\n[mcp_servers.y]\ncommand = "y"\n',
        ],
        [
          "a table inserted right before the entry, no final newline before",
          'model="m"',
          (t) =>
            t.replace(
              `[mcp_servers.${MCP_SERVER_KEY}]`,
              `[mcp_servers.y]\ncommand = "y"\n[mcp_servers.${MCP_SERVER_KEY}]`,
            ),
          'model="m"\n\n[mcp_servers.y]\ncommand = "y"\n',
        ],
        [
          "a table ending in a blank line inserted right before the entry, no final newline before",
          'model="m"',
          (t) =>
            t.replace(
              `[mcp_servers.${MCP_SERVER_KEY}]`,
              `[mcp_servers.y]\ncommand = "y"\n\n[mcp_servers.${MCP_SERVER_KEY}]`,
            ),
          'model="m"\n\n[mcp_servers.y]\ncommand = "y"\n',
        ],
        [
          "CRLF, a table appended after the entry, no final newline before",
          'model="m"\r\nx = 1',
          (t) => `${t}[mcp_servers.x]\r\ncommand = "x"\r\n`,
          'model="m"\r\nx = 1\r\n[mcp_servers.x]\r\ncommand = "x"\r\n',
        ],
      ];
      const json: readonly [string, string, (text: string) => string, string][] = [
        [
          "a server added after the entry",
          '{\n  "theme": "dark"\n}',
          (t) => t.replace(/\n {2}\}\n\}$/u, ',\n    "x": {"command": "x"}\n  }\n}'),
          '{\n  "theme": "dark",\n  "mcpServers": {\n    "x": {"command": "x"}\n  }\n}',
        ],
        [
          "a server inserted before the entry",
          '{\n  "theme": "dark"\n}',
          (t) => t.replace('"mcpServers": {', '"mcpServers": {\n    "y": {"command": "y"},'),
          '{\n  "theme": "dark",\n  "mcpServers": {\n    "y": {"command": "y"}\n  }\n}',
        ],
        [
          "the entry no longer last in the file",
          '{\n  "theme": "dark"\n}',
          (t) => t.replace(/\n\}$/u, ',\n  "later": 1\n}'),
          '{\n  "theme": "dark",\n  "later": 1\n}',
        ],
      ];
      for (const a of ADAPTERS) {
        for (const [label, start, edit, expected] of a.format === "toml" ? toml : json) {
          const w = await world();
          const file = a.file(w);
          seed(file, start);
          const what = `${a.app}: ${label}`;
          expect((await apply(w, a)).result, what).toBe("applied");
          writeFileSync(file, edit(readFileSync(file, "utf8")));
          expect(await remove(w, a), what).toMatchObject({ result: "removed", access: "off" });
          expect(readFileSync(file, "utf8"), what).toBe(expected);
          expect(readRecords(w.input.stateDir), what).toEqual([]);
        }
      }
    },
    SLOW,
  );

  test(
    "a record setup could not read back is never written: a servers object with millions of line breaks is left alone",
    async () => {
      for (const a of ADAPTERS.filter((x) => x.format === "json")) {
        const w = await world();
        const file = a.file(w);
        const text = `{"mcpServers": {${"\n".repeat(2_200_000)}}}`;
        seed(file, text);
        expect(await apply(w, a), a.app).toMatchObject({
          result: "left",
          reason: "unsupported_layout",
        });
        expect(readFileSync(file, "utf8") === text).toBe(true);
        expect(w.rows.asked).toEqual([]);
        expect(readRecords(w.input.stateDir)).toEqual([]);
      }
    },
    SLOW,
  );

  test(
    "an earlier build's records: an intact entry comes out, one with a field it took for its own stays and loses its access, and an apply it left midway is undone",
    async () => {
      for (const a of ADAPTERS) {
        const w = await world();
        const file = a.file(w);
        const instance = (await viewOf(w, a)).home.instance;
        const argv = [
          w.input.tasks,
          "mcp",
          "--space",
          SPACE,
          "--instance",
          instance,
          "--app",
          a.app,
        ];
        const ran = { command: argv[0], args: argv.slice(1) };
        // The entry as that build's writers left it: Claude Code's own `mcp add` added `type` and
        // an empty `env`; Codex's wrote the table, then that build its two keys.
        const left =
          a.app === "claude-code"
            ? { type: "stdio", ...ran, env: {} }
            : a.app === "codex"
              ? { ...ran, env_vars: [envVar("TICKET")], startup_timeout_sec: 20 }
              : ran;
        const bare = a.format === "json" ? '{\n  "theme": "dark"\n}\n' : 'model = "m"\n';
        const withEntry =
          a.format === "json"
            ? `${JSON.stringify({ theme: "dark", mcpServers: { [MCP_SERVER_KEY]: left } }, null, 2)}\n`
            : `model = "m"\n\n[mcp_servers.${MCP_SERVER_KEY}]\ncommand = ${JSON.stringify(argv[0])}\nargs = [${argv
                .slice(1)
                .map((s) => JSON.stringify(s))
                .join(", ")}]\nenv_vars = ["${envVar("TICKET")}"]\nstartup_timeout_sec = 20\n`;
        const v1 = (over: Record<string, unknown>) => ({
          app: a.app,
          home: a.folder === undefined ? w.desktop : join(w.home, a.folder),
          file,
          is_default: a.app === "claude-desktop",
          instance,
          account: "",
          space: SPACE,
          state: "applied",
          file_existed: true,
          parent_existed: false,
          sha256_before: null,
          sha256_after: null,
          args: [],
          undo: [],
          entry_argv: argv,
          env: {},
          entry: left,
          patches: [],
          grant: null,
          at: "2026-11-01T00:00:00.000Z",
          ...over,
        });
        const writeV1 = (record: Record<string, unknown>) => {
          mkdirSync(setupDir(w.input.stateDir), { recursive: true });
          writeFileSync(
            join(setupDir(w.input.stateDir), SETUP_FILE),
            JSON.stringify({ format: 1, homes: [record] }),
          );
        };

        // Intact: it comes out, with the servers' table that build made.
        writeFileSync(file, withEntry);
        writeV1(v1({}));
        expect((await viewOf(w, a)).state, a.app).toBe("registered");
        expect(await remove(w, a), a.app).toMatchObject({ result: "removed", access: "off" });
        const after = readFileSync(file, "utf8");
        expect(a.format === "json" ? JSON.parse(after) : after, a.app).toEqual(
          a.format === "json" ? { theme: "dark" } : bare,
        );

        // A field that build read back and took for its own: the entry stays, its access goes.
        const adopted = { ...left, env: { PERSON: "1" } };
        if (a.format === "json") {
          writeFileSync(
            file,
            `${JSON.stringify({ theme: "dark", mcpServers: { [MCP_SERVER_KEY]: adopted } }, null, 2)}\n`,
          );
        } else {
          writeFileSync(file, `${withEntry}tool_timeout_sec = 99\n`);
        }
        const kept = readFileSync(file, "utf8");
        writeV1(v1({ entry: a.format === "json" ? adopted : { ...left, tool_timeout_sec: 99 } }));
        await w.rows.grant((await viewOf(w, a)).home, SPACE);
        expect(await remove(w, a), a.app).toMatchObject({
          result: "left",
          reason: "edited",
          access: "off",
        });
        expect(readFileSync(file, "utf8")).toBe(kept);
        expect(accessOf(w, a, file)).toBe(false);

        // An apply that build left while Codex's own command ran: the table without its two keys.
        if (a.app === "codex") {
          writeFileSync(
            file,
            `model = "m"\n\n[mcp_servers.${MCP_SERVER_KEY}]\ncommand = ${JSON.stringify(argv[0])}\nargs = [${argv
              .slice(1)
              .map((s) => JSON.stringify(s))
              .join(", ")}]\n`,
          );
          writeV1(v1({ state: "applying", entry: null }));
          expect(await settleHomes(w.input, w.rows)).toMatchObject([{ result: "removed" }]);
          expect(readFileSync(file, "utf8")).toBe(bare);
          expect(readRecords(w.input.stateDir)).toEqual([]);
        }
      }
    },
    SLOW,
  );
});

type Write = (fd: number, ...rest: unknown[]) => number;

/**
 * Runs `body` with the file system failing what is written to `file` and to the temporary files
 * beside it: `write` stands in for each of their writes, `sync` fails their flush. Every other
 * file is written as usual.
 */
async function faulty<T>(
  file: string,
  fault: {
    readonly write?: (write: Write, fd: number, ...rest: unknown[]) => number;
    readonly sync?: true;
  },
  body: () => Promise<T>,
): Promise<T> {
  const real = {
    openSync: fs.openSync,
    closeSync: fs.closeSync,
    writeSync: fs.writeSync,
    fsyncSync: fs.fsyncSync,
  };
  const name = basename(file);
  const ours = new Set<number>();
  const write = real.writeSync as Write;
  fs.openSync = (path: fs.PathLike, ...rest: unknown[]) => {
    const fd = (real.openSync as (...args: unknown[]) => number)(path, ...rest);
    const opened = basename(String(path));
    if (opened === name || opened.startsWith(`.${name}.`)) ours.add(fd);
    return fd;
  };
  fs.closeSync = (fd: number) => {
    ours.delete(fd);
    real.closeSync(fd);
  };
  fs.writeSync = (fd: number, ...rest: unknown[]) =>
    ours.has(fd) && fault.write !== undefined
      ? fault.write(write, fd, ...rest)
      : write(fd, ...rest);
  fs.fsyncSync = (fd: number) => {
    if (ours.has(fd) && fault.sync === true) {
      throw Object.assign(new Error("flush failed"), { code: "EIO" });
    }
    real.fsyncSync(fd);
  };
  syncBuiltinESMExports();
  try {
    return await body();
  } finally {
    Object.assign(fs, real);
    syncBuiltinESMExports();
  }
}

/**
 * Runs `body` while the first open of `file` after a new one is renamed or linked into its place
 * fails once with EBUSY, as when a scanner holds a file just written.
 */
async function failingReadAfterWrite<T>(file: string, body: () => Promise<T>): Promise<T> {
  const real = { openSync: fs.openSync, renameSync: fs.renameSync, linkSync: fs.linkSync };
  const name = basename(file);
  let armed = false;
  const placed = (to: fs.PathLike) => {
    if (basename(String(to)) === name) armed = true;
  };
  fs.renameSync = (from: fs.PathLike, to: fs.PathLike) => {
    real.renameSync(from, to);
    placed(to);
  };
  fs.linkSync = (from: fs.PathLike, to: fs.PathLike) => {
    real.linkSync(from, to);
    placed(to);
  };
  fs.openSync = (path: fs.PathLike, ...rest: unknown[]) => {
    if (armed && basename(String(path)) === name) {
      armed = false;
      throw Object.assign(new Error("held by a scanner"), { code: "EBUSY" });
    }
    return (real.openSync as (...args: unknown[]) => number)(path, ...rest);
  };
  syncBuiltinESMExports();
  try {
    return await body();
  } finally {
    Object.assign(fs, real);
    syncBuiltinESMExports();
  }
}

/** Makes the file one the OS will not let setup replace, and gives back how to undo that. */
function unwritable(file: string): () => void {
  // Windows refuses to replace a read-only file; elsewhere the folder decides.
  const target = windows ? file : dirname(file);
  const mode = statSync(target).mode & 0o777;
  chmodSync(target, windows ? 0o444 : 0o555);
  return () => {
    chmodSync(target, mode);
  };
}

// ---------------------------------------------------------------------------------------------
// A home with two settings files: Claude Code's default folder, read as `~/.claude.json` when
// Claude Code starts plainly and as `~/.claude/.claude.json` when it starts with its home set to
// the folder (as T3 Code may start it).

const CLAUDE = ADAPTERS[0] as Adapter;

/** The default folder and its two settings files. */
const twoFiles = (w: World) => ({
  folder: join(w.home, ".claude"),
  plain: join(w.home, ".claude.json"),
  inner: join(w.home, ".claude", ".claude.json"),
});

/** The input with the test's live rows, as the service lists them. */
const live = (w: World, input: SetupInput = w.input): SetupInput => ({
  ...input,
  rows: w.rows.live,
});

/** The default Claude Code home's settings files, the first first, as survey finds them. */
async function filesOf(w: World, input: SetupInput = live(w)): Promise<HomeView[]> {
  return (await survey(input)).filter(
    (v) => v.home.app === "claude-code" && basename(v.home.home) === ".claude",
  );
}

/** Turns the default home on from `space`: each of its files as its answer offers. */
async function turnOn(
  w: World,
  rows: Access = w.rows,
  input: SetupInput = live(w),
  space: string = SPACE,
) {
  return applyFiles(input, planOf(input, await filesOf(w, input), space), space, rows);
}

/** Turns the default home off. */
async function turnOff(w: World, rows: Access = w.rows, input: SetupInput = live(w)) {
  return removeFiles(input, await filesOf(w, input), rows);
}

const furtherRecords = (w: World) => readRecords(w.input.stateDir, FURTHER_FILE);

/** Each of the default home's files with its answer, as the command line's status reads it. */
async function answers(w: World, input: SetupInput = live(w)) {
  return (await filesOf(w, input)).map((v) => ({
    file: v.home.file,
    answer: toolsOf(input, v, ""),
  }));
}

/** A JSON file's servers, read as Claude Code reads them. */
function serversIn(file: string): Record<string, Record<string, unknown>> {
  const doc = JSON.parse(readFileSync(file, "utf8")) as {
    mcpServers?: Record<string, Record<string, unknown>>;
  };
  return doc.mcpServers ?? {};
}

/** Setup's entry in a JSON file, changed by hand: a key of the person's beside setup's. */
function editEntry(file: string): void {
  const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const entry = serversIn(file)[MCP_SERVER_KEY];
  if (entry === undefined) throw new Error(`no entry in ${file}`);
  doc["mcpServers"] = { ...serversIn(file), [MCP_SERVER_KEY]: { ...entry, cwd: dirname(file) } };
  writeFileSync(file, JSON.stringify(doc, null, 2));
}

/** Each record of `file`, in either record file, changed by `change`. */
function rewriteRecord(w: World, file: string, change: (r: HomeRecord) => HomeRecord): void {
  for (const store of [SETUP_FILE, FURTHER_FILE]) {
    const records = readRecords(w.input.stateDir, store);
    writeRecords(
      w.input.stateDir,
      records.map((r) => (r.file === file ? change(r) : r)),
      store,
    );
  }
}

/** The entry in `file` and its record name `command`, as an install elsewhere wrote them. */
function recordedAs(w: World, file: string, command: string): void {
  const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const entry = serversIn(file)[MCP_SERVER_KEY];
  if (entry === undefined) throw new Error(`no entry in ${file}`);
  doc["mcpServers"] = { ...serversIn(file), [MCP_SERVER_KEY]: { ...entry, command } };
  writeFileSync(file, JSON.stringify(doc, null, 2));
  rewriteRecord(w, file, (r) => ({ ...r, entry: { ...r.entry, command } }));
}

/** Runs `body`, doing `act` right after `file` is first put in place by a rename or a link. */
async function afterPlaced<T>(file: string, act: () => void, body: () => Promise<T>): Promise<T> {
  const real = { renameSync: fs.renameSync, linkSync: fs.linkSync };
  let done = false;
  const placed = (to: fs.PathLike) => {
    if (!done && String(to) === file) {
      done = true;
      act();
    }
  };
  fs.renameSync = (from: fs.PathLike, to: fs.PathLike) => {
    real.renameSync(from, to);
    placed(to);
  };
  fs.linkSync = (from: fs.PathLike, to: fs.PathLike) => {
    real.linkSync(from, to);
    placed(to);
  };
  syncBuiltinESMExports();
  try {
    return await body();
  } finally {
    Object.assign(fs, real);
    syncBuiltinESMExports();
  }
}

describe("[A3.3.13.setup.home-files] Each settings file of a home by itself: Claude Code's default folder has one for each way it is started, and the entry goes into each that is there and comes out of each", () => {
  test(
    "both files there: one apply writes the same entry into each and asks for the access once; Off takes the access first, then each entry out byte for byte; each file has its own record, the first where an earlier build reads it",
    async () => {
      const w = await world();
      const { plain, inner } = twoFiles(w);
      seed(plain, '{\n  "numStartups": 3\n}\n');
      seed(inner, '{"theme":"dark"}');
      const before = [bytesOf(plain), bytesOf(inner)];
      expect((await filesOf(w)).map((v) => v.home.file)).toEqual([plain, inner]);
      expect(await turnOn(w)).toMatchObject([
        { result: "applied", access: "on" },
        { result: "applied", access: "on" },
      ]);
      expect(w.rows.asked.map((x) => x.verb)).toEqual(["grant"]);
      const instance = (await filesOf(w))[0]?.home.instance ?? "";
      expect(entryIn(CLAUDE, plain)).toEqual(expectedEntry(w, CLAUDE, instance));
      expect(entryIn(CLAUDE, inner)).toEqual(expectedEntry(w, CLAUDE, instance));
      // One record per file: the first file's in agents.json, as an earlier build reads it.
      const [first] = readRecords(w.input.stateDir);
      expect(readRecords(w.input.stateDir)).toHaveLength(1);
      expect(first).toMatchObject({ file: plain, state: "applied", made: { file: false } });
      expect(first).not.toHaveProperty("gives_access");
      expect(furtherRecords(w)).toMatchObject([
        { file: inner, state: "applied", made: { file: false } },
      ]);
      expect(homeAnswer(await answers(w))).toEqual({ status: "on", files: [], off: true });

      // Off: the access goes before either file changes, then each entry comes out.
      const withEntries = [bytesOf(plain), bytesOf(inner)];
      let atRevoke: (Buffer | null)[] = [];
      const watched = keptRows(() => {
        atRevoke = [bytesOf(plain), bytesOf(inner)];
      });
      watched.live.push(...w.rows.live);
      expect(await turnOff(w, watched)).toMatchObject([
        { result: "removed", access: "off" },
        { result: "removed", access: "off" },
      ]);
      expect(atRevoke).toEqual(withEntries);
      expect(watched.live).toEqual([]);
      expect([bytesOf(plain), bytesOf(inner)]).toEqual(before);
      expect(readRecords(w.input.stateDir)).toEqual([]);
      expect(furtherRecords(w)).toEqual([]);
    },
    SLOW,
  );

  test(
    "a further file counts only while it is there, and setup never creates it: not for a reader T3 starts with its home set to the folder, not when it goes between the survey and the write",
    async () => {
      const w = await world();
      const { folder, plain, inner } = twoFiles(w);
      seed(plain, "{}\n");
      const t3 = join(w.home, ".t3", "userdata");
      mkdirSync(t3, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(t3, "settings.json"),
        JSON.stringify({
          providerInstances: {
            claudeAgent: { driver: "claudeAgent", config: { homePath: folder } },
          },
        }),
        { mode: 0o600 },
      );
      const views = await filesOf(w);
      expect(views.map((v) => v.home.file)).toEqual([plain]);
      expect(views[0]?.home.hosts).toEqual(["t3"]);
      expect(await turnOn(w)).toMatchObject([{ result: "applied", access: "on" }]);
      expect(existsSync(inner)).toBe(false);

      // There when the plan was made, gone when its turn comes.
      const v = await world();
      const two = twoFiles(v);
      seed(two.plain, "{}\n");
      seed(two.inner, "{}\n");
      const input = live(v);
      const items = planOf(input, await filesOf(v, input), SPACE);
      rmSync(two.inner);
      expect(await applyFiles(input, items, SPACE, v.rows)).toMatchObject([
        { result: "applied", access: "on" },
        { result: "failed", reason: "changed_meanwhile", access: "on" },
      ]);
      expect(existsSync(two.inner)).toBe(false);
      expect(furtherRecords(v)).toEqual([]);
    },
    SLOW,
  );

  test(
    "an entry edited by hand in one file never keeps the other from being turned on (188's second review, sequence 2)",
    async () => {
      const w = await world();
      const { plain, inner } = twoFiles(w);
      seed(plain, "{}\n");
      seed(inner, "{}\n");
      await turnOn(w);
      editEntry(inner);
      expect(await turnOff(w)).toMatchObject([
        { result: "removed", access: "off" },
        { result: "left", reason: "edited", kept: "edited", access: "off" },
      ]);
      // The plain file offers its entry again; the edited one is the person's, and is named.
      const after = await answers(w);
      expect(homeAnswer(after)).toEqual({
        status: "off",
        files: [
          { file: plain, on: "add" },
          { file: inner, why: "foreign_entry" },
        ],
        off: false,
      });
      expect(await turnOn(w)).toMatchObject([
        { result: "applied", access: "on" },
        { result: "left", reason: "foreign_entry", access: "on" },
      ]);
      expect(homeAnswer(await answers(w)).status).toBe("on");
    },
    SLOW,
  );

  test.skipIf(root)(
    "a further file that cannot be written is said before the apply, and the other is written and works (188's second review, sequence 4)",
    async () => {
      const w = await world();
      const { plain, inner } = twoFiles(w);
      seed(plain, "{}\n");
      seed(inner, '{"theme":"dark"}\n');
      const restore = unwritable(inner);
      try {
        const input = live(w);
        const items = planOf(input, await filesOf(w, input), SPACE);
        expect(items.map((i) => (typeof i.change === "string" ? i.change : "write"))).toEqual([
          "write",
          "read_only",
        ]);
        expect(await applyFiles(input, items, SPACE, w.rows)).toMatchObject([
          { result: "applied", access: "on" },
          { result: "left", reason: "read_only", access: "on" },
        ]);
      } finally {
        restore();
      }
      expect(readFileSync(inner, "utf8")).toBe('{"theme":"dark"}\n');
      expect(entryIn(CLAUDE, plain)).toBeDefined();
    },
    SLOW,
  );

  test(
    "a file setup cannot read is named each time, and the other is written: the same apply again says the same (188's second review, sequence 3)",
    async () => {
      const w = await world();
      const { plain, inner } = twoFiles(w);
      seed(plain, "{}\n");
      seed(inner, '{"theme": "dark",}\n');
      expect(await turnOn(w)).toMatchObject([
        { result: "applied", access: "on" },
        { result: "left", reason: "invalid_file", access: "on" },
      ]);
      expect(await turnOn(w)).toMatchObject([
        { result: "unchanged", access: "on" },
        { result: "left", reason: "invalid_file", access: "on" },
      ]);
      expect(homeAnswer(await answers(w))).toEqual({
        status: "on",
        files: [{ file: inner, why: "invalid_file" }],
        off: true,
      });
    },
    SLOW,
  );

  test(
    "Off names an entry of setup's name that it has no record of, and leaves it (188's second review, sequence 8)",
    async () => {
      const w = await world();
      const { plain, inner } = twoFiles(w);
      seed(plain, "{}\n");
      await turnOn(w);
      seed(
        inner,
        JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: entryIn(CLAUDE, plain) } }, null, 2),
      );
      const copied = bytesOf(inner);
      expect((await answers(w))[1]?.answer.why).toBe("foreign_entry");
      expect(await turnOff(w)).toMatchObject([
        { result: "removed", access: "off" },
        { result: "left", reason: "foreign_entry", kept: "unrecorded", access: "off" },
      ]);
      expect(bytesOf(inner)).toEqual(copied);
      expect(w.rows.live).toEqual([]);
    },
    SLOW,
  );

  test(
    "cannot happen: a hand edit of a working file while another is added takes the access, or a change of the other during a repair takes the repaired entry (188's second review, sequence 5)",
    async () => {
      let onWait = (): void => undefined;
      const w = await world(() => {
        onWait();
        return Promise.resolve();
      });
      const { plain, inner } = twoFiles(w);
      seed(plain, "{}\n");
      await turnOn(w);
      seed(inner, "{}\n");
      // Claude Code holds the inner file's lock; while setup waits, the person edits the plain
      // entry, then the lock goes.
      mkdirSync(`${inner}.lock`);
      onWait = () => {
        editEntry(plain);
        rmdirSync(`${inner}.lock`);
        onWait = () => undefined;
      };
      w.rows.asked.length = 0;
      expect(await turnOn(w)).toMatchObject([
        { result: "unchanged", access: "on" },
        { result: "applied", access: "on" },
      ]);
      expect(w.rows.asked).toEqual([]);
      expect(w.rows.live).toHaveLength(1);
      expect(serversIn(plain)[MCP_SERVER_KEY]).toMatchObject({ cwd: dirname(plain) });

      // Both entries run where TTasks was before; while the inner one waits for its lock during
      // the repair, another server is added there.
      const v = await world(() => {
        onWait();
        return Promise.resolve();
      });
      const two = twoFiles(v);
      seed(two.plain, "{}\n");
      seed(two.inner, "{}\n");
      await turnOn(v);
      const gone = join(v.dir, "before", basename(v.input.tasks));
      recordedAs(v, two.plain, gone);
      recordedAs(v, two.inner, gone);
      mkdirSync(`${two.inner}.lock`);
      onWait = () => {
        const doc = JSON.parse(readFileSync(two.inner, "utf8")) as Record<string, unknown>;
        doc["mcpServers"] = { ...serversIn(two.inner), other: { command: "x" } };
        writeFileSync(two.inner, JSON.stringify(doc, null, 2));
        rmdirSync(`${two.inner}.lock`);
        onWait = () => undefined;
      };
      v.rows.asked.length = 0;
      expect(await turnOn(v)).toMatchObject([
        { result: "applied", access: "on" },
        { result: "failed", reason: "changed_meanwhile", access: "on" },
      ]);
      expect(v.rows.asked).toEqual([]);
      expect(serversIn(two.plain)[MCP_SERVER_KEY]).toMatchObject({ command: v.input.tasks });
      expect(serversIn(two.inner)[MCP_SERVER_KEY]).toMatchObject({ command: gone });
      expect(serversIn(two.inner)["other"]).toEqual({ command: "x" });
    },
    SLOW,
  );

  test(
    "cannot happen: a failed add says the access is off while its row is live (188's second review, sequence 6)",
    async () => {
      const w = await world();
      const { plain } = twoFiles(w);
      seed(plain, "{}\n");
      await turnOn(w);
      // The record is lost and the entry gone: the row is live with no entry, and Add is offered.
      rmSync(recordPath(w));
      seed(plain, "{}\n");
      const [view] = await filesOf(w);
      if (view === undefined) throw new Error("no default home");
      expect(toolsOf(live(w), view, "")).toMatchObject({ why: "missing", on: "add" });
      w.rows.asked.length = 0;
      // A change right after the write, before setup reads its entry back.
      const out = await afterPlaced(
        plain,
        () => {
          editEntry(plain);
        },
        () => turnOn(w),
      );
      expect(out).toMatchObject([
        { result: "failed", reason: "changed_meanwhile", access: "on", notes: ["entry_left"] },
      ]);
      expect(w.rows.asked).toEqual([]);
      expect(w.rows.live).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "cannot happen: two files run different installs and nothing says so (188's second review, sequence 7): an older install still there is offered a repair, and a repair that cannot write keeps the entry that works",
    async () => {
      const w = await world();
      const { plain, inner } = twoFiles(w);
      seed(plain, "{}\n");
      seed(inner, "{}\n");
      await turnOn(w);
      const older = join(w.dir, "older", basename(w.input.tasks));
      mkdirSync(dirname(older), { recursive: true });
      writeFileSync(older, "");
      recordedAs(w, plain, older);
      const before = await answers(w);
      expect(before[0]?.answer).toEqual({ status: "on", why: "older", on: "repair", off: true });
      expect(before[1]?.answer).toEqual({ status: "on", off: true });
      expect(homeAnswer(before).files).toEqual([{ file: plain, why: "older", on: "repair" }]);
      // A write that fails keeps the entry as it was, and its record.
      const kept = bytesOf(plain);
      const failed = await faulty(plain, { sync: true }, () => turnOn(w));
      expect(failed[0]).toMatchObject({ result: "failed", reason: "unwritable", access: "on" });
      expect(bytesOf(plain)).toEqual(kept);
      expect((await answers(w))[0]?.answer.why).toBe("older");
      w.rows.asked.length = 0;
      expect(await turnOn(w)).toMatchObject([
        { result: "applied", access: "on" },
        { result: "unchanged", access: "on" },
      ]);
      expect(w.rows.asked).toEqual([]);
      expect(entryIn(CLAUDE, plain)).toEqual(entryIn(CLAUDE, inner));
    },
    SLOW,
  );

  test(
    "agents-further.json that cannot be read concerns only the home that can have a further file: its first file works, the other is named and untouched, Off still revokes; every other home works",
    async () => {
      const w = await world();
      const { plain, inner } = twoFiles(w);
      seed(plain, "{}\n");
      seed(inner, "{}\n");
      await turnOn(w);
      const codex = ADAPTERS[1] as Adapter;
      seed(codex.file(w), 'model = "m"\n');
      writeFileSync(join(setupDir(w.input.stateDir), FURTHER_FILE), '{"format": 2, "homes": [');
      const innerBytes = bytesOf(inner);
      const views = await filesOf(w);
      expect(views.map((v) => [v.state, v.refusal])).toEqual([
        ["registered", undefined],
        ["refused", "record_unreadable"],
      ]);
      expect(await apply(w, codex)).toMatchObject({ result: "applied", access: "on" });
      expect(await turnOff(w)).toMatchObject([
        { result: "removed", access: "off" },
        { result: "left", reason: "record_unreadable", access: "off" },
      ]);
      expect(bytesOf(inner)).toEqual(innerBytes);
      expect(accessOf(w, codex, codex.file(w))).toBe(true);
    },
    SLOW,
  );

  test(
    "the home's space and instance are its live row's: a file whose record names another instance is not counted as on, and Off cleans it",
    async () => {
      const w = await world();
      const { plain, inner } = twoFiles(w);
      seed(plain, "{}\n");
      seed(inner, "{}\n");
      await turnOn(w);
      rewriteRecord(w, inner, (r) => ({ ...r, instance: "claude-before" }));
      const seen = await answers(w);
      expect(seen[1]?.answer).toEqual({ status: "off", why: "unbound", off: true });
      expect(homeAnswer(seen).status).toBe("on");
      // Nothing to turn on: the row is renewed for the home's own instance, never the record's.
      expect(await turnOn(w)).toMatchObject([
        { result: "unchanged", access: "on" },
        { result: "left", reason: "unbound", access: "on" },
      ]);
      expect(w.rows.live.map((r) => r.instance)).toEqual([(await filesOf(w))[0]?.home.instance]);
      expect(await turnOff(w)).toMatchObject([{ result: "removed" }, { result: "removed" }]);
    },
    SLOW,
  );
});

describe("[A3.3.13.setup.access-rule] Only the apply that finds a home's access off asks for it, and only that apply takes it back; with the service silent nothing is given or taken", () => {
  test(
    "adding a file to a home that has its grant asks the service for nothing: no grant, no renewal, no revoke",
    async () => {
      const w = await world();
      const { plain, inner } = twoFiles(w);
      seed(plain, "{}\n");
      await turnOn(w);
      seed(inner, "{}\n");
      w.rows.asked.length = 0;
      expect(await turnOn(w)).toMatchObject([
        { result: "unchanged", access: "on" },
        { result: "applied", access: "on" },
      ]);
      expect(w.rows.asked).toEqual([]);
      expect(furtherRecords(w)).toMatchObject([{ file: inner, state: "applied" }]);
      expect(furtherRecords(w)[0]).not.toHaveProperty("gives_access");
    },
    SLOW,
  );

  test(
    "a file added to a home that has its grant, whose read back fails, is taken back without a revoke, at once and when it is settled",
    async () => {
      const w = await world();
      const { plain, inner } = twoFiles(w);
      seed(plain, "{}\n");
      await turnOn(w);
      seed(inner, "{}\n");
      w.rows.asked.length = 0;
      const out = await failingReadAfterWrite(inner, () => turnOn(w));
      expect(out[1]).toMatchObject({
        result: "failed",
        reason: "unreadable",
        access: "on",
        notes: ["undo_failed"],
      });
      expect(furtherRecords(w)).toMatchObject([{ state: "removing" }]);
      expect(await settleHomes(live(w), w.rows)).toMatchObject([
        { result: "removed", access: "on" },
      ]);
      expect(w.rows.asked).toEqual([]);
      expect(w.rows.live).toHaveLength(1);
      expect(entryIn(CLAUDE, inner)).toBeUndefined();
      expect(entryIn(CLAUDE, plain)).toBeDefined();
    },
    SLOW,
  );

  test(
    "the apply that finds the access off marks its record before it asks, and takes the access back when its file fails",
    async () => {
      const w = await world();
      const { plain } = twoFiles(w);
      seed(plain, "{}\n");
      let atGrant: HomeRecord[] = [];
      const rows = keptRows((verb) => {
        if (verb === "grant") atGrant = readRecords(w.input.stateDir);
      });
      rows.refuse.grant = "grant_failed";
      expect(await turnOn(w, rows, { ...w.input, rows: rows.live })).toMatchObject([
        { result: "failed", reason: "grant_failed", access: "off", notes: ["undone"] },
      ]);
      expect(atGrant).toMatchObject([{ state: "applying", gives_access: true }]);
      expect(rows.asked.map((x) => x.verb)).toEqual(["grant", "revoke"]);
      expect(entryIn(CLAUDE, plain)).toBeUndefined();
    },
    SLOW,
  );

  test(
    "the service cannot say whether the access is live: nothing is offered, granted or revoked, and each file says the access is unknown",
    async () => {
      const w = await world();
      const { plain, inner } = twoFiles(w);
      seed(plain, "{}\n");
      seed(inner, "{}\n");
      const before = [bytesOf(plain), bytesOf(inner)];
      // No rows: no service said.
      const silent = w.input;
      for (const { answer } of await answers(w, silent)) {
        expect(answer).toEqual({ status: "off", off: true });
      }
      w.rows.refuse.read = true;
      expect(await turnOn(w, w.rows, silent)).toMatchObject([
        { result: "left", reason: "access_unknown", access: "unknown" },
        { result: "left", reason: "access_unknown", access: "unknown" },
      ]);
      expect(w.rows.asked).toEqual([]);
      expect([bytesOf(plain), bytesOf(inner)]).toEqual(before);
      expect(readRecords(w.input.stateDir)).toEqual([]);
    },
    SLOW,
  );
});

describe("[A3.3.13.setup.cuts] What a run cut between two of its steps leaves: what the next start shows and offers, and what settling it does", () => {
  /** The default home on in both files, its row live. */
  async function bothOn(w: World) {
    const files = twoFiles(w);
    seed(files.plain, "{}\n");
    seed(files.inner, "{}\n");
    await turnOn(w);
    w.rows.asked.length = 0;
    return files;
  }
  const verbs = (w: World) => w.rows.asked.map((x) => x.verb);

  test(
    "an add of a further file to a home with its grant, cut after its record or after its write: the file shows interrupted, settling takes its entry out without a revoke, and it offers Add",
    async () => {
      for (const written of [false, true]) {
        const w = await world();
        const { inner } = await bothOn(w);
        rewriteRecord(w, inner, (r) => ({ ...r, state: "applying" }));
        if (!written) seed(inner, "{}\n");
        const seen = await answers(w);
        expect(seen[1]?.answer, String(written)).toEqual(
          written
            ? { status: "on", why: "interrupted", off: true }
            : { status: "off", why: "interrupted", on: "add", off: true },
        );
        expect(homeAnswer(seen).status).toBe("on");
        expect(await settleHomes(live(w), w.rows)).toMatchObject([
          { result: "removed", access: "on" },
        ]);
        expect(verbs(w)).toEqual([]);
        expect(entryIn(CLAUDE, inner)).toBeUndefined();
        expect((await answers(w))[1]?.answer).toMatchObject({ on: "add" });
      }
    },
    SLOW,
  );

  test(
    "the same cut with the entry edited meanwhile: it is the person's, and no Add is promised; with the file unreadable meanwhile: it stays pending, untouched",
    async () => {
      const w = await world();
      const { inner } = await bothOn(w);
      rewriteRecord(w, inner, (r) => ({ ...r, state: "applying" }));
      editEntry(inner);
      expect((await answers(w))[1]?.answer).toMatchObject({ why: "foreign_entry" });
      expect((await answers(w))[1]?.answer.on).toBeUndefined();
      expect(await settleHomes(live(w), w.rows)).toMatchObject([
        { result: "left", reason: "edited", kept: "edited" },
      ]);
      expect(furtherRecords(w)).toEqual([]);

      const v = await world();
      const two = await bothOn(v);
      rewriteRecord(v, two.inner, (r) => ({ ...r, state: "applying" }));
      const broken = `${readFileSync(two.inner, "utf8")},`;
      writeFileSync(two.inner, broken);
      expect((await answers(v))[1]?.answer).toEqual({
        status: "off",
        why: "invalid_file",
        off: true,
      });
      expect(await settleHomes(live(v), v.rows)).toMatchObject([
        { result: "left", reason: "invalid_file", kept: "own" },
      ]);
      expect(readFileSync(two.inner, "utf8")).toBe(broken);
      expect(furtherRecords(v)).toMatchObject([{ state: "removing" }]);
      expect(verbs(v)).toEqual([]);
    },
    SLOW,
  );

  test(
    "the add that asked for the access, cut after the service gave it and before its record said so: the row is live until settling, which takes it and the entry back",
    async () => {
      const w = await world();
      const { plain } = twoFiles(w);
      seed(plain, "{}\n");
      await turnOn(w);
      rewriteRecord(w, plain, (r) => ({ ...r, state: "applying", gives_access: true }));
      w.rows.asked.length = 0;
      expect((await answers(w))[0]?.answer).toEqual({
        status: "on",
        why: "interrupted",
        off: true,
      });
      expect(await settleHomes(live(w), w.rows)).toMatchObject([
        { result: "removed", access: "off" },
      ]);
      expect(verbs(w)).toEqual(["revoke"]);
      expect(entryIn(CLAUDE, plain)).toBeUndefined();
    },
    SLOW,
  );

  test(
    "giving an intact entry its access back, cut after the service confirmed it and before the record took the row's ID: the row is live, the file is on, and nothing is left to settle",
    async () => {
      const w = await world();
      const { plain } = await bothOn(w);
      rewriteRecord(w, plain, (r) => ({ ...r, grant: "gr_00000000000000000000000000" }));
      expect(homeAnswer(await answers(w)).status).toBe("on");
      expect(await settleHomes(live(w), w.rows)).toEqual([]);
      expect(verbs(w)).toEqual([]);
    },
    SLOW,
  );

  test(
    "Off cut after its revoke, before either file, or after the first file said removing: Off is offered again, the access off, and it finishes both",
    async () => {
      for (const first of ["untouched", "removing"] as const) {
        const w = await world();
        const { plain, inner } = await bothOn(w);
        await w.rows.revoke((await filesOf(w))[0]?.home ?? missingHome());
        if (first === "removing") rewriteRecord(w, plain, (r) => ({ ...r, state: "removing" }));
        const seen = await answers(w);
        expect(
          seen.map((s) => s.answer),
          first,
        ).toEqual([
          first === "removing"
            ? { status: "off", why: "entry_left", on: "add", off: true }
            : { status: "off", why: "access_off", on: "grant", off: true },
          { status: "off", why: "access_off", on: "grant", off: true },
        ]);
        expect(homeAnswer(seen).off).toBe(true);
        expect(await turnOff(w)).toMatchObject([{ result: "removed" }, { result: "removed" }]);
        expect([entryIn(CLAUDE, plain), entryIn(CLAUDE, inner)]).toEqual([undefined, undefined]);
        expect(homeAnswer(await answers(w)).off).toBe(false);
      }
    },
    SLOW,
  );

  test(
    "a repair in place, cut after its record and before its write: the file shows interrupted, settling takes its entry out without a revoke, and it offers Add",
    async () => {
      const w = await world();
      const { plain } = await bothOn(w);
      rewriteRecord(w, plain, (r) => ({
        ...r,
        state: "applying",
        entry: { ...r.entry, command: join(w.dir, "new", basename(w.input.tasks)) },
        also: [r.entry],
      }));
      expect((await answers(w))[0]?.answer).toMatchObject({ why: "interrupted" });
      expect(await settleHomes(live(w), w.rows)).toMatchObject([
        { result: "removed", access: "on" },
      ]);
      expect(verbs(w)).toEqual([]);
      expect(entryIn(CLAUDE, plain)).toBeUndefined();
      expect((await answers(w))[0]?.answer).toMatchObject({ why: "missing", on: "add" });
    },
    SLOW,
  );
});

/** The default home was not found: the test cannot go on. */
function missingHome(): never {
  throw new Error("no default home");
}

describe("[A3.3.13.setup.earlier-builds] Installs set up by earlier builds keep their access after the update, and a rollback to one leaves a state this build answers", () => {
  const EARLIER = ["42d05231", "491a6d74", "2f09505f", "11ebfa74"] as const;

  interface Earlier {
    readonly record: { readonly format: number; readonly homes: Record<string, unknown>[] };
    readonly after: Readonly<Record<string, string | null>>;
  }

  /** A fixture's text with each placeholder as this world's path, escaped as its place needs. */
  function placed(w: World, text: string, escape: (path: string) => string): string {
    const paths: Record<string, string> = {
      user: w.home,
      desktop: w.desktop,
      root: w.dir,
      tasks: w.input.tasks,
    };
    return text.replace(
      /\{\{(user|desktop|root|tasks)\}\}((?:\/[^"'\s,\]]*)?)/gu,
      (_m, token: string, rest: string) =>
        escape(join(paths[token] ?? "", ...rest.split("/").filter((s) => s !== ""))),
    );
  }
  const raw = (path: string) => path;
  const escaped = (path: string) => JSON.stringify(path).slice(1, -1);

  test.each(EARLIER)(
    "an install the build %s set up keeps its access and shows on; the default folder's further file shows without its entry, and one apply writes it without asking for access; each home then turns off and comes out",
    async (build) => {
      const fixture = JSON.parse(
        readFileSync(
          join(import.meta.dirname, "fixtures", "setup-earlier", `${build}.json`),
          "utf8",
        ),
      ) as Earlier;
      const w = await world();
      mkdirSync(join(w.home, ".claude-two"));
      const input: SetupInput = {
        ...w.input,
        detection: await detect(nodeDetectHost({ env: w.input.env, home: w.home })),
      };
      const files: Record<string, string> = {};
      for (const [key, text] of Object.entries(fixture.after)) {
        const file = placed(w, key, raw);
        files[key] = file;
        // A TOML literal string holds the path as it is, every other string escaped.
        seed(
          file,
          text === null
            ? null
            : placed(w, text.replaceAll("'{{tasks}}'", `'${w.input.tasks}'`), escaped),
        );
      }
      mkdirSync(setupDir(w.input.stateDir), { recursive: true });
      writeFileSync(recordPath(w), placed(w, JSON.stringify(fixture.record), escaped));
      for (const r of fixture.record.homes) {
        w.rows.live.push({
          app: r["app"] as string,
          home: placed(w, r["home"] as string, raw),
          instance: r["instance"] as string,
          space: r["space"] as string,
          grant: r["grant"] as string,
        });
      }
      const rowed = () => live(w, input);
      const bytes = () => Object.values(files).map(bytesOf);
      const written = bytes();

      // After the update: each home on, with nothing to say and nothing written.
      const views = await survey(rowed());
      expect(views.map((v) => v.home.instance).sort(), build).toEqual(
        ["claude", "claude-desktop", "claude-two", "claude-work", "codex", "codex-work"].sort(),
      );
      for (const view of views) {
        expect(view.state, `${build}: ${view.home.instance}`).toBe("registered");
        expect(toolsOf(rowed(), view, ""), `${build}: ${view.home.instance}`).toEqual({
          status: "on",
          off: true,
        });
      }
      expect(bytes(), build).toEqual(written);

      // Claude Code started with its home set to the folder makes its own file: no entry yet.
      const { plain, inner } = twoFiles(w);
      seed(inner, '{"numStartups": 1}\n');
      const seen = await answers(w, rowed());
      expect(homeAnswer(seen), build).toEqual({
        status: "on",
        files: [{ file: inner, why: "missing", on: "add" }],
        off: true,
      });
      expect(bytes(), `${build}: nothing is written before an apply`).toEqual(written);
      w.rows.asked.length = 0;
      // As the command line applies: from no space of its own, the home's is the one.
      expect(await turnOn(w, w.rows, rowed(), ""), build).toMatchObject([
        { result: "unchanged", access: "on" },
        { result: "applied", access: "on" },
      ]);
      expect(w.rows.asked, build).toEqual([]);
      // This install's entry, for the instance and space of the home's row.
      const space = (
        fixture.record.homes.find((h) => h["instance"] === "claude") as {
          space: string;
        }
      ).space;
      expect(entryIn(CLAUDE, inner), build).toEqual({
        command: w.input.tasks,
        args: ["mcp", "--space", space, "--instance", "claude", "--app", "claude-code"],
      });
      expect(entryIn(CLAUDE, plain), build).toBeDefined();

      // Each turns off and comes out of every file.
      for (const group of await survey(rowed())) {
        expect(
          await removeHome(rowed(), group, w.rows),
          `${build}: ${group.home.instance} ${group.home.file}`,
        ).toMatchObject({ result: "removed", access: "off" });
        const adapter = ADAPTERS.find((a) => a.app === group.home.app) as Adapter;
        if (existsSync(group.home.file)) {
          expect(entryIn(adapter, group.home.file), group.home.file).toBeUndefined();
        }
      }
      expect(w.rows.live, build).toEqual([]);
      expect(readRecords(w.input.stateDir), build).toEqual([]);
      expect(furtherRecords(w), build).toEqual([]);
    },
    SLOW,
  );

  test(
    "rolled back to an earlier build, which knows the first file only: its Off takes that file's entry out, and after the update the further file's recorded entry offers Off and turning on; its turning on again is on in both",
    async () => {
      const w = await world();
      const { plain, inner } = twoFiles(w);
      seed(plain, "{}\n");
      seed(inner, "{}\n");
      await turnOn(w);
      const home = (await filesOf(w))[0]?.home ?? missingHome();
      const further = readFileSync(join(setupDir(w.input.stateDir), FURTHER_FILE));

      // The earlier build's Off: the folder's rows, then the one file it knows, then its record.
      await w.rows.revoke(home);
      seed(plain, "{}\n");
      writeRecords(w.input.stateDir, []);
      expect(readFileSync(join(setupDir(w.input.stateDir), FURTHER_FILE))).toEqual(further);

      // Updated again.
      const seen = await answers(w);
      expect(seen.map((s) => s.answer)).toEqual([
        { status: "off", on: "add", off: false },
        { status: "off", why: "access_off", on: "grant", off: true },
      ]);
      expect(homeAnswer(seen)).toMatchObject({ status: "off", off: true });
      expect(await turnOff(w)).toMatchObject([
        { result: "unchanged", access: "off" },
        { result: "removed", access: "off" },
      ]);
      expect(entryIn(CLAUDE, inner)).toBeUndefined();
      expect(furtherRecords(w)).toEqual([]);

      // Or the earlier build turns it on again: its entry, its record, its row.
      const v = await world();
      const two = twoFiles(v);
      seed(two.plain, "{}\n");
      seed(two.inner, "{}\n");
      await turnOn(v);
      const vHome = (await filesOf(v))[0]?.home ?? missingHome();
      const vEntry = bytesOf(two.plain);
      const vLegacy = readRecords(v.input.stateDir);
      await v.rows.revoke(vHome);
      seed(two.plain, "{}\n");
      writeRecords(v.input.stateDir, []);
      writeFileSync(two.plain, vEntry ?? "");
      writeRecords(v.input.stateDir, vLegacy);
      await v.rows.grant(vHome, SPACE);
      expect(homeAnswer(await answers(v))).toEqual({ status: "on", files: [], off: true });
    },
    SLOW,
  );
});

describe("[A3.3.13.setup.plan-bound] A plan is bound to what its apply writes and gives: each file as read, and the access", () => {
  const tokenOf = async (w: World, a: Adapter, input: SetupInput = w.input) => {
    const view = (await survey(input)).find(
      (v) => v.home.app === a.app && (a.folder === undefined || v.home.home.endsWith(a.folder)),
    );
    if (view === undefined) throw new Error(`no ${a.app} home`);
    return planToken(input, SPACE, planOf(input, [view], SPACE));
  };

  test(
    "an edit of a selected file changes the plan, for turning on and for turning off; Claude Code's own saves outside its servers do not",
    async () => {
      for (const a of ADAPTERS) {
        const w = await world();
        const file = a.file(w);
        const base =
          a.format === "json" ? '{"theme": "dark", "mcpServers": {}}\n' : 'model = "m"\n';
        seed(file, base);
        const other =
          a.format === "json"
            ? '{"theme": "dark", "mcpServers": {"other": {"command": "x"}}}\n'
            : 'model = "m"\n\n[mcp_servers.other]\ncommand = "x"\n';
        const adding = await tokenOf(w, a);
        seed(file, other);
        expect(await tokenOf(w, a), `${a.app}: another server, before it is turned on`).not.toBe(
          adding,
        );
        seed(file, base);
        expect(await apply(w, a)).toMatchObject({ result: "applied" });
        const withRows = { ...w.input, rows: w.rows.live };
        const removing = await tokenOf(w, a, withRows);
        const text = readFileSync(file, "utf8");
        seed(
          file,
          a.format === "json"
            ? text.replace('"theme": "dark"', '"theme": "light"')
            : text.replace('model = "m"', 'model = "n"'),
        );
        const edited = await tokenOf(w, a, withRows);
        if (a.app === "claude-code") {
          // Claude Code saves its own state into this file while a session runs.
          expect(edited, `${a.app}: its own save, before it is turned off`).toBe(removing);
        } else {
          expect(edited, `${a.app}: an edit, before it is turned off`).not.toBe(removing);
        }
      }
    },
    SLOW,
  );

  test(
    "the access an apply gives back is part of its plan: on, off and unknown are three plans, and an apply that cannot read the access gives none back",
    async () => {
      for (const a of ADAPTERS) {
        const w = await world();
        seed(a.file(w), a.format === "json" ? "{}\n" : "");
        expect(await apply(w, a)).toMatchObject({ result: "applied", access: "on" });
        const on = await tokenOf(w, a, { ...w.input, rows: w.rows.live });
        const off = await tokenOf(w, a, { ...w.input, rows: [] });
        const unknown = await tokenOf(w, a, w.input);
        expect(new Set([on, off, unknown]).size, a.app).toBe(3);
        // The service does not answer: a renewal asks for no access, and nothing is taken.
        await w.rows.revoke((await viewOf(w, a)).home);
        w.rows.asked.length = 0;
        w.rows.refuse.read = true;
        const view = await viewOf(w, a);
        expect(await applyHome(w.input, view, SPACE, w.rows), a.app).toMatchObject({
          result: "left",
          reason: "access_unknown",
          access: "unknown",
        });
        expect(w.rows.asked, a.app).toEqual([]);
        expect(w.rows.live, a.app).toEqual([]);
      }
    },
    SLOW,
  );
});
