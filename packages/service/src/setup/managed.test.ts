// Managed targets, rules 3 and 4 (A3 3.12; M4.05): a file another git repository tracks, or one
// machine.toml lists, is left to its source. Repositories are made by git itself in a temporary
// folder, so the reader of git's files is checked against git's own layout: index versions 2 and
// 4, a SHA-256 repository, a linked worktree, a split index (which counts as tracked), metadata in
// a folder of its own reached through a `.git` file or a link, and a linked folder above the file.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { indexPaths, listedAsManaged, trackedByAnotherRepository } from "./managed.ts";

const SLOW = 120_000;
// Named here, made in beforeAll: a test file's top level runs at collection, its hooks do not.
const base = join(realpathSync.native(tmpdir()), `tasks-managed-${randomBytes(6).toString("hex")}`);
const GLOBAL = join(base, "global.gitconfig");
const GIT_ENV = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")),
  ),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: GLOBAL,
};

function git(args: string[], cwd: string): void {
  const run = spawnSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
    { cwd, env: GIT_ENV, encoding: "utf8", windowsHide: true },
  );
  if (run.status !== 0) throw new Error(`git ${args[0] ?? ""} failed: ${run.stderr}`);
}

/** A user home with agent homes in it: `.codex/config.toml`, `.claude/settings.json`. */
function userHome(name: string): { home: string; codex: string; file: string } {
  const home = join(base, name);
  const codex = join(home, ".codex");
  mkdirSync(codex, { recursive: true });
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(codex, "config.toml"), 'model = "m"\n');
  writeFileSync(join(codex, "a.toml"), "");
  writeFileSync(join(home, ".claude", "settings.json"), "{}");
  return { home, codex, file: join(codex, "config.toml") };
}

const tracked = (file: string, home: string) =>
  trackedByAnotherRepository(process.platform, file, home);

