// A retry that races its first call while a place is being bound (A1 3.15;
// round four's finding 3). The first call pauses while it reads the repository's Git config; an
// identical request applies meanwhile and records the remote; the config then gains an include,
// which this reader cannot read exactly, and the paused call resumes. The writer replays it. The
// replay's warnings must be the stored result's: the place was bound with its remote, so no
// PLACE_REMOTE_UNREADABLE. A real service in this process, real sessions, fixture text only; the
// pause comes from a stand-in for node:fs/promises that waits at one file's open.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { TaskAddResult } from "@tasks/contracts";
import type { RpcSession } from "@tasks/bridge/protocol";

const gate = vi.hoisted(() => ({
  /** The file whose open waits, once. */
  path: undefined as string | undefined,
  entered: undefined as (() => void) | undefined,
  release: undefined as Promise<void> | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      if (gate.path !== undefined && resolve(String(args[0])) === gate.path) {
        gate.path = undefined;
        gate.entered?.();
        await gate.release;
      }
      return real.open(...args);
    },
  };
});

const { startService } = await import("../src/hub/service.ts");
const { classSession } = await import("./ops-helpers.ts");
const { configOf, removeRuntimeDir, serviceEnv, tempRoot } = await import("./harness.ts");

let service: Awaited<ReturnType<typeof startService>>;
let home: string;
let work: string;
let cleanup: () => void;
const sessions: RpcSession[] = [];

beforeAll(async () => {
  const temp = tempRoot("places-race");
  cleanup = temp.cleanup;
  home = join(temp.root, "h");
  work = join(temp.root, "work");
  mkdirSync(join(work, "repo", ".git"), { recursive: true });
  mkdirSync(configOf(home), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(configOf(home), "machine.toml"),
    `[roots.work]\npath = ${JSON.stringify(work)}\n`,
    { mode: 0o600 },
  );
  service = await startService({
    env: serviceEnv(home),
    identity: () => ({ root: false, elevated: false, package: null }),
    maintenance: false,
    say: () => undefined,
  });
  const user = await classSession(home, service.endpoint.path, "cli-interactive");
  sessions.push(user);
  await user.call(
    "space/create",
    { name: "Fixture", path: join(temp.root, "space"), ref_prefix: "F" },
    { timeoutMs: 60_000 },
  );
}, 120_000);

afterAll(async () => {
  for (const s of sessions) s.close();
  await service.stop();
  removeRuntimeDir(service);
  cleanup();
});

describe("[A1.3.15.places.request-path] a retry racing its first call while a place is bound", () => {
  test("the replay carries the stored result's warnings, not those of its own late binding", async () => {
    const config = join(work, "repo", ".git", "config");
    writeFileSync(config, '[remote "origin"]\n\turl = https://example.com/fixture/repo.git\n');
    const first = await classSession(home, service.endpoint.path, "cli-script");
    const second = await classSession(home, service.endpoint.path, "cli-script");
    sessions.push(first, second);
    const request = {
      tasks: [{ title: "Fixture raced place", place: join(work, "repo") }],
      request_id: "fixture-place-race-000001",
    };
    // The first call pauses when it opens the config to read the remote.
    let release = (): void => undefined;
    const entered = new Promise<void>((done) => {
      gate.entered = done;
    });
    gate.release = new Promise<void>((done) => {
      release = done;
    });
    gate.path = resolve(config);
    const paused = first.call("op/call", { op: "task.add", input: request }, { timeoutMs: 30_000 });
    await entered;
    // The same request applies meanwhile, with the remote recorded and no warning.
    const won = TaskAddResult.parse(
      await second.call("op/call", { op: "task.add", input: request }, { timeoutMs: 30_000 }),
    );
    expect(won.warnings).toEqual([]);
    // Now the config holds an include: the paused call reads it as unreadable.
    writeFileSync(
      config,
      '[include]\n\tpath = fixture.cfg\n[remote "origin"]\n\turl = https://example.com/fixture/repo.git\n',
    );
    release();
    const replay = TaskAddResult.parse(await paused);
    expect(replay).toEqual({ ...won, replayed: true });
  });
});
