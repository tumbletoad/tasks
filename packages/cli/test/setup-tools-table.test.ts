// What a home's tools row says and offers, as one table: for Claude Code, Codex and Claude Desktop,
// every combination of the entry (setup's own, changed by hand, gone), the program it names (there,
// where TTasks was installed before, gone), the access (live, off) and the space (the one the
// person is in, another), read through the page's answer and the command line's status JSON on
// the same scratch state; then each action the page offers is carried out and is never refused.
// A real service in this process with the page's agent apps, the CLI in this process, fake agent
// commands (testkit), scratch homes only.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MCP_SERVER_KEY } from "@ttasks/brand";
import { valueText } from "@ttasks/service/config";
import { startService, type RunningService } from "@ttasks/service/hub";
import { removeRuntimeDir, serviceEnv, stateOf, tempRoot } from "@ttasks/service/test/harness";
import { post } from "@ttasks/service/test/http-client";
import { signIn } from "@ttasks/service/test/http-world";
import { classSession } from "@ttasks/service/test/ops-helpers";
import { installFakeAgents } from "@ttasks/testkit/fake-agents";
import { runMain } from "./cli-harness.ts";

const SLOW = 600_000;
const windows = process.platform === "win32";
const APPS = ["claude-code", "codex", "claude-desktop"] as const;
type App = (typeof APPS)[number];

/** What a person sees of a tools row and may do with it. */
interface Seen {
  readonly status: "on" | "off" | "unknown";
  readonly why?: string;
  readonly on: boolean;
  readonly off: boolean;
}

interface Row {
  readonly entry: "none" | "own" | "edited" | "gone" | "removing";
  readonly program: "there" | "moved" | "gone";
  readonly access: "live" | "off";
  readonly space: "here" | "other";
  /** What the page and the command line say, for each of the three apps. */
  readonly seen: Seen;
  /** The command line, where it differs: it has no space of its own, so another one is here. */
  readonly cli?: Seen;
}

const s = (status: Seen["status"], why: string | undefined, on: boolean, off: boolean): Seen => ({
  status,
  ...(why === undefined ? {} : { why }),
  on,
  off,
});

const TABLE: readonly Row[] = [
  {
    entry: "none",
    program: "there",
    access: "off",
    space: "here",
    seen: s("off", undefined, true, false),
  },
  {
    entry: "own",
    program: "there",
    access: "live",
    space: "here",
    seen: s("on", undefined, false, true),
  },
  {
    entry: "own",
    program: "there",
    access: "off",
    space: "here",
    seen: s("off", "access_off", true, false),
  },
  {
    entry: "own",
    program: "moved",
    access: "live",
    space: "here",
    seen: s("off", "moved", true, true),
  },
  {
    entry: "own",
    program: "moved",
    access: "off",
    space: "here",
    seen: s("off", "moved", true, false),
  },
  {
    entry: "own",
    program: "gone",
    access: "live",
    space: "here",
    seen: s("off", "not_installed", false, true),
  },
  {
    entry: "own",
    program: "gone",
    access: "off",
    space: "here",
    seen: s("off", "not_installed", false, false),
  },
  {
    entry: "edited",
    program: "there",
    access: "live",
    space: "here",
    seen: s("on", "edited", false, true),
  },
  {
    entry: "edited",
    program: "there",
    access: "off",
    space: "here",
    seen: s("off", "edited", false, false),
  },
  {
    entry: "edited",
    program: "gone",
    access: "live",
    space: "here",
    seen: s("off", "edited_gone", false, true),
  },
  {
    entry: "edited",
    program: "gone",
    access: "off",
    space: "here",
    seen: s("off", "edited_gone", false, false),
  },
  {
    entry: "gone",
    program: "there",
    access: "live",
    space: "here",
    seen: s("off", "missing", true, true),
  },
  {
    entry: "gone",
    program: "there",
    access: "off",
    space: "here",
    seen: s("off", "missing", true, false),
  },
  {
    entry: "gone",
    program: "gone",
    access: "live",
    space: "here",
    seen: s("off", "not_installed", false, true),
  },
  {
    entry: "gone",
    program: "gone",
    access: "off",
    space: "here",
    seen: s("off", "not_installed", false, false),
  },
  // Set up for another space: what works from here is turning it off.
  {
    entry: "own",
    program: "there",
    access: "live",
    space: "other",
    seen: s("on", "other_space", false, true),
    cli: s("on", undefined, false, true),
  },
  {
    entry: "own",
    program: "there",
    access: "off",
    space: "other",
    seen: s("off", "other_space", false, false),
    cli: s("off", "access_off", true, false),
  },
  {
    entry: "own",
    program: "moved",
    access: "live",
    space: "other",
    seen: s("off", "other_space", false, true),
    cli: s("off", "moved", true, true),
  },
  {
    entry: "gone",
    program: "there",
    access: "live",
    space: "other",
    seen: s("off", "other_space", false, true),
    cli: s("off", "missing", true, true),
  },
  {
    entry: "edited",
    program: "there",
    access: "live",
    space: "other",
    seen: s("on", "edited", false, true),
  },
  // A turning off whose revoke the service did not confirm: the next apply finishes it first.
  {
    entry: "removing",
    program: "there",
    access: "live",
    space: "here",
    seen: s("on", "interrupted", false, true),
  },
  {
    entry: "removing",
    program: "there",
    access: "off",
    space: "here",
    seen: s("off", "entry_left", true, false),
  },
];

