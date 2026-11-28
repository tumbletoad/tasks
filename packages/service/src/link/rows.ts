// What a phone's feed carries: the space's own data and nothing of this computer. The page's
// snapshot also names the space's folder, its restore record and the agent apps installed here,
// and a task's row says where it opens on this machine and in which agent app it was last opened.
// None of that is the phone's to know, so a phone gets rows built from a list of what it may see,
// and a field added to the page's rows later reaches no phone until it is named here.
import type { BatchMessage, SnapshotMessage } from "../http/feed.ts";
import type { CompactRow, CompactValue } from "../ops/task-rows.ts";

const TASK_FIELDS = new Set([
  "id",
  "ref",
  "title",
  "summary",
  "lifecycle",
  "status",
  "inbox",
  "priority",
  "effort",
  "due_date",
  "due_at",
  "due_tz",
  "planned_for",
  "focus_on",
  "owner",
  "waiting_on",
  "area_id",
  "project_id",
  "parent_id",
  "position",
  "wrap_state",
  "completed_at",
  "deleted_at",
  "created_at",
  "finished_at",
  "waiting_since",
  "version",
  "touched",
  "sources",
  "sources_more",
  "ending",
  "questions_more",
]);

const GROUP_FIELDS = new Set([
  "id",
  "area_id",
  "slug",
  "title",
  "position",
  "color",
  "lifecycle",
  "deleted_at",
  "version",
]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A task's row as a phone sees it. */
export function phoneTask(row: CompactRow): CompactRow {
  const out: Record<string, CompactValue> = {};
  for (const [name, value] of Object.entries(row)) {
    if (TASK_FIELDS.has(name)) out[name] = value;
  }
  const run: unknown = row["run"];
  if (isRecord(run) && typeof run["id"] === "string" && typeof run["state"] === "string") {
    // Without the instance: that is this machine's key for an agent app.
    out["run"] = { id: run["id"], state: run["state"] } as unknown as CompactValue;
  }
  const questions = row["questions"];
  if (Array.isArray(questions)) {
    out["questions"] = questions.map((q: Record<string, unknown>) => ({
      ref: q["ref"],
      by: q["by"],
      text: q["text"],
      at: q["at"],
    })) as unknown as CompactValue;
  }
  return out;
}

/** An area's or a project's row as a phone sees it. */
export function phoneGroup(row: CompactRow): CompactRow {
  const out: Record<string, CompactValue> = {};
  for (const [name, value] of Object.entries(row)) {
    if (GROUP_FIELDS.has(name)) out[name] = value;
  }
  return out;
}

const rowOf = (type: string, row: CompactRow | null): CompactRow | null => {
  if (row === null) return null;
  if (type === "task") return phoneTask(row);
  if (type === "area" || type === "project") return phoneGroup(row);
  return null;
};

/** What a phone's snapshot says of the copy it was read from: which copy, and why it takes no change. */
export interface PhoneCopy {
  readonly copy?: string;
  readonly read_only?: { readonly reason: string };
}

/** The phone's snapshot: the space's data, and of the copy only its name and whether it writes. */
export function phoneSnapshot(
  snapshot: SnapshotMessage,
  copy: PhoneCopy,
  reason?: string,
): Record<string, unknown> {
  return {
    type: "snapshot",
    space: { ...snapshot.space, ...copy },
    cursor: snapshot.cursor,
    tasks: snapshot.tasks.map(phoneTask),
    agent_changes: snapshot.agent_changes.map((c) => ({
      task: c.task,
      actor: c.actor,
      at: c.at,
      ...(c.row === undefined ? {} : { row: phoneTask(c.row) }),
    })),
    asking: snapshot.asking.map(phoneTask),
    areas: snapshot.areas.map(phoneGroup),
    projects: snapshot.projects.map(phoneGroup),
    preferences: snapshot.preferences,
    ...(reason === undefined ? {} : { reason }),
  };
}

/** A batch with each entity's row as a phone sees it. */
export function phoneBatch(batch: BatchMessage): BatchMessage {
  return {
    ...batch,
    events: batch.events.map((event) => ({
      ...event,
      entities: event.entities.map((entity) => ({
        ...entity,
        row: rowOf(entity.type, entity.row),
      })),
    })),
  };
}
