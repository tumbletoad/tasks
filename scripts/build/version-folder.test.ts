// The version folder (A2 3.12.2) and the build's checks around it, offline. The last test assembles
// a real version folder for this machine's platform with the Node that runs the tests as its
// runtime (pnpm's download of the same official 26.13.1, checked against pnpm-lock.yaml), the real
// bundles, the real page (packages/web) and the real launchers, archives it, and runs the build's runtime gate inside it through
// its own launcher. Only `pnpm build` and CI download Node and build every platform. Temporary
// folders only.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { checkVersionFolder } from "../../packages/service/src/version/folder.ts";
import { buildWeb } from "../../packages/web/build.ts";
import { repoRoot } from "../run.ts";
import { readTarGz, readZip, writeTarGz, writeZip } from "./archive.ts";
import { compareFolders, identityProblems, resolveIdentity, staleArchives } from "./build.ts";
import { bundle } from "./bundle.ts";
import { runBuiltGate } from "./gate.ts";
import { LAUNCHD_WRAPPER, POSIX_LAUNCHER, windowsLaunchers } from "./launchers.ts";
import { loadPin } from "./node-runtime.ts";
import { hostPlatform, PLATFORMS } from "./platforms.ts";
import {
  assembleVersionFolder,
  executables,
  folderEntries,
  machinePathNeedles,
  plannedFiles,
  scanForMachinePaths,
} from "./version-folder.ts";

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "ttasks-version-folder-"));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const host = hostPlatform();

