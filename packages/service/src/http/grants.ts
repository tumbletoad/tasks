// The grants table, kept in `service.sqlite` (A2 3.2.5).
//
// The rows live in memory for the synchronous lookups the local server and the HTTP listener make
// (a token is checked on every request, a revoked row closes its connections at once), and every
// change is written through the database's worker in order. A change is in effect in this process
// the moment it is made; `flush()` resolves once every change made so far is on disk, and a token
// is handed to a browser only after that (auth.ts), so a token that works never vanishes in a
// restart. A revocation's in-memory effect never waits for the disk.
//
// UI tokens are `tasks_u_` plus 43 base64url characters (256 bits, A2 3.8.4). Only their SHA-256
// is kept. A lookup hashes the presented text and compares it with every row's hash in constant
// time, so the time does not depend on which row matches. A `ui` row expires 7 days after its last
// use and 30 days after creation at most. A use is recorded in memory at once and written at most
// once a minute per row, and at the drain: a crash loses at most a minute of "last used", which
// only makes the row expire sooner.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  GRANT_KINDS,
  isLive,
  newGrantId,
  UI_IDLE_MS,
  UI_MAX_MS,
  type Grant,
  type GrantKind,
  type GrantStore,
  type NewGrant,
} from "../local/index.ts";
import type { ServiceDb } from "./service-db.ts";

/** A2 3.8.4: a UI token's prefix. */
export const UI_TOKEN_PREFIX = "tasks_u_";
/** A UI token's shape: the prefix and 256 bits as base64url. Anything else is never a token. */
export const UI_TOKEN = /^tasks_u_[A-Za-z0-9_-]{43}$/;
/** A row's last use is written at most this often (it is exact in memory). */
export const USE_WRITE_MS = 60_000;

const hashOf = (token: string): Buffer => createHash("sha256").update(token, "utf8").digest();

/** The expiry of a `ui` row used at `use`: 7 days on, and never past 30 days from creation. */
export function uiExpiry(createdAt: string, use: Date): string {
  return new Date(
    Math.min(use.getTime() + UI_IDLE_MS, Date.parse(createdAt) + UI_MAX_MS),
  ).toISOString();
}

export class DurableGrants implements GrantStore {
  readonly #db: ServiceDb;
  readonly #rows = new Map<string, Grant>();
  readonly #listeners = new Set<(grantId: string) => void>();
  /** When each row's last use was last written. */
  readonly #written = new Map<string, number>();
  /** Rows changed and not yet handed to the database. */
  readonly #dirty = new Map<string, Grant>();
  #queue: Promise<void> = Promise.resolve();
  #failed = false;
  readonly #onFailure: () => void;

  private constructor(db: ServiceDb, onFailure: () => void) {
    this.#db = db;
    this.#onFailure = onFailure;
  }

  /**
   * Loads the table. `ui` rows that can never be used again (revoked, or expired at `now`) are
   * dropped: nothing reads them, and the table stays small.
   */
  static async open(
    db: ServiceDb,
    options: { now?: Date; onFailure?: () => void } = {},
  ): Promise<DurableGrants> {
    const now = options.now ?? new Date();
    const store = new DurableGrants(db, options.onFailure ?? (() => undefined));
    const dead: string[] = [];
    for (const row of await db.grants()) {
      if (row.kind === "ui" && !isLive(row, now)) dead.push(row.grant_id);
      else {
        store.#rows.set(row.grant_id, row);
        if (row.last_used_at !== null)
          store.#written.set(row.grant_id, Date.parse(row.last_used_at));
      }
    }
    await db.dropGrants(dead);
    return store;
  }

