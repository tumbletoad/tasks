// A2 3.2.1: the person's data and configuration live in ~/.ttasks, the program elsewhere, and
// removing or updating the program never removes anything in ~/.ttasks. On this tree the commands
// that remove anything outside a space are `ttasks service uninstall` and its clean-up of what
// install made; the program's own install, update and uninstall (M1.14, M6.12) extend this test
// when they arrive. Each case fills a daily install's data folder under a stand-in home, runs
// service install and uninstall through the entries the CLI uses, and compares the folder file by
// file. Nothing here touches the real home, PATH, registry or autostart places (install-fakes.ts).
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { makeDir } from "../src/hub/files.ts";
import { serviceEntry } from "../src/install/entries.ts";
import { captureIO, fakeContext, snapshot, type FakeContext } from "./install-fakes.ts";

let dir = "";
beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ttasks-data-folder-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const run = async (fake: FakeContext, verb: "install" | "uninstall") => {
  const io = captureIO();
  const code = await serviceEntry(verb, { yes: true }, io.io, () => fake.ctx);
  return { code, out: io.text() + io.errors() };
};

/**
 * A data folder in use: configuration, two spaces, logs, a cache and an empty folder. Its folders
 * are user-only, as the product makes them whatever the umask (A2 3.2.2 rule 5), so service install
 * finds a state folder it may write to.
 */
function fill(data: string, withLogs: boolean): void {
  const files: [string, string][] = [
    ["config/machine.toml", "# the person's own file\n"],
    ["spaces/work/space.json", '{"fixture":true}\n'],
    ["spaces/work/notes.md", "Fixture notes.\n"],
    ["spaces/life/space.json", '{"fixture":true}\n'],
    ["cache/mcp-offline.json", "{}\n"],
    ["state/service.log.1", "fixture log\n"],
  ];
  if (withLogs) files.push(["state/logs/service.stdout.log", "fixture output\n"]);
  for (const [path, text] of files) {
    makeDir(dirname(join(data, path)), 0o700);
    writeFileSync(join(data, path), text, { mode: 0o600 });
  }
  makeDir(join(data, "state", "empty"), 0o700);
}

const platforms = [
  "win32",
  ...(process.platform === "win32" ? [] : (["linux", "darwin"] as const)),
] as const;

describe("[A2.3.2.data-folder.kept] no command removes anything in the data folder unasked", () => {
  test.each(platforms)(
    "%s: service install, then uninstall, leaves ~/.ttasks exactly as it was",
    async (platform) => {
      const fake = fakeContext({ platform, dir, daily: true });
      const { data, root, bin } = fake.ctx.layout;
      // The daily layout: the data folder is ~/.ttasks, the program and the command are elsewhere.
      expect(data).toBe(join(dir, "home", ".ttasks"));
      for (const program of [root, bin]) expect(program.startsWith(data)).toBe(false);
      fill(data, true);
      const before = snapshot(data);
      expect(before.length).toBeGreaterThan(10);

      const installed = await run(fake, "install");
      expect(installed.code, installed.out).toBe(0);
      const uninstalled = await run(fake, "uninstall");
      expect(uninstalled.code, uninstalled.out).toBe(0);
      expect(snapshot(data)).toEqual(before);
    },
    60_000,
  );

  test.skipIf(process.platform === "win32")(
    "darwin: the logs folder install makes for launchd stays after uninstall, with all else",
    async () => {
      const fake = fakeContext({ platform: "darwin", dir, daily: true });
      const { data, logs } = fake.ctx.layout;
      fill(data, false);
      const before = snapshot(data);

      expect((await run(fake, "install")).code).toBe(0);
      expect((await run(fake, "uninstall")).code).toBe(0);
      const after = snapshot(data);
      for (const entry of before) expect(after).toContain(entry);
      expect(after).toContain(`dir ${join("state", "logs")}`);
      expect(logs).toBe(join(data, "state", "logs"));
    },
    60_000,
  );
});
