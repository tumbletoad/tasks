// Places through the request path and `tasks roots add` (A1 3.15, A3 3.4.5, A3 3.4.6; M2.07):
// a place given as the caller's working folder or as an absolute folder becomes a root ID and a
// relative path before it reaches the space; a folder under no root is a warning for a new task
// and a refusal for an update; a retry replays even when the folder has gone since; and no
// absolute path reaches the space's files, a receipt, a log line or an error. Roots are added by
// the user only, through machine.toml's editor, and are live at once. A real service in this
// process, real tasks-local/1 sessions, fixture text and temporary folders only.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TaskAddResult, TaskFinishResult, TaskGetResult, TaskUpdateResult } from "@tasks/contracts";
import type { RpcSession } from "@tasks/bridge/protocol";
import { startService, type RunningService } from "../src/hub/service.ts";
import { classSession, errorOf, type CliClass } from "./ops-helpers.ts";
import { configOf, removeRuntimeDir, serviceEnv, stateOf, tempRoot } from "./harness.ts";

let service: RunningService;
let home: string;
let root: string;
let cleanup: () => void;
let work: string;
let outside: string;
let spaceFolder: string;
const sessions: RpcSession[] = [];

const session = async (cls: CliClass, env: Record<string, string> = {}): Promise<RpcSession> => {
  const opened = await classSession(home, service.endpoint.path, cls, env);
  sessions.push(opened);
  return opened;
};
const call = (s: RpcSession, op: string, input: Record<string, unknown>) =>
  s.call("op/call", { op, input }, { timeoutMs: 30_000 });
const refusal = async (promise: Promise<unknown>) =>
  errorOf(await promise.catch((e: unknown) => e));

let n = 0;
const rid = () => `fixture-place-${String((n += 1)).padStart(6, "0")}`;

const MACHINE_TOML = (workPath: string) =>
  `# Fixture machine.toml: this comment and the order stay.\n[log]\nlevel = "info"\n\n[roots.work]\nlabel = "Work"\npath = ${JSON.stringify(workPath)}\n`;

