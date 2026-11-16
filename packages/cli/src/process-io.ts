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
  };
}
