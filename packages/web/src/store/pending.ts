// Own writes (A5 3.15 item 4): an operation this tab sends may show its effect at once, as an
// overlay on the confirmed rows. The overlay is the only optimistic state, and it is never mixed
// into the confirmed rows: those change only through the feed.
//
// An overlay goes away when its write is settled:
// - confirmed: an applied batch carries an event with the write's `request_id`, so the confirmed
//   rows now hold its effect. The HTTP answer alone never confirms a write.
// - covered: the service answered with its `as_of` (the commit's position, or the head for a write
//   that changed nothing), and the applied cursor reached it in the same authority, or moved to a
//   later epoch. A snapshot that covers the write confirms it this way, and so does the feed for a
//   write that made no commit and so sends no event.
// - replaced: the write landed in an authority the feed has left for another of the same epoch (two
//   claims of one backup, A1 3.5). The new authority's rows are the truth and its seqs say nothing
//   about the write, so the overlay goes. An authority counts as left when the tab held it before
//   the current one, or when the cursor moved on from the one it held at the answer; an answer from
//   an authority the feed has not reached yet waits for it.
// - refused: the service refused it, or the call failed. Nothing of it stays behind. A call that
//   failed on the way may still have committed: the feed then brings its effect like anyone's.
import type { EffortLevel } from "@ttasks/contracts/preferences";
import type { Cursor, Scales, TaskRow } from "./rows.ts";

/** A task row's fields an overlay may change: every one but its ID. */
export type TaskField = Exclude<keyof TaskRow, "id">;

/** One optimistic change to a task row: fields set, fields cleared, or the row removed. */
export type TaskOverlay =
  | {
      readonly id: string;
      readonly set: Partial<Omit<TaskRow, "id">>;
      readonly clear?: readonly TaskField[];
    }
  | { readonly id: string; readonly remove: true };

export interface Overlay {
  readonly tasks: readonly TaskOverlay[];
  /** The space's effort levels as the write sets them. */
  readonly efforts?: readonly EffortLevel[];
}

/** Where the service said a write landed: `as_of`'s epoch, seq and incarnation tag (A1 3.5). */
export interface Landed {
  readonly epoch: number;
  readonly seq: number;
  readonly tag: string;
}

const AS_OF = /^([0-9]{1,10})\.([0-9]{1,15})\.([0-9a-z]{8})$/u;

/** The `as_of` of a write's answer, or undefined when it has none the page can read. */
export function landedOf(result: unknown): Landed | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const text = (result as Record<string, unknown>)["as_of"];
  const match = typeof text === "string" ? AS_OF.exec(text) : null;
  if (match === null) return undefined;
  const epoch = Number(match[1]);
  const seq = Number(match[2]);
  if (!Number.isSafeInteger(epoch) || !Number.isSafeInteger(seq)) return undefined;
  return { epoch, seq, tag: match[3] ?? "" };
}

/** The incarnation's tag as `as_of` carries it: the first 8 characters after its prefix. */
export const incarnationTag = (incarnation: string): string => {
  const at = incarnation.indexOf("_");
  return incarnation.slice(at + 1, at + 9);
};

/** Whether the applied cursor has reached where a write landed. */
export function covers(cursor: Cursor, landed: Landed): boolean {
  if (cursor.epoch !== landed.epoch) return cursor.epoch > landed.epoch;
  return incarnationTag(cursor.incarnation) === landed.tag && cursor.seq >= landed.seq;
}

/** An authority as `as_of` names it: the epoch and the incarnation's tag. */
const authorityOf = (cursor: Cursor): string =>
  `${String(cursor.epoch)}.${incarnationTag(cursor.incarnation)}`;

interface Entry {
  readonly overlay: Overlay;
  landed: Landed | undefined;
  /** The authority the cursor was in when the answer came, if there was a cursor. */
  under: string | undefined;
}

export type Settled = "confirmed" | "refused";

/** The writes on their way, in the order they were made. */
export class Pending {
  readonly #entries = new Map<string, Entry>();
  readonly #waiters = new Map<string, (settled: Settled) => void>();
  /** The authorities the cursor has been in before its current one. */
  readonly #left = new Set<string>();
  #current: string | undefined;

