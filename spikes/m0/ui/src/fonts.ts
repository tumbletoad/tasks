// Row U05 (A5 M0-3, U16): the bundled Inter and Fira Code render through the service under the
// page's CSP (fonts fall under default-src 'self'; A2 3.8.3 sets no font-src of its own). The page
// loads each face through document.fonts, then checks that text actually renders in it and not in
// a fallback: the same string measured with the face first and two different fallbacks behind it
// has one width only when the face itself is used.
import { metric, record } from "./report.ts";

export const FACES = [
  { family: "Inter Variable", key: "inter" },
  { family: "Fira Code Variable", key: "fira" },
] as const;

const SAMPLE = "Mira fixture M-14 · 0123456789 · Release 2.4 to the app stores";

function width(context: CanvasRenderingContext2D, font: string): number {
  context.font = font;
  return context.measureText(SAMPLE).width;
}

export async function checkFonts(): Promise<boolean> {
  const started = performance.now();
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  let all = true;
  for (const { family, key } of FACES) {
    let loaded: FontFace[];
    try {
      loaded = await document.fonts.load(`16px "${family}"`, SAMPLE);
    } catch {
      loaded = [];
    }
    const isLoaded = loaded.length > 0 && loaded.every((face) => face.status === "loaded");
    const checked = document.fonts.check(`16px "${family}"`, SAMPLE);
    let rendered = false;
    if (context !== null) {
      const serif = width(context, `16px "${family}", serif`);
      const mono = width(context, `16px "${family}", monospace`);
      const plainSerif = width(context, "16px serif");
      const plainMono = width(context, "16px monospace");
      // The face is used when both stacks measure the same and differ from the fallbacks.
      rendered =
        Math.abs(serif - mono) < 0.01 &&
        (Math.abs(serif - plainSerif) > 0.5 || Math.abs(mono - plainMono) > 0.5);
    }
    metric(`u05_${key}_loaded`, isLoaded);
    metric(`u05_${key}_check`, checked);
    metric(`u05_${key}_rendered`, rendered);
    record(
      `font ${family}`,
      isLoaded && rendered
        ? "ok rendered"
        : `fail loaded ${String(isLoaded)} rendered ${String(rendered)}`,
    );
    all &&= isLoaded && rendered;
  }

  // The DOM agrees: the sample paragraph in the mono face keeps ligatures off (A5 3.20).
  const mono = document.getElementById("font-mono");
  if (mono !== null) {
    metric("u05_mono_ligatures_off", getComputedStyle(mono).fontVariantLigatures === "none");
  }

  // Every font file came from this origin, as WOFF2.
  const files = performance
    .getEntriesByType("resource")
    .filter((entry) => /\.woff2(\?|$)/.test(entry.name)) as PerformanceResourceTiming[];
  const foreign = files.filter((entry) => new URL(entry.name).origin !== location.origin).length;
  metric("u05_font_files", files.length);
  metric("u05_font_foreign", foreign);
  metric(
    "u05_font_bytes",
    files.reduce((sum, entry) => sum + (entry.encodedBodySize || 0), 0),
  );
  metric("u05_check_ms", performance.now() - started);
  metric("u05_pass", all && foreign === 0);
  record("fonts", all && foreign === 0 ? "ok" : "fail");
  return all;
}
