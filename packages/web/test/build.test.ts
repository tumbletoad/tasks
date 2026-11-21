// The page as built and served (A7 3.9 M2.13; A2 3.8.3; A5 3.25, 3.26): proven on the built files
// and through the service that serves them, never against a dev server. Every script and
// stylesheet carries the integrity hash of its bytes, nothing is inline, no service worker exists,
// and the service serves the folder with the strict CSP, a fresh nonce and its own build.
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { APP_NAME, PRODUCT_NAME } from "@ttasks/brand";
import { selfTest } from "@ttasks/cli/doctor-http";
import { indexProblems, loadUiFolder, UiFolderInvalid } from "@ttasks/service/http";
import { send } from "@ttasks/service/test/http-client";
import { httpWorld, type HttpWorld } from "@ttasks/service/test/http-world";
import { thirdPartyText } from "../../../scripts/build/bundle.ts";
import { buildWeb, sriOf, type BuiltWeb } from "../build.ts";
import { SUMI, WASHI } from "../src/theme/themes.ts";
import { TOKENS } from "../src/theme/tokens.ts";

const SLOW = { timeout: 240_000 };

let work: string;
let built: BuiltWeb;
let world: HttpWorld | undefined;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "ttasks-web-build-"));
  built = await buildWeb(join(work, "ui"));
}, 240_000);

afterAll(async () => {
  await world?.close();
  rmSync(work, { recursive: true, force: true });
});

const read = (path: string) => readFileSync(join(built.out, ...path.split("/")));

