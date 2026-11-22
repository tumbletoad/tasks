// Search cursors bound to a snapshot (A3 3.9.5). A search's first page freezes the ordered list of
// its matching IDs (at most SEARCH_IDS) at as_of S, and every later page reads its slice of that list,
// so no row is skipped or repeated and the order is never computed again.
//
// The list lives in memory only, so a service restart drops it. Each page gets a cursor of its own
// (`c_` and 16 base32 characters, 80 random bits) for the page after it: asking with the same
// cursor again gives the same page, so a retry after a lost answer skips nothing. A cursor belongs
// to its space and to the caller's binding (the writer scope the call acts in: the bound session's,
// else the connection's, A3 3.7.9), and it expires after 15 minutes unused. Each binding keeps at
// most 32; the least recently used goes first. The page read checks the space's epoch and
// incarnation against the list's (search.ts), so a claim, transfer or restore expires it too.
import { randomBytes } from "node:crypto";
import { AppError } from "@ttasks/contracts";
import type { FrozenKind } from "@ttasks/storage";
import type { Scope } from "./plan.ts";

export const CURSOR_LIMITS = {
  /** Cursors each binding keeps. */
  perOwner: 32,
  /** Unused this long, a cursor expires. */
  idleMs: 15 * 60_000,
  /** Expired and evicted cursors remembered, so a late page names `idle`. */
  remembered: 1024,
} as const;

export type ExpiredReason = "idle" | "restart" | "epoch" | "incarnation" | "binding";

/** One frozen entry: an ID with the task reference it had at S (a placeholder shows it). */
export interface FrozenItem {
  readonly id: string;
  readonly ref: string;
  /** The best document at S, for the snippet; null without text. */
  readonly doc: number | null;
  /**
   * That document's entity at S: a page shows a snippet only while the number still holds it, since
   * a number freed by a removal can be taken by a later document.
   */
  readonly entity: string | null;
}

/** A search's frozen list and what each of its pages needs. */
export interface FrozenSearch {
  readonly space: string;
  readonly epoch: number;
  readonly incarnation: string;
  /** S: the seq the list was frozen at. A row changed after it is marked. */
  readonly seq: number;
  readonly owner: string;
  readonly kind: FrozenKind;
  readonly scope: Scope;
  readonly parsed: string;
  readonly audience: "user" | "agent";
  readonly match: string | null;
  readonly limit: number;
  readonly items: readonly FrozenItem[];
  readonly total: number | `${number}+`;
}

interface Held {
  readonly search: FrozenSearch;
  readonly offset: number;
  used: number;
}

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** `c_` and 16 base32 characters from 80 random bits. */
function newCursor(): string {
  const bytes = randomBytes(10);
  let bits = 0;
  let value = 0;
  let out = "c_";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET.charAt((value >> bits) & 31);
    }
    value &= (1 << bits) - 1;
  }
  return out;
}

/** `cursor_expired` with its reason (A3 3.5), and the way on: search again. */
export function cursorExpired(reason: ExpiredReason): AppError {
  return new AppError({
    code: "cursor_expired",
    message: "This search cursor is no longer valid.",
    hint: "Run the search again.",
    data: { reason },
  });
}

/** The cursors of one service run. */
export class SearchCursors {
  readonly #now: () => number;
  /** By cursor, least recently used first. */
  readonly #held = new Map<string, Held>();
  readonly #gone = new Map<string, ExpiredReason>();

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  #forget(cursor: string, reason: ExpiredReason): void {
    this.#held.delete(cursor);
    this.#gone.set(cursor, reason);
    while (this.#gone.size > CURSOR_LIMITS.remembered) {
      const oldest = this.#gone.keys().next().value;
      if (oldest === undefined) break;
      this.#gone.delete(oldest);
    }
  }

  #sweep(now: number): void {
    for (const [cursor, held] of this.#held) {
      if (now - held.used >= CURSOR_LIMITS.idleMs) this.#forget(cursor, "idle");
    }
  }

  /**
   * The cursor for the page of `search` that starts at `offset`: the one already issued for it,
   * so a page read twice gives the same answer, or a new one.
   */
  issue(search: FrozenSearch, offset: number): string {
    const now = this.#now();
    this.#sweep(now);
    for (const [held, entry] of this.#held) {
      if (entry.search === search && entry.offset === offset) {
        entry.used = now;
        this.#held.delete(held);
        this.#held.set(held, entry);
        return held;
      }
    }
    let cursor = newCursor();
    while (this.#held.has(cursor) || this.#gone.has(cursor)) cursor = newCursor();
    this.#held.set(cursor, { search, offset, used: now });
    const mine = [...this.#held].filter(([, held]) => held.search.owner === search.owner);
    for (const [old] of mine.slice(0, Math.max(0, mine.length - CURSOR_LIMITS.perOwner))) {
      this.#forget(old, "idle");
    }
    return cursor;
  }

  /**
   * The search and offset a cursor names, for `owner` in `space`; else `cursor_expired` with its
   * reason. An unknown cursor was issued before a restart, or never.
   */
  take(cursor: string, owner: string, space: string): { search: FrozenSearch; offset: number } {
    const now = this.#now();
    this.#sweep(now);
    const held = this.#held.get(cursor);
    if (held === undefined) throw cursorExpired(this.#gone.get(cursor) ?? "restart");
    if (held.search.owner !== owner || held.search.space !== space) {
      throw cursorExpired("binding");
    }
    held.used = now;
    // Most recently used last.
    this.#held.delete(cursor);
    this.#held.set(cursor, held);
    return { search: held.search, offset: held.offset };
  }

  /** Drops every cursor of a list whose history ended (another epoch or incarnation). */
  expire(search: FrozenSearch, reason: ExpiredReason): void {
    for (const [cursor, held] of this.#held) {
      if (held.search === search) this.#forget(cursor, reason);
    }
  }
}
