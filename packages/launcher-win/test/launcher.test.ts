// tasks.exe and tasksw.exe (A2 3.12.3, A7 3.8 M1.11): the build, hostile argv, the job object and
// the two modes. Windows only: on other platforms every test is collected and skipped.
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { assertReleaseBinary, buildLaunchers, type Launchers } from "../src/build.ts";
import {
  addVersion,
  alive,
  childEnv,
  type Env,
  HOSTILE_ARGS,
  killQuietly,
  launchArgv,
  launchVersion,
  linkOrCopy,
  makeStable,
  prepareRuntime,
  removeDir,
  run,
  samePath,
  stable,
  tempDir,
  versionLocal,
  waitUntil,
  windows,
} from "./install.ts";
import { compileFixture } from "./native.ts";

const SLOW = 120_000;
const OLD = "0.1.0";
const NEW = "0.2.0-beta.1+build.7";

describe.runIf(windows)("Windows launchers", () => {
  let work: string;
  let release: Launchers;
  let hooks: Launchers;
  /** The native fixtures of test/fixtures/ (see native.ts). */
  let fixture: { provider: string; spy: string; starter: string };

  beforeAll(() => {
    work = tempDir("launcher");
    prepareRuntime(work);
    release = buildLaunchers(join(work, "release"));
    hooks = buildLaunchers(join(work, "hooks"), { testHooks: true });
    const dir = join(work, "fixtures");
    mkdirSync(dir);
    fixture = {
      provider: compileFixture(dir, "provider"),
      spy: compileFixture(dir, "spy"),
      starter: compileFixture(dir, "starter"),
    };
  }, 300_000);

  afterAll(() => {
    removeDir(work);
  });

  /**
   * A fresh install root with one version, made current, and its stable launchers: by default the
   * daily install's layout, `<label>\share\tasks` with the launchers in `<label>\bin`; with
   * `separate`, a TASKS_HOME root `<label>` with home.marker and the launchers in its bin\.
   */
  function stableInstall(label: string, launchers: Launchers = release, separate = false): string {
    const root = separate ? join(work, label) : join(work, label, "share", "tasks");
    mkdirSync(root, { recursive: true });
    if (separate) writeFileSync(join(root, "home.marker"), "");
    addVersion(root, OLD, launchers);
    makeStable(root, OLD, launchers);
    return root;
  }

  /** Both launchers in both modes: the stable ones in bin\ and those of versions\<version>\bin\. */
  function everyLauncher(root: string, version = OLD): [exe: string, label: string][] {
    return [
      [stable(root), "stable tasks.exe"],
      [stable(root, true), "stable tasksw.exe"],
      [versionLocal(root, version), "version-local tasks.exe"],
      [versionLocal(root, version, true), "version-local tasksw.exe"],
    ];
  }

  describe("[A2.3.12.3.launcher-win.build] the build makes a console tasks.exe and a GUI tasksw.exe, hardened, and release builds carry no test hooks", () => {
    /** Reads the PE optional header: subsystem and DLL characteristics. */
    function peHeader(exe: string): { subsystem: number; dllCharacteristics: number } {
      const image = readFileSync(exe);
      const pe = image.readUInt32LE(0x3c);
      expect(image.toString("latin1", pe, pe + 4)).toBe("PE\0\0");
      const optional = pe + 24;
      expect(image.readUInt16LE(optional), "PE32+").toBe(0x20b);
      return {
        subsystem: image.readUInt16LE(optional + 68),
        dllCharacteristics: image.readUInt16LE(optional + 70),
      };
    }

    const has = (exe: string, text: string) =>
      readFileSync(exe).includes(Buffer.from(text, "utf16le"));

    test("tasks.exe is a console program and tasksw.exe a GUI program, with ASLR, DEP and CFG", () => {
      const CONSOLE = 3;
      const GUI = 2;
      const HARDENED = 0x0020 | 0x0040 | 0x0100 | 0x4000; // high-entropy ASLR, ASLR, DEP, CFG
      for (const built of [release, hooks]) {
        const tasks = peHeader(built.tasks);
        const tasksw = peHeader(built.tasksw);
        expect(tasks.subsystem).toBe(CONSOLE);
        expect(tasksw.subsystem).toBe(GUI);
        expect(tasks.dllCharacteristics & HARDENED).toBe(HARDENED);
        expect(tasksw.dllCharacteristics & HARDENED).toBe(HARDENED);
      }
    });

    test("release builds contain no test hook, test builds do", () => {
      for (const exe of [release.tasks, release.tasksw]) {
        expect(has(exe, "TASKS_TEST_"), exe).toBe(false);
      }
      expect(has(hooks.tasks, "TASKS_TEST_JOB_FAIL")).toBe(true);
      expect(has(hooks.tasksw, "TASKS_TEST_TIME_UNIT_MS")).toBe(true);
      expect(has(hooks.tasksw, "TASKS_TEST_TRACE")).toBe(true);
    });

    test(
      "CL and _CL_ in the caller's environment cannot put the test hooks into a release build",
      () => {
        // cl.exe prepends CL and appends _CL_ to its command line (Microsoft Learn, "CL
        // environment variables"). Names match without case on Windows.
        for (const name of ["CL", "_CL_", "cl"]) {
          const saved = process.env[name];
          process.env[name] = "/DTASKS_TEST_HOOKS";
          try {
            const built = buildLaunchers(join(work, `release-env-${name}`));
            for (const exe of [built.tasks, built.tasksw]) {
              expect(has(exe, "TASKS_TEST_"), `${name}: ${exe}`).toBe(false);
            }
          } finally {
            if (saved === undefined) Reflect.deleteProperty(process.env, name);
            else process.env[name] = saved;
          }
        }
      },
      SLOW,
    );

    test("the release check refuses a binary with test hooks and passes a release build", () => {
      for (const exe of [hooks.tasks, hooks.tasksw]) {
        expect(() => {
          assertReleaseBinary(exe);
        }, exe).toThrow(/contains test hooks/);
      }
      for (const exe of [release.tasks, release.tasksw]) {
        expect(() => {
          assertReleaseBinary(exe);
        }, exe).not.toThrow();
      }
    });
  });

  describe("[A2.3.12.3.launcher-win.argv] hostile argv reaches Node byte for byte through both launchers in both modes", () => {
    let root: string;
    let launchers: [exe: string, mode: "stable" | "version"][];

    beforeAll(() => {
      root = stableInstall("argv", release, true);
      launchers = [
        [versionLocal(root, OLD), "version"],
        [versionLocal(root, OLD, true), "version"],
        [stable(root), "stable"],
        [stable(root, true), "stable"],
      ];
    });

    test(
      "every hostile argument arrives unchanged, alone and all at once, with NODE_OPTIONS and NODE_PATH removed",
      () => {
        // If either reached Node, it would fail to start or load the missing module.
        const poisoned = [
          { NODE_OPTIONS: "--require ./does-not-exist.cjs", NODE_PATH: "./nowhere" },
          { node_options: "--require ./does-not-exist.cjs", Node_Path: "./nowhere" },
        ];
        for (const [exe, mode] of launchers) {
          for (const env of poisoned) {
            const all = launchArgv(exe, HOSTILE_ARGS, env);
            expect(all.args, exe).toEqual([...HOSTILE_ARGS]);
            expect(all.execArgv).toEqual(["--report-exclude-env"]);
            expect(all.env["NODE_OPTIONS"], "NODE_OPTIONS reached Node").toBe(false);
            expect(all.env["NODE_PATH"], "NODE_PATH reached Node").toBe(false);
            expect(all.env["TASKS_LAUNCH_MODE"]).toBe(mode);
          }
          for (const arg of HOSTILE_ARGS) {
            expect(launchArgv(exe, [arg]).args, `${exe} ${JSON.stringify(arg)}`).toEqual([arg]);
          }
          expect(launchArgv(exe, []).args).toEqual([]);
        }
      },
      SLOW,
    );

    test("a raw command-line tail reaches Node exactly as Node parses it when called directly", () => {
      // Raw text, not produced by any quoting library: unbalanced quotes, backslash runs before
      // quotes, empty quoted strings, percent signs and cmd.exe metacharacters.
      const tail = String.raw`argv a"b c"d \"x\" "y\\" z\\\" "" "" %PATH% ^& "un terminated`;
      const node = join(root, "versions", OLD, "runtime", "node.exe");
      const entry = join(root, "versions", OLD, "lib", "tasks.mjs");
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
      for (const [exe] of launchers) {
        // argv[0] with a quote in the middle and a space inside it: the launcher must still find
        // where the tail starts, by the C runtime's rule for argv[0].
        for (const argv0 of [`"${exe}"`, `C:\\fake"dir with space"\\tasks.exe`, exe]) {
          const result = raw(exe, argv0, tail);
          expect(result.status, result.stderr).toBe(0);
          expect((JSON.parse(result.stdout) as { args: string[] }).args, `${exe} ${argv0}`).toEqual(
            expected,
          );
        }
      }
    });

    test("Node's exit code reaches the caller", () => {
      for (const [exe] of launchers) {
        for (const code of [0, 1, 7, 64, 70, 73, 75, 255, 256]) {
          expect(run(exe, ["exit", String(code)]).status, `${exe} exit ${String(code)}`).toBe(code);
        }
      }
    });

    test("a command line too long for Node exits 70 before anything runs", () => {
      for (const [exe] of launchers) {
        // Fits the launcher's own command line, but not Node's once the paths are added.
        const long = "x".repeat(32_700 - exe.length - 16);
        const result = run(exe, ["argv", long]);
        expect([result.status, result.stdout], exe).toEqual([70, ""]);
        expect(result.stderr).toMatch(/too long/);
      }
    });

    test("the launcher's own variables come from its location, whatever the caller set", () => {
      const decoy = join(work, "decoy-root");
      const spoofed = {
        TASKS_ROOT: decoy,
        TASKS_LAUNCHER: join(decoy, "tasks.exe"),
        TASKS_LAUNCH_MODE: "spoofed",
        TASKS_PACKAGE: "Spoofed.Package_1.0.0.0_x64__8wekyb3d8bbwe",
        tasks_home: decoy,
      };
      for (const [exe, mode] of launchers) {
        const { env } = launchArgv(exe, [], spoofed);
        expect(samePath(env["TASKS_ROOT"], root), `${exe}: TASKS_ROOT`).toBe(true);
        expect(samePath(env["TASKS_LAUNCHER"], exe), `${exe}: TASKS_LAUNCHER`).toBe(true);
        expect(env["TASKS_LAUNCH_MODE"]).toBe(mode);
        expect(env["TASKS_PACKAGE"]).toBeNull();
        expect(samePath(env["TASKS_HOME"], root), `${exe}: TASKS_HOME`).toBe(true);
      }
      // Without home.marker the install is the daily one: TASKS_HOME from the caller is removed,
      // and the stable launchers in the command folder name share\tasks beside it as the root.
      const daily = stableInstall("argv-daily");
      for (const exe of [stable(daily), stable(daily, true), versionLocal(daily, OLD, true)]) {
        const { env } = launchArgv(exe, [], spoofed);
        expect(env["TASKS_HOME"], exe).toBeNull();
        expect(samePath(env["TASKS_ROOT"], daily), `${exe}: TASKS_ROOT`).toBe(true);
      }
    });
  });

  describe("[A2.3.12.3.launcher-win.env] Node's own variables and OpenSSL's loader settings never reach Node, except NODE_EXTRA_CA_CERTS", () => {
    let root: string;
    let dir: string;
    let count = 0;
    const fresh = (label: string) => {
      count += 1;
      return join(dir, `${label}-${String(count)}`);
    };

    beforeAll(() => {
      root = stableInstall("env");
      dir = join(work, "env-files");
      mkdirSync(dir);
    });

    /** The control: the same Node and entry started directly, without a launcher. */
    const direct = (args: readonly string[], env: Env) =>
      spawnSync(
        join(root, "versions", OLD, "runtime", "node.exe"),
        [join(root, "versions", OLD, "lib", "tasks.mjs"), ...args],
        { env: childEnv(env), encoding: "utf8", windowsHide: true },
      );

    test(
      "an OpenSSL provider DLL named by OPENSSL_CONF is never loaded",
      () => {
        // OpenSSL's configuration parser reads a backslash as an escape: forward slashes.
        const conf = fresh("openssl.cnf");
        writeFileSync(
          conf,
          [
            "nodejs_conf = nodejs_init",
            "[nodejs_init]",
            "providers = providers",
            "[providers]",
            "default = default_provider",
            "canary = canary_provider",
            "[default_provider]",
            "activate = 1",
            "[canary_provider]",
            `module = ${fixture.provider.replaceAll("\\", "/")}`,
            "activate = 1",
            "",
          ].join("\n"),
        );
        const seen = fresh("marker");
        const control = direct(["argv"], { OPENSSL_CONF: conf, TASKS_FIXTURE_MARKER: seen });
        expect(control.status, control.stderr).toBe(0);
        expect(existsSync(seen), "the control did not load the provider DLL").toBe(true);
        for (const [exe, label] of everyLauncher(root)) {
          for (const name of ["OPENSSL_CONF", "openssl_conf"]) {
            const marker = fresh("marker");
            const result = run(exe, ["argv"], {
              env: { [name]: conf, TASKS_FIXTURE_MARKER: marker },
            });
            expect(existsSync(marker), `${label} ${name}: the provider DLL was loaded`).toBe(false);
            expect([result.status, result.stderr], label).toEqual([0, ""]);
          }
        }
      },
      SLOW,
    );

    test(
      "NODE_DEBUG adds nothing to stderr, and NODE_COMPILE_CACHE and NODE_V8_COVERAGE create no folder",
      () => {
        const variables = () => ({
          NODE_DEBUG: "esm,module,child_process,timers,fs",
          NODE_COMPILE_CACHE: fresh("cache"),
          NODE_V8_COVERAGE: fresh("coverage"),
        });
        const env = variables();
        const control = direct(["argv"], env);
        expect(control.status).toBe(0);
        expect(control.stderr, "the control printed no debug output").not.toBe("");
        expect(existsSync(env.NODE_COMPILE_CACHE), "the control made no compile cache").toBe(true);
        expect(existsSync(env.NODE_V8_COVERAGE), "the control wrote no coverage").toBe(true);
        for (const [exe, label] of everyLauncher(root)) {
          const poisoned = variables();
          const result = run(exe, ["argv"], { env: poisoned });
          expect([result.status, result.stderr], label).toEqual([0, ""]);
          expect(existsSync(poisoned.NODE_COMPILE_CACHE), `${label}: compile cache`).toBe(false);
          expect(existsSync(poisoned.NODE_V8_COVERAGE), `${label}: coverage`).toBe(false);
        }
      },
      SLOW,
    );

    test(
      "NODE_EXTRA_CA_CERTS, proxies and SSL_CERT_ pass, every other NODE_ name and OpenSSL's loader settings are removed, in any case and when a name appears twice",
      () => {
        const pem = fresh("extra.pem");
        writeFileSync(pem, rootCertificates[0] ?? "");
        const passed = {
          HTTPS_PROXY: "http://127.0.0.1:9",
          http_proxy: "http://127.0.0.1:9",
          No_Proxy: "localhost",
          SSL_CERT_FILE: pem,
          SSL_CERT_DIR: dir,
        };
        // Raw entries appended to the block, so a name can appear twice in different cases.
        const entries = [
          `NODE_EXTRA_CA_CERTS=${pem}`,
          "NODE_OPTIONS=--require ./missing.cjs",
          "Node_Options=--require ./missing.cjs",
          "NODE_DEBUG=esm",
          "node_debug=module",
          "NODE_PENDING_DEPRECATION=1",
          "NODE_TLS_REJECT_UNAUTHORIZED=0",
          "NODE_REPL_EXTERNAL_MODULE=./missing.cjs",
          "NODE_ICU_DATA=./missing",
          "NODE_ENV=development",
          "NODE_=x",
          "NODE_NOT_YET_INVENTED=1",
          `OPENSSL_CONF=${pem}`,
          `openssl_conf=${pem}`,
          "OPENSSL_CONF_INCLUDE=./missing",
          "OpenSSL_Modules=./missing",
          "OPENSSL_ENGINES=./missing",
          ...Object.entries(passed).map(([name, value]) => `${name}=${value}`),
        ];
        // The caller's own copies of the passed names would show up twice.
        const clean = Object.fromEntries(Object.keys(passed).map((name) => [name, undefined]));
        for (const [exe, label] of everyLauncher(root)) {
          const result = run(
            fixture.starter,
            ["inherit", "inherit", "inherit", "-", exe, ...entries, "--", "env"],
            { env: clean },
          );
          expect([result.status, result.stderr], label).toEqual([0, ""]);
          const report = JSON.parse(result.stdout) as {
            names: string[];
            passed: Record<string, string>;
            extraCertificates: number;
          };
          expect(report.names, label).toEqual(["NODE_EXTRA_CA_CERTS"]);
          expect(report.extraCertificates, `${label}: NODE_EXTRA_CA_CERTS unused`).toBe(1);
          expect(report.passed, label).toEqual(passed);
        }
      },
      SLOW,
    );

    test(
      "more than 64 copies of each launcher variable, in mixed case, all give way to the launcher's own value",
      () => {
        const COPIES = 70;
        // Copy i spells the name with the letters chosen by i's bits in lower case: every copy is
        // spelled differently (Node lists one spelling once).
        const spelled = (name: string, i: number) => {
          let letter = 0;
          return name.replace(/[A-Z]/g, (c) => ((i >> letter++) & 1 ? c.toLowerCase() : c));
        };
        const owned = [
          "TASKS_ROOT",
          "TASKS_LAUNCHER",
          "TASKS_LAUNCH_MODE",
          "TASKS_PACKAGE",
          "TASKS_HOME",
          "TASKS_SERVICE_MANAGER",
        ];
        const entries = owned.flatMap((name) =>
          Array.from({ length: COPIES }, (_, i) => `${spelled(name, i)}=decoy-${String(i)}`),
        );
        // The test's own copies, if it has any, would show up too.
        const clean = Object.fromEntries(owned.map((name) => [name, undefined]));
        interface Report {
          prefixedNames: string[];
          launcher: Record<string, string | boolean | null>;
        }
        // The control: Node started directly sees every copy, so the report would show any left.
        const node = join(root, "versions", OLD, "runtime", "node.exe");
        const entry = join(root, "versions", OLD, "lib", "tasks.mjs");
        const control = run(
          fixture.starter,
          [
            ...["inherit", "inherit", "inherit", "-", node],
            ...entries,
            ...["--", `"${entry}"`, "env"],
          ],
          { env: clean },
        );
        expect([control.status, control.stderr]).toEqual([0, ""]);
        expect((JSON.parse(control.stdout) as Report).prefixedNames).toHaveLength(
          owned.length * COPIES,
        );
        for (const [exe, label] of everyLauncher(root)) {
          const result = run(
            fixture.starter,
            [...["inherit", "inherit", "inherit", "-", exe], ...entries, ...["--", "env"]],
            { env: clean },
          );
          expect([result.status, result.stderr], label).toEqual([0, ""]);
          const report = JSON.parse(result.stdout) as Report;
          // No home.marker and no package: TASKS_HOME and TASKS_PACKAGE are absent.
          expect(report.prefixedNames, label).toEqual([
            "TASKS_LAUNCHER",
            "TASKS_LAUNCH_MODE",
            "TASKS_ROOT",
          ]);
          expect(samePath(report.launcher["TASKS_ROOT"], root), label).toBe(true);
          expect(samePath(report.launcher["TASKS_LAUNCHER"], exe), label).toBe(true);
          expect(report.launcher["TASKS_LAUNCH_MODE"], label).toBe(
            label.startsWith("stable") ? "stable" : "version",
          );
        }
      },
      SLOW,
    );
  });

  describe("[A2.3.12.3.launcher-win.handles] Node inherits the launcher's standard handles and no other handle", () => {
    let root: string;
    let count = 0;

    beforeAll(() => {
      root = stableInstall("handles");
      // A stand-in node.exe (test/fixtures/spy.c) reports the handles it received.
      const runtime = join(root, "versions", OLD, "runtime", "node.exe");
      rmSync(runtime);
      copyFileSync(fixture.spy, runtime);
    });

    interface SpyReport {
      stdin: string;
      stdout: string;
      stderr: string;
      stray: number;
      input: string;
    }

    /**
     * Runs exe through the starter with the given standard handles ("file" for a file in a fresh
     * folder) while the starter holds an unrelated file open through an inheritable handle.
     */
    function start(exe: string, specs: readonly [string, string, string]) {
      count += 1;
      const dir = join(work, `handles-${String(count)}`);
      mkdirSync(dir);
      const file = (name: string) => join(dir, name);
      const read = (name: string) =>
        existsSync(file(name)) ? readFileSync(file(name), "utf8") : null;
      writeFileSync(file("in.txt"), "in");
      const names = ["in.txt", "out.txt", "err.txt"];
      const handles = specs.map((spec, i) =>
        spec === "file" ? `file:${file(names[i] ?? "")}` : spec,
      );
      const result = run(fixture.starter, [...handles, file("stray.txt"), exe, "--", "argv"], {
        env: { TASKS_FIXTURE_REPORT: file("report.json"), TASKS_FIXTURE_STRAY: "\\stray.txt" },
      });
      return {
        status: result.status,
        report: JSON.parse(read("report.json") ?? "null") as SpyReport | null,
        out: read("out.txt"),
        err: read("err.txt"),
        stray: read("stray.txt"),
      };
    }

    test(
      "an unrelated inheritable handle of the caller never reaches Node",
      () => {
        // The control: started directly by the starter, the stand-in finds and uses the handle.
        const control = start(fixture.spy, ["file", "file", "file"]);
        expect([control.report?.stray, control.stray]).toEqual([1, "LEAK"]);
        for (const [exe, label] of everyLauncher(root)) {
          const s = start(exe, ["file", "file", "file"]);
          expect(s.status, label).toBe(0);
          expect(s.report, label).toEqual({
            stdin: "disk",
            stdout: "disk",
            stderr: "disk",
            stray: 0,
            input: "in",
          });
          expect([s.out, s.err, s.stray], label).toEqual(["out\n", "err\n", ""]);
        }
      },
      SLOW,
    );

    test(
      "one handle in both stdout and stderr (> out.log 2>&1) reaches Node in both slots",
      () => {
        // The starter puts the identical handle value into both slots, which Node's own spawn
        // cannot do: it duplicates per slot.
        for (const [exe, label] of everyLauncher(root)) {
          const s = start(exe, ["file", "file", "stdout"]);
          expect(s.status, label).toBe(0);
          expect(s.report, label).toEqual({
            stdin: "disk",
            stdout: "disk",
            stderr: "disk",
            stray: 0,
            input: "in",
          });
          // Both streams arrive in the one file.
          expect([s.out, s.err], label).toEqual(["out\nerr\n", null]);
        }
      },
      SLOW,
    );

    test(
      "a missing or invalid standard handle leaves Node without it, and Node still runs",
      () => {
        // Windows gives a console program its console's handle where a standard handle is
        // NULL, so "without it" is either no handle or a console handle: never a value that
        // names no handle ("bad") and never a file.
        const absent = "none or char";
        const kind = (k: string) => (k === "none" || k === "char" ? absent : k);
        const seen = (r: SpyReport | null) =>
          r && { ...r, stdin: kind(r.stdin), stdout: kind(r.stdout), stderr: kind(r.stderr) };
        const slots = ["stdin", "stdout", "stderr"] as const;
        for (const [exe, label] of everyLauncher(root)) {
          for (const missing of ["null", "invalid", "bogus"]) {
            for (const [slot, name] of slots.entries()) {
              const specs: [string, string, string] = ["file", "file", "file"];
              specs[slot] = missing;
              const s = start(exe, specs);
              const what = `${label}, ${name} ${missing}`;
              expect(s.status, what).toBe(0);
              expect(seen(s.report), what).toEqual({
                stdin: slot === 0 ? absent : "disk",
                stdout: slot === 1 ? absent : "disk",
                stderr: slot === 2 ? absent : "disk",
                stray: 0,
                input: slot === 0 ? "" : "in",
              });
            }
            const none = start(exe, [missing, missing, missing]);
            expect(none.status, `${label}, all ${missing}`).toBe(0);
            expect(seen(none.report), `${label}, all ${missing}`).toEqual({
              stdin: absent,
              stdout: absent,
              stderr: absent,
              stray: 0,
              input: "",
            });
          }
        }
      },
      SLOW,
    );
  });

  describe("[A2.3.12.3.launcher-win.job] Node runs only inside tasks.exe's job, so killing tasks.exe kills Node", () => {
    let root: string;

    beforeAll(() => {
      root = stableInstall("job");
    });

    /** Starts a launcher with `args` and resolves with the first line it prints. */
    function firstLine(exe: string, args: readonly string[]) {
      const child = spawn(exe, args, { windowsHide: true });
      const line = new Promise<string>((resolve, reject) => {
        let text = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          text += chunk;
          const match = /^(.*)\r?\n/.exec(text);
          if (match) resolve(match[1] ?? "");
        });
        child.on("exit", (code) => {
          reject(new Error(`${exe} exited early (${String(code)})`));
        });
      });
      return { child, line };
    }

    test("killing tasks.exe kills Node, in both modes", async () => {
      for (const exe of [stable(root), versionLocal(root, OLD)]) {
        const { child, line } = firstLine(exe, ["wait"]);
        let pid: number | undefined;
        try {
          pid = Number(await line);
          expect(alive(pid)).toBe(true);
          // Node's stdin stays open (the test holds it), so only the job can end Node.
          child.kill();
          expect(await waitUntil(() => !alive(pid ?? 0), 10_000), "Node outlived tasks.exe").toBe(
            true,
          );
          // Gone: Windows may already have given its PID to another test's process.
          pid = undefined;
        } finally {
          child.kill();
          killQuietly(pid);
        }
      }
    });

    test("a detached child of Node is outside the job and survives tasks.exe", async () => {
      const { child, line } = firstLine(stable(root), ["detach"]);
      let pids: number[] = [];
      try {
        pids = (await line).split(" ").map(Number);
        const [node, detached] = pids;
        expect(alive(node ?? 0) && alive(detached ?? 0)).toBe(true);
        child.kill();
        expect(await waitUntil(() => !alive(node ?? 0), 10_000), "Node outlived tasks.exe").toBe(
          true,
        );
        // Node is gone: Windows may already have given its PID to another test's process.
        pids = pids.filter((pid) => pid !== node);
        expect(alive(detached ?? 0), "the detached child died with the job").toBe(true);
      } finally {
        child.kill();
        for (const pid of pids) killQuietly(pid);
      }
    });

    test(
      "a refused job step stops Node before it runs (exit 70), and a release build ignores the hook",
      () => {
        const exe = join(stable(root), "..", "tasks-hooks.exe");
        copyFileSync(hooks.tasks, exe);
        const normal = run(exe, ["argv", "x"]);
        expect([normal.status, normal.stderr]).toEqual([0, ""]);
        for (const step of ["create", "limits", "assign", "resume"]) {
          const refused = run(exe, ["argv", "x"], { env: { TASKS_TEST_JOB_FAIL: step } });
          // Exit 70 and no output from Node: it never ran.
          expect([refused.status, refused.stdout], step).toEqual([70, ""]);
          expect(refused.stderr, step).toMatch(/job object .*error 5\)/);
        }
        const ignored = run(stable(root), ["argv", "x"], {
          env: { TASKS_TEST_JOB_FAIL: "assign" },
        });
        expect([ignored.status, ignored.stderr], "the release build must ignore it").toEqual([
          0,
          "",
        ]);
      },
      SLOW,
    );
  });

  describe("[A2.3.12.3.launcher-win.modes] stable dispatch reads current, version-local runs its own version without it, and neither can be steered", () => {
    const node = (root: string, version: string) =>
      join(root, "versions", version, "runtime", "node.exe");

    test("a version-local launcher runs its own version in a fresh install with no current", () => {
      const root = join(work, "fresh");
      addVersion(root, NEW, release);
      for (const gui of [false, true]) {
        const exe = versionLocal(root, NEW, gui);
        const ran = launchVersion(exe);
        expect(ran.version).toBe(NEW);
        expect(samePath(ran.execPath, node(root, NEW)), ran.execPath).toBe(true);
        const { env } = launchArgv(exe, []);
        expect(env["TASKS_LAUNCH_MODE"]).toBe("version");
        expect(samePath(env["TASKS_ROOT"], root)).toBe(true);
      }
      const info = run(versionLocal(root, NEW), ["--package-info"]);
      expect([info.status, info.stdout]).toEqual([0, "none\n"]);
    });

    test("during an update a version-local launcher runs its version while current names the old one", () => {
      const root = stableInstall("update");
      addVersion(root, NEW, release);
      for (const gui of [false, true]) {
        expect(launchVersion(versionLocal(root, NEW, gui)).version).toBe(NEW);
        expect(launchVersion(versionLocal(root, OLD, gui)).version).toBe(OLD);
        expect(launchVersion(stable(root, gui)).version).toBe(OLD);
      }
      // It never reads current: a broken current stops the stable launchers, not this one.
      for (const broken of ["../escape", "9.9.9"]) {
        writeFileSync(join(root, "current"), broken);
        expect(run(stable(root), ["version"]).status).toBe(70);
        for (const gui of [false, true]) {
          const ran = launchVersion(versionLocal(root, NEW, gui));
          expect(ran.version).toBe(NEW);
          expect(samePath(ran.execPath, node(root, NEW))).toBe(true);
        }
      }
      // The switch: the stable launchers follow current at the next start.
      writeFileSync(join(root, "current"), NEW);
      for (const gui of [false, true]) {
        const ran = launchVersion(stable(root, gui));
        expect(ran.version).toBe(NEW);
        expect(samePath(ran.execPath, node(root, NEW))).toBe(true);
      }
    });

    test("a stable launcher refuses hostile contents of current", () => {
      const root = stableInstall("hostile-current");
      const current = join(root, "current");
      const hostile = [
        "",
        ".",
        "..",
        "...",
        "../escape",
        "..\\escape",
        "a/b",
        "a\\b",
        "0..1",
        ".staging-k3j4",
        "0.1.0.",
        "-0.1.0",
        "0.1.0 ",
        " 0.1.0",
        "0.1.0\n",
        "0.1.0\r\n",
        "0.1.0\t",
        "0.1 0",
        "\uFEFF0.1.0",
        "0.1.0\0",
        "0.1.0:evil",
        "0.1.0::$DATA",
        "C:0.1.0",
        "%PATH%",
        "*",
        "0.1.?",
        "CON",
        "nul",
        "Aux",
        "prn.1.0",
        "COM1",
        "lpt9.0",
        "x".repeat(65),
        `${"1".repeat(64)}\n`,
        "0.1.0é",
      ];
      for (const bad of hostile) {
        writeFileSync(current, bad);
        const result = run(stable(root), ["version"]);
        expect([result.status, result.stdout], JSON.stringify(bad)).toEqual([70, ""]);
        expect(result.stderr, JSON.stringify(bad)).toMatch(/does not hold a valid version/);
      }
      // The longest valid name is accepted and only then found missing.
      writeFileSync(current, "1".repeat(64));
      expect(run(stable(root), ["version"]).stderr).toMatch(/missing .*versions\\1{64}$/m);
      // A missing current, and a folder in its place.
      rmSync(current);
      expect(run(stable(root), ["version"]).stderr).toMatch(/cannot read .*current/);
      mkdirSync(current);
      expect(run(stable(root), ["version"]).status).toBe(70);
    });

    test("a missing runtime or entry exits 70 naming it", () => {
      const root = stableInstall("missing");
      rmSync(join(root, "versions", OLD, "lib", "tasks.mjs"));
      const noEntry = run(stable(root), ["version"]);
      expect(noEntry.status).toBe(70);
      expect(noEntry.stderr).toMatch(/missing .*lib\\tasks\.mjs/);
      rmSync(node(root, OLD));
      for (const exe of [stable(root), versionLocal(root, OLD)]) {
        const noRuntime = run(exe, ["version"]);
        expect(noRuntime.status).toBe(70);
        expect(noRuntime.stderr).toMatch(/missing .*runtime\\node\.exe/);
      }
      // A command folder with no share\tasks beside it: the daily stable launcher names what is
      // missing and runs nothing.
      const lone = join(work, "lone", "bin");
      mkdirSync(lone, { recursive: true });
      copyFileSync(release.tasks, join(lone, "tasks.exe"));
      const noShare = run(join(lone, "tasks.exe"), ["version"]);
      expect([noShare.status, noShare.stdout]).toEqual([70, ""]);
      expect(noShare.stderr).toMatch(/missing .*\\lone\\share$/m);
      mkdirSync(join(work, "lone", "share"));
      expect(run(join(lone, "tasks.exe"), ["version"]).stderr).toMatch(
        /missing .*\\share\\tasks$/m,
      );
    });

    test("neither launcher follows a link or junction below the install root, in either mode", () => {
      const outside = join(work, "outside");
      addVersion(outside, "6.6.6", release);
      const elsewhere = join(outside, "versions", "6.6.6");
      // Junctions need no administrator rights. Each case also starts the version-local
      // launchers of the version folder it names, reached through the junction where there is one.
      const cases: [label: string, version: string, setUp: (root: string) => void][] = [
        [
          "the version folder",
          "6.6.6",
          (root) => {
            symlinkSync(elsewhere, join(root, "versions", "6.6.6"), "junction");
            writeFileSync(join(root, "current"), "6.6.6");
          },
        ],
        [
          "the runtime folder",
          OLD,
          (root) => {
            rmSync(join(root, "versions", OLD, "runtime"), { recursive: true });
            symlinkSync(
              join(elsewhere, "runtime"),
              join(root, "versions", OLD, "runtime"),
              "junction",
            );
          },
        ],
        [
          "the lib folder",
          OLD,
          (root) => {
            rmSync(join(root, "versions", OLD, "lib"), { recursive: true });
            symlinkSync(join(elsewhere, "lib"), join(root, "versions", OLD, "lib"), "junction");
          },
        ],
        [
          "the versions folder",
          "6.6.6",
          (root) => {
            rmSync(join(root, "versions"), { recursive: true });
            symlinkSync(join(outside, "versions"), join(root, "versions"), "junction");
            writeFileSync(join(root, "current"), "6.6.6");
          },
        ],
      ];
      for (const [label, version, setUp] of cases) {
        const root = stableInstall(`link-${label.replaceAll(" ", "-")}`);
        setUp(root);
        for (const [exe, mode] of everyLauncher(root, version)) {
          const result = run(exe, ["version"]);
          expect([result.status, result.stdout], `${label}, ${mode}`).toEqual([70, ""]);
          expect(result.stderr, `${label}, ${mode}`).toMatch(/is a link or junction/);
        }
      }
      // The daily install's command folder reaches the program through share\tasks beside it:
      // a junction at share or at share\tasks would point it at another install.
      const other = stableInstall("link-other");
      for (const level of ["share", "program"] as const) {
        const root = stableInstall(`link-${level}`);
        const target = level === "share" ? join(root, "..") : root;
        rmSync(target, { recursive: true });
        symlinkSync(level === "share" ? join(other, "..") : other, target, "junction");
        for (const gui of [false, true]) {
          const result = run(stable(root, gui), ["version"]);
          expect([result.status, result.stdout], level).toEqual([70, ""]);
          expect(result.stderr, level).toMatch(/is a link or junction/);
        }
      }
    });

    test("neither the working directory nor PATH nor the caller's variables steer what runs", () => {
      const root = stableInstall("steer");
      // A decoy install in the working directory, first on PATH and named by every variable.
      const decoy = join(work, "steer-decoy");
      mkdirSync(decoy);
      writeFileSync(join(decoy, "home.marker"), "");
      addVersion(decoy, "6.6.6", release);
      makeStable(decoy, "6.6.6", release);
      linkOrCopy(node(decoy, "6.6.6"), join(decoy, "node.exe"));
      cpSync(join(decoy, "versions", "6.6.6", "lib"), join(decoy, "lib"), { recursive: true });
      const env = {
        PATH: `${decoy};${join(decoy, "bin")};${process.env["PATH"] ?? ""}`,
        TASKS_ROOT: decoy,
        TASKS_HOME: decoy,
        TASKS_LAUNCH_MODE: "version",
      };
      for (const exe of [stable(root), stable(root, true), versionLocal(root, OLD)]) {
        const ran = launchVersion(exe, { cwd: decoy, env });
        expect(ran.version, exe).toBe(OLD);
        expect(samePath(ran.execPath, node(root, OLD)), ran.execPath).toBe(true);
      }
    });

    test("a launcher in a version folder ignores a stray current there, and the mode needs the manifest", () => {
      const root = stableInstall("nested");
      addVersion(root, NEW, release);
      const folder = join(root, "versions", NEW);
      // A stray current and versions\ inside a version folder: version-local mode never reads them.
      writeFileSync(join(folder, "current"), OLD);
      addVersion(folder, OLD, release);
      expect(launchVersion(versionLocal(root, NEW)).version).toBe(NEW);
      // Without manifest.json the folder is no version folder, so the launcher is a stable one: a
      // daily one whose program would be in share\tasks there, never this folder's runtime. With
      // home.marker it is a TASKS_HOME one with the folder as its root, which reads its current.
      rmSync(join(folder, "manifest.json"));
      rmSync(join(folder, "current"));
      const result = run(versionLocal(root, NEW), ["version"]);
      expect([result.status, result.stdout]).toEqual([70, ""]);
      expect(result.stderr).toMatch(/missing .*\\share$/m);
      writeFileSync(join(folder, "home.marker"), "");
      const marked = run(versionLocal(root, NEW), ["version"]);
      expect([marked.status, marked.stdout]).toEqual([70, ""]);
      expect(marked.stderr).toMatch(/cannot read .*current/);
    });

    test("an install root inside a folder named versions is still a stable install", () => {
      // A TASKS_HOME root whose parent folder happens to be named versions (A2 3.12.3 step 1).
      const root = join(work, "parent", "versions", "home");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "home.marker"), "");
      addVersion(root, OLD, release);
      makeStable(root, OLD, release);
      const ran = launchVersion(stable(root));
      expect(ran.version).toBe(OLD);
      expect(launchArgv(stable(root), []).env["TASKS_LAUNCH_MODE"]).toBe("stable");
    });

    test("--package-info answers before anything is read, even where no install is", () => {
      const bare = join(work, "bare", "bin");
      mkdirSync(bare, { recursive: true });
      for (const exe of [release.tasks, release.tasksw]) {
        const copy = join(bare, exe.endsWith("tasksw.exe") ? "tasksw.exe" : "tasks.exe");
        copyFileSync(exe, copy);
        const info = run(copy, ["--package-info"]);
        expect([info.status, info.stdout, info.stderr]).toEqual([0, "none\n", ""]);
        const extra = run(copy, ["--package-info", "x"]);
        expect(extra.status).toBe(64);
      }
    });
  });
});
