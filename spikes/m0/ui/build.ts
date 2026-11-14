// Builds the spike page with Vite (A5 U17) into a folder the stand-in service serves with
// `kit service --ui <out>` (step M0.08). The output loads under the strict CSP of A2 3.8.3:
// - no inline script or style: Vite writes one external module script and one stylesheet;
// - every asset is a file of this origin (assetsInlineLimit 0, so no data: fonts that
//   default-src 'self' would block), with a content hash in its name;
// - every script and stylesheet carries a Subresource Integrity hash (A2 3.8.3 "Asset
//   integrity"), added after the build from the files as written;
// - no service worker file, and the module-preload polyfill is off.
//
//   pnpm exec node spikes/m0/ui/build.ts <out>
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

export const UI_DIR = dirname(fileURLToPath(import.meta.url));

/** Adds `integrity="sha384-…"` to every same-origin script and stylesheet of index.html. */
export function addIntegrity(out: string): string[] {
  const indexPath = join(out, "index.html");
  const covered: string[] = [];
  const html = readFileSync(indexPath, "utf8").replace(
    /<(script|link)\b([^>]*?)\s(src|href)="(\/assets\/[^"]+\.(?:js|css))"([^>]*)>/g,
    (_tag, name: string, before: string, attr: string, url: string, after: string) => {
      const digest = createHash("sha384")
        .update(readFileSync(join(out, url)))
        .digest("base64");
      covered.push(url);
      return `<${name}${before} ${attr}="${url}" integrity="sha384-${digest}"${after}>`;
    },
  );
  writeFileSync(indexPath, html);
  return covered;
}

export async function buildUi(out: string): Promise<{ out: string; integrity: string[] }> {
  const target = resolve(out);
  rmSync(target, { recursive: true, force: true });
  await build({
    root: UI_DIR,
    configFile: false,
    logLevel: "warn",
    base: "/",
    publicDir: join(UI_DIR, "public"),
    build: {
      outDir: target,
      emptyOutDir: true,
      assetsInlineLimit: 0,
      modulePreload: { polyfill: false },
      cssCodeSplit: false,
      sourcemap: false,
      target: "es2024",
    },
  });
  return { out: target, integrity: addIntegrity(target) };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (out === undefined) {
    process.stderr.write("Usage: node spikes/m0/ui/build.ts <out>\n");
    process.exit(64);
  }
  const built = await buildUi(out);
  process.stdout.write(`${JSON.stringify(built, null, 2)}\n`);
}
