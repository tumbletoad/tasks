// The grants table (A2 3.2.5, A6 3.3, A2 5 "grants table: one row per kind, revocation closes
// live connections, no raw secret stored"), in its in-memory form.
import { createHash, timingSafeEqual } from "node:crypto";
import { connect, openLines, openRpc } from "@tasks/bridge/protocol";
import { clientInfo, endpointRoot, until } from "@tasks/bridge/test/endpoint";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { startServer } from "../../test/local.ts";
import { GRANT_KINDS, MemoryGrants, UI_IDLE_MS, UI_MAX_MS, coversSpace, isLive } from "./index.ts";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const SLOW = { timeout: 60_000 };
const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-11-13T08:00:00.000Z");
const at = (days: number) => new Date(T0.getTime() + days * DAY);

let root: ReturnType<typeof endpointRoot>;
beforeAll(() => {
  root = endpointRoot();
});
afterAll(() => {
  root.remove();
});

describe("[A2.3.6.local.grants] the grants table", () => {
  beforeEach(() => {
    vi.mocked(timingSafeEqual).mockClear();
  });

  test("one table holds a row of every kind, each with a stable gr_ ID", () => {
    const grants = new MemoryGrants();
    const ui = grants.create({ kind: "ui", principal: "user", attrs: { agent: "Firefox" } }, T0);
    const home = grants.create(
      {
        kind: "agent_home",
        principal: "user",
        spaces: ["sp_a"],
        attrs: { instance: "codex-work" },
      },
      T0,
    );
    const device = grants.create(
      { kind: "device", principal: "user", spaces: ["sp_a"], scopes: ["read"], expiresAt: at(90) },
      T0,
    );
    expect(
      grants
        .list()
        .map((g) => g.kind)
        .sort(),
    ).toEqual([...GRANT_KINDS].sort());
    expect(grants.list("agent_home")).toEqual([home.grant]);
    for (const { grant } of [ui, home, device]) {
      expect(grant.grant_id).toMatch(/^gr_[0-7][0-9a-hjkmnp-tv-z]{25}$/);
      expect(grants.get(grant.grant_id)).toEqual(grant);
    }
    expect(new Set(grants.list().map((g) => g.grant_id)).size).toBe(3);
    expect(home.grant).toMatchObject({
      token_hash: null,
      scopes: [],
      expires_at: null,
      revoked_at: null,
    });
    expect(home.token).toBeUndefined();
    expect(device.grant.expires_at).toBe(at(90).toISOString());
    expect(coversSpace(ui.grant, "sp_any")).toBe(true);
    expect(coversSpace(home.grant, "sp_a")).toBe(true);
    expect(coversSpace(home.grant, "sp_b")).toBe(false);
    expect(() => grants.create({ kind: "other" as "ui", principal: "user" })).toThrow(TypeError);
    expect(() => grants.create({ kind: "ui", principal: "" })).toThrow(TypeError);
  });

  test("a UI token is returned once and only its hash is stored", () => {
    const grants = new MemoryGrants();
    const { grant, token } = grants.create({ kind: "ui", principal: "user" }, T0);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(grant.token_hash).toBe(
      createHash("sha256")
        .update(token ?? "")
        .digest("hex"),
    );
    expect(JSON.stringify(grants.list())).not.toContain(token);
    expect(grants.findByToken(token ?? "", at(1))?.grant_id).toBe(grant.grant_id);
    expect(grants.findByToken(`${token ?? ""}x`, at(1))).toBeUndefined();
    expect(grants.findByToken("", at(1))).toBeUndefined();
  });

  test("a lookup compares the presented token with every row in constant time", () => {
    const grants = new MemoryGrants();
    const tokens = [1, 2, 3].map(
      () => grants.create({ kind: "ui", principal: "user" }, T0).token ?? "",
    );
    grants.create({ kind: "agent_home", principal: "user" }, T0);
    for (const token of tokens) {
      vi.mocked(timingSafeEqual).mockClear();
      expect(grants.findByToken(token, at(1))).toBeDefined();
      // Three rows with a token, three comparisons, whichever row matches.
      expect(vi.mocked(timingSafeEqual)).toHaveBeenCalledTimes(3);
    }
  });

  test("a UI grant expires 7 days after its last use and 30 days after creation at most", () => {
    const grants = new MemoryGrants();
    const { grant, token = "" } = grants.create({ kind: "ui", principal: "user" }, T0);
    expect(grant.expires_at).toBe(at(7).toISOString());
    expect(UI_IDLE_MS).toBe(7 * DAY);
    expect(UI_MAX_MS).toBe(30 * DAY);
    expect(grants.touch(grant.grant_id, at(6))?.expires_at).toBe(at(13).toISOString());
    expect(grants.touch(grant.grant_id, at(12))?.expires_at).toBe(at(19).toISOString());
    expect(grants.touch(grant.grant_id, at(18))?.expires_at).toBe(at(25).toISOString());
    const capped = grants.touch(grant.grant_id, at(24));
    expect(capped?.expires_at).toBe(at(30).toISOString());
    expect(capped?.last_used_at).toBe(at(24).toISOString());
    expect(grants.findByToken(token, at(29.9))).toBeDefined();
    expect(grants.findByToken(token, at(30))).toBeUndefined();
    expect(grants.touch(grant.grant_id, at(30))).toBeUndefined();

    const idle = grants.create({ kind: "ui", principal: "user" }, T0);
    expect(grants.findByToken(idle.token ?? "", at(7))).toBeUndefined();
    expect(isLive(idle.grant, at(6.9))).toBe(true);
  });

  test("revocation sets revoked_at, ends lookups and tells every listener once", () => {
    const grants = new MemoryGrants();
    const { grant, token = "" } = grants.create({ kind: "ui", principal: "user" }, T0);
    const heard: string[] = [];
    const stop = grants.onRevoke((id) => heard.push(id));
    grants.onRevoke(() => {
      throw new Error("a broken listener");
    });
    expect(grants.revoke(grant.grant_id, at(1))).toBe(true);
    expect(grants.get(grant.grant_id)?.revoked_at).toBe(at(1).toISOString());
    expect(grants.findByToken(token, at(1))).toBeUndefined();
    expect(grants.revoke(grant.grant_id, at(2))).toBe(false);
    expect(grants.revoke("gr_unknown")).toBe(false);
    expect(heard).toEqual([grant.grant_id]);
    stop();
    const other = grants.create({ kind: "agent_home", principal: "user" }, T0);
    grants.revoke(other.grant.grant_id);
    expect(heard).toEqual([grant.grant_id]);
  });

  test(
    "revoking a row closes every live connection that used it, and only those",
    SLOW,
    async () => {
      const grants = new MemoryGrants();
      const work = grants.create({
        kind: "agent_home",
        principal: "user",
        attrs: { instance: "codex-work" },
      });
      const life = grants.create({
        kind: "agent_home",
        principal: "user",
        attrs: { instance: "claude-life" },
      });
      const byInstance = new Map([
        ["codex-work", work.grant.grant_id],
        ["claude-life", life.grant.grant_id],
      ]);
      const started = await startServer(root, {
        grants,
        bind: (connection) => {
          const instance = connection.context["instance"];
          const grant = typeof instance === "string" ? byInstance.get(instance) : undefined;
          return grant === undefined ? {} : { grant };
        },
        mcp: (channel) => {
          channel.onLine = () => undefined;
        },
      });
      try {
        const open = (instance: string) =>
          openLines({
            path: started.path,
            key: started.key,
            client: clientInfo("bridge"),
            context: { instance },
          });
        const [a, b, c] = [
          await open("codex-work"),
          await open("codex-work"),
          await open("claude-life"),
        ];
        const cli = await openRpc({
          path: started.path,
          key: started.key,
          client: clientInfo(),
          context: {},
        });
        const closed: string[] = [];
        a.onClose = () => closed.push("a");
        b.onClose = () => closed.push("b");
        c.onClose = () => closed.push("c");
        cli.onClose = () => closed.push("cli");
        expect(started.server.connectionCount).toBe(4);

        grants.revoke(work.grant.grant_id);
        await until(() => closed.length === 2);
        expect(closed.sort()).toEqual(["a", "b"]);
        await until(() => started.server.connectionCount === 2);
        expect(started.events.filter((e) => e.ev === "local.revoked")).toHaveLength(2);
        expect(c.closed).toBe(false);
        expect(cli.closed).toBe(false);
        c.close();
        cli.close();
      } finally {
        await started.server.close();
      }
    },
  );

  test("a connection closed by a revocation dispatches nothing more", SLOW, async () => {
    const grants = new MemoryGrants();
    const row = grants.create({ kind: "agent_home", principal: "user" });
    const ran: string[] = [];
    const started = await startServer(root, {
      grants,
      bind: () => ({ grant: row.grant.grant_id }),
      handlers: {
        "op/call": (params) => {
          ran.push(String(params["n"]));
          // The first call revokes the row this connection holds, in the middle of a chunk.
          if (params["n"] === 1) grants.revoke(row.grant.grant_id);
          return "ok";
        },
      },
    });
    try {
      const connected = await connect({
        path: started.path,
        key: started.key,
        mode: "rpc",
        client: clientInfo(),
        context: {},
      });
      const closed = new Promise((resolve) => connected.socket.once("close", resolve));
      connected.socket.write(
        '{"jsonrpc":"2.0","id":1,"method":"op/call","params":{"n":1}}\n' +
          '{"jsonrpc":"2.0","id":2,"method":"op/call","params":{"n":2}}\n',
      );
      await closed;
      await until(() => started.server.connectionCount === 0);
      expect(ran).toEqual(["1"]);
    } finally {
      await started.server.close();
    }
  });

  test(
    "a grant revoked while its bind is answered, or never live, binds no connection",
    SLOW,
    async () => {
      const grants = new MemoryGrants();
      const soon = grants.create({ kind: "agent_home", principal: "user" });
      const slow = grants.create({ kind: "agent_home", principal: "user" });
      let release: () => void = () => undefined;
      const hookStarted = new Promise<void>((resolve) => {
        release = resolve;
      });
      let proceed: () => void = () => undefined;
      const started = await startServer(root, {
        grants,
        bind: async (connection) => {
          const which = connection.context["which"];
          if (which === "soon") {
            // Revoked after the hook decided, before the service acted on its answer.
            queueMicrotask(() => grants.revoke(soon.grant.grant_id));
            return { grant: soon.grant.grant_id };
          }
          if (which === "slow") {
            release();
            await new Promise<void>((resolve) => {
              proceed = resolve;
            });
            return { grant: slow.grant.grant_id };
          }
          return { grant: "gr_unknown" };
        },
        mcp: (channel) => {
          channel.onLine = () => undefined;
        },
      });
      try {
        const open = (which: string) =>
          openLines({
            path: started.path,
            key: started.key,
            client: clientInfo("bridge"),
            context: { which },
          }).then(
            (session) => {
              session.close();
              return "bound";
            },
            (error: unknown) => (error as { reason?: string }).reason,
          );
        expect(await open("soon")).toBe("connection_lost");
        const slowBind = open("slow");
        await hookStarted;
        grants.revoke(slow.grant.grant_id);
        proceed();
        expect(await slowBind).toBe("connection_lost");
        expect(await open("unknown")).toBe("connection_lost");
        expect(
          started.events.filter(
            (e) => e.ev === "local.handshake_failed" && e.reason === "grant_not_live",
          ),
        ).toHaveLength(3);
        expect(started.events.some((e) => e.ev === "local.bound")).toBe(false);
        await until(() => started.server.connectionCount === 0);
      } finally {
        await started.server.close();
      }
    },
  );
});
