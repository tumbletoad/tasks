// A place's Git remote, read from the repository's config file, never by starting git.
// The remote is a check of which repository a folder holds, so reading it wrongly is worse than not
// reading it. It is read step by step (`.git`, a git folder, `commondir`, the config), each read at
// its own moment: an observation, not an identity. The config
// file is read by git's own syntax (git-config(1), CONFIGURATION FILE; git's config.c), within
// explicit bounds, and everything this reader does not support makes the config unreadable: an
// include, a URL rewrite that would apply, a per-worktree config, a syntax error git refuses, a
// NUL character, text that is not UTF-8, a file or a URL beyond its bound. Unreadable is never a
// guess: binding records no remote then (and says so), and a place that recorded one does not
// match.
import { lstat, open } from "node:fs/promises";
import { posix, win32 } from "node:path";

/** What a folder's repository says its remote is. */
export type GitRemote =
  /** A network address git reaches by itself, without credentials: what a place records. */
  | { readonly status: "remote"; readonly url: string }
  /**
   * No repository in the folder itself, a repository without a remote, or a remote kept off the
   * record by design (a local path, a remote helper, another scheme).
   */
  | { readonly status: "none" }
  /** A repository whose config this reader cannot read exactly: never a guess. */
  | { readonly status: "unreadable" };

const NONE: GitRemote = { status: "none" };
const UNREADABLE: GitRemote = { status: "unreadable" };

/** The bounds of the files read: a `.git` file and `commondir`, and the config itself. */
const MAX_GIT_FILE = 4096;
const MAX_GIT_CONFIG = 256 * 1024;
/** The longest remote a place records, the space's writer's bound. */
const MAX_REMOTE = 2048;

// ---------------------------------------------------------------------------------------------
// git's config syntax

/** One entry of a config file as git reads it. */
export interface GitConfigEntry {
  /**
   * `section.name` or `section.subsection.name` as git spells it: the section and the name in
   * lower case, a quoted subsection as written, a dotted one (`[section.sub]`) in lower case.
   */
  readonly key: string;
  /** The value; null for a name without `=` (git's boolean true). */
  readonly value: string | null;
}

// git's own character classes (git's ctype.c), which are ASCII only: a byte of a multi-byte
// character is none of them.
const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";
const isAlpha = (c: string): boolean => (c >= "A" && c <= "Z") || (c >= "a" && c <= "z");
const isKeyChar = (c: string): boolean => isAlpha(c) || (c >= "0" && c <= "9") || c === "-";
const lower = (c: string): string => (c >= "A" && c <= "Z" ? c.toLowerCase() : c);

/**
 * A config file's text read the way git reads it (config.c `git_parse_source`): the entries in
 * order, or undefined when git refuses the text (`bad config line`) or it holds a NUL character
 * (git cuts a value there). Sections, quoted and dotted subsections, names, `=`, values with
 * quotes, the escapes `\"`, `\\`, `\n`, `\t` and `\b`, a backslash that continues a line, comments
 * with `#` and `;`, CRLF, a section header with a setting after it on the same line and a UTF-8
 * byte order mark in front are all read as git reads them. Blanks between the words of a value
 * are kept as written, as git-config(1) says and newer git does (2.55); older git (2.34) wrote a
 * space for each, which `remoteFromConfig` allows for. Includes are not followed here: they are
 * entries like any other, which `remoteFromConfig` refuses.
 */
