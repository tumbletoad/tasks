import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  assertArgvVerbatim,
  assertExitCode,
  assertInstalled,
  assertRefused,
  assertReinstallChecksExistingVersion,
  type Canary,
  formatGate,
  launchArgv,
  prepareCanary,
  prepareTamperCases,
  type Ps7Condition,
  resignWithOtherKey,
  runFromPowerShell7,
  runGateVia,
  runInstaller,
  runInstallerFromPowerShell7,
  stableLauncher,
  versionLauncher,
} from "../src/checks.ts";
import { compileLaunchers } from "../src/msvc.ts";
import {
  buildFixtureRelease,
  type FixtureRelease,
  removeDir,
  requireHostPlatform,
  tempDir,
  VERSION,
} from "./fixture.ts";

// One signed release per run, built offline: the running Node as the packaged runtime, the
// launchers compiled with MSVC on Windows, SHA256SUMS signed by a throwaway key.
const platform = requireHostPlatform();
const windows = platform === "win-x64";
const SLOW = 180_000;

let work: string;
let release: FixtureRelease;
let canary: Canary;

beforeAll(() => {
  work = tempDir("release");
  release = buildFixtureRelease(work);
  canary = prepareCanary(join(work, "canary-kit"), platform);
}, 600_000);

afterAll(() => {
  removeDir(work);
});

