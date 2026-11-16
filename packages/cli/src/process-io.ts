// The real process as the CLI's Io (io.ts): argv, environment, terminals, stdout and stderr.
import { readFile } from "node:fs/promises";
import type { Io } from "./io.ts";

/** A stream that is no terminal has no `isTTY` at run time, whatever its type says. */
const isTty = (stream: { readonly isTTY?: boolean }): boolean => stream.isTTY === true;

export function processIo(): Io {
  let stdin: Promise<string> | undefined;
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
  };
}

/** A yes-or-no question: on stderr, so output piped elsewhere stays clean. No is the default. */
async function terminalAsk(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^(y|yes)$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}
