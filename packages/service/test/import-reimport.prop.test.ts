// M7.05's Verify line (A7 3.14): random prototype edits between imports apply exactly the changed
// fields, conflict where the space changed the same field, and give zero operations for unchanged
// input. Each run imports a small synthetic prototype into the Mira sample, then for a few rounds
// edits both sides (the prototype's files, and the person's own changes through the writer, some
// taken back with Ctrl+Z), imports again through the service's dry run and apply
// (import-harness.ts), and compares every field, every link and every reported conflict with a
// model of A1 3.14's table. The edits include unchecking and checking again on both sides, writing
// an outcome, and naming, dropping, linking and taking off sources. Above the table: a value the
// person changed since the last import is never overwritten. Right after each import the same
// input is imported once more, which must write nothing. Fixture data only, in temporary folders
// removed by their full names.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Operation } from "@tasks/storage";
import { openWorld, writePrototype, type ImportWorld, type ProtoTask } from "./import-harness.ts";

const IDS = ["pa", "pb", "pc"] as const;
type Legacy = (typeof IDS)[number];

/** The two sources the property names, links and takes off, by their URL. */
const URLS = { a: "https://example.com/notes/a", b: "https://example.com/notes/b" } as const;
type SourceName = keyof typeof URLS;
const keyOf = (name: SourceName): string => `url:${URLS[name]}`;

/**
 * The fields the property edits, with the values each may take on either side. In the prototype,
 * `lifecycle` is an open line, one checked by an event, or a line in DONE.md with `wrap` as its
 * outcome; the person reopens, completes, and writes an outcome. `sources` are the prototype's
 * sources, and the person's own link of one.
 */
const POOLS = {
  title: ["Alpha", "Beta", "Gamma"],
  summary: ["", "Call it", "Write it"],
  context: ["", "Body one", "Body two"],
  status: ["open", "waiting", "backlog"],
  priority: [1, 2, 3],
  due: [null, "2026-12-01", "2026-12-02"],
  grouping: ["Work", "Home", "Errands"],
  lifecycle: ["active", "completed", "done"],
  wrap: ["Shipped", "Parked", "Noted"],
  // The task's folder under the root `work`: a place is a row of its own, with its own version.
  place: [null, "a", "b"],
  sources: [["a"], [], ["a", "b"]],
} as const;
type Field = Exclude<keyof typeof POOLS, "sources">;
type Editable = keyof typeof POOLS;
const FIELDS = Object.keys(POOLS).filter((f) => f !== "sources") as Field[];
type Values = {
  -readonly [F in Editable]: F extends "sources"
    ? readonly SourceName[]
    : (typeof POOLS)[F][number];
};

const slug = (category: string): string => category.toLowerCase();

/** The day a line of DONE.md was done. */
const DONE_DATE = "2026-11-02";

/** One edit: a task, a field and a value's index in its pool. */
const edit = fc.record({
  task: fc.constantFrom(...IDS),
  field: fc.constantFrom(...(Object.keys(POOLS) as Editable[])),
  pick: fc.nat(2),
});
const scenario = fc.record({
  start: fc.array(fc.array(fc.nat(2), { minLength: 11, maxLength: 11 }), {
    minLength: IDS.length,
    maxLength: IDS.length,
  }),
  rounds: fc.array(
    fc.record({
      // Ctrl+Z of the person's last change, before this round's edits.
      undo: fc.boolean(),
      prototype: fc.array(edit, { maxLength: 4 }),
      person: fc.array(edit, { maxLength: 4 }),
      // Fields both sides change in the round, each to a value of its own: the conflicts.
      both: fc.array(fc.record({ cell: edit, theirs: fc.nat(2) }), { maxLength: 2 }),
      // One side changes a task's outcome while the other changes its lifecycle.
      crossed: fc.option(
        fc.record({
          task: fc.constantFrom(...IDS),
          person: fc.constantFrom("wrap" as const, "lifecycle" as const),
          pick: fc.nat(2),
          theirs: fc.nat(2),
        }),
      ),
      // The sources the prototype names for each task, or null to leave them.
      sources: fc.array(fc.constantFrom(null, 0, 1, 2), { minLength: 3, maxLength: 3 }),
      // The person links a source by hand, last in the round, so a later Ctrl+Z takes it off; the
      // prototype may name it in the same round.
      link: fc.option(
        fc.record({ task: fc.constantFrom(...IDS), pick: fc.nat(1), named: fc.boolean() }),
      ),
    }),
    { minLength: 1, maxLength: 5 },
  ),
});

