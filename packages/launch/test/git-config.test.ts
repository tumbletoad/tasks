// The Git config reader behind a place's remote. The remote is an
// identity check, so the reader follows git's own syntax or reads nothing. Examples first, among
// them round three's finding 2 (a URL continued onto the next line read as one URL for two
// remotes). Then git itself as the oracle: random config files, valid and broken, read by this
// reader and by `git config --list`, which must agree entry for entry, or both refuse; and URLs
// written by git into a repository of the test's own, read back by this reader. Running git is
// right here and nowhere else in the product's tests: it is what the reader must match. Where git
// is not installed the oracle tests are skipped with that reason.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  parseGitConfig,
  readGitRemote,
  remoteFromConfig,
  type GitConfigEntry,
} from "../src/git-remote.ts";

/**
 * The test's own folder for git's files: made before the first test and removed by its full name
 * after the last, also when a test failed or timed out. Nothing is made at module level: verify's
 * manifest step loads every test file through Vitest's collection, which runs a file's top level
 * but none of its hooks, so a folder made there was left behind on every verify.
 */
let base = "";
/** See below: set once git's own reading of a blank is known. */
let verbatimBlanks = false;
beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "ttasks-git-config-")));
  writeFileSync(join(base, "global.cfg"), "");
  verbatimBlanks = HAS_GIT && gitReads("[a]\n\tk = x\ty\n", 0)?.[0]?.value === "x\ty";
});
afterAll(() => {
  if (base !== "") rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

/** git's environment: no system config, an empty global one, no config from the environment. */
const gitEnv = () => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")),
  ),
  GIT_CONFIG_NOSYSTEM: "1",
  ...(base === "" ? {} : { GIT_CONFIG_GLOBAL: join(base, "global.cfg") }),
});
const gitRuns = (args: string[], cwd?: string) =>
  spawnSync("git", args, {
    encoding: "buffer",
    env: gitEnv(),
    ...(cwd === undefined ? {} : { cwd }),
  });
/** Read at collection, to skip the oracle tests by name: `--version` reads no file. */
const HAS_GIT = gitRuns(["--version"]).status === 0;

/** What git reads from a config file: its entries, or undefined when it refuses the file. */
function gitReads(text: string, n: number): GitConfigEntry[] | undefined {
  const file = join(base, `case-${String(n)}.cfg`);
  writeFileSync(file, Buffer.from(text, "utf8"));
  const run = gitRuns(["config", "--file", file, "--no-includes", "--list", "-z"]);
  if (run.status !== 0) return undefined;
  const out = run.stdout.toString("utf8");
  return out
    .split("\u0000")
    .slice(0, -1)
    .map((entry) => {
      const cut = entry.indexOf("\n");
      return cut < 0
        ? { key: entry, value: null }
        : { key: entry.slice(0, cut), value: entry.slice(cut + 1) };
    });
}

/*
 * `verbatimBlanks`: whether the installed git keeps blanks between the words of a value as written
 * (newer git, as git-config(1) says) or writes a space for each (older git, 2.34 for one). The
 * reader follows the first; against the second, entries are compared with every tab and carriage
 * return taken as a space, and remoteFromConfig refuses a URL with a blank inside for that reason.
 */
const blanksAsSpaces = (entries: readonly GitConfigEntry[] | undefined) =>
  entries?.map((e) => ({ key: e.key, value: e.value?.replace(/[\t\r]/gu, " ") ?? null }));

const remote = (url: string) => ({ status: "remote", url });
const UNREADABLE = { status: "unreadable" };

