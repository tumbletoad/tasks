// The input copy (A7 3.15.1): a run first copies the prototype's inputs into its own folder,
// `<space>/exchange/planning/<run-id>/input/`, and records the SHA-256 of every source file before
// and after copying. If a source hash changes during the run, the run stops. Counts are taken from
// the copy, never from the source folder.
//
// This is the importer's only file I/O. It reads the source folder, never runs or evaluates a file
// of it, follows no link, and writes only into a destination folder it creates itself.
//
// The inputs are the files the importer reads (A7 3.15.2) and the ones 3.15.7 says are copied:
// TODO.md, DONE.md, data/metadata.json, data/jira.json, data/audit.json, tasks-export.json (a
// return import, 3.15.6) and every events/*.json and events/*.ready. Code, agent files, context/,
// reviews/ and snapshots/ stay in the frozen folder and are not copied.

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { EVENTS_DIR, type EventFileInput } from "./events.ts";
import { limitsWith, type Limits } from "./limits.ts";
import { METADATA_FILE } from "./metadata.ts";
import { AUDIT_FILE, JIRA_FILE } from "./optional.ts";
import { problem, type Problem } from "./problems.ts";
import type { PrototypeInput } from "./prototype.ts";

export const EXPORT_FILE = "tasks-export.json";

// The copy holds the person's work data, inside the space folder (A1: folders 0700, files 0600).
// The modes are set on each new folder and file by descriptor, so the umask does not change them and
// no link is followed. Windows keeps the inherited ACL.
const FOLDER_MODE = 0o700;
const FILE_MODE = 0o600;
const POSIX = process.platform !== "win32";

/**
 * Creates the folder `path` (it must not exist: an existing one throws EEXIST and is never
 * touched) with exactly FOLDER_MODE. The mode is set only on what this mkdir made: through a
 * descriptor opened without following a link and only as a folder, once it shows a folder of this
 * user. Only a process of this same user could put another folder there between the mkdir and the
 * open (A2 3.2.2 rule 5).
 */
async function makePrivateFolder(path: string): Promise<void> {
  await mkdir(path, { mode: FOLDER_MODE });
  if (!POSIX) return;
  const folder = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW);
  try {
    const uid = process.getuid?.();
    if (uid !== undefined && (await folder.stat()).uid !== uid) {
      throw Object.assign(new Error("A folder this copy made belongs to another user"), {
        code: "EPERM",
      });
    }
    await folder.chmod(FOLDER_MODE);
  } finally {
    await folder.close();
  }
}

/** Writes `bytes` to the new file `path` (created exclusively) with exactly FILE_MODE. */
async function writePrivateFile(path: string, bytes: Uint8Array): Promise<void> {
  const file = await open(path, "wx", FILE_MODE);
  try {
    if (POSIX) await file.chmod(FILE_MODE);
    await file.writeFile(bytes);
  } finally {
    await file.close();
  }
}

/** The single files of an input, in copy order, with the bound that applies to each. */
const SINGLE_FILES: readonly [path: string, bound: (l: Limits) => number][] = [
  ["TODO.md", (l) => l.ledgerBytes],
  ["DONE.md", (l) => l.ledgerBytes],
  [METADATA_FILE, (l) => l.jsonBytes],
  [JIRA_FILE, (l) => l.jsonBytes],
  [AUDIT_FILE, (l) => l.jsonBytes],
  [EXPORT_FILE, (l) => l.jsonBytes],
];

export interface InputFile {
  /** Relative to the folder, with forward slashes. */
  readonly path: string;
  readonly size: number;
  /** Lower-case hex. */
  readonly sha256: string;
}

export interface InputCopy {
  /** True when every input was copied and no source file changed while it was copied. */
  readonly ok: boolean;
  /** Every copied file in copy order, with the hash of the bytes read from the source, which are
   * the bytes written to the copy. */
  readonly files: readonly InputFile[];
  readonly problems: readonly Problem[];
}

interface Listed {
  readonly path: string;
  readonly bound: number;
}

const isCode = (error: unknown, code: string): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === code;

const local = (folder: string, path: string): string => join(folder, ...path.split("/"));

const DATA_DIR = "data";

/** Whether a sub-folder of the source is a real folder, is absent, or is something else (a link,
 * a junction, a file), which is reported. */
async function folderState(
  folder: string,
  name: string,
  problems: Problem[],
): Promise<"folder" | "absent" | "other"> {
  try {
    if ((await lstat(join(folder, name))).isDirectory()) return "folder";
    problems.push(problem("not-a-regular-file", { file: name }));
  } catch (error) {
    if (isCode(error, "ENOENT")) return "absent";
    problems.push(problem("read-failed", { file: name }));
  }
  return "other";
}

