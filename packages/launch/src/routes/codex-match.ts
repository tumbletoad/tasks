// Codex's native thread ID by reference match (A4 3.4.3, L15): Codex cannot preset an ID, so for
// up to two minutes after its start Tasks looks for the session file of this launch. A file
// matches only when its `session_meta` record names this launch's folder and a user message in it
// starts with this launch's brief: the reference counts only in the brief's first line, after the
// title's closing quote (briefReference), never where a title or an instruction file quotes one.
// The reference is unique among the space's launches, so the match is identity, not a guess by
// folder and time (A4 L15); two files that both match give no ID at all.
//
// What is read, and nothing else: in the instance's own Codex home, `sessions/<yyyy>/<mm>/<dd>/`
// of the days around the launch, files named `rollout-*.jsonl` that were not there when the
// launch was dispatched, each regular file's first 64 KB. Never an older file, a compressed
// `.jsonl.zst`, a link, or another home. Nothing read is logged or kept but the thread ID.
//
// Measured and assumed: the layout and the record shapes are taken from
// A4 3.4.3 and Codex's source as A4 read it. Lab row L04 has not run, so a file in another shape
// matches nothing: no native ID, and therefore no Resume, never a wrong one.
import { closeSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { briefReference } from "../brief/render.ts";
import { EVIDENCE_ID } from "../intents.ts";

/** A4 3.4.3: at most the first 64 KB of a file is read. */
export const ROLLOUT_READ_BYTES = 64 * 1024;
/** A4 3.4.3: Tasks looks for two minutes after the agent's start. */
export const MATCH_WINDOW_MS = 120_000;
/** How often the folders are looked at while the window is open. */
export const MATCH_POLL_MS = 1_000;

const ROLLOUT = /^rollout-[A-Za-z0-9._-]{1,200}\.jsonl$/;

/** What one launch looks for. */
export interface MatchTarget {
  /** The folder the agent works in, as the claim's reply gave it (`-C <folder>`). */
  readonly folder: string;
  /** The launch reference in the brief, such as `L7KQ2M`. */
  readonly reference: string;
  readonly platform: NodeJS.Platform;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The texts of a user message record, in either of Codex's two forms. */
function userTexts(record: Record<string, unknown>): string[] {
  const payload = record["payload"];
  if (!isObject(payload)) return [];
  // An event: `{"type":"event_msg","payload":{"type":"user_message","message":"…"}}`.
  if (record["type"] === "event_msg" && payload["type"] === "user_message") {
    return typeof payload["message"] === "string" ? [payload["message"]] : [];
  }
  // A model input item: `{"type":"response_item","payload":{"type":"message","role":"user",
  // "content":[{"type":"input_text","text":"…"}]}}`.
  if (
    record["type"] === "response_item" &&
    payload["type"] === "message" &&
    payload["role"] === "user" &&
    Array.isArray(payload["content"])
  ) {
    return payload["content"].flatMap((part: unknown) =>
      isObject(part) && typeof part["text"] === "string" ? [part["text"]] : [],
    );
  }
  return [];
}

/** Whether two folders are the same as Codex spells them: exact, without case on Windows. */
const sameFolder = (a: string, b: string, platform: NodeJS.Platform): boolean =>
  platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

/**
 * What a session file's start (its first 64 KB as text) says about this launch:
 * - `match` with the thread ID: the `session_meta` record names the folder, and a user message
 *   holds the reference;
 * - `other`: another launch's or another session's (another folder, the person's own message
 *   without the reference, no session record before the first user message, or a full 64 KB
 *   without the reference). It is not read again;
 * - `pending`: it may still become this launch's (Codex writes the prompt after the session
 *   record), so it is read again at the next look.
 * A partial last line, a line that is not JSON and an unknown record are skipped. Model input
 * items Codex adds itself (its environment, the folder's instructions) do not decide.
 */
export function readRollout(
  text: string,
  target: MatchTarget,
  full: boolean,
): { readonly kind: "match"; readonly thread: string } | { readonly kind: "other" | "pending" } {
  let thread: string | undefined;
  const lines = text.split("\n");
  // The last line may be cut by the 64 KB bound, or still being written: only whole lines count.
  if (!text.endsWith("\n")) lines.pop();
  for (const line of lines) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(record)) continue;
    if (record["type"] === "session_meta") {
      if (thread !== undefined) continue;
      const payload = record["payload"];
      if (!isObject(payload)) return { kind: "other" };
      const { id, cwd } = payload;
      if (typeof id !== "string" || !EVIDENCE_ID.test(id) || typeof cwd !== "string") {
        return { kind: "other" };
      }
      if (!sameFolder(cwd, target.folder, target.platform)) return { kind: "other" };
      thread = id;
      continue;
    }
    const texts = userTexts(record);
    if (texts.length === 0) continue;
    if (thread === undefined) return { kind: "other" };
    // A brief's reference, read from its first line's fixed place only: a title or an instruction
    // file that quotes a reference never counts (briefReference).
    const references = texts.map((t) => briefReference(t.trimStart()));
    if (references.includes(target.reference)) return { kind: "match", thread };
    // Another launch's brief: its session.
    if (references.some((r) => r !== undefined)) return { kind: "other" };
    // The person's own first message, not a brief: another session in this folder. What Codex
    // adds itself (its environment, the folder's instructions) is a model input item and does
    // not decide.
    if (record["type"] === "event_msg") return { kind: "other" };
  }
  return full ? { kind: "other" } : { kind: "pending" };
}

