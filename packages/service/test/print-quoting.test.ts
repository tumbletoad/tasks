// Lines printed for a person to paste (A3 3.13.7; launch's shell-line.ts, setup's print.ts): each
// line is fed to the real shell it is for, and a harmless stub in place of the command reports the
// argv and the variable it received. Windows: PowerShell 7 when it is on the PATH and Windows
// PowerShell 5.1, each through an npm-style `.ps1` shim and an npm-style `.cmd` shim (which
// PowerShell runs through cmd). Elsewhere: /bin/sh. Nothing real is run or configured: the stubs
// live in this file's own temporary folder, which is removed afterwards.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MCP_SERVER_KEY } from "@tasks/brand";
import { MAX_LINE_BYTES, pasteShell, shellLine, shellWord } from "@tasks/launch";
import { PrintRefused, snippetFor } from "../src/setup/index.ts";

const windows = process.platform === "win32";
const SLOW = 180_000;
/** A variable the shell has: a line that expands anything shows its value. */
const SENTINEL = "TASKS_PRINT_SENTINEL";
/** The variable a line sets for its command. */
const SET = "TASKS_LINE_TEST";

let base = "";
/** Folders that hold a stub named `claude`, by how the shell reaches it. */
const stubs: { kind: string; dir: string; file: string }[] = [];

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "tasks-print-quoting-"));
  const report = `process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), set: process.env[${JSON.stringify(SET)}] ?? null }) + "\\n");\n`;
  const node = process.execPath;
  const stub = (kind: string, name: string, text: string) => {
    const dir = join(base, kind);
    mkdirSync(dir);
    writeFileSync(join(dir, "argv.cjs"), report);
    const file = join(dir, name);
    writeFileSync(file, text);
    if (!windows) chmodSync(file, 0o755);
    stubs.push({ kind, dir, file });
  };
  if (windows) {
    // As npm's cmd-shim writes them: the .ps1 passes $args on, the .cmd passes %* on.
    stub(
      "ps1",
      "claude.ps1",
      `$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\r\n& "${node}" "$basedir/argv.cjs" $args\r\nexit $LASTEXITCODE\r\n`,
    );
    stub("cmd", "claude.cmd", `@ECHO off\r\nSETLOCAL\r\n"${node}" "%~dp0argv.cjs" %*\r\n`);
  } else {
    stub("sh", "claude", `#!/bin/sh\nexec '${node}' "$(dirname "$0")/argv.cjs" "$@"\n`);
  }
});

afterAll(() => {
  if (base !== "") rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

interface Shell {
  readonly name: string;
  run(line: string, path: string): { argv: string[]; set: string | null } | undefined;
}

/** The shells a line is fed to on this OS. */
function shells(): Shell[] {
  const env = (path: string) => ({
    ...process.env,
    PATH: `${path}${windows ? ";" : ":"}${process.env["PATH"] ?? ""}`,
    [SENTINEL]: "expanded",
  });
  const answer = (stdout: string) => {
    const line = stdout
      .split(/\r?\n/u)
      .reverse()
      .find((l) => l.startsWith("{"));
    return line === undefined
      ? undefined
      : (JSON.parse(line) as { argv: string[]; set: string | null });
  };
  if (!windows) {
    return [
      {
        name: "sh",
        run: (line, path) =>
          answer(spawnSync("/bin/sh", ["-c", line], { env: env(path), encoding: "utf8" }).stdout),
      },
    ];
  }
  const powershell = (name: string, exe: string): Shell => ({
    name,
    run: (line, path) => {
      // The line as typed: -EncodedCommand takes it as UTF-16, with no file or code page between.
      const encoded = Buffer.from(line, "utf16le").toString("base64");
      const ran = spawnSync(
        exe,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-EncodedCommand",
          encoded,
        ],
        { env: env(path), encoding: "utf8", windowsHide: true, timeout: 120_000 },
      );
      return answer(ran.stdout);
    },
  });
  const found: Shell[] = [];
  if (spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { windowsHide: true }).status === 0) {
    found.push(powershell("PowerShell 7", "pwsh"));
  }
  const root = process.env["SystemRoot"] ?? "C:\\Windows";
  found.push(
    powershell(
      "Windows PowerShell",
      win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ),
  );
  return found;
}

