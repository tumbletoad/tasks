// Who else can change a file or folder of this install, and what fixes it (A2 3.2.2 rule 5).
// Linux and macOS only: on Windows the profile's ACL is
// doctor's to check.
//
// The rule: a file or folder Tasks trusts must belong to this user and may not be writable by every
// user. Its group may write it only when that group is the person's own private group: the object's
// group ID is their account's primary group ID, and that group's name is their user name (the user
// private groups of distributions whose umask is 002; @tasks/files/person reads it). Any other
// group's write is refused, because whether a group has members besides the person cannot be known
// for certain (a directory service adds accounts no local file lists), and this rule lists no
// members. Its limits: whoever can add a member to a person's private group administers the
// machine, and ACLs are not read, so a write a person grants another user by ACL on a folder of
// their private group is not seen (A2 3.2.2 rule 5). macOS's primary group `staff` is shared, so
// group write stays refused there. The install script (scripts/install/install.sh) applies the same
// rule to the install root and the folders above it, launch applies it to T3's files
// (t3-client.ts), and the script and this file run one table of cases (test/fixtures/
// group-rule.json). Tasks gives everything it creates an exact mode (files.ts), so only a file or
// folder a person made or changed by hand can fail the rule.
//
// This is the one place that turns the facts of a path into what is wrong with it and the command
// that fixes it. factsOf reads them; problemOf judges them by the whole rule for that kind of object
// (a folder Tasks writes in, the socket folder, machine.toml); repairOf builds the command from the
// same rule, so the one line a person pastes makes the next start pass. It also gives the owner back
// the access Tasks needs (u+rwx on a folder, u+rw on the file, never recursive): a folder or file
// that belonged to another user often lacks it.
//
// A command that changes an owner runs as root, so it must change exactly the file it names. It is
// never given for a path that is a link, or that has a link on its way: chown -h does not follow
// the path's own link, but a link above it would still be followed. Configuration is never read
// through a link at all (machine-toml.ts), so a link there is named with where it points.
import { lstatSync, readlinkSync, statSync, type Stats } from "node:fs";
import { userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { PRODUCT_NAME } from "@tasks/brand";
import { currentPerson, groupMayWrite, type Person } from "@tasks/files/person";
import { MAX_LINE_BYTES, shellWord } from "@tasks/launch/shell-line";

export { currentPerson, isOwnGroup, type Person } from "@tasks/files/person";

/**
 * What Tasks needs of a file or folder it trusts. `folder`: the state, log, crash and cache folders
 * and the configuration folder, which it reads and writes in. `private_folder`: the socket folder,
 * which keeps every other user from the socket, so its group and others have no access at all.
 * `file`: machine.toml, which it reads.
 */
export type Need = "folder" | "private_folder" | "file";

/** Why a file or folder fails its rule, the most important reason first. */
export type Unsafe =
  /** A link where a link is not followed (configuration). */
  | "link"
  | "not_a_folder"
  | "not_a_file"
  | "other_owner"
  | "world_writable"
  | "group_writable"
  /** The socket folder: its group or others have any access. */
  | "open_to_others"
  /** The owner lacks what Tasks needs: rwx on a folder, read on the file. */
  | "no_access";

/** What the rule looks at for one path. */
export interface PathFacts {
  readonly path: string;
  readonly need: Need;
  /** What is at the path, or at the link's target when a link there is followed. */
  readonly kind: "folder" | "file" | "other";
  readonly uid: number;
  /** Its group's ID. */
  readonly gid: number;
  /** The permission bits (mode & 0o7777). */
  readonly mode: number;
  /** When the path itself is a link: where it points, as the link says. */
  readonly link?: string;
  /** Whether a link at the path is followed: the state folder may be a link to another disk. */
  readonly followsLink?: boolean;
  /** The first folder on the way to the path that is a link, and where it points. */
  readonly linkAbove?: { readonly at: string; readonly to: string };
}

/** The bits the owner must have for Tasks to use it. */
const NEEDED: Readonly<Record<Need, number>> = {
  folder: 0o700,
  private_folder: 0o700,
  file: 0o400,
};

/** Whether the group of these facts may write: it is the person's own private group. */
const groupWrites = (facts: PathFacts, person: Person): boolean => groupMayWrite(facts.gid, person);

/** Why these facts fail their rule, or undefined when they pass (POSIX). */
export function problemOf(facts: PathFacts, person: Person): Unsafe | undefined {
  if (facts.link !== undefined && facts.followsLink !== true) return "link";
  if (facts.need === "file") {
    if (facts.kind !== "file") return "not_a_file";
  } else if (facts.kind !== "folder") {
    return "not_a_folder";
  }
  if (facts.uid !== person.uid) return "other_owner";
  if (facts.need === "private_folder") {
    if ((facts.mode & 0o077) !== 0) return "open_to_others";
  } else if ((facts.mode & 0o002) !== 0) {
    return "world_writable";
  } else if ((facts.mode & 0o020) !== 0 && !groupWrites(facts, person)) {
    return "group_writable";
  }
  const needed = NEEDED[facts.need];
  return (facts.mode & needed) === needed ? undefined : "no_access";
}

/** A person whose group never writes: what pure judgements use when no person is given. */
const NOBODY_ELSE: Person = {
  uid: -1,
  ownGroup: () => undefined,
  groupName: () => undefined,
};

const kindOf = (stat: Stats): PathFacts["kind"] =>
  stat.isDirectory() ? "folder" : stat.isFile() ? "file" : "other";

function readLink(path: string): string {
  try {
    return readlinkSync(path);
  } catch {
    return "?";
  }
}

/** The outermost folder on the way to `path` (the path itself left out) that is a link. */
export function linkAbove(path: string): PathFacts["linkAbove"] {
  const parts: string[] = [];
  for (let at = dirname(resolve(path)); dirname(at) !== at; at = dirname(at)) parts.unshift(at);
  for (const at of parts) {
    try {
      if (lstatSync(at).isSymbolicLink()) return { at, to: readLink(at) };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The facts of `stat`, read for `path` without following a link at it (a descriptor's, or an
 * lstat's), with the first link above the path.
 */
export function factsFrom(path: string, need: Need, stat: Stats): PathFacts {
  const above = linkAbove(path);
  return {
    path,
    need,
    kind: kindOf(stat),
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode & 0o7777,
    ...(above === undefined ? {} : { linkAbove: above }),
  };
}

/**
 * The facts of `path` (POSIX): "missing" when nothing is there, "unseen" when this user cannot look
 * (a folder on the way it cannot enter). A link at the path is followed only with `followLink`.
 */
export function factsOf(
  path: string,
  need: Need,
  options: { readonly followLink: boolean },
): PathFacts | "missing" | "unseen" {
  let own: Stats;
  try {
    own = lstatSync(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unseen";
  }
  if (!own.isSymbolicLink()) return factsFrom(path, need, own);
  // Typed apart from the union, whose string members would read `link` as String.prototype.link.
  const pointsTo = readLink(path);
  if (!options.followLink) {
    const unfollowed: PathFacts = { ...factsFrom(path, need, own), link: pointsTo };
    return unfollowed;
  }
  let target: Stats;
  try {
    target = statSync(path);
  } catch {
    return "unseen";
  }
  const followed: PathFacts = {
    ...factsFrom(path, need, target),
    link: pointsTo,
    followsLink: true,
  };
  return followed;
}

/** A file or folder that fails the rule: its facts and why. */
export interface Judged {
  readonly facts: PathFacts;
  readonly problem: Unsafe;
}

/**
 * Judges `path` by the rule for `need` (POSIX): undefined when it passes or is not there, "unseen"
 * when this user cannot look at it (a folder on the way it cannot enter). A link at the path is
 * followed only with `followLink`. `person`: this process's, by default; none on Windows.
 */
export function judgePath(
  path: string,
  need: Need,
  options: { readonly followLink: boolean },
  person: Person | undefined = currentPerson(),
): Judged | "unseen" | undefined {
  if (person === undefined) return undefined;
  const facts = factsOf(path, need, options);
  if (facts === "missing") return undefined;
  if (facts === "unseen") return "unseen";
  const problem = problemOf(facts, person);
  return problem === undefined ? undefined : { facts, problem };
}

/** This process's person, or on Windows one whose group never writes (the words still work). */
const thisPerson = (): Person => currentPerson() ?? NOBODY_ELSE;

/** The command that makes these facts pass their rule, or why none is given. */
export interface Repair {
  /** Give it to this user first: `sudo chown -h <user> <path>`. */
  readonly chown: boolean;
  /** Then this chmod, for example `u+rwx,go-w`. */
  readonly chmod?: string;
  /** Why no command is given: a link (at the path or above it), or the wrong kind of object. */
  readonly none?: "link" | "link_above" | "kind";
}

/**
 * The repair for facts that fail with `problem`, built from the whole rule for the object: the
 * owner first, then every bit that must change, so that after it the facts pass: write for every
 * user goes (`o-w`), and write for the group unless it is the person's own private group (`g-w`).
 * Another owner gets no command through a link (see the top of this file), and then no chmod
 * either, which only the owner could run.
 */
export function repairOf(facts: PathFacts, problem: Unsafe, person = thisPerson()): Repair {
  if (problem === "link") return { chown: false, none: "link" };
  if (problem === "not_a_folder" || problem === "not_a_file") return { chown: false, none: "kind" };
  const chown = problem === "other_owner";
  if (chown && facts.link !== undefined) return { chown: false, none: "link" };
  if (chown && facts.linkAbove !== undefined) return { chown: false, none: "link_above" };
  const parts: string[] = [];
  const own = facts.need === "file" ? 0o600 : 0o700;
  if ((facts.mode & own) !== own) parts.push(facts.need === "file" ? "u+rw" : "u+rwx");
  if (facts.need === "private_folder") {
    if ((facts.mode & 0o077) !== 0) parts.push("go-rwx");
  } else {
    const group = (facts.mode & 0o020) !== 0 && !groupWrites(facts, person);
    const world = (facts.mode & 0o002) !== 0;
    if (group || world) parts.push(`${group ? "g" : ""}${world ? "o" : ""}-w`);
  }
  return parts.length === 0 ? { chown } : { chown, chmod: parts.join(",") };
}

/**
 * A path as a person types it in a POSIX shell: `~/` for the home folder, quoted when needed by
 * launch's shell-line.ts (the rule for every line setup and doctor print to paste, A3 3.13.7).
 * Undefined when no quoting keeps it literal (a control character other than a newline). POSIX
 * paths only (the rule
 * applies on Linux and macOS), so the separator is `/` on every OS.
 */
export function shellArg(
  path: string,
  home: string | undefined = homeOrUndefined(),
): string | undefined {
  if (home !== undefined && home !== "" && home !== "/" && path.startsWith(`${home}/`)) {
    const rest = shellWord("linux", path.slice(home.length + 1));
    return rest === undefined ? undefined : `~/${rest}`;
  }
  return shellWord("linux", path);
}

/**
 * A path in a sentence: as a person types it, or with its control characters escaped. A Windows
 * path, for which no POSIX shell line is given, as Windows shows it.
 */
export function shellPath(path: string, home: string | undefined = homeOrUndefined()): string {
  if (/^(?:[A-Za-z]:[\\/]|\\\\)/u.test(path)) {
    return /\p{Cc}/u.test(path) ? JSON.stringify(path) : path;
  }
  return shellArg(path, home) ?? JSON.stringify(path);
}

function homeOrUndefined(): string | undefined {
  try {
    return userInfo().homedir;
  } catch {
    return undefined;
  }
}

/** This user's name for a chown line; the shell's own answer when it cannot be read here. */
function userName(): string {
  try {
    return shellWord("linux", userInfo().username) ?? '"$(id -un)"';
  } catch {
    return '"$(id -un)"';
  }
}

/** One file or folder that failed the rule, as a person reads it. */
export interface UnsafeThing {
  /** What it is, for example "Tasks's state folder". */
  readonly name: string;
  readonly facts: PathFacts;
  readonly problem: Unsafe;
  /**
   * A folder this user cannot look inside: what in it could not be judged, for example "Tasks's
   * machine.toml". The message says that it is checked on the next start.
   */
  readonly hides?: string;
}

/** What is wrong, in plain words, for one thing and for several. */
const REASONS: Readonly<
  Record<Exclude<Unsafe, "link" | "no_access" | "group_writable">, readonly [string, string]>
> = {
  not_a_folder: ["is a file, not a folder", "are files, not folders"],
  not_a_file: ["is not a regular file", "are not regular files"],
  other_owner: ["belongs to another user", "belong to another user"],
  world_writable: [
    "can be changed by every user on this machine",
    "can be changed by every user on this machine",
  ],
  open_to_others: [
    "can be opened by other users, not only by you",
    "can be opened by other users, not only by you",
  ],
};

/**
 * The group of these facts as a person reads it: its name, or its ID when the name cannot be read
 * or holds what a line cannot show as it is.
 */
function groupLabel(facts: PathFacts, person: Person): string {
  const name = person.groupName(facts.gid);
  return name !== undefined && shellWord("linux", name) === name
    ? name
    : `with ID ${String(facts.gid)}`;
}

/** What is wrong with one thing, in words: "belongs to another user"; [one, several]. */
function reasons(thing: UnsafeThing, person: Person): readonly [string, string] {
  if (thing.problem === "link") {
    const to = `is a link to ${shellPath(thing.facts.link ?? "?")}`;
    return [to, to];
  }
  if (thing.problem === "no_access") {
    return thing.facts.need === "file"
      ? ["cannot be read by you", "cannot be read by you"]
      : [
          "does not let you read, change and enter it",
          "do not let you read, change and enter them",
        ];
  }
  if (thing.problem === "group_writable") {
    const group = groupLabel(thing.facts, person);
    return [
      `can be changed by the members of its group ${group}, not only by you`,
      `can be changed by the members of their group ${group}, not only by you`,
    ];
  }
  return REASONS[thing.problem];
}

/** What is wrong with one file or folder, in words: "belongs to another user". */
export const unsafeReason = (thing: UnsafeThing, person = thisPerson()): string =>
  reasons(thing, person)[0];

/**
 * The one line a person pastes to make every thing pass, or undefined when no command can: also
 * when a path in it holds a character no line to paste keeps literal, or the line would be longer
 * than a line to paste can be (launch's MAX_LINE_BYTES, A3 3.13.7).
 */
export function fixCommand(
  things: readonly Pick<UnsafeThing, "facts" | "problem">[],
  user: string = userName(),
  person = thisPerson(),
): string | undefined {
  const line = repairLine(things, user, person);
  return line !== undefined && Buffer.byteLength(line, "utf8") <= MAX_LINE_BYTES ? line : undefined;
}

/** The repair as one line, however long; undefined when no command can. */
function repairLine(
  things: readonly Pick<UnsafeThing, "facts" | "problem">[],
  user: string,
  person: Person,
): string | undefined {
  if (things.some((t) => shellArg(t.facts.path) === undefined)) return undefined;
  const repairs = things.map((t) => ({
    path: shellPath(t.facts.path),
    repair: repairOf(t.facts, t.problem, person),
  }));
  const chown = repairs.filter((r) => r.repair.chown).map((r) => r.path);
  // One chmod per change, in the order the things come (a folder before the file in it, so a
  // folder that gets back its x bit is entered for the file).
  const chmods = new Map<string, string[]>();
  for (const { path, repair } of repairs) {
    if (repair.chmod !== undefined) {
      chmods.set(repair.chmod, [...(chmods.get(repair.chmod) ?? []), path]);
    }
  }
  const steps = [
    ...(chown.length > 0 ? [`sudo chown -h ${user} ${chown.join(" ")}`] : []),
    ...[...chmods].map(([spec, paths]) => `chmod ${spec} ${paths.join(" ")}`),
  ];
  return steps.length > 0 ? steps.join(" && ") : undefined;
}

/** What a person reads about one thing the command cannot reach, or cannot see inside. */
function noteOf(thing: UnsafeThing, person: Person): string | undefined {
  const repair = repairOf(thing.facts, thing.problem, person);
  if (repair.none === "link" && thing.problem === "link") {
    const real = thing.facts.need === "file" ? "a real file" : "a real folder";
    return `${PRODUCT_NAME} does not follow links for its configuration: put ${real} in place of the link.`;
  }
  if (repair.none === "link") {
    return `${shellPath(thing.facts.path)} is a link to ${shellPath(thing.facts.link ?? "?")}, and ${PRODUCT_NAME} gives no command that changes an owner through a link.`;
  }
  if (repair.none === "link_above" && thing.facts.linkAbove !== undefined) {
    const { at, to } = thing.facts.linkAbove;
    return `${shellPath(at)}, on the way to ${shellPath(thing.facts.path)}, is a link to ${shellPath(to)}, and ${PRODUCT_NAME} gives no command that changes an owner through a link.`;
  }
  if (thing.hides !== undefined) {
    return `${PRODUCT_NAME} cannot look inside ${shellPath(thing.facts.path)} until that is fixed, so what is inside it (${thing.hides}) is checked on the next start.`;
  }
  return undefined;
}

/**
 * The whole line a person reads: what is wrong with which file or folder, in plain words first,
 * then why that stops Tasks (`why`, a sentence), then what the command cannot reach or see, then
 * the one command that fixes the rest. `person`: whose rule judged the things, this process's by
 * default.
 */
export function unsafeMessage(
  things: readonly UnsafeThing[],
  why: string,
  user?: string,
  person = thisPerson(),
): string {
  const named = (t: UnsafeThing) => `${t.name} (${shellPath(t.facts.path)})`;
  const first = things[0];
  const wrong =
    first !== undefined &&
    things.length > 1 &&
    things.every((t) => reasons(t, person)[0] === reasons(first, person)[0])
      ? `${things.map(named).join(" and ")} ${reasons(first, person)[1]}`
      : things.map((t) => `${named(t)} ${reasons(t, person)[0]}`).join("; ");
  const fix = fixCommand(things, user, person);
  const notes = things.map((t) => noteOf(t, person)).filter((note) => note !== undefined);
  if (things.some((t) => shellArg(t.facts.path) === undefined)) {
    notes.push(
      "No command is given, because a path in it holds a control character, which a line to paste cannot show as it is.",
    );
  } else if (fix === undefined && repairLine(things, user ?? userName(), person) !== undefined) {
    notes.push(
      `No command is given, because it would be longer than a line to paste can be (${String(MAX_LINE_BYTES)} bytes).`,
    );
  }
  const partial = things.some((t) => repairOf(t.facts, t.problem, person).none !== undefined);
  const run = partial ? "For the others, run" : "To fix it, run";
  return [`${wrong}.`, `${why}.`, ...notes, ...(fix === undefined ? [] : [`${run}: ${fix}`])].join(
    " ",
  );
}
