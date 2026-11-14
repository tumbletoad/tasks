// The process's umask at a start (A2 3.2.2 rule 5). Tasks gives every file
// and folder it creates an exact mode, but a new folder is made first and opened again to set its
// mode: a umask that takes away one of the person's own bits (0400, 0200, 0100) breaks that half-way
// and leaves a folder the person cannot use. That is no configuration worth supporting, so the
// service and `tasks service install` refuse such a umask with what to do instead.
//
// The umask is only ever read, never set: the service starts agents, and they must inherit the
// person's own. Node's process.umask() without an argument reads it by setting it to 0 and back,
// and in between a worker thread's new file gets every bit of its requested mode (0666 for a plain
// file), so the product never calls it (a lint rule refuses it). Linux reads the mask from
// /proc/self/status, which leaves it alone; where that is missing, a short-lived child that
// inherits the mask says it (`umask` in /bin/sh), within a deadline.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { PRODUCT_NAME } from "@tasks/brand";

/** How long the child that says the umask may take. */
export const UMASK_CHILD_MS = 5_000;

/**
 * What a read of the umask found: the mask; undefined on Windows, which has none; or why it could
 * not be read. A mask that cannot be read is never guessed.
 */
export type UmaskRead = number | undefined | { readonly unreadable: "timeout" | "failed" };

/** Where the mask is read from. Tests pass others to force the child's path. */
export interface UmaskSources {
  /** Linux's own record of the process, `/proc/self/status`. */
  readonly status?: string;
  /** The POSIX shell whose builtin `umask` says the mask it inherited, `/bin/sh`. */
  readonly sh?: string;
  readonly timeoutMs?: number;
}

const MASK = /^0?[0-7]{1,3}$/u;

/** The mask a child that inherits it says, or why it could not. */
function askChild(sh: string, timeoutMs: number): UmaskRead {
  // No environment: a non-interactive `sh -c` reads no start-up file, and `umask` is a builtin.
  const ran = spawnSync(sh, ["-c", "umask"], {
    env: {},
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  const code = (ran.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ETIMEDOUT") return { unreadable: "timeout" };
  const text = typeof ran.stdout === "string" ? ran.stdout.trim() : "";
  if (ran.status !== 0 || !MASK.test(text)) return { unreadable: "failed" };
  return Number.parseInt(text, 8);
}

/**
 * The process's umask, without changing it: undefined on Windows, the mask, or why it could not be
 * read. Linux reads /proc/self/status; elsewhere, and on a Linux without that line, a child says it.
 */
export function readUmask(
  platform: NodeJS.Platform = process.platform,
  sources: UmaskSources = {},
): UmaskRead {
  if (platform === "win32") return undefined;
  if (platform === "linux") {
    try {
      const status = readFileSync(sources.status ?? "/proc/self/status", "utf8");
      const line = /^Umask:\s*([0-7]{1,4})\s*$/mu.exec(status);
      if (line?.[1] !== undefined) return Number.parseInt(line[1], 8);
    } catch {
      // No /proc: the child below says it.
    }
  }
  return askChild(sources.sh ?? "/bin/sh", sources.timeoutMs ?? UMASK_CHILD_MS);
}

/** The umask as a person types it: `0400`. */
export const umaskText = (mask: number): string => mask.toString(8).padStart(4, "0");

/**
 * The line a person reads when the umask takes away one of their own bits, or cannot be read; or
 * undefined when it leaves them all (and on Windows). `what` starts the sentence: "Tasks's service
 * does not start".
 */
export function umaskRefusal(read: UmaskRead, what: string): string | undefined {
  if (read === undefined) return undefined;
  if (typeof read === "object") {
    const why =
      read.unreadable === "timeout"
        ? `/bin/sh did not say it within ${String(UMASK_CHILD_MS / 1000)} s`
        : "/bin/sh could not say it";
    return `Your umask could not be read (${why}), so ${what}: ${PRODUCT_NAME} does not guess which of your own bits it takes away from new files and folders. Try again; if it keeps failing, check that /bin/sh runs.`;
  }
  if ((read & 0o700) === 0) return undefined;
  return `Your umask (${umaskText(read)}) takes away your own access to every new file or folder, so ${what}: ${PRODUCT_NAME} could not use the files it creates. Set the usual umask first, for example: umask 022`;
}
