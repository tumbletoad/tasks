// What a person last did to a space holds after a restart (A2 3.1, 3.2.4, 3.10.1): the space verbs
// record it in machine.toml's `[[spaces]]`, which the service opens at its next start.
//
//   create, open, restore --to, restore latest     the folder's entry: added with `enabled = true`,
//   restore in place, recover                      or set to `enabled = true` (opened again)
//   close                                          the folder's entry: `enabled = false`. Closed, it is
//                                                  listed, and `tasks space open <folder>` opens it
//                                                  again
//   forget                                         the folder's entry taken out, of a closed or
//                                                  unavailable space only; no file of it is touched
//   claim                                          the copy's entry enabled, and every other entry
//                                                  of the same space that serves nothing now
//                                                  (closed or unavailable) disabled, so the list
//                                                  after a restart shows the copy the person made
//                                                  this machine's as the space
//
// Which copy of a space takes the writer at a start is not these records' to keep: the copy that
// last opened as this machine's writer opens first (spaces.ts openAll, from the space's machine-local
// settings), so a record that failed, or an original enabled again, never moves the writer.
//
// An entry is found by its folder, compared as the OS compares names. A create or a restore made a
// new space in a folder that was not there, so it re-points that folder's entry to the new space's
// ID; nothing else changes an entry's ID, so a hand edit of one is never undone: a verb that serves
// a space whose folder's entry names another space records nothing and says so (`other_space`).
//
// The edit is machine.toml's one editor (config/edit.ts), as `[service] default_space`, `tasks roots
// add` and `tasks setup instances` use it: the file is read, the edits are worked out on the very
// bytes read, spliced in with every other byte kept (comments, order, line breaks, a byte order
// mark), and written atomically with the file's own mode, only if the file is still what was read
// just before the rename. A file saved meanwhile is read again and the edit made on it, up to three
// times. What is not covered is the instant between that last check and the rename: an editor's
// save landing exactly then is replaced (A2 3.1). No write when the file already says it.
//
// A record that cannot be written (a syntax error from a hand edit, a layout the editor cannot
// place, a file or folder that fails the permission rule, a write the OS refuses) does not undo or
// refuse the verb: the space is served or closed as the person asked, for this run, and the verb's
// answer says in a plain line that a restart will not keep it, why, and the command that records it
// once the file is fixed: `tasks space open <folder>` or `tasks space close <folder>`, which do
// nothing more to a space already open or closed, so the verb itself (a create, a claim) is never
// repeated (A2 3.10.1). The service's own view is its space manager, which the verb changed; the
// next start reads the file.
import { resolve } from "node:path";
import { CLI_NAME } from "@tasks/brand";
import { isTable } from "@tasks/launch";
import type { Id } from "@tasks/storage";
import { commitEdit, prepareEditOf, type Edit, type EditRefusal } from "../config/edit.ts";
import type { TomlDocument } from "../config/toml.ts";
import type { Logger } from "./log.ts";

export interface SpaceRecordsHost {
  /** The folder of machine.toml. */
  readonly configDir: string;
  readonly platform: NodeJS.Platform;
  readonly log: Logger;
}

/** What a verb did to the space in `folder`. */
export interface SpaceChange {
  readonly folder: string;
  readonly id: Id<"sp">;
  /** True: served (opened); false: closed. */
  readonly enabled: boolean;
  /** The entry names `id` from now on: a create or a restore made it in a folder that was not there. */
  readonly repoint?: boolean;
  /**
   * A claim: every other entry of the space `id` is disabled, except those of the folders given,
   * which are served now.
   */
  readonly others?: { readonly keep: readonly string[] };
}

/**
 * Why a record was not written: the editor's refusal; `other_space`, the folder's entry names
 * another space than the one served there (a hand edit, kept); or the OS's error code.
 */
export type NotRecorded = EditRefusal | "other_space" | { readonly code: string };

export type Recorded =
  { readonly remembered: true } | { readonly remembered: false; readonly why: NotRecorded };

const TRIES = 3;
const ARRAY = "spaces";

