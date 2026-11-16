// The search index tables (A1 3.12; A7 3.10 M3.05 Verify: "Search rows equal a fresh rebuild").
// The fixture space is created with schema 0.4, so every commit maintains the index. Tombstones (M3.04), redaction (M3.14),
// learnings and area renames have no operation yet: they are played directly on the database
// (search-helpers.ts), with the change rows their operations will write passed to the index as the
// writer passes them. Fixture text only.
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, type Id } from "../src/ids.ts";
import {
  expectedDocuments,
  indexChanges,
  rebuildSearchIndex,
  storedDocuments,
  type SearchDocument,
} from "../src/search/documents.ts";
import { decodeRowsByIds, ROWS_BY_IDS_SQL } from "../src/search/rows.ts";
import { hasSearchTables } from "../src/search/tables.ts";
import type { Operation, WriteResult } from "../src/write/request.ts";
import {
  addLearning,
  directly,
  lastSeq,
  redactTask,
  redactText,
  restore,
  tombstone,
} from "./search-helpers.ts";
import { openSpaceAt, STEPS_0_3 } from "./revisions.ts";
import { checkedDriver, tempFolders } from "./space-helpers.ts";
import { writeFixture, type Fixture } from "./write-helpers.ts";

const temp = tempFolders("search-index");
let fx: Fixture;
let plain: Fixture;

beforeAll(async () => {
  fx = await writeFixture(temp.make());
  plain = await writeFixture(temp.make(), { steps: STEPS_0_3 });
}, 60_000);

afterAll(() => {
  fx.close();
  plain.close();
  temp.cleanup();
});

const WORDS = ["zone", "export", "clinic", "report", "café", "lisbon", "naïve", "DST", "time"];

function submit(f: Fixture, ops: Operation[], who = f.human): WriteResult {
  return f.writer.submit(f.request(who, ops, { base: f.base() }));
}

function created(result: WriteResult): Id<"t"> {
  const id = result.results[0]?.id;
  if (typeof id !== "string") throw new Error(`no task: ${JSON.stringify(result.error)}`);
  return id as Id<"t">;
}

/** The documents without their numbers and seqs, as a rebuild would compare them. */
const plainDocs = (docs: Iterable<SearchDocument>): SearchDocument[] =>
  [...docs]
    .map(({ kind, entityId, taskId, lifecycle, audience, title, body, extra }) => ({
      kind,
      entityId,
      taskId,
      lifecycle,
      audience,
      title,
      body,
      extra,
    }))
    .sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0));

