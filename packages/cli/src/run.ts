// The `ttasks` process: the real process as the CLI's Io, then the exit code (A2 3.10.3). bin.ts runs
// it from source; a built version folder's entry (entry.ts, `lib/ttasks.mjs`) runs it with the
// folder it lives in. Ctrl+C exits 130. Nothing of argv reaches a log or a crash file: the CLI
// writes neither.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { main, type MainOptions } from "./main.ts";
import { processIo } from "./process-io.ts";

export interface RunOptions extends Pick<MainOptions, "versionFolder"> {
  /**
   * The page's built folder (packages/web, M2.13) that `ttasks serve` serves: a version folder's
   * `ui/`, or from source `packages/web/dist` once `pnpm build:web` made it. A folder without an
   * `index.html` is not used, and the service serves its minimal shell instead.
   */
  readonly uiFolder?: string;
}

/** Runs `ttasks` in this process and resolves with its exit code. */
export async function run(options: RunOptions = {}): Promise<number> {
  const io = processIo();
  process.on("SIGINT", () => {
    io.interrupted();
    process.exit(130);
  });
  const { uiFolder, ...rest } = options;
  const ui =
    uiFolder !== undefined && existsSync(join(uiFolder, "index.html")) ? uiFolder : undefined;
  return main(io, {
    ...rest,
    // `ttasks serve` ends the process with its own exit code (A2 3.3.1), whatever is still open.
    serve: async () => {
      const { runServe } = await import("@ttasks/service/hub");
      process.exit(await runServe(ui === undefined ? {} : { http: { ui } }));
    },
  });
}
