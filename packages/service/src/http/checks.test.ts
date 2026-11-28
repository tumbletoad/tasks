// A2 3.8.3's request checks and A2 5's HTTP check matrix: every combination of Host, Origin,
// Sec-Fetch-Site, method, content type and token presence, on every kind of route, with the
// expected status. The server applies this function to every request before anything else
// (server.test.ts runs a slice of the same matrix over real sockets).
import { describe, expect, test } from "vitest";
import {
  checkRequest,
  isJson,
  repeatedHeader,
  type RequestFacts,
  type RouteTable,
} from "./checks.ts";
import { contentSecurityPolicy, newNonce, securityHeaders } from "./csp.ts";

const PORT = 7713;
const TABLE: RouteTable = {
  hasOp: (name) => name === "task.get" || name === "task.add",
  hasFile: (path) => path === "/assets/boot-0123abcd.js" || path === "/manifest.webmanifest",
};

const HOSTS = {
  ip: "127.0.0.1:7713",
  name: "localhost:7713",
  upper: "LOCALHOST:7713",
  rebinding: "attacker.example:7713",
  otherPort: "127.0.0.1:7714",
  bare: "127.0.0.1",
  ipv6: "[::1]:7713",
  missing: undefined,
} as const;
const ORIGINS = {
  none: undefined,
  own: "http://127.0.0.1:7713",
  ownName: "http://localhost:7713",
  otherPort: "http://127.0.0.1:7714",
  evil: "http://attacker.example",
  null: "null",
  https: "https://127.0.0.1:7713",
} as const;
const SITES = {
  none: undefined,
  same: "same-origin",
  direct: "none",
  sameSite: "same-site",
  cross: "cross-site",
} as const;
const METHODS = ["GET", "POST", "OPTIONS", "PUT", "HEAD", "DELETE"] as const;
const TYPES = {
  json: "application/json",
  jsonCharset: "application/json; charset=utf-8",
  text: "text/plain",
  form: "application/x-www-form-urlencoded",
  multipart: "multipart/form-data; boundary=x",
  missing: undefined,
} as const;
const PATHS = {
  root: "/",
  index: "/index.html",
  asset: "/assets/boot-0123abcd.js",
  healthz: "/healthz",
  wellKnown: "/.well-known/ttasks",
  probe: "/api/v1/auth/probe",
  redeem: "/api/v1/auth/redeem",
  ticket: "/api/v1/ws-ticket",
  ws: "/api/v1/ws",
  op: "/api/v1/op/task.get",
  unknownOp: "/api/v1/op/task.unknown",
  launch: "/api/v1/launch/list",
  unknownLaunch: "/api/v1/launch/open",
  space: "/api/v1/space/default",
  unknownSpace: "/api/v1/space/rename",
  machine: "/api/v1/machine/terminal",
  unknownMachine: "/api/v1/machine/name",
  apiOther: "/api/v1/nothing",
  other: "/nothing",
  // The page's own routes (A5 3.3) are the shell; a path of another shape is not.
  app: "/s/sp_0123456789abcdefghjkmnpqrs",
  appTask: "/s/sp_0123456789abcdefghjkmnpqrs/area/ar_1/project/pj_2",
  notApp: "/s/sp_0123456789abcdefghjkmnpqrs/area/ar_1/project/pj_2/x",
} as const;

interface Case {
  readonly host: keyof typeof HOSTS;
  readonly origin: keyof typeof ORIGINS;
  readonly site: keyof typeof SITES;
  readonly method: (typeof METHODS)[number];
  readonly type: keyof typeof TYPES;
  readonly bearer: boolean;
  readonly upgrade: boolean;
  readonly path: keyof typeof PATHS;
}

function facts(c: Case): RequestFacts {
  return {
    method: c.method,
    path: PATHS[c.path],
    host: HOSTS[c.host],
    origin: ORIGINS[c.origin],
    fetchSite: SITES[c.site],
    contentType: TYPES[c.type],
    bearer: c.bearer,
    upgrade: c.upgrade,
  };
}

function* everyCase(): Generator<Case> {
  for (const host of Object.keys(HOSTS) as (keyof typeof HOSTS)[])
    for (const origin of Object.keys(ORIGINS) as (keyof typeof ORIGINS)[])
      for (const site of Object.keys(SITES) as (keyof typeof SITES)[])
        for (const method of METHODS)
          for (const type of Object.keys(TYPES) as (keyof typeof TYPES)[])
            for (const bearer of [false, true])
              for (const upgrade of [false, true])
                for (const path of Object.keys(PATHS) as (keyof typeof PATHS)[])
                  yield { host, origin, site, method, type, bearer, upgrade, path };
}

