// The real process as the CLI's Io (io.ts): argv, environment, terminals, stdout and stderr.
import { writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Io } from "./io.ts";

/** A stream that is no terminal has no `isTTY` at run time, whatever its type says. */
const isTty = (stream: { readonly isTTY?: boolean }): boolean => stream.isTTY === true;

/** The process's Io, and what Ctrl+C prints before the process ends (run.ts). */
export function processIo(): Io & { readonly interrupted: () => void } {
  let stdin: Promise<string> | undefined;
  let note: string | undefined;
  return {
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    platform: process.platform,
    tty: {
      stdin: isTty(process.stdin),
      stdout: isTty(process.stdout),
      stderr: isTty(process.stderr),
    },
    pid: process.pid,
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    readStdin: () =>
      (stdin ??= (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        return Buffer.concat(chunks).toString("utf8");
      })()),
    readFile: (path) => readFile(path, "utf8"),
    ...(isTty(process.stdin) ? { ask: terminalAsk } : {}),
    onInterrupt: (text) => {
      note = text;
    },
    interrupted: () => {
      if (note === undefined) return;
      // Written at once: the process ends right after, and a write to a pipe may still be queued.
      try {
        writeSync(2, `\n${note}`);
      } catch {
        // stderr is gone: nothing to tell.
      }
    },
  };
}

/** A yes-or-no question: on stderr, so output piped elsewhere stays clean. No is the default. */
async function terminalAsk(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  // The terminal's Ctrl+C reaches the question, not the process: it ends the command as anywhere
  // else.
  rl.on("SIGINT", () => {
    rl.close();
    process.emit("SIGINT", "SIGINT");
  });
  try {
    return /^(y|yes)$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}
