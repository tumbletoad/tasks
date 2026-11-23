// What every TTasks process a test starts with a clean environment gets: none of the test shell's
// TTasks or agent app variables, and an Agent Monitor that does not exist unless the test names one.
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { testEnv } from "./env.ts";
import { NO_MONITOR } from "./no-monitor.ts";

const set = ["TTASKS_HOME", "TTASKS_MONITOR", "CLAUDECODE", "CODEX_THREAD_ID", "KF_KEPT"];
const before = new Map(set.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const [name, value] of before) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
});

describe("[A7.testkit.clean-env] a test's clean environment", () => {
  test("no TTasks or agent variable of the shell, no real monitor; extra adds, replaces and removes", () => {
    Object.assign(process.env, {
      TTASKS_HOME: "/shell/home",
      TTASKS_MONITOR: "/shell/ttam",
      CLAUDECODE: "1",
      CODEX_THREAD_ID: "t",
      KF_KEPT: "kept",
    });
    const env = testEnv({ TTASKS_HOME: "/test/home" });
    expect(env["TTASKS_HOME"]).toBe("/test/home");
    expect(env["TTASKS_MONITOR"]).toBe(NO_MONITOR);
    expect(isAbsolute(NO_MONITOR) && !existsSync(NO_MONITOR)).toBe(true);
    expect(env["CLAUDECODE"]).toBeUndefined();
    expect(env["CODEX_THREAD_ID"]).toBeUndefined();
    expect(env["KF_KEPT"]).toBe("kept");
    expect(testEnv({ TTASKS_MONITOR: "/fake/ttam" })["TTASKS_MONITOR"]).toBe("/fake/ttam");
    expect(testEnv({ KF_KEPT: undefined })).not.toHaveProperty("KF_KEPT");
  });
});
