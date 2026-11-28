// The phone's space over the link: the live rows the computer's feed sends, the person's
// check-offs, reopenings and captures, and what was last shown while the computer is away.
//
// - Rows: after each hello the session subscribes, from the cursor it holds, and feeds the store
//   core (store/core.ts) as the page does. They change only through the feed.
// - What the person does is kept first, with the request ID it got when the person acted, and only
//   then sent: one at a time, while the link is up. A lost answer, a lost link or a restart of the
//   app leaves it kept, and it goes again with the same ID, which the computer applies once. An
//   answer the computer refused takes it out, with the words it gave; one it could not give now
//   (a 5xx) leaves it for a later try.
// - A finished task leaves the list when it is checked off, not when the feed confirms it.
// - The last rows are kept with the time they were current, so a start without the computer shows
//   them and how old they are. A removal of the phone forgets them; what waits to be sent stays.
//
// Plain TypeScript: the app hands it the native link and its own storage, the tests a Node link
// and a map.
import type { CaptureDraft } from "../capture/index.ts";
import {
  incarnationTag,
  LiveCore,
  messageOf,
  type Cursor,
  type Held,
  type NodeRow,
  type SpaceHead,
  type TaskRow,
} from "../store/index.ts";
import type { Connect, Saved } from "./open.ts";
import { linkOwner, type LinkState } from "./owner.ts";

/** Where the session keeps what must outlast the app: the app's private storage. */
export interface Keep {
  read(name: string): string | null;
  write(name: string, text: string): void;
}

/**
 * What the person did that the computer has not taken yet, in the space it was done in: a pairing
 * with another space sends none of it there.
 */
export type Waiting = { readonly space: string } & (
  | {
      readonly kind: "finish" | "reopen";
      readonly request: string;
      readonly task: string;
      readonly title: string;
      /** Where the feed was when the person acted: the write's `base`. */
      readonly base: string;
      readonly at: number;
      readonly copy?: string;
    }
  | {
      readonly kind: "add";
      readonly request: string;
      readonly draft: CaptureDraft;
      /** The words the person typed. */
      readonly text: string;
      readonly at: number;
      readonly copy?: string;
    }
);

/** Something the computer refused: it did nothing, and its words say why. */
export interface Refused {
  readonly request: string;
  readonly kind: Waiting["kind"];
  /** The task's title, or the words of a capture. */
  readonly words: string;
  /** The computer's words, when it gave any. */
  readonly why: string | undefined;
}

export interface SpaceView {
  readonly link: LinkState;
  /** The open tasks to show, without those checked off on this phone. */
  readonly tasks: ReadonlyMap<string, TaskRow>;
  readonly nodes: ReadonlyMap<string, NodeRow>;
  /** Whether any rows are known: the feed's or the ones kept from before. */
  readonly loaded: boolean;
  /** The rows are the feed's, live now. */
  readonly live: boolean;
  /** When the rows were last current, in milliseconds since 1970. */
  readonly asOf: number | undefined;
  readonly waiting: readonly Waiting[];
  readonly refused: readonly Refused[];
  /** The last capture the computer took, by its request ID. */
  readonly added: string | undefined;
}

export interface SpaceSession {
  /** The app is in front. */
  start(): void;
  /** The app went to the background. */
  stop(): void;
  /** Open the link again now (Try now, another network). */
  now(): void;
  /** Checks a task off. Its request ID, for Undo. */
  finish(task: TaskRow): string;
  /**
   * Takes back a check-off: one still waiting is never sent; one the computer took is reopened
   * there.
   */
  undo(request: string): void;
  /** Adds a task from a capture. Its request ID. */
  add(draft: CaptureDraft, text: string): string;
  /** The person read a refusal. */
  dismiss(request: string): void;
}

