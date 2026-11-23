// The skills an agent can read: TTasks' defaults (the repository's `skills/`, compiled into
// generated/skills.json by `pnpm gen`) and the person's own files in `<TTasks home>/skills/`.
// The person's files are read at every request, so an edit reaches every agent app at once.
//
// A person's `skills/<name>/SKILL.md` replaces a default's text whole, or is a skill of their own
// when no default has its name. A file that cannot be used is never served in part: a default
// falls back to its own text, and either way the reason travels with the skill.
//
// Only real folders and regular files inside the skills folder count, the folder itself included:
// a link could bring text from anywhere as the person's instructions. Every read is bounded in
// bytes, in folders and in time, because a home folder may be on a network share.
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { CLI_NAME } from "@ttasks/brand";
import shipped from "../../generated/skills.json" with { type: "json" };
import { isSkillName, kib, parseSkill, SKILL_BYTES, SKILL_FILE } from "./format.ts";
import { TTASKS_PARTS, type SpaceFacts } from "./ttasks-part.ts";

export { isSkillName, SKILL_BYTES, SKILL_FILE } from "./format.ts";
export type { SpaceFacts } from "./ttasks-part.ts";

/** How long reading the person's skills may take before an answer goes on without them. */
export const SKILLS_WITHIN_MS = 2_000;
/** The most folders of the skills folder one list reads. */
export const SKILL_FOLDERS = 64;
/** The skill files read at the same time. */
const AT_ONCE = 8;

/** A default as it ships: its whole file, which `copy` writes for a person to start from. */
interface Default {
  readonly name: string;
  readonly file: string;
  readonly description: string;
  readonly body: string;
}

/** The defaults, in the generated file's order (by name). A broken one fails at load. */
export const DEFAULTS: ReadonlyMap<string, Default> = new Map(
  shipped.skills.map(({ name, file }) => {
    const parsed = parseSkill(new TextEncoder().encode(file));
    if (!parsed.ok || parsed.description === undefined || TTASKS_PARTS[name] === undefined) {
      throw new Error(`the default skill ${name} is not a skill this build can serve`);
    }
    return [name, { name, file, description: parsed.description, body: parsed.body }];
  }),
);

/**
 * One skill as an agent may read it. `default`: TTasks' text; `edited`: the person's copy of a
 * default; `own`: a skill of the person's that no default has.
 */
export interface Skill {
  readonly name: string;
  readonly origin: "default" | "edited" | "own";
  /** When to read it: the person's file's, else the default's. Empty when neither says. */
  readonly description: string;
  /** The person's part as served; undefined for a skill of the person's that cannot be used. */
  readonly body: string | undefined;
  /** The person's file or folder for this name, when there is one. */
  readonly path: string | undefined;
  /** Why the person's file is not used, when it is not. */
  readonly problem: string | undefined;
}

/** Every skill one list found. */
export interface Catalog {
  readonly skills: readonly Skill[];
  /** Folders of the skills folder past SKILL_FOLDERS, not read. */
  readonly unread: number;
}

type Found = { readonly path: string } & (
  | { readonly ok: true; readonly description: string | undefined; readonly body: string }
  | { readonly ok: false; readonly problem: string }
);

const codeOf = (error: unknown): string =>
  (error as NodeJS.ErrnoException | null)?.code ?? "an error";

const LINK = "it is a link, and only real folders and files in the skills folder are read";
const NO_FOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

/** A person's skill file: what it says, or why it cannot be used. Reads at most the limit + 1. */
async function readOne(path: string): Promise<Found> {
  const fail = (problem: string): Found => ({ path, ok: false, problem });
  try {
    const kind = await lstat(path);
    if (kind.isSymbolicLink()) return fail(LINK);
    if (!kind.isFile()) return fail(`its ${SKILL_FILE} is not a file`);
  } catch (error) {
    const code = codeOf(error);
    return fail(
      code === "ENOENT" ? `its folder has no ${SKILL_FILE}` : `it cannot be read (${code})`,
    );
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    const code = codeOf(error);
    return fail(code === "ELOOP" ? LINK : `it cannot be read (${code})`);
  }
  try {
    const bytes = Buffer.alloc(SKILL_BYTES + 1);
    let filled = 0;
    for (;;) {
      const { bytesRead } = await handle.read(bytes, filled, bytes.length - filled, filled);
      filled += bytesRead;
      if (bytesRead === 0 || filled === bytes.length) break;
    }
    if (filled > SKILL_BYTES) {
      const { size } = await handle.stat();
      return fail(`it is ${kib(Math.max(size, filled))}, over the limit of ${kib(SKILL_BYTES)}`);
    }
    return { path, ...parseSkill(bytes.subarray(0, filled)) };
  } catch (error) {
    return fail(`it cannot be read (${codeOf(error)})`);
  } finally {
    await handle.close();
  }
}

