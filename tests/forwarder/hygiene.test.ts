// Forwarder conformance (A2 3.7.1, 3.7.2, A3 3.7.2): stdout carries MCP frames only, stderr is
// content-free, the context is the allow-list and nothing else, bad arguments fail loudly, a
// closed stdin ends the forwarder with nothing left behind, and against the real hub a forwarder
// newer than the service and a stopped service give their offline answers.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { hubSpace, spaceOpen } from "../../packages/service/test/mcp-hub.ts";
import {
  Procs,
  alive,
  isOfflineText,
  makeHome,
  peerBinds,
  textOf,
  waitFor,
  type Home,
  type Json,
} from "./harness.ts";

const procs = new Procs();
const homes: Home[] = [];
afterEach(async () => {
  await procs.stopAll();
  for (const home of homes.splice(0)) home.remove();
});

function home(label: string): Home {
  const made = makeHome(label);
  homes.push(made);
  return made;
}

const EXIT_MS = 30_000;

describe("[A2.3.7.bridge.hygiene] what the forwarder writes, copies and leaves behind", () => {
  test(
    "a whole session, a restart included: stdout holds only frames and stderr names no content",
    { timeout: 180_000 },
    async () => {
      const where = home("content");
      const peer = await procs.peer(where);
      const env = {
        TASKS_TICKET: "CONTENTTICKET",
        CLAUDE_CODE_SESSION_ID: "CONTENTSESSION",
        TASKS_TASK: "CONTENTTASK",
        // Not on the allow-list: never copied.
        CLAUDECODE: "1",
        CODEX_SANDBOX: "seatbelt",
        CONTENT_SECRET: "CONTENTSECRET",
        TASKS_PACKAGE: "",
      };
      const bridge = procs.bridge(where, { env });
      await bridge.initialize();
      expect(textOf(await bridge.call("echo", { secret: "CONTENTARG" }))).toContain("CONTENTARG");
      await procs.kill(peer);
      where.removeServiceFile();
      bridge.write("not json at all CONTENTRAW\n");
      bridge.write(`${"v".repeat(64)}\u0000CONTENTNUL\n`);
      expect(
        isOfflineText(await bridge.call("echo", { secret: "CONTENTARG2" }), "service_down"),
      ).toBe(true);
      await procs.peer(where);
      await waitFor(
        () => (peerBinds(where).length >= 2 ? true : undefined),
        60_000,
        "the bridge binds again",
      );
      expect(textOf(await bridge.call("echo", { secret: "CONTENTARG3" }))).toContain("CONTENTARG3");
      bridge.end();
      expect(await bridge.proc.exit).toEqual({ code: 0, signal: null });

      expect(bridge.stray).toEqual([]);
      const stderr = bridge.proc.stderr();
      expect(stderr).toContain("lost the connection");
      for (const word of ["CONTENT", "bh_", where.root, "sp_test"]) {
        expect(stderr).not.toContain(word);
      }
      // The context is the allow-list: ticket, session and task, never the rest.
      for (const bind of peerBinds(where)) {
        expect(Object.keys(bind.context["env"] as Json).sort()).toEqual([
          "CLAUDE_CODE_SESSION_ID",
          "TASKS_TASK",
          "TASKS_TICKET",
        ]);
        const keys = Object.keys(bind.context);
        for (const key of keys) {
          expect([
            "space",
            "instance",
            "app",
            "cwd",
            "env",
            "parent",
            "mcp_init",
            "resume",
          ]).toContain(key);
        }
      }
    },
  );

  test(
    "a closed stdin ends the forwarder with exit 0, online or offline, and its connection closes",
    { timeout: 120_000 },
    async () => {
      const where = home("exit");
      await procs.peer(where);
      const online = procs.bridge(where);
      await online.initialize();
      const offline = procs.bridge(home("exit-off"));
      await offline.initialize();
      online.end();
      offline.end();
      for (const bridge of [online, offline]) {
        const exit = await Promise.race([
          bridge.proc.exit,
          new Promise<"hung">((resolve) =>
            setTimeout(() => {
              resolve("hung");
            }, EXIT_MS),
          ),
        ]);
        expect(exit).toEqual({ code: 0, signal: null });
        expect(alive(bridge.pid)).toBe(false);
        expect(bridge.stray).toEqual([]);
      }
    },
  );

  test(
    "an agent app that closes its end of stderr: diagnostics are dropped and the forwarder goes on",
    { timeout: 60_000 },
    async () => {
      const where = home("nostderr");
      const bridge = procs.bridge(where);
      bridge.proc.child.stderr?.destroy();
      const early = bridge.proc.exit.then((exit) => {
        throw new Error(`the forwarder ended early: ${JSON.stringify(exit)}`);
      });
      // With no service, the forwarder reports that on stderr before it answers.
      const init = await Promise.race([bridge.initialize(), early]);
      expect(init["result"]).toMatchObject({ protocolVersion: "2025-11-25" });
      const call = await Promise.race([bridge.call("status"), early]);
      expect(isOfflineText(call, "service_down")).toBe(true);
      bridge.end();
      expect(await bridge.proc.exit).toEqual({ code: 0, signal: null });
      expect(bridge.stray).toEqual([]);
    },
  );

  test(
    "bad arguments: exit 2, a usage line on stderr and nothing on stdout",
    { timeout: 60_000 },
    async () => {
      const where = home("usage");
      for (const args of [
        ["--bogus"],
        ["--space"],
        ["--space", "../x"],
        ["--app", "a", "--app", "b"],
        ["positional"],
      ]) {
        const bridge = procs.bridge(where, { args });
        expect(await bridge.proc.exit, args.join(" ")).toEqual({ code: 2, signal: null });
        expect(bridge.lines).toEqual([]);
        expect(bridge.proc.stderr()).toContain("usage:");
      }
    },
  );

  test(
    "[A2.3.7.bridge.handshake] the real hub refuses a forwarder newer than itself: tools answer service_too_old",
    { timeout: 180_000 },
    async () => {
      const where = home("hub");
      const space = await hubSpace(where.root);
      const hub = procs.hub(where);
      await waitFor(
        () => {
          try {
            const json = JSON.parse(
              readFileSync(join(where.state, "service.json"), "utf8"),
            ) as Json;
            return json["state"] === "ready" && json["pid"] === hub.pid ? true : undefined;
          } catch {
            return undefined;
          }
        },
        60_000,
        "hub ready",
      );
      const bridge = procs.bridge(where, { newer: true });
      await bridge.initialize();
      expect(isOfflineText(await bridge.call("status"), "service_too_old")).toBe(true);
      const log = readFileSync(join(where.state, "logs", "service.log"), "utf8");
      expect(log).toMatch(/"ev":"local\.bind_refused".*"reason":"service_too_old"/);
      expect(bridge.stray).toEqual([]);
      // A forwarder of this build binds in mcp mode, and its stdout stays MCP frames only.
      await spaceOpen(where.root);
      const current = procs.bridge(where, {
        args: ["--space", space.id, "--instance", "test-agent", "--app", "test"],
      });
      await current.initialize();
      expect(isOfflineText(await current.call("status"), "service_too_old")).toBe(false);
      expect(textOf(await current.call("status"))).toMatch(/^TT Tasks · /);
      expect(current.stray).toEqual([]);
    },
  );

  test(
    "with no service the forwarder answers offline and never starts one",
    { timeout: 60_000 },
    async () => {
      const where = home("nostart");
      const bridge = procs.bridge(where);
      await bridge.initialize();
      expect(isOfflineText(await bridge.call("status"), "service_down")).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(existsSync(join(where.state, "service.json"))).toBe(false);
      expect(existsSync(join(where.state, "service.lock"))).toBe(false);
      expect(existsSync(join(where.state, "logs"))).toBe(false);
    },
  );
});
