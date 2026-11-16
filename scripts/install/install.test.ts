// The install scripts (A7 3.8 M1.14, A2 3.12.4): install.sh on Linux and install.ps1 on Windows,
// run as a person runs them, on a release built offline (the real bundles and launchers, the Node
// that runs the tests as the runtime) and signed with a throwaway key made here. Every install
// goes into a root below a temporary folder of this file's own; nothing touches the real install
// root, PATH, a profile, a start-up entry or the registry. The canary stand-ins prove that a
// refused download ran nothing: each writes a file when it runs, in any way, and the canary
// folder must stay empty.
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { fork, spawn, spawnSync } from "node:child_process";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PRODUCT_ID } from "../../packages/brand/src/index.ts";
import { canonicalStatePath, installId } from "../../packages/service/src/hub/paths.ts";
import { checkVersionFolder } from "../../packages/service/src/version/folder.ts";
import { ENV_PREFIX, PRODUCT_NAME } from "../../packages/brand/src/index.ts";
import { TEMPLATES } from "./render.ts";
import {
  craftTarGz,
  craftZip,
  downloadCases,
  entriesOf,
  fired,
  grantUsers,
  holdInstallLock,
  HOME_VAR,
  installerIn,
  installsFolder,
  KIND,
  letUsersChange,
  linkTarget,
  listing,
  lookAlikeFolder,
  offlineVersionFolder,
  packFolder,
  powershell51,
  prepareCanary,
  present,
  proveStandInsFire,
  releaseOf,
  runInstaller,
  runProgram,
  signedSource,
  snapshot,
  stableCommand,
  throwawayKey,
  variantFolder,
  VERIFIERS,
  windows,
  type Canary,
  type Ran,
  type Release,
} from "./test/kit.ts";

const SLOW = 900_000;
/** Holds update.lock as a running update does (packages/service/test/lock-racer.ts). */
const RACER = fileURLToPath(new URL("../../packages/service/test/lock-racer.ts", import.meta.url));

let folders: ReturnType<typeof installsFolder>;
let work: string;
let homes: string;
let base: string;
let release: Release;
let canary: Canary;

beforeAll(async () => {
  folders = installsFolder("install");
  work = folders.root;
  homes = join(work, "h");
  // User-only, whatever the umask: the installer refuses a root below a folder others can change.
  mkdirSync(homes, { mode: 0o700 });
  base = await offlineVersionFolder(join(work, "build"), {
    version: "0.1.0-dev.1",
    build: "install0test",
  });
  release = releaseOf(base, join(work, "dist"), throwawayKey(), work);
  canary = prepareCanary(join(work, "canary-kit"));
}, SLOW);

afterAll(() => {
  folders.remove();
});

const install = (
  options: Omit<Parameters<typeof runInstaller>[1], "within">,
  from = release,
): Ran => runInstaller(from, { ...options, within: work });

const output = (ran: Ran): string => `exit ${String(ran.status)}\n${ran.stdout}\n${ran.stderr}`;

/** A path as install.sh writes it in a command to paste: single-quoted unless it is plain. */
const pasted = (path: string): string =>
  /^[A-Za-z0-9_./+-]+$/u.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;

