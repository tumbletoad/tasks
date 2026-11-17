// A project's folder that does not answer, in a call that binds it: the look is bounded, so the
// call is refused in time and the space's other calls that decide on names go on. A real service
// in this process, real sessions, fixture text only; the folder that does not answer is a stand-in
// for node:fs/promises that waits at one folder's stat until the test lets it go, and says when
// that late look has come back.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { GroupManageResult } from "@tasks/contracts";
import type { RpcSession } from "@tasks/bridge/protocol";

const gate = vi.hoisted(() => ({
  /** The folder whose stat waits, once. */
  path: undefined as string | undefined,
  entered: undefined as (() => void) | undefined,
  release: undefined as Promise<void> | undefined,
  /** Told once the late stat has come back and what awaited it has run. */
  finished: undefined as (() => void) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    stat: async (...args: Parameters<typeof real.stat>) => {
      if (gate.path === undefined || resolve(String(args[0])) !== gate.path) {
        return real.stat(...args);
      }
      gate.path = undefined;
      gate.entered?.();
      await gate.release;
      try {
        return await real.stat(...args);
      } finally {
        setTimeout(() => gate.finished?.(), 0);
      }
    },
  };
});

const { startService } = await import("../src/hub/service.ts");
const { classSession, errorOf } = await import("./ops-helpers.ts");
const { removeRuntimeDir, serviceEnv, tempRoot } = await import("./harness.ts");

let service: Awaited<ReturnType<typeof startService>>;
let home: string;
let work: string;
let cleanup: () => void;
const sessions: RpcSession[] = [];

beforeAll(async () => {
  const temp = tempRoot("folders-late");
  cleanup = temp.cleanup;
  home = join(temp.root, "h");
  work = join(temp.root, "work");
  mkdirSync(join(work, "repo"), { recursive: true });
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

describe("[A1.3.15.folders.request-path] a project's folder that does not answer", () => {
  test("is refused in time, holds up no other call of the space, and its late answer writes nothing", async () => {
    const first = await classSession(home, service.endpoint.path, "cli-script");
    const second = await classSession(home, service.endpoint.path, "cli-script");
    sessions.push(first, second);
    let release = (): void => undefined;
    const entered = new Promise<void>((done) => {
      gate.entered = done;
    });
    const finished = new Promise<void>((done) => {
      gate.finished = done;
    });
    gate.release = new Promise<void>((done) => {
      release = done;
    });
    gate.path = resolve(join(work, "repo"));
    try {
      const stuck = first
        .call(
          "op/call",
          {
            op: "group.manage",
            input: {
              action: "create",
              path: "Stuck/Fixture repo",
              folder: join(work, "repo"),
              request_id: "fixture-folder-late-0000001",
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
            input: { action: "create", path: "Errands", request_id: "fixture-folder-late-0000002" },
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
    // The late look has come back: the refused call still wrote nothing.
    await finished;
    const listed = GroupManageResult.parse(
      await second.call("op/call", { op: "group.manage", input: { action: "list" } }),
    );
    expect(JSON.stringify(listed)).not.toContain("Stuck");
    expect(JSON.stringify(listed)).toContain("Errands");
  }, 60_000);
});
