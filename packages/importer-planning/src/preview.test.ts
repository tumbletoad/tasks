// The dry run's report and token (A7 3.15.4), pure: what blocks, what reconciles, the proposed
// roots, report.md, and a token that changes with everything the apply depends on and with
// nothing else. Small synthetic inputs and the committed fixture; hosts are example domains.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ImportPlanningPreviewResult } from "@tasks/contracts";
import { beforeAll, describe, expect, test } from "vitest";
import {
  mapPrototype,
  parsePrototype,
  previewOf,
  previewToken,
  proposeRoots,
  readInput,
  renderPreview,
  type ImportPlan,
  type MappingOptions,
  type PreviewRun,
  type PrototypeInput,
  type PrototypeParse,
} from "./index.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const options: MappingOptions = {
  me: "Mira Okafor",
  roots: { work: "/home/mira/work" },
  timeZone: "Europe/Lisbon",
};
const space: PreviewRun["space"] = {
  id: "sp_7c0hq2m4w9d8k1r6t3v5x0b2nf",
  epoch: 1,
  incarnation: "ai_0c4g8k2n6r0v4y8b2e6h0m4q8t",
  refPrefix: "M",
  nextRef: 16,
  aliases: [],
  sources: [],
  areas: [],
  projects: [],
};
const runOf = (more: Partial<PreviewRun> = {}): PreviewRun => ({
  run: "ex_0c4g8k2n6r0v4y8b2e6h0m4q8t",
  folder: "/home/mira/.tasks/spaces/mira/exchange/planning/ex_0c4g8k2n6r0v4y8b2e6h0m4q8t",
  options,
  roots: [{ id: "work", folder: "/home/mira/work", origin: "machine" }],
  inputs: [
    { path: "TODO.md", size: 10, sha256: "a".repeat(64) },
    { path: "DONE.md", size: 0, sha256: "b".repeat(64) },
  ],
  problems: [],
  verified: [],
  space,
  missing: new Set(),
  ...more,
});

function small(input: Partial<PrototypeInput> = {}, more: Partial<MappingOptions> = {}) {
  const parse = parsePrototype({ todo: "", done: "", events: [], ...input });
  return { parse, plan: mapPrototype(parse, { ...options, ...more }) };
}

const TODO =
  "## Lumen\n" +
  "- [ ] **Fix the export** Two rows left. <!-- task:a -->\n" +
  "- [x] **Ship the notes** <!-- task:b -->\n" +
  "- [ ] **Unmarked**\n";
const META = JSON.stringify({
  a: {
    category: "Lumen",
    project: "Portal",
    owner: "Tomas",
    sources: [{ label: "LUM-7 Export", url: "https://tickets.lumen.example/browse/LUM-7" }],
    paths: ["/home/mira/work/lumen/portal"],
  },
  b: { category: "Lumen", paths: ["/home/mira/Documents/notes"] },
});

let fixture: { parse: PrototypeParse; plan: ImportPlan };

beforeAll(async () => {
  const { input } = await readInput(join(ROOT, "fixtures", "planning-prototype"));
  const parse = parsePrototype(input);
  fixture = { parse, plan: mapPrototype(parse, options) };
});

