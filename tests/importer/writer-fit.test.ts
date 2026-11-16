// A7 3.15.3, the mapping's rule that every value of a plan is one the space stores as it is: the
// writer takes it, and its normalisation (A1 3.7) leaves it unchanged. A value that would be refused
// or changed is dropped, cut or replaced in the mapping, with a named problem. Rather than one case
// per field, this test maps many synthetic prototype folders built from awkward pieces (hidden and
// decomposed characters, lone surrogates, line separators, long runs, days at both ends of the
// range and days a zone skips, odd source URLs, paths, metadata keys and numbers) and puts every
// operation of every plan through the writer's request check, which is pure: no space, no I/O.
//
// The parts only an import's request carries (M7.05: the alias, the creation and completion
// instants, `ext.planning`) go through the same check with an import's credential, and are also
// held to the rules the space holds them to: an alias is the legacy ID and of the marker grammar,
// an instant is in the space's range, and `ext.planning` is JSON whose strings SafeText keeps.
//
// The importer never imports storage, so this test lives outside both packages. The folders are
// generated from fixed seeds: the same pieces every run.
import { describe, expect, test } from "vitest";
import { normaliseText } from "../../packages/contracts/src/index.ts";
import {
  bindOperations,
  decideApply,
  INSTANT_MAX,
  mapPrototype,
  parsePrototype,
  type ApplySpace,
  type MappingOptions,
  type PrototypeInput,
} from "../../packages/importer-planning/src/index.ts";
import { checkRequest, newId, type Credential } from "../../packages/storage/src/index.ts";

/** mulberry32: a small seeded generator, so every run builds the same folders. */
function generator(seed: number) {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (n: number): number => Math.floor(next() * n);
  const pick = <T>(list: readonly T[]): T => list[int(list.length)] as T;
  const chance = (p: number): boolean => next() < p;
  return { int, pick, chance };
}
type Gen = ReturnType<typeof generator>;

/** Text pieces: plain words and the characters SafeText, NFC, line splitting and cutting meet. */
const PIECES = [
  "fix",
  "the",
  "bike light",
  "Waiting on ",
  "Next: call the clinic.",
  "Refs: LUM-7",
  "(added 2026-11-02, codex)",
  "(added 2011-12-30, codex)",
  "...",
  " ",
  "  ",
  "\t",
  "é",
  "e\u0301",
  "Работа",
  "日本",
  "🎂",
  "👩\u200d💻",
  "\u202e",
  "\u200b",
  "\u2066",
  "\u0000",
  "\u0007",
  "\ud800",
  "\u2028",
  "\u0085",
  "\u000b",
  "\r",
  "\ufeff",
  "\u{e0041}",
  "**",
  "(",
  ")",
  "#",
  "/",
  ":",
  "word ".repeat(80),
  "x".repeat(420),
  "ü".repeat(90),
];
const DAYS = [
  "2026-11-05",
  "2026-03-29",
  "1970-01-01",
  "1969-12-31",
  "9999-12-31",
  "0099-01-01",
  "2011-12-30",
  "2026-02-30",
];
const INSTANTS = [
  "2026-11-05T23:30:00Z",
  "2026-11-05T09:30+02:00",
  "1970-01-01T00:30:00Z",
  "1969-12-31T23:59:59Z",
  "9999-12-31T23:30:00Z",
  "2011-12-29T23:30:00-10:00",
  "2026-03-29T01:30:00.123456789Z",
];
const ZONES = [
  "Europe/Amsterdam",
  "UTC",
  "Pacific/Auckland",
  "Pacific/Apia",
  "Pacific/Kiritimati",
  "America/Los_Angeles",
  "Etc/GMT+12",
];
const URLS = [
  "https://tickets.lumen.example/browse/LUM-7",
  "https://tickets.lumen.example/browse/lum-1000/",
  `https://tickets.lumen.example/browse/${"A".repeat(299)}-1`,
  "https://git.example.org/o/r/pull/3",
  "https://mail.lumen.example/mail/u/0/#inbox/AAA",
  "https://www.example.org/s?utm_source=x&a=1#top",
  "mailto:tomas@mail.lumen.example",
  "https://www.example.org/caf\u00e9",
  "https://www.example.org/cafe\u0301",
  `https://www.example.org/${"a".repeat(600)}`,
  `https://www.example.org/${"a".repeat(2100)}`,
  "not a url",
  "https://www.example.org/\u200b",
  // The page's own kinds: its wiki and ticket host, a file: link (a kept path, no source), an
  // agent thread, and a scheme the page shows no link for.
  "https://lumen.atlassian.net/wiki/spaces/P/pages/1",
  "https://lumen.atlassian.net/jira/software/projects/LUM/boards/2",
  "file:///home/mira/work/a%20b",
  "file:///home/mira/%E2%80%8B",
  "file://server.example/share",
  "t3-thread:thread-0001",
  "ftp://files.lumen.example/a",
  "  ",
];
const LABELS = ["", "Email", "Ticket", "Notes", "Chat with Aiko", "\u202e", "x".repeat(320)];
const EXTRA_KEYS = ["estimate", "__proto__", "constructor", "legacy_id", "", "imported_at", "k"];
const EXTRA_VALUES = [
  '"2h"',
  '"a\\u200bb"',
  '"\\ud800"',
  "1.50",
  "9007199254740993",
  "1e400",
  "-0",
  "true",
  "null",
  '{"a": ["x\\u0000", 2]}',
  `${"[".repeat(40)}1${"]".repeat(40)}`,
];
const ORPHAN_KEYS = ["o-1", "M-1", "\u200b ", "raw\u202eid", "t-0000abcd"];

