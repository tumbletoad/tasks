// The message catalogue (A5 3.23): every message is ICU that FormatJS formats, every message is
// used, and no message spells out a product name, so the rename touches packages/brand only.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createIntl } from "react-intl";
import { describe, expect, test } from "vitest";
import { APP_NAME, CLI_NAME, PRODUCT_NAME } from "@tasks/brand";
import en from "../src/i18n/en.json" with { type: "json" };

// As intl.tsx gives them to every message (the page's module is JSX, outside this project): inside
// its own page the app is called by the name inside the app (PLAN.md Q).
const CATALOGUE: Readonly<Record<string, string>> = en;
const SOURCE_LOCALE = "en";
const BRAND_VALUES = { product: APP_NAME, cli: CLI_NAME };

/**
 * Whether a message spells out one of the product's names: the product's full name or the name
 * inside the app, in their own letter case, or the command where a message runs it. The command
 * `tasks` is also the domain's plural ("2 tasks"), so the word alone is not a name.
 */
const spellsName = (text: string): boolean =>
  new RegExp(`\\b(?:${PRODUCT_NAME}|${APP_NAME})\\b`).test(text) ||
  new RegExp(`(?:\\bRun |\`)${CLI_NAME}\\b`, "i").test(text);

const SRC = join(import.meta.dirname, "..", "src");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** A value for every argument the catalogue's messages take. */
const SAMPLE = {
  ...BRAND_VALUES,
  view: "Today",
  space: "Mira",
  name: "Mira",
  count: 2,
  title: "Fix appointment time zones",
  label: "Claude Code",
  reason: "no terminal",
  status: "waiting",
  weekday: "Sat",
  day: 14,
  month: "Nov",
  year: "2027",
  date: "Friday 13 November",
  time: "10:30",
  days: 2,
  n: 3,
  level: 1,
  person: "Tom Haas",
  text: "Wrong appointment times since Sunday · Ana Reyes",
  domain: "mail.example",
  machine: "mira-desktop",
  by: "Codex",
  what: "Codex prepared the changelog",
  why: "needs_recovery",
  way: "Recover it.",
  actor: "Codex",
  who: "Ana Reyes",
  ref: "LUM-212",
  url: "https://mail.example/m/1",
  kind: "email",
  area: "Client work",
  project: "Lumen Health",
  age: "3d",
  where: "Ghostty, the desktop's default",
  terminal: "ghostty",
  source: "desktop",
  value: "P1",
  wrote: "P1",
  now: "P2",
  restore: "P3",
  field: "the due date",
  at: Date.UTC(2026, 10, 12, 9, 40),
  filters: "status:open p<=2",
  message: "Unknown filter colour.",
  open: 3,
  done: 1,
  more: "yes",
  version: "0.2.0",
  running: "0.1.0",
};

describe("[A5.3.23.web.catalogue] the page's message catalogue", () => {
  test("every message is ICU that FormatJS formats in the source locale", () => {
    const errors: string[] = [];
    const intl = createIntl({
      locale: SOURCE_LOCALE,
      messages: CATALOGUE,
      onError: (error) => errors.push(error.message),
    });
    for (const id of Object.keys(CATALOGUE)) {
      const text = intl.formatMessage({ id }, SAMPLE);
      expect(text, id).not.toBe(id);
      expect(text, id).not.toMatch(/[{}]/);
    }
    expect(errors).toEqual([]);
    // Plurals and selects are ICU's, never built by hand.
    expect(intl.formatMessage({ id: "nav.counted" }, { view: "Waiting", count: 1 })).toBe(
      "Waiting, 1 task",
    );
    expect(intl.formatMessage({ id: "nav.counted" }, { view: "Waiting", count: 2 })).toBe(
      "Waiting, 2 tasks",
    );
    expect(
      intl.formatMessage({ id: "row.desc.late" }, { days: 1, date: "Friday 13 November" }),
    ).toBe("1 day late, due Friday 13 November");
    expect(intl.formatMessage({ id: "list.updated" }, { count: 3, actor: "Codex" })).toBe(
      "3 tasks updated by Codex",
    );
  });

  test("every message is used by the page, and no message spells out a product name", () => {
    const code = sources(SRC)
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    const unused = Object.keys(CATALOGUE).filter((id) => !code.includes(`"${id}"`));
    expect(unused).toEqual([]);
    const named = Object.entries(CATALOGUE).filter(([, text]) => spellsName(text));
    expect(named).toEqual([]);
    // The rule itself: names and a command it runs are caught, the domain's plural is not.
    expect(
      [
        `${PRODUCT_NAME} was updated.`,
        `${APP_NAME} work folder`,
        `Run ${CLI_NAME} open to sign in.`,
        `run \`${CLI_NAME} doctor\``,
      ].map(spellsName),
    ).toEqual([true, true, true, true]);
    expect(spellsName("{count, plural, one {# task} other {# tasks}} updated by {actor}")).toBe(
      false,
    );
  });
});
