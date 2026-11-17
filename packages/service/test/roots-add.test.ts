// `tasks roots add` (A1 3.15; M2.07): roots are added by the user only, through machine.toml's
// editor, and are live at once. A real service in this process, real tasks-local/1 sessions,
// fixture text and temporary folders only.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
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
const sessions: RpcSession[] = [];

const session = async (cls: CliClass, env: Record<string, string> = {}): Promise<RpcSession> => {
  const opened = await classSession(home, service.endpoint.path, cls, env);
  sessions.push(opened);
  return opened;
};
const refusal = async (promise: Promise<unknown>) =>
  errorOf(await promise.catch((e: unknown) => e));
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
  const temp = tempRoot("roots");
  root = temp.root;
  cleanup = temp.cleanup;
  home = join(root, "h");
  work = join(root, "workrootfixture");
  outside = join(root, "elsewherefixture");
  mkdirSync(join(work, "lumen", "portal"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(configOf(home), { recursive: true, mode: 0o700 });
  writeFileSync(join(configOf(home), "machine.toml"), MACHINE_TOML(work), { mode: 0o600 });
  service = await startService({
    env: serviceEnv(home),
    identity: () => ({ root: false, elevated: false, package: null }),
    maintenance: false,
    say: () => undefined,
  });
}, 120_000);

afterAll(async () => {
  for (const s of sessions) s.close();
  await service.stop();
  removeRuntimeDir(service);
  cleanup();
});

describe("[A1.3.15.roots.add] tasks roots add: the user's, through machine.toml's editor, live at once", () => {
  test("a root is added for the user only, keeps the file's other bytes, gets its revision and is live at once", async () => {
    const oss = join(root, "oss");
    mkdirSync(join(oss, "tool"), { recursive: true });
    const script = await session("cli-script");
    const agent = await session("cli-agent", { CLAUDECODE: "1" });
    for (const s of [script, agent]) {
      expect(await refusal(s.call("roots/add", { id: "oss", path: oss }))).toMatchObject({
        code: "forbidden",
      });
    }
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

    // Live at once, without a restart: listed, and the service resolves places through it.
    const listed = (await script.call("roots/list", {})) as { roots: { id: string }[] };
    expect(listed.roots.map((r) => r.id)).toEqual(["work", "oss"]);
    expect((service.ops.roots?.() ?? []).map((r) => r.id)).toContain("oss");
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
    // The root's folder spelled in another case: where the volume folds case it is the same
    // folder, which a root names already; where it keeps case it is not there.
    const loud = join(root, basename(work).toUpperCase());
    let folds = false;
    try {
      const [a, b] = [statSync(loud, { bigint: true }), statSync(work, { bigint: true })];
      folds = a.dev === b.dev && a.ino === b.ino;
    } catch {
      // Not there: the volume keeps case.
    }
    expect(await refusal(user.call("roots/add", { id: "loud", path: loud }))).toMatchObject({
      code: "invalid_input",
      data: { issues: [{ path: "path" }], ...(folds ? { roots: ["work"] } : {}) },
    });
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
