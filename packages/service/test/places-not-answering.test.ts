// A place on a folder that does not answer, in a call that names a group: the binding is bounded,
// so the call is refused in time and the space's other calls that decide on names go on. A real
// service in this process, real sessions, fixture text only; the folder that does not answer is a
// stand-in for node:fs/promises that waits at one file's open until the test lets it go.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { GroupManageResult } from "@tasks/contracts";
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
const { classSession, errorOf } = await import("./ops-helpers.ts");
const { configOf, removeRuntimeDir, serviceEnv, tempRoot } = await import("./harness.ts");

let service: Awaited<ReturnType<typeof startService>>;
let home: string;
let work: string;
let cleanup: () => void;
const sessions: RpcSession[] = [];

beforeAll(async () => {
  const temp = tempRoot("places-late");
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

describe("[A1.3.15.places.request-path] a place whose folder does not answer", () => {
  test("is refused in time, holds up no other call of the space, and its late answer writes nothing", async () => {
    writeFileSync(
      join(work, "repo", ".git", "config"),
      '[remote "origin"]\n\turl = https://example.com/fixture/repo.git\n',
    );
    const first = await classSession(home, service.endpoint.path, "cli-script");
    const second = await classSession(home, service.endpoint.path, "cli-script");
    sessions.push(first, second);
    let release = (): void => undefined;
    const entered = new Promise<void>((done) => {
      gate.entered = done;
    });
    gate.release = new Promise<void>((done) => {
      release = done;
    });
    gate.path = resolve(join(work, "repo", ".git", "config"));
    try {
      const stuck = first
        .call(
          "op/call",
          {
            op: "task.add",
            input: {
              tasks: [{ title: "Fixture stuck place", area: "Stuck", place: join(work, "repo") }],
              request_id: "fixture-place-late-0000001",
            },
          },
          { timeoutMs: 60_000 },
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      await entered;
      // Another call that decides on names goes on while the folder still does not answer.
      const other = GroupManageResult.parse(
        await second.call(
          "op/call",
          {
            op: "group.manage",
            input: { action: "create", path: "Errands", request_id: "fixture-place-late-0000002" },
          },
          { timeoutMs: 60_000 },
        ),
      );
      expect(other.action).toBe("create");
      expect(errorOf(await stuck)).toMatchObject({
        code: "invalid_input",
        data: { reason: "not_answering" },
      });
    } finally {
      release();
    }
    // Answered at last: the refused call still wrote nothing.
    const listed = GroupManageResult.parse(
      await second.call("op/call", { op: "group.manage", input: { action: "list" } }),
    );
    expect(JSON.stringify(listed)).not.toContain("Stuck");
    expect(JSON.stringify(listed)).toContain("Errands");
  }, 60_000);
});
