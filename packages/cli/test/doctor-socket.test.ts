// `ttasks doctor` names what stands where a stopped service's socket goes (Linux and macOS): the
// service removes only a socket nobody answers on, and does not start until the rest moves.
import { mkdirSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  canonicalStatePath,
  hostFacts,
  installId,
  resolveLayout,
  runtimeNames,
} from "@ttasks/service/paths";
import { isPrivateDir, shellPath } from "@ttasks/service/permissions";
import { tempRoot } from "@ttasks/service/test/harness";
import { cliEnv, runMain } from "./cli-harness.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const listening = async (path: string): Promise<Server> => {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => {
    server.listen(path, resolve);
  });
  return server;
};

const closed = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });

describe("[A2.3.4.hub.stale-recovery] ttasks doctor names what is in the way of the socket", () => {
  test.skipIf(process.platform === "win32")(
    "the service row names a file or a live socket there, also under a record a crash left; a socket nobody answers on is not named",
    async () => {
      const { root, cleanup } = tempRoot("dsock");
      cleanups.push(cleanup);
      const home = join(root, "h");
      const env = cliEnv(home);
      const facts = hostFacts(env, process.platform);
      const layout = resolveLayout(facts);
      mkdirSync(layout.state, { recursive: true, mode: 0o700 });
      const id = installId(canonicalStatePath(realpathSync.native(layout.state), process.platform));
      const plan = runtimeNames(layout, id, facts, isPrivateDir).endpoint;
      if (plan.kind !== "unix") throw new Error("a Unix socket is expected here");
      const serviceRow = async (): Promise<string | undefined> => {
        const ran = await runMain(["doctor", "--json"], { home });
        const report = JSON.parse(ran.stdout) as { checks: { id: string; detail: string }[] };
        return report.checks.find((check) => check.id === "service")?.detail;
      };
      const inTheWay = (what: string, todo: string) =>
        `${shellPath(plan.path)} is ${what} where TTasks's socket goes, so the service does not start. ${todo}, then start the service again.`;
      const aFile = inTheWay("a file", "Move it elsewhere");
      const aLiveSocket = inTheWay(
        "a socket another program answers on",
        "Stop the program that listens there",
      );

      expect(await serviceRow()).toBe("Not running. Start it with: ttasks service start");
      // The socket folder may be the per-user runtime folder: only what this test made goes.
      mkdirSync(plan.dir, { mode: 0o700 });
      cleanups.push(() => {
        rmdirSync(plan.dir);
      });
      writeFileSync(plan.path, "restored\n");
      cleanups.push(() => {
        rmSync(plan.path, { force: true });
      });
      expect(await serviceRow()).toBe(`Not running. ${aFile}`);

      // A record a crash or a restore left: its process is gone, its endpoint answers nothing.
      writeFileSync(
        join(layout.state, "service.json"),
        JSON.stringify({
          state: "ready",
          pid: 2_147_483_646,
          endpoint: { kind: "unix", path: join(root, "gone.sock") },
        }),
      );
      expect(await serviceRow()).toContain(aFile);

      // Another program listening where the socket goes.
      rmSync(plan.path);
      const other = await listening(plan.path);
      cleanups.push(() => closed(other));
      expect(await serviceRow()).toContain(aLiveSocket);
      await closed(other);

      // A socket nobody answers on is stale, and the next start removes it: not named. Node removes
      // its socket on close, so the socket is moved where the service's goes before that.
      const elsewhere = join(root, "elsewhere.sock");
      const ended = await listening(elsewhere);
      renameSync(elsewhere, plan.path);
      await closed(ended);
      const row = await serviceRow();
      expect(row).not.toContain("where TTasks's socket goes");
    },
  );
});
