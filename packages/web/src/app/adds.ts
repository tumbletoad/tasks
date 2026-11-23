// The top field's adds, each a thing of its own from Enter on: the field is empty and free at
// once, and the add keeps its words, its task and its request ID exactly as sent until the service
// says what it did. It is kept for the browser (kept.ts) per space, so a reload or a closed tab
// does not lose it, and every tab of the space shows it under its field.
//
// An add with no answer is sent again with the same request ID when the page is live again, on
// Try again, or by another tab once no tab holds it: the service gives back the task it made, or
// makes it once. A browser lock per add (Web Locks) lets one tab send it at a time; a tab that
// finds it held shows it as on its way, and takes it over when the holder closes. Without the
// locks two tabs may send the same request, which the service still makes once.
//
// The service's receipts belong to a sign-in, so an add sent under an earlier one is never sent
// again by itself: the same request ID would be a new request there.
import { requestId, Refused } from "../api.ts";
import type { CaptureDraft } from "../capture/parse.ts";
import type { Kept } from "../kept.ts";
import type { Settled } from "../store/pending.ts";

export interface KeptAdd {
  readonly request: string;
  /** The words as typed, and the shortcuts the person kept as text: Edit puts them back. */
  readonly text: string;
  readonly kept: readonly string[];
  /** The task as sent: sent again exactly so, or the service would call it another request. */
  readonly task: CaptureDraft;
  /** Where it goes, as the field said when it was sent: "Added to {where}". */
  readonly where: string;
  /** The sign-in it was sent under (`signInMark`). */
  readonly signIn: string;
  /** When it was sent, in milliseconds: the order of the lines. */
  readonly at: number;
}

/** What a person can do with an add, by what the page knows of it. */
export type AddState =
  /** On its way, from this tab or another. */
  | "adding"
  /** No answer: the service may or may not have made it. */
  | "unanswered"
  /** The service decided not to make it. */
  | "refused"
  /** Sent under an earlier sign-in: the service cannot say what it did. */
  | "signedInAgain";

export interface AddLine {
  readonly add: KeptAdd;
  readonly state: AddState;
  /** A refusal's sentence from the service, when it gave one. */
  readonly said?: string;
}

/** A tab's hold on a name, shared with the browser's other tabs where it can be. */
export interface Locks {
  /** Runs `work` holding `name`, unless another tab holds it: then false at once. */
  attempt(name: string, work: () => Promise<void>): Promise<boolean>;
  /** Settles once no other tab holds `name`. */
  free(name: string): Promise<void>;
}

/** Locks within one page: tests share one between two "tabs". */
export function memoryLocks(): Locks {
  const held = new Map<string, (() => void)[]>();
  const release = (name: string) => {
    const waiting = held.get(name) ?? [];
    held.delete(name);
    for (const wake of waiting) wake();
  };
  return {
    async attempt(name, work) {
      if (held.has(name)) return false;
      held.set(name, []);
      try {
        await work();
      } finally {
        release(name);
      }
      return true;
    },
    free(name) {
      const waiting = held.get(name);
      if (waiting === undefined) return Promise.resolve();
      return new Promise((resolve) => {
        waiting.push(resolve);
      });
    },
  };
}

/** The browser's locks, shared by its tabs; locks of this page alone where it has none. */
export function browserLocks(): Locks {
  const manager = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (manager === undefined) return memoryLocks();
  return {
    async attempt(name, work) {
      try {
        return await manager.request(name, { ifAvailable: true }, async (lock) => {
          if (lock === null) return false;
          await work();
          return true;
        });
      } catch {
        await work();
        return true;
      }
    },
    async free(name) {
      try {
        await manager.request(name, () => undefined);
      } catch {
        // The browser refused the lock: nothing to wait for.
      }
    },
  };
}

/**
 * A short mark of a sign-in's token, to tell an earlier sign-in from this one. It is kept beside
 * the token's own copy in the same storage, so it gives away nothing the browser does not hold.
 */
