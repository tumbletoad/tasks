import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_KINDS } from "@ttasks/bridge/protocol";
import { afterEach, describe, expect, test } from "vitest";
import {
  BIND_REFUSALS,
  CONNECTION_CLASSES,
  HANDSHAKE_FAILURES,
  HANDSHAKE_STAGES,
  RPC_METHODS,
  type LocalEvent,
} from "../local/index.ts";
import { logLocal } from "./endpoint.ts";
import {
  EVENTS,
  fieldAllowed,
  formatEvent,
  LOG_FILE,
  LOG_FILES_KEPT,
  Logger,
  RECENT_LINES,
  type EventName,
  type FieldKind,
} from "./log.ts";

// Free text a caller might try to pass: task text, paths of every OS, a token, an environment
// value with a newline, and text shaped like the closed words.
const FREE_TEXT = [
  "Fix appointment time zones",
  "/home/mira/Tasks/work",
  "C:\\Users\\mira\\Tasks\\work",
  "ttasks_u_3q7k9d2xw8f4r6t1c5v0b2n8aaXYZ",
  "CODEX_THREAD_ID=019a\nsecret",
  "missing because of the sync client",
  "ENOENT: no such file or directory, open '/home/mira/Tasks/work/space.json'",
];

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "kh-log-"));
  roots.push(dir);
  return dir;
};