/** A good install: current, the stable command, home.marker, install.json, no leftovers. */
function expectInstalled(root: string, ran: Ran, version = release.version): void {
  expect(ran.status, output(ran)).toBe(0);
  expect(ran.stdout).toContain(`Installed ${PRODUCT_NAME} ${version}`);
  for (const row of [
    "integrity",
    "runtime",
    "candidate-space",
    "candidate-endpoint",
    "candidate-bridge",
  ]) {
    expect(ran.stdout, row).toMatch(new RegExp(`^ok {4}${row}: `, "m"));
  }
  const current = join(root, "current");
  if (windows) expect(readFileSync(current, "utf8")).toBe(version);
  else expect(linkTarget(current)).toBe(`versions/${version}`);
  expect(existsSync(stableCommand(root))).toBe(true);
  if (windows) expect(existsSync(join(root, "bin", `${PRODUCT_ID}w.exe`))).toBe(true);
  else expect(linkTarget(stableCommand(root))).toBe(`../current/bin/${PRODUCT_ID}`);
  expect(existsSync(join(root, "home.marker"))).toBe(true);
  const leftovers = listing(join(root, "versions")).filter((p) => p.startsWith("."));
  expect(leftovers, "download or staging folders were left").toEqual([]);
  expect(present(join(root, ".install.lock")), "the install lock was left").toBe(false);
  const record = JSON.parse(readFileSync(join(root, "state", "install.json"), "utf8")) as {
    install_id: string;
    root: string;
    versions: string[];
    method: string;
  };
  const state = realpathSync.native(join(root, "state"));
  expect(record.install_id).toBe(installId(canonicalStatePath(state, process.platform)));
  expect(record.versions).toContain(version);
  expect(record.method).toBe("script");
}

/** A refused download: the reason, nothing ran, and the root's parent exactly as it was. */
function expectRefused(ran: Ran, reason: RegExp, parentBefore: string[], parent: string): void {
  expect(fired(canary), `a stand-in ran: ${output(ran)}`).toEqual([]);
  expect(ran.status, output(ran)).not.toBe(0);
  expect(ran.stderr).toMatch(reason);
  expect(listing(parent)).toEqual(parentBefore);
}

describe("[A2.3.12.4.install.script] install.sh and install.ps1 make a separate install in a temporary TASKS_HOME", () => {
  test(
    "through each verifier path: the signature, the hash, the self-test through the version's own launcher, then current",
    () => {
      const ids = new Set<string>();
      for (const verifier of VERIFIERS) {
        const root = join(homes, `good-${verifier}`);
        const ran = install({ env: { [HOME_VAR]: root }, verifier });
        expectInstalled(root, ran);
        // The self-test came before the switch, and the offer of the service install after it.
        expect(ran.stdout.indexOf("ok    candidate-bridge")).toBeLessThan(
          ran.stdout.indexOf("Installed"),
        );
        expect(ran.stdout).toContain(`${stableCommand(root)} service install`);
        const version = runProgram(stableCommand(root), ["version"]);
        expect(version.stdout.trim()).toBe(`${PRODUCT_NAME} ${release.version} (${release.build})`);
        const record = JSON.parse(readFileSync(join(root, "state", "install.json"), "utf8")) as {
          install_id: string;
          created: string[];
        };
        ids.add(record.install_id);
        expect(record.created).toEqual(
          [
            ".",
            "bin",
            ...(windows
              ? [`bin/${PRODUCT_ID}.exe`, `bin/${PRODUCT_ID}w.exe`]
              : [`bin/${PRODUCT_ID}`]),
            "current",
            "home.marker",
            "state",
            "versions",
            `versions/${release.version}`,
          ].sort(),
        );
      }
      // Each install has its own install ID, from its own state folder (A2 3.2.1).
      expect(ids.size).toBe(VERIFIERS.length);
    },
    SLOW,
  );

  test(
    "--root names the root as TASKS_HOME does, the install's doctor passes, and nothing outside the root changes",
    () => {
      const root = join(homes, "by-parameter");
      const before = listing(homes);
      const ran = install({ root });
      expectInstalled(root, ran);
      const after = listing(homes).filter((path) => !before.includes(path));
      expect(after.every((path) => path.startsWith("by-parameter/"))).toBe(true);
      const doctor = runProgram(stableCommand(root), ["doctor", "--self-test", "--json"]);
      const rows = (JSON.parse(doctor.stdout) as { checks: { id: string; status: string }[] })
        .checks;
      for (const id of [
        "integrity",
        "runtime",
        "install",
        "candidate-space",
        "candidate-endpoint",
        "candidate-bridge",
      ]) {
        expect(rows.find((row) => row.id === id)?.status, `${id}: ${doctor.stdout}`).toBe("ok");
      }
    },
    SLOW,
  );

  test.runIf(windows)(
    "from PowerShell 7, and from Windows PowerShell 5.1 with PowerShell 7's module path through the node verifier (A2 3.12.4)",
    () => {
      const seven = join(homes, "pwsh");
      expectInstalled(seven, install({ root: seven, powershell: "7" }));
      const inherited = join(homes, "module-path");
      expectInstalled(
        inherited,
        install({ root: inherited, verifier: "node", modulePath: "inherit" }),
      );
    },
    SLOW,
  );
});