let service: RunningService;
let cleanup: () => void;
let root: string;
let home: string;
let user: string;
let desktop: string;
let env: Record<string, string>;
let token: string;
let port: number;
const spaces: Record<Row["space"], string> = { here: "", other: "" };

const tasksName = windows ? "ttasks.exe" : "ttasks";
const present = () => join(home, "bin", tasksName);
const old = () => join(home, "old", tasksName);
const nowhere = () => join(root, "nowhere", tasksName);
const recordFile = () => join(stateOf(home), "setup", "agents.json");
const FILE: Readonly<Record<App, () => string>> = {
  "claude-code": () => join(user, ".claude.json"),
  codex: () => join(user, ".codex", "config.toml"),
  "claude-desktop": () => join(desktop, "claude_desktop_config.json"),
};
const HOME: Readonly<Record<App, () => string>> = {
  "claude-code": () => join(user, ".claude"),
  codex: () => join(user, ".codex"),
  "claude-desktop": () => desktop,
};
const BASE_TOML = 'model = "m"\n';

beforeAll(async () => {
  const temp = tempRoot("tt");
  cleanup = temp.cleanup;
  root = temp.root;
  home = join(root, "h");
  user = join(root, "u");
  mkdirSync(join(user, ".claude"), { recursive: true });
  mkdirSync(join(user, ".codex"), { recursive: true });
  const fakes = installFakeAgents(join(root, "t"), user);
  env = { ...fakes.env };
  if (windows) {
    env["APPDATA"] = join(root, "roaming");
    env["LOCALAPPDATA"] = join(root, "local");
    desktop = join(root, "roaming", "Claude");
  } else if (process.platform === "darwin") {
    desktop = join(user, "Library", "Application Support", "Claude");
  } else {
    desktop = join(user, ".config", "Claude");
  }
  mkdirSync(desktop, { recursive: true });
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(present(), "");
  service = await startService({
    env: serviceEnv(home),
    identity: () => ({ root: false, elevated: false, package: null }),
    maintenance: false,
    say: () => undefined,
    http: { ports: [0], persist: false },
    agentApps: { env, home: user },
  });
  const sessions: { close(): void }[] = [];
  try {
    token = (
      await signIn({
        user: async () => {
          const session = await classSession(home, service.endpoint.path, "cli-interactive");
          sessions.push(session);
          return session;
        },
      })
    ).token;
  } finally {
    for (const session of sessions) session.close();
  }
  port = service.status().http?.port ?? 0;
  for (const [key, name] of [
    ["here", "Mira"],
    ["other", "Oslo"],
  ] as const) {
    spaces[key] = (await call<{ id: string }>("/api/v1/space/create", { name })).id;
  }
}, SLOW);

afterAll(async () => {
  await service.stop();
  removeRuntimeDir(service);
  cleanup();
}, SLOW);

async function call<T>(path: string, body: unknown): Promise<T> {
  const reply = await post(port, path, body, { token });
  if (reply.status !== 200) throw new Error(`${path} answered ${String(reply.status)}`);
  return (JSON.parse(reply.body) as { result: T }).result;
}

interface Part {
  readonly on: boolean;
  readonly change: "add" | "remove" | null;
  readonly why?: string;
  readonly plan: string;
  readonly off?: { readonly plan: string };
}
interface PageRow {
  readonly key: string;
  readonly app: string;
  readonly home: string | null;
  readonly tools?: Part;
}
interface Applied {
  readonly applied: boolean;
  readonly outcomes: readonly {
    readonly key: string;
    readonly result: string;
    readonly reason?: string;
  }[];
}

