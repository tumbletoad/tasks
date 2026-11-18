// The space's statuses and effort scale in the page (rows.ts `scalesOf`, core.ts): read from the
// snapshot's preferences, the defaults for anything that does not read as a list of keys, and a
// batch that changes a preference asks for a snapshot, which carries its new value.
import { describe, expect, test } from "vitest";
import { LiveCore } from "./core.ts";
import { DEFAULT_SCALES, parseMessage, scalesOf, type SnapshotMessage } from "./rows.ts";

const SPACE = { id: "sp_0123456789abcdefghjkmnpqrs", name: "Mira", ref_prefix: "M" };
const CURSOR = { epoch: 1, incarnation: "ai_0123456789abcdefghjkmnpq", seq: 10 };

const snapshotText = (preferences: unknown) =>
  JSON.stringify({
    type: "snapshot",
    space: SPACE,
    cursor: CURSOR,
    tasks: [],
    areas: [],
    projects: [],
    instances: [],
    preferences,
  });

describe("[A5.3.7.web.scales] the space's statuses and effort scale reach the page", () => {
  test("the snapshot's preferences set them; what does not read keeps the defaults", () => {
    const message = parseMessage(
      snapshotText([
        { key: "ui.theme", value: "sumi", state: "set" },
        { key: "tasks.statuses", value: ["open", "blocked"], state: "set" },
        { key: "tasks.effort_scale", value: [{ key: "XS" }, { key: "XL" }], state: "set" },
      ]),
    ) as SnapshotMessage;
    expect(message.scales).toEqual({ statuses: ["open", "blocked"], efforts: ["XS", "XL"] });
    for (const junk of [
      undefined,
      "x",
      [{ key: "tasks.statuses", value: [] }],
      [{ key: "tasks.statuses", value: ["open", 3] }],
      [{ key: "tasks.statuses", value: ["<b>"] }],
      [{ key: "tasks.effort_scale", value: ["S"] }],
    ]) {
      expect(scalesOf(junk), JSON.stringify(junk)).toEqual(DEFAULT_SCALES);
    }
  });

  test("the core holds the snapshot's scales, and a changed preference asks for a new snapshot", () => {
    const core = new LiveCore(SPACE.id);
    core.receive(parseMessage(snapshotText([])) as SnapshotMessage);
    expect(core.publish()?.scales).toEqual(DEFAULT_SCALES);
    const outcome = core.receive({
      type: "batch",
      space_id: SPACE.id,
      epoch: CURSOR.epoch,
      incarnation: CURSOR.incarnation,
      from: CURSOR.seq,
      through: CURSOR.seq + 1,
      events: [
        {
          seq: CURSOR.seq + 1,
          request_id: "r1",
          actor: { kind: "human", label: "Mira" },
          kind: "pref.set",
          entities: [
            { type: "preference", id: "tasks.statuses", row: null, changed: [], created: false },
          ],
        },
      ],
    });
    expect(outcome).toEqual({ kind: "resnapshot", reason: "preference" });
    core.receive(
      parseMessage(
        snapshotText([{ key: "tasks.statuses", value: ["open", "done"], state: "set" }]),
      ) as SnapshotMessage,
    );
    expect(core.publish()?.scales.statuses).toEqual(["open", "done"]);
  });
});
