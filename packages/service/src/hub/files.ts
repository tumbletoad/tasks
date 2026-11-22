// Files of `<state>` (A2 3.2.2 rule 5, 3.2.3): files and folders created with exactly the mode the
// plan names, atomic replacement, and the leftovers a crash can leave, which the next start removes.
//
// Creation itself is @ttasks/files, the one implementation every package creates through: the mode
// is set on the new object by descriptor, which follows no link and ignores the umask, and a file
// or folder that was already there keeps its mode (A2 3.2.2 rule 5). This module adds the service's
// rule for who else may change a folder it writes in (permissions.ts).
import { makeDir } from "@ttasks/files";
import { currentPerson, factsOf, judgePath, problemOf, type Judged } from "./permissions.ts";

export {
  appendPrivate,
  atomicWrite,
  createFile,
  makeDir,
  removeStaleTemps,
  setModeOf,
  writeAll,
  type MakeDirOptions,
} from "@ttasks/files";
export { judgePath, type Judged };

/** An error with an errno code, as Node's own file system errors carry one, and no path. */
const errnoError = (code: string, message: string): NodeJS.ErrnoException =>
  Object.assign(new Error(message), { code });

/**
 * Creates `dir` (and missing parents) user-only (exactly 0700), and on Linux and macOS judges it by
 * the rule for `need`: a folder of this UID that no other user can write (`folder`), or that no
 * other user can enter at all (`private_folder`), which this user can read, change and enter.
 * Returns what fails, or undefined when it is safe. Windows: folders under %USERPROFILE% inherit
 * the profile's ACL, which doctor checks (A2 3.2.2 rule 5), so only creation happens there.
 */
export function ensurePrivateDir(
  dir: string,
  platform: NodeJS.Platform = process.platform,
  need: "folder" | "private_folder" = "folder",
): Judged | undefined {
  makeDir(dir, 0o700, { platform });
  if (platform === "win32") return undefined;
  // Followed: a state folder may be a link to another disk. Its target is what is judged.
  const judged = judgePath(dir, need, { followLink: true });
  // makeDir found or made it, so only a change in between hides it: never taken for safe.
  if (judged === "unseen") throw errnoError("EACCES", "The folder cannot be looked at");
  return judged;
}

/**
 * Whether `dir` is a real folder of this user that no one else can write, the person's own private
 * group aside (POSIX only, permissions.ts).
 */
export function isPrivateDir(dir: string): boolean {
  const person = currentPerson();
  if (person === undefined) return false;
  const facts = factsOf(dir, "folder", { followLink: false });
  return typeof facts === "object" && problemOf(facts, person) === undefined;
}
