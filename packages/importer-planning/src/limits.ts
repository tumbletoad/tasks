// The bounds of every unbounded input (A7 3.15.2). Each one is far above what the prototype holds
// in daily use, and each one, when reached, gives a typed problem instead of unbounded work.

export interface Limits {
  /** TODO.md and DONE.md, each. */
  readonly ledgerBytes: number;
  /** One line of a ledger, in UTF-16 code units. A longer line is left out. */
  readonly lineLength: number;
  /** Task lines per ledger. Lines after the bound are left out. */
  readonly taskLines: number;
  /** data/metadata.json, data/jira.json, data/audit.json and tasks-export.json, each. */
  readonly jsonBytes: number;
  /** Entries of data/metadata.json and rows of data/jira.json. */
  readonly entries: number;
  /** Sources and paths of one metadata entry, each. */
  readonly itemsPerEntry: number;
  /** One event file. */
  readonly eventBytes: number;
  /** Every event file together: the copy and the read stop at it, so the files a run holds in
   * memory at once stay bounded however many there are. */
  readonly eventsBytes: number;
  /** Files in events/: `.json` and `.ready` together. */
  readonly eventFiles: number;
}

export const LIMITS: Limits = {
  ledgerBytes: 16 * 1024 * 1024,
  lineLength: 64 * 1024,
  taskLines: 100_000,
  jsonBytes: 32 * 1024 * 1024,
  entries: 100_000,
  itemsPerEntry: 1_000,
  eventBytes: 64 * 1024,
  eventsBytes: 64 * 1024 * 1024,
  eventFiles: 200_000,
};

export function limitsWith(overrides: Partial<Limits> | undefined): Limits {
  return overrides === undefined ? LIMITS : { ...LIMITS, ...overrides };
}
