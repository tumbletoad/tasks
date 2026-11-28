// The phone's space over the link: the live rows the computer's feed sends, what the person does
// (outbox.ts holds it until the computer answers), and what was last shown while the computer is
// away.
//
// - Rows: after each hello the session subscribes, from the cursor it holds, and feeds the store
//   core (store/core.ts) as the page does. They change only through the feed. A subscription the
//   computer ended is asked for again; until a snapshot comes, the rows are not live.
// - What waits goes one entry at a time, in order, while the link is up and the app in front. No
//   answer within `callMs`, or one that may change, sends the same request again after `resendMs`.
// - The screen's rows are the feed's, less the tasks the outbox hides.
// - The last rows are kept with the time they were current, under the computer's pin and the
//   space, so a start without the computer shows them and how old they are. A removal of the phone
//   forgets them; what waits stays.
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
  type PageRow,
  type TaskRow,
} from "../store/index.ts";
import type { Connect, Saved } from "./open.ts";
import { ChangeLog, type ChangeFrame } from "../today/changes.ts";
import type { TaskChange } from "../today/views.ts";
import {
  CARD_READ,
  cardOf,
  joinCards,
  joinPages,
  PAGE_READ,
  pageOf,
  PARTS,
  Reads,
  RUNS_READ,
  runsOf,
  type CardDetail,
  type PageText,
  type PhoneRun,
  type Part,
  type Read,
} from "./card.ts";
import { answerOf, Outbox, type Entry, type Keep, type Refused } from "./outbox.ts";
import { linkOwner, type LinkState } from "./owner.ts";

export interface SpaceView {
  readonly link: LinkState;
  /** The tasks to show: the feed's, less those checked off on this phone. */
  readonly tasks: ReadonlyMap<string, TaskRow>;
  readonly nodes: ReadonlyMap<string, NodeRow>;
  /** Whether any rows are known: the feed's or the ones kept from before. */
  readonly loaded: boolean;
  /** The rows are the feed's, live now. */
  readonly live: boolean;
  /** When the rows were last current, in milliseconds since 1970. */
  readonly asOf: number | undefined;
  readonly waiting: readonly Entry[];
  readonly refused: readonly Refused[];
  /** Whether an applied change still waits for the feed to show it. */
  readonly settling: boolean;
  /** The last capture the computer took: its request ID and what it asked for. */
  readonly added: { readonly request: string; readonly draft: CaptureDraft } | undefined;
  /** How each task that left lately went, as the feed showed it: finished, or to the Trash. */
  readonly left: ReadonlyMap<string, "done" | "trash">;
  /** What agents changed lately, newest first, as the page's Changes reads it. */
  readonly changes: readonly TaskChange[];
  /** The space's pages, without their text: who changed each last, and when. */
  readonly pages: ReadonlyMap<string, PageRow>;
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
  /** Takes back a check-off made in this run of the app. */
  undo(request: string): void;
  /** Adds a task from a capture. Its request ID. */
  add(draft: CaptureDraft, text: string): string;
  /**
   * A task's card beyond its row: from the computer when the link is up, else the phone's last
   * read with its age.
   */
  card(task: string): Promise<Read<CardDetail>>;
  /** A page, opened from a card, as `card` reads it. */
  page(ref: string): Promise<Read<PageText>>;
  /** A task's runs, newest first, as `card` reads it. */
  runs(task: string): Promise<Read<readonly PhoneRun[]>>;
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
  /** How long an unanswered send waits before the same request goes again. */
  readonly resendMs?: number;
  /** How long a send waits for its answer. */
  readonly callMs?: number;
}

