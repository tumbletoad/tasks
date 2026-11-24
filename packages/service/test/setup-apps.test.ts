// `ttasks setup agents` for the remaining apps (A3 3.13.3, 3.13.5, 3.13.6; A7 3.11 M4.05): Claude
// Desktop's entry spliced in and out, the Codex app as a host of the default Codex home, and T3
// Code's provider instances' homes, with T3's settings only read. Apply and remove on scratch homes
// leave every file key-identical (byte-identical here).
//
// Every home and app folder here is one this test made under the OS's temporary folder, passed in
// through the environment setup reads (LOCALAPPDATA and APPDATA on Windows, XDG_CONFIG_HOME on
// Linux, T3CODE_HOME), and the apps' commands are testkit's fakes, run as real processes. No test
// reads or changes a real agent home, a real Claude Desktop, Codex app or T3 folder, or runs a
// real agent app's command.
import { spawnSync } from "node:child_process";
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
import { dirname, join, relative, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MCP_SERVER_KEY } from "@ttasks/brand";
import { detect, nodeDetectHost } from "@ttasks/launch";
import { installFakeAgents, type FakeAgents } from "@ttasks/testkit/fake-agents";
import {
  applyHome,
  claudeDesktopFolders,
  codexAppEngines,
  codexEngines,
  gitOnPath,
  planChange,
  planOf,
  readRecords,
  removeHome,
  runCommand,
  survey,
  t3HomesOf,
  type HomeView,
  type SetupInput,
} from "../src/setup/index.ts";
import { keptRows } from "./setup-rows.ts";
import { installedTasks } from "./harness.ts";

const SLOW = 180_000;
const SPACE = "sp_3z8sm956jp8dajmtsar5kx026c";
/** The service's rows, as these tests keep them. */
const ROWS = keptRows();
const windows = process.platform === "win32";
const BOM = "\u{FEFF}";
/** Another server's secret: it must never leave its file. */
const SENTINEL = "sentinel-secret-5b1c";

