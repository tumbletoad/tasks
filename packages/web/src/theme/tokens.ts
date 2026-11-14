// Themes are token data, never CSS (A5 3.19, U15). This module is the one source of truth for what
// a theme may say and what its colours must achieve:
//
// - TOKENS: the allowlist. A theme sets each of them as `#rrggbb`; the styles read them as
//   `--k-<token>` custom properties, and nothing else in the styles is a colour.
// - The contrast rules: every allowed foreground and background pair with its WCAG 2.x threshold
//   (4.5:1 for text, 3:1 for controls, focus and marks), and the pairs that must never carry
//   meaning because they are decorative.
// - validateTheme: what a theme must look like to load (only allowlisted names, colours only as
//   `#rrggbb`). Sumi and Washi go through it like any later theme will.
// - themeCss: the custom properties the build writes into the stylesheet, from the same data the
//   contrast test reads. A token change therefore reaches the page and the test together.
//
// Pure functions without the DOM: the build (Node) and the page both use them.

/** Every colour token a theme sets (A5 3.19), in the table's order, then the eight area slots. */
export const TOKENS = [
  "bg",
  "raised",
  "hover",
  "selected",
  "sunken",
  "line",
  "line-strong",
  "control",
  "text",
  "text-2",
  "muted",
  "accent",
  "accent-strong",
  "accent-ink",
  "accent-soft",
  "focus",
  "due",
  "due-soft",
  "late",
  "late-soft",
  "waiting",
  "waiting-soft",
  "review",
  "review-soft",
  "star",
  "selection",
  "slot-1",
  "slot-2",
  "slot-3",
  "slot-4",
  "slot-5",
  "slot-6",
  "slot-7",
  "slot-8",
] as const;

export type Token = (typeof TOKENS)[number];

/** The themes v1 ships. `system` follows the browser's colour scheme between the two. */
export const THEME_NAMES = ["sumi", "washi"] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

export interface Theme {
  readonly name: ThemeName;
  /** The browser's `color-scheme` for this theme: form controls and scroll bars follow it. */
  readonly scheme: "dark" | "light";
  readonly tokens: Readonly<Record<Token, string>>;
}

/** The five surfaces text sits on (A5 3.19's contrast table). */
export const SURFACES = ["bg", "raised", "hover", "selected", "sunken"] as const;

/** AA thresholds (WCAG 2.x): text, and non-text such as controls, focus rings and marks. */
export const TEXT_MIN = 4.5;
export const NON_TEXT_MIN = 3;

export interface Pair {
  readonly fg: Token;
  readonly bg: Token;
  readonly min: number;
}

const SLOTS: readonly Token[] = TOKENS.filter((t) => t.startsWith("slot-"));

/** Foregrounds that are text on every surface. */
const TEXT_ON_SURFACES: readonly Token[] = [
  "text",
  "text-2",
  "muted",
  "accent",
  "due",
  "late",
  "waiting",
  "review",
  ...SLOTS,
];

/** Foregrounds that are marks or controls on every surface (3:1). */
const NON_TEXT_ON_SURFACES: readonly Token[] = ["star", "control", "focus"];

/** Every allowed pair and its threshold: A5 3.19's two contrast tables. */
export const ALLOWED_PAIRS: readonly Pair[] = [
  ...TEXT_ON_SURFACES.flatMap((fg) => SURFACES.map((bg) => ({ fg, bg, min: TEXT_MIN }))),
  ...NON_TEXT_ON_SURFACES.flatMap((fg) => SURFACES.map((bg) => ({ fg, bg, min: NON_TEXT_MIN }))),
  { fg: "accent-ink", bg: "accent", min: TEXT_MIN },
  { fg: "accent-ink", bg: "accent-strong", min: TEXT_MIN },
  { fg: "due", bg: "due-soft", min: TEXT_MIN },
  { fg: "late", bg: "late-soft", min: TEXT_MIN },
  { fg: "waiting", bg: "waiting-soft", min: TEXT_MIN },
  { fg: "review", bg: "review-soft", min: TEXT_MIN },
  { fg: "text", bg: "accent-soft", min: TEXT_MIN },
  { fg: "text", bg: "selection", min: TEXT_MIN },
  { fg: "control", bg: "accent-soft", min: NON_TEXT_MIN },
];

/**
 * Pairs that must never carry meaning (A5 3.19): hairlines against any surface are decorative,
 * and late against due-soon differs only a little, so the two always differ by text and glyph too.
 * The styles test checks that no rule draws text in a hairline colour.
 */
export const DECORATIVE_PAIRS: readonly (readonly [Token, Token])[] = [
  ...(["line", "line-strong"] as const).flatMap((fg) => SURFACES.map((bg) => [fg, bg] as const)),
  ["late", "due"],
];

const HEX = /^#[0-9a-f]{6}$/i;

/** Checks a theme's data (A5 3.19 "validated on write"): the theme, or what is wrong with it. */
export function validateTheme(data: unknown): { theme?: Theme; problems: string[] } {
  const problems: string[] = [];
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { problems: ["a theme is an object"] };
  }
  const { name, scheme, tokens } = data as Record<string, unknown>;
  if (typeof name !== "string" || !(THEME_NAMES as readonly string[]).includes(name)) {
    problems.push("name: not a theme of this version");
  }
  if (scheme !== "dark" && scheme !== "light") problems.push("scheme: dark or light");
  if (typeof tokens !== "object" || tokens === null || Array.isArray(tokens)) {
    problems.push("tokens: an object");
    return { problems };
  }
  const given = tokens as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    if (!(TOKENS as readonly string[]).includes(key)) problems.push(`${key}: not a token`);
  }
  for (const token of TOKENS) {
    const value = given[token];
    if (value === undefined) problems.push(`${token}: missing`);
    else if (typeof value !== "string" || !HEX.test(value)) problems.push(`${token}: not #rrggbb`);
  }
  if (problems.length > 0) return { problems };
  return { theme: data as Theme, problems };
}

/** WCAG 2.x relative luminance of `#rrggbb`. */
export function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const c = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG 2.x contrast ratio of two colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The allowed pairs a theme fails, each with its ratio. Empty means the theme passes. */
export function contrastFailures(theme: Theme): { pair: Pair; ratio: number }[] {
  return ALLOWED_PAIRS.map((pair) => ({
    pair,
    ratio: contrast(theme.tokens[pair.fg], theme.tokens[pair.bg]),
  })).filter(({ pair, ratio }) => ratio < pair.min);
}

const declarations = (theme: Theme, indent: string): string =>
  [
    `${indent}color-scheme: ${theme.scheme};`,
    ...TOKENS.map((token) => `${indent}--k-${token}: ${theme.tokens[token]};`),
  ].join("\n");

/**
 * The stylesheet's theme rules. Sumi is the default and needs no attribute (D17); `data-theme` on
 * the root element picks Washi, or `system`, which follows `prefers-color-scheme` live and maps
 * light to Washi, anything else to Sumi.
 */
export function themeCss(sumi: Theme, washi: Theme): string {
  return [
    "/* Generated at build time from src/theme/*.json (tokens.ts). */",
    `:root {\n${declarations(sumi, "  ")}\n}`,
    `:root[data-theme="washi"] {\n${declarations(washi, "  ")}\n}`,
    `@media (prefers-color-scheme: light) {\n  :root[data-theme="system"] {\n${declarations(washi, "    ")}\n  }\n}`,
    "",
  ].join("\n");
}
