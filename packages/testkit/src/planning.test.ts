// The synthetic Planning prototype (A7 3.14 M7.01): its index names every edge case the A7 row
// lists, and each named place holds what the index says. The parse and the fold below are written
// here from the prototype's rules (A7 3.15.2), share no code with the generator,
// and decide what the index must say. The byte-for-byte check of the generated folder against the
// committed fixture is in scripts/seed-planning.test.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSpace } from "@tasks/storage";
import { afterAll, describe, expect, test } from "vitest";
import { checkedDriver, seedMira } from "./mira.ts";
import {
  buildPlanningFixture,
  fnv1a32,
  PLANNING,
  ROW_CASES,
  type CaseLocation,
  type IndexedTask,
} from "./planning.ts";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fixture = buildPlanningFixture();
const { files, index } = fixture;

const text = (path: string): string => {
  const value = files.get(path);
  if (value === undefined) throw new Error(`no file ${path}`);
  return value;
};

// --- The prototype's rules, written independently --------------------------------------------

/** The line ends of Python's str.splitlines(). CR followed by LF is one line end. */
const BREAKS = new Set([
  "\n",
  "\r",
  "\v",
  "\f",
  "\x1c",
  "\x1d",
  "\x1e",
  "\x85",
  "\u2028",
  "\u2029",
]);
interface Line {
  text: string;
  end: string;
}
function splitlines(value: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charAt(i);
    if (!BREAKS.has(c)) continue;
    const end = c === "\r" && value.charAt(i + 1) === "\n" ? "\r\n" : c;
    out.push({ text: value.slice(start, i), end });
    i += end.length - 1;
    start = i + 1;
  }
  if (start < value.length) out.push({ text: value.slice(start), end: "" });
  return out;
}
const lines = (path: string): Line[] => splitlines(text(path));
const lineAt = (where: CaseLocation): Line => {
  if (where.line === undefined) throw new Error(`no line for ${where.file}`);
  const line = lines(where.file)[where.line - 1];
  if (line === undefined) throw new Error(`${where.file} has no line ${String(where.line)}`);
  return line;
};

/** FNV-1a 32-bit over a list of units, in BigInt arithmetic. */
const fnv = (units: Iterable<number>): string => {
  let hash = 2166136261n;
  for (const unit of units) hash = ((hash ^ BigInt(unit)) * 16777619n) % 2n ** 32n;
  return `t-${hash.toString(16).padStart(8, "0")}`;
};
const byCodePoint = (s: string) => fnv(Array.from(s).map((c) => c.codePointAt(0) ?? 0));
const byUtf8 = (s: string) => fnv(Buffer.from(s, "utf8"));
const byUtf16 = (s: string) => fnv(Array.from({ length: s.length }, (_, i) => s.charCodeAt(i)));

const TASK_LINE = /^- \[([ xX])\] \*\*(.+?)\*\*\s*(.*)$/;
const MARKER = /<!-- task:([a-z0-9_-]+) -->/;
const MARKERS = /<!-- task:[a-z0-9_-]+ -->/g;

const where = (name: string): CaseLocation[] => index.cases[name]?.where ?? [];
const metadata = JSON.parse(text("data/metadata.json")) as Record<string, Record<string, unknown>>;
const metaValue = (w: CaseLocation): unknown => metadata[w.task ?? ""]?.[w.key ?? ""];

const isDate = (v: unknown): boolean =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) &&
  new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/** Both ledgers parsed by the prototype's rules: the index's task list must equal this. */
const parsed: IndexedTask[] = (["TODO.md", "DONE.md"] as const).flatMap((file) => {
  let group = "Other";
  return lines(file).flatMap(({ text: line }, i): IndexedTask[] => {
    if (line.startsWith("## ")) {
      group = line.slice(3).trim();
      return [];
    }
    const match = TASK_LINE.exec(line);
    if (match === null) return [];
    const title = (match[2] ?? "").replace(/\.+$/, "");
    const marker = MARKER.exec(line)?.[1];
    const checked = match[1] !== " ";
    return [
      {
        id: marker ?? byCodePoint(`${group}|${title}`),
        file,
        line: i + 1,
        group,
        title,
        body: (match[3] ?? "").replace(MARKERS, "").trim(),
        marked: marker !== undefined,
        checked,
        done: file === "DONE.md" || checked,
        metadata: (marker ?? byCodePoint(`${group}|${title}`)) in metadata,
      },
    ];
  });
});
const taskOn = (w: CaseLocation) => parsed.find((t) => t.file === w.file && t.line === w.line);