/** How often each verdict came up over all runs: the property must meet every one. */
const seen = { apply: 0, settle: 0, keep: 0, conflict: 0 };
/** How often the cases the property exists for came up. */
const met = { lifecycleOverOutcome: 0, sourceTakenOff: 0, sourceDroppedBetween: 0, undo: 0 };

/** The model of one field (A1 3.14): the base, and whether the space changed it since. */
interface Cell {
  base: unknown;
  dirty: boolean;
}

type Verdict = "apply" | "settle" | "keep" | "conflict";

let scratch = "";
let runs = 0;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "tasks-m7-05-prop-"));
});

afterAll(() => {
  if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
});

/** A field's value in the space, in the model's form. */
function spaceValue(world: ImportWorld, id: string, field: Field): unknown {
  if (field === "place") {
    const place = world.rows(
      "SELECT rel_path FROM places WHERE owner_kind = 'task' AND owner_id = $id AND deleted_at IS NULL",
      { id },
    )[0];
    return place?.["rel_path"] ?? null;
  }
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
    case "wrap":
      return row["wrap_state"] === "wrapped" ? row["outcome"] : null;
    default:
      return row[field];
  }
}

/** The sources a task links now, by name. */
function linked(world: ImportWorld, id: string): Set<SourceName> {
  const keys = world
    .rows(
      "SELECT s.source_key AS key FROM task_sources ts JOIN sources s ON s.id = ts.source_id " +
        "WHERE ts.task_id = $id AND ts.removed_at IS NULL AND s.deleted_at IS NULL",
      { id },
    )
    .map((r) => r["key"]);
  return new Set((Object.keys(URLS) as SourceName[]).filter((n) => keys.includes(keyOf(n))));
}

/** E: the prototype's value of a field in the model's form. */
function expectedOf(v: Values, field: Field): unknown {
  switch (field) {
    case "grouping":
      return slug(v.grouping);
    case "lifecycle":
      return v.lifecycle === "active" ? "active" : "completed";
    case "wrap":
      return v.lifecycle === "done" ? v.wrap : null;
    case "context": {
      // A line of DONE.md keeps its done clause in its body, as the page writes it.
      if (v.lifecycle !== "done") return v.context;
      const clause = `(done ${DONE_DATE}; ${v.wrap})`;
      return v.context === "" ? clause : `${v.context} ${clause}`;
    }
    default:
      return v[field];
  }
}

/** The fields a person's operation writes, as the writer versions them. */
function touched(op: Operation): Field[] {
  switch (op.kind) {
    case "task.complete":
    case "task.reopen":
      return ["lifecycle", "wrap"];
    case "task.wrap_up":
      return ["wrap"];
    case "task.move":
      return ["grouping"];
    case "place.set":
    case "place.clear":
      return ["place"];
    case "task.patch":
      return Object.keys(op.set ?? {}) as Field[];
    default:
      return [];
  }
}