describe("[A2.3.12.4.spike.install-verify] install verifies the signature and the hash first", () => {
  test(
    "installs into a temporary TTASKS_HOME, and the gate passes in the packaged runtime",
    () => {
      const root = join(work, "home");
      const run = runInstaller(platform, release.installer, release.dist, undefined, {
        TTASKS_HOME: root,
      });
      assertInstalled(root, VERSION, platform, run);
      const gate = runGateVia(stableLauncher(root, platform), join(work, "gate-scratch"));
      expect(gate.ok, formatGate(gate)).toBe(true);
    },
    SLOW,
  );

  test(
    "each tampered download stops before anything from it is unpacked or runs",
    () => {
      // The look-alike's launchers, runtime and lib/ modules are all canary stand-ins, and
      // prepareTamperCases first proves that each one fires when run.
      const cases = prepareTamperCases(
        release.dist,
        VERSION,
        platform,
        join(work, "tamper"),
        resignWithOtherKey(join(work, "tamper", "other-key")),
        canary,
      );
      expect(cases.map((c) => c.name)).toEqual(["archive", "sums", "resigned", "unsigned"]);
      for (const c of cases) {
        const root = join(work, `refused-${c.name}`);
        const installer = join(c.source, basename(release.installer));
        const run = runInstaller(platform, installer, c.source, root);
        assertRefused(root, VERSION, run, canary, c.reason);
      }
    },
    SLOW,
  );

  test(
    "a reinstall runs an existing folder of its version only if it is exactly the signed release",
    () => {
      assertReinstallChecksExistingVersion(
        platform,
        release.installer,
        release.dist,
        VERSION,
        join(work, "reinstall"),
        canary,
      );
    },
    SLOW,
  );

  test("without TTASKS_HOME or a root parameter the spike installs nowhere", () => {
    const run = runInstaller(platform, release.installer, release.dist, undefined, {
      TTASKS_HOME: undefined,
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/Set TTASKS_HOME or pass -?-[Rr]oot/);
  });

  // Lab row R09 (A2 3.12.4): started from a PowerShell 7 window, Windows PowerShell 5.1 fed
  // ssh-keygen a byte order mark on a UTF-8 console, and lost Get-FileHash under PowerShell 7's
  // module path. Both failed closed on a good signature.
  const PS7_CONDITIONS: readonly Ps7Condition[] = ["utf8-console", "pwsh-module-path"];

  test.runIf(windows)(
    "from a PowerShell 7 window ssh-keygen reads exactly the bytes of SHA256SUMS",
    () => {
      // The installer's own Invoke-WithInput, with a Node child that prints its input in hex in
      // place of ssh-keygen. The console's code page is reported too, to prove the condition.
      const fn = /^function Invoke-WithInput[\s\S]*?^\}\r?\n/m.exec(
        readFileSync(release.installer, "utf8"),
      )?.[0];
      if (fn === undefined) throw new Error("Invoke-WithInput is not in the install script");
      const probe = join(work, "stdin-probe.ps1");
      writeFileSync(
        probe,
        [
          "param([string]$Exe, [string]$Js, [string]$File)",
          "$ErrorActionPreference = 'Stop'",
          fn,
          "$cp = [Console]::InputEncoding.CodePage",
          "$r = Invoke-WithInput $Exe @($Js) $File",
          '[Console]::Out.Write("$cp $($r.Code) $($r.Output)")',
        ].join("\n"),
      );
      const hex = join(work, "stdin-hex.cjs");
      writeFileSync(
        hex,
        "const b = []; process.stdin.on('data', (c) => b.push(c)).on('end', () => " +
          "process.stdout.write(Buffer.concat(b).toString('hex')));\n",
      );
      const sums = join(release.dist, "SHA256SUMS");
      const want = readFileSync(sums).toString("hex");
      for (const [condition, codePage] of [
        ["utf8-console", "65001"],
        ["pwsh-module-path", "437"],
      ] as const) {
        const run = runFromPowerShell7(condition, probe, [
          "-Exe",
          process.execPath,
          "-Js",
          hex,
          "-File",
          sums,
        ]);
        expect(run.status, `${condition}: ${run.stderr}`).toBe(0);
        expect(run.stdout.trim(), condition).toBe(`${codePage} 0 ${want}`);
      }
    },
    SLOW,
  );

  test.runIf(windows)(
    "installs from a PowerShell 7 window on a UTF-8 console and with its module path",
    () => {
      for (const condition of PS7_CONDITIONS) {
        const root = join(work, `home-${condition}`);
        const run = runInstallerFromPowerShell7(condition, release.installer, release.dist, root);
        assertInstalled(root, VERSION, platform, {
          ...run,
          stderr: `[${condition}] ${run.stderr}`,
        });
      }
    },
    SLOW,
  );

  test.runIf(windows)(
    "tampered downloads are still refused from a PowerShell 7 window",
    () => {
      const cases = prepareTamperCases(
        release.dist,
        VERSION,
        platform,
        join(work, "tamper-ps7"),
        resignWithOtherKey(join(work, "tamper-ps7", "other-key")),
        canary,
      );
      for (const condition of PS7_CONDITIONS) {
        for (const c of cases) {
          const root = join(work, `refused-${condition}-${c.name}`);
          const installer = join(c.source, basename(release.installer));
          const run = runInstallerFromPowerShell7(condition, installer, c.source, root);
          try {
            assertRefused(root, VERSION, run, canary, c.reason);
          } catch (error) {
            throw new Error(`${condition}, ${c.name}: ${String(error)}\n${run.stderr}`, {
              cause: error,
            });
          }
        }
      }
    },
    SLOW,
  );
});

