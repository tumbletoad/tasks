// Search against a real space (A3 3.9; A7 3.10 M3.05 Verify): random query strings never raise an
// SQLite error, the ranking and filters of A3 3.9.2–3.9.4, and cursor pages under random writes,
// deletions and redactions with no gaps or duplicates and no old text. The fixture space is created
// with schema 0.4, which holds the index, and a 0.3 space stands for one without it; tombstones,
// redaction and authority changes are played directly on the database (storage's
// search-helpers.ts), since their operations arrive in later steps. In-thread, through a reader
// connection shaped like the service's. Fixture text only.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppError, SEARCH_IDS, SEARCH_SCOPES, TaskSearchResult } from "@ttasks/contracts";
import {
  indexChanges,
  rebuildSearchIndex,
  type Operation,
  type WriteResult,
} from "@ttasks/storage";
import {
  addLearning,
  changeAuthority,
  directly,
  lastSeq,
  redactTask,
  redactText,
  tombstone,
} from "@ttasks/storage/search-helpers";
import { STEPS_0_3 } from "@ttasks/storage/revisions";
import { MACHINE, writeFixture, type Fixture } from "@ttasks/storage/write-helpers";
import type { Caller } from "../src/ops/caller.ts";
import { opCall, type OpsHost } from "../src/ops/index.ts";
import { SearchCursors, CURSOR_LIMITS } from "../src/search/cursors.ts";
import {
  runSearch,
  type SearchEnv,
  type SearchReader,
  type SearchResult,
} from "../src/search/search.ts";
import { SEPARATOR_RANGES } from "../src/search/query.ts";
import { queryText } from "./search-queries.ts";
import { readerOf, tempRoot } from "./harness.ts";

let temp: { root: string; cleanup: () => void };
let fx: Fixture;
let plain: Fixture;
let clock = Date.UTC(2026, 10, 12, 9, 0, 0);
const cursors = new SearchCursors(() => clock);

beforeAll(async () => {
  temp = tempRoot("search");
  const indexed = join(temp.root, "indexed");
  const unindexed = join(temp.root, "plain");
  mkdirSync(indexed);
  mkdirSync(unindexed);
  fx = await writeFixture(indexed);
  plain = await writeFixture(unindexed, { steps: STEPS_0_3 });
});

afterAll(() => {
  fx.close();
  plain.close();
  temp.cleanup();
});

function envOf(f: Fixture, extra: Partial<SearchEnv> = {}): SearchEnv {
  return {
    cursors,
    owner: "user-cli:test",
    space: f.spaceId,
    audience: "user",
    today: "2026-11-12",
    now: clock,
    timeZone: "Europe/Lisbon",
    machine: MACHINE.id,
    live: () => [],
    here: () => Promise.resolve({ tasks: [], projects: [] }),
    ...extra,
  };
}

const search = (input: Parameters<typeof runSearch>[1], extra: Partial<SearchEnv> = {}, f = fx) =>
  runSearch(readerOf(f.reader), input, envOf(f, extra));

function submit(f: Fixture, ops: Operation[], who = f.human): WriteResult {
  return f.writer.submit(f.request(who, ops, { base: f.base() }));
}

/** The IDs of the tasks a request created, in order. */
function created(result: WriteResult): string[] {
  if (result.status !== "applied") throw new Error(JSON.stringify(result.error));
  return result.results.flatMap((r) =>
    r.status === "created" && r.id.startsWith("t_") ? [r.id] : [],
  );
}

const refOf = (f: Fixture, id: string): string =>
  `M-${String(f.reader.prepare("SELECT ref FROM tasks WHERE id = $id").get({ id })?.["ref"])}`;

