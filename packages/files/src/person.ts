// Who a file or folder of the person's may be written by, besides them (A2 3.2.2 rule 5): their own
// private group, the one group whose write the product accepts. A module of its own, beside the
// file helpers, because the service's rule (packages/service/src/hub/permissions.ts) and launch's
// reading of T3's files (packages/launch/src/t3-client.ts) hold the same rule, and launch may not
// import the service. Linux and macOS only.
//
// The person's own private group is their account's primary group when that group's name is their
// user name: the user private groups of distributions whose umask is 002. It is the account's
// primary group as the account services give it, not this process's group, which `newgrp` or `sg`
// changes for a while. Its name and ID come from those services (a directory service included),
// so each question is bounded, asked only when a judgement needs it, and a failed one is asked
// again next time: a directory service that does not answer now may answer later.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Who the rule judges for: this user and, when they have one, their own private group, which alone
 * besides them may write what TTasks trusts.
 */
export interface Person {
  readonly uid: number;
  /**
   * The ID of the person's own private group, or undefined when they have none or it cannot be read
   * now. Asked only when a file or folder its group may write is judged.
   */
  readonly ownGroup: () => number | undefined;
  /** A group's name, for the person's message; undefined when it cannot be read. */
  readonly groupName: (gid: number) => string | undefined;
}

/**
 * Whether a primary group of name `group` is the private group of the user named `user`: both
 * names are known and the same. The install script's `own_group` is the same test.
 */
export const isOwnGroup = (user: string | undefined, group: string | undefined): boolean =>
  user !== undefined && user !== "" && user === group;

/** How long one question to the account services may take. */
const ASK_MS = 5_000;

/** Asks the account services: `id` with these arguments, its one line or undefined. */
export type AskId = (args: readonly string[]) => string | undefined;

/**
 * What `id` prints, through the account services alone: the system's own `id`, never one found on
 * PATH, with no environment but the C locale, within 5 s. Its one line, or undefined.
 */
const askId: AskId = (args) => askTool(["/usr/bin/id", "/bin/id"], args);

function askTool(paths: readonly string[], args: readonly string[]): string | undefined {
  const tool = paths.find((path) => existsSync(path));
  if (tool === undefined) return undefined;
  const ran = spawnSync(tool, args, {
    env: { LC_ALL: "C" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: ASK_MS,
    killSignal: "SIGKILL",
  });
  const line = typeof ran.stdout === "string" ? ran.stdout.replace(/\n$/u, "") : "";
  // eslint-disable-next-line no-control-regex -- a name with a control character is no name
  return ran.status === 0 && line !== "" && !/[\0-\x1f\x7f]/u.test(line) ? line : undefined;
}

/** The account's primary group: its ID and its name when it has one. */
export interface Account {
  readonly user: string;
  readonly gid: number;
  readonly group: string | undefined;
}

/**
 * This user's account as the account services give it (`id -un`, then `id -g` and `id -gn` for that
 * user name), or undefined when the user name or the group ID cannot be read.
 */
export function readAccount(ask: AskId = askId): Account | undefined {
  const user = ask(["-un"]);
  if (user === undefined) return undefined;
  const id = ask(["-g", "--", user]);
  if (id === undefined || !/^\d{1,10}$/u.test(id)) return undefined;
  // A group without a name: `id -gn` fails, and the group is not the person's own.
  return { user, gid: Number(id), group: ask(["-gn", "--", user]) };
}

/**
 * The account, kept once it was read whole. A read that failed, or found no group name, is asked
 * again next time: a lookup that timed out looks the same as a group without a name.
 */
let account: Account | undefined;
function theAccount(): Account | undefined {
  if (account !== undefined) return account;
  const found = readAccount();
  if (found?.group !== undefined) account = found;
  return found;
}

/** The ID of the person's own private group in `found`, or undefined. */
export const ownGroupOf = (found: Account | undefined): number | undefined =>
  found !== undefined && isOwnGroup(found.user, found.group) ? found.gid : undefined;

/** Another group's name, as `getent group` says it (Linux); undefined elsewhere. */
function lookUpGroup(gid: number): string | undefined {
  const entry = askTool(["/usr/bin/getent", "/bin/getent"], ["group", String(gid)]);
  const name = entry?.split(":")[0];
  return name === undefined || name === "" ? undefined : name;
}

/** This process's person (POSIX): its UID and its own private group. Undefined on Windows. */
export function currentPerson(): Person | undefined {
  const uid = process.getuid?.();
  if (process.platform === "win32" || uid === undefined) return undefined;
  return {
    uid,
    ownGroup: () => ownGroupOf(theAccount()),
    groupName: (gid) => {
      const found = theAccount();
      return found !== undefined && found.gid === gid ? found.group : lookUpGroup(gid);
    },
  };
}

/** Whether the group `gid` of a file or folder may write it: it is the person's own. */
export const groupMayWrite = (gid: number, person: Person): boolean => {
  const own = person.ownGroup();
  return own !== undefined && own === gid;
};