const ROWS = "rows";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function parsed(text: string | null): unknown {
  if (text === null || text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The kept rows of one computer's space: what the feed last sent, and when it was current. */
interface Kept {
  readonly at: number;
  readonly copy?: string;
  readonly cursor?: Cursor;
  readonly tasks: readonly TaskRow[];
  readonly nodes: readonly NodeRow[];
  readonly pages?: readonly PageRow[];
  readonly changes?: readonly TaskChange[];
}

function keptOf(value: unknown): Kept | undefined {
  if (!isRecord(value) || typeof value["at"] !== "number") return undefined;
  const { tasks, nodes, copy, cursor, pages, changes } = value;
  if (!Array.isArray(tasks) || !Array.isArray(nodes)) return undefined;
  return {
    at: value["at"],
    ...(typeof copy === "string" ? { copy } : {}),
    ...(isRecord(cursor) ? { cursor: cursor as unknown as Cursor } : {}),
    tasks: tasks as TaskRow[],
    nodes: nodes as NodeRow[],
    ...(Array.isArray(pages) ? { pages: pages as PageRow[] } : {}),
    ...(Array.isArray(changes) ? { changes: changes as TaskChange[] } : {}),
  };
}

const asOfOf = (cursor: Cursor | undefined): string =>
  cursor === undefined
    ? ""
    : `${String(cursor.epoch)}.${String(cursor.seq)}.${incarnationTag(cursor.incarnation)}`;

/**
 * A new pairing replaced `saved` (another computer, or another space): what the phone read there
 * goes, its rows, cards and pages. What waits to be sent stays, under that computer and space.
 */
export function forgetReads(keep: Keep, saved: Saved): void {
  new Reads(keep, saved.pin, saved.space.id).forget();
  const rows = parsed(keep.read(ROWS));
  if (!isRecord(rows)) return;
  Reflect.deleteProperty(rows, `${saved.pin} ${saved.space.id}`);
  keep.write(ROWS, JSON.stringify(rows));
}

export function spaceSession(options: SessionOptions): SpaceSession {
  const { connect, keep, newId, report } = options;
  const now = options.now ?? Date.now;
  const resendMs = options.resendMs ?? 5_000;
  const callMs = options.callMs ?? 30_000;
  const retryMs = options.retryMs ?? 10_000;
  let pairing = options.saved;
  const space = pairing.space.id;
  const key = `${pairing.pin} ${space}`;

  const outbox = new Outbox(keep, pairing.pin, space);
  const reads = new Reads(keep, pairing.pin, space);

  /**
   * One read, in as many parts as the computer gives (at most PARTS): the computer's answer when it
   * gives one, else the phone's last, else none. A confirmed not_found is `gone`, and its copy goes.
   */
  const read = async <T>(
    ask: (next: string | undefined) => { path: string; body: Record<string, unknown> },
    parse: (body: unknown) => Part<T> | undefined,
    join: (first: T, later: T) => T,
    last: () => { readonly at: number; readonly value: T } | undefined,
    keepIt: (value: T, at: number) => void,
    drop?: () => void,
  ): Promise<Read<T>> => {
    if (link.kind === "connected") {
      let whole: T | undefined;
      let next: string | undefined;
      for (let part = 0; part < PARTS; part += 1) {
        const { path, body } = ask(next);
        const reply = await call(path, body);
        if (reply?.status === 404 && part === 0 && drop !== undefined) {
          drop();
          return { kind: "gone" };
        }
        const got = reply?.status === 200 ? parse(reply.body) : undefined;
        // A part that did not come: what came is a part of the whole, and says so.
        if (got === undefined) break;
        whole = whole === undefined ? got.value : join(whole, got.value);
        next = got.next;
        if (next === undefined) break;
      }
      if (whole !== undefined) {
        const at = now();
        keepIt(whole, at);
        return { kind: "read", value: whole, at, live: true };
      }
    }
    const kept = last();
    return kept === undefined ? { kind: "none" } : { kind: "read", ...kept, live: false };
  };
  let core = new LiveCore(space);
  let held: Held | undefined;
  const rowsFile = (): Record<string, unknown> => {
    const value = parsed(keep.read(ROWS));
    return isRecord(value) ? value : {};
  };
  let kept = keptOf(rowsFile()[key]);
  let link: LinkState = { kind: "connecting" };
  let running = false;
  /** The feed serves this phone now: resumed, or a snapshot came, since the last hello. */
  let subscribed = false;
  /** When the feed last applied something: the rows were current then. */
  let fresh: number | undefined;
  let added: SpaceView["added"];
  const left = new Map<string, "done" | "trash">();
  const frames = new Set<(frame: ChangeFrame) => void>();
  const log = new ChangeLog(
    {
      onChanges: (listener) => {
        frames.add(listener);
        return () => {
          frames.delete(listener);
        };
      },
    },
    now,
  );
  const frame = (f: ChangeFrame) => {
    for (const listener of frames) listener(f);
  };
  // Without the computer, what agents changed is what the phone last kept.
  if (kept?.changes !== undefined) frame({ changes: [], reset: true, agentChanges: kept.changes });
  /** This run's check-offs, for their Undo. */
  const taps = new Map<string, { task: string; title: string }>();

  const calls = new Map<string, (reply: { status: number; body: unknown } | undefined) => void>();
  let callCount = 0;
  let pumping = false;
  let resubscribe: ReturnType<typeof setTimeout> | undefined;

  const live = () => link.kind === "connected" && subscribed && held !== undefined;

  const view = (): SpaceView => {
    const hidden = outbox.hidden();
    const tasks = new Map<string, TaskRow>();
    for (const task of held?.tasks.values() ?? kept?.tasks ?? []) {
      if (!hidden.has(task.id)) tasks.set(task.id, task);
    }
    const nodes =
      held?.nodes ?? new Map((kept?.nodes ?? []).map((node): [string, NodeRow] => [node.id, node]));
    const isLive = live();
    return {
      link,
      tasks,
      nodes,
      loaded: held !== undefined || kept !== undefined,
      live: isLive,
      asOf: isLive ? now() : (fresh ?? kept?.at),
      waiting: outbox.waiting,
      refused: outbox.refused,
      settling: outbox.settling,
      added,
      left,
      changes: log.getEntries(),
      pages:
        held?.pages ??
        new Map((kept?.pages ?? []).map((page): [string, PageRow] => [page.id, page])),
    };
  };
  const tell = () => {
    report(view(), pairing);
  };

  const keepRows = () => {
    if (held === undefined) return;
    kept = {
      at: fresh ?? now(),
      ...(held.space.copy === undefined ? {} : { copy: held.space.copy }),
      cursor: held.cursor,
      tasks: [...held.tasks.values()],
      nodes: [...held.nodes.values()],
      pages: [...held.pages.values()],
      changes: log.getEntries(),
    };
    const all = rowsFile();
    all[key] = kept;
    keep.write(ROWS, JSON.stringify(all));
  };

  const subscribe = (fresh: boolean) => {
    const message: Record<string, unknown> = { type: "subscribe" };
    const cursor = fresh ? undefined : core.resumeFrom;
    if (cursor !== undefined) message["cursor"] = cursor;
    // A subscription resumed from the cursor gets no snapshot: its rows are current as of the
    // cursor, so it is live now. A fresh one is live with its snapshot.
    subscribed = cursor !== undefined;
    if (core.copy !== undefined && (cursor !== undefined || !core.loaded)) {
      message["copy"] = core.copy;
    }
    owner.send(JSON.stringify(message));
  };

  const message = (text: string) => {
    const value = parsed(text);
    if (isRecord(value) && value["type"] === "reply" && typeof value["id"] === "string") {
      const answer = calls.get(value["id"]);
      answer?.({
        status: typeof value["status"] === "number" ? value["status"] : 0,
        body: value["body"],
      });
      return;
    }
    const feed = messageOf(value);
    if (feed?.type === "error") {
      // The computer ended the subscription (the space closed there): not live, and asked again.
      subscribed = false;
      clearTimeout(resubscribe);
      resubscribe = setTimeout(() => {
        if (link.kind === "connected") subscribe(true);
      }, retryMs);
      tell();
      return;
    }
    if (feed?.type !== "snapshot" && feed?.type !== "batch" && feed?.type !== "unreadable") return;
    const outcome = core.receive(feed);
    if (outcome.kind === "resnapshot") subscribe(true);
    if (outcome.kind === "replaced") {
      // Another copy of the space is served now: start again from its snapshot.
      core = new LiveCore(space);
      held = undefined;
      subscribe(true);
    }
    if (outcome.kind === "snapshot") subscribed = true;
    if (outcome.kind === "snapshot") {
      frame({ changes: [], reset: true, agentChanges: outcome.agentChanges });
    }
    if (outcome.kind === "applied") {
      frame({ changes: outcome.changes, reset: false });
      for (const change of outcome.changes) {
        const after = change.after as TaskRow | undefined;
        if (change.type !== "task" || change.before === undefined || after === undefined) continue;
        if (after.deleted_at !== undefined) left.set(change.id, "trash");
        else if (after.lifecycle !== "active") left.set(change.id, "done");
      }
      // The last few are enough: a card open on one of them hears it at once.
      for (const id of [...left.keys()].slice(0, Math.max(0, left.size - 50))) left.delete(id);
    }
    if (outcome.kind === "snapshot" || outcome.kind === "applied") fresh = now();
    const next = core.publish();
    if (next !== undefined) {
      held = next;
      keepRows();
    }
    if (held !== undefined && outcome.kind !== "ignored") outbox.covered(held.cursor);
    tell();
  };

  /** One send on the link: its answer, or undefined when none came in time or the link went. */
  const call = (
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown } | undefined> =>
    new Promise((resolve) => {
      callCount += 1;
      const id = `w${String(callCount)}`;
      const timer = setTimeout(() => {
        done(undefined);
      }, callMs);
      function done(reply: { status: number; body: unknown } | undefined) {
        clearTimeout(timer);
        calls.delete(id);
        resolve(reply);
      }
      calls.set(id, done);
      const copy = held?.space.copy ?? kept?.copy;
      const sent = owner.send(
        JSON.stringify({ type: "call", id, path, body, ...(copy === undefined ? {} : { copy }) }),
      );
      if (!sent) done(undefined);
    });

  const pause = () =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, resendMs);
    });

  /** Sends what waits, oldest first, one at a time, while the link is up and the app in front. */
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (running && link.kind === "connected") {
        const entry = outbox.next();
        if (entry === undefined) break;
        outbox.tried(entry.request);
        const { path, body } = outbox.bodyOf(entry);
        const reply = await call(path, body);
        const answer =
          reply === undefined ? { kind: "again" as const } : answerOf(reply.status, reply.body);
        if (answer.kind === "again") {
          await pause();
          continue;
        }
        outbox.answered(entry.request, answer);
        // The feed may have shown it before its answer came.
        if (held !== undefined) outbox.covered(held.cursor);
        if (answer.kind === "applied" && entry.kind === "add") {
          added = { request: entry.request, draft: entry.draft };
        }
        tell();
      }
    } finally {
      pumping = false;
    }
  };

  const owner = linkOwner(
    connect,
    pairing,
    (state, saved) => {
      link = state;
      pairing = saved;
      subscribed = false;
      if (state.kind !== "connected") {
        for (const end of [...calls.values()]) end(undefined);
      }
      if (state.kind === "removed") {
        // What it read goes; what waits to be sent stays, for a new pairing of this phone.
        kept = undefined;
        held = undefined;
        const all = rowsFile();
        Reflect.deleteProperty(all, key);
        reads.forget();
        keep.write(ROWS, JSON.stringify(all));
      }
      if (state.kind === "connected") {
        subscribe(false);
        void pump();
      }
      tell();
    },
    { retryMs, message },
  );

  // A change that turns seven days old leaves Changes by itself.
  log.subscribe(tell);

  const act = (request: string) => {
    tell();
    void pump();
    return request;
  };
  const base = () => asOfOf(held?.cursor ?? kept?.cursor);

  return {
    start: () => {
      running = true;
      tell();
      owner.start();
      void pump();
    },
    stop: () => {
      running = false;
      clearTimeout(resubscribe);
      owner.stop();
    },
    now: () => {
      owner.now();
    },
    finish: (task) => {
      const request = newId();
      taps.set(request, { task: task.id, title: task.title });
      outbox.add(
        { kind: "finish", task: task.id, title: task.title, base: base() },
        request,
        now(),
      );
      return act(request);
    },
    undo: (request) => {
      const task = taps.get(request);
      if (task === undefined) return;
      taps.delete(request);
      outbox.undo(request, task, newId(), now(), base());
      act(request);
    },
    add: (draft, text) => {
      const request = newId();
      outbox.add({ kind: "add", draft, text }, request, now());
      return act(request);
    },
    card: (task) =>
      read(
        (before) => ({ path: CARD_READ.path, body: CARD_READ.body(task, before) }),
        cardOf,
        joinCards,
        () => reads.card(task),
        (value, at) => {
          reads.keepCard(task, value, at);
        },
      ),
    runs: (task) =>
      read(
        () => ({ path: RUNS_READ.path, body: RUNS_READ.body(task) }),
        runsOf,
        (first) => first,
        () => reads.runs(task),
        (value, at) => {
          reads.keepRuns(task, value, at);
        },
      ),
    page: (ref) =>
      read(
        (cursor) => ({ path: PAGE_READ.path, body: PAGE_READ.body(ref, cursor) }),
        pageOf,
        joinPages,
        () => reads.page(ref),
        (value, at) => {
          reads.keepPage(ref, value, at);
        },
        () => {
          reads.dropPage(ref);
        },
      ),
    dismiss: (request) => {
      outbox.dismiss(request);
      tell();
    },
  };
}
