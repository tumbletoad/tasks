// The examples both lanes build against that no entry's example can hold: the feed's page rows
// and a Restore that meets a newer body.
import type { ErrorBody } from "../errors.ts";
import type { z } from "zod";
import type { CompactPage } from "../pages.ts";
import { AS_OF_NEXT } from "./fixture.ts";
import { LUMEN, M180 } from "./page-read.ts";

const live: z.input<typeof CompactPage> = {
  ...M180,
  title: "Time zone rules",
  brief: "Store UTC plus the clinic's zone ID; convert once",
  owner_kind: "project",
  owner_id: LUMEN.project,
  area_id: LUMEN.area,
  project_id: LUMEN.project,
  version: 1031,
  by: "agent:codex-work",
  at: 1_778_425_320_000,
  why: "store the zone ID, not the offset: M-3's reports drifted",
};

/** A page of a task, as the snapshot's `pages` lists it: the task comes with it. */
const onTask: z.input<typeof CompactPage> = {
  id: "pg_3d7h1m5r9w3b7f1k5p9t3x7c1g",
  ref: "M-221",
  title: "Offset measurements, week 46",
  brief: "Raw times per clinic and the setup",
  owner_kind: "task",
  owner_id: "t_5m2k8q0w3z7r1c9d4f6h8j0n2p",
  task: { ref: "M-14", title: "Fix appointment time zones", lifecycle: "active" },
  area_id: LUMEN.area,
  project_id: LUMEN.project,
  version: 1040,
  by: "agent:claude-code",
  at: 1_778_500_800_000,
};

export const PAGE_FEED_EXAMPLES = {
  /** The snapshot gains `pages`: every page of the space that is shown, without its body. */
  snapshotPages: [live, onTask],
  /**
   * A batch event that takes M-180 out of the live lists: an agent moved it to the Trash. A page
   * whose task goes to the Trash leaves the same way, its row carrying the task's time.
   */
  pageLeaves: {
    seq: 1050,
    at: 1_778_590_000_000,
    op_id: "op_6n0r4v8z2d6h0m4q8t2x6b0f4j",
    request_id: "7f3c2a10-5d4e-4b8a-9c61-2e0f3a7b0097",
    actor: { kind: "agent", label: "codex-work" },
    kind: "ops",
    entities: [
      {
        type: "page",
        id: M180.id,
        row: {
          ...live,
          version: 1050,
          at: 1_778_590_000_000,
          why: "merged into M-140, the report template",
          deleted_at: 1_778_590_000_000,
        },
        changed: ["deleted"],
        created: false,
      },
    ],
  },
  /**
   * A change to a node's texts (its description, the space's brief, the text for agents) carries
   * no row: a Library that shows the node reads it again.
   */
  textChanged: {
    seq: 1051,
    at: 1_778_590_060_000,
    op_id: "op_8q2v6z0d4h8m2r6w0b4f8k2p6t",
    request_id: "7f3c2a10-5d4e-4b8a-9c61-2e0f3a7b0098",
    actor: { kind: "human", label: "user" },
    kind: "ops",
    entities: [
      { type: "node_text", id: LUMEN.project, row: null, changed: ["for_agents"], created: false },
    ],
  },
};

/**
 * Restore, or the person's pen, sent with the base of a body that changed since: nothing is
 * written. The page keeps the person's words in their box ("Not saved", as for a note) and shows
 * the newer change; Restore is offered again on the newest body.
 */
export const PAGE_CONFLICT_EXAMPLE: ErrorBody = {
  code: "conflict",
  message: "The page changed since you read it.",
  hint: "Read the page again, then send the change with a new request ID.",
  data: {
    as_of: AS_OF_NEXT,
    conflicts: [
      {
        entity: "pages",
        id: M180.id,
        field: "body",
        version: 1047,
        by: "agent:codex-work",
        at: "2026-11-12T10:10:00.000Z",
      },
    ],
  },
};
