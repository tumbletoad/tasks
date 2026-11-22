// A bridge that binds while the service starts, after it said it is ready and before its spaces are
// handed to the space manager: held there by a stand-in for the offline cache's write, the step
// between the two. A service in this process over one space registered in machine.toml, fixture
// text and temporary folders only.
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { startService } from "../src/hub/service.ts";
import { readServiceJson, removeRuntimeDir, serviceEnv, tempRoot, waitFor } from "./harness.ts";
import { hubSpace } from "./mcp-hub.ts";
import { bridgeContext, openMcp } from "./mcp-helpers.ts";

const gate = vi.hoisted(() => {
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release: () => release() };
});

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
    "on an install with one space and no default, a hand-made entry bound before the spaces are handed over gets that space by its registered ID",
    { timeout: 180_000 },
    async () => {
      const temp = tempRoot("bind-startup");
      const home = join(temp.root, "h");
      const space = await hubSpace(home);
      const starting = startService({
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
        const session = await openMcp(home, path, bridgeContext({ instance: null, app: null }));
        expect(session.bound.binding).toEqual({ space: space.id, state: "unbound" });
        session.close();
      } finally {
        gate.release();
        const service = await starting;
        await service.stop();
        removeRuntimeDir(service);
        temp.cleanup();
      }
    },
  );
});