describe("[A7.3.15.importer.preview] the dry run's report and token", () => {
  test("a report of the fixture fits the contract, reconciles and has a token", () => {
    const { report, result } = previewOf(fixture.parse, fixture.plan, runOf());
    expect(ImportPlanningPreviewResult.safeParse(report).success).toBe(true);
    expect(ImportPlanningPreviewResult.safeParse(result).success).toBe(true);
    expect(report.reconciled).toBe(true);
    expect(report.blocked).toBe(false);
    expect(report.token).toBe(previewToken(fixture.plan, runOf()));
    // Warnings never block; the fixture holds many.
    expect(report.attention.length).toBeGreaterThan(5);
    expect(report.attention.every((a) => a.severity === "warning")).toBe(true);
    expect(report.tasks.map((t) => t.legacy_id)).toEqual(fixture.plan.tasks.map((t) => t.legacyId));
    expect(report.tasks[0]?.ref).toBe("M-16");
    expect(report.tasks.at(-1)?.ref).toBe(`M-${String(15 + fixture.plan.tasks.length)}`);
    const md = renderPreview(report);
    for (const n of [1, 2, 3, 4, 5, 6]) expect(md).toContain(`## ${String(n)}.`);
  });

  test("every error blocks, and no warning does", () => {
    const warn = small({ todo: TODO, metadata: META });
    expect(previewOf(warn.parse, warn.plan, runOf()).report.blocked).toBe(false);
    for (const p of [
      parsePrototype({ todo: TODO, done: "", metadata: "{ x", events: [] }),
      parsePrototype({ todo: `${TODO}${TODO}`, done: "", events: [] }),
    ]) {
      const plan = mapPrototype(p, options);
      const { report } = previewOf(p, plan, runOf());
      expect(report.blocked).toBe(true);
      expect(report.token).toBeUndefined();
      expect(report.attention[0]?.severity).toBe("error");
      expect(renderPreview(report)).toContain("**Blocked.**");
    }
    // A problem of the copy or of the second check blocks the same way.
    const changed = previewOf(
      warn.parse,
      warn.plan,
      runOf({ verified: [{ code: "source-changed", severity: "error", file: "TODO.md" }] }),
    );
    expect(changed.report.blocked).toBe(true);
    expect(changed.report.counts.source_changes).toBe(1);
  });

  test("what only the space and this machine tell: held keys, earlier imports, missing folders", () => {
    const { parse, plan } = small({ todo: TODO, metadata: META });
    const { report } = previewOf(
      parse,
      plan,
      runOf({
        space: {
          ...space,
          aliases: [{ alias: "a", task: "t_0c4g8k2n6r0v4y8b2e6h0m4q8t", version: 3 }],
          sources: [{ key: "jira:LUM-7", id: "s_0c4g8k2n6r0v4y8b2e6h0m4q8t", version: 2 }],
          areas: [{ slug: "lumen", id: "ar_0c4g8k2n6r0v4y8b2e6h0m4q8t", version: 1 }],
        },
        missing: new Set(["a"]),
      }),
    );
    expect(report.counts).toMatchObject({
      sources_existing: 1,
      areas_existing: 1,
      projects_existing: 0,
      places: 1,
      places_missing: 1,
    });
    expect(report.problems.filter((p) => /exists|imported|missing/.test(p.code))).toEqual([
      { code: "legacy-id-imported", severity: "warning", file: "TODO.md", line: 2, task: "a" },
      {
        code: "source-key-exists",
        severity: "warning",
        file: "data/metadata.json",
        task: "a",
        field: "sources",
      },
      {
        code: "place-missing",
        severity: "warning",
        file: "data/metadata.json",
        task: "a",
        field: "paths",
      },
    ]);
    expect(report.tasks[0]).toMatchObject({
      legacy_id: "a",
      area: "Lumen",
      project: "Portal",
      place: { root: "work", path: "lumen/portal" },
      place_missing: true,
      imported: true,
    });
    // The folder under no root gets a proposed root, named by its last folder.
    expect(report.roots).toEqual([
      { id: "work", folder: "/home/mira/work", origin: "machine", places: 1, missing: 1 },
      {
        id: "documents",
        folder: "/home/mira/Documents",
        origin: "proposed",
        places: 1,
        missing: 0,
      },
    ]);
    expect(report.statuses).toEqual([{ prototype: "none", status: "open", count: 3 }]);
    expect(report.owners).toEqual([{ name: "Tomas", me: false, tasks: 1 }]);
  });

  test("the token changes with everything the apply depends on, and with nothing else", () => {
    const base = small({ todo: TODO, metadata: META });
    const token = previewToken(base.plan, runOf());
    expect(token).toMatch(/^pv1_[A-Za-z0-9_-]{43}$/);
    // The same run gives the same token: one plan, one hash.
    expect(previewToken(small({ todo: TODO, metadata: META }).plan, runOf())).toBe(token);
    const row = { slug: "lumen", id: "ar_0c4g8k2n6r0v4y8b2e6h0m4q8t", version: 1 };
    const changes: [string, string][] = [
      ["run", previewToken(base.plan, runOf({ run: "ex_1c4g8k2n6r0v4y8b2e6h0m4q8t" }))],
      ["epoch", previewToken(base.plan, runOf({ space: { ...space, epoch: 2 } }))],
      ["incarnation", previewToken(base.plan, runOf({ space: { ...space, incarnation: "ai_x" } }))],
      [
        "an input",
        previewToken(
          base.plan,
          runOf({ inputs: [{ path: "TODO.md", size: 10, sha256: "c".repeat(64) }] }),
        ),
      ],
      [
        "the actions export",
        previewToken(
          base.plan,
          runOf({ actions: { path: "actions.json", size: 2, sha256: "d".repeat(64) } }),
        ),
      ],
      ["--me", previewToken(base.plan, runOf({ options: { ...options, me: "Tomas" } }))],
      [
        "--roots",
        previewToken(
          base.plan,
          runOf({ options: { ...options, roots: { work: "/home/mira/work2" } } }),
        ),
      ],
      [
        "--checked-as",
        previewToken(base.plan, runOf({ options: { ...options, checkedAs: "review" } })),
      ],
      [
        "--include-orphans",
        previewToken(base.plan, runOf({ options: { ...options, includeOrphans: true } })),
      ],
      [
        "the time zone",
        previewToken(base.plan, runOf({ options: { ...options, timeZone: "Europe/Paris" } })),
      ],
      ["the plan", previewToken(small({ todo: `${TODO}- [ ] **More**\n` }).plan, runOf())],
      [
        "an area the plan reuses",
        previewToken(base.plan, runOf({ space: { ...space, areas: [row] } })),
      ],
      [
        "its version",
        previewToken(base.plan, runOf({ space: { ...space, areas: [{ ...row, version: 2 }] } })),
      ],
      [
        "a held key",
        previewToken(
          base.plan,
          runOf({
            space: { ...space, sources: [{ key: "jira:LUM-7", id: "s_x", version: 1 }] },
          }),
        ),
      ],
      [
        "an earlier import",
        previewToken(
          base.plan,
          runOf({ space: { ...space, aliases: [{ alias: "a", task: "t_x", version: 1 }] } }),
        ),
      ],
    ];
    const seen = new Set([token]);
    for (const [what, changed] of changes) {
      expect(changed, what).not.toBe(token);
      seen.add(changed);
    }
    expect(seen.size).toBe(changes.length + 1);
    // Rows the plan does not meet, the folder, the roots' origin and the next reference: unpinned.
    for (const same of [
      runOf({ space: { ...space, nextRef: 99, refPrefix: "X" } }),
      runOf({ space: { ...space, areas: [{ ...row, slug: "home" }] } }),
      runOf({ space: { ...space, sources: [{ key: "jira:LUM-8", id: "s_x", version: 1 }] } }),
      runOf({ folder: "/elsewhere" }),
      runOf({ missing: new Set(["a"]) }),
    ]) {
      expect(previewToken(base.plan, same)).toBe(token);
    }
  });

  test("proposed roots: grouped by a person's folder, named, never taking an ID in use", () => {
    expect(
      proposeRoots(
        [
          "/home/mira/Documents/health",
          "/home/mira/Documents/tax",
          "/mnt/shed/fence-plans",
          "/home/mira/Café Notes/x",
          "C:\\Users\\mira\\Work Files\\a",
        ],
        ["documents"],
      ),
    ).toEqual([
      { id: "documents-2", folder: "/home/mira/Documents", places: 2 },
      { id: "fence-plans", folder: "/mnt/shed/fence-plans", places: 1 },
      { id: "cafe-notes", folder: "/home/mira/Café Notes", places: 1 },
      { id: "work-files", folder: "C:\\Users\\mira\\Work Files", places: 1 },
    ]);
  });

  test("report.md writes the person's own text as text, never as markup", () => {
    const { parse, plan } = small({
      todo: "- [ ] **A** <!-- task:a -->\n",
      metadata: JSON.stringify({ a: { category: "Work | *bold* <b>", owner: "Tomas `x`" } }),
    });
    const md = renderPreview(previewOf(parse, plan, runOf()).report);
    expect(md).toContain("Work \\| \\*bold\\* \\<b\\>");
    expect(md).toContain("Tomas \\`x\\`");
    expect(md).not.toContain("<b>");
  });
});
