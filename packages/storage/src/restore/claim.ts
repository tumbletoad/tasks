// A claim (A1 3.18 "Claims and new incarnations", A6 3.5): a new random authority incarnation and a
// new epoch, in one commit. The new epoch is one more than the highest epoch known on this machine:
// the copy's own, every epoch in its lineage, and what the caller knows besides (the live space a
// restore in place replaces, and `spaces_seen` once machine-local state exists, M1.08). The lineage
// gains `{incarnation, epoch, kind, parent: {incarnation, through_seq}, machine_id, at}`, whose
// parent is the copy's incarnation at its last commit. So two claims of one backup make two
// incarnations, and a base or cursor from before the claim no longer matches.
//
// Two kinds: `restore_claim`, which a restore in place makes in its staging folder before the swap,
// and `claim`, which makes a read-only copy (a backup restored into a new folder) this machine's
// authority. Either ends the read-only copy state: the same transaction clears `space.transfer`,
// where a restore into a new folder marks the copy (restore.ts), so the claim and the end of the
// copy state commit together or not at all.
//
// The claim commit is the first of the new incarnation: its seq is `last_seq + 1`, and
// `authority_since` is that seq. It is a system commit of kind `ops` with one `space.claim`
// operation, written by the writer's own writeSystemCommit (write/writer.ts), in the one
// `commits.ops` format.
import type { Connection } from "../driver.ts";
import { misuse, StorageError } from "../errors.ts";
import { isId, newId, type Id, type RandomSource } from "../ids.ts";
import { manifestFor, writeManifest } from "../manifest.ts";
import { stepPosition } from "../migrate/steps.ts";
import { decodeSpaceRow, inRange, type LineageEntry, type SpaceRow } from "../rows.ts";
import { encodeRevision, type SchemaStep } from "../schema.ts";
import type { OpenedSpace } from "../space.ts";
import { writeSystemCommit } from "../write/writer.ts";

export interface ClaimOptions {
  kind: "claim" | "restore_claim";
  /** This machine: the new authority. */
  machineId: Id<"m">;
  /** Epochs known on this machine besides the copy's own and its lineage's. */
  knownEpochs?: readonly number[];
  /** Milliseconds since 1970. */
  now: number;
  random: RandomSource;
}

export interface Claim {
  epoch: number;
  incarnation: Id<"ai">;
  /** The claim's commit. */
  seq: number;
  parent: { incarnation: Id<"ai">; through_seq: number };
  space: SpaceRow;
}

const SPACE = "SELECT * FROM space WHERE one = 1";

/**
 * Claims the read-only copy that `opened` holds as its writer (opened with `read_only_copy`
 * allowed, under its process's claim: the storage worker's claimSpace), then rewrites space.json.
 * A crash between the claim's commit and space.json leaves a stale space.json, which the next
 * writer's open rebuilds from the database. The caller closes the connection.
 */
export function claimCopy(
  opened: OpenedSpace,
  options: Omit<ClaimOptions, "kind"> & { appVersion: string; steps: readonly SchemaStep[] },
): Claim {
  if (opened.role !== "writer" || !opened.readOnlyReasons.includes("read_only_copy")) {
    throw misuse("Only a read-only copy is claimed");
  }
  const position = stepPosition(options.steps, encodeRevision(opened.revision));
  if (position.state !== "known") throw misuse("The writer opened a revision it does not know");
  const claim = claimSpace(opened.conn, { ...options, kind: "claim" });
  writeManifest(opened.folder, manifestFor(claim.space, position.step, options.appVersion));
  return claim;
}

/** Claims the space on `conn`, a writer connection, in one IMMEDIATE transaction. */
export function claimSpace(conn: Connection, options: ClaimOptions): Claim {
  if (!isId(options.machineId, "m")) throw misuse("The machine ID is not an m_ ID");
  if (!inRange(options.now, "instant")) throw misuse("The clock gave an instant outside its range");
  for (const epoch of options.knownEpochs ?? []) {
    if (!inRange(epoch, "epoch")) throw misuse("A known epoch is outside its range");
  }
  return conn.transaction("immediate", () => {
    const before = decodeSpaceRow(conn.prepare(SPACE).get());
    const known = [
      before.authority.epoch,
      ...before.lineage.incarnations.map((entry) => entry.epoch),
      ...(options.knownEpochs ?? []),
    ];
    const epoch = known.reduce((a, b) => Math.max(a, b), 0) + 1;
    if (!inRange(epoch, "epoch")) {
      throw new StorageError("STORAGE_CONSTRAINT", "The space's authority epochs are used up");
    }
    const incarnation = newId("ai", options.random);
    const parent = { incarnation: before.authority.incarnation, through_seq: before.lastSeq };
    const { seq, at } = writeSystemCommit(conn, {
      kind: "ops",
      origin: "system",
      // The new incarnation is random, so the request ID is unique in the system scope.
      request: `claim-${incarnation.slice(3)}`,
      ops: [
        {
          v: 1,
          op: "space.claim",
          target: before.spaceId,
          input: { kind: options.kind, epoch, incarnation, parent },
        },
      ],
      epoch,
      incarnation,
      machine: options.machineId,
      now: options.now,
      random: options.random,
    });
    const entry: LineageEntry = {
      incarnation,
      epoch,
      kind: options.kind,
      parent,
      machine_id: options.machineId,
      at,
    };
    conn
      .prepare(
        `UPDATE space SET authority_machine = $machine, authority_epoch = $epoch,
           authority_incarnation = $incarnation, authority_since = $seq, lineage = $lineage,
           transfer = NULL
         WHERE one = 1`,
      )
      .run({
        machine: options.machineId,
        epoch,
        incarnation,
        seq,
        lineage: JSON.stringify({
          forked_from: before.lineage.forked_from,
          incarnations: [...before.lineage.incarnations, entry],
        }),
      });
    const space = decodeSpaceRow(conn.prepare(SPACE).get());
    return { epoch, incarnation, seq, parent, space };
  });
}
