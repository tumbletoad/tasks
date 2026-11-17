// M7.04's Verify line (A7 3.14): `tasks import planning <fixture> --dry-run --json` reports the
// fixture index's counts, with zero source-hash changes. Against a real service child with one
// space, the committed synthetic prototype as the input, fixture data only. Also what the dry run
// must not do: write an operation, write outside its run folder, or answer an agent or a script.
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ImportPlanningPreviewResult } from "@tasks/contracts";
import { undoText } from "../src/import.ts";
import { runMain, startWorld, type CliWorld } from "./cli-harness.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE = join(ROOT, "fixtures", "planning-prototype");
const ACTIONS = join(ROOT, "fixtures", "planning-prototype.actions.json");

interface Index {
  me: string;
  counts: Record<string, number>;
  actions: { events: number; added: string[] };
}
const index = JSON.parse(
  readFileSync(join(ROOT, "fixtures", "planning-prototype.index.json"), "utf8"),
) as Index;

/** The index's ledger counts by the report's names. */
const snake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

let world: CliWorld;
let scratch = "";

beforeAll(async () => {
  world = await startWorld("ip");
  scratch = mkdtempSync(join(tmpdir(), "tasks-m7-04-"));
}, 180_000);

afterAll(async () => {
  if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
  await world.close();
}, 120_000);

const run = (argv: string[], options: { tty?: boolean; env?: Record<string, string> } = {}) =>
  runMain(argv, { home: world.home, cwd: world.root, tty: options.tty ?? true, ...options });
const report = (stdout: string) => ImportPlanningPreviewResult.parse(JSON.parse(stdout));

/** The space's `as_of`: it moves with every commit. */
async function asOf(): Promise<string> {
  const ran = await run(["status", "--json"], { tty: false });
  return (JSON.parse(ran.stdout) as { as_of: string }).as_of;
}

/** Every path under `folder`, relative, sorted. */
const tree = (folder: string): string[] =>
  readdirSync(folder, { recursive: true, withFileTypes: true })
    .map((e) =>
      join(e.parentPath, e.name)
        .slice(folder.length + 1)
        .replaceAll("\\", "/"),
    )
    .sort();

