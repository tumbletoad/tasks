// What a phone's feed carries: the space's own data and nothing of this computer, built through
// the same specs as every answer a phone gets (allowed.ts). The page's snapshot also names the
// space's folder, its restore record and the agent apps installed here, a task's row says where
// it opens on this machine, and an actor names an agent's instance and session; a phone gets
// none of that.
import type { BatchMessage, SnapshotMessage } from "../http/feed.ts";
import { FEED_NODE, FEED_PAGE, FEED_TASK, project, type Authors } from "./allowed.ts";

const rowOf = (type: string, row: unknown, authors: Authors): unknown => {
  if (row === null || row === undefined) return null;
  if (type === "task") return project(row, FEED_TASK, authors);
  if (type === "node") return project(row, FEED_NODE, authors);
  if (type === "page") return project(row, FEED_PAGE, authors);
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
  authors: Authors,
  reason?: string,
): Record<string, unknown> {
  return {
    type: "snapshot",
    space: { ...snapshot.space, ...copy },
    cursor: snapshot.cursor,
    tasks: snapshot.tasks.map((t) => rowOf("task", t, authors)),
    agent_changes: snapshot.agent_changes.map((c) => ({
      task: c.task,
      actor: authors(c.actor),
      at: c.at,
      ...(c.row === undefined ? {} : { row: rowOf("task", c.row, authors) }),
    })),
    asking: snapshot.asking.map((t) => rowOf("task", t, authors)),
    nodes: snapshot.nodes.map((n) => rowOf("node", n, authors)),
    ...(snapshot.pages === undefined
      ? {}
      : { pages: snapshot.pages.map((p) => rowOf("page", p, authors)) }),
    preferences: snapshot.preferences,
    ...(reason === undefined ? {} : { reason }),
  };
}

/** A batch with each actor and each entity's row as a phone sees them. */
export function phoneBatch(batch: BatchMessage, authors: Authors): Record<string, unknown> {
  return {
    ...batch,
    events: batch.events.map((event) => ({
      ...event,
      actor: { kind: event.actor.kind, label: authors(event.actor.label) },
      entities: event.entities.map((entity) => ({
        ...entity,
        row: rowOf(entity.type, entity.row, authors),
      })),
    })),
  };
}
