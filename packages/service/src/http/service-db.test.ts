// `<state>/service.sqlite` after a rollback: the older service that opens a file a newer version
// marked with a format it does not know refuses it before it writes anything.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DEFAULT_DRIVER, StorageWorker } from "@ttasks/storage";
import { DurableGrants } from "./grants.ts";
import { SERVICE_DB, SERVICE_DB_VERSION, ServiceDb } from "./service-db.ts";

let root: string;
beforeAll(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ttasks-service-db-")));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Marks the database as a newer build would: its format, and nothing else. */
async function markFormat(path: string, format: number): Promise<void> {
  const worker = await StorageWorker.start({ driver: DEFAULT_DRIVER });
  try {
    const conn = await worker.open(path, "writer");
    await conn.pragma("user_version", format);
    await conn.close();
  } finally {
    await worker.close();
  }
}

describe("[A2.3.2.3.service-db.newer] an older service does not write into a service.sqlite a newer version wrote", () => {
  test("a newer format is refused before anything is written, and the refusal names both formats", async () => {
    const dir = join(root, "newer");
    mkdirSync(dir);
    const made = await ServiceDb.open(dir);
    await made.close();
    const path = join(dir, SERVICE_DB);
    const newer = SERVICE_DB_VERSION + 1;
    await markFormat(path, newer);
    const before = readFileSync(path);

    let opened: ServiceDb | undefined;
    let refusal: unknown;
    try {
      opened = await ServiceDb.open(dir);
      // What an older service writes at once when another user holds its port.
      await opened.recordHolders(41_234, new Date(0), [null]);
    } catch (error) {
      refusal = error;
    } finally {
      await opened?.close();
    }
    expect(refusal).toBeInstanceOf(Error);
    const message = (refusal as Error).message;
    expect(message).toContain(`format ${String(newer)}`);
    expect(message).toContain(`format ${String(SERVICE_DB_VERSION)}`);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  test("a file of its own format opens again with what it holds", async () => {
    const dir = join(root, "own");
    mkdirSync(dir);
    const first = await ServiceDb.open(dir);
    await first.recordHolders(41_235, new Date(0), ["S-1-5-21-0"]);
    await first.close();
    const again = await ServiceDb.open(dir);
    try {
      expect(await again.observations(41_235)).toHaveLength(1);
    } finally {
      await again.close();
    }
  });
});

describe("[S5.link.run-saved] a phone's Run switch lasts a restart of the service", () => {
  test("Run switched on, then off, reads back as switched after the store is closed and opened again", async () => {
    const dir = join(root, "run-switch");
    mkdirSync(dir);
    const reopen = async (check: (grants: DurableGrants) => void | Promise<void>) => {
      const db = await ServiceDb.open(dir);
      try {
        await check(await DurableGrants.open(db));
      } finally {
        await db.close();
      }
    };
    let id = "";
    await reopen(async (grants) => {
      const { grant } = grants.create({
        kind: "device",
        principal: "user",
        spaces: ["sp_a"],
        scopes: ["space:read", "space:write"],
        attrs: { key: "fixture-pin" },
      });
      id = grant.grant_id;
      grants.setScopes(id, ["space:read", "space:write", "launch:run"]);
      await grants.flush();
    });
    await reopen(async (grants) => {
      expect(grants.get(id)?.scopes).toContain("launch:run");
      grants.setScopes(id, ["space:read", "space:write"]);
      await grants.flush();
    });
    await reopen((grants) => {
      expect(grants.get(id)?.scopes).toEqual(["space:read", "space:write"]);
    });
  });
});
