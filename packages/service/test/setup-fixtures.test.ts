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
  applyHome,
  planOf,
  planToken,
  readRecords,
  removeHome,
  setupDir,
  SETUP_FILE,
  settleHomes,
  survey,
  toolsOf,
  writeRecords,
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

async function apply(w: World, a: Adapter, input: SetupInput = w.input) {
  const view = await viewOf(w, a);
  const [item] = planOf(input, [view], SPACE);
  return applyHome(input, view, SPACE, w.rows, item?.change);
}

/** The world's input with the service's live rows read, as the command line and the page read them. */
const known = (w: World): SetupInput => ({ ...w.input, rows: w.rows.live });

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
    "giving a registered home its access back checks its entry as a new install does: before the grant, after it, and when the record cannot be written",
    async () => {
      for (const a of ADAPTERS) {
        for (const event of [
          "a save before the grant changes the entry",
          "a save during the grant changes the entry",
          "the record cannot be written",
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
            if (armed && verb === "grant" && event === "a save during the grant changes the entry")
              change();
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
          if (event === "a save before the grant changes the entry") change();
          const restore =
            event === "the record cannot be written" ? unwritable(recordPath(w)) : null;
          let outcome;
          try {
            // The service says the access is off: giving it back is what turning on offers.
            outcome = await applyHome({ ...w.input, rows: rows.live }, view, "", rows);
          } finally {
            restore?.();
          }
          expect(outcome, what).toMatchObject({ result: "failed", access: "off" });
          expect(rows.live, what).toEqual([]);
          if (event === "the record cannot be written") {
            expect(outcome.reason, what).toBe("state_unwritable");
            expect(
              rows.asked.map((x) => x.verb),
              what,
            ).toEqual(["grant", "revoke"]);
          } else {
            expect(outcome.reason, what).toBe("changed_meanwhile");
            // The person's save stays, and is theirs from then on.
            expect(readFileSync(file, "utf8"), what).toBe(saved);
            expect(readRecords(w.input.stateDir), what).toEqual([]);
            expect(
              rows.asked.map((x) => x.verb),
              what,
            ).toEqual(
              event === "a save before the grant changes the entry"
                ? ["revoke"]
                : ["grant", "revoke"],
            );
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
        const outcome = await applyHome(known(w), view, SPACE, w.rows, item?.change);
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
      expect(await apply(held, a, known(held))).toMatchObject({
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
    "a file that cannot be written: no access is given; turning off takes the access away, and the next setup takes the entry out once",
    async () => {
      for (const a of ADAPTERS) {
        const w = await world();
        const file = a.file(w);
        seed(file, a.format === "json" ? "{}\n" : 'model = "m"\n');
        const before = readFileSync(file);
        const restore = unwritable(file);
        try {
          expect(await apply(w, a, known(w)), a.app).toMatchObject({
            result: "failed",
            reason: "unwritable",
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
        // record said so: the entry comes out and the access is off. The person turns it on again.
        for (const granted of [false, true]) {
          writeFileSync(file, withEntry);
          await w.rows.revoke((await viewOf(w, a)).home);
          if (granted) await w.rows.grant((await viewOf(w, a)).home, SPACE);
          writeRecords(w.input.stateDir, [{ ...record, state: "applying", grant: null }]);
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
        w.rows.refuse = { grant: "grant_failed", revoke: true };
        // Nothing claims the entry went: it stays, and the outcome says so.
        expect(await apply(w, a), a.app).toMatchObject({
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
            () => apply(w, a, known(w)),
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

describe("[A3.3.13.setup.home-files] Claude Code's default folder has a settings file for each way it is started: the entry goes into each that a program reads, and comes out of each", () => {
  /** The default folder's two files: plain Claude Code's, and the one Claude Code reads when its home is set to the folder. */
  const filesOf = (w: World) => ({
    folder: join(w.home, ".claude"),
    plain: join(w.home, ".claude.json"),
    explicit: join(w.home, ".claude", ".claude.json"),
  });
  const claude = ADAPTERS[0] as Adapter;
  const defaultView = async (w: World, input: SetupInput = w.input): Promise<HomeView> => {
    const found = (await survey(input)).find(
      (v) => v.home.app === "claude-code" && v.home.home === filesOf(w).folder,
    );
    if (found === undefined) throw new Error("no default Claude Code home");
    return found;
  };
  const applyDefault = async (w: World, input: SetupInput = w.input) => {
    const view = await defaultView(w, input);
    const [item] = planOf(input, [view], SPACE);
    return applyHome(input, view, SPACE, w.rows, item?.change);
  };

  test(
    "both files there: apply writes the same entry into each and gives one access; remove takes both out byte for byte",
    async () => {
      const w = await world();
      const { plain, explicit } = filesOf(w);
      seed(plain, '{\n  "numStartups": 3\n}\n');
      seed(explicit, '{"theme":"dark"}');
      const before = [bytesOf(plain), bytesOf(explicit)];
      expect(await applyDefault(w)).toMatchObject({ result: "applied", access: "on" });
      const instance = (await defaultView(w)).home.instance;
      expect(entryIn(claude, plain)).toEqual(expectedEntry(w, claude, instance));
      expect(entryIn(claude, explicit)).toEqual(expectedEntry(w, claude, instance));
      expect(w.rows.live).toHaveLength(1);
      expect(await removeHome(w.input, await defaultView(w), w.rows)).toMatchObject({
        result: "removed",
        access: "off",
      });
      expect([bytesOf(plain), bytesOf(explicit)]).toEqual(before);
      expect(readRecords(w.input.stateDir)).toEqual([]);
    },
    SLOW,
  );

  test.skipIf(root)(
    "an add that writes nothing says the access as it is: still on for a live grant whose record was lost, off when there is none, unknown when the service was not asked",
    async () => {
      const codex = ADAPTERS[1] as Adapter;
      for (const live of [true, false, undefined]) {
        const w = await world();
        const file = codex.file(w);
        seed(file, "");
        if (live === true) {
          w.rows.live.push({
            app: "codex",
            home: dirname(file),
            instance: "codex-work",
            space: SPACE,
            grant: "gr_00000000000000000000000009",
          });
        }
        const restore = unwritable(file);
        try {
          const input = live === undefined ? w.input : known(w);
          expect(await apply(w, codex, input), String(live)).toMatchObject({
            result: "failed",
            reason: "unwritable",
            access: live === true ? "on" : live === false ? "off" : "unknown",
          });
        } finally {
          restore();
        }
        expect(w.rows.asked, String(live)).toEqual([]);
        expect(w.rows.live, String(live)).toHaveLength(live === true ? 1 : 0);
      }
    },
    SLOW,
  );

  test.skipIf(root)(
    "one of the two files cannot be written: the other is given back as it was, and no access is given",
    async () => {
      const w = await world();
      const { plain, explicit } = filesOf(w);
      seed(plain, '{\n  "numStartups": 3\n}\n');
      seed(explicit, '{"theme":"dark"}');
      const before = [bytesOf(plain), bytesOf(explicit)];
      const restore = unwritable(explicit);
      let outcome;
      try {
        outcome = await applyDefault(w, known(w));
      } finally {
        restore();
      }
      expect(outcome).toMatchObject({
        result: "failed",
        reason: "unwritable",
        file: explicit,
        access: "off",
      });
      expect([bytesOf(plain), bytesOf(explicit)]).toEqual(before);
      expect(w.rows.asked).toEqual([]);
      expect(readRecords(w.input.stateDir)).toEqual([]);
    },
    SLOW,
  );

  test(
    "a program that will read the folder's own file is no reason to make it: setup writes it once it is there",
    async () => {
      const w = await world();
      const { folder, plain, explicit } = filesOf(w);
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
      expect((await defaultView(w)).home.hosts).toEqual(["t3"]);
      expect(await applyDefault(w)).toMatchObject({ result: "applied", access: "on" });
      const instance = (await defaultView(w)).home.instance;
      expect(entryIn(claude, plain)).toEqual(expectedEntry(w, claude, instance));
      expect(existsSync(explicit)).toBe(false);
      // Claude Code made its file: the row says it has no entry, and one apply writes it.
      seed(explicit, '{"numStartups": 1}\n');
      const live = { ...w.input, rows: w.rows.live };
      const lacking = await defaultView(w, live);
      expect(toolsOf(live, lacking, SPACE)).toEqual({
        status: "on",
        why: "file_lacks",
        file: explicit,
        on: "add",
        off: true,
      });
      expect(await applyDefault(w, live)).toMatchObject({ result: "unchanged", access: "on" });
      expect(entryIn(claude, explicit)).toEqual(expectedEntry(w, claude, instance));
    },
    SLOW,
  );

  test(
    "a file setup made and the person then replaced with their own is theirs: the record names each file once, and turning off leaves theirs",
    async () => {
      const w = await world();
      const { plain, explicit } = filesOf(w);
      seed(plain, null);
      seed(explicit, '{"theme":"dark"}');
      expect(await applyDefault(w)).toMatchObject({ result: "applied", access: "on" });
      // Their own file in place of the one setup made, with an empty servers table of their own.
      const theirs = '{\n  "mcpServers": {}\n}\n';
      seed(plain, theirs);
      const live = { ...w.input, rows: w.rows.live };
      expect(toolsOf(live, await defaultView(w, live), SPACE)).toMatchObject({
        why: "file_lacks",
        file: plain,
        on: "add",
      });
      expect(await applyDefault(w, live)).toMatchObject({ result: "unchanged", access: "on" });
      const [record] = readRecords(w.input.stateDir);
      const named = [record?.file, ...(record?.more ?? []).map((m) => m.file)];
      expect(named.sort()).toEqual([plain, explicit].sort());
      expect(await removeHome(live, await defaultView(w, live), w.rows)).toMatchObject({
        result: "removed",
        access: "off",
      });
      expect(readFileSync(plain, "utf8")).toBe(theirs);
      expect(readFileSync(explicit, "utf8")).toBe('{"theme":"dark"}');
    },
    SLOW,
  );

  test(
    "the folder's own file, which a program will read, made by the person after setup ran: turning off leaves it",
    async () => {
      const w = await world();
      const { folder, plain, explicit } = filesOf(w);
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
      expect(await applyDefault(w)).toMatchObject({ result: "applied", access: "on" });
      const theirs = '{\n  "mcpServers": {}\n}\n';
      seed(explicit, theirs);
      const live = { ...w.input, rows: w.rows.live };
      expect(await applyDefault(w, live)).toMatchObject({ result: "unchanged", access: "on" });
      const [record] = readRecords(w.input.stateDir);
      const named = [record?.file, ...(record?.more ?? []).map((m) => m.file)];
      expect(named.sort()).toEqual([plain, explicit].sort());
      expect(await removeHome(live, await defaultView(w, live), w.rows)).toMatchObject({
        result: "removed",
        access: "off",
      });
      expect(readFileSync(explicit, "utf8")).toBe(theirs);
      expect(readFileSync(plain, "utf8")).toBe("{}\n");
    },
    SLOW,
  );

  // What earlier builds left, made by each build's own `ttasks setup agents` through its service
  // with fake agent commands: five agent homes and Claude Desktop, their files and setup's record,
  // paths as {{user}}, {{desktop}}, {{root}} and {{tasks}}.
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
    "an install the build %s set up keeps its access and shows on; a second file of Claude Code's folder shows without its entry, and one apply writes it; each home then turns off and comes out",
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
      const live = () => ({ ...input, rows: w.rows.live });
      const bytes = () => Object.values(files).map(bytesOf);
      const written = bytes();

      // After the update: each home on, with nothing to say and nothing written.
      const views = await survey(live());
      expect(views.map((v) => v.home.instance).sort(), build).toEqual(
        ["claude", "claude-desktop", "claude-two", "claude-work", "codex", "codex-work"].sort(),
      );
      for (const view of views) {
        expect(view.state, `${build}: ${view.home.instance}`).toBe("registered");
        expect(toolsOf(live(), view, ""), `${build}: ${view.home.instance}`).toEqual({
          status: "on",
          off: true,
        });
      }
      expect(bytes(), build).toEqual(written);

      // Claude Code started with its home set to the folder makes its own file: no entry yet.
      const { explicit } = filesOf(w);
      seed(explicit, '{"numStartups": 1}\n');
      const lacking = await defaultView(w, live());
      expect(toolsOf(live(), lacking, ""), build).toEqual({
        status: "on",
        why: "file_lacks",
        file: explicit,
        on: "add",
        off: true,
      });
      expect(bytes(), `${build}: nothing is written before an apply`).toEqual(written);
      // From the space its record names, as the command line applies a registered home.
      const [item] = planOf(live(), [lacking], "");
      expect(await applyHome(live(), lacking, "", w.rows, item?.change), build).toMatchObject({
        result: "unchanged",
        access: "on",
      });
      const instance = lacking.home.instance;
      const space = (
        fixture.record.homes.find((h) => h["instance"] === instance) as {
          space: string;
        }
      ).space;
      expect(entryIn(claude, explicit), build).toEqual({
        command: w.input.tasks,
        args: ["mcp", "--space", space, "--instance", instance, "--app", "claude-code"],
      });
      expect(toolsOf(live(), await defaultView(w, live()), ""), build).toEqual({
        status: "on",
        off: true,
      });

      // Each turns off and comes out of every file.
      for (const view of await survey(live())) {
        expect(
          await removeHome(live(), view, w.rows),
          `${build}: ${view.home.instance}`,
        ).toMatchObject({
          result: "removed",
          access: "off",
        });
        const adapter = ADAPTERS.find((a) => a.app === view.home.app) as Adapter;
        for (const file of view.home.files) {
          if (existsSync(file)) expect(entryIn(adapter, file), file).toBeUndefined();
        }
      }
      expect(w.rows.live, build).toEqual([]);
      expect(readRecords(w.input.stateDir), build).toEqual([]);
    },
    SLOW,
  );
});

describe("[A3.3.13.setup.fixtures] A live grant is a fact of its home: listed when nothing else accounts for it, and its space is the home's", () => {
  const OTHER = "sp_0other0space0000000000000a";

  test(
    "a live grant whose folder is gone and whose record was lost is listed, can be turned off, and offers nothing to turn on",
    async () => {
      const w = await world();
      const gone = join(w.home, ".codex-renamed");
      const row = { app: "codex", home: gone, instance: "codex-renamed", space: SPACE };
      const input = { ...w.input, rows: [row] };
      const view = (await survey(input)).find((v) => v.home.home === gone);
      if (view === undefined) throw new Error("the grant's home is not listed");
      expect(view.home.instance).toBe("codex-renamed");
      expect(toolsOf(input, view, SPACE)).toMatchObject({ off: true });
      expect(toolsOf(input, view, SPACE).on).toBeUndefined();
      w.rows.live.push({ ...row, grant: "gr_00000000000000000000000001" });
      expect(await removeHome(input, view, w.rows)).toMatchObject({ access: "off" });
      expect(w.rows.live).toEqual([]);
    },
    SLOW,
  );

  test(
    "a repair from another space never moves the access there: a lost record, and a removal that stopped half-way",
    async () => {
      for (const a of ADAPTERS.filter((x) => x.app !== "claude-desktop")) {
        const w = await world();
        const bare = a.format === "json" ? "{}\n" : "";
        seed(a.file(w), bare);
        expect(await apply(w, a)).toMatchObject({ result: "applied" });
        const live = { ...w.input, rows: w.rows.live };
        // Setup's record lost and its entry gone: the grant for SPACE is what is left.
        rmSync(recordPath(w));
        seed(a.file(w), bare);
        const lost = await viewOf(w, a);
        expect(toolsOf(live, lost, OTHER), a.app).toMatchObject({
          why: "other_space",
          off: true,
        });
        expect(toolsOf(live, lost, OTHER).on, a.app).toBeUndefined();
        expect(toolsOf(live, lost, SPACE).on, a.app).toBe("add");
        expect(await applyHome(live, lost, OTHER, w.rows), a.app).toMatchObject({ result: "left" });
        expect(
          w.rows.live.map((r) => r.space),
          a.app,
        ).toEqual([SPACE]);
        // A removal for SPACE that stopped before its revoke: finishing it is offered, not a move.
        seed(a.file(w), bare);
        expect(await apply(w, a)).toMatchObject({ result: "applied" });
        const [record] = readRecords(w.input.stateDir);
        writeRecords(w.input.stateDir, [{ ...(record as HomeRecord), state: "removing" }]);
        const half = await viewOf(w, a);
        const known = { ...w.input, rows: w.rows.live };
        expect(half.state, a.app).toBe("interrupted");
        expect(toolsOf(known, half, OTHER), a.app).toMatchObject({ why: "other_space", off: true });
        expect(toolsOf(known, half, OTHER).on, a.app).toBeUndefined();
      }
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
    return planToken(SPACE, planOf(input, [view], SPACE));
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
        // The service did not say: a renewal asks for no access.
        await w.rows.revoke((await viewOf(w, a)).home);
        w.rows.asked.length = 0;
        const view = await viewOf(w, a);
        expect(await applyHome(w.input, view, SPACE, w.rows), a.app).toMatchObject({
          result: "left",
          reason: "access_unknown",
        });
        expect(w.rows.asked, a.app).toEqual([]);
        expect(w.rows.live, a.app).toEqual([]);
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