describe("[A2.3.13.hub.logs-content-free] the log takes no free text", () => {
  test("no field of any catalogue event accepts free text", () => {
    for (const [event, spec] of Object.entries(EVENTS)) {
      const fields: Readonly<Record<string, FieldKind>> = spec.fields;
      for (const [field, kind] of Object.entries(fields)) {
        for (const text of FREE_TEXT) {
          expect(fieldAllowed(kind, text), `${event}.${field}`).toBe(false);
        }
        expect(fieldAllowed(kind, { text: FREE_TEXT[0] }), `${event}.${field}`).toBe(false);
        expect(fieldAllowed(kind, [FREE_TEXT[0]]), `${event}.${field}`).toBe(false);
      }
    }
  });

  test("ttasks-local/1's events enter the catalogue whole, and only the library's listed words do", () => {
    const at = { t: new Date("2026-11-13T08:00:00Z"), pid: 4120 };
    const events: LocalEvent[] = [
      ...HANDSHAKE_STAGES.flatMap((stage) =>
        HANDSHAKE_FAILURES.map((reason): LocalEvent => ({
          ev: "local.handshake_failed",
          stage,
          reason,
        })),
      ),
      ...BIND_REFUSALS.map((reason): LocalEvent => ({ ev: "local.bind_refused", reason })),
      ...CONNECTION_CLASSES.flatMap((cls) =>
        CLIENT_KINDS.map((kind): LocalEvent => ({
          ev: "local.bound",
          conn: 7,
          class: cls,
          mode: "rpc",
          kind,
          protocol: 1,
          ms: 3,
        })),
      ),
      { ev: "local.frame_too_large", conn: 1 },
      { ev: "local.slow_reader", conn: 1 },
      ...Object.keys(RPC_METHODS).map((method): LocalEvent => ({
        ev: "local.handler_failed",
        conn: 2,
        method: method as keyof typeof RPC_METHODS,
      })),
      { ev: "local.revoked", conn: 3 },
      { ev: "local.listen_error", code: "EACCES" },
    ];
    for (const event of events) {
      const { ev, ...fields } = event;
      const line = JSON.parse(formatEvent(ev, fields, at).line) as Record<string, unknown>;
      expect(line, ev).toMatchObject({ ...fields, ev, c: "local" });
      expect(line["dropped"], ev).toBeUndefined();
    }
    // A reason the library does not list, cast past its types, is dropped.
    for (const text of FREE_TEXT) {
      const line = JSON.parse(
        formatEvent("local.handshake_failed", { stage: "hello", reason: text }, at).line,
      ) as Record<string, unknown>;
      expect(line["reason"]).toBeUndefined();
      expect(line["dropped"]).toBe(1);
    }
    // The adapter passes an event through as it is.
    const dir = tempDir();
    const log = new Logger({ dir, stderr: false, level: "debug" });
    for (const event of events) logLocal(log, event);
    const written = readFileSync(join(dir, LOG_FILE), "utf8").trim().split("\n");
    expect(written).toHaveLength(events.length);
    expect(written.every((l) => !l.includes('"dropped"'))).toBe(true);
  });

  test("values cast past the types are dropped, unknown fields and events too", () => {
    const at = { t: new Date("2026-11-13T08:00:00Z"), pid: 4120 };
    const { line } = formatEvent(
      "space.unavailable",
      {
        entry: 2,
        reason: FREE_TEXT[0],
        code: FREE_TEXT[6],
        space: FREE_TEXT[1],
        title: FREE_TEXT[0],
        ms: Number.NaN,
      },
      at,
    );
    expect(JSON.parse(line)).toEqual({
      t: "2026-11-13T08:00:00.000Z",
      lvl: "warn",
      c: "space",
      ev: "space.unavailable",
      pid: 4120,
      entry: 2,
      dropped: 5,
    });
    const unknown = JSON.parse(formatEvent(FREE_TEXT[0] ?? "", {}, at).line) as Record<
      string,
      unknown
    >;
    expect(unknown["ev"]).toBe("log.invalid_event");
    for (const text of FREE_TEXT) expect(line).not.toContain(text);

    // Typed values pass.
    const ok = JSON.parse(
      formatEvent(
        "space.open",
        {
          entry: 0,
          space: "sp_7c0hq2m4w9d8k1r6t3v5x0b2nf",
          ms: 12,
          registered: true,
          migrated: false,
        },
        at,
      ).line,
    ) as Record<string, unknown>;
    expect(ok).toMatchObject({ space: "sp_7c0hq2m4w9d8k1r6t3v5x0b2nf", ms: 12, registered: true });
    expect(ok["dropped"]).toBeUndefined();
  });

  test("the Logger writes JSON lines, keeps the last 200 for a crash file and never throws", () => {
    const dir = tempDir();
    const log = new Logger({ dir: join(dir, "logs"), stderr: false });
    for (let i = 0; i < RECENT_LINES + 5; i += 1) log.log("space.opening", { entry: i });
    log.log("service.refused", { reason: "packaged" });
    const lines = readFileSync(join(dir, "logs", LOG_FILE), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(RECENT_LINES + 6);
    for (const line of lines) expect(() => JSON.parse(line) as unknown).not.toThrow();
    expect(log.recent()).toHaveLength(RECENT_LINES);
    expect(log.recent().at(-1)).toContain('"reason":"packaged"');
    // Debug events stay out at the default level.
    log.log("service.lock_acquired", { ms: 3 });
    expect(readFileSync(join(dir, "logs", LOG_FILE), "utf8")).not.toContain("lock_acquired");
    // A log that cannot be written is not an error for the caller.
    const blocked = new Logger({ dir: join(dir, "logs", LOG_FILE, "nested"), stderr: false });
    expect(() => {
      blocked.log("service.machine_created");
    }).not.toThrow();
    expect(blocked.failed).toBe(true);
  });

  test("only the lock holder rotates: at the limit, keeping 5 files", () => {
    const dir = tempDir();
    const logs = join(dir, "logs");
    const other = new Logger({ dir: logs, stderr: false, maxBytes: 400 });
    for (let i = 0; i < 40; i += 1) other.log("space.opening", { entry: i });
    // Not the holder: one file, however long.
    expect(readdirSync(logs)).toEqual([LOG_FILE]);

    const holder = new Logger({ dir: logs, stderr: false, maxBytes: 400 });
    holder.own();
    for (let i = 0; i < 200; i += 1) holder.log("space.opening", { entry: i });
    const files = readdirSync(logs).sort();
    expect(files).toEqual([
      LOG_FILE,
      ...Array.from({ length: LOG_FILES_KEPT - 1 }, (_, i) => `${LOG_FILE}.${String(i + 1)}`),
    ]);
    for (const file of files) {
      expect(readFileSync(join(logs, file)).length).toBeLessThanOrEqual(400);
    }
    expect(existsSync(join(logs, `${LOG_FILE}.${String(LOG_FILES_KEPT)}`))).toBe(false);
  });

  test("the holder rotates on the file's real size, other starts' lines included", () => {
    const dir = tempDir();
    const logs = join(dir, "logs");
    const holder = new Logger({ dir: logs, stderr: false, maxBytes: 400 });
    holder.own();
    holder.log("space.opening", { entry: 0 });
    // Second starts append to the same file and never rotate it.
    const other = new Logger({ dir: logs, stderr: false, maxBytes: 400 });
    for (let i = 0; i < 40; i += 1) other.log("space.opening", { entry: i });
    expect(readdirSync(logs)).toEqual([LOG_FILE]);
    // The holder's next line sees the file over its limit and rotates it first.
    holder.log("space.opening", { entry: 1 });
    expect(readdirSync(logs).sort()).toEqual([LOG_FILE, `${LOG_FILE}.1`]);
    expect(readFileSync(join(logs, LOG_FILE)).length).toBeLessThanOrEqual(400);
  });

  test("second starts stop appending once the file is full, so an idle holder's log stays bounded", () => {
    const dir = tempDir();
    const logs = join(dir, "logs");
    const holder = new Logger({ dir: logs, stderr: false, maxBytes: 400 });
    holder.own();
    holder.log("space.opening", { entry: 0 });
    // The holder logs nothing more; many second starts come and go.
    for (let i = 0; i < 40; i += 1) {
      new Logger({ dir: logs, stderr: false, maxBytes: 400 }).log("service.locked", { holder: i });
    }
    const longest = 200;
    expect(readFileSync(join(logs, LOG_FILE)).length).toBeLessThanOrEqual(400 + longest);
    // They still keep their lines for a crash file of their own.
    const other = new Logger({ dir: logs, stderr: false, maxBytes: 400 });
    other.log("service.locked", { holder: 7 });
    expect(other.recent()).toHaveLength(1);
  });

  test("codes and class names come from closed lists, so identifier-shaped text is refused", () => {
    for (const code of ["ENOENT", "EADDRINUSE", "EPERM", "ERR_INVALID_ARG_TYPE", "STORAGE_BUSY"]) {
      expect(fieldAllowed("error_code", code), code).toBe(true);
    }
    // Shaped like codes, but made of data: never written.
    for (const code of ["ECUSTOMERRENEWAL", "ERR_CUSTOMER_RENEWAL", "EMIRA"]) {
      expect(fieldAllowed("error_code", code), code).toBe(false);
    }
    for (const type of ["Error", "TypeError", "StorageError", "ServiceExit"]) {
      expect(fieldAllowed("error_type", type), type).toBe(true);
    }
    for (const type of ["CustomerRenewal", "FixAppointmentTimeZones"]) {
      expect(fieldAllowed("error_type", type), type).toBe(false);
    }
  });

  test("every event names a level and a component, and its name is dotted", () => {
    for (const [event, spec] of Object.entries(EVENTS) as [
      EventName,
      (typeof EVENTS)[EventName],
    ][]) {
      expect(event).toMatch(/^[a-z]+\.[a-z_]+$/);
      expect(["debug", "info", "warn", "error"]).toContain(spec.lvl);
      expect(["hub", "space", "local", "http", "mcp", "launch"]).toContain(spec.c);
    }
  });
});
