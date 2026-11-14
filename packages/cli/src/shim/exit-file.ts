// `exit.json` (A4 3.6.3 step 9): when the service cannot be reached at the agent's end, the shim
// writes what it could not report into its launch folder, atomically (a temporary file beside it,
// flushed, then renamed), user-only: exactly 0600 whatever the umask the agent's terminal gave the
// shim (@tasks/files). The service collects it at start-up and in its PID check.
import { atomicWrite } from "@tasks/files";
import type { ExitFile } from "@tasks/launch/shim-wire";

export function writeExitFile(path: string, file: ExitFile): void {
  atomicWrite(path, `${JSON.stringify(file)}\n`, 0o600);
}