/** Every file below `dir`, recursively. */
function filesBelow(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesBelow(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

beforeAll(async () => {
  const temp = tempRoot("places");
  root = temp.root;
  cleanup = temp.cleanup;
  home = join(root, "h");
  // Names found nowhere else, so a search for them finds only a leaked path. (The temporary
  // folder's own name is in writer.json, which names its holder's state folder by design.)
  work = join(root, "workrootfixture");
  outside = join(root, "elsewherefixture");
  mkdirSync(join(work, "lumen", "portal", ".git"), { recursive: true });
  // The repository's remote carries a credential, which a place never records.
  writeFileSync(
    join(work, "lumen", "portal", ".git", "config"),
    '[remote "origin"]\n\turl = https://fixture-user:fixture-token@example.com/lumen/portal.git\n',
  );
  mkdirSync(join(work, "lumen", "api"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(configOf(home), { recursive: true, mode: 0o700 });
  writeFileSync(join(configOf(home), "machine.toml"), MACHINE_TOML(work), { mode: 0o600 });
  service = await startService({
    env: serviceEnv(home),
    identity: () => ({ root: false, elevated: false, package: null }),
    maintenance: false,
    say: () => undefined,
  });
  spaceFolder = join(root, "spaces", "mira");
  const user = await session("cli-interactive");
  await user.call(
    "space/create",
    { name: "Mira", path: spaceFolder, ref_prefix: "M" },
    { timeoutMs: 60_000 },
  );
}, 120_000);

afterAll(async () => {
  for (const s of sessions) s.close();
  await service.stop();
  removeRuntimeDir(service);
  cleanup();
}, 60_000);

/** The place task.get shows for a task on this machine: its root and path, as bound. */
async function placeOfTask(s: RpcSession, ref: string): Promise<unknown> {
  const read = TaskGetResult.parse(await call(s, "task.get", { task: ref }));
  if (read.view !== "digest" || read.task.place === undefined) return undefined;
  return { root: read.task.place.root, path: read.task.place.path };
}

describe("[A1.3.15.places.request-path] places from the working folder or an absolute folder", () => {
  test("cwd and an absolute folder become the closest root and a relative path, with the Git remote", async () => {
    const s = await session("cli-script");
    const added = TaskAddResult.parse(
      await call(s, "task.add", {
        tasks: [
          { title: "Fixture portal task", place: "cwd" },
          { title: "Fixture api task", place: join(work, "lumen", "api") },
          { title: "Fixture root task", place: { root: "Work", path: "" } },
        ],
        cwd: join(work, "lumen", "portal"),
        request_id: rid(),
      }),
    );
    expect(added.warnings).toEqual([]);
    const [portal, api, top] = added.tasks.map((t) => t.ref);
    expect(await placeOfTask(s, portal ?? "")).toEqual({ root: "work", path: "lumen/portal" });
    expect(await placeOfTask(s, api ?? "")).toEqual({ root: "work", path: "lumen/api" });
    // A root named by its label is that root.
    expect(await placeOfTask(s, top ?? "")).toEqual({ root: "work", path: "" });

    // An update binds another folder, given by its absolute path; the base allows the change.
    const read = TaskGetResult.parse(await call(s, "task.get", { task: api }));
    const updated = TaskUpdateResult.parse(
      await call(s, "task.update", {
        task: api,
        set: { place: join(work, "lumen", "portal") },
        base: read.as_of,
        request_id: rid(),
      }),
    );
    expect(updated).toMatchObject({ result: "updated", fields: ["place"] });
    expect(await placeOfTask(s, api ?? "")).toEqual({ root: "work", path: "lumen/portal" });
  });

  test("a folder under no root: a new task gets no place and a warning, an update is refused", async () => {
    const s = await session("cli-script");
    const request = {
      tasks: [
        { title: "Fixture outside task", place: "cwd" },
        { title: "Fixture inside task", place: work },
      ],
      cwd: outside,
      request_id: rid(),
    };
    const added = TaskAddResult.parse(await call(s, "task.add", request));
    expect(added.warnings).toHaveLength(1);
    expect(added.warnings[0]).toContain("tasks.0.place");
    expect(added.warnings[0]).toContain("PLACE_OUTSIDE_ROOTS");
    const [out, inside] = added.tasks.map((t) => t.ref);
    expect(await placeOfTask(s, out ?? "")).toBeUndefined();
    expect(await placeOfTask(s, inside ?? "")).toEqual({ root: "work", path: "" });
    // A replay warns the same, from the stored result.
    expect(TaskAddResult.parse(await call(s, "task.add", request))).toEqual({
      ...added,
      replayed: true,
    });

    const read = TaskGetResult.parse(await call(s, "task.get", { task: out }));
    const error = await refusal(
      call(s, "task.update", {
        task: out,
        set: { place: "cwd" },
        cwd: outside,
        base: read.as_of,
        request_id: rid(),
      }),
    );
    expect(error).toMatchObject({
      code: "invalid_input",
      data: { reason: "outside_roots", cause: "PLACE_OUTSIDE_ROOTS", roots: ["work"] },
    });
    expect(JSON.stringify(error)).not.toContain(basename(root));
    // A follow-up has no warnings to carry one: refused too.
    const finish = await refusal(
      call(s, "task.finish", {
        task: inside,
        outcome: "Fixture outcome.",
        follow_ups: [{ title: "Fixture follow-up", place: outside }],
        base: read.as_of,
        request_id: rid(),
      }),
    );
    expect(finish).toMatchObject({ data: { reason: "outside_roots" } });
  });

  test("a missing folder, a file, a relative path and `..` are refused with their reason and no path", async () => {
    const s = await session("cli-script");
    writeFileSync(join(work, "notes.md"), "fixture");
    const cases: [unknown, string][] = [
      [join(work, "lumen", "gone"), "path_missing"],
      [join(work, "notes.md"), "not_a_directory"],
      [`${work}/lumen/../lumen`, "invalid_path"],
      [{ root: "work", path: "lumen/../x" }, "invalid_path"],
    ];
    for (const [place, reason] of cases) {
      const error = await refusal(
        call(s, "task.add", { tasks: [{ title: "Fixture refused", place }], request_id: rid() }),
      );
      expect(error).toMatchObject({ code: "invalid_input", data: { reason } });
      expect(JSON.stringify(error)).not.toContain(basename(root));
    }
    // A relative folder is no place form at all: the contract refuses it.
    const relative = await refusal(
      call(s, "task.add", {
        tasks: [{ title: "Fixture refused", place: "lumen" }],
        request_id: rid(),
      }),
    );
    expect(relative).toMatchObject({ code: "invalid_input" });
    // cwd without cwd.
    expect(
      await refusal(
        call(s, "task.add", {
          tasks: [{ title: "Fixture refused", place: "cwd" }],
          request_id: rid(),
        }),
      ),
    ).toMatchObject({ data: { reason: "no_cwd" } });
  });

  test("a retry replays after the folder has gone; a new request is refused", async () => {
    const s = await session("cli-script");
    const folder = join(work, "lumen", "temporary");
    mkdirSync(folder);
    const request = {
      tasks: [{ title: "Fixture temporary task", place: "cwd" }],
      cwd: folder,
      request_id: rid(),
    };
    const first = TaskAddResult.parse(await call(s, "task.add", request));
    rmSync(folder, { recursive: true });
    expect(TaskAddResult.parse(await call(s, "task.add", request))).toEqual({
      ...first,
      replayed: true,
    });
    expect(await refusal(call(s, "task.add", { ...request, request_id: rid() }))).toMatchObject({
      data: { reason: "path_missing" },
    });
  });

  test("the follow-ups of task.finish bind their places too", async () => {
    const s = await session("cli-script");
    const added = TaskAddResult.parse(
      await call(s, "task.add", { tasks: [{ title: "Fixture finish task" }], request_id: rid() }),
    );
    const ref = added.tasks[0]?.ref ?? "";
    const read = TaskGetResult.parse(await call(s, "task.get", { task: ref }));
    const finished = TaskFinishResult.parse(
      await call(s, "task.finish", {
        task: ref,
        outcome: "Fixture outcome.",
        follow_ups: [{ title: "Fixture follow-up task", place: "cwd" }],
        cwd: join(work, "lumen", "api"),
        base: read.as_of,
        request_id: rid(),
      }),
    );
    const follow = finished.follow_ups[0]?.ref ?? "";
    expect(await placeOfTask(s, follow)).toEqual({ root: "work", path: "lumen/api" });
  });

  test("a repository whose Git config cannot be read exactly is bound without a remote, and the result says so", async () => {
    const s = await session("cli-script");
    const folder = join(work, "lumen", "included");
    mkdirSync(join(folder, ".git"), { recursive: true });
    // An include could set the remote from another file: Tasks does not guess.
    writeFileSync(
      join(folder, ".git", "config"),
      '[include]\n\tpath = fixture.cfg\n[remote "origin"]\n\turl = https://example.com/lumen/included.git\n',
    );
    const request = {
      tasks: [{ title: "Fixture included task", place: folder }],
      request_id: rid(),
    };
    const added = TaskAddResult.parse(await call(s, "task.add", request));
    expect(added.warnings).toHaveLength(1);
    expect(added.warnings[0]).toContain("tasks.0.place");
    expect(added.warnings[0]).toContain("PLACE_REMOTE_UNREADABLE");
    expect(added.warnings[0]).not.toContain(basename(work));
    expect(await placeOfTask(s, added.tasks[0]?.ref ?? "")).toEqual({
      root: "work",
      path: "lumen/included",
    });
    // No remote recorded: the place has no remote check.
    for (const file of filesBelow(spaceFolder)) {
      expect(readFileSync(file).toString("utf8").includes("included.git"), file).toBe(false);
    }
    // A replay binds nothing and returns the stored result: the first call's warning too, so a
    // reply lost on the way still reaches the caller (A3 3.4.1).
    expect(TaskAddResult.parse(await call(s, "task.add", request))).toEqual({
      ...added,
      replayed: true,
    });
    // A full batch bound there: one warning per draft, and the batch applies.
    const batch = TaskAddResult.parse(
      await call(s, "task.add", {
        tasks: Array.from({ length: 25 }, (_, k) => ({
          title: `Fixture included task ${String(k)}`,
          place: folder,
        })),
        request_id: rid(),
      }),
    );
    expect(batch.tasks).toHaveLength(25);
    expect(batch.warnings).toHaveLength(25);
    expect(batch.warnings.every((w) => w.includes("PLACE_REMOTE_UNREADABLE"))).toBe(true);
  });

  test("no absolute path reaches the space's files or the log; the remote is kept without its credential", () => {
    // After every test above: the space and the log hold what they wrote.
    const markers = [basename(work), basename(outside), "fixture-token"];
    const files = [...filesBelow(spaceFolder), ...filesBelow(service.layout.logs)];
    expect(files.length).toBeGreaterThan(2);
    let remoteSeen = false;
    for (const file of files) {
      const bytes = readFileSync(file);
      for (const text of [bytes.toString("utf8"), bytes.toString("utf16le")]) {
        for (const marker of markers) expect(text.includes(marker), file).toBe(false);
      }
      if (bytes.toString("utf8").includes("https://example.com/lumen/portal.git"))
        remoteSeen = true;
    }
    expect(remoteSeen).toBe(true);
  });
});

describe("[A1.3.15.roots.add] tasks roots add: the user's, through machine.toml's editor, live at once", () => {
  test("a root is added for the user only, keeps the file's other bytes, gets its revision and binds at once", async () => {
    const oss = join(root, "oss");
    mkdirSync(join(oss, "tool"), { recursive: true });
    const script = await session("cli-script");
    const agent = await session("cli-agent", { CLAUDECODE: "1" });
    for (const s of [script, agent]) {
      expect(await refusal(s.call("roots/add", { id: "oss", path: oss }))).toMatchObject({
        code: "forbidden",
      });
    }
    // Before: the folder is under no root.
    const before = await refusal(
      call(script, "task.update", {
        task: "M-1",
        set: { place: join(oss, "tool") },
        request_id: rid(),
      }),
    );
    expect(before).toMatchObject({ data: { reason: "outside_roots", roots: ["work"] } });

    const user = await session("cli-interactive");
    const added = (await user.call("roots/add", {
      id: "oss",
      path: oss,
      label: "Open source",
    })) as {
      root: Record<string, unknown>;
    };
    expect(added.root).toEqual({ id: "oss", label: "Open source", path: oss, runs: false, rev: 1 });
    const text = readFileSync(join(configOf(home), "machine.toml"), "utf8");
    expect(text.startsWith(MACHINE_TOML(work))).toBe(true);
    expect(text).toContain("[roots.oss]");
    const revs = JSON.parse(readFileSync(join(stateOf(home), "roots.json"), "utf8")) as {
      roots: Record<string, { rev: number }>;
    };
    expect(revs.roots["oss"]?.rev).toBe(1);
    expect(JSON.stringify(revs)).not.toContain(basename(root));

    // Live at once: a place under it binds, without a restart.
    const listed = (await script.call("roots/list", {})) as { roots: { id: string }[] };
    expect(listed.roots.map((r) => r.id)).toEqual(["work", "oss"]);
    const added2 = TaskAddResult.parse(
      await call(script, "task.add", {
        tasks: [{ title: "Fixture oss task", place: join(oss, "tool") }],
        request_id: rid(),
      }),
    );
    expect(await placeOfTask(script, added2.tasks[0]?.ref ?? "")).toEqual({
      root: "oss",
      path: "tool",
    });
    // The log line names no root and no path.
    const log = filesBelow(service.layout.logs)
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    expect(log).toContain("config.root_added");
  });

  test("an ID in use, a folder another root names, a missing folder and a bad ID are refused, the file unchanged", async () => {
    const user = await session("cli-interactive");
    const file = join(configOf(home), "machine.toml");
    const before = readFileSync(file, "utf8");
    const mtime = statSync(file).mtimeMs;
    const cases: [Record<string, unknown>, string][] = [
      [{ id: "work", path: outside }, "id"],
      [{ id: "again", path: work }, "path"],
      [{ id: "gone", path: join(root, "gone") }, "path"],
      [{ id: "Bad ID", path: outside }, "id"],
      [{ id: "rel", path: "relative/folder" }, "path"],
      // A folder that is there, spelled with a segment places never resolve a root through.
      [{ id: "dot", path: `${outside}${sep}.` }, "path"],
      [{ id: "dotdot", path: `${outside}${sep}..${sep}${basename(outside)}` }, "path"],
    ];
    for (const [params, field] of cases) {
      const error = await refusal(user.call("roots/add", params));
      expect(error).toMatchObject({ code: "invalid_input", data: { issues: [{ path: field }] } });
      expect(JSON.stringify(error)).not.toContain(basename(root));
    }
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(statSync(file).mtimeMs).toBe(mtime);
  });

  test("two adds of one folder at once: one root is added, the other is refused", async () => {
    const user = await session("cli-interactive");
    const shared = join(root, "sharedfixture");
    mkdirSync(shared);
    const results = await Promise.allSettled([
      user.call("roots/add", { id: "one", path: shared }),
      user.call("roots/add", { id: "two", path: shared }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find((r) => r.status === "rejected");
    expect(errorOf(rejected?.reason)).toMatchObject({
      code: "invalid_input",
      data: { issues: [{ path: "path" }] },
    });
    const text = readFileSync(join(configOf(home), "machine.toml"), "utf8");
    expect([text.includes("[roots.one]"), text.includes("[roots.two]")].sort()).toEqual([
      false,
      true,
    ]);
    // The folder has one place.
    const s = await session("cli-script");
    const added = TaskAddResult.parse(
      await call(s, "task.add", {
        tasks: [{ title: "Fixture shared task", place: shared }],
        request_id: rid(),
      }),
    );
    expect(added.warnings).toEqual([]);
  });

  test("a root written into machine.toml by hand meanwhile is checked too", async () => {
    const user = await session("cli-interactive");
    const handmade = join(root, "handfixture");
    mkdirSync(handmade);
    const file = join(configOf(home), "machine.toml");
    writeFileSync(
      file,
      `${readFileSync(file, "utf8")}\n[roots.hand]\npath = ${JSON.stringify(handmade)}\n`,
    );
    const before = readFileSync(file, "utf8");
    expect(await refusal(user.call("roots/add", { id: "again2", path: handmade }))).toMatchObject({
      code: "invalid_input",
      data: { issues: [{ path: "path" }], roots: ["hand"] },
    });
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});

describe("[A1.3.15.places.request-path] replays and remotes", () => {
  test("a retry replays whatever became of the folder's remote; a helper remote is never recorded", async () => {
    const s = await session("cli-script");
    const repoDir = join(work, "lumen", "helper");
    mkdirSync(join(repoDir, ".git"), { recursive: true });
    const config = join(repoDir, ".git", "config");
    writeFileSync(config, '[remote "origin"]\n\turl = ext::fixture-bridge-marker\n');
    const request = {
      tasks: [{ title: "Fixture helper task", place: repoDir }],
      request_id: rid(),
    };
    const first = TaskAddResult.parse(await call(s, "task.add", request));
    expect(await placeOfTask(s, first.tasks[0]?.ref ?? "")).toEqual({
      root: "work",
      path: "lumen/helper",
    });
    // The remote changes to one far over the writer's bound once written out: the retry is the
    // writer's replay and reads nothing of the folder.
    writeFileSync(
      config,
      `[remote "origin"]\n\turl = https://example.com/${"é".repeat(400)}.git\n`,
    );
    expect(TaskAddResult.parse(await call(s, "task.add", request))).toEqual({
      ...first,
      replayed: true,
    });
    // A new request binds with no remote recorded. The same title again in the Inbox is a possible
    // duplicate of the first task (A3 3.4.5), and that is its only warning.
    const again = TaskAddResult.parse(await call(s, "task.add", { ...request, request_id: rid() }));
    expect(again.warnings).toEqual([
      `tasks.0: possible duplicate of ${first.tasks[0]?.ref ?? ""} (both in the Inbox, similar title)`,
    ]);
    for (const file of filesBelow(spaceFolder)) {
      expect(readFileSync(file).includes("fixture-bridge-marker"), file).toBe(false);
    }
  });

  test("a full request whose places were all outside every root replays within the operation limit", async () => {
    const s = await session("cli-script");
    // 25 drafts with a log entry each: 50 operations, the most a request holds; no place binds.
    const request = {
      tasks: Array.from({ length: 25 }, (_, k) => ({
        title: `Fixture full task ${String(k)}`,
        log: "Fixture log entry.",
        place: outside,
      })),
      request_id: rid(),
    };
    const first = TaskAddResult.parse(await call(s, "task.add", request));
    expect(first.warnings).toHaveLength(25);
    expect(TaskAddResult.parse(await call(s, "task.add", request))).toEqual({
      ...first,
      replayed: true,
    });
  });

  test("an update of the place alone replays after its folder has gone", async () => {
    const s = await session("cli-script");
    const folder = join(work, "lumen", "brief");
    mkdirSync(folder);
    const added = TaskAddResult.parse(
      await call(s, "task.add", { tasks: [{ title: "Fixture brief task" }], request_id: rid() }),
    );
    const ref = added.tasks[0]?.ref ?? "";
    const read = TaskGetResult.parse(await call(s, "task.get", { task: ref }));
    const request = { task: ref, set: { place: folder }, base: read.as_of, request_id: rid() };
    const first = TaskUpdateResult.parse(await call(s, "task.update", request));
    rmSync(folder, { recursive: true });
    expect(TaskUpdateResult.parse(await call(s, "task.update", request))).toEqual({
      ...first,
      replayed: true,
    });
  });
});

describe("[A1.3.15.roots.add] a root remapped by hand", () => {
  test("a root the file maps to another folder than the live one is checked under both", async () => {
    const user = await session("cli-interactive");
    const first = join(root, "remapfirstfixture");
    const second = join(root, "remapsecondfixture");
    mkdirSync(first);
    mkdirSync(second);
    await user.call("roots/add", { id: "remap", path: first });
    // By hand, the root now names the second folder; the service still holds the first.
    const file = join(configOf(home), "machine.toml");
    const lines = readFileSync(file, "utf8").split("\n");
    const header = lines.indexOf("[roots.remap]");
    const at = lines.findIndex((line, k) => k > header && line.startsWith("path = "));
    lines[at] = `path = ${JSON.stringify(second)}`;
    writeFileSync(file, lines.join("\n"));
    for (const folder of [second, first]) {
      expect(
        await refusal(user.call("roots/add", { id: "remapcopy", path: folder })),
      ).toMatchObject({
        code: "invalid_input",
        data: { issues: [{ path: "path" }], roots: ["remap"] },
      });
    }
  });
});
