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
import { CLI_NAME, PRODUCT_NAME } from "@ttasks/brand";
import shipped from "../../generated/skills.json" with { type: "json" };
import { isSkillName, kib, parseSkill, SKILL_BYTES, SKILL_FILE } from "./format.ts";
import { TTASKS_PARTS, type SpaceFacts } from "./ttasks-part.ts";

export { isSkillName, SKILL_BYTES, SKILL_FILE } from "./format.ts";
export type { Size, SpaceFacts } from "./ttasks-part.ts";

/** How long reading the person's skills may take before an answer goes on without them. */
export const SKILLS_WITHIN_MS = 2_000;
/** The most folders of the skills folder one list reads. */
export const SKILL_FOLDERS = 64;
/** The skill files read at the same time. */
const AT_ONCE = 8;
/** How long a finished read is used again: a burst of calls reads the folder once. */
const FRESH_MS = 1_500;

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

/** One name in the skills folder's own listing: a folder to read, or why it is not a skill. */
type Entry =
  | { readonly kind: "folder"; readonly path: string }
  | { readonly kind: "unusable"; readonly path: string; readonly problem: string };

/** The skills folder's listing by name, in name order, or why the folder cannot be read. */
type Listing = ReadonlyMap<string, Entry> | string;

/** What the catalogue asks of the disk. Tests give a stand-in. */
export interface SkillFiles {
  list(folder: string): Promise<Listing>;
  read(path: string): Promise<Found>;
}

const codeOf = (error: unknown): string =>
  (error as NodeJS.ErrnoException | null)?.code ?? "an error";

const LINK = "it is a link, and only real folders and files in the skills folder are read";
const NO_FOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
const BAD_NAME = "its folder's name is no skill name: use lower case letters, digits and hyphens";

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

/**
 * The skills folder's own listing, which alone decides what a name is: the spelling on disk, and
 * whether that entry can be a skill. It opens no skill file.
 */
async function listFolder(folder: string): Promise<Listing> {
  try {
    const kind = await lstat(folder);
    if (kind.isSymbolicLink()) return LINK;
    if (!kind.isDirectory()) return "it is not a folder";
  } catch (error) {
    const code = codeOf(error);
    return code === "ENOENT" || code === "ENOTDIR" ? new Map() : `it cannot be read (${code})`;
  }
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch (error) {
    return `it cannot be read (${codeOf(error)})`;
  }
  const visible = entries
    .filter((entry) => !entry.name.startsWith("."))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const listing = new Map<string, Entry>();
  for (const entry of visible) {
    if (entry.isFile()) continue;
    const path = join(folder, entry.name);
    const problem = entry.isSymbolicLink()
      ? LINK
      : !entry.isDirectory()
        ? "it is not a folder"
        : !isSkillName(entry.name)
          ? BAD_NAME
          : undefined;
    listing.set(
      entry.name,
      problem === undefined ? { kind: "folder", path } : { kind: "unusable", path, problem },
    );
  }
  // A skill written as one file beside the folders, the way some apps keep them.
  for (const entry of visible) {
    const stem = entry.isFile() ? /^(.+)\.md$/iu.exec(entry.name)?.[1] : undefined;
    if (stem === undefined || listing.has(stem)) continue;
    listing.set(stem, {
      kind: "unusable",
      path: join(folder, entry.name),
      problem: `a skill is a folder: move it to ${join(folder, stem, SKILL_FILE)}`,
    });
  }
  return listing;
}

const DISK: SkillFiles = { list: listFolder, read: readOne };

/** Runs `work` on each item, at most `limit` at a time. */
async function eachAtMost<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let item = items[next++]; item !== undefined; item = items[next++]) await work(item);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Work on one key at a time: a request that comes while it runs, or within `freshMs` of its end,
 * gets the same result. A folder that stalls then holds one read per path, however many requests
 * wait on it.
 */