/** Lists the inputs of a folder: regular files only, never through a link, bounded in number. */
async function listInputs(
  folder: string,
  limits: Limits,
): Promise<{ files: Listed[]; problems: Problem[] }> {
  const files: Listed[] = [];
  const problems: Problem[] = [];
  // A file's parent folder is checked too: lstat follows a link in any earlier part of a path, so
  // a data/ that is a link or junction would read files from outside the source.
  const data = await folderState(folder, DATA_DIR, problems);
  for (const [path, bound] of SINGLE_FILES) {
    if (path.startsWith(`${DATA_DIR}/`) && data !== "folder") continue;
    let stat;
    try {
      stat = await lstat(local(folder, path));
    } catch (error) {
      if (!isCode(error, "ENOENT") && !isCode(error, "ENOTDIR")) {
        problems.push(problem("read-failed", { file: path }));
      }
      continue;
    }
    if (!stat.isFile()) problems.push(problem("not-a-regular-file", { file: path }));
    else files.push({ path, bound: bound(limits) });
  }

  if ((await folderState(folder, EVENTS_DIR, problems)) !== "folder") return { files, problems };
  const names: string[] = [];
  try {
    const dir = await opendir(join(folder, EVENTS_DIR));
    // The bound counts every candidate name, so entries that are no files cannot run past it.
    let candidates = 0;
    for await (const entry of dir) {
      if (!entry.name.endsWith(".json") && !entry.name.endsWith(".ready")) continue;
      if (candidates >= limits.eventFiles) {
        problems.push(problem("too-many-event-files", { file: EVENTS_DIR }));
        break;
      }
      candidates += 1;
      if (entry.isFile()) names.push(entry.name);
      else problems.push(problem("not-a-regular-file", { file: `${EVENTS_DIR}/${entry.name}` }));
    }
  } catch {
    problems.push(problem("read-failed", { file: EVENTS_DIR }));
  }
  // A fixed order, so two runs over one folder copy and hash in the same order.
  names.sort();
  for (const name of names) files.push({ path: `${EVENTS_DIR}/${name}`, bound: limits.eventBytes });
  return { files, problems };
}

const CHUNK = 64 * 1024;
const NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

/**
 * Reads a file to its end, or to `bound + 1` bytes when it is longer, so a file over its bound is
 * seen to be over it without reading all of it.
 */
