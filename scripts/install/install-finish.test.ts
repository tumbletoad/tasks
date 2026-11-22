// The install scripts (A7 3.8 M1.14, A2 3.12.4): install.sh on Linux and install.ps1 on Windows,
// run as a person runs them, on the run's release (scripts/install/test/install-file.ts). Every
// install goes into a root below a temporary folder of this file's own; nothing touches the real
// install root, PATH, a profile, a start-up entry or the registry. The canary stand-ins prove that
// a refused download ran nothing: each writes a file when it runs, in any way, and the canary
// folder must stay empty. One file per part (install-*.test.ts), so the parts run side by side.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { PRODUCT_ID } from "../../packages/brand/src/index.ts";
import { checkVersionFolder } from "../../packages/service/src/version/folder.ts";
import { fork, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";
import {
  fired,
  holdInstallLock,
  linkTarget,
  listing,
  releaseOf,
  runProgram,
  snapshot,
  stableCommand,
  throwawayKey,
  variantFolder,
  windows,
  type Ran,
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

/** Holds update.lock as a running update does (packages/service/test/lock-racer.ts). */
const RACER = fileURLToPath(new URL("../../packages/service/test/lock-racer.ts", import.meta.url));

useInstallFolder("finish");

describe("[A2.3.12.4.install.replace] installing again, a newer version, and a failure, leave the previous install working", () => {
  let root: string;
  beforeAll(() => {
    root = join(homes, "replace");
    expectInstalled(root, install({ root }));
  }, SLOW);

  test.runIf(!windows)(
    "a root this run made that another install used before this run's lock is not removed when this run fails",
    () => {
      // A flock that first writes into the root through the descriptor it is given, as another
      // install that took the root between this run's mkdir and its lock would have, then locks.
      const realFlock = spawnSync("sh", ["-c", "command -v flock"], { encoding: "utf8" });
      const tools = join(work, "late-lock-tools");
      mkdirSync(tools);
      writeFileSync(
        join(tools, "flock"),
        `#!/bin/sh\nprintf 'another install\\n' > "$(readlink /proc/$$/fd/9)/theirs"\nexec ${realFlock.stdout.trim()} "$@"\n`,
        { mode: 0o755 },
      );
      const root = join(homes, "taken-before-lock");
      const ran = install({
        root,
        source: join(work, "no-such-release"),
        env: { PATH: `${tools}:${process.env["PATH"] ?? ""}` },
      });
      expect(ran.status, output(ran)).not.toBe(0);
      expect(ran.stderr).toMatch(/Cannot verify this download/);
      expect(readFileSync(join(root, "theirs"), "utf8")).toBe("another install\n");
    },
  );

  test(
    "while another install into the root runs, the installer stops and changes nothing",
    async () => {
      const before = snapshot(root);
      const held = await holdInstallLock(root);
      let ran: Ran;
      try {
        ran = install({ root });
      } finally {
        await held.release();
      }
      expect(fired(canary)).toEqual([]);
      expect(ran.status, output(ran)).not.toBe(0);
      expect(ran.stderr).toMatch(/Another install into .* is running/);
      expect(snapshot(root)).toEqual(before);
      expect(runProgram(stableCommand(root), ["version"]).status).toBe(0);
    },
    SLOW,
  );

  test(
    "while an update holds update.lock, the finish stops and the version folder this run put in place stays, for the update that may use it",
    async () => {
      // An update of the same version may take the folder this run renamed into place (A2 3.12.4)
      // while it holds update.lock, so the script never removes it from an existing install.
      const copy = join(homes, "update-running");
      cpSync(root, copy, { recursive: true, verbatimSymlinks: true });
      const currentOf = () =>
        windows ? readFileSync(join(copy, "current"), "utf8") : linkTarget(join(copy, "current"));
      const was = currentOf();
      const next = releaseOf(
        variantFolder(base, join(work, "racing", "0.1.0-dev.6"), { version: "0.1.0-dev.6" }),
        join(work, "racing-dist"),
        release.key ?? throwawayKey(),
        work,
      );
      const racer = fork(RACER, [], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
      let ran: Ran;
      try {
        const won = await new Promise<{ won: boolean }>((resolve) => {
          racer.once("message", (message: { won: boolean }) => {
            resolve(message);
          });
          racer.send({ go: Date.now(), path: join(copy, "state", "update.lock") });
        });
        expect(won.won).toBe(true);
        ran = install({ root: copy }, next);
      } finally {
        racer.send({ exit: true });
        await new Promise((resolve) => racer.once("exit", resolve));
      }
      expect(ran.status, output(ran)).not.toBe(0);
      expect(ran.stderr).toMatch(/Another install or update of this install is running/);
      expect(currentOf()).toBe(was);
      expect(checkVersionFolder(join(copy, "versions", "0.1.0-dev.6"))).toEqual([]);
      expect(listing(join(copy, "versions")).filter((p) => p.startsWith("."))).toEqual([]);
      rmSync(copy, { recursive: true, force: true });
    },
    SLOW,
  );

  test(
    "a finish that fails after its switch puts current back and keeps the new folder; one that dies after the switch keeps the folder current names",
    () => {
      const own = join(homes, "stopped");
      expectInstalled(own, install({ root: own }));
      // The receipt cannot be written (a folder took its name): the finish fails after current
      // and the stable command changed, so it puts them back. The script keeps the verified
      // folder, which is not current: in an existing install an update may use it.
      const late = releaseOf(
        variantFolder(base, join(work, "late", "0.1.0-dev.4"), { version: "0.1.0-dev.4" }),
        join(work, "late-dist"),
        release.key ?? throwawayKey(),
        work,
      );
      const receipt = join(own, "state", "install.json");
      const kept = readFileSync(receipt);
      rmSync(receipt);
      mkdirSync(join(receipt, "taken"), { recursive: true });
      const failed = install({ root: own }, late);
      expect(failed.status, output(failed)).not.toBe(0);
      expect(failed.stderr, output(failed)).toMatch(
        /current and the stable command were put back as they were/,
      );
      if (windows) expect(readFileSync(join(own, "current"), "utf8")).toBe(release.version);
      else expect(linkTarget(join(own, "current"))).toBe(`versions/${release.version}`);
      expect(checkVersionFolder(join(own, "versions", "0.1.0-dev.4"))).toEqual([]);
      expect(runProgram(stableCommand(own), ["version"]).stdout).toContain(release.version);
      rmSync(receipt, { recursive: true });
      writeFileSync(receipt, kept);

      // A version whose finish switches current and dies, as a crash after the switch does: the
      // script keeps the folder that current names, and home.marker, instead of removing them.
      const dying = join(work, "dying", "0.1.0-dev.5");
      variantFolder(base, join(work, "dying-src"), { version: "0.1.0-dev.5" });
      writeFileSync(join(work, "dying-src", "lib", `${PRODUCT_ID}.mjs`), SWITCH_THEN_DIE);
      const died = releaseOf(
        variantFolder(join(work, "dying-src"), dying, {}),
        join(work, "dying-dist"),
        release.key ?? throwawayKey(),
        work,
      );
      for (const into of [own, join(homes, "dying-fresh")]) {
        // An earlier install's root, and one this run makes: both stay.
        const crashed = install({ root: into }, died);
        expect(crashed.status, output(crashed)).not.toBe(0);
        expect(crashed.stderr).toMatch(/current names 0\.1\.0-dev\.5 now, so it stays installed/);
        if (windows) expect(readFileSync(join(into, "current"), "utf8")).toBe("0.1.0-dev.5");
        else expect(linkTarget(join(into, "current"))).toBe("versions/0.1.0-dev.5");
        expect(existsSync(join(into, "versions", "0.1.0-dev.5", "manifest.json"))).toBe(true);
        expect(existsSync(join(into, "home.marker"))).toBe(true);
      }

      // A root this run made, where current names another version by the time the script cleans
      // up: once the finish let go of update.lock, an update may have taken the install over. As a
      // stand-in, the finish switches current to another version and dies. The root stays whole.
      const takenSrc = join(work, "taken-src");
      variantFolder(base, takenSrc, { version: "0.1.0-dev.7" });
      writeFileSync(join(takenSrc, "lib", `${PRODUCT_ID}.mjs`), switchThenDie("0.1.0-dev.8"));
      const taken = releaseOf(
        variantFolder(takenSrc, join(work, "taken", "0.1.0-dev.7"), {}),
        join(work, "taken-dist"),
        release.key ?? throwawayKey(),
        work,
      );
      const takenRoot = join(homes, "taken-over");
      const takenRun = install({ root: takenRoot }, taken);
      expect(takenRun.status, output(takenRun)).not.toBe(0);
      if (windows) expect(readFileSync(join(takenRoot, "current"), "utf8")).toBe("0.1.0-dev.8");
      else expect(linkTarget(join(takenRoot, "current"))).toBe("versions/0.1.0-dev.8");
      expect(checkVersionFolder(join(takenRoot, "versions", "0.1.0-dev.7"))).toEqual([]);
      expect(existsSync(join(takenRoot, "home.marker"))).toBe(true);
      expect(listing(join(takenRoot, "versions")).filter((p) => p.startsWith("."))).toEqual([]);
    },
    SLOW,
  );
});

/** A version entry that, on `install --finish`, switches current to `version` and dies. */
const switchThenDie = (version: string): string =>
  SWITCH_THEN_DIE.replaceAll("basename(folder)", JSON.stringify(version));

/** A version entry that switches current to its own version on `install --finish`, then dies. */
const SWITCH_THEN_DIE = `import { renameSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const folder = dirname(dirname(fileURLToPath(import.meta.url)));
const root = dirname(dirname(folder));
if (process.argv.includes("--finish")) {
  if (process.platform === "win32") {
    writeFileSync(join(root, "current"), basename(folder));
  } else {
    const link = join(root, ".current.dying");
    symlinkSync(\`versions/\${basename(folder)}\`, link);
    renameSync(link, join(root, "current"));
  }
  process.exit(9);
}
`;
