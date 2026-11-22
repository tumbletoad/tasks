// A2 5: "Token lifecycle: mint, redeem once, expiry 7 days after last use and 30 days after
// creation, revoke, hash-only storage in grants", and the grants table kept in service.sqlite
// (A2 3.2.5): rows survive a restart, a revocation survives it too, and no raw secret is stored.
// Codes and tickets are single use with their own expiry (auth.ts).
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { UI_IDLE_MS, UI_MAX_MS, type Grant } from "../local/index.ts";
import { CODE_MS, OneTimeSecrets, RateLimit, TICKET_MS, probeProof, verifyProbe } from "./auth.ts";
import { DurableGrants, UI_TOKEN, UI_TOKEN_PREFIX, USE_WRITE_MS } from "./grants.ts";
import { SERVICE_DB, ServiceDb } from "./service-db.ts";

const SLOW = { timeout: 120_000 };
const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-11-14T08:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

let root: string;
beforeAll(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "kh-grants-")));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

let counter = 0;
const stateDir = () => {
  counter += 1;
  const dir = join(root, `s${String(counter)}`);
  return dir;
};

async function open(dir: string, now: Date = T0) {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  const db = await ServiceDb.open(dir);
  const grants = await DurableGrants.open(db, { now });
  return { db, grants };
}

