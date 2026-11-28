// Command lines of TTasks's own printed for a person to paste: the one rule for every
// such line. On Windows a line is for PowerShell, the shell Windows Terminal opens by default;
// elsewhere for a POSIX shell (sh, bash, zsh). A word is printed as it is when the shell takes it
// literally, else quoted so that it does:
//
// - POSIX: in single quotes, where nothing is expanded. A single quote closes the quotes, is
//   escaped and opens them again ('\''). A newline stays inside the quotes: the shell takes it
//   literally, and a terminal shows and copies it as the line break it is.
// - PowerShell: in single quotes, where nothing is expanded. Each single quote is doubled,
//   typographic ones too (‘ ’ ‚ ‛), because PowerShell ends a quoted string at any of them. A bare
//   `--`, `,` and a leading `@` are always quoted: PowerShell drops `--` before a script (the npm
//   `.ps1` shims), joins `a,b` into one array, and splats `@name`. A line whose command is a path
//   starts with `&`, which runs a quoted command.
//
// A word no quoting keeps literal is refused (`undefined`), and the caller prints no line:
// - anywhere: a control character other than a POSIX newline (C0, DEL, C1, a line or paragraph
//   separator), which a terminal shows otherwise than it pastes;
// - Windows: every control character, a newline too (cmd ends a command at it, and Windows file
//   names hold none); `% ! ^ & | < > "`, because PowerShell runs an npm `.cmd` shim through cmd,
//   which expands or acts on them inside PowerShell's own quotes; an empty word, and one with a
//   space or tab that ends in a backslash, which Windows PowerShell 5.1 hands on wrongly.
//
// A whole line is at most MAX_LINE_BYTES bytes of UTF-8, or there is no line: a terminal in
// canonical mode (sh without line editing, on Linux) takes no longer line, and on
// Windows that leaves cmd.exe, whose command line holds at most 8,191 characters, room for what an
// npm `.cmd` shim puts before the words (Node's path and its script's). A UTF-16 character is never
// more than its UTF-8 bytes, so one bound in bytes holds for both.
//
// Pure: no I/O. Tests: `A3.3.13.setup.print-quoting` (packages/service/test/print-quoting.test.ts),
// which feeds the lines to the real shells.

/** Characters no line to paste can show as they are; a POSIX line keeps a newline. */
// eslint-disable-next-line no-control-regex -- the control characters are what it finds
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
// eslint-disable-next-line no-control-regex -- the control characters are what it finds
const POSIX_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/u;
/** Windows: what cmd acts on inside PowerShell's quotes, when the command is a `.cmd` shim. */
const CMD_SPECIAL = /[%!^&|<>"]/u;

/** A POSIX word the shell takes literally as it is. */
const POSIX_PLAIN = /^[A-Za-z0-9_./:+@%,-][A-Za-z0-9_./:=+@%,-]*$/u;
/** A PowerShell word it takes literally as it is: no `,`, `@`, `$`, and a dash only before a letter. */
const POWERSHELL_PLAIN =
  /^(?:[A-Za-z0-9_./:\\+][A-Za-z0-9_./:\\=+-]*|--?[A-Za-z][A-Za-z0-9_./:\\=+-]*)$/u;
/** The single quotes PowerShell ends a quoted string at. */
const POWERSHELL_QUOTES = /['\u2018\u2019\u201a\u201b]/gu;

const refused = (platform: NodeJS.Platform, word: string): boolean =>
  platform === "win32"
    ? CONTROL.test(word) ||
      word === "" ||
      CMD_SPECIAL.test(word) ||
      (/\s/u.test(word) && word.endsWith("\\"))
    : POSIX_CONTROL.test(word);

/** One word quoted for the shell, always. */
export function quotedWord(platform: NodeJS.Platform, word: string): string | undefined {
  if (refused(platform, word)) return undefined;
  return platform === "win32"
    ? `'${word.replace(POWERSHELL_QUOTES, (q) => q + q)}'`
    : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** One word as the shell takes it literally: as it is when it can be, else quoted; or undefined. */
export function shellWord(platform: NodeJS.Platform, word: string): string | undefined {
  if (refused(platform, word)) return undefined;
  const plain = platform === "win32" ? POWERSHELL_PLAIN : POSIX_PLAIN;
  return plain.test(word) ? word : quotedWord(platform, word);
}

/** The longest line to paste, in bytes of UTF-8 (the header says why). */
export const MAX_LINE_BYTES = 4095;

/**
 * An argv as one line to paste: PowerShell runs a command given by its path with `&`. Undefined
 * when a word cannot be quoted, or the line would be longer than MAX_LINE_BYTES.
 */
export function shellLine(platform: NodeJS.Platform, argv: readonly string[]): string | undefined {
  const words = argv.map((word) => shellWord(platform, word));
  if (words.length === 0 || words.some((word) => word === undefined)) return undefined;
  const command = words.join(" ");
  const first = argv[0] ?? "";
  // A command by its path, or quoted, is run with `&`: PowerShell reads a quoted word as a string.
  const line =
    platform === "win32" && (/[\\/]/u.test(first) || words[0] !== first) ? `& ${command}` : command;
  return Buffer.byteLength(line, "utf8") <= MAX_LINE_BYTES ? line : undefined;
}
