import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { repositoryFiles } from "./machine-facts.ts";
import { repoRoot } from "./run.ts";

// The product's names before it was renamed, in the forms that can only mean the product. The
// word itself stays: it is also the domain's plural, and the stored format markers keep it.
const OLD_NAMES: readonly RegExp[] = [
  /\bTT(?: |%20)Tasks\b/,
  /(?<![\w.-])@tasks\//,
  // Environment variables, which Windows reads in any case, and the tokens' and IDs' prefixes.
  /(?<![A-Za-z0-9])TASKS_|(?<![A-Za-z0-9])Tasks_(?=[A-Z])/,
  /(?<![\w.-])tasks_(?:(?:home|lab|service_manager|package)\b|u_|a_)/i,
  // The data folder and the marker; a property on a continued line (`  .tasks`) is not one.
  /(?:[~%\\/"'`=(:]|\S )\.tasks\b|\\\.TASKS\\/,
  /\btasks(?:w|-run)?\.exe\b/i,
  /\btasksw\b/,
  /\btasks\.(?:service|sock)\b/,
  /\blocal\.tasks\./,
  /\bmcp__tasks(?:__|-|\b)|\bmcp(?:_s|S)ervers(?:\.tasks\b|\[["']tasks["']\])/,
  /\bmcp(?:_s|S)ervers["']?:\s*\{.*(?<![\w.-])tasks["']?:/,
  // tasks-build, tasks-local/1, tasks-*-linux-x64.*, tasks-@@VERSION@@, tasks-release.
  /(?<![\w.@-])tasks-(?=[\w<$([*@"'`])/,
  /(?<![\w.@/-])tasks\/(?:challenge|hello|bind|no-)/,
  /(?<=\b(?:bin|share)[\\/])tasks\b(?![.\w-])|(?<=[\\/])tasks(?=[\\/](?:bin|current|versions)\b)/,
  /(?<=(?:\.local[\\/]state|\.cache|\.config)[\\/])tasks\b/,
  // The command, where a verb only it has follows, or as code with a word after it.
  /(?<![\w.@$/-])tasks (?:has no command|service|space|doctor|setup|mcp|--[a-z]|<[a-z])/,
  /(?<=`)tasks (?:machine|project|session|proposals|security|policy|open|run|add|set|show|find|status|view|undo|redo|reopen|help|version|serve|install)\b/,
  // The name inside the app, where a singular verb follows it: the domain's plural takes none.
  /(?<![\w/\\.])Tasks(?:['’]s\b| (?:never |also |still |only |always |now )?(?:is|was|does|has)\b| (?:never|also|still|only|always|now) [a-z]+[^\Wsu]s\b| (?:that|which) (?:is|was|does|has|stops|starts|runs|changes|keeps|holds|knows|needs|writes|reads|opens|sees)\b)/,
];

// What keeps the old identifier on purpose: the repository's address and site; the approval hash's
// domain, which pins every approval in machine.toml; the sample generator's seed, which the frozen
// sample digests depend on; and the folder a machine keeps its test installs in.
const KEPT: readonly RegExp[] = [
  /tumbletoad(?:\.com)?\/tasks\b/g,
  /tasks-approval\/1/g,
  /tasks-mira:/g,
  /tasks-test\b/g,
];

/** This file, which spells the old forms to test that each is found. */
const SELF = "scripts/old-names.test.ts";

const hasOldName = (text: string): boolean => {
  const rest = KEPT.reduce((line, kept) => line.replace(kept, ""), text);
  return OLD_NAMES.some((re) => re.test(rest));
};

function oldNames(file: string, text: string): string[] {
  return text
    .split("\n")
    .flatMap((line, i) => (hasOldName(line) ? [`${file}:${String(i + 1)}: ${line.trim()}`] : []));
}

describe("[A7.3.2.brand.old-names] the product's earlier names do not come back", () => {
  test("no file in the repository uses one, in its text or its name", () => {
    const found = repositoryFiles(repoRoot).flatMap((file) => {
      if (file === SELF) return [];
      const named = hasOldName(file) ? [`${file}: its name`] : [];
      let bytes: Buffer;
      try {
        bytes = readFileSync(join(repoRoot, file));
      } catch {
        return named; // listed in the index but deleted in the working tree
      }
      return bytes.includes(0) ? named : [...named, ...oldNames(file, bytes.toString("utf8"))];
    });
    expect(found).toEqual([]);
  });

  test("finds each form, and lets the new names, the kept identifiers and the domain's plural pass", () => {
    const old = [
      "TT Tasks",
      "TT%20Tasks",
      "@tasks/brand",
      "TASKS_HOME",
      "Tasks_Home",
      "tasks_u_abc",
      "~/.tasks/spaces",
      "a .tasks-marker folder",
      "home=.tasks",
      "C:\\Users\\x\\.TASKS\\STATE",
      "bin\\tasksw.exe",
      "TASKS.EXE",
      "tasks.service",
      "local.tasks.service",
      "mcp__tasks__status",
      "mcp__tasks-probe__probe_echo",
      "--allowedTools mcp__tasks",
      "mcpServers.tasks",
      'mcpServers["tasks"]',
      "dist/tasks-*-linux-x64.*",
      "folder with tasks-@@VERSION@@-win-x64.zip",
      "tasks-local/1",
      '"method":"tasks/hello"',
      "tasks/no-shell-exec",
      "~/.local/share/tasks",
      "<root>/bin/tasks",
      "<state> ~/.local/state/tasks",
      "~/.cache/tasks",
      "tasks has no command misspelled",
      "Run: tasks doctor",
      "tasks --version",
      'mcpServers: { other: {}, tasks: { command: "x" } }',
      'command: "/opt/tasks/bin/ttasks"',
      "`tasks <command> --help`",
      "with `tasks session rebind`",
      "Tasks's own tools",
      "Tasks is not running",
      "- Tasks never changes another app's settings",
      "a launch that fails or a Tasks that stops",
    ];
    for (const line of old) expect(oldNames("x", line), line).toHaveLength(1);
    const current = [
      "TTasks",
      "@ttasks/brand",
      "TTASKS_HOME",
      "Ttasks_Home",
      "~/.ttasks/spaces",
      "ttasksw.exe",
      "local.ttasks.service",
      "mcp__ttasks__status",
      "dist/ttasks-*-linux-x64.*",
      "ttasks/hello",
      "ttasks has no command",
      "state.tasks.map(render)",
      "HAS_ACTIVE_TASKS",
      "tasks_space, tasks_backup and tasks_export",
      "the tasks of a space, sub-tasks-heavy, 3 tasks",
      "the `tasks` table, mcpServers: { ttasks: {} }, `${n} tasks moved`, `tasks is an integer`",
      "all tasks <= 5",
      "TTasks never changes, Tasks never change, Tasks that agents create, Tasks that pass",
      "https://github.com/tumbletoad/tasks-x and tumbletoad.com/tasks",
      "tasks-approval/1",
      "`tasks-mira:${String(seed)}`",
      "the tasks-test folder",
    ];
    for (const line of current) expect(oldNames("x", line), line).toEqual([]);
  });
});
