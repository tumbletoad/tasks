// A folder as the space stores it: an absolute path on one machine, as that machine spells it, with
// the person's home written as `~`. Only that machine's service looks at the folder, so the writer
// checks the form alone and never touches the disk. A path is stored exactly as sent: no text
// normalisation, because a decomposed and a composed `é` name two folders on Linux.
//
// Comparisons follow the machine's case rule: Windows and macOS compare without case, Linux with.
// A comparison is by whole segments, so `~/work/a` is inside `~/work` and `~/work-old` is not.
import type { Connection, Row } from "../driver.ts";
import { isId, type Id } from "../ids.ts";
import { RowReader } from "../rows.ts";

export type FolderOs = "linux" | "windows" | "macos";

/** The longest path a folder row holds, in characters (its CHECK counts the same). */
export const FOLDER_PATH_MAX = 4_096;

// C0 controls, DEL and the C1 controls: no folder a person picks has one, and one would hide in
// every place the path is shown.
// eslint-disable-next-line no-control-regex -- the controls are what this refuses.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

/**
 * Whether `path` has a folder's form on some machine: a home path (`~`, `~/…`, `~\…`), a POSIX
 * absolute path, a drive path (`C:\…`) or a share (`\\server\share…`); at most 4,096 characters, no
 * control character and no lone surrogate. The request's machine decides the rest (folderProblem).
 */
export function isFolderForm(path: unknown): path is string {
  if (typeof path !== "string" || path === "") return false;
  if (Array.from(path).length > FOLDER_PATH_MAX) return false;
  if (!path.isWellFormed() || CONTROL.test(path)) return false;
  return /^(~(?:$|[/\\])|\/|\\\\|[A-Za-z]:\\)/u.test(path);
}

/** The separator a machine's paths use. */
export const separatorOf = (os: FolderOs): "/" | "\\" => (os === "windows" ? "\\" : "/");

