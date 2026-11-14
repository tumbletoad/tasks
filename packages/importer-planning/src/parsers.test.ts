// The importer's parsers on small synthetic inputs (A7 3.15.2): the prototype's rules where the
// fixture has no case, the totality of every parser, and every bound.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  eachLine,
  eventInstant,
  fallbackId,
  parseAudit,
  parseEvents,
  parseJira,
  parseLedger,
  parseMetadata,
  parsePrototype,
  PROBLEM_CODES,
  PROBLEM_FIELDS,
  splitLines,
  type Problem,
} from "./index.ts";

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const codes = (problems: readonly Problem[]) => problems.map((p) => p.code);
const ev = (id: string, task: string, action: string, at: string) =>
  JSON.stringify({ id, task, action, at });

describe("[A7.3.15.importer.grammar] the prototype's rules on small inputs", () => {
  test("lines split as Python's str.splitlines() splits them", () => {
    const texts = (s: string) => splitLines(s).map((l) => l.text);
    expect(texts("")).toEqual([]);
    expect(texts("\n")).toEqual([""]);
    expect(texts("a\n\nb")).toEqual(["a", "", "b"]);
    expect(texts("\r\r\n")).toEqual(["", ""]);
    expect(texts(`a\vb\fc\x1cd\x1de\x1ef\x85g${LS}h${PS}i\x1fj`)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
      "i\x1fj",
    ]);
    expect(splitLines("a\r\nb").map((l) => l.end)).toEqual(["\r\n", ""]);
    // The ledger parser takes lines one at a time, so a file of millions of blank lines never
    // becomes an array of them (review finding).
    const lazy = eachLine(`a\n${"\n".repeat(1_000_000)}`);
    expect(lazy.next().value).toEqual({ text: "a", end: "\n" });
  });

  test("headings, groups and Python's whitespace", () => {
    const { tasks } = parseLedger(
      "TODO.md",
      [
        "- [ ] **First** x",
        "## Errands \x1f",
        "- [ ] **Second**\x1fbody",
        "## A\ufeff",
        "- [ ] **Third**\ufeffbody",
        "##No space",
        "- [ ] **Fourth**",
      ].join("\n"),
    );
    expect(tasks.map((t) => [t.group, t.title, t.body])).toEqual([
      ["Other", "First", "x"],
      // Python strips U+001F and lets \s match it.
      ["Errands", "Second", "body"],
      // Python does not count U+FEFF as whitespace.
      ["A\ufeff", "Third", "\ufeffbody"],
      ["A\ufeff", "Fourth", ""],
    ]);
  });

  test("task lines: boxes, titles, markers and bodies", () => {
    const todo = parseLedger(
      "TODO.md",
      [
        "- [x] **Done in TODO.** <!-- task:a-1 -->",
        "- [X] **Also done**  <!-- task:a-2 --> tail",
        "- [ ] **Open** <!-- task:Bad --> keeps the bad marker",
        "- [ ] **...** only dots",
        "- [ ] **Bold <!-- task:in-title -->** body <!-- task:second -->",
        "- [] **Not a task**",
        "-  [ ] **Not a task**",
        "- [ ] **Unclosed",
        "- [ ] ****",
      ].join("\n"),
    );
    expect(
      todo.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        body: t.body,
        marked: t.marked,
        checked: t.checked,
        done: t.done,
      })),
    ).toEqual([
      { id: "a-1", title: "Done in TODO", body: "", marked: true, checked: true, done: true },
      { id: "a-2", title: "Also done", body: "tail", marked: true, checked: true, done: true },
      {
        id: fallbackId("Other", "Open"),
        title: "Open",
        body: "<!-- task:Bad --> keeps the bad marker",
        marked: false,
        checked: false,
        done: false,
      },
      {
        id: fallbackId("Other", ""),
        title: "",
        body: "only dots",
        marked: false,
        checked: false,
        done: false,
      },
      {
        id: "in-title",
        title: "Bold <!-- task:in-title -->",
        body: "body",
        marked: true,
        checked: false,
        done: false,
      },
    ]);
    // `(.+?)` needs one character, so `****` is no task line; `**x****` is, with title `x`.
    expect(parseLedger("TODO.md", "- [ ] **x****").tasks.map((t) => t.title)).toEqual(["x"]);
    const done = parseLedger("DONE.md", "- [ ] **Open box** <!-- task:d-1 -->");
    expect(done.tasks[0]?.done).toBe(true);
    expect(done.tasks[0]?.checked).toBe(false);
  });

  test("the added, done and Next clauses", () => {
    const todo = parseLedger(
      "TODO.md",
      [
        "- [ ] **A** Next: call Tomas (added 2026-10-01, codex)",
        "- [ ] **B** Next: ship v2.1 today. Refs: X. (added 2026-02-29, claude)",
        "- [ ] **C** Nextday: no. xNext: no. (added today, codex)",
        "- [ ] **D** Next:  spaced out",
        "- [ ] **E** (done 2026-01-02; not in TODO)",
      ].join("\n"),
    );
    const [a, b, c, d, e] = todo.tasks;
    expect(a?.next).toBe("call Tomas");
    expect(a?.added).toEqual({ date: "2026-10-01", agent: "codex" });
    expect(b?.next).toBe("ship v2.1 today");
    expect(b?.added).toEqual({ agent: "claude" });
    expect(todo.problems).toEqual([
      {
        code: "date-invalid",
        severity: "warning",
        file: "TODO.md",
        line: 2,
        task: b?.id,
        field: "added",
      },
    ]);
    expect(c?.next).toBeUndefined();
    expect(c?.added).toBeUndefined();
    expect(d?.next).toBe("spaced out");
    expect(e?.completion).toBeUndefined();

    const done = parseLedger(
      "DONE.md",
      [
        "- [x] **F** (done 2026-01-02; fixed (twice)) <!-- task:f -->",
        "- [x] **G** (done 2026-01-02; first) then (done 2026-01-03; second)",
        "- [x] **H** (done 2026-01-02; early) and more",
        "- [x] **I** (done 2026-02-29; leap)",
        "- [x] **J** (done 2026-1-2; short)",
        // The clause that closes the body is the one whose parenthesis the last `)` closes, so a
        // quoted clause inside the evidence is evidence (review finding).
        "- [x] **K** (done 2026-11-13; checked (done 2026-01-01; old work) and confirmed)",
        // Unbalanced evidence: the last opener stands.
        "- [x] **L** (done 2026-01-02; works :) now)",
        // Balanced, and the final `)` closes another clause: no completion (review round two).
        "- [x] **M** Earlier (done 2026-01-01; old) More notes (kept)",
      ].join("\n"),
    );
    expect(done.tasks.map((t) => t.completion)).toEqual([
      { date: "2026-01-02", evidence: "fixed (twice)" },
      { date: "2026-01-03", evidence: "second" },
      undefined,
      { evidence: "leap" },
      undefined,
      { date: "2026-11-13", evidence: "checked (done 2026-01-01; old work) and confirmed" },
      { date: "2026-01-02", evidence: "works :) now" },
      undefined,
    ]);
    expect(codes(done.problems)).toEqual(["date-invalid"]);
  });

  test("duplicate IDs across and within the ledgers are errors", () => {
    const parse = parsePrototype({
      todo: "- [ ] **A** <!-- task:x -->\n- [ ] **B** <!-- task:x -->\n- [ ] **C**",
      done: "- [x] **D** <!-- task:y -->\n## Other\n- [x] **C**",
      events: [],
    });
    const dup = parse.problems.filter((p) => p.code === "duplicate-id");
    expect(dup).toEqual([
      { code: "duplicate-id", severity: "error", file: "TODO.md", line: 2, task: "x" },
      {
        code: "duplicate-id",
        severity: "error",
        file: "DONE.md",
        line: 3,
        task: fallbackId("Other", "C"),
      },
    ]);
    // Every task line is still returned: M7.03 and M7.04 decide what an error blocks.
    expect(parse.tasks).toHaveLength(5);
  });

  test("decoding: a byte-order mark stays, as Python's utf-8 codec keeps it; bad bytes are an error", () => {
    const bom = parseLedger("TODO.md", Buffer.from("\ufeff## A\n- [ ] **T**", "utf8"));
    expect(codes(bom.problems)).toEqual(["byte-order-mark"]);
    expect(bom.tasks[0]?.group).toBe("Other");
    const bad = parseLedger(
      "TODO.md",
      Buffer.concat([Buffer.from("- [ ] **T** a"), Buffer.from([0xff, 0xfe]), Buffer.from("\n")]),
    );
    expect(codes(bad.problems)).toEqual(["invalid-utf8"]);
    expect(bad.tasks[0]?.body).toBe("a\ufffd\ufffd");
    expect(codes(parseLedger("DONE.md", undefined).problems)).toEqual(["file-missing"]);
  });

  test("metadata: typed fields, dropped values, unknown keys", () => {
    const parse = parseMetadata(
      JSON.stringify({
        a: {
          category: 5,
          project: "P (Q4)",
          status: "done",
          owner: "Noor",
          priority: "P4",
          rank: "2",
          confidence: 0.6,
          due: "2024-02-29",
          reviewed: "2026-11-01T10:00:00Z",
          sources: [
            { url: "https://x.example/1" },
            { label: "no url" },
            "text",
            { label: 1, url: "u" },
          ],
          paths: ["rel/x", 5, "C:\\work\\x", "\\\\host\\share", "/home/x"],
          estimate: { hours: 2 },
        },
        b: { priority: 1, status: 3, rank: 1.5, sources: "x", paths: {}, confidence: [] },
        c: 5,
        ["__proto__"]: { owner: "proto" },
      }),
    );
    const a = parse.entries.get("a");
    expect(a).toEqual({
      id: "a",
      project: "P (Q4)",
      owner: "Noor",
      due: "2024-02-29",
      sources: [{ label: "", url: "https://x.example/1" }],
      paths: ["rel/x", "C:\\work\\x", "\\\\host\\share", "/home/x"],
      extra: { estimate: { hours: 2 } },
    });
    expect(parse.entries.get("b")).toEqual({
      id: "b",
      rank: 1.5,
      sources: [],
      paths: [],
      extra: {},
    });
    expect(parse.entries.has("c")).toBe(false);
    // A key named __proto__ is an entry like any other and changes no prototype.
    expect(parse.entries.get("__proto__")?.owner).toBe("proto");
    expect(({} as Record<string, unknown>)["owner"]).toBeUndefined();
    const at = (p: Problem) =>
      `${p.task ?? ""} ${p.code} ${p.field ?? ""} ${String(p.index ?? "")}`;
    expect(parse.problems.map(at)).toEqual([
      "a field-type category ",
      "a date-invalid reviewed ",
      "a status-unknown status ",
      "a priority-invalid priority ",
      "a field-type rank ",
      "a field-type confidence ",
      "a source-invalid sources 1",
      "a source-invalid sources 2",
      "a source-invalid sources 3",
      "a path-not-absolute paths 0",
      "a field-type paths 1",
      "b field-type status ",
      "b field-type priority ",
      "b field-type confidence ",
      "b field-type sources ",
      "b field-type paths ",
      "c entry-not-object  ",
    ]);

    // JSON.parse has already rounded a number, so its text as written cannot be kept: a number is
    // dropped and reported, never kept as other text (review findings, both rounds).
    const lossy = parseMetadata(
      '{"a": {"confidence": 9007199254740993}, "b": {"confidence": 1e400}, "c": {"confidence": 1e-400}, "d": {"confidence": 9007199254740991.1}, "e": {"confidence": true}}',
    );
    expect([...lossy.entries.values()].map((e) => e.confidence)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      "true",
    ]);
    expect(lossy.problems.map(at)).toEqual([
      "a field-type confidence ",
      "b field-type confidence ",
      "c field-type confidence ",
      "d field-type confidence ",
    ]);
  });

  test("metadata, jira and audit files: missing, invalid and wrongly shaped", () => {
    expect(parseMetadata(undefined)).toEqual({ present: false, entries: new Map(), problems: [] });
    expect(codes(parseMetadata("{ secret task text").problems)).toEqual(["json-invalid"]);
    expect(codes(parseMetadata("[]").problems)).toEqual(["json-wrong-shape"]);
    expect(codes(parseMetadata("NaN").problems)).toEqual(["json-invalid"]);

    expect(parseJira(undefined).present).toBe(false);
    expect(codes(parseJira("{}").problems)).toEqual(["json-wrong-shape"]);
    const jira = parseJira(
      JSON.stringify([
        { key: "LUM-1", summary: "Title", url: "https://t.example/browse/LUM-1" },
        { key: 7 },
        { key: "" },
        null,
        { key: "LUM-2", summary: 5 },
      ]),
    );
    expect(jira.tickets.map((t) => [t.key, t.title, t.url])).toEqual([
      ["LUM-1", "Title", "https://t.example/browse/LUM-1"],
      ["LUM-2", undefined, undefined],
    ]);
    expect(jira.skippedRows).toBe(3);
    expect(jira.problems.map((p) => p.index)).toEqual([1, 2, 3]);

    expect(parseAudit(undefined).present).toBe(false);
    expect(parseAudit("{}").problems).toEqual([]);
    expect(parseAudit('{"reviewed": "2026-10-30T09:10Z"}').reviewed).toBe("2026-10-30T09:10Z");
    expect(codes(parseAudit('{"reviewed": "last week"}').problems)).toEqual(["date-invalid"]);
    expect(codes(parseAudit('{"reviewed": "2026-10-30"}').problems)).toEqual(["date-invalid"]);
    expect(codes(parseAudit("[1]").problems)).toEqual(["json-wrong-shape"]);
  });

  test("event times: the grammar, real calendar values, and instants", () => {
    const valid = [
      "2026-11-06T07:45Z",
      "2026-11-06T07:45:00Z",
      "2026-11-06T07:45:00.000Z",
      "2026-11-06T08:45:00+01:00",
      "2026-11-06T06:45:00.000000999-01:00",
      "2024-02-29T00:00:00Z",
      "0001-01-01T00:00:00Z",
    ];
    for (const at of valid) expect(eventInstant(at), at).toBeDefined();
    const [a, b, c, d, e] = valid.map(eventInstant);
    expect(new Set([a, b, c, d, e]).size).toBe(1);
    expect(eventInstant("0001-01-01T00:00:00.000001Z")).toBe(1n);
    for (const at of [
      "2026-13-01T00:00:00Z",
      "2026-02-29T00:00:00Z",
      "2026-11-06T24:00:00Z",
      "2026-11-06T23:60:00Z",
      "2026-11-06T23:59:60Z",
      "2026-11-06T07:45:00+24:00",
      "2026-11-06T07:45:00+01:60",
      "2026-11-06T07:45:00z",
      "2026-11-06T07:45:00",
      "2026-11-06 07:45:00Z",
      "2026-11-06T07:45:00.1234567890Z",
      "0000-01-01T00:00:00Z",
      "2026-11-06T07Z",
    ]) {
      expect(eventInstant(at), at).toBeUndefined();
    }
  });

  test("events: validity, the .ready rule, file order and the fold", () => {
    const parse = parseEvents([
      { name: "z.json", bytes: ev("z", "t", "check", "2026-01-01T10:00:00.0000002Z") },
      { name: "y.json", bytes: ev("a-late", "t", "uncheck", "2026-01-01T10:00:00.0000001Z") },
      { name: "x.json", bytes: ev("m", "u", "focus", "2026-01-01T23:30:00-05:00") },
      { name: "w.json", bytes: ev("w", "u", "check", "2026-01-01T10:00:00.000001Z") },
      { name: "v.json", bytes: ev("v", "u", "uncheck", "2026-01-01T10:00:00.000002Z") },
      { name: "bad-time.json", bytes: ev("b1", "t", "check", "2026-02-30T10:00:00Z") },
      { name: "bad-id.json", bytes: ev("x".repeat(101), "t", "check", "2026-01-01T10:00Z") },
      { name: "bad-task.json", bytes: ev("b3", "has space", "check", "2026-01-01T10:00Z") },
      { name: "bad-action.json", bytes: ev("b4", "t", "star", "2026-01-01T10:00Z") },
      { name: "bad-shape.json", bytes: "[1]" },
      { name: "bad-json.json", bytes: "{ secret task text" },
      { name: "web-1.json", bytes: "{ half writ" },
      { name: "web-2.json", bytes: ev("web-2", "t", "check", "2026-01-01T12:00Z") },
      { name: "web-2.ready" },
      { name: "web-3.ready" },
      { name: "dup.json", bytes: ev("z", "t", "check", "2026-01-01T09:00Z") },
      { name: "notes.txt", bytes: "ignored" },
    ]);
    expect(parse.files.map((f) => [f.name, f.counted])).toEqual([
      ["bad-action.json", false],
      ["bad-id.json", false],
      ["bad-json.json", false],
      ["bad-shape.json", false],
      ["bad-task.json", false],
      ["bad-time.json", false],
      ["dup.json", true],
      ["v.json", true],
      ["w.json", true],
      ["web-1.json", false],
      ["web-2.json", true],
      ["x.json", true],
      ["y.json", true],
      ["z.json", true],
    ]);
    expect(parse.readyFiles).toBe(2);
    // Python keeps microseconds: z and a-late are one instant, so the ID orders them.
    expect(parse.applied.map((e) => e.id)).toEqual(["z", "a-late", "z", "w", "v", "web-2", "m"]);
    expect(parse.state.get("t")?.check).toEqual({
      checked: true,
      at: "2026-01-01T12:00Z",
      event: "web-2",
    });
    expect(parse.state.get("u")?.check?.checked).toBe(false);
    // The focus day is the date as the event's own time writes it.
    expect(parse.state.get("u")?.star).toEqual({
      starred: true,
      at: "2026-01-01T23:30:00-05:00",
      event: "m",
      day: "2026-01-01",
    });
    expect(parse.problems.map((p) => `${p.code} ${p.file}`)).toEqual([
      "event-invalid events/bad-action.json",
      "event-invalid events/bad-id.json",
      "json-invalid events/bad-json.json",
      "event-invalid events/bad-shape.json",
      "event-invalid events/bad-task.json",
      "event-invalid events/bad-time.json",
      // A web- file without .ready may be half written: it is not checked, only reported.
      "event-not-ready events/web-1.json",
      "event-duplicate-id events/z.json",
    ]);
  });

  test("event files sort by code point, as Python sorts names", () => {
    const high = String.fromCodePoint(0xff61);
    const astral = String.fromCodePoint(0x1f382);
    const parse = parseEvents([
      { name: `${astral}.json`, bytes: ev("a", "t", "check", "2026-01-01T10:00Z") },
      { name: `${high}.json`, bytes: ev("b", "t", "check", "2026-01-01T10:00Z") },
    ]);
    expect(parse.files.map((f) => f.name)).toEqual([`${high}.json`, `${astral}.json`]);
  });

  test("an event's task is any ledger ID, however long; only the event's own ID is bounded", () => {
    // A marker ID has no length bound, so a check of that task must count (review finding).
    const long = "a".repeat(101);
    const parse = parsePrototype({
      todo: `- [ ] **Long** <!-- task:${long} -->`,
      done: "",
      events: [{ name: "e.json", bytes: ev("e", long, "check", "2026-01-01T10:00Z") }],
    });
    expect(parse.problems).toEqual([]);
    expect(parse.events.state.get(long)?.check?.checked).toBe(true);
    const bad = parseEvents([
      { name: "e.json", bytes: ev("e", "", "check", "2026-01-01T10:00Z") },
      { name: "f.json", bytes: ev("f", "a b", "check", "2026-01-01T10:00Z") },
    ]);
    expect(codes(bad.problems)).toEqual(["event-invalid", "event-invalid"]);
  });

  test("a problem names an event file only by a name of the event grammar", () => {
    const parse = parseEvents([
      { name: "Call Tomas about the lease.json", bytes: "{" },
      { name: "ok-name.json", bytes: "{" },
      { name: "web-Call Tomas.json", bytes: "{" },
    ]);
    // Any other name is the folder plus the file's place in the sorted list.
    expect(parse.problems).toEqual([
      { code: "json-invalid", severity: "error", file: "events", index: 0 },
      { code: "json-invalid", severity: "error", file: "events/ok-name.json" },
      { code: "event-not-ready", severity: "warning", file: "events", index: 2 },
    ]);
  });

  test("a whole folder: orphans, lines without metadata and events for no task", () => {
    const parse = parsePrototype({
      todo: "- [ ] **A** <!-- task:a -->\n- [ ] **B** <!-- task:b -->",
      done: "",
      metadata: JSON.stringify({ a: {}, gone: {}, "not an id": {} }),
      events: [
        { name: "1.json", bytes: ev("e1", "a", "check", "2026-01-01T10:00Z") },
        { name: "2.json", bytes: ev("e2", "nope", "focus", "2026-01-01T10:00Z") },
      ],
    });
    expect(parse.orphans).toEqual(["gone", "not an id"]);
    expect(parse.withoutMetadata).toEqual(["b"]);
    expect(parse.problems).toEqual([
      { code: "metadata-orphan", severity: "warning", file: "data/metadata.json", task: "gone" },
      // A key that is no ID could be any text: the problem leaves it out.
      { code: "metadata-orphan", severity: "warning", file: "data/metadata.json" },
      { code: "event-unknown-task", severity: "warning", file: "events/2.json", task: "nope" },
    ]);
    expect(parse.counts).toEqual({
      todoTaskLines: 2,
      doneTaskLines: 0,
      taskLines: 2,
      metadataEntries: 3,
      metadataOrphans: 2,
      taskLinesWithoutMetadata: 1,
      eventFiles: 2,
      readyFiles: 0,
      countedEventFiles: 2,
    });
  });
});

