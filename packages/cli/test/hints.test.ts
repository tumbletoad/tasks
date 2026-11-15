// No message sends a person to a command that does not exist (A2 3.10.1, A3 3.5). Every string in
// the CLI's, the service's and the bridge's code that names `tasks <word>` (or `${CLI_NAME} <word>`)
// names a command of the verb table, and, for a command that takes a subcommand, one it takes. A
// string is read from the code's syntax tree, so comments, which may name a command a later step
// builds, are not read. English after the command's name (`tasks space has no command …`) is
// allowed by a short list.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { CLI_SPEC } from "../src/args.ts";
import { LOCAL_COMMANDS } from "../src/help.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const SOURCES = ["packages/cli/src", "packages/service/src", "packages/bridge/src"];

/** Words that follow `tasks` in English, not a command: "tasks in the space". */
const PROSE = new Set(
  "a and are as at by command for has from get in into is its itself match named never of on or per placed still than that the to whose with without".split(
    " ",
  ),
);
/** Words that follow a command's name in a sentence about it: "tasks open takes --space". */
const ABOUT = new Set(
  "answered asks cannot does has is needs prints runs shows starts takes works writes".split(" "),
);
/** Hidden verbs that the router knows besides the table (A4 3.6.3's shim). */
const HIDDEN = new Set(["shim"]);

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

/** The text of every string in a file, a template's substitutions as `tasks` when they name it. */
function strings(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest);
  const found: string[] = [];
  const cli = (expression: ts.Expression): string =>
    /^(CLI_NAME|cli|CLI)$/.test(expression.getText(source)) ? "tasks" : "\u0000";
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) found.push(node.text);
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

/** The commands a text names that the verb table does not have, as `tasks <word> [<word>]`. */
export function unknownCommands(text: string): string[] {
  // SQL names the tasks table, never the command.
  if (/\b(SELECT|INSERT|UPDATE|DELETE|FROM|JOIN)\b/.test(text)) return [];
  const verbs = new Set(CLI_SPEC.verbs.map((v) => v.verb));
  const wrong: string[] = [];
  for (const m of text.matchAll(/(?:^|[\s`'"(:])tasks ([a-z][a-z0-9-]*)(?: ([a-z][a-z0-9-]*))?/g)) {
    const [, word = "", next] = m;
    const local = LOCAL_COMMANDS.find((c) => c.name === word);
    if (local === undefined) {
      if (!verbs.has(word) && !HIDDEN.has(word) && !PROSE.has(word)) wrong.push(`tasks ${word}`);
      continue;
    }
    const subs = local.subcommands;
    if (subs !== undefined && next !== undefined && !subs.includes(next) && !ABOUT.has(next)) {
      wrong.push(`tasks ${word} ${next}`);
    }
  }
  return wrong;
}

describe("[A2.3.10.cli.hints] every command a message names exists", () => {
  test("the check finds a command that does not exist", () => {
    expect(unknownCommands("Run: tasks service restart")).toEqual(["tasks service restart"]);
    expect(unknownCommands("Restart it with `tasks restart`.")).toEqual(["tasks restart"]);
    expect(unknownCommands("Run: tasks service stop, then tasks service start")).toEqual([]);
    expect(unknownCommands("Several tasks in Mira have its source key")).toEqual([]);
    expect(unknownCommands("tasks space has no command like that")).toEqual([]);
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
