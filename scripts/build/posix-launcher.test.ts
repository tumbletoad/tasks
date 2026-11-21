// The POSIX launcher `bin/ttasks` (A2 3.12.3), on Linux and macOS:
// hostile arguments reach Node unchanged, the caller's NODE_ variables (but NODE_EXTRA_CA_CERTS)
// and OpenSSL's loader settings never do, TTASKS_HOME comes from the location only, and exit codes
// pass through, called by its own path in a version folder and through bin/ttasks -> current. The
// runtime is a link to the Node that runs the tests; the entry is a stub that reports what it got.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { POSIX_LAUNCHER } from "./launchers.ts";

const posix = process.platform !== "win32";
const VERSION = "0.1.0-dev.9";

const STUB = `const [command, ...rest] = process.argv.slice(2);
if (command === "exit") process.exit(Number(rest[0]));
const shown = /^(NODE_|node_|OPENSSL_|TTASKS_|SSL_CERT_|HTTPS?_PROXY$|MULTI)/;
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => shown.test(name)));
process.stdout.write(JSON.stringify({ args: rest, execArgv: process.execArgv, env }));
`;

let work: string;
let root: string;
let versionLauncher: string;
let stableLauncher: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "ttasks-posix-launcher-"));
  root = join(work, "root");
  if (!posix) return;
  const folder = join(root, "versions", VERSION);
  for (const dir of ["bin", "runtime", "lib"]) mkdirSync(join(folder, dir), { recursive: true });
  versionLauncher = join(folder, "bin", "ttasks");
  writeFileSync(versionLauncher, POSIX_LAUNCHER);
  chmodSync(versionLauncher, 0o755);
  symlinkSync(process.execPath, join(folder, "runtime", "node"));
  writeFileSync(join(folder, "lib", "ttasks.mjs"), STUB);
  writeFileSync(join(root, "home.marker"), "");
  symlinkSync(`versions/${VERSION}`, join(root, "current"));
  mkdirSync(join(root, "bin"));
  stableLauncher = join(root, "bin", "ttasks");
  symlinkSync("../current/bin/ttasks", stableLauncher);
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

interface Seen {
  args: string[];
  execArgv: string[];
  env: Record<string, string>;
}

const BASE = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: process.env["HOME"] ?? "/" };

