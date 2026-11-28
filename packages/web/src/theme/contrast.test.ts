import { describe, expect, test } from "vitest";
import { SUMI, WASHI } from "./themes.ts";
import {
  ALLOWED_PAIRS,
  contrast,
  contrastFailures,
  DECORATIVE_PAIRS,
  NON_TEXT_MIN,
  SURFACES,
  TEXT_MIN,
  themeCss,
  TOKENS,
  validateTheme,
  type Theme,
  type Token,
} from "./tokens.ts";

const THEMES: readonly Theme[] = [SUMI, WASHI];
const ratio = (theme: Theme, fg: Token, bg: Token) => contrast(theme.tokens[fg], theme.tokens[bg]);
const range = (theme: Theme, fg: Token) => {
  const all = SURFACES.map((bg) => ratio(theme, fg, bg));
  return [Math.min(...all), Math.max(...all)];
};

describe("[A5.3.19.web.contrast] every allowed token pair meets its contrast threshold", () => {
  test.each(THEMES.map((t) => [t.name, t] as const))(
    "%s: every allowed pair passes",
    (_name, theme) => {
      const failures = contrastFailures(theme).map(
        ({ pair, ratio: r }) => `${pair.fg} on ${pair.bg}: ${r.toFixed(2)} < ${String(pair.min)}`,
      );
      expect(failures).toEqual([]);
      // Text needs 4.5:1, marks and controls 3:1, and every allowed pair is checked: 16
      // foregrounds and 3 marks on the five surfaces, and the nine named pairs.
      expect(ALLOWED_PAIRS).toHaveLength(16 * 5 + 3 * 5 + 9);
      expect(new Set(ALLOWED_PAIRS.map((p) => p.min))).toEqual(new Set([TEXT_MIN, NON_TEXT_MIN]));
    },
  );

  test("the formula gives A5's computed values", () => {
    const two = (n: number) => Math.round(n * 100) / 100;
    expect(range(SUMI, "text").map(two)).toEqual([11.98, 14.5]);
    expect(range(WASHI, "muted").map(two)).toEqual([4.97, 5.73]);
    expect(range(WASHI, "star").map(two)).toEqual([3.6, 4.14]);
    expect(two(ratio(SUMI, "accent-ink", "accent"))).toBe(7.28);
    expect(two(ratio(WASHI, "late", "late-soft"))).toBe(5.14);
    expect(two(ratio(SUMI, "control", "accent-soft"))).toBe(3.42);
  });

  test("the decorative pairs are not allowed pairs and could not carry meaning", () => {
    for (const theme of THEMES) {
      for (const [fg, bg] of DECORATIVE_PAIRS) {
        expect(ALLOWED_PAIRS.some((p) => p.fg === fg && p.bg === bg)).toBe(false);
        expect(ratio(theme, fg, bg), `${theme.name} ${fg} on ${bg}`).toBeLessThan(NON_TEXT_MIN);
      }
    }
  });

  test("a token change that breaks a pair is caught", () => {
    const dim: Theme = { ...WASHI, tokens: { ...WASHI.tokens, muted: "#8a8478" } };
    const failed = contrastFailures(dim).map(({ pair }) => `${pair.fg}/${pair.bg}`);
    expect(failed).toContain("muted/bg");
  });

  test("the stylesheet's rules carry every token of both themes, Sumi by default", () => {
    const css = themeCss(SUMI, WASHI);
    for (const token of TOKENS) {
      expect(css).toContain(`--k-${token}: ${SUMI.tokens[token]};`);
      expect(css).toContain(`--k-${token}: ${WASHI.tokens[token]};`);
    }
    expect(css).toMatch(/^:root \{\n {2}color-scheme: dark;/m);
    expect(css).toContain(':root[data-theme="washi"] {\n  color-scheme: light;');
    expect(css).toContain('@media (prefers-color-scheme: light) {\n  :root[data-theme="system"]');
  });
});

describe("[A5.3.19.web.theme-data] a theme is validated token data, never CSS", () => {
  const good = { name: "washi", scheme: "light", tokens: { ...WASHI.tokens } };

  test("the shipped themes load; data that is not an allowlisted colour token does not", () => {
    expect(validateTheme(good).problems).toEqual([]);
    const cases: [unknown, string][] = [
      [null, "a theme is an object"],
      [{ ...good, name: "ink" }, "name: not a theme of this version"],
      [{ ...good, scheme: "dim" }, "scheme: dark or light"],
      [{ ...good, tokens: { ...good.tokens, glow: "#ffffff" } }, "glow: not a token"],
      [{ ...good, tokens: { ...good.tokens, bg: "red" } }, "bg: not #rrggbb"],
      [{ ...good, tokens: { ...good.tokens, bg: "#fff" } }, "bg: not #rrggbb"],
      [{ ...good, tokens: { ...good.tokens, bg: "#ffffff;}body{x:y" } }, "bg: not #rrggbb"],
      [{ ...good, tokens: { ...good.tokens, bg: "url(x)" } }, "bg: not #rrggbb"],
      [{ ...good, tokens: { ...good.tokens, text: 0 } }, "text: not #rrggbb"],
    ];
    for (const [data, problem] of cases) {
      const result = validateTheme(data);
      expect(result.theme).toBeUndefined();
      expect(result.problems).toContain(problem);
    }
    const without: Record<string, string> = { ...good.tokens };
    delete without["muted"];
    expect(validateTheme({ ...good, tokens: without }).problems).toEqual(["muted: missing"]);
  });
});
