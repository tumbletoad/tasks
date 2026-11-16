// The UI listener over real sockets on ephemeral ports (A2 3.8.1, 3.8.3, 3.8.4; A2 5 "HTTP check
// matrix", "CSP", "DNS rebinding simulation"; A7 3.9 M2.12 "No response registers a service
// worker"). Node clients send exactly what a browser sends, and requests a browser never sends.
// The listener's own timers are virtual (test/clock.ts), so no test waits on wall-clock time.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import { testClock, type TestClock } from "../../test/clock.ts";
import { idle, post, raw, send, upgrade, upgradeHead, type Reply } from "../../test/http-client.ts";
import { openFeed } from "../../test/http-world.ts";
import { UI_IDLE_MS, UI_MAX_MS, type Grant } from "../local/index.ts";
import { HttpApp } from "./app.ts";
import { checkRequest } from "./checks.ts";
import type { HttpEvent } from "./events.ts";
import { DurableGrants } from "./grants.ts";
import { DEFAULT_HTTP_LIMITS, type HttpLimits } from "./limits.ts";
import { listenHttp, type HttpListener } from "./listener.ts";
import { builtinUi } from "./page.ts";
import type { ServiceDb } from "./service-db.ts";
import type { HttpTimerKind } from "./timers.ts";

const SLOW = { timeout: 120_000 };
const KEY = new Uint8Array(32).fill(3);
const INSTANCE = "0123456789abcdef0123456789abcdef";
const BUILD = { version: "0.0.0", build: "source" };
const DAY = 24 * 60 * 60 * 1000;

/** A grants table on a database that keeps nothing: the listener's own behaviour is under test. */
async function memoryGrants(): Promise<DurableGrants> {
  const db = {
    grants: () => Promise.resolve([] as Grant[]),
    dropGrants: () => Promise.resolve(),
    putGrants: () => Promise.resolve(),
  } as unknown as ServiceDb;
  return DurableGrants.open(db);
}

interface Served {
  readonly app: HttpApp;
  readonly listener: HttpListener;
  readonly port: number;
  readonly events: HttpEvent[];
  readonly clock: TestClock<HttpTimerKind>;
  readonly grants: DurableGrants;
  /** The app's clock in ms, moved by tests. */
  now: number;
  close(): Promise<void>;
}

const open: Served[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
});

async function serve(
  options: {
    limits?: Partial<HttpLimits>;
    peer?: () => boolean;
    redeem?: () => boolean;
    installed?: () => string | undefined;
  } = {},
): Promise<Served> {
  const events: HttpEvent[] = [];
  const clock = testClock<HttpTimerKind>({ virtual: "all" });
  const grants = await memoryGrants();
  const state = { now: Date.parse("2026-11-14T08:00:00.000Z") };
  const app = new HttpApp({
    key: KEY,
    instance: INSTANCE,
    build: BUILD,
    grants,
    ops: { machine: { id: "mc_test" }, spaces: () => [] },
    ui: builtinUi(BUILD),
    log: (event) => events.push(event),
    limits: { ...DEFAULT_HTTP_LIMITS, ...options.limits },
    now: () => state.now,
    timers: clock.timers,
    redeemCheck: options.redeem ?? (() => true),
    ...(options.installed === undefined ? {} : { installed: options.installed }),
  });
  const listener = await listenHttp(app, 0, options.peer ?? (() => true));
  const served: Served = {
    app,
    listener,
    port: listener.port,
    events,
    clock,
    grants,
    get now() {
      return state.now;
    },
    set now(value: number) {
      state.now = value;
    },
    close: async () => {
      app.closeAll();
      await listener.close();
    },
  };
  open.push(served);
  return served;
}

/** A token, through the real redeem path. */
async function signIn(s: Served): Promise<string> {
  const reply = await post(s.port, "/api/v1/auth/redeem", { code: s.app.mintCode() });
  expect(reply.status).toBe(200);
  return (JSON.parse(reply.body) as { token: string }).token;
}

const csp = (reply: Reply): string => String(reply.headers["content-security-policy"] ?? "");