describe("[A2.3.12.2.build.version-folder] the version folder, its checks and its gate", () => {
  test("each platform's folder follows A2 3.12.2", () => {
    const common = [
      "LICENSE",
      "NOTICE",
      "THIRD_PARTY.txt",
      "lib/bridge.mjs",
      "lib/ttasks.mjs",
      "lib/mcp-offline.json",
      "lib/shim.mjs",
      "licenses/node.txt",
      "ui/icon-192.png",
      "ui/icon-512.png",
      "ui/icon.svg",
      "ui/index.html",
      "ui/manifest.webmanifest",
    ];
    const plan = (p: (typeof PLATFORMS)[number]) => plannedFiles(p);
    expect(plan("linux-x64")).toEqual([...common, "bin/ttasks", "runtime/node"].sort());
    expect(plan("linux-arm64")).toEqual(plan("linux-x64"));
    expect(plan("win-x64")).toEqual(
      [
        ...common,
        "bin/ttasks-run.exe",
        "bin/ttasks.exe",
        "bin/ttasksw.exe",
        "runtime/node.exe",
      ].sort(),
    );
    // The launchd wrapper (M1.12's text) is macOS's only.
    expect(plan("darwin-arm64")).toEqual(
      [...common, "bin/ttasks", "bin/ttasks-launchd", "runtime/node"].sort(),
    );
    expect([...executables("linux-x64")].sort()).toEqual([
      "bin/ttasks",
      "bin/ttasks-launchd",
      "runtime/node",
    ]);
    expect(executables("win-x64").size).toBe(0);
  });

  test("a macOS folder carries the launchd wrapper with the exec bit, a Linux one does not", () => {
    // Stand-in runtime and bundle files: this test checks placement and modes, not that they run.
    const bundleOut = join(work, "fake-bundle");
    const libFiles = ["lib/bridge.mjs", "lib/ttasks.mjs", "lib/mcp-offline.json", "lib/shim.mjs"];
    for (const file of libFiles) {
      mkdirSync(join(bundleOut, "lib"), { recursive: true });
      writeFileSync(join(bundleOut, ...file.split("/")), `// ${file}\n`);
    }
    const fake = join(work, "fake-node");
    writeFileSync(fake, "stand-in runtime\n");
    const uiOut = join(work, "fake-ui");
    mkdirSync(join(uiOut, "assets"), { recursive: true });
    writeFileSync(join(uiOut, "index.html"), "<!doctype html>\n");
    writeFileSync(join(uiOut, "assets", "index-abc123.js"), "// stand-in page\n");
    const uiRoot = ["icon-192.png", "icon-512.png", "icon.svg", "manifest.webmanifest"];
    for (const file of uiRoot) writeFileSync(join(uiOut, file), `stand-in ${file}\n`);
    const assemble = (platform: "darwin-arm64" | "linux-arm64") => {
      const folder = join(work, `fake-${platform}`, "0.1.0");
      assembleVersionFolder(folder, {
        platform,
        version: "0.1.0",
        build: "fixture",
        node: { version: "26.13.1", sqlite: "3.54.1", binary: fake, license: fake },
        launchers: { posix: POSIX_LAUNCHER, launchd: LAUNCHD_WRAPPER },
        bundle: {
          out: bundleOut,
          files: libFiles,
        },
        ui: { out: uiOut, files: ["assets/index-abc123.js", "index.html", ...uiRoot] },
        thirdParty: "none\n",
        repoRoot,
      });
      return folderEntries(folder, platform);
    };
    const mac = assemble("darwin-arm64");
    const wrapper = mac.find((e) => e.path === "bin/ttasks-launchd");
    expect(wrapper?.data.toString()).toBe(LAUNCHD_WRAPPER);
    expect(wrapper?.mode).toBe(0o755);
    expect(mac.find((e) => e.path === "bin/ttasks")?.mode).toBe(0o755);
    expect(mac.find((e) => e.path === "lib/ttasks.mjs")?.mode).toBe(0o644);
    // The page sits in ui/, beside lib/, as plain files.
    expect(mac.find((e) => e.path === "ui/assets/index-abc123.js")?.mode).toBe(0o644);
    expect(mac.map((e) => e.path)).toContain("ui/index.html");
    expect(assemble("linux-arm64").map((e) => e.path)).not.toContain("bin/ttasks-launchd");
  });

  test("a version and a build label must fit current, the app version and the log", () => {
    expect(identityProblems({ version: "0.1.0", build: "abcdef012345" })).toEqual([]);
    expect(identityProblems({ version: "0.1.0-dev.151", build: "abcdef012345-dirty" })).toEqual([]);
    for (const version of [
      "0.1",
      "0.1.0+meta",
      "01.0.0",
      "0.1.0-",
      "0.1.0-dev..1",
      "0.1.0 x",
      `0.1.0-${"a".repeat(41)}`,
    ]) {
      expect(identityProblems({ version, build: "abc" }), version).toHaveLength(1);
    }
    for (const build of ["source", "", "-x", "a b", "a".repeat(41), "a/b"]) {
      expect(identityProblems({ version: "0.1.0", build }), build).toHaveLength(1);
    }
  });

  test("a default identity needs the commit's whole history, which a shallow clone has not", () => {
    // The version counts the commits on HEAD: in a shallow clone that count is the clone's depth,
    // so the same commit would get another, smaller version.
    const git = (cwd: string, args: readonly string[]) => {
      const ran = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
      expect(ran.status, ran.stderr).toBe(0);
    };
    const origin = join(work, "identity-origin");
    mkdirSync(origin);
    writeFileSync(join(origin, "package.json"), '{ "version": "0.1.0" }\n');
    git(origin, ["init", "-q"]);
    for (const n of [1, 2, 3]) {
      git(origin, ["add", "-A"]);
      git(origin, [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        `fixture ${String(n)}`,
      ]);
    }
    const full = resolveIdentity(origin);
    expect(full.version).toBe("0.1.0-dev.3");
    expect(full.build).toMatch(/^[0-9a-f]{12}$/);
    const shallow = join(work, "identity-shallow");
    git(work, ["clone", "-q", "--depth", "1", pathToFileURL(origin).href, shallow]);
    expect(() => resolveIdentity(shallow)).toThrow(/shallow/);
    // A version given (a release) needs no history: the build label is still the commit's.
    expect(resolveIdentity(shallow, { version: "0.1.0" })).toEqual({
      version: "0.1.0",
      build: full.build,
    });
    expect(resolveIdentity(shallow, { version: "0.1.0", build: "fixture" })).toEqual({
      version: "0.1.0",
      build: "fixture",
    });
    expect(() => resolveIdentity(shallow, { build: "fixture" })).toThrow(/shallow/);
  });

  test("a build leaves dist/ with archives of its own version only", () => {
    const names = [
      "ttasks-0.1.0-dev.7-linux-x64.tar.gz",
      "ttasks-0.1.0-dev.7-win-x64.zip",
      "ttasks-0.1.0-dev.8-darwin-arm64.tar.gz",
      "ttasks-0.1.0-dev.8-linux-x64.tar.gz",
      "SHA256SUMS",
      "notes.txt",
    ];
    // Building 0.1.0-dev.8 for linux-x64: this platform's archive goes (it is made again), and so
    // does every archive of another version, which this build's SHA256SUMS would not list.
    expect(staleArchives(names, "0.1.0-dev.8", "linux-x64")).toEqual([
      "ttasks-0.1.0-dev.7-linux-x64.tar.gz",
      "ttasks-0.1.0-dev.7-win-x64.zip",
      "ttasks-0.1.0-dev.8-linux-x64.tar.gz",
    ]);
  });

  test("the scan finds a machine path in any spelling, as UTF-8 and UTF-16", () => {
    const dir = join(work, "scan");
    mkdirSync(join(dir, "lib"), { recursive: true });
    mkdirSync(join(dir, "runtime"), { recursive: true });
    const machine =
      process.platform === "win32" ? "C:\\Users\\fixture-builder" : "/home/fixture-builder";
    const needles = machinePathNeedles([machine, "/x"]);
    expect(needles.length).toBeGreaterThan(1);
    expect(needles.every((n) => n.length >= 8)).toBe(true);
    writeFileSync(join(dir, "lib", "clean.mjs"), "export {};\n");
    writeFileSync(
      join(dir, "lib", "slashes.mjs"),
      `// ${machine.replaceAll("\\", "/")}/tasks/x.ts\n`,
    );
    writeFileSync(join(dir, "lib", "escaped.json"), JSON.stringify({ p: `${machine}\\x` }));
    writeFileSync(join(dir, "lib", "wide.bin"), Buffer.from(`${machine}\\x`, "utf16le"));
    // Node's own binary is not the build's to scan.
    writeFileSync(join(dir, "runtime", "node"), machine);
    expect(scanForMachinePaths(dir, needles).sort()).toEqual([
      "lib/escaped.json",
      "lib/slashes.mjs",
      "lib/wide.bin",
    ]);
  });

  test("two folders compare byte for byte", () => {
    const a = join(work, "cmp-a");
    const b = join(work, "cmp-b");
    for (const dir of [a, b]) {
      mkdirSync(join(dir, "lib"), { recursive: true });
      writeFileSync(join(dir, "lib", "same.mjs"), "same");
    }
    expect(compareFolders(a, b)).toEqual([]);
    writeFileSync(join(a, "lib", "x.mjs"), "1");
    writeFileSync(join(b, "lib", "x.mjs"), "2");
    writeFileSync(join(b, "only.txt"), "");
    expect(compareFolders(a, b)).toEqual(["differs: lib/x.mjs", "only in one build: only.txt"]);
  });

  test.runIf(host !== undefined)(
    "a folder for this machine, built offline, archives exactly and passes the gate through its launcher",
    async () => {
      if (host === undefined) return;
      const pin = loadPin();
      expect(process.version).toBe(`v${pin.version}`);
      const identity = { version: "0.1.0-dev.1", build: "offline0test" };
      const web = await buildWeb(join(work, "ui"), repoRoot);
      const bundled = await bundle({
        root: repoRoot,
        out: join(work, "bundle"),
        identity,
        extraInputs: web.npmInputs,
      });
      const license = join(work, "node-license.txt");
      writeFileSync(license, "Stand-in for Node's licence in the offline test.\n");
      const folder = join(work, "out", identity.version);
      const manifest = assembleVersionFolder(folder, {
        platform: host,
        ...identity,
        node: { version: pin.version, sqlite: pin.sqlite, binary: process.execPath, license },
        launchers:
          host === "win-x64"
            ? windowsLaunchers(join(work, "launchers"))
            : { posix: POSIX_LAUNCHER, launchd: LAUNCHD_WRAPPER },
        bundle: { out: join(work, "bundle"), files: bundled.files },
        ui: { out: web.out, files: web.files },
        thirdParty: bundled.thirdParty,
        repoRoot,
      });
      // The page is in the folder, under the manifest like every other file.
      expect(Object.keys(manifest.files)).toContain("ui/index.html");
      expect(bundled.thirdParty).toMatch(/^react-dom \d+\.\d+\.\d+ \(MIT\)$/m);
      expect(manifest).toMatchObject({
        ...identity,
        platform: host,
        node: pin.version,
        sqlite: pin.sqlite,
      });
      expect(checkVersionFolder(folder)).toEqual([]);
      expect(readFileSync(join(folder, "manifest.json"), "utf8")).toContain('"protocol": {');

      const entries = folderEntries(folder, host);
      const archive =
        host === "win-x64" ? writeZip(entries, { level: 0 }) : writeTarGz(entries, { level: 0 });
      const back = host === "win-x64" ? readZip(archive) : readTarGz(archive);
      for (const e of entries) {
        const found = back.find((b) => b.path === e.path && b.type === "file");
        expect(found?.data.equals(e.data), e.path).toBe(true);
        if (host !== "win-x64") expect(found?.mode, e.path).toBe(e.mode);
      }

      const gate = runBuiltGate(folder, work, identity);
      expect(gate.problems).toEqual([]);
      expect(gate.rows.map((r) => [r.id, r.status])).toEqual([
        ["integrity", "ok"],
        ["runtime", "ok"],
        ["candidate-space", "ok"],
        ["candidate-endpoint", "ok"],
        ["candidate-bridge", "ok"],
      ]);
    },
    300_000,
  );
});
