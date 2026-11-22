import { useSyncExternalStore } from "react";
import { requestId } from "../api.ts";
import { browserKept, onKeptUnder, pageKept, type Kept } from "../kept.ts";

/** A request still unanswered after this long is forgotten: the next one is a new one. */
const KEEP_MS = 24 * 60 * 60_000;

const PREFIX = "unanswered.";

interface Pending {
  readonly asked: string;
  readonly id: string;
  readonly at: number;
}

/**
 * The requests that got no answer, by what they are for (a task's Run, a task and app's Open):
 * what each asked and its request ID, from the press until the service answers. The same request
 * again carries that ID, so the service gives back what the first one made, if it made anything,
 * instead of making a second.
 */
export class Unanswered {
  readonly #kept: Kept;
  readonly #heard = new Set<() => void>();

  constructor(kept: Kept = pageKept()) {
    this.#kept = kept;
  }

  /** What the unanswered request for `name` asked, or undefined when none is kept. */
  asked(name: string): string | undefined {
    return this.#pending(name)?.asked;
  }

  /** The ID of a request for `name` that asks `asked`: the unanswered one's, else a new one. */
  idFor(name: string, asked: string): string {
    const before = this.#pending(name);
    if (before?.asked === asked) return before.id;
    const id = requestId();
    this.#keep(name, { asked, id, at: Date.now() });
    return id;
  }

  /** The service answered the request `id` for `name`, or for `name` whatever it was: it goes. */
  answered(name: string, id?: string): void {
    const before = this.#pending(name);
    if (before !== undefined && (id === undefined || before.id === id)) this.#keep(name, undefined);
  }

  /** The kept text of the requests whose names start with `prefix`, as one string. */
  raw(prefix: string): string {
    return this.#kept
      .names(PREFIX + prefix)
      .sort()
      .map((name) => `${name}=${this.#kept.read(name) ?? ""}`)
      .join("\n");
  }

  /** The kept requests changed, in this tab or another. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#heard.add(listener);
    const stop = onKeptUnder(PREFIX, listener);
    return () => {
      this.#heard.delete(listener);
      stop();
    };
  };

  #pending(name: string): Pending | undefined {
    const value = this.#kept.json(PREFIX + name);
    if (typeof value !== "object" || value === null) return undefined;
    const { asked, id, at } = value as Partial<Record<keyof Pending, unknown>>;
    if (typeof asked !== "string" || typeof id !== "string" || typeof at !== "number") {
      return undefined;
    }
    if (!/^[0-9a-f-]{36}$/u.test(id) || Date.now() - at > KEEP_MS) return undefined;
    return { asked, id, at };
  }

  #keep(name: string, pending: Pending | undefined): void {
    this.#kept.keep(PREFIX + name, pending === undefined ? undefined : JSON.stringify(pending));
    for (const listener of this.#heard) listener();
  }
}

/**
 * The Opens that got no answer, kept for the browser beside the composer's draft: a reload, or
 * another tab of the task, presses the same Open again under its request ID.
 */
export const unansweredOpens = new Unanswered(browserKept);

/** An Open's name among them: its task and app. */
export const openName = (space: string, task: string, instance: string): string =>
  `open.${space}.${task}.${instance}`;

/** What an Open asks: a second session or not, and the words or the note it carries. */
export const openAsked = (another: boolean, text?: string, request?: string): string =>
  JSON.stringify([another, request ?? "", text ?? ""]);

/**
 * What the unanswered Open of the task in each app asked, by the app's key, kept current as one
 * comes or goes, here or in another tab.
 */
export function useUnansweredOpens(
  space: string,
  task: string,
): (instance: string) => string | undefined {
  const prefix = openName(space, task, "");
  // The kept text itself: a string, so the snapshot is the same until something changed.
  useSyncExternalStore(unansweredOpens.subscribe, () => unansweredOpens.raw(prefix));
  return (instance) => unansweredOpens.asked(openName(space, task, instance));
}
