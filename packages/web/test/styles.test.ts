// The page's stylesheets keep the theme's rules: colours come only from the theme's tokens,
// no text is set in capitals or spaced out, and the decorative hairline tokens never colour text.
// Read straight from the source files, so a rule that breaks them fails `pnpm verify`.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });
}

/** Each declaration of a sheet, comments removed: `property: value`. */
function declarations(css: string): { property: string; value: string }[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...text.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/g)].map((m) => ({
    property: (m[1] ?? "").trim(),
    value: (m[2] ?? "").trim(),
  }));
}

const SHEETS = cssFiles(SRC).map((path) => ({
  name: relative(SRC, path).replaceAll("\\", "/"),
  css: readFileSync(path, "utf8"),
}));

/** A colour written out: hex, a colour function, or a named colour. */
const RAW_COLOUR =
  /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(|\b(?:white|black|red|green|blue|gray|grey|silver|orange|yellow|purple)\b/i;

describe("[A5.3.19.web.styles] the stylesheets use tokens only and keep A5's type rules", () => {
  test("the page has its sheets: the base, the list's, the row's and the shell's modules", () => {
    const names = SHEETS.map((s) => s.name);
    expect(names).toContain("theme/base.css");
    expect(names).toContain("list/List.module.css");
    expect(names).toContain("row/Row.module.css");
    // Every component styles itself in a CSS Module: base.css is the one global sheet.
    expect(names.filter((n) => !n.endsWith(".module.css"))).toEqual(["theme/base.css"]);
    expect(names.filter((n) => n.endsWith(".module.css")).length).toBeGreaterThanOrEqual(5);
  });

  test("no colour is written outside the theme data", () => {
    const raw = SHEETS.flatMap(({ name, css }) =>
      declarations(css)
        .filter(({ value }) => RAW_COLOUR.test(value))
        .map(({ property, value }) => `${name}: ${property}: ${value}`),
    );
    expect(raw).toEqual([]);
  });

  test("no capitals by CSS and no letter spacing above 0.01em", () => {
    const broken = SHEETS.flatMap(({ name, css }) =>
      declarations(css)
        .filter(
          ({ property, value }) =>
            (property === "text-transform" && /uppercase|capitalize/.test(value)) ||
            (property === "letter-spacing" &&
              value !== "normal" &&
              value !== "0" &&
              !(/^-?[\d.]+em$/.test(value) && Number.parseFloat(value) <= 0.01)),
        )
        .map(({ property, value }) => `${name}: ${property}: ${value}`),
    );
    expect(broken).toEqual([]);
  });

  test("hairlines never colour text, and selected text keeps the text colour", () => {
    const misuse = SHEETS.flatMap(({ name, css }) =>
      declarations(css)
        .filter(
          ({ property, value }) =>
            property === "color" && /var\(--k-line(?:-strong)?\)/.test(value),
        )
        .map(({ property, value }) => `${name}: ${property}: ${value}`),
    );
    expect(misuse).toEqual([]);
    const base = SHEETS.find((s) => s.name === "theme/base.css")?.css ?? "";
    expect(base).toMatch(/::selection\s*\{[^}]*color:\s*var\(--k-text\);/);
  });
});