/** The tools row of each app's home, as the page in `space` shows it. */
async function page(space: string): Promise<Record<App, PageRow>> {
  const view = await call<{ rows: PageRow[] }>("/api/v1/machine/apps", { space });
  const of = (app: App): PageRow => {
    const found = view.rows.find(
      (r) => r.app === app && r.home !== null && sameFolder(r.home, HOME[app]()),
    );
    if (found === undefined) throw new Error(`no ${app} row`);
    return found;
  };
  return {
    "claude-code": of("claude-code"),
    codex: of("codex"),
    "claude-desktop": of("claude-desktop"),
  };
}

/** A home as the page shows it (`~` for the user's folder) is the scratch one. */
const sameFolder = (shown: string, path: string) =>
  (shown.startsWith("~") ? join(user, shown.slice(1)) : shown).toLowerCase() === path.toLowerCase();

const seenOnPage = (part: Part | undefined): Seen => {
  if (part === undefined) throw new Error("no tools switch");
  return s(
    part.on ? "on" : "off",
    part.why,
    part.change === "add",
    part.change === "remove" || part.off !== undefined,
  );
};

/** Each app's home as `ttasks setup agents --status --json` says it. */
async function cli(): Promise<Record<App, Seen>> {
  const ran = await runMain(["setup", "agents", "--status", "--json"], {
    home,
    tty: false,
    main: { agents: { env, home: user, systemApplications: join(user, "Apps") } },
  });
  expect(ran.code, ran.stderr).toBe(0);
  const homes = (
    JSON.parse(ran.stdout) as {
      homes: {
        app: string;
        home: string;
        tools: { status: Seen["status"]; why?: string; on?: string; off: boolean };
      }[];
    }
  ).homes;
  const of = (app: App): Seen => {
    const found = homes.find(
      (h) => h.app === app && h.home.toLowerCase() === HOME[app]().toLowerCase(),
    );
    if (found === undefined) throw new Error(`no ${app} home`);
    return s(found.tools.status, found.tools.why, found.tools.on !== undefined, found.tools.off);
  };
  return {
    "claude-code": of("claude-code"),
    codex: of("codex"),
    "claude-desktop": of("claude-desktop"),
  };
}

async function asPerson<T>(
  work: (call: (method: string, params: unknown) => Promise<unknown>) => Promise<T>,
) {
  const session = await classSession(home, service.endpoint.path, "cli-interactive");
  try {
    return await work((method, params) =>
      session.call(method, params as Record<string, unknown>, { timeoutMs: 30_000 }),
    );
  } finally {
    session.close();
  }
}

/** Nothing of setup's anywhere: no record, no row, each file as it was, the install in place. */
async function reset(): Promise<void> {
  writeFileSync(present(), "");
  await asPerson(async (person) => {
    const listed = (await person("setup/homes", {})) as { homes: { grant: string }[] };
    if (listed.homes.length > 0) {
      await person("setup/home_revoke", { grants: listed.homes.map((h) => h.grant) });
    }
  });
  rmSync(recordFile(), { force: true });
  rmSync(FILE["claude-code"](), { force: true });
  writeFileSync(FILE.codex(), BASE_TOML);
  writeFileSync(FILE["claude-desktop"](), "{}");
}

/** Changes TTasks's entry in an app's file by hand, in the file's own format. */
function byHand(app: App, change: "moved" | "edited" | "edited_gone" | "gone"): void {
  const file = FILE[app]();
  if (app === "codex") {
    const text = readFileSync(file, "utf8");
    const command = (to: string) =>
      text.replace(`command = ${valueText(present())}`, `command = ${valueText(to)}`);
    const next =
      change === "moved"
        ? command(old())
        : change === "edited_gone"
          ? command(nowhere())
          : change === "edited"
            ? text.replace("startup_timeout_sec = 20", "startup_timeout_sec = 21")
            : BASE_TOML;
    expect(next, `${app} ${change}`).not.toBe(text);
    writeFileSync(file, next);
    return;
  }
  const doc = JSON.parse(readFileSync(file, "utf8")) as {
    mcpServers: Record<string, Record<string, unknown>>;
  };
  const entry = doc.mcpServers[MCP_SERVER_KEY];
  if (entry === undefined) throw new Error(`no entry in ${app}`);
  if (change === "moved") entry["command"] = old();
  else if (change === "edited_gone") entry["command"] = nowhere();
  else if (change === "edited") entry["cwd"] = root;
  else Reflect.deleteProperty(doc.mcpServers, MCP_SERVER_KEY);
  writeFileSync(file, JSON.stringify(doc, null, 2));
}