export interface SessionOptions {
  readonly connect: Connect;
  readonly saved: Saved;
  readonly keep: Keep;
  /** A new request ID: 16 to 64 of `A-Za-z0-9_-`. */
  readonly newId: () => string;
  readonly now?: () => number;
  /** Every change; with the pairing to keep when the computer named it anew. */
  readonly report: (view: SpaceView, saved: Saved) => void;
  readonly retryMs?: number;
  /** How long a write the computer could not take now waits for its next try. */
  readonly resendMs?: number;
}

const WAITING = "waiting";
const ROWS = "rows";

const PATH: Readonly<Record<Waiting["kind"], string>> = {
  finish: "/api/v1/op/task.finish",
  reopen: "/api/v1/op/task.reopen",
  add: "/api/v1/op/task.add",
};

/** Each call is answered within this long, or counts as lost with its link. */
const CALL_MS = 30_000;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function parsed(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The kept rows: what the feed last sent, and when it was current. */
interface Kept {
  readonly at: number;
  readonly space: string;
  readonly copy?: string;
  readonly cursor?: Cursor;
  readonly tasks: readonly TaskRow[];
  readonly nodes: readonly NodeRow[];
}

function keptOf(value: unknown, space: string): Kept | undefined {
  if (!isRecord(value) || value["space"] !== space || typeof value["at"] !== "number") {
    return undefined;
  }
  const { tasks, nodes, copy, cursor } = value;
  if (!Array.isArray(tasks) || !Array.isArray(nodes)) return undefined;
  return {
    at: value["at"],
    space,
    ...(typeof copy === "string" ? { copy } : {}),
    ...(isRecord(cursor) ? { cursor: cursor as unknown as Cursor } : {}),
    tasks: tasks as TaskRow[],
    nodes: nodes as NodeRow[],
  };
}

function waitingOf(value: unknown): Waiting[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (w): w is Waiting =>
      isRecord(w) &&
      typeof w["request"] === "string" &&
      typeof w["space"] === "string" &&
      typeof w["at"] === "number" &&
      (w["kind"] === "add"
        ? isRecord(w["draft"]) && typeof w["text"] === "string"
        : (w["kind"] === "finish" || w["kind"] === "reopen") &&
          typeof w["task"] === "string" &&
          typeof w["base"] === "string"),
  );
}

const bodyOf = (w: Waiting): Record<string, unknown> =>
  w.kind === "add"
    ? { tasks: [w.draft], request_id: w.request }
    : { task: w.task, base: w.base, request_id: w.request };

const wordsOf = (w: Waiting): string => (w.kind === "add" ? w.text : w.title);

/** The words of a refusal the computer sent, if it gave any. */
function whyOf(body: unknown): string | undefined {
  const error = isRecord(body) ? body["error"] : undefined;
  const message = isRecord(error) ? error["message"] : undefined;
  return typeof message === "string" && message !== "" ? message : undefined;
}

