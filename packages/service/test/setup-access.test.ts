// A home's access follows its entry: setup gives the agent-home row only once the entry is in
// place, takes it back before it touches the file, and settles a run that ended midway at the next
// setup. Scratch homes only, under the OS's temporary folder; the grants table is the test's own
// (setup-rows.ts), which records each call and can refuse.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MCP_SERVER_KEY } from "@ttasks/brand";
import { detect, nodeDetectHost } from "@ttasks/launch";
import { installFakeAgents } from "@ttasks/testkit/fake-agents";
import {
  applyHome,
  readRecords,
  removeHome,
  runCommand,
  settleHomes,
  survey,
  writeRecords,
  type HomeView,
  type SetupInput,
} from "../src/setup/index.ts";
import { keptRows } from "./setup-rows.ts";

const SLOW = 120_000;
const SPACE = "sp_3z8sm956jp8dajmtsar5kx026c";
const windows = process.platform === "win32";
/** Root ignores a file's mode: the cases that need an unwritable file cannot be made. */
const root = process.getuid?.() === 0;

let base: string;
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "ttasks-setup-access-"));
});
afterAll(() => {
  rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

let worlds = 0;
/** A scratch user home with Claude Desktop's file (`{}` by default) where this OS keeps it. */
async function world(text = "{}\n"): Promise<{ input: SetupInput; file: string }> {
  worlds += 1;
  const dir = join(base, String(worlds));
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const fakes = installFakeAgents(join(dir, "tools"), home);
  const env: Record<string, string> = { ...fakes.env };
  let folder: string;
  if (windows) {
    env["APPDATA"] = join(dir, "roaming");
    env["LOCALAPPDATA"] = join(dir, "local");
    folder = join(dir, "roaming", "Claude");
  } else if (process.platform === "darwin") {
    folder = join(home, "Library", "Application Support", "Claude");
  } else {
    env["XDG_CONFIG_HOME"] = join(dir, "xdg");
    folder = join(dir, "xdg", "Claude");
  }
  mkdirSync(folder, { recursive: true });
  const file = join(folder, "claude_desktop_config.json");
  writeFileSync(file, text);
  return {
    file,
    input: {
      platform: process.platform,
      userHome: home,
      env,
      stateDir: join(dir, "state"),
      tasks: join(dir, "install", "bin", windows ? "ttasks.exe" : "ttasks"),
      detection: await detect(nodeDetectHost({ env, home, timeoutMs: 30_000 })),
      instances: [],
      systemApplications: join(dir, "Applications"),
      isFolder: (path) => existsSync(path) && statSync(path).isDirectory(),
      run: (argv, childEnv) => runCommand(argv, childEnv, home),
    },
  };
}

async function desktop(input: SetupInput): Promise<HomeView> {
  const found = (await survey(input)).find((v) => v.home.app === "claude-desktop");
  if (found === undefined) throw new Error("no Claude Desktop home");
  return found;
}

const hasEntry = (file: string): boolean =>
  (JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, unknown> }).mcpServers?.[
    MCP_SERVER_KEY
  ] !== undefined;

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

describe("[A3.3.13.setup.access] a home's access follows its entry", () => {
  test(
    "the access is given once the entry is in place, and taken back before the entry comes out",
    async () => {
      const { input, file } = await world();
      const seen: string[] = [];
      const rows = keptRows((verb) => {
        seen.push(`${verb} with the entry ${hasEntry(file) ? "in" : "out of"} its file`);
      });
      expect(await applyHome(input, await desktop(input), SPACE, rows)).toMatchObject({
        result: "applied",
        access: "on",
      });
      expect(rows.live).toHaveLength(1);
      expect(readRecords(input.stateDir)).toMatchObject([
        { state: "applied", grant: rows.live[0]?.grant },
      ]);
      expect(await removeHome(input, await desktop(input), rows)).toMatchObject({
        result: "removed",
        access: "off",
      });
      expect(seen).toEqual([
        "grant with the entry in its file",
        "revoke with the entry in its file",
      ]);
      expect(rows.live).toEqual([]);
      expect(readFileSync(file, "utf8")).toBe("{}\n");
    },
    SLOW,
  );

  test(
    "a refused row, and a file that cannot be written, leave the home without access and its file as it was",
    async () => {
      const { input, file } = await world();
      const rows = keptRows();
      rows.refuse.grant = "instance_taken";
      expect(await applyHome(input, await desktop(input), SPACE, rows)).toMatchObject({
        result: "failed",
        reason: "instance_taken",
        access: "off",
      });
      expect(readFileSync(file, "utf8")).toBe("{}\n");
      expect(rows.live).toEqual([]);
      expect(readRecords(input.stateDir)).toEqual([]);

      if (root) return;
      rows.refuse = {};
      const restore = unwritable(file);
      try {
        expect(await applyHome(input, await desktop(input), SPACE, rows)).toMatchObject({
          result: "failed",
          reason: "unwritable",
          access: "off",
        });
      } finally {
        restore();
      }
      expect(readFileSync(file, "utf8")).toBe("{}\n");
      expect(rows.asked.filter((a) => a.verb === "grant")).toHaveLength(1);
      expect(rows.live).toEqual([]);
      expect(readRecords(input.stateDir)).toEqual([]);
    },
    SLOW,
  );

  test(
    "turning off takes the access away whatever the file holds, and says what stays there",
    async () => {
      const { input, file } = await world();
      const rows = keptRows();

      // An entry the person changed: the access goes, the entry stays theirs.
      await applyHome(input, await desktop(input), SPACE, rows);
      const changed = readFileSync(file, "utf8").replace('"--app"', '"--app-x"');
      writeFileSync(file, changed);
      expect(await removeHome(input, await desktop(input), rows)).toMatchObject({
        result: "left",
        reason: "edited",
        access: "off",
        kept: "edited",
      });
      expect(rows.live).toEqual([]);
      expect(readFileSync(file, "utf8")).toBe(changed);
      expect(readRecords(input.stateDir)).toEqual([]);

      // A file that cannot be written: the access goes, TTasks's entry waits for the next setup.
      writeFileSync(file, "{}\n");
      await applyHome(input, await desktop(input), SPACE, rows);
      if (root) return;
      const restore = unwritable(file);
      try {
        expect(await removeHome(input, await desktop(input), rows)).toMatchObject({
          result: "failed",
          reason: "unwritable",
          access: "off",
          kept: "own",
        });
      } finally {
        restore();
      }
      expect(rows.live).toEqual([]);
      expect(hasEntry(file)).toBe(true);
      expect((await desktop(input)).state).toBe("interrupted");
      // The next setup settles it, once.
      expect(await settleHomes(input, rows)).toMatchObject([{ result: "removed", access: "off" }]);
      expect(readFileSync(file, "utf8")).toBe("{}\n");
      expect(await settleHomes(input, rows)).toEqual([]);
    },
    SLOW,
  );

  test(
    "a revoke that fails still takes the entry out, says the access is unknown, and is done again by the next setup",
    async () => {
      const { input, file } = await world();
      const rows = keptRows();
      await applyHome(input, await desktop(input), SPACE, rows);
      rows.refuse.revoke = true;
      expect(await removeHome(input, await desktop(input), rows)).toMatchObject({
        result: "removed",
        access: "unknown",
      });
      expect(readFileSync(file, "utf8")).toBe("{}\n");
      expect(rows.live).toHaveLength(1);
      expect(readRecords(input.stateDir)).toMatchObject([{ state: "removing" }]);
      rows.refuse = {};
      expect(await settleHomes(input, rows)).toMatchObject([{ access: "off" }]);
      expect(rows.live).toEqual([]);
      expect(readRecords(input.stateDir)).toEqual([]);
    },
    SLOW,
  );

  test(
    "a run that ended between the entry and its access is settled once by the next setup",
    async () => {
      const { input, file } = await world();
      const rows = keptRows();
      await applyHome(input, await desktop(input), SPACE, rows);
      // As a run leaves it when it ends after writing the entry, before the access was given.
      const [record] = readRecords(input.stateDir);
      if (record === undefined) throw new Error("no record");
      writeRecords(input.stateDir, [{ ...record, state: "applying", grant: null }]);
      expect((await desktop(input)).state).toBe("interrupted");
      expect(await settleHomes(input, rows)).toMatchObject([{ result: "removed", access: "off" }]);
      expect(rows.live).toEqual([]);
      expect(readFileSync(file, "utf8")).toBe("{}\n");
      expect(readRecords(input.stateDir)).toEqual([]);
      expect(await settleHomes(input, rows)).toEqual([]);
    },
    SLOW,
  );
});