describe("[A2.3.12.4.install.tamper] a tampered download is refused before any candidate file runs", () => {
  test(
    "a tampered archive or SHA256SUMS, through each verifier path",
    () => {
      for (const verifier of VERIFIERS) {
        const cases = downloadCases(release, base, join(work, "tamper"), canary, verifier);
        for (const c of cases) {
          const root = join(homes, `tamper-${verifier}-${c.name}`);
          const before = listing(homes);
          const ran = install({
            root,
            source: c.source,
            installer: installerIn(release, c.source),
            verifier,
          });
          try {
            expect(ran.stderr).toMatch(/Cannot verify this download/);
            expectRefused(ran, c.reason, before, homes);
          } catch (error) {
            throw new Error(`${verifier}, ${c.name}: ${String(error)}`, { cause: error });
          }
        }
      }
    },
    SLOW,
  );

  test(
    "a signed archive whose file changed after hashing, or that holds a name leaving its folder or a link, is refused before anything from it runs",
    () => {
      // Signed with the release's own key, so the signature and the hash pass: what stops each is
      // the check of the unpacked files against manifest.json, or of the archive's entries.
      const changed = lookAlikeFolder(base, join(work, "changed", release.version), canary, false);
      proveStandInsFire(changed, canary);
      const escape = windows
        ? craftZip(
            entriesOf(base, release.platform, [
              { path: "xx/xx/xx/escape.txt", data: Buffer.from("escaped\n"), mode: 0o644 },
            ]),
            { from: "xx/xx/xx/escape.txt", to: "../../../escape.txt" },
          )
        : craftTarGz([
            ...entriesOf(base, release.platform).map((e) => ({ path: e.path, data: e.data })),
            { path: "../../../escape.txt", data: Buffer.from("escaped\n") },
          ]);
      const link = windows
        ? craftZip(
            entriesOf(base, release.platform, [
              { path: "lib/linked.mjs", data: Buffer.from("C:\\Windows\\win.ini"), mode: 0o644 },
            ]),
            undefined,
            "lib/linked.mjs",
          )
        : craftTarGz([
            ...entriesOf(base, release.platform).map((e) => ({ path: e.path, data: e.data })),
            { path: "lib/linked.mjs", link: "/etc/hostname" },
          ]);
      const absolute = windows
        ? craftZip(
            entriesOf(base, release.platform, [
              { path: "xx/escape.txt", data: Buffer.from("escaped\n"), mode: 0o644 },
            ]),
            { from: "xx/escape.txt", to: "C:/escape.txt" },
          )
        : craftTarGz([
            ...entriesOf(base, release.platform).map((e) => ({ path: e.path, data: e.data })),
            { path: "/tmp/escape.txt", data: Buffer.from("escaped\n") },
          ]);
      const cases: [string, Buffer, RegExp][] = [
        ["changed", packFolder(changed, release.platform), /do not match manifest\.json/],
        ["escape", escape, /a name that could leave its folder/],
        ["absolute", absolute, /a name that could leave its folder/],
        ["link", link, /not a plain file or folder/],
      ];
      for (const [name, archive, reason] of cases) {
        const source = signedSource(release, join(work, "signed", name), archive, work);
        const root = join(homes, `signed-${name}`);
        const before = listing(homes);
        const ran = install({ root, source, installer: installerIn(release, source) });
        try {
          expectRefused(ran, reason, before, homes);
          expect(present(join(work, "escape.txt"))).toBe(false);
        } catch (error) {
          throw new Error(`${name}: ${String(error)}`, { cause: error });
        }
      }
    },
    SLOW,
  );

  test.runIf(windows)(
    "a folder of the run whose file Windows still holds for a moment is removed once the file is let go",
    async () => {
      // As an antivirus scan holds the verifier's node.exe it has just seen run: a handle without
      // delete sharing, until `release` appears.
      const held = join(work, "held");
      const download = join(held, ".download-held");
      const file = join(download, "verifier", "node.exe");
      const release = join(held, "release");
      mkdirSync(join(download, "verifier"), { recursive: true });
      writeFileSync(file, "");
      const script = readFileSync(join(import.meta.dirname, "install.ps1"), "utf8");
      const removeTree = /^function Remove-Tree\([\s\S]*?^\}\r?$/mu.exec(script)?.[0];
      expect(removeTree, "install.ps1 removes its folders through Remove-Tree").toBeDefined();
      writeFileSync(
        join(held, "hold.ps1"),
        `$f = [IO.File]::Open('${file}', 'Open', 'Read', 'Read')\n[Console]::Out.WriteLine('held')\n` +
          `while (-not [IO.File]::Exists('${release}')) { [Threading.Thread]::Sleep(20) }\n$f.Dispose()\n`,
      );
      writeFileSync(
        join(held, "remove.ps1"),
        `${removeTree ?? ""}\n[Console]::Out.WriteLine('removing')\nRemove-Tree '${download}'\n`,
      );
      const holder = powershellFile(join(held, "hold.ps1"));
      try {
        await holder.said("held");
        const remover = powershellFile(join(held, "remove.ps1"));
        await remover.said("removing");
        // Let Remove-Tree meet the held file before it is let go.
        await new Promise((resolve) => setTimeout(resolve, 300));
        writeFileSync(release, "");
        expect(await remover.exited, remover.output()).toBe(0);
        expect(existsSync(download)).toBe(false);
      } finally {
        writeFileSync(release, "");
        await holder.exited;
      }
    },
    SLOW,
  );
});

