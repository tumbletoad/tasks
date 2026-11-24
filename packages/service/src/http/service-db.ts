// `<state>/service.sqlite` (A2 3.2.3): the machine-level records. This step brings its first two
// tables: the `grants` table (A2 3.2.5), so UI tokens survive a restart, and the foreign
// port-holder observations (A2 3.8.2 step 3). Later steps add their own tables (update state,
// crash counters, A6's pairing rows) as new schema versions.
//
// The database lives in a storage worker of its own, like every database of the service: the main
// thread holds no SQLite connection (A1 3.9, A2 3.1), and only storage imports a SQLite
// binding (A7 3.2). The service reads the rows once at start and keeps them in memory; every
// change is written through the worker (grants.ts).
import { closeSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DRIVER, StorageWorker, type Row, type WorkerConnection } from "@ttasks/storage";
import { CLI_NAME, PRODUCT_NAME } from "@ttasks/brand";
import { createFile } from "../hub/files.ts";
import { GRANT_KINDS, type Grant, type GrantKind } from "../local/index.ts";

export const SERVICE_DB = "service.sqlite";

/** The schema version this build writes (`PRAGMA user_version`). */
export const SERVICE_DB_VERSION = 1;

const SCHEMA_1 = `
CREATE TABLE IF NOT EXISTS grants (
  grant_id     TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('ui','agent_home','device')),
  principal    TEXT NOT NULL,
  spaces       TEXT NOT NULL CHECK (json_valid(spaces)),
  scopes       TEXT NOT NULL CHECK (json_valid(scopes)),
  token_hash   TEXT CHECK (token_hash IS NULL OR length(token_hash) = 64),
  attrs        TEXT NOT NULL CHECK (json_valid(attrs)),
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  expires_at   TEXT,
  revoked_at   TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS grants_kind ON grants(kind);
CREATE TABLE IF NOT EXISTS port_holders (
  id      INTEGER PRIMARY KEY,
  port    INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  seen_at TEXT NOT NULL,
  owner   TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS port_holders_port ON port_holders(port);
`;

/**
 * A service.sqlite marked with a format this build does not know: a newer version wrote it, and
 * this one, after a rollback, must not write into what it cannot read. The message is for people.
 */
export class NewerServiceDb extends Error {
  override readonly name = "NewerServiceDb";
  constructor(format: number) {
    super(
      `${PRODUCT_NAME}'s service.sqlite is in format ${String(format)}, which a newer version of ${PRODUCT_NAME} wrote; this version knows format ${String(SERVICE_DB_VERSION)}, so the service does not start. Run that version again, or a newer one: after a rollback, ${CLI_NAME} update --rollback goes back to it.`,
    );
  }
}

/** How often a service.sqlite that goes away between its creation and the open is made again. */
const GONE_TRIES = 3;

/**
 * Opens `<state>/service.sqlite` as the writer. A missing file is created here, exclusively and
 * with exactly 0600 whatever the umask (A2 3.2.2 rule 5), and SQLite opens it without `create`: it
 * would give a file it creates its own default mode masked by the umask. Its -wal and -shm take
 * the database file's mode from SQLite. One that is there keeps its mode. A file removed between
 * the creation and the open is created again.
 */
async function openCreated(worker: StorageWorker, path: string): Promise<WorkerConnection> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      closeSync(createFile(path, 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    try {
      return await worker.open(path, "writer");
    } catch (error) {
      if (existsSync(path) || attempt >= GONE_TRIES) throw error;
    }
  }
}

/** One recorded sighting of another OS user on a port (A2 3.8.2 step 3). */
export interface PortObservation {
  readonly port: number;
  readonly seen_at: string;
  /** The other user's UID or SID, where the OS said. */
  readonly owner: string | null;
}

const UPSERT_GRANT =
  "INSERT INTO grants (grant_id, kind, principal, spaces, scopes, token_hash, attrs, created_at, " +
  "last_used_at, expires_at, revoked_at) VALUES ($grant_id, $kind, $principal, $spaces, $scopes, " +
  "$token_hash, $attrs, $created_at, $last_used_at, $expires_at, $revoked_at) " +
  "ON CONFLICT (grant_id) DO UPDATE SET last_used_at = excluded.last_used_at, " +
  "expires_at = excluded.expires_at, revoked_at = excluded.revoked_at";

const asText = (value: unknown): string | null => (typeof value === "string" ? value : null);

