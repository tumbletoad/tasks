// The search index, the same ordinary sequence on today's writer and the tree's: after each step a
// search for a word of a title, of a note, of a page and of a source, also after the Trash and
// back, a source linked to a second task, and after Undo. What each index finds is compared, as
// the kind of document and the title it shows. Fixture text only.
import { afterAll, describe, test } from "vitest";
import type { Connection } from "../src/driver.ts";
import { newId } from "../src/ids.ts";
import type { Operation } from "../src/write/request.ts";
import {
  both,
  TodaySession,
  todayAnswer,
  TreeSession,
  treeAnswer,
  type Side,
} from "./both-helpers.ts";
import { tempFolders } from "./space-helpers.ts";
import { fixtureCopies } from "./write-helpers.ts";

const temp = tempFolders("search-both");
const fixture = fixtureCopies(temp.make);
afterAll(temp.cleanup);

type Step =
  | { do: "task"; title: string }
  | { do: "note"; task: string; body: string }
  | { do: "page"; task: string; title: string; body: string }
  | { do: "source"; task: string; subject: string }
  | { do: "link"; task: string; subject: string }
  | { do: "trash" | "restore"; task: string }
  | { do: "undo" };

const mail = (subject: string) => ({
  kind: "email" as const,
  title: subject,
  key: `mail:${subject.toLowerCase().replaceAll(" ", "-")}`,
});

/** The words searched after every step: of a title, a note, a page, and a source. */
const WORDS = ["passport", "photo", "checklist", "embassy"];

/** What the index finds for each word: each document's kind and the title it shows. */
const found = (conn: Connection) =>
  Object.fromEntries(
    WORDS.map((word) => [
      word,
      conn
        .prepare(
          "SELECT d.kind AS kind, f.title AS title FROM search_fts f JOIN search_docs d " +
            "ON d.doc = f.rowid WHERE search_fts MATCH $word",
        )
        .all({ word })
        .map((r) => `${String(r["kind"])}: ${String(r["title"])}`)
        .sort(),
    ]),
  );

const TODAY: Side<Step, TodaySession> = {
  open: async () => new TodaySession(await fixture()),
  step: (s, step) => {
    if (step.do === "undo") return todayAnswer(s.history("undo"));
    let ops: Operation[];
    switch (step.do) {
      case "task":
        ops = [{ kind: "task.create", id: newId("t"), title: step.title }];
        break;
      case "note":
        ops = [{ kind: "note.add", task: s.task(step.task), body: step.body }];
        break;
      case "page":
        ops = [
          {
            kind: "page.create",
            owner: { kind: "task", task: s.task(step.task) },
            title: step.title,
            brief: "",
            body: step.body,
          },
        ];
        break;
      case "source":
      case "link":
        ops = [{ kind: "source.add", task: s.task(step.task), source: mail(step.subject) }];
        break;
      case "trash":
        ops = [{ kind: "task.delete", task: s.task(step.task) }];
        break;
      case "restore":
        ops = [{ kind: "task.restore", task: s.task(step.task) }];
        break;
    }
    return todayAnswer(s.send(ops));
  },
  seen: (s) => found(s.fx.reader),
  close: (s) => {
    s.close();
  },
};

const TREE: Side<Step, TreeSession> = {
  open: () => TreeSession.open(temp.make()),
  step: (s, step) => {
    if (step.do === "undo") return treeAnswer(s.fx.send("undo", {}));
    const [command, input]: [string, Record<string, unknown>] = (() => {
      switch (step.do) {
        case "task":
          return ["tasks.add", { tasks: [{ title: step.title }] }];
        case "note":
          return ["note.add", { on: s.task(step.task), body: step.body }];
        case "page":
          return ["page.create", { on: s.task(step.task), title: step.title, body: step.body }];
        case "source":
          return ["source.add", { on: s.task(step.task), source: mail(step.subject) }];
        case "link": {
          const id = s.fx.conn
            .prepare("SELECT id FROM sources WHERE title = $t")
            .get({ t: step.subject })?.["id"];
          return ["link.add", { on: s.task(step.task), target: String(id) }];
        }
        case "trash":
          return ["nodes.trash", { task: s.task(step.task) }];
        case "restore":
          return ["nodes.restore", { task: s.task(step.task) }];
      }
    })();
    return treeAnswer(s.send(command, input));
  },
  seen: (s) => found(s.fx.conn),
  close: (s) => {
    s.close();
  },
};

describe("[S2.search.both] the search index, the same on both writers", () => {
  test("a word of a title, a note, a page and a source, after the Trash and back, a second link and Undo", async () => {
    await both({ today: TODAY, tree: TREE }, [
      { do: "task", title: "Renew the passport" },
      { do: "note", task: "Renew the passport", body: "Bring a photo" },
      { do: "page", task: "Renew the passport", title: "Checklist", body: "Forms and fees" },
      { do: "source", task: "Renew the passport", subject: "Embassy reply" },
      { do: "trash", task: "Renew the passport" },
      { do: "restore", task: "Renew the passport" },
      { do: "task", title: "Book the flight" },
      { do: "link", task: "Book the flight", subject: "Embassy reply" },
      { do: "undo" },
      {
        step: { do: "undo" },
        differs:
          "today's restore by Undo leaves the source link its second removal took; the tree's source stays on the task",
      },
    ]);
  });
});