export function parseGitConfig(text: string): readonly GitConfigEntry[] | undefined {
  if (text.includes("\u0000")) return undefined;
  let at = text.startsWith("\ufeff") ? 1 : 0;
  // An object, so a read of it after a call to next() is not narrowed away.
  const read = { eof: false };
  /** git's `get_next_char`: CRLF is one newline; past the end, always a newline. */
  const next = (): string => {
    if (at >= text.length) {
      read.eof = true;
      return "\n";
    }
    const c = text[at] ?? "";
    at += 1;
    if (c === "\r" && text[at] === "\n") {
      at += 1;
      return "\n";
    }
    return c;
  };

  /** `[name]`, `[name.sub]` or `[name "sub"]` after its `[`: the key's stem, or undefined. */
  const header = (): string | undefined => {
    let name = "";
    for (;;) {
      const c = next();
      if (read.eof) return undefined;
      if (c === "]") return name;
      if (isSpace(c)) return subsection(name, c);
      if (!isKeyChar(c) && c !== ".") return undefined;
      name += lower(c);
    }
  };
  /** git's `get_extended_base_var`: spaces, then a quoted subsection, then `]` at once. */
  const subsection = (name: string, first: string): string | undefined => {
    let c = first;
    do {
      if (c === "\n") return undefined;
      c = next();
    } while (isSpace(c));
    if (c !== '"') return undefined;
    let stem = `${name}.`;
    for (;;) {
      let d = next();
      if (d === "\n") return undefined;
      if (d === '"') break;
      if (d === "\\") {
        d = next();
        if (d === "\n") return undefined;
      }
      stem += d;
    }
    return next() === "]" ? stem : undefined;
  };
  /** git's `parse_value`, after the `=`: the value, or undefined on an error git refuses. */
  const value = (): string | undefined => {
    let quoted = false;
    let comment = false;
    let out = "";
    // Where trailing blanks would be cut; 0 is "none", as in git.
    let trim = 0;
    for (;;) {
      let c = next();
      if (c === "\n") {
        if (quoted) return undefined;
        return trim > 0 ? out.slice(0, trim) : out;
      }
      if (comment) continue;
      if (isSpace(c) && !quoted) {
        if (trim === 0) trim = out.length;
        if (out.length > 0) out += c;
        continue;
      }
      if (!quoted && (c === ";" || c === "#")) {
        comment = true;
        continue;
      }
      trim = 0;
      if (c === "\\") {
        c = next();
        if (c === "\n") continue;
        if (c === "t") c = "\t";
        else if (c === "b") c = "\b";
        else if (c === "n") c = "\n";
        else if (c !== "\\" && c !== '"') return undefined;
        out += c;
        continue;
      }
      if (c === '"') {
        quoted = !quoted;
        continue;
      }
      out += c;
    }
  };

  const entries: GitConfigEntry[] = [];
  let stem = "";
  let comment = false;
  for (;;) {
    const c = next();
    if (c === "\n") {
      if (read.eof) return entries;
      comment = false;
      continue;
    }
    if (comment || isSpace(c)) continue;
    if (c === "#" || c === ";") {
      comment = true;
      continue;
    }
    if (c === "[") {
      const name = header();
      if (name === undefined || name.length === 0) return undefined;
      stem = `${name}.`;
      continue;
    }
    if (!isAlpha(c)) return undefined;
    // git's `get_value`: the rest of the name, blanks, then `=` and a value or the line's end.
    let name = lower(c);
    let d: string;
    for (;;) {
      d = next();
      if (read.eof || !isKeyChar(d)) break;
      name += lower(d);
    }
    while (d === " " || d === "\t") d = next();
    let found: string | null = null;
    if (d !== "\n") {
      if (d !== "=") return undefined;
      const v = value();
      if (v === undefined) return undefined;
      found = v;
    }
    entries.push({ key: stem + name, value: found });
  }
}

// ---------------------------------------------------------------------------------------------
// The remote in a config file

/** A key's section (before the first dot), subsection (between) and name (after the last). */
function splitKey(key: string): { section: string; sub: string | undefined; name: string } {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first < 0) return { section: "", sub: undefined, name: key };
  return {
    section: key.slice(0, first),
    sub: first === last ? undefined : key.slice(first + 1, last),
    name: key.slice(last + 1),
  };
}

/**
 * The remote a repository's config file names, as a place records it: the first URL of `origin`,
 * else the first URL of the remote whose URL comes first in the file (git fetches from a remote's
 * first URL). Unreadable when the text is not git's syntax, holds an include (`include` or
 * `includeIf`, which would read another file), turns on per-worktree config
 * (`extensions.worktreeConfig`, another file that may set the remote), has a remote URL without a
 * value or with an empty one (newer git reads an empty URL as "forget the earlier ones"), a remote
 * with an empty name, a `url.<base>.insteadOf` that would rewrite the URL, a URL longer than a
 * place may record, or a URL with a blank inside it (older git, 2.34 for one, turns each blank
 * between words into a space and newer git, 2.55 for one, keeps it: two readings). A URL that is
 * not a network address is `none` (portableRemote).
 */
