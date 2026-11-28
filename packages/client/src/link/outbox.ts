// What the person did on the phone that the computer has not answered yet: the one truth of what
// waits, kept in the app's private storage under the computer's pin and the space's ID, so another
// computer that holds a copy of the same space gets nothing of it.
//
// - An entry gets its request ID when the person acts and is kept before anything is sent. It is
//   marked as tried before each send.
// - It leaves only on a definite answer, in one write of the file:
//   - applied (also a replay of an earlier send): a check-off or reopening is remembered with the
//     answer's `as_of` until the feed's cursor covers it, so the screen does not flicker back;
//   - refused for good: it moves to the refusals the person reads, which outlast a restart.
//   No answer, or one that says it may work later, leaves it for the next try under the same ID.
// - What the screen shows on top of the feed is derived from the entries and the remembered
//   answers, in order: a task whose last word is a check-off is hidden.
// - A check-off or a reopening goes from where the feed was when the person acted, or, when an
//   earlier one of the same task waits or is not shown by the feed yet, from where that one landed:
//   the computer then takes them in order, and none conflicts with the one before it.
// - Undo of a check-off never tried takes it out. Otherwise Undo is a reopening of its own.
import type { CaptureDraft } from "../capture/index.ts";
import { covers, landedOf } from "../store/pending.ts";
import type { Cursor } from "../store/rows.ts";

/** Where the session keeps what must outlast the app: the app's private storage. */
export interface Keep {
  read(name: string): string | null;
  write(name: string, text: string): void;
}

/** A check-off or a reopening of one task. */
interface TaskChange {
  readonly task: string;
  readonly title: string;
  /** Where the write goes from: the feed when the person acted, or where `after` landed. */
  readonly base: string;
  /** An earlier change of the task still waiting: its answer gives this one its base. */
  readonly after?: string;
}

export type Change =
  | ({ readonly kind: "finish" } & TaskChange)
  | ({
      readonly kind: "reopen";
      /** The check-off it takes back. */
      readonly undoes: string;
    } & TaskChange)
  | { readonly kind: "add"; readonly draft: CaptureDraft; readonly text: string };

export type Entry = Change & {
  readonly request: string;
  readonly at: number;
  /** Sent at least once: the computer may have applied it. */
  readonly tried: boolean;
};

/** An applied check-off or reopening, until the feed shows it. */
interface Applied {
  readonly request: string;
  readonly kind: "finish" | "reopen";
  readonly task: string;
  readonly title: string;
  readonly asOf: string;
}

/** Something the computer refused: it did nothing, and its words say why. */
export interface Refused {
  readonly request: string;
  readonly kind: Change["kind"];
  /** The task's title, or the words of a capture. */
  readonly words: string;
  /** The computer's words, when it gave any. */
  readonly why: string | undefined;
}

interface Box {
  readonly waiting: readonly Entry[];
  readonly applied: readonly Applied[];
  readonly refused: readonly Refused[];
}

/** What came of one send. */
export type Answer =
  | { readonly kind: "applied"; readonly asOf: string | undefined }
  | { readonly kind: "refused"; readonly why: string | undefined }
  /** No answer, or one that may change: the same request again later. */
  | { readonly kind: "again" };

const FILE = "outbox";
const EMPTY: Box = { waiting: [], applied: [], refused: [] };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads a reply: its status and body as the link gives them. */
export function answerOf(status: number, body: unknown): Answer {
  const result = isRecord(body) ? body["result"] : undefined;
  if (status === 200) {
    const asOf =
      isRecord(result) && typeof result["as_of"] === "string" ? result["as_of"] : undefined;
    return { kind: "applied", asOf };
  }
  const error = isRecord(body) && isRecord(body["error"]) ? body["error"] : undefined;
  const message = typeof error?.["message"] === "string" ? error["message"] : undefined;
  const data = isRecord(error?.["data"]) ? error["data"] : undefined;
  const retryable = data?.["retryable"];
  // A 5xx may work later unless it says it will not; a 4xx never will.
  if (status >= 500 && retryable !== false) return { kind: "again" };
  if (status < 400) return { kind: "again" };
  return { kind: "refused", why: message === "" ? undefined : message };
}

function boxOf(value: unknown): Box {
  if (!isRecord(value)) return EMPTY;
  const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    waiting: list<Entry>(value["waiting"]).filter(
      (e) => isRecord(e) && typeof e.request === "string",
    ),
    applied: list<Applied>(value["applied"]),
    refused: list<Refused>(value["refused"]),
  };
}

/** `entry` waits for no earlier change any more: it goes from `base`. */
function freed(entry: Entry, base: string): Entry {
  const copy: Record<string, unknown> = { ...entry, base };
  Reflect.deleteProperty(copy, "after");
  return copy as unknown as Entry;
}

export const wordsOf = (change: Change): string =>
  change.kind === "add" ? change.text : change.title;

export class Outbox {
  readonly #keep: Keep;
  readonly #key: string;
  #box: Box;

  /** The outbox of the space `space` on the computer whose key has the pin `pin`. */
  constructor(keep: Keep, pin: string, space: string) {
    this.#keep = keep;
    this.#key = `${pin} ${space}`;
    this.#box = boxOf(this.#all()[this.#key]);
  }