/** The thread ID when the file is this launch's (readRollout's `match`), else undefined. */
export function matchRollout(text: string, target: MatchTarget): string | undefined {
  const read = readRollout(text, target, true);
  return read.kind === "match" ? read.thread : undefined;
}

/** `yyyy/mm/dd` of an instant in the machine's local time and in UTC (Codex's folder per day). */
export function dayFolders(at: number): string[] {
  const local = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const days = [
    `${String(local.getFullYear())}/${pad(local.getMonth() + 1)}/${pad(local.getDate())}`,
    `${String(local.getUTCFullYear())}/${pad(local.getUTCMonth() + 1)}/${pad(local.getUTCDate())}`,
  ];
  return [...new Set(days)];
}

/** The file system as the matcher reads it. Tests pass fake session folders. */
export interface RolloutFiles {
  /** The `rollout-*.jsonl` names of a folder that are regular files; empty when it is not there. */
  list(folder: string): string[];
  /** A regular file's first `bytes`, as UTF-8; undefined when it is not one or cannot be read. */
  head(path: string, bytes: number): string | undefined;
}

/** The OS's files: lstat first, so a link is never followed. */
export const osRolloutFiles: RolloutFiles = {
  list(folder) {
    let names: string[];
    try {
      names = readdirSync(folder);
    } catch {
      return [];
    }
    return names.filter((name) => {
      if (!ROLLOUT.test(name)) return false;
      try {
        return lstatSync(join(folder, name)).isFile();
      } catch {
        return false;
      }
    });
  },
  head(path, bytes) {
    let fd: number | undefined;
    try {
      if (!lstatSync(path).isFile()) return undefined;
      fd = openSync(path, "r");
      const buffer = Buffer.alloc(bytes);
      const read = readSync(fd, buffer, 0, bytes, 0);
      return buffer.subarray(0, read).toString("utf8");
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  },
};

/**
 * One launch's watch over a Codex home. `before` is taken at dispatch (the names already there),
 * `look` at each poll after the agent's start: it reads each new file once and returns the
 * thread ID of the first that matches.
 */
export class ReferenceMatch {
  readonly #sessions: string;
  readonly #target: MatchTarget;
  readonly #files: RolloutFiles;
  readonly #days: string[];
  /** Names there at dispatch, and files that are another launch's: never read (again). */
  readonly #seen = new Set<string>();
  #settled = false;

  /** `home` is the Codex home; `at` the dispatch's wall-clock time. */
  constructor(home: string, target: MatchTarget, at: number, files: RolloutFiles = osRolloutFiles) {
    this.#sessions = join(home, "sessions");
    this.#target = target;
    this.#files = files;
    this.#days = dayFolders(at);
    // What is there before the launch is never read.
    for (const day of this.#days) {
      for (const name of files.list(this.#folder(day))) this.#seen.add(join(day, name));
    }
  }

  #folder(day: string): string {
    return join(this.#sessions, ...day.split("/"));
  }

  /**
   * The watch has ended without a match: two session files held this launch's brief, so neither
   * is known to be its own. Nothing more is read.
   */
  get settled(): boolean {
    return this.#settled;
  }

  /**
   * Reads the files that appeared since; the thread ID of this launch's, or undefined. Two files
   * that both match in one look settle the watch without a match: a native ID is identity, never
   * a pick between two sessions.
   */
  look(now: number): string | undefined {
    if (this.#settled) return undefined;
    const days = [...new Set([...this.#days, ...dayFolders(now)])];
    const threads = new Set<string>();
    for (const day of days) {
      const folder = this.#folder(day);
      for (const name of this.#files.list(folder).sort()) {
        const key = join(day, name);
        if (this.#seen.has(key)) continue;
        const text = this.#files.head(join(folder, name), ROLLOUT_READ_BYTES);
        if (text === undefined) continue;
        const full = Buffer.byteLength(text, "utf8") >= ROLLOUT_READ_BYTES;
        const read = readRollout(text, this.#target, full);
        if (read.kind === "match") threads.add(read.thread);
        // Another's is never read again; one that may still become this launch's is.
        if (read.kind === "other") this.#seen.add(key);
      }
    }
    if (threads.size > 1) this.#settled = true;
    return threads.size === 1 ? [...threads][0] : undefined;
  }
}