describe("[A1.3.15.places.git-config] the Git config reader follows git's syntax or reads nothing", () => {
  test("git's syntax, by example", () => {
    const read = (text: string) => parseGitConfig(text);
    // Sections and subsections: a quoted one as written, a dotted one in lower case.
    expect(read('[Remote "Origin"]\n\tURL = x\n[remote.Fork]\nurl = y\n')).toEqual([
      { key: "remote.Origin.url", value: "x" },
      { key: "remote.fork.url", value: "y" },
    ]);
    // A setting after the header on the same line; a name without `=` is a null value.
    expect(read('[remote "o"] url = x\n\tmirror\n')).toEqual([
      { key: "remote.o.url", value: "x" },
      { key: "remote.o.mirror", value: null },
    ]);
    // Quotes, escapes, comments, inner and trailing blanks, CRLF.
    expect(
      read('[a]\r\n\tk = " x " y  # c\r\n\tq = "a#b" ; c\r\n\te = a\\tb\\n\\"\\\\\r\n'),
    ).toEqual([
      { key: "a.k", value: " x  y" },
      { key: "a.q", value: "a#b" },
      { key: "a.e", value: 'a\tb\n"\\' },
    ]);
    // A backslash at the end of a line continues the value on the next line.
    expect(read("[a]\n\tk = one\\\ntwo\n")).toEqual([{ key: "a.k", value: "onetwo" }]);
    // A UTF-8 byte order mark in front is skipped.
    expect(read('\ufeff[remote "o"]\nurl = x\n')).toEqual([{ key: "remote.o.url", value: "x" }]);
    // What git refuses: an unknown escape, an open quote, a space before `]`, a name that starts
    // with a digit, a header over two lines, `_` in a section name, text after a name without `=`.
    for (const bad of [
      "[a]\nk = \\x\n",
      '[a]\nk = "open\n',
      '[remote "o" ]\nurl = x\n',
      "[a]\n1k = x\n",
      '[remote "o\\\n"]\n',
      "[a_b]\nk = x\n",
      "[a]\nk # c\n",
      "[a]\nk x\n",
      "[",
    ]) {
      expect([bad, read(bad)]).toEqual([bad, undefined]);
    }
    // A NUL character, where git would cut the value.
    expect(read('[remote "o"]\nurl = a\u0000b\n')).toBeUndefined();
  });

  test("round three's finding 2: a URL continued onto the next line is not cut", () => {
    const a = '[remote "origin"]\n\turl = https://example.com/a\\\nb.git\n';
    const b = '[remote "origin"]\n\turl = https://example.com/a\\\nc.git\n';
    expect(remoteFromConfig(a)).toEqual(remote("https://example.com/ab.git"));
    expect(remoteFromConfig(b)).toEqual(remote("https://example.com/ac.git"));
  });

  test("what the reader does not support is unreadable, never a guess", () => {
    const origin = '[remote "origin"]\n\turl = https://example.com/o.git\n';
    for (const [why, text] of [
      ["an include", `[include]\n\tpath = other.cfg\n${origin}`],
      ["an includeIf", `[includeIf "gitdir:~/x/"]\n\tpath = other.cfg\n${origin}`],
      ["an include, dotted", `[includeif.onbranch:main]\n\tpath = x\n${origin}`],
      [
        "a rewrite that applies",
        `[url "ssh://git@example.com/"]\n\tinsteadOf = https://example.com/\n${origin}`,
      ],
      ["a rewrite of everything", `[url "x"]\n\tinsteadOf =\n${origin}`],
      ["per-worktree config", `[extensions]\n\tworktreeConfig = true\n${origin}`],
      ["an empty URL", `${origin}\turl =\n`],
      ["a URL without a value", '[remote "origin"]\n\turl\n'],
      ["a remote without a name", '[remote ""]\n\turl = https://example.com/x.git\n'],
      ["a syntax error", `${origin}[core]\n\tbare = "\n`],
      [
        "a URL beyond the bound",
        `[remote "origin"]\n\turl = https://example.com/${"x".repeat(2100)}\n`,
      ],
      // Older git reads `a<TAB>b` as `a b`, newer git as written: two readings.
      ["a blank inside the URL", '[remote "origin"]\n\turl = https://example.com/a\tb.git\n'],
      [
        "a quoted blank inside the URL",
        '[remote "origin"]\n\turl = "https://example.com/a b.git"\n',
      ],
    ] as const) {
      expect([why, remoteFromConfig(text)]).toEqual([why, UNREADABLE]);
    }
    // A rewrite for another prefix, or for pushing only, changes nothing that is read.
    expect(
      remoteFromConfig(
        `[url "ssh://git@other.example/"]\n\tinsteadOf = https://other.example/\n${origin}`,
      ),
    ).toEqual(remote("https://example.com/o.git"));
    expect(
      remoteFromConfig(
        `[url "ssh://git@example.com/"]\n\tpushInsteadOf = https://example.com/\n${origin}`,
      ),
    ).toEqual(remote("https://example.com/o.git"));
    // A local remote is read exactly, and kept off the record: none.
    expect(remoteFromConfig('[remote "origin"]\n\turl = /srv/git/o.git\n')).toEqual({
      status: "none",
    });
    // The first URL of origin, else of the remote whose URL comes first.
    expect(
      remoteFromConfig(
        '[remote "b"]\n\turl = https://b.example/x\n[remote "a"]\n\turl = https://a.example/x\n',
      ),
    ).toEqual(remote("https://b.example/x"));
    expect(remoteFromConfig(`${origin}\turl = https://mirror.example/o.git\n`)).toEqual(
      remote("https://example.com/o.git"),
    );
  });

  test.skipIf(!HAS_GIT)(
    "[A1.3.15.places.git-config] random config files read as git reads them (git is the oracle)",
    () => {
      const blank = fc.constantFrom("", " ", "\t", "  \t");
      const someBlank = fc.constantFrom(" ", "\t", "  ");
      const section = fc.constantFrom(
        "remote",
        "REMOTE",
        "Url",
        "core",
        "a.b",
        "sec-tion",
        "x_y",
        "",
        "é",
      );
      const subPart = fc.constantFrom(
        "o",
        "origin",
        "Fork",
        " ",
        '\\"',
        "\\\\",
        "\\t",
        "#",
        ";",
        "]",
        "é",
        ".",
        "\\",
      );
      const sub = fc.array(subPart, { maxLength: 4 }).map((parts) => parts.join(""));
      const header = fc.oneof(
        section.map((s) => `[${s}]`),
        fc
          .tuple(section, someBlank, sub, blank)
          .map(([s, w, x, after]) => `[${s}${w}"${x}"${after}]`),
        fc
          .tuple(section, fc.constantFrom("origin", "Origin", "a.b", "x y"))
          .map(([s, x]) => `[${s}.${x}]`),
      );
      const name = fc.constantFrom(
        "url",
        "URL",
        "insteadOf",
        "fetch",
        "k-1",
        "1k",
        "_k",
        "k.x",
        "k_x",
      );
      const valuePart = fc.constantFrom(
        "a",
        "https://example.com/o.git",
        " ",
        "\t",
        '"',
        '\\"',
        "\\\\",
        "\\n",
        "\\t",
        "\\b",
        "\\x",
        "\\",
        "#",
        ";",
        "é",
        "\r",
        "\\\n",
        "\\\r\n",
        "[x]",
        "=",
      );
      const value = fc.array(valuePart, { maxLength: 6 }).map((parts) => parts.join(""));
      const setting = fc
        .tuple(blank, name, blank, fc.boolean(), blank, value)
        .map(([a, n, b, eq, c, v]) => (eq ? `${a}${n}${b}=${c}${v}` : `${a}${n}${b}`));
      const comment = fc
        .tuple(blank, fc.constantFrom("#", ";"), value)
        .map(([a, m, v]) => `${a}${m}${v}`);
      const line = fc.oneof(
        { weight: 2, arbitrary: header },
        { weight: 4, arbitrary: setting },
        { weight: 1, arbitrary: comment },
        { weight: 1, arbitrary: blank },
        {
          weight: 1,
          arbitrary: fc.tuple(header, blank, setting).map(([h, b, s]) => `${h}${b}${s}`),
        },
      );
      const file = fc
        .tuple(
          fc.boolean(),
          fc.array(fc.tuple(line, fc.constantFrom("\n", "\r\n")), { maxLength: 8 }),
          fc.boolean(),
        )
        .map(
          ([bom, lines, last]) =>
            (bom ? "\ufeff" : "") +
            lines
              .map(([l, eol]) => l + eol)
              .join("")
              .replace(/\r?\n$/u, last ? "\n" : ""),
        );
      let n = 0;
      let refused = 0;
      let read = 0;
      fc.assert(
        fc.property(file, (text) => {
          n += 1;
          const git = gitReads(text, n);
          const ours = parseGitConfig(text);
          if (verbatimBlanks) expect([text, ours]).toEqual([text, git]);
          else expect([text, blanksAsSpaces(ours)]).toEqual([text, blanksAsSpaces(git)]);
          if (git === undefined) refused += 1;
          else read += 1;
        }),
        { numRuns: 200 },
      );
      // Both kinds were met: files git reads and files it refuses.
      expect([refused > 0, read > 0]).toEqual([true, true]);
    },
    120_000,
  );

  test.skipIf(!HAS_GIT)(
    "[A1.3.15.places.git-config] URLs git writes into a repository of the test's own are read back exactly",
    async () => {
      const repo = join(base, "repo");
      mkdirSync(repo);
      expect(gitRuns(["init", "--quiet"], repo).status).toBe(0);
      const written = [
        "https://example.com/plain.git",
        "git@example.com:group/r.git",
        'https://example.com/odd "quoted" #hash ;semi\\back\ttab.git',
        " leading and trailing ",
        "line\nbreak",
      ];
      for (const url of written) {
        expect(gitRuns(["config", "remote.origin.url", url], repo).status).toBe(0);
        const text = readFileSync(join(repo, ".git", "config"), "utf8");
        const ours = parseGitConfig(text)?.filter((e) => e.key === "remote.origin.url");
        expect(ours).toEqual([{ key: "remote.origin.url", value: url }]);
        const got = gitRuns(
          ["config", "--file", join(".git", "config"), "--get-all", "remote.origin.url"],
          repo,
        );
        expect(got.stdout.toString("utf8")).toBe(`${url}\n`);
      }
      // An ordinary remote written by git is the place's remote.
      expect(
        gitRuns(["config", "remote.origin.url", "https://example.com/plain.git"], repo).status,
      ).toBe(0);
      expect(await readGitRemote(repo)).toEqual(remote("https://example.com/plain.git"));
    },
    60_000,
  );
});