/** The index equals a fresh rebuild of the current state, and holds no stray text. */
function expectRebuildEqual(f: Fixture): void {
  const { docs, stray } = storedDocuments(f.reader);
  expect(stray).toBe(0);
  expect(plainDocs(docs.values())).toEqual(plainDocs(expectedDocuments(f.reader).values()));
}
describe("[A1.5.search.index] the search tables are written in the commit", () => {
  test("each document holds A1 3.12's fields", () => {
    const task = created(
      submit(fx, [
        {
          kind: "task.create",
          title: "Fix appointment time zones",
          summary: "Store UTC and the zone ID",
          context: "Times are stored without a zone.",
          project: "portal",
        },
      ]),
    );
    submit(fx, [
      {
        kind: "source.add",
        task,
        source: {
          kind: "ticket",
          title: "Times shift by an hour",
          who: "Lumen support",
          key: "jira:LUM-212",
        },
      },
      { kind: "note.add", task, body: "Check the mobile app too." },
    ]);
    submit(fx, [{ kind: "log.add", task, body: "Reproduced on staging." }], fx.codex);
    submit(fx, [{ kind: "task.complete", task, outcome: "Converted once from UTC." }]);
    const { docs } = storedDocuments(fx.reader);
    const ref = fx.reader.prepare("SELECT ref FROM tasks WHERE id = $id").get({ id: task })?.[
      "ref"
    ];
    expect(docs.get(task)).toMatchObject({
      kind: "task",
      taskId: task,
      lifecycle: "completed",
      audience: "all",
      title: "Fix appointment time zones",
      body: "Store UTC and the zone ID\nTimes are stored without a zone.\nConverted once from UTC.",
      extra: `Times shift by an hour\nLumen support\nPortal\nLumen\nM-${String(ref)}`,
    });
    const children = [...docs.values()].filter((d) => d.taskId === task && d.kind !== "task");
    expect(children.map((d) => [d.kind, d.title, d.body, d.extra, d.lifecycle]).sort()).toEqual([
      ["log", "Fix appointment time zones", "Reproduced on staging.", "Codex · work", "completed"],
      ["note", "Fix appointment time zones", "Check the mobile app too.", "user", "completed"],
    ]);
    expect(docs.get(fx.areas.lumen)).toMatchObject({
      kind: "area",
      taskId: null,
      lifecycle: null,
      title: "Lumen",
      extra: "lumen",
    });
    expectRebuildEqual(fx);
  });

  test("a commit that changes no indexed text leaves its documents and their seqs alone", () => {
    const task = created(submit(fx, [{ kind: "task.create", title: "Plan the report" }]));
    const before = storedDocuments(fx.reader).docs.get(task);
    const seqOf = () =>
      fx.reader.prepare("SELECT seq FROM search_docs WHERE entity_id = $id").get({ id: task })?.[
        "seq"
      ];
    const seq = seqOf();
    expect(
      submit(fx, [{ kind: "task.patch", task, set: { priority: 1, status: "waiting" } }]).status,
    ).toBe("applied");
    expect(seqOf()).toBe(seq);
    expect(storedDocuments(fx.reader).docs.get(task)).toEqual(before);
    submit(fx, [{ kind: "task.patch", task, set: { title: "Plan the clinic report" } }]);
    expect(seqOf()).toBe(lastSeq(fx.reader));
    expectRebuildEqual(fx);
  });

  test("a tombstone removes a task's documents and its children's, and a restore brings them back", async () => {
    const task = created(submit(fx, [{ kind: "task.create", title: "Tombstone sentinel task" }]));
    submit(fx, [{ kind: "note.add", task, body: "A note under it." }]);
    const count = () =>
      fx.reader.prepare("SELECT count(*) AS n FROM search_docs WHERE task_id = $id").get({
        id: task,
      })?.["n"];
    expect(count()).toBe(2);
    const human = fx.human.principal_id;
    await directly(fx, (conn) => {
      tombstone(conn, task, human);
    });
    expect(count()).toBe(0);
    expectRebuildEqual(fx);
    await directly(fx, (conn) => {
      restore(conn, task);
    });
    expect(count()).toBe(2);
    expectRebuildEqual(fx);
  });

  test("an undo and a redo write the documents their inversions reach, a create's tombstone and restore included", () => {
    // The human's writes join the undo stack, as the service sends them (A1 3.10.1).
    const write = (ops: Operation[]): WriteResult =>
      fx.writer.submit(fx.request(fx.human, ops, { base: fx.base(), undoable: true }));
    const history = (kind: "undo" | "redo"): WriteResult =>
      fx.writer.submit(fx.request(fx.human, [{ kind }]));
    const id = newId("t");
    const task = created(
      write([
        { kind: "task.create", id, title: "Undo sentinel task" },
        { kind: "note.add", task: id, body: "A note to take back." },
        { kind: "log.add", task: id, body: "Logged with it." },
        {
          kind: "source.add",
          task: id,
          source: { kind: "ticket", title: "Undo sentinel ticket", key: "jira:UNDO-1" },
        },
      ]),
    );
    expect(write([{ kind: "task.patch", task, set: { summary: "Set and set back" } }]).status).toBe(
      "applied",
    );
    expect(write([{ kind: "task.complete", task }]).status).toBe("applied");
    const docs = () => storedDocuments(fx.reader).docs;
    const count = (): unknown =>
      fx.reader.prepare("SELECT count(*) AS n FROM search_docs WHERE task_id = $id").get({
        id: task,
      })?.["n"];
    expect(docs().get(task)).toMatchObject({
      lifecycle: "completed",
      body: expect.stringContaining("Set and set back") as unknown,
    });
    // The check-off, the summary, then the create: each undo rewrites what it reaches.
    expect(history("undo").status).toBe("applied");
    expect(docs().get(task)?.lifecycle).toBe("active");
    expectRebuildEqual(fx);
    expect(history("undo").status).toBe("applied");
    expect(docs().get(task)?.body).not.toContain("Set and set back");
    expectRebuildEqual(fx);
    expect(history("undo").status).toBe("applied");
    expect(count()).toBe(0);
    expectRebuildEqual(fx);
    // Redone, the task, its note and its log entry are found again, then its summary and lifecycle.
    for (let n = 0; n < 3; n += 1) {
      expect(history("redo").status).toBe("applied");
      expectRebuildEqual(fx);
    }
    expect(count()).toBe(3);
    expect(docs().get(task)).toMatchObject({
      lifecycle: "completed",
      extra: expect.stringContaining("Undo sentinel ticket") as unknown,
    });
  });

  test("a move reaches the task's learnings, which show its project", async () => {
    const task = created(
      submit(fx, [{ kind: "task.create", title: "Move with a learning", project: "portal" }]),
    );
    const human = fx.human.principal_id;
    const learning = await directly(fx, (conn) => addLearning(conn, task, "Moved once.", human));
    expect(storedDocuments(fx.reader).docs.get(learning)?.extra).toBe("Portal");
    expect(submit(fx, [{ kind: "task.move", task, area: "lumen" }]).status).toBe("applied");
    expect(storedDocuments(fx.reader).docs.get(learning)?.extra).toBe("");
    expectRebuildEqual(fx);
  });

  test("a new source, label, area or project reads no other task: its links bring their own changes", async () => {
    const task = created(submit(fx, [{ kind: "task.create", title: "Fan-out probe" }]));
    const read: string[] = [];
    await directly(fx, (conn) => {
      // The connection, recording each statement it prepares.
      const spy = new Proxy(conn, {
        get(target, prop) {
          if (prop === "prepare") {
            return (sql: string) => {
              read.push(sql);
              return target.prepare(sql);
            };
          }
          const value: unknown = Reflect.get(target, prop);
          return typeof value === "function" ? (value as () => unknown).bind(target) : value;
        },
      });
      const create = (entity: string, entityId: string, taskId: string | null) => ({
        entity,
        entityId,
        taskId,
        action: "create" as const,
        field: null,
      });
      indexChanges(spy, lastSeq(conn), [
        create("sources", "s_00000000000000000000000000", task),
        create("labels", "lb_00000000000000000000000000", null),
        create("areas", "a_00000000000000000000000000", null),
        create("projects", "p_00000000000000000000000000", null),
      ]);
    });
    expect(
      read.filter((sql) => /source_id = |label_id = |area_id = |project_id = /.test(sql)),
    ).toEqual([]);
    expectRebuildEqual(fx);
  });

  test("a 0.3 space keeps no index, and its build writes it as before", () => {
    expect(hasSearchTables(plain.reader)).toBe(false);
    expect(submit(plain, [{ kind: "task.create", title: "No index here" }]).status).toBe("applied");
  });

  test("rebuildSearchIndex refuses a space without the search tables", async () => {
    plain.writer.close();
    const { conn } = openSpaceAt(
      await checkedDriver(),
      plain.folder,
      { role: "writer" },
      STEPS_0_3,
    );
    try {
      expect(() => conn.transaction("immediate", () => rebuildSearchIndex(conn))).toThrow(
        /no search tables/,
      );
    } finally {
      conn.close();
      plain.reopen();
    }
  });

  test("random writes, tombstones, restores and redactions keep the index equal to a rebuild", async () => {
    const tasks: Id<"t">[] = [];
    const word = fc.constantFrom(...WORDS);
    const text = fc.array(word, { minLength: 1, maxLength: 4 }).map((w) => w.join(" "));
    const pick = fc.nat({ max: 1_000 });
    const step = fc.oneof(
      fc.record({
        k: fc.constant("create" as const),
        title: text,
        summary: text,
        project: fc.boolean(),
      }),
      fc.record({ k: fc.constant("title" as const), t: pick, title: text }),
      fc.record({ k: fc.constant("context" as const), t: pick, text }),
      fc.record({
        k: fc.constant("priority" as const),
        t: pick,
        p: fc.integer({ min: 1, max: 4 }),
      }),
      fc.record({ k: fc.constant("note" as const), t: pick, body: text }),
      fc.record({ k: fc.constant("log" as const), t: pick, body: text }),
      fc.record({
        k: fc.constant("source" as const),
        t: pick,
        title: text,
        key: fc.nat({ max: 5 }),
      }),
      fc.record({
        k: fc.constant("move" as const),
        t: pick,
        area: fc.constantFrom("lumen", "home", null),
      }),
      fc.record({ k: fc.constant("complete" as const), t: pick, outcome: text }),
      fc.record({ k: fc.constant("reopen" as const), t: pick }),
      fc.record({ k: fc.constant("tombstone" as const), t: pick }),
      fc.record({ k: fc.constant("restore" as const), t: pick }),
      fc.record({ k: fc.constant("redact" as const), t: pick }),
      fc.record({ k: fc.constant("redactText" as const), word }),
      fc.record({ k: fc.constant("learning" as const), t: pick, body: text }),
      fc.record({ k: fc.constant("area" as const), title: text }),
    );
    const human = fx.human.principal_id;
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 12 }), async (steps) => {
        for (const s of steps) {
          const task = tasks.length === 0 ? undefined : tasks[("t" in s ? s.t : 0) % tasks.length];
          if (s.k === "create") {
            tasks.push(
              created(
                submit(fx, [
                  {
                    kind: "task.create",
                    title: s.title,
                    summary: s.summary,
                    ...(s.project ? { project: "portal" } : {}),
                  },
                ]),
              ),
            );
            continue;
          }
          if (task === undefined) continue;
          switch (s.k) {
            case "title":
              submit(fx, [{ kind: "task.patch", task, set: { title: s.title } }]);
              break;
            case "context":
              submit(fx, [{ kind: "task.context_append", task, text: s.text }]);
              break;
            case "priority":
              submit(fx, [{ kind: "task.patch", task, set: { priority: s.p } }]);
              break;
            case "note":
              submit(fx, [{ kind: "note.add", task, body: s.body }]);
              break;
            case "log":
              submit(fx, [{ kind: "log.add", task, body: s.body }], fx.claude);
              break;
            case "source":
              submit(fx, [
                {
                  kind: "source.add",
                  task,
                  source: { kind: "ticket", title: s.title, key: `jira:FX-${String(s.key)}` },
                },
              ]);
              break;
            case "move":
              submit(fx, [{ kind: "task.move", task, area: s.area }]);
              break;
            case "complete":
              submit(fx, [{ kind: "task.complete", task, outcome: s.outcome }]);
              break;
            case "reopen":
              submit(fx, [{ kind: "task.reopen", task }]);
              break;
            case "tombstone":
              await directly(fx, (conn) => {
                tombstone(conn, task, human);
              });
              break;
            case "restore":
              await directly(fx, (conn) => {
                restore(conn, task);
              });
              break;
            case "redact":
              await directly(fx, (conn) => {
                redactTask(conn, task);
              });
              tasks.splice(tasks.indexOf(task), 1);
              break;
            case "redactText":
              await directly(fx, (conn) => {
                redactText(conn, s.word);
              });
              break;
            case "learning":
              await directly(fx, (conn) => addLearning(conn, task, s.body, human));
              break;
            case "area":
              await directly(fx, (conn) => {
                conn
                  .prepare("UPDATE areas SET title = $title WHERE id = $id")
                  .run({ title: s.title, id: fx.areas.home });
                indexChanges(conn, lastSeq(conn), [
                  {
                    entity: "areas",
                    entityId: fx.areas.home,
                    taskId: null,
                    action: "set",
                    field: "title",
                  },
                ]);
              });
              break;
          }
        }
        expectRebuildEqual(fx);
      }),
      { numRuns: 20 },
    );
    // The FTS table's own check, and a rebuild that changes nothing a reader compares.
    const before = plainDocs(storedDocuments(fx.reader).docs.values());
    await directly(fx, (conn) => {
      conn.exec("INSERT INTO search_fts(search_fts) VALUES ('integrity-check')");
      rebuildSearchIndex(conn);
    });
    expect(plainDocs(storedDocuments(fx.reader).docs.values())).toEqual(before);
  }, 240_000);
});