/** Words that a shell would split, expand, drop or act on unless the line keeps them literal. */
const WORDS = [
  SENTINEL,
  `$${SENTINEL}`,
  `\${${SENTINEL}}`,
  "$(echo expanded)",
  "`echo expanded`",
  "a b",
  "it's",
  "x\u2018y\u2019z\u201a\u201b",
  "a,b",
  "@splat",
  "--",
  "-x",
  "--flag=1",
  "#hash",
  ";semi",
  "{brace}",
  "(paren)",
  "~tilde",
  "*glob",
  "?q",
  "[x]",
  "1e5",
  "caf\u00e9",
  "",
  ...(windows
    ? ["C:\\Program Files (x86)\\x", "C:\\a\\tasks.exe"]
    : [
        "back\\slash",
        '"dq"',
        "!bang",
        "%pct",
        "a&b",
        "a|b",
        "<lt>",
        "^caret",
        "/opt/a b/tasks",
        "new\nline",
      ]),
].filter((word) => shellWord(process.platform, word) !== undefined);

describe("[A3.3.13.setup.print-quoting] a line printed for a person to paste gives the command exactly its words", () => {
  test("words are quoted per shell, and a word no quoting keeps literal is refused", () => {
    expect(pasteShell("win32")).toBe("PowerShell");
    expect(pasteShell("linux")).toBe("a POSIX shell (sh, bash, zsh)");
    expect(shellWord("linux", "/opt/tasks")).toBe("/opt/tasks");
    expect(shellWord("linux", "it's")).toBe(`'it'\\''s'`);
    expect(shellWord("linux", "$HOME")).toBe(`'$HOME'`);
    expect(shellWord("win32", "C:\\x\\tasks.exe")).toBe("C:\\x\\tasks.exe");
    expect(shellWord("win32", "C:\\$NAME\\tasks.exe")).toBe(`'C:\\$NAME\\tasks.exe'`);
    expect(shellWord("win32", "it's \u2018q\u2019")).toBe(`'it''s \u2018\u2018q\u2019\u2019'`);
    expect(shellWord("win32", "--")).toBe(`'--'`);
    expect(shellWord("win32", "--scope")).toBe("--scope");
    expect(shellWord("win32", "a,b")).toBe(`'a,b'`);
    for (const word of ["a%b", "a!b", "a^b", "a&b", "a|b", "a<b", "a>b", 'a"b', "", "C:\\a b\\"]) {
      expect([word, shellWord("win32", word)]).toEqual([word, undefined]);
    }
    for (const word of ["a\rb", "a\tb", "\u001b[31m", "a\u0085b", "a\u2028b", "a\u007fb"]) {
      expect(shellWord("linux", word)).toBeUndefined();
      expect(shellWord("win32", word)).toBeUndefined();
    }
    // A POSIX shell takes a newline inside single quotes literally; cmd ends a command at it.
    expect(shellWord("linux", "a\nb")).toBe("'a\nb'");
    expect(shellWord("win32", "a\nb")).toBeUndefined();
    for (const word of ["a!b", "a&b", 'a"b', "a%b", ""]) {
      expect(shellWord("linux", word)).not.toBeUndefined();
    }
    expect(shellLine("win32", ["C:\\a b\\claude.exe", "mcp"], { CODEX_HOME: "C:\\h" })).toBe(
      "$env:CODEX_HOME = 'C:\\h'; & 'C:\\a b\\claude.exe' mcp",
    );
    expect(shellLine("linux", ["/a b/claude", "mcp"], { CODEX_HOME: "/h", X: "a b" })).toBe(
      "CODEX_HOME=/h X='a b' '/a b/claude' mcp",
    );
    expect(shellLine("linux", ["claude", "a\rb"])).toBeUndefined();
    expect(shellLine("linux", ["claude"], { "BAD NAME": "x" })).toBeUndefined();
  });

  test(
    "fed to the real shell, every word and variable reaches the command as it was",
    () => {
      expect(WORDS.length).toBeGreaterThan(20);
      for (const shell of shells()) {
        for (const stub of stubs) {
          const line = shellLine(process.platform, ["claude", ...WORDS]);
          expect(line).toBeDefined();
          expect([shell.name, stub.kind, shell.run(line ?? "", stub.dir)?.argv]).toEqual([
            shell.name,
            stub.kind,
            WORDS,
          ]);
          // The command by its path, with a variable set for it.
          const value = `v $${SENTINEL} 'q' \`x\``;
          const withEnv = shellLine(process.platform, [stub.file, ...WORDS], { [SET]: value });
          expect([shell.name, stub.kind, shell.run(withEnv ?? "", stub.dir)]).toEqual([
            shell.name,
            stub.kind,
            { argv: WORDS, set: value },
          ]);
        }
      }
    },
    SLOW,
  );

  test(
    "a line is at most MAX_LINE_BYTES bytes of UTF-8: at the bound every shell gets the words, past it there is no line",
    () => {
      expect(MAX_LINE_BYTES).toBe(4095);
      const head = "claude ";
      const at = ["claude", "x".repeat(MAX_LINE_BYTES - head.length)];
      const line = shellLine(process.platform, at);
      expect(line === undefined ? -1 : Buffer.byteLength(line, "utf8")).toBe(MAX_LINE_BYTES);
      for (const shell of shells()) {
        for (const stub of stubs) {
          expect([shell.name, stub.kind, shell.run(line ?? "", stub.dir)?.argv]).toEqual([
            shell.name,
            stub.kind,
            at.slice(1),
          ]);
        }
      }
      for (const platform of ["win32", "linux"] as const) {
        // One byte past it, as a character or as the second byte of one; a variable counts too.
        expect(shellLine(platform, ["claude", "x".repeat(MAX_LINE_BYTES - head.length + 1)])).toBe(
          undefined,
        );
        expect(shellLine(platform, ["claude", "\u00e9".repeat(2100)])).toBeUndefined();
        expect(shellLine(platform, ["claude"], { X: "x".repeat(MAX_LINE_BYTES) })).toBeUndefined();
        // A 9,000-character word: cmd.exe would refuse the line through an npm `.cmd` shim.
        expect(shellLine(platform, ["claude", "x".repeat(9000)])).toBeUndefined();
      }
      // print refuses with its explained fallback.
      expect(() =>
        snippetFor(
          {
            platform: process.platform,
            userHome: base,
            env: {},
            tasks: windows
              ? `C:\\${"x".repeat(9000)}\\tasks.exe`
              : `/opt/${"x".repeat(9000)}/tasks`,
          },
          "claude-code",
        ),
      ).toThrow(PrintRefused);
    },
    SLOW,
  );

  test(
    "print's Claude Code command registers exactly the install's path, whatever it holds",
    () => {
      const tasks = windows
        ? `C:\\Fixture\\it's $${SENTINEL} (x86)\\tasks.exe`
        : `/opt/it's $${SENTINEL} \`x\`/bin/tasks`;
      const snippet = snippetFor(
        { platform: process.platform, userHome: base, env: {}, tasks },
        "claude-code",
      );
      expect(snippet.runIn).toBe(pasteShell(process.platform));
      const line = snippet.text.trimEnd();
      for (const shell of shells()) {
        for (const stub of stubs) {
          expect([shell.name, stub.kind, shell.run(line, stub.dir)?.argv]).toEqual([
            shell.name,
            stub.kind,
            [
              "mcp",
              "add",
              "--scope",
              "user",
              MCP_SERVER_KEY,
              "--",
              tasks,
              "mcp",
              "--app",
              "claude-code",
            ],
          ]);
        }
      }
      // A path no quoting keeps literal gets no command at all.
      expect(() =>
        snippetFor(
          {
            platform: process.platform,
            userHome: base,
            env: {},
            tasks: windows ? "C:\\a%PATH%\\tasks.exe" : "/opt/a\rb/tasks",
          },
          "claude-code",
        ),
      ).toThrow(PrintRefused);
    },
    SLOW,
  );
});
