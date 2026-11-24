// Exact-folder binding for T3 (A4 3.4.1 steps 1 to 4, A4 5.1 "Exact-folder resolver", R11): each
// case gives the expected strategy or nothing, and never a containing project. Directories are
// compared by identity (A1 3.15). Git repositories and worktrees are made by git itself in a
// temporary folder, so the reader of git's files is checked against git's own layout, and the fake
// T3 checks an existing worktree with `git worktree list`, as T3 does. Where git is not installed
// those cases are skipped with that reason.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FakeT3 } from "@ttasks/testkit/fake-t3";
import { LaunchMachine } from "../src/machine.ts";
import { resolvePlace } from "../src/places.ts";
import { bindFolder, identityAt, worktreeAt, type T3Project } from "../src/t3-binding.ts";
import { T3Route } from "../src/t3-route.ts";
import { MemoryT3Files } from "../src/t3-state.ts";
import { MemoryDurable, MemoryExecutionStore, randomId } from "./memory-store.ts";
import { MACHINE } from "./stores.ts";

const SLOW = 60_000;
// The folder is only named here and made in beforeAll: verify's manifest step loads every test file
// through Vitest's collection, which runs a file's top level but none of its hooks, so a folder made
// at module level would be left behind on every verify.
const TMP = realpathSync.native(tmpdir());
const base = join(TMP, `ttasks-t3-bind-${randomBytes(6).toString("hex")}`);
const work = join(base, "work");

afterAll(() => {
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const GLOBAL = join(base, "global.gitconfig");
const GIT_ENV = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")),
  ),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: GLOBAL,
};
const git = (args: string[], cwd: string) =>
  spawnSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
    { cwd, env: GIT_ENV, encoding: "utf8", windowsHide: true },
  );
const HAS_GIT = git(["--version"], TMP).status === 0;

/** A folder's binding input. */
async function at(path: string) {
  const identity = await identityAt(path);
  if (identity === undefined) throw new Error("fixture folder");
  return { path: realpathSync.native(path), identity };
}

const project = (id: string, root: string): T3Project => ({ id, root });