describe("[A1.5.search.rows-by-ids] pages by frozen IDs", () => {
  test("one entry per ID, in order: current rows, tombstones and redacted IDs as placeholders", async () => {
    const ids = ["Keep", "Tombstone", "Redact"].map((title) =>
      created(submit(fx, [{ kind: "task.create", title: `${title} sentinel` }])),
    );
    const [keep, gone, redacted] = ids as [Id<"t">, Id<"t">, Id<"t">];
    const human = fx.human.principal_id;
    const learning = await directly(fx, (conn) => addLearning(conn, keep, "Learned it.", human));
    const goneLearning = await directly(fx, (conn) => addLearning(conn, gone, "Gone too.", human));
    await directly(fx, (conn) => {
      tombstone(conn, gone, human);
      redactTask(conn, redacted);
    });
    const wanted = [redacted, keep, gone, keep];
    const rows = fx.reader.prepare(ROWS_BY_IDS_SQL.tasks).all({ ids: JSON.stringify(wanted) });
    const entries = decodeRowsByIds("tasks", wanted, rows);
    expect(entries.map((e) => [e.id, e.state])).toEqual([
      [redacted, "redacted"],
      [keep, "current"],
      [gone, "deleted"],
      [keep, "current"],
    ]);
    // A placeholder carries no content: a reference at most.
    expect(JSON.stringify(entries.filter((e) => e.state !== "current"))).not.toMatch(/sentinel/);
    const current = entries[1];
    expect(current?.state === "current" ? current.row["title"] : undefined).toBe("Keep sentinel");

    const lids = [learning, goneLearning, "lr_0000000000000000000000000a"];
    const learned = decodeRowsByIds(
      "learnings",
      lids,
      fx.reader.prepare(ROWS_BY_IDS_SQL.learnings).all({ ids: JSON.stringify(lids) }),
    );
    expect(learned.map((e) => e.state)).toEqual(["current", "deleted", "redacted"]);
    expect(() => decodeRowsByIds("tasks", wanted, rows.slice(1))).toThrow(/lost an entry/);
  });
});