beforeAll(() => {
  mkdirSync(base, { mode: 0o700 });
  writeFileSync(GLOBAL, "");
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("[A3.3.12.setup.managed] a file another repository tracks, or machine.toml lists, is managed", () => {
  test(
    "rule 3: tracked by a repository above the home, in index versions 2 and 4; not by the home's own",
    () => {
      const plain = userHome("plain");
      expect(tracked(plain.file, plain.codex)).toBe(false);

      // A dotfiles repository at the user's home: untracked, then tracked.
      const dot = userHome("dot");
      git(["init", "-q"], dot.home);
      expect(tracked(dot.file, dot.codex)).toBe(false);
      git(["add", ".claude/settings.json", ".codex/a.toml"], dot.home);
      expect(tracked(dot.file, dot.codex)).toBe(false);
      git(["add", ".codex/config.toml"], dot.home);
      expect(tracked(dot.file, dot.codex)).toBe(true);
      // Version 4 compresses each name against the one before it.
      git(["update-index", "--index-version", "4"], dot.home);
      expect(tracked(dot.file, dot.codex)).toBe(true);
      expect(tracked(join(dot.home, ".claude", "settings.json"), join(dot.home, ".claude"))).toBe(
        true,
      );
      git(["rm", "-q", "--cached", ".codex/config.toml"], dot.home);
      expect(tracked(dot.file, dot.codex)).toBe(false);

      // The home is its own repository: the person's record of it, not another tool's.
      const own = userHome("own");
      git(["init", "-q"], own.codex);
      git(["add", "config.toml"], own.codex);
      expect(tracked(own.file, own.codex)).toBe(false);
    },
    SLOW,
  );

  test(
    "rule 3: a SHA-256 repository, a linked worktree, and a split index that cannot be read for certain",
    () => {
      const sha = userHome("sha");
      git(["init", "-q", "--object-format=sha256"], sha.home);
      git(["add", ".codex/a.toml"], sha.home);
      expect(tracked(sha.file, sha.codex)).toBe(false);
      git(["add", ".codex/config.toml"], sha.home);
      expect(tracked(sha.file, sha.codex)).toBe(true);

      // A linked worktree: `.git` is a file naming its git folder, which holds its own index.
      const main = userHome("main");
      git(["init", "-q"], main.home);
      git(["add", "."], main.home);
      git(["commit", "-q", "-m", "fixture"], main.home);
      git(["worktree", "add", "-q", "-b", "fixture-wt", join(base, "linked")], main.home);
      const linked = join(base, "linked", ".codex");
      expect(tracked(join(linked, "config.toml"), linked)).toBe(true);

      // A split index keeps entries in a second file: unknown, so the safe side.
      const split = userHome("split");
      git(["init", "-q"], split.home);
      git(["add", ".codex/a.toml"], split.home);
      git(["update-index", "--split-index"], split.home);
      expect(tracked(split.file, split.codex)).toBe(true);

      // A damaged index is no proof either way.
      const bad = userHome("bad");
      git(["init", "-q"], bad.home);
      writeFileSync(join(bad.home, ".git", "index"), "DIRC\u0000\u0000\u0000\u0002garbage");
      expect(tracked(bad.file, bad.codex)).toBe(true);
      expect(() => indexPaths(Buffer.from("not an index"), 20)).toThrow();
    },
    SLOW,
  );

  test(
    "rule 3: git's own config syntax for the object format, and an index whose bytes do not add up",
    () => {
      // The object format quoted and with a comment, as git's config syntax allows: still SHA-256.
      const quoted = userHome("quoted");
      git(["init", "-q", "--object-format=sha256"], quoted.home);
      git(["add", ".codex/config.toml"], quoted.home);
      const config = join(quoted.home, ".git", "config");
      const text = readFileSync(config, "utf8");
      writeFileSync(
        config,
        text.replace(/objectformat\s*=\s*sha256/iu, 'objectFormat = "sha256" # the format'),
      );
      expect(readFileSync(config, "utf8")).toContain('"sha256" #');
      expect(tracked(quoted.file, quoted.codex)).toBe(true);

      // A tracked file's index with its entry count zeroed: the checksum no longer holds.
      const zeroed = userHome("zeroed");
      git(["init", "-q"], zeroed.home);
      git(["add", ".codex/config.toml"], zeroed.home);
      const indexFile = join(zeroed.home, ".git", "index");
      const index = readFileSync(indexFile);
      index.writeUInt32BE(0, 8);
      writeFileSync(indexFile, index);
      expect(tracked(zeroed.file, zeroed.codex)).toBe(true);

      // An index that is there but cannot be read is no proof that the file is untracked: one
      // that is not a file, and on Linux and macOS one without read access.
      const odd = userHome("odd");
      git(["init", "-q"], odd.home);
      mkdirSync(join(odd.home, ".git", "index"));
      expect(tracked(odd.file, odd.codex)).toBe(true);
      const locked = userHome("locked");
      git(["init", "-q"], locked.home);
      git(["add", ".codex/config.toml"], locked.home);
      if (process.platform !== "win32" && process.getuid?.() !== 0) {
        const lockedIndex = join(locked.home, ".git", "index");
        chmodSync(lockedIndex, 0o000);
        try {
          expect(tracked(locked.file, locked.codex)).toBe(true);
        } finally {
          chmodSync(lockedIndex, 0o600);
        }
      }

      // An index written without its checksum (index.skipHash, git 2.40 and later) is still read.
      const skip = userHome("skip");
      git(["init", "-q"], skip.home);
      git(["-c", "index.skipHash=true", "add", ".codex/a.toml"], skip.home);
      expect(tracked(skip.file, skip.codex)).toBe(false);
      git(["-c", "index.skipHash=true", "add", ".codex/config.toml"], skip.home);
      expect(tracked(skip.file, skip.codex)).toBe(true);
    },
    SLOW,
  );

  test(
    "rule 3: the repository git itself would find, through a .git file, linked metadata or a linked folder above the file; any other .git counts as tracked",
    () => {
      const link = (target: string, path: string) => {
        symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
      };

      // The metadata in a folder of its own: `.git` is a file naming it (gitdir:).
      const sep = userHome("sep");
      const meta = join(base, "sep-meta");
      git(["init", "-q", `--separate-git-dir=${meta}`, sep.home], base);
      expect(lstatSync(join(sep.home, ".git")).isFile()).toBe(true);
      git(["add", ".codex/config.toml"], sep.home);
      expect(tracked(sep.file, sep.codex)).toBe(true);

      // The same metadata through a link (a junction on Windows): git reads it, and so does setup.
      rmSync(join(sep.home, ".git"));
      link(meta, join(sep.home, ".git"));
      expect(tracked(sep.file, sep.codex)).toBe(true);
      git(["rm", "-q", "--cached", ".codex/config.toml"], sep.home);
      git(["add", ".codex/a.toml"], sep.home);
      expect(tracked(sep.file, sep.codex)).toBe(false);

      // A `.git` that cannot be read for certain stops the search and counts as tracking the file:
      // a link whose target is gone, and a `.git` file without a gitdir line.
      const dangling = userHome("dangling");
      const gone = join(base, "dangling-meta");
      mkdirSync(gone);
      link(gone, join(dangling.home, ".git"));
      rmSync(gone, { recursive: true });
      expect(tracked(dangling.file, dangling.codex)).toBe(true);
      const pointerless = userHome("pointerless");
      writeFileSync(join(pointerless.home, ".git"), "not a pointer\n");
      expect(tracked(pointerless.file, pointerless.codex)).toBe(true);

      // A dotfiles repository reached through a linked folder above the home: git, started in the
      // home, walks up the folders as the OS resolves them, so it finds the repository; so does setup.
      const dotfiles = join(base, "dotfiles");
      mkdirSync(join(dotfiles, "config", "Claude"), { recursive: true });
      writeFileSync(join(dotfiles, "config", "Claude", "claude_desktop_config.json"), "{}");
      git(["init", "-q"], dotfiles);
      git(["add", "config/Claude/claude_desktop_config.json"], dotfiles);
      const linkedHome = join(base, "linked-home");
      mkdirSync(linkedHome);
      link(join(dotfiles, "config"), join(linkedHome, ".config"));
      const desktop = join(linkedHome, ".config", "Claude");
      expect(tracked(join(desktop, "claude_desktop_config.json"), desktop)).toBe(true);
      git(["rm", "-q", "--cached", "config/Claude/claude_desktop_config.json"], dotfiles);
      expect(tracked(join(desktop, "claude_desktop_config.json"), desktop)).toBe(false);
    },
    SLOW,
  );

  test("rule 4: a listed file, or a listed folder above it, and nothing else", () => {
    const home = join(base, "listed");
    const file = join(home, ".codex", "config.toml");
    expect(listedAsManaged(process.platform, file, [file])).toBe(true);
    expect(listedAsManaged(process.platform, file, [join(home, ".codex")])).toBe(true);
    expect(listedAsManaged(process.platform, file, [join(home, ".codex-work")])).toBe(false);
    expect(listedAsManaged(process.platform, file, [join(home, ".codex", "config.toml.bak")])).toBe(
      false,
    );
    expect(
      listedAsManaged("win32", "C:\\Users\\A\\.codex\\config.toml", ["c:\\users\\a\\.CODEX"]),
    ).toBe(true);
    expect(listedAsManaged("linux", "/home/a/.codex/config.toml", ["/home/a/.CODEX"])).toBe(false);
  });
});
