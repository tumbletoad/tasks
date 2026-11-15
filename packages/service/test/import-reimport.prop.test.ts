// M7.05's Verify line (A7 3.14): random prototype edits between imports apply exactly the changed
// fields, conflict where the space changed the same field, and give zero operations for unchanged
// input. Each run imports a small synthetic prototype into the Mira sample, then for a few rounds
// edits fields on both sides (the prototype's files, and the person's own changes through the
// writer), imports again through the service's dry run and apply (import-harness.ts), and compares
// every field and every reported conflict with a model of A1 3.14's table. Right after each import
// the same input is imported once more, which must write nothing. Fixture data only, in temporary
// folders removed by their full names.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Operation } from "@tasks/storage";
import { openWorld, writePrototype, type ImportWorld, type ProtoTask } from "./import-harness.ts";

const IDS = ["pa", "pb", "pc"] as const;
type Legacy = (typeof IDS)[number];

/** The fields the property edits, with the values each may take on either side. */
const POOLS = {
  title: ["Alpha", "Beta", "Gamma"],
  summary: ["", "Call it", "Write it"],
  context: ["", "Body one", "Body two"],
  status: ["open", "waiting", "backlog"],
  priority: [1, 2, 3],
  due: [null, "2026-12-01", "2026-12-02"],
  grouping: ["Work", "Home", "Errands"],
  lifecycle: ["active", "completed"],
} as const;
type Field = keyof typeof POOLS;
const FIELDS = Object.keys(POOLS) as Field[];
type Values = { -readonly [F in Field]: (typeof POOLS)[F][number] };

const slug = (category: string): string => category.toLowerCase();

/** One edit: a task, a field and a value's index in its pool. */
const edit = fc.record({
  task: fc.constantFrom(...IDS),
  field: fc.constantFrom(...FIELDS),
  pick: fc.nat(2),
});
const scenario = fc.record({
  start: fc.array(fc.array(fc.nat(2), { minLength: FIELDS.length, maxLength: FIELDS.length }), {
    minLength: IDS.length,
    maxLength: IDS.length,
  }),
  rounds: fc.array(
    fc.record({
      prototype: fc.array(edit, { maxLength: 4 }),
      person: fc.array(edit, { maxLength: 4 }),
      // Fields both sides change in the round, each to a value of its own: the conflicts.
      both: fc.array(fc.record({ cell: edit, theirs: fc.nat(2) }), { maxLength: 2 }),
    }),
    { minLength: 1, maxLength: 3 },
  ),
});

/** How often each verdict came up over all runs: the property must meet every one. */
const seen = { apply: 0, settle: 0, keep: 0, conflict: 0 };

/** The model of one field (A1 3.14): the base, and whether the space changed it since. */
interface Cell {
  base: unknown;
  dirty: boolean;
}

let scratch = "";
let runs = 0;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "tasks-m7-05-prop-"));
});

afterAll(() => {
  if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
});

/** A field's value in the space, in the pool's form. */
function spaceValue(world: ImportWorld, id: string, field: Field): unknown {
  const row =
    world.rows(
      "SELECT t.*, a.slug AS area_slug FROM tasks t LEFT JOIN areas a ON a.id = t.area_id " +
        "WHERE t.id = $id",
      { id },
    )[0] ?? {};
  switch (field) {
    case "due":
      return row["due_date"] ?? null;
    case "grouping":
      return row["area_slug"];
    case "lifecycle":
      return row["lifecycle"];
    default:
      return row[field];
  }
}

/** The prototype's value in the space's form: a category is its area's slug. */
const spaceForm = (field: Field, value: unknown): unknown =>
  field === "grouping" ? slug(String(value)) : value;

