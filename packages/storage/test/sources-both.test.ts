// Sources and the capture by source, the same ordinary sequences on today's writer and the tree's:
// a source added, moved to another task, removed and put back, linked to a second task; a mail
// captured again while its task is open, after an archive and after a backdated completion, with
// the same log twice. Each writer says a step in its own operations or commands; the answers and
// what a reader sees of the tasks are compared. Fixture text only.
import { afterAll, describe, test } from "vitest";
import { newId, type Id } from "../src/ids.ts";
import type { Operation } from "../src/write/request.ts";
import {
  both,
  TodaySession,
  todayAnswer,
  TreeSession,
  treeAnswer,
  type Sequence,
  type Side,
} from "./both-helpers.ts";
import { tempFolders } from "./space-helpers.ts";
import { fixtureCopies } from "./write-helpers.ts";

const temp = tempFolders("sources-both");
const fixture = fixtureCopies(temp.make);
afterAll(temp.cleanup);

type Step =
  | { do: "capture"; title: string; mail: string; log?: string }
  | { do: "add"; task: string; mail: string }
  | { do: "move"; mail: string; from: string; to: string }
  | { do: "remove" | "put back"; mail: string; task: string }
  | { do: "link"; mail: string; task: string }
  | { do: "archive"; task: string }
  | { do: "complete"; task: string; at?: number };

/** A mail by its subject: its key is the subject's. */
const mail = (subject: string) => ({
  kind: "email" as const,
  title: subject,
  key: `mail:${subject.toLowerCase().replaceAll(" ", "-")}`,
});

/** What a reader sees of the tasks the sequence made: each with its live sources and its log. */
interface Seen {
  title: unknown;
  lifecycle: unknown;
  trash: boolean;
  sources: string[];
  log: string[];
}

const sorted = (rows: readonly Record<string, unknown>[], key: string): string[] =>
  rows.map((r) => String(r[key])).sort();

const TODAY: Side<Step, TodaySession> = {
  open: async () => new TodaySession(await fixture()),
  step: (s, step) => {
    const source = (subject: string) =>
      String(
        s.fx.reader.prepare("SELECT id FROM sources WHERE title = $t").get({ t: subject })?.["id"],
      );
    let ops: Operation[];
    switch (step.do) {
      case "capture": {
        const id = newId("t");
        ops = [
          { kind: "task.create", id, title: step.title },
          { kind: "source.add", task: id, source: mail(step.mail) },
          ...(step.log === undefined
            ? []
            : [{ kind: "log.add" as const, task: id, body: step.log }]),
        ];
        break;
      }
      case "add":
        ops = [{ kind: "source.add", task: s.task(step.task), source: mail(step.mail) }];
        break;
      // Today a source belongs to no one task: a move is a link removed and one made.
      case "move":
        ops = [
          { kind: "source.unlink", task: s.task(step.from), source: source(step.mail) as Id<"s"> },
          { kind: "source.add", task: s.task(step.to), source: mail(step.mail) },
        ];
        break;
      case "remove":
      case "put back":
        ops = [
          {
            kind: step.do === "remove" ? "source.unlink" : "source.relink",
            task: s.task(step.task),
            source: source(step.mail) as Id<"s">,
          },
        ];
        break;
      case "link":
        ops = [{ kind: "source.add", task: s.task(step.task), source: mail(step.mail) }];
        break;
      case "archive":
        ops = [{ kind: "task.archive", task: s.task(step.task), reason: "Not needed" }];
        break;
      case "complete":
        ops = [
          {
            kind: "task.complete",
            task: s.task(step.task),
            ...(step.at === undefined ? {} : { at: step.at }),
          },
        ];
        break;
    }
    return todayAnswer(s.send(ops));
  },
  seen: (s) =>
    s.fx.reader
      .prepare("SELECT id, title, lifecycle, deleted_at FROM tasks ORDER BY title, ref")
      .all()
      .filter((t) => TITLES.has(String(t["title"])))
      .map((t): Seen => ({
        title: t["title"],
        lifecycle: t["lifecycle"],
        trash: t["deleted_at"] !== null,
        sources: sorted(
          s.fx.reader
            .prepare(
              "SELECT s.title FROM task_sources l JOIN sources s ON s.id = l.source_id " +
                "WHERE l.task_id = $id AND l.removed_at IS NULL AND s.deleted_at IS NULL",
            )
            .all({ id: String(t["id"]) }),
          "title",
        ),
        log: sorted(
          s.fx.reader
            .prepare("SELECT body FROM log_entries WHERE task_id = $id AND deleted_at IS NULL")
            .all({ id: String(t["id"]) }),
          "body",
        ),
      })),
  close: (s) => {
    s.close();
  },
};