export function signInMark(token: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const REQUEST_ID = /^[0-9a-f-]{36}$/u;
const MARK = /^[0-9a-f]{8}$/u;

const optional = (value: unknown, type: "string" | "number"): boolean =>
  value === undefined || typeof value === type;

/** A task as a capture makes it, read by its shape: the service checks the values. */
function taskOf(value: unknown): CaptureDraft | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { title, inbox, area, project, priority, due, status, waiting_on, focus } = value as Record<
    string,
    unknown
  >;
  if (typeof title !== "string" || typeof inbox !== "boolean") return undefined;
  if (![area, project, due, status, waiting_on].every((v) => optional(v, "string"))) {
    return undefined;
  }
  if (!optional(priority, "number") || (focus !== undefined && focus !== true)) return undefined;
  return value as CaptureDraft;
}

/** A kept add, read by its shape. Labels and words have no limit of their own here. */
export function keptAddOf(value: unknown): KeptAdd | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { request, text, kept, task, where, signIn, at } = value as Record<string, unknown>;
  if (typeof request !== "string" || !REQUEST_ID.test(request)) return undefined;
  if (typeof text !== "string" || typeof where !== "string") return undefined;
  if (typeof signIn !== "string" || !MARK.test(signIn)) return undefined;
  if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
  const found = taskOf(task);
  if (found === undefined) return undefined;
  return {
    request,
    text,
    kept: Array.isArray(kept) ? kept.filter((k): k is string => typeof k === "string") : [],
    task: found,
    where,
    signIn,
    at,
  };
}

/** What the service decided, from an add's error: undefined when it decided nothing. */
const UNDECIDED: ReadonlySet<string> = new Set([
  "service_unavailable",
  "space_unavailable",
  "internal",
  "unknown",
]);

function refusalOf(error: unknown): { readonly said?: string } | undefined {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  if (typeof code !== "string" || UNDECIDED.has(code)) return undefined;
  // The page's own calls carry the service's sentence apart; a registry call's error is that sentence.
  const said = error instanceof Refused ? error.said : (error as Error).message;
  return said === undefined || said === "" || said.length > 500 ? {} : { said };
}

/** How long an add on its way stays out of sight: a usual answer comes well before. */
export const SHOW_MS = 1_000;

export interface AddsDeps {
  readonly space: string;
  /** This page's sign-in (`signInMark`). */
  readonly signIn: string;
  /** Kept for the browser. */
  readonly kept: Kept;
  /** Another tab kept or removed something under `prefix`. */
  readonly heard: (prefix: string, listener: () => void) => () => void;
  readonly locks: Locks;
  /** Sends the add under its request ID: its answer, and when the feed confirmed it. */
  readonly send: (add: KeptAdd) => {
    readonly answer: Promise<unknown>;
    readonly settled: Promise<Settled>;
  };
  /** The page handled the error itself (signed out, or an older page): nothing was decided. */
  readonly failed: (error: unknown) => boolean;
  /** The add was made, and its row is on screen. */
  readonly added: (add: KeptAdd) => void;
  readonly now?: () => number;
}

interface Known {
  readonly add: KeptAdd;
  state: AddState;
  said?: string;
  /** An add on its way that has been on its way long enough to show. */
  shown: boolean;
}

type Patch = { readonly state?: AddState; readonly said?: string; readonly shown?: boolean };

/** The kept adds of one space, as this tab sees and sends them. */
export class Adds {
  readonly #deps: AddsDeps;
  readonly #prefix: string;
  readonly #known = new Map<string, Known>();
  /** The adds this tab is sending now. */
  readonly #sending = new Set<string>();
  /** The adds this tab is about to send, or waits to send while another tab holds them. */
  readonly #asking = new Set<string>();
  /** The adds this tab has seen kept: one gone from the browser since was let go by a tab. */
  readonly #written = new Set<string>();
  readonly #listeners = new Set<() => void>();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  readonly #unhear: () => void;
  #live = false;
  #stopped = false;
  #lines: readonly AddLine[] = [];