/** Puts the three homes in the state a row of the table names. */
async function put(row: Row): Promise<void> {
  await reset();
  if (row.entry === "none") return;
  const space = spaces[row.space];
  const shown = await page(space);
  const applied = await call<Applied>("/api/v1/machine/apps_apply", {
    space,
    changes: APPS.map((app) => ({
      key: shown[app].key,
      part: "tools",
      on: true,
      plan: shown[app].tools?.plan,
    })),
  });
  expect(applied.outcomes.map((o) => o.result)).toEqual(["done", "done", "done"]);
  for (const app of APPS) {
    if (row.entry === "edited") byHand(app, row.program === "there" ? "edited" : "edited_gone");
    else if (row.entry === "gone") byHand(app, "gone");
    else if (row.program === "moved") byHand(app, "moved");
  }
  const record = JSON.parse(readFileSync(recordFile(), "utf8")) as {
    homes: { entry: { command: string }; state: string }[];
  };
  for (const h of record.homes) {
    if (row.entry === "own" && row.program === "moved") h.entry.command = old();
    if (row.entry === "removing") h.state = "removing";
  }
  writeFileSync(recordFile(), JSON.stringify(record));
  if (row.program === "gone" && row.entry !== "edited") renameSync(present(), `${present()}.away`);
  if (row.access === "off") {
    await asPerson(async (person) => {
      for (const app of APPS) await person("setup/home_revoke", { app, home: HOME[app]() });
    });
  }
}

const named = (row: Row) =>
  `${row.entry} entry, program ${row.program}, access ${row.access}, ${row.space} space`;

describe("[A3.3.13.setup.tools-table] One answer for each home's tools: what the page and the command line say and offer, and that what is offered is done", () => {
  test.each(TABLE.map((row) => [named(row), row] as const))(
    "%s",
    async (_name, row) => {
      await put(row);
      const shown = await page(spaces.here);
      const said = await cli();
      for (const app of APPS) {
        expect(seenOnPage(shown[app].tools), `page, ${app}`).toEqual(row.seen);
        expect(said[app], `command line, ${app}`).toEqual(row.cli ?? row.seen);
      }
      // Each action the page offers is carried out from here, and none is refused.
      for (const on of [true, false]) {
        if (on ? !row.seen.on : !row.seen.off) continue;
        await put(row);
        const before = await page(spaces.here);
        const applied = await call<Applied>("/api/v1/machine/apps_apply", {
          space: spaces.here,
          changes: APPS.map((app) => {
            const tools = before[app].tools;
            const plan = on || tools?.change === "remove" ? tools?.plan : tools?.off?.plan;
            return { key: before[app].key, part: "tools", on, plan };
          }),
        });
        expect(applied.applied, named(row)).toBe(true);
        expect(
          applied.outcomes.map((o) => o.result),
          `turned ${on ? "on" : "off"}`,
        ).toEqual(APPS.map(() => "done"));
        const after = await page(spaces.here);
        for (const app of APPS) {
          expect(seenOnPage(after[app].tools).status, `${app} turned ${on ? "on" : "off"}`).toBe(
            on ? "on" : "off",
          );
          // Off is off: nothing left to turn off.
          if (!on) expect(seenOnPage(after[app].tools).off, app).toBe(false);
        }
      }
      if (existsSync(`${present()}.away`)) renameSync(`${present()}.away`, present());
    },
    SLOW,
  );
});

/**
 * What one of the two settings files of Claude Code's default folder holds: setup's entry that
 * runs (`ours`), setup's entry naming where TTasks was installed before (`moved`), setup's entry
 * changed by hand (`edited`), a file that cannot be parsed (`broken`), or no entry (`none`).
 */
type Kind = "ours" | "moved" | "edited" | "broken" | "none";

/**
 * One row: the plain file's kind, the one inside the folder's, and what the row says for access
 * live, off and unconfirmed. Each answer is its status, its reasons as `why@file` (file 1 is the
 * plain one, 2 the one inside; a reason of the home's has none) in the order the row gives them,
 * whether turning on is offered, and whether turning off is.
 */