describe("[A7.3.15.importer.dry-run] tasks import planning --dry-run", () => {
  test("the fixture's counts, zero source-hash changes, a token, and nothing written but the run folder", async () => {
    const before = await asOf();
    const space = tree(world.spaceFolder);
    const ran = await run(["import", "planning", FIXTURE, "--dry-run", "--json"]);
    expect(ran.code, ran.stdout).toBe(0);
    const r = report(ran.stdout);

    // The Verify line: every ledger count of the index, and no input changed during the run.
    for (const [name, value] of Object.entries(index.counts)) {
      expect(r.counts[snake(name) as keyof typeof r.counts], name).toBe(value);
    }
    expect(r.counts.source_changes).toBe(0);
    expect(r.reconciled).toBe(true);
    expect(r.blocked).toBe(false);
    expect(r.token).toMatch(/^pv1_[A-Za-z0-9_-]{43}$/);
    expect(r.counts.tasks + r.counts.duplicates_left_out).toBe(index.counts["taskLines"]);

    // No operation: the space's as_of did not move. Only the run folder was added.
    expect(await asOf()).toBe(before);
    const runFolder = join(world.spaceFolder, "exchange", "planning", r.run);
    expect(r.folder).toBe(runFolder);
    // The service's own daily backup may land in backups/ meanwhile: its start's maintenance.
    const added = tree(world.spaceFolder).filter(
      (p) => !space.includes(p) && p !== "backups" && !p.startsWith("backups/"),
    );
    expect(
      added.filter(
        (p) => !p.startsWith(`exchange/planning/${r.run}`) && !/^exchange(\/planning)?$/.test(p),
      ),
    ).toEqual([]);
    expect(tree(runFolder).filter((p) => !p.startsWith("input/"))).toEqual([
      "input",
      "report.json",
      "report.md",
    ]);
    // The copy holds the inputs only: no code, no agent file, no notes.
    expect(
      tree(join(runFolder, "input")).some((p) =>
        /planning\.py|index\.html|AGENTS|context|reviews|snapshots/.test(p),
      ),
    ).toBe(false);
    // report.json is the whole report; report.md is for a person.
    const whole = ImportPlanningPreviewResult.parse(
      JSON.parse(readFileSync(join(runFolder, "report.json"), "utf8")),
    );
    expect(whole.token).toBe(r.token);
    expect(whole.counts).toEqual(r.counts);
    const md = readFileSync(join(runFolder, "report.md"), "utf8");
    for (const section of ["## 1.", "## 2.", "## 3.", "## 4.", "## 5.", "## 6."]) {
      expect(md).toContain(section);
    }
    expect(md).toContain(r.token ?? "-");
    if (process.platform !== "win32") {
      expect(statSync(runFolder).mode & 0o777).toBe(0o700);
      expect(statSync(join(runFolder, "report.json")).mode & 0o777).toBe(0o600);
    }

    // Needs attention lists the ticked boxes apart from the event check-offs.
    const codes = new Map(r.attention.map((a) => [a.code, a.count]));
    expect(codes.get("ticked-in-file")).toBe(2);
    expect(codes.get("ticked-unchecked")).toBe(1);
    expect(codes.get("checked-item")).toBeGreaterThan(0);
    expect(codes.get("open-copy-hidden")).toBe(1);
    expect(codes.get("event-not-ready")).toBe(index.counts["eventsNotReady"]);
    expect(
      [...codes.keys()].every((c) => r.attention.find((a) => a.code === c)?.severity === "warning"),
    ).toBe(true);
  }, 120_000);

  test("the person's text: a summary, with the run and the token", async () => {
    const ran = await run([
      "import",
      "planning",
      FIXTURE,
      "--dry-run",
      "--me",
      index.me,
    ]);
    expect(ran.code, ran.stdout).toBe(0);
    expect(ran.stdout).toContain("nothing was written to the space");
    expect(ran.stdout).toMatch(/Preview token: pv1_/);
    expect(ran.stdout).toContain(`${index.me} (you)`);
    expect(ran.stdout).toContain("ticked-in-file");
    expect(ran.stdout).toMatch(/Task folders: \d+, \d+ not on this machine\./);
  }, 120_000);

  test("the actions export adds the browser's own events and the unfinished write", async () => {
    const ran = await run([
      "import",
      "planning",
      FIXTURE,
      "--dry-run",
      "--actions",
      ACTIONS,
      "--json",
    ]);
    expect(ran.code, ran.stdout).toBe(0);
    const r = report(ran.stdout);
    expect(r.counts.actions_events).toBe(index.actions.events);
    expect(r.counts.actions_added).toBe(index.actions.added.length);
    expect(r.counts.source_changes).toBe(0);
    expect(r.blocked).toBe(false);
    expect(readdirSync(r.folder)).toContain("actions.json");
    expect(readFileSync(join(r.folder, "actions.json"))).toEqual(readFileSync(ACTIONS));
  }, 120_000);

  test("an error blocks: no token, and the report says why", async () => {
    const broken = join(scratch, "broken");
    cpSync(FIXTURE, broken, { recursive: true });
    writeFileSync(join(broken, "data", "metadata.json"), "{ not json");
    const ran = await run(["import", "planning", broken, "--dry-run", "--json"]);
    expect(ran.code, ran.stdout).toBe(0);
    const r = report(ran.stdout);
    expect(r.blocked).toBe(true);
    expect(r.token).toBeUndefined();
    expect(r.attention[0]).toMatchObject({ code: "json-invalid", severity: "error" });
    expect(readFileSync(join(r.folder, "report.md"), "utf8")).toContain("**Blocked.**");
    // The input text is in no problem.
    expect(ran.stdout).not.toContain("not json");
  }, 120_000);

  test("only the user: an agent's shell and a script are refused, and nothing is made", async () => {
    const before = readdirSync(join(world.spaceFolder, "exchange", "planning")).sort();
    for (const options of [{ tty: false }, { tty: true, env: { CLAUDECODE: "1" } }]) {
      const ran = await run(["import", "planning", FIXTURE, "--dry-run", "--json"], options);
      expect(ran.code).toBe(5);
      expect(JSON.parse(ran.stdout)).toMatchObject({
        error: { code: "forbidden", data: { rule: "user_only" } },
      });
    }
    expect(readdirSync(join(world.spaceFolder, "exchange", "planning")).sort()).toEqual(before);
  }, 120_000);

  test("[A7.3.15.importer.apply] the apply and the undo, for a person and only the user", async () => {
    const copy = join(scratch, "apply");
    cpSync(FIXTURE, copy, { recursive: true });
    const dry = report((await run(["import", "planning", copy, "--dry-run", "--json"])).stdout);
    const token = dry.token ?? "";
    // An agent's shell and a script cannot apply it.
    for (const options of [{ tty: false }, { tty: true, env: { CLAUDECODE: "1" } }]) {
      const ran = await run(
        ["import", "planning", "--apply", dry.run, "--token", token, "--json"],
        options,
      );
      expect(JSON.parse(ran.stdout)).toMatchObject({
        error: { code: "forbidden", data: { rule: "user_only" } },
      });
    }
    const applied = await run(["import", "planning", "--apply", dry.run, "--token", token]);
    expect(applied.code, applied.stdout).toBe(0);
    expect(applied.stdout).toContain(`Applied run ${dry.run}`);
    expect(applied.stdout).toMatch(/Backup before it: pre-import-/);
    expect(applied.stdout).toContain(`tasks import planning --undo ${dry.run}`);
    // The same command again applies it once.
    const again = await run(["import", "planning", "--apply", dry.run, "--token", token, "--json"]);
    expect(JSON.parse(again.stdout)).toMatchObject({ status: "applied", replayed: true });
    const undone = await run(["import", "planning", "--undo", dry.run]);
    expect(undone.code, undone.stdout).toBe(0);
    expect(undone.stdout).toContain(`Undid run ${dry.run}`);
  }, 120_000);

  test("[A7.3.15.importer.undo] the undo's text counts every kept task and says where the unlisted ones are", () => {
    const kept = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ task: `M-${String(i + 1)}`, fields: ["title"] }));
    const answer = {
      run: "ex_0c4g8k2n6r0v4y8b2e6h0m4q8t",
      commit: "op_0c4g8k2n6r0v4y8b2e6h0m4q8t",
      undone: "op_1c4g8k2n6r0v4y8b2e6h0m4q8t",
      removed: 3,
      restored: 1,
      as_of: "1.ai_0c4g8k2n6r0v4y8b2e6h0m4q8t.9",
    };
    const all = undoText({ ...answer, kept: kept(2), kept_more: 0 });
    expect(all).toContain("kept as they are: 2 tasks.");
    expect(all).not.toContain("more");
    const cut = undoText({ ...answer, kept: kept(3), kept_more: 2_400 });
    expect(cut).toContain("kept as they are: 2403 tasks.");
    expect(cut).toContain("and 2400 more, listed in the run's undo.json");
    const unsaved = undoText({ ...answer, kept: kept(3), kept_more: 2_400, unsaved: true });
    expect(unsaved).toContain("kept as they are: 2403 tasks.");
    expect(unsaved).toContain(
      "and 2400 more, not listed: the run's undo.json could not be written",
    );
    expect(unsaved).not.toContain("listed in the run's undo.json");
  });

  test("usage: a folder that is not there, a missing --dry-run, an option of a later build", async () => {
    const missing = await run([
      "import",
      "planning",
      join(scratch, "nowhere"),
      "--dry-run",
      "--json",
    ]);
    expect(JSON.parse(missing.stdout)).toMatchObject({ error: { code: "not_found" } });
    const run0 = "ex_0c4g8k2n6r0v4y8b2e6h0m4q8t";
    for (const argv of [
      ["import", "planning", FIXTURE, "--json"],
      ["import", "planning", "--apply", "ex_x", "--json"],
      ["import", "planning", "--apply", run0, "--json"],
      ["import", "planning", "--undo", run0, "--token", `pv1_${"A".repeat(43)}`, "--json"],
      ["import", "planning", FIXTURE, "--dry-run", "--undo", run0, "--json"],
      ["import", "elsewhere", FIXTURE, "--dry-run", "--json"],
      ["import", "planning", FIXTURE, "--dry-run", "--checked-as", "maybe", "--json"],
    ]) {
      const ran = await run(argv);
      expect(ran.code, argv.join(" ")).toBe(2);
      expect(JSON.parse(ran.stdout)).toMatchObject({ error: { code: "invalid_input" } });
    }
    const help = await run(["help", "import"]);
    expect(help.stdout).toContain("tasks import planning <folder> --dry-run");
  }, 120_000);
});