function decodeGrant(row: Row): Grant | undefined {
  const kind = row["kind"];
  if (typeof kind !== "string" || !(GRANT_KINDS as readonly string[]).includes(kind)) return;
  const id = row["grant_id"];
  const principal = row["principal"];
  const created = row["created_at"];
  if (typeof id !== "string" || typeof principal !== "string" || typeof created !== "string") {
    return undefined;
  }
  const list = (value: unknown): string[] => {
    try {
      const parsed = JSON.parse(String(value)) as unknown;
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  };
  let attrs: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(row["attrs"])) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      attrs = parsed as Record<string, unknown>;
    }
  } catch {
    // An unreadable attrs column reads as none.
  }
  return {
    grant_id: id,
    kind: kind as GrantKind,
    principal,
    spaces: list(row["spaces"]),
    scopes: list(row["scopes"]),
    token_hash: asText(row["token_hash"]),
    attrs,
    created_at: created,
    last_used_at: asText(row["last_used_at"]),
    expires_at: asText(row["expires_at"]),
    revoked_at: asText(row["revoked_at"]),
  };
}

/** `service.sqlite`, open in a storage worker of its own. */
export class ServiceDb {
  readonly #worker: StorageWorker;
  readonly #conn: WorkerConnection;
  #closing: Promise<void> | undefined;

  private constructor(worker: StorageWorker, conn: WorkerConnection) {
    this.#worker = worker;
    this.#conn = conn;
  }

  /** Opens (or creates) `<state>/service.sqlite` and brings its schema to this build's version. */
  static async open(
    stateDir: string,
    options: { startWorker?: () => Promise<StorageWorker> } = {},
  ): Promise<ServiceDb> {
    const worker = await (
      options.startWorker ?? (() => StorageWorker.start({ driver: DEFAULT_DRIVER }))
    )();
    try {
      const conn = await openCreated(worker, join(stateDir, SERVICE_DB));
      // Read before the first write, the journal mode's included.
      const version = Number(await conn.pragma("user_version"));
      if (version > SERVICE_DB_VERSION) {
        await conn.close().catch(() => undefined);
        throw new NewerServiceDb(version);
      }
      await conn.pragma("journal_mode", "wal");
      if (version < SERVICE_DB_VERSION) {
        await conn.exec(SCHEMA_1);
        await conn.pragma("user_version", SERVICE_DB_VERSION);
      }
      return new ServiceDb(worker, conn);
    } catch (error) {
      await worker.close().catch(() => undefined);
      throw error;
    }
  }

  async grants(): Promise<Grant[]> {
    const rows = await this.#conn.all("SELECT * FROM grants ORDER BY created_at, grant_id");
    return rows.flatMap((row) => {
      const grant = decodeGrant(row);
      return grant === undefined ? [] : [grant];
    });
  }

  /** Writes rows: a new row whole, an existing row's use, expiry and revocation. One transaction. */
  async putGrants(grants: readonly Grant[]): Promise<void> {
    if (grants.length === 0) return;
    await this.#conn.transaction(
      "immediate",
      grants.map((grant) => ({
        sql: UPSERT_GRANT,
        mode: "run" as const,
        params: {
          grant_id: grant.grant_id,
          kind: grant.kind,
          principal: grant.principal,
          spaces: JSON.stringify(grant.spaces),
          scopes: JSON.stringify(grant.scopes),
          token_hash: grant.token_hash,
          attrs: JSON.stringify(grant.attrs),
          created_at: grant.created_at,
          last_used_at: grant.last_used_at,
          expires_at: grant.expires_at,
          revoked_at: grant.revoked_at,
        },
      })),
    );
  }

  /** Removes rows that can never be used again: dead `ui` rows (revoked or expired). */
  async dropGrants(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.#conn.transaction(
      "immediate",
      ids.map((id) => ({
        sql: "DELETE FROM grants WHERE grant_id = $id",
        mode: "run" as const,
        params: { id },
      })),
    );
  }

  async observations(port?: number): Promise<PortObservation[]> {
    const rows =
      port === undefined
        ? await this.#conn.all("SELECT port, seen_at, owner FROM port_holders ORDER BY id")
        : await this.#conn.all(
            "SELECT port, seen_at, owner FROM port_holders WHERE port = $port ORDER BY id",
            { port },
          );
    return rows.map((row) => ({
      port: Number(row["port"]),
      seen_at: String(row["seen_at"]),
      owner: asText(row["owner"]),
    }));
  }

  /** Records that other users held `port` at `at`: one row per owner (null when unknown). */
  async recordHolders(port: number, at: Date, owners: readonly (string | null)[]): Promise<void> {
    const list = owners.length === 0 ? [null] : owners;
    await this.#conn.transaction(
      "immediate",
      list.map((owner) => ({
        sql: "INSERT INTO port_holders (port, seen_at, owner) VALUES ($port, $at, $owner)",
        mode: "run" as const,
        params: { port, at: at.toISOString(), owner },
      })),
    );
  }

  /** `ttasks service port`: the user resolved the observations (A2 3.8.2 step 5). */
  async clearObservations(): Promise<void> {
    await this.#conn.run("DELETE FROM port_holders");
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      await this.#conn.close().catch(() => undefined);
      await this.#worker.close().catch(() => undefined);
    })();
    return this.#closing;
  }
}
