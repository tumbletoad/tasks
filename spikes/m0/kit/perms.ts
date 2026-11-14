// Owner-only checks for the stand-in service's state folder, runtime folder and key (A2 3.2.2
// rule 5, A6 3.16.6, lab row R10). The service refuses to start on anything another principal
// could read or change, before it writes a discovery file or listens.
// - POSIX: owner and mode. Folders must be owned by this UID and not group- or world-writable
//   (A2 3.2.2), the key must be owned by this UID with no group or other bits at all.
// - Windows: the owner and the DACL, read by SID as SDDL (account names are localised) through
//   Windows PowerShell calling .NET only, with an environment built from scratch (see READ_SDDL).
//   Only the user, SYSTEM and Administrators may own the item or hold an allow entry. Folders and
//   keys the service creates get an explicit user-only ACL through icacls instead of the inherited
//   one. A check that cannot run refuses with `cannot_inspect_permissions`, never with
//   `unsafe_permissions`, so a folder it could not read is never called unsafe.
import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { KitError } from "./wire.ts";

export type Kind = "dir" | "key";

export interface PosixFacts {
  uid: number;
  mode: number;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
}

/** What is unsafe about one folder or key on POSIX. Empty when it is safe. */
export function posixProblems(kind: Kind, facts: PosixFacts, uid: number): string[] {
  const problems: string[] = [];
  if (facts.isSymbolicLink) problems.push("is a symbolic link");
  else if (kind === "dir" && !facts.isDirectory) problems.push("is not a folder");
  else if (kind === "key" && !facts.isFile) problems.push("is not a regular file");
  if (facts.uid !== uid) problems.push(`is owned by UID ${String(facts.uid)}`);
  const open = facts.mode & (kind === "dir" ? 0o022 : 0o077);
  if (open !== 0) {
    problems.push(`has mode ${(facts.mode & 0o777).toString(8)} (open bits ${open.toString(8)})`);
  }
  return problems;
}

export interface AclEntry {
  sid: string;
  type: string;
  rights: string;
  inherited: boolean;
  inheritOnly: boolean;
}

export interface AclFacts {
  path: string;
  owner: string;
  entries: AclEntry[];
  /** The DACL is protected (SDDL flag P): no entry is inherited from the parent. */
  protected?: boolean;
}

const SYSTEM = "S-1-5-18";
const ADMINISTRATORS = "S-1-5-32-544";
const EVERYONE = "S-1-1-0";
/** CREATOR OWNER: an inherit-only placeholder that becomes the creating user on new children. */
const CREATOR_OWNER = "S-1-3-0";

/** What is unsafe about one ACL on Windows. Deny entries never widen access, so they pass. */
export function aclProblems(facts: AclFacts, userSid: string): string[] {
  const trusted = new Set([userSid, SYSTEM, ADMINISTRATORS]);
  const problems: string[] = [];
  if (!trusted.has(facts.owner)) problems.push(`is owned by ${facts.owner}`);
  for (const entry of facts.entries) {
    if (entry.type === "Deny" || trusted.has(entry.sid) || entry.sid === CREATOR_OWNER) continue;
    const how = entry.inheritOnly ? "for new files" : entry.inherited ? "inherited" : "explicit";
    problems.push(`grants ${entry.rights} to ${entry.sid} (${how})`);
  }
  return problems;
}

/** SDDL's two-letter aliases for the well-known SIDs that can appear in a file's owner or DACL. */
const SDDL_ALIASES: Record<string, string> = {
  AC: "S-1-15-2-1",
  AN: "S-1-5-7",
  AU: "S-1-5-11",
  BA: ADMINISTRATORS,
  BG: "S-1-5-32-546",
  BO: "S-1-5-32-551",
  BU: "S-1-5-32-545",
  CG: "S-1-3-1",
  CO: CREATOR_OWNER,
  IU: "S-1-5-4",
  LS: "S-1-5-19",
  NS: "S-1-5-20",
  NU: "S-1-5-2",
  OW: "S-1-3-4",
  PS: "S-1-5-10",
  PU: "S-1-5-32-547",
  RC: "S-1-5-12",
  RD: "S-1-5-32-555",
  RU: "S-1-5-32-554",
  SO: "S-1-5-32-549",
  SU: "S-1-5-6",
  SY: SYSTEM,
  WD: EVERYONE,
  WR: "S-1-5-33",
};
const ALLOW_TYPES = new Set(["A", "OA"]);
const DENY_TYPES = new Set(["D", "OD"]);
// Callback and conditional ACE types. Their effect depends on an expression, so they are refused.
const CONDITIONAL_TYPES = new Set(["XA", "XD", "XU", "ZA"]);

