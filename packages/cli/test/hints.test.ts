// No message sends a person to a command that does not exist. Every string in the code a person
// reads that names `tasks <word>` (or `${CLI_NAME} <word>`) in a command's place names a command of
// the verb table, and, for a command that takes a subcommand, one it takes. A string is read from
// the code's syntax tree, so comments, which may name a command a later step builds, are not read.
// Only a command's place is read, so ordinary English about tasks ("the user's tasks live in …")
// needs no list of allowed words.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { CLI_SPEC } from "../src/args.ts";
import { LOCAL_COMMANDS } from "../src/help.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
/** Every package whose text a person reads: the faces, and what they print or show. */
const SOURCES = [
  "packages/cli/src",
  "packages/service/src",
  "packages/bridge/src",
  "packages/web/src",
  "packages/launch/src",
  "packages/runs/src",
  "packages/contracts/src",
];

/**
 * Where a message tells the person to run a command, the text just before `tasks`: after "run",
 * "with:", a backtick or a quote. Every word there is checked.
 */
const RUN_PLACE = /(?:\brun:?\s+|\bwith:\s+|[`"'])$/i;
/**
 * Where a message names a command, by itself or in a sentence about it: the start of the string or
 * of a line, after a colon, a semicolon, a full stop, "then" or an opening parenthesis. There a
 * word of ABOUT may follow the command's name.
 */
const NAME_PLACE = /(?:(?:^|\n)\s*|[:;.]\s+|\bthen\s+|\()$/i;
/** Words that follow a command's name in a sentence about it: "ttasks open takes --space". */
const ABOUT = new Set(
  "answered asks cannot does has is needs prints runs says shows starts takes works writes".split(
    " ",
  ),
);
/** Hidden verbs that the router knows besides the table (A4 3.6.3's shim). */
const HIDDEN = new Set(["shim"]);

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** The text of every string in a file, a template's substitutions as `tasks` when they name it. */
function strings(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    false,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const cli = (expression: ts.Expression): string =>
    /^(CLI_NAME|cli|CLI)$/.test(expression.getText(source)) ? "tasks" : "\u0000";
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) found.push(node.text);
    else if (ts.isJsxText(node)) found.push(node.text);
    else if (ts.isTemplateExpression(node)) {
      found.push(
        node.head.text +
          node.templateSpans.map((span) => cli(span.expression) + span.literal.text).join(""),
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * The commands a text names in a command's place that the verb table does not have, as
 * `tasks <word> [<word>]`. Elsewhere `tasks` is English or SQL's table, and not read.
 */
export function unknownCommands(text: string): string[] {
  const verbs = new Set(CLI_SPEC.verbs.map((v) => v.verb));
  const wrong: string[] = [];
  for (const m of text.matchAll(/\btasks ([a-z][a-z0-9-]*)(?: ([a-z][a-z0-9-]*))?/g)) {
    const [, word = "", next] = m;
    const before = text.slice(0, m.index);
    const strict = RUN_PLACE.test(before);
    const local = LOCAL_COMMANDS.find((c) => c.name === word);
    // A command that takes a subcommand is no English word after "tasks": its subcommand is
    // checked wherever it stands ("add it with ttasks roots add").
    const named = local?.subcommands !== undefined && next !== undefined;
    if (!strict && !named && !NAME_PLACE.test(before)) continue;
    if (local === undefined) {
      if (!verbs.has(word) && !HIDDEN.has(word) && (strict || !ABOUT.has(word))) {
        wrong.push(`ttasks ${word}`);
      }
      continue;
    }
    const subs = local.subcommands;
    if (
      subs !== undefined &&
      next !== undefined &&
      !subs.includes(next) &&
      (strict || !ABOUT.has(next))
    ) {
      wrong.push(`ttasks ${word} ${next}`);
    }
  }
  return wrong;
}

describe("[A2.3.10.cli.hints] every command a message names exists", () => {
  test("the check finds a command that does not exist", () => {
    expect(unknownCommands("Run: ttasks service reload")).toEqual(["ttasks service reload"]);
    expect(unknownCommands("Restart it with `ttasks restart`.")).toEqual(["ttasks restart"]);
    expect(unknownCommands("Run: ttasks service stop, then ttasks service start")).toEqual([]);
    expect(unknownCommands("Run: ttasks service restart")).toEqual([]);
    expect(unknownCommands("Several tasks in Mira have its source key")).toEqual([]);
    expect(unknownCommands("ttasks space has no command like that")).toEqual([]);
    expect(unknownCommands("tasks has no command like that")).toEqual([]);
    // Where a message tells the person to run something, every word is checked.
    expect(unknownCommands("Run: ttasks get M-1")).toEqual(["ttasks get"]);
    expect(unknownCommands("Try `tasks match M-1`.")).toEqual(["tasks match"]);
    expect(unknownCommands("Run: ttasks service is")).toEqual(["ttasks service is"]);
    // Where it names a command, a missing one is found too.
    expect(unknownCommands("tasks spaces list")).toEqual(["tasks spaces"]);
    expect(unknownCommands("Usage:\n  ttasks space mend <folder>")).toEqual(["ttasks space mend"]);
    expect(unknownCommands("Fix it first. tasks mend does the rest.")).toEqual(["ttasks mend"]);
    expect(unknownCommands("Recover it with: ttasks space mend <folder>.")).toEqual([
      "ttasks space mend",
    ]);
    expect(unknownCommands("It ran (ttasks repair --all).")).toEqual(["ttasks repair"]);
    expect(unknownCommands("Stop it, then ttasks service reload.")).toEqual([
      "ttasks service reload",
    ]);
    // A command that takes a subcommand is checked mid-sentence too.
    expect(unknownCommands("Fix it with tasks view mend <folder>.")).toEqual(["ttasks view mend"]);
    expect(unknownCommands("Add it with ttasks space open <folder>.")).toEqual([]);
    // English about tasks and SQL's table are not in a command's place, whatever their words.
    expect(unknownCommands("those tasks get no owner")).toEqual([]);
    expect(unknownCommands("- The user's tasks live in the space.")).toEqual([]);
    expect(unknownCommands("Two tasks match this folder.")).toEqual([]);
    expect(unknownCommands("SELECT id FROM tasks t")).toEqual([]);
    expect(unknownCommands("SELECT failed. Run: ttasks get M-1")).toEqual(["ttasks get"]);
  });

  test("no string in the code names a command the verb table does not have", () => {
    const wrong: string[] = [];
    for (const dir of SOURCES) {
      for (const path of files(join(REPO, dir))) {
        for (const text of strings(path)) {
          for (const command of unknownCommands(text)) {
            wrong.push(`${relative(REPO, path)}: ${command}`);
          }
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});