  get size(): number {
    return this.#entries.size;
  }

  has(request: string): boolean {
    return this.#entries.has(request);
  }

  /** A write is sent. `done` hears once how it settled. */
  add(request: string, overlay: Overlay, done?: (settled: Settled) => void): void {
    this.#entries.set(request, { overlay, landed: undefined, under: undefined });
    if (done !== undefined) this.#waiters.set(request, done);
  }

  /**
   * The service answered: the write landed at `landed`. Settles it at once when the cursor
   * already covers that. Returns whether it settled.
   */
  answered(request: string, landed: Landed | undefined, cursor: Cursor | undefined): boolean {
    const entry = this.#entries.get(request);
    if (entry === undefined) return false;
    if (landed === undefined) {
      // An answer without a position cannot be matched to the feed: the overlay goes, and the
      // feed shows what the write did.
      this.#settle(request, "confirmed");
      return true;
    }
    entry.landed = landed;
    if (cursor === undefined) return false;
    this.#note(cursor);
    entry.under = authorityOf(cursor);
    if (this.#reached(cursor, entry)) {
      this.#settle(request, "confirmed");
      return true;
    }
    return false;
  }

  /** The cursor's authority, remembered once the cursor leaves it. */
  #note(cursor: Cursor): void {
    const now = authorityOf(cursor);
    if (this.#current !== undefined && this.#current !== now) this.#left.add(this.#current);
    this.#current = now;
  }

  /** Whether the cursor covers where the write landed, or has left the authority it landed in. */
  #reached(cursor: Cursor, entry: Entry): boolean {
    const landed = entry.landed;
    if (landed === undefined) return false;
    if (covers(cursor, landed)) return true;
    if (cursor.epoch !== landed.epoch || incarnationTag(cursor.incarnation) === landed.tag) {
      return false;
    }
    const at = `${String(landed.epoch)}.${landed.tag}`;
    return this.#left.has(at) || (entry.under !== undefined && entry.under !== authorityOf(cursor));
  }

  /** The service refused the write, or the call failed: its overlay goes. */
  refused(request: string): boolean {
    if (!this.#entries.has(request)) return false;
    this.#settle(request, "refused");
    return true;
  }

  /**
   * The feed moved: settles the writes its events named, and those its cursor now covers.
   * Returns whether any settled.
   */
  feed(requests: Iterable<string>, cursor: Cursor | undefined): boolean {
    let any = false;
    for (const request of requests) {
      if (this.#entries.has(request)) {
        this.#settle(request, "confirmed");
        any = true;
      }
    }
    if (cursor === undefined) return any;
    this.#note(cursor);
    for (const [request, entry] of [...this.#entries]) {
      if (this.#reached(cursor, entry)) {
        this.#settle(request, "confirmed");
        any = true;
      }
    }
    return any;
  }

  #settle(request: string, settled: Settled): void {
    this.#entries.delete(request);
    const done = this.#waiters.get(request);
    this.#waiters.delete(request);
    done?.(settled);
  }

  /** The confirmed task rows with every pending overlay on top, in the order they were made. */
  view(tasks: ReadonlyMap<string, TaskRow>): ReadonlyMap<string, TaskRow> {
    if (this.#entries.size === 0) return tasks;
    const out = new Map(tasks);
    for (const { overlay } of this.#entries.values()) {
      for (const change of overlay.tasks) {
        if ("remove" in change) {
          out.delete(change.id);
          continue;
        }
        // A change to a row the set no longer holds shows nothing: the feed decides.
        const row = out.get(change.id);
        if (row === undefined) continue;
        const cleared = new Set<string>(change.clear ?? []);
        const next = Object.entries({ ...row, ...change.set }).filter(([f]) => !cleared.has(f));
        out.set(change.id, Object.fromEntries(next) as unknown as TaskRow);
      }
    }
    return out;
  }

  /** The confirmed scales with the newest pending effort levels in place of the space's. */
  scales(scales: Scales): Scales {
    let efforts: readonly EffortLevel[] | undefined;
    for (const { overlay } of this.#entries.values()) efforts = overlay.efforts ?? efforts;
    return efforts === undefined ? scales : { ...scales, efforts };
  }
}
