// `ttasks doctor` names what stands where a stopped service's socket goes (Linux and macOS): the
// service keeps anything that is not a stale socket of its own, and does not start until it moves.
import { mkdirSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
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
import { socketBlocked } from "../src/doctor.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("[A2.3.4.hub.stale-recovery] ttasks doctor names what is in the way of the socket", () => {
  test.skipIf(process.platform === "win32")(
    "a file at the socket's path is named with where it is; nothing there is not",
    () => {
      const { root, cleanup } = tempRoot("dsock");
      cleanups.push(cleanup);
      const io = { env: { TTASKS_HOME: join(root, "h") }, platform: process.platform };
      const facts = hostFacts(io.env, io.platform);
      const layout = resolveLayout(facts);
      mkdirSync(layout.state, { recursive: true, mode: 0o700 });
      const id = installId(canonicalStatePath(realpathSync.native(layout.state), io.platform));
      const plan = runtimeNames(layout, id, facts, isPrivateDir).endpoint;
      if (plan.kind !== "unix") throw new Error("a Unix socket is expected here");
      expect(socketBlocked(io, layout, layout.state)).toBeUndefined();

      // The socket folder may be the per-user runtime folder: only what this test made goes.
      mkdirSync(plan.dir, { mode: 0o700 });
      cleanups.push(() => {
        rmdirSync(plan.dir);
      });
      writeFileSync(plan.path, "restored\n");
      cleanups.push(() => {
        rmSync(plan.path, { force: true });
      });
      expect(socketBlocked(io, layout, layout.state)).toBe(
        `${shellPath(plan.path)} is a file where TTasks's socket goes, so the service does not start. Move it elsewhere, then start the service again.`,
      );
    },
  );
});