describe("[A2.3.12.3.spike.launcher-argv] launchers pass hostile argv to Node byte for byte", () => {
  let root: string;

  beforeAll(() => {
    // An install laid out by hand, so these tests do not depend on the install script.
    root = join(work, "launch-root");
    cpSync(join(work, "stage", VERSION), join(root, "versions", VERSION), { recursive: true });
    writeFileSync(join(root, "home.marker"), "");
    mkdirSync(join(root, "bin"), { recursive: true });
    if (windows) {
      writeFileSync(join(root, "current"), VERSION);
      for (const name of ["ttasks.exe", "ttasksw.exe"]) {
        cpSync(join(root, "versions", VERSION, "bin", name), join(root, "bin", name));
      }
    } else {
      symlinkSync(`versions/${VERSION}`, join(root, "current"));
      symlinkSync("../current/bin/ttasks", join(root, "bin", "ttasks"));
    }
  });

  const launchers = (): [string, "stable" | "version" | "posix"][] =>
    windows
      ? [
          [versionLauncher(root, VERSION, platform), "version"],
          [versionLauncher(root, VERSION, platform, true), "version"],
          [stableLauncher(root, platform), "stable"],
          [stableLauncher(root, platform, true), "stable"],
        ]
      : [
          [versionLauncher(root, VERSION, platform), "posix"],
          [stableLauncher(root, platform), "posix"],
        ];

  test(
    "every hostile argument arrives unchanged through every launcher, without NODE_OPTIONS",
    () => {
      for (const [launcher, mode] of launchers()) assertArgvVerbatim(launcher, mode);
    },
    SLOW,
  );

  test(
    "Node's exit code reaches the caller",
    () => {
      for (const [launcher] of launchers()) assertExitCode(launcher);
    },
    SLOW,
  );

  test("the launcher marks a separate install with TTASKS_HOME", () => {
    const same = (a: unknown, b: string) => String(a).toLowerCase() === b.toLowerCase();
    for (const [launcher, mode] of launchers()) {
      const { env } = launchArgv(launcher, []);
      expect(same(env["TTASKS_HOME"], root), `${launcher}: TTASKS_HOME`).toBe(true);
      if (mode !== "posix") {
        expect(same(env["TTASKS_ROOT"], root), `${launcher}: TTASKS_ROOT`).toBe(true);
        expect(same(env["TTASKS_LAUNCHER"], launcher), `${launcher}: TTASKS_LAUNCHER`).toBe(true);
        expect(env["TTASKS_PACKAGE"]).toBeNull();
      }
    }
  });

  test.runIf(windows)(
    "ttasks.exe copies a raw command-line tail verbatim, so Node parses it as if called directly",
    () => {
      // Raw text, not produced by any quoting library: unbalanced quotes, backslash runs before
      // quotes, empty quoted strings, percent signs and cmd.exe metacharacters.
      const tail = String.raw`argv a"b c"d \"x\" "y\\" z\\\" "" "" %PATH% ^& "un terminated`;
      const node = join(root, "versions", VERSION, "runtime", "node.exe");
      const entry = join(root, "versions", VERSION, "lib", "ttasks.mjs");
      const raw = (exe: string, argv0: string, rest: string) =>
        spawnSync(exe, [rest], {
          argv0,
          windowsVerbatimArguments: true,
          encoding: "utf8",
          windowsHide: true,
        });
      const direct = raw(node, `"${node}"`, `--report-exclude-env "${entry}" ${tail}`);
      expect(direct.status, direct.stderr).toBe(0);
      const expected = (JSON.parse(direct.stdout) as { args: string[] }).args;
      expect(expected.length).toBeGreaterThan(8);
      for (const [exe, mode] of launchers()) {
        if (mode === "posix") continue;
        // argv[0] with a quote in the middle and a space inside it: the launcher must still find
        // where the tail starts, by the C runtime's rule for argv[0].
        for (const argv0 of [`"${exe}"`, `C:\\fake"dir with space"\\ttasks.exe`]) {
          const run = raw(exe, argv0, tail);
          expect(run.status, run.stderr).toBe(0);
          expect((JSON.parse(run.stdout) as { args: string[] }).args, `${exe} ${argv0}`).toEqual(
            expected,
          );
        }
      }
    },
  );

  test.runIf(windows)("ttasks.exe answers --package-info and --replace itself", () => {
    const exe = stableLauncher(root, platform);
    const info = spawnSync(exe, ["--package-info"], { encoding: "utf8", windowsHide: true });
    expect([info.status, info.stdout]).toEqual([0, "none\n"]);

    const from = join(work, "replace-new.txt");
    const to = join(work, "replace-target.txt");
    writeFileSync(from, "new");
    writeFileSync(to, "old");
    const replaced = spawnSync(exe, ["--replace", from, to], {
      encoding: "utf8",
      windowsHide: true,
    });
    expect(replaced.status, replaced.stderr).toBe(0);
    expect(readFileSync(to, "utf8")).toBe("new");
    expect(existsSync(from)).toBe(false);
  });

  test.runIf(windows)(
    "ttasks.exe stops before Node runs when Windows refuses any step of its job object",
    () => {
      // A test build (TTASKS_TEST_HOOKS) simulates each refusal. Release builds have no hook.
      const hooks = compileLaunchers(join(work, "launchers-hooks"), undefined, [
        "TTASKS_TEST_HOOKS",
      ]);
      const exe = join(root, "bin", "ttasks-hooks.exe");
      cpSync(hooks.ttasks, exe);
      const run = (fail: string | undefined, launcher = exe) =>
        spawnSync(launcher, ["argv", "x"], {
          encoding: "utf8",
          windowsHide: true,
          env: { ...process.env, TTASKS_TEST_JOB_FAIL: fail },
        });
      const normal = run(undefined);
      expect([normal.status, normal.stderr]).toEqual([0, ""]);
      for (const step of ["create", "limits", "assign", "resume"]) {
        const refused = run(step);
        // Exit 70 and no output from Node: it never ran.
        expect([refused.status, refused.stdout], step).toEqual([70, ""]);
        expect(refused.stderr, step).toMatch(/job object .*error 5\)/);
      }
      const release = run("assign", stableLauncher(root, platform));
      expect([release.status, release.stderr], "the release build must ignore it").toEqual([0, ""]);
    },
    SLOW,
  );

  test.runIf(windows)("killing ttasks.exe kills Node, through the job object", async () => {
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const child = spawn(stableLauncher(root, platform), ["wait"], { windowsHide: true });
    try {
      const pid = await new Promise<number>((resolve, reject) => {
        let text = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          text += chunk;
          const line = /^(\d+)\r?\n/.exec(text);
          if (line) resolve(Number(line[1]));
        });
        child.on("exit", (code) => {
          reject(new Error(`ttasks.exe exited early (${String(code)})`));
        });
      });
      expect(alive(pid)).toBe(true);
      child.kill();
      const deadline = Date.now() + 10_000;
      while (alive(pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(alive(pid), "Node outlived its launcher").toBe(false);
    } finally {
      child.kill();
    }
  });

  test.runIf(windows)("a stable launcher refuses a bad current and a missing runtime", () => {
    const exe = stableLauncher(root, platform);
    const current = join(root, "current");
    try {
      for (const bad of [
        "",
        "..",
        ".",
        "../escape",
        "0.0.0 spike",
        "x".repeat(65),
        `${VERSION}\n`,
      ]) {
        writeFileSync(current, bad);
        const run = spawnSync(exe, ["argv"], { encoding: "utf8", windowsHide: true });
        expect(run.status, JSON.stringify(bad)).toBe(70);
        expect(run.stderr).toMatch(/does not hold a valid version/);
      }
      writeFileSync(current, "9.9.9");
      const missing = spawnSync(exe, ["argv"], { encoding: "utf8", windowsHide: true });
      expect(missing.status).toBe(70);
      expect(missing.stderr).toMatch(/missing .*runtime\\node\.exe/);
    } finally {
      writeFileSync(current, VERSION);
    }
    // A tail that fits the launcher's own command line but not Node's, with the paths added.
    const long = "x".repeat(32_700 - exe.length - 16);
    const tooLong = spawnSync(exe, ["argv", long], { encoding: "utf8", windowsHide: true });
    expect(tooLong.status).toBe(70);
    expect(tooLong.stderr).toMatch(/too long/);
  });

  test("a launcher inside a version folder runs that version, whatever current names", () => {
    const other = join(root, "versions", "0.0.1-spike");
    cpSync(join(root, "versions", VERSION), other, { recursive: true });
    const manifest = join(other, "manifest.json");
    writeFileSync(manifest, readFileSync(manifest, "utf8").replace(VERSION, "0.0.1-spike"));
    const version = (launcher: string) =>
      spawnSync(launcher, ["version"], { encoding: "utf8", windowsHide: true }).stdout;
    try {
      for (const gui of windows ? [false, true] : [false]) {
        expect(version(versionLauncher(root, "0.0.1-spike", platform, gui))).toBe("0.0.1-spike\n");
        expect(version(stableLauncher(root, platform, gui))).toBe(`${VERSION}\n`);
      }
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
