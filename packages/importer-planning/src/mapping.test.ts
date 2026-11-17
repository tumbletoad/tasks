// M7.03's Verify line (A7 3.14): each mapping row of A7 3.15.3 has a fixture case and an assertion.
// The plan is built from the committed synthetic prototype, read the way an import reads its copy,
// and every row below names the index's cases it rests on and asserts what the row states at each
// of their locations. The expected values come from the row and from the fixture's raw files and
// index, never from the mapping's own helpers. The writer half of the Verify line (two legacy tasks,
// one source row, the sample task untouched) is tests/importer/shared-sources.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ImportProblem } from "@tasks/contracts";
import { beforeAll, describe, expect, test } from "vitest";
import {
  decideFolders,
  IMPORT_LOG,
  mapPrototype,
  parsePrototype,
  readInput,
  type FolderFact,
  type ImportPlan,
  type MappingOptions,
  type PlannedOp,
  type PlannedTask,
  type PlannedTaskCreate,
  type PrototypeInput,
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
  expect?: Record<string, unknown>;
}
interface Index {
  me: string;
  home: string;
  spaceTask: { key: string };
  counts: Record<string, number>;
  tasks: { id: string; file: string; line: number; group: string; title: string; body: string }[];
  cases: Record<string, { where: Where[] }>;
}
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

let index: Index;
let raw: Record<string, Record<string, unknown>>;
let input: PrototypeInput;
let parse: PrototypeParse;
let plan: ImportPlan;
/** The import machine's zone for the fixture: CEST until 25 October 2026, CET after. */
const ZONE = "Europe/Amsterdam";
let options: MappingOptions;

beforeAll(async () => {
  index = JSON.parse(read("fixtures/planning-prototype.index.json")) as Index;
  // One task per ID: the TODO.md line of an ID that DONE.md has too is hidden, as on the page
  // (case in-both-ledgers). Every row below reads the lines that stand for their tasks.
  const hidden = (index.cases["in-both-ledgers"]?.where ?? []).filter(
    (w) => w.expect?.["hidden"] === true,
  );
  expect(hidden).toHaveLength(1);
  index.tasks = index.tasks.filter(
    (t) => !hidden.some((w) => w.file === t.file && w.line === t.line),
  );
  raw = JSON.parse(read("fixtures/planning-prototype/data/metadata.json")) as typeof raw;
  const folder = await readInput(FIXTURE);
  expect(folder.problems).toEqual([]);
  input = folder.input;
  parse = parsePrototype(input);
  options = { me: index.me, timeZone: ZONE };
  plan = mapPrototype(parse, options);
});

const where = (name: string): Where[] => {
  const list = index.cases[name]?.where ?? [];
  expect(list.length, `case ${name}`).toBeGreaterThan(0);
  return list;
};
const ids = (name: string): string[] =>
  where(name).map((w) => {
    expect(w.task, `case ${name} names a task`).toBeDefined();
    return w.task ?? "";
  });
const taskOf = (id: string, p: ImportPlan = plan): PlannedTask => {
  const t = p.tasks.find((x) => x.legacyId === id);
  expect(t, `planned task ${id}`).toBeDefined();
  return t as PlannedTask;
};
const createOf = (id: string, p: ImportPlan = plan): PlannedTaskCreate =>
  taskOf(id, p).ops[0] as PlannedTaskCreate;
const opsOf = <K extends PlannedOp["kind"]>(id: string, kind: K, p: ImportPlan = plan) =>
  taskOf(id, p).ops.filter((o): o is Extract<PlannedOp, { kind: K }> => o.kind === kind);
const ext = (id: string, p: ImportPlan = plan): Record<string, unknown> =>
  createOf(id, p).ext.planning;
const problemsOf = (code: string, id: string, p: ImportPlan = plan) =>
  p.problems.filter((x) => x.code === code && x.task === id);
const meta = (id: string): Record<string, unknown> => raw[id] ?? {};
/**
 * The folders on a Linux machine whose home is the fixture's and holds every folder under it: each
 * path there is a folder, stored with `~`, and every other path is missing.
 */
const folders = () => {
  const facts = new Map<string, FolderFact>();
  for (const t of plan.tasks) {
    if (t.folder === undefined) continue;
    const { path } = t.folder;
    facts.set(
      t.legacyId,
      path.startsWith(`${index.home}/`)
        ? { state: "present", stored: `~${path.slice(index.home.length)}` }
        : { state: "missing" },
    );
  }
  return decideFolders(plan, facts, { os: "linux", holders: [], reuses: () => undefined });
};
const indexed = (id: string) => index.tasks.find((t) => t.id === id);
/** 09:00 on a day in the fixture's zone, written out: +02:00 until 25 October, +01:00 after. */
const nine = (day: string): number =>
  Date.parse(`${day}T09:00:00${day < "2026-10-25" ? "+02:00" : "+01:00"}`);

