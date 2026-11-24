// The message catalogue (A5 3.23): every message is ICU that FormatJS formats, every message is
// used, and no message spells out a product name, so the rename touches packages/brand only.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createIntl } from "react-intl";
import { describe, expect, test } from "vitest";
import { CLI_NAME, MONITOR_COMMAND, MONITOR_NAME, PRODUCT_NAME } from "@ttasks/brand";
import en from "../src/i18n/en.json" with { type: "json" };

// As intl.tsx gives them to every message (the page's module is JSX, outside this project).
const CATALOGUE: Readonly<Record<string, string>> = en;
const SOURCE_LOCALE = "en";
const BRAND_VALUES = {
  product: PRODUCT_NAME,
  cli: CLI_NAME,
  monitor: MONITOR_NAME,
  monitorCli: MONITOR_COMMAND,
};

/** Whether a message spells out the product's name, or the command where a message runs it. */
const spellsName = (text: string): boolean =>
  new RegExp(`\\b${PRODUCT_NAME}\\b`).test(text) ||
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
  words: "agent exited",
  status: "waiting",
  weekday: "Sat",
  day: 14,
  month: "Nov",
  year: "2027",
  date: "Friday 13 November",
  time: "10:30",
  days: 2,
  weeks: 15,
  years: 2,
  n: 3,
  level: 1,
  person: "Tom Haas",
  text: "Wrong appointment times since Sunday · Ana Reyes",
  domain: "mail.example",
  machine: "mira-desktop",
  folder: "~/work/portal",
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
  claim: "yes",
  terminal: "ghostty",
  source: "desktop",
  value: "P1",
  effort: "S",
  wrote: "P1",
  now: "P2",
  restore: "P3",
  field: "the due date",
  at: Date.UTC(2026, 10, 12, 9, 40),
  backup: "daily-20261112T030000.000Z-e1-s42.db.gz",
  filters: "status:open p<=2",
  message: "Unknown filter colour.",
  open: 3,
  done: 1,
  more: "yes",
  search: "Ctrl K",
  version: "0.2.0",
  running: "0.1.0",
  prefix: "W",
  host: "codex_app",
  file: "~/.claude.json",
  part: "tools",
  on: "yes",
  fix: "yes",
  off: "yes",
  unconfirmed: "yes",
  several: "yes",
  apps: "Codex",
  of: "project",
  owners: "the project Billing",
  repo: "portal-web",
  left: 1_200,
  max: 20_000,
  sub: "1 today",
  names: "M-14, Billing",
  stayed: 2,
  because: "not_in_new_folder",
  kept: "M-15, Docs",
  opened: "yes",
  limit: "wall",
  ran: "2 min",
  hours: 1,
  minutes: 5,
  app: "claude",
  state: "working",
  side: "older",
  percent: 40,
  started: "yes",
  when: "14:02",
  place: "Open",
  group: "Lumen / Portal",
  holder: "M-20",
  already: 1,
  later: 1,
  a: "Codex",
  b: "a run",
  c: "Ana Reyes",
  rest: 2,
  tasks: "LUM-212 and LUM-214",
  home: "~/.codex",
  timed: "yes",
  described: "yes",
  about: "One long sitting",
  amount: 4,
  unit: "hours",
};

describe("[A5.3.23.web.catalogue] the page's message catalogue", () => {
  test("the catalogue file names each message once: a second one would silently replace the first", () => {
    const raw = readFileSync(join(SRC, "i18n", "en.json"), "utf8");
    // Each message is one line of the flat file, so a key is what opens a line.
    const keys = [...raw.matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*:/gm)].map((m) => m[1]);
    expect(keys).toHaveLength(Object.keys(CATALOGUE).length);
    expect(keys.filter((key, i) => keys.indexOf(key) !== i)).toEqual([]);
  });

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
    // A folder's toast says why the folders inside the old one stayed.
    const folderSet = (values: Record<string, string | number>) =>
      intl.formatMessage(
        { id: "toast.folderSet" },
        { folder: "~/new", count: 0, names: "", stayed: 0, because: "", kept: "", ...values },
      );
    expect(folderSet({ count: 1, names: "M-1" })).toBe(
      "Folder set to ~/new. 1 folder inside the old one moved along: M-1",
    );
    expect(
      folderSet({
        count: 1,
        names: "M-1",
        stayed: 2,
        because: "not_in_new_folder",
        kept: "M-2, Docs",
      }),
    ).toBe(
      "Folder set to ~/new. 1 folder inside the old one moved along: M-1. 2 folders inside the old one are not in the new one and stayed: M-2, Docs",
    );
    expect(folderSet({ stayed: 1, because: "old_folder_there", kept: "M-2" })).toBe(
      "Folder set to ~/new. The old folder is still there, so 1 folder inside it stayed: M-2",
    );
    expect(folderSet({ stayed: 1, because: "old_folder_unseen", kept: "M-2" })).toBe(
      "Folder set to ~/new. The old folder cannot be seen and nothing shows the new one is it, so 1 folder inside it stayed: M-2",
    );
    expect(folderSet({ stayed: 2, because: "unchecked", kept: "M-2, Docs" })).toBe(
      "Folder set to ~/new. A folder could not be checked, so 2 folders inside the old one stayed: M-2, Docs",
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
        `${PRODUCT_NAME} work folder`,
        `Run ${CLI_NAME} open to sign in.`,
        `run \`${CLI_NAME} doctor\``,
      ].map(spellsName),
    ).toEqual([true, true, true, true]);
    expect(spellsName("{count, plural, one {# task} other {# tasks}} updated by {actor}")).toBe(
      false,
    );
  });
});
