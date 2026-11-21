// Managed targets, rules 3 and 4 (A3 3.12; M4.05): a file another git repository tracks, or one
// machine.toml lists, is left to its source. Rule 3 asks git itself, so each case checks setup's
// answer against a repository git made in this file's temporary folder: the layouts git finds
// through a `.git` file, linked metadata, a linked folder above the file, a linked worktree and a
// submodule, the ones a reader of git's files got wrong (an empty `.git` folder git skips, a deep
// folder, `core.worktree`), and the safe side when git gives no clear answer (no git on the PATH, a
// git that times out or answers in another form). A repository's file-system monitor is never
// started. Stubs are Node scripts in the same folder, and nothing real is configured.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
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
import { listedAsManaged, trackedByAnotherRepository, type GitAsk } from "./managed.ts";

const SLOW = 120_000;
const windows = process.platform === "win32";
// Named here, made in beforeAll: a test file's top level runs at collection, its hooks do not.
const base = join(
  realpathSync.native(tmpdir()),
  `ttasks-managed-${randomBytes(6).toString("hex")}`,
);
const GLOBAL = join(base, "global.gitconfig");
/** The fixtures' git: no system or global configuration of the machine's. */
const GIT_ENV = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")),
  ),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: GLOBAL,
};

function git(args: string[], cwd: string): string {
  const run = spawnSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
    { cwd, env: GIT_ENV, encoding: "utf8", windowsHide: true },
  );
  if (run.status !== 0) throw new Error(`git ${args[0] ?? ""} failed: ${run.stderr}`);
  return run.stdout;
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

/**
 * Setup's answer, asking the git on this test's PATH (or the one `ask` names). A clear answer
 * here must not depend on how fast a loaded machine starts git, so its deadline is generous; only
 * the case of a git that never answers sets its own.
 */
const tracked = (file: string, home: string, ask: Partial<GitAsk> = {}) =>
  trackedByAnotherRepository(process.platform, file, home, {
    env: GIT_ENV,
    deadlineMs: 120_000,
    ...ask,
  });

/** Whether git itself, run in the file's folder, lists the file. */
const gitTracks = (folder: string, name: string): boolean =>
  git(["ls-files", "--", name], folder).trim() === name;