describe("[A2.3.8.http.listener] the UI listener", () => {
  test(
    "the shell: a fresh nonce per response, repeated in its meta tag, and every script carries its integrity hash",
    SLOW,
    async () => {
      const s = await serve();
      const first = await send(s.port, { path: "/" });
      const second = await send(s.port, { path: "/index.html" });
      const nonceOf = (reply: Reply) => /'nonce-([^']+)'/.exec(csp(reply))?.[1];
      const n1 = nonceOf(first);
      const n2 = nonceOf(second);
      expect(first.status).toBe(200);
      expect(n1).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      expect(n2).not.toBe(n1);
      expect(first.body).toContain(`<meta name="csp-nonce" content="${n1 ?? ""}">`);
      expect(first.body).toContain(`<style nonce="${n1 ?? ""}">`);
      expect(first.body).not.toContain("__TASKS_NONCE__");
      expect(first.headers["cache-control"]).toBe("no-store");
      expect(first.headers["content-type"]).toBe("text/html; charset=utf-8");
      // No inline script: every script is a file with an integrity hash that matches it.
      const scripts = [...first.body.matchAll(/<script([^>]*)>([^<]*)<\/script>/g)];
      expect(scripts.length).toBeGreaterThan(0);
      for (const [, attrs = "", inline = ""] of scripts) {
        expect(inline).toBe("");
        const src = /src="([^"]+)"/.exec(attrs)?.[1] ?? "";
        const integrity = /integrity="([^"]+)"/.exec(attrs)?.[1] ?? "";
        const file = await send(s.port, { path: src });
        expect(file.status).toBe(200);
        expect(file.headers["cache-control"]).toContain("immutable");
        expect(file.headers["content-security-policy"]).not.toContain("nonce");
        // v1 registers no service worker (A2 3.8.6): the shell never asks for one.
        expect(file.body).not.toContain("serviceWorker");
        const digest = createHash("sha384").update(file.body, "utf8").digest("base64");
        expect(integrity).toBe(`sha384-${digest}`);
      }
    },
  );

  test(
    "every response, errors included, carries the policy with worker-src 'none' and never a CORS header",
    SLOW,
    async () => {
      const s = await serve();
      const token = await signIn(s);
      const replies = [
        await send(s.port, { path: "/" }),
        await send(s.port, { path: "/healthz" }),
        await send(s.port, { path: "/.well-known/tasks" }),
        await send(s.port, { path: "/nothing" }),
        await send(s.port, { path: "/", headers: { host: "attacker.example:7713" } }),
        await send(s.port, { method: "OPTIONS", path: "/api/v1/op/task.get" }),
        await send(s.port, {
          method: "PUT",
          path: "/",
          headers: { origin: `http://127.0.0.1:${String(s.port)}` },
        }),
        await post(s.port, "/api/v1/op/task.get", {}),
        await post(
          s.port,
          "/api/v1/op/task.get",
          {},
          { token, headers: { "content-type": "text/plain" } },
        ),
        await post(s.port, "/api/v1/op/task.get", { task: "M-1" }, { token }),
        await post(
          s.port,
          "/api/v1/auth/probe",
          { nonce: "n".repeat(22) },
          { headers: { origin: null } },
        ),
      ];
      expect(replies.map((r) => r.status)).toEqual([
        200, 200, 200, 404, 421, 403, 405, 401, 415, 503, 200,
      ]);
      for (const reply of replies) {
        expect(csp(reply)).toContain("worker-src 'none'");
        expect(csp(reply)).toContain("script-src 'self';");
        expect(csp(reply)).not.toMatch(/unsafe/);
        expect(reply.headers["x-content-type-options"]).toBe("nosniff");
        expect(reply.headers["referrer-policy"]).toBe("no-referrer");
        expect(reply.headers["cross-origin-opener-policy"]).toBe("same-origin");
        expect(reply.headers["service-worker-allowed"]).toBeUndefined();
        for (const name of Object.keys(reply.headers)) expect(name).not.toMatch(/^access-control-/);
      }
      // A parser-level refusal (a malformed request) is answered with the same headers.
      const bad = await raw(s.port, "NOT A REQUEST\r\n\r\n");
      expect(bad).toMatch(/^HTTP\/1\.1 400/);
      expect(bad).toContain("worker-src 'none'");
      expect(JSON.parse((await send(s.port, { path: "/.well-known/tasks" })).body)).toEqual({
        app: "tasks",
        protocol: 1,
      });
    },
  );

  test(
    "no answer of Node's or ws's own skips the checks or the headers: Host, Expect, the handshake, the 101",
    SLOW,
    async () => {
      const s = await serve();
      const host = `127.0.0.1:${String(s.port)}`;
      const headed = (text: string) => {
        expect(text).toContain("worker-src 'none'");
        expect(text.toLowerCase()).toContain("x-content-type-options: nosniff");
      };
      // HTTP/1.1 without a Host: the Host check's 421, not a bare 400.
      const noHost = await raw(s.port, "GET / HTTP/1.1\r\nConnection: close\r\n\r\n");
      expect(noHost).toMatch(/^HTTP\/1\.1 421 /);
      headed(noHost);
      // A client waiting for 100 Continue from a foreign Host: the 421, and no 100 before it.
      const probe = '{"nonce":"abcdefghijklmnopqrstuv"}';
      const waiting = (h: string) =>
        raw(
          s.port,
          `POST /api/v1/auth/probe HTTP/1.1\r\nHost: ${h}\r\nContent-Type: application/json\r\n` +
            `Content-Length: ${String(probe.length)}\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n${probe}`,
        );
      const foreign = await waiting("attacker.example");
      expect(foreign).toMatch(/^HTTP\/1\.1 421 /);
      expect(foreign).not.toContain("100 Continue");
      // The same from the listener's own Host: 100 Continue once the checks passed, then the proof.
      const own = await waiting(host);
      expect(own).toMatch(/^HTTP\/1\.1 100 Continue\r\n\r\nHTTP\/1\.1 200 /);
      // An expectation the listener does not meet: 417, with the headers.
      const odd = await raw(
        s.port,
        `GET / HTTP/1.1\r\nHost: ${host}\r\nExpect: a-thing\r\nConnection: close\r\n\r\n`,
      );
      expect(odd).toMatch(/^HTTP\/1\.1 417 /);
      headed(odd);
      // A handshake ws would refuse: 400 with the headers, and the ticket is not spent by it.
      const token = await signIn(s);
      const { ticket } = JSON.parse(
        (await post(s.port, "/api/v1/ws-ticket", {}, { token })).body,
      ) as {
        ticket: string;
      };
      for (const bad of [
        { "sec-websocket-key": "not-a-key" },
        { "sec-websocket-key": null },
        { "sec-websocket-version": "8" },
        { "sec-websocket-protocol": "chat" },
      ]) {
        const refused = await upgradeHead(s.port, `/api/v1/ws?ticket=${ticket}`, bad);
        expect(refused).toMatch(/^HTTP\/1\.1 400 /);
        headed(refused);
      }
      // The 101 carries them too.
      const switched = await upgradeHead(s.port, `/api/v1/ws?ticket=${ticket}`);
      expect(switched).toMatch(/^HTTP\/1\.1 101 /);
      headed(switched);
    },
  );

  test(
    "one Host, one Origin, one token, one type, HTTP/1.1: a repeat or another version is refused",
    SLOW,
    async () => {
      const s = await serve();
      const token = await signIn(s);
      const host = `127.0.0.1:${String(s.port)}`;
      const origin = `http://${host}`;
      const ask = (lines: string[], version = "1.1", path = "/api/v1/ws-ticket") =>
        raw(
          s.port,
          [
            `POST ${path} HTTP/${version}`,
            ...lines,
            "Content-Length: 2",
            "Connection: close",
            "",
            "{}",
          ].join("\r\n"),
        );
      const good = [
        `Host: ${host}`,
        `Origin: ${origin}`,
        "Content-Type: application/json",
        `Authorization: Bearer ${token}`,
      ];
      expect(await ask(good)).toMatch(/^HTTP\/1\.1 200 /);
      for (const extra of [
        "Host: attacker.example",
        `Origin: ${origin}`,
        "Content-Type: text/plain",
        "Authorization: Bearer tasks_u_x",
        "Sec-Fetch-Site: cross-site\r\nSec-Fetch-Site: same-origin",
      ]) {
        const reply = await ask([...good, extra]);
        expect(reply, extra).toMatch(/^HTTP\/1\.1 400 /);
        expect(reply).toContain("worker-src 'none'");
      }
      expect(await ask(good, "1.0")).toMatch(/^HTTP\/1\.1 505 /);
      expect(await raw(s.port, `GET /healthz HTTP/1.0\r\nHost: ${host}\r\n\r\n`)).toMatch(
        /^HTTP\/1\.1 505 /,
      );
    },
  );

  test(
    "the check matrix over real sockets: every refusal the checks decide is the status the listener answers",
    SLOW,
    async () => {
      const s = await serve();
      const token = await signIn(s);
      const port = s.port;
      const hosts = [
        `127.0.0.1:${String(port)}`,
        `localhost:${String(port)}`,
        "attacker.example",
        `127.0.0.1:${String(port + 1)}`,
      ];
      const origins = [
        undefined,
        `http://127.0.0.1:${String(port)}`,
        `http://127.0.0.1:${String(port + 1)}`,
        "null",
      ];
      const sites = [undefined, "same-origin", "cross-site"];
      const methods = ["GET", "POST", "OPTIONS", "DELETE"];
      const types = ["application/json", "text/plain"];
      const paths = [
        "/",
        "/api/v1/op/task.get",
        "/api/v1/ws-ticket",
        "/api/v1/auth/redeem",
        "/api/v1/nothing",
        "/healthz",
      ];
      let checked = 0;
      for (const host of hosts)
        for (const origin of origins)
          for (const site of sites)
            for (const method of methods)
              for (const type of types)
                for (const path of paths)
                  for (const bearer of [false, true]) {
                    if (method !== "POST" && type !== "application/json") continue;
                    const headers: Record<string, string | null> = {
                      host,
                      ...(origin === undefined ? {} : { origin }),
                      ...(site === undefined ? {} : { "sec-fetch-site": site }),
                      ...(method === "POST" ? { "content-type": type } : {}),
                      ...(bearer ? { authorization: `Bearer ${token}` } : {}),
                    };
                    const verdict = checkRequest(
                      port,
                      {
                        method,
                        path,
                        host,
                        origin,
                        fetchSite: site,
                        contentType: method === "POST" ? type : undefined,
                        bearer,
                        upgrade: false,
                      },
                      { hasOp: (n) => n === "task.get", hasFile: () => false },
                    );
                    const reply = await send(port, {
                      method,
                      path,
                      headers,
                      ...(method === "POST" ? { body: "{}" } : {}),
                    });
                    if (!verdict.ok) {
                      expect(reply.status, `${method} ${path} ${JSON.stringify(headers)}`).toBe(
                        verdict.status,
                      );
                    } else {
                      // Passed the checks: never a check's status.
                      expect([421, 405, 415, 426]).not.toContain(reply.status);
                    }
                    checked += 1;
                  }
      expect(checked).toBeGreaterThan(1000);
    },
  );

  test(
    "DNS rebinding: names that resolve to 127.0.0.1 get 421 on every path, the probe and redeem included",
    SLOW,
    async () => {
      const s = await serve();
      for (const host of [
        "attacker.example",
        `attacker.example:${String(s.port)}`,
        `127.0.0.1.nip.io:${String(s.port)}`,
      ]) {
        for (const path of [
          "/",
          "/api/v1/auth/probe",
          "/api/v1/auth/redeem",
          "/api/v1/op/task.get",
        ]) {
          const get = path === "/";
          const reply = await send(s.port, {
            method: get ? "GET" : "POST",
            path,
            headers: { host, origin: `http://${host}`, "content-type": "application/json" },
            ...(get ? {} : { body: "{}" }),
          });
          expect(reply.status).toBe(421);
        }
        expect(
          await upgrade(s.port, "/api/v1/ws?ticket=x", { host, origin: `http://${host}` }),
        ).toMatch(/ 421 /);
      }
    },
  );

  test(
    "cross-origin: another loopback port's page cannot call the API, preflight, or open the WebSocket",
    SLOW,
    async () => {
      const s = await serve();
      const token = await signIn(s);
      const ticket = JSON.parse((await post(s.port, "/api/v1/ws-ticket", {}, { token })).body) as {
        ticket: string;
      };
      const foreign = `http://127.0.0.1:${String(s.port + 1)}`;
      const preflight = await send(s.port, {
        method: "OPTIONS",
        path: "/api/v1/op/task.get",
        headers: {
          origin: foreign,
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization, content-type",
          "sec-fetch-site": "same-site",
        },
      });
      expect(preflight.status).toBe(403);
      expect(Object.keys(preflight.headers).some((h) => h.startsWith("access-control"))).toBe(
        false,
      );
      for (const path of ["/api/v1/op/task.get", "/api/v1/ws-ticket", "/api/v1/auth/redeem"]) {
        const reply = await post(
          s.port,
          path,
          {},
          { token, headers: { origin: foreign, "sec-fetch-site": "same-site" } },
        );
        expect(reply.status).toBe(403);
        // A form post from anywhere: refused before anything reads it.
        const form = await post(
          s.port,
          path,
          {},
          { headers: { "content-type": "application/x-www-form-urlencoded" } },
        );
        expect(form.status).toBe(415);
      }
      expect(
        await upgrade(s.port, `/api/v1/ws?ticket=${ticket.ticket}`, { origin: foreign }),
      ).toMatch(/ 403 /);
      expect(
        await upgrade(s.port, `/api/v1/ws?ticket=${ticket.ticket}`, {
          "sec-fetch-site": "cross-site",
        }),
      ).toMatch(/ 403 /);
      // The foreign attempts did not spend the ticket: the page's own upgrade still works once.
      expect(await upgrade(s.port, `/api/v1/ws?ticket=${ticket.ticket}`)).toMatch(/ 101 /);
      expect(await upgrade(s.port, `/api/v1/ws?ticket=${ticket.ticket}`)).toMatch(/ 401 /);
      expect(await upgrade(s.port, "/api/v1/ws")).toMatch(/ 401 /);
    },
  );

  test(
    "the token hand-over: probe, redeem once, ticket once, a stale build, and limits per minute",
    SLOW,
    async () => {
      const s = await serve();
      // The probe answers without an Origin (tasks open is Node), with the HMAC over its port.
      const probe = await post(
        s.port,
        "/api/v1/auth/probe",
        { nonce: "abcdefghijklmnopqrstuv" },
        { headers: { origin: null, "sec-fetch-site": null } },
      );
      expect(probe.status).toBe(200);
      const { verifyProbe } = await import("./auth.ts");
      expect(
        verifyProbe(
          KEY,
          INSTANCE,
          s.port,
          "abcdefghijklmnopqrstuv",
          (JSON.parse(probe.body) as { proof: string }).proof,
        ),
      ).toBe(true);
      expect(
        (
          await post(
            s.port,
            "/api/v1/auth/probe",
            { nonce: "short" },
            { headers: { origin: null } },
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await post(
            s.port,
            "/api/v1/auth/probe",
            {},
            { headers: { origin: "http://attacker.example" } },
          )
        ).status,
      ).toBe(403);
      // A code redeems once; a spent, expired or made-up one is 401.
      const code = s.app.mintCode();
      const redeemed = await post(s.port, "/api/v1/auth/redeem", { code });
      expect(redeemed.status).toBe(200);
      const body = JSON.parse(redeemed.body) as { token: string; session_id: string };
      expect(body.token).toMatch(/^tasks_u_[A-Za-z0-9_-]{43}$/);
      expect(body.session_id).toMatch(/^gr_/);
      expect((await post(s.port, "/api/v1/auth/redeem", { code })).status).toBe(401);
      const late = s.app.mintCode();
      s.now += 60_000;
      expect((await post(s.port, "/api/v1/auth/redeem", { code: late })).status).toBe(401);
      // Redeem needs the page's Origin.
      expect(
        (
          await post(
            s.port,
            "/api/v1/auth/redeem",
            { code: s.app.mintCode() },
            { headers: { origin: null } },
          )
        ).status,
      ).toBe(403);
      // The token works; a build the service does not have is told to reload.
      const ticket = await post(s.port, "/api/v1/ws-ticket", {}, { token: body.token });
      expect(ticket.status).toBe(200);
      const stale = await post(
        s.port,
        "/api/v1/ws-ticket",
        {},
        { token: body.token, headers: { "tasks-build": "older" } },
      );
      expect(stale.status).toBe(409);
      expect(JSON.parse(stale.body)).toMatchObject({ error: { data: { reason: "build" } } });
      // A token one character off (a character it does not end in) is no token.
      const off = `${body.token.slice(0, -1)}${body.token.endsWith("A") ? "B" : "A"}`;
      expect(off).not.toBe(body.token);
      expect((await post(s.port, "/api/v1/ws-ticket", {}, { token: off })).status).toBe(401);
      // 10 redemptions a minute for the whole service, then 429 until the minute is over.
      s.now += 61_000;
      const statuses: number[] = [];
      for (let i = 0; i < 11; i += 1)
        statuses.push((await post(s.port, "/api/v1/auth/redeem", { code: "x" })).status);
      expect(statuses.slice(0, 10).every((st) => st === 401)).toBe(true);
      expect(statuses[10]).toBe(429);
      s.now += 60_000;
      expect((await post(s.port, "/api/v1/auth/redeem", { code: "x" })).status).toBe(401);
      // 60 probes a minute.
      const probes: number[] = [];
      for (let i = 0; i < 61; i += 1)
        probes.push(
          (
            await post(
              s.port,
              "/api/v1/auth/probe",
              { nonce: "abcdefghijklmnopqrstuv" },
              { headers: { origin: null } },
            )
          ).status,
        );
      expect(probes.filter((st) => st === 200)).toHaveLength(60);
      expect(probes[60]).toBe(429);
    },
  );

  test("a revoked token is refused at once and its live connections close", SLOW, async () => {
    const s = await serve();
    const token = await signIn(s);
    const grant = s.grants.list("ui")[0];
    expect((await post(s.port, "/api/v1/ws-ticket", {}, { token })).status).toBe(200);
    s.grants.revoke(grant?.grant_id ?? "", new Date(s.now));
    expect((await post(s.port, "/api/v1/ws-ticket", {}, { token })).status).toBe(401);
  });

  test(
    "an open feed ends with its token: 7 days unused, or 30 days after creation, closes it with 4401",
    SLOW,
    async () => {
      const s = await serve();
      const tick = () => {
        for (const t of s.clock.live({ kind: "ws_ping" })) s.clock.fire(t);
      };
      // 7 days without a use: the feed's own traffic is no use of the token.
      const idleToken = await signIn(s);
      const idleFeed = await openFeed(s.port, idleToken);
      await idleFeed.next();
      s.now += UI_IDLE_MS - 1;
      tick();
      expect(s.app.feed.size).toBe(1);
      s.now += 1;
      tick();
      expect(await idleFeed.closed).toBe(4401);
      expect((await post(s.port, "/api/v1/ws-ticket", {}, { token: idleToken })).status).toBe(401);
      // Used every few days, a token still ends 30 days after its creation, and its feed with it.
      const usedToken = await signIn(s);
      const created = s.now;
      const usedFeed = await openFeed(s.port, usedToken);
      await usedFeed.next();
      while (s.now + 5 * DAY < created + UI_MAX_MS) {
        s.now += 5 * DAY;
        expect((await post(s.port, "/api/v1/ws-ticket", {}, { token: usedToken })).status).toBe(
          200,
        );
      }
      s.now = created + UI_MAX_MS - 1;
      tick();
      expect(s.app.feed.size).toBe(1);
      s.now += 1;
      tick();
      expect(await usedFeed.closed).toBe(4401);
      expect(s.events).toContainEqual(
        expect.objectContaining({ ev: "http.ws_closed", reason: "expired" }),
      );
    },
  );

  test(
    "bounds: body size, header size, connections unauthenticated, in all and per token, and the idle deadline",
    SLOW,
    async () => {
      const s = await serve({
        limits: {
          maxBodyBytes: 1024,
          maxUnauthenticated: 3,
          maxConnections: 6,
          maxPerToken: 2,
          maxHeaderBytes: 2048,
        },
      });
      const token = await signIn(s);
      expect(
        (await post(s.port, "/api/v1/ws-ticket", { pad: "x".repeat(2000) }, { token })).status,
      ).toBe(413);
      expect(
        (
          await post(
            s.port,
            "/api/v1/auth/probe",
            { pad: "x".repeat(2000) },
            { headers: { origin: null } },
          )
        ).status,
      ).toBe(413);
      const big = await raw(
        s.port,
        `GET / HTTP/1.1\r\nHost: 127.0.0.1:${String(s.port)}\r\nX-Pad: ${"y".repeat(4096)}\r\n\r\n`,
      );
      expect(big).toMatch(/^HTTP\/1\.1 431/);
      // Three silent connections are what may wait; the fourth is closed with no byte.
      const silent = [idle(s.port), idle(s.port), idle(s.port)];
      await expect.poll(() => s.app.connectionCount, { timeout: 30_000 }).toBe(3);
      const fourth = idle(s.port);
      expect(await fourth.closed).toBe("");
      expect(s.events).toContainEqual({ ev: "http.capacity", kind: "unauthenticated" });
      // Their idle deadline: each is closed when its timer fires, before any request arrived.
      const timers = s.clock.live({ kind: "idle" });
      expect(timers.length).toBeGreaterThanOrEqual(3);
      for (const timer of timers) {
        expect(timer.ms).toBe(DEFAULT_HTTP_LIMITS.headersMs);
        s.clock.fire(timer);
      }
      for (const c of silent) expect(await c.closed).toBe("");
      await expect.poll(() => s.app.connectionCount, { timeout: 30_000 }).toBe(0);
      // Node's own deadlines are the configured ones (A2 3.8.1).
      expect(s.listener.deadlines).toEqual({
        headersMs: 10_000,
        requestMs: 30_000,
        keepAliveMs: 5_000,
      });
    },
  );

  test("bounds: connections per token, and connections in all, are capped", SLOW, async () => {
    const s = await serve({ limits: { maxPerToken: 2, maxConnections: 4 } });
    const first = await signIn(s);
    const second = await signIn(s);
    // Two feeds hold two connections of the first token: a third request of it is refused.
    const feeds = [await openFeed(s.port, first), await openFeed(s.port, first)];
    await expect.poll(() => s.app.connectionCount, { timeout: 30_000 }).toBe(2);
    const third = await post(s.port, "/api/v1/ws-ticket", {}, { token: first });
    expect(third.status).toBe(503);
    expect(JSON.parse(third.body)).toMatchObject({ error: { data: { reason: "capacity" } } });
    expect(s.events).toContainEqual({ ev: "http.capacity", kind: "token" });
    // Another token still gets in: three connections in all, then one more waits.
    feeds.push(await openFeed(s.port, second));
    await expect.poll(() => s.app.connectionCount, { timeout: 30_000 }).toBe(3);
    const fourth = idle(s.port);
    await expect.poll(() => s.app.connectionCount, { timeout: 30_000 }).toBe(4);
    // The fifth is closed at once, before any byte.
    const fifth = idle(s.port);
    expect(await fifth.closed).toBe("");
    expect(s.events).toContainEqual({ ev: "http.capacity", kind: "total" });
    fourth.socket.destroy();
    for (const feed of feeds) feed.ws.close();
  });

  test(
    "a peer that is not this user is closed before any byte is read or answered",
    SLOW,
    async () => {
      const s = await serve({ peer: () => false });
      const answer = await raw(
        s.port,
        `GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:${String(s.port)}\r\n\r\n`,
      );
      expect(answer).toBe("");
      expect(s.events).toContainEqual({ ev: "http.peer_refused", reason: "other_user" });
      expect(s.events.some((e) => e.ev === "http.request")).toBe(false);
    },
  );

  test(
    "macOS's redeem check: a code redeemed by another user's socket is refused and not spent",
    SLOW,
    async () => {
      let mine = false;
      const s = await serve({ redeem: () => mine });
      const code = s.app.mintCode();
      expect((await post(s.port, "/api/v1/auth/redeem", { code })).status).toBe(403);
      mine = true;
      expect((await post(s.port, "/api/v1/auth/redeem", { code })).status).toBe(200);
    },
  );

  test(
    "blocked: the listener serves nothing at all, every UI token is revoked, every connection closed",
    SLOW,
    async () => {
      const s = await serve();
      const token = await signIn(s);
      const waiting = idle(s.port);
      // The silent connection is admitted when its idle deadline starts.
      await expect.poll(() => s.clock.live({ kind: "idle" }).length, { timeout: 30_000 }).toBe(1);
      expect(s.app.block()).toBe(1);
      expect(await waiting.closed).toBe("");
      expect(s.grants.list("ui").every((g) => g.revoked_at !== null)).toBe(true);
      expect(s.grants.findByToken(token, new Date(s.now))).toBeUndefined();
      // Every new connection is closed before a byte is read or answered.
      for (const path of ["/", "/healthz"]) {
        expect(
          await raw(s.port, `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${String(s.port)}\r\n\r\n`),
        ).toBe("");
      }
      expect(() => s.app.mintCode()).toThrow();
    },
  );

  test("no token, code, ticket, nonce or path reaches the listener's events", SLOW, async () => {
    const s = await serve();
    const code = s.app.mintCode();
    const redeemed = JSON.parse((await post(s.port, "/api/v1/auth/redeem", { code })).body) as {
      token: string;
    };
    const ticket = JSON.parse(
      (await post(s.port, "/api/v1/ws-ticket", {}, { token: redeemed.token })).body,
    ) as { ticket: string };
    await upgrade(s.port, `/api/v1/ws?ticket=${ticket.ticket}`);
    await send(s.port, { path: "/secret-path-fixture-1" });
    await post(
      s.port,
      "/api/v1/op/task.add",
      { tasks: [{ title: "Fixture title for the log test" }] },
      { token: redeemed.token },
    );
    const text = JSON.stringify(s.events);
    for (const secret of [
      code,
      redeemed.token,
      ticket.ticket,
      "secret-path-fixture-1",
      "Fixture title",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(
      s.events.some((e) => e.ev === "http.request" && e.route === "op" && e.entry === "task.add"),
    ).toBe(true);
  });
});

describe("[A2.3.8.http.installed] the feed tells the page when another version is installed", () => {
  test(
    "hello names the installed version when it is not the service's own, and a heartbeat names a change once",
    SLOW,
    async () => {
      let installed: string | undefined = "0.2.0";
      const s = await serve({ installed: () => installed });
      const tick = () => {
        for (const t of s.clock.live({ kind: "ws_ping" })) s.clock.fire(t);
      };
      const first = await openFeed(s.port, await signIn(s));
      expect(await first.next()).toEqual({
        type: "hello",
        protocol: 1,
        version: BUILD.version,
        build: BUILD.build,
        installed: "0.2.0",
      });
      // Another install while the page is open: its next heartbeat says so.
      installed = "0.3.0";
      tick();
      expect(await first.next()).toEqual({ type: "installed", version: "0.3.0" });
      first.ws.close();
      await first.closed;
      await expect.poll(() => s.app.feed.size, { timeout: 30_000 }).toBe(0);

      // A rollback to the service's own version: the page hears that there is none any more.
      const second = await openFeed(s.port, await signIn(s));
      expect(await second.next()).toMatchObject({ type: "hello", installed: "0.3.0" });
      installed = undefined;
      tick();
      expect(await second.next()).toEqual({ type: "installed" });
      expect(second.messages.filter((m) => m["type"] === "installed")).toHaveLength(1);
      second.ws.close();
    },
  );

  test("without an installed version the hello names none", SLOW, async () => {
    const s = await serve();
    const feed = await openFeed(s.port, await signIn(s));
    expect(await feed.next()).not.toHaveProperty("installed");
    feed.ws.close();
  });
});
