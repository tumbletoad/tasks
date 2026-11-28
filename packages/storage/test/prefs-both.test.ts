// A space's preferences, the same ordinary sequences on today's writer and the tree's: an effort
// level renamed, one dropped with tasks on it, two renames in one request; a preference set for the
// first time and again on a stale read. The answers, with the tasks each move moved, and what a
// reader sees of the levels, the window and the tasks' sizes are compared. Fixture text only.
import { afterAll, describe, test } from "vitest";
import { newId } from "../src/ids.ts";
import { listPreference, readSpacePreference } from "../src/preferences.ts";
import type { Connection } from "../src/driver.ts";
import {
  both,
  TodaySession,
  todayAnswer,
  TreeSession,
  treeAnswer,
  type Base,
  type Sequence,
  type Side,
} from "./both-helpers.ts";
import { tempFolders } from "./space-helpers.ts";
import { fixtureCopies } from "./write-helpers.ts";

const temp = tempFolders("prefs-both");
const fixture = fixtureCopies(temp.make);
afterAll(temp.cleanup);

type Move = { from: string; to: string | null };
type Step =
  | { do: "task"; title: string; effort: string }
  | { do: "levels"; keys: string[]; moves?: Move[]; base?: Base }
  | { do: "window"; days: number; base?: Base }
  | { do: "size"; task: string; effort: string; base?: Base }
  | { do: "mark" };

const levels = (keys: string[]) => keys.map((key) => ({ key }));

/** What a reader sees: the levels, the capture window, and each task's size. */
const seenOf = (conn: Connection, sizes: Record<string, unknown>[]) => ({
  levels: listPreference(conn, "tasks.effort_scale"),
  window: readSpacePreference(conn, "tasks.dedupe_window_days").value,
  sizes: sizes.map((r) => [r["title"], r["effort"]]),
});

/** What a change of levels said it moved, and the tasks left on a size the levels lack. */
const movedOf = (said: Record<string, unknown> | undefined) =>
  said?.["moved"] === undefined ? undefined : { moved: said["moved"], off: said["off_list"] };

const TODAY: Side<Step, TodaySession> = {
  open: async () => new TodaySession(await fixture()),
  step: (s, step) => {
    switch (step.do) {
      case "mark":
        s.mark();
        return { status: "marked" };
      case "task": {
        const id = newId("t");
        return todayAnswer(
          s.send([{ kind: "task.create", id, title: step.title, effort: step.effort }]),
        );
      }
      case "levels": {
        const result = s.send(
          [
            {
              kind: "pref.set",
              key: "tasks.effort_scale",
              value: levels(step.keys),
              ...(step.moves === undefined ? {} : { moves: step.moves }),
            },
          ],
          step.base,
        );
        return todayAnswer(
          result,
          movedOf(result.results[0] as unknown as Record<string, unknown>),
        );
      }
      case "window":
        return todayAnswer(
          s.send(
            [{ kind: "pref.set", key: "tasks.dedupe_window_days", value: step.days }],
            step.base,
          ),
        );
      case "size":
        return todayAnswer(
          s.send(
            [{ kind: "task.patch", task: s.task(step.task), set: { effort: step.effort } }],
            step.base,
          ),
        );
    }
  },
  seen: (s) =>
    seenOf(
      s.fx.reader,
      s.fx.reader.prepare("SELECT title, effort FROM tasks ORDER BY title").all(),
    ),
  close: (s) => {
    s.close();
  },
};

const TREE: Side<Step, TreeSession> = {
  open: () => TreeSession.open(temp.make()),
  step: (s, step) => {
    switch (step.do) {
      case "mark":
        s.mark();
        return { status: "marked" };
      case "task":
        return treeAnswer(
          s.send("tasks.add", { tasks: [{ title: step.title, effort: step.effort }] }),
        );
      case "levels": {
        const result = s.send(
          "pref.set",
          {
            key: "tasks.effort_scale",
            value: levels(step.keys),
            ...(step.moves === undefined ? {} : { moves: step.moves }),
          },
          step.base,
        );
        return treeAnswer(result, movedOf(result.result as Record<string, unknown> | undefined));
      }
      case "window":
        return treeAnswer(
          s.send("pref.set", { key: "tasks.dedupe_window_days", value: step.days }, step.base),
        );
      case "size":
        return treeAnswer(
          s.send(
            "task.update",
            { task: s.task(step.task), set: { effort: step.effort } },
            step.base,
          ),
        );
    }
  },
  seen: (s) =>
    seenOf(
      s.fx.conn,
      s.fx.conn
        .prepare("SELECT n.title, t.effort FROM nodes n JOIN tasks t USING (id) ORDER BY n.title")
        .all(),
    ),
  close: (s) => {
    s.close();
  },
};

describe("[S2.prefs.both] a space's preferences, the same on both writers", () => {
  test("an effort level renamed, one dropped with tasks on it, two renames in one request", async () => {
    const sequence: Sequence<Step> = [
      { do: "levels", keys: ["S", "M", "L"] },
      { do: "task", title: "Fix the export", effort: "S" },
      { do: "task", title: "Book the van", effort: "M" },
      { do: "mark" },
      { do: "levels", keys: ["Small", "M", "L"], moves: [{ from: "S", to: "Small" }] },
      {
        step: { do: "size", task: "Fix the export", effort: "S", base: "marked" },
        differs:
          "both refuse the stale save; today names a conflict, the tree the level (a row in the table)",
      },
      {
        do: "levels",
        keys: ["M", "L"],
        moves: [
          { from: "Small", to: "M" },
          { from: "M", to: "L" },
        ],
      },
      { do: "levels", keys: ["L"], moves: [{ from: "M", to: null }] },
    ];
    await both({ today: TODAY, tree: TREE }, sequence);
  });

  test("a preference set for the first time and again on a stale read", async () => {
    await both({ today: TODAY, tree: TREE }, [
      { do: "mark" },
      { do: "window", days: 7 },
      { do: "window", days: 7, base: "marked" },
      { do: "window", days: 9, base: "none" },
      { do: "window", days: 9 },
    ]);
  });
});
