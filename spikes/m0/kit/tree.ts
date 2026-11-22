// The scratch folder tree for the launch rows (L01-L12, A01-A05, E02): an exact repository root,
// a nested folder inside it, a git worktree, a sibling clone, and folders with Unicode and
// punctuation names. Everything is created inside a new folder under the base the caller passes.
// Git runs with an empty global config, so the fixture commits never read the user's settings.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ScratchTree {
  /** The new folder that holds everything below. */
  container: string;
  /** A git repository's root. */
  exactRoot: string;
  /** A folder two levels inside the repository. */
  nested: string;
  /** A linked worktree of the repository, on its own branch. */
  worktree: string;
  /** A clone of the repository beside it. */
  siblingClone: string;
  /** A git repository whose folder name has non-ASCII letters, a dash and a space. */
  unicode: string;
  /** A plain folder whose name holds the characters shells and launchers trip on. */
  punctuation: string;
}

export const UNICODE_NAME = "Mira Café – 東京 ünïcode";
// Legal on Windows and Linux: no < > : " / \ | ? * and no trailing dot or space.
export const PUNCTUATION_NAME = "Mira's notes & drafts (v2) [#1] 100% {x} !;=,+@~$";

const GITCONFIG = "[user]\n\tname = Mira Okafor\n\temail = mira@example.invalid\n";

export function buildTree(base: string): ScratchTree {
  mkdirSync(base, { recursive: true });
  const container = realpathSync.native(mkdtempSync(join(base, "mira-tree-")));
  const gitconfig = join(container, ".kit-gitconfig");
  writeFileSync(gitconfig, GITCONFIG);
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.toUpperCase().startsWith("GIT_")) env[name] = value;
  }
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  });
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", args, {
      cwd,
      env,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`git ${args[0] ?? ""} failed: ${result.stderr.trim()}`);
    }
  };
  const repo = (dir: string, files: Record<string, string>) => {
    for (const [name, text] of Object.entries(files)) {
      const file = join(dir, name);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, text);
    }
    git(dir, "init", "--quiet", "--initial-branch=main");
    git(dir, "add", "--all");
    git(dir, "commit", "--quiet", "--message", "Add the Mira fixture");
  };

  const exactRoot = join(container, "mira-portal");
  const nested = join(exactRoot, "packages", "web", "src");
  mkdirSync(nested, { recursive: true });
  repo(exactRoot, {
    "README.md": "# Mira portal\n\nFixture repository for the TTasks M0 lab.\n",
    [join("packages", "web", "src", "index.ts")]: 'export const fixture = "M-14";\n',
  });

  const worktree = join(container, "mira-portal-m-14");
  git(exactRoot, "worktree", "add", "--quiet", "-b", "m-14-time-zones", worktree);

  const siblingClone = join(container, "mira-portal-clone");
  git(container, "clone", "--quiet", exactRoot, siblingClone);

  const unicode = join(container, UNICODE_NAME);
  mkdirSync(unicode);
  repo(unicode, { "notes.md": "# Café notes\n\nFixture folder with a Unicode name.\n" });

  const punctuation = join(container, PUNCTUATION_NAME);
  mkdirSync(punctuation);
  writeFileSync(join(punctuation, "notes.md"), "Fixture folder with punctuation in its name.\n");

  const tree: ScratchTree = {
    container,
    exactRoot,
    nested,
    worktree,
    siblingClone,
    unicode,
    punctuation,
  };
  writeFileSync(join(container, "tree.json"), `${JSON.stringify(tree, null, 2)}\n`);
  return tree;
}