const API = new Set([
  "probe",
  "redeem",
  "ticket",
  "ws",
  "op",
  "unknownOp",
  "launch",
  "unknownLaunch",
  "space",
  "unknownSpace",
  "machine",
  "unknownMachine",
  "apiOther",
]);
const GOOD_HOST = new Set(["ip", "name", "upper"]);
const GOOD_ORIGIN = new Set(["own", "ownName"]);
const JSON_TYPES = new Set(["json", "jsonCharset"]);

describe("[A2.3.8.http.matrix] the request checks", () => {
  test("every combination gets the status of the first rule it breaks, in A2's order", () => {
    let passed = 0;
    let total = 0;
    for (const c of everyCase()) {
      total += 1;
      const verdict = checkRequest(PORT, facts(c), TABLE);
      const status = verdict.ok ? 200 : verdict.status;
      const api = API.has(c.path);
      // The expected status, rule by rule, written apart from the implementation.
      let expected: number;
      if (!GOOD_HOST.has(c.host)) expected = 421;
      else if (c.method === "OPTIONS") expected = 403;
      else if (c.method === "POST" && !JSON_TYPES.has(c.type)) expected = 415;
      else if (api && (c.site === "sameSite" || c.site === "cross")) expected = 403;
      else if (c.origin !== "none" && !GOOD_ORIGIN.has(c.origin)) expected = 403;
      else if ((c.method !== "GET" || c.upgrade) && c.origin === "none" && c.path !== "probe")
        expected = 403;
      else if (
        c.path === "apiOther"
          ? c.method !== "GET" && c.method !== "POST"
          : [
                "probe",
                "redeem",
                "ticket",
                "op",
                "unknownOp",
                "launch",
                "unknownLaunch",
                "space",
                "unknownSpace",
                "machine",
                "unknownMachine",
              ].includes(c.path)
            ? c.method !== "POST"
            : c.method !== "GET"
      )
        expected = 405;
      else if (
        [
          "ticket",
          "op",
          "unknownOp",
          "launch",
          "unknownLaunch",
          "space",
          "unknownSpace",
          "machine",
          "unknownMachine",
          "apiOther",
        ].includes(c.path) &&
        !c.bearer
      )
        expected = 401;
      else if (c.path === "ws" && !c.upgrade) expected = 426;
      else if (c.path !== "ws" && c.upgrade) expected = 404;
      else if (
        [
          "apiOther",
          "other",
          "unknownOp",
          "unknownLaunch",
          "unknownSpace",
          "unknownMachine",
          "notApp",
        ].includes(c.path)
      )
        expected = 404;
      else expected = 200;
      if (status !== expected) {
        expect.fail(`${JSON.stringify(c)}: ${String(status)}, expected ${String(expected)}`);
      }
      if (verdict.ok) passed += 1;
    }
    expect(total).toBe(8 * 7 * 5 * 6 * 6 * 2 * 2 * 22);
    expect(passed).toBeGreaterThan(0);
  });

  test("nothing passes with a foreign Host, a cross-site API fetch, a foreign Origin or OPTIONS", () => {
    for (const c of everyCase()) {
      const verdict = checkRequest(PORT, facts(c), TABLE);
      if (!verdict.ok) continue;
      expect(GOOD_HOST.has(c.host)).toBe(true);
      expect(c.method).not.toBe("OPTIONS");
      expect(c.origin === "none" || GOOD_ORIGIN.has(c.origin)).toBe(true);
      if (API.has(c.path)) expect(["none", "same", "direct"]).toContain(c.site);
      // A request that may start work (any POST but the probe) always names our origin.
      if (c.method === "POST" && c.path !== "probe") expect(GOOD_ORIGIN.has(c.origin)).toBe(true);
      // Every API route but redeem, probe and the WebSocket's ticket-checked upgrade has a token.
      if (["ticket", "op", "launch", "space", "machine", "apiOther"].includes(c.path))
        expect(c.bearer).toBe(true);
      // The page's own routes are the shell: a GET without a body or a token.
      if (["app", "appTask"].includes(c.path)) expect(c.method).toBe("GET");
      if (c.upgrade) {
        expect(c.path).toBe("ws");
        expect(GOOD_ORIGIN.has(c.origin)).toBe(true);
      }
    }
  });

  test("DNS rebinding: any name resolved to 127.0.0.1 gets 421, whatever else the request holds", () => {
    for (const host of [
      "attacker.example:7713",
      "127.0.0.1.nip.io:7713",
      "localhost.attacker.example:7713",
      "127.0.0.2:7713",
      "0.0.0.0:7713",
      "127.1:7713",
      "2130706433:7713",
      "localhost:7713.attacker.example",
      "localhost",
      "",
    ]) {
      const verdict = checkRequest(
        PORT,
        {
          method: "POST",
          path: "/api/v1/op/task.get",
          host,
          origin: `http://${host}`,
          fetchSite: "same-origin",
          contentType: "application/json",
          bearer: true,
          upgrade: false,
        },
        TABLE,
      );
      expect(verdict).toMatchObject({ ok: false, status: 421, reason: "host" });
    }
  });

  test("cross-origin: a page on another loopback port or site cannot reach the API", () => {
    for (const origin of [
      "http://127.0.0.1:7714",
      "http://localhost:3000",
      "https://example.com",
    ]) {
      for (const path of ["/api/v1/op/task.get", "/api/v1/ws-ticket", "/api/v1/auth/redeem"]) {
        const verdict = checkRequest(
          PORT,
          {
            method: "POST",
            path,
            host: "127.0.0.1:7713",
            origin,
            fetchSite: "same-site",
            contentType: "application/json",
            bearer: true,
            upgrade: false,
          },
          TABLE,
        );
        expect(verdict.ok).toBe(false);
        expect(verdict.ok ? 0 : verdict.status).toBe(403);
      }
      const ws = checkRequest(
        PORT,
        {
          method: "GET",
          path: "/api/v1/ws",
          host: "127.0.0.1:7713",
          origin,
          fetchSite: undefined,
          contentType: undefined,
          bearer: false,
          upgrade: true,
        },
        TABLE,
      );
      expect(ws).toMatchObject({ ok: false, status: 403, reason: "origin" });
    }
  });

  test("the form comes first: HTTP/1.1 only, and no header the checks read sent twice", () => {
    const good = facts({
      host: "ip",
      origin: "own",
      site: "same",
      method: "POST",
      type: "json",
      bearer: true,
      upgrade: false,
      path: "op",
    });
    expect(checkRequest(PORT, { ...good, version: "1.1", repeated: false }, TABLE)).toEqual({
      ok: true,
      route: "op",
    });
    // Whatever else the request holds, a wrong form decides first.
    for (const host of [HOSTS.ip, HOSTS.rebinding, undefined]) {
      expect(checkRequest(PORT, { ...good, host, version: "1.0" }, TABLE)).toMatchObject({
        status: 505,
        reason: "version",
      });
      expect(checkRequest(PORT, { ...good, host, repeated: true }, TABLE)).toMatchObject({
        status: 400,
        reason: "repeated",
      });
    }
    expect(repeatedHeader(["Host", "a", "X-Other", "1", "x-other", "2"])).toBe(false);
    for (const name of ["Host", "Origin", "Authorization", "Content-Type", "Sec-Fetch-Site"]) {
      expect(repeatedHeader([name, "a", "Accept", "*/*", name.toUpperCase(), "b"])).toBe(true);
    }
  });

  test("JSON content types are recognised with parameters, and nothing else is", () => {
    expect(isJson("application/json")).toBe(true);
    expect(isJson("Application/JSON; charset=utf-8")).toBe(true);
    expect(isJson("application/json-patch+json")).toBe(false);
    expect(isJson("text/plain; application/json")).toBe(false);
    expect(isJson(undefined)).toBe(false);
  });
});