/** The skills folder: a real folder, none at all, or why it cannot be read. */
async function rootOf(folder: string): Promise<"folder" | "absent" | { readonly problem: string }> {
  try {
    const kind = await lstat(folder);
    if (kind.isSymbolicLink()) return { problem: LINK };
    return kind.isDirectory() ? "folder" : { problem: "it is not a folder" };
  } catch (error) {
    const code = codeOf(error);
    return code === "ENOENT" || code === "ENOTDIR"
      ? "absent"
      : { problem: `it cannot be read (${code})` };
  }
}

/** Runs `work` on each item, at most `limit` at a time. */
async function eachAtMost<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let item = items[next++]; item !== undefined; item = items[next++]) await work(item);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** What the skills folder holds, by skill name, or why it cannot be read. */
export type FolderRead = { readonly found: Map<string, Found>; readonly unread: number } | string;

async function readFolder(folder: string): Promise<FolderRead> {
  const root = await rootOf(folder);
  if (root === "absent") return { found: new Map(), unread: 0 };
  if (root !== "folder") return root.problem;
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch (error) {
    return `it cannot be read (${codeOf(error)})`;
  }
  const visible = entries
    .filter((entry) => !entry.name.startsWith("."))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const folders = visible.filter((entry) => !entry.isFile());
  const read = folders.slice(0, SKILL_FOLDERS);
  const found = new Map<string, Found>();
  await eachAtMost(read, AT_ONCE, async (entry) => {
    const path = join(folder, entry.name);
    const fail = (problem: string) => {
      found.set(entry.name, { path, ok: false, problem });
    };
    if (entry.isSymbolicLink()) fail(LINK);
    else if (!entry.isDirectory()) fail("it is not a folder");
    else if (!isSkillName(entry.name)) {
      fail("its folder's name is no skill name: use lower case letters, digits and hyphens");
    } else found.set(entry.name, await readOne(join(path, SKILL_FILE)));
  });
  // A skill written as one file beside the folders, the way some apps keep them.
  for (const entry of visible) {
    const stem = entry.isFile() ? /^(.+)\.md$/iu.exec(entry.name)?.[1] : undefined;
    if (stem === undefined || found.has(stem)) continue;
    found.set(stem, {
      path: join(folder, entry.name),
      ok: false,
      problem: `a skill is a folder: move it to ${join(folder, stem, SKILL_FILE)}`,
    });
  }
  return { found, unread: folders.length - read.length };
}

/** The person's files for these names alone. */
async function readNames(folder: string, names: readonly string[]): Promise<FolderRead> {
  const root = await rootOf(folder);
  if (root === "absent") return { found: new Map(), unread: 0 };
  if (root !== "folder") return root.problem;
  const found = new Map<string, Found>();
  await eachAtMost(names, AT_ONCE, async (name) => {
    const path = join(folder, name);
    try {
      const kind = await lstat(path);
      if (kind.isSymbolicLink()) found.set(name, { path, ok: false, problem: LINK });
      else if (kind.isDirectory()) found.set(name, await readOne(join(path, SKILL_FILE)));
    } catch (error) {
      const code = codeOf(error);
      if (code !== "ENOENT") {
        found.set(name, { path, ok: false, problem: `it cannot be read (${code})` });
      }
    }
  });
  return { found, unread: 0 };
}

