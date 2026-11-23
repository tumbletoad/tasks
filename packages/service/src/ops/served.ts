// A space as the request path sees it, and one a call may go on with: the copy a caller's address
// found, which everything after the edge takes by this type, never by its ID.
import type { SpaceWriterHandle, WorkerConnection } from "@ttasks/storage";

/** A space as the request path sees it. The hub's space manager provides them. */
export interface ServedSpace {
  /** The space's ID as read from its folder, once it is served. */
  readonly id: string | undefined;
  /**
   * The ID its machine.toml entry names, also before it is served (unavailable, opening): it tells
   * which space an unserved copy is of, so copies of one space count as one (ops/copies.ts).
   */
  readonly registered?: string;
  readonly name: string | undefined;
  readonly state: "opening" | "open" | "read_only" | "unavailable" | "closing" | "closed";
  readonly reason?: string;
  /** Why a read-only space is read-only, in A1 3.2's words (a synced or network folder). */
  readonly message?: string;
  /** An open space whose backups are not working: why, in a fixed word (hub/backup-health.ts). */
  readonly backup?: string;
  /** Set while the space is open as this machine's. */
  readonly writer: SpaceWriterHandle | undefined;
  /** Set while the space is served: open or read-only. */
  readonly reader: WorkerConnection | undefined;
  /** The space's folder on this machine. */
  readonly folder: string;
}

/** A space a call may go on with: open or read-only, so served, with its ID. */
export type UsableSpace = ServedSpace & { readonly id: string };
