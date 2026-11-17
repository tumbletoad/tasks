// A folder a person or an agent names, made into the form the space stores, and the checks made at
// bind: only this machine's service can look at this machine's folders, so these checks live here
// and the writer checks the form alone.
//
// The stored form: the path as this machine spells it, absolute, with the person's home written as
// `~`. Only the separators are normalised (no doubled or trailing one, `\` on Windows, an upper-case
// drive letter); the Unicode form is kept as given, since a composed and a decomposed `é` are two
// folders on Linux, and a link stays a link, so retargeting it moves the folder.
//
// The checks at bind, each cheap and each about a person's work:
// - the folder exists and is a folder (a link to one counts);
// - it is not inside Tasks' own data: the Tasks home or a space folder this machine registers, or
//   one of those folders itself. Judged by what the folders are on disk: each folder from the
//   candidate's real path up to its root is compared by identity with each of them;
// - it is not another live project's folder on this machine, compared by identity, so two
//   spellings of one folder (case, a short name, a link) are one; a project's folder that is
//   missing now or does not answer is compared by its stored path, with the machine's case
//   rule, so a share that is away keeps no other folder from binding.
// The writer keeps the last rule again by the stored text in its transaction, for an undo, a redo
// and a restore, which it decides without the disk.
//
// Every look is bounded: a folder on a share that does not answer is `not_answering` after 2 s,
// never a hung call. The look itself runs in Node's file system threads, which a share that never
// answers keeps busy until the OS gives up.
import { realpath, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { PRODUCT_NAME } from "@tasks/brand";
import { AppError } from "@tasks/contracts";
import { FOLDER_PATH_MAX, folderKey, rebased, segmentsOf, type FolderOs } from "@tasks/storage";

/** Why a folder is not bound. */
export type FolderReason =
  | "no_cwd"
  | "not_absolute"
  | "invalid_path"
  | "folder_missing"
  | "not_a_directory"
  | "folder_unreadable"
  | "folder_reserved"
  | "folder_taken"
  | "not_answering";

/** How long one look at a folder may take. */
export const LOOK_MS = 2_000;

const SENTENCES: Readonly<Record<FolderReason, string>> = {
  no_cwd: 'A folder given as "cwd" needs your working folder',
  not_absolute: "Not an absolute folder, nor one under ~",
  invalid_path: "A folder path this machine cannot store as given",
  folder_missing: "The folder is not there",
  not_a_directory: "Not a folder",
  folder_unreadable: "The folder could not be read",
  folder_reserved: `A folder inside ${PRODUCT_NAME}'s own data: an agent working there would change it`,
  folder_taken: "Another project has this folder on this machine",
  not_answering: "The folder did not answer in time",
};

const HINTS: Partial<Record<FolderReason, string>> = {
  no_cwd: "Pass cwd, your working folder as an absolute path, or give the folder itself.",
  not_absolute: "Give an absolute path, or one that starts with ~.",
  folder_missing: "Make the folder first, then name it.",
  folder_reserved: `Choose a folder outside the ${PRODUCT_NAME} home and the space folders.`,
  folder_taken: "Open that project, or choose another folder.",
  not_answering: "Check that its drive or share is connected, then try again.",
};

/**
 * The refusal of a folder at input path `at`: `invalid_input` with the reason, and for a taken
 * folder the project that has it. Never the path itself: the caller sent it.
 */
export function folderRefused(
  at: string,
  reason: FolderReason,
  extra: { project?: { id: string; name: string }; task?: string } = {},
): AppError {
  const message = SENTENCES[reason];
  const hint = HINTS[reason];
  return new AppError({
    code: reason === "folder_taken" ? "conflict" : "invalid_input",
    message: `${message}.`,
    ...(hint === undefined ? {} : { hint }),
    data: {
      issues: [{ path: at, message }],
      reason,
      ...(reason === "folder_taken" ? { cause: "FOLDER_TAKEN" } : {}),
      ...(extra.project === undefined ? {} : { project: extra.project }),
      ...(extra.task === undefined ? {} : { task: extra.task }),
    },
  });
}

export const osOf = (platform: NodeJS.Platform): FolderOs =>
  platform === "win32" ? "windows" : platform === "darwin" ? "macos" : "linux";

const pathFor = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

// eslint-disable-next-line no-control-regex -- the controls are what this refuses.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

/** A folder as the space stores it, and as this machine opens it. */
export interface Folder {
  /** The stored form: the home as `~`. */
  readonly stored: string;
  /** The absolute path this machine opens. */
  readonly absolute: string;
}

/**
 * The stored form of `given` (an absolute path, or `~` and a path under the home) on this machine,
 * or the reason it has none. `home` is this machine's home folder for the person.
 */
export function storedForm(
  given: string,
  home: string,
  platform: NodeJS.Platform,
): Folder | FolderReason {
  if (!given.isWellFormed() || CONTROL.test(given)) return "invalid_path";
  const path = pathFor(platform);
  const windows = platform === "win32";
  const sep = windows ? "\\" : "/";
  let text = windows ? given.replaceAll("/", "\\") : given;
  if (text === "~" || text.startsWith(`~${sep}`)) text = `${home}${text.slice(1)}`;
  else if (!path.isAbsolute(text)) return "not_absolute";
  // A drive-relative Windows path (`C:x`, `\x`) names a folder that depends on the current one.
  if (windows && !/^([A-Za-z]:\\|\\\\[^\\])/u.test(text)) return "not_absolute";
  const unc = windows && text.startsWith("\\\\");
  const body = unc ? text.slice(2) : text;
  const parts = body.split(sep);
  // A root keeps its own separator: `/` and `C:\`.
  const head = parts[0] ?? "";
  const rest = parts.slice(1).filter((part) => part !== "" && part !== ".");
  // `a/link/..` is not `a` when `link` is a link, so `..` is not folded away by its text.
  if (rest.includes("..")) return "invalid_path";
  let absolute: string;
  if (unc) {
    if (head === "" || rest.length === 0) return "not_absolute";
    absolute = `\\\\${[head, ...rest].join(sep)}`;
  } else if (windows) {
    const drive = head.toUpperCase();
    absolute = rest.length === 0 ? `${drive}\\` : `${drive}\\${rest.join(sep)}`;
  } else {
    absolute = rest.length === 0 ? "/" : `/${rest.join(sep)}`;
  }
  if (Array.from(absolute).length > FOLDER_PATH_MAX) return "invalid_path";
  const os = osOf(platform);
  const homeParts = home.split(sep).filter((part, k) => part !== "" || k === 0);
  const own = absolute.split(sep);
  const fold = (s: string): string => (os === "linux" ? s : s.toLowerCase());
  const under =
    own.length >= homeParts.length &&
    homeParts.every((part, k) => fold(part) === fold(own[k] ?? ""));
  const stored = under ? ["~", ...own.slice(homeParts.length)].join(sep) : absolute;
  if (Array.from(stored).length > FOLDER_PATH_MAX) return "invalid_path";
  return { stored, absolute };
}

/** A stored path of this machine as it opens it: `~` expanded with the home. */
export function expanded(stored: string, home: string, platform: NodeJS.Platform): string {
  const sep = platform === "win32" ? "\\" : "/";
  return stored === "~" || stored.startsWith(`~${sep}`) ? `${home}${stored.slice(1)}` : stored;
}

/**
 * The absolute path a stored folder opens on this machine: `~` expanded with the home, or
 * undefined for a home path when the home is not known.
 */
export function openPath(
  stored: string,
  home: string | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  const sep = platform === "win32" ? "\\" : "/";
  if (stored !== "~" && !stored.startsWith(`~${sep}`)) return stored;
  return home === undefined ? undefined : expanded(stored, home, platform);
}

/**
 * Whether a stored folder is a folder on this machine now: `here` when it is there and is a
 * folder, a link to one included, else `missing`. A look that does not answer in time is missing.
 */
export async function folderState(
  stored: string,
  home: string | undefined,
  platform: NodeJS.Platform,
): Promise<"here" | "missing"> {
  const open = openPath(stored, home, platform);
  if (open === undefined) return "missing";
  const found = await bounded(async () => {
    try {
      return (await stat(open)).isDirectory();
    } catch {
      return false;
    }
  });
  return found === true ? "here" : "missing";
}

/** Runs a look at the disk, or answers `not_answering` once it took longer than `ms`. */
export async function bounded<T>(
  look: () => Promise<T>,
  ms = LOOK_MS,
): Promise<T | "not_answering"> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"not_answering">((resolve) => {
    timer = setTimeout(() => {
      resolve("not_answering");
    }, ms);
  });
  try {
    return await Promise.race([look(), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** What a folder is on disk: its file identity, or its real path where the volume gives none. */
async function identityOf(path: string, platform: NodeJS.Platform): Promise<string | undefined> {
  try {
    const found = await stat(path, { bigint: true });
    if (found.ino !== 0n) return `id:${String(found.dev)}:${String(found.ino)}`;
    const real = await realpath(path);
    return `path:${osOf(platform) === "linux" ? real : real.toLowerCase()}`;
  } catch {
    return undefined;
  }
}

/** The folders from `real` up to its root. */
function ancestors(real: string, platform: NodeJS.Platform): string[] {
  const path = pathFor(platform);
  const list = [real];
  for (let at = real; path.dirname(at) !== at; at = path.dirname(at)) list.push(path.dirname(at));
  return list;
}

/** A live project's folder on this machine, as the same-folder check compares it. */
export interface ProjectFolder {
  readonly project: string;
  readonly name: string;
  readonly stored: string;
}

export interface BindFacts {
  readonly home: string;
  readonly platform: NodeJS.Platform;
  /** Tasks' own data: the Tasks home and the folder of each space this machine registers. */
  readonly reserved: readonly string[];
  /** The live projects' folders on this machine, but the one the folder is bound to. */
  readonly projects?: readonly ProjectFolder[];
}

/**
 * The checks at bind (the module header) on a folder in stored form: undefined when it may be
 * bound, else the reason, with the project that has it for `folder_taken`.
 */
export async function checkFolder(
  folder: Folder,
  facts: BindFacts,
): Promise<{ reason: FolderReason; project?: ProjectFolder } | undefined> {
  const { platform } = facts;
  const looked = await bounded(async () => {
    try {
      const found = await stat(folder.absolute);
      return found.isDirectory() ? "ok" : "not_a_directory";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ENOTDIR" ? "folder_missing" : "folder_unreadable";
    }
  });
  if (looked !== "ok") return { reason: looked };
  const reserved = await reservedBy(folder.absolute, facts);
  if (reserved !== undefined) return { reason: reserved };
  const projects = facts.projects ?? [];
  if (projects.length === 0) return undefined;
  const os = osOf(platform);
  const mine = await bounded(() => identityOf(folder.absolute, platform));
  if (mine === "not_answering") return { reason: "not_answering" };
  const same = await Promise.all(
    projects.map(async (project) => {
      const theirs = await bounded(() =>
        identityOf(expanded(project.stored, facts.home, platform), platform),
      );
      return mine === undefined || theirs === undefined || theirs === "not_answering"
        ? folderKey(project.stored, os) === folderKey(folder.stored, os)
        : theirs === mine;
    }),
  );
  const taken = projects.find((_, k) => same[k] === true);
  return taken === undefined ? undefined : { reason: "folder_taken", project: taken };
}

/**
 * The project whose folder holds `folder` most closely: the folder itself, or the deepest of the
 * project folders it lies in. A project folder holds it by its stored text with the machine's case
 * rule, or by identity, so a folder reached through a link still belongs to its project. A project
 * folder that does not answer is judged by its text alone. `exact`: the folder is the project's.
 * `looks` keeps the project folders' identities for the next folder of the same call.
 */
export async function deepestProject<P extends ProjectFolder>(
  folder: Folder,
  projects: readonly P[],
  facts: Pick<BindFacts, "home" | "platform">,
  looks: Map<string, Promise<string | undefined>> = new Map(),
): Promise<{ project: P; exact: boolean } | undefined> {
  if (projects.length === 0) return undefined;
  const { platform } = facts;
  const os = osOf(platform);
  const depth = segmentsOf(folder.stored, os).length;
  // How many folders up from `folder` each project's folder is, by its text.
  const byText = projects.map((p) =>
    rebased(folder.stored, p.stored, p.stored, os) === undefined
      ? undefined
      : depth - segmentsOf(p.stored, os).length,
  );
  const up = await bounded(async () => {
    try {
      const real = await realpath(folder.absolute);
      return await Promise.all(ancestors(real, platform).map((at) => identityOf(at, platform)));
    } catch {
      return [];
    }
  });
  const byIdentity = await Promise.all(
    projects.map(async (p) => {
      if (up === "not_answering" || up.length === 0) return undefined;
      let look = looks.get(p.stored);
      if (look === undefined) {
        look = bounded(() => identityOf(expanded(p.stored, facts.home, platform), platform)).then(
          (found) => (found === "not_answering" ? undefined : found),
        );
        looks.set(p.stored, look);
      }
      const theirs = await look;
      if (theirs === undefined) return undefined;
      const k = up.indexOf(theirs);
      return k === -1 ? undefined : k;
    }),
  );
  let best: { project: P; distance: number } | undefined;
  projects.forEach((project, k) => {
    const found = [byText[k], byIdentity[k]].filter((d): d is number => d !== undefined);
    if (found.length === 0) return;
    const distance = Math.min(...found);
    if (best === undefined || distance < best.distance) best = { project, distance };
  });
  return best === undefined ? undefined : { project: best.project, exact: best.distance === 0 };
}

/**
 * Whether the folder at `absolute` is Tasks' own data or inside it, by identity: undefined when it
 * is not or is not there, `folder_reserved` when it is.
 */
export async function reservedBy(
  absolute: string,
  facts: Pick<BindFacts, "platform" | "reserved">,
): Promise<"folder_reserved" | "not_answering" | undefined> {
  const { platform } = facts;
  const found = await bounded(async () => {
    let real: string;
    try {
      real = await realpath(absolute);
    } catch {
      return undefined;
    }
    const own = new Set<string>();
    for (const folder of facts.reserved) {
      const id = await identityOf(folder, platform);
      if (id !== undefined) own.add(id);
    }
    if (own.size === 0) return undefined;
    for (const folder of ancestors(real, platform)) {
      const id = await identityOf(folder, platform);
      if (id !== undefined && own.has(id)) return "folder_reserved" as const;
    }
    return undefined;
  });
  return found;
}
