// M7.02's Verify line (A7 3.14): every edge case of the synthetic prototype parses, meaning every
// case named in fixtures/planning-prototype.index.json gives exactly the result the index states.
// The run goes the way an import goes: copy the committed fixture into a run folder, read the copy,
// parse it. The test reads the fixture and its index from disk and shares no code with the
// generator or with the testkit's own parse (A7 3.15.8 Tests).
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  copyInput,
  fallbackId,
  parsePrototype,
  readInput,
  splitLines,
  type InputCopy,
  type LedgerTask,
  type MetadataEntry,
  type Problem,
  type PrototypeParse,
} from "./index.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE = join(ROOT, "fixtures", "planning-prototype");

interface Where {
  file: string;
  line?: number;
  task?: string;
  key?: string;
  event?: string;
  note?: string;
  expect?: Record<string, unknown>;
}
interface IndexedTask {
  id: string;
  file: string;
  line: number;
  group: string;
  title: string;
  body: string;
  marked: boolean;
  checked: boolean;
  done: boolean;
  metadata: boolean;
}
interface Index {
  counts: Record<string, number>;
  tasks: IndexedTask[];
  cases: Record<string, { description: string; where: Where[] }>;
}
const index = JSON.parse(
  readFileSync(join(ROOT, "fixtures", "planning-prototype.index.json"), "utf8"),
) as Index;
const rawMetadata = JSON.parse(
  readFileSync(join(FIXTURE, "data", "metadata.json"), "utf8"),
) as Record<string, Record<string, unknown>>;
const fixtureText = (file: string) => readFileSync(join(FIXTURE, ...file.split("/")), "utf8");

let work = "";
let copy: InputCopy;
let readProblems: Problem[];
let parse: PrototypeParse;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "tasks-m7-02-fixture-"));
  copy = await copyInput(FIXTURE, join(work, "input"));
  const read = await readInput(join(work, "input"));
  readProblems = read.problems;
  parse = parsePrototype(read.input);
});
afterAll(() => {
  if (work !== "") rmSync(work, { recursive: true, force: true });
});

const taskAt = (file: string, line: number): LedgerTask | undefined =>
  parse.tasks.find((t) => t.file === file && t.line === line);
const taskById = (id: string | undefined): LedgerTask | undefined =>
  parse.tasks.find((t) => t.id === id);
const problemsOf = (code: string) => parse.problems.filter((p) => p.code === code);

/** The parsed field for a metadata key, as the prototype names it. */
function parsedField(entry: MetadataEntry, key: string): unknown {
  const known: Record<string, keyof MetadataEntry> = {
    category: "category",
    project: "project",
    status: "status",
    owner: "owner",
    priority: "priority",
    rank: "rank",
    next: "next",
    evidence: "evidence",
    source_date: "sourceDate",
    reviewed: "reviewed",
    confidence: "confidence",
    due: "due",
    sources: "sources",
    paths: "paths",
  };
  const field = known[key];
  return field === undefined ? entry.extra[key] : entry[field];
}
/** What the parse must give for a valid raw value. */
function expected(key: string, raw: unknown): unknown {
  if (raw === undefined) return key === "sources" || key === "paths" ? [] : undefined;
  if (key === "priority") return typeof raw === "string" ? { P1: 1, P2: 2, P3: 3 }[raw] : raw;
  if (key === "confidence" && typeof raw !== "string") return JSON.stringify(raw);
  // Each parsed source carries its place in the file's list.
  if (key === "sources" && Array.isArray(raw)) {
    return raw.map((source: object, index) => ({ ...source, index }));
  }
  return raw;
}

/** Copied paths of the fixture, from the fixture folder itself. */
function fixtureInputs(): string[] {
  const out = ["TODO.md", "DONE.md", "data/metadata.json", "data/jira.json", "data/audit.json"];
  for (const name of readdirSync(join(FIXTURE, "events"))) out.push(`events/${name}`);
  return out.sort();
}