// Characters Windows never allows in a folder's name.
const WINDOWS_NAME = /[<>:"|?*/]/u;
const DRIVE = /^[A-Z]:$/u;

/**
 * Why `path` is not a folder of a machine with `os`, or undefined when it is one: a home path or an
 * absolute path in that machine's form, with no empty, `.` or `..` segment and no trailing
 * separator but a root's. A drive letter is upper case, as the service writes it.
 */
export function folderProblem(path: string, os: FolderOs): string | undefined {
  if (!isFolderForm(path)) return "Expected a folder: an absolute path or a path under ~";
  const sep = separatorOf(os);
  if (os !== "windows") {
    if (path.startsWith("\\") || /^[A-Za-z]:/u.test(path)) {
      return "Expected a folder of this machine";
    }
    if (path === "/" || path === "~") return undefined;
    const parts = path.split("/");
    const head = parts[0];
    if (head !== "" && head !== "~") return "Expected a folder of this machine";
    return segmentsProblem(parts.slice(1), sep);
  }
  if (path.includes("/")) return "Expected a folder of this machine, with \\ between its names";
  if (path === "~") return undefined;
  if (path.startsWith("~\\")) return segmentsProblem(path.split("\\").slice(1), sep, true);
  if (path.startsWith("\\\\")) {
    const parts = path.slice(2).split("\\");
    if (parts.length < 2) return "Expected a share: \\\\server\\share";
    return segmentsProblem(parts, sep, true);
  }
  const [drive = "", ...rest] = path.split("\\");
  if (!DRIVE.test(drive)) return "Expected a drive letter in upper case";
  // `C:\` is the drive's root; anything below has no empty segment.
  if (rest.length === 1 && rest[0] === "") return undefined;
  return segmentsProblem(rest, sep, true);
}

function segmentsProblem(
  parts: readonly string[],
  sep: string,
  windows = false,
): string | undefined {
  for (const part of parts) {
    if (part === "") return `Expected no empty name, doubled ${sep} or trailing ${sep}`;
    if (part === "." || part === "..") return "Expected no . or .. in the path";
    if (windows && WINDOWS_NAME.test(part)) return "Expected names Windows allows";
  }
  return undefined;
}

/** A path's segments, which the comparisons work on. A root is one segment. */
export function segmentsOf(path: string, os: FolderOs): string[] {
  const sep = separatorOf(os);
  if (os === "windows" && /^[A-Z]:\\$/u.test(path)) return [path.slice(0, 2)];
  if (os !== "windows" && path === "/") return [""];
  return path.split(sep);
}

/** A segment as the machine's case rule compares it. */
const keyOfSegment = (segment: string, os: FolderOs): string =>
  os === "linux" ? segment : segment.toLowerCase();

/** The text two paths of one machine are the same folder by: case folded where the OS folds it. */
export const folderKey = (path: string, os: FolderOs): string =>
  segmentsOf(path, os)
    .map((s) => keyOfSegment(s, os))
    .join("\n");

/**
 * Where `path` lands when the folder `from` becomes `to`: undefined when `path` is neither `from`
 * nor inside it, by whole segments with the case rule; else `to` with the rest of `path` as it is.
 */
export function rebased(path: string, from: string, to: string, os: FolderOs): string | undefined {
  const parts = segmentsOf(path, os);
  const base = segmentsOf(from, os);
  if (parts.length < base.length) return undefined;
  for (let i = 0; i < base.length; i += 1) {
    if (keyOfSegment(parts[i] ?? "", os) !== keyOfSegment(base[i] ?? "", os)) return undefined;
  }
  const rest = parts.slice(base.length);
  if (rest.length === 0) return to;
  const sep = separatorOf(os);
  return to.endsWith(sep) ? `${to}${rest.join(sep)}` : `${to}${sep}${rest.join(sep)}`;
}

/**
 * Where a folder `path` goes when the folder `from` was moved to `to`: as `rebased`, but nowhere
 * when one of the two folders is the other or inside it. No folder can be moved into itself, so
 * such a change names another folder, and the folders below are still where they were.
 */
export function carriedTo(
  path: string,
  from: string,
  to: string,
  os: FolderOs,
): string | undefined {
  if (rebased(to, from, from, os) !== undefined || rebased(from, to, to, os) !== undefined) {
    return undefined;
  }
  return rebased(path, from, to, os);
}

// ---------------------------------------------------------------------------------------------
// Reads

/** A folder row as the reads and the writer use it. */
export interface FolderRow {
  id: Id<"fo">;
  ownerKind: "project" | "task";
  ownerId: string;
  machineId: Id<"m">;
  path: string;
  version: number;
  createdSeq: number;
  deleted: boolean;
}

export function decodeFolder(row: Row): FolderRow {
  const r = new RowReader("folders", row);
  return {
    id: r.id("id", "fo"),
    ownerKind: r.oneOf("owner_kind", ["project", "task"]),
    ownerId: r.text("owner_id"),
    machineId: r.id("machine_id", "m"),
    path: r.text("path"),
    version: r.int("version", "seq"),
    createdSeq: r.int("created_seq", "seq"),
    deleted: r.optInt("deleted_at", "instant") !== null,
  };
}

export const FOLDER_SQL = {
  hasTable: "SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = 'folders'",
  folder: "SELECT * FROM folders WHERE id = $id",
  /** An owner's live folder on one machine: at most one (the unique index). */
  liveOf:
    "SELECT * FROM folders WHERE owner_kind = $kind AND owner_id = $owner " +
    "AND machine_id = $machine AND deleted_at IS NULL",
  /** An owner's live folders on every machine, newest first. */
  liveOfOwner:
    "SELECT * FROM folders WHERE owner_kind = $kind AND owner_id = $owner " +
    "AND deleted_at IS NULL ORDER BY created_seq DESC, id",
  /** Every folder row of an owner, removed ones included. */
  allOfOwner: "SELECT * FROM folders WHERE owner_kind = $kind AND owner_id = $owner ORDER BY id",
  /** An owner's removed folders on one machine. */
  removedOn:
    "SELECT * FROM folders WHERE owner_kind = $kind AND owner_id = $owner " +
    "AND machine_id = $machine AND deleted_at IS NOT NULL ORDER BY id",
  /** Every live folder on a machine, a project's or a task's, whatever its owner's state. */
  liveOn: "SELECT * FROM folders WHERE machine_id = $machine AND deleted_at IS NULL ORDER BY id",
  machineOs: "SELECT os FROM machines WHERE id = $id",
  machine: "SELECT id, name, os FROM machines WHERE id = $id",
  task: "SELECT id, project_id FROM tasks WHERE id = $id",
} as const;

/** Whether the space's schema has the folders table (0.5 on). */
export function hasFolders(conn: Connection): boolean {
  return conn.prepare(FOLDER_SQL.hasTable).get() !== undefined;
}

/** A machine's OS as its record holds it, or undefined for a machine the space does not know. */
export function machineOs(conn: Connection, machine: string): FolderOs | undefined {
  const os = conn.prepare(FOLDER_SQL.machineOs).get({ id: machine })?.["os"];
  return os === "linux" || os === "windows" || os === "macos" ? os : undefined;
}

/** A folder as a read shows it: the row, its machine and the path as stored. */
export interface FolderView {
  id: Id<"fo">;
  machine: Id<"m">;
  path: string;
  version: number;
}

const viewOf = (f: FolderRow): FolderView => ({
  id: f.id,
  machine: f.machineId,
  path: f.path,
  version: f.version,
});

/** An owner's live folders, one per machine, newest first. Empty before schema 0.5. */
export function foldersOf(conn: Connection, kind: "project" | "task", owner: string): FolderView[] {
  if (!hasFolders(conn)) return [];
  return conn
    .prepare(FOLDER_SQL.liveOfOwner)
    .all({ kind, owner })
    .map((row) => viewOf(decodeFolder(row)));
}

/**
 * The folder a launch of `task` uses on `machine`:
 * - `task`: the task's own folder there;
 * - `project`: else its project's folder there;
 * - `other_machine`: else the task or its project has a folder on another machine, the newest of
 *   the task's, else of the project's: it opens there;
 * - `none`: else no folder anywhere, and the launch uses the space's work folder.
 * Never another folder in place of the one these name.
 */
export type LaunchFolder =
  | { kind: "task" | "project"; folder: FolderView }
  | { kind: "other_machine"; machine: { id: Id<"m">; name: string } }
  | { kind: "none" };

/**
 * The decision of `launchFolder` from the task's and its project's live folders, each newest
 * first, and the machines' names: the one rule, whoever read the rows.
 */
export function decideLaunchFolder(
  own: readonly FolderView[],
  project: readonly FolderView[],
  machine: string,
  nameOf: (machine: Id<"m">) => string | undefined,
): LaunchFolder {
  const here = (list: readonly FolderView[]) => list.find((f) => f.machine === machine);
  const mine = here(own);
  if (mine !== undefined) return { kind: "task", folder: mine };
  const theirs = here(project);
  if (theirs !== undefined) return { kind: "project", folder: theirs };
  const elsewhere = own[0] ?? project[0];
  if (elsewhere === undefined) return { kind: "none" };
  const name = nameOf(elsewhere.machine) ?? elsewhere.machine;
  return { kind: "other_machine", machine: { id: elsewhere.machine, name } };
}

/** A folder row as the reads show it, from its row. */
export function folderView(row: Row): FolderView {
  return viewOf(decodeFolder(row));
}

export function launchFolder(conn: Connection, task: string, machine: string): LaunchFolder {
  const row = conn.prepare(FOLDER_SQL.task).get({ id: task });
  if (row === undefined) return { kind: "none" };
  const project = row["project_id"];
  const own = foldersOf(conn, "task", task);
  const projects = isId(project, "p") ? foldersOf(conn, "project", project) : [];
  return decideLaunchFolder(own, projects, machine, (id) => {
    const name = conn.prepare(FOLDER_SQL.machine).get({ id })?.["name"];
    return typeof name === "string" ? name : undefined;
  });
}