// --- Totality --------------------------------------------------------------------------------

const SENTINEL = "secret task text";
const ALLOWED_KEYS = new Set(["code", "severity", "file", "line", "task", "field", "index"]);

/** Every problem has only the allowed keys and values, and none holds the sentinel. */
function checkProblems(problems: readonly Problem[]): void {
  for (const p of problems) {
    for (const key of Object.keys(p)) expect(ALLOWED_KEYS.has(key), key).toBe(true);
    expect(PROBLEM_CODES[p.code]).toBe(p.severity);
    if (p.field !== undefined) expect(PROBLEM_FIELDS).toContain(p.field);
    if (p.task !== undefined) expect(p.task).toMatch(/^[a-zA-Z0-9_-]{1,100}$/);
    if (p.line !== undefined) expect(Number.isInteger(p.line) && p.line > 0).toBe(true);
  }
  expect(JSON.stringify(problems)).not.toContain(SENTINEL);
}

/** Text built from the grammar's own tokens and the sentinel, so the parsers meet near-misses. */
const ledgerText = fc
  .array(
    fc.oneof(
      fc.constantFrom(
        "- [ ] **",
        "- [x] **",
        "- [X] **",
        "**",
        "## ",
        "<!-- task:",
        " -->",
        "abc-1",
        "\n",
        "\r\n",
        "\r",
        String.fromCharCode(0x2028),
        "\x85",
        "\x1f",
        "\ufeff",
        "(added 2026-01-01, ",
        "(added 2026-02-30, ",
        "(done 2026-01-01; ",
        "(done 2026-13-01; ",
        ")",
        ".",
        " ",
        "Next: ",
        SENTINEL,
      ),
      fc.string({ maxLength: 8 }),
    ),
    { maxLength: 60 },
  )
  .map((parts) => parts.join(""));