/**
 * The SID an SDDL trustee names. "LA" and "LG" are machine-relative (RID 500 and 501): they are
 * the user only when the user is that account. An alias the table does not know stays visible as
 * "alias XX", so it is never trusted.
 */
function sddlSid(trustee: string, userSid: string): string {
  if (trustee.startsWith("S-")) return trustee;
  if (trustee === "LA" && userSid.endsWith("-500")) return userSid;
  if (trustee === "LG" && userSid.endsWith("-501")) return userSid;
  return SDDL_ALIASES[trustee] ?? `alias ${trustee}`;
}

/**
 * Parses the owner and DACL of one SDDL string ("O:<owner>D:<flags>(ace)(ace)..."), by SID. A
 * missing or null DACL ("D:NO_ACCESS_CONTROL") grants everyone everything, so it becomes an
 * Everyone allow entry. Only the deny ACE types count as deny: any other type counts as allow,
 * so an unknown type fails closed.
 */
export function parseSddl(path: string, sddl: string, userSid: string): AclFacts {
  const unreadable = (why: string) =>
    new KitError(
      "cannot_inspect_permissions",
      `Cannot inspect permissions: ${why} in the security descriptor of ${path}`,
    );
  // Read strictly from the left: owner, an optional group, then the DACL. Nothing is searched
  // for, so text inside one part can never be taken for the start of another.
  const head = /^O:(S-[0-9-]+|[A-Z]{2})(?:G:(?:S-[0-9-]+|[A-Z]{2}))?/.exec(sddl);
  const owner = head?.[1];
  if (head === null || owner === undefined) throw unreadable("no owner");
  const rest = sddl.slice(head[0].length);
  const flags = /^D:([A-Z_]*)/.exec(rest);
  if (rest !== "" && flags === null) throw unreadable("unexpected text after the owner");
  if (flags === null || (flags[1] ?? "").includes("NO_ACCESS_CONTROL")) {
    const everyone: AclEntry = {
      sid: EVERYONE,
      type: "Allow",
      rights: "everything (no DACL)",
      inherited: false,
      inheritOnly: false,
    };
    return { path, owner: sddlSid(owner, userSid), entries: [everyone], protected: false };
  }
  // Every character of the DACL must be consumed by a well-formed ACE. A conditional or callback
  // ACE nests parentheses and adds a seventh field: a flat reader would stop at its first ")" and
  // never see the entries after it (review round 3). Such an ACE is refused, never interpreted.
  const entries: AclEntry[] = [];
  let at = flags[0].length;
  while (at < rest.length) {
    if (rest[at] !== "(") throw unreadable("text outside an entry");
    let depth = 0;
    let end = at;
    for (; end < rest.length; end += 1) {
      if (rest[end] === "(") depth += 1;
      else if (rest[end] === ")" && (depth -= 1) === 0) break;
    }
    if (end === rest.length) throw unreadable("an unclosed entry");
    const ace = rest.slice(at + 1, end);
    at = end + 1;
    const fields = ace.split(";");
    const [type = "", aceFlags = "", rights = "", , , trustee = ""] = fields;
    if (ace.includes("(") || fields.length !== 6 || CONDITIONAL_TYPES.has(type)) {
      throw unreadable("a conditional or callback entry, which this check cannot evaluate,");
    }
    entries.push({
      sid: sddlSid(trustee, userSid),
      type: DENY_TYPES.has(type) ? "Deny" : ALLOW_TYPES.has(type) ? "Allow" : `Allow (${type})`,
      rights,
      inherited: /ID/.test(aceFlags),
      inheritOnly: /IO/.test(aceFlags),
    });
  }
  // The flags are P (protected), AI and AR: only P holds the letter P.
  const isProtected = (flags[1] ?? "").includes("P");
  return { path, owner: sddlSid(owner, userSid), entries, protected: isProtected };
}

