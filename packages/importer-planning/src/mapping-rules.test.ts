// The mapping's rules on small synthetic inputs (A7 3.15.1, 3.15.3): what the fixture cannot show
// in one folder. Source kinds and keys, generic labels, slugs, roots, days and instants in a zone,
// cutting and SafeText with their problems, duplicates, orphans, unknown metadata keys, and a plan
// that is pure and deterministic and binds its drafts to IDs. Hosts are reserved example domains.
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  bindOperations,
  classifyUrl,
  cutAtWord,
  eventMillis,
  groupSlug,
  isGenericLabel,
  isTimeZone,
  localDay,
  mapPrototype,
  MappingOptionsError,
  nineOClock,
  parsePrototype,
  placeFor,
  shortUrl,
  type ImportPlan,
  type MappingOptions,
  type PlannedOp,
  type PlannedTaskCreate,
  type PrototypeInput,
} from "./index.ts";

const ZONE = "Europe/Amsterdam";
const options: MappingOptions = {
  me: "Mira Okafor",
  roots: { work: "/home/mira/work" },
  timeZone: ZONE,
};

function plan(input: Partial<PrototypeInput>, more: Partial<MappingOptions> = {}): ImportPlan {
  return mapPrototype(
    parsePrototype({ todo: "", done: "", ...input, events: input.events ?? [] }),
    { ...options, ...more },
  );
}
const metadata = (entries: Record<string, unknown>): string => JSON.stringify(entries);
const createOf = (p: ImportPlan, id: string): PlannedTaskCreate =>
  p.tasks.find((t) => t.legacyId === id)?.ops[0] as PlannedTaskCreate;
const opsOf = <K extends PlannedOp["kind"]>(p: ImportPlan, id: string, kind: K) =>
  (p.tasks.find((t) => t.legacyId === id)?.ops ?? []).filter(
    (o): o is Extract<PlannedOp, { kind: K }> => o.kind === kind,
  );
const codes = (p: ImportPlan, id?: string) =>
  p.problems
    .filter((x) => id === undefined || x.task === id)
    .map((x) => `${x.code} ${x.field ?? ""}`);
const line = (title: string, id: string, body = "") =>
  `- [ ] **${title}** ${body} <!-- task:${id} -->\n`;

afterEach(() => {
  vi.useRealTimers();
});

