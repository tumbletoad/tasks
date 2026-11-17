// The repository's name shown beside a project, read from the folder's own Git configuration: one
// remote, several, none, an address with a token in it, a folder that is not a checkout, and a
// configuration that does not answer in time. Temporary folders of this test, fixture addresses.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { repoName, repoNameOf } from "./repo.ts";

let base = "";
beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "tasks-repo-name-")));
});
afterAll(() => {
  if (base !== "") rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

/** A checkout of this test whose `.git/config` holds `config`. */
function checkout(name: string, config?: string): string {
  const folder = join(base, name);
  mkdirSync(join(folder, ".git"), { recursive: true });
  if (config !== undefined) writeFileSync(join(folder, ".git", "config"), config);
  return folder;
}

describe("[A1.3.15.folders.repo] the repository a project's folder holds, by name", () => {
  test("one remote, several remotes, none, and a folder that is not a checkout", async () => {
    const one = checkout("one", '[remote "origin"]\n\turl = git@git.example.com:mira/portal.git\n');
    expect(await repoName(one, process.platform)).toBe("portal");
    const several = checkout(
      "several",
      '[remote "upstream"]\n\turl = https://git.example.com/team/portal-upstream\n' +
        '[remote "origin"]\n\turl = ssh://git@git.example.com:2222/mira/portal-web.git/\n',
    );
    expect(await repoName(several, process.platform)).toBe("portal-web");
    const firstOnly = checkout(
      "first",
      '[remote "fork"]\n\turl = https://git.example.com/mira/first.git\n' +
        '[remote "mirror"]\n\turl = https://git.example.com/mira/second.git\n',
    );
    expect(await repoName(firstOnly, process.platform)).toBe("first");
    const none = checkout("none", "[core]\n\tbare = false\n");
    expect(await repoName(none, process.platform)).toBeUndefined();
    const plain = join(base, "plain");
    mkdirSync(plain);
    expect(await repoName(plain, process.platform)).toBeUndefined();
    // A remote that is a folder on this machine leaves it nameless: it names no repository elsewhere.
    const local = checkout("local", '[remote "origin"]\n\turl = /srv/git/portal.git\n');
    expect(await repoName(local, process.platform)).toBeUndefined();
  });

  test("an address with a token in it gives the name only", async () => {
    const token = checkout(
      "token",
      '[remote "origin"]\n\turl = https://mira:fixture-secret@git.example.com/mira/billing.git\n',
    );
    const name = await repoName(token, process.platform);
    expect(name).toBe("billing");
    expect(repoNameOf("https://git.example.com/mira/billing.git")).toBe("billing");
    expect(repoNameOf("git.example.com:billing")).toBe("billing");
    expect(repoNameOf("https://git.example.com/")).toBeUndefined();
  });

  test("a configuration that does not answer in time leaves the name out", async () => {
    const name = await repoName(join(base, "share"), process.platform, {
      ms: 20,
      read: () => new Promise(() => undefined),
    });
    expect(name).toBeUndefined();
  });
});
