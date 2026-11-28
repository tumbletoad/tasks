// The rules of a page's and a node's texts that do not depend on the schema, run as the same
// sequences against today's writer and the tree's: which write needs a base and which says where a
// page goes whatever changed; what changes nothing; that every field a save gives is held to its
// base, the same words included; which input is refused; and that someone else's newer comment
// keeps an Undo that would put it out of sight. Each writer says a step in its own operations or
// commands; the answers and what a person then sees are compared. Fixture text only.
import { afterAll, describe, expect, test } from "vitest";
import { newId } from "../src/ids.ts";
import type { Operation } from "../src/write/request.ts";
import { checkedDriver, tempFolders } from "./space-helpers.ts";
import { openTree, treeHistoryProblems } from "./tree-helpers.ts";
import { checkHistory, fixtureCopies } from "./write-helpers.ts";

const temp = tempFolders("pages-both");
const fixture = fixtureCopies(temp.make);
afterAll(temp.cleanup);

/** The base a step is sent with: the space as it is now, none, or the one `mark` kept. */
type Base = "now" | "none" | "marked";

/** A step, in neither writer's words. */
type Step =
  | { do: "page.set"; title?: string; brief?: string; body?: string; from?: "first" }
  | { do: "page.move" | "page.trash" | "page.restore" }
  | { do: "describe"; description: string }
  | { do: "instruct"; text: string }
  | { do: "task.trash" | "task.restore" }
  | { do: "comment"; on: "page" | "task"; body: string }
  | { do: "undo" };

/** A step's answer as a person or an agent meets it. */
interface Answer {
  status: string;
  code?: string;
  kept?: boolean;
}

interface Writer {
  /** Keeps the space's as_of now, for a later step sent with `marked`. */
  mark(): void;
  step(step: Step, base: Base, who?: "person" | "agent"): Answer;
  /** What a person sees of the page, the task and the space's texts. */
  seen(): unknown;
  close(): void;
}

/** The words a step gives, without the ones it leaves out. */
const given = (words: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(words).filter((e): e is [string, string] => e[1] !== undefined),
  );

const answer = (status: string, code: unknown, kept: unknown): Answer => ({
  status,
  ...(typeof code === "string" ? { code } : {}),
  ...(kept === undefined ? {} : { kept: true }),
});

/** Today's writer, on its fixture space, with a page on the space and a task. */
async function today(): Promise<Writer> {
  const fx = await fixture();
  let marked = "";
  const send = (ops: Operation[], base: Base, who: "person" | "agent" = "person") => {
    const result = fx.writer.submit(
      fx.request(who === "person" ? fx.human : fx.codex, ops, {
        ...(base === "now" ? { base: fx.base() } : base === "marked" ? { base: marked } : {}),
      }),
    );
    return { result, answer: answer(result.status, result.error?.code, result.kept) };
  };
  const made = send(
    [
      {
        kind: "page.create",
        owner: { kind: "space" },
        title: "Passport",
        brief: "",
        body: "Bring a photo.",
      },
    ],
    "now",
  );
  const page = made.result.results[0]?.id ?? "";
  const firstSeq = made.result.seq;
  const task = newId("t");
  send([{ kind: "task.create", id: task, title: "Renew the passport" }], "now");
  const op = (step: Step): Operation => {
    switch (step.do) {
      case "page.set": {
        const { title, brief, body, from } = step;
        const set = given({ title, brief, body });
        return {
          kind: "page.set",
          page,
          ...set,
          ...(from === undefined ? {} : { from_seq: firstSeq }),
        };
      }
      case "page.move":
        return { kind: "page.move", page, owner: { kind: "task", task } };
      case "page.trash":
      case "page.restore":
        return { kind: step.do, page };
      case "describe":
        return { kind: "node.set", node: { kind: "space" }, description: step.description };
      case "instruct":
        return { kind: "node.instruct", node: { kind: "space" }, text: step.text };
      case "task.trash":
        return { kind: "task.delete", task };
      case "task.restore":
        return { kind: "task.restore", task };
      case "comment":
        if (step.on === "page") throw new Error("Today's pages take no comments");
        return { kind: "note.add", task, body: step.body };
      case "undo":
        return { kind: "undo" };
    }
  };
  return {
    mark: () => {
      marked = fx.base();
    },
    step: (step, base, who) => send([op(step)], step.do === "undo" ? "none" : base, who).answer,
    seen: () => {
      const p = fx.reader.prepare("SELECT * FROM pages WHERE id = $id").get({ id: page }) ?? {};
      const t = fx.reader.prepare("SELECT * FROM tasks WHERE id = $id").get({ id: task }) ?? {};
      const x = fx.reader
        .prepare("SELECT * FROM node_texts WHERE owner_id = $id")
        .get({ id: fx.spaceId });
      return {
        page: {
          title: p["title"],
          brief: p["brief"],
          body: p["body"],
          trash: p["deleted_at"] !== null,
          onTask: p["owner_id"] === task,
        },
        task: { trash: t["deleted_at"] !== null },
        texts: { description: x?.["description"] ?? "", forAgents: x?.["for_agents"] ?? "" },
      };
    },
    close: () => {
      checkHistory(fx.reader);
      fx.close();
    },
  };
}