  #write(row: Grant): void {
    this.#dirty.set(row.grant_id, row);
    this.#queue = this.#queue.then(async () => {
      const batch = [...this.#dirty.values()];
      this.#dirty.clear();
      if (batch.length === 0) return;
      try {
        await this.#db.putGrants(batch);
      } catch {
        this.#failed = true;
        this.#onFailure();
      }
    });
  }

  /** Resolves when every change made so far is on disk; rejects when any write failed. */
  async flush(): Promise<void> {
    await this.#queue;
    if (this.#failed) throw new Error("The grants table could not be written");
  }

  /** Writes every use not yet written, then waits for the disk (the drain). */
  async close(): Promise<void> {
    for (const row of this.#rows.values()) {
      const written = this.#written.get(row.grant_id);
      if (row.last_used_at !== null && written !== Date.parse(row.last_used_at)) this.#write(row);
    }
    await this.#queue;
  }

  create(input: NewGrant, now: Date = new Date()): { grant: Grant; token: string | undefined } {
    if (!(GRANT_KINDS as readonly string[]).includes(input.kind)) {
      throw new TypeError("Unknown grant kind");
    }
    if (typeof input.principal !== "string" || input.principal === "") {
      throw new TypeError("A grant needs a principal");
    }
    const token =
      input.kind === "ui"
        ? `${UI_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`
        : undefined;
    const created = now.toISOString();
    const grant: Grant = {
      grant_id: newGrantId(),
      kind: input.kind,
      principal: input.principal,
      spaces: [...(input.spaces ?? [])],
      scopes: [...(input.scopes ?? [])],
      token_hash: token === undefined ? null : hashOf(token).toString("hex"),
      attrs: { ...(input.attrs ?? {}) },
      created_at: created,
      last_used_at: null,
      expires_at:
        input.kind === "ui"
          ? uiExpiry(created, now)
          : input.kind === "device" && input.expiresAt !== undefined
            ? input.expiresAt.toISOString()
            : null,
      revoked_at: null,
    };
    this.#rows.set(grant.grant_id, grant);
    this.#write(grant);
    return { grant, token };
  }

  get(grantId: string): Grant | undefined {
    return this.#rows.get(grantId);
  }

  list(kind?: GrantKind): Grant[] {
    return [...this.#rows.values()].filter((row) => kind === undefined || row.kind === kind);
  }

  findByToken(token: string, now: Date = new Date()): Grant | undefined {
    if (typeof token !== "string" || token === "") return undefined;
    const presented = hashOf(token);
    let found: Grant | undefined;
    // Every row with a token is compared, so the time does not depend on which row matches.
    for (const row of this.#rows.values()) {
      if (row.token_hash === null) continue;
      const stored = Buffer.from(row.token_hash, "hex");
      if (stored.length === presented.length && timingSafeEqual(stored, presented)) found = row;
    }
    return found !== undefined && isLive(found, now) ? found : undefined;
  }

  touch(grantId: string, now: Date = new Date()): Grant | undefined {
    const row = this.#rows.get(grantId);
    if (row === undefined || !isLive(row, now)) return undefined;
    const updated: Grant = {
      ...row,
      last_used_at: now.toISOString(),
      expires_at: row.kind === "ui" ? uiExpiry(row.created_at, now) : row.expires_at,
    };
    this.#rows.set(grantId, updated);
    const written = this.#written.get(grantId);
    if (written === undefined || now.getTime() - written >= USE_WRITE_MS) {
      this.#written.set(grantId, now.getTime());
      this.#write(updated);
    }
    return updated;
  }

  revoke(grantId: string, now: Date = new Date()): boolean {
    const row = this.#rows.get(grantId);
    if (row === undefined || row.revoked_at !== null) return false;
    const revoked: Grant = { ...row, revoked_at: now.toISOString() };
    this.#rows.set(grantId, revoked);
    this.#write(revoked);
    for (const listener of [...this.#listeners]) {
      try {
        listener(grantId);
      } catch {
        // One failing listener must not keep the others from closing their connections.
      }
    }
    return true;
  }

  /** Revokes every live row of `kind`. Returns how many. */
  revokeAll(kind: GrantKind, now: Date = new Date()): number {
    let count = 0;
    for (const row of [...this.#rows.values()]) {
      if (row.kind === kind && row.revoked_at === null && this.revoke(row.grant_id, now))
        count += 1;
    }
    return count;
  }

  onRevoke(listener: (grantId: string) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
