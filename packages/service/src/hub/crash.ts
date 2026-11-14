// Crash files (A2 3.13): an uncaught exception or an unhandled rejection in the hub writes
// `<state>/crash/<time>-<pid>.json` and the service exits 70. Nothing is uploaded.
//
// A crash file is content-free by construction, like the log. An error's message can hold anything
// (a path in an fs error, a value in a validation error), so it is never written. The record keeps
// the error's class and code from the log's closed lists, and its stack frames reduced to a file's
// base name with line and column, checked against a strict shape. Function names are left out:
// JavaScript names a function after the computed key it is stored under, so a name can be data,
// and the file, line and column of a known build already locate the code. The last log lines are
// the log's own, which are already content-free.
//
// Node's fatal-error reports (out of memory, a native abort) go to the same folder with the
// environment excluded (A2 3.13).
import { join } from "node:path";
import type { Refusal } from "./exit.ts";
import { atomicWrite, makeDir } from "./files.ts";
import { fieldAllowed } from "./log.ts";

export const CRASH_FORMAT = 1;
/** The most stack frames a crash file keeps. */
export const MAX_FRAMES = 40;

const FRAME = /^\s*at\s+(.*)$/;
const FILE_NAME = /^[\w.-]{1,100}$/;

/** The base name of a frame's location, `name.ts:12:5`, or undefined when it has no such shape. */
function location(text: string): string | undefined {
  const match = /([^\\/()]+?):(\d{1,7}):(\d{1,7})\)?$/.exec(text);
  if (match === null) return undefined;
  const [, file = "", line = "", column = ""] = match;
  return FILE_NAME.test(file) ? `${file}:${line}:${column}` : undefined;
}

/**
 * An error's stack frames as `at file.ts:1:2`, with every path cut to its base name and no
 * function name. A frame whose location does not fit the strict shape becomes `at ?`. The lines of
 * the header, which hold the message, are skipped first, so a message that contains a line shaped
 * like a frame is never read as one.
 */
export function sanitizeStack(error: unknown): string[] {
  if (!(error instanceof Error) || typeof error.stack !== "string") return [];
  const lines = error.stack.split(/\r?\n/);
  const message = typeof error.message === "string" ? error.message : "";
  const header = message === "" ? 1 : message.split(/\r?\n/).length;
  const frames: string[] = [];
  for (const line of lines.slice(header)) {
    const match = FRAME.exec(line);
    if (match === null) continue;
    const where = location((match[1] ?? "").trim());
    frames.push(where === undefined ? "at ?" : `at ${where}`);
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames;
}

/**
 * The error's class: the nearest class in its chain that the log's closed list names (a class of
 * its own that extends TypeError is "TypeError"), else "Error", or "NonError" for a thrown value
 * that is not an Error.
 */
export function errorType(error: unknown): string {
  if (!(error instanceof Error)) return "NonError";
  for (let c: unknown = error.constructor; typeof c === "function"; c = Object.getPrototypeOf(c)) {
    const name = (c as { name?: unknown }).name;
    if (fieldAllowed("error_type", name)) return name as string;
  }
  return "Error";
}

/** The error's code when the log would take it: an errno name, a Node or a storage code. */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && fieldAllowed("error_code", code) ? code : undefined;
}

export interface CrashContext {
  readonly version: string;
  readonly build: string;
  /** When the process started, ms since 1970. */
  readonly startedAt: number;
}

const header = (event: string, context: CrashContext, now: Date) => ({
  format: CRASH_FORMAT,
  event,
  t: now.toISOString(),
  pid: process.pid,
  version: context.version,
  build: context.build,
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  uptime_ms: Math.max(0, now.getTime() - context.startedAt),
});

const parsedLines = (recent: readonly string[]): unknown[] =>
  recent.map((line) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return null;
    }
  });

/** The crash record of one error: an uncaught one, or a failure while starting. */
export function crashRecord(
  error: unknown,
  event: "service.crash" | "service.start_failed",
  context: CrashContext,
  recent: readonly string[],
  now: Date,
): Record<string, unknown> {
  const code = errorCode(error);
  return {
    ...header(event, context, now),
    error: { type: errorType(error), ...(code === undefined ? {} : { code }) },
    stack: sanitizeStack(error),
    log: parsedLines(recent),
  };
}

/**
 * The record of a refusal (exit 64), so the reason is in `<state>/crash/` for a service manager
 * that only sees the exit code (A2 3.3.1, the macOS wrapper turns 64 into 0).
 */
export function refusalRecord(
  reason: Refusal,
  context: CrashContext,
  recent: readonly string[],
  now: Date,
): Record<string, unknown> {
  return { ...header("service.refused", context, now), reason, log: parsedLines(recent) };
}

/** `2026-11-12T08:01:12.031Z` as `20261112T080112031Z`, safe in a Windows file name. */
export const fileStamp = (now: Date): string => now.toISOString().replace(/[-:.]/g, "");

/** Writes a crash record and returns its file name. Throws when the folder cannot be written. */
export function writeCrashFile(dir: string, record: Record<string, unknown>, now: Date): string {
  makeDir(dir, 0o700);
  const name = `${fileStamp(now)}-${String(process.pid)}.json`;
  atomicWrite(join(dir, name), `${JSON.stringify(record, null, 2)}\n`);
  return name;
}

/**
 * Sends Node's fatal-error reports to the crash folder without the environment (A2 3.13). Only fatal
 * errors: an uncaught exception's report would quote the error's message.
 */
export function routeNodeReports(dir: string): void {
  const report = process.report;
  report.directory = dir;
  report.excludeEnv = true;
  report.reportOnFatalError = true;
  report.reportOnUncaughtException = false;
  report.reportOnSignal = false;
}
