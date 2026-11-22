// Calls while the service starts, after it said it is ready and before its spaces are handed to
// the space manager: held there by a stand-in for the offline cache's write, the step between the
// two. A service in this process over one space registered in machine.toml, fixture text and
// temporary folders only.
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { startService, type RunningService } from "../src/hub/service.ts";
import {
  readServiceJson,
  registerSpaces,
  removeRuntimeDir,
  serviceEnv,
  tempRoot,
  waitFor,
} from "./harness.ts";
import { hubSpace } from "./mcp-hub.ts";
import { toolOf } from "../src/mcp/index.ts";
import { bridgeContext, openMcp, RawMcp, textOf } from "./mcp-helpers.ts";
import { classSession, errorOf } from "./ops-helpers.ts";

const gate = vi.hoisted(() => {
  let release = (): void => undefined;
  let held = Promise.resolve();
  return {
    get held() {
      return held;
    },
    /** The next start waits at the step until `release`. */
    arm: () => {
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => {
      release();
    },
  };
});

/**
 * Runs `body` with the endpoint of `home`'s service, started and held before the hand-over. The
 * hold is released and the service stopped however the body or the wait for readiness ends.
 */
async function whileStarting(home: string, body: (path: string) => Promise<void>): Promise<void> {
  gate.arm();
  const starting: Promise<RunningService> = startService({
    env: serviceEnv(home),
    identity: () => ({ root: false, elevated: false, package: null }),
    maintenance: false,
    say: () => undefined,
  });
  try {
    const path = await waitFor(
      () => {
        const json = readServiceJson(home);
        return json?.state === "ready" ? json.endpoint?.path : undefined;
      },
      60_000,
      "the service says it is ready",
    );
    await body(path);
  } finally {
    gate.release();
    const service = await starting;
    await service.stop();
    removeRuntimeDir(service);
  }
}

vi.mock("../src/mcp/offline.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/mcp/offline.ts")>();
  return {
    ...real,
    writeOfflineCache: async (...args: Parameters<typeof real.writeOfflineCache>) => {
      await gate.held;
      return real.writeOfflineCache(...args);
    },
  };
});

describe("[A3.3.7.binding.space] a bind while the service starts settles the configured space", () => {
  test(
    "on an install with one space and no default, a hand-made entry bound before the spaces are handed over gets that space by its registered ID, and its first call is told the space is still opening, to try again",
    { timeout: 180_000 },
    async () => {
      const temp = tempRoot("bind-startup");
      try {
        const home = join(temp.root, "h");
        const space = await hubSpace(home);
        await whileStarting(home, async (path) => {
          const session = await openMcp(home, path, bridgeContext({ instance: null, app: null }));
          expect(session.bound.binding).toEqual({ space: space.id, state: "unbound" });
          const mcp = new RawMcp(session);
          await mcp.initialize();
          const reply = await mcp.request("tools/call", {
            name: toolOf("space.status"),
            arguments: {},
          });
          expect(textOf(reply.message["result"])).toMatch(/^error space_unavailable \(opening\):/);
          session.close();
        });
      } finally {
        temp.cleanup();
      }
    },
  );

  test(
    "with a default space configured, a person's command and an agent's shell call that names the space, by ID, name or folder, are told it is still opening, to try again",
    { timeout: 180_000 },
    async () => {
      const temp = tempRoot("call-startup");
      try {
        const home = join(temp.root, "h");
        const space = await hubSpace(home);
        registerSpaces(home, [space.folder], `\n[service]\ndefault_space = "${space.id}"\n`);
        await whileStarting(home, async (path) => {
          const opening = async (
            cls: "cli-interactive" | "cli-agent",
            named?: string,
          ): Promise<unknown> => {
            const session = await classSession(home, path, cls, { TTASKS_AGENT: "1" });
            try {
              await session.call(
                "op/call",
                { op: "space.status", input: {}, ...(named === undefined ? {} : { space: named }) },
                { timeoutMs: 60_000 },
              );
              return "answered";
            } catch (error) {
              const body = errorOf(error);
              return [body.code, body.data?.["reason"], body.data?.["retryable"]];
            } finally {
              session.close();
            }
          };
          const retry = ["space_unavailable", "opening", true];
          // `ttasks status` right after a start: the machine's default, by its registered ID.
          expect(await opening("cli-interactive")).toEqual(retry);
          // An agent's shell names its space by ID, or by a name not known until the space opens.
          expect(await opening("cli-agent", space.id)).toEqual(retry);
          expect(await opening("cli-agent", "Mira")).toEqual(retry);
          // A folder names its copy: the configured one, which is opening too.
          expect(await opening("cli-agent", space.folder)).toEqual(retry);
        });
      } finally {
        temp.cleanup();
      }
    },
  );
});
