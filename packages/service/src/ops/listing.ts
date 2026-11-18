// The folder chooser's look at this computer's disk: the folders in one folder, by name, for the
// person's page. It reads names and whether each is a folder, never a file's content, and lists no
// file. A link to a folder is listed as a link: opening it lists the folder it points to, which the
// page says. Each look is bounded: a share that stops answering gives what was read so far, or
// `not_answering`, never a hung call. A folder with very many entries is read up to a cap.
//
// What the person typed decides what is listed: a path that ends in a separator (or `~`, or a
// root) lists that folder; any other lists its parent, with the last name as a prefix to complete.
import { opendir, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { makeDirAsync } from "@tasks/files";
import { folderKey, type FolderOs } from "@tasks/storage";
import {
  bounded,
  folderName,
  LOOK_MS,
  osOf,
  storedForm,
  type Folder,
  type FolderReason,
} from "./folders.ts";
import { repoName } from "./repo.ts";

/** What the chooser reads of the disk: tests give a slow or strange one. */
export interface ListFs {
  /** The entries of a folder, in the order the OS gives them; none once `deadline` is past. */
  entries(
    path: string,
    deadline?: number,
  ): AsyncIterable<{
    readonly name: string;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }>;
  /** Whether `path`, links followed, is a folder; throws as `fs.stat` does. */
  isFolder(path: string): Promise<boolean>;
  /** Makes one folder in a folder that exists, as a plain mkdir would under the umask. */
  make(path: string): Promise<void>;
  /** The repository name of a checkout, or undefined. */
  repo(path: string): Promise<string | undefined>;
}

export function nodeListFs(platform: NodeJS.Platform): ListFs {
  return {
    entries: async function* (path) {
      // `for await` closes the handle when the caller stops early.
      yield* await opendir(path, { bufferSize: 64 });
    },
    isFolder: async (path) => (await stat(path)).isDirectory(),
    make: (path) => makeDirAsync(path, "umask", platform),
    repo: (path) => repoName(path, platform),
  };
}

/**
 * The same disk, where a look at a path still on its way is shared, not started again. A time
 * limit stops the waiting, not the look: on a share that stopped answering, every keystroke and
 * every new start would otherwise hold one more of the few threads all of the service's disk work
 * shares, until the share gives up.
 */
export function sharedLooks(fs: ListFs): ListFs {
  const pending = new Map<string, Promise<boolean>>();
  const reading = new Map<string, Promise<void>>();
  return {
    ...fs,
    // One read of a folder at a time: a later one waits for the earlier to end, and gives up
    // without reading once its own time is past.
    entries: async function* (path, deadline) {
      for (let busy = reading.get(path); busy !== undefined; busy = reading.get(path)) {
        await busy;
        if (deadline !== undefined && Date.now() > deadline) return;
      }
      let done = (): void => undefined;
      reading.set(
        path,
        new Promise<void>((resolve) => {
          done = resolve;
        }),
      );
      try {
        yield* fs.entries(path, deadline);
      } finally {
        reading.delete(path);
        done();
      }
    },
    isFolder: (path) => {
      const found = pending.get(path);
      if (found !== undefined) return found;
      const look = fs.isFolder(path).finally(() => {
        pending.delete(path);
      });
      pending.set(path, look);
      return look;
    },
  };
}

/** At most this many entries are read from one folder; the rest is left for a narrower prefix. */
export const SCAN_MAX = 20_000;
/** At most this many folders are shown from one folder. */
export const SHOW_MAX = 200;

/** Why a folder cannot be listed: a bind's reasons, and a server named without its share. */
export type ListReason = FolderReason | "share_needed";

/** A project of the tab's space whose folder is here, so a listed folder can say it is its. */
export interface KnownProject {
  readonly id: string;
  readonly name: string;
  /** Its folder here, as the space stores it. */
  readonly stored: string;
}

export interface ListFacts {
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly fs: ListFs;
  readonly projects?: readonly KnownProject[];
  readonly ms?: number;
  readonly scanMax?: number;
  readonly showMax?: number;
}

/** One folder in a listing. */
export interface Listed {
  readonly name: string;
  /** A link (a junction on Windows) to a folder: opening it lists the folder it points to. */
  readonly link?: true;
  /** The project of the tab's space whose folder this is. */
  readonly project?: { readonly id: string; readonly name: string };
}

/** The folder a person's text names exactly, when it is one. */
export interface Exact {
  /** As the space would store it: the home as `~`. */
  readonly folder: string;
  /** The name a project made from it gets: none for a drive or a root. */
  readonly name?: string;
  readonly repo?: string;
  readonly project?: { readonly id: string; readonly name: string };
}

export type Listing =
  | {
      readonly kind: "start";
      readonly sep: string;
      /** Where to begin: the home, and the folders that hold this space's project folders here. */
      readonly places: readonly { readonly folder: string; readonly project?: string }[];
      /** The drives found (Windows) or the root. */
      readonly roots: readonly string[];
    }
  | {
      readonly kind: "list";
      readonly sep: string;
      /** The folder listed, as the person reads it: the home as `~`, ending in a separator. */
      readonly at: string;
      /** The name typed after `at`, which the folders listed start with (case aside). */
      readonly prefix: string;
      /** The folder that holds `at`, as the person reads it: none at a root. */
      readonly up?: string;
      readonly folders: readonly Listed[];
      /** More folders, or entries, than were shown or read: a longer prefix narrows them. */
      readonly more: boolean;
      readonly exact?: Exact;
    }
  | {
      readonly kind: "problem";
      readonly sep: string;
      readonly reason: ListReason;
      /** The folder that could not be listed, as the person reads it. */
      readonly at?: string;
    };

const sepOf = (platform: NodeJS.Platform): string => (platform === "win32" ? "\\" : "/");

/** The folder `text` names to list, with the prefix typed after it, or the reason it names none. */
export function splitTyped(
  text: string,
  platform: NodeJS.Platform,
): { folder: string; prefix: string } | ListReason {
  const windows = platform === "win32";
  const sep = sepOf(platform);
  let typed = windows ? text.replaceAll("/", "\\") : text;
  if (windows && /^[A-Za-z]:$/u.test(typed)) typed = `${typed}\\`;
  if (typed === "~") return { folder: "~", prefix: "" };
  if (windows && /^\\\\[^\\]*\\?$/u.test(typed)) return "share_needed";
  const cut = typed.lastIndexOf(sep);
  if (cut < 0) return "not_absolute";
  const folder = typed.slice(0, cut + 1);
  return { folder, prefix: typed.slice(cut + 1) };
}

/** A folder as the person reads it, ending in its separator. */
function shownFolder(folder: Folder, sep: string): string {
  return folder.stored.endsWith(sep) ? folder.stored : `${folder.stored}${sep}`;
}

/** A name in the case the OS compares names by, for a prefix that completes it. */
const fold = (name: string): string => name.toLocaleLowerCase();

/** Names a person rarely means and the OS keeps: hidden until the prefix asks for them. */
function hidden(name: string, prefix: string, platform: NodeJS.Platform): boolean {
  if (prefix !== "") return false;
  if (name.startsWith(".")) return true;
  return platform === "win32" && (name.startsWith("$") || name === "System Volume Information");
}

function projectOf(
  stored: string,
  projects: readonly KnownProject[],
  os: FolderOs,
): { id: string; name: string } | undefined {
  const key = folderKey(stored, os);
  const found = projects.find((p) => folderKey(p.stored, os) === key);
  return found === undefined ? undefined : { id: found.id, name: found.name };
}

/** Where a person may begin: the home, the folders holding the projects' folders, the roots. */
export async function startOf(facts: ListFacts): Promise<Listing> {
  const { platform } = facts;
  const sep = sepOf(platform);
  const os = osOf(platform);
  const places: { folder: string; project?: string }[] = [{ folder: "~" }];
  const seen = new Set([folderKey("~", os)]);
  for (const project of facts.projects ?? []) {
    const cut = project.stored.lastIndexOf(sep);
    if (cut <= 0) continue;
    const parent = project.stored.slice(0, cut);
    const key = folderKey(parent, os);
    if (seen.has(key) || places.length > 5) continue;
    seen.add(key);
    places.push({ folder: parent, project: project.name });
  }
  let roots: string[] = ["/"];
  if (platform === "win32") {
    const letters = "CDEFGHIJKLMNOPQRSTUVWXYZ".split("");
    const found = await Promise.all(
      letters.map(async (letter) => {
        const root = `${letter}:\\`;
        const here = await bounded(
          () => facts.fs.isFolder(root).catch(() => false),
          facts.ms ?? LOOK_MS,
        );
        return here === true ? root : undefined;
      }),
    );
    roots = found.filter((root): root is string => root !== undefined);
  }
  return { kind: "start", sep, places, roots };
}

/**
 * The folders in the folder `text` names, or its start when it is empty. Each look is bounded by
 * `ms` overall: a scan that runs out of time returns what it read, marked `more`.
 */
export async function listFolders(text: string, facts: ListFacts): Promise<Listing> {
  const { platform, home } = facts;
  const sep = sepOf(platform);
  const os = osOf(platform);
  if (text.trim() === "") return startOf(facts);
  const split = splitTyped(text, platform);
  if (typeof split === "string") return { kind: "problem", sep, reason: split };
  const form = storedForm(split.folder, home, platform);
  if (typeof form === "string") return { kind: "problem", sep, reason: form };
  const at = shownFolder(form, sep);
  const parent = (platform === "win32" ? win32 : posix).dirname(form.absolute);
  const above = parent === form.absolute ? undefined : storedForm(parent, home, platform);
  const up = above === undefined || typeof above === "string" ? undefined : shownFolder(above, sep);
  const ms = facts.ms ?? LOOK_MS;
  const deadline = Date.now() + ms;
  // One time limit for the whole look: each step gets what is left of it.
  const left = () => Math.max(1, deadline - Date.now());
  const looked = await bounded(async (): Promise<FolderReason | undefined> => {
    try {
      return (await facts.fs.isFolder(form.absolute)) ? undefined : "not_a_directory";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ENOTDIR" ? "folder_missing" : "folder_unreadable";
    }
  }, left());
  if (looked !== undefined) return { kind: "problem", sep, reason: looked, at };

  const prefix = split.prefix;
  const wanted = fold(prefix);
  const scanMax = facts.scanMax ?? SCAN_MAX;
  const found: { name: string; link: boolean }[] = [];
  let more = false;
  // What was read so far stays when the time runs out; only a folder that gives nothing at all
  // in time does not answer.
  const read = { count: 0, started: false };
  const scan = bounded(async (): Promise<FolderReason | undefined> => {
    try {
      for await (const entry of facts.fs.entries(form.absolute, deadline)) {
        read.started = true;
        read.count += 1;
        if (read.count > scanMax || Date.now() > deadline) {
          more = true;
          break;
        }
        const { name } = entry;
        if (!fold(name).startsWith(wanted) || hidden(name, prefix, platform)) continue;
        if (entry.isDirectory()) found.push({ name, link: false });
        else if (entry.isSymbolicLink()) found.push({ name, link: true });
      }
      return undefined;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ENOTDIR" ? "folder_missing" : "folder_unreadable";
    }
  }, left());
  const scanned = await scan;
  if (scanned === "not_answering") {
    if (!read.started) return { kind: "problem", sep, reason: "not_answering", at };
    more = true;
  } else if (scanned !== undefined) {
    return { kind: "problem", sep, reason: scanned, at };
  }

  const join = (name: string) =>
    `${form.absolute.endsWith(sep) ? form.absolute : form.absolute + sep}${name}`;
  found.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }),
  );
  const showMax = facts.showMax ?? SHOW_MAX;
  if (found.length > showMax) more = true;
  const shown = found.slice(0, showMax);
  // A link is listed only when it leads to a folder: its target is looked at, never listed. Only
  // the links that would be shown are looked at.
  const links = shown.filter((f) => f.link);
  const leads = await Promise.all(
    links.map((f) => bounded(() => facts.fs.isFolder(join(f.name)).catch(() => false), left())),
  );
  const dead = new Set(links.filter((_, k) => leads[k] !== true).map((f) => f.name));
  const kept = shown.filter((f) => !dead.has(f.name));
  const projects = facts.projects ?? [];
  const storedOf = (name: string) => `${at}${name}`;
  const folders: Listed[] = kept.map((f) => {
    const project = projectOf(storedOf(f.name), projects, os);
    return {
      name: f.name,
      ...(f.link ? { link: true as const } : {}),
      ...(project === undefined ? {} : { project }),
    };
  });

  // The folder the text names exactly: the one listed, or a listed one whose name it is.
  const same = (name: string) => (os === "linux" ? name === prefix : fold(name) === wanted);
  const named = prefix === "" ? undefined : kept.find((f) => same(f.name));
  let exact: Exact | undefined;
  if (prefix === "" || named !== undefined) {
    const stored = named === undefined ? form.stored : storedOf(named.name);
    const absolute = named === undefined ? form.absolute : join(named.name);
    const name = folderName(absolute, platform);
    const found = await bounded(() => facts.fs.repo(absolute).catch(() => undefined), left());
    const repo = found === "not_answering" ? undefined : found;
    const project = projectOf(stored, projects, os);
    exact = {
      folder: stored,
      ...(name === undefined ? {} : { name }),
      ...(repo === undefined ? {} : { repo }),
      ...(project === undefined ? {} : { project }),
    };
  }
  return {
    kind: "list",
    sep,
    at,
    prefix,
    ...(up === undefined ? {} : { up }),
    folders,
    more,
    ...(exact === undefined ? {} : { exact }),
  };
}

/**
 * Makes the folder `text` names, in a folder that exists: the chooser's "Make this folder". A
 * folder that is there already is fine. Bounded like a look.
 */
export async function makeFolder(
  text: string,
  facts: Pick<ListFacts, "home" | "platform" | "fs" | "ms">,
): Promise<{ folder: string } | { reason: ListReason }> {
  const sep = sepOf(facts.platform);
  const trimmed = text.endsWith(sep) && text.length > 1 ? text.slice(0, -1) : text;
  const form = storedForm(trimmed, facts.home, facts.platform);
  if (typeof form === "string") return { reason: form };
  const made = await bounded(async (): Promise<FolderReason | undefined> => {
    try {
      await facts.fs.make(form.absolute);
      return undefined;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        return (await facts.fs.isFolder(form.absolute).catch(() => false))
          ? undefined
          : "not_a_directory";
      }
      return code === "ENOENT" || code === "ENOTDIR" ? "folder_missing" : "folder_unreadable";
    }
  }, facts.ms ?? LOOK_MS);
  return made === undefined ? { folder: form.stored } : { reason: made };
}
