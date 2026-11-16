// A Windows command line from an argument list, quoted so the C runtime's parser (and Node's,
// which follows it) gives back exactly these arguments. It is libuv's quoting, the same Node
// applies to every program it starts, so an agent started through tasks-run.exe sees the same
// arguments as one Node started directly.

/** One argument, quoted when it needs to be. */
export function quoteWindowsArg(arg: string): string {
  if (arg === "") return '""';
  if (!/[ \t\n\v"]/.test(arg)) return arg;
  if (!/["\\]/.test(arg)) return `"${arg}"`;
  // Backslashes are literal unless they precede a quote: there they are doubled, and the quote
  // escaped. The closing quote follows any trailing backslashes, so those are doubled too.
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      backslashes += 1;
      continue;
    }
    out += ch === '"' ? `${"\\".repeat(backslashes * 2 + 1)}"` : `${"\\".repeat(backslashes)}${ch}`;
    backslashes = 0;
  }
  return `${out}${"\\".repeat(backslashes * 2)}"`;
}

/**
 * The command line for `argv`, whose first entry is the program. The program's path is quoted
 * without escapes, as the C runtime reads the first word: a path cannot hold a quote.
 */
export function windowsCommandLine(argv: readonly string[]): string {
  const [program, ...args] = argv;
  if (program === undefined || program === "" || program.includes('"')) {
    throw new Error("a program path is required and cannot hold a quote");
  }
  const first = /[ \t]/.test(program) ? `"${program}"` : program;
  return [first, ...args.map(quoteWindowsArg)].join(" ");
}
