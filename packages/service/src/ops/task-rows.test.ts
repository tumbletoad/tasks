// Where a task's row says it opens on the machine that serves the feed: the rule the launch uses
// (storage's decideLaunchFolder) over the folder rows a row read carries. Fixture rows and
// temporary folders only.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { Row } from "@tasks/storage";
import { taskRows, type FeedHere } from "./task-rows.ts";

const HERE = "m_7c0hq2m4w9d8k1r6t3v5x0b2nf";
const LAPTOP = "m_3z8sm956jp8dajmtsar5kx026c";
const home = mkdtempSync(join(tmpdir(), "tasks-rows-"));
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
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