describe("[A7.3.15.importer.fixture] the synthetic prototype parses as its index states", () => {
  test("the input copy holds exactly the inputs, byte for byte, and nothing changed", () => {
    expect(copy.problems).toEqual([]);
    expect(copy.ok).toBe(true);
    expect(readProblems).toEqual([]);
    expect(copy.files.map((f) => f.path).sort()).toEqual(fixtureInputs());
    for (const f of copy.files) {
      const bytes = readFileSync(join(FIXTURE, ...f.path.split("/")));
      expect(f.sha256, f.path).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(f.size, f.path).toBe(bytes.length);
      const copied = readFileSync(join(work, "input", ...f.path.split("/")));
      expect(copied.equals(bytes), f.path).toBe(true);
    }
  });

  test("every task line: id, group, title, body and flags, in file order", () => {
    const got = parse.tasks.map((t) => ({
      id: t.id,
      file: t.file,
      line: t.line,
      group: t.group,
      title: t.title,
      body: t.body,
      marked: t.marked,
      checked: t.checked,
      done: t.done,
      metadata: parse.metadata.has(t.id),
    }));
    expect(got).toEqual(index.tasks);
  });

  test("the counts equal the index's ledger counts", () => {
    expect(parse.counts).toEqual(index.counts);
  });

  test("every case named in the index gives what the index states", () => {
    const consumed = new Map<Record<string, unknown>, Set<string>>();
    const want = (w: Where, key: string): unknown => {
      const e = w.expect ?? {};
      const seen = consumed.get(e) ?? new Set<string>();
      seen.add(key);
      consumed.set(e, seen);
      return e[key];
    };
    const has = (w: Where, key: string) => w.expect !== undefined && key in w.expect;

    for (const [name, { where }] of Object.entries(index.cases)) {
      expect(where.length, name).toBeGreaterThan(0);
      for (const w of where) {
        const label = `${name} @ ${w.file}${w.line === undefined ? "" : `:${String(w.line)}`}`;

        // Ledger lines: the task found there and every field the case states.
        if (/^(TODO|DONE)\.md$/.test(w.file)) {
          const line = w.line ?? 0;
          const found = taskAt(w.file, line);
          if (w.task !== undefined) expect(found?.id, label).toBe(w.task);
          if (has(w, "taskLine")) expect(found !== undefined, label).toBe(want(w, "taskLine"));
          for (const key of ["id", "title", "body", "marked", "checked", "done"] as const) {
            if (has(w, key)) expect(found?.[key], `${label} ${key}`).toBe(want(w, key));
          }
          if (has(w, "end")) {
            const ends: Record<string, string> = {
              CR: "\r",
              "U+000B": "\v",
              "U+000C": "\f",
              "U+001C": "\x1c",
              "U+001D": "\x1d",
              "U+001E": "\x1e",
              "U+0085": "\x85",
              "U+2028": String.fromCharCode(0x2028),
              "U+2029": String.fromCharCode(0x2029),
            };
            const end = splitLines(fixtureText(w.file))[line - 1]?.end;
            expect(end, label).toBe(ends[String(want(w, "end"))]);
          }
          if (has(w, "marker")) {
            const marker = String(want(w, "marker"));
            expect(splitLines(fixtureText(w.file))[line - 1]?.text, label).toContain(
              `<!-- task:${marker} -->`,
            );
            expect(taskById(marker), label).toBeUndefined();
            expect(parse.orphans.includes(marker), label).toBe(marker in rawMetadata);
          }
          if (has(w, "group")) {
            const next = parse.tasks.find((t) => t.file === w.file && t.line > line);
            expect(next?.group, label).toBe(want(w, "group"));
          }
        }

        // Metadata: each field parses to its typed value, an invalid date is dropped and reported,
        // a missing field stays missing, and an unknown key is kept as written.
        if (w.file === "data/metadata.json") {
          const id = w.task ?? "";
          expect(id in rawMetadata, label).toBe(true);
          const entry = parse.metadata.get(id);
          expect(entry, label).toBeDefined();
          if (entry !== undefined && w.key !== undefined) {
            const raw = rawMetadata[id]?.[w.key];
            const value = parsedField(entry, w.key);
            if (name.endsWith("-invalid") || name === "invalid-date") {
              expect(typeof raw, label).toBe("string");
              expect(value, label).toBeUndefined();
              expect(parse.problems, label).toContainEqual({
                code: "date-invalid",
                severity: "warning",
                file: "data/metadata.json",
                task: id,
                field: w.key,
              });
            } else {
              expect(value, label).toEqual(expected(w.key, raw));
            }
          }
        }

        // Events: the file, its event, whether it counts, and the folded state of its task.
        if (w.file.startsWith("events/")) {
          const name = w.file.slice("events/".length);
          const result = parse.events.files.find((f) => f.name === name);
          expect(result, label).toBeDefined();
          expect(result?.event?.id, label).toBe(w.event);
          expect(result?.event?.task, label).toBe(w.task);
          const state = parse.events.state.get(w.task ?? "");
          if (has(w, "counted")) expect(result?.counted, label).toBe(want(w, "counted"));
          if (has(w, "checked")) {
            expect(state?.check?.checked ?? false, label).toBe(want(w, "checked"));
          }
          if (has(w, "starred")) {
            expect(state?.star?.starred ?? false, label).toBe(want(w, "starred"));
          }
          if (has(w, "focusOn")) expect(state?.star?.day, label).toBe(want(w, "focusOn"));
        }
      }
    }

    // What each case means beyond the fields above.
    const where = (name: string) => index.cases[name]?.where ?? [];
    const task = (w: Where) => taskAt(w.file, w.line ?? 0);
    for (const w of where("added-clause")) {
      expect(task(w)?.added?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(task(w)?.added?.agent).toMatch(/^(codex|claude)$/);
    }
    for (const w of where("no-added-clause")) expect(task(w)?.added).toBeUndefined();
    for (const w of where("done-with-suffix")) expect(task(w)?.completion?.evidence).toBeTruthy();
    for (const w of where("done-without-suffix")) expect(task(w)?.completion).toBeUndefined();
    for (const w of where("done-reconciled")) {
      expect(task(w)?.completion).toEqual({ date: want(w, "date"), evidence: want(w, "evidence") });
      want(w, "from");
    }
    for (const w of where("done-reconciled-fallback")) {
      const t = task(w);
      expect(t?.id).toBe(want(w, "id"));
      expect(t?.id).toBe(fallbackId(String(want(w, "todoGroup")), t?.title ?? ""));
      expect(fallbackId(t?.group ?? "", t?.title ?? "")).toBe(want(w, "fallbackHere"));
    }
    for (const name of ["non-ascii-fallback", "astral-fallback"]) {
      for (const w of where(name)) {
        const t = task(w);
        expect(fallbackId(t?.group ?? "", t?.title ?? "")).toBe(want(w, "id"));
        for (const wrong of ["utf8BytesWouldGive", "utf16UnitsWouldGive"]) {
          if (has(w, wrong)) expect(t?.id).not.toBe(want(w, wrong));
        }
      }
    }
    // The invalid dates in the ledgers: the clause is kept without its day, and reported.
    for (const w of where("invalid-date").filter((x) => x.line !== undefined)) {
      const t = task(w);
      const field = w.file === "DONE.md" ? "done" : "added";
      expect(field === "done" ? t?.completion?.date : t?.added?.date).toBeUndefined();
      expect(field === "done" ? t?.completion : t?.added).toBeDefined();
      expect(parse.problems).toContainEqual({
        code: "date-invalid",
        severity: "warning",
        file: w.file,
        line: w.line,
        task: w.task,
        field,
      });
    }
    for (const w of where("empty-body")) expect(task(w)?.body).toBe("");
    for (const w of where("refs-clause")) expect(task(w)?.body).toMatch(/Refs: \S/);
    for (const w of where("next-set")) expect(parse.metadata.get(w.task ?? "")?.next).toBeTruthy();
    for (const w of where("next-from-body")) {
      const t = taskById(w.task);
      expect(parse.metadata.get(w.task ?? "")?.next).toBeUndefined();
      expect(t?.next).toBeTruthy();
      expect(t?.body).toContain(`Next: ${t?.next ?? ""}.`);
    }
    for (const w of where("next-empty")) {
      expect(parse.metadata.get(w.task ?? "")?.next).toBeUndefined();
      expect(taskById(w.task)?.next).toBeUndefined();
    }
    for (const w of where("repeated-heading")) {
      const heading = splitLines(fixtureText(w.file))[(w.line ?? 0) - 1]?.text ?? "";
      expect(heading.startsWith("## ")).toBe(true);
      const next = parse.tasks.find((t) => t.file === w.file && t.line > (w.line ?? 0));
      expect(next?.group).toBe(heading.slice(3).trim());
    }
    for (const w of where("non-task-line")) expect(task(w)).toBeUndefined();
    for (const w of where("crlf")) {
      expect(splitLines(fixtureText(w.file))[(w.line ?? 0) - 1]?.end).toBe("\r\n");
    }
    for (const w of where("long-title"))
      expect(taskById(w.task)?.title.length).toBeGreaterThan(300);
    for (const w of where("default-group")) expect(task(w)?.group).toBe("Other");
    const toner = where("same-title-two-groups").map((w) => task(w));
    expect(toner).toHaveLength(2);
    expect(toner[0]?.title).toBe(toner[1]?.title);
    expect(toner[0]?.id).not.toBe(toner[1]?.id);
    for (const w of where("marked")) expect(task(w)?.marked).toBe(true);
    for (const w of where("unmarked-task-line")) expect(task(w)?.marked).toBe(false);
    for (const w of where("checked-in-todo")) {
      expect(task(w)?.file).toBe("TODO.md");
      expect(task(w)?.done).toBe(true);
    }
    for (const w of where("metadata-on-fallback-id")) {
      expect(taskById(w.task)?.marked).toBe(false);
      expect(parse.metadata.has(w.task ?? "")).toBe(true);
    }
    for (const w of where("task-line-without-metadata")) {
      expect(parse.withoutMetadata).toContain(w.task);
    }
    expect(parse.withoutMetadata).toHaveLength(where("task-line-without-metadata").length);
    expect([...parse.orphans].sort()).toEqual(
      where("metadata-orphan")
        .map((w) => w.task)
        .sort(),
    );
    for (const w of where("event-web-without-ready")) {
      expect(problemsOf("event-not-ready").map((p) => p.file)).toContain(w.file);
    }
    for (const w of where("event-unknown-task")) {
      expect(taskById(w.task)).toBeUndefined();
      expect(problemsOf("event-unknown-task")).toContainEqual({
        code: "event-unknown-task",
        severity: "warning",
        file: w.file,
        task: w.task,
      });
    }
    for (const w of where("event-on-fallback-id")) expect(taskById(w.task)?.marked).toBe(false);
    // Two events of one task: the one whose outcome the case states applies last.
    for (const name of ["event-tie-by-id", "event-zone-order", "event-time-forms"]) {
      const [a, b] = where(name);
      const last = [a, b].find((w) => w?.expect !== undefined);
      const other = [a, b].find((w) => w !== last);
      const pos = (w: Where | undefined) =>
        parse.events.applied.findIndex((e) => e.id === w?.event);
      expect(pos(last), name).toBeGreaterThan(pos(other));
      expect(pos(other), name).toBeGreaterThanOrEqual(0);
    }
    for (const w of where("jira-row-without-key")) {
      expect(want(w, "skipped")).toBe(true);
      expect(parse.jira.skippedRows).toBe(1);
      expect(problemsOf("jira-row-without-key")).toHaveLength(1);
    }
    for (const w of where("optional-jira")) {
      expect(parse.jira.tickets.map((t) => t.key)).toEqual(want(w, "keys"));
      for (const t of parse.jira.tickets) expect(t.url).toMatch(new RegExp(`/browse/${t.key}$`));
    }
    for (const w of where("optional-audit")) expect(parse.audit.reviewed).toBe(want(w, "reviewed"));
    const copied = new Set(copy.files.map((f) => f.path));
    for (const w of where("not-imported")) {
      expect(statSync(join(FIXTURE, ...w.file.split("/"))).isFile()).toBe(true);
      expect(copied.has(w.file), w.file).toBe(false);
    }

    // Every statement of every case was checked.
    for (const [name, { where: places }] of Object.entries(index.cases)) {
      for (const w of places) {
        const keys = Object.keys(w.expect ?? {}).filter((k) => k !== "note");
        const seen = consumed.get(w.expect ?? {}) ?? new Set();
        for (const k of keys) expect(seen.has(k), `${name}: expect.${k} is not checked`).toBe(true);
      }
    }
  });

  test("the problems are exactly the ones the cases name, and none carries task text", () => {
    const where = (name: string) => index.cases[name]?.where ?? [];
    const wanted = [
      ...where("invalid-date").map((w) => `date-invalid ${w.file} ${w.task ?? ""}`),
      ...where("event-web-without-ready").map((w) => `event-not-ready ${w.file} ${w.task ?? ""}`),
      ...where("event-unknown-task").map((w) => `event-unknown-task ${w.file} ${w.task ?? ""}`),
      ...where("metadata-orphan").map((w) => `metadata-orphan ${w.file} ${w.task ?? ""}`),
      ...where("jira-row-without-key").map((w) => `jira-row-without-key ${w.file} `),
    ].sort();
    const got = parse.problems.map((p) => `${p.code} ${p.file} ${p.task ?? ""}`).sort();
    expect(got).toEqual(wanted);

    const serialised = JSON.stringify(parse.problems);
    for (const t of parse.tasks) {
      expect(serialised).not.toContain(t.title);
      if (t.body.length > 3) expect(serialised).not.toContain(t.body);
    }
  });
});
