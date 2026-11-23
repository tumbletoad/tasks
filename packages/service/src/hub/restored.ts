// A restored copy of a space on this machine: its own record, which says it is one whatever else
// keeps it from being written, and the refusal of an open while another folder serves its space
// (spaces.ts, ONE COPY AT A TIME).

/**
 * A restored copy's own record (storage's restore mark, `space.transfer`): when it was restored and
 * the backup file's name. Shown whatever else keeps the copy from being written.
 */
export interface Restored {
  /** When it was restored, ISO 8601. */
  readonly at: string;
  /** The backup or bundle file it was restored from, its name only. */
  readonly backup?: string;
}

/**
 * The restore mark of a space row's `transfer` (its text, or space.json's value), or undefined for
 * a space that is no restored copy.
 */
export function restoredOf(transfer: unknown): Restored | undefined {
  let mark: unknown = transfer;
  if (typeof transfer === "string") {
    try {
      mark = JSON.parse(transfer);
    } catch {
      return undefined;
    }
  }
  if (typeof mark !== "object" || mark === null) return undefined;
  const { state, at, backup } = mark as Record<string, unknown>;
  if (state !== "restored_copy" || typeof at !== "number" || !Number.isFinite(at)) return undefined;
  return {
    at: new Date(at).toISOString(),
    ...(typeof backup === "string" && /^[^/\\]{1,255}$/u.test(backup) ? { backup } : {}),
  };
}

/**
 * An open of a folder whose space another folder serves now: `open`, with the space's ID and
 * name.
 */
export class OtherCopyOpen extends Error {
  override readonly name = "OtherCopyOpen";
  readonly open: string;
  readonly spaceId: string;
  readonly spaceName: string | undefined;
  constructor(open: string, spaceId: string, spaceName: string | undefined) {
    super("Another copy of this space is open");
    this.open = open;
    this.spaceId = spaceId;
    this.spaceName = spaceName;
  }
}
