// Builds the page with Vite (A5 3.24) into a folder the service serves through `HttpStart.ui`
// (A5 3.28) and the version folder ships as `ui/` (A2 3.12.2). The output loads under
// A2 3.8.3's strict CSP and nothing else:
// - no inline script or style: one external module script and one stylesheet;
// - every asset is a file of this origin with a content hash in its name (assetsInlineLimit 0,
//   so nothing becomes a data: URL), and no public folder;
// - every script, stylesheet and module preload carries a Subresource Integrity hash of its bytes
//   as written, added after the build (A2 3.8.3 "Asset integrity");
// - no service worker, no module-preload polyfill, no source maps;
// - one script: a lazy chunk would load without an integrity hash, so the build refuses a second
//   one (A5 3.24 says how lazy chunks get integrity when they come);
// - the theme's custom properties come from the theme data (src/theme, `virtual:theme-tokens.css`),
//   so the stylesheet and the contrast test read the same values;
// - a web app manifest and its icons at the root, and no service worker (A5 3.24 `PWA`);
// - `index.html` keeps the service's two placeholders: `__TASKS_NONCE__` (the per-response style
//   nonce, in `<meta name="csp-nonce">`) and `__TASKS_BUILD__` (the serving build, sent back as
//   the build header).
//
//   pnpm build:web [<out>]        default out: packages/web/dist
import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin, type Rolldown } from "vite";
import { APP_NAME, PRODUCT_NAME } from "@tasks/brand";
import { SUMI, shippedThemeCss } from "./src/theme/themes.ts";

export const WEB_DIR = dirname(fileURLToPath(import.meta.url));
/** Where `pnpm build:web` writes, and where `tasks serve` from source looks (cli/src/bin.ts). */
export const WEB_DIST = join(WEB_DIR, "dist");

/** `sha384-<base64>` of a file's bytes. */
export const sriOf = (bytes: Buffer): string =>
  `sha384-${createHash("sha384").update(bytes).digest("base64")}`;

/**
 * Adds `integrity="sha384-…"` to every same-origin script, stylesheet and module preload of
 * index.html, from the files as written. Returns the URLs it covered.
 */
export function addIntegrity(out: string): string[] {
  const indexPath = join(out, "index.html");
  const covered: string[] = [];
  const html = readFileSync(indexPath, "utf8").replace(
    /<(script|link)\b([^>]*?)\s(src|href)="(\/assets\/[^"]+\.(?:js|css))"([^>]*)>/g,
    (_tag, name: string, before: string, attr: string, url: string, after: string) => {
      if (/\sintegrity=/.test(before + after)) throw new Error(`${url} has an integrity already`);
      covered.push(url);
      const sri = sriOf(readFileSync(join(out, ...url.split("/"))));
      return `<${name}${before} ${attr}="${url}" integrity="${sri}"${after}>`;
    },
  );
  writeFileSync(indexPath, html);
  return covered;
}

/** The name inside the app in the page's title, from packages/brand (PLAN.md Q). */
const brandTitle: Plugin = {
  name: "brand-title",
  transformIndexHtml: {
    order: "pre",
    handler: (html) => html.replaceAll("%APP_NAME%", APP_NAME),
  },
};

/** The theme's custom properties, from the theme data (A5 3.19: themes are data, never CSS). */
const THEME_MODULE = "virtual:theme-tokens.css";
const themeTokens: Plugin = {
  name: "theme-tokens",
  resolveId: (id) => (id === THEME_MODULE ? `\0${THEME_MODULE}` : undefined),
  load: (id) => (id === `\0${THEME_MODULE}` ? shippedThemeCss() : undefined),
};