const fold = (platform: NodeJS.Platform) => (path: string) =>
  platform === "win32" || platform === "darwin" ? path.toLowerCase() : path;

/** The edits that make `doc`'s `[[spaces]]` say `change`, or why they cannot. */
function editsFor(
  doc: TomlDocument,
  change: SpaceChange,
  platform: NodeJS.Platform,
): Edit[] | EditRefusal | "other_space" {
  const key = fold(platform);
  const current = doc[ARRAY];
  if (current !== undefined && !Array.isArray(current)) return "unsupported_layout";
  const elements = ((current as unknown[] | undefined) ?? []).filter(isTable);
  const folderOf = (element: Readonly<Record<string, unknown>>): string | undefined =>
    typeof element["path"] === "string" ? key(resolve(element["path"])) : undefined;
  const at = (folder: string) => (element: Readonly<Record<string, unknown>>) =>
    folderOf(element) === folder;
  const target = key(resolve(change.folder));
  const matches = elements.filter(at(target));
  // The reader refuses a folder named twice; a hand edit made since the start may hold one.
  if (matches.length > 1) return "unsupported_layout";
  const edits: Edit[] = [];
  const entry = matches[0];
  if (entry === undefined) {
    // A space that is closed and has no entry stays without one: it opens at no start anyway.
    if (change.enabled) {
      edits.push({
        op: "append",
        array: ARRAY,
        entries: new Map<string, string | boolean>([
          ["id", change.id],
          ["path", change.folder],
          ["enabled", true],
        ]),
      });
    }
  } else {
    // An entry the person changed by hand to name another space is theirs: kept as it is, and the
    // space it would open at a start is not this one, so serving it is not remembered.
    if (change.repoint !== true && change.enabled && entry["id"] !== change.id) {
      return "other_space";
    }
    if (change.repoint === true && entry["id"] !== change.id) {
      edits.push({
        op: "set_in_element",
        array: ARRAY,
        select: at(target),
        key: "id",
        value: change.id,
      });
    }
    if ((entry["enabled"] ?? true) !== change.enabled) {
      edits.push({
        op: "set_in_element",
        array: ARRAY,
        select: at(target),
        key: "enabled",
        value: change.enabled,
      });
    }
  }
  if (change.others !== undefined) {
    const keep = new Set([target, ...change.others.keep.map((f) => key(resolve(f)))]);
    for (const element of elements) {
      const folder = folderOf(element);
      if (folder === undefined || keep.has(folder) || element["id"] !== change.id) continue;
      if (element["enabled"] === false) continue;
      edits.push({
        op: "set_in_element",
        array: ARRAY,
        select: at(folder),
        key: "enabled",
        value: false,
      });
    }
  }
  return edits;
}

/** Records `change` in machine.toml's `[[spaces]]`. Never throws. */
export function recordSpace(host: SpaceRecordsHost, change: SpaceChange): Recorded {
  let why: NotRecorded = "changed_meanwhile";
  for (let attempt = 1; attempt <= TRIES; attempt += 1) {
    let count = 0;
    // Set by the plan: the editor knows only its own refusals.
    const planned: { refusal?: "other_space" } = {};
    try {
      const prepared = prepareEditOf(host.configDir, (doc) => {
        const edits = editsFor(doc, change, host.platform);
        if (edits === "other_space") {
          planned.refusal = edits;
          return "absent";
        }
        if (typeof edits !== "string") count = edits.length;
        return edits;
      });
      if (!prepared.ok) {
        why = planned.refusal ?? prepared.reason;
        break;
      }
      if (count === 0) return { remembered: true };
      const written = commitEdit(prepared.edit);
      if (written.ok) {
        host.log.log("config.spaces_changed", { enabled: change.enabled, edits: count });
        return { remembered: true };
      }
      why = written.reason;
      if (why !== "changed_meanwhile") break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      why = { code: typeof code === "string" ? code : "EIO" };
      break;
    }
  }
  host.log.log("config.spaces_failed", {
    reason: typeof why === "string" ? why : "write_failed",
    ...(typeof why === "string" ? {} : { code: why.code }),
  });
  return { remembered: false, why };
}