function systemExe(...parts: string[]): string {
  return join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", ...parts);
}

/**
 * Prints the user's SID, then one line per path: "ok<TAB><SDDL of owner and DACL>" or
 * "err<TAB><.NET exception type>". It calls .NET only, never a cmdlet, so PowerShell never loads
 * a module and the module path cannot matter (review round 2, finding A: Get-Acl failed to load
 * Microsoft.PowerShell.Security under PowerShell 7's PSModulePath). The paths travel in an
 * environment variable, one per line (Windows names cannot hold a line feed), never in the script
 * text, so no path can become PowerShell code.
 */
const READ_SDDL =
  "$ErrorActionPreference='Stop'; " +
  "[Console]::Out.WriteLine([Security.Principal.WindowsIdentity]::GetCurrent().User.Value); " +
  "$s=[Security.AccessControl.AccessControlSections]'Owner,Access'; " +
  "if ($env:TASKS_M0_ACL_PATHS) { foreach ($p in $env:TASKS_M0_ACL_PATHS.Split([char]10)) { try { " +
  "if ([IO.Directory]::Exists($p)) { $a=[IO.Directory]::GetAccessControl($p,$s) } " +
  "else { $a=[IO.File]::GetAccessControl($p,$s) }; " +
  "[Console]::Out.WriteLine('ok' + [char]9 + $a.GetSecurityDescriptorSddlForm($s)) " +
  "} catch { [Console]::Out.WriteLine('err' + [char]9 + $_.Exception.GetBaseException().GetType().Name) } } }";

/**
 * The reader's whole environment: what Windows needs to start a process, and the paths. Nothing
 * from the parent shell (PSModulePath, profiles, PowerShell 7's variables) reaches it.
 */