let base: string;
/** The git on this test's PATH, which rule 3 of A3 3.12 asks (the fakes' PATH has none). */
let gitCommand: readonly string[];
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "ttasks-setup-apps-"));
  const found = gitOnPath(process.platform, process.env);
  if (found === undefined) throw new Error("these tests need git on the PATH");
  gitCommand = found;
});
afterAll(() => {
  // This file's own folder, by its full name. Retried: on Windows a fake's working folder can stay
  // in use for a moment after it ends.
  rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

interface World {
  readonly root: string;
  readonly home: string;
  readonly state: string;
  readonly tasks: string;
  readonly fakes: FakeAgents;
}

let worlds = 0;
function world(label: string): World {
  worlds += 1;
  const root = join(base, `${label}-${String(worlds)}`);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return {
    root,
    home,
    state: join(root, "state"),
    tasks: installedTasks(root),
    fakes: installFakeAgents(join(root, "tools"), home),
  };
}

async function inputOf(w: World, extra: Record<string, string> = {}): Promise<SetupInput> {
  const env = { ...w.fakes.env, ...extra };
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

/** Where this OS keeps Claude Desktop's file, inside the world, and the variables that say so. */
function desktopPlace(w: World): { env: Record<string, string>; folder: string; second?: string } {
  if (windows) {
    const local = join(w.root, "local");
    const roaming = join(w.root, "roaming");
    return {
      env: { LOCALAPPDATA: local, APPDATA: roaming },
      folder: join(local, "Claude-Data", "claude_pkg7"),
      second: join(roaming, "Claude"),
    };
  }
  if (process.platform === "darwin") {
    return { env: {}, folder: join(w.home, "Library", "Application Support", "Claude") };
  }
  const xdg = join(w.root, "xdg");
  return { env: { XDG_CONFIG_HOME: xdg }, folder: join(xdg, "Claude") };
}

const DESKTOP_JSON = `${BOM}${[
  "{",
  '    "mcpServers": {',
  '        "other": {',
  '            "command": "/opt/other",',
  '            "args": ["serve"],',
  `            "env": {"TOKEN": "${SENTINEL}"}`,
  "        }",
  "    },",
  '    "preferences": {"quickEntryShortcut": "off"}',
  "}",
  "",
].join("\r\n")}`;

const only = (views: readonly HomeView[], app: string): HomeView => {
  const found = views.filter((v) => v.home.app === app);
  if (found.length !== 1 || found[0] === undefined) throw new Error(`not one ${app} home`);
  return found[0];
};

const byFolder = (views: readonly HomeView[], app: string, folder: string): HomeView => {
  const view = views.find((v) => v.home.app === app && v.home.home.endsWith(folder));
  if (view === undefined) throw new Error(`no ${app} home ${folder}`);
  return view;
};

const mcpCalls = (w: World) => w.fakes.calls().filter((c) => c.args[0] === "mcp");

describe("[A3.3.13.setup.apps] setup for Claude Desktop, the Codex app and T3's homes on scratch homes", () => {
  test(
    "Claude Desktop: one entry spliced in, then out, leaving the file byte-identical",
    async () => {
      const w = world("desktop");
      const place = desktopPlace(w);
      mkdirSync(place.folder, { recursive: true });
      const file = join(place.folder, "claude_desktop_config.json");
      writeFileSync(file, DESKTOP_JSON);
      if (!windows) chmodSync(file, 0o640);
      const before = readFileSync(file);
      const input = await inputOf(w, place.env);

      const view = only(await survey(input), "claude-desktop");
      expect(view.home).toMatchObject({ instance: "claude-desktop", file, hosts: [] });
      expect(view.state).toBe("not_registered");
      const change = planChange(input, view, SPACE);
      if (typeof change === "string") throw new Error(change);
      const argv = [
        w.tasks,
        "mcp",
        "--space",
        SPACE,
        "--instance",
        "claude-desktop",
        "--app",
        "claude-desktop",
      ];
      expect(change.entry).toEqual({ command: w.tasks, args: argv.slice(1) });
      expect(change.diff).toEqual([
        `+ mcpServers.${MCP_SERVER_KEY}.command = ${JSON.stringify(w.tasks)}`,
        `+ mcpServers.${MCP_SERVER_KEY}.args = ${JSON.stringify(argv.slice(1))}`,
      ]);
      expect(readFileSync(file)).toEqual(before);

      expect(await applyHome(input, view, SPACE, ROWS)).toMatchObject({ result: "applied" });
      const text = readFileSync(file, "utf8");
      expect(text.startsWith(BOM)).toBe(true);
      expect(text.replaceAll("\r\n", "")).not.toContain("\n");
      const doc = JSON.parse(text.slice(1)) as {
        mcpServers: Record<string, unknown>;
        preferences: unknown;
      };
      expect(doc.mcpServers[MCP_SERVER_KEY]).toEqual({ command: w.tasks, args: argv.slice(1) });
      expect(doc.mcpServers["other"]).toEqual({
        command: "/opt/other",
        args: ["serve"],
        env: { TOKEN: SENTINEL },
      });
      expect(doc.preferences).toEqual({ quickEntryShortcut: "off" });
      if (!windows) expect(statSync(file).mode & 0o777).toBe(0o640);
      // No command ran: Claude Desktop has none, setup wrote the one entry itself.
      expect(mcpCalls(w)).toEqual([]);
      const [record] = readRecords(w.state);
      expect(record).toMatchObject({
        app: "claude-desktop",
        state: "applied",
        entry: { command: w.tasks, args: argv.slice(1) },
        grant: ROWS.live.find((row) => row.home === view.home.home)?.grant,
      });
      expect(JSON.stringify(readRecords(w.state))).not.toContain(SENTINEL);

      const registered = only(await survey(input), "claude-desktop");
      expect(registered.state).toBe("registered");
      expect((await applyHome(input, registered, SPACE, ROWS)).result).toBe("unchanged");
      expect(await removeHome(input, registered, ROWS)).toMatchObject({ result: "removed" });
      expect(readFileSync(file)).toEqual(before);
      expect(readRecords(w.state)).toEqual([]);
      if (!windows) expect(statSync(file).mode & 0o777).toBe(0o640);
    },
    SLOW,
  );

  test(
    "Claude Desktop: a servers table setup made goes with its entry; no file, no change; an edited entry stays",
    async () => {
      const w = world("desktop-more");
      const place = desktopPlace(w);
      mkdirSync(place.folder, { recursive: true });
      const input = await inputOf(w, place.env);
      const file = join(place.folder, "claude_desktop_config.json");

      // The app has not made its file yet: setup does not create it.
      const unset = only(await survey(input), "claude-desktop");
      expect(planChange(input, unset, SPACE)).toBe("not_set_up");
      expect(await applyHome(input, unset, SPACE, ROWS)).toMatchObject({
        result: "left",
        reason: "not_set_up",
      });
      expect(existsSync(file)).toBe(false);

      // A file without servers: the table comes and goes with the entry.
      const bare = '{\n  "preferences": {\n    "menuBarEnabled": true\n  }\n}\n';
      writeFileSync(file, bare);
      const view = only(await survey(input), "claude-desktop");
      const change = planChange(input, view, SPACE);
      expect(typeof change !== "string" && change.diff[0]).toBe("+ mcpServers = {}");
      expect((await applyHome(input, view, SPACE, ROWS)).result).toBe("applied");
      expect(
        await removeHome(input, only(await survey(input), "claude-desktop"), ROWS),
      ).toMatchObject({
        result: "removed",
      });
      expect(readFileSync(file, "utf8")).toBe(bare);

      // Changed by hand after apply: turning it off takes the access away and leaves the entry,
      // the person's from then on.
      expect(
        (await applyHome(input, only(await survey(input), "claude-desktop"), SPACE, ROWS)).result,
      ).toBe("applied");
      const edited = readFileSync(file, "utf8").replace('"--app"', '"--app-x"');
      writeFileSync(file, edited);
      const changed = only(await survey(input), "claude-desktop");
      expect(changed.state).toBe("edited");
      expect(await removeHome(input, changed, ROWS)).toMatchObject({
        result: "left",
        reason: "edited",
        access: "off",
        kept: "edited",
      });
      expect(readFileSync(file, "utf8")).toBe(edited);
      expect(readRecords(w.state)).toEqual([]);

      // A file over machine.toml's 1 MiB bound but within Claude Desktop's own: written and taken
      // back under the app's bound, at every read.
      const big = world("desktop-big");
      const bigPlace = desktopPlace(big);
      mkdirSync(bigPlace.folder, { recursive: true });
      const bigFile = join(bigPlace.folder, "claude_desktop_config.json");
      const large = `{\n  "preferences": {\n    "note": "${"x".repeat(1_200_000)}"\n  }\n}\n`;
      writeFileSync(bigFile, large);
      const bigInput = await inputOf(big, bigPlace.env);
      expect(
        (await applyHome(bigInput, only(await survey(bigInput), "claude-desktop"), SPACE, ROWS))
          .result,
      ).toBe("applied");
      expect(
        await removeHome(bigInput, only(await survey(bigInput), "claude-desktop"), ROWS),
      ).toMatchObject({
        result: "removed",
      });
      expect(readFileSync(bigFile, "utf8")).toBe(large);
    },
    SLOW,
  );

  test(
    "several Claude Desktop files: none is changed until --home names one",
    async () => {
      const w = world("desktop-two");
      const place = desktopPlace(w);
      mkdirSync(place.folder, { recursive: true });
      writeFileSync(join(place.folder, "claude_desktop_config.json"), "{}");
      if (place.second !== undefined) {
        // Windows: the MSIX app's folder and a classic install's, both with a file.
        mkdirSync(place.second, { recursive: true });
        writeFileSync(join(place.second, "claude_desktop_config.json"), "{}");
      }
      const input = await inputOf(w, place.env);
      const found = (await survey(input)).filter((v) => v.home.app === "claude-desktop");
      const [first] = found;
      if (first === undefined) throw new Error("no Claude Desktop home");
      if (place.second !== undefined) {
        expect(claudeDesktopFolders(input)).toEqual([place.folder, place.second]);
        expect(found).toHaveLength(2);
      }
      // A second candidate beside the first: found on Windows, made up elsewhere (one place only).
      const second: HomeView = found[1] ?? {
        ...first,
        home: { ...first.home, home: join(w.root, "other"), file: join(w.root, "other", "c.json") },
      };
      expect(planOf(input, [first, second], SPACE).map((i) => i.change)).toEqual([
        "ambiguous",
        "ambiguous",
      ]);
      expect(planOf(input, [first], SPACE)[0]?.change).toMatchObject({
        entry: { command: w.tasks },
      });
      expect(await applyHome(input, first, SPACE, ROWS, "ambiguous")).toMatchObject({
        result: "left",
        reason: "ambiguous",
      });
      expect(readFileSync(join(place.folder, "claude_desktop_config.json"), "utf8")).toBe("{}");

      // A second file setup cannot read (it does not parse) still counts: the app may use it.
      const brokenFile =
        place.second !== undefined
          ? join(place.second, "claude_desktop_config.json")
          : join(w.root, "other", "c.json");
      mkdirSync(dirname(brokenFile), { recursive: true });
      writeFileSync(brokenFile, "{ not json");
      const again = (await survey(input)).filter((v) => v.home.app === "claude-desktop");
      const broken: HomeView = again[1] ?? {
        ...first,
        home: { ...first.home, home: dirname(brokenFile), file: brokenFile },
        state: "refused",
        refusal: "invalid_file",
        sha256: null,
      };
      expect(broken).toMatchObject({ state: "refused", sha256: null });
      expect(planOf(input, [first, broken], SPACE).map((i) => i.change)).toEqual([
        "ambiguous",
        undefined,
      ]);
    },
    SLOW,
  );

  test(
    "T3 Code: its provider instances' homes are offered and marked as read by T3; its settings are only read",
    async () => {
      const w = world("t3");
      for (const folder of [".codex", ".codex_second", "work-claude", "off-claude"]) {
        mkdirSync(join(w.home, folder));
      }
      const t3 = join(w.home, ".t3", "userdata");
      mkdirSync(t3, { recursive: true, mode: 0o700 });
      const settings = join(t3, "settings.json");
      // T3's own shape (A3 3.13.6): a renamed default, added instances with config.homePath, one
      // turned off, and an agent that is not TTasks's.
      writeFileSync(
        settings,
        JSON.stringify(
          {
            providerInstances: {
              codex: { driver: "codex", displayName: "Codex", enabled: true },
              codex_second: {
                driver: "codex",
                displayName: "Codex Second",
                enabled: true,
                config: {
                  homePath: "~/.codex_second",
                  shadowHomePath: join(w.home, ".t3", "shadow", "codex-second"),
                },
              },
              claude_work: {
                driver: "claudeAgent",
                displayName: "Claude Work",
                enabled: true,
                environment: [{ name: "ANTHROPIC_API_KEY", value: SENTINEL, sensitive: true }],
                config: { homePath: join(w.home, "work-claude") },
              },
              claude_off: {
                driver: "claudeAgent",
                enabled: false,
                config: { homePath: join(w.home, "off-claude") },
              },
              opencode: { driver: "opencode", enabled: true, config: {} },
            },
            apiKey: SENTINEL,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      const before = readFileSync(settings);
      const input = await inputOf(w);
      const views = await survey(input);
      expect(
        views.map((v) => [v.home.app, v.home.instance, v.home.hosts, v.home.isDefault]).sort(),
      ).toEqual(
        [
          ["claude-code", "claude-work", ["t3"], false],
          ["codex", "codex", ["t3"], true],
          ["codex", "codex-second", ["t3"], false],
        ].sort(),
      );
      const work = byFolder(views, "claude-code", "work-claude");
      expect(work.home.file).toBe(join(w.home, "work-claude", ".claude.json"));

      for (const view of views) {
        expect(await applyHome(input, view, SPACE, ROWS), view.home.instance).toMatchObject({
          result: "applied",
        });
      }
      // Each entry went into the file of the home T3 gives its instance.
      for (const file of [
        join(w.home, "work-claude", ".claude.json"),
        join(w.home, ".codex", "config.toml"),
        join(w.home, ".codex_second", "config.toml"),
      ]) {
        expect(readFileSync(file, "utf8"), file).toContain(MCP_SERVER_KEY);
      }
      for (const view of await survey(input)) {
        expect((await removeHome(input, view, ROWS)).result, view.home.instance).toBe("removed");
      }
      // T3's own file was read, never written, and its values went nowhere.
      expect(readFileSync(settings)).toEqual(before);
      expect(existsSync(join(w.state, "setup", "agents.json"))).toBe(true);
      expect(readFileSync(join(w.state, "setup", "agents.json"), "utf8")).not.toContain(SENTINEL);

      // T3CODE_HOME names another T3 folder: its settings are the ones read.
      const elsewhere = join(w.root, "t3-elsewhere", "userdata");
      mkdirSync(elsewhere, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(elsewhere, "settings.json"),
        JSON.stringify({
          providerInstances: {
            codex_second: {
              driver: "codex",
              config: { homePath: join(w.home, ".codex_second") },
            },
          },
        }),
        { mode: 0o600 },
      );
      const named = await inputOf(w, { T3CODE_HOME: join(w.root, "t3-elsewhere") });
      // Its instance, and T3's default Codex instance, which the file does not list.
      expect(
        (await survey(named))
          .filter((v) => v.home.hosts.includes("t3"))
          .map((v) => v.home.instance)
          .sort(),
      ).toEqual(["codex", "codex-second"]);
      if (!windows) {
        // A settings file anyone can change, or a link, is not believed: what it says about its
        // instances is not used, and only T3's default homes are taken as its (here `.codex`).
        const t3Hosted = async () =>
          (await survey(named))
            .filter((v) => v.home.hosts.includes("t3"))
            .map((v) => v.home.instance);
        chmodSync(join(elsewhere, "settings.json"), 0o646);
        expect(await t3Hosted()).toEqual(["codex"]);
        rmSync(join(elsewhere, "settings.json"));
        symlinkSync(settings, join(elsewhere, "settings.json"));
        expect(await t3Hosted()).toEqual(["codex"]);
      }

      // T3 names Claude Code's default folder by its path: its Claude then reads `.claude.json`
      // inside that folder, not the user's `~/.claude.json` where the default home's entry goes, so
      // that home is not marked as read by T3.
      mkdirSync(join(w.home, ".claude"));
      const explicitT3 = join(w.root, "t3-explicit", "userdata");
      mkdirSync(explicitT3, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(explicitT3, "settings.json"),
        JSON.stringify({
          providerInstances: {
            claudeAgent: { driver: "claudeAgent", config: { homePath: join(w.home, ".claude") } },
          },
        }),
        { mode: 0o600 },
      );
      const explicit = await inputOf(w, { T3CODE_HOME: join(w.root, "t3-explicit") });
      expect(byFolder(await survey(explicit), "claude-code", ".claude").home).toMatchObject({
        isDefault: true,
        file: join(w.home, ".claude.json"),
        hosts: [],
      });
      expect(t3HomesOf(explicit)).toEqual([
        {
          app: "claude-code",
          provider: "claudeAgent",
          home: join(w.home, ".claude"),
          isDefault: false,
        },
        // T3's default Codex instance, which the file does not list.
        { app: "codex", provider: "codex", home: join(w.home, ".codex"), isDefault: true },
      ]);

      if (!windows) {
        // A Codex shadow home (its config.toml a link into another home) is no home of its own:
        // the home it links to is offered in its place and names it. (Windows links a file only
        // with an elevated right or developer mode.)
        writeFileSync(join(w.home, ".codex", "config.toml"), "");
        mkdirSync(join(w.home, ".codex", "sessions"));
        mkdirSync(join(w.home, ".codex-linked"));
        for (const name of ["config.toml", "sessions"]) {
          symlinkSync(join(w.home, ".codex", name), join(w.home, ".codex-linked", name));
        }
        const linked = await survey(await inputOf(w));
        expect(linked.some((v) => v.home.home.endsWith(".codex-linked"))).toBe(false);
        expect(byFolder(linked, "codex", `${sep}.codex`).home.shadows).toEqual([
          join(w.home, ".codex-linked"),
        ]);
        rmSync(join(w.home, ".codex-linked"), { recursive: true });
        rmSync(join(w.home, ".codex", "sessions"), { recursive: true });
        rmSync(join(w.home, ".codex", "config.toml"));
      }
    },
    SLOW,
  );

  test(
    "the Codex app: a host of the default Codex home, its bundled engine the command when no CLI is there",
    async () => {
      const w = world("codex-app");
      mkdirSync(join(w.home, ".codex"));
      if (!windows) {
        // The app has no build here: no engine, no host.
        const input = await inputOf(w);
        expect(codexAppEngines(input)).toEqual([]);
        expect(only(await survey(input), "codex").home.hosts).toEqual([]);
        return;
      }
      const local = join(w.root, "local");
      const engine = join(local, "OpenAI", "Codex", "bin", "4f2a9c", "codex.exe");
      mkdirSync(join(engine, ".."), { recursive: true });
      writeFileSync(engine, "");
      const fake = join(
        w.root,
        "tools",
        "bin",
        "node_modules",
        "@openai",
        "codex",
        "bin",
        "codex.js",
      );
      const found = await inputOf(w, { LOCALAPPDATA: local });
      // No Codex CLI on this PATH: only the app's engine reads the home, and setup writes it.
      const input: SetupInput = {
        ...found,
        detection: {
          ...found.detection,
          commands: found.detection.commands.filter((c) => c.target !== "codex-cli"),
        },
        run: (argv, env) =>
          found.run(argv[0] === engine ? [process.execPath, fake, ...argv.slice(1)] : argv, env),
      };
      expect(codexAppEngines(input)).toEqual([engine]);
      const view = only(await survey(input), "codex");
      expect(view.home).toMatchObject({ instance: "codex", hosts: ["codex-app"] });
      expect(codexEngines(input, view.home)).toEqual([{ kind: "app", exec: [engine] }]);
      expect((await applyHome(input, view, SPACE, ROWS)).result).toBe("applied");
      expect(readFileSync(join(w.home, ".codex", "config.toml"), "utf8")).toContain(
        `[mcp_servers.${MCP_SERVER_KEY}]`,
      );
      expect(await removeHome(input, only(await survey(input), "codex"), ROWS)).toMatchObject({
        result: "removed",
      });
      // The file setup made for its entry is gone again.
      expect(existsSync(join(w.home, ".codex", "config.toml"))).toBe(false);
    },
    SLOW,
  );

  test(
    "a home whose file machine.toml lists as managed is left alone and nothing runs there",
    async () => {
      const w = world("managed");
      mkdirSync(join(w.home, ".codex"));
      writeFileSync(join(w.home, ".codex", "config.toml"), 'model = "m"\n');
      const place = desktopPlace(w);
      mkdirSync(place.folder, { recursive: true });
      writeFileSync(join(place.folder, "claude_desktop_config.json"), "{}");
      const input: SetupInput = {
        ...(await inputOf(w, place.env)),
        managedPaths: [join(w.home, ".codex"), join(place.folder, "claude_desktop_config.json")],
      };
      for (const app of ["codex", "claude-desktop"]) {
        const view = only(await survey(input), app);
        expect([app, view.state, view.refusal]).toEqual([app, "refused", "managed"]);
        expect(await applyHome(input, view, SPACE, ROWS)).toMatchObject({
          result: "left",
          reason: "managed",
        });
      }
      expect(mcpCalls(w)).toEqual([]);
      expect(readFileSync(join(place.folder, "claude_desktop_config.json"), "utf8")).toBe("{}");
      expect(existsSync(join(w.state, "setup", "agents.json"))).toBe(false);
    },
    SLOW,
  );

  test(
    "Claude Desktop: a file a repository tracks through linked git metadata is managed, for apply and for remove",
    async () => {
      // Not registered yet: apply leaves the tracked file as it is and records nothing.
      const w = world("linked-git");
      const place = desktopPlace(w);
      mkdirSync(place.folder, { recursive: true });
      const file = join(place.folder, "claude_desktop_config.json");
      writeFileSync(file, DESKTOP_JSON);
      const before = readFileSync(file);
      const repo = linkedRepository(w.root);
      const input: SetupInput = { ...(await inputOf(w, place.env)), git: gitCommand };
      // In the repository, not tracked: git says so, and setup goes on.
      expect(only(await survey(input), "claude-desktop").state).toBe("not_registered");
      repo(["add", pathIn(w.root, file)]);
      const view = only(await survey(input), "claude-desktop");
      expect([view.state, view.refusal]).toEqual(["refused", "managed"]);
      expect(await applyHome(input, view, SPACE, ROWS)).toMatchObject({
        result: "left",
        reason: "managed",
      });
      expect(readFileSync(file)).toEqual(before);
      expect(existsSync(join(w.state, "setup", "agents.json"))).toBe(false);

      // Registered while no repository held the file, then tracked: remove leaves the entry.
      const r = world("linked-git-remove");
      const at = desktopPlace(r);
      mkdirSync(at.folder, { recursive: true });
      const registered = join(at.folder, "claude_desktop_config.json");
      writeFileSync(registered, DESKTOP_JSON);
      const later: SetupInput = { ...(await inputOf(r, at.env)), git: gitCommand };
      expect(
        await applyHome(later, only(await survey(later), "claude-desktop"), SPACE, ROWS),
      ).toMatchObject({ result: "applied" });
      const applied = readFileSync(registered);
      linkedRepository(r.root)(["add", pathIn(r.root, registered)]);
      const now = only(await survey(later), "claude-desktop");
      expect([now.state, now.refusal]).toEqual(["refused", "managed"]);
      expect(await removeHome(later, now, ROWS)).toMatchObject({
        result: "left",
        reason: "managed",
      });
      expect(readFileSync(registered)).toEqual(applied);
      expect(readRecords(r.state)).toHaveLength(1);
    },
    SLOW,
  );
});

/** A file's path in the work tree at `root`, as git names it. */
const pathIn = (root: string, file: string): string => relative(root, file).split(sep).join("/");

/**
 * Makes `root` a git work tree whose `.git` is a link (a junction on Windows) to its metadata in a
 * sibling folder, and returns git run there, with no system or global configuration.
 */
function linkedRepository(root: string): (args: string[]) => void {
  const global = `${root}-gitconfig`;
  writeFileSync(global, "");
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")),
    ),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: global,
  };
  const git = (args: string[]) => {
    const run = spawnSync("git", args, { cwd: root, env, encoding: "utf8", windowsHide: true });
    if (run.status !== 0) throw new Error(`git ${args[0] ?? ""} failed: ${run.stderr}`);
  };
  const meta = `${root}-git`;
  git(["init", "-q", `--separate-git-dir=${meta}`, root]);
  rmSync(join(root, ".git"));
  symlinkSync(meta, join(root, ".git"), windows ? "junction" : "dir");
  return git;
}