async function readBounded(path: string, bound: number): Promise<Buffer> {
  // No link is followed, even one that replaced the file after it was listed (POSIX only: Windows
  // has no O_NOFOLLOW, and there the listing's check stands alone).
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= bound) {
      const chunk = Buffer.alloc(Math.min(CHUNK, bound + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Hashes every input of a folder as it is now. */
export async function hashInputs(
  folder: string,
  overrides?: Partial<Limits>,
): Promise<{ files: InputFile[]; problems: Problem[] }> {
  const limits = limitsWith(overrides);
  const listed = await listInputs(folder, limits);
  const files: InputFile[] = [];
  const problems = listed.problems;
  for (const { path, bound } of listed.files) {
    try {
      const bytes = await readBounded(local(folder, path), bound);
      if (bytes.length > bound) problems.push(problem("file-too-large", { file: path }));
      else files.push({ path, size: bytes.length, sha256: sha256(bytes) });
    } catch {
      problems.push(problem("read-failed", { file: path }));
    }
  }
  return { files, problems };
}

/**
 * Checks a source folder against the hashes a copy recorded. Every input that changed, appeared or
 * went away gives `source-changed`. An empty result means the folder still holds what was copied.
 * It fails closed: anything the check cannot list or hash (an unreadable or oversized file, a
 * folder where a file belongs, too many event files) is a change too.
 */
export async function verifySource(
  source: string,
  recorded: readonly InputFile[],
  overrides?: Partial<Limits>,
): Promise<Problem[]> {
  return compareSource(source, recorded, [], limitsWith(overrides));
}

const problemKey = (p: Problem): string => `${p.code}|${p.file}|${String(p.index ?? "")}`;

/** verifySource, where `known` are the problems the copy itself already reported: those are the
 * same state, not a change. */
async function compareSource(
  source: string,
  recorded: readonly InputFile[],
  known: readonly Problem[],
  limits: Limits,
): Promise<Problem[]> {
  const now = await hashInputs(source, limits);
  const before = new Map(recorded.map((f) => [f.path, f.sha256]));
  const after = new Map(now.files.map((f) => [f.path, f.sha256]));
  const changed = new Set<string>();
  for (const [path, hash] of before) if (after.get(path) !== hash) changed.add(path);
  for (const path of after.keys()) if (!before.has(path)) changed.add(path);
  const seen = new Set(known.map(problemKey));
  for (const p of now.problems) if (!seen.has(problemKey(p))) changed.add(p.file);
  // problem() names an unsafe event file name as `events`, so the set may hold both spellings.
  const out = new Map<string, Problem>();
  for (const file of changed) {
    const p = problem("source-changed", { file });
    out.set(problemKey(p), p);
  }
  return [...out.values()];
}

/**
 * Copies the inputs of `source` into `destination`, which must not exist yet (its parent must).
 * Each file is read once, hashed, and those same bytes are written with exclusive create. Then the
 * source is hashed again: any difference gives `source-changed` and `ok: false`.
 */
export async function copyInput(
  source: string,
  destination: string,
  overrides?: Partial<Limits>,
): Promise<InputCopy> {
  const limits = limitsWith(overrides);
  // Both sides through realpath, so a link or junction in the destination's parent cannot lead
  // back into the source. The destination itself does not exist yet; its parent must.
  let from: string;
  let to: string;
  try {
    from = await realpath(resolve(source));
  } catch {
    return fail(problem("read-failed", { file: "." }));
  }
  try {
    const target = resolve(destination);
    to = join(await realpath(dirname(target)), basename(target));
  } catch {
    return fail(problem("write-failed", { file: "." }));
  }
  if (isInside(from, to)) return fail(problem("destination-inside-source", { file: "." }));
  try {
    await makePrivateFolder(to);
  } catch (error) {
    return fail(
      problem(isCode(error, "EEXIST") ? "destination-exists" : "write-failed", { file: "." }),
    );
  }

  const listed = await listInputs(from, limits);
  const problems: Problem[] = [...listed.problems];
  const files: InputFile[] = [];
  const made = new Set<string>();
  for (const { path, bound } of listed.files) {
    let bytes: Buffer;
    try {
      bytes = await readBounded(local(from, path), bound);
    } catch {
      problems.push(problem("read-failed", { file: path }));
      continue;
    }
    if (bytes.length > bound) {
      problems.push(problem("file-too-large", { file: path }));
      continue;
    }
    try {
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (dir !== "" && !made.has(dir)) {
        await makePrivateFolder(local(to, dir));
        made.add(dir);
      }
      await writePrivateFile(local(to, path), bytes);
    } catch {
      problems.push(problem("write-failed", { file: path }));
      continue;
    }
    files.push({ path, size: bytes.length, sha256: sha256(bytes) });
  }

  // A problem the copy already reported (a file over its bound, say) is the same state again.
  const changes = await compareSource(from, files, problems, limits);
  problems.push(...changes);
  return { ok: !problems.some((p) => p.severity === "error"), files, problems };
}

/** Whether `to` is `from` or lies under it, by whole path parts: `<from>/..input` is inside. */
function isInside(from: string, to: string): boolean {
  const rel = relative(from, to);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${sep}`);
}

function fail(p: Problem): InputCopy {
  return { ok: false, files: [], problems: [p] };
}

/**
 * Reads an input copy into the parsers' input. A missing optional file is left out; a missing
 * ledger is left out too, and the ledger parser reports it.
 */
export async function readInput(
  folder: string,
  overrides?: Partial<Limits>,
): Promise<{ input: PrototypeInput; problems: Problem[] }> {
  const limits = limitsWith(overrides);
  const listed = await listInputs(folder, limits);
  const problems = listed.problems;
  const single = new Map<string, Buffer>();
  const events: EventFileInput[] = [];
  for (const { path, bound } of listed.files) {
    const isEvent = path.startsWith(`${EVENTS_DIR}/`);
    const name = isEvent ? path.slice(EVENTS_DIR.length + 1) : path;
    if (isEvent && name.endsWith(".ready")) {
      events.push({ name });
      continue;
    }
    let bytes: Buffer;
    try {
      // The parsers see a file over its bound as over it, and report it themselves.
      bytes = await readBounded(local(folder, path), bound);
    } catch {
      problems.push(problem("read-failed", { file: path }));
      if (isEvent) events.push({ name });
      continue;
    }
    if (isEvent) events.push({ name, bytes });
    else single.set(path, bytes);
  }
  const input: { -readonly [K in keyof PrototypeInput]: PrototypeInput[K] } = { events };
  const take = (key: "todo" | "done" | "metadata" | "jira" | "audit", path: string) => {
    const bytes = single.get(path);
    if (bytes !== undefined) input[key] = bytes;
  };
  take("todo", "TODO.md");
  take("done", "DONE.md");
  take("metadata", METADATA_FILE);
  take("jira", JIRA_FILE);
  take("audit", AUDIT_FILE);
  return { input, problems };
}
