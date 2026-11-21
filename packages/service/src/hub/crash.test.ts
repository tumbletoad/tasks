import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  crashRecord,
  errorCode,
  errorType,
  fileStamp,
  refusalRecord,
  sanitizeStack,
  writeCrashFile,
} from "./crash.ts";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TITLE = "Fix appointment time zones";
const PATH_UNIX = "/home/mira/Tasks/work/space.json";
const PATH_WIN = "C:\\Users\\mira\\Tasks\\work\\space.json";

/** An error whose message holds task text, paths and a line shaped like a stack frame. */
function hostileError(): Error {
  const error = new Error(
    `${TITLE} at ${PATH_UNIX}\n    at ${TITLE.replaceAll(" ", "")} (${PATH_WIN}:1:2)\n    at Fix appointment (${PATH_UNIX}:3:4)`,
  );
  error.stack = [
    `Error: ${error.message}`,
    "    at SpaceManager.open (file:///C:/Users/mira/.local/share/ttasks/versions/0.3.0/lib/spaces.ts:120:5)",
    "    at async Promise.all (index 0)",
    `    at readManifest (${PATH_WIN.replace("space.json", "manifest.ts")}:44:11)`,
    "    at node:internal/process/task_queues:105:5",
    `    at eval (eval at <anonymous> (${PATH_UNIX}:1:1), <anonymous>:1:1)`,
  ].join("\n");
  return error;
}

describe("[A2.3.13.hub.crash-files] crash files hold no content", () => {
  test("stack frames keep only a base name and a position, never the message, a path or a name", () => {
    const frames = sanitizeStack(hostileError());
    expect(frames).toEqual([
      "at spaces.ts:120:5",
      "at ?",
      "at manifest.ts:44:11",
      "at task_queues:105:5",
      "at ?",
    ]);
    const text = frames.join("\n");
    for (const part of [TITLE, "mira", "Users", "home", "Tasks", "FixAppointment"]) {
      expect(text).not.toContain(part);
    }
    expect(sanitizeStack("not an error")).toEqual([]);
  });

  test("names JavaScript derives from data never reach a crash record", () => {
    // A function or class stored under a computed key takes the key as its name, so a name in a
    // stack frame, or a class name, can be data.
    const TOKEN = "FixAppointmentTimeZones";
    const handlers: Record<string, () => never> = {
      [TOKEN]: () => {
        throw Object.assign(new Error("x"), { code: "ERR_FIX_APPOINTMENT_TIME_ZONES" });
      },
    };
    const made: Record<string, new () => Error> = { [TOKEN]: class extends TypeError {} };
    let thrown: unknown;
    try {
      handlers[TOKEN]?.();
    } catch (error) {
      thrown = error;
    }
    const record = crashRecord(
      thrown,
      "service.crash",
      { version: "0.0.0", build: "source", startedAt: 0 },
      [],
      new Date(0),
    );
    expect(JSON.stringify(record)).not.toContain(TOKEN);
    expect(JSON.stringify(record)).not.toContain("FIX_APPOINTMENT");
    const Made = made[TOKEN];
    if (Made === undefined) throw new Error("no class");
    expect(errorType(new Made())).toBe("TypeError");
  });

  test("the error's class and a fixed code only", () => {
    expect(errorType(hostileError())).toBe("Error");
    expect(errorType(new TypeError("x"))).toBe("TypeError");
    expect(errorType("thrown text")).toBe("NonError");
    class Weird extends Error {}
    Object.defineProperty(Weird, "name", { value: TITLE });
    expect(errorType(new Weird())).toBe("Error");
    expect(errorCode(Object.assign(new Error(), { code: "ENOENT" }))).toBe("ENOENT");
    expect(errorCode(Object.assign(new Error(), { code: "ERR_INVALID_ARG_TYPE" }))).toBe(
      "ERR_INVALID_ARG_TYPE",
    );
    expect(errorCode(Object.assign(new Error(), { code: "STORAGE_BUSY" }))).toBe("STORAGE_BUSY");
    expect(errorCode(Object.assign(new Error(), { code: TITLE }))).toBeUndefined();
    expect(errorCode(Object.assign(new Error(), { code: PATH_UNIX }))).toBeUndefined();
  });

  test("a crash file is written atomically, user-only, and holds none of the error's text", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "kh-crash-")), "crash");
    roots.push(join(dir, ".."));
    const now = new Date("2026-11-13T08:01:12.031Z");
    const recent = ['{"t":"2026-11-13T08:01:11.000Z","lvl":"info","c":"hub","ev":"service.ready"}'];
    const record = crashRecord(
      hostileError(),
      "service.crash",
      { version: "0.0.0", build: "source", startedAt: now.getTime() - 5_000 },
      recent,
      now,
    );
    const name = writeCrashFile(dir, record, now);
    expect(name).toBe(`${fileStamp(now)}-${String(process.pid)}.json`);
    expect(name).toBe(`20261113T080112031Z-${String(process.pid)}.json`);
    expect(readdirSync(dir)).toEqual([name]);
    const text = readFileSync(join(dir, name), "utf8");
    for (const part of [TITLE, PATH_UNIX, PATH_WIN, "mira"]) expect(text).not.toContain(part);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      format: 1,
      event: "service.crash",
      pid: process.pid,
      uptime_ms: 5_000,
      error: { type: "Error" },
      log: [{ ev: "service.ready" }],
    });
    if (process.platform !== "win32") expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);

    const refusal = refusalRecord(
      "packaged",
      { version: "0.0.0", build: "source", startedAt: now.getTime() },
      [],
      now,
    );
    expect(refusal).toMatchObject({ event: "service.refused", reason: "packaged" });
  });
});