/** Every row of A7 3.15.3, the cases it rests on, and its assertion. */
const ROWS: { row: string; cases: string[]; check: () => void }[] = [
  {
    row: "ID marker: a new task with the alias (planning, <id>)",
    cases: ["marked", "marker-in-title", "two-markers"],
    check() {
      for (const name of ["marked", "marker-in-title", "two-markers"]) {
        for (const id of ids(name)) {
          expect(opsOf(id, "alias.add")).toEqual([
            { kind: "alias.add", task: { draft: id }, namespace: "planning", alias: id },
          ]);
          expect(createOf(id).dedupe).toBe("none");
          expect(problemsOf("fallback-id", id)).toEqual([]);
        }
      }
    },
  },
  {
    row: "No marker: the fallback ID, imported with a warning",
    cases: ["unmarked-task-line", "non-ascii-fallback", "astral-fallback", "same-title-two-groups"],
    check() {
      for (const w of where("unmarked-task-line")) {
        const id = w.task ?? "";
        expect(opsOf(id, "alias.add")[0]?.alias).toBe(id);
        expect(problemsOf("fallback-id", id)).toEqual([
          { code: "fallback-id", severity: "warning", file: w.file, line: w.line, task: id },
        ]);
      }
      for (const name of ["non-ascii-fallback", "astral-fallback"]) {
        for (const w of where(name)) expect(taskOf(String(w.expect?.["id"])).marked).toBe(false);
      }
      const [a, b] = ids("same-title-two-groups");
      expect(createOf(a ?? "").title).toBe(createOf(b ?? "").title);
      expect(a).not.toBe(b);
    },
  },
  {
    row: "Title: over 300 characters cut at a word boundary, the full text at the top of context",
    cases: ["long-title", "trailing-dots"],
    check() {
      for (const id of ids("long-title")) {
        const full = indexed(id)?.title ?? "";
        const create = createOf(id);
        expect(Array.from(full).length).toBeGreaterThan(300);
        expect(Array.from(create.title).length).toBeLessThanOrEqual(300);
        expect(full.startsWith(create.title)).toBe(true);
        expect(full.charAt(create.title.length)).toBe(" ");
        expect(create.context).toBe(`${full}\n\n${indexed(id)?.body ?? ""}`);
        expect(problemsOf("title-cut", id)).toHaveLength(1);
      }
      for (const w of where("trailing-dots")) {
        expect(createOf(w.task ?? "").title).toBe(w.expect?.["title"]);
      }
    },
  },
  {
    row: "## Group: the area, only when metadata has no category",
    cases: ["group-as-area", "default-group", "shared-source-legacy"],
    check() {
      for (const id of ids("group-as-area")) {
        expect(meta(id)["category"]).toBeUndefined();
        expect(createOf(id).area).toBe("errands");
        expect(indexed(id)?.group).toBe("Errands");
      }
      for (const id of ids("default-group")) {
        if (meta(id)["category"] === undefined) expect(createOf(id).area).toBe("other");
      }
      // In the ledger under "Clinic sync", with category Lumen: the category wins.
      for (const id of ids("shared-source-legacy")) {
        expect(indexed(id)?.group).toBe("Clinic sync");
        expect(createOf(id).area).toBe("lumen");
      }
    },
  },
  {
    row: "Body without the marker: context, verbatim, with Next:, Refs: and (added …)",
    cases: ["refs-clause", "added-clause", "two-markers", "empty-body"],
    check() {
      for (const t of index.tasks) {
        if (ids("long-title").includes(t.id)) continue;
        expect(createOf(t.id).context ?? "", t.id).toBe(t.body);
      }
      for (const id of ids("refs-clause")) expect(createOf(id).context).toMatch(/Refs: \S/);
      for (const id of ids("added-clause")) expect(createOf(id).context).toMatch(/\(added /);
      for (const w of where("two-markers")) {
        expect(createOf(w.task ?? "").context).toBe(w.expect?.["body"]);
      }
      for (const id of ids("empty-body")) expect(createOf(id).context).toBeUndefined();
    },
  },
  {
    row: "(added YYYY-MM-DD, <agent>): created_at 09:00 local, ext.planning.added_by",
    cases: ["added-clause", "no-added-clause", "invalid-date"],
    check() {
      for (const id of ids("added-clause")) {
        const m = /\(added (\d{4}-\d{2}-\d{2}), ([^()]*)\)/.exec(indexed(id)?.body ?? "");
        expect(createOf(id).created_at).toBe(nine(m?.[1] ?? ""));
        expect(ext(id)["added_by"]).toBe(m?.[2]);
      }
      // Without the clause, created_at is the import time: the commit's instant.
      for (const id of ids("no-added-clause")) {
        expect(createOf(id).created_at).toBeUndefined();
        expect(ext(id)["added_by"]).toBeUndefined();
      }
      // A clause whose day is no date keeps its agent and gives no created_at.
      for (const w of where("invalid-date").filter((x) => x.file === "TODO.md")) {
        expect(createOf(w.task ?? "").created_at).toBeUndefined();
        expect(ext(w.task ?? "")["added_by"]).toBe("codex");
      }
    },
  },
  {
    row: "category: the area, slug from the text, title as written, in order of first appearance",
    cases: ["group-as-area", "no-project"],
    check() {
      const titles: string[] = [];
      for (const t of index.tasks) {
        const title = (meta(t.id)["category"] as string | undefined) ?? t.group;
        if (!titles.includes(title)) titles.push(title);
      }
      expect(plan.areas.map((a) => a.title)).toEqual(titles);
      expect(plan.areas.map((a) => a.slug)).toEqual([
        "other",
        "lumen",
        "home",
        "errands",
        "open-source",
      ]);
      for (const id of ids("no-project")) {
        expect(createOf(id).area).toBe(String(meta(id)["category"]).toLowerCase());
      }
    },
  },
  {
    row: "project: a project in that area; the slug ignores a trailing (…), the title keeps it",
    cases: ["project-paren-suffix", "no-project"],
    check() {
      const slugs: Record<string, string> = {
        "Clinic sync (Q4)": "clinic-sync",
        "tidy-md (oss)": "tidy-md",
      };
      for (const id of ids("project-paren-suffix")) {
        const title = meta(id)["project"] as string;
        const project = plan.projects.find((p) => p.title === title);
        expect(project?.slug).toBe(slugs[title]);
        expect(createOf(id).project).toBe(slugs[title]);
        expect(project?.area).toBe(createOf(id).area);
      }
      for (const id of ids("no-project")) expect(createOf(id).project).toBeUndefined();
    },
  },
  {
    row: "status open, waiting, backlog: the same status",
    cases: ["status-open", "status-waiting", "status-backlog"],
    check() {
      for (const [name, status] of [
        ["status-open", "open"],
        ["status-waiting", "waiting"],
        ["status-backlog", "backlog"],
      ] as const) {
        for (const id of ids(name)) expect(createOf(id).status).toBe(status);
      }
    },
  },
  {
    row: "status needs_review: review",
    cases: ["status-needs-review"],
    check() {
      for (const id of ids("status-needs-review")) expect(createOf(id).status).toBe("review");
    },
  },
  {
    row: "status delegated: waiting, waiting_on the owner, ext.planning.status delegated",
    cases: ["status-delegated", "owner-other-delegated"],
    check() {
      for (const id of ids("status-delegated")) {
        expect(createOf(id).status).toBe("waiting");
        expect(createOf(id).waiting_on).toBe(meta(id)["owner"]);
        expect(ext(id)["status"]).toBe("delegated");
      }
    },
  },
  {
    row: 'No status: waiting when the title starts "Waiting on ", else open',
    cases: ["status-missing-waiting-title", "status-missing-open"],
    check() {
      for (const id of ids("status-missing-waiting-title")) {
        expect(meta(id)["status"]).toBeUndefined();
        expect(createOf(id).status).toBe("waiting");
      }
      for (const id of ids("status-missing-open")) {
        expect(meta(id)["status"]).toBeUndefined();
        expect(createOf(id).status).toBe("open");
      }
    },
  },
  {
    row: "owner: the user is no owner; another person is waiting_on when waiting, else owner",
    cases: [
      "owner-me",
      "owner-other-open",
      "owner-other-waiting",
      "owner-other-delegated",
      "owner-missing",
    ],
    check() {
      for (const id of [...ids("owner-me"), ...ids("owner-missing")]) {
        expect(createOf(id).owner).toBeUndefined();
        expect(createOf(id).waiting_on).toBeUndefined();
      }
      for (const id of ids("owner-other-open")) {
        expect(createOf(id).owner).toBe(meta(id)["owner"]);
        expect(createOf(id).waiting_on).toBeUndefined();
      }
      for (const id of [...ids("owner-other-waiting"), ...ids("owner-other-delegated")]) {
        expect(createOf(id).waiting_on).toBe(meta(id)["owner"]);
        expect(createOf(id).owner).toBeUndefined();
      }
      // The report lists every distinct owner.
      const owners = [
        ...new Set(index.tasks.map((t) => meta(t.id)["owner"]).filter((o) => o !== undefined)),
      ];
      expect(plan.owners.map((o) => o.name)).toEqual(owners);
      expect(plan.owners.filter((o) => o.me).map((o) => o.name)).toEqual([index.me]);
    },
  },
  {
    row: "priority P1 to P3: 1 to 3; none: 3",
    cases: ["priority-p1", "priority-p2", "priority-p3", "priority-missing"],
    check() {
      for (const [name, level] of [
        ["priority-p1", 1],
        ["priority-p2", 2],
        ["priority-p3", 3],
        ["priority-missing", 3],
      ] as const) {
        for (const id of ids(name)) expect(createOf(id).priority).toBe(level);
      }
    },
  },
  {
    row: "rank: ext.planning.rank; position in the project by rank, then file order",
    cases: ["rank-set", "rank-tie", "rank-missing"],
    check() {
      for (const id of ids("rank-set")) expect(ext(id)["rank"]).toBe(meta(id)["rank"]);
      for (const id of ids("rank-missing")) expect(ext(id)["rank"]).toBeUndefined();
      // The writer appends each create to its group, so the creation order is the position.
      const project = createOf(ids("rank-set")[0] ?? "").project;
      const order = plan.tasks.filter((t) => t.project === project).map((t) => t.legacyId);
      const fileOrder = index.tasks.map((t) => t.id).filter((id) => order.includes(id));
      const rank = (id: string) => meta(id)["rank"] as number | undefined;
      const expected = [
        ...fileOrder
          .filter((id) => rank(id) !== undefined)
          .sort((a, b) => (rank(a) ?? 0) - (rank(b) ?? 0)),
        ...fileOrder.filter((id) => rank(id) === undefined),
      ];
      expect(order).toEqual(expected);
      const [first, second] = ids("rank-tie");
      expect(order.indexOf(first ?? "")).toBeLessThan(order.indexOf(second ?? ""));
      for (const id of ids("rank-missing")) {
        expect(order.indexOf(id)).toBeGreaterThan(order.indexOf(second ?? ""));
      }
    },
  },
  {
    row: "next: the summary; without it the body's Next: clause, else empty",
    cases: ["next-set", "next-from-body", "next-empty"],
    check() {
      for (const id of ids("next-set")) expect(createOf(id).summary).toBe(meta(id)["next"]);
      // The page's own pattern for the clause.
      for (const id of ids("next-from-body")) {
        const clause = /Next:\s*(.*?)(?=\sRefs:|\s\(added|$)/.exec(indexed(id)?.body ?? "")?.[1];
        expect(clause).toBeTruthy();
        expect(createOf(id).summary).toBe(clause);
      }
      for (const id of ids("next-empty")) expect(createOf(id).summary).toBeUndefined();
    },
  },
  {
    row: "evidence: one log entry of kind evidence, dated source_date, verbatim",
    cases: ["evidence"],
    check() {
      for (const id of ids("evidence")) {
        expect(opsOf(id, "log.add").filter((o) => o.log_kind === "evidence")).toEqual([
          {
            kind: "log.add",
            task: { draft: id },
            body: meta(id)["evidence"],
            log_kind: "evidence",
            at: nine(String(meta(id)["source_date"])),
          },
        ]);
      }
    },
  },
  {
    row: "source_date, reviewed: source_at, reviewed_at at 09:00 local; invalid dates dropped",
    cases: [
      "source-date-valid",
      "source-date-invalid",
      "source-date-missing",
      "reviewed-valid",
      "reviewed-invalid",
      "reviewed-missing",
    ],
    check() {
      for (const id of ids("source-date-valid")) {
        expect(createOf(id).source_at).toBe(nine(String(meta(id)["source_date"])));
      }
      for (const id of ids("reviewed-valid")) {
        expect(createOf(id).reviewed_at).toBe(nine(String(meta(id)["reviewed"])));
      }
      for (const id of [...ids("source-date-invalid"), ...ids("source-date-missing")]) {
        expect(createOf(id).source_at).toBeUndefined();
      }
      for (const id of [...ids("reviewed-invalid"), ...ids("reviewed-missing")]) {
        expect(createOf(id).reviewed_at).toBeUndefined();
      }
      // The invalid dates were reported by the parse, which the report lists with the plan's.
      for (const id of [...ids("source-date-invalid"), ...ids("reviewed-invalid")]) {
        expect(parse.problems.some((p) => p.code === "date-invalid" && p.task === id)).toBe(true);
      }
    },
  },
  {
    row: "confidence: ext.planning.confidence, kept as written",
    cases: ["confidence-word", "confidence-number", "confidence-free-text", "confidence-missing"],
    check() {
      for (const name of ["confidence-word", "confidence-number", "confidence-free-text"]) {
        for (const id of ids(name)) expect(ext(id)["confidence"]).toBe(meta(id)["confidence"]);
      }
      for (const id of ids("confidence-missing")) expect(ext(id)["confidence"]).toBeUndefined();
    },
  },
  {
    row: "due: due_date; invalid dates dropped; no due date invented",
    cases: ["due-valid", "due-invalid", "due-missing"],
    check() {
      for (const id of ids("due-valid")) {
        expect(createOf(id).due).toEqual({ date: meta(id)["due"] });
      }
      for (const id of [...ids("due-invalid"), ...ids("due-missing")]) {
        expect(createOf(id).due).toBeUndefined();
      }
      const withDue = plan.tasks.filter((t) => createOf(t.legacyId).due !== undefined);
      expect(withDue.map((t) => t.legacyId).sort()).toEqual(ids("due-valid").sort());
    },
  },
  {
    row: "sources: rows linked with role origin, the kind from the URL, the label as title",
    cases: [
      "source-ticket",
      "source-email",
      "source-chat",
      "source-doc",
      "source-drive",
      "source-calendar",
      "source-pr",
      "source-issue",
      "source-web",
      "generic-source-label",
      "multiple-sources",
    ],
    check() {
      const kinds: Record<string, string> = {
        "source-ticket": "ticket",
        "source-email": "email",
        "source-chat": "chat",
        "source-doc": "doc",
        "source-drive": "doc",
        "source-calendar": "calendar",
        "source-pr": "pr",
        "source-issue": "issue",
        "source-web": "web",
      };
      for (const [name, kind] of Object.entries(kinds)) {
        for (const id of ids(name)) {
          const adds = opsOf(id, "source.add");
          expect(
            adds.map((a) => a.source.kind),
            `${name} ${id}`,
          ).toContain(kind);
          for (const add of adds) expect(add.role).toBe("origin");
        }
      }
      for (const id of ids("source-ticket")) {
        const url = (meta(id)["sources"] as { url: string }[])[0]?.url ?? "";
        const ref = /\/browse\/([A-Z]+-\d+)$/.exec(url)?.[1];
        expect(opsOf(id, "source.add")[0]?.source.ref).toBe(ref);
      }
      // A label that only names the kind: a short form of the URL, flagged generic.
      for (const id of ids("generic-source-label")) {
        const add = opsOf(id, "source.add")[0];
        const label = (meta(id)["sources"] as { label: string }[])[0]?.label;
        expect(["Email", "Chat"]).toContain(label);
        expect(add?.source.title).not.toBe(label);
        expect(add?.source.url.includes(add.source.title.split("/")[0] ?? "-")).toBe(true);
        expect(plan.sources.find((s) => s.key === add?.source.key)?.generic).toBe(true);
        expect(problemsOf("source-title-generic", id)).toHaveLength(1);
      }
      for (const id of ids("generic-source-label").concat(ids("source-ticket"))) {
        if (ids("generic-source-label").includes(id)) continue;
        const labels = (meta(id)["sources"] as { label: string }[]).map((s) => s.label);
        expect(labels).toContain(opsOf(id, "source.add")[0]?.source.title);
      }
      for (const id of ids("multiple-sources")) {
        const urls = (meta(id)["sources"] as { url: string }[]).map((s) => s.url);
        expect(opsOf(id, "source.add").map((a) => a.source.url)).toEqual(urls);
      }
    },
  },
  {
    row: "Source keys: jira:<KEY> from the URL, else url:<normalised URL>",
    cases: [
      "source-ticket",
      "source-email",
      "source-web",
      "source-doc",
      "source-pr",
      "source-issue",
    ],
    check() {
      for (const id of ids("source-ticket")) {
        const add = opsOf(id, "source.add")[0];
        expect(add?.source.key).toBe(`jira:${add?.source.ref ?? ""}`);
      }
      for (const name of [
        "source-email",
        "source-web",
        "source-doc",
        "source-pr",
        "source-issue",
      ]) {
        for (const id of ids(name)) {
          for (const add of opsOf(id, "source.add")) {
            expect(add.source.key).toBe(`url:${add.source.url}`);
          }
        }
      }
      // A webmail URL keeps its route fragment, which names the thread.
      for (const id of ids("source-email")) {
        expect(opsOf(id, "source.add")[0]?.source.key).toMatch(/#inbox\//);
      }
    },
  },
  {
    row: "Shared sources: one row per key, linked to every task that names it, every create dedupe none",
    cases: ["shared-source-legacy", "shared-source-space"],
    check() {
      const shared = ids("shared-source-legacy");
      const keys = shared.map((id) => opsOf(id, "source.add")[0]?.source.key);
      expect(new Set(keys).size).toBe(1);
      const row = plan.sources.filter((s) => s.key === keys[0]);
      expect(row).toHaveLength(1);
      expect(row[0]?.tasks).toEqual(shared);
      // Each create names the same source fields, so the writer finds one row by its key.
      expect(opsOf(shared[0] ?? "", "source.add")[0]?.source).toEqual(
        opsOf(shared[1] ?? "", "source.add")[0]?.source,
      );
      for (const id of shared) expect(problemsOf("source-key-shared", id)).toHaveLength(1);
      for (const id of ids("shared-source-space")) {
        expect(opsOf(id, "source.add").map((a) => a.source.key)).toContain(index.spaceTask.key);
      }
      for (const t of plan.tasks) expect(createOf(t.legacyId).dedupe).toBe("none");
    },
  },
  {
    row: "paths[0]: the task's folder on this machine; a project gets the one that holds all its tasks' folders",
    cases: ["project-folder", "project-folder-none", "folder-no-project"],
    check() {
      const decided = folders();
      const projectOf = (id: string) => taskOf(id).project ?? "";
      const stored = (id: string) =>
        `~${((meta(id)["paths"] as string[])[0] ?? "").slice(index.home.length)}`;
      // The project gets the folder that holds the others; that task none of its own.
      const projects = new Set(ids("project-folder").map(projectOf));
      for (const slug of projects) {
        const tasks = ids("project-folder").filter((id) => projectOf(id) === slug);
        const outer = tasks.map(stored).find((p) => tasks.every((t) => stored(t).startsWith(p)));
        expect(decided.projects.get(slug)).toEqual({ folder: outer });
        for (const id of tasks) {
          expect(decided.tasks.get(id)).toEqual({
            path: stored(id),
            state: stored(id) === outer ? "project" : "own",
          });
        }
      }
      // No folder holds them all: no project folder, and each task keeps its own.
      const none = projectOf(ids("project-folder-none")[0] ?? "");
      expect(decided.projects.get(none)).toEqual({ none: "no_common_folder" });
      for (const id of ids("project-folder-none")) {
        expect(decided.tasks.get(id)).toEqual({ path: stored(id), state: "own" });
      }
      for (const id of ids("folder-no-project")) {
        expect(taskOf(id).project).toBeUndefined();
        expect(decided.tasks.get(id)).toEqual({ path: stored(id), state: "own" });
      }
      expect(decided.problems.filter((p) => p.code !== "folder-missing")).toEqual([]);
    },
  },
  {
    row: "paths[0] not a folder on this machine: no folder, reported, the task all the same",
    cases: ["folder-not-here"],
    check() {
      const decided = folders();
      for (const id of ids("folder-not-here")) {
        const path = (meta(id)["paths"] as string[])[0] ?? "";
        expect(taskOf(id).folder).toEqual({ path, index: 0 });
        expect(decided.tasks.get(id)).toEqual({ path, state: "missing" });
        expect(decided.problems.filter((p) => p.task === id)).toEqual([
          {
            code: "folder-missing",
            severity: "warning",
            file: "data/metadata.json",
            task: id,
            field: "paths",
            index: 0,
          },
        ]);
        // Its project holds no folder of it.
        const project = decided.projects.get(taskOf(id).project ?? "");
        expect(project === undefined || !("folder" in project) || project.folder !== path).toBe(
          true,
        );
      }
    },
  },
  {
    row: "paths[1…]: ext.planning.paths, reported",
    cases: ["paths-extra"],
    check() {
      for (const id of ids("paths-extra")) {
        expect(ext(id)["paths"]).toEqual((meta(id)["paths"] as string[]).slice(1));
        expect(problemsOf("paths-extra", id)).toHaveLength(1);
        expect(taskOf(id).folder?.path).toBe((meta(id)["paths"] as string[])[0]);
      }
    },
  },
  {
    row: "A folded check, or a [x] box in TODO.md no event decides: completed, pending, at the event time or the import time. The last check event wins over a box",
    cases: [
      "checked-in-todo",
      "ticked-in-file",
      "ticked-unchecked",
      "rollback-checked",
      "event-on-fallback-id",
      "rollback-unchecked",
      "event-web-without-ready",
    ],
    check() {
      // A ticked box no event decides: the page does not show it checked, the import completes it
      // as the person's own statement, under a code of its own.
      for (const id of ids("ticked-in-file")) {
        expect(ids("checked-in-todo")).toContain(id);
        expect(taskOf(id).lifecycle).toBe("completed");
        expect(taskOf(id).wrap).toBe("pending");
        expect(opsOf(id, "task.complete")).toEqual([
          { kind: "task.complete", task: { draft: id } },
        ]);
        expect(problemsOf("ticked-in-file", id)).toHaveLength(1);
        expect(problemsOf("checked-item", id)).toEqual([]);
      }
      // A ticked box whose last check event is an uncheck: unchecked, as on the page.
      for (const id of ids("ticked-unchecked")) {
        expect(indexed(id)?.file).toBe("TODO.md");
        expect(taskOf(id).lifecycle).toBe("active");
        expect(opsOf(id, "task.complete")).toEqual([]);
        expect(problemsOf("ticked-unchecked", id)).toHaveLength(1);
      }
      for (const name of ["rollback-checked", "event-on-fallback-id"]) {
        for (const w of where(name)) {
          const event = JSON.parse(read(`fixtures/planning-prototype/${w.file}`)) as { at: string };
          const at = event.at;
          expect(opsOf(w.task ?? "", "task.complete")).toEqual([
            { kind: "task.complete", task: { draft: w.task }, at: Date.parse(at) },
          ]);
          expect(problemsOf("checked-item", w.task ?? "")).toHaveLength(1);
        }
      }
      // Checked, then unchecked; and a check whose page write never finished: still active.
      for (const id of [...ids("rollback-unchecked"), ...ids("event-web-without-ready")]) {
        expect(taskOf(id).lifecycle).toBe("active");
        expect(opsOf(id, "task.complete")).toEqual([]);
      }
      // With the page's actions export, the browser's own check and the unfinished write count.
      const actions = readFileSync(join(ROOT, "fixtures", "planning-prototype.actions.json"));
      const merged = mapPrototype(parsePrototype({ ...input, actions }), options);
      for (const w of where("actions-export")) {
        const event = (
          JSON.parse(actions.toString("utf8")) as { events: { id: string; at: string }[] }
        ).events.find((e) => e.id === w.event);
        expect(opsOf(w.task ?? "", "task.complete")).toEqual([]);
        expect(opsOf(w.task ?? "", "task.complete", merged)).toEqual([
          { kind: "task.complete", task: { draft: w.task }, at: Date.parse(event?.at ?? "") },
        ]);
      }
      for (const id of ids("event-web-without-ready")) {
        expect(taskOf(id, merged).lifecycle).toBe("completed");
      }
      // --checked-as review keeps them active in Review.
      const review = mapPrototype(parse, { ...options, checkedAs: "review" });
      for (const id of [...ids("checked-in-todo"), ...ids("rollback-checked")]) {
        expect(taskOf(id, review).lifecycle).toBe("active");
        expect(createOf(id, review).status).toBe("review");
        expect(opsOf(id, "task.complete", review)).toEqual([]);
      }
    },
  },
  {
    row: "A folded focus: focus_on, the event instant's day where the import runs; unfocus clears it",
    cases: [
      "rollback-focus",
      "rollback-unfocus",
      "event-zone-order",
      "event-time-forms",
      "event-tie-by-id",
    ],
    check() {
      for (const w of where("rollback-focus")) {
        expect(createOf(w.task ?? "").focus).toBe(w.expect?.["focusOn"]);
        // 07:00Z on 3 November is still 2 November in Los Angeles: the day where the import runs.
        const west = mapPrototype(parse, { ...options, timeZone: "America/Los_Angeles" });
        expect(createOf(w.task ?? "", west).focus).toBe("2026-11-02");
      }
      for (const name of ["rollback-unfocus", "event-zone-order", "event-time-forms"]) {
        for (const id of ids(name)) expect(createOf(id).focus).toBeUndefined();
      }
      for (const w of where("event-tie-by-id").filter((x) => x.expect !== undefined)) {
        expect(createOf(w.task ?? "").focus).toBe("2026-11-05");
      }
    },
  },
  {
    row: "DONE.md with (done YYYY-MM-DD; <evidence>): completed that day, outcome, wrapped",
    cases: ["done-with-suffix", "done-reconciled"],
    check() {
      for (const w of where("done-reconciled")) {
        const id = w.task ?? "";
        expect(opsOf(id, "task.complete")).toEqual([
          {
            kind: "task.complete",
            task: { draft: id },
            outcome: w.expect?.["evidence"],
            at: nine(String(w.expect?.["date"])),
          },
        ]);
        expect(taskOf(id).wrap).toBe("wrapped");
      }
      for (const id of ids("done-with-suffix")) {
        expect(taskOf(id).lifecycle).toBe("completed");
        expect(taskOf(id).wrap).toBe("wrapped");
        expect(opsOf(id, "task.complete")[0]?.outcome).toBeTruthy();
      }
    },
  },
  {
    row: "DONE.md without it: completed at the import time, done_date_unknown, pending",
    cases: ["done-without-suffix", "done-unchecked-box", "invalid-date"],
    check() {
      for (const id of [...ids("done-without-suffix"), ...ids("done-unchecked-box")]) {
        expect(opsOf(id, "task.complete")).toEqual([
          { kind: "task.complete", task: { draft: id } },
        ]);
        expect(taskOf(id).wrap).toBe("pending");
        expect(ext(id)["done_date_unknown"]).toBe(true);
        expect(problemsOf("done-date-unknown", id)).toHaveLength(1);
      }
      // A done clause whose day is no date keeps its evidence as the outcome.
      for (const w of where("invalid-date").filter((x) => x.file === "DONE.md")) {
        const id = w.task ?? "";
        expect(opsOf(id, "task.complete")[0]?.at).toBeUndefined();
        expect(opsOf(id, "task.complete")[0]?.outcome).toBeTruthy();
        expect(ext(id)["done_date_unknown"]).toBe(true);
      }
    },
  },
  {
    row: "Every imported task: ext.planning {legacy_id, file, line} and one import log entry",
    cases: ["marked", "unmarked-task-line"],
    check() {
      expect(plan.tasks.map((t) => t.legacyId).sort()).toEqual(index.tasks.map((t) => t.id).sort());
      for (const t of index.tasks) {
        expect(ext(t.id)).toMatchObject({ legacy_id: t.id, file: t.file, line: t.line });
        const entries = opsOf(t.id, "log.add").filter((o) => o.body === IMPORT_LOG);
        expect(entries).toEqual([
          { kind: "log.add", task: { draft: t.id }, body: IMPORT_LOG, log_kind: "progress" },
        ]);
      }
    },
  },
  {
    row: "Unknown metadata keys: ext.planning.<key>, never a space field",
    cases: ["unknown-metadata-key"],
    check() {
      for (const w of where("unknown-metadata-key")) {
        const id = w.task ?? "";
        expect(ext(id)[w.key ?? ""]).toEqual(meta(id)[w.key ?? ""]);
        expect(Object.keys(createOf(id))).not.toContain(w.key);
      }
    },
  },
  {
    row: "Metadata keys checked, focus and ticked: kept in ext.planning and reported, never applied",
    cases: ["metadata-state-key"],
    check() {
      for (const w of where("metadata-state-key")) {
        const id = w.task ?? "";
        const key = w.key ?? "";
        expect(ext(id)[key]).toEqual(meta(id)[key]);
        const index = Object.keys(meta(id))
          .filter((k) => !KNOWN_KEYS.has(k))
          .indexOf(key);
        expect(problemsOf("metadata-state-key", id).map((p) => p.index)).toContain(index);
        // No event decides the task, and the key neither checks nor stars it.
        if (parse.events.state.get(id) === undefined) {
          expect(taskOf(id).lifecycle).toBe("active");
          expect(createOf(id).focus).toBeUndefined();
        }
      }
    },
  },
  {
    row: "An ID in both ledgers: the DONE.md line is the task, as the page shows it",
    cases: ["in-both-ledgers"],
    check() {
      const [open, done] = [true, false].map((hidden) =>
        where("in-both-ledgers").find((w) => w.expect?.["hidden"] === hidden),
      );
      const id = done?.task ?? "";
      expect(open?.task).toBe(id);
      expect(ext(id)).toMatchObject({ legacy_id: id, file: "DONE.md", line: done?.line });
      expect(taskOf(id).lifecycle).toBe("completed");
      expect(plan.tasks.filter((t) => t.legacyId === id)).toHaveLength(1);
      expect(parse.problems).toContainEqual({
        code: "open-copy-hidden",
        severity: "warning",
        file: "TODO.md",
        line: open?.line,
        task: id,
      });
    },
  },
  {
    row: "Links of the page's own kinds: a file: link is a kept path, a t3-thread: link a session",
    cases: ["source-file-link", "source-session"],
    check() {
      for (const id of ids("source-file-link")) {
        const links = (meta(id)["sources"] as { url: string }[]).filter((s) =>
          s.url.startsWith("file:"),
        );
        expect(links.length).toBeGreaterThan(0);
        for (const link of links) {
          expect(ext(id)["paths"]).toContain(decodeURIComponent(new URL(link.url).pathname));
          expect(opsOf(id, "source.add").map((o) => o.source.url)).not.toContain(link.url);
        }
        expect(problemsOf("source-file-link", id)).toHaveLength(links.length);
      }
      for (const id of ids("source-session")) {
        const thread = (meta(id)["sources"] as { url: string }[]).find((s) =>
          s.url.startsWith("t3-thread:"),
        );
        const add = opsOf(id, "source.add").find((o) => o.source.url === thread?.url);
        expect(add?.source.kind).toBe("session");
        expect(add?.source.key).toBe(`url:${thread?.url ?? ""}`);
      }
    },
  },
];

/** The metadata keys of the prototype's grammar (A7 3.15.2): every other key is `extra`. */
const KNOWN_KEYS = new Set([
  "category",
  "project",
  "status",
  "owner",
  "priority",
  "rank",
  "next",
  "evidence",
  "source_date",
  "reviewed",
  "confidence",
  "due",
  "sources",
  "paths",
]);

describe("[A7.3.15.importer.mapping] each mapping row of A7 3.15.3 on its fixture cases", () => {
  for (const { row, check } of ROWS) test(row, check);

  test("every row rests on cases the index places, and every fixture case of a row is used", () => {
    for (const { row, cases } of ROWS) {
      expect(cases.length, row).toBeGreaterThan(0);
      for (const name of cases)
        expect(index.cases[name]?.where.length, `${row}: ${name}`).toBeGreaterThan(0);
    }
  });

  test("what is not a task (A7 3.15.7): orphans, events for no task, later duplicates", () => {
    for (const id of ids("metadata-orphan"))
      expect(plan.tasks.some((t) => t.legacyId === id)).toBe(false);
    for (const id of ids("event-unknown-task")) {
      expect(plan.tasks.some((t) => t.legacyId === id)).toBe(false);
    }
    // --include-orphans creates them in Backlog, titled by their ID.
    const orphans = mapPrototype(parse, { ...options, includeOrphans: true });
    for (const id of ids("metadata-orphan")) {
      const create = createOf(id, orphans);
      expect(create.status).toBe("backlog");
      expect(create.title).toBe(id);
      expect(ext(id, orphans)).toEqual({ legacy_id: id, file: "data/metadata.json" });
    }
    expect(orphans.counts.orphansIncluded).toBe(index.counts["metadataOrphans"]);
  });

  test("the counts reconcile with the index: every task line is one task, active or completed", () => {
    expect(plan.counts.tasks + plan.counts.duplicatesLeftOut).toBe(index.counts["taskLines"]);
    expect(plan.counts.active + plan.counts.completed).toBe(plan.counts.tasks);
    expect(plan.counts.aliases).toBe(plan.counts.tasks);
    expect(plan.counts.areas).toBe(plan.areas.length);
    expect(plan.counts.projects).toBe(plan.projects.length);
    expect(plan.counts.links).toBe(
      plan.tasks.reduce((n, t) => n + t.ops.filter((o) => o.kind === "source.add").length, 0),
    );
  });

  test("the plan's problems carry no task text, and each fits the report's shape", () => {
    for (const p of [...parse.problems, ...plan.problems]) {
      expect(ImportProblem.safeParse(p).success, JSON.stringify(p)).toBe(true);
    }
    const serialised = JSON.stringify(plan.problems);
    for (const t of index.tasks) {
      expect(serialised).not.toContain(t.title);
      if (t.body.length > 3) expect(serialised).not.toContain(t.body);
    }
    for (const s of plan.sources) {
      expect(serialised).not.toContain(s.url);
      expect(serialised).not.toContain(s.title);
    }
  });
});
