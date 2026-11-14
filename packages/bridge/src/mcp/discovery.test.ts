// Finding the service (A2 3.6.1): the folders by A2 3.2.1 and 3.2.2, then service.json and
// ipc.key, each failure with its reason. packages/service/test/bridge-names.test.ts checks the
// folders against the hub's own layout.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { installFolders, readEndpoint, readKey, type HostFacts } from "./discovery.ts";
import { Unavailable } from "./unavailable.ts";

const facts = (
  platform: NodeJS.Platform,
  env: Record<string, string>,
  accountHome?: string,
): HostFacts => ({
  platform,
  env,
  accountHome,
});

let state = "";
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "kb-disc-"));
});
afterEach(() => {
  rmSync(state, { recursive: true, force: true });
});

function failure(read: () => unknown): { reason: string; detail: string } {
  try {
    read();
  } catch (error) {
    if (error instanceof Unavailable) return { reason: error.reason, detail: error.detail };
    throw error;
  }
  throw new Error("no failure");
}

describe("[A2.3.7.bridge.discovery] finding the service", () => {
  test("the folders of ~/.tasks on every OS, from the account or USERPROFILE, never from XDG_*", () => {
    const xdg = { XDG_STATE_HOME: "/elsewhere", XDG_CACHE_HOME: "/elsewhere" };
    expect(installFolders(facts("linux", { HOME: "/snap/x", ...xdg }, "/home/mira"))).toEqual({
      state: "/home/mira/.tasks/state",
      cache: "/home/mira/.tasks/cache",
    });
    expect(installFolders(facts("darwin", {}, "/Users/mira"))).toEqual({
      state: "/Users/mira/.tasks/state",
      cache: "/Users/mira/.tasks/cache",
    });
    expect(installFolders(facts("win32", { USERPROFILE: "C:\\Users\\mira" }))).toEqual({
      state: "C:\\Users\\mira\\.tasks\\state",
      cache: "C:\\Users\\mira\\.tasks\\cache",
    });
    expect(installFolders(facts("linux", { TASKS_HOME: "/tmp/test-home" }, "/home/mira"))).toEqual({
      state: "/tmp/test-home/state",
      cache: "/tmp/test-home/cache",
    });
    expect(() =>
      installFolders(facts("linux", { TASKS_HOME: "relative" }, "/home/mira")),
    ).toThrow();
    expect(() => installFolders(facts("linux", {}))).toThrow();
  });

  test("service.json: missing is not_running, binding is starting, a bad endpoint is unreachable", () => {
    const platform = process.platform;
    expect(failure(() => readEndpoint(state, platform))).toEqual({
      reason: "not_running",
      detail: "no_service_file",
    });
    const write = (value: unknown) => {
      writeFileSync(
        join(state, "service.json"),
        typeof value === "string" ? value : JSON.stringify(value),
      );
    };
    write("{torn");
    expect(failure(() => readEndpoint(state, platform)).reason).toBe("not_running");
    write({ state: "starting", endpoint: null });
    expect(failure(() => readEndpoint(state, platform)).reason).toBe("starting");
    write({ state: "ready", endpoint: { kind: "unix", path: "relative/tasks.sock" } });
    expect(failure(() => readEndpoint(state, platform))).toEqual({
      reason: "unreachable",
      detail: "bad_endpoint",
    });
    const path =
      platform === "win32"
        ? "\\\\.\\pipe\\tasks-q7mw2c4k9x-abc"
        : "/run/user/1000/tasks-q7mw2c4k9x/tasks.sock";
    write({ state: "ready", endpoint: { kind: platform === "win32" ? "pipe" : "unix", path } });
    expect(readEndpoint(state, platform)).toBe(path);
    write("x".repeat(70_000));
    expect(failure(() => readEndpoint(state, platform)).reason).toBe("unreachable");
  });

  test("ipc.key: the 32 bytes, and unreachable when it is missing or not a key", () => {
    expect(failure(() => readKey(state, process.platform))).toEqual({
      reason: "unreachable",
      detail: "ENOENT",
    });
    writeFileSync(join(state, "ipc.key"), "not a key");
    expect(failure(() => readKey(state, process.platform))).toEqual({
      reason: "unreachable",
      detail: "bad_key",
    });
    const key = Buffer.alloc(32, 7);
    writeFileSync(join(state, "ipc.key"), `${key.toString("base64url")}\n`);
    expect(readKey(state, process.platform)).toEqual(key);
  });
});