describe("[A7.3.15.importer.mapping-rules] the mapping's rules on small inputs", () => {
  test("a source's kind, key and ref come from its URL", () => {
    const cases: [string, string, string | undefined][] = [
      ["mailto:tomas@mail.lumen.example", "email", "url:mailto:tomas@mail.lumen.example"],
      ["https://tickets.lumen.example/browse/lum-12", "ticket", "jira:LUM-12"],
      ["https://tickets.lumen.example/browse/LUM-12/?focus=1", "ticket", "jira:LUM-12"],
      [
        "https://tickets.lumen.example/browse/LUM",
        "web",
        "url:https://tickets.lumen.example/browse/LUM",
      ],
      ["https://git.example.org/o/r/pull/3", "pr", "url:https://git.example.org/o/r/pull/3"],
      [
        "https://git.example.org/g/sub/p/-/merge_requests/4",
        "pr",
        "url:https://git.example.org/g/sub/p/-/merge_requests/4",
      ],
      ["https://git.example.org/o/r/issues/9", "issue", "url:https://git.example.org/o/r/issues/9"],
      ["https://git.example.org/issues/9", "web", "url:https://git.example.org/issues/9"],
      [
        "https://outlook.lumen.example/mail/id/A1",
        "email",
        "url:https://outlook.lumen.example/mail/id/A1",
      ],
      ["https://teams.lumen.example/c/1", "chat", "url:https://teams.lumen.example/c/1"],
      [
        "https://calendar.mira.example/e?eid=1",
        "calendar",
        "url:https://calendar.mira.example/e?eid=1",
      ],
      ["https://sheets.lumen.example/d/1", "doc", "url:https://sheets.lumen.example/d/1"],
      ["https://www.example.org/x", "web", "url:https://www.example.org/x"],
    ];
    for (const [url, kind, key] of cases) {
      expect(classifyUrl(url), url).toMatchObject({ kind, key });
    }
    expect(classifyUrl("https://tickets.lumen.example/browse/lum-12").ref).toBe("LUM-12");
    expect(classifyUrl("no url at all")).toEqual({ kind: "web", keyProblem: "unparsed" });
    const long = `https://www.example.org/${"a".repeat(600)}`;
    expect(classifyUrl(long)).toEqual({ kind: "web", keyProblem: "too-long" });
  });

  test("a url: key lower-cases scheme and host, drops utm_* and a fragment without a route", () => {
    const key = (url: string) => classifyUrl(url).key;
    expect(key("HTTPS://WWW.Example.ORG/Path?utm_source=x&a=1&UTM_medium=y#section")).toBe(
      "url:https://www.example.org/Path?a=1",
    );
    expect(key("https://www.example.org/p?utm_source=x")).toBe("url:https://www.example.org/p");
    // A route fragment names the item: two threads of one mailbox are two keys.
    const a = key("https://mail.lumen.example/mail/u/0/#inbox/AAA");
    const b = key("https://mail.lumen.example/mail/u/0/#inbox/BBB");
    expect(a).toBe("url:https://mail.lumen.example/mail/u/0/#inbox/AAA");
    expect(a).not.toBe(b);
    // Other parameters keep their spelling.
    expect(key("https://www.example.org/s?q=a+b&r=%20")).toBe(
      "url:https://www.example.org/s?q=a+b&r=%20",
    );
  });

  test("a label that only names the kind is generic; its title is a short form of the URL", () => {
    for (const label of ["", "Email", " chat. ", "Mail:", "PR", "pull request", "Link"]) {
      expect(isGenericLabel(label), label).toBe(true);
    }
    for (const label of ["LUM-1000 Appointment times", "Email from Tomas", "Chat with Aiko"]) {
      expect(isGenericLabel(label), label).toBe(false);
    }
    expect(shortUrl("https://www.example.org/a/b/")).toBe("example.org/a/b");
    expect(shortUrl("https://mail.lumen.example/mail/u/0/#inbox/A1")).toBe(
      "mail.lumen.example/mail/u/0/#inbox/A1",
    );
    const short = shortUrl(`https://www.example.org/${"b".repeat(200)}`);
    expect(Array.from(short)).toHaveLength(80);
    expect(short.endsWith("…")).toBe(true);
    expect(isGenericLabel(`${".".repeat(200_000)}x`)).toBe(false);
  });

  test("slugs: letters and digits, a project's trailing (…) ignored, linear on long text", () => {
    expect(groupSlug("Open source", "area")).toBe("open-source");
    expect(groupSlug("Clinic sync (Q4)", "project")).toBe("clinic-sync");
    expect(groupSlug("Clinic sync (Q4)", "area")).toBe("clinic-sync-q4");
    expect(groupSlug("(Q4)", "project")).toBe("q4");
    expect(groupSlug("Ålborg Kontor", "area")).toBe("alborg-kontor");
    expect(groupSlug("日本", "area")).toBe("area");
    expect(groupSlug("日本", "project")).toBe("project");
    expect(groupSlug("x".repeat(100), "area")).toHaveLength(48);
    const started = performance.now();
    groupSlug(`x${" ".repeat(200_000)}(y`, "project");
    groupSlug(`x${"(".repeat(200_000)})`, "project");
    // Linear: well under the time a quadratic scan of 200,000 characters takes.
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test("a path's place: the longest root by whole segments, never a climb or a hidden character", () => {
    const roots = { work: "/home/mira/work", lumen: "/home/mira/work/lumen" };
    expect(placeFor("/home/mira/work/lumen/portal", roots)).toEqual({
      root: "lumen",
      path: "portal",
    });
    expect(placeFor("/home/mira/work/oss/./a//b/", roots)).toEqual({
      root: "work",
      path: "oss/a/b",
    });
    expect(placeFor("/home/mira/work", roots)).toEqual({ root: "work", path: "" });
    expect(placeFor("/home/mira/workshop/x", roots)).toBeUndefined();
    expect(placeFor("/home/mira/work/../secret", roots)).toBeUndefined();
    expect(placeFor("/Home/mira/work/x", roots)).toBeUndefined();
    expect(placeFor("work/x", roots)).toBeUndefined();
    expect(placeFor("/home/mira/work/a\u200bb", roots)).toBeUndefined();
    expect(placeFor("/home/mira/work/a\\b", roots)).toBeUndefined();
    const windows = { work: "C:\\Users\\Mira\\Work" };
    expect(placeFor("c:\\users\\mira\\work\\Lumen\\Portal", windows)).toEqual({
      root: "work",
      path: "Lumen/Portal",
    });
    expect(placeFor("/home/mira/work/x", windows)).toBeUndefined();
  });

  test("a day is 09:00 in the import's zone; a star's day is the instant's day there", () => {
    expect(nineOClock("2026-10-05", ZONE)).toBe(Date.parse("2026-10-05T07:00:00Z"));
    expect(nineOClock("2026-11-07", ZONE)).toBe(Date.parse("2026-11-07T08:00:00Z"));
    // The day the clocks go forward at 02:00: 09:00 is summer time.
    expect(nineOClock("2026-03-29", ZONE)).toBe(Date.parse("2026-03-29T07:00:00Z"));
    expect(nineOClock("2026-11-03", "Pacific/Auckland")).toBe(Date.parse("2026-11-02T20:00:00Z"));
    expect(nineOClock("2026-11-03", "UTC")).toBe(Date.parse("2026-11-03T09:00:00Z"));
    // Outside the space's range: 1970 to 9999.
    expect(nineOClock("1969-12-31", "UTC")).toBeUndefined();
    // Sydney was at UTC+10 in January 1970: 09:00 there is 23:00 on 31 December, out of range.
    expect(nineOClock("1970-01-01", "Australia/Sydney")).toBeUndefined();
    expect(nineOClock("1970-01-01", "Europe/London")).toBe(Date.parse("1970-01-01T08:00:00Z"));
    expect(nineOClock("9999-12-31", "America/Los_Angeles")).toBe(
      Date.parse("9999-12-31T17:00:00Z"),
    );
    expect(nineOClock("0099-05-01", "UTC")).toBeUndefined();
    expect(localDay(Date.parse("2026-11-03T07:00:00Z"), "America/Los_Angeles")).toBe("2026-11-02");
    expect(localDay(Date.parse("2026-11-03T07:00:00Z"), ZONE)).toBe("2026-11-03");
    expect(eventMillis("2026-11-06T07:45:00.123456789Z")).toBe(
      Date.parse("2026-11-06T07:45:00.123Z"),
    );
    expect(eventMillis("2026-11-05T09:30+02:00")).toBe(Date.parse("2026-11-05T07:30:00Z"));
    expect(eventMillis("1969-12-31T23:59:59Z")).toBeUndefined();
    expect(eventMillis("not a time")).toBeUndefined();
    expect(isTimeZone(ZONE)).toBe(true);
    for (const zone of ["+01:00", "Nowhere/City", "", 7]) expect(isTimeZone(zone)).toBe(false);
  });

  test("a day outside the space's range is dropped and reported wherever it appears", () => {
    const p = plan({
      todo: line("A", "x1", "(added 1969-12-31, codex)") + line("B", "x2"),
      metadata: metadata({
        x1: { due: "0099-05-01", source_date: "1969-01-01", reviewed: "2026-11-01" },
        x2: { due: "2026-11-20" },
      }),
    });
    const create = createOf(p, "x1");
    expect(create.due).toBeUndefined();
    expect(create.source_at).toBeUndefined();
    expect(create.created_at).toBeUndefined();
    expect(create.reviewed_at).toBe(Date.parse("2026-11-01T08:00:00Z"));
    expect(create.ext.planning["added_by"]).toBe("codex");
    expect(codes(p, "x1").sort()).toEqual(
      ["date-out-of-range added", "date-out-of-range due", "date-out-of-range source_date"].sort(),
    );
    expect(createOf(p, "x2").due).toEqual({ date: "2026-11-20" });
  });

  test("a cut keeps whole words within the limit, counting characters or UTF-8 bytes", () => {
    expect(cutAtWord("aaa bbb ccc", 9, "chars")).toBe("aaa bbb");
    expect(cutAtWord("aaa bbb ccc", 100, "chars")).toBe("aaa bbb ccc");
    expect(cutAtWord("abcdefghij", 4, "chars")).toBe("abcd");
    // A space only near the start: a hard cut, not a stub.
    expect(cutAtWord("a bcdefghij", 6, "chars")).toBe("a bcde");
    expect(cutAtWord("éé éé", 5, "bytes")).toBe("éé");
    expect(cutAtWord("🎂🎂🎂", 2, "chars")).toBe("🎂🎂");
  });

  test("SafeText cleans every text, and each changed field is reported without its text", () => {
    const p = plan({
      todo:
        line("Call\u200b the plumber", "x1", "About the \u202eleak\u202c.") + line("\u200b", "x2"),
      metadata: metadata({
        x1: {
          owner: "Tomas\u2066",
          next: "Ask\u200b about Friday",
          confidence: "high\u200b",
          sources: [{ label: "Bill\u200b", url: "https://www.example.org/b\u200b" }],
          estimate: { text: "2h\u200b" },
        },
      }),
    });
    const create = createOf(p, "x1");
    expect(create.title).toBe("Call the plumber");
    expect(create.context).toBe("About the leak.");
    expect(create.owner).toBe("Tomas");
    expect(create.summary).toBe("Ask about Friday");
    expect(create.ext.planning["confidence"]).toBe("high");
    expect(create.ext.planning["estimate"]).toEqual({ text: "2h" });
    expect(opsOf(p, "x1", "source.add")[0]?.source).toMatchObject({
      title: "Bill",
      url: "https://www.example.org/b",
    });
    expect(codes(p, "x1").sort()).toEqual(
      [
        "text-sanitised title",
        "text-sanitised body",
        "text-sanitised owner",
        "text-sanitised next",
        "text-sanitised confidence",
        "text-sanitised sources",
        "text-sanitised sources",
        "text-sanitised extra",
      ].sort(),
    );
    // A title SafeText empties takes the legacy ID.
    expect(createOf(p, "x2").title).toBe("x2");
    expect(codes(p, "x2")).toEqual(["text-sanitised title", "title-empty title"]);
    const serialised = JSON.stringify(p.problems);
    for (const text of ["plumber", "leak", "Tomas", "Friday", "Bill", "example.org"]) {
      expect(serialised).not.toContain(text);
    }
  });

  test("texts over the space's limits are cut and reported", () => {
    const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");
    const p = plan({
      todo: line("Short", "x1"),
      done: `- [x] **Done** (done 2026-10-01; ${words(1000)}) <!-- task:x2 -->\n`,
      metadata: metadata({
        x1: { next: words(100), owner: words(70), evidence: words(4000) },
      }),
    });
    const create = createOf(p, "x1");
    expect(Array.from(create.summary ?? "").length).toBeLessThanOrEqual(400);
    expect(Array.from(create.owner ?? "").length).toBeLessThanOrEqual(300);
    const evidence = opsOf(p, "x1", "log.add").find((o) => o.log_kind === "evidence");
    expect(Buffer.byteLength(evidence?.body ?? "")).toBeLessThanOrEqual(16 * 1024);
    expect(codes(p, "x1")).toEqual(["text-cut owner", "text-cut next", "text-cut evidence"]);
    const outcome = opsOf(p, "x2", "task.complete")[0]?.outcome ?? "";
    expect(Buffer.byteLength(outcome)).toBeLessThanOrEqual(4 * 1024);
    expect(codes(p, "x2")).toEqual(["text-cut done"]);
  });

  test("the user is no owner whatever the case and outer spaces of the name", () => {
    const p = plan({
      todo: line("A", "x1") + line("B", "x2"),
      metadata: metadata({ x1: { owner: "  mira okafor " }, x2: { owner: "Noor" } }),
    });
    expect(createOf(p, "x1").owner).toBeUndefined();
    expect(createOf(p, "x2").owner).toBe("Noor");
    expect(p.owners).toEqual([
      { name: "mira okafor", me: true, tasks: 1 },
      { name: "Noor", me: false, tasks: 1 },
    ]);
    // Without --me every owner is another person.
    const noMe = mapPrototype(
      parsePrototype({
        todo: line("A", "x1"),
        done: "",
        events: [],
        metadata: metadata({ x1: { owner: "Mira Okafor" } }),
      }),
      { timeZone: ZONE },
    );
    expect(createOf(noMe, "x1").owner).toBe("Mira Okafor");
  });

  test("a later line with an earlier line's ID is left out: one legacy ID, one task", () => {
    const p = plan({
      todo: line("First", "x1"),
      done: `- [x] **Again** (done 2026-10-01; done) <!-- task:x1 -->\n`,
    });
    expect(p.tasks.map((t) => t.legacyId)).toEqual(["x1"]);
    expect(createOf(p, "x1").title).toBe("First");
    expect(p.counts.duplicatesLeftOut).toBe(1);
  });

  test("project slugs are unique in the space: one name in two areas gets a number", () => {
    const p = plan({
      todo: line("A", "x1") + line("B", "x2") + line("C", "x3"),
      metadata: metadata({
        x1: { category: "Lumen", project: "Admin" },
        x2: { category: "Home", project: "Admin (house)" },
        x3: { category: "Lumen", project: "Admin" },
      }),
    });
    expect(p.projects).toEqual([
      { slug: "admin", title: "Admin", area: "lumen" },
      { slug: "admin-2", title: "Admin (house)", area: "home" },
    ]);
    expect(createOf(p, "x3").project).toBe("admin");
  });

  test("unknown metadata keys: reserved names left out, deep values left out, __proto__ kept", () => {
    let deep: unknown = "end";
    for (let i = 0; i < 40; i += 1) deep = [deep];
    const p = plan({
      todo: line("A", "x1"),
      metadata: `{"x1": {"legacy_id": "other", "deep": ${JSON.stringify(deep)}, "__proto__": {"polluted": true}, "size": 3}}`,
    });
    const ext = createOf(p, "x1").ext.planning;
    expect(ext["legacy_id"]).toBe("x1");
    expect(Object.hasOwn(ext, "deep")).toBe(false);
    expect(Object.hasOwn(ext, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(ext)).toBe(Object.prototype);
    expect(JSON.stringify(ext)).toContain('"__proto__":{"polluted":true}');
    expect(ext["size"]).toBe(3);
    expect(codes(p, "x1")).toEqual(["extra-key-reserved extra", "extra-dropped extra"]);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  test("completions: an empty outcome is pending, a day out of range is unknown, the box wins", () => {
    const p = plan({
      todo: `- [x] **Boxed** <!-- task:x3 -->\n`,
      done:
        `- [x] **Empty** (done 2026-10-01; ) <!-- task:x1 -->\n` +
        `- [x] **Old** (done 1969-07-20; landed) <!-- task:x2 -->\n`,
      events: [
        {
          name: "cli-1.json",
          bytes: JSON.stringify({
            id: "cli-1",
            task: "x3",
            action: "uncheck",
            at: "2026-11-01T10:00:00Z",
          }),
        },
        {
          name: "cli-2.json",
          bytes: JSON.stringify({
            id: "cli-2",
            task: "x1",
            action: "focus",
            at: "2026-11-01T10:00:00Z",
          }),
        },
      ],
    });
    expect(opsOf(p, "x1", "task.complete")).toEqual([
      { kind: "task.complete", task: { draft: "x1" }, at: Date.parse("2026-10-01T07:00:00Z") },
    ]);
    expect(p.tasks.find((t) => t.legacyId === "x1")?.wrap).toBe("pending");
    expect(createOf(p, "x1").focus).toBe("2026-11-01");
    expect(opsOf(p, "x2", "task.complete")).toEqual([
      { kind: "task.complete", task: { draft: "x2" }, outcome: "landed" },
    ]);
    expect(createOf(p, "x2").ext.planning["done_date_unknown"]).toBe(true);
    expect(codes(p, "x2")).toEqual(["date-out-of-range done"]);
    // A checked box completes, at the import time, even when an event unchecked the task.
    expect(opsOf(p, "x3", "task.complete")).toEqual([
      { kind: "task.complete", task: { draft: "x3" } },
    ]);
  });

  test("sources: dropped, keyless, one per key per task, and one title per shared key", () => {
    const p = plan({
      todo: line("A", "x1") + line("B", "x2") + line("C", "x3"),
      jira: JSON.stringify([
        {
          key: "LUM-7",
          summary: "Fix the export",
          url: "https://tickets.lumen.example/browse/LUM-7",
        },
      ]),
      metadata: metadata({
        x1: {
          sources: [
            { label: "Link", url: `https://www.example.org/${"a".repeat(2100)}` },
            { label: "Draft", url: "not a url" },
            { label: "Email", url: "https://www.example.org/s#top" },
            { label: "Email again", url: "https://www.example.org/s" },
            { label: "Ticket", url: "https://tickets.lumen.example/browse/LUM-7" },
          ],
        },
        x2: {
          sources: [
            { label: "Draft", url: "not a url" },
            { label: "", url: "https://www.example.org/s" },
          ],
        },
        x3: { sources: [{ label: "Notes", url: "https://www.example.org/n" }] },
      }),
    });
    expect(codes(p, "x1")).toEqual([
      "source-dropped sources",
      "source-key-unavailable sources",
      "source-key-shared sources",
    ]);
    // One link per key per task; the first named label titles the shared row.
    expect(opsOf(p, "x1", "source.add").map((a) => a.source.title)).toEqual([
      "Draft",
      "Email again",
      "Fix the export",
    ]);
    expect(opsOf(p, "x2", "source.add").map((a) => a.source.title)).toEqual([
      "Draft",
      "Email again",
    ]);
    const shared = p.sources.find((s) => s.key === "url:https://www.example.org/s");
    expect(shared).toMatchObject({ generic: false, tasks: ["x1", "x2"] });
    // A keyless URL is a row of its own for each task that names it.
    expect(p.sources.filter((s) => s.url === "not a url")).toHaveLength(2);
    expect(p.counts.sources).toBe(5);
  });

  test("--include-orphans creates metadata entries without a task line in Backlog", () => {
    const input = {
      todo: line("A", "x1"),
      metadata: metadata({ x1: {}, o1: { next: "Plan it", status: "open" } }),
    };
    expect(plan(input).tasks.map((t) => t.legacyId)).toEqual(["x1"]);
    const p = plan(input, { includeOrphans: true });
    const create = createOf(p, "o1");
    expect(create).toMatchObject({
      title: "o1",
      summary: "Plan it",
      status: "backlog",
      area: "other",
    });
    expect(p.tasks.find((t) => t.legacyId === "o1")?.file).toBe("data/metadata.json");
    // A metadata key is any text. One that no task line could carry as its ID is no prototype
    // task: it is left out and reported, and the problem cannot name it.
    const odd = plan(
      { metadata: metadata({ "​ ": {}, "raw‮id": {}, "M-1": {}, "o-2": {} }) },
      { includeOrphans: true },
    );
    expect(odd.tasks.map((t) => t.legacyId)).toEqual(["o-2"]);
    expect(odd.problems).toEqual([
      { code: "orphan-id-invalid", severity: "warning", file: "data/metadata.json" },
      { code: "orphan-id-invalid", severity: "warning", file: "data/metadata.json" },
      { code: "orphan-id-invalid", severity: "warning", file: "data/metadata.json", task: "M-1" },
    ]);
    expect(odd.counts.orphansIncluded).toBe(1);
  });

  test("an empty metadata next falls back to the body's Next: clause", () => {
    const p = plan({
      todo: line("A", "x1", "Next: call the clinic. More."),
      metadata: metadata({ x1: { next: "  " } }),
    });
    expect(createOf(p, "x1").summary).toBe("call the clinic");
    // The clause's text passes SafeText like every field, and its change is reported as `next`.
    const hidden = plan({ todo: line("A", "x1", "Next: call​ the clinic.") });
    expect(createOf(hidden, "x1").summary).toBe("call the clinic");
    expect(codes(hidden, "x1")).toEqual(["text-sanitised body", "text-sanitised next"]);
  });

  test("a ticket's title from data/jira.json passes SafeText, and its change is reported", () => {
    const p = plan({
      todo: line("A", "x1"),
      jira: JSON.stringify([{ key: "LUM-7", summary: "Fix the ‮export" }]),
      metadata: metadata({
        x1: { sources: [{ label: "Ticket", url: "https://tickets.lumen.example/browse/LUM-7" }] },
      }),
    });
    expect(opsOf(p, "x1", "source.add")[0]?.source.title).toBe("Fix the export");
    expect(p.problems).toEqual([
      {
        code: "text-sanitised",
        severity: "warning",
        file: "data/metadata.json",
        task: "x1",
        field: "sources",
        index: 0,
      },
    ]);
  });

  test("an unknown key whose number JSON.parse cannot keep as written is left out", () => {
    const p = plan({
      todo: line("A", "x1"),
      metadata:
        '{"x1": {"big": 9007199254740993, "huge": 1e400, "tiny": 1e-400, "fine": 1.50,' +
        ' "int": 1E2, "safe": 9007199254740991, "nested": {"a": [1, 2e400]}, "text": "1e400"}}',
    });
    const ext = createOf(p, "x1").ext.planning;
    expect(ext["fine"]).toBe(1.5);
    expect(ext["int"]).toBe(100);
    expect(ext["safe"]).toBe(9_007_199_254_740_991);
    expect(ext["text"]).toBe("1e400");
    for (const key of ["big", "huge", "tiny", "nested"])
      expect(Object.hasOwn(ext, key)).toBe(false);
    expect(
      p.problems.filter((x) => x.code === "extra-dropped").map((x) => [x.field, x.index]),
    ).toEqual([
      ["extra", 0],
      ["extra", 1],
      ["extra", 2],
      ["extra", 6],
    ]);
  });

  test("a place's path is one the writer stores as it is: SafeText leaves it unchanged", () => {
    const roots = { work: "/home/mira/work" };
    expect(placeFor("/home/mira/work/café", roots)).toEqual({ root: "work", path: "café" });
    // A decomposed é would be stored composed: on Linux another folder.
    expect(placeFor("/home/mira/work/café", roots)).toBeUndefined();
    expect(placeFor("/home/mira/work/a\u{e0041}", roots)).toBeUndefined();
    const p = plan({
      todo: line("A", "x1"),
      metadata: metadata({ x1: { paths: ["/home/mira/work/café"] } }),
    });
    expect(opsOf(p, "x1", "place.set")).toEqual([]);
    expect(createOf(p, "x1").ext.planning.paths).toEqual(["/home/mira/work/café"]);
    expect(codes(p, "x1")).toEqual(["path-outside-roots paths", "text-sanitised paths"]);
  });

  test("a star's day outside the space's range is dropped and reported", () => {
    const focus = (at: string) => [
      {
        name: "cli-1.json",
        bytes: JSON.stringify({ id: "cli-1", task: "x1", action: "focus", at }),
      },
    ];
    const late = plan(
      { todo: line("A", "x1"), events: focus("9999-12-31T23:30:00Z") },
      { timeZone: "Pacific/Auckland" },
    );
    expect(createOf(late, "x1").focus).toBeUndefined();
    expect(codes(late, "x1")).toEqual(["date-out-of-range focus"]);
    const early = plan(
      { todo: line("A", "x1"), events: focus("1970-01-01T00:30:00Z") },
      { timeZone: "America/Los_Angeles" },
    );
    expect(createOf(early, "x1").focus).toBeUndefined();
    expect(codes(early, "x1")).toEqual(["date-out-of-range focus"]);
    const inside = plan(
      { todo: line("A", "x1"), events: focus("9999-12-31T09:00:00Z") },
      { timeZone: "Pacific/Auckland" },
    );
    expect(createOf(inside, "x1").focus).toBe("9999-12-31");
  });

  test("a day the import's zone skips is no day there: dropped and reported", () => {
    // Samoa skipped 30 December 2011 when it crossed the date line.
    expect(nineOClock("2011-12-30", "Pacific/Apia")).toBeUndefined();
    const before = nineOClock("2011-12-29", "Pacific/Apia") ?? 0;
    const after = nineOClock("2011-12-31", "Pacific/Apia") ?? 0;
    expect(localDay(before, "Pacific/Apia")).toBe("2011-12-29");
    expect(localDay(after, "Pacific/Apia")).toBe("2011-12-31");
    const p = plan(
      {
        done: `- [x] **Done** (done 2011-12-30; shipped) <!-- task:x1 -->\n`,
      },
      { timeZone: "Pacific/Apia" },
    );
    expect(opsOf(p, "x1", "task.complete")).toEqual([
      { kind: "task.complete", task: { draft: "x1" }, outcome: "shipped" },
    ]);
    expect(createOf(p, "x1").ext.planning["done_date_unknown"]).toBe(true);
    expect(codes(p, "x1")).toEqual(["date-out-of-range done"]);
  });

  test("a ticket key longer than the writer's ref is no ticket: its URL keeps a url: key", () => {
    const url = (key: string) => `https://tickets.lumen.example/browse/${key}`;
    const longest = `${"A".repeat(298)}-1`;
    expect(classifyUrl(url(longest))).toEqual({
      kind: "ticket",
      key: `jira:${longest}`,
      ref: longest,
    });
    const over = `${"A".repeat(299)}-1`;
    expect(classifyUrl(url(over))).toEqual({ kind: "web", key: `url:${url(over)}` });
  });

  test("the plan's counts are own keys whatever a root is called", () => {
    const p = plan(
      {
        todo: line("A", "x1"),
        metadata: metadata({ x1: { paths: ["/home/mira/work/a"] } }),
      },
      { roots: { constructor: "/home/mira/work" } },
    );
    expect(p.counts.placesByRoot).toEqual({ constructor: 1 });
    expect(Object.hasOwn(p.counts.placesByRoot, "constructor")).toBe(true);
  });

  test("one title is one area; distinct titles with one slug get numbered slugs", () => {
    const p = plan({
      todo:
        line("A", "x1") +
        line("B", "x2") +
        line("C", "x3") +
        line("D", "x4") +
        line("E", "x5") +
        line("F", "x6") +
        line("G", "x7"),
      metadata: metadata({
        x1: { category: "Работа", project: "Отчёт" },
        x2: { category: "Дом", project: "Ремонт" },
        x3: { category: "Работа", project: "План" },
        x4: { category: " работа " },
        x5: { category: "🏠" },
        x6: { category: "💼" },
        x7: { category: "Work" },
      }),
    });
    expect(p.areas).toEqual([
      { slug: "area", title: "Работа" },
      { slug: "area-2", title: "Дом" },
      { slug: "area-3", title: "🏠" },
      { slug: "area-4", title: "💼" },
      { slug: "work", title: "Work" },
    ]);
    expect(p.projects).toEqual([
      { slug: "project", title: "Отчёт", area: "area" },
      { slug: "project-2", title: "Ремонт", area: "area-2" },
      { slug: "project-3", title: "План", area: "area" },
    ]);
    expect(createOf(p, "x4").area).toBe("area");
    // A numbered slug stays within 48 characters.
    const long = "p".repeat(48);
    const q = plan({
      todo: line("A", "x1") + line("B", "x2"),
      metadata: metadata({
        x1: { category: "One", project: long },
        x2: { category: "Two", project: long },
      }),
    });
    expect(q.projects.map((x) => x.slug)).toEqual([long, `${"p".repeat(46)}-2`]);
  });

  test("the plan is pure: no clock, no random source, the same plan for the same input", () => {
    const input = {
      todo: line("A", "x1", "(added 2026-10-05, codex)"),
      metadata: metadata({ x1: { source_date: "2026-10-04" } }),
    };
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-01-01T00:00:00Z"));
    const first = plan(input);
    vi.setSystemTime(Date.parse("2031-06-01T12:00:00Z"));
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("the mapping read the clock");
    });
    const random = vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("the mapping drew a random number");
    });
    const second = plan(input);
    expect(now).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  test("bindOperations turns each draft into the ID the apply draws", () => {
    const p = plan({ todo: line("A", "x1") + line("B", "x2") });
    const bound = bindOperations(p, (id) => `t_${id}`);
    expect(bound.filter((o) => o.kind === "task.create").map((o) => o["id"])).toEqual([
      "t_x1",
      "t_x2",
    ]);
    for (const op of bound) {
      if (op.kind === "task.create") expect(Object.hasOwn(op, "task")).toBe(false);
      else expect(op["task"]).toMatch(/^t_x[12]$/);
    }
    expect(bound).toHaveLength(p.tasks.reduce((n, t) => n + t.ops.length, 0));
    // The bound operations share nothing with the plan, and two tasks never get one ID.
    const withSource = plan({
      todo: line("A", "x1"),
      metadata: metadata({
        x1: { sources: [{ label: "Notes", url: "https://www.example.org/n" }] },
      }),
    });
    const copy = bindOperations(withSource, (id) => `t_${id}`);
    (copy.find((o) => o.kind === "source.add")?.["source"] as { title: string }).title = "changed";
    expect(opsOf(withSource, "x1", "source.add")[0]?.source.title).toBe("Notes");
    expect(() => bindOperations(p, () => "t_same")).toThrow(/one ID/);
  });

  test("options the caller should have checked are refused without quoting them", () => {
    const input = parsePrototype({ todo: "", done: "", events: [] });
    const refused = (more: Partial<MappingOptions>) => () =>
      mapPrototype(input, { ...options, ...more });
    expect(refused({ timeZone: "+01:00" })).toThrow(MappingOptionsError);
    expect(refused({ roots: { Work: "/w" } })).toThrow(MappingOptionsError);
    expect(refused({ roots: { work: "w" } })).toThrow(MappingOptionsError);
    expect(refused({ checkedAs: "later" as "review" })).toThrow(MappingOptionsError);
    try {
      refused({ roots: { "secret-name!": "/w" } })();
    } catch (error) {
      expect(String(error)).not.toContain("secret-name");
    }
  });
});