async function refusal(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

const ids = (result: SearchResult): string[] => result.rows.map((row) => String(row["id"]));

describe("[A3.5.search.query] random query strings never raise an SQLite error", () => {
  beforeAll(() => {
    const [a, b] = created(
      submit(fx, [
        {
          kind: "task.create",
          title: "Fix appointment time zones",
          summary: "Convert once from UTC",
          context: "Times are stored without zone and converted twice.",
          project: "portal",
          priority: 1,
          due: { date: "2026-11-13" },
        },
        { kind: "task.create", title: "Clinic report export", status: "waiting", area: "home" },
      ]),
    );
    if (a === undefined || b === undefined) throw new Error("fixture tasks missing");
    submit(fx, [
      { kind: "note.add", task: a, body: "Check the café booking flow." },
      { kind: "log.add", task: b, body: "Is the export naïve about DST?", log_kind: "question" },
      {
        kind: "source.add",
        task: a,
        source: { kind: "ticket", title: "Times shift", key: "jira:FX-1" },
      },
    ]);
    submit(fx, [{ kind: "task.complete", task: b, outcome: "" }]);
  });

  test("every query gives rows that match the contract, or invalid_input", async () => {
    let answered = 0;
    let withRows = 0;
    await fc.assert(
      fc.asyncProperty(
        queryText,
        fc.constantFrom(undefined, ...SEARCH_SCOPES),
        fc.constantFrom("user" as const, "agent" as const),
        fc.boolean(),
        async (q, scope, audience, cwd) => {
          try {
            const result = await search(
              {
                q,
                ...(scope === undefined ? {} : { scope }),
                limit: 5,
                ...(cwd ? { cwd: "/" } : {}),
              },
              { audience },
            );
            const checked = TaskSearchResult.safeParse(result);
            expect(checked.success, JSON.stringify(checked.error?.issues)).toBe(true);
            answered += 1;
            if (result.rows.length > 0) withRows += 1;
          } catch (error) {
            expect(error).toBeInstanceOf(AppError);
            expect((error as AppError).code, (error as Error).message).toBe("invalid_input");
          }
        },
      ),
      { numRuns: 600 },
    );
    // Not a property about refusals only: many queries ran, and some found rows.
    expect(answered).toBeGreaterThan(100);
    expect(withRows).toBeGreaterThan(10);
  }, 120_000);

  test("a 0.3 space answers filters, and refuses words with not_indexed and the space's schema", async () => {
    created(
      submit(plain, [{ kind: "task.create", title: "Plain waiting task", status: "waiting" }]),
    );
    const found = await search({ q: "status:waiting" }, {}, plain);
    expect(found.rows.map((r) => r["title"])).toEqual(["Plain waiting task"]);
    for (const q of ["plain", "-plain", "status:waiting plain"]) {
      const error = await refusal(search({ q }, {}, plain));
      expect(error.code).toBe("space_unavailable");
      expect(error.message).toBe(
        "This space is at schema 0.3, from before word search, so words cannot be searched yet.",
      );
      expect(error.data).toMatchObject({ reason: "not_indexed", retryable: false });
    }
  });

  test("every character the parser leaves out is one the index's tokenizer drops", async () => {
    const text = SEPARATOR_RANGES.flatMap(([a, b]) =>
      Array.from({ length: b - a + 1 }, (_, i) => String.fromCodePoint(a + i)),
    ).join("");
    const tokens = await directly(fx, (conn) => {
      conn.exec(
        "CREATE VIRTUAL TABLE tok_probe USING fts5(x, tokenize = 'unicode61 remove_diacritics 2')",
      );
      conn.exec("CREATE VIRTUAL TABLE tok_probe_v USING fts5vocab(tok_probe, 'instance')");
      conn.prepare("INSERT INTO tok_probe (x) VALUES ($x)").run({ x: text });
      const n = Number(conn.prepare("SELECT count(*) AS n FROM tok_probe_v").get()?.["n"]);
      conn.exec("DROP TABLE tok_probe_v");
      conn.exec("DROP TABLE tok_probe");
      return n;
    });
    expect(text.length).toBeGreaterThan(250);
    expect(tokens).toBe(0);
  });

  test("a symbol the index keeps is searched as written, negated or not", async () => {
    const [withIt, without] = created(
      submit(fx, [
        { kind: "task.create", title: "Emojiword 🧪" },
        { kind: "task.create", title: "Emojiword plain" },
      ]),
    );
    expect(ids(await search({ q: "emojiword 🧪" }))).toEqual([withIt]);
    expect(ids(await search({ q: "emojiword -🧪" }))).toEqual([without]);
  });
});

describe("[A3.5.search.ranking] ranking, grouping, filters and rows", () => {
  let title: string;
  let note: string;
  let done: string;
  let starred: string;
  let lumen: string;

  beforeAll(async () => {
    [title, note, done, starred, lumen] = created(
      submit(fx, [
        { kind: "task.create", title: "Rankword in the title", summary: "Its summary." },
        { kind: "task.create", title: "Another task", summary: "Plain summary." },
        { kind: "task.create", title: "Rankword finished long ago" },
        { kind: "task.create", title: "Starred rankword", focus: "2026-11-12", priority: 2 },
        { kind: "task.create", title: "Lumen rankword", area: "lumen", priority: 3 },
      ]),
    ) as [string, string, string, string, string];
    submit(fx, [
      { kind: "note.add", task: note, body: "A rankword in a note, and more words around it." },
      { kind: "note.add", task: title, body: "rankword again" },
      { kind: "log.add", task: title, body: "rankword in the log" },
    ]);
    submit(fx, [{ kind: "task.complete", task: done, outcome: "Done with the rankword." }]);
    const human = fx.human.principal_id;
    await directly(fx, (conn) =>
      addLearning(conn, done, "Rankword learnings stay findable.", human),
    );
  });

  test("a task appears once, ranked by its best document with A3 3.9.3's boosts", async () => {
    const found = await search({ q: "rankword", scope: "all", limit: 50 });
    const order = ids(found);
    expect(new Set(order).size).toBe(order.length);
    expect(order).toEqual(expect.arrayContaining([title, note, done, starred, lumen]));
    // A title hit beats a note hit; an active task beats the completed one.
    expect(order.indexOf(title)).toBeLessThan(order.indexOf(note));
    expect(order.indexOf(starred)).toBeLessThan(order.indexOf(done));
    const noteRow = found.rows.find((r) => r["id"] === note);
    expect(noteRow).toMatchObject({ kind: "task", snippet_from: "note" });
    expect(String(noteRow?.["snippet"])).toMatch(/rankword/);
    expect(found.rows.find((r) => r["id"] === done)).toMatchObject({
      lifecycle: "completed",
      completed: "2026-11-12",
    });
    expect(found.parsed).toBe("rankword");
    expect(found.total).toBe(5);
  });

  test("scopes, the default scope and a query that names a lifecycle", async () => {
    expect(ids(await search({ q: "rankword" }))).not.toContain(done);
    expect(ids(await search({ q: "rankword", scope: "finished" }))).toEqual([done]);
    const widened = await search({ q: "rankword is:completed" });
    expect(widened.scope).toBe("all");
    expect(ids(widened)).toEqual([done]);
    const learned = await search({ q: "rankword", scope: "learnings" });
    expect(learned.rows).toEqual([
      expect.objectContaining({
        kind: "learning",
        task: refOf(fx, done),
        text: "Rankword learnings stay findable.",
      }),
    ]);
  });

  test("the last word matches as a prefix of two characters or more, and -word excludes", async () => {
    expect(ids(await search({ q: "rankw" }))).toContain(title);
    expect(ids(await search({ q: "Ra" }))).toContain(title);
    expect(ids(await search({ q: '"rankw"' }))).toEqual([]);
    // The prefix goes to the last token: "R." has the one-letter token r, which gets none, and an
    // enclosing mark ends a token as it does in the index.
    expect(ids(await search({ q: "rankw." }))).toContain(title);
    expect(ids(await search({ q: "rankword R." }))).toEqual([]);
    const enclosing = String.fromCodePoint(0x20dd);
    expect(ids(await search({ q: `rankword the${enclosing}T` }))).toEqual([]);
    // Punctuation alone is no word, so it never empties the AND.
    expect(ids(await search({ q: "rankword & —" }))).toContain(title);
    const without = ids(await search({ q: "rankword -again" }));
    expect(without).not.toContain(title);
    expect(without).toContain(note);
    // A negated word alone works too: the order without text.
    expect(ids(await search({ q: "-rankword", limit: 50 }))).not.toContain(note);
  });

  test("words from different parts of one task find it together; a phrase stays within one text", async () => {
    const [spread = "", other = ""] = created(
      submit(fx, [
        {
          kind: "task.create",
          title: "Spread holder",
          context: "The radarword sits in the context.",
          area: "lumen",
        },
        { kind: "task.create", title: "Radarword only", summary: "Nothing else here." },
      ]),
    );
    submit(fx, [
      { kind: "log.add", task: spread, body: "violetword in the log" },
      { kind: "note.add", task: spread, body: "amberword in a note" },
    ]);
    expect(ids(await search({ q: "radarword violetword" }))).toEqual([spread]);
    expect(ids(await search({ q: "violetword amberword radarword" }))).toEqual([spread]);
    expect(ids(await search({ q: "radarword violetword OR zzznone" }))).toEqual([spread]);
    expect(ids(await search({ q: "radarword viol" }))).toEqual([spread]);
    expect(ids(await search({ q: "radarword" })).sort()).toEqual([spread, other].sort());
    // A phrase is one text's words in order: never across a context and a log.
    expect(ids(await search({ q: '"radarword violetword"' }))).toEqual([]);
    expect(ids(await search({ q: '"sits in the context" violetword' }))).toEqual([spread]);
    // Filters and negations hold as they do for one document.
    expect(ids(await search({ q: "radarword violetword area:lumen" }))).toEqual([spread]);
    expect(ids(await search({ q: "radarword violetword -area:lumen" }))).toEqual([]);
    expect(ids(await search({ q: "radarword violetword -amberword" }))).toEqual([]);
    // The row's snippet comes from a document that holds one of the words.
    const row = (await search({ q: "radarword amberword" })).rows[0];
    expect(String(row?.["snippet"])).toMatch(/radarword|amberword/);
    // A retracted note no longer lends its words.
    submit(fx, [{ kind: "note.delete", task: spread, ordinal: 1 }]);
    expect(ids(await search({ q: "radarword amberword" }))).toEqual([]);
    expect(ids(await search({ q: "radarword violetword" }))).toEqual([spread]);
  });

  test("a source's key and the readable parts of its link find its task", async () => {
    const [task = ""] = created(submit(fx, [{ kind: "task.create", title: "Linked holder" }]));
    submit(fx, [
      {
        kind: "source.add",
        task,
        source: {
          kind: "ticket",
          title: "Ticket",
          url: "https://www.tracker.example/harborword/item%20seven?utm_source=mailword",
          key: "issue:sample-42",
        },
      },
    ]);
    expect(ids(await search({ q: "harborword" }))).toEqual([task]);
    expect(ids(await search({ q: "sample-42" }))).toEqual([task]);
    expect(ids(await search({ q: "issue:sample-42" }))).toEqual([task]);
    expect(ids(await search({ q: "tracker seven" }))).toEqual([task]);
    expect(ids(await search({ q: "linked sample" }))).toEqual([task]);
    // What a person does not read as the link's words: its scheme, www and query.
    expect(ids(await search({ q: '"https"' }))).not.toContain(task);
    expect(ids(await search({ q: '"www"' }))).not.toContain(task);
    expect(ids(await search({ q: "mailword" }))).toEqual([]);
    expect(ids(await search({ q: "source:issue:sample-42" }))).toEqual([task]);
  });

  test("a link's words are its address and path, whatever its form", async () => {
    const links = [
      "mailto:deskword@example.test?subject=marigoldsubject#tulipfrag",
      "example.test/gardenword?sort=orchidsort#lilyfrag",
      "https://keeperword:hunterpass@bücherhalle.example:8471/Eintrag?x=asterquery#teilfrag",
    ];
    const tasks = created(
      submit(
        fx,
        links.map((_, i) => ({ kind: "task.create", title: `Link form ${String(i)}` })),
      ),
    );
    const added = submit(
      fx,
      links.map((url, i) => ({
        kind: "source.add",
        task: tasks[i] ?? "",
        source: { kind: "web", title: "Page", url },
      })),
    );
    expect(added.status).toBe("applied");
    const [mail, bare, web] = tasks;
    expect(ids(await search({ q: "deskword" }))).toEqual([mail]);
    expect(ids(await search({ q: "gardenword" }))).toEqual([bare]);
    // The host as a person typed it, not its punycode, and its explicit port.
    expect(ids(await search({ q: "bücherhalle eintrag" }))).toEqual([web]);
    expect(ids(await search({ q: "8471" }))).toEqual([web]);
    for (const hidden of [
      "marigoldsubject",
      "tulipfrag",
      "orchidsort",
      "lilyfrag",
      "keeperword",
      "hunterpass",
      "asterquery",
      "teilfrag",
    ]) {
      expect(ids(await search({ q: hidden })), hidden).toEqual([]);
    }
  });

  test("filters: an area includes its projects, priority, focus, ids and has:", async () => {
    expect(ids(await search({ q: "rankword area:Lumen" }))).toEqual([lumen]);
    expect(ids(await search({ q: "rankword p<=2" }))).toEqual([starred]);
    expect(ids(await search({ q: "rankword is:focus" }))).toEqual([starred]);
    expect(ids(await search({ q: `id:${refOf(fx, note)}` }))).toEqual([note]);
    expect(ids(await search({ q: "id:ZZ-1" }))).toEqual([]);
    expect(ids(await search({ q: "rankword has:notes" }))).toEqual([title, note]);
    expect(ids(await search({ q: "rankword -has:notes" })).sort()).toEqual([lumen, starred].sort());
    const unknown = await refusal(search({ q: "status:opn" }));
    expect(unknown.data["suggestions"]).toEqual(["open"]);
  });

  test("filter names resolve in the query's own snapshot, so a rename between the reads never mixes two", async () => {
    const [moved = ""] = created(
      submit(fx, [{ kind: "task.create", title: "Vocabword task", area: "lumen" }]),
    );
    const rename = async (title: string, slug: string) =>
      directly(fx, (conn) => {
        conn
          .prepare("UPDATE areas SET title = $title, slug = $slug WHERE id = $id")
          .run({ title, slug, id: fx.areas.home });
        indexChanges(conn, lastSeq(conn), [
          { entity: "areas", entityId: fx.areas.home, taskId: null, action: "set", field: "title" },
        ]);
      });
    // Between the search's reads, the area named home is renamed and the task moves into it: it
    // never was in an area named home.
    const inner = readerOf(fx.reader);
    let calls = 0;
    const racing: SearchReader = {
      transaction: async (mode, queries) => {
        calls += 1;
        if (calls === 2) {
          await rename("Elsewhere", "elsewhere");
          submit(fx, [{ kind: "task.move", task: moved, area: "elsewhere" }]);
        }
        return inner.transaction(mode, queries);
      },
    };
    try {
      const outcome = await runSearch(racing, { q: "vocabword area:home" }, envOf(fx)).then(
        (result) => ids(result),
        (error: unknown) => (error instanceof AppError ? error.code : error),
      );
      expect(outcome === "invalid_input" || (Array.isArray(outcome) && outcome.length === 0)).toBe(
        true,
      );
    } finally {
      await rename("Home", "home");
    }
    // Values that change at every read never settle: a retryable refusal, never a mixed answer.
    let reads = 0;
    const restless: SearchReader = {
      transaction: async (mode, queries) => {
        const results = await inner.transaction(mode, queries);
        reads += 1;
        const areas = results[3];
        if (Array.isArray(areas)) areas.push({ id: `a_${String(reads)}`, slug: "x", title: "X" });
        return results;
      },
    };
    const busy = await refusal(runSearch(restless, { q: "vocabword" }, envOf(fx)));
    expect(busy.code).toBe("space_unavailable");
    expect(busy.data).toMatchObject({ reason: "busy", retryable: true });
  });

  test("on:cwd reads the folders in the query's own snapshot too", async () => {
    const [task = ""] = created(submit(fx, [{ kind: "task.create", title: "Oldcwdword" }]));
    submit(fx, [{ kind: "task.folder_set", task, path: "/fixture/here" }]);
    const ownHere = () =>
      fx.reader
        .prepare(
          "SELECT owner_id FROM folders WHERE owner_kind = 'task' AND path = '/fixture/here' " +
            "AND deleted_at IS NULL",
        )
        .all()
        .map((row) => String(row["owner_id"]));
    let calls = 0;
    // The tasks whose folder is here are read; then, before the query, one commit renames the
    // task and moves its folder: no state had it both here and named newcwdword.
    const here = () => {
      calls += 1;
      const tasks = ownHere();
      if (calls === 1) {
        submit(fx, [
          { kind: "task.patch", task, set: { title: "Newcwdword" } },
          { kind: "task.folder_set", task, path: "/fixture/elsewhere" },
        ]);
      }
      return Promise.resolve({ tasks, projects: [] });
    };
    const found = await search({ q: "newcwdword on:cwd", cwd: "/" }, { here });
    expect(ids(found)).toEqual([]);
    expect(calls).toBe(2);
  });

  test("without text: due date (none last), then priority, then the latest change", async () => {
    const [late, soon, none] = created(
      submit(fx, [
        { kind: "task.create", title: "Ordered late", due: { date: "2026-12-01" }, priority: 1 },
        { kind: "task.create", title: "Ordered soon", due: { date: "2026-11-20" }, priority: 4 },
        { kind: "task.create", title: "Ordered none", priority: 1 },
      ]),
    );
    const order = ids(await search({ q: "status:open", limit: 50 }));
    expect(order.indexOf(soon ?? "")).toBeLessThan(order.indexOf(late ?? ""));
    expect(order.indexOf(late ?? "")).toBeLessThan(order.indexOf(none ?? ""));
    expect((await search({ q: "status:open" })).rows[0]).not.toHaveProperty("snippet_from");
  });

  test("a timed due counts on its day in the time zone: late, today and later agree with the page", async () => {
    const zone = { timeZone: "Europe/Amsterdam" };
    const [late, early, dated, tomorrow] = created(
      submit(fx, [
        // 23:30 yesterday in Amsterdam.
        {
          kind: "task.create",
          title: "Dueword late",
          due: { at: Date.UTC(2026, 10, 11, 22, 30), tz: "Europe/Amsterdam" },
        },
        // 00:30 today in Amsterdam, still yesterday in UTC.
        {
          kind: "task.create",
          title: "Dueword early",
          due: { at: Date.UTC(2026, 10, 11, 23, 30), tz: "Europe/Amsterdam" },
        },
        { kind: "task.create", title: "Dueword dated", due: { date: "2026-11-12" } },
        // 00:10 tomorrow in Amsterdam, still today in UTC.
        {
          kind: "task.create",
          title: "Dueword tomorrow",
          due: { at: Date.UTC(2026, 10, 12, 23, 10), tz: "Europe/Amsterdam" },
        },
      ]),
    ) as [string, string, string, string];
    const found = async (q: string) => new Set(ids(await search({ q, limit: 50 }, zone)));
    expect(await found("dueword due:today")).toEqual(new Set([early, dated]));
    expect(await found("dueword is:overdue")).toEqual(new Set([late]));
    expect(await found("dueword due:overdue")).toEqual(new Set([late]));
    expect(await found("dueword due<today")).toEqual(new Set([late]));
    expect(await found("dueword due<=today")).toEqual(new Set([late, early, dated]));
    expect(await found("dueword due>today")).toEqual(new Set([tomorrow]));
    expect(await found("dueword due>=today")).toEqual(new Set([early, dated, tomorrow]));
    expect(await found("dueword -due:today")).toEqual(new Set([late, tomorrow]));
  });

  test("sort:effort lists quick work first by the space's scale, sort:-effort big work first, none last", async () => {
    const [large, none, small, medium] = created(
      submit(fx, [
        { kind: "task.create", title: "Sizeword large", effort: "L", priority: 1 },
        { kind: "task.create", title: "Sizeword unsized", priority: 1 },
        { kind: "task.create", title: "Sizeword small", effort: "S" },
        { kind: "task.create", title: "Sizeword medium", effort: "M", due: { date: "2026-11-13" } },
      ]),
    ) as [string, string, string, string];
    // With words, and without: the effort comes before the rank or the due date.
    for (const q of ["sizeword sort:effort", "sort:effort status:open"]) {
      const order = ids(await search({ q, limit: 50 })).filter((id) =>
        [large, none, small, medium].includes(id),
      );
      expect(order, q).toEqual([small, medium, large, none]);
    }
    const big = ids(await search({ q: "sizeword sort:-Effort" }));
    expect(big).toEqual([large, medium, small, none]);
    expect((await search({ q: "sizeword sort:-Effort" })).parsed).toBe("sizeword sort:-Effort");
    // An alias is read as its key.
    expect(ids(await search({ q: "sizeword order:-effort" }))).toEqual(big);
    // An order filters nothing, so it stands alone.
    for (const q of ["sizeword -sort:effort", "sort:effort OR p:1", "sort:effort sort:-effort"]) {
      expect((await refusal(search({ q }))).code, q).toBe("invalid_input");
    }
    expect((await refusal(search({ q: "sort:size" }))).hint).toContain("sort:effort");
  });

  test("an agent never matches or sees an only-me note; the user does", async () => {
    const [hidden] = created(submit(fx, [{ kind: "task.create", title: "Audience test" }]));
    submit(fx, [{ kind: "note.add", task: hidden ?? "", body: "privateword in an only-me note" }]);
    await directly(fx, (conn) => {
      // As the operation that sets a note's audience (D14) will write and index it.
      conn
        .prepare("UPDATE notes SET audience = 'owner' WHERE task_id = $id")
        .run({ id: hidden ?? "" });
      const note = conn
        .prepare("SELECT id FROM notes WHERE task_id = $id")
        .get({ id: hidden ?? "" });
      indexChanges(conn, lastSeq(conn), [
        {
          entity: "notes",
          entityId: String(note?.["id"]),
          taskId: hidden ?? "",
          action: "set",
          field: "audience",
        },
      ]);
    });
    expect(ids(await search({ q: "privateword" }))).toEqual([hidden]);
    expect(ids(await search({ q: "privateword" }, { audience: "agent" }))).toEqual([]);
    // Nor through another document of the task that holds the other word.
    expect(ids(await search({ q: "audience privateword" }))).toEqual([hidden]);
    expect(ids(await search({ q: "audience privateword" }, { audience: "agent" }))).toEqual([]);
    expect(ids(await search({ q: "audience -privateword" }, { audience: "agent" }))).toEqual([
      hidden,
    ]);
    expect(ids(await search({ q: "audience has:notes" }, { audience: "agent" }))).toEqual([]);
  });

  test("of equal best documents the lower entity ID gives the snippet, before and after a rebuild", async () => {
    // Two notes that score the same; the pair whose first note has the higher ID, so neither the
    // order of writing nor the order of a rebuild's document numbers decides.
    let task = "";
    let notes: { id: string; body: string }[] = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      [task = ""] = created(submit(fx, [{ kind: "task.create", title: "Tie holder" }]));
      submit(fx, [
        { kind: "note.add", task, body: "tieword alpha" },
        { kind: "note.add", task, body: "tieword bravo" },
      ]);
      notes = fx.reader
        .prepare("SELECT id, body FROM notes WHERE task_id = $id ORDER BY created_seq, ordinal")
        .all<{ id: string; body: string }>({ id: task });
      if ((notes[0]?.id ?? "") > (notes[1]?.id ?? "")) break;
    }
    const lower = [...notes].sort((a, b) => (a.id < b.id ? -1 : 1))[0]?.body;
    expect(lower).toBe("tieword bravo");
    const snippet = async () =>
      (await search({ q: "tieword", limit: 50 })).rows.find((r) => r["id"] === task)?.["snippet"];
    expect(await snippet()).toBe(lower);
    await directly(fx, (conn) => rebuildSearchIndex(conn));
    expect(await snippet()).toBe(lower);
  });

  test("a snippet comes from the best document at the snapshot, never one that took its number", async () => {
    const [lead] = created(
      submit(fx, [{ kind: "task.create", title: "Reuseword lead", summary: "Lead." }]),
    );
    const [holder = ""] = created(
      submit(fx, [{ kind: "task.create", title: "Reuse holder", summary: "Holder summary." }]),
    );
    // The holder's note is the newest document, so its number is the highest.
    submit(fx, [{ kind: "note.add", task: holder, body: "reuseword first" }]);
    const first = await search({ q: "reuseword", limit: 1 });
    expect(ids(first)).toEqual([lead]);
    await directly(fx, (conn) => {
      // Entity redaction of the note (A1 3.11.4): the row leaves, and so does its document.
      const note = conn.prepare("SELECT id FROM notes WHERE task_id = $id").get({ id: holder });
      conn.prepare("DELETE FROM notes WHERE task_id = $id").run({ id: holder });
      indexChanges(conn, lastSeq(conn), [
        {
          entity: "notes",
          entityId: String(note?.["id"]),
          taskId: holder,
          action: "set",
          field: "deleted",
        },
      ]);
    });
    // A new note of the same task takes the freed number.
    submit(fx, [{ kind: "note.add", task: holder, body: "reuseword second" }]);
    const next = await search({ cursor: first.cursor ?? "" });
    expect(next.rows[0]).toMatchObject({ id: holder, snippet: "Holder summary." });
    expect(next.rows[0]).not.toHaveProperty("snippet_from");
  });

  test("a snippet shows where the task's own text matched, never its title again", async () => {
    const [bare = "", summed = ""] = created(
      submit(fx, [
        { kind: "task.create", title: "Onlytitleword bare" },
        { kind: "task.create", title: "Onlytitleword summed", summary: "Summary words." },
      ]),
    );
    // The note's document holds the task's title too; its body does not match.
    submit(fx, [{ kind: "note.add", task: bare, body: "Unrelated note text." }]);
    const rows = (await search({ q: "onlytitleword", limit: 50 })).rows;
    const row = (id: string) => rows.find((r) => r["id"] === id);
    expect(row(bare)).not.toHaveProperty("snippet");
    expect(row(summed)).toMatchObject({ snippet: "Summary words." });
    expect(row(summed)).not.toHaveProperty("snippet_from");
    // A match in the body shows that part, without any mark of the match.
    submit(fx, [{ kind: "note.add", task: bare, body: "Before bodyhitword after." }]);
    const hit = (await search({ q: "bodyhitword" })).rows.find((r) => r["id"] === bare);
    expect(hit).toMatchObject({ snippet: "Before bodyhitword after.", snippet_from: "note" });
  });

  test("a finished task's row says how it ended in its summary's place; a match in its notes still shows", async () => {
    const [shipped = "", dropped = "", plain = "", noted = "", open = ""] = created(
      submit(fx, [
        { kind: "task.create", title: "Endword shipped", summary: "Shipped summary." },
        { kind: "task.create", title: "Endword dropped", summary: "Dropped summary." },
        { kind: "task.create", title: "Endword plain", summary: "Plain summary." },
        { kind: "task.create", title: "Endword noted", summary: "Noted summary." },
        { kind: "task.create", title: "Endword open", summary: "Open summary." },
      ]),
    );
    submit(fx, [
      { kind: "task.complete", task: shipped, outcome: "## Shipped it.\nWith evidence." },
      { kind: "task.archive", task: dropped, reason: "Not needed after all." },
      { kind: "task.archive", task: plain },
      { kind: "task.complete", task: noted, outcome: "Noted outcome." },
      { kind: "note.add", task: noted, body: "An endnoteword in a note." },
    ]);
    const rows = (await search({ q: "endword", scope: "all", limit: 50 })).rows;
    const row = (id: string) => rows.find((r) => r["id"] === id);
    expect(row(shipped)).toMatchObject({ ending: "Shipped it." });
    expect(row(shipped)).not.toHaveProperty("snippet");
    expect(row(dropped)).toMatchObject({ ending: "Not needed after all." });
    expect(row(dropped)).not.toHaveProperty("snippet");
    expect(row(plain)).toMatchObject({ snippet: "Plain summary." });
    expect(row(plain)).not.toHaveProperty("ending");
    expect(row(open)).toMatchObject({ snippet: "Open summary." });
    expect(row(open)).not.toHaveProperty("ending");
    // The day each finished, completed or dropped, as the Completed view shows it.
    const days = [shipped, dropped, plain].map((id) => row(id)?.["completed"]);
    expect(days).toEqual([expect.any(String), expect.any(String), expect.any(String)]);
    expect(row(open)).not.toHaveProperty("completed");
    const hit = (await search({ q: "endnoteword", scope: "finished" })).rows[0];
    expect(hit).toMatchObject({
      id: noted,
      snippet: "An endnoteword in a note.",
      snippet_from: "note",
      ending: "Noted outcome.",
    });
    for (const each of [...rows, hit]) {
      expect(TaskSearchResult.shape.rows.element.safeParse(each).success).toBe(true);
    }
  });

  test("titles are cut at 90 characters and snippets at 100", async () => {
    const long = `Cutword ${"x".repeat(120)}`;
    const [task] = created(
      submit(fx, [{ kind: "task.create", title: long, summary: `cutword ${"y ".repeat(80)}` }]),
    );
    const row = (await search({ q: "cutword" })).rows.find((r) => r["id"] === task);
    expect(Array.from(String(row?.["title"]))).toHaveLength(90);
    expect(String(row?.["title"]).endsWith("…")).toBe(true);
    expect(Array.from(String(row?.["snippet"])).length).toBeLessThanOrEqual(100);
  });
});