export function remoteFromConfig(text: string): GitRemote {
  const entries = parseGitConfig(text);
  if (entries === undefined) return UNREADABLE;
  const urls = new Map<string, string>();
  const rewrites: string[] = [];
  for (const { key, value } of entries) {
    const { section, sub, name } = splitKey(key);
    if (section === "include" || section === "includeif") return UNREADABLE;
    if (section === "extensions" && sub === undefined && name === "worktreeconfig") {
      return UNREADABLE;
    }
    if (section === "url" && sub !== undefined && name === "insteadof") {
      if (value === null) return UNREADABLE;
      rewrites.push(value);
    }
    if (section === "remote" && sub !== undefined && name === "url") {
      if (value === null || value === "" || sub === "") return UNREADABLE;
      if (!urls.has(sub)) urls.set(sub, value);
    }
  }
  const url = urls.get("origin") ?? urls.values().next().value;
  if (url === undefined) return NONE;
  if (url.length > MAX_REMOTE || /[ \t\r]/u.test(url)) return UNREADABLE;
  if (rewrites.some((prefix) => url.startsWith(prefix))) return UNREADABLE;
  const kept = portableRemote(url);
  return kept === undefined ? NONE : { status: "remote", url: kept };
}

/**
 * A remote as a place may record it, or undefined. A space travels, so only a network address is
 * kept: a local path (`/srv/x.git`, `C:\x`, `file://…`, a relative path) is a machine-local fact
 * and is not recorded. Credentials are removed (a token in an HTTPS address is a secret); the user
 * of an SSH address is kept (`git@host`). The address is kept as git uses it, as text: nothing is
 * normalised (no dot segment folded, no escape decoded, no case or default port changed), so two
 * addresses git keeps apart are never recorded as one. A form that cannot be cleaned that way is
 * not recorded: a query or a fragment (part of the address git uses, and a place for a secret), a
 * user name holding an `@`, a scheme git does not know as written (git's are lower case).
 */
export function portableRemote(url: string): string | undefined {
  if (url === "" || url.length > MAX_REMOTE || !PRINTABLE_WORD.test(url)) return undefined;
  // A remote helper (`<transport>::<address>`, `ext::`, `fd::`) names a program or a local
  // resource, not an address git reaches by itself: never recorded. Git reads any run of letters,
  // digits, `+`, `-` and `.` before `::` as a helper's name (transport.c), a digit first included.
  if (/^[A-Za-z0-9+.-]*::/u.test(url)) return undefined;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//u.exec(url);
  if (scheme === null) return SCP_LIKE.test(url) ? url : undefined;
  const name = scheme[1] ?? "";
  if (!NETWORK_SCHEMES.has(name)) return undefined;
  if (url.includes("?") || url.includes("#")) return undefined;
  const rest = url.slice(name.length + 3);
  const slash = rest.indexOf("/");
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  const path = slash < 0 ? "" : rest.slice(slash);
  const parts = authority.split("@");
  if (parts.length > 2) return undefined;
  const host = parts[parts.length - 1] ?? "";
  if (!HOST.test(host)) return undefined;
  let user = "";
  if (parts.length === 2 && !USER_IS_CREDENTIAL.has(name)) {
    // `user:password`: the password goes, the user names the account and stays.
    user = (parts[0] ?? "").split(":")[0] ?? "";
    if (!USER.test(user)) return undefined;
  }
  return `${name}://${user === "" ? "" : `${user}@`}${host}${path}`;
}

/** One word of printable ASCII: no space, control character, DEL or other script. */
const PRINTABLE_WORD = /^[\x21-\x7e]+$/u;
/** A URL's host: a host name or a bracketed address, and a port. */
const HOST = /^(?:[A-Za-z0-9._~-]+|\[[0-9A-Fa-f:.]+\])(?::[0-9]*)?$/u;
/** An SSH user name as a place keeps it. */
const USER = /^[A-Za-z0-9._~-]+$/u;
/** The schemes whose user is a credential (HTTP and FTP authentication), removed with it. */
const USER_IS_CREDENTIAL = new Set(["http", "https", "ftp", "ftps"]);

