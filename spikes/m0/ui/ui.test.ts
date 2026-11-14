// The spike page self-test (step M0.08). It builds the page with Vite into a temporary folder,
// serves it from the stand-in service and checks without a browser what can be checked: the
// response headers and the CSP, that every asset is same-origin, carries an integrity hash that
// matches and loads under the policy, that the fonts are served as WOFF2 from this origin, that
// no service worker file exists, the size budgets of A5 3.25, the browser code's own typecheck,
// and the result files the lab runner writes. No browser runs here: Playwright is not in the
// workspace, and the e2e setup is a later step.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { UI_NONCE_PLACEHOLDER, startService, type RunningService } from "../kit/service.ts";
import { buildUi } from "./build.ts";
import { browserArgs, openUrl, waitForReport, writeResults } from "./lab.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

let work: string;
let dist: string;
let service: RunningService;
let origin: string;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "tasks-ui-"));
  dist = (await buildUi(join(work, "dist"))).out;
  service = await startService({ state: join(work, "state"), ui: dist, socketDir: "state" });
  origin = `http://127.0.0.1:${String(service.info.http.port)}`;
}, 180_000);

afterAll(async () => {
  await service.close();
  rmSync(work, { recursive: true, force: true });
});

async function signIn(): Promise<string> {
  const url = await openUrl(join(work, "state"), "?measure=u07");
  const code = new URL(url).hash.replace("#k=", "");
  const res = await fetch(`${origin}/api/v1/auth/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ code }),
  });
  return ((await res.json()) as { token: string }).token;
}

const sriOf = (bytes: Buffer) => `sha384-${createHash("sha384").update(bytes).digest("base64")}`;

describe("[A7.3.7.m0-ui.self-test] the M0 spike page", () => {
  test("the page is served with the strict CSP of A2 3.8.3 and a fresh nonce in header and meta", async () => {
    const first = await fetch(`${origin}/`);
    const second = await fetch(`${origin}/`);
    expect(first.status).toBe(200);
    const csp = first.headers.get("content-security-policy") ?? "";
    for (const directive of [
      "default-src 'self'",
      "script-src 'self'",
      "img-src 'self' data:",
      "worker-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "object-src 'none'",
      "require-trusted-types-for 'script'",
      `connect-src 'self' ws://127.0.0.1:${String(service.info.http.port)} ws://localhost:${String(service.info.http.port)}`,
    ]) {
      expect(csp).toContain(directive);
    }
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|wasm-unsafe-eval|font-src/);
    const nonce = /style-src 'self' 'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
    expect(nonce).toBeDefined();
    expect(Buffer.from(nonce ?? "", "base64").length).toBe(16);
    const html = await first.text();
    expect(html).toContain(`<meta name="csp-nonce" content="${nonce ?? ""}"`);
    expect(html).not.toContain(UI_NONCE_PLACEHOLDER);
    const otherNonce = /'nonce-([^']+)'/.exec(
      second.headers.get("content-security-policy") ?? "",
    )?.[1];
    expect(otherNonce).not.toBe(nonce);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.headers.get("x-content-type-options")).toBe("nosniff");
    expect(first.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(first.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(first.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("the document has no inline script or style, and every script and stylesheet is same-origin with a matching integrity hash", async () => {
    const html = await (await fetch(`${origin}/`)).text();
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scripts.length).toBe(1);
    for (const [, attrs, body] of scripts) {
      expect(body?.trim()).toBe("");
      expect(attrs).toMatch(/type="module"/);
    }
    const refs = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(refs.length).toBeGreaterThanOrEqual(4);
    for (const ref of refs) {
      // Same-origin paths only: no scheme, no protocol-relative URL.
      expect(ref).toMatch(/^\/[^/]/);
      const res = await fetch(`${origin}${ref}`);
      expect(res.status, ref).toBe(200);
      expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    }
    const covered = [
      ...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)" integrity="(sha384-[^"]+)"/g),
    ];
    expect(covered.map((m) => m[1]?.split(".").at(-1)).sort()).toEqual(["css", "js"]);
    for (const [, url, integrity] of covered) {
      const res = await fetch(`${origin}${url ?? ""}`);
      expect(sriOf(Buffer.from(await res.arrayBuffer()))).toBe(integrity);
      expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(res.headers.get("content-type")).toMatch(
        url?.endsWith(".js") === true ? /^text\/javascript/ : /^text\/css/,
      );
    }
  });

  test("the bundled fonts are WOFF2 files of this origin, with no data: URL that default-src 'self' would block", async () => {
    const html = await (await fetch(`${origin}/`)).text();
    const cssUrl = /href="(\/assets\/[^"]+\.css)"/.exec(html)?.[1] ?? "";
    const css = await (await fetch(`${origin}${cssUrl}`)).text();
    expect(css).not.toContain("data:");
    const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => (m[1] ?? "").replace(/["']/g, ""));
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).toMatch(/^\/assets\/[A-Za-z0-9_-]+\.woff2$/);
      const res = await fetch(`${origin}${url}`);
      expect(res.status, url).toBe(200);
      expect(res.headers.get("content-type")).toBe("font/woff2");
      expect(
        Buffer.from(await res.arrayBuffer())
          .subarray(0, 4)
          .toString("latin1"),
      ).toBe("wOF2");
    }
    expect(css).toContain("font-family:Inter Variable");
    expect(css).toContain("font-family:Fira Code Variable");
    // A5 3.25: fonts <= 200 KB, Latin subset first. The two Latin faces are what Latin text loads.
    const latin = readdirSync(join(dist, "assets")).filter((n) =>
      /^(inter|fira-code)-latin-wght-normal-.*\.woff2$/.test(n),
    );
    expect(latin.length).toBe(2);
    const bytes = latin.reduce((sum, n) => sum + readFileSync(join(dist, "assets", n)).length, 0);
    expect(bytes).toBeLessThanOrEqual(200 * 1024);
  });

  test("no service worker file exists, and the manifest and icon are served for a PWA install", async () => {
    const files = readdirSync(dist, { recursive: true }).map(String);
    expect(
      files.filter((f) => /(^|[\\/])(sw|service-worker|workbox)[^\\/]*\.js$/i.test(f)),
    ).toEqual([]);
    for (const path of ["/sw.js", "/sw-probe.js", "/service-worker.js"]) {
      expect((await fetch(`${origin}${path}`)).status).toBe(404);
    }
    const manifest = await fetch(`${origin}/manifest.webmanifest`);
    expect(manifest.headers.get("content-type")).toMatch(/^application\/manifest\+json/);
    const body = (await manifest.json()) as { start_url: string; display: string };
    expect(body).toMatchObject({ start_url: "/", display: "standalone" });
    expect((await fetch(`${origin}/icon.svg`)).headers.get("content-type")).toBe("image/svg+xml");
    // Paths outside the build stay unreachable.
    for (const path of [
      "/assets/../index.html",
      "/assets/..%2F..%2Fpackage.json",
      "/package.json",
      "/src/main.tsx",
    ]) {
      expect((await fetch(`${origin}${path}`)).status, path).toBe(404);
    }
  });

  test("the bundle has no eval, and the initial JavaScript fits A5 3.25's 250 KB compressed", () => {
    const assets = readdirSync(join(dist, "assets"));
    const js = assets.filter((n) => n.endsWith(".js"));
    expect(js.length).toBe(1);
    const code = readFileSync(join(dist, "assets", js[0] ?? ""));
    expect(code.toString("utf8")).not.toMatch(/\beval\(|new Function\(/);
    expect(gzipSync(code).length).toBeLessThanOrEqual(250 * 1024);
  });

  test("the browser code typechecks with its own DOM configuration", () => {
    const tsc = join(ROOT, "node_modules", "typescript", "bin", "tsc");
    const result = spawnSync(
      process.execPath,
      [tsc, "-p", join(import.meta.dirname, "tsconfig.json")],
      {
        encoding: "utf8",
        shell: false,
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  test("a page report with metrics reaches the runner, and the result files hold no token or code", async () => {
    const token = await signIn();
    const headers = {
      "content-type": "application/json",
      origin,
      authorization: `Bearer ${token}`,
    };
    const waiting = waitForReport(service, (event) => event["run"] === "u07", 10_000);
    const posted = await fetch(`${origin}/api/v1/spike/report`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        run: "u07",
        checks: {
          browser: "Firefox 159.0.1",
          platform: "Linux",
          "font Inter Variable": "ok rendered",
          redeem: "ok",
          // Values the result files must never carry, whatever a page reports.
          "leak token": `Bearer ${token.slice(0, 20)}`,
          "leak path": "/home/mira/tasks",
          "leak windows": "C:\\Users\\mira",
          "leak code": "#k=abc",
        },
        metrics: {
          u05_pass: true,
          u07_done: true,
          u07_scroll_frame_p95: 16.7,
          u07_bad: "text",
          u07_inf: null,
        },
      }),
    });
    expect(posted.status).toBe(200);
    const report = await waitForReport(service, (event) => event["run"] === "u07", 10_000);
    expect(await waiting).toBe(report);
    expect(report["metrics"]).toEqual({
      u05_pass: true,
      u07_done: true,
      u07_scroll_frame_p95: 16.7,
    });
    const out = join(work, "results");
    const written = writeResults(out, report, {
      machine: "laptop",
      date: "2026-11-12",
      mode: "headless",
      size: "1440x900",
    });
    expect(written.sort()).toEqual(["U05.json", "U07.json", "page-checks.json"]);
    for (const name of written) {
      const text = readFileSync(join(out, name), "utf8");
      expect(text).not.toContain(token);
      expect(text).not.toMatch(/[A-Za-z]:\\|\/home\/|\/Users\//);
    }
    const u07 = JSON.parse(readFileSync(join(out, "U07.json"), "utf8")) as {
      browser: string;
      metrics: object;
    };
    expect(u07.browser).toBe("Firefox 159.0.1");
    expect(u07.metrics).toEqual({ u07_done: true, u07_scroll_frame_p95: 16.7 });
    const page = readFileSync(join(out, "page-checks.json"), "utf8");
    expect(page).toContain('"redeem": "ok"');
    expect(page).not.toMatch(/leak|mira|Bearer|#k=/);
    expect(readFileSync(join(work, "state", "events.jsonl"), "utf8")).not.toContain(token);
  });

  test("the runner starts a browser only with its own profile folder", () => {
    const firefox = browserArgs(
      "firefox",
      "/scratch/profile",
      true,
      [1440, 900],
      "http://127.0.0.1:1/",
    );
    expect(firefox).toEqual([
      "--headless",
      "--no-remote",
      "-profile",
      "/scratch/profile",
      "--window-size=1440,900",
      "http://127.0.0.1:1/",
    ]);
    const chrome = browserArgs(
      "chrome",
      "/scratch/profile",
      false,
      [1440, 900],
      "http://127.0.0.1:1/",
    );
    expect(chrome).toContain("--user-data-dir=/scratch/profile");
    expect(chrome).not.toContain("--headless=new");
    expect(existsSync(join(dist, "index.html"))).toBe(true);
  });
});