function launch(launcher: string, args: readonly string[], env: Record<string, string> = {}) {
  const result = spawnSync(launcher, ["argv", ...args], {
    env: { ...BASE, ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Seen;
}

const HOSTILE = [
  "plain",
  "two words",
  "",
  " ",
  '"quoted"',
  "'single'",
  "back\\slash\\",
  "\\\\server\\share",
  "$HOME",
  "${PATH}",
  "$(id)",
  "`id`",
  "*",
  "?",
  "[ab]",
  "~",
  "a;b",
  "a&&b",
  "a|b",
  "<in >out 2>&1",
  "%PATH%",
  "^&|<>",
  "tab\there",
  "new\nline",
  "-n",
  "--",
  "--require=/tmp/x.js",
  "emoji 😀",
  "é combining",
  "שלום right-to-left",
  "IFS=x",
  "line\r\nend",
];

describe.runIf(posix)("[A2.3.12.3.build.posix-launcher] the POSIX launcher bin/ttasks", () => {
  test("hostile arguments reach Node unchanged, by its own path and through current", () => {
    for (const launcher of [versionLauncher, stableLauncher]) {
      const seen = launch(launcher, HOSTILE);
      expect(seen.args).toEqual(HOSTILE);
      expect(seen.execArgv).toEqual(["--report-exclude-env"]);
    }
  });

  test("no NODE_ variable but NODE_EXTRA_CA_CERTS and no OpenSSL loader setting reaches Node", () => {
    const seen = launch(stableLauncher, [], {
      NODE_OPTIONS: "--require /nonexistent/ttasks-test-preload.js",
      NODE_DEBUG: "child_process",
      NODE_COMPILE_CACHE: join(work, "should-not-exist"),
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      NODE_EXTRA_CA_CERTS_TOO: "x",
      NODE_EXTRA_CA_CERTS: "/fixture/ca.pem",
      node_options: "lowercase is not Node's",
      OPENSSL_CONF: "/fixture/openssl.cnf",
      OPENSSL_CONF_INCLUDE: "/fixture",
      OPENSSL_MODULES: "/fixture",
      OPENSSL_ENGINES: "/fixture",
      SSL_CERT_FILE: "/fixture/certs.pem",
      HTTPS_PROXY: "http://proxy.example:3128",
      // A value over several lines that looks like more exported variables.
      MULTI: "first\nexport NODE_PATH='/evil'\nexport HTTPS_PROXY=fake\nNODE_X Y=z\n",
      // A name that is no shell identifier must not end the script. Whether the shell passes it
      // on is its own affair (dash drops it, bash keeps it); Node reads no such name.
      "NODE_NOT-AN-IDENTIFIER": "no variable Node reads",
    });
    const { "NODE_NOT-AN-IDENTIFIER": odd, ...rest } = seen.env;
    expect([undefined, "no variable Node reads"]).toContain(odd);
    expect(rest).toEqual({
      NODE_EXTRA_CA_CERTS: "/fixture/ca.pem",
      node_options: "lowercase is not Node's",
      SSL_CERT_FILE: "/fixture/certs.pem",
      HTTPS_PROXY: "http://proxy.example:3128",
      MULTI: "first\nexport NODE_PATH='/evil'\nexport HTTPS_PROXY=fake\nNODE_X Y=z\n",
      TTASKS_HOME: root,
    });
  });

  test("TTASKS_HOME comes from the location only, and the Windows launchers' variables are removed", () => {
    const caller = {
      TTASKS_HOME: "/elsewhere",
      TTASKS_ROOT: "/elsewhere",
      TTASKS_LAUNCHER: "x",
      TTASKS_LAUNCH_MODE: "stable",
      TTASKS_PACKAGE: "Fake.Package_1.0_x64__abc",
      TTASKS_SERVICE_MANAGER: "systemd",
    };
    expect(launch(versionLauncher, [], caller).env).toEqual({
      TTASKS_HOME: root,
      TTASKS_SERVICE_MANAGER: "systemd",
    });
    rmSync(join(root, "home.marker"));
    try {
      expect(launch(stableLauncher, [], caller).env).toEqual({ TTASKS_SERVICE_MANAGER: "systemd" });
    } finally {
      writeFileSync(join(root, "home.marker"), "");
    }
  });

  test("a shell that inherits tracing or functions prints nothing of the environment or arguments and runs as written", () => {
    // /bin/sh is bash on Fedora and macOS. Bash takes SHELLOPTS (xtrace: every expanded command on
    // stderr, which agent apps log) and exported functions from the environment before the first
    // line runs; dash takes neither. Both are checked: the system's sh and bash started as sh.
    const shells = [["/bin/sh"]];
    const bash = ["/bin/bash", "/usr/bin/bash"].find((path) => existsSync(path));
    if (bash !== undefined) {
      const sh = join(work, "bash-as-sh", "sh");
      if (!existsSync(sh)) {
        mkdirSync(join(work, "bash-as-sh"));
        symlinkSync(bash, sh);
      }
      shells.push([sh]);
    }
    const secret = "fixture-secret-never-traced";
    const argument = "fixture task text never traced";
    for (const [shell] of shells) {
      const result = spawnSync(shell ?? "/bin/sh", [stableLauncher, "argv", argument], {
        env: {
          ...BASE,
          SHELLOPTS: "xtrace:verbose",
          FIXTURE_TOKEN: secret,
          NODE_OPTIONS: `--title=${secret}`,
          "BASH_FUNC_readlink%%": "() { echo /nonexistent/bin/ttasks; }",
        },
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(result.status, `${String(shell)}: ${result.stderr}`).toBe(0);
      expect(result.stderr, String(shell)).not.toContain(secret);
      expect(result.stderr, String(shell)).not.toContain(argument);
      const seen = JSON.parse(result.stdout) as Seen;
      expect(seen.args, String(shell)).toEqual([argument]);
      expect(seen.env, String(shell)).toEqual({ TTASKS_HOME: root });
    }
  });

  test("Node's exit code reaches the caller", () => {
    for (const code of [0, 1, 7, 70, 130]) {
      const result = spawnSync(stableLauncher, ["exit", String(code)], {
        env: BASE,
        timeout: 30_000,
      });
      expect(result.status).toBe(code);
    }
  });
});
