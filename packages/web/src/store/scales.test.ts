// The space's statuses and effort scale in the page (@ttasks/client/store: `scalesOf`, LiveCore):
// read from the snapshot's preferences, the defaults for anything that does not read as a list of
// keys, and a batch that changes a preference asks for a snapshot, which carries its new value. Any
// list of sizes the contract allows reaches the card's options and the row as it is.
import fc from "fast-check";
import { createIntl } from "react-intl";
import { describe, expect, test } from "vitest";
import { PRODUCT_NAME, CLI_NAME } from "@ttasks/brand";
import { EFFORT_KEY_MAX, EFFORT_SCALE_MAX } from "@ttasks/contracts/preferences";
import en from "../i18n/en.json" with { type: "json" };
import type { MessageId, Values } from "../i18n/intl.tsx";
import { contextFor, renderRow } from "../row/model.ts";
import { sayMsg } from "../row/say.ts";
import {
  LiveCore,
  DEFAULT_SCALES,
  effortOptions,
  parseMessage,
  scalesOf,
  type SnapshotMessage,
} from "@ttasks/client/store";

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
    expect(message.scales).toEqual({
      statuses: ["open", "blocked"],
      efforts: [{ key: "XS" }, { key: "XL" }],
    });
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
    // Another preference changes nothing the page shows: the batch applies, with no snapshot.
    const other = core.receive({
      type: "batch",
      space_id: SPACE.id,
      epoch: CURSOR.epoch,
      incarnation: CURSOR.incarnation,
      from: CURSOR.seq,
      through: CURSOR.seq + 1,
      events: [
        {
          seq: CURSOR.seq + 1,
          request_id: "r2",
          actor: { kind: "human", label: "Mira" },
          kind: "pref.set",
          entities: [
            { type: "preference", id: "today.next_limit", row: null, changed: [], created: false },
          ],
        },
      ],
    });
    expect(other.kind).not.toBe("resnapshot");
  });
});

const intl = createIntl({ locale: "en", messages: en });
const t = (id: MessageId, values?: Values) =>
  intl.formatMessage({ id }, { product: PRODUCT_NAME, cli: CLI_NAME, ...values });
const CLOCK = {
  today: "2026-11-12",
  now: Date.UTC(2026, 10, 12, 8, 0),
  timeZone: "Europe/Amsterdam",
  locale: "en",
};

const FIRST = "A-Za-z0-9";
const REST = `${FIRST}_.-`;
const name = fc.oneof(
  fc.stringMatching(new RegExp(`^[${FIRST}]$`, "u")),
  fc.stringMatching(new RegExp(`^[${FIRST}][${REST}]{${String(EFFORT_KEY_MAX - 1)}}$`, "u")),
  fc.stringMatching(new RegExp(`^[0-9][${REST}]{0,${String(EFFORT_KEY_MAX - 1)}}$`, "u")),
  fc.stringMatching(new RegExp(`^[${FIRST}][${REST}]{0,${String(EFFORT_KEY_MAX - 1)}}$`, "u")),
);
const lists = fc.uniqueArray(name, {
  minLength: 1,
  maxLength: EFFORT_SCALE_MAX,
  selector: (n) => n.toLowerCase(),
});
const scaleOf = (value: unknown) =>
  scalesOf([{ key: "tasks.effort_scale", value, state: "set" }]).efforts.map((level) => level.key);

describe("[A5.3.7.web.effort-lists] any list of sizes reaches the card and the row as it is", () => {
  test("the store, the card's options and the row follow a list of 1 to 10 names", () => {
    fc.assert(
      fc.property(lists, (names) => {
        const efforts = scaleOf(names.map((key) => ({ key })));
        expect(efforts).toEqual(names);
        const scales = { ...DEFAULT_SCALES, efforts: names.map((key) => ({ key })) };
        const optionsOf = (effort: string | undefined) =>
          effortOptions(scales, effort).map((level) => level.key);
        expect(optionsOf(undefined)).toEqual(names);
        for (const key of names) {
          expect(optionsOf(key)).toEqual(names);
          const row = renderRow(
            {
              task: {
                id: "t_1",
                ref: "M-1",
                title: "Fixture",
                status: "open",
                inbox: false,
                lifecycle: "active",
                position: "a0",
                created_at: CLOCK.now,
                version: 1,
                effort: key,
              },
              instances: [],
            },
            contextFor("open", "area", CLOCK, scales.efforts),
          );
          expect(row.effort?.key).toBe(key);
          expect(row.effort === undefined ? undefined : sayMsg(t, row.effort.tip)).toBe(
            `Effort ${key}`,
          );
        }
        // A size the scale lost stays on its task's card, after the scale's.
        const stray = "Gone-size";
        if (!names.includes(stray)) {
          expect(optionsOf(stray)).toEqual([...names, stray]);
        }
      }),
    );
  });

  test("a list with fields the page does not know keeps its names; more than the contract allows does not read", () => {
    expect(scaleOf([{ key: "XS", time: { amount: 10, unit: "minutes" } }, { key: "S" }])).toEqual([
      "XS",
      "S",
    ]);
    const eleven = Array.from({ length: EFFORT_SCALE_MAX + 1 }, (_, i) => ({
      key: `S${String(i)}`,
    }));
    expect(scaleOf(eleven)).toEqual(DEFAULT_SCALES.efforts.map((level) => level.key));
    expect(scaleOf(eleven.slice(0, EFFORT_SCALE_MAX))).toHaveLength(EFFORT_SCALE_MAX);
    expect(scaleOf([{ key: "X".repeat(EFFORT_KEY_MAX + 1) }])).toEqual(
      DEFAULT_SCALES.efforts.map((level) => level.key),
    );
  });
});
