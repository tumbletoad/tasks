// The install scripts: install.sh on Linux and install.ps1 on Windows,
// run as a person runs them, on the run's release (scripts/install/test/install-file.ts). Every
// install goes into a root below a temporary folder of this file's own; nothing touches the real
// install root, PATH, a profile, a start-up entry or the registry. The canary stand-ins prove that
// a refused download ran nothing: each writes a file when it runs, in any way, and the canary
// folder must stay empty. One file per part (install-*.test.ts), so the parts run side by side.
import { chmodSync, cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { PRODUCT_ID } from "../../packages/brand/src/index.ts";
import { checkVersionFolder } from "../../packages/service/src/version/folder.ts";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import {
  fired,
  grantUsers,
  lookAlikeFolder,
  releaseOf,
  runProgram,
  snapshot,
  stableCommand,
  throwawayKey,
  variantFolder,
  windows,
} from "./test/kit.ts";
import {
  base,
  canary,
  expectInstalled,
  homes,
  install,
  output,
  release,
  SLOW,
  useInstallFolder,
  work,
} from "./test/install-file.ts";

useInstallFolder("replace");

describe("[A2.3.12.4.install.replace] installing again, a newer version, and a failure, leave the previous install working", () => {
  let root: string;
  beforeAll(() => {
    root = join(homes, "replace");
    expectInstalled(root, install({ root }));
  }, SLOW);

  test(
    "the same release again keeps its folder; a version folder that is not exactly it runs nothing and stays as it is",
    () => {
      const folder = join(root, "versions", release.version);
      const kept = snapshot(folder);
      expectInstalled(root, install({ root }));
      expect(snapshot(folder)).toEqual(kept);
      // A changed file, every runnable file a stand-in with a matching manifest,
      // and the files of another build of the same version. Each in a copy of the install.
      const cases: [string, (dir: string) => void, RegExp][] = [
        [
          "changed",
          (dir) => {
            writeFileSync(join(dir, "lib", `${PRODUCT_ID}.mjs`), "// changed\n", { flag: "a" });
          },
          /its files do not match the signed manifest/,
        ],
        [
          "consistent",
          (dir) => {
            const look = lookAlikeFolder(dir, join(work, "replace-look"), canary, true);
            cpSync(look, dir, { recursive: true, force: true });
          },
          /its manifest\.json is not the signed one/,
        ],
        [
          "rebuilt",
          (dir) => {
            const manifest = join(dir, "manifest.json");
            writeFileSync(
              manifest,
              readFileSync(manifest, "utf8").replace(/"build": "[^"]*"/, '"build": "another"'),
            );
          },
          /its manifest\.json is not the signed one/,
        ],
        [
          // Every byte still the signed release's, but another account may change a module after
          // the check: the folder is not used.
          "writable",
          (dir) => {
            const entry = join(dir, "lib", `${PRODUCT_ID}.mjs`);
            if (windows) grantUsers(entry, "M");
            else chmodSync(entry, 0o666);
          },
          /another (user|account) can change/,
        ],
      ];
      for (const [name, change, reason] of cases) {
        const copy = join(homes, `replace-${name}`);
        cpSync(root, copy, { recursive: true, verbatimSymlinks: true });
        const dir = join(copy, "versions", release.version);
        change(dir);
        const before = snapshot(copy);
        const ran = install({ root: copy });
        try {
          expect(fired(canary)).toEqual([]);
          expect(ran.status).not.toBe(0);
          expect(ran.stderr).toMatch(/already exists but is not this signed release/);
          expect(ran.stderr).toMatch(reason);
          expect(snapshot(copy)).toEqual(before);
        } catch (error) {
          throw new Error(`${name}: ${output(ran)}`, { cause: error });
        }
      }
    },
    SLOW,
  );

  test(
    "a newer version becomes current and keeps the older one; one that fails its self-test changes nothing",
    () => {
      // Another version of the same files, and one whose manifest pins a Node it does not ship:
      // both signed, both whole, so only the self-test can stop the second.
      const next = releaseOf(
        variantFolder(base, join(work, "next", "0.1.0-dev.2"), { version: "0.1.0-dev.2" }),
        join(work, "next-dist"),
        release.key ?? throwawayKey(),
        work,
      );
      const bad = releaseOf(
        variantFolder(base, join(work, "bad", "0.1.0-dev.3"), {
          version: "0.1.0-dev.3",
          node: "26.0.0",
        }),
        join(work, "bad-dist"),
        release.key ?? throwawayKey(),
        work,
      );
      const upgraded = install({ root }, next);
      expectInstalled(root, upgraded, "0.1.0-dev.2");
      expect(existsSync(join(root, "versions", release.version, "manifest.json"))).toBe(true);
      const record = JSON.parse(readFileSync(join(root, "state", "install.json"), "utf8")) as {
        versions: string[];
      };
      expect(record.versions).toEqual([release.version, "0.1.0-dev.2"]);

      const before = snapshot(root);
      const failed = install({ root }, bad);
      expect(failed.status, output(failed)).not.toBe(0);
      expect(failed.stdout).toMatch(/^fail {2}runtime: /m);
      expect(failed.stderr).toMatch(/failed its self-test, so current was not changed/);
      // current and install.json are as they were, and the installed command still runs. The
      // failed version's verified folder stays, not current: in an existing install an update may
      // use it meanwhile, so the script never removes it. The new version's own
      // start may leave its compile cache.
      const after = snapshot(root);
      const failedFolder = "versions/0.1.0-dev.3/";
      for (const path of Object.keys({ ...before, ...after })) {
        if (path.startsWith("cache/") || path.startsWith(failedFolder)) continue;
        expect(after[path], path).toBe(before[path]);
      }
      expect(checkVersionFolder(join(root, "versions", "0.1.0-dev.3"))).toEqual([]);
      rmSync(join(root, "versions", "0.1.0-dev.3"), { recursive: true });
      expect(runProgram(stableCommand(root), ["version"]).status).toBe(0);
    },
    SLOW,
  );
});