describe("[A3.5.search.find] task.search through the request path", () => {
  /** A host serving the indexed fixture space through the in-thread reader. */
  const host = (): OpsHost => ({
    machine: { id: MACHINE.id },
    spaces: () => [
      {
        id: fx.spaceId,
        name: "Mira",
        state: "open",
        writer: undefined,
        reader: readerOf(fx.reader),
      },
    ],
    now: () => clock,
    timeZone: () => "Europe/Lisbon",
  });
  const user: Caller = { class: "cli-interactive", env: {} };
  const script: Caller = { class: "cli-script", env: {} };
  const call = (h: OpsHost, caller: Caller, input: Record<string, unknown>) =>
    opCall(h, caller, { op: "task.search", input }) as Promise<SearchResult>;

  test("the entry's schema, its default page of 15 and its cursor, for the user and a script", async () => {
    created(
      submit(
        fx,
        Array.from({ length: 20 }, (_, i) => ({
          kind: "task.create" as const,
          title: `findword ${String(i)}`,
        })),
      ),
    );
    const h = host();
    const first = await call(h, user, { q: "findword" });
    expect(TaskSearchResult.parse(first).rows).toHaveLength(15);
    expect(first).toMatchObject({ scope: "active", total: 20, first: 1, parsed: "findword" });
    const second = await call(h, user, { cursor: first.cursor, q: "ignored" });
    expect(second.rows).toHaveLength(5);
    expect(second.first).toBe(16);
    expect(second).not.toHaveProperty("cursor");
    // A script is another binding: the user's cursor is not its own.
    const error = await refusal(call(h, script, { cursor: first.cursor }));
    expect(error.code).toBe("cursor_expired");
    expect(error.data).toEqual({ reason: "binding" });
    expect(
      TaskSearchResult.parse(await call(h, script, { q: "findword", limit: 3 })).rows,
    ).toHaveLength(3);
    // The schema's limits come first: too long a query is too_large.
    expect((await refusal(call(h, user, { q: "x".repeat(501) }))).code).toBe("too_large");
  });

  test("a search that names its time zone counts its days there, else on the service's", async () => {
    const [friday] = created(
      submit(fx, [{ kind: "task.create", title: "Zoneword friday", due: { date: "2026-11-13" } }]),
    );
    // 00:01 on Friday 13 November in Amsterdam: still Thursday on a service that counts in UTC.
    const h: OpsHost = {
      ...host(),
      now: () => Date.UTC(2026, 10, 12, 23, 1),
      timeZone: () => "UTC",
    };
    expect(ids(await call(h, user, { q: "zoneword due:today" }))).toEqual([]);
    expect(
      ids(await call(h, user, { q: "zoneword due:today", time_zone: "Europe/Amsterdam" })),
    ).toEqual([friday]);
    expect(
      ids(await call(h, user, { q: "zoneword due<today", time_zone: "Europe/Amsterdam" })),
    ).toEqual([]);
    const error = await refusal(call(h, user, { q: "zoneword", time_zone: "Mars/Olympus_Mons" }));
    expect(error.code).toBe("invalid_input");
    expect(error.data).toMatchObject({ issues: [{ path: "time_zone" }] });
    expect((await refusal(call(h, user, { q: "zoneword", time_zone: "+01:00" }))).code).toBe(
      "invalid_input",
    );
  });

  test("the next page of a search shows its dates in the zone the search was asked in", async () => {
    const finished = created(
      submit(fx, [
        { kind: "task.create", title: "Pagezoneword one" },
        { kind: "task.create", title: "Pagezoneword two" },
      ]),
    );
    submit(
      fx,
      finished.map((task) => ({ kind: "task.complete" as const, task, outcome: "Done." })),
    );
    // Finished on 12 November in UTC, on the 11th twelve hours west of it.
    const zone = "Etc/GMT+12";
    const h = host();
    const first = await call(h, user, {
      q: "pagezoneword",
      scope: "finished",
      limit: 1,
      time_zone: zone,
    });
    const next = await call(h, user, { cursor: first.cursor });
    expect([...first.rows, ...next.rows].map((row) => row["completed"])).toEqual([
      "2026-11-11",
      "2026-11-11",
    ]);
  });

  test("a restart drops every cursor", async () => {
    const first = await call(host(), user, { q: "findword", limit: 2 });
    const error = await refusal(call(host(), user, { cursor: first.cursor }));
    expect(error.data).toEqual({ reason: "restart" });
  });

  test("on:cwd finds a completed task whose folder is here, in the scope that holds it", async () => {
    const [task = ""] = created(submit(fx, [{ kind: "task.create", title: "Finishedcwdword" }]));
    // The home folder itself: `~` is a folder on every OS, and the host says what it means here.
    submit(fx, [{ kind: "task.folder_set", task, path: "~" }]);
    submit(fx, [{ kind: "task.complete", task, outcome: "Completed." }]);
    const h: OpsHost = { ...host(), home: temp.root };
    const find = (q: string) => call(h, user, { q, scope: "finished", cwd: temp.root });
    expect(ids(await find("finishedcwdword on:this-machine"))).toEqual([task]);
    expect(ids(await find("finishedcwdword on:cwd"))).toEqual([task]);
    expect(ids(await find("on:cwd is:completed"))).toContain(task);
  });
});

