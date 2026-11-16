// The machine rules of lab run N (M0.11), enforced by the code before anything is spawned: full
// access and Claude Code sessions run on Windows only, and so does every command that exists for
// them. On Linux the lab runs only the reduced route.
import { LabError } from "../agents/facts.ts";

/** Commands that exist for Windows only (n02-linux, n05, resanitise and keys run anywhere). */
export const WINDOWS_ONLY = [
  "build-helper",
  "n01",
  "n02",
  "n03",
  "n03-detached",
  "repeats",
  "cleanup",
] as const;

export const FULL_ACCESS_FLAG = "--dangerously-bypass-approvals-and-sandbox";

/** Refuses a Windows-only command on a host that is not Windows. */
export function guardCommand(command: string, win: boolean): void {
  if (!win && (WINDOWS_ONLY as readonly string[]).includes(command)) {
    throw new LabError("a Windows-only command on a non-Windows host");
  }
}

/** Refuses a run that is not allowed on this host, from the CLI and its argv. */
export function guardRun(cli: "claude" | "codex", argv: readonly string[], win: boolean): void {
  if (win) return;
  if (cli === "claude") throw new LabError("Claude Code sessions are Windows-only in this step");
  if (argv.includes(FULL_ACCESS_FLAG)) throw new LabError("full access on a non-Windows host");
}