/** The tree's writer, on a disposable tree space, with the same page and task. */
async function tree(): Promise<Writer> {
  const fx = openTree(await checkedDriver(), temp.make(), true);
  let marked = "";
  const send = (
    command: string,
    input: Record<string, unknown>,
    base: Base,
    who: "person" | "agent" = "person",
  ) => {
    const result = fx.send(command, input, {
      ...(base === "now" ? {} : { base: base === "marked" ? marked : null }),
      ...(who === "agent" ? { who: fx.agent } : {}),
    });
    const kept = (result.result as { kept?: unknown } | undefined)?.kept;
    return { result, answer: answer(result.status, result.error?.code, kept) };
  };
  const made = send(
    "page.create",
    { on: "space", title: "Passport", brief: "", body: "Bring a photo." },
    "now",
  );
  const page = (made.result.result as { page: { id: string } }).page.id;
  const firstSeq = made.result.seq;
  const task =
    (
      send("tasks.add", { tasks: [{ title: "Renew the passport" }] }, "now").result.result as {
        tasks: { id: string }[];
      }
    ).tasks[0]?.id ?? "";
  const call = (step: Step): [string, Record<string, unknown>] => {
    switch (step.do) {
      case "page.set": {
        const { title, brief, body, from } = step;
        const set = given({ title, brief, body });
        return [
          "page.set",
          { page, ...set, ...(from === undefined ? {} : { from_seq: firstSeq }) },
        ];
      }
      case "page.move":
        return ["page.move", { page, on: task }];
      case "page.trash":
      case "page.restore":
        return [step.do, { page }];
      case "describe":
        return ["node.set", { node: "space", description: step.description }];
      case "instruct":
        return ["node.instruct", { node: "space", text: step.text }];
      case "task.trash":
        return ["nodes.trash", { task }];
      case "task.restore":
        return ["nodes.restore", { task }];
      case "comment":
        return ["note.add", { on: step.on === "page" ? page : task, body: step.body }];
      case "undo":
        return ["undo", {}];
    }
  };
  return {
    mark: () => {
      marked = fx.asOf();
    },
    step: (step, base, who) => {
      const [command, input] = call(step);
      return send(command, input, step.do === "undo" ? "none" : base, who).answer;
    },
    seen: () => {
      const p = fx.conn.prepare("SELECT * FROM pages WHERE id = $id").get({ id: page }) ?? {};
      const t = fx.conn.prepare("SELECT * FROM nodes WHERE id = $id").get({ id: task }) ?? {};
      const x = fx.conn.prepare("SELECT * FROM nodes WHERE id = $id").get({ id: fx.spaceId }) ?? {};
      return {
        page: {
          title: p["title"],
          brief: p["brief"],
          body: p["body"],
          trash: p["deleted_at"] !== null,
          onTask: p["owner_id"] === task,
        },
        task: { trash: t["deleted_at"] !== null },
        texts: { description: x["description"], forAgents: x["for_agents"] },
      };
    },
    close: () => {
      const problems = treeHistoryProblems(fx.conn);
      fx.close();
      expect(problems).toEqual([]);
    },
  };
}

/** Runs `walk` on both writers and returns what each answered and showed. */
async function both(walk: (w: Writer) => unknown[]): Promise<void> {
  const results = [];
  for (const make of [today, tree]) {
    const w = await make();
    try {
      results.push(walk(w));
    } finally {
      w.close();
    }
  }
  expect(results[1]).toEqual(results[0]);
}

describe("[S2.pages.both] a page's and a node's texts by the same rules on both writers", () => {
  test("a move, the Trash, a restore and a first text need no base; a restore of a live page changes nothing", async () => {
    await both((w) => [
      w.step({ do: "page.move" }, "none"),
      w.step({ do: "page.move" }, "none"),
      w.step({ do: "page.trash" }, "none"),
      w.step({ do: "page.restore" }, "none"),
      w.step({ do: "page.restore" }, "none"),
      w.step({ do: "describe", description: "Home and paperwork." }, "none"),
      w.step({ do: "instruct", text: "Ask before you book anything." }, "now"),
      w.step({ do: "describe", description: "Home, paperwork and travel." }, "none"),
      w.seen(),
    ]);
  });

  test("a save on a stale read is a conflict, also for the field whose words match", async () => {
    await both((w) => {
      w.mark();
      const changed = w.step({ do: "page.set", body: "Bring two photos." }, "now", "agent");
      const stale = w.step(
        { do: "page.set", body: "Bring two photos.", title: "Renewal" },
        "marked",
      );
      return [changed, stale, w.seen()];
    });
  });

  test("a restore gives the body or the version it comes from, not both", async () => {
    await both((w) => [
      w.step({ do: "page.set", body: "Bring two photos." }, "now"),
      w.step({ do: "page.set", body: "Something else", from: "first" }, "now"),
      w.step({ do: "page.set", from: "first" }, "now"),
      w.seen(),
    ]);
  });

  test("someone else's newer note keeps the Undo that would put it out of sight again", async () => {
    await both((w) => [
      w.step({ do: "task.trash" }, "now"),
      w.step({ do: "task.restore" }, "now"),
      w.step({ do: "comment", on: "task", body: "Booked for Monday" }, "now", "agent"),
      w.step({ do: "undo" }, "none"),
      w.seen(),
    ]);
    // A page's comments are the tree's: the same rule keeps its Undo.
    const w = await tree();
    try {
      w.step({ do: "page.trash" }, "now");
      w.step({ do: "page.restore" }, "now");
      w.step({ do: "comment", on: "page", body: "Take the old one too" }, "now", "agent");
      expect(w.step({ do: "undo" }, "none")).toEqual({ status: "unchanged", kept: true });
      expect(w.seen()).toMatchObject({ page: { trash: false } });
    } finally {
      w.close();
    }
  });
});