function inspectorEnv(paths: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { TASKS_M0_ACL_PATHS: paths.join("\n") };
  for (const name of ["SystemRoot", "windir", "SystemDrive", "TEMP", "TMP"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

const cannotInspect = (reason: string) =>
  new KitError("cannot_inspect_permissions", `Cannot inspect permissions: ${reason}`);

export interface InspectOptions {
  /** Tests only: another executable in place of Windows PowerShell, to show a failed inspection. */
  powershell?: string;
}

/**
 * Windows: the current user's SID and the owner and DACL of each path, by SID. Throws
 * `cannot_inspect_permissions`, never `unsafe_permissions`, when it cannot read them.
 */
export function readAcls(
  paths: string[],
  options: InspectOptions = {},
): { user: string; items: AclFacts[] } {
  const result = spawnSync(
    options.powershell ?? systemExe("WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-NoLogo", "-Command", READ_SDDL],
    { encoding: "utf8", windowsHide: true, timeout: 30_000, env: inspectorEnv(paths) },
  );
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code ?? result.error.message;
    throw cannotInspect(`Windows PowerShell did not run (${code})`);
  }
  const lines = result.stdout.split(/\r?\n/).filter((line) => line !== "");
  const user = lines[0] ?? "";
  if (result.status !== 0 || !/^S-1-[0-9-]+$/.test(user)) {
    const why = result.stderr.trim().split(/\r?\n/)[0] ?? "";
    throw cannotInspect(
      `Windows PowerShell exited with ${String(result.status)}${why === "" ? "" : `: ${why}`}`,
    );
  }
  const items = paths.map((path, i): AclFacts => {
    const [status, value = ""] = (lines[i + 1] ?? "").split("\t");
    if (status !== "ok") {
      throw cannotInspect(
        `the owner and ACL of ${path} are unreadable (${status === "err" ? value : "no answer"})`,
      );
    }
    return parseSddl(path, value, user);
  });
  return { user, items };
}

function icacls(path: string, args: string[]): void {
  const result = spawnSync(systemExe("icacls.exe"), [path, ...args, "/Q"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    env: inspectorEnv([]),
  });
  if (result.status !== 0) {
    throw new KitError(
      "unsafe_permissions",
      `icacls could not set a user-only ACL on ${path}: ${result.stdout.trim()} ${result.stderr.trim()}`,
    );
  }
}

/**
 * Windows: replaces the ACL of `path` with one entry for the user (A2 3.2.2 rule 5). Removing
 * inheritance is not enough: under a parent with no inheritable entries a new object gets the
 * token's default DACL as explicit entries (on CI's elevated runner: SYSTEM, Administrators and
 * the user), so every other explicit allow entry is removed by SID afterwards.
 */
export function setUserOnlyAcl(path: string, userSid: string, kind: Kind): void {
  const grant = kind === "dir" ? `*${userSid}:(OI)(CI)F` : `*${userSid}:F`;
  icacls(path, ["/inheritance:r", "/grant:r", grant]);
  const { items } = readAcls([path]);
  const others = new Set(
    (items[0]?.entries ?? [])
      .filter((e) => e.type !== "Deny" && e.sid !== userSid && e.sid.startsWith("S-"))
      .map((e) => e.sid),
  );
  if (others.size > 0) icacls(path, ["/remove:g", ...[...others].map((sid) => `*${sid}`)]);
}

export interface Item {
  path: string;
  kind: Kind;
  /** For the message, for example "state folder". */
  what: string;
}

function refuse(item: Item, problems: string[]): never {
  throw new KitError(
    "unsafe_permissions",
    `The ${item.what} ${item.path} ${problems.join(", ")}. The stand-in service only uses a ` +
      `${item.kind === "dir" ? "folder" : "key"} that no other user can open. Fix it or use another --state.`,
  );
}

/**
 * Refuses the first item another principal could open. Returns the user's SID on Windows (for
 * `setUserOnlyAcl`), undefined elsewhere. Items that do not exist are skipped. Throws
 * `cannot_inspect_permissions` when the check itself cannot run.
 */
export function assertPrivate(items: Item[], options: InspectOptions = {}): string | undefined {
  if (process.platform === "win32") {
    const existing = items.filter((item) => exists(item.path));
    const { user, items: acls } = readAcls(
      existing.map((item) => item.path),
      options,
    );
    existing.forEach((item, i) => {
      const acl = acls[i];
      if (acl === undefined) throw cannotInspect(`no answer for ${item.path}`);
      const problems = aclProblems(acl, user);
      if (problems.length > 0) refuse(item, problems);
    });
    return user;
  }
  const uid = process.getuid?.() ?? -1;
  for (const item of items) {
    if (!exists(item.path)) continue;
    const stat = lstatSync(item.path);
    const problems = posixProblems(
      item.kind,
      {
        uid: stat.uid,
        mode: stat.mode,
        isDirectory: stat.isDirectory(),
        isFile: stat.isFile(),
        isSymbolicLink: stat.isSymbolicLink(),
      },
      uid,
    );
    if (problems.length > 0) refuse(item, problems);
  }
  return undefined;
}

/** POSIX: whether `dir` is a real folder owned by this UID and not group- or world-writable. */
export function isPrivateDir(dir: string): boolean {
  if (process.platform === "win32") return false;
  try {
    const stat = lstatSync(dir);
    const facts: PosixFacts = {
      uid: stat.uid,
      mode: stat.mode,
      isDirectory: stat.isDirectory(),
      isFile: stat.isFile(),
      isSymbolicLink: stat.isSymbolicLink(),
    };
    return posixProblems("dir", facts, process.getuid?.() ?? -1).length === 0;
  } catch {
    return false;
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The canonical path of an existing folder (symlinks resolved), so the check sees the target. */
export const canonical = (path: string): string => realpathSync.native(path);
