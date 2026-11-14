// Shared set-up for the backup, migration and restore tests (M1.06): commits written through the
// write path (M1.04), as the testkit builds its sample, the facts a sidecar records, read from a
// live space, and copies of a folder tree taken at a crash point. Fixture data only.
import { cpSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { expect } from "vitest";
import type { Connection } from "../src/driver.ts";
import { isId } from "../src/ids.ts";
import { DATABASE_FILE } from "../src/manifest.ts";
import { openReader, openWriter } from "../src/open.ts";
import { decodeSpaceRow, type SpaceRow } from "../src/rows.ts";
import { tableCounts } from "../src/backup/snapshot.ts";
import type { SchemaStep } from "../src/schema.ts";
import { openSpace } from "../src/space.ts";
import { SpaceWriter } from "../src/write/writer.ts";
import { createRequest, FIXTURE_MACHINE, ownerCredential } from "./fixture-requests.ts";
import { openSpaceAt } from "./revisions.ts";
import { checkedDriver } from "./space-helpers.ts";

/**
 * A raw writer on a space's database, for tests that damage or rewrite a space on purpose. The
 * caller closes it.
 */
export async function rawWriter(folder: string): Promise<Connection> {
  return openWriter(await checkedDriver(), join(folder, DATABASE_FILE));
}

/**
 * Brings the space at `folder` `count` commits further through the write path (M1.04), as the
 * testkit builds its sample: this machine's `machine.register` when the writer opens the space for
 * the first time, then one `task.create` per commit. Returns the space's last seq. `steps` opens
 * it as a build with that chain would (revisions.ts: STEPS_0_1 for a space at 0.1).
 */
export async function writeCommits(
  folder: string,
  count: number,
  tag = "s",
  steps?: readonly SchemaStep[],
): Promise<number> {
  const checked = await checkedDriver();
  const opened =
    steps === undefined
      ? openSpace(checked, folder, { role: "writer" })
      : openSpaceAt(checked, folder, { role: "writer" }, steps);
  const owner = opened.conn.prepare("SELECT id FROM actors WHERE kind = 'human'").get()?.["id"];
  if (!isId(owner, "ac")) throw new Error("the fixture space has no owner");
  const writer = SpaceWriter.attach(opened, { machine: FIXTURE_MACHINE });
  try {
    let written = count > 0 && writer.registerMachine() ? 1 : 0;
    for (; written < count; written += 1) {
      const result = writer.submit(
        createRequest(writer.spaceId, ownerCredential(owner), `Task ${tag}${String(written)}`),
      );
      expect(result.status, JSON.stringify(result.error)).toBe("applied");
    }
    return writer.asOf().seq;
  } finally {
    writer.close();
  }
}

/** What a sidecar records, read from a space folder's database through a reader. */
export interface LiveFacts {
  space: SpaceRow;
  userVersion: number;
  counts: Record<string, number>;
  integrity: unknown;
}

export async function readFacts(folder: string): Promise<LiveFacts> {
  const conn = openReader(await checkedDriver(), join(folder, DATABASE_FILE));
  try {
    return conn.transaction("deferred", () => ({
      space: decodeSpaceRow(conn.prepare("SELECT * FROM space WHERE one = 1").get()),
      userVersion: Number(conn.pragma("user_version")),
      counts: tableCounts(conn),
      integrity: conn.pragma("integrity_check"),
    }));
  } finally {
    conn.close();
  }
}

/** Copies a folder tree as it is now: what a crash at this moment would leave on disk. */
export function copyTree(from: string, to: string): void {
  cpSync(from, to, { recursive: true });
}

/** Every file under `folder`, by relative path, with the SHA-256 of its bytes. */
export function treeDigest(folder: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        out[relative(folder, path).replaceAll("\\", "/")] = createHash("sha256")
          .update(readFileSync(path))
          .digest("hex");
      }
    }
  };
  if (statSync(folder, { throwIfNoEntry: false })?.isDirectory() === true) walk(folder);
  return out;
}
