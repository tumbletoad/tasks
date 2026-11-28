// Runs one sequence of ordinary steps through today's writer and the tree's, and compares what
// each answered and what a reader then saw, step by step. A part of the tree says each step in
// both writers' words once (a `Side`); a sequence is then a list of steps. Where the writers may
// differ, the step says why in one line, and only that step's answer and view are left out of the
// comparison. Fixture text only.
import { expect } from "vitest";
import type { Id } from "../src/ids.ts";
import type { Operation, WriteResult } from "../src/write/request.ts";
import { checkedDriver } from "./space-helpers.ts";
import { openTree, treeHistoryProblems, type TreeFixture } from "./tree-helpers.ts";
import { checkHistory, type Fixture } from "./write-helpers.ts";

/** What a person or an agent meets of a step: its status, a refusal's code, and what it said. */
export interface Answer {
  status: string;
  code?: string;
  said?: unknown;
}

/** The base a step is sent with: the space as it is now, none, or the one `mark` kept. */
export type Base = "now" | "none" | "marked";
export type Who = "person" | "agent";

/** A step, and the line that says why the writers may differ at it. */
export type Sequence<Step> = readonly (Step | { readonly step: Step; readonly differs: string })[];

export interface Side<Step, S> {
  open(): Promise<S>;
  step(session: S, step: Step): Answer;
  seen(session: S): unknown;
  close(session: S): void;
}

type Marked<Step> = { readonly step: Step; readonly differs: string };

const isMarked = <Step>(s: Step | Marked<Step>): s is Marked<Step> =>
  typeof s === "object" && s !== null && "differs" in s && "step" in s;

/** The step itself, with or without its line. */
const stepOf = <Step>(s: Step | Marked<Step>): Step => (isMarked(s) ? s.step : s);

/** Runs `sequence` on both writers and expects the same answers and views after every step. */
export async function both<Step, T, R>(
  sides: { today: Side<Step, T>; tree: Side<Step, R> },
  sequence: Sequence<Step>,
): Promise<void> {
  const run = async <S>(side: Side<Step, S>) => {
    const session = await side.open();
    try {
      return sequence.map((s) => {
        return { answer: side.step(session, stepOf(s)), seen: side.seen(session) };
      });
    } finally {
      side.close(session);
    }
  };
  const today = await run(sides.today);
  const tree = await run(sides.tree);
  sequence.forEach((s, i) => {
    if (isMarked(s)) return;
    const at = `step ${String(i + 1)}: ${JSON.stringify(s)}`;
    expect(tree[i]?.answer, `${at}, the answer`).toEqual(today[i]?.answer);
    expect(tree[i]?.seen, `${at}, what a reader sees`).toEqual(today[i]?.seen);
  });
}

/** Today's writer on its fixture space, sending operations as the person or an agent. */
export class TodaySession {
  readonly fx: Fixture;
  #marked = "";
  constructor(fx: Fixture) {
    this.fx = fx;
  }

  mark(): void {
    this.#marked = this.fx.base();
  }

  send(ops: Operation[], base: Base = "now", who: Who = "person"): WriteResult {
    const { fx } = this;
    return fx.writer.submit(
      fx.request(who === "person" ? fx.human : fx.codex, ops, {
        ...(base === "now" ? { base: fx.base() } : base === "marked" ? { base: this.#marked } : {}),
      }),
    );
  }

  /** A history request: Undo or Redo, which takes no base. */
  history(kind: "undo" | "redo"): WriteResult {
    return this.fx.writer.submit(this.fx.request(this.fx.human, [{ kind }]));
  }

  /** A task by its title: steps name tasks by title, which each writer numbers its own way. */
  task(title: string): Id<"t"> {
    const id = this.fx.reader.prepare("SELECT id FROM tasks WHERE title = $title").get({ title })?.[
      "id"
    ];
    if (typeof id !== "string") throw new Error(`No task "${title}" here`);
    return id as Id<"t">;
  }

  close(): void {
    checkHistory(this.fx.reader);
    this.fx.close();
  }
}

export const todayAnswer = (result: WriteResult, said?: unknown): Answer => ({
  status: result.status,
  ...(result.error === undefined ? {} : { code: result.error.code }),
  ...(said === undefined ? {} : { said }),
});

/** The tree's writer on a disposable tree space, sending commands as the person or an agent. */
export class TreeSession {
  readonly fx: TreeFixture;
  #marked = "";
  constructor(fx: TreeFixture) {
    this.fx = fx;
  }

  static async open(folder: string): Promise<TreeSession> {
    return new TreeSession(openTree(await checkedDriver(), folder, true));
  }

  mark(): void {
    this.#marked = this.fx.asOf();
  }

  send(command: string, input: Record<string, unknown>, base: Base = "now", who: Who = "person") {
    return this.fx.send(command, input, {
      ...(base === "now" ? {} : { base: base === "marked" ? this.#marked : null }),
      ...(who === "agent" ? { who: this.fx.agent } : {}),
    });
  }

  task(title: string): string {
    const id = this.fx.conn
      .prepare("SELECT id FROM nodes WHERE kind = 'task' AND title = $title")
      .get({ title })?.["id"];
    if (typeof id !== "string") throw new Error(`No task "${title}" here`);
    return id;
  }

  close(): void {
    const problems = treeHistoryProblems(this.fx.conn);
    this.fx.close();
    expect(problems).toEqual([]);
  }
}

export const treeAnswer = (
  result: { status: string; error?: { code: string } },
  said?: unknown,
): Answer => ({
  status: result.status,
  ...(result.error === undefined ? {} : { code: result.error.code }),
  ...(said === undefined ? {} : { said }),
});