interface Event {
  id: string;
  task: string;
  action: string;
  at: string;
}
const AT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/;
/** The instant of an event time, in nanoseconds since the epoch. */
function instant(at: string): bigint {
  const m = AT.exec(at);
  if (m === null) throw new Error(`not an event time: ${at}`);
  const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? "0"));
  const zone = m[8] ?? "Z";
  let ms = Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0, s ?? 0);
  if (zone !== "Z") {
    const minutes = Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6));
    ms -= (zone.startsWith("-") ? -1 : 1) * minutes * 60_000;
  }
  return BigInt(ms) * 1_000_000n + BigInt((m[7] ?? "").padEnd(9, "0"));
}

/** Every events/*.json in sorted file-name order, and whether its file counts. */
const eventFiles = [...files.keys()]
  .filter((path) => /^events\/[^/]+\.json$/.test(path))
  .sort()
  .map((path) => {
    const stem = path.slice("events/".length, -".json".length);
    const event = JSON.parse(text(path)) as Event;
    const counts = !stem.startsWith("web-") || files.has(`events/${stem}.ready`);
    return { path, stem, event, counts };
  });
const counted = eventFiles
  .filter((f) => f.counts)
  .map((f) => f.event)
  .sort((a, b) => {
    const d = instant(a.at) - instant(b.at);
    return d < 0n ? -1 : d > 0n ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
const state = new Map<string, { checked?: boolean; starred?: boolean; focusOn?: string }>();
for (const e of counted) {
  const s = state.get(e.task) ?? {};
  if (e.action === "check" || e.action === "uncheck") s.checked = e.action === "check";
  else {
    s.starred = e.action === "focus";
    // A7 3.15.3: focus_on is the day of the folded focus event, and unfocus clears it.
    if (e.action === "focus") s.focusOn = e.at.slice(0, 10);
    else delete s.focusOn;
  }
  state.set(e.task, s);
}

// ---------------------------------------------------------------------------------------------

describe("[A7.3.14.planning-fixture.index] the synthetic prototype and its index", () => {
  test("the generator is pure: two builds are equal", () => {
    const again = buildPlanningFixture();
    expect([...again.files]).toEqual([...files]);
    expect(again.index).toEqual(index);
  });

  test("every edge case of the A7 row has a place, and every place exists", () => {
    for (const name of ROW_CASES) expect(where(name).length, name).toBeGreaterThan(0);
    for (const [name, { where: places }] of Object.entries(index.cases)) {
      for (const w of places) {
        // The actions export lies beside the folder: its place names an event in it.
        if (w.file === PLANNING.actions) {
          expect(fixture.actions, name).toContain(`"${w.event ?? "-"}"`);
          continue;
        }
        expect(files.has(w.file), `${name}: ${w.file}`).toBe(true);
        if (w.line !== undefined) expect(lineAt(w), name).toBeDefined();
      }
    }
  });

  test("the task list and the counts equal an independent parse of the files", () => {
    // Every field of every indexed task, and every count, comes from parsing the files here, so
    // the index cannot carry an ID, group, title, body, flag or count the files do not.
    const sorted = [...index.tasks].sort((a, b) =>
      a.file === b.file ? a.line - b.line : a.file === "TODO.md" ? -1 : 1,
    );
    expect(sorted).toEqual(parsed);
    // One ID per line, but for the case of an ID in both ledgers, once in each.
    for (const file of ["TODO.md", "DONE.md"]) {
      const ids = parsed.filter((t) => t.file === file).map((t) => t.id);
      expect(new Set(ids).size, file).toBe(ids.length);
    }
    const twice = parsed
      .filter((t) => t.file === "DONE.md")
      .filter((t) => parsed.some((o) => o.file === "TODO.md" && o.id === t.id))
      .map((t) => t.id);
    expect(twice).toEqual([...new Set(where("in-both-ledgers").map((w) => w.task))]);
    const ids = new Set(parsed.map((t) => t.id));
    const paths = [...files.keys()];
    expect(index.counts).toEqual({
      todoTaskLines: parsed.filter((t) => t.file === "TODO.md").length,
      doneTaskLines: parsed.filter((t) => t.file === "DONE.md").length,
      taskLines: parsed.length,
      metadataEntries: Object.keys(metadata).length,
      metadataOrphans: Object.keys(metadata).filter((id) => !ids.has(id)).length,
      taskLinesWithoutMetadata: parsed.filter((t) => !t.metadata).length,
      eventFiles: eventFiles.length,
      readyFiles: paths.filter((p) => /^events\/[^/]+\.ready$/.test(p)).length,
      countedEventFiles: counted.length,
      eventsNotReady: eventFiles.filter((f) => !f.counts).length,
    });
    // A case on a ledger line names the task the parse finds there, and states only what the
    // parse gives: taskLine, and any of id, title, body, marked, checked and done.
    for (const [name, { where: places }] of Object.entries(index.cases)) {
      for (const w of places.filter((p) => p.line !== undefined && /\.md$/.test(p.file))) {
        const label = `${name}: ${w.file}:${String(w.line)}`;
        const found = taskOn(w);
        if (w.task !== undefined) expect(found?.id, label).toBe(w.task);
        const e = w.expect ?? {};
        if ("taskLine" in e) expect(found !== undefined, label).toBe(e["taskLine"]);
        for (const key of ["id", "title", "body", "marked", "checked", "done"] as const) {
          if (key in e) expect(found?.[key], `${label} ${key}`).toBe(e[key]);
        }
      }
    }
  });

  test("lines split as str.splitlines() splits them", () => {
    expect(splitlines("a\r\nb\rc\u2028d\x85e\n")).toEqual([
      { text: "a", end: "\r\n" },
      { text: "b", end: "\r" },
      { text: "c", end: "\u2028" },
      { text: "d", end: "\x85" },
      { text: "e", end: "\n" },
    ]);
    for (const w of where("crlf")) expect(lineAt(w).end, w.file).toBe("\r\n");
    expect(lines("DONE.md").every((l) => l.end === "\r\n")).toBe(true);
    const ends = new Set(lines("TODO.md").map((l) => l.end));
    expect(ends.has("\n") && ends.has("\r\n")).toBe(true);
    // Every separator ends a line somewhere, at least U+0085 and a lone CR on task lines.
    const names: Record<string, string> = {
      CR: "\r",
      "U+000B": "\v",
      "U+000C": "\f",
      "U+001C": "\x1c",
      "U+001D": "\x1d",
      "U+001E": "\x1e",
      "U+0085": "\x85",
      "U+2028": "\u2028",
      "U+2029": "\u2029",
    };
    const seen = new Set<string>();
    for (const w of where("line-separators")) {
      const end = names[String(w.expect?.["end"])];
      expect(lineAt(w).end, `${w.file}:${String(w.line)}`).toBe(end);
      seen.add(String(w.expect?.["end"]));
    }
    expect([...seen].sort()).toEqual(Object.keys(names).sort());
    for (const end of ["\r", "\x85"]) {
      const onTask = lines("TODO.md").some(
        (l, i) => l.end === end && taskOn({ file: "TODO.md", line: i + 1 }) !== undefined,
      );
      expect(onTask, JSON.stringify(end)).toBe(true);
    }
    // U+2028 in the body: a task with a cut body and the fallback ID, then a marker line.
    const [cut, rest] = where("u2028");
    expect(cut && lineAt(cut).end).toBe("\u2028");
    expect(cut && taskOn(cut)?.marked).toBe(false);
    expect(rest && taskOn(rest)).toBeUndefined();
    expect(rest && MARKER.exec(lineAt(rest).text)?.[1]).toBe(rest?.expect?.["marker"]);
    expect(where("metadata-orphan").some((w) => w.task === rest?.expect?.["marker"])).toBe(true);
    // U+2028 in the title: no task line at all, and its marker is no task's ID.
    const lost = where("u2028-in-title");
    expect(lost).toHaveLength(2);
    expect(lost.map((w) => taskOn(w))).toEqual([undefined, undefined]);
    expect(parsed.some((t) => t.id === lost[1]?.expect?.["marker"])).toBe(false);
  });

  test("the fallback ID is FNV-1a over code points, not UTF-8 bytes or UTF-16 units", () => {
    // Published FNV-1a 32-bit test vectors (ASCII: every reading agrees).
    for (const [input, hash] of [
      ["", 0x811c9dc5],
      ["a", 0xe40c292c],
      ["foobar", 0xbf9cf968],
    ] as const) {
      expect(fnv1a32(input)).toBe(hash);
      expect(byCodePoint(input)).toBe(`t-${hash.toString(16)}`);
    }
    const unmarked = index.tasks.filter((t) => !t.marked);
    expect(unmarked.length).toBeGreaterThanOrEqual(5);
    const key = (w: CaseLocation) => {
      const t = taskOn(w);
      return `${t?.group ?? ""}|${t?.title ?? ""}`;
    };
    // Below U+0800: code points and UTF-16 units agree, UTF-8 bytes do not.
    const [narrow] = where("non-ascii-fallback");
    const n = narrow ? key(narrow) : "";
    expect(Array.from(n).some((c) => (c.codePointAt(0) ?? 0) > 0x7f)).toBe(true);
    expect(Array.from(n).every((c) => (c.codePointAt(0) ?? 0) < 0x800)).toBe(true);
    expect(narrow?.expect?.["id"]).toBe(byCodePoint(n));
    expect(narrow?.expect?.["id"]).toBe(byUtf16(n));
    expect(narrow?.expect?.["utf8BytesWouldGive"]).toBe(byUtf8(n));
    expect(byUtf8(n)).not.toBe(byCodePoint(n));
    // Above U+FFFF: all three differ.
    const [astral] = where("astral-fallback");
    const a = astral ? key(astral) : "";
    expect(Array.from(a).some((c) => (c.codePointAt(0) ?? 0) > 0xffff)).toBe(true);
    expect(astral?.expect?.["id"]).toBe(byCodePoint(a));
    expect(astral?.expect?.["utf8BytesWouldGive"]).toBe(byUtf8(a));
    expect(astral?.expect?.["utf16UnitsWouldGive"]).toBe(byUtf16(a));
    expect(new Set([byCodePoint(a), byUtf8(a), byUtf16(a)]).size).toBe(3);
    const toner = where("same-title-two-groups").map((w) => w.task);
    expect(toner).toHaveLength(2);
    expect(new Set(toner).size).toBe(2);
  });

  test("the line cases hold what they name", () => {
    const at = (w: CaseLocation) => lineAt(w).text;
    for (const w of where("trailing-dots")) expect(at(w)).toMatch(/\.\*\*/);
    expect(where("trailing-dots").some((w) => /\.\.\*\*/.test(at(w)))).toBe(true);
    const checked = where("checked-in-todo").map((w) => at(w).slice(0, 5));
    expect(new Set(checked)).toEqual(new Set(["- [x]", "- [X]"]));
    for (const w of where("checked-in-todo")) {
      expect(w.file).toBe("TODO.md");
      expect(taskOn(w)?.done).toBe(true);
    }
    for (const w of where("repeated-heading")) {
      const group = at(w).slice(3).trim();
      const before = lines(w.file).slice(0, (w.line ?? 0) - 1);
      expect(before.some((l) => l.text.startsWith("## ") && l.text.slice(3).trim() === group)).toBe(
        true,
      );
    }
    for (const w of where("heading-trimmed")) {
      expect(at(w)).not.toBe(at(w).trimEnd());
      const next = parsed.find((t) => t.file === w.file && t.line > (w.line ?? 0));
      expect(next?.group).toBe(w.expect?.["group"]);
    }
    for (const w of where("done-with-suffix")) {
      expect(w.file).toBe("DONE.md");
      // The clause ends the body, before the marker when there is one.
      expect(at(w)).toMatch(/\(done [^;)]+; [^)]+\)( <!-- task:[a-z0-9_-]+ -->)?$/);
    }
    for (const w of where("done-without-suffix")) {
      expect(w.file).toBe("DONE.md");
      expect(at(w)).not.toContain("(done ");
    }
    for (const w of where("done-unchecked-box")) {
      expect(at(w).startsWith("- [ ]")).toBe(true);
      expect(taskOn(w)?.done).toBe(true);
    }
    // reconcile's own lines: from the TODO line, after the first line, between blank lines.
    const done = lines("DONE.md");
    const firstHeading = done.findIndex((l) => l.text.startsWith("## "));
    const reconciled = where("done-reconciled");
    expect(reconciled.length).toBeGreaterThanOrEqual(2);
    for (const w of reconciled) {
      const e = w.expect ?? {};
      const written =
        String(e["from"]).replace(MARKERS, "").replace("- [ ]", "- [x]").trimEnd() +
        ` (done ${String(e["date"])}; ${String(e["evidence"])}) <!-- task:${w.task ?? ""} -->`;
      expect(at(w)).toBe(written);
      const i = (w.line ?? 0) - 1;
      expect(i).toBeGreaterThan(0);
      expect(i).toBeLessThan(firstHeading);
      expect([done[i - 1]?.text, done[i + 1]?.text]).toEqual(["", ""]);
      expect(taskOn(w)?.group).toBe("Other");
    }
    for (const w of where("done-reconciled-fallback")) {
      const t = taskOn(w);
      expect(String(reconciled.find((r) => r.line === w.line)?.expect?.["from"])).not.toMatch(
        MARKER,
      );
      expect(t?.id).toBe(byCodePoint(`${String(w.expect?.["todoGroup"])}|${t?.title ?? ""}`));
      expect(w.expect?.["fallbackHere"]).toBe(byCodePoint(`Other|${t?.title ?? ""}`));
      expect(t?.id).not.toBe(w.expect?.["fallbackHere"]);
    }
    for (const w of where("marker-in-title")) {
      expect(MARKER.test(TASK_LINE.exec(at(w))?.[2] ?? "")).toBe(true);
    }
    for (const w of where("two-markers")) expect(at(w).match(MARKERS)).toHaveLength(2);
    for (const w of where("non-task-line")) {
      expect(TASK_LINE.test(at(w)) || at(w).startsWith("## "), at(w)).toBe(false);
    }
    for (const w of where("long-title")) {
      expect(index.tasks.find((t) => t.id === w.task)?.title.length).toBeGreaterThan(300);
    }
    for (const w of where("default-group")) expect(taskOn(w)?.group).toBe("Other");
    expect(new Set(where("default-group").map((w) => w.file))).toEqual(
      new Set(["TODO.md", "DONE.md"]),
    );
  });

  test("the metadata cases hold what they name", () => {
    const statuses: Record<string, string | undefined> = {
      "status-open": "open",
      "status-waiting": "waiting",
      "status-needs-review": "needs_review",
      "status-delegated": "delegated",
      "status-backlog": "backlog",
      "status-missing-waiting-title": undefined,
      "status-missing-open": undefined,
    };
    for (const [name, status] of Object.entries(statuses)) {
      for (const w of where(name)) expect(metaValue(w), name).toBe(status);
    }
    const title = (id: string | undefined) => index.tasks.find((t) => t.id === id)?.title ?? "";
    for (const w of where("status-missing-waiting-title")) {
      expect(title(w.task).startsWith("Waiting on ")).toBe(true);
    }
    for (const w of where("status-missing-open")) {
      expect(title(w.task).startsWith("Waiting on ")).toBe(false);
    }
    for (const name of ["reviewed", "source-date", "due"]) {
      for (const w of where(`${name}-valid`)) expect(isDate(metaValue(w)), name).toBe(true);
      for (const w of where(`${name}-invalid`)) {
        expect(typeof metaValue(w), name).toBe("string");
        expect(isDate(metaValue(w)), name).toBe(false);
      }
      for (const w of where(`${name}-missing`)) expect(metaValue(w), name).toBeUndefined();
    }
    for (const name of Object.keys(index.cases).filter((n) => n.endsWith("-missing"))) {
      for (const w of where(name).filter((x) => x.key !== undefined)) {
        expect(metaValue(w), name).toBeUndefined();
      }
    }
    // The confidence cases name the kind of text they hold: each must really be that kind.
    const confidence: Record<string, RegExp> = {
      "confidence-word": /^[A-Za-z]+$/,
      "confidence-number": /^\d+(\.\d+)?%?$/,
      "confidence-free-text": /\S\s+\S+\s+\S/,
    };
    for (const [name, shape] of Object.entries(confidence)) {
      expect(where(name).length, name).toBeGreaterThan(0);
      for (const w of where(name)) {
        expect(typeof metaValue(w), name).toBe("string");
        expect(String(metaValue(w)), name).toMatch(shape);
      }
    }
    for (const w of where("generic-source-label")) {
      const sources = metaValue(w) as { label: string }[];
      expect(sources.some((s) => s.label === "Email" || s.label === "Chat")).toBe(true);
    }
    const roots = Object.values(PLANNING.roots);
    const under = (path: string) => roots.some((r) => path === r || path.startsWith(`${r}/`));
    for (const w of where("path-outside-roots")) {
      expect((metaValue(w) as string[]).some((p) => !under(p))).toBe(true);
    }
    for (const w of where("path-in-root"))
      expect(under((metaValue(w) as string[])[0] ?? "")).toBe(true);
    const ranks = where("rank-tie").map((w) => [metadata[w.task ?? ""]?.["project"], metaValue(w)]);
    expect(ranks).toHaveLength(2);
    expect(ranks[0]).toEqual(ranks[1]);
    for (const w of where("metadata-orphan")) {
      expect(w.task !== undefined && w.task in metadata).toBe(true);
      expect(parsed.some((t) => t.id === w.task)).toBe(false);
    }
    for (const w of where("task-line-without-metadata"))
      expect(metadata[w.task ?? ""]).toBeUndefined();
  });

  test("the optional files have the prototype's shapes", () => {
    const jira = JSON.parse(text("data/jira.json")) as unknown;
    expect(Array.isArray(jira)).toBe(true);
    const rows = jira as Record<string, unknown>[];
    const keyed = rows.filter((r) => typeof r["key"] === "string");
    expect(keyed.map((r) => r["key"])).toEqual(where("optional-jira")[0]?.expect?.["keys"]);
    expect(rows.length - keyed.length).toBe(where("jira-row-without-key").length);
    for (const r of keyed) {
      expect(String(r["url"])).toMatch(new RegExp(`/browse/${String(r["key"])}$`));
    }
    const audit = JSON.parse(text("data/audit.json")) as unknown;
    expect(audit !== null && typeof audit === "object" && !Array.isArray(audit)).toBe(true);
    const reviewed = (audit as Record<string, unknown>)["reviewed"];
    expect(typeof reviewed).toBe("string");
    expect(reviewed).toBe(where("optional-audit")[0]?.expect?.["reviewed"]);
    const shape = Object.values(audit as Record<string, unknown>).map((v) => typeof v);
    expect(shape).toContain("object");
    expect(Array.isArray(JSON.parse(text("data/metadata.json")))).toBe(false);
  });

  test("shared sources: two active legacy tasks with one ticket, and the Mira space's key", async () => {
    const shared = where("shared-source-legacy");
    expect(shared).toHaveLength(2);
    const urls = shared.map((w) => (metaValue(w) as { url: string }[]).map((s) => s.url));
    const common = urls[0]?.filter((u) => urls[1]?.includes(u)) ?? [];
    expect(common).toHaveLength(1);
    expect(common[0]).toMatch(/\/browse\/[A-Z]+-\d+$/);
    for (const w of shared) {
      const task = index.tasks.find((t) => t.id === w.task);
      expect(task?.file).toBe("TODO.md");
      expect(task?.done).toBe(false);
      expect(eventFiles.some((f) => f.event.task === w.task)).toBe(false);
    }
    const tasks = where("shared-source-space");
    expect(tasks).toHaveLength(1);
    const key = index.spaceTask.key.replace(/^jira:/, "");
    expect(
      (metaValue(tasks[0] ?? { file: "" }) as { url: string }[]).some((s) =>
        s.url.endsWith(`/browse/${key}`),
      ),
    ).toBe(true);
    // The Mira sample space holds that key on the task the index names. If the Mira generator
    // changes, this fails here first: move the fixture's key, or keep Mira's first source.
    const dir = mkdtempSync(join(tmpdir(), "planning-"));
    made.push(dir);
    const space = await seedMira(dir, { seed: index.spaceTask.seed, tasks: index.spaceTask.tasks });
    const { conn } = openSpace(await checkedDriver(), space.folder, { role: "reader" });
    try {
      const row = conn
        .prepare(
          `SELECT t.ref, t.title FROM sources s JOIN task_sources ts ON ts.source_id = s.id
           JOIN tasks t ON t.id = ts.task_id WHERE s.source_key = $key`,
        )
        .get<{ ref: number; title: string }>({ key: index.spaceTask.key });
      expect(row && { ref: `M-${String(row.ref)}`, title: row.title }).toEqual({
        ref: index.spaceTask.ref,
        title: index.spaceTask.title,
      });
    } finally {
      conn.close();
    }
  }, 60_000);

  test("events: the grammar, the .ready rule by file name, and the fold of every case", () => {
    // Every event file is valid: one invalid file would fail the prototype's read of the folder.
    for (const { path, stem, event: e } of eventFiles) {
      expect(Object.keys(e), path).toEqual(["id", "task", "action", "at"]);
      expect(e.id).toMatch(/^[a-zA-Z0-9_-]{1,100}$/);
      expect(e.task).toMatch(/^[a-zA-Z0-9_-]{1,100}$/);
      expect(["check", "uncheck", "focus", "unfocus"]).toContain(e.action);
      expect(e.at).toMatch(AT);
      expect(stem).toBe(e.id);
    }
    // Writers: the page writes web-<lower-case UUID> compactly; the import command writes two
    // spaces and a final newline, with .ready only for a web- ID.
    const uuid = /^web-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const { path, stem, event } of eventFiles) {
      const body = text(path);
      if (body === JSON.stringify(event)) expect(stem, path).toMatch(uuid);
      else expect(body, path).toBe(`${JSON.stringify(event, null, 2)}\n`);
    }
    for (const path of [...files.keys()].filter((p) => p.endsWith(".ready"))) {
      expect(text(path)).toBe("");
      expect(files.has(path.replace(/\.ready$/, ".json"))).toBe(true);
    }
    for (const w of where("event-import-web")) {
      expect(text(w.file)).toMatch(/\n$/);
      expect(files.has(w.file.replace(/\.json$/, ".ready"))).toBe(true);
    }
    const shapes = where("event-file-shape").map((w) => text(w.file).endsWith("\n"));
    expect(new Set(shapes)).toEqual(new Set([true, false]));
    for (const w of where("event-ready"))
      expect(files.has(`events/${w.event ?? ""}.ready`)).toBe(true);
    for (const w of where("event-web-without-ready")) {
      expect(w.event?.startsWith("web-")).toBe(true);
      expect(files.has(`events/${w.event ?? ""}.ready`)).toBe(false);
      expect(counted.some((e) => e.id === w.event)).toBe(false);
    }
    for (const w of where("event-non-web")) {
      expect(w.event?.startsWith("web-")).toBe(false);
      expect(files.has(`events/${w.event ?? ""}.ready`)).toBe(false);
      expect(counted.some((e) => e.id === w.event)).toBe(true);
    }
    // No two counted times differ by less than a microsecond (Python keeps microseconds).
    const instants = counted.map((e) => instant(e.at));
    for (const [i, t] of instants.entries()) {
      const prev = instants[i - 1];
      if (prev !== undefined && t !== prev) expect(t - prev >= 1000n, String(t)).toBe(true);
    }

    let expectations = 0;
    for (const { where: places } of Object.values(index.cases)) {
      for (const w of places.filter((p) => p.event !== undefined && p.expect !== undefined)) {
        const s = state.get(w.task ?? "") ?? {};
        if ("checked" in (w.expect ?? {}))
          expect(s.checked ?? false, w.event).toBe(w.expect?.["checked"]);
        if ("starred" in (w.expect ?? {}))
          expect(s.starred ?? false, w.event).toBe(w.expect?.["starred"]);
        if ("focusOn" in (w.expect ?? {})) expect(s.focusOn, w.event).toBe(w.expect?.["focusOn"]);
        if ("counted" in (w.expect ?? {})) {
          expect(counted.some((e) => e.id === w.event)).toBe(w.expect?.["counted"]);
        }
        expectations += 1;
      }
    }
    expect(expectations).toBeGreaterThan(5);
    // Rollback: one checked, one unchecked after a check, one starred, one unstarred after a star.
    const task = (name: string) => where(name)[0]?.task ?? "";
    expect(state.get(task("rollback-checked"))?.checked).toBe(true);
    expect(state.get(task("rollback-unchecked"))?.checked).toBe(false);
    expect(state.get(task("rollback-focus"))?.starred).toBe(true);
    expect(state.get(task("rollback-unfocus"))?.starred).toBe(false);
    // The zone and time-form cases are real: text order and instant order disagree on each.
    for (const name of ["event-zone-order", "event-time-forms"]) {
      const [a, b] = where(name).map((w) => eventFiles.find((f) => f.stem === w.event)?.event);
      if (a === undefined || b === undefined) throw new Error(`${name}: two events`);
      const byInstant = instant(a.at) < instant(b.at);
      expect(byInstant, name).toBe(!(a.at < b.at));
    }
    const tie = where("event-tie-by-id").map(
      (w) => eventFiles.find((f) => f.stem === w.event)?.event,
    );
    expect(new Set(tie.map((e) => (e ? instant(e.at) : -1n))).size).toBe(1);
  });

  test("the actions export holds every event the page knows, sorted, and adds the uncounted", () => {
    const exported = JSON.parse(fixture.actions) as { version: number; events: Event[] };
    expect(exported.version).toBe(1);
    expect(exported.events).toHaveLength(index.actions.events);
    // Every event of events/ is in it as written, the web- one without .ready too.
    for (const { event } of eventFiles) expect(exported.events).toContainEqual(event);
    const sorted = [...exported.events].sort((a, b) => {
      const d = instant(a.at) / 1_000_000n - instant(b.at) / 1_000_000n;
      return d < 0n ? -1 : d > 0n ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    expect(exported.events).toEqual(sorted);
    const ids = new Set(exported.events.map((e) => e.id));
    expect(ids.size).toBe(exported.events.length);
    const countedIds = new Set(counted.map((e) => e.id));
    expect(
      exported.events
        .filter((e) => !countedIds.has(e.id))
        .map((e) => e.id)
        .sort(),
    ).toEqual(index.actions.added);
    expect(index.actions.file).toBe(`fixtures/${PLANNING.actions}`);
  });

  test("fixture text only: every host is a reserved example domain, every path is Mira's", () => {
    const all = [...files.values()].join("\n");
    const hosts = [...all.matchAll(/https?:\/\/([^/\s"'<>]+)/g)].map((m) => m[1] ?? "");
    expect(hosts.length).toBeGreaterThan(5);
    for (const host of hosts) expect(host, host).toMatch(/(^|\.)example(\.(org|com|net))?$/);
    for (const entry of Object.values(metadata)) {
      for (const path of (entry["paths"] as string[] | undefined) ?? []) {
        expect(path).toMatch(/^\/(home\/mira|mnt\/shed)\//);
      }
    }
  });
});