/** The URL schemes git reaches over the network by itself (git-clone(1), GIT URLS). */
const NETWORK_SCHEMES = new Set([
  "ssh",
  "git+ssh",
  "ssh+git",
  "git",
  "http",
  "https",
  "ftp",
  "ftps",
]);
/**
 * The scp-like form `[user@]host:path`: a host name (letters, digits, `.`, `-`, `_`, at least two
 * characters, so never a drive letter) or a bracketed address, then a colon not followed by `//`.
 */
const SCP_LIKE =
  /^(?:[A-Za-z0-9._~-]+@)?(?:[A-Za-z0-9_-][A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\]):(?!\/\/)/u;

// ---------------------------------------------------------------------------------------------
// The repository of a folder

/** A file's bytes, at most `max`; `missing` when nothing is there; `unreadable` otherwise. */
async function readBounded(path: string, max: number): Promise<Buffer | "missing" | "unreadable"> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > max) return "unreadable";
    const buffer = Buffer.alloc(max + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > max) return "unreadable";
    return buffer.subarray(0, bytesRead);
  } catch {
    return "unreadable";
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** UTF-8 text, or undefined when the bytes are not UTF-8 (a byte order mark is kept). */
function utf8(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** A line break or a NUL inside a path named in a git file: git would read another path. */
const breaksPath = (path: string): boolean =>
  path.includes("\n") || path.includes("\r") || path.includes("\u0000");

/** A path named in a git file, joined to the folder it is relative to the way git joins it. */
function under(folder: string, named: string, P: typeof posix): string {
  return P.isAbsolute(named) ? named : `${folder}${P.sep}${named}`;
}

/**
 * The remote of the repository whose working folder is `folder` (absolute, or `.` for the
 * working directory itself), as a place records it. `.git` is a folder, or a file `gitdir: <path>`
 * (a linked worktree or a submodule), and the git folder's `commondir` names the repository that
 * holds the config, all as git reads them. Only `folder` itself is looked at, never a parent. A
 * relative path in these files is joined to the folder it is relative to, not to the process's
 * path, so for `.` every read goes through the directory the process is in. Every file is read
 * bounded.
 */
export async function readGitRemote(
  folder: string,
  platform: NodeJS.Platform = process.platform,
): Promise<GitRemote> {
  const P = platform === "win32" ? win32 : posix;
  const dotGit = `${folder}${P.sep}.git`;
  let gitDir: string;
  try {
    const info = await lstat(dotGit);
    if (info.isDirectory()) gitDir = dotGit;
    else if (info.isFile()) {
      // git's read_gitfile: `gitdir: ` and a path, trailing line ends removed.
      const bytes = await readBounded(dotGit, MAX_GIT_FILE);
      const text = typeof bytes === "string" ? undefined : utf8(bytes);
      if (text === undefined || !text.startsWith("gitdir: ")) return UNREADABLE;
      const named = text.slice(8).replace(/[\r\n]+$/u, "");
      if (named === "" || breaksPath(named)) return UNREADABLE;
      gitDir = under(folder, named, P);
    } else return UNREADABLE; // a link or another kind of file: git follows it, this reader does not
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? NONE : UNREADABLE;
  }
  let configDir = gitDir;
  const common = await readBounded(`${gitDir}${P.sep}commondir`, MAX_GIT_FILE);
  if (common === "unreadable") return UNREADABLE;
  if (common !== "missing") {
    const text = utf8(common)?.replace(/[\r\n]+$/u, "");
    if (text === undefined || text === "" || breaksPath(text)) return UNREADABLE;
    configDir = under(gitDir, text, P);
  }
  // A `.git` without a config (or naming a git folder that is not there) is no repository git
  // reads: unreadable, never "no remote".
  const config = await readBounded(`${configDir}${P.sep}config`, MAX_GIT_CONFIG);
  if (typeof config === "string") return UNREADABLE;
  // git skips a UTF-8 byte order mark at the start; the parser does, on the decoded text.
  const text = utf8(config);
  return text === undefined ? UNREADABLE : remoteFromConfig(text);
}