const words = (g: Gen, n: number): string =>
  Array.from({ length: n }, () => g.pick(PIECES)).join(g.pick(["", " "]));

/** One synthetic prototype folder, and the options its import runs with. */
function folder(g: Gen): { input: PrototypeInput; options: MappingOptions } {
  const ids = Array.from({ length: 1 + g.int(6) }, (_, i) => `x${String(i)}`);
  const todo: string[] = [];
  const done: string[] = [];
  const metadata: string[] = [];
  const events: { name: string; bytes: string }[] = [];
  for (const id of ids) {
    const marker = g.chance(0.85) ? ` <!-- task:${id} -->` : "";
    const title = words(g, 1 + g.int(3));
    const body = g.chance(0.7) ? words(g, g.int(4)) : "";
    if (g.chance(0.3)) {
      const evidence = g.chance(0.8) ? words(g, g.int(3)) : "";
      done.push(`- [x] **${title}** ${body} (done ${g.pick(DAYS)}; ${evidence})${marker}`);
    } else {
      if (g.chance(0.3)) todo.push(`## ${words(g, 1 + g.int(2))}`);
      todo.push(`- [${g.pick([" ", "x", "X"])}] **${title}** ${body}${marker}`);
    }
    const fields: string[] = [];
    const text = () => JSON.stringify(words(g, 1 + g.int(3)));
    if (g.chance(0.6)) fields.push(`"category": ${text()}`);
    if (g.chance(0.5)) fields.push(`"project": ${text()}`);
    if (g.chance(0.5)) {
      const status = g.pick(["open", "waiting", "needs_review", "delegated", "backlog", "later"]);
      fields.push(`"status": "${status}"`);
    }
    if (g.chance(0.5)) fields.push(`"owner": ${g.chance(0.3) ? '"Mira Okafor"' : text()}`);
    if (g.chance(0.4)) fields.push(`"priority": "${g.pick(["P1", "P2", "P3", "P4"])}"`);
    if (g.chance(0.4))
      fields.push(`"rank": ${g.pick(["1", "2.5", "-3", "1e400", "9007199254740993"])}`);
    for (const key of ["next", "evidence", "confidence"]) {
      if (g.chance(0.4)) fields.push(`"${key}": ${text()}`);
    }
    for (const key of ["source_date", "reviewed", "due"]) {
      if (g.chance(0.4)) fields.push(`"${key}": "${g.pick(DAYS)}"`);
    }
    if (g.chance(0.5)) {
      const sources = Array.from({ length: 1 + g.int(3) }, () =>
        JSON.stringify({ label: g.pick(LABELS), url: g.pick(URLS) }),
      );
      fields.push(`"sources": [${sources.join(", ")}]`);
    }
    if (g.chance(0.5)) {
      const paths = Array.from({ length: 1 + g.int(2) }, () =>
        JSON.stringify(
          `${g.pick(["/home/mira/work/", "/home/mira/", "C:\\Work\\"])}${words(g, 2)}`,
        ),
      );
      fields.push(`"paths": [${paths.join(", ")}]`);
    }
    if (g.chance(0.4))
      fields.push(`${JSON.stringify(g.pick(EXTRA_KEYS))}: ${g.pick(EXTRA_VALUES)}`);
    metadata.push(`${JSON.stringify(id)}: {${fields.join(", ")}}`);
    if (g.chance(0.5)) {
      const n = String(events.length);
      const action = g.pick(["check", "uncheck", "focus", "unfocus"]);
      const at = g.pick(INSTANTS);
      events.push({
        name: `cli-${n}.json`,
        bytes: JSON.stringify({ id: `cli-${n}`, task: id, action, at }),
      });
    }
  }
  if (g.chance(0.5)) metadata.push(`${JSON.stringify(g.pick(ORPHAN_KEYS))}: {"next": "Plan it"}`);
  return {
    input: {
      todo: `${todo.join("\n")}\n`,
      done: `# Done\n${done.join("\n")}\n`,
      metadata: `{${metadata.join(", ")}}`,
      events,
    },
    options: {
      me: "Mira Okafor",
      roots: g.chance(0.5)
        ? { work: "/home/mira/work" }
        : { work: "/home/mira/work", w: "C:\\Work" },
      timeZone: g.pick(ZONES),
      ...(g.chance(0.3) ? { checkedAs: "review" as const } : {}),
      ...(g.chance(0.5) ? { includeOrphans: true } : {}),
    },
  };
}

