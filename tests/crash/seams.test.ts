// Where the write path's fault seams sit (WriteSeams, M1.07): `before-commit` inside the request's
// transaction, with every row and the receipt written and nothing committed, and `after-commit`
// once COMMIT returned, before the result goes back. A second connection shows which side of
// COMMIT each point is on. Fixture data only, in a temporary folder.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { Connection } from "../../packages/storage/src/driver.ts";
import { newId } from "../../packages/storage/src/ids.ts";
import { createSpace, openSpace } from "../../packages/storage/src/space.ts";
import type { WriteRequest, WriteResult } from "../../packages/storage/src/write/request.ts";
import { SpaceWriter, type WritePoint } from "../../packages/storage/src/write/writer.ts";
import { FIXTURE_MACHINE } from "../../packages/storage/test/fixture-requests.ts";
import { checkedDriver } from "../../packages/storage/test/space-helpers.ts";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const lastSeq = (reader: Connection): unknown =>
  reader.prepare("SELECT last_seq FROM space WHERE one = 1").get()?.["last_seq"];
const receipts = (reader: Connection): unknown =>
  reader.prepare("SELECT count(*) AS n FROM receipts").get()?.["n"];

describe(
  "[A1.5.crash.seams] the write path's fault seams sit before and after COMMIT",
  { timeout: 60_000 },
  () => {
    test("before-commit sees nothing committed, after-commit sees the commit and its receipt; a throw before COMMIT leaves nothing", async () => {
      const dir = mkdtempSync(join(tmpdir(), "tasks-crash-seams-"));
      made.push(dir);
      const checked = await checkedDriver();
      const created = createSpace(checked, join(dir, "space"), {
        name: "Crash",
        ownerLabel: "Crash owner",
        machineId: FIXTURE_MACHINE.id,
      });
      const reader = openSpace(checked, created.folder, { role: "reader" }).conn;
      const seen: { point: WritePoint; seq: unknown; receipts: unknown }[] = [];
      const decisions: { point: WritePoint; request: string; result: WriteResult }[] = [];
      let fail: WritePoint | undefined;
      const writer = SpaceWriter.open(
        openSpace(checked, created.folder, { role: "writer" }),
        { machine: FIXTURE_MACHINE },
        {
          at: (point, decision) => {
            seen.push({ point, seq: lastSeq(reader), receipts: receipts(reader) });
            decisions.push({
              point,
              request: decision.request.request_id,
              result: decision.result,
            });
            if (point === fail) throw new Error("planted failure at the seam");
          },
        },
      );
      try {
        const start = lastSeq(reader);
        const request = (n: number): WriteRequest => ({
          space_id: created.space.spaceId,
          request_id: `seams-request-${String(n).padStart(4, "0")}`,
          actor: {
            scope_id: "cli:crash-1",
            principal_id: created.actors.human,
            actor_kind: "human",
            machine_id: FIXTURE_MACHINE.id,
            origin: "cli",
          },
          ops: [{ kind: "task.create", id: newId("t"), title: `Crash task ${String(n)}` }],
        });
        const first = request(1);
        const result = writer.submit(first);
        expect(result.status).toBe("applied");
        expect(seen).toEqual([
          { point: "before-commit", seq: start, receipts: 0 },
          { point: "after-commit", seq: result.seq, receipts: 1 },
        ]);
        // Both points carry the request and the decision the caller then gets.
        expect(decisions).toEqual([
          { point: "before-commit", request: first.request_id, result },
          { point: "after-commit", request: first.request_id, result },
        ]);

        // A replay is decided in a transaction too, and passes both points with the replay.
        seen.length = 0;
        decisions.length = 0;
        expect(writer.submit(first).replayed).toBe(true);
        expect(seen.map((s) => s.point)).toEqual(["before-commit", "after-commit"]);
        expect(decisions.map((d) => d.result.replayed)).toEqual([true, true]);

        // A failure at before-commit rolls the whole request back: no commit, no receipt.
        seen.length = 0;
        fail = "before-commit";
        expect(() => writer.submit(request(2))).toThrow("planted failure at the seam");
        expect(lastSeq(reader)).toBe(result.seq);
        expect(receipts(reader)).toBe(1);
        // A failure at after-commit comes after COMMIT: the request stays decided.
        fail = "after-commit";
        expect(() => writer.submit(request(3))).toThrow("planted failure at the seam");
        expect(lastSeq(reader)).toBe(result.seq + 1);
        expect(receipts(reader)).toBe(2);
      } finally {
        writer.close();
        reader.close();
      }
    });
  },
);