describe("[A2.3.8.http.csp] the response headers", () => {
  test("the CSP: a nonce only when asked, worker-src 'none', and nothing unsafe", () => {
    const nonce = newNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(newNonce()).not.toBe(nonce);
    const withNonce = contentSecurityPolicy(PORT, nonce);
    const without = contentSecurityPolicy(PORT);
    expect(withNonce).toContain(`style-src 'self' 'nonce-${nonce}'`);
    expect(without).toContain("style-src 'self';");
    expect(without).not.toContain("nonce");
    for (const policy of [withNonce, without]) {
      expect(policy).toContain("worker-src 'none'");
      expect(policy).toContain("script-src 'self';");
      expect(policy).toContain("require-trusted-types-for 'script'");
      expect(policy).toContain("connect-src 'self' ws://127.0.0.1:7713 ws://localhost:7713");
      expect(policy).toContain("frame-ancestors 'none'");
      expect(policy).not.toMatch(/unsafe-inline|unsafe-eval|wasm-unsafe-eval/);
    }
    expect(() => contentSecurityPolicy(PORT, "x'; script-src *")).toThrow();
  });

  test("every response carries the same security headers and never a CORS header", () => {
    const headers = securityHeaders(PORT);
    expect(headers).toMatchObject({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cache-Control": "no-store",
    });
    expect(securityHeaders(PORT, { cache: "immutable" })["Cache-Control"]).toContain("immutable");
    for (const name of Object.keys(headers))
      expect(name.toLowerCase()).not.toMatch(/^access-control/);
  });
});
