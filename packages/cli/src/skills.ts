// `ttasks skills`: a person's way to their skills until the page has an editor. It lists them and
// writes a default's text into the TTasks home to start from, both from the files alone, so they
// work without a service; `show` asks the service, which adds the space's sizes as agents get them.
//
//   ttasks skills
//   ttasks skills show <name>
//   ttasks skills copy <name>
//   ttasks skills diff <name>
import { closeSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLI_NAME, DATA_FOLDER, PRODUCT_NAME, SKILLS_FOLDER } from "@ttasks/brand";
import { createFile, makeDir, writeAll } from "@ttasks/files";
import { hostFacts, LayoutError, resolveLayout } from "@ttasks/service/paths";
import {
  copyText,
  defaultChange,
  DEFAULTS,
  listLine,
  listSkills,
  readSkills,
  SKILL_FILE,
  SKILL_FOLDERS,
  SKILL_LIST_ROWS,
  type Skill,
} from "@ttasks/service/skills";
import { verbSpec, type Globals } from "./args.ts";
import type { ConnectOptions } from "./connect.ts";
import type { Io } from "./io.ts";
import { printError, printUsage } from "./output.ts";
import { runVerb } from "./verbs.ts";

/** `ttasks skills --help` and `ttasks help skills`. */
export const SKILLS_HELP = `Usage: ${CLI_NAME} skills [--json]
       ${CLI_NAME} skills show <name>
       ${CLI_NAME} skills copy <name>
       ${CLI_NAME} skills diff <name>

Skills tell your agents how you want tasks sized, sorted and worked on. Each agent app with
${PRODUCT_NAME}'s tools reads them through ${PRODUCT_NAME}: ${PRODUCT_NAME}'s own part (which tool,
which fields), then yours. Your file ~/${DATA_FOLDER}/${SKILLS_FOLDER}/<name>/${SKILL_FILE} replaces a
default's part, or is a skill of your own when no default has its name. Agents read a change at
their next call.

  (none)       List the skills: default, edited, yours, and files that cannot be used, with why
  show <name>  Print a skill as an agent gets it, with the space's sizes (asks the service)
  copy <name>  Write a default's text into your skills folder, to edit
  diff <name>  What changed in a default since your copy was made from it
`;

const sortName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The person's skills folder, from the same layout the service uses (it honours TTASKS_HOME). */
function skillsFolder(io: Io): string | undefined {
  try {
    return resolveLayout(hostFacts(io.env, io.platform)).skills;
  } catch (error) {
    if (error instanceof LayoutError) return undefined;
    throw error;
  }
}

/** A skill's state as a person reads it. */
function stateOf(skill: Skill): string {
  if (skill.problem !== undefined) {
    return skill.origin === "own"
      ? `cannot be used: ${skill.problem}`
      : `default, your file is not used: ${skill.problem}`;
  }
  if (skill.origin === "own") return "yours";
  const change = defaultChange(skill)?.state;
  return change === "changed"
    ? `edited, and the default changed since: ${CLI_NAME} skills diff ${skill.name}`
    : change === "unknown"
      ? `edited, from a default this build does not know: ${CLI_NAME} skills diff ${skill.name}`
      : skill.origin;
}

/**
 * The lines of `after` against `before`, with two lines around each change: "- " a line that went,
 * "+ " a line that came, "  " one that stayed, and "..." where unchanged lines are left out.
 */
export function lineDiff(before: string, after: string): string[] {
  const a = before.split("\n");
  const b = after.split("\n");
  // The longest common subsequence from each pair of positions on.
  const common = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  const at = (i: number, j: number): number => common[i]?.[j] ?? 0;
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const row = common[i];
      if (row !== undefined) {
        row[j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
      }
    }
  }
  const lines: string[] = [];
  for (let i = 0, j = 0; i < a.length || j < b.length; ) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push(`  ${a[i] ?? ""}`);
      i += 1;
      j += 1;
    } else if (j >= b.length || (i < a.length && at(i + 1, j) >= at(i, j + 1))) {
      lines.push(`- ${a[i] ?? ""}`);
      i += 1;
    } else {
      lines.push(`+ ${b[j] ?? ""}`);
      j += 1;
    }
  }
  const near = (k: number) =>
    lines.slice(Math.max(0, k - 2), k + 3).some((line) => !line.startsWith("  "));
  const shown: string[] = [];
  let left = false;
  lines.forEach((line, k) => {
    if (!near(k)) {
      left = true;
      return;
    }
    if (left && shown.length > 0) shown.push("...");
    left = false;
    shown.push(line);
  });
  return shown;
}

async function diff(io: Io, globals: Globals, folder: string, name: string): Promise<number> {
  if (!DEFAULTS.has(name)) {
    return printUsage(io, globals.json, `${CLI_NAME} skills diff takes a default skill`);
  }
  const [skill] = (await readSkills(folder, [name], LIST_WITHIN_MS)).skills;
  const change = skill === undefined ? undefined : defaultChange(skill);
  if (skill === undefined || change === undefined) {
    io.stdout(`You have no copy of ${name} that is used: agents get the default.\n`);
    return 0;
  }
  if (change.state === "current") {
    io.stdout(`Your copy of ${name} was made from this build's default: it has not changed since.\n`);
    return 0;
  }
  const lines =
    change.state === "changed"
      ? [`What changed in the default ${name} since your copy was made from it:`, "", ...lineDiff(change.before, change.after)]
      : [
          `Your copy of ${name} names a default this build does not have. Your copy against today's default:`,
          "",
          ...lineDiff(readFileSync(skill.path ?? "", "utf8").replaceAll("\r\n", "\n"), change.after),
        ];
  lines.push(
    "",
    `Your copy: ${skill.path ?? ""}`,
    `Take over what you want. Then set ttasks-default: ${change.id} under metadata in its front matter, and the mark goes.`,
  );
  io.stdout(`${lines.join("\n")}\n`);
  return 0;
}