describe("[A2.3.8.http.tokens] UI tokens and the grants table in service.sqlite", () => {
  test(
    "a token is ttasks_u_ and 256 bits; only its hash is stored, and it works after a restart",
    SLOW,
    async () => {
      const dir = stateDir();
      const first = await open(dir);
      const { grant, token } = first.grants.create(
        { kind: "ui", principal: "user", attrs: { agent: "Firefox" } },
        T0,
      );
      expect(token).toMatch(UI_TOKEN);
      expect(grant.token_hash).toMatch(/^[0-9a-f]{64}$/);
      await first.grants.flush();
      const stored = await first.db.grants();
      expect(stored).toHaveLength(1);
      expect(JSON.stringify(stored)).not.toContain(token ?? "missing");
      expect(JSON.stringify(stored)).not.toContain(
        (token ?? "ttasks_u_x").slice(UI_TOKEN_PREFIX.length),
      );
      await first.grants.close();
      await first.db.close();
      // No file of the database holds the token or its random part, in any encoding the test knows.
      for (const name of readdirSync(dir).filter((n) => n.startsWith(SERVICE_DB))) {
        const bytes = readFileSync(join(dir, name));
        expect(bytes.includes(Buffer.from(token ?? "", "utf8"))).toBe(false);
        expect(
          bytes.includes(Buffer.from((token ?? "").slice(UI_TOKEN_PREFIX.length), "utf8")),
        ).toBe(false);
      }
      const second = await open(dir);
      expect(second.grants.findByToken(token ?? "", at(DAY))?.grant_id).toBe(grant.grant_id);
      expect(second.grants.findByToken(`${token ?? ""}x`, at(DAY))).toBeUndefined();
      await second.db.close();
    },
  );

  test(
    "a token unused for 7 days is refused, and so is one created more than 30 days ago",
    SLOW,
    async () => {
      const { db, grants } = await open(stateDir());
      const idle = grants.create({ kind: "ui", principal: "user" }, T0);
      const used = grants.create({ kind: "ui", principal: "user" }, T0);
      expect(idle.grant.expires_at).toBe(at(UI_IDLE_MS).toISOString());
      // Unused: live until 7 days, refused from then.
      expect(grants.findByToken(idle.token ?? "", at(UI_IDLE_MS - 1))).toBeDefined();
      expect(grants.findByToken(idle.token ?? "", at(UI_IDLE_MS))).toBeUndefined();
      // Used every 6 days: still refused at 30 days after creation.
      for (let day = 6; day < 30; day += 6) {
        expect(grants.findByToken(used.token ?? "", at(day * DAY))).toBeDefined();
        const touched = grants.touch(used.grant.grant_id, at(day * DAY));
        expect(touched?.expires_at).toBe(
          new Date(
            Math.min(at(day * DAY + UI_IDLE_MS).getTime(), at(UI_MAX_MS).getTime()),
          ).toISOString(),
        );
      }
      expect(grants.findByToken(used.token ?? "", at(UI_MAX_MS - 1))).toBeDefined();
      expect(grants.findByToken(used.token ?? "", at(UI_MAX_MS))).toBeUndefined();
      expect(grants.touch(used.grant.grant_id, at(UI_MAX_MS))).toBeUndefined();
      await grants.flush();
      await db.close();
    },
  );

  test(
    "a revocation is at once in effect, tells listeners, and survives a restart; dead rows are dropped",
    SLOW,
    async () => {
      const dir = stateDir();
      const first = await open(dir);
      const a = first.grants.create({ kind: "ui", principal: "user" }, T0);
      const b = first.grants.create({ kind: "ui", principal: "user" }, T0);
      const home = first.grants.create(
        { kind: "agent_home", principal: "user", spaces: ["sp_x"], attrs: { instance: "i" } },
        T0,
      );
      const told: string[] = [];
      first.grants.onRevoke((id) => told.push(id));
      expect(first.grants.revoke(a.grant.grant_id, at(1))).toBe(true);
      expect(first.grants.revoke(a.grant.grant_id, at(2))).toBe(false);
      expect(told).toEqual([a.grant.grant_id]);
      expect(first.grants.findByToken(a.token ?? "", at(3))).toBeUndefined();
      await first.grants.close();
      await first.db.close();
      // At the next start the revoked row is gone, the live ones and the agent home stay.
      const second = await open(dir, at(DAY));
      expect(
        second.grants
          .list()
          .map((g) => g.grant_id)
          .sort(),
      ).toEqual([b.grant.grant_id, home.grant.grant_id].sort());
      expect(second.grants.revokeAll("ui", at(DAY))).toBe(1);
      expect(second.grants.findByToken(b.token ?? "", at(DAY))).toBeUndefined();
      expect(second.grants.get(home.grant.grant_id)?.revoked_at).toBeNull();
      await second.grants.close();
      await second.db.close();
      // A ui row that expired while the service was stopped is dropped too.
      const third = await open(dir, at(40 * DAY));
      expect(third.grants.list("ui")).toEqual([]);
      await third.db.close();
    },
  );

  test("a row's use is exact in memory and written at most once a minute; a failed write is reported", async () => {
    const writes: Grant[][] = [];
    let fail = false;
    let failures = 0;
    const fake = {
      grants: () => Promise.resolve([]),
      dropGrants: () => Promise.resolve(),
      putGrants: (rows: readonly Grant[]) => {
        if (fail) return Promise.reject(new Error("disk"));
        writes.push([...rows]);
        return Promise.resolve();
      },
    } as unknown as ServiceDb;
    const grants = await DurableGrants.open(fake, {
      now: T0,
      onFailure: () => {
        failures += 1;
      },
    });
    const { grant } = grants.create({ kind: "ui", principal: "user" }, T0);
    await grants.flush();
    expect(writes).toHaveLength(1);
    for (let s = 1; s < 60; s += 1) grants.touch(grant.grant_id, at(s * 1000));
    await grants.flush();
    // The first use is written; the next 58 within the minute are not.
    expect(writes).toHaveLength(2);
    expect(grants.get(grant.grant_id)?.last_used_at).toBe(at(59_000).toISOString());
    grants.touch(grant.grant_id, at(1000 + USE_WRITE_MS));
    await grants.flush();
    expect(writes).toHaveLength(3);
    // The drain writes the last use that was not written yet.
    grants.touch(grant.grant_id, at(2000 + USE_WRITE_MS));
    await grants.close();
    expect(writes.at(-1)?.[0]?.last_used_at).toBe(at(2000 + USE_WRITE_MS).toISOString());
    fail = true;
    grants.revoke(grant.grant_id, at(DAY));
    await expect(grants.flush()).rejects.toThrow();
    expect(failures).toBe(1);
  });

  test("codes and tickets: single use, 60 s and 30 s, kept as hashes, bounded in number", () => {
    const codes = new OneTimeSecrets<true>(CODE_MS, 3);
    const code = codes.mint(true, 0);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(codes.take(code, CODE_MS - 1)).toBe(true);
    expect(codes.take(code, CODE_MS - 1)).toBeUndefined();
    const late = codes.mint(true, 0);
    expect(codes.take(late, CODE_MS)).toBeUndefined();
    // A failed lookup spends nothing else, and garbage is no code.
    for (const bad of [undefined, 42, "", "x".repeat(44), `${code}=`]) {
      expect(codes.take(bad, 0)).toBeUndefined();
    }
    // At most 3 wait: the oldest is pushed out.
    const minted = [1, 2, 3, 4].map(() => codes.mint(true, 0));
    expect(codes.size).toBe(3);
    expect(codes.take(minted[0], 1)).toBeUndefined();
    expect(codes.take(minted[3], 1)).toBe(true);
    const tickets = new OneTimeSecrets<string>(TICKET_MS, 8);
    const ticket = tickets.mint("gr_a", 0);
    const other = tickets.mint("gr_b", 0);
    tickets.drop((grant) => grant === "gr_a");
    expect(tickets.take(ticket, 1)).toBeUndefined();
    expect(tickets.take(other, TICKET_MS - 1)).toBe("gr_b");
  });

  test("rate limits: a fixed one-minute window", () => {
    const limit = new RateLimit(10);
    const taken = Array.from({ length: 12 }, () => limit.take(1_000));
    expect(taken.filter(Boolean)).toHaveLength(10);
    expect(limit.take(60_999)).toBe(false);
    expect(limit.take(61_000)).toBe(true);
  });

  test("the probe proof: HMAC over the instance, port and nonce, compared in constant time", () => {
    const key = new Uint8Array(32).fill(7);
    const proof = probeProof(key, "a".repeat(32), 7713, "n".repeat(22));
    expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifyProbe(key, "a".repeat(32), 7713, "n".repeat(22), proof)).toBe(true);
    expect(verifyProbe(key, "a".repeat(32), 7714, "n".repeat(22), proof)).toBe(false);
    expect(verifyProbe(key, "b".repeat(32), 7713, "n".repeat(22), proof)).toBe(false);
    expect(verifyProbe(new Uint8Array(32), "a".repeat(32), 7713, "n".repeat(22), proof)).toBe(
      false,
    );
    expect(verifyProbe(key, "a".repeat(32), 7713, "n".repeat(22), "short")).toBe(false);
  });
});