/** A Windows PowerShell 5.1 script as a child: what it said, and its exit code. */
function powershellFile(path: string): {
  said(line: string): Promise<void>;
  output(): string;
  exited: Promise<number | null>;
} {
  const child = spawn(powershell51(), ["-NoProfile", "-NonInteractive", "-File", path], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let out = "";
  const waiting: { line: string; resolve: () => void }[] = [];
  const onData = (chunk: string): void => {
    out += chunk;
    for (const wait of waiting.filter((w) => out.split(/\r?\n/u).includes(w.line))) {
      waiting.splice(waiting.indexOf(wait), 1);
      wait.resolve();
    }
  };
  child.stdout.setEncoding("utf8").on("data", onData);
  child.stderr.setEncoding("utf8").on("data", onData);
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", resolve);
  });
  return {
    said: (line) =>
      new Promise<void>((resolve, reject) => {
        if (out.split(/\r?\n/u).includes(line)) {
          resolve();
          return;
        }
        waiting.push({ line, resolve });
        void exited.then(() => {
          reject(new Error(`exited before it said ${line}: ${out}`));
        });
      }),
    output: () => out,
    exited,
  };
}

describe("[A2.3.12.4.install.root] the install root: named, absolute, at most 168 long, and changed by no one else", () => {
  test("without TASKS_HOME or a root, a relative root, or a missing parent, nothing is installed", () => {
    const before = listing(homes);
    const none = install({ env: { [HOME_VAR]: undefined } });
    expect(none.status).not.toBe(0);
    expect(none.stderr).toMatch(new RegExp(`Set (\\$env:)?${ENV_PREFIX}HOME or pass -?-[Rr]oot`));
    const relative = install({ root: "tasks-relative" });
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
          `Every user on this computer can change ${shared}, the install root, so nothing was installed. To fix it, run: chmod o-w ${pasted(shared)}`,
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
          /Every user on this computer can change .*open, a folder above the install root, so nothing was installed\. To fix it, run: chmod g?o-w /,
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
      // A2 3.12.4 step 7: a changed file, every runnable file a stand-in with a matching manifest,
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
      // use it meanwhile (A2 3.12.4), so the script never removes it. The new version's own
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