describe("[A7.3.15.importer.reimport-property] random edits on both sides between imports", () => {
  test("exactly the changed fields apply, both-sided changes conflict and stay, the same input writes nothing", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async ({ start, rounds }) => {
        runs += 1;
        const root = join(scratch, `r${String(runs)}`);
        const prototype = join(root, "prototype");
        mkdirSync(root, { recursive: true });
        const world = await openWorld(root, { tasks: 3, seed: `prop-${String(runs)}` });
        try {
          const proto = new Map<Legacy, Values>();
          IDS.forEach((id, k) => {
            const picks = start[k] ?? [];
            const values = Object.fromEntries(
              FIELDS.map((f, j) => [f, POOLS[f][(picks[j] ?? 0) % POOLS[f].length]]),
            ) as Values;
            // Both areas the person moves tasks into exist from the first import on.
            if (k < 2) values.grouping = k === 0 ? "Work" : "Home";
            proto.set(id, values);
          });
          const events: { id: string; task: string; action: string; at: string }[] = [];
          let clock = Date.UTC(2026, 10, 1);
          const checkEvent = (id: Legacy, lifecycle: string) => {
            clock += 60_000;
            events.push({
              id: `cli-${String(events.length).padStart(4, "0")}`,
              task: id,
              action: lifecycle === "completed" ? "check" : "uncheck",
              at: new Date(clock).toISOString(),
            });
          };
          for (const id of IDS) if (proto.get(id)?.lifecycle === "completed") checkEvent(id, "completed");
          const write = () => {
            const tasks: ProtoTask[] = IDS.map((id) => {
              const v = proto.get(id) as Values;
              return {
                id,
                title: v.title,
                body: v.context,
                meta: {
                  category: v.grouping,
                  status: v.status,
                  priority: `P${String(v.priority)}`,
                  ...(v.summary === "" ? {} : { next: v.summary }),
                  ...(v.due === null ? {} : { due: v.due }),
                },
              };
            });
            writePrototype(prototype, { tasks, events });
          };
          const reimport = async () => {
            const preview = await world.preview({ folder: prototype });
            expect(preview.blocked).toBe(false);
            return world.apply(preview.run, preview.token ?? "");
          };

          write();
          const first = await reimport();
          expect(first.counts.created).toBe(IDS.length);
          const ids = new Map(
            IDS.map((id) => [
              id,
              String(
                world.rows(
                  "SELECT entity_id FROM aliases WHERE namespace = 'planning' AND alias = $a",
                  { a: id },
                )[0]?.["entity_id"],
              ),
            ]),
          );
          const model = new Map<string, Cell>();
          const cell = (id: Legacy, f: Field): Cell => {
            const key = `${id}|${f}`;
            let c = model.get(key);
            if (c === undefined) {
              c = { base: spaceForm(f, proto.get(id)?.[f]), dirty: false };
              model.set(key, c);
            }
            return c;
          };
          for (const id of IDS) {
            for (const f of FIELDS) {
              expect(spaceValue(world, ids.get(id) ?? "", f), `${id}.${f}`).toEqual(cell(id, f).base);
            }
          }

          for (const round of rounds) {
            // The person's own changes, each one commit; a change to the value it has is none.
            const person = [...round.person, ...round.both.map((b) => b.cell)];
            const prototypeEdits = [
              ...round.prototype,
              ...round.both.map((b) => ({ ...b.cell, pick: b.cell.pick + 1 + (b.theirs % 2) })),
            ];
            for (const e of person) {
              const id = ids.get(e.task) ?? "";
              const pool = POOLS[e.field].filter((v) => e.field !== "grouping" || v !== "Errands");
              const value = pool[e.pick % pool.length];
              const now = spaceValue(world, id, e.field);
              if (spaceForm(e.field, value) === now) continue;
              const op: Operation =
                e.field === "grouping"
                  ? { kind: "task.move", task: id, area: slug(String(value)) }
                  : e.field === "lifecycle"
                    ? value === "completed"
                      ? { kind: "task.complete", task: id }
                      : { kind: "task.reopen", task: id }
                    : {
                        kind: "task.patch",
                        task: id,
                        set: { [e.field]: e.field === "due" && value !== null ? { date: value } : value },
                      };
              expect(world.edit([op]).status, `${e.task}.${e.field}`).toBe("applied");
              cell(e.task, e.field).dirty = true;
            }
            // The prototype's edits.
            for (const e of prototypeEdits) {
              const v = proto.get(e.task) as Values;
              const before = v[e.field];
              (v as Record<Field, unknown>)[e.field] = POOLS[e.field][e.pick % POOLS[e.field].length];
              if (e.field === "lifecycle" && v.lifecycle !== before) checkEvent(e.task, v.lifecycle);
            }
            write();

            // The model's verdict per field (A1 3.14's table).
            const verdicts = new Map<string, "apply" | "settle" | "keep" | "conflict">();
            const before = new Map<string, unknown>();
            let writes = false;
            for (const id of IDS) {
              for (const f of FIELDS) {
                const c = cell(id, f);
                const e = spaceForm(f, proto.get(id)?.[f]);
                const s = spaceValue(world, ids.get(id) ?? "", f);
                before.set(`${id}|${f}`, s);
                const v =
                  e === c.base
                    ? s === e
                      ? "settle"
                      : "keep"
                    : !c.dirty
                      ? "apply"
                      : s === e
                        ? "settle"
                        : "conflict";
                verdicts.set(`${id}|${f}`, v);
                seen[v] += 1;
                if (v === "apply" || (v === "settle" && e !== c.base)) writes = true;
              }
            }
            const seq = world.seq();
            const result = await reimport();
            expect(result.status, "an import writes when a field applies or settles anew").toBe(
              writes ? "applied" : "unchanged",
            );
            if (!writes) expect(world.seq()).toBe(seq);
            for (const id of IDS) {
              const row = result.tasks.find((t) => t.legacy_id === id);
              const conflicts = FIELDS.filter((f) => verdicts.get(`${id}|${f}`) === "conflict");
              expect((row?.conflicts ?? []).filter((f) => FIELDS.includes(f as Field)).sort()).toEqual(
                conflicts.sort(),
              );
              for (const f of FIELDS) {
                const c = cell(id, f);
                const v = verdicts.get(`${id}|${f}`);
                const e = spaceForm(f, proto.get(id)?.[f]);
                const now = spaceValue(world, ids.get(id) ?? "", f);
                // Exactly the changed field applies; every other keeps the space's value.
                expect(now, `${id}.${f} (${String(v)})`).toEqual(
                  v === "apply" ? e : before.get(`${id}|${f}`),
                );
                if (writes && (v === "apply" || v === "settle")) {
                  c.base = e;
                  c.dirty = false;
                }
              }
            }
            // The same input once more: zero operations.
            const seqAfter = world.seq();
            const again = await reimport();
            expect(again.status).toBe("unchanged");
            expect(world.seq()).toBe(seqAfter);
          }
        } finally {
          world.close();
        }
      }),
      { numRuns: 12, seed: 0x0705 },
    );
    // Every row of the table came up: a field that applies, one that settles where both sides
    // agree, one the space changed alone, and one both changed.
    for (const [verdict, count] of Object.entries(seen)) {
      expect(count, verdict).toBeGreaterThan(0);
    }
  }, 600_000);
});
