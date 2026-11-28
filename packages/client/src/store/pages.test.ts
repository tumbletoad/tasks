// The Library's lists come from the live store: the snapshot's pages, and the feed's page rows
// after it. A row that is not shown (its page or what holds it is in the Trash) leaves the lists,
// a page row the feed withholds asks for a fresh snapshot, and a node's texts changing carries no
// row. Rows from the contract's examples.
import { PAGE_FEED_EXAMPLES } from "@ttasks/contracts";
import { describe, expect, test } from "vitest";
import { LiveCore } from "./core.ts";
import { parseMessage, type BatchMessage, type SnapshotMessage } from "./rows.ts";

const SPACE = { id: "sp_0123456789abcdefghjkmnpqrs", name: "Mira", ref_prefix: "M" };
const CURSOR = { epoch: 1, incarnation: "ai_0123456789abcdefghjkmnpq", seq: 1040 };

/** A message as the feed sends it, read as the page reads it. */
const read = (message: unknown) => parseMessage(JSON.stringify(message)) as never;

const snapshot = (pages: unknown[]): SnapshotMessage =>
  read({
    type: "snapshot",
    space: SPACE,
    cursor: CURSOR,
    tasks: [],
    areas: [],
    projects: [],
    pages,
  });

const batch = (events: unknown[], from = 1040, through = 1050): BatchMessage =>
  read({
    type: "batch",
    space_id: SPACE.id,
    epoch: 1,
    incarnation: CURSOR.incarnation,
    from,
    through,
    events,
  });

describe("[A5.pages.web.store] the page holds the pages shown, live", () => {
  test("from the snapshot and the batches after it: a page leaving for the Trash leaves the lists, a withheld row asks for a snapshot, a text change carries none", () => {
    const core = new LiveCore(SPACE.id);
    const [live, onTask] = PAGE_FEED_EXAMPLES.snapshotPages;
    core.receive(snapshot([...PAGE_FEED_EXAMPLES.snapshotPages, { id: "pg_x" }]));
    expect([...(core.publish()?.pages.keys() ?? [])]).toEqual([live?.id, onTask?.id]);

    const leaves = core.receive(batch([PAGE_FEED_EXAMPLES.pageLeaves]));
    expect(leaves.kind).toBe("applied");
    expect([...(core.publish()?.pages.keys() ?? [])]).toEqual([onTask?.id]);

    const text = core.receive(batch([PAGE_FEED_EXAMPLES.textChanged], 1050, 1051));
    expect(text.kind === "applied" ? text.changes.map((c) => [c.type, c.id]) : []).toEqual([
      ["node_text", PAGE_FEED_EXAMPLES.textChanged.entities[0]?.id],
    ]);

    const withheld = {
      ...PAGE_FEED_EXAMPLES.pageLeaves,
      seq: 1052,
      entities: [{ type: "page", id: onTask?.id, row: null, changed: ["title"], created: false }],
    };
    expect(core.receive(batch([withheld], 1051, 1052))).toEqual({
      kind: "resnapshot",
      reason: "withheld",
    });
  });
});