const TREE: Side<Step, TreeSession> = {
  open: () => TreeSession.open(temp.make()),
  step: (s, step) => {
    const source = (subject: string) =>
      String(
        s.fx.conn.prepare("SELECT id FROM sources WHERE title = $t").get({ t: subject })?.["id"],
      );
    const [command, input]: [string, Record<string, unknown>] = (() => {
      switch (step.do) {
        case "capture":
          return [
            "tasks.add",
            {
              tasks: [
                {
                  title: step.title,
                  source: mail(step.mail),
                  ...(step.log === undefined ? {} : { log: step.log }),
                },
              ],
            },
          ];
        case "add":
          return ["source.add", { on: s.task(step.task), source: mail(step.mail) }];
        case "move":
          return ["source.move", { source: source(step.mail), on: s.task(step.to) }];
        case "remove":
          return ["source.remove", { source: source(step.mail) }];
        case "put back":
          return ["source.put_back", { source: source(step.mail) }];
        case "link":
          return ["link.add", { on: s.task(step.task), target: source(step.mail) }];
        case "archive":
          return [
            "task.finish",
            { task: s.task(step.task), status: "dropped", reason: "Not needed" },
          ];
        case "complete":
          return [
            "task.finish",
            { task: s.task(step.task), ...(step.at === undefined ? {} : { at: step.at }) },
          ];
      }
    })();
    return treeAnswer(s.send(command, input));
  },
  seen: (s) =>
    s.fx.conn
      .prepare(
        "SELECT n.id, n.title, t.lifecycle, n.deleted_at FROM nodes n JOIN tasks t USING (id) " +
          "ORDER BY n.title, t.ref",
      )
      .all()
      .filter((t) => TITLES.has(String(t["title"])))
      .map((t): Seen => ({
        title: t["title"],
        lifecycle: t["lifecycle"],
        trash: t["deleted_at"] !== null,
        sources: sorted(
          s.fx.conn
            .prepare(
              "SELECT s.title FROM sources s WHERE s.deleted_at IS NULL AND (s.owner_id = $id " +
                "OR EXISTS (SELECT 1 FROM links l WHERE l.owner_id = $id AND l.target_id = s.id " +
                "AND l.removed_at IS NULL))",
            )
            .all({ id: String(t["id"]) }),
          "title",
        ),
        log: sorted(
          s.fx.conn
            .prepare(
              "SELECT body FROM notes WHERE owner_id = $id AND deleted_at IS NULL " +
                "AND kind NOT IN ('note', 'learning')",
            )
            .all({ id: String(t["id"]) }),
          "body",
        ),
      })),
  close: (s) => {
    s.close();
  },
};

const TITLES = new Set(["Fix the export", "Answer the council", "Book the van"]);

const SOURCES: Sequence<Step> = [
  { do: "capture", title: "Fix the export", mail: "Export broken", log: "Asked by mail" },
  { do: "capture", title: "Answer the council", mail: "Council letter" },
  { do: "add", task: "Fix the export", mail: "Export logs" },
  { do: "move", mail: "Export logs", from: "Fix the export", to: "Answer the council" },
  { do: "remove", mail: "Export logs", task: "Answer the council" },
  { do: "remove", mail: "Export logs", task: "Answer the council" },
  { do: "put back", mail: "Export logs", task: "Answer the council" },
  { do: "put back", mail: "Export logs", task: "Answer the council" },
  { do: "link", mail: "Council letter", task: "Fix the export" },
];

const CAPTURES: Sequence<Step> = [
  { do: "capture", title: "Fix the export", mail: "Export broken", log: "Asked by mail" },
  // The same capture with the same log: found, and the log is added once.
  { do: "capture", title: "Fix the export", mail: "Export broken", log: "Asked by mail" },
  { do: "archive", task: "Fix the export" },
  // Archived just now: the capture finds it, and nothing follows a finished match.
  { do: "capture", title: "Fix the export", mail: "Export broken", log: "Asked again" },
  { do: "capture", title: "Book the van", mail: "Van booking" },
  { do: "complete", task: "Book the van", at: 1 },
  // A completion dated long ago counts from when this space recorded it.
  { do: "capture", title: "Book the van", mail: "Van booking" },
];

describe("[S2.sources.both] sources and the capture by source, the same on both writers", () => {
  test("a source added, moved to another task, removed and put back, and linked to a second task", async () => {
    await both({ today: TODAY, tree: TREE }, SOURCES);
  });

  test("a mail captured again while open, after an archive and after a backdated completion, with the same log twice", async () => {
    await both({ today: TODAY, tree: TREE }, CAPTURES);
  });
});
