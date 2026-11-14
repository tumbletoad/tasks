// Lab row R10 (A7 3.7, A6 3.16.4, 3.16.6 and M0 item 4, A2 3.2.2 rule 5): owner-only folders and
// files as Node creates them, without admin rights.
//
//   node spikes/m0/checks/owner-only.ts --scratch <empty folder> --out <folder>
//
// Linux and macOS: a space-like folder made with mkdir mode 0700 and a file written with mode 0600,
// a secrets folder and file the same way. The modes and the owner are read back with stat.
// Windows: a space-like folder and file that inherit the ACL of the folder above (the profile's,
// when the scratch folder is under %USERPROFILE%), and a secrets folder made user-only with the
// spike kit's setUserOnlyAcl (a protected DACL with exactly the user, as the stand-in service
// does), with a file created inside it afterwards. Every ACL is read back with the kit's strict
// SDDL reader (by SID, conditional entries refused). Account SIDs are shown without their domain
// part.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { type AclFacts, aclProblems, readAcls, setUserOnlyAcl } from "../kit/perms.ts";
import { isElevated, machineFacts, options, redactSid, writeResult } from "./common.ts";

/** The well-known SIDs the profile ACL grants besides the user (A2 3.2.2 rule 5). */
export const SYSTEM = "S-1-5-18";
export const ADMINISTRATORS = "S-1-5-32-544";

/**
 * The secrets rule (A6 3.16.4): every entry names the user, by SID, with no other principal. The
 * secrets folder itself must also be protected (inheritance off). A file created inside it
 * inherits from it, so for a file `protect` is false. The owner may be the user, SYSTEM or
 * Administrators (an elevated token makes Administrators the owner): `aclProblems` judges it.
 */
export function onlyUser(acl: AclFacts, userSid: string, protect = true): boolean {
  if (protect && acl.protected !== true) return false;
  return (
    acl.entries.length > 0 &&
    acl.entries.every((e) => e.sid === userSid) &&
    aclProblems(acl, userSid).length === 0
  );
}

function redactAcl(acl: AclFacts): Omit<AclFacts, "path"> {
  return {
    protected: acl.protected === true,
    owner: redactSid(acl.owner),
    entries: acl.entries.map((e) => ({ ...e, sid: redactSid(e.sid) })),
  };
}

function windows(scratch: string): { ok: boolean; detail: Record<string, unknown> } {
  const space = join(scratch, "space");
  const db = join(space, "space.db");
  const secrets = join(scratch, "state", "secrets");
  const key = join(secrets, "machine.key");
  mkdirSync(space, { recursive: true, mode: 0o700 });
  writeFileSync(db, "fixture", { mode: 0o600 });
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  // The spike kit's user-only ACL, as the stand-in service sets it: a protected DACL with one
  // entry for the user, and every other explicit allow entry removed by SID (a review finding).
  const { user } = readAcls([]);
  setUserOnlyAcl(secrets, user, "dir");
  writeFileSync(key, "fixture", { mode: 0o600 });
  const paths = { scratch, space, db, secrets, key };
  const { items } = readAcls(Object.values(paths));
  const acls = Object.fromEntries(Object.keys(paths).map((k, i) => [k, items[i]])) as Record<
    keyof typeof paths,
    AclFacts | undefined
  >;
  if (Object.values(acls).some((a) => a === undefined)) throw new Error("an ACL was not read");
  const read = acls as Record<keyof typeof paths, AclFacts>;
  const problems = {
    space: aclProblems(read.space, user),
    db: aclProblems(read.db, user),
  };
  const secretsOnlyUser = onlyUser(read.secrets, user) && onlyUser(read.key, user, false);
  const ok = problems.space.length === 0 && problems.db.length === 0 && secretsOnlyUser;
  const modes = Object.fromEntries(
    Object.entries({ space, db, secrets, key }).map(([k, p]) => [
      k,
      (statSync(p).mode & 0o777).toString(8),
    ]),
  );
  return {
    ok,
    detail: {
      user: redactSid(user),
      inheritedFolderProblems: problems.space.map(redactText),
      inheritedFileProblems: problems.db.map(redactText),
      secretsOnlyUser,
      nodeModeBits: modes,
      acls: Object.fromEntries(Object.entries(read).map(([k, a]) => [k, redactAcl(a)])),
    },
  };
}

/** Account SIDs inside a problem text, without their domain part. */
function redactText(text: string): string {
  return text.replace(/S-1-5-21-[0-9-]+/g, (sid) => redactSid(sid));
}

function umask(): string {
  try {
    const m = /^Umask:\s*([0-7]+)/m.exec(readFileSync("/proc/self/status", "utf8"));
    return m?.[1] ?? "unknown";
  } catch {
    return "unknown";
  }
}

function posix(scratch: string): { ok: boolean; detail: Record<string, unknown> } {
  const items = {
    space: join(scratch, "space"),
    db: join(scratch, "space", "space.db"),
    secrets: join(scratch, "state", "secrets"),
    key: join(scratch, "state", "secrets", "machine.key"),
  };
  mkdirSync(join(scratch, "state"), { recursive: true, mode: 0o700 });
  mkdirSync(items.space, { mode: 0o700 });
  writeFileSync(items.db, "fixture", { mode: 0o600 });
  mkdirSync(items.secrets, { mode: 0o700 });
  writeFileSync(items.key, "fixture", { mode: 0o600 });
  const uid = process.getuid?.() ?? -1;
  const expect: Record<string, number> = { space: 0o700, db: 0o600, secrets: 0o700, key: 0o600 };
  const seen: Record<string, { mode: string; ownerIsUser: boolean; ok: boolean }> = {};
  for (const [k, p] of Object.entries(items)) {
    const s = statSync(p);
    const mode = s.mode & 0o777;
    seen[k] = {
      mode: mode.toString(8).padStart(4, "0"),
      ownerIsUser: s.uid === uid,
      ok: mode === expect[k] && s.uid === uid,
    };
  }
  return { ok: Object.values(seen).every((v) => v.ok), detail: { umask: umask(), items: seen } };
}

/** Runs the check in scratch (which must exist and be empty) for this OS. */
export function ownerOnly(scratch: string): { ok: boolean; detail: Record<string, unknown> } {
  return process.platform === "win32" ? windows(scratch) : posix(scratch);
}

function main(argv: readonly string[]): number {
  const o = options(argv, ["scratch", "out"]);
  if (o.scratch === undefined || o.out === undefined) throw new Error("pass --scratch and --out");
  const scratch = resolve(String(o.scratch));
  mkdirSync(scratch, { recursive: true });
  if (readdirSync(scratch).length > 0) throw new Error("--scratch must be empty");
  let result: { ok: boolean; detail: Record<string, unknown> };
  try {
    result = ownerOnly(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(JSON.stringify(result.detail, null, 2));
  console.log(result.ok ? "owner-only check passed" : "owner-only check FAILED");
  const file = writeResult(String(o.out), "r10-owner-only.json", {
    row: "R10",
    at: new Date().toISOString(),
    machine: machineFacts(),
    elevated: isElevated(),
    ok: result.ok,
    ...result.detail,
  });
  console.log(`result: ${file}`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = main(process.argv.slice(2));
}
