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
import { atomicWrite, createFile, makeDir, writeAll } from "@ttasks/files";
import { hostFacts, LayoutError, resolveLayout } from "@ttasks/service/paths";
import {
  DEFAULTS,
  listLine,
  listSkills,
  readSkills,
  SKILL_BYTES,
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
  copy <name>  Write a default's text into your skills folder, to edit. A file of yours
               there is never replaced: it counts as made from today's default
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

/**
 * Where `copy` keeps the default each copy was made from, so a change of the default since can be
 * marked and shown. Agents never read it: the skills folder's listing passes over dot names.
 */
const COPIED_FROM = ".copied-from";

const copiedFrom = (folder: string, name: string) => join(folder, COPIED_FROM, `${name}.md`);

/** A file's text, or undefined when it is missing, a link, not a regular file or over the limit. */
function readText(path: string): string | undefined {
  try {
    const kind = lstatSync(path, { throwIfNoEntry: false });
    if (kind?.isFile() !== true || kind.size > SKILL_BYTES) return undefined;
    return readFileSync(path, "utf8").replaceAll("\r\n", "\n");
  } catch {
    return undefined;
  }
}

/**
 * How the default stands to the person's copy of it: the `same` as when the copy was made,
 * `changed` since (with the default as it was then), or `unknown` when no record says which
 * default the copy was made from. Undefined for a skill that is no edited default.
 */
type Change =
  | { readonly state: "same" }
  | { readonly state: "changed"; readonly before: string }
  | { readonly state: "unknown" };

function changeOf(folder: string, skill: Skill): Change | undefined {
  const shipped = DEFAULTS.get(skill.name);
  if (skill.origin !== "edited" || shipped === undefined) return undefined;
  // A linked record folder could bring any text in as the default; `copy` refuses it too.
  const linked = lstatSync(join(folder, COPIED_FROM), { throwIfNoEntry: false })?.isSymbolicLink();
  const before = linked === true ? undefined : readText(copiedFrom(folder, skill.name));
  if (before === undefined) return { state: "unknown" };
  return before === shipped.file ? { state: "same" } : { state: "changed", before };
}

/** A skill's state as a person reads it. */
function stateOf(skill: Skill, change: Change | undefined): string {
  if (skill.problem !== undefined) {
    return skill.origin === "own"
      ? `cannot be used: ${skill.problem}`
      : `default, your file is not used: ${skill.problem}`;
  }
  if (skill.origin === "own") return "yours";
  const diff = `${CLI_NAME} skills diff ${skill.name}`;
  if (change?.state === "changed") return `edited, and the default changed since: ${diff}`;
  if (change?.state === "unknown") {
    return `edited, from a default ${PRODUCT_NAME} has no record of: ${diff} compares it with today's`;
  }
  return skill.origin;
}

/**
 * The lines of `after` against `before`, with two lines around each change: "- " a line that went,
 * "+ " a line that came, "  " one that stayed, and "..." where unchanged lines are left out.
 */
function lineDiff(before: string, after: string): string[] {
  const a = before.split("\n");
  const b = after.split("\n");
  // The longest common subsequence from each pair of positions on.
  const common = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  const at = (i: number, j: number): number => common[i]?.[j] ?? 0;
  for (let i = a.length - 1; i >= 0; i -= 1) {
    const row = common[i] ?? [];
    for (let j = b.length - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const lines: string[] = [];
  for (let i = 0, j = 0; i < a.length || j < b.length;) {
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
  lines.forEach((line, k) => {
    if (near(k)) shown.push(line);
    // One "..." for each run of lines left out.
    else if (k === 0 || near(k - 1)) shown.push("...");
  });
  return shown;
}

const defaultNames = () => [...DEFAULTS.keys()].sort(sortName).join(", ");

async function diff(io: Io, globals: Globals, folder: string, name: string): Promise<number> {
  const shipped = DEFAULTS.get(name);
  if (shipped === undefined) {
    return printUsage(
      io,
      globals.json,
      `${CLI_NAME} skills diff takes a default skill: ${defaultNames()}`,
    );
  }
  const [skill] = (await readSkills(folder, [name], LIST_WITHIN_MS)).skills;
  const change = skill === undefined ? undefined : changeOf(folder, skill);
  const path = skill?.path;
  if (change === undefined || path === undefined) {
    if (globals.json) io.stdout(`${JSON.stringify({ name, state: "no_copy" })}\n`);
    else {
      const why = skill?.problem === undefined ? "" : ` Your file is not used: ${skill.problem}.`;
      io.stdout(`Your agents get the default ${name}: you have no copy of it in use.${why}\n`);
    }
    return 0;
  }
  const lines =
    change.state === "same"
      ? []
      : change.state === "changed"
        ? lineDiff(change.before, shipped.file)
        : lineDiff(readText(path) ?? "", shipped.file);
  if (globals.json) {
    io.stdout(`${JSON.stringify({ name, state: change.state, path, lines })}\n`);
    return 0;
  }
  if (change.state === "same") {
    io.stdout(`The default ${name} has not changed since your copy was made from it.
`);
    return 0;
  }
  const heading =
    change.state === "changed"
      ? `What changed in the default ${name} since your copy was made from it:`
      : `${PRODUCT_NAME} has no record of the default your copy of ${name} was made from. Your copy against today's default:`;
  io.stdout(
    `${[
      heading,
      "",
      ...lines,
      "",
      `Your copy: ${path}`,
      `Take over what you want, then run ${CLI_NAME} skills copy ${name}: it keeps your copy, and counts it as made from today's default.`,
    ].join("\n")}\n`,
  );
  return 0;
}

/** How long a person waits for a slow skills folder before the list goes on without it. */
const LIST_WITHIN_MS = 30_000;

async function list(io: Io, globals: Globals, folder: string): Promise<number> {
  const { skills, unread } = await listSkills(folder, LIST_WITHIN_MS);
  if (globals.json) {
    const rows = skills.map((skill) => {
      const change = changeOf(folder, skill)?.state;
      return {
        name: skill.name,
        origin: skill.origin,
        ...(skill.description === "" ? {} : { when: skill.description }),
        ...(skill.path === undefined ? {} : { path: skill.path }),
        ...(skill.problem === undefined ? {} : { problem: skill.problem }),
        ...(change === undefined ? {} : { default_since_copy: change }),
      };
    });
    io.stdout(`${JSON.stringify({ folder, skills: rows, ...(unread === 0 ? {} : { unread }) })}\n`);
    return 0;
  }
  const width = Math.max(...skills.map((skill) => skill.name.length));
  const lines = [`Your skills folder: ${folder}`, ""];
  const pad = " ".repeat(width);
  for (const skill of skills) {
    lines.push(`${skill.name.padEnd(width)}  ${stateOf(skill, changeOf(folder, skill))}`);
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
    return printUsage(
      io,
      globals.json,
      `${CLI_NAME} skills copy takes a default skill: ${defaultNames()}. A skill of your own is a folder of its own in ${folder}`,
    );
  }
  const path = join(folder, name, SKILL_FILE);
  const record = copiedFrom(folder, name);
  // A copy goes into a real folder: in a linked one, the service would not read it.
  for (const dir of [folder, join(folder, name), join(folder, COPIED_FROM)]) {
    if (lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
      return printError(io, globals.json, {
        code: "invalid_input",
        message: `${dir} is a link, and ${PRODUCT_NAME} reads only real folders there`,
        hint: "Make it a real folder, then copy again.",
      });
    }
  }
  makeDir(join(folder, name), 0o700);
  makeDir(join(folder, COPIED_FROM), 0o700);
  const said = (written: boolean, text: string) => {
    io.stdout(globals.json ? `${JSON.stringify({ path, written })}\n` : `${text}\n`);
    return 0;
  };
  let fd: number;
  try {
    fd = createFile(path, 0o600, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // The person's file is theirs whatever it holds: only the record of the default moves on.
    atomicWrite(record, skill.file, 0o600);
    return said(
      false,
      `Your copy at ${path} is kept as it is, and now counts as made from today's default. For today's default instead, remove your file: your agents get the default again, and ${CLI_NAME} skills copy ${name} writes it fresh.`,
    );
  }
  try {
    writeAll(fd, skill.file);
  } finally {
    closeSync(fd);
  }
  atomicWrite(record, skill.file, 0o600);
  return said(true, `Wrote ${path}. Edit it: your agents read it at their next call.`);
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