/** How long a person waits for a slow skills folder before the list goes on without it. */
const LIST_WITHIN_MS = 30_000;

async function list(io: Io, globals: Globals, folder: string): Promise<number> {
  const { skills, unread } = await listSkills(folder, LIST_WITHIN_MS);
  if (globals.json) {
    const rows = skills.map((skill) => ({
      name: skill.name,
      origin: skill.origin,
      ...(skill.description === "" ? {} : { when: skill.description }),
      ...(skill.path === undefined ? {} : { path: skill.path }),
      ...(skill.problem === undefined ? {} : { problem: skill.problem }),
    }));
    io.stdout(`${JSON.stringify({ folder, skills: rows, ...(unread === 0 ? {} : { unread }) })}\n`);
    return 0;
  }
  const width = Math.max(...skills.map((skill) => skill.name.length));
  const lines = [`Your skills folder: ${folder}`, ""];
  const pad = " ".repeat(width);
  for (const skill of skills) {
    lines.push(`${skill.name.padEnd(width)}  ${stateOf(skill)}`);
    if (skill.description !== "") {
      lines.push(`${pad}  ${skill.description}`);
      const unused = skill.problem !== undefined;
      if (!listLine(skill.name, skill.description, unused).endsWith(skill.description)) {
        lines.push(`${pad}  (agents see this cut short in their list)`);
      }
    }
    if (skill.origin !== "default" && skill.path !== undefined) {
      lines.push(`${pad}  ${skill.path}`);
    }
  }
  if (skills.length > SKILL_LIST_ROWS) {
    lines.push(
      "",
      `Agents' list shows at most ${String(SKILL_LIST_ROWS)}. They read the others only by name.`,
    );
  }
  if (unread > 0) {
    lines.push(
      "",
      `${String(unread)} more folders are not read: ${PRODUCT_NAME} reads the first ${String(SKILL_FOLDERS)} by name.`,
    );
  }
  lines.push(
    "",
    `${CLI_NAME} skills copy <name> writes a default's text there to edit. A folder of your own with a ${SKILL_FILE} is a skill of yours.`,
  );
  io.stdout(`${lines.join("\n")}\n`);
  return 0;
}

function copy(io: Io, globals: Globals, folder: string, name: string): number {
  const skill = DEFAULTS.get(name);
  if (skill === undefined) {
    const defaults = [...DEFAULTS.keys()].sort(sortName).join(", ");
    return printUsage(
      io,
      globals.json,
      `${CLI_NAME} skills copy takes a default skill: ${defaults}. A skill of your own is a folder of its own in ${folder}`,
    );
  }
  const path = join(folder, name, SKILL_FILE);
  // A copy goes into a real folder: in a linked one, the service would not read it.
  for (const dir of [folder, join(folder, name)]) {
    if (lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
      return printError(io, globals.json, {
        code: "invalid_input",
        message: `${dir} is a link, and ${PRODUCT_NAME} reads only real folders there`,
        hint: "Make it a real folder, then copy again.",
      });
    }
  }
  makeDir(join(folder, name), 0o700);
  let fd: number;
  try {
    fd = createFile(path, 0o600, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (globals.json) io.stdout(`${JSON.stringify({ path, written: false })}\n`);
    else io.stdout(`Your copy is already at ${path}. It is unchanged.\n`);
    return 0;
  }
  try {
    writeAll(fd, copyText(skill));
  } finally {
    closeSync(fd);
  }
  if (globals.json) io.stdout(`${JSON.stringify({ path, written: true })}\n`);
  else io.stdout(`Wrote ${path}. Edit it: your agents read it at their next call.\n`);
  return 0;
}

export async function skillsCommand(
  io: Io,
  globals: Globals,
  args: readonly string[],
  options: ConnectOptions,
): Promise<number> {
  const [sub, name, ...rest] = args;
  const folder = skillsFolder(io);
  if (folder === undefined) {
    return printUsage(io, globals.json, `${PRODUCT_NAME}'s folders cannot be found`);
  }
  if (sub === undefined) return await list(io, globals, folder);
  if (!["show", "copy", "diff"].includes(sub) || name === undefined || rest.length > 0) {
    return printUsage(
      io,
      globals.json,
      `${CLI_NAME} skills takes nothing, show <name>, copy <name> or diff <name>`,
    );
  }
  if (sub === "copy") return copy(io, globals, folder, name);
  if (sub === "diff") return await diff(io, globals, folder, name);
  const status = verbSpec("status");
  if (status === undefined) throw new Error("status is no verb");
  return await runVerb(io, globals, status, ["--skill", name], options);
}
