// The `grants` table (A2 3.2.5, A6 3.3): one table for every credential and registration on this
// machine. UI sessions (`ui`), A3's agent-home registrations (`agent_home`) and, from L1, A6's
// device grants (`device`). This module defines the interface and an in-memory implementation.
// The durable table lives in `<state>/service.sqlite` and arrives with the first step that needs
// rows to survive a restart (M2.12, UI tokens), behind this same interface.
//
// Raw secrets are never stored: a row keeps the SHA-256 of its token, and a lookup hashes the
// presented token and compares it with every row in constant time. Revoking a row tells every
// listener, and the local server closes each live connection that used it.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { encodeIdBody } from "@tasks/storage";

export const GRANT_KINDS = ["ui", "agent_home", "device"] as const;
export type GrantKind = (typeof GRANT_KINDS)[number];

/** A `ui` grant expires this long after its last use (A2 3.8.4, S15). */
export const UI_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
/** A `ui` grant expires this long after its creation at the latest. */
export const UI_MAX_MS = 30 * 24 * 60 * 60 * 1000;

/** One row of the grants table, with A2 3.2.5's column names. Times are ISO 8601 UTC. */
export interface Grant {
  /** `gr_` and 128 random bits in A1 3.3's ID alphabet. Stable for the row's life. */
  readonly grant_id: string;
  readonly kind: GrantKind;
  /** The human principal the row acts for (A3). */
  readonly principal: string;
  /** Space IDs the row may use. A `ui` row covers every space on this machine. */
  readonly spaces: readonly string[];
  /** Empty for `ui` and `agent_home` in v1. A6 fills it for devices. */
  readonly scopes: readonly string[];
  /** SHA-256 hex of the bearer secret, or null when the row has none (`agent_home`). */
  readonly token_hash: string | null;
  /** Kind-specific details: a user-agent label, an agent home, a device's keys. Never a secret. */
  readonly attrs: Readonly<Record<string, unknown>>;
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly expires_at: string | null;
  readonly revoked_at: string | null;
}

export interface NewGrant {
  readonly kind: GrantKind;
  readonly principal: string;
  readonly spaces?: readonly string[];
  readonly scopes?: readonly string[];
  readonly attrs?: Readonly<Record<string, unknown>>;
  /** For `device` rows: A6's expiry. `ui` rows compute theirs, `agent_home` rows have none. */
  readonly expiresAt?: Date;
}

export interface GrantStore {
  /**
   * Adds a row. A `ui` row gets a new bearer token, returned here once and never stored. Other
   * kinds get none.
   */
  create(input: NewGrant, now?: Date): { grant: Grant; token: string | undefined };
  get(grantId: string): Grant | undefined;
  list(kind?: GrantKind): Grant[];
  /** The live row whose token this is: not revoked, not expired. Constant time per row. */
  findByToken(token: string, now?: Date): Grant | undefined;
  /** Records a use. For `ui` rows it moves the expiry to 7 days from now, 30 days from creation at most. */
  touch(grantId: string, now?: Date): Grant | undefined;
  /** Sets `revoked_at` and tells every listener. False when the row is unknown or already revoked. */
  revoke(grantId: string, now?: Date): boolean;
  /** Calls `listener` with the ID of every row revoked from now on. Returns the unsubscribe function. */
  onRevoke(listener: (grantId: string) => void): () => void;
  /** A durable table: resolves once every change made so far is on disk. */
  flush?(): Promise<void>;
}

/** Whether a row may be used for a space. */
export function coversSpace(grant: Grant, spaceId: string): boolean {
  return grant.kind === "ui" || grant.spaces.includes(spaceId);
}

/** Whether a row is live at `now`: not revoked and not expired. */
export function isLive(grant: Grant, now: Date = new Date()): boolean {
  if (grant.revoked_at !== null) return false;
  return grant.expires_at === null || now.getTime() < Date.parse(grant.expires_at);
}

export function newGrantId(): string {
  return `gr_${encodeIdBody(randomBytes(16))}`;
}

const tokenHash = (token: string): Buffer => createHash("sha256").update(token, "utf8").digest();

/** The grants table in memory. It forgets everything when the process ends. */
export class MemoryGrants implements GrantStore {
  readonly #rows = new Map<string, Grant>();
  readonly #listeners = new Set<(grantId: string) => void>();

  create(input: NewGrant, now: Date = new Date()): { grant: Grant; token: string | undefined } {
    if (!(GRANT_KINDS as readonly string[]).includes(input.kind)) {
      throw new TypeError("Unknown grant kind");
    }
    if (typeof input.principal !== "string" || input.principal === "") {
      throw new TypeError("A grant needs a principal");
    }
    const token = input.kind === "ui" ? randomBytes(32).toString("base64url") : undefined;
    const created = now.toISOString();
    const expires =
      input.kind === "ui"
        ? new Date(now.getTime() + Math.min(UI_IDLE_MS, UI_MAX_MS)).toISOString()
        : input.kind === "device" && input.expiresAt !== undefined
          ? input.expiresAt.toISOString()
          : null;
    const grant: Grant = {
      grant_id: newGrantId(),
      kind: input.kind,
      principal: input.principal,
      spaces: [...(input.spaces ?? [])],
      scopes: [...(input.scopes ?? [])],
      token_hash: token === undefined ? null : tokenHash(token).toString("hex"),
      attrs: { ...(input.attrs ?? {}) },
      created_at: created,
      last_used_at: null,
      expires_at: expires,
      revoked_at: null,
    };
    this.#rows.set(grant.grant_id, grant);
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
    const presented = tokenHash(token);
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
    const expires =
      row.kind === "ui"
        ? new Date(
            Math.min(now.getTime() + UI_IDLE_MS, Date.parse(row.created_at) + UI_MAX_MS),
          ).toISOString()
        : row.expires_at;
    const updated: Grant = { ...row, last_used_at: now.toISOString(), expires_at: expires };
    this.#rows.set(grantId, updated);
    return updated;
  }

  revoke(grantId: string, now: Date = new Date()): boolean {
    const row = this.#rows.get(grantId);
    if (row === undefined || row.revoked_at !== null) return false;
    this.#rows.set(grantId, { ...row, revoked_at: now.toISOString() });
    for (const listener of [...this.#listeners]) {
      try {
        listener(grantId);
      } catch {
        // One failing listener must not keep the others from closing their connections.
      }
    }
    return true;
  }

  onRevoke(listener: (grantId: string) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