const jsonish = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: "small" },
    fc.constantFrom(SENTINEL, "P1", "open", "2026-02-30", "2026-01-01", "/abs", "rel", "", null),
    fc.integer(),
    fc.double(),
    fc.boolean(),
    fc.array(tie("value"), { maxLength: 4 }),
    fc.dictionary(
      fc.constantFrom(
        "category",
        "status",
        "priority",
        "rank",
        "due",
        "reviewed",
        "sources",
        "paths",
        "label",
        "url",
        "key",
        "summary",
        "id",
        "task",
        "action",
        "at",
        SENTINEL,
      ),
      tie("value"),
      { maxKeys: 6 },
    ),
  ),
})).value;

describe("[A7.3.15.importer.total] every parser returns a result for any input", () => {
  test("ledgers: any text or bytes", () => {
    fc.assert(
      fc.property(ledgerText, fc.uint8Array({ maxLength: 200 }), (text, bytes) => {
        for (const file of ["TODO.md", "DONE.md"] as const) {
          const a = parseLedger(file, text);
          const b = parseLedger(file, bytes);
          checkProblems(a.problems);
          checkProblems(b.problems);
          for (const t of a.tasks) {
            expect(t.id).toMatch(/^([a-z0-9_-]+|t-[0-9a-f]{8})$/);
            expect(t.line).toBeGreaterThan(0);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  test("JSON files: any value, any text", () => {
    fc.assert(
      fc.property(jsonish, fc.string({ maxLength: 40 }), (value, text) => {
        const json = JSON.stringify(value);
        for (const source of [json, text, `${json}${text}`]) {
          checkProblems(parseMetadata(source).problems);
          checkProblems(parseMetadata(JSON.stringify({ [SENTINEL]: value, a: value })).problems);
          checkProblems(parseJira(source).problems);
          checkProblems(parseJira(JSON.stringify([value, { key: SENTINEL }])).problems);
          checkProblems(parseAudit(source).problems);
          checkProblems(parseAudit(JSON.stringify({ reviewed: value })).problems);
        }
      }),
      { numRuns: 300 },
    );
  });

  test("events: any file content and any names", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            name: fc.constantFrom("a.json", "web-1.json", "web-1.ready", "b.json", "c.ready"),
            bytes: fc.oneof(
              jsonish.map((v) => JSON.stringify(v)),
              fc.string({ maxLength: 30 }),
            ),
          }),
          { maxLength: 8 },
        ),
        (files) => {
          const parse = parseEvents(files);
          checkProblems(parse.problems);
          const whole = parsePrototype({ todo: SENTINEL, events: files });
          checkProblems(whole.problems);
        },
      ),
      { numRuns: 300 },
    );
  });

  test("no problem carries input text, even where the text sits next to a problem", () => {
    const parse = parsePrototype({
      todo: `- [ ] **${SENTINEL}** ${SENTINEL} (added 2026-02-30, ${SENTINEL}) <!-- task:x -->\n- [ ] **${SENTINEL}** <!-- task:x -->`,
      done: `- [x] **${SENTINEL}** (done 2026-02-30; ${SENTINEL})`,
      metadata: JSON.stringify({
        x: { due: SENTINEL, status: SENTINEL, priority: SENTINEL, sources: [SENTINEL] },
        [SENTINEL]: { owner: SENTINEL },
      }),
      jira: JSON.stringify([{ summary: SENTINEL }]),
      audit: JSON.stringify({ reviewed: SENTINEL }),
      events: [
        { name: "a.json", bytes: ev("a", "t", "check", SENTINEL) },
        { name: "b.json", bytes: `{"id": "${SENTINEL}"` },
        { name: `${SENTINEL}.json`, bytes: "{" },
        { name: `web-${SENTINEL}.json`, bytes: "{" },
      ],
    });
    expect(parse.problems.length).toBeGreaterThan(10);
    checkProblems(parse.problems);
  });
});

describe("[A7.3.15.importer.bounds] every unbounded input is bounded with a typed problem", () => {
  test("ledgers: file size, line length and task lines", () => {
    expect(codes(parseLedger("TODO.md", "- [ ] **A**", { ledgerBytes: 5 }).problems)).toEqual([
      "file-too-large",
    ]);
    const long = parseLedger("TODO.md", `- [ ] **${"a".repeat(30)}**\n- [ ] **B**`, {
      lineLength: 20,
    });
    expect(long.tasks.map((t) => t.title)).toEqual(["B"]);
    expect(long.problems).toEqual([
      { code: "line-too-long", severity: "error", file: "TODO.md", line: 1 },
    ]);
    const many = parseLedger("TODO.md", "- [ ] **A**\n- [ ] **B**\n- [ ] **C**", { taskLines: 2 });
    expect(many.tasks).toHaveLength(2);
    expect(many.problems).toEqual([
      { code: "too-many-task-lines", severity: "error", file: "TODO.md", line: 3 },
    ]);
    // The default line bound.
    const huge = parseLedger("TODO.md", `- [ ] **${"a".repeat(70_000)}**`);
    expect(codes(huge.problems)).toEqual(["line-too-long"]);
  });

  test("the grammar's regular expressions stay linear on the longest allowed line", () => {
    const n = 60_000;
    const lines = [
      `- [ ] **T** Next: a${" ".repeat(n)}b`,
      `- [ ] **T** Next: ${"a.".repeat(n / 2)}`,
      `- [ ] **${"a*".repeat(n / 2)}`,
      `- [ ] **${".".repeat(n)}x** ${"\t".repeat(n)}x`,
      `## ${" ".repeat(n)}x`,
      `- [ ] **T** ${"(done 2026-01-01; ".repeat(n / 20)})`,
      `- [ ] **T** ${"(added 2026-01-01, ".repeat(n / 20)}`,
      `- [ ] **T** ${"<!-- task:".repeat(n / 10)}`,
    ];
    const started = performance.now();
    for (const line of lines) {
      parseLedger("TODO.md", line);
      parseLedger("DONE.md", line);
    }
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("JSON files: size, entries and items per entry", () => {
    for (const parse of [parseMetadata, parseJira, parseAudit]) {
      expect(codes(parse("{}", { jsonBytes: 1 }).problems)).toEqual(["file-too-large"]);
    }
    const meta = parseMetadata(JSON.stringify({ a: {}, b: {}, c: {} }), { entries: 2 });
    expect([...meta.entries.keys()]).toEqual(["a", "b"]);
    expect(codes(meta.problems)).toEqual(["too-many-entries"]);
    // Entries that are left out count toward the bound too (review finding).
    const invalid = parseMetadata(JSON.stringify({ a: 1, b: 2, c: 3, d: 4 }), { entries: 2 });
    expect(codes(invalid.problems)).toEqual([
      "entry-not-object",
      "entry-not-object",
      "too-many-entries",
    ]);
    const jira = parseJira(JSON.stringify([{ key: "A" }, { key: "B" }, { key: "C" }]), {
      entries: 2,
    });
    expect(jira.tickets.map((t) => t.key)).toEqual(["A", "B"]);
    expect(codes(jira.problems)).toEqual(["too-many-entries"]);
    const items = parseMetadata(
      JSON.stringify({
        a: { sources: [{ url: "1" }, { url: "2" }, { url: "3" }], paths: ["/1", "/2", "/3"] },
      }),
      { itemsPerEntry: 2 },
    );
    expect(items.entries.get("a")?.sources).toHaveLength(2);
    expect(items.entries.get("a")?.paths).toEqual(["/1", "/2"]);
    expect(items.problems.map((p) => `${p.code} ${p.field ?? ""}`)).toEqual([
      "too-many-items sources",
      "too-many-items paths",
    ]);
  });

  test("events: file size and file count", () => {
    const big = parseEvents(
      [{ name: "a.json", bytes: ev("a", "t", "check", "2026-01-01T10:00Z") }],
      {
        eventBytes: 10,
      },
    );
    expect(big.problems).toEqual([
      { code: "event-too-large", severity: "error", file: "events/a.json" },
    ]);
    expect(big.applied).toEqual([]);
    const many = parseEvents(
      ["a", "b", "c"].map((id) => ({
        name: `${id}.json`,
        bytes: ev(id, "t", "check", "2026-01-01T10:00Z"),
      })),
      { eventFiles: 2 },
    );
    expect(many.files).toHaveLength(2);
    expect(codes(many.problems)).toEqual(["too-many-event-files"]);
  });
});