/** `work`, or `late()` once `ms` have passed without it. */
function within<T>(work: Promise<T>, ms: number, late: () => T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((done) => {
    timer = setTimeout(() => {
      done(late());
    }, ms);
    timer.unref();
  });
  return Promise.race([work, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

const tooSlow = (ms: number) => () => `it did not answer within ${String(ms / 1000)} s`;

/** A default as the person's file for it leaves it. */
function defaultSkill(skill: Default, file: Found | undefined): Skill {
  if (file?.ok === true) {
    return {
      name: skill.name,
      origin: "edited",
      description: file.description ?? skill.description,
      body: file.body,
      path: file.path,
      problem: undefined,
    };
  }
  return {
    name: skill.name,
    origin: "default",
    description: skill.description,
    body: skill.body,
    path: file?.path,
    problem: file?.problem,
  };
}

/** A skill of the person's own. */
const ownSkill = (name: string, file: Found): Skill => ({
  name,
  origin: "own",
  description: file.ok ? (file.description ?? "") : "",
  body: file.ok ? file.body : undefined,
  path: file.path,
  problem: file.ok ? undefined : file.problem,
});

/** A default when the skills folder itself cannot be read: why travels with it. */
const unreadFolder = (folder: string, problem: string) => (skill: Default) =>
  defaultSkill(skill, { path: folder, ok: false, problem: `the skills folder: ${problem}` });

/**
 * Every skill, read now: the defaults in their order, then the person's own by name. `folder` is
 * the person's skills folder; none serves the defaults alone.
 */
export async function listSkills(
  folder: string | undefined,
  ms: number = SKILLS_WITHIN_MS,
  read: (folder: string) => Promise<FolderRead> = readFolder,
): Promise<Catalog> {
  if (folder === undefined) {
    return {
      skills: [...DEFAULTS.values()].map((skill) => defaultSkill(skill, undefined)),
      unread: 0,
    };
  }
  const result = await within(read(folder), ms, tooSlow(ms));
  if (typeof result === "string") {
    return { skills: [...DEFAULTS.values()].map(unreadFolder(folder, result)), unread: 0 };
  }
  const own = [...result.found.entries()]
    .filter(([name]) => !DEFAULTS.has(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, file]) => ownSkill(name, file));
  const defaults = [...DEFAULTS.values()].map((skill) =>
    defaultSkill(skill, result.found.get(skill.name)),
  );
  return { skills: [...defaults, ...own], unread: result.unread };
}

/**
 * The skills of these names, reading only their files, in the order asked; `missing` names no
 * skill. When the skills folder cannot be read, a name no default has comes back with why.
 */
export async function readSkills(
  folder: string | undefined,
  names: readonly string[],
  ms: number = SKILLS_WITHIN_MS,
): Promise<{ readonly skills: readonly Skill[]; readonly missing: readonly string[] }> {
  const asked = [...new Set(names)];
  const result =
    folder === undefined
      ? { found: new Map<string, Found>(), unread: 0 }
      : await within(readNames(folder, asked), ms, tooSlow(ms));
  const skills: Skill[] = [];
  const missing: string[] = [];
  for (const name of asked) {
    const shipped = DEFAULTS.get(name);
    if (typeof result === "string") {
      const file: Found = {
        path: folder ?? "",
        ok: false,
        problem: `the skills folder: ${result}`,
      };
      skills.push(shipped === undefined ? ownSkill(name, file) : defaultSkill(shipped, file));
      continue;
    }
    const file = result.found.get(name);
    if (shipped !== undefined) skills.push(defaultSkill(shipped, file));
    else if (file !== undefined) skills.push(ownSkill(name, file));
    else missing.push(name);
  }
  return { skills, missing };
}

/** The most skills an agent's list shows; the rest are counted. */
export const SKILL_LIST_ROWS = 10;
/** The longest line of a skill in an agent's list. */
export const SKILL_LINE_CHARS = 120;

const UNUSED = ` (the user's file is not used: ${CLI_NAME} skills says why)`;

/**
 * A skill's line in an agent's list: its name and when to read it, one line, with "..." where the
 * line was cut. `ttasks skills` says when a "when to use" is cut here.
 */
export function listLine(name: string, when: string | undefined, unused: boolean): string {
  const head = `  ${name}${unused ? UNUSED : ""}`;
  const room = SKILL_LINE_CHARS - head.length - 2;
  const chars = Array.from(when ?? "");
  const line =
    chars.length === 0
      ? head
      : `${head}: ${chars.length <= room ? chars.join("") : `${chars.slice(0, Math.max(0, room - 3)).join("")}...`}`;
  const all = Array.from(line);
  return all.length <= SKILL_LINE_CHARS
    ? line
    : `${all.slice(0, SKILL_LINE_CHARS - 3).join("")}...`;
}

/**
 * The text an agent is handed: TTasks' part of a default, then the person's part. Undefined for a
 * skill of the person's that cannot be used.
 */
export function servedText(skill: Skill, space: SpaceFacts): string | undefined {
  if (skill.body === undefined) return undefined;
  const ttasks = skill.origin === "own" ? [] : (TTASKS_PARTS[skill.name]?.(space) ?? []);
  return [ttasks.join("\n"), skill.body].filter((part) => part !== "").join("\n\n");
}