describe("[A3.5.search.cursors] cursor pages under random writes, deletions and redactions", () => {
  test("the union of pages is the snapshot list, and a removed entry never shows its old text", async () => {
    const human = fx.human.principal_id;
    let round = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            k: fc.constantFrom("title", "note", "create", "tombstone", "redact", "redactText"),
            t: fc.nat({ max: 100 }),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        fc.integer({ min: 1, max: 7 }),
        async (steps, limit) => {
          round += 1;
          const word = `pageword${String(round)}`;
          // A sentinel per task in its title, which every row shows.
          const sentinel = (n: number) => `snt${String(round)}x${String(n)}z`;
          const made = created(
            submit(
              fx,
              Array.from({ length: 18 }, (_, n) => ({
                kind: "task.create" as const,
                title: `${word} task ${sentinel(n)}`,
                priority: (n % 4) + 1,
              })),
            ),
          );
          // The snapshot list: the same search at the same state, in one page.
          const order = ids(await search({ q: word, limit: 50 }));
          expect([...order].sort()).toEqual([...made].sort());
          /** Tasks tombstoned or redacted, and texts redacted, before the page being read. */
          const removed = new Set<string>();
          const redacted = new Set<string>();
          const seen: Record<string, unknown>[] = [];
          const check = (rows: readonly Record<string, unknown>[]): void => {
            for (const row of rows) {
              const text = JSON.stringify(row);
              if (removed.has(String(row["id"]))) {
                expect(["deleted", "redacted"]).toContain(row["kind"]);
                expect(Object.keys(row).sort()).toEqual(["id", "kind", "ref"]);
                expect(text).not.toMatch(/snt\d+x\d+z/);
              }
              for (const gone of redacted) expect(text).not.toContain(gone);
            }
            seen.push(...rows);
          };
          let page = await search({ q: word, limit });
          check(page.rows);
          let i = 0;
          while (page.cursor !== undefined) {
            for (const step of steps.slice(i, i + 2)) {
              const target = made[step.t % made.length] ?? "";
              const n = made.indexOf(target);
              switch (step.k) {
                case "title":
                  if (removed.has(target)) break;
                  submit(fx, [
                    {
                      kind: "task.patch",
                      task: target,
                      set: { title: `${word} renamed ${String(n)}` },
                    },
                  ]);
                  break;
                case "note":
                  if (removed.has(target)) break;
                  submit(fx, [{ kind: "note.add", task: target, body: `${word} note` }]);
                  break;
                case "create":
                  created(submit(fx, [{ kind: "task.create", title: `${word} late arrival` }]));
                  break;
                case "tombstone":
                case "redact":
                  if (removed.has(target)) break;
                  await directly(fx, (conn) => {
                    if (step.k === "tombstone") tombstone(conn, target, human);
                    else redactTask(conn, target);
                  });
                  removed.add(target);
                  break;
                case "redactText":
                  await directly(fx, (conn) => {
                    redactText(conn, sentinel(n));
                  });
                  redacted.add(sentinel(n));
                  break;
              }
            }
            i += 2;
            page = await search({ cursor: page.cursor });
            check(page.rows);
          }
          // No gaps, no duplicates: the snapshot's list, in its order.
          expect(seen.map((r) => String(r["id"]))).toEqual(order);
        },
      ),
      { numRuns: 12 },
    );
  }, 240_000);

  test("a retried cursor gives the same page, and the header carries each page's own as_of", async () => {
    const word = "retryword";
    created(
      submit(
        fx,
        Array.from({ length: 6 }, (_, i) => ({
          kind: "task.create" as const,
          title: `${word} ${String(i)}`,
        })),
      ),
    );
    const first = await search({ q: word, limit: 2 });
    const cursor = first.cursor ?? "";
    const again = await search({ cursor });
    expect(await search({ cursor })).toEqual(again);
    // A row changed after the snapshot is read fresh and marked; the others are not.
    submit(fx, [{ kind: "task.patch", task: String(again.rows[0]?.["id"]), set: { priority: 1 } }]);
    const later = await search({ cursor });
    expect(ids(later)).toEqual(ids(again));
    expect(later.rows[0]).toMatchObject({ priority: 1, changed: true });
    expect(later.rows[1]).not.toHaveProperty("changed");
    expect(later.as_of).not.toBe(again.as_of);
    expect(later.first).toBe(3);
    expect(later.total).toBe(6);
  });

  test("a learning row is marked changed when its task changed since the search", async () => {
    const [one = "", two = ""] = created(
      submit(fx, [
        { kind: "task.create", title: "Learn holder one" },
        { kind: "task.create", title: "Learn holder two" },
      ]),
    );
    const human = fx.human.principal_id;
    await directly(fx, (conn) => {
      addLearning(conn, one, "markword one", human);
      addLearning(conn, two, "markword two", human);
    });
    const first = await search({ q: "markword", scope: "learnings", limit: 1 });
    expect(first.rows[0]).not.toHaveProperty("changed");
    submit(fx, [
      { kind: "task.patch", task: one, set: { title: "Learn holder one renamed" } },
      { kind: "task.patch", task: two, set: { title: "Learn holder two renamed" } },
    ]);
    const next = await search({ cursor: first.cursor ?? "" });
    expect(next.rows[0]).toMatchObject({ kind: "learning", changed: true });
    expect(String(next.rows[0]?.["title"])).toMatch(/renamed/);
  });

  test("more matches than a search keeps freeze the first ones, and total says so", async () => {
    // The rule at a cap of 200; the product's cap is SEARCH_IDS (the next test).
    const keep = 200;
    const word = "bulkword";
    created(
      submit(
        fx,
        Array.from({ length: keep + 40 }, (_, i) => ({
          kind: "task.create" as const,
          title: `${word} ${String(i)}`,
        })),
      ),
    );
    // The ranked query itself reads one past the cap, to tell there are more.
    const inner = readerOf(fx.reader);
    const ranked: number[] = [];
    const recording: SearchReader = {
      transaction: async (mode, queries) => {
        const results = await inner.transaction(mode, queries);
        const last = results.at(-1);
        if (Array.isArray(last)) ranked.push(last.length);
        return results;
      },
    };
    let page = await runSearch(recording, { q: word, limit: 50 }, envOf(fx, { keep }));
    expect(ranked).toContain(keep + 1);
    expect(ranked.every((n) => n <= keep + 1)).toBe(true);
    expect(page.total).toBe(`${String(keep)}+`);
    const seen = ids(page);
    while (page.cursor !== undefined) {
      page = await search({ cursor: page.cursor });
      seen.push(...ids(page));
    }
    expect(seen).toHaveLength(keep);
    expect(new Set(seen).size).toBe(keep);
    expect(page.first).toBe(keep - 49);
  });

  test("a search keeps SEARCH_IDS, the 10000+ its result's schema names", async () => {
    expect(`${String(SEARCH_IDS)}+`).toBe("10000+");
    const inner = readerOf(fx.reader);
    const params: unknown[] = [];
    const recording: SearchReader = {
      transaction: (mode, queries) => {
        params.push(...queries.flatMap((q) => Object.values(q.params ?? {})));
        return inner.transaction(mode, queries);
      },
    };
    await runSearch(recording, { q: "keepword" }, envOf(fx));
    // The plan reads one past the cap, to tell there are more.
    expect(params).toContain(SEARCH_IDS + 1);
  });

  test("an epoch, incarnation, binding, idle or restart ends a cursor with its reason", async () => {
    const word = "expireword";
    created(
      submit(
        fx,
        Array.from({ length: 4 }, (_, i) => ({
          kind: "task.create" as const,
          title: `${word} ${String(i)}`,
        })),
      ),
    );
    const open = async () => (await search({ q: word, limit: 1 })).cursor ?? "";

    expect(
      (await refusal(search({ cursor: await open() }, { owner: "agent:other" }))).data,
    ).toEqual({
      reason: "binding",
    });
    expect((await refusal(search({ cursor: "c_0000000000000000" }))).data).toEqual({
      reason: "restart",
    });
    expect((await refusal(search({ cursor: "c_bad" }))).code).toBe("invalid_input");

    const idle = await open();
    clock += CURSOR_LIMITS.idleMs;
    expect((await refusal(search({ cursor: idle }))).data).toEqual({ reason: "idle" });

    const many = [];
    for (let n = 0; n <= CURSOR_LIMITS.perOwner; n += 1) many.push(await open());
    expect((await refusal(search({ cursor: many[0] ?? "" }))).data).toEqual({ reason: "idle" });
    expect((await search({ cursor: many.at(-1) ?? "" })).rows).toHaveLength(1);

    for (const what of ["epoch", "incarnation"] as const) {
      const cursor = await open();
      await directly(fx, (conn) => {
        changeAuthority(conn, what);
      });
      const error = await refusal(search({ cursor }));
      expect(error.code).toBe("cursor_expired");
      expect(error.data).toEqual({ reason: what });
      // Gone for good, never rows from another history.
      expect((await refusal(search({ cursor }))).data).toEqual({ reason: what });
    }
  });
});