/** A PNG of `size` px: the page's colour with a ring in the accent, drawn without a library. */
export function iconPng(size: number, background: string, ring: string): Buffer {
  const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const [bg, fg] = [rgb(background), rgb(ring)];
  const centre = size / 2;
  const radius = size * 0.28;
  const half = size * 0.035;
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    rows[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      const d = Math.abs(Math.hypot(x + 0.5 - centre, y + 0.5 - centre) - radius);
      const cover = Math.min(1, Math.max(0, half + 0.5 - d));
      const at = y * (size * 4 + 1) + 1 + x * 4;
      for (let c = 0; c < 3; c += 1) {
        rows[at + c] = Math.round((bg[c] ?? 0) * (1 - cover) + (fg[c] ?? 0) * cover);
      }
      rows[at + 3] = 255;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * The web app manifest (A5 3.24 "PWA"): Chromium-family browsers can install the page as an app
 * window, and no service worker is registered (U27). The name comes from packages/brand; the icon
 * is a plain placeholder mark in Sumi's colours until the brand step draws one.
 */
const webManifest: Plugin = {
  name: "web-manifest",
  transformIndexHtml: {
    order: "post",
    handler: () => [
      { tag: "link", attrs: { rel: "manifest", href: "/manifest.webmanifest" }, injectTo: "head" },
      {
        tag: "link",
        attrs: { rel: "icon", href: "/icon.svg", type: "image/svg+xml" },
        injectTo: "head",
      },
      { tag: "meta", attrs: { name: "theme-color", content: SUMI.tokens.bg }, injectTo: "head" },
    ],
  },
  generateBundle() {
    const { bg, accent } = SUMI.tokens;
    const manifest = {
      id: "/",
      name: PRODUCT_NAME,
      short_name: PRODUCT_NAME,
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: bg,
      theme_color: bg,
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
        { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      ],
    };
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">` +
      `<rect width="512" height="512" rx="112" fill="${bg}"/>` +
      `<circle cx="256" cy="256" r="143" fill="none" stroke="${accent}" stroke-width="36"/></svg>\n`;
    const files: [string, string | Buffer][] = [
      ["manifest.webmanifest", `${JSON.stringify(manifest, null, 2)}\n`],
      ["icon.svg", svg],
      ["icon-192.png", iconPng(192, bg, accent)],
      ["icon-512.png", iconPng(512, bg, accent)],
    ];
    for (const [fileName, source] of files) this.emitFile({ type: "asset", fileName, source });
  },
};

export interface BuiltWeb {
  readonly out: string;
  /** Every file written, as forward-slash paths relative to `out`, sorted. */
  readonly files: string[];
  /** The URLs that got an integrity hash. */
  readonly integrity: string[];
  /**
   * The bundled modules from npm packages, as forward-slash paths relative to `root`, for the
   * version folder's THIRD_PARTY.txt.
   */
  readonly npmInputs: string[];
}

/** The end of the last `asProduction` call: each waits for the one before it. */
let productionQueue: Promise<unknown> = Promise.resolve();

/**
 * Runs `work` with NODE_ENV set to `production`, and gives the caller's value back after. Vite
 * reads NODE_ENV itself, whatever `mode` says: any other value makes a development build, whose
 * JSX carries the absolute source path of every component (A5 3.24). Vitest sets `test`. NODE_ENV
 * belongs to the whole process, so calls run one at a time: two at once would each give the other's
 * value back, and one would build with the caller's.
 */
export function asProduction<T>(work: () => Promise<T>): Promise<T> {
  const run = productionQueue.then(async () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      return await work();
    } finally {
      if (before === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = before;
    }
  });
  productionQueue = run.catch(() => undefined);
  return run;
}

/** Builds the page into `out`, which is replaced. `root` is the repository, for npmInputs. */
export async function buildWeb(out: string = WEB_DIST, root?: string): Promise<BuiltWeb> {
  const target = resolve(out);
  rmSync(target, { recursive: true, force: true });
  const result = await asProduction(() => viteBuild(target));
  const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[];
  const files: string[] = [];
  const modules = new Set<string>();
  for (const output of outputs) {
    for (const item of output.output) {
      files.push(item.fileName);
      if (item.type === "chunk") for (const id of item.moduleIds) modules.add(id);
    }
  }
  // A second script would be a lazy chunk, which the browser loads without an integrity hash.
  const scripts = files.filter((f) => f.endsWith(".js"));
  if (scripts.length !== 1) {
    throw new Error(`The page must build to one script, not ${String(scripts.length)}`);
  }
  const base = root ?? join(WEB_DIR, "..", "..");
  const npmInputs = [...modules]
    .filter((id) => id.includes(`${sep}node_modules${sep}`) || id.includes("/node_modules/"))
    .map((id) => relative(base, id).split(sep).join("/"))
    .sort();
  return { out: target, files: files.sort(), integrity: addIntegrity(target), npmInputs };
}

/** Vite's production build of the page into `target`. */
function viteBuild(target: string): ReturnType<typeof build> {
  return build({
    root: WEB_DIR,
    configFile: false,
    envDir: false,
    // Always the production build, whatever NODE_ENV the caller runs with: see asProduction.
    mode: "production",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "warn",
    base: "/",
    publicDir: false,
    plugins: [brandTitle, themeTokens, webManifest],
    build: {
      outDir: target,
      emptyOutDir: true,
      assetsInlineLimit: 0,
      modulePreload: { polyfill: false },
      cssCodeSplit: false,
      sourcemap: false,
      reportCompressedSize: false,
      // One script by design; its budget (A5 3.25) is the build test's, compressed.
      chunkSizeWarningLimit: 1024,
      target: "es2024",
      rolldownOptions: {
        // React libraries mark modules "use client" for server rendering, which this page has none of.
        onLog: (level, log, handle) => {
          if (log.code !== "MODULE_LEVEL_DIRECTIVE") handle(level, log);
        },
      },
    },
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const built = await buildWeb(process.argv[2] ?? WEB_DIST);
  process.stdout.write(`${built.out}\n${built.files.map((f) => `  ${f}\n`).join("")}`);
}
