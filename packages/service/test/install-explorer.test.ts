// `ttasks service start` through Explorer for real (A2 3.3.5, 3.5 rule 5):
// a test install in a temporary folder, with the release launchers built from this checkout, Node
// as its runtime and the product's own `ttasks serve` as its entry. The start goes through the
// shell's Explorer, as the Run value does at sign-in: the supervisor's parent is Explorer, it is
// outside this process's tree, and no job it is in kills it when the job closes. No registry value
// is written: the context's registry root is a key that does not exist. Windows only, signed in
// with Explorer running, not elevated (the service refuses an elevated start, and CI's runners
// are elevated) and with the C build tools.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isAgentMarker } from "@ttasks/bridge/protocol";
import { buildLaunchers, compileC, findMsvc, type Msvc } from "@ttasks/launcher-win/build";
import { afterAll, describe, expect, test } from "vitest";
import { detectIdentity, system32 } from "../src/hub/identity.ts";
import { explorerInSession, startService, stopService } from "../src/install/commands.ts";
import { defaultServiceContext, type ServiceContext } from "../src/install/context.ts";
import { MAIN } from "./harness.ts";

const windows = process.platform === "win32";
const VERSION = "1.0.0";
/** JOBOBJECT_BASIC_LIMIT_INFORMATION.LimitFlags: the job ends its processes when it closes. */
const KILL_ON_JOB_CLOSE = 0x2000;

interface Proc {
  readonly pid: number;
  readonly ppid: number;
  readonly name: string;
  readonly path: string | null;
}

/**
 * Runs a script in Windows PowerShell 5.1, part of every Windows, encoded so nothing is re-quoted.
 * Every error stops the script and fails the call: a CIM query that was refused never reads as an
 * empty list.
 */
function powershell(script: string): string {
  const result = spawnSync(
    join(system32() ?? "C:\\Windows\\System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(`$ErrorActionPreference = 'Stop'\n${script}`, "utf16le").toString("base64"),
    ],
    { encoding: "utf8", windowsHide: true, timeout: 60_000 },
  );
  if (result.status !== 0) throw new Error(`the process query failed: ${result.stderr}`);
  return result.stdout;
}

/** A process, its parent and its grandparent, from CIM. */
function lineage(pid: number): Proc[] {
  return JSON.parse(
    powershell(`
$id = ${String(pid)}
$out = @()
for ($i = 0; $i -lt 3; $i++) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id"
  if ($null -eq $p) { break }
  $out += [pscustomobject]@{ pid = [int]$id; ppid = [int]$p.ParentProcessId; name = $p.Name; path = $p.ExecutablePath }
  $id = $p.ParentProcessId
}
ConvertTo-Json -Compress -InputObject $out
`),
  ) as Proc[];
}

/**
 * The processes whose program lies in this test's folder: what it started through Explorer
 * (ttasksw.exe, the service's node.exe, jobinfo.exe), supervisors first.
 */