export function spaceSession(options: SessionOptions): SpaceSession {
  const { connect, keep, newId, report } = options;
  const now = options.now ?? Date.now;
  const resendMs = options.resendMs ?? 5_000;
  let pairing = options.saved;
  const space = pairing.space.id;

  let core = new LiveCore(space);
  let held: Held | undefined;
  let kept = keptOf(parsed(keep.read(ROWS)), space);
  const all = waitingOf(parsed(keep.read(WAITING)));
  /** What waits for another space's pairing: kept as it is, never sent from here. */
  const others = all.filter((w) => w.space !== space);
  let waiting = all.filter((w) => w.space === space);
  const refused: Refused[] = [];
  /** Check-offs the computer took that the feed has not shown yet. */
  const landed = new Set<string>();
  let added: string | undefined;
  /** This run's check-offs, for their Undo. */
  const finishes = new Map<string, { task: string; title: string }>();
  /** The request on its way to the computer now. */
  let flying: string | undefined;
  /** Check-offs taken back while on their way: their answer hides nothing. */
  const undone = new Set<string>();
  let link: LinkState = { kind: "connecting" };
  let heard: number | undefined;

  const calls = new Map<string, (reply: { status: number; body: unknown }) => void>();
  let lost: (() => void)[] = [];
  let callCount = 0;
  let draining = false;
  let resend: ReturnType<typeof setTimeout> | undefined;

  const copy = (): string | undefined => held?.space.copy ?? kept?.copy;
  /** Where the feed is: what a write of a field the person saw names as its `base`. */
  const base = (): string => {
    const cursor = held?.cursor ?? kept?.cursor;
    return cursor === undefined
      ? ""
      : `${String(cursor.epoch)}.${String(cursor.seq)}.${incarnationTag(cursor.incarnation)}`;
  };

  const view = (): SpaceView => {
    const live = link.kind === "connected" && held !== undefined;
    const source = held ?? kept;
    const tasks = new Map<string, TaskRow>();
    const leaving = new Set<string>(landed);
    for (const w of waiting) {
      if (w.kind === "finish") leaving.add(w.task);
      if (w.kind === "reopen") leaving.delete(w.task);
    }
    for (const task of held?.tasks.values() ?? kept?.tasks ?? []) {
      if (!leaving.has(task.id)) tasks.set(task.id, task);
    }
    const nodes =
      held?.nodes ?? new Map((kept?.nodes ?? []).map((node): [string, NodeRow] => [node.id, node]));
    return {
      link,
      tasks,
      nodes,
      loaded: source !== undefined,
      live,
      asOf: live ? now() : (heard ?? kept?.at),
      waiting,
      refused,
      added,
    };
  };
  const tell = () => {
    report(view(), pairing);
  };

  const keepWaiting = () => {
    keep.write(WAITING, JSON.stringify([...others, ...waiting]));
  };
  const keepRows = () => {
    if (held === undefined) return;
    const head: SpaceHead = held.space;
    kept = {
      at: heard ?? now(),
      space,
      ...(head.copy === undefined ? {} : { copy: head.copy }),
      cursor: held.cursor,
      tasks: [...held.tasks.values()],
      nodes: [...held.nodes.values()],
    };
    keep.write(ROWS, JSON.stringify(kept));
  };

  const subscribe = (fresh: boolean) => {
    const message: Record<string, unknown> = { type: "subscribe" };
    const cursor = fresh ? undefined : core.resumeFrom;
    if (cursor !== undefined) message["cursor"] = cursor;
    if (core.copy !== undefined && (cursor !== undefined || !core.loaded))
      message["copy"] = core.copy;
    owner.send(JSON.stringify(message));
  };

  const published = () => {
    const next = core.publish();
    if (next === undefined) return;
    held = next;
    for (const id of landed) {
      if (held.tasks.get(id)?.lifecycle !== "active") landed.delete(id);
    }
    keepRows();
  };

  const message = (text: string) => {
    heard = now();
    const value = parsed(text);
    if (isRecord(value) && value["type"] === "reply" && typeof value["id"] === "string") {
      const answer = calls.get(value["id"]);
      calls.delete(value["id"]);
      answer?.({
        status: typeof value["status"] === "number" ? value["status"] : 0,
        body: value["body"],
      });
      return;
    }
    const feed = messageOf(value);
    if (
      feed === undefined ||
      (feed.type !== "snapshot" && feed.type !== "batch" && feed.type !== "unreadable")
    ) {
      return;
    }
    const outcome = core.receive(feed);
    if (outcome.kind === "resnapshot") subscribe(true);
    if (outcome.kind === "replaced") {
      // Another copy of the space is served now: start again from its snapshot.
      core = new LiveCore(space);
      held = undefined;
      subscribe(true);
    }
    published();
    tell();
    if (outcome.kind === "snapshot") void drain();
  };

  /** One call on the link: its answer, or undefined when the link went first. */
  const call = (w: Waiting): Promise<{ status: number; body: unknown } | undefined> =>
    new Promise((resolve) => {
      callCount += 1;
      const id = `w${String(callCount)}`;
      const timer = setTimeout(() => {
        calls.delete(id);
        resolve(undefined);
      }, CALL_MS);
      const done = (reply: { status: number; body: unknown } | undefined) => {
        clearTimeout(timer);
        resolve(reply);
      };
      calls.set(id, done);
      lost.push(() => {
        calls.delete(id);
        done(undefined);
      });
      const at = w.copy ?? copy();
      const sent = owner.send(
        JSON.stringify({
          type: "call",
          id,
          path: PATH[w.kind],
          body: bodyOf(w),
          ...(at === undefined ? {} : { copy: at }),
        }),
      );
      if (!sent) done(undefined);
    });

  /** Sends what waits, oldest first, one at a time, while the link is up. */
  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      while (link.kind === "connected" && waiting.length > 0) {
        const w = waiting[0];
        if (w === undefined) break;
        flying = w.request;
        const reply = await call(w);
        flying = undefined;
        if (reply === undefined) break;
        if (reply.status >= 500) {
          clearTimeout(resend);
          resend = setTimeout(() => void drain(), resendMs);
          break;
        }
        waiting = waiting.filter((x) => x.request !== w.request);
        keepWaiting();
        if (reply.status === 200) {
          if (w.kind === "finish" && !undone.has(w.request)) landed.add(w.task);
          if (w.kind === "add") added = w.request;
        } else {
          refused.push({
            request: w.request,
            kind: w.kind,
            words: wordsOf(w),
            why: whyOf(reply.body),
          });
        }
        tell();
      }
    } finally {
      draining = false;
    }
  };

  const owner = linkOwner(
    connect,
    pairing,
    (state, saved) => {
      link = state;
      pairing = saved;
      if (state.kind !== "connected") {
        for (const end of lost.splice(0)) end();
      }
      if (state.kind === "removed") {
        // What it read goes; what waits to be sent stays, for a new pairing of this phone.
        kept = undefined;
        held = undefined;
        keep.write(ROWS, "");
      }
      if (state.kind === "connected") {
        lost = [];
        subscribe(false);
        void drain();
      }
      tell();
    },
    { ...(options.retryMs === undefined ? {} : { retryMs: options.retryMs }), message },
  );

  const act = (w: Waiting): string => {
    // Kept before anything is sent: a crash right after still sends it, once.
    waiting = [...waiting, w];
    keepWaiting();
    tell();
    void drain();
    return w.request;
  };
  const at = (): { copy?: string } => {
    const c = copy();
    return c === undefined ? {} : { copy: c };
  };

  return {
    start: () => {
      tell();
      owner.start();
    },
    stop: () => {
      clearTimeout(resend);
      owner.stop();
    },
    now: () => {
      owner.now();
    },
    finish: (task) => {
      const request = newId();
      finishes.set(request, { task: task.id, title: task.title });
      return act({
        kind: "finish",
        space,
        request,
        task: task.id,
        title: task.title,
        base: base(),
        at: now(),
        ...at(),
      });
    },
    undo: (request) => {
      const finished = finishes.get(request);
      if (finished === undefined) return;
      finishes.delete(request);
      if (request !== flying && waiting.some((x) => x.request === request)) {
        // Never sent: it goes, and the computer hears nothing of it.
        waiting = waiting.filter((x) => x.request !== request);
        keepWaiting();
        tell();
        return;
      }
      // Sent, or on its way: the computer reopens the task.
      undone.add(request);
      landed.delete(finished.task);
      act({
        kind: "reopen",
        space,
        request: newId(),
        ...finished,
        base: base(),
        at: now(),
        ...at(),
      });
    },
    add: (draft, text) =>
      act({ kind: "add", space, request: newId(), draft, text, at: now(), ...at() }),
    dismiss: (request) => {
      const i = refused.findIndex((r) => r.request === request);
      if (i >= 0) refused.splice(i, 1);
      tell();
    },
  };
}