type FilesRow = readonly [Kind, Kind, live: Said, off: Said, unconfirmed: Said];
type Said = readonly [status: Seen["status"], reasons: string, on: boolean, off: boolean];

const FILES_TABLE: readonly FilesRow[] = [
  [
    "ours",
    "ours",
    ["on", "", false, true],
    ["off", "access_off", true, false],
    ["unknown", "", false, true],
  ],
  [
    "ours",
    "moved",
    ["on", "moved@2", true, true],
    ["off", "access_off moved@2", true, false],
    ["unknown", "moved@2", false, true],
  ],
  [
    "ours",
    "edited",
    ["on", "edited@2", false, true],
    ["off", "access_off edited@2", true, false],
    ["unknown", "edited@2", false, true],
  ],
  [
    "ours",
    "broken",
    ["on", "invalid_file@2", false, true],
    ["off", "access_off invalid_file@2", true, false],
    ["unknown", "invalid_file@2", false, true],
  ],
  [
    "ours",
    "none",
    ["on", "file_lacks@2", true, true],
    ["off", "access_off file_lacks@2", true, false],
    ["unknown", "file_lacks@2", false, true],
  ],
  [
    "moved",
    "ours",
    ["on", "moved@1", true, true],
    ["off", "access_off moved@1", true, false],
    ["unknown", "moved@1", false, true],
  ],
  [
    "moved",
    "moved",
    ["off", "moved@1 moved@2", true, true],
    ["off", "moved@1 moved@2", true, false],
    ["off", "moved@1 moved@2", false, true],
  ],
  [
    "moved",
    "edited",
    ["on", "moved@1 edited@2", true, true],
    ["off", "access_off moved@1 edited@2", true, false],
    ["unknown", "moved@1 edited@2", false, true],
  ],
  [
    "moved",
    "broken",
    ["off", "moved@1 invalid_file@2", true, true],
    ["off", "moved@1 invalid_file@2", true, false],
    ["off", "moved@1 invalid_file@2", false, true],
  ],
  [
    "moved",
    "none",
    ["off", "moved@1 file_lacks@2", true, true],
    ["off", "moved@1 file_lacks@2", true, false],
    ["off", "moved@1 file_lacks@2", false, true],
  ],
  [
    "edited",
    "ours",
    ["on", "edited@1", false, true],
    ["off", "access_off edited@1", true, false],
    ["unknown", "edited@1", false, true],
  ],
  [
    "edited",
    "moved",
    ["on", "edited@1 moved@2", true, true],
    ["off", "access_off edited@1 moved@2", true, false],
    ["unknown", "edited@1 moved@2", false, true],
  ],
  [
    "edited",
    "edited",
    ["on", "edited@1 edited@2", false, true],
    ["off", "edited@1 edited@2", false, false],
    ["unknown", "edited@1 edited@2", false, true],
  ],
  [
    "edited",
    "broken",
    ["on", "edited@1 invalid_file@2", false, true],
    ["off", "edited@1 invalid_file@2", false, false],
    ["unknown", "edited@1 invalid_file@2", false, true],
  ],
  [
    "edited",
    "none",
    ["on", "edited@1 file_lacks@2", true, true],
    ["off", "access_off edited@1 file_lacks@2", true, false],
    ["unknown", "edited@1 file_lacks@2", false, true],
  ],
  [
    "broken",
    "ours",
    ["on", "invalid_file@1", false, true],
    ["off", "access_off invalid_file@1", true, false],
    ["unknown", "invalid_file@1", false, true],
  ],
  [
    "broken",
    "moved",
    ["off", "invalid_file@1 moved@2", true, true],
    ["off", "invalid_file@1 moved@2", true, false],
    ["off", "invalid_file@1 moved@2", false, true],
  ],
  [
    "broken",
    "edited",
    ["on", "invalid_file@1 edited@2", false, true],
    ["off", "invalid_file@1 edited@2", false, false],
    ["unknown", "invalid_file@1 edited@2", false, true],
  ],
  [
    "broken",
    "broken",
    ["off", "invalid_file@1 invalid_file@2", false, true],
    ["off", "invalid_file@1 invalid_file@2", false, false],
    ["off", "invalid_file@1 invalid_file@2", false, true],
  ],
  [
    "broken",
    "none",
    ["off", "missing invalid_file@1", true, true],
    ["off", "missing invalid_file@1", true, false],
    ["off", "missing invalid_file@1", false, true],
  ],
  [
    "none",
    "ours",
    ["on", "file_lacks@1", true, true],
    ["off", "access_off file_lacks@1", true, false],
    ["unknown", "file_lacks@1", false, true],
  ],
  [
    "none",
    "moved",
    ["off", "file_lacks@1 moved@2", true, true],
    ["off", "file_lacks@1 moved@2", true, false],
    ["off", "file_lacks@1 moved@2", false, true],
  ],
  [
    "none",
    "edited",
    ["on", "file_lacks@1 edited@2", true, true],
    ["off", "access_off file_lacks@1 edited@2", true, false],
    ["unknown", "file_lacks@1 edited@2", false, true],
  ],
  [
    "none",
    "broken",
    ["off", "missing invalid_file@2", true, true],
    ["off", "missing invalid_file@2", true, false],
    ["off", "missing invalid_file@2", false, true],
  ],
  [
    "none",
    "none",
    ["off", "missing", true, true],
    ["off", "missing", true, false],
    ["off", "missing", false, true],
  ],
];