function startedHere(folder: string): Proc[] {
  const prefix = `${folder.toLowerCase()}\\`;
  const listed = JSON.parse(
    powershell(
      "ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = $_.Name; path = $_.ExecutablePath } })",
    ),
  ) as Proc[];
  const supervisor = (p: Proc) => Number(p.name.toLowerCase() === "ttasksw.exe");
  return listed
    .filter((p) => p.path?.toLowerCase().startsWith(prefix) === true)
    .sort((a, b) => supervisor(b) - supervisor(a));
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

let dir = "";
let started: ServiceContext | undefined;

afterAll(async () => {
  if (dir === "") return;
  // What a failure left running from this test's folder. First the service's own stop: it exits
  // 0, so the supervisor stops too. Then whatever still runs from the folder, the supervisor first
  // so it cannot start the service again. A process list that cannot be read fails the run, and
  // so does a process that is still there afterwards.
  if (started !== undefined) {
    try {
      await stopService(started);
    } catch {
      // Not running, or not answering: the process list below decides.
    }
  }
  let left: Proc[] = startedHere(dir);
  for (let round = 0; left.length > 0 && round < 50; round += 1) {
    for (const p of left) {
      try {
        process.kill(p.pid);
      } catch {
        // Gone meanwhile.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    left = startedHere(dir);
  }
  if (left.length > 0) {
    throw new Error(`still running from the test folder: ${left.map((p) => p.name).join(", ")}`);
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}, 120_000);

/** Compiles test/fixtures/jobinfo.c with the launchers' MSVC. */
function compileJobInfo(msvc: Msvc, outDir: string): string {
  return compileC(msvc, {
    source: fileURLToPath(new URL("./fixtures/jobinfo.c", import.meta.url)),
    out: join(outDir, "jobinfo.exe"),
    compile: ["/W4", "/WX", "/MT", "/DUNICODE", "/D_UNICODE"],
    link: [],
  });
}

/**
 * A test install: the release launchers, Node as the runtime, and an entry that runs the product's
 * `ttasks serve` after starting jobinfo.exe detached, which writes the service's job into job.json.
 */
function testInstall(msvc: Msvc): { root: string; ctx: ServiceContext } {
  // A comma, which Explorer's command line treats as a separator unless it is quoted.
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ttasks-svc,explorer-")));
  const root = join(dir, "kh");
  const build = join(dir, "build");
  const launchers = buildLaunchers(build, { msvc });
  const version = join(root, "versions", VERSION);
  for (const sub of ["bin", "runtime", "lib"]) mkdirSync(join(version, sub), { recursive: true });
  mkdirSync(join(root, "bin"));
  for (const bin of [join(root, "bin"), join(version, "bin")]) {
    copyFileSync(launchers.ttasks, join(bin, "ttasks.exe"));
    copyFileSync(launchers.ttasksw, join(bin, "ttasksw.exe"));
  }
  copyFileSync(compileJobInfo(msvc, build), join(version, "bin", "jobinfo.exe"));
  try {
    linkSync(realpathSync.native(process.execPath), join(version, "runtime", "node.exe"));
  } catch {
    copyFileSync(realpathSync.native(process.execPath), join(version, "runtime", "node.exe"));
  }
  writeFileSync(
    join(version, "lib", "ttasks.mjs"),
    [
      "// Test entry: `serve` runs the product's service from the checkout, after jobinfo.exe.",
      'import { spawn } from "node:child_process";',
      'import { fileURLToPath } from "node:url";',
      'if (process.argv[2] !== "serve") process.exit(2);',
      'const bin = fileURLToPath(new URL("../bin/", import.meta.url));',
      'spawn(`${bin}jobinfo.exe`, [`${process.env.TTASKS_ROOT}\\\\job.json`], { detached: true, stdio: "ignore", windowsHide: true }).unref();',
      `await import(${JSON.stringify(pathToFileURL(MAIN).href)});`,
      "",
    ].join("\n"),
  );
  writeFileSync(join(version, "manifest.json"), `${JSON.stringify({ version: VERSION })}\n`);
  writeFileSync(join(root, "current"), VERSION);
  writeFileSync(join(root, "home.marker"), "");
  // A person's terminal: no agent marker, so the stop is the operator's (A2 3.6.5).
  const env: Record<string, string | undefined> = { TTASKS_HOME: root };
  for (const [name, value] of Object.entries(process.env)) {
    if (!isAgentMarker(name) && !name.toUpperCase().startsWith("TTASKS_")) env[name] = value;
  }
  const real = defaultServiceContext({ env: { ...env, TTASKS_HOME: root } });
  const ctx: ServiceContext = {
    ...real,
    // A key that does not exist: nothing reads or writes the real Run key.
    roots: {
      ...real.roots,
      registryRoot: `HKCU\\Software\\ttasks-test-absent-${randomBytes(6).toString("hex")}`,
    },
  };
  return { root, ctx };
}

function buildTools(): Msvc | undefined {
  try {
    return findMsvc();
  } catch {
    return undefined;
  }
}

describe.skipIf(!windows)(
  "[A2.3.3.5.service-install.commands] start through Explorer, for real, on a signed-in desktop",
  () => {
    test("Explorer starts ttasksw.exe outside this process's tree, in no job that kills it on close; stop ends service and supervisor", async (context) => {
      const msvc = buildTools();
      if (detectIdentity().elevated !== false || msvc === undefined) context.skip();
      const { root, ctx } = testInstall(msvc as Msvc);
      if (!(await explorerInSession(ctx))) context.skip();
      // The test's process list must be readable before anything starts, so the cleanup can see.
      expect(startedHere(dir)).toEqual([]);

      started = ctx;
      const start = await startService(ctx);
      expect(start).toMatchObject({ outcome: "started", via: "explorer" });
      expect(start.status.manager).toBe("ttasksw");
      expect(start.status.install_id).toBe(ctx.installId);

      const [node, ttasksw, shell] = lineage(start.status.pid);
      expect(node?.name.toLowerCase()).toBe("node.exe");
      expect(ttasksw?.name.toLowerCase()).toBe("ttasksw.exe");
      expect(ttasksw?.path?.toLowerCase()).toBe(join(root, "bin", "ttasksw.exe").toLowerCase());
      // The shell's Explorer is the parent, as at sign-in: not this test, and not the
      // explorer.exe this start ran (it handed the start to the shell and exited).
      expect(shell?.name.toLowerCase()).toBe("explorer.exe");
      expect(shell?.pid).not.toBe(process.pid);
      // Explorer puts what it starts in a job of its own. That job must not end the service or
      // its supervisor when it closes. The service shares the supervisor's job: ttasksw.exe makes
      // none (A2 3.3.2), and jobinfo.exe shares the service's.
      const jobFile = join(root, "job.json");
      await until(() => existsSync(jobFile), 30_000);
      const job = JSON.parse(readFileSync(jobFile, "utf8")) as {
        inJob: boolean;
        flags: number | null;
      };
      // On Windows 11 Explorer's job has BREAKAWAY_OK (0x800) only.
      if (job.inJob) {
        expect(job.flags).not.toBeNull();
        expect((job.flags ?? KILL_ON_JOB_CLOSE) & KILL_ON_JOB_CLOSE).toBe(0);
      }
      // jobinfo.exe reads only the immediate job. A job Explorer makes nests inside Explorer's own
      // jobs, so with Explorer in none, the immediate job is the whole chain and nothing above it
      // can kill the service on close.
      const shellFile = join(root, "shell-job.json");
      const asked = spawnSync(
        join(root, "versions", VERSION, "bin", "jobinfo.exe"),
        ["--pid", String(shell?.pid ?? 0), shellFile],
        { windowsHide: true, timeout: 30_000 },
      );
      expect(asked.status).toBe(0);
      expect(JSON.parse(readFileSync(shellFile, "utf8"))).toEqual({ inJob: false });

      const stop = await stopService(ctx);
      expect(stop).toEqual({ outcome: "stopped", via: "shutdown" });
      // stop returns once the service's process has ended, not only its endpoint.
      expect(alive(start.status.pid)).toBe(false);
      // The service exited 0, so the supervisor stops too (A2 3.3.1).
      await until(() => ttasksw === undefined || !alive(ttasksw.pid), 15_000);
      expect(ttasksw !== undefined && alive(ttasksw.pid)).toBe(false);
      started = undefined;
    }, 180_000);
  },
);