describe("[A7.3.15.importer.reimport-property] random edits on both sides between imports", () => {
  test("exactly the changed fields apply, both-sided changes conflict and stay, the same input writes nothing", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async ({ start, rounds }) => {
        runs += 1;
        const root = join(scratch, `r${String(runs)}`);
        const prototype = join(root, "prototype");
        const places = join(root, "places");
        for (const folder of POOLS.place) {
          if (folder !== null) mkdirSync(join(places, folder), { recursive: true });
        }
        const world = await openWorld(root, {
          tasks: 3,
          seed: `prop-${String(runs)}`,
          roots: [{ id: "work", path: places }],
        });
        try {
          const editable = Object.keys(POOLS) as Editable[];
          const proto = new Map<Legacy, Values>();
          IDS.forEach((id, k) => {
            const picks = start[k] ?? [];
            const values = Object.fromEntries(
              editable.map((f, j) => [f, POOLS[f][(picks[j] ?? 0) % POOLS[f].length]]),
            ) as unknown as Values;
            // Both areas the person moves tasks into exist from the first import on.
            if (k < 2) values.grouping = k === 0 ? "Work" : "Home";
            proto.set(id, values);
          });
          // The page's check events: the last one of a task in TODO.md decides.
          const events: { id: string; task: string; action: string; at: string }[] = [];
          const checked = new Map<Legacy, boolean>();
          let clock = Date.UTC(2026, 10, 1);
          const write = () => {
            for (const id of IDS) {
              const lifecycle = proto.get(id)?.lifecycle;
              if (lifecycle === "done") continue;
              const want = lifecycle === "completed";
              if ((checked.get(id) ?? false) === want) continue;
              clock += 60_000;
              events.push({
                id: `cli-${String(events.length).padStart(4, "0")}`,
                task: id,
                action: want ? "check" : "uncheck",
                at: new Date(clock).toISOString(),
              });
              checked.set(id, want);
            }
            const tasks: ProtoTask[] = IDS.map((id) => {
              const v = proto.get(id) as Values;
              return {
                id,
                title: v.title,
                body: v.context,
                ...(v.lifecycle === "done" ? { done: { date: DONE_DATE, evidence: v.wrap } } : {}),
                meta: {
                  category: v.grouping,
                  status: v.status,
                  priority: `P${String(v.priority)}`,
                  ...(v.summary === "" ? {} : { next: v.summary }),
                  ...(v.due === null ? {} : { due: v.due }),
                  ...(v.place === null ? {} : { paths: [join(places, v.place)] }),
                  ...(v.sources.length === 0
                    ? {}
                    : { sources: v.sources.map((n) => ({ label: `Notes ${n}`, url: URLS[n] })) }),
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
              c = { base: expectedOf(proto.get(id) as Values, f), dirty: false };
              model.set(key, c);
            }
            return c;
          };
          // Every source an import that wrote named for the task: one not linked now was taken off.
          const named = new Map<Legacy, Set<SourceName>>(
            IDS.map((id) => [id, new Set(proto.get(id)?.sources ?? [])]),
          );
          // The sources the newest import that wrote named.
          const newest = new Map<Legacy, Set<SourceName>>(
            IDS.map((id) => [id, new Set(proto.get(id)?.sources ?? [])]),
          );
          for (const id of IDS) {
            for (const f of FIELDS) {
              expect(spaceValue(world, ids.get(id) ?? "", f), `${id}.${f}`).toEqual(
                cell(id, f).base,
              );
            }
            expect([...linked(world, ids.get(id) ?? "")].sort()).toEqual(
              [...(proto.get(id)?.sources ?? [])].sort(),
            );
          }
          // The person's changes, newest last, as Ctrl+Z takes them back.
          const undoable: { task: Legacy; fields: Field[] }[] = [];

          for (const round of rounds) {
            if (round.undo && undoable.length > 0) {
              const last = undoable.at(-1);
              const undo = world.writer.submit({
                space_id: world.writer.spaceId,
                request_id: `undo-${String(runs).padStart(4, "0")}-${String(world.seq()).padStart(8, "0")}`,
                actor: {
                  scope_id: "cli:import-test",
                  principal_id: world.user,
                  actor_kind: "human",
                  machine_id: world.machine,
                  origin: "cli",
                },
                ops: [{ kind: "undo" }],
              });
              expect(undo.status, "an undo is applied or meets a later change").not.toBe(
                "rejected",
              );
              if (undo.status === "applied" && last !== undefined) {
                met.undo += 1;
                undoable.pop();
                // The undo writes back what the change wrote: those fields changed again.
                for (const f of last.fields) cell(last.task, f).dirty = true;
              }
            }
            // The person's own changes, each one commit; a change to the value it has is none.
            const crossed = round.crossed;
            const person = [
              ...round.person,
              ...round.both.map((b) => b.cell),
              ...(crossed === null ? [] : [{ ...crossed, field: crossed.person }]),
              ...(round.link === null ? [] : [{ ...round.link, field: "sources" as const }]),
            ];
            const prototypeEdits = [
              ...round.prototype,
              ...IDS.flatMap((task, k) => {
                const pick = round.sources[k] ?? null;
                return pick === null ? [] : [{ task, field: "sources" as const, pick }];
              }),
              ...round.both.map((b) => ({ ...b.cell, pick: b.cell.pick + 1 + (b.theirs % 2) })),
              ...(crossed === null
                ? []
                : [
                    {
                      task: crossed.task,
                      field: crossed.person === "wrap" ? ("lifecycle" as const) : ("wrap" as const),
                      pick: crossed.theirs,
                    },
                  ]),
            ];
            for (const e of person) {
              const id = ids.get(e.task) ?? "";
              let op: Operation | undefined;
              if (e.field === "sources") {
                const name: SourceName = e.pick % 2 === 0 ? "a" : "b";
                if (!linked(world, id).has(name)) {
                  op = {
                    kind: "source.add",
                    task: id,
                    source: {
                      kind: "web",
                      title: `Mine ${name}`,
                      url: URLS[name],
                      key: keyOf(name),
                    },
                  };
                }
              } else if (e.field === "lifecycle") {
                const done = e.pick % 2 === 1;
                const now = spaceValue(world, id, "lifecycle");
                if (done && now === "active") op = { kind: "task.complete", task: id };
                if (!done && now !== "active") op = { kind: "task.reopen", task: id };
              } else if (e.field === "wrap") {
                const outcome = POOLS.wrap[e.pick % POOLS.wrap.length] ?? "Shipped";
                if (spaceValue(world, id, "wrap") !== outcome) {
                  op =
                    spaceValue(world, id, "lifecycle") === "active"
                      ? { kind: "task.complete", task: id, outcome }
                      : { kind: "task.wrap_up", task: id, outcome };
                }
              } else {
                const pool = POOLS[e.field].filter(
                  (v) => e.field !== "grouping" || v !== "Errands",
                );
                const value = pool[e.pick % pool.length];
                const form = e.field === "grouping" ? slug(String(value)) : value;
                if (form !== spaceValue(world, id, e.field)) {
                  op =
                    e.field === "place"
                      ? value === null
                        ? { kind: "place.clear", task: id }
                        : { kind: "place.set", task: id, root: "work", path: String(value) }
                      : e.field === "grouping"
                        ? { kind: "task.move", task: id, area: slug(String(value)) }
                        : {
                            kind: "task.patch",
                            task: id,
                            set: {
                              [e.field]:
                                e.field === "due" && value !== null ? { date: value } : value,
                            },
                          };
                }
              }
              if (op === undefined) continue;
              expect(world.edit([op]).status, `${e.task}.${e.field}`).toBe("applied");
              const fields = touched(op);
              for (const f of fields) cell(e.task, f).dirty = true;
              undoable.push({ task: e.task, fields });
            }
            // The prototype's edits.
            for (const e of prototypeEdits) {
              const v = proto.get(e.task) as Values;
              (v as Record<Editable, unknown>)[e.field] =
                POOLS[e.field][e.pick % POOLS[e.field].length];
            }
            // The prototype names the source the person just linked: the import records it.
            if (round.link?.named === true) {
              const v = proto.get(round.link.task) as Values;
              const name: SourceName = round.link.pick % 2 === 0 ? "a" : "b";
              if (!v.sources.includes(name)) v.sources = [...v.sources, name].sort();
            }
            write();

            // The model's verdict per field (A1 3.14's table).
            const verdicts = new Map<string, Verdict>();
            const before = new Map<string, unknown>();
            const links = new Map<Legacy, Set<SourceName>>();
            let writes = false;
            for (const id of IDS) {
              const task = ids.get(id) ?? "";
              const v = proto.get(id) as Values;
              const table = (f: Field): Verdict => {
                const c = cell(id, f);
                const e = expectedOf(v, f);
                const s = spaceValue(world, task, f);
                before.set(`${id}|${f}`, s);
                return e === c.base
                  ? s === e
                    ? "settle"
                    : "keep"
                  : !c.dirty
                    ? "apply"
                    : s === e
                      ? "settle"
                      : "conflict";
              };
              const own = new Map(FIELDS.map((f) => [f, table(f)]));
              // A completion or a reopen writes the lifecycle and the outcome together: when the
              // person's value of either stands, the other is a conflict too.
              const personal = (x: Verdict | undefined) => x === "keep" || x === "conflict";
              const [lv, wv] = [own.get("lifecycle"), own.get("wrap")];
              if (lv === "apply" && personal(wv)) {
                own.set("lifecycle", "conflict");
                met.lifecycleOverOutcome += 1;
              }
              if (wv === "apply" && personal(lv)) own.set("wrap", "conflict");
              // An outcome alone: a finished task is wrapped up again, never unwrapped.
              if (own.get("wrap") === "apply" && own.get("lifecycle") !== "apply") {
                const active = spaceValue(world, task, "lifecycle") === "active";
                if (expectedOf(v, "wrap") === null || active) own.set("wrap", "keep");
              }
              // An import never clears a place: one the prototype no longer names stays (A7
              // 3.15.6), and the base stays the place it last settled.
              if (own.get("place") === "apply" && expectedOf(v, "place") === null) {
                own.set("place", "keep");
              }
              for (const [f, verdict] of own) {
                verdicts.set(`${id}|${f}`, verdict);
                seen[verdict] += 1;
                const e = expectedOf(v, f);
                if (verdict === "apply" || (verdict === "settle" && e !== cell(id, f).base)) {
                  writes = true;
                }
              }
              // Sources: the prototype's that the task does not link and no import named before.
              const now = linked(world, task);
              const known = named.get(id) ?? new Set();
              const after = new Set(now);
              for (const n of v.sources) {
                if (now.has(n)) continue;
                if (known.has(n)) {
                  met.sourceTakenOff += 1;
                  if (!(newest.get(id)?.has(n) ?? false)) met.sourceDroppedBetween += 1;
                } else {
                  after.add(n);
                  writes = true;
                }
              }
              links.set(id, after);
            }
            const seq = world.seq();
            const result = await reimport();
            expect(result.status, "an import writes when a field applies or settles anew").toBe(
              writes ? "applied" : "unchanged",
            );
            if (!writes) expect(world.seq()).toBe(seq);
            for (const id of IDS) {
              const task = ids.get(id) ?? "";
              const row = result.tasks.find((t) => t.legacy_id === id);
              const conflicts = FIELDS.filter((f) => verdicts.get(`${id}|${f}`) === "conflict");
              expect(
                (row?.conflicts ?? []).filter((f) => FIELDS.includes(f as Field)).sort(),
                `${id} conflicts`,
              ).toEqual(conflicts.sort());
              for (const f of FIELDS) {
                const c = cell(id, f);
                const v = verdicts.get(`${id}|${f}`);
                const e = expectedOf(proto.get(id) as Values, f);
                const now = spaceValue(world, task, f);
                const was = before.get(`${id}|${f}`);
                // What the person changed since the last import is never overwritten.
                if (c.dirty) expect(now, `${id}.${f} is the person's`).toEqual(was);
                // Exactly the changed field applies; every other keeps the space's value.
                expect(now, `${id}.${f} (${String(v)})`).toEqual(v === "apply" ? e : was);
                if (writes && (v === "apply" || v === "settle")) {
                  c.base = e;
                  c.dirty = false;
                }
              }
              expect([...linked(world, task)].sort(), `${id} sources`).toEqual(
                [...(links.get(id) ?? [])].sort(),
              );
              if (writes) {
                for (const n of proto.get(id)?.sources ?? []) named.get(id)?.add(n);
                newest.set(id, new Set(proto.get(id)?.sources ?? []));
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
      { numRuns: 40, seed: 0x0705 },
    );
    // Every row of the table came up: a field that applies, one that settles where both sides
    // agree, one the space changed alone, and one both changed. So did a lifecycle change that
    // met the person's outcome, a source the person took off that the prototype names again, also
    // after an import that left it out, and an undo.
    for (const [verdict, count] of Object.entries({ ...seen, ...met })) {
      expect(count, verdict).toBeGreaterThan(0);
    }
  }, 600_000);
});
