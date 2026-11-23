// `ttasks doctor`'s monitor row against the service's answers: found and fitting, missing, a
// script, a build without `ttam query`, a version that does not fit (naming the side to update),
// a failed start, and an older service that does not answer. None fails the report.
import { describe, expect, test } from "vitest";
import { monitorCheck } from "../src/doctor-monitor.ts";

const BUILD = { version: "0.1.0", build: "0123456789ab" };

describe("[A3.3.14.doctor.monitor] doctor's monitor row", () => {
  test("found and fitting names its version; not installed is no fault and says what it adds", () => {
    expect(monitorCheck({ fits: true, build: BUILD })).toEqual({
      id: "monitor",
      status: "ok",
      detail: "TTAM 0.1.0 (0123456789ab) is found and fits.",
    });
    const missing = monitorCheck({
      fits: false,
      problem: { kind: "not_installed", reason: "not_found" },
    });
    expect(missing.status).toBe("skip");
    expect(missing.detail).toContain("TTAM is not installed");
  });

  test("a script, an old build and a version that does not fit warn with what to do", () => {
    const row = (problem: object) => monitorCheck({ fits: false, problem });
    expect(row({ kind: "not_installed", reason: "script" })).toMatchObject({ status: "warn" });
    expect(row({ kind: "not_installed", reason: "no_query" }).detail).toContain("Update TTAM.");
    expect(row({ kind: "does_not_fit", update: "ttasks", found: BUILD })).toEqual({
      id: "monitor",
      status: "warn",
      detail: "TTAM 0.1.0 (0123456789ab) does not fit this TTasks. Update TTasks.",
    });
    expect(row({ kind: "does_not_fit", update: "monitor", found: null }).detail).toBe(
      "TTAM does not fit this TTasks. Update TTAM.",
    );
    const failed = row({ kind: "failed", reason: "no_hello" });
    expect(failed.status).toBe("warn");
    expect(failed.detail).toContain("Run: ttam doctor");
  });

  test("an older service that does not answer skips the row", () => {
    expect(monitorCheck(undefined)).toMatchObject({ status: "skip" });
    expect(monitorCheck(null)).toMatchObject({ status: "skip" });
  });
});