beforeAll(() => {
  mkdirSync(base, { mode: 0o700 });
  mkdirSync(work);
  writeFileSync(GLOBAL, "");
  mkdirSync(join(work, "lumen", "docs"), { recursive: true });
  mkdirSync(join(work, "linked-target"), { recursive: true });
  symlinkSync(
    join(work, "linked-target"),
    join(work, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  if (!HAS_GIT) return;
  const ok = (run: ReturnType<typeof git>) => {
    if (run.status !== 0) throw new Error(`git failed: ${run.stderr}`);
  };
  ok(git(["init", "-q", "repo"], work));
  ok(git(["commit", "-q", "--allow-empty", "-m", "fixture"], join(work, "repo")));
  ok(git(["worktree", "add", "-q", "-b", "fixture-wt", "../repo-wt"], join(work, "repo")));
  ok(git(["clone", "-q", "repo", "repo-clone"], work));
  mkdirSync(join(work, "repo-wt", "sub"), { recursive: true });
  // A main checkout whose git folder lives elsewhere (`.git` is a file without a commondir), and
  // a linked worktree of it.
  ok(git(["init", "-q", `--separate-git-dir=${join(work, "sep-store.git")}`, "sep"], work));
  ok(git(["commit", "-q", "--allow-empty", "-m", "fixture"], join(work, "sep")));
  ok(git(["worktree", "add", "-q", "-b", "fixture-sep", "../sep-wt"], join(work, "sep")));
});

describe("[A4.5.t3.binding] exact-folder binding for T3", () => {
  test("an exact project root binds with the root strategy; a containing project never does", async () => {
    const lumen = project("p-lumen", join(work, "lumen"));
    expect(await bindFolder([lumen], await at(join(work, "lumen")))).toEqual({
      kind: "bound",
      projectId: "p-lumen",
      strategy: { type: "root" },
    });
    expect(await bindFolder([lumen], await at(join(work, "lumen", "docs")))).toEqual({
      kind: "none",
    });
    // A root T3 lists that is gone or not absolute names nothing.
    expect(
      await bindFolder(
        [project("gone", join(work, "missing")), project("rel", "lumen")],
        await at(join(work, "lumen")),
      ),
    ).toEqual({ kind: "none" });
  });

  test("a root spelled through a link, or in another case where the OS folds case, is the folder", async () => {
    const viaLink = project("p-link", join(work, "linked"));
    expect(await bindFolder([viaLink], await at(join(work, "linked-target")))).toMatchObject({
      kind: "bound",
      projectId: "p-link",
    });
    if (process.platform === "win32") {
      const upper = project("p-case", join(work, "LUMEN"));
      expect(await bindFolder([upper], await at(join(work, "lumen")))).toMatchObject({
        kind: "bound",
        projectId: "p-case",
      });
    }
  });

  test.skipIf(!HAS_GIT)(
    "an existing worktree binds to the repository's project, the main worktree's first",
    async () => {
      const wt = await at(join(work, "repo-wt"));
      expect(await worktreeAt(wt.path)).toMatchObject({ main: false, listed: true });
      expect(await worktreeAt(join(work, "repo"))).toMatchObject({ main: true, listed: true });
      const main = project("p-main", join(work, "repo"));
      expect(await bindFolder([main], wt)).toEqual({
        kind: "bound",
        projectId: "p-main",
        strategy: { type: "existing_worktree", worktreePath: wt.path },
      });
      // A project at another worktree of the repository binds the main checkout too; with both
      // registered, the main worktree's project is preferred.
      const other = project("p-wt", join(work, "repo-wt"));
      expect(await bindFolder([other], await at(join(work, "repo")))).toMatchObject({
        projectId: "p-wt",
        strategy: { type: "existing_worktree" },
      });
      const run = git(
        ["worktree", "add", "-q", "-b", "fixture-wt2", "../repo-wt2"],
        join(work, "repo"),
      );
      expect(run.status, run.stderr).toBe(0);
      expect(await bindFolder([other, main], await at(join(work, "repo-wt2")))).toMatchObject({
        projectId: "p-main",
      });
    },
  );

  test.skipIf(!HAS_GIT)(
    "a main checkout with its git folder elsewhere is a project root its worktrees bind to; it is not listed itself",
    async () => {
      const sepWt = await at(join(work, "sep-wt"));
      const sep = project("p-sep", join(work, "sep"));
      // `git -C sep worktree list` lists sep-wt: T3 accepts it as an existing worktree of p-sep.
      const listed = git(["worktree", "list", "--porcelain"], join(work, "sep"));
      expect(listed.stdout).toContain(`worktree ${sepWt.path.replaceAll("\\", "/")}`);
      expect(await bindFolder([sep], sepWt)).toEqual({
        kind: "bound",
        projectId: "p-sep",
        strategy: { type: "existing_worktree", worktreePath: sepWt.path },
      });
      // Git lists the git folder, not the checkout, as that repository's main worktree, so the
      // checkout itself is no existing worktree of a project at sep-wt: it asks.
      expect(await worktreeAt(join(work, "sep"))).toMatchObject({ main: true, listed: false });
      expect(
        await bindFolder([project("p-sep-wt", join(work, "sep-wt"))], await at(join(work, "sep"))),
      ).toEqual({ kind: "none" });
      // Another repository's project never binds it.
      expect(await bindFolder([project("p-main", join(work, "repo"))], sepWt)).toEqual({
        kind: "none",
      });
    },
  );

  test.skipIf(!HAS_GIT)(
    "a sibling clone, a subfolder of a worktree and a submodule's folder bind to nothing",
    async () => {
      const main = project("p-main", join(work, "repo"));
      expect(await bindFolder([main], await at(join(work, "repo-clone")))).toEqual({
        kind: "none",
      });
      expect(await bindFolder([main], await at(join(work, "repo-wt", "sub")))).toEqual({
        kind: "none",
      });
      // A `.git` file without a commondir in its git folder: a submodule's. It is the main checkout
      // of its own repository, not listed, and never a worktree of the superproject.
      const sub = join(work, "submodule-like");
      const gitDir = join(work, "repo", ".git", "modules", "fixture");
      mkdirSync(sub, { recursive: true });
      mkdirSync(gitDir, { recursive: true });
      writeFileSync(join(sub, ".git"), `gitdir: ${gitDir}\n`);
      expect(await worktreeAt(sub)).toMatchObject({ main: true, listed: false });
      expect(await bindFolder([main], await at(sub))).toEqual({ kind: "none" });
      // A project at the submodule's checkout never binds the superproject's worktrees either.
      expect(await bindFolder([project("p-sub", sub)], await at(join(work, "repo-wt")))).toEqual({
        kind: "none",
      });
      // A worktree whose git folder does not name it back is not listed.
      const stray = join(work, "stray-wt");
      mkdirSync(stray, { recursive: true });
      const wtGit = join(work, "repo", ".git", "worktrees", "repo-wt");
      writeFileSync(join(stray, ".git"), `gitdir: ${wtGit}\n`);
      expect(await worktreeAt(stray)).toMatchObject({ listed: false });
      expect(await bindFolder([main], await at(stray))).toEqual({ kind: "none" });
    },
  );

  test.skipIf(!HAS_GIT)(
    "through a fake T3: a worktree opens with existing_worktree, which T3 checks with git; an archived project is gone",
    async () => {
      const fake = await FakeT3.start(join(base, "t3home"));
      try {
        const files = new MemoryT3Files();
        const route = new T3Route({ home: fake.home, files, requestMs: 15_000 });
        const attempt = await route.beginPairing();
        expect(await fake.approveInBrowser(attempt.url)).toBe(200);
        await route.finishPairing(attempt);
        const main = fake.addProject(join(work, "repo"), "repo");
        const roots = [{ id: "work", path: work }];
        const resolution = await resolvePlace({ root: "work", path: "repo-wt" }, roots);
        if (resolution.status !== "ok") throw new Error("fixture");
        const folder = { path: resolution.folder, identity: resolution.identity };
        const prepared = await route.prepare({ folder, name: "repo-wt" });
        expect(prepared).toEqual({
          kind: "bound",
          projectId: main,
          strategy: { type: "existing_worktree", worktreePath: resolution.folder },
        });
        if (prepared.kind !== "bound") throw new Error("fixture");
        const durable = new MemoryDurable();
        const machine = new LaunchMachine({
          store: new MemoryExecutionStore(durable),
          machine: MACHINE,
          steps: { dispatch: (intent) => route.dispatch(intent) },
          recovery: {
            observe: () => Promise.resolve({ kind: "pending" }),
            grant: () => route.grant(),
            replay: (intent) => route.replay(intent),
          },
        });
        const intent = await machine.open(
          {
            task: randomId("t"),
            instance: "t3-codex",
            route: "t3-mcp",
            place: randomId("pl"),
            taskVersion: 1,
            briefHash: "d".repeat(64),
          },
          "t3-binding-click-001",
        );
        const planned = await route.plan(intent.id, {
          ...prepared,
          title: "M-14 Fixture task",
          instance: { openPermission: "auto-edit" },
          folder: resolution.identity,
        });
        if (planned.kind !== "ready") throw new Error("fixture");
        const dispatched = await machine.dispatch(intent.id, { grant: planned.grant });
        expect(dispatched?.state).toBe("dispatched");
        const thread = fake.threads.get(dispatched?.evidence.thread ?? "");
        expect(thread).toMatchObject({
          projectId: main,
          worktreePath: resolution.folder,
          runtimeMode: "auto-accept-edits",
          modelSelection: null,
        });
        expect((await route.confirm(dispatched as never)).kind).toBe("confirmed");

        // Archived: the project is no binding any more, and the worktree becomes a project of its own.
        const archived = fake.projects.get(main);
        if (archived !== undefined) archived.archivedAt = "2026-11-14T09:00:00Z";
        const own = await route.prepare({ folder, name: "repo-wt" });
        expect(own).toMatchObject({ kind: "bound", strategy: { type: "root" } });
        expect(own).not.toMatchObject({ projectId: main });
      } finally {
        await fake.stop();
      }
    },
    SLOW,
  );
});
