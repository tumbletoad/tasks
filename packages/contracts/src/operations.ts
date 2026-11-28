// The A1 operation kinds an entry may declare in `ops` (A1 3.6), who may emit each one and the
// grant scopes an entry that emits it may require (A3 3.2.3, A6 3.3, 3.6.3). The registry
// check reads this table: an unknown kind fails, and an agent-allowed entry can never declare a
// kind that R7 or A3 3.2.3 keeps for the user.
import type { Scope } from "./define.ts";

/**
 * Who may emit an operation kind.
 * - `agent`: agents and the user.
 * - `user`: the user only (A3 3.2.3).
 * - `system`: the service itself, never through an entry (A1 3.6, A3 3.7.4).
 */
export type OpClass = "agent" | "user" | "system";

export interface OpSpec {
  readonly class: OpClass;
  /** The scopes an entry that emits it may require (A6 3.6.3). Empty for `system`. */
  readonly scopes: readonly Scope[];
  /**
   * A1 3.6 always requires `base`: the operation changes existing fields (A1 3.5). False when
   * the precondition is conditional, such as a link version or a base, or a base only when a
   * place exists. The handler checks those (A1 3.6).
   */
  readonly base: boolean;
  /** R7: launching agents, runs and routines belong to the user (A3 3.10 item 1). */
  readonly r7?: true;
}

const WRITE: readonly Scope[] = ["space:write"];

const agent = (base: boolean): OpSpec => ({ class: "agent", scopes: WRITE, base });
const user = (): OpSpec => ({ class: "user", scopes: WRITE, base: false });
const r7 = (...scopes: Scope[]): OpSpec => ({ class: "user", scopes, base: false, r7: true });

/** Group operations (A1 3.6 `area.*`, `project.*`): create needs no base, the rest do. */
function group(kind: "area" | "project"): Record<string, OpSpec> {
  return {
    [`${kind}.create`]: agent(false),
    [`${kind}.patch`]: agent(true),
    [`${kind}.move`]: agent(true),
    [`${kind}.archive`]: agent(true),
    [`${kind}.unarchive`]: agent(true),
    [`${kind}.delete`]: agent(true),
    [`${kind}.restore`]: agent(true),
  };
}

/**
 * Every operation kind, by exact name. A key ending in `.*` is a family that A4 owns: every kind
 * under it has the family's spec. A later step that adds a kind adds it here.
 */
export const OPERATIONS: Readonly<Record<string, OpSpec>> = {
  "task.create": agent(false),
  "task.patch": agent(true),
  "task.context_append": agent(false),
  "task.move": agent(true),
  "task.complete": agent(true),
  "task.wrap_up": agent(true),
  "task.reopen": agent(true),
  "task.archive": agent(true),
  "task.delete": agent(true),
  // A base, or the change it restores, whose tombstone the task must still hold.
  "task.restore": agent(false),
  "task.label": agent(false),
  "note.add": agent(false),
  // The person corrects, retracts and puts back a note, and corrects a log entry: agents never
  // rewrite or take back what someone else wrote.
  "note.patch": { class: "user", scopes: WRITE, base: true },
  "note.delete": { class: "user", scopes: WRITE, base: true },
  "note.restore": { class: "user", scopes: WRITE, base: true },
  "log.add": agent(false),
  "log.patch": { class: "user", scopes: WRITE, base: true },
  "log.delete": agent(true),
  // A link version for a revival.
  "source.add": agent(false),
  "source.patch": agent(true),
  // A link version or a base.
  "source.unlink": agent(false),
  "source.relink": agent(false),
  // A base only when the owner already has a place on this machine.
  "place.set": agent(false),
  "place.clear": agent(false),
  // A base only when the owner already has a folder on the request's machine.
  "project.folder_set": agent(false),
  "project.folder_clear": agent(false),
  "task.folder_set": agent(false),
  "task.folder_clear": agent(false),
  ...group("area"),
  ...group("project"),
  // Pages and a node's texts (step 1). An edit, an append, a move and the Trash need no base:
  // an edit applies while its old words stand. A set replaces a text whole, against a base.
  "page.create": agent(false),
  "page.edit": agent(false),
  "page.append": agent(false),
  "page.set": agent(true),
  "page.move": agent(false),
  "page.trash": agent(false),
  "page.restore": agent(false),
  "node.set": agent(true),
  // The person's standing instruction for every task below: the writer refuses it from others too.
  "node.instruct": { class: "user", scopes: WRITE, base: true },
  "label.patch": agent(true),
  "label.delete": agent(true),
  // Agents write only keys whose declaration lists them. Policy keys are human-only and need
  // admin (A6 3.6.3), so an entry for them may require admin. The handler refuses a policy key
  // without both, with `forbidden` and rule `policy` (A1 3.16, A3 3.4.11, 3.8.3).
  "pref.set": { class: "agent", scopes: ["space:write", "admin"], base: true },
  // No agent tool attaches files (A3 3.4).
  "attachment.add": user(),
  "proposal.accept": user(),
  "proposal.reject": user(),
  "space.patch": user(),
  "space.hold": user(),
  "space.release": user(),
  undo: user(),
  redo: user(),
  revert: user(),
  revert_session: user(),
  redact: user(),
  "session.unbind": user(),
  "session.rebind": user(),
  "session.end": user(),
  // R7 (A3 3.2.3, 3.10 item 1, A6 3.6.3).
  "launch.*": r7("launch:open", "launch:run"),
  // A4's run record, written only through the execution store (A4 3.16.1), as a launch's is.
  "run.create": r7("launch:run"),
  "run.transition": r7("launch:run"),
  "machine.register": { class: "system", scopes: [], base: false },
  // An agent actor joins a space on its first act (A3 3.7.4, M1.10): the writer's own commit.
  "actor.register": { class: "system", scopes: [], base: false },
};

/** The spec of an operation kind, by exact name, then by its family. */
export function opSpec(kind: string): OpSpec | undefined {
  if (kind.includes("*")) return undefined;
  if (Object.hasOwn(OPERATIONS, kind)) return OPERATIONS[kind];
  const dot = kind.indexOf(".");
  if (dot <= 0) return undefined;
  const family = `${kind.slice(0, dot)}.*`;
  return Object.hasOwn(OPERATIONS, family) ? OPERATIONS[family] : undefined;
}