describe("[A3.3.13.setup.tools-table-files] One answer for a home with two settings files, from both: what the page and the command line say and offer for each pair of what the files hold, for access live, off and unconfirmed, and that what is offered is done", () => {
  const files = () => [join(user, ".claude.json"), join(user, ".claude", ".claude.json")] as const;
  /** A TTasks home with no service: the command line there cannot confirm any access. */
  const alone = () => join(root, "alone");

  /** Setup's entry in both files, then each file as `kinds` say, then the access. */
  async function putFiles(kinds: readonly [Kind, Kind], access: "live" | "off"): Promise<void> {
    await reset();
    writeFileSync(files()[0], "{}\n");
    writeFileSync(files()[1], '{"theme": "dark"}\n');
    const shown = (await page(spaces.here))["claude-code"];
    const applied = await call<Applied>("/api/v1/machine/apps_apply", {
      space: spaces.here,
      changes: [{ key: shown.key, part: "tools", on: true, plan: shown.tools?.plan }],
    });
    expect(applied.outcomes.map((o) => o.result)).toEqual(["done"]);
    const record = JSON.parse(readFileSync(recordFile(), "utf8")) as {
      homes: { app: string; entry: Record<string, unknown>; also: unknown[] }[];
    };
    const claude = record.homes.find((h) => h.app === "claude-code");
    if (claude === undefined) throw new Error("no Claude Code record");
    kinds.forEach((kind, i) => {
      const file = files()[i] as string;
      const doc = JSON.parse(readFileSync(file, "utf8")) as {
        mcpServers: Record<string, Record<string, unknown>>;
      };
      const entry = doc.mcpServers[MCP_SERVER_KEY] as Record<string, unknown>;
      if (kind === "moved") {
        // Setup's own entry, as an earlier install wrote it: the record knows it as its own.
        entry["command"] = old();
        claude.also.push({ ...claude.entry, command: old() });
      } else if (kind === "edited") entry["cwd"] = root;
      else if (kind === "none") Reflect.deleteProperty(doc.mcpServers, MCP_SERVER_KEY);
      writeFileSync(file, `${JSON.stringify(doc, null, 2)}${kind === "broken" ? ",\n" : "\n"}`);
    });
    writeFileSync(recordFile(), JSON.stringify(record));
    if (access === "off") {
      await asPerson(async (person) => {
        await person("setup/home_revoke", { app: "claude-code", home: HOME["claude-code"]() });
      });
    }
  }

  interface FilesPart extends Part {
    readonly whyFile?: string;
    readonly more?: readonly { readonly why: string; readonly file: string }[];
    readonly add?: { readonly plan: string };
  }

  /** A file as a row's reasons name it: 1 or 2, or none for the home's. */
  const which = (file: string | undefined): string => {
    if (file === undefined) return "";
    const path = file.startsWith("~") ? join(user, file.slice(1)) : file;
    const at = files().findIndex((f) => f.toLowerCase() === path.toLowerCase());
    return at === -1 ? `@${file}` : `@${String(at + 1)}`;
  };
  const reasons = (
    why: string | undefined,
    file: string | undefined,
    more: readonly { readonly why: string; readonly file: string }[] = [],
  ): string =>
    [
      ...(why === undefined ? [] : [`${why}${which(file)}`]),
      ...more.map((m) => `${m.why}${which(m.file)}`),
    ].join(" ");
  /** The page says a file it cannot read as one reason. */
  const onPage = (said: string) => said.replaceAll("invalid_file", "file_unreadable");

  async function cliSays(home: string): Promise<Said> {
    const ran = await runMain(["setup", "agents", "--status", "--json"], {
      home,
      tty: false,
      main: { agents: { env, home: user, systemApplications: join(user, "Apps") } },
    });
    expect(ran.code, ran.stderr).toBe(0);
    const found = (
      JSON.parse(ran.stdout) as {
        homes: {
          app: string;
          home: string;
          tools: {
            status: Seen["status"];
            why?: string;
            file?: string;
            more?: { why: string; file: string }[];
            on?: string;
            off: boolean;
          };
        }[];
      }
    ).homes.find(
      (h) =>
        h.app === "claude-code" && h.home.toLowerCase() === HOME["claude-code"]().toLowerCase(),
    );
    if (found === undefined) throw new Error("no Claude Code home");
    const { tools } = found;
    return [
      tools.status,
      reasons(tools.why, tools.file, tools.more),
      tools.on !== undefined,
      tools.off,
    ];
  }

  async function pageSays(): Promise<{ said: Said; part: FilesPart; key: string }> {
    const row = (await page(spaces.here))["claude-code"];
    const part = row.tools as FilesPart;
    return {
      said: [
        part.on ? "on" : "off",
        reasons(part.why, part.whyFile, part.more),
        part.change === "add" || part.add !== undefined,
        part.change === "remove" || part.off !== undefined,
      ],
      part,
      key: row.key,
    };
  }

  test.each(FILES_TABLE.map((row) => [`${row[0]} and ${row[1]}`, row] as const))(
    "%s",
    async (_name, [first, second, live, off, unconfirmed]) => {
      for (const [access, expected] of [
        ["live", live],
        ["off", off],
      ] as const) {
        await putFiles([first, second], access);
        const shown = await pageSays();
        expect(shown.said, `page, access ${access}`).toEqual([
          expected[0],
          onPage(expected[1]),
          expected[2],
          expected[3],
        ]);
        expect(await cliSays(home), `command line, access ${access}`).toEqual(expected);
        if (access === "live") {
          // The command line where no service answers, TTasks installed there too: the same
          // files and record, the access unconfirmed.
          mkdirSync(join(stateOf(alone()), "setup"), { recursive: true });
          mkdirSync(join(alone(), "bin"), { recursive: true });
          writeFileSync(join(alone(), "bin", tasksName), "");
          writeFileSync(join(stateOf(alone()), "setup", "agents.json"), readFileSync(recordFile()));
          expect(await cliSays(alone()), "command line, access unconfirmed").toEqual(unconfirmed);
          rmSync(alone(), { recursive: true, force: true });
        }

        // Each action offered is carried out from here, and none is refused.
        for (const on of [true, false]) {
          if (on ? !expected[2] : !expected[3]) continue;
          await putFiles([first, second], access);
          const before = await pageSays();
          const part = before.part;
          const plan = on
            ? part.change === "add"
              ? part.plan
              : part.add?.plan
            : part.change === "remove"
              ? part.plan
              : part.off?.plan;
          const applied = await call<Applied>("/api/v1/machine/apps_apply", {
            space: spaces.here,
            changes: [{ key: before.key, part: "tools", on, plan }],
          });
          const what = `${first} and ${second}, access ${access}, turned ${on ? "on" : "off"}`;
          expect(applied.applied, what).toBe(true);
          expect(
            applied.outcomes.map((o) => o.result),
            what,
          ).toEqual(["done"]);
          const after = await pageSays();
          // On is on with nothing more to turn on; off is off with nothing left to turn off.
          expect([after.said[0], after.said[on ? 2 : 3]], what).toEqual([on ? "on" : "off", false]);
          if (!on) {
            // Setup's own entries come out; the person's file and one it cannot read stay.
            for (const [i, kind] of [first, second].entries()) {
              const text = readFileSync(files()[i] as string, "utf8");
              if (kind === "edited" || kind === "broken")
                expect(text, what).toContain(MCP_SERVER_KEY);
              else expect(text, what).not.toContain(MCP_SERVER_KEY);
            }
          }
        }
      }
      rmSync(files()[1], { force: true });
    },
    SLOW,
  );
});
