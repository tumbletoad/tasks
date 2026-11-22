// The top field's add whose answer the page did not hear (a reload, a dropped connection): kept for
// the tab with its request as it was sent, apart from what the field holds now, so no keystroke can
// let it go. The same words again send that request again, so the service gives back the task it
// made instead of a second; it is let go only on the service's word: an answer, or its receipt.
import type { Client } from "@ttasks/contracts/generated/client.ts";
import { ASK_MS, type Receipt } from "../edit/calls.ts";
import type { Kept } from "../kept.ts";

export type AddTask = Parameters<Client["task"]["add"]>[0]["tasks"][number];

export interface SentAdd {
  readonly request: string;
  /** The field's words it was sent for. */
  readonly text: string;
  /** The task as it was sent: "tomorrow" stays the day it meant then. */
  readonly task: AddTask;
  /** Where it goes, as the toast names it. */
  readonly where: string;
}

const REQUEST_ID = /^[0-9a-f-]{36}$/u;

const nameOf = (space: string) => `added.${space}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The space's sent add, read by its shape (the service checks the task itself). */
export function readSent(kept: Kept, space: string): SentAdd | undefined {
  const value = kept.json(nameOf(space));
  if (!isRecord(value)) return undefined;
  const { request, text, task, where } = value;
  if (typeof request !== "string" || !REQUEST_ID.test(request)) return undefined;
  if (typeof text !== "string" || text === "" || text.length > 500) return undefined;
  if (!isRecord(task) || typeof task["title"] !== "string") return undefined;
  if (typeof where !== "string" || where.length > 200) return undefined;
  return { request, text, task: task as AddTask, where };
}

export function keepSent(kept: Kept, space: string, sent: SentAdd | undefined): void {
  kept.keep(nameOf(space), sent === undefined ? undefined : JSON.stringify(sent));
}

/** What the service says a request did: made its task, refused it, never heard of it, or no word. */
export type Word =
  { readonly made: true; readonly as_of: string } | "refused" | "unheard" | "unknown";

/** A receipt's outcome of an add that made its task. */
const MADE: ReadonlySet<string> = new Set(["applied", "proposed", "unchanged"]);

/** The service's word on `request`, from its receipt; none when the read fails or takes too long. */
export async function wordOn(
  receipt: (request: string) => Promise<Receipt>,
  request: string,
): Promise<Word> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"unknown">((resolve) => {
    handle = setTimeout(() => {
      resolve("unknown");
    }, ASK_MS);
  });
  const read = receipt(request).then(
    (found): Word =>
      !found.found
        ? "unheard"
        : MADE.has(found.status)
          ? { made: true, as_of: found.as_of }
          : "refused",
    (): Word => "unknown",
  );
  try {
    return await Promise.race([read, late]);
  } finally {
    clearTimeout(handle);
  }
}
