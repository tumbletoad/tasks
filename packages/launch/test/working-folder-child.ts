// A child process for the working-folder tests: the process that works in a
// place's folder, as the shim will be. It is started in the folder, says `ready`, waits for
// one line (a FolderCheck as JSON) so the test can change the tree in between, runs
// checkWorkingFolder there and prints one JSON line: the check's result, the identity of `.`, the
// identity of the directory the kernel says it holds (Linux: /proc/self/cwd) and, when asked, the
// identity of `.` in a child it starts without a working-folder option, as the shim will start the
// agent. With `serve`, it instead handles one request per line: change to a folder, check, report,
// change back.
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { createInterface } from "node:readline";
import { checkWorkingFolder, type FolderCheck } from "../src/places.ts";

const idOf = (path: string): string | undefined => {
  try {
    const s = statSync(path, { bigint: true });
    return `${String(s.dev)}:${String(s.ino)}`;
  } catch {
    return undefined;
  }
};

async function report(check: FolderCheck, agent: boolean): Promise<Record<string, unknown>> {
  const result = await checkWorkingFolder(check);
  return {
    result,
    dot: idOf("."),
    ...(process.platform === "linux" ? { held: idOf("/proc/self/cwd") } : {}),
    ...(agent
      ? {
          agent: execFileSync(
            process.execPath,
            [
              "-e",
              "const s = require('node:fs').statSync('.', { bigint: true }); process.stdout.write(`${s.dev}:${s.ino}`);",
            ],
            { encoding: "utf8" },
          ),
        }
      : {}),
  };
}

const lines = createInterface({ input: process.stdin });
if (process.argv[2] === "serve") {
  const home = process.cwd();
  lines.on("line", (line) => {
    void (async () => {
      const { folder, check } = JSON.parse(line) as { folder: string; check: FolderCheck };
      let out: Record<string, unknown> = { entered: false };
      let entered = false;
      try {
        process.chdir(folder);
        entered = true;
      } catch {
        // Not a folder there now: the process could not be started in it.
      }
      if (entered) {
        try {
          out = { entered: true, ...(await report(check, false)) };
        } finally {
          process.chdir(home);
        }
      }
      process.stdout.write(`${JSON.stringify(out)}\n`);
    })();
  });
} else {
  process.stdout.write("ready\n");
  lines.once("line", (line) => {
    void (async () => {
      const out = await report(JSON.parse(line) as FolderCheck, process.argv[2] === "agent");
      process.stdout.write(`${JSON.stringify(out)}\n`);
      lines.close();
    })();
  });
}
