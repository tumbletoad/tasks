// Folders at the command line: `ttasks add` and `ttasks set` give a task its folder with --folder,
// a folder relative to the working one, --here and folder=, and clear it; `ttasks area` makes a
// project with its folder, and with --create makes the folder first, as the person's mkdir would,
// removed after a refusal and kept after a lost reply; one undo takes the whole act back; `tasks
// area list` shows the folders; the old --place and place= name --folder. The CLI in this process
// against a service in this process; fixture text and temporary folders only.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { LocalError } from "@ttasks/bridge/protocol";
import { contractWorld, type ContractWorld } from "@ttasks/service/test/contract";
import { runMain, type Ran } from "./cli-harness.ts";

let w: ContractWorld & { root: string };
const LONG = 120_000;

beforeAll(async () => {
  w = await contractWorld("cf");
}, LONG);
afterAll(async () => {
  await w.close();
}, LONG);

/** `ttasks <args>` from a terminal in `cwd`: the person. */
const tasks = (args: readonly string[], cwd: string): Promise<Ran> =>
  runMain(args, { home: w.home, cwd, tty: true });
const json = (ran: Ran) => JSON.parse(ran.stdout) as Record<string, unknown>;

/** A folder of this test, made with its parents. */
function folder(...parts: string[]): string {
  const path = join(w.root, "work", ...parts);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

/** The folder the digest of `ref` names. */
async function folderOf(ref: string): Promise<unknown> {
  const shown = json(await tasks(["show", ref, "--json"], w.root));
  return (shown["task"] as Record<string, unknown>)["folder"];
}

const ends = (tail: string): unknown => expect.stringMatching(new RegExp(`${tail}$`, "u"));

describe("[A3.3.4.folders.cli] folders at the command line", () => {
  test("a task's folder from --folder ., folder= relative, --here, and --clear folder", async () => {
    const portal = folder("lumen", "portal");
    folder("lumen", "api");
    const added = await tasks(["add", "Fixture portal task", "--folder", ".", "--json"], portal);
    expect(added.code, added.stdout).toBe(0);
    const ref = (json(added)["tasks"] as { ref: string }[])[0]?.ref ?? "";
    expect(await folderOf(ref)).toEqual({ path: ends("portal"), of: "task" });

    expect((await tasks(["set", ref, "folder=../api"], portal)).code).toBe(0);
    expect(await folderOf(ref)).toEqual({ path: ends("api"), of: "task" });

    expect((await tasks(["set", ref, "--here"], portal)).code).toBe(0);
    expect(await folderOf(ref)).toEqual({ path: ends("portal"), of: "task" });

    const shown = await tasks(["show", ref], w.root);
    expect(shown.stdout).toMatch(/\n {2}folder: .*portal\n/u);

    expect((await tasks(["set", ref, "--clear", "folder"], portal)).code).toBe(0);
    expect(await folderOf(ref)).toBeUndefined();

    // --here and --folder name two folders: a usage error before any call.
    const both = await tasks(["set", ref, "--here", "folder=."], portal);
    expect(both.code).toBe(2);
  });

  test("ttasks area create --folder --create makes the folder and binds it, and one undo takes it back", async () => {
    const empty = folder("empty-start");
    const made = join(empty, "fresh");
    const created = await tasks(
      ["area", "create", "Fixture area/Fixture fresh", "--folder", "fresh", "--create", "--json"],
      empty,
    );
    expect(created.code, created.stdout + created.stderr).toBe(0);
    expect(json(created)).toMatchObject({
      result: "created",
      group: { kind: "project", name: "Fixture fresh", folder: ends("fresh") },
    });
    expect(existsSync(made)).toBe(true);
    // An ordinary folder for the person's work, as their own mkdir makes it: not user-only.
    const plain = join(empty, "plain");
    mkdirSync(plain);
    expect(statSync(made).mode & 0o777).toBe(statSync(plain).mode & 0o777);
    const listed = await tasks(["area", "list"], w.root);
    expect(listed.stdout).toMatch(/\n {2}Fixture fresh \(0\) {2}.*fresh\n/u);

    // One undo takes back the project, its new area and its folder together.
    const undone = await tasks(["undo", "--yes"], w.root);
    expect(undone.code, undone.stderr).toBe(0);
    const after = json(await tasks(["area", "list", "--json"], w.root));
    expect(JSON.stringify(after)).not.toContain("Fixture fresh");
    expect(JSON.stringify(after)).not.toContain("Fixture area");
    // The folder on disk is the person's: the undo leaves it.
    expect(existsSync(made)).toBe(true);
  });

  test("--folder . --create in a folder that holds files binds it as it is", async () => {
    const here = folder("already-here");
    writeFileSync(join(here, "notes.txt"), "fixture");
    const created = await tasks(
      ["area", "create", "Fixture area/Fixture here", "--folder", ".", "--create", "--json"],
      here,
    );
    expect(created.code, created.stdout).toBe(0);
    expect(json(created)).toMatchObject({ group: { folder: ends("already-here") } });
    expect(readFileSync(join(here, "notes.txt"), "utf8")).toBe("fixture");
  });

  test("a reply lost after the write keeps the folder --create made, which the binding names", async () => {
    const parent = folder("lost-reply");
    const made = join(parent, "fresh");
    const lost = await runMain(
      ["area", "create", "Fixture area/Fixture lost", "--folder", made, "--create", "--json"],
      {
        home: w.home,
        cwd: parent,
        tty: true,
        main: {
          wrap: (session) => ({
            bound: session.bound,
            close: () => {
              session.close();
            },
            call: async (...args) => {
              const result = await session.call(...args);
              const [method, params] = args;
              if (method === "op/call" && params?.["op"] === "group.manage") {
                throw new LocalError("connection_lost", "test_lost_reply");
              }
              return result;
            },
          }),
        },
      },
    );
    expect(lost.code).toBe(6);
    expect(existsSync(made)).toBe(true);
    const listed = await tasks(["area", "list"], w.root);
    expect(listed.stdout).toMatch(/\n {2}Fixture lost \(0\) {2}.*fresh\n/u);
  });

  test("ttasks area set_folder --here and clear_folder change a project's folder", async () => {
    const at = folder("ledger");
    const created = await tasks(["area", "create", "Fixture area/Fixture ledger"], w.root);
    expect(created.code, created.stderr).toBe(0);
    const set = await tasks(
      ["area", "set_folder", "Fixture area/Fixture ledger", "--here", "--json"],
      at,
    );
    expect(set.code, set.stdout + set.stderr).toBe(0);
    expect(json(set)).toMatchObject({ result: "folder_set", group: { folder: ends("ledger") } });
    const cleared = await tasks(
      ["area", "clear_folder", "Fixture area/Fixture ledger", "--json"],
      w.root,
    );
    expect(cleared.code, cleared.stdout + cleared.stderr).toBe(0);
    expect(json(cleared)).toMatchObject({ result: "folder_cleared" });
    const listed = await tasks(["area", "list"], w.root);
    expect(listed.stdout).toMatch(/\n {2}Fixture ledger \(0\)\n/u);
  });

  test("a refused call removes the folder --create made for it", async () => {
    const parent = folder("refused");
    // A folder inside TTasks's own data is refused after the CLI made it.
    const inside = join(w.home, "fixture-made");
    const refused = await tasks(
      ["area", "create", "Fixture area/Fixture refused", "--folder", inside, "--create", "--json"],
      parent,
    );
    expect(refused.code).toBe(2);
    expect(json(refused)).toMatchObject({
      error: { code: "invalid_input", data: { reason: "folder_reserved" } },
    });
    expect(existsSync(inside)).toBe(false);
  });

});
});