  /** `live`: whether the page is live as the bar starts. */
  constructor(deps: AddsDeps, live: boolean) {
    this.#deps = deps;
    this.#live = live;
    this.#prefix = `add.${deps.space}.`;
    this.#unhear = deps.heard(this.#prefix, () => {
      this.#read();
    });
    this.#read();
  }

  /** The lines to show, oldest first: the same array until something changed. */
  readonly lines = (): readonly AddLine[] => this.#lines;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Enter: a new add of its own, kept before it is sent. */
  add(words: Pick<KeptAdd, "text" | "kept" | "task" | "where">): void {
    this.#start({
      ...words,
      request: requestId(),
      signIn: this.#deps.signIn,
      at: (this.#deps.now ?? Date.now)(),
    });
  }

  /** The page is live, or no longer: adds without an answer go again once it is. */
  live(on: boolean): void {
    const was = this.#live;
    this.#live = on;
    if (!on || was) return;
    for (const [request, known] of this.#known) {
      if (known.state === "unanswered") void this.#consider(request, false);
    }
  }

  tryAgain(request: string): void {
    const known = this.#known.get(request);
    if (known?.state === "unanswered") void this.#consider(request, true);
  }

  /** Sent under an earlier sign-in: the person adds it now, as a new request of this one. */
  addAgain(request: string): void {
    const known = this.#known.get(request);
    if (known?.state !== "signedInAgain") return;
    const { text, kept, task, where } = known.add;
    this.#start(
      {
        text,
        kept,
        task,
        where,
        request: requestId(),
        signIn: this.#deps.signIn,
        at: known.add.at,
      },
      request,
    );
  }

  /**
   * The line goes. What the service made stays made: an add on its way that it makes is in the
   * list and says Added like any other.
   */
  discard(request: string): void {
    this.#remove(request);
  }

  /** A refused add's words go back to the person: the line goes, and its words are returned. */
  edit(request: string): KeptAdd | undefined {
    const known = this.#known.get(request);
    if (known?.state !== "refused") return undefined;
    this.#remove(request);
    return known.add;
  }

  /** The bar goes: nothing more is shown or said. A send on its way still settles its add. */
  stop(): void {
    this.#stopped = true;
    this.#unhear();
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#listeners.clear();
  }

  /** The add's name among the kept, and its lock's: one tab sends it at a time. */
  #name(request: string): string {
    return `${this.#prefix}${request}`;
  }

  /**
   * Keeps `add` once this tab holds it, so no other tab takes it up while it is on its way, then
   * sends it; `replacing` goes once it is kept.
   */
  #start(add: KeptAdd, replacing?: string): void {
    const request = add.request;
    this.#known.set(request, { add, state: "adding", shown: false });
    this.#sending.add(request);
    this.#arm(request);
    this.#emit();
    void this.#deps.locks.attempt(this.#name(request), async () => {
      if (!this.#known.has(request)) {
        this.#sending.delete(request);
        return;
      }
      this.#deps.kept.keep(this.#name(request), JSON.stringify(add));
      this.#written.add(request);
      if (replacing !== undefined) this.#remove(replacing);
      await this.#send(add);
    });
  }

  /** Reads what is kept: new adds are taken up, and those another tab let go leave. */
  #read(): void {
    const found = new Map<string, KeptAdd>();
    for (const name of this.#deps.kept.names(this.#prefix)) {
      const add = keptAddOf(this.#deps.kept.json(name));
      // One this build cannot read stays as it is: it may hold words another build can.
      if (add !== undefined && this.#name(add.request) === name) found.set(add.request, add);
    }
    let changed = false;
    for (const request of [...this.#known.keys()]) {
      // This tab's own add is not kept yet in the moment before it holds its lock.
      if (found.has(request) || !this.#written.has(request)) continue;
      this.#known.delete(request);
      changed = true;
    }
    for (const [request, add] of found) {
      if (this.#known.has(request)) continue;
      this.#written.add(request);
      const earlier = add.signIn !== this.#deps.signIn;
      this.#known.set(request, {
        add,
        state: earlier ? "signedInAgain" : "unanswered",
        shown: false,
      });
      this.#arm(request);
      changed = true;
      if (!earlier) void this.#consider(request, false);
    }
    if (changed) this.#emit();
  }

  /**
   * Sends the add when no tab holds it and the page is live, or the person asked. A tab that holds
   * it is sending it: the add shows as on its way, and this tab looks again once it is let go.
   */
  async #consider(request: string, asked: boolean): Promise<void> {
    if (this.#stopped || this.#sending.has(request) || this.#asking.has(request)) return;
    this.#asking.add(request);
    const took = await this.#deps.locks.attempt(this.#name(request), async () => {
      const known = this.#known.get(request);
      if (known === undefined || !this.#kept(request)) return;
      if (!this.#live && !asked) {
        this.#set(request, { state: "unanswered" });
        return;
      }
      this.#asking.delete(request);
      await this.#send(known.add);
    });
    this.#asking.delete(request);
    if (took) return;
    this.#set(request, { state: "adding" });
    this.#asking.add(request);
    await this.#deps.locks.free(this.#name(request));
    this.#asking.delete(request);
    if (this.#known.has(request)) void this.#consider(request, false);
  }

  async #send(add: KeptAdd): Promise<void> {
    const request = add.request;
    this.#sending.add(request);
    this.#set(request, { state: "adding" });
    this.#arm(request);
    let settled: Promise<Settled> | undefined;
    let failure: { readonly error: unknown } | undefined;
    try {
      const sent = this.#deps.send(add);
      settled = sent.settled;
      await sent.answer;
    } catch (error) {
      failure = { error };
    }
    this.#sending.delete(request);
    // The feed named the request before its answer was lost: it was made all the same.
    const confirmed =
      settled !== undefined &&
      (await Promise.race([settled, Promise.resolve(undefined)])) === "confirmed";
    if (failure === undefined || confirmed) {
      this.#remove(request);
      void settled?.then((how) => {
        if (how === "confirmed" && !this.#stopped) this.#deps.added(add);
      });
      return;
    }
    if (!this.#kept(request)) {
      this.#forget(request);
      return;
    }
    const refused = this.#deps.failed(failure.error) ? undefined : refusalOf(failure.error);
    this.#set(
      request,
      refused === undefined
        ? { state: "unanswered", shown: true }
        : { state: "refused", shown: true, ...refused },
    );
  }

  /** Whether the browser still keeps the add: another tab may have let it go. */
  #kept(request: string): boolean {
    return this.#deps.kept.read(this.#name(request)) !== undefined;
  }

  #remove(request: string): void {
    this.#deps.kept.keep(this.#name(request), undefined);
    this.#forget(request);
  }

  #forget(request: string): void {
    this.#written.delete(request);
    if (this.#known.delete(request)) this.#emit();
  }

  /**
   * An add shows a moment after it is sent or found, unless it is settled by then: a usual add,
   * and one sent again as the page loads, says only Added.
   */
  #arm(request: string): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      if (this.#known.get(request)?.shown === false) this.#set(request, { shown: true });
    }, SHOW_MS);
    this.#timers.add(timer);
  }

  #set(request: string, patch: Patch): void {
    const known = this.#known.get(request);
    if (known === undefined) return;
    if (patch.state !== undefined) {
      known.state = patch.state;
      if (patch.said === undefined) delete known.said;
      else known.said = patch.said;
    }
    if (patch.shown !== undefined) known.shown = patch.shown;
    this.#emit();
  }

  #emit(): void {
    if (this.#stopped) return;
    this.#lines = [...this.#known.values()]
      .filter((known) => known.shown)
      .sort((a, b) => a.add.at - b.add.at)
      .map((known) => ({
        add: known.add,
        state: known.state,
        ...(known.said === undefined ? {} : { said: known.said }),
      }));
    for (const listener of this.#listeners) listener();
  }
}