const link = (target: string, path: string) => {
  symlinkSync(target, path, windows ? "junction" : "dir");
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Whether a process is gone within a while (a loaded machine may take its time); kills it if not. */
async function exited(pid: number): Promise<boolean> {
  const until = Date.now() + 30_000;
  while (alive(pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  const left = alive(pid);
  if (left) process.kill(pid, "SIGKILL");
  return !left;
}

/**
 * A stand-in for git: a Node script that writes its PID and argv to `<dir>/<name>.json`, then
 * answers as `answer` says, or never.
 */
function stubGit(
  name: string,
  answer: { readonly ls?: string; readonly top?: string; readonly code?: number } | "hang",
): readonly string[] {
  const dir = join(base, "stubs");
  mkdirSync(dir, { recursive: true });
  const report = join(dir, `${name}.json`);
  const script = join(dir, `${name}.cjs`);
  writeFileSync(
    script,
    [
      `const fs = require("node:fs");`,
      `fs.appendFileSync(${JSON.stringify(report)}, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }) + "\\n");`,
      answer === "hang"
        ? "setInterval(() => {}, 1000);"
        : [
            `const a = ${JSON.stringify(answer)};`,
            `process.stdout.write(process.argv.includes("ls-files") ? (a.ls ?? "") : (a.top ?? ""));`,
            `process.exitCode = a.code ?? 0;`,
          ].join("\n"),
    ].join("\n"),
  );
  return [process.execPath, script];
}

const stubRuns = (name: string): { pid: number; argv: string[] }[] => {
  const report = join(base, "stubs", `${name}.json`);
  return existsSync(report)
    ? readFileSync(report, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { pid: number; argv: string[] })
    : [];
};

beforeAll(() => {
  mkdirSync(base, { mode: 0o700 });
  writeFileSync(GLOBAL, "");
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("[A3.3.12.setup.managed] a file another repository tracks, or machine.toml lists, is managed", () => {
  test(
    "rule 3: tracked by a repository above the home, by git's own answer; not by the home's own",
    async () => {
      const plain = userHome("plain");
      expect(await tracked(plain.file, plain.codex)).toBe(false);

      // A dotfiles repository at the user's home: untracked, then tracked.
      const dot = userHome("dot");
      git(["init", "-q"], dot.home);
      expect(await tracked(dot.file, dot.codex)).toBe(false);
      git(["add", ".claude/settings.json", ".codex/a.toml"], dot.home);
      expect(await tracked(dot.file, dot.codex)).toBe(false);
      git(["add", ".codex/config.toml"], dot.home);
      expect(await tracked(dot.file, dot.codex)).toBe(true);
      expect(
        await tracked(join(dot.home, ".claude", "settings.json"), join(dot.home, ".claude")),
      ).toBe(true);
      git(["rm", "-q", "--cached", ".codex/config.toml"], dot.home);
      expect(await tracked(dot.file, dot.codex)).toBe(false);

      // The home is its own repository: the person's record of it, not another tool's.
      const own = userHome("own");
      git(["init", "-q"], own.codex);
      git(["add", "config.toml"], own.codex);
      expect(await tracked(own.file, own.codex)).toBe(false);
    },
    SLOW,
  );

  test(
    "rule 3: the repository git finds through a .git file, linked metadata, a linked folder above the file, a linked worktree and a submodule",
    async () => {
      // The metadata in a folder of its own: `.git` is a file naming it (gitdir:).
      const sep = userHome("sep");
      const meta = join(base, "sep-meta");
      git(["init", "-q", `--separate-git-dir=${meta}`, sep.home], base);
      expect(lstatSync(join(sep.home, ".git")).isFile()).toBe(true);
      git(["add", ".codex/config.toml"], sep.home);
      expect(await tracked(sep.file, sep.codex)).toBe(true);

      // The same metadata through a link (a junction on Windows).
      rmSync(join(sep.home, ".git"));
      link(meta, join(sep.home, ".git"));
      expect(await tracked(sep.file, sep.codex)).toBe(true);
      git(["rm", "-q", "--cached", ".codex/config.toml"], sep.home);
      git(["add", ".codex/a.toml"], sep.home);
      expect(await tracked(sep.file, sep.codex)).toBe(false);

      // A dotfiles repository reached through a linked folder above the home: git, started in the
      // folder as the OS resolves it, finds the repository; so does setup.
      const dotfiles = join(base, "dotfiles");
      mkdirSync(join(dotfiles, "config", "Claude"), { recursive: true });
      writeFileSync(join(dotfiles, "config", "Claude", "claude_desktop_config.json"), "{}");
      git(["init", "-q"], dotfiles);
      git(["add", "config/Claude/claude_desktop_config.json"], dotfiles);
      const linkedHome = join(base, "linked-home");
      mkdirSync(linkedHome);
      link(join(dotfiles, "config"), join(linkedHome, ".config"));
      const desktop = join(linkedHome, ".config", "Claude");
      expect(await tracked(join(desktop, "claude_desktop_config.json"), desktop)).toBe(true);
      git(["rm", "-q", "--cached", "config/Claude/claude_desktop_config.json"], dotfiles);
      expect(await tracked(join(desktop, "claude_desktop_config.json"), desktop)).toBe(false);

      // A linked worktree: `.git` is a file naming its git folder, which holds its own index.
      const main = userHome("main");
      git(["init", "-q"], main.home);
      git(["add", "."], main.home);
      git(["commit", "-q", "-m", "fixture"], main.home);
      git(["worktree", "add", "-q", "-b", "fixture-wt", join(base, "linked")], main.home);
      const linked = join(base, "linked", ".codex");
      expect(await tracked(join(linked, "config.toml"), linked)).toBe(true);

      // A submodule: git answers for the repository the file's folder belongs to.
      const inner = userHome("inner");
      git(["init", "-q"], inner.home);
      git(["add", ".codex/config.toml"], inner.home);
      git(["commit", "-q", "-m", "fixture"], inner.home);
      const outer = join(base, "outer");
      mkdirSync(outer);
      git(["init", "-q"], outer);
      git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", inner.home, "sub"], outer);
      const sub = join(outer, "sub", ".codex");
      expect(lstatSync(join(outer, "sub", ".git")).isFile()).toBe(true);
      writeFileSync(join(sub, "a.toml"), "");
      expect(await tracked(join(sub, "config.toml"), sub)).toBe(true);
      expect(await tracked(join(sub, "a.toml"), sub)).toBe(false);
    },
    SLOW,
  );

  test(
    "rule 3: an empty .git folder git skips, and a file 66 folders below its repository",
    async () => {
      // An empty `.git` folder is no repository to git: it goes on to the one above, which tracks it.
      const skipped = userHome("skipped");
      git(["init", "-q"], skipped.home);
      git(["add", ".codex/config.toml"], skipped.home);
      mkdirSync(join(skipped.codex, ".git"));
      expect(gitTracks(skipped.codex, "config.toml")).toBe(true);
      expect(await tracked(skipped.file, skipped.codex)).toBe(true);

      // No level limit: the repository 66 folders above the file's folder.
      const top = join(base, "deep");
      const levels = Array.from({ length: 66 }, () => "a");
      const folder = join(top, ...levels);
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "config.toml"), "");
      git(["init", "-q"], top);
      git(["add", "--", `${levels.join("/")}/config.toml`], top);
      expect(gitTracks(folder, "config.toml")).toBe(true);
      expect(await tracked(join(folder, "config.toml"), folder)).toBe(true);
    },
    SLOW,
  );

  test(
    "rule 3: a repository whose work tree is redirected to the folder above (core.worktree)",
    async (context) => {
      // `.git` beside the file: the repository tracks `.codex/config.toml` of a work tree that is
      // not the home.
      const moved = userHome("moved");
      git(["init", "-q"], moved.codex);
      git(["config", "core.worktree", "../.."], moved.codex);
      git(["add", "config.toml"], moved.codex);
      // Setup's answer is git's. Git 2.34 does not list the file from this folder, and then there
      // is nothing to compare with.
      if (!gitTracks(moved.codex, "config.toml")) {
        context.skip("this machine's git does not list a file through a redirected work tree");
      }
      expect(await tracked(moved.file, moved.codex)).toBe(true);
    },
    SLOW,
  );

  test(
    "rule 3: a repository's file-system monitor is never started by setup's question",
    async () => {
      const fsm = userHome("fsm");
      git(["init", "-q"], fsm.home);
      git(["add", ".codex/config.toml"], fsm.home);
      // A hook git runs through its shell (Git for Windows' own sh on Windows), which only records
      // that it ran.
      const ran = join(base, "fsm-ran").replaceAll("\\", "/");
      const hook = join(base, "fsm-hook.sh");
      writeFileSync(hook, `#!/bin/sh\necho ran >> '${ran}'\nexit 1\n`, { mode: 0o755 });
      git(["config", "core.fsmonitor", hook.replaceAll("\\", "/")], fsm.home);
      // Git itself starts it to list the files.
      expect(gitTracks(fsm.codex, "config.toml")).toBe(true);
      expect(existsSync(ran)).toBe(true);
      rmSync(ran);
      expect(await tracked(fsm.file, fsm.codex)).toBe(true);
      expect(await tracked(join(fsm.codex, "a.toml"), fsm.codex)).toBe(false);
      expect(existsSync(ran)).toBe(false);
    },
    SLOW,
  );

  test(
    "rule 3: no clear answer is the safe side: a .git git refuses, a huge .git file, no git on the PATH, a git that times out or answers otherwise",
    async () => {
      // A `.git` git refuses: a link whose target is gone, and a file that is not a gitfile.
      const dangling = userHome("dangling");
      const gone = join(base, "dangling-meta");
      mkdirSync(gone);
      link(gone, join(dangling.home, ".git"));
      rmSync(gone, { recursive: true });
      expect(await tracked(dangling.file, dangling.codex)).toBe(true);
      const prefixed = userHome("prefixed");
      git(["init", "-q", join(base, "prefixed-meta")], base);
      writeFileSync(
        join(prefixed.home, ".git"),
        `invalid prefix\ngitdir: ${join(base, "prefixed-meta", ".git")}\n`,
      );
      expect(await tracked(prefixed.file, prefixed.codex)).toBe(true);

      // A 16 MiB `.git` file: setup reads nothing inside a `.git` (managed.ts looks at names only),
      // and git refuses it.
      const huge = userHome("huge");
      writeFileSync(join(huge.home, ".git"), Buffer.alloc(16 * 1024 * 1024, 0x61));
      expect(await tracked(huge.file, huge.codex)).toBe(true);
      const source = readFileSync(join(import.meta.dirname, "managed.ts"), "utf8");
      expect(/import \{([^}]*)\} from "node:fs";/u.exec(source)?.[1]?.trim()).toBe(
        "lstatSync, realpathSync",
      );

      // No git on the PATH: a file under a `.git` is managed, one under none is not.
      const repo = userHome("no-git");
      git(["init", "-q"], repo.home);
      const empty = join(base, "empty-path");
      mkdirSync(empty);
      const noGit = { env: { ...GIT_ENV, PATH: empty, Path: empty } };
      expect(await tracked(repo.file, repo.codex, noGit)).toBe(true);
      const bare = userHome("no-git-no-repo");
      expect(await tracked(bare.file, bare.codex, noGit)).toBe(false);

      // A git that never answers: ended at its deadline, with what it started.
      expect(
        await tracked(repo.file, repo.codex, { git: stubGit("hang", "hang"), deadlineMs: 1_000 }),
      ).toBe(true);
      for (const { pid } of stubRuns("hang")) expect(await exited(pid)).toBe(true);

      // A git whose answer is of another form: a failure, or a work tree that is not a path.
      expect(await tracked(repo.file, repo.codex, { git: stubGit("fails", { code: 1 }) })).toBe(
        true,
      );
      expect(
        await tracked(repo.file, repo.codex, {
          git: stubGit("odd", { ls: "config.toml\0", top: "not a path\n" }),
        }),
      ).toBe(true);
      // The question as asked: no pager, no file-system monitor, the name as a literal pathspec.
      expect(await tracked(repo.file, repo.codex, { git: stubGit("untracked", { ls: "" }) })).toBe(
        false,
      );
      expect(stubRuns("untracked").map((r) => r.argv)).toEqual([
        [
          "--no-pager",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.useBuiltinFSMonitor=false",
          "ls-files",
          "-z",
          "--",
          windows || process.platform === "darwin"
            ? ":(literal,icase)config.toml"
            : ":(literal)config.toml",
        ],
      ]);
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
