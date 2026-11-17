// The words a person typed for an agent when they pressed Open, held for that launch on this
// computer: never on a command line, in a link or in the space. The agent reads them through
// Tasks' tools with its launch reference (`get_task`, or `tasks show --launch` without the tools).
//
// Each one is `request.json` (0600) in the launch's own folder under the install's launch root
// (0700, records.ts), beside a terminal launch's `launch.json`: Linux keeps that root on the
// per-user tmpfs, Windows in the install's state. The file goes with its launch: a terminal
// launch's folder is removed when its launch ends, and the service's sweep removes the rest
// (launch/service.ts). Whether an agent read it is kept with it, so the page clears the person's
// field only once the words reached the agent.
import { readdirSync, readFileSync, rmdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, makeDir } from "@tasks/files";
import { LAUNCH_FILE_MODE, LAUNCH_FOLDER_MODE } from "./shim/records.ts";
import { LAUNCH_ID } from "./store.ts";

export const REQUEST_FILE = "request.json";

/** As long as a launch reference binds an agent: a link launch's request is no use after that. */
export const REQUEST_KEEP_MS = 24 * 60 * 60_000;

/** The largest request held, in characters: the composer's own input limit. */
export const REQUEST_MAX = 65_536;

/** The largest file read back. */
const MAX_FILE = 1024 * 1024;

/** Launches whose request was read and is gone since, remembered for the page's receipts. */
const READ_KEPT = 1024;

const SPACE_ID = /^sp_[0-7][0-9a-hjkmnp-tv-z]{25}$/;

export type RequestRoute = "terminal" | "link";

/** What the store knows of a held request, without its words. */
export interface HeldRequest {
  readonly space: string;
  readonly launch: string;
  readonly route: RequestRoute;
  /** When it was held, wall clock milliseconds. */
  readonly at: number;
  /** An agent read it. */
  readonly read: boolean;
}

/** Whether a launch's request waits for its agent, was read, or none is held. */
export type RequestState = "waiting" | "read" | undefined;

interface RequestFile extends HeldRequest {
  readonly format: 1;
  readonly text: string;
}

function checkFile(value: unknown, launch: string): RequestFile | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { format, space, route, at, read, text } = value as Record<string, unknown>;
  if (format !== 1 || (value as Record<string, unknown>)["launch"] !== launch) return undefined;
  if (typeof space !== "string" || !SPACE_ID.test(space)) return undefined;
  if (route !== "terminal" && route !== "link") return undefined;
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at < 0) return undefined;
  if (typeof read !== "boolean") return undefined;
  if (typeof text !== "string" || text === "" || text.length > REQUEST_MAX) return undefined;
  return { format, space, launch, route, at, read, text };
}

/** The held requests under one launch root. */
export class LaunchRequests {
  readonly root: string;
  readonly #held = new Map<string, HeldRequest>();
  readonly #read = new Set<string>();

  /**
   * Reads every request under the root. One that cannot be read is removed: no agent can be
   * given it, and it must not stay on disk.
   */
  constructor(root: string) {
    this.root = root;
    makeDir(root, LAUNCH_FOLDER_MODE);
    for (const name of readdirSync(root)) {
      if (!LAUNCH_ID.test(name)) continue;
      const found = this.#readFile(name);
      if (found !== undefined) this.#held.set(name, held(found));
      else if (exists(this.#file(name))) this.#removeFile(name);
    }
  }

  /**
   * Holds `text` for `launch`, durable when it returns. False when the launch holds a request
   * already: one click is one request, and a repeated one never replaces it.
   */
  put(request: Omit<HeldRequest, "read">, text: string): boolean {
    if (!LAUNCH_ID.test(request.launch) || !SPACE_ID.test(request.space)) {
      throw new Error("Not a launch of a space");
    }
    if (text === "" || text.length > REQUEST_MAX) throw new Error("Not a request");
    if (this.#held.has(request.launch)) return false;
    const entry: HeldRequest = { ...request, read: false };
    this.#write(entry, text);
    this.#held.set(request.launch, entry);
    return true;
  }

  /** The launches whose request is held. */
  list(): readonly HeldRequest[] {
    return [...this.#held.values()];
  }

  /** The words held for `launch` of `space`, or undefined. */
  text(space: string, launch: string): string | undefined {
    const entry = this.#held.get(launch);
    if (entry?.space !== space) return undefined;
    const found = this.#readFile(launch);
    // Its folder went with its launch: the request is gone.
    if (found === undefined) {
      this.#forget(launch);
      return undefined;
    }
    return found.text;
  }

  /** Records that an agent read the request. True the first time. */
  markRead(launch: string): boolean {
    const entry = this.#held.get(launch);
    if (entry === undefined || entry.read) return false;
    const next = { ...entry, read: true };
    this.#held.set(launch, next);
    const found = this.#readFile(launch);
    try {
      if (found !== undefined) this.#write(next, found.text);
    } catch {
      // Known as read until a restart, which shows it waiting again: the field keeps the words.
    }
    return true;
  }

  state(launch: string): RequestState {
    const entry = this.#held.get(launch);
    if (entry !== undefined) {
      if (exists(this.#file(launch))) return entry.read ? "read" : "waiting";
      this.#forget(launch);
    }
    return this.#read.has(launch) ? "read" : undefined;
  }

  /** Removes the request of `launch`, and its folder when nothing else is in it. */
  remove(launch: string): void {
    if (!LAUNCH_ID.test(launch)) return;
    this.#removeFile(launch);
    this.#forget(launch);
  }

  #forget(launch: string): void {
    const entry = this.#held.get(launch);
    this.#held.delete(launch);
    if (entry?.read === true) {
      this.#read.add(launch);
      if (this.#read.size > READ_KEPT) {
        const oldest = this.#read.values().next().value;
        if (oldest !== undefined) this.#read.delete(oldest);
      }
    }
  }

  #file(launch: string): string {
    return join(this.root, launch, REQUEST_FILE);
  }

  #readFile(launch: string): RequestFile | undefined {
    const path = this.#file(launch);
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return undefined;
    }
    if (size > MAX_FILE) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return undefined;
    }
    return checkFile(value, launch);
  }

  #write(entry: HeldRequest, text: string): void {
    const folder = join(this.root, entry.launch);
    makeDir(folder, LAUNCH_FOLDER_MODE);
    const file: RequestFile = { format: 1, ...entry, text };
    atomicWrite(this.#file(entry.launch), `${JSON.stringify(file)}\n`, LAUNCH_FILE_MODE);
  }

  #removeFile(launch: string): void {
    rmSync(this.#file(launch), { force: true, maxRetries: 5 });
    try {
      // Only an empty folder: a terminal launch's own files are its record's to remove.
      rmdirSync(join(this.root, launch));
    } catch {
      // Not empty, or gone.
    }
  }
}

const held = (file: RequestFile): HeldRequest => ({
  space: file.space,
  launch: file.launch,
  route: file.route,
  at: file.at,
  read: file.read,
});

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
