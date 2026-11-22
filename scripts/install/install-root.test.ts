// The install scripts (A7 3.8 M1.14, A2 3.12.4): install.sh on Linux and install.ps1 on Windows,
// run as a person runs them, on the run's release (scripts/install/test/install-file.ts). Every
// install goes into a root below a temporary folder of this file's own; nothing touches the real
// install root, PATH, a profile, a start-up entry or the registry. The canary stand-ins prove that
// a refused download ran nothing: each writes a file when it runs, in any way, and the canary
// folder must stay empty. One file per part (install-*.test.ts), so the parts run side by side.
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, sep } from "node:path";
import { describe, expect, test } from "vitest";
import { ENV_PREFIX, PRODUCT_ID, PRODUCT_NAME } from "../../packages/brand/src/index.ts";
import { TEMPLATES } from "./render.ts";
import {
  fired,
  grantUsers,
  HOME_VAR,
  KIND,
  letUsersChange,
  listing,
  present,
  runProgram,
  snapshot,
  stableCommand,
  windows,
} from "./test/kit.ts";
import {
  canary,
  expectInstalled,
  homes,
  install,
  output,
  pasted,
  release,
  SLOW,
  useInstallFolder,
  work,
} from "./test/install-file.ts";

useInstallFolder("root");

describe("[A2.3.12.4.install.root] the install root: named, absolute, at most 168 long, and changed by no one else", () => {
  test("without TTASKS_HOME or a root, a relative root, or a missing parent, nothing is installed", () => {
    const before = listing(homes);
    const none = install({ env: { [HOME_VAR]: undefined } });
    expect(none.status).not.toBe(0);
    expect(none.stderr).toMatch(new RegExp(`Set (\\$env:)?${ENV_PREFIX}HOME or pass -?-[Rr]oot`));
    const relative = install({ root: "ttasks-relative" });
    expect(relative.status).not.toBe(0);
    expect(relative.stderr).toMatch(/full path|absolute path/);
    const dots = install({ root: `${homes}${sep}x${sep}..${sep}dots` });
    expect(dots.status).not.toBe(0);
    expect(dots.stderr).toMatch(/\. or \.\./);
    const orphan = install({ root: join(homes, "no-parent", "root") });
    expect(orphan.status).not.toBe(0);
    expect(orphan.stderr).toMatch(/parent folder .* does not exist/);
    expect(listing(homes)).toEqual(before);
  });

  test(
    "a root of 169 is refused before anything is written, and one of 168 is taken",
    () => {
      const at = (length: number) => {
        const prefix = join(homes, "L");
        const root = `${prefix}${"x".repeat(length - Buffer.byteLength(prefix))}`;
        expect(Buffer.byteLength(root)).toBe(length);
        return root;
      };
      const before = listing(homes);
      const long = install({ root: at(169) });
      expect(long.status).not.toBe(0);
      expect(long.stderr).toMatch(/169 (bytes|characters) long\. At most 168/);
      expect(listing(homes)).toEqual(before);
      // 168 passes the length check: here it stops later, at a folder of release files that does
      // not exist, and leaves nothing.
      const fits = install({ root: at(168), source: join(work, "no-such-folder") });
      expect(fits.stderr).toMatch(/Cannot verify this download \(the folder .* does not exist\)/);
      expect(listing(homes)).toEqual(before);
      if (windows) {
        // And on Windows a whole install at 168 runs through its launchers (A2 3.12.3).
        const root = at(168);
        expectInstalled(root, install({ root }));
        expect(runProgram(stableCommand(root), ["version"]).status).toBe(0);
      }
    },
    SLOW,
  );

  test(
    "a root, or on Linux a folder above it, that another user can change is refused before anything from the archive runs",
    () => {
      const shared = join(homes, "shared");
      mkdirSync(shared);
      if (windows) letUsersChange(shared);
      else chmodSync(shared, 0o707);
      const before = listing(homes);
      const ran = install({ root: shared });
      expect(ran.status).not.toBe(0);
      if (windows) expect(ran.stderr).toMatch(/Another account can change/);
      else {
        expect(ran.stderr).toContain(
          `Every user on this machine can change ${shared}, the install root, so nothing was installed. To fix it, run: chmod o-w ${pasted(shared)}`,
        );
      }
      expect(listing(homes)).toEqual(before);
      if (!windows) {
        const open = join(homes, "open");
        mkdirSync(open);
        chmodSync(open, 0o777);
        const inside = install({ root: join(open, "root") });
        expect(inside.status).not.toBe(0);
        expect(inside.stderr).toMatch(
          /Every user on this machine can change .*open, a folder above the install root, so nothing was installed\. To fix it, run: chmod g?o-w /,
        );
        expect(present(join(open, "root"))).toBe(false);
        chmodSync(open, 0o700);
      }
    },
    SLOW,
  );

  test.runIf(!windows)(
    "[A2.3.2.2.permissions.group-rule] a root below a folder its owner's group may write, as umask 002 makes it: installed under the person's own private group, else refused with the group and chmod g-w",
    () => {
      const parent = join(homes, "umask002");
      mkdirSync(parent, { mode: 0o700 });
      chmodSync(parent, 0o775);
      const root = join(parent, "root");
      const ran = install({ root });
      const id = (flag: string) =>
        spawnSync("id", [flag], { encoding: "utf8" }).stdout.replace(/\n$/u, "");
      if (id("-un") !== "" && id("-un") === id("-gn")) {
        expectInstalled(root, ran);
      } else {
        expect(ran.status).not.toBe(0);
        expect(ran.stderr).toContain(
          `The members of the group ${id("-gn")} can change ${parent}, a folder above the install root, not only you, so nothing was installed. To fix it, run: chmod g-w ${pasted(parent)}`,
        );
        expect(present(root)).toBe(false);
      }
      chmodSync(parent, 0o700);
    },
    SLOW,
  );

  test(
    "a state, config or cache that is a link, and on Windows a folder above the root that another account may rename, is refused before anything from the archive runs",
    () => {
      // A root whose state folder is a link to another install's: it would share that install's
      // ID and receipt.
      const elsewhere = join(homes, "elsewhere-state");
      mkdirSync(elsewhere, { mode: 0o700 });
      for (const name of ["state", "config", "cache"]) {
        const root = join(homes, `linked-${name}`);
        mkdirSync(root, { mode: 0o700 });
        symlinkSync(elsewhere, join(root, name), windows ? "junction" : "dir");
        const before = snapshot(homes);
        const ran = install({ root });
        expect(fired(canary)).toEqual([]);
        expect(ran.status, output(ran)).not.toBe(0);
        expect(ran.stderr).toMatch(new RegExp(`${name} is not a plain folder`));
        expect(snapshot(homes)).toEqual(before);
      }
      // Deeper down, where the new version writes while it installs: the candidate's checks in
      // state/tmp and its compile cache in cache/compile.
      for (const inner of [
        ["state", "tmp"],
        ["cache", "compile"],
      ] as const) {
        const root = join(homes, `nested-${inner[1]}`);
        mkdirSync(join(root, inner[0]), { recursive: true, mode: 0o700 });
        symlinkSync(elsewhere, join(root, ...inner), windows ? "junction" : "dir");
        const before = snapshot(homes);
        const ran = install({ root });
        expect(fired(canary)).toEqual([]);
        expect(ran.status, output(ran)).not.toBe(0);
        expect(ran.stderr).toMatch(/is not a plain folder|is a link|holds a link/);
        expect(snapshot(homes)).toEqual(before);
      }
      if (windows) {
        // A junction on the way to the root: the folders it leads to are what an account would
        // rename, and the walk above the root reads the path as written.
        const target = join(homes, "junction-target");
        mkdirSync(target);
        const via = join(homes, "via-junction");
        symlinkSync(target, via, "junction");
        const ran = install({ root: join(via, "root") });
        expect(ran.status, output(ran)).not.toBe(0);
        expect(ran.stderr).toMatch(
          /via-junction, a folder on the way to the install root, is a link or junction/,
        );
        expect(listing(target)).toEqual([]);
      }
      if (windows) {
        // The root's own ACL is clean, but the Users group may delete what is in its parent, so it
        // could rename the root away and put another folder in its place after the checks.
        const parent = join(homes, "renamable");
        mkdirSync(parent);
        grantUsers(parent, "(DC)");
        const root = join(parent, "root");
        const ran = install({ root });
        expect(ran.status, output(ran)).not.toBe(0);
        expect(ran.stderr).toMatch(/can rename or remove .*renamable\\root \(S-1-5-32-545\)/);
        expect(listing(parent)).toEqual([]);
      }
    },
    SLOW,
  );

  test.runIf(!windows)(
    "tar, gzip and OpenSSL options in the environment change nothing: the archive stays inside its folder",
    () => {
      const root = join(homes, "tool-options");
      const outside = join(work, "tar-outside");
      const ran = install({
        root,
        verifier: "openssl",
        env: {
          TAR_OPTIONS: `--absolute-names --transform=s|^|${outside}/|`,
          GZIP: "--verbose",
          OPENSSL_CONF: join(work, "no-such-openssl.cnf"),
        },
      });
      expectInstalled(root, ran);
      expect(present(outside)).toBe(false);
    },
    SLOW,
  );

  test("an install script whose keys were never written trusts nothing and installs nothing", () => {
    // The template with everything filled in but the keys.
    const text = readFileSync(TEMPLATES[KIND], "utf8")
      .replaceAll("@@PRODUCT@@", PRODUCT_ID)
      .replaceAll("@@PRODUCT_NAME@@", PRODUCT_NAME)
      .replaceAll("@@HOME_VAR@@", HOME_VAR)
      .replaceAll("@@VERSION@@", release.version)
      .replaceAll("@@BUILD_KIND@@", "release");
    expect(text).toContain("@@RELEASE_KEYS@@");
    const installer = join(work, `unkeyed.${KIND}`);
    writeFileSync(installer, text);
    const root = join(homes, "unkeyed");
    const before = listing(homes);
    const ran = install({ root, installer });
    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toMatch(/pins no valid release key/);
    expect(listing(homes)).toEqual(before);
  });
});