  #all(): Record<string, unknown> {
    const text = this.#keep.read(FILE);
    if (text === null || text === "") return {};
    try {
      const value = JSON.parse(text) as unknown;
      return isRecord(value) ? value : {};
    } catch {
      return {};
    }
  }

  /** Every change of the box is one write of the whole file: what moves never falls between two. */
  #save(box: Box): void {
    this.#box = box;
    const all = this.#all();
    all[this.#key] = box;
    this.#keep.write(FILE, JSON.stringify(all));
  }

  get waiting(): readonly Entry[] {
    return this.#box.waiting;
  }

  get refused(): readonly Refused[] {
    return this.#box.refused;
  }

  /** Whether an applied check-off or reopening still waits for the feed to show it. */
  get settling(): boolean {
    return this.#box.applied.length > 0;
  }

  /** The next entry to send. */
  next(): Entry | undefined {
    return this.#box.waiting[0];
  }

  add(change: Change, request: string, at: number): void {
    let made: Change = change;
    if (change.kind !== "add") {
      // An earlier change of the same task: waiting, it hands this one its base when answered;
      // applied and not shown yet, its `as_of` is the base.
      const before = [...this.#box.waiting]
        .reverse()
        .find((e) => e.kind !== "add" && e.task === change.task);
      const applied = [...this.#box.applied].reverse().find((a) => a.task === change.task);
      if (before !== undefined) made = { ...change, after: before.request };
      else if (applied !== undefined) made = { ...change, base: applied.asOf };
    }
    const entry = { ...made, request, at, tried: false } as Entry;
    this.#save({ ...this.#box, waiting: [...this.#box.waiting, entry] });
  }

  /** Marked before each send: from now on the computer may have it. */
  tried(request: string): void {
    const waiting = this.#box.waiting.map((e) =>
      e.request === request && !e.tried ? { ...e, tried: true } : e,
    );
    this.#save({ ...this.#box, waiting });
  }

  /** What `request` sends: its body, the reopening's base filled in. */
  bodyOf(entry: Entry): { path: string; body: Record<string, unknown> } {
    switch (entry.kind) {
      case "add":
        return {
          path: "/api/v1/op/task.add",
          body: { tasks: [entry.draft], request_id: entry.request },
        };
      case "finish":
        return {
          path: "/api/v1/op/task.finish",
          body: { task: entry.task, base: entry.base, request_id: entry.request },
        };
      case "reopen":
        return {
          path: "/api/v1/op/task.reopen",
          body: { task: entry.task, base: entry.base, request_id: entry.request },
        };
    }
  }

  /** A definite answer takes the entry out; `again` leaves it for the next try. */
  answered(request: string, answer: Answer): void {
    if (answer.kind === "again") return;
    const entry = this.#box.waiting.find((e) => e.request === request);
    if (entry === undefined) return;
    let waiting = this.#box.waiting.filter((e) => e !== entry);
    let { applied, refused } = this.#box;
    if (answer.kind === "applied") {
      if (entry.kind !== "add" && answer.asOf !== undefined) {
        applied = [
          ...applied,
          { request, kind: entry.kind, task: entry.task, title: entry.title, asOf: answer.asOf },
        ];
      }
    } else {
      refused = [...refused, { request, kind: entry.kind, words: wordsOf(entry), why: answer.why }];
      // A refused check-off left the task open: its Undo has nothing to take back.
      if (entry.kind === "finish") {
        waiting = waiting.filter((e) => !(e.kind === "reopen" && e.undoes === request));
      }
    }
    // What came after this change goes from where it landed; after a refusal, from its own base.
    const asOf = answer.kind === "applied" ? answer.asOf : undefined;
    waiting = waiting.map((e) =>
      e.kind !== "add" && e.after === request ? freed(e, asOf ?? e.base) : e,
    );
    this.#save({ waiting, applied, refused });
  }

  /**
   * Undo of the check-off `request` of `task`: never tried, it goes; tried or applied, a reopening
   * follows it under `reopen`. False when there is nothing to take back: the computer refused it.
   * `now` is where the feed is, the base when nothing of the task waits or settles.
   */
  undo(
    request: string,
    task: { readonly task: string; readonly title: string },
    reopen: string,
    at: number,
    now: string,
  ): boolean {
    const waiting = this.#box.waiting.find((e) => e.request === request);
    if (waiting?.kind === "finish" && !waiting.tried) {
      // What chained to it goes from its base instead.
      const rest = this.#box.waiting
        .filter((e) => e !== waiting)
        .map((e) => (e.kind !== "add" && e.after === request ? freed(e, waiting.base) : e));
      this.#save({ ...this.#box, waiting: rest });
      return true;
    }
    if (this.#box.refused.some((r) => r.request === request)) return false;
    this.add({ kind: "reopen", ...task, undoes: request, base: now }, reopen, at);
    return true;
  }

  /** The feed's cursor reached `cursor`: what it covers is the feed's to show now. */
  covered(cursor: Cursor): void {
    const applied = this.#box.applied.filter((a) => {
      const landed = landedOf({ as_of: a.asOf });
      return landed !== undefined && !covers(cursor, landed);
    });
    if (applied.length !== this.#box.applied.length) this.#save({ ...this.#box, applied });
  }

  /** The tasks hidden on top of the feed: those whose last word, applied or waiting, is a check-off. */
  hidden(): ReadonlySet<string> {
    const hidden = new Set<string>();
    for (const change of [...this.#box.applied, ...this.#box.waiting]) {
      if (change.kind === "finish") hidden.add(change.task);
      if (change.kind === "reopen") hidden.delete(change.task);
    }
    return hidden;
  }

  dismiss(request: string): void {
    this.#save({ ...this.#box, refused: this.#box.refused.filter((r) => r.request !== request) });
  }
}