describe("[A7.3.9.m2-13.web.build] the built page under SRI and the strict CSP", () => {
  test("every script and stylesheet is a file of the build with the integrity hash of its bytes", () => {
    const index = read("index.html").toString("utf8");
    const tags = [...index.matchAll(/<(script|link)\b[^>]*>/g)].map(([tag]) => tag);
    const loading = tags.filter(
      (t) => t.startsWith("<script") || /rel="(stylesheet|modulepreload)"/.test(t),
    );
    expect(loading.length).toBeGreaterThanOrEqual(2);
    for (const tag of loading) {
      const url = /\s(?:src|href)="(\/assets\/[^"]+)"/.exec(tag)?.[1];
      const sri = /\sintegrity="([^"]+)"/.exec(tag)?.[1];
      expect(url, tag).toBeDefined();
      expect(sri, tag).toBe(sriOf(read((url ?? "").slice(1))));
    }
    expect(built.integrity.sort()).toEqual(
      loading.map((t) => /\s(?:src|href)="([^"]+)"/.exec(t)?.[1]).sort(),
    );
    // No inline script or style, the nonce and build placeholders the service fills, the title
    // from packages/brand: the name inside the app (PLAN.md Q).
    expect(index).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
    expect(index).not.toMatch(/<style\b/);
    expect(index).not.toMatch(/\sstyle="/);
    expect(index).toContain('<meta name="csp-nonce" content="__TTASKS_NONCE__"');
    expect(index).toContain('<meta name="app-build" content="__TTASKS_BUILD__"');
    expect(index).toContain(`<title>${APP_NAME}</title>`);
    expect(index).not.toMatch(/%[A-Z_]+%/);
  });

  test("inside the app the product is called by the app's name, never the full product name", () => {
    // PLAN.md Q: TTasks outside the app, TTasks inside it. The page's words are in its bundle.
    expect(PRODUCT_NAME).not.toBe(APP_NAME);
    for (const file of readdirSync(join(built.out, "assets"))) {
      expect(read(`assets/${file}`).toString("utf8"), file).not.toContain(PRODUCT_NAME);
    }
  });

  test("no service worker, no eval, no remote URL, and the initial JavaScript fits A5's budget", () => {
    const files = readdirSync(join(built.out, "assets"));
    expect(files.every((f) => /^[A-Za-z0-9._-]+\.(js|css|woff2)$/.test(f))).toBe(true);
    // Judged on the name without its content hash: a hash such as `B_SWr00U` names no worker.
    const unhashed = (f: string) => f.replace(/-[A-Za-z0-9_-]{8}(?=\.[a-z0-9]+$)/, "");
    expect(built.files.filter((f) => /sw|worker/i.test(unhashed(f)))).toEqual([]);
    let compressed = 0;
    for (const file of files) {
      const text = read(`assets/${file}`).toString("utf8");
      expect(text, file).not.toMatch(/serviceWorker\s*\.\s*register|\beval\(|new Function\(/);
      // URLs only in text the libraries never fetch: XML namespaces, React's and FormatJS's error
      // links, and the router's stand-in origin for a page without one.
      expect(text, file).not.toMatch(
        /https?:\/\/(?!www\.w3\.org\/|react\.dev\/|formatjs\.github\.io\/|localhost`)[a-z]/,
      );
      if (file.endsWith(".js")) compressed += gzipSync(read(`assets/${file}`)).length;
    }
    // A guide for the first load, not a limit a feature must fit under: it moves with what the
    // page does, and real use decides it.
    expect(compressed).toBeLessThanOrEqual(260 * 1024);
    // The version folder's THIRD_PARTY.txt names every npm package the page ships.
    const third = thirdPartyText(join(import.meta.dirname, "..", "..", ".."), [], built.npmInputs);
    for (const name of ["react", "react-dom", "scheduler"]) {
      expect(third).toMatch(new RegExp(`^${name} \\d+\\.\\d+\\.\\d+ \\(MIT\\)$`, "m"));
    }
  });

  test("the service takes the folder only while every file it loads is hashed", () => {
    const bundle = loadUiFolder(built.out, { build: "b-test" });
    expect(indexProblems(bundle.index, bundle.files)).toEqual([]);
    expect(bundle.index).toContain('<meta name="app-build" content="b-test"');

    // A changed asset, an inline script, an unhashed stylesheet: each is refused.
    const copy = (name: string) => {
      const dir = join(work, name);
      rmSync(dir, { recursive: true, force: true });
      for (const file of built.files) {
        const to = join(dir, ...file.split("/"));
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, read(file));
      }
      return dir;
    };
    const js = built.files.find((f) => f.endsWith(".js")) ?? "";
    const changed = copy("changed");
    appendFileSync(join(changed, ...js.split("/")), "\n;0");
    expect(() => loadUiFolder(changed)).toThrow(UiFolderInvalid);
    const inline = copy("inline");
    const index = join(inline, "index.html");
    writeFileSync(
      index,
      readFileSync(index, "utf8").replace("</head>", "<script>1</script></head>"),
    );
    expect(() => loadUiFolder(inline)).toThrow(/inline script/);
    const unhashed = copy("unhashed");
    const page = join(unhashed, "index.html");
    writeFileSync(
      page,
      readFileSync(page, "utf8").replace(/(rel="stylesheet"[^>]*?) integrity="[^"]+"/, "$1"),
    );
    expect(() => loadUiFolder(unhashed)).toThrow(/integrity/);
  });

  test(
    "the service serves it: a fresh nonce in the CSP and the meta tag, its build, the page's routes",
    SLOW,
    async () => {
      world = await httpWorld("web", { ui: built.out });
      const port = world.port();
      const first = await send(port, { path: "/" });
      const second = await send(port, {
        path: `/s/sp_0123456789abcdefghjkmnpqrs/area/ar_1/project/pj_2`,
      });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const csp = String(first.headers["content-security-policy"]);
      const nonce = /'nonce-([^']+)'/.exec(csp)?.[1] ?? "";
      expect(nonce).not.toBe("");
      expect(first.body).toContain(`<meta name="csp-nonce" content="${nonce}"`);
      expect(second.body).not.toContain(nonce);
      for (const directive of ["script-src 'self'", "worker-src 'none'", "object-src 'none'"]) {
        expect(csp).toContain(directive);
      }
      expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
      expect(first.body).toMatch(/<meta name="app-build" content="[A-Za-z0-9._-]+"/);
      expect(first.body).not.toContain("__TTASKS_");
      for (const file of built.files.filter((f) => f.startsWith("assets/"))) {
        const asset = await send(port, { path: `/${file}` });
        expect(asset.status, file).toBe(200);
        expect(asset.body, file).toBe(read(file).toString("utf8"));
      }
      expect((await send(port, { path: "/s/not-a-space/../../x" })).status).toBe(404);
    },
  );
});

describe("[A2.3.13.cli.doctor-page] doctor's self-test of the page a build produces", () => {
  test(
    "the built page, served by the service, passes doctor's self-test: the meta tag repeats the nonce",
    SLOW,
    async () => {
      world ??= await httpWorld("web", { ui: built.out });
      // The build's own output, not a hand-written page: the tag is written the way the build
      // writes it, and doctor reads it the way a browser does.
      expect(await selfTest(world.port())).toEqual([]);
    },
  );
});

describe("[A7.3.12.m5-01.web.build] the shell's build: one script, the themes' tokens, fonts, the manifest", () => {
  const assets = () => readdirSync(join(built.out, "assets"));

  test("one script; the stylesheet carries every token of both themes from the theme data", () => {
    expect(assets().filter((f) => f.endsWith(".js"))).toHaveLength(1);
    const sheets = assets().filter((f) => f.endsWith(".css"));
    expect(sheets).toHaveLength(1);
    const css = read(`assets/${sheets[0] ?? ""}`).toString("utf8");
    for (const theme of [SUMI, WASHI]) {
      for (const token of TOKENS) {
        expect(css, `${theme.name} ${token}`).toMatch(
          new RegExp(`--k-${token}:\\s*${theme.tokens[token]}[;}]`, "i"),
        );
      }
    }
    expect(css).toMatch(/\[data-theme=["']?washi["']?\]/);
    expect(css).toMatch(/prefers-color-scheme:\s*light/);
  });

  test("Inter and Fira Code are files of the build, Latin within A5's font budget, with their licences", () => {
    const fonts = assets().filter((f) => f.endsWith(".woff2"));
    const latin = fonts.filter((f) => /^(inter|fira-code)-latin-wght-normal-/.test(f));
    expect(latin).toHaveLength(2);
    const size = latin.reduce((sum, f) => sum + read(`assets/${f}`).length, 0);
    expect(size).toBeLessThanOrEqual(200 * 1024);
    const css = read(`assets/${assets().find((f) => f.endsWith(".css")) ?? ""}`).toString("utf8");
    for (const font of fonts) expect(css, font).toContain(`/assets/${font}`);
    expect(css).not.toMatch(/url\(\s*["']?(?:https?:)?\/\//);
    const third = thirdPartyText(join(import.meta.dirname, "..", "..", ".."), [], built.npmInputs);
    for (const name of ["@fontsource-variable/inter", "@fontsource-variable/fira-code"]) {
      expect(third).toMatch(new RegExp(`^${name} \\d+\\.\\d+\\.\\d+ \\(OFL-1\\.1\\)$`, "m"));
    }
    expect(third).toContain("SIL OPEN FONT LICENSE");
    for (const name of [
      "@tanstack/react-router",
      "@tanstack/react-virtual",
      "@tanstack/virtual-core",
      "react-aria-components",
      "react-intl",
    ]) {
      expect(third, name).toMatch(new RegExp(`^${name} \\d+\\.\\d+\\.\\d+ \\(`, "m"));
    }
  });

  test("a web app manifest with the brand's name and its icons, linked from the page", () => {
    const manifest = JSON.parse(read("manifest.webmanifest").toString("utf8")) as {
      name: string;
      start_url: string;
      display: string;
      icons: { src: string; sizes: string; type: string }[];
    };
    expect(manifest.name).toBe(PRODUCT_NAME);
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
    for (const icon of manifest.icons) {
      const bytes = read(icon.src.slice(1));
      if (icon.type === "image/png") {
        expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
        expect(`${String(bytes.readUInt32BE(16))}x${String(bytes.readUInt32BE(20))}`).toBe(
          icon.sizes,
        );
      } else {
        expect(bytes.toString("utf8")).toMatch(/^<svg /);
      }
    }
    const index = read("index.html").toString("utf8");
    expect(index).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    const bundle = loadUiFolder(built.out);
    for (const path of ["/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png"]) {
      expect(bundle.files.has(path), path).toBe(true);
    }
  });
});