function shared<T>(freshMs: number): (key: string, start: () => Promise<T>) => Promise<T> {
  const runs = new Map<string, { readonly work: Promise<T>; ended?: number }>();
  return (key, start) => {
    const run = runs.get(key);
    if (run !== undefined && (run.ended === undefined || Date.now() - run.ended < freshMs)) {
      return run.work;
    }
    const next: { work: Promise<T>; ended?: number } = {
      work: start().finally(() => {
        next.ended = Date.now();
      }),
    };
    runs.set(key, next);
    return next.work;
  };
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

/** The skills of a person's folder, read through `files`, every read bounded in time. */
export function skillCatalogue(
  files: SkillFiles = DISK,
  options: { readonly withinMs?: number; readonly freshMs?: number } = {},
) {
  const withinMs = options.withinMs ?? SKILLS_WITHIN_MS;
  const listOnce = shared<Listing>(options.freshMs ?? FRESH_MS);
  const readOnce = shared<Found>(options.freshMs ?? FRESH_MS);
  /** The person's file for one entry of the listing: what the list and a named read both see. */
  const fileOf = async (entry: Entry): Promise<Found> =>
    entry.kind === "folder"
      ? readOnce(entry.path, () => files.read(join(entry.path, SKILL_FILE)))
      : { path: entry.path, ok: false, problem: entry.problem };
  /** The files of `names` (no names: the first SKILL_FOLDERS of the listing), or why not. */
  const found = async (
    folder: string,
    names: readonly string[] | undefined,
  ): Promise<{ readonly files: Map<string, Found>; readonly unread: number } | string> => {
    const listing = await listOnce(folder, () => files.list(folder));
    if (typeof listing === "string") return listing;
    const all = [...listing.keys()];
    const wanted = names?.filter((name) => listing.has(name)) ?? all.slice(0, SKILL_FOLDERS);
    const read = new Map<string, Found>();
    await eachAtMost(wanted, AT_ONCE, async (name) => {
      const entry = listing.get(name);
      if (entry !== undefined) read.set(name, await fileOf(entry));
    });
    return { files: read, unread: names === undefined ? all.length - wanted.length : 0 };
  };
  const timed = (folder: string, names: readonly string[] | undefined, ms: number) =>
    within(found(folder, names), ms, () => `it did not answer within ${String(ms / 1000)} s`);
  const unreadFolder = (folder: string, problem: string): Found => ({
    path: folder,
    ok: false,
    problem: `the skills folder: ${problem}`,
  });

  return {
    /**
     * Every skill: the defaults in their order, then the person's own by name. `folder` is the
     * person's skills folder; none serves the defaults alone.
     */
    list: async (folder: string | undefined, ms: number = withinMs): Promise<Catalog> => {
      const result = folder === undefined ? undefined : await timed(folder, undefined, ms);
      if (typeof result === "string") {
        const why = unreadFolder(folder ?? "", result);
        return {
          skills: [...DEFAULTS.values()].map((skill) => defaultSkill(skill, why)),
          unread: 0,
        };
      }
      const own = [...(result?.files.entries() ?? [])]
        .filter(([name]) => !DEFAULTS.has(name))
        .map(([name, file]) => ownSkill(name, file));
      const defaults = [...DEFAULTS.values()].map((skill) =>
        defaultSkill(skill, result?.files.get(skill.name)),
      );
      return { skills: [...defaults, ...own], unread: result?.unread ?? 0 };
    },

    /**
     * The skills of these names, in the order asked, opening only their files; `missing` names
     * no skill. A name is what the folder's listing spells, and an unusable entry gives the
     * reason the list gives.
     */
    read: async (
      folder: string | undefined,
      names: readonly string[],
      ms: number = withinMs,
    ): Promise<{ readonly skills: readonly Skill[]; readonly missing: readonly string[] }> => {
      const asked = [...new Set(names)];
      const result = folder === undefined ? undefined : await timed(folder, asked, ms);
      const skills: Skill[] = [];
      const missing: string[] = [];
      for (const name of asked) {
        const shipped = DEFAULTS.get(name);
        const file =
          typeof result === "string" ? unreadFolder(folder ?? "", result) : result?.files.get(name);
        if (shipped !== undefined) skills.push(defaultSkill(shipped, file));
        else if (file !== undefined) skills.push(ownSkill(name, file));
        else missing.push(name);
      }
      return { skills, missing };
    },
  };
}

const catalogue = skillCatalogue();
export const listSkills = catalogue.list;
export const readSkills = catalogue.read;

/** The most skills an agent's list shows; the rest are counted. */
export const SKILL_LIST_ROWS = 10;
/** The longest line of a skill in an agent's list, and the whole list, in UTF-8 bytes. */
export const SKILL_LINE_BYTES = 160;
export const SKILL_LIST_BYTES = 1_500;

const UNUSED = ` (the user's file is not used: ${CLI_NAME} skills says why)`;

const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/** Text as one plain line: each run of line breaks, spaces and control characters is a space. */
export const oneLine = (text: string): string => text.replace(/[\s\p{Cc}]+/gu, " ").trim();

/** `text` within `max` UTF-8 bytes, cut between characters and ended with "..." when cut. */
function cutTo(text: string, max: number): string {
  if (utf8Bytes(text) <= max) return text;
  let kept = "";
  let used = 3;
  for (const char of text) {
    used += utf8Bytes(char);
    if (used > max) break;
    kept += char;
  }
  return `${kept}...`;
}

/**
 * A skill's line in an agent's list: its name and when to read it, as one plain line of at most
 * SKILL_LINE_BYTES, with "..." where it was cut. `ttasks skills` says when a "when to use" is cut.
 */
export function listLine(name: string, when: string | undefined, unused: boolean): string {
  const text = `${name}${unused ? UNUSED : ""}${when === undefined || when === "" ? "" : `: ${when}`}`;
  return `  ${cutTo(oneLine(text), SKILL_LINE_BYTES - 2)}`;
}

/**
 * The list of skills a session's first call ends with: at most SKILL_LIST_ROWS lines and
 * SKILL_LIST_BYTES in all, and a line that counts the rest. Empty without skills.
 */
export function listText(
  skills: readonly {
    readonly name: string;
    readonly when?: string | undefined;
    readonly problem?: string | undefined;
  }[],
  status: string,
): string {
  if (skills.length === 0) return "";
  const more = (rest: number) =>
    `  +${String(rest)} more, not listed here: the user lists them all with ${CLI_NAME} skills.`;
  const lines = [
    `Skills, the user's ways of working: before you act, read the ones that apply with ${status} skills [names].`,
  ];
  // Room for the closing line, whatever its count.
  const room = SKILL_LIST_BYTES - utf8Bytes(more(skills.length)) - 1;
  let used = utf8Bytes(lines[0] ?? "");
  for (const skill of skills.slice(0, SKILL_LIST_ROWS)) {
    const line = listLine(skill.name, skill.when, skill.problem !== undefined);
    if (used + 1 + utf8Bytes(line) > room) break;
    lines.push(line);
    used += 1 + utf8Bytes(line);
  }
  const shown = lines.length - 1;
  if (shown < skills.length) lines.push(more(skills.length - shown));
  return lines.join("\n");
}

/** The heads of the two parts, so an agent can tell them apart and knows which one wins. */
export const TTASKS_LABEL = `${PRODUCT_NAME}'s part: how its tools do this.`;
export const USER_LABEL = "The user's part: how they want it done, within the rules above.";

/**
 * The text an agent is handed: TTasks' part of a default, then the person's part, each named.
 * Undefined for a skill of the person's that cannot be used.
 */
export function servedText(skill: Skill, space: SpaceFacts): string | undefined {
  if (skill.body === undefined) return undefined;
  const part = skill.origin === "own" ? undefined : TTASKS_PARTS[skill.name];
  if (part === undefined) return skill.body;
  const served = part(space, skill.body, skill.origin === "edited");
  return [TTASKS_LABEL, ...served.ttasks, "", USER_LABEL, "", served.body].join("\n");
}