const SPACE = newId("sp");
/** An import's credential (A7 3.15.5): the user as the principal, the import actor as author. */
const ACTOR: Credential = {
  scope_id: "cli:import-fixture",
  principal_id: newId("ac"),
  actor_kind: "human",
  author_id: newId("ac"),
  machine_id: newId("m"),
  origin: "import",
};

/** Every string of a JSON value is one SafeText keeps, and every number is finite. */
function checkJson(value: unknown, path: string): void {
  if (typeof value === "string") {
    expect(normaliseText(value), path).toBe(value);
  } else if (typeof value === "number") {
    expect(Number.isFinite(value), path).toBe(true);
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => {
      checkJson(item, `${path}[${String(i)}]`);
    });
  } else if (typeof value === "object" && value !== null) {
    expect(Object.getPrototypeOf(value), path).toBe(Object.prototype);
    for (const [k, v] of Object.entries(value)) checkJson(v, `${path}.${k}`);
  } else {
    expect(value === null || typeof value === "boolean", path).toBe(true);
  }
}

const RUNS = 400;

describe("[A7.3.15.importer.writer-fit] every value of a plan is one the space stores as it is", () => {
  test(`${String(RUNS)} synthetic folders: the writer takes every operation unchanged`, () => {
    let ops = 0;
    for (let run = 0; run < RUNS; run += 1) {
      const g = generator(0x5eed + run);
      const { input, options } = folder(g);
      const plan = mapPrototype(parsePrototype(input), options);
      // One input, one plan.
      expect(mapPrototype(parsePrototype(input), options)).toEqual(plan);
      const ids = new Map(plan.tasks.map((t) => [t.legacyId, newId("t")]));
      for (const op of bindOperations(plan, (id) => ids.get(id) ?? "")) {
        ops += 1;
        const where = `run ${String(run)}, ${op.kind}`;
        if (op.kind === "alias.add") {
          expect(op["alias"], where).toMatch(/^[a-z0-9_-]+$/);
          expect(ids.get(String(op["alias"])), where).toBe(op["task"]);
        }
        for (const field of ["created_at", "at"]) {
          const at = op[field];
          if (at !== undefined) {
            expect(Number.isSafeInteger(at) && (at as number) >= 0, where).toBe(true);
            expect(at as number, where).toBeLessThanOrEqual(INSTANT_MAX);
          }
        }
        if (op.kind === "task.create") checkJson(op["ext"], `${where} ext`);
        const sent = op as Record<string, unknown>;
        const checked = checkRequest({
          space_id: SPACE,
          request_id: `import-check-${String(run).padStart(4, "0")}`,
          actor: ACTOR,
          ops: [sent],
        });
        // The writer's normalised operation is the operation as planned.
        expect(checked.ops[0], where).toEqual(sent);
      }
    }
    expect(ops).toBeGreaterThan(RUNS * 3);
  });

  test("a metadata entry at the input's size: its ext.planning and its exchange item fit the writer", () => {
    // Unknown keys, a confidence and paths far over any daily size, in one entry the parser takes.
    const big = (n: number, c: string) => c.repeat(n);
    const metadata = JSON.stringify({
      a1: {
        next: "Plan it",
        confidence: big(300_000, "c"),
        paths: ["/home/mira/work/a1", `/home/mira/${big(200_000, "p")}`],
        notes_long: big(400_000, "n"),
        more_text: { nested: [big(300_000, "m")] },
      },
    });
    const input: PrototypeInput = {
      todo: `- [ ] **Big one** ${big(30_000, "b ")} <!-- task:a1 -->\n`,
      done: "# Done\n",
      metadata,
      events: [],
    };
    const options: MappingOptions = {
      me: "Mira Okafor",
      roots: { work: "/home/mira/work" },
      timeZone: "Europe/Amsterdam",
    };
    const plan = mapPrototype(parsePrototype(input), options);
    expect(plan.tasks).toHaveLength(1);
    const empty: ApplySpace = {
      state: {
        id: SPACE,
        epoch: 1,
        incarnation: "in_0000000000000000000000000",
        refPrefix: "M",
        nextRef: 1,
        aliases: [],
        sources: [],
        areas: [],
        projects: [],
      },
      matched: new Map(),
      gone: [],
    };
    const decision = decideApply(plan, empty, {
      exchange: newId("ex"),
      dir: "exchange/planning/run/input",
      idOf: () => newId("t"),
      groupIdOf: (kind) => newId(kind === "area" ? "a" : "p"),
      importedAt: Date.UTC(2026, 10, 15),
    });
    const ops = decision.ops.map((op) => ({ ...op }));
    expect(ops.map((op) => op["kind"])).toContain("exchange.create");
    const checked = checkRequest({
      space_id: SPACE,
      request_id: "import-check-big",
      actor: ACTOR,
      ops,
    });
    expect(checked.ops).toEqual(ops);
  });
});
