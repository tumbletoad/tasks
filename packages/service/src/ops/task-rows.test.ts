// Where a task's row says it opens on the machine that serves the feed: the rule the launch uses
// (storage's decideLaunchFolder) over the folder rows a row read carries. Fixture rows and
// temporary folders only.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Row } from "@ttasks/storage";
import { taskRows, type FeedHere } from "./task-rows.ts";

const HERE = "m_7c0hq2m4w9d8k1r6t3v5x0b2nf";
const LAPTOP = "m_3z8sm956jp8dajmtsar5kx026c";
// Made in beforeAll: collecting the tests (the manifest check) loads this file but runs no hook.
let home = "";
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "ttasks-rows-"));
});
afterAll(() => {
  if (home !== "") rmSync(home, { recursive: true, force: true });
});

const sep = process.platform === "win32" ? "\\" : "/";
const folder = (machine: string, name: string, path: string, version = 1) => ({
  id: `fo_${String(version)}`,
  machine,
  name,
  path,
  version,
});
const row = (title: string, own: unknown[], project: unknown[]): Row => ({
  id: `t_${title}`,
  ref: 1,
  title,
  x_folders_own: JSON.stringify(own),
  x_folders_project: JSON.stringify(project),
});

describe("[A3.3.4.here.folders] a row opens where the launch would", () => {
  test("its own folder here, else its project's, else another machine by name, else none", async () => {
    const here: FeedHere = { machine: HERE, home, platform: process.platform };
    const rows = await taskRows(
      [
        row("own", [folder(HERE, "desk", "~")], [folder(HERE, "desk", `~${sep}gone`)]),
        row("project", [folder(LAPTOP, "laptop", "/home/mira/x")], [folder(HERE, "desk", "~")]),
        row("missing", [], [folder(HERE, "desk", `~${sep}not-there`)]),
        row("elsewhere", [], [folder(LAPTOP, "mira-laptop", "/home/mira/work/portal")]),
        row("none", [], []),
      ],
      "M",
      here,
    );
    expect(rows.map((r) => [r["title"], r["place"]])).toEqual([
      ["own", { state: "here" }],
      ["project", { state: "here" }],
      ["missing", { state: "missing" }],
      ["elsewhere", { state: "elsewhere", machine: "mira-laptop" }],
      ["none", undefined],
    ]);
    // No folder row rides on the row itself, and a feed that names no machine shows none.
    expect(rows[0]).not.toHaveProperty("x_folders_own");
    const bare = await taskRows([row("own", [folder(HERE, "desk", "~")], [])], "M");
    expect(bare[0]).not.toHaveProperty("place");
  });
});

describe("[M6.page.run-row] a row says when its newest run works or needs the person", () => {
  const run = (state: string, reason: string | null = null): Row => ({
    id: "t_run",
    ref: 2,
    title: "run",
    x_run: JSON.stringify({ state, reason, instance: "codex-work" }),
  });
  test("queued to stopping, and not confirmed ended, is working; a question is needs_you; the rest nothing", async () => {
    const rows = await taskRows(
      [
        run("queued"),
        run("running"),
        run("cancelling"),
        run("unknown", "stop_timed_out"),
        run("failed", "needs_input"),
        run("failed", "agent_error"),
        run("succeeded"),
        run("cancelled"),
        { id: "t_none", ref: 3, title: "none", x_run: null },
      ],
      "M",
    );
    const working = { state: "working", instance: "codex-work" };
    expect(rows.map((r) => r["run"])).toEqual([
      working,
      working,
      working,
      working,
      { state: "needs_you", instance: "codex-work" },
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(rows[0]).not.toHaveProperty("x_run");
  });

  test("a newer run's question shows over an older run that may still work; an ended follow-up does not hide it", async () => {
    const json = (state: string, reason: string | null = null) =>
      JSON.stringify({ state, reason, instance: "codex-work" });
    const rows = await taskRows(
      [
        {
          id: "t_asks",
          ref: 4,
          title: "asks",
          x_run: json("failed", "needs_input"),
          x_run_open: json("unknown", "stop_timed_out"),
        },
        {
          id: "t_works",
          ref: 5,
          title: "works",
          x_run: json("cancelled"),
          x_run_open: json("running"),
        },
      ],
      "M",
    );
    expect(rows.map((r) => r["run"])).toEqual([
      { state: "needs_you", instance: "codex-work" },
      { state: "working", instance: "codex-work" },
    ]);
    expect(rows[0]).not.toHaveProperty("x_run_open");
  });
});
