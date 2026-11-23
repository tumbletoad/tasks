// The field edits the service did not take, kept in the browser per space (kept.ts), so that a
// reload shows each again under its field with its choices (Try again or Apply mine, Copy,
// Discard). An edit is kept until the person saves or discards it. A tab removes only what it kept
// or read itself, so a second tab on the space never takes away the first one's.
//
// What is kept is the edit's source, never its request: the change is built again the one way a
// control builds it (`changeOf`), so a value read back is only ever one a control could have made.
import { browserKept } from "../kept.ts";
import { changeOf, type Field } from "./change.ts";
import type { Unsaved, UnsavedKeeper } from "./edits.ts";

const FIELDS: ReadonlySet<string> = new Set<Field>([
  "title",
  "summary",
  "status",
  "inbox",
  "priority",
  "effort",
  "due",
  "waiting_on",
  "grouping",
  "focus",
]);

const TASK_ID = /^[a-z]{1,4}_[0-9a-z]{1,64}$/u;
const REF = /^[A-Za-z0-9_-]{1,64}$/u;
const AS_OF = /^\d{1,16}\.\d{1,16}\.[0-9a-z]{1,64}$/u;

/** An edit as it is kept: undefined for one that cannot be built again. */
function keptOf(unsaved: Unsaved): string | undefined {
  const source = unsaved.change.source;
  if (source === undefined) return undefined;
  return JSON.stringify({
    task: unsaved.task,
    ref: unsaved.ref,
    field: unsaved.field,
    reason: unsaved.reason,
    ...(unsaved.base === undefined ? {} : { base: unsaved.base }),
    ...(unsaved.by === undefined ? {} : { by: unsaved.by }),
    ...(unsaved.at === undefined ? {} : { at: unsaved.at }),
    source,
  });
}

/** A kept edit, read by its shape. */
export function unsavedOf(value: unknown): Unsaved | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { task, ref, field, reason, base, by, at, source } = value as Record<string, unknown>;
  if (typeof task !== "string" || !TASK_ID.test(task)) return undefined;
  if (typeof ref !== "string" || !REF.test(ref)) return undefined;
  if (typeof field !== "string" || !FIELDS.has(field)) return undefined;
  if (reason !== "conflict" && reason !== "failed") return undefined;
  if (base !== undefined && (typeof base !== "string" || !AS_OF.test(base))) return undefined;
  if (by !== undefined && (typeof by !== "string" || by.length > 200)) return undefined;
  if (at !== undefined && (typeof at !== "number" || !Number.isFinite(at))) return undefined;
  const change = changeOf(source);
  if (change === undefined || !change.fields.includes(field as Field)) return undefined;
  return {
    task,
    ref,
    field: field as Field,
    change,
    reason,
    ...(base === undefined ? {} : { base }),
    ...(by === undefined ? {} : { by }),
    ...(at === undefined ? {} : { at }),
  };
}

export function unsavedKeeper(space: string): UnsavedKeeper {
  const prefix = `unsaved.${space}.`;
  const nameOf = (unsaved: Unsaved) => `${prefix}${unsaved.task}.${unsaved.field}`;
  /**
   * What this tab kept or read, by name, with the value it kept or read: it removes a name only
   * while that value is still there, so a newer edit another tab kept under it stays.
   */
  let known = new Map<string, { readonly unsaved: Unsaved; readonly value: string | undefined }>();
  return {
    load() {
      const found: Unsaved[] = [];
      for (const name of browserKept.names(prefix)) {
        const value = browserKept.read(name);
        const unsaved = unsavedOf(browserKept.json(name));
        // Not one of ours: it is removed, so it is never read again as anything.
        if (unsaved === undefined || nameOf(unsaved) !== name) {
          browserKept.keep(name, undefined);
          continue;
        }
        found.push(unsaved);
        known.set(name, { unsaved, value });
      }
      return found;
    },
    save(unsaved) {
      const next = new Map<
        string,
        { readonly unsaved: Unsaved; readonly value: string | undefined }
      >();
      for (const each of unsaved.values()) {
        const name = nameOf(each);
        const before = known.get(name);
        if (before?.unsaved === each) {
          next.set(name, before);
          continue;
        }
        // A new line where this tab kept or read one (a Try again refused) is written only while
        // the browser still holds that one, or nothing: another tab's newer value stays.
        const stored = browserKept.read(name);
        if (before !== undefined && stored !== undefined && stored !== before.value) {
          next.set(name, { unsaved: each, value: before.value });
          continue;
        }
        const value = keptOf(each);
        if (value !== undefined) browserKept.keep(name, value);
        next.set(name, { unsaved: each, value });
      }
      for (const [name, { value }] of known) {
        if (!next.has(name) && browserKept.read(name) === value) browserKept.keep(name, undefined);
      }
      known = next;
    },
  };
}

/** The tasks of `space` with a kept edit. */
export function unsavedTasks(space: string): string[] {
  const prefix = `unsaved.${space}.`;
  return browserKept.names(prefix).map((name) => name.slice(prefix.length).split(".")[0] ?? "");
}

/** Forgets the kept edits of a task that no longer exists. */
export function forgetUnsaved(space: string, task: string): void {
  for (const name of browserKept.names(`unsaved.${space}.${task}.`))
    browserKept.keep(name, undefined);
}
