// The repository a project's folder holds, by name, shown beside the project's own name. It is a
// fact of the folder, not of the space: read from the folder's own Git configuration each time it
// is shown, never stored, and never by starting git. Only the name is shown: the address can carry
// a token, and the name is what a person recognises.
import { readGitRemote, type GitRemote } from "@tasks/launch";
import { bounded } from "./folders.ts";

/** How long the look at one folder's Git configuration may take before the name is left out. */
export const REPO_MS = 500;

/**
 * The repository's name in a remote address that `readGitRemote` kept (credentials, a query and a
 * fragment never reach it): the last name of its path, without `.git`.
 */
export function repoNameOf(url: string): string | undefined {
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/u.exec(url);
  const path = scheme === null ? url.slice(url.indexOf(":") + 1) : url.slice(scheme[0].length);
  const last = path
    .split("/")
    .filter((part) => part !== "")
    .at(-1);
  const name = last?.replace(/\.git$/u, "");
  return name === undefined || name === "" || name.length > 255 ? undefined : name;
}

/**
 * The name of the repository whose working folder is `absolute`: its `origin`, else its first
 * remote. Undefined for a folder that is not a checkout, one without a remote that leaves the
 * machine, a configuration this reader cannot read exactly, and one that does not answer in time.
 */
export async function repoName(
  absolute: string,
  platform: NodeJS.Platform,
  options: {
    readonly ms?: number;
    readonly read?: (folder: string, platform: NodeJS.Platform) => Promise<GitRemote>;
  } = {},
): Promise<string | undefined> {
  const read = options.read ?? readGitRemote;
  const remote = await bounded(
    () => read(absolute, platform).catch((): GitRemote => ({ status: "unreadable" })),
    options.ms ?? REPO_MS,
  );
  return remote === "not_answering" || remote.status !== "remote"
    ? undefined
    : repoNameOf(remote.url);
}