/**
 * Takes the entry of `folder` out of machine.toml's `[[spaces]]` (`tasks space forget`): the space
 * is no longer listed or opened at a start. No entry for the folder is nothing to do. Never throws.
 */
export function forgetSpaceRecord(host: SpaceRecordsHost, folder: string): Recorded {
  const key = fold(host.platform);
  const target = key(resolve(folder));
  const at = (element: Readonly<Record<string, unknown>>) =>
    typeof element["path"] === "string" && key(resolve(element["path"])) === target;
  let why: NotRecorded = "changed_meanwhile";
  for (let attempt = 1; attempt <= TRIES; attempt += 1) {
    // Set by the plan, which sees the document as this read parses it.
    const plan = { listed: false };
    try {
      const prepared = prepareEditOf(host.configDir, (doc) => {
        const current = doc[ARRAY];
        if (current === undefined) return [];
        if (!Array.isArray(current)) return "unsupported_layout";
        plan.listed = current.some((element) => isTable(element) && at(element));
        return plan.listed ? [{ op: "remove_element", array: ARRAY, select: at }] : [];
      });
      if (!prepared.ok) {
        why = prepared.reason;
        break;
      }
      if (!plan.listed) return { remembered: true };
      const written = commitEdit(prepared.edit);
      if (written.ok) {
        host.log.log("config.space_forgotten", {});
        return { remembered: true };
      }
      why = written.reason;
      if (why !== "changed_meanwhile") break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      why = { code: typeof code === "string" ? code : "EIO" };
      break;
    }
  }
  host.log.log("config.spaces_failed", {
    reason: typeof why === "string" ? why : "write_failed",
    ...(typeof why === "string" ? {} : { code: why.code }),
  });
  return { remembered: false, why };
}

/** Why machine.toml could not take the record, in the words a person reads. No path, no value. */
export function because(why: NotRecorded): string {
  if (typeof why !== "string") return `machine.toml could not be written (${why.code})`;
  switch (why) {
    case "invalid_file":
      return "machine.toml cannot be read as it is";
    case "unsupported_layout":
      return "machine.toml writes [[spaces]] in a way this command cannot change";
    case "unsafe":
      return "machine.toml or its folder fails the permission rule (another user could change it, or it is a link)";
    case "changed_meanwhile":
      return "machine.toml kept changing while it was being written";
    case "too_large":
      return "machine.toml would be larger than a configuration file may be";
    case "other_space":
      return "machine.toml's entry for this folder names another space";
    default:
      return "machine.toml could not be changed";
  }
}

/**
 * What fixes it. `again` is the command that records the space's state once the file is fixed
 * (`tasks space open <folder>` or `close`), never the verb itself, which may not be repeatable.
 */
function fix(why: NotRecorded, again: string, id: string): string {
  if (why === "unsupported_layout") return "Change the space's [[spaces]] entry by hand.";
  if (why === "other_space") return `Change that entry's id to ${id} by hand, then run: ${again}`;
  if (why === "unsafe" || why === "invalid_file") {
    return `Run ${CLI_NAME} doctor: it names the problem. Then run: ${again}`;
  }
  return `To record it, run: ${again}`;
}

/**
 * The plain line a verb's answer carries when its record was not written: what a restart does
 * instead, why, and the fix. `served`: the verb left the space served (else closed). `again`: the
 * command that records it, quoted for the person's shell; `id`: the space's ID. `repoint`: a create
 * or a restore made a new space in the folder, which an entry the file lists for the folder must
 * name first, since `space open` never changes an entry's ID.
 */
export function notRememberedLine(
  why: NotRecorded,
  served: boolean,
  again: string,
  id: string,
  repoint = false,
): string {
  const after = served
    ? "The space is open for now, but will not reopen after a restart"
    : "The space is closed for now, but a restart may open it again";
  const entry =
    repoint && why !== "other_space" && why !== "unsupported_layout"
      ? ` If machine.toml lists this folder for another space, change that entry's id to ${id} first.`
      : "";
  return `${after}: ${because(why)}. ${fix(why, again, id)}${entry}`;
}
