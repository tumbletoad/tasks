// The self-test of lab session 3's cold-start timers (M0.07) and of E01's cleanup. They run against
// a lab install in a temporary folder whose runtime is this Node, and against a stand-in install
// whose bridge gives scripted replies. Nothing here touches the real Run key, a unit, linger or a
// real install. Every process a test starts is stopped before its folder goes.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sha256Hex, type JsonObject } from "../kit/wire.ts";
import { compileLaunchers } from "../packaging/src/msvc.ts";
import { loadPin } from "../packaging/src/node-runtime.ts";
import { assembleVersionFolder } from "../packaging/src/version-folder.ts";
import { assembleLabFolder, buildLab } from "./build.ts";

const WIN = process.platform === "win32";
const HERE = import.meta.dirname;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const POWERSHELL = join(
  process.env["SystemRoot"] ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

let work: string;

beforeAll(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), "ttasks-cold-start-")));
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function until(probe: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** Windows PowerShell 5.1 (or `shell`) running a script file, as the session runs it. */
function powershellFile(script: string, args: string[], timeout = 180_000, shell = POWERSHELL) {
  return spawnSync(
    shell,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
    { encoding: "utf8", timeout, windowsHide: true },
  );
}

function powershellCommand(command: string) {
  return spawnSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });
}

/** PIDs of processes whose image is under `dir` (Windows) or whose command line names it (Linux). */
function pidsUnder(dir: string): number[] {
  if (WIN) {
    const r = powershellCommand(
      `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${dir}\\', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.ProcessId }`,
    );
    return r.stdout
      .split(/\r?\n/)
      .filter((l) => /^\d+$/.test(l.trim()))
      .map(Number);
  }
  const pids: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${name}/cmdline`, "utf8").includes(dir)) pids.push(Number(name));
    } catch {
      // Gone.
    }
  }
  return pids;
}

let scratchCount = 0;
function scratch(label: string): string {
  const dir = join(work, `${label}-${String(++scratchCount)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const LAB_VERSION = "0.0.7-lab.t";

/** Puts this Node at `to`: a hard link or copy on Windows, a symbolic link on Linux. */
function placeNode(to: string): void {
  if (!WIN) {
    symlinkSync(process.execPath, to);
    return;
  }
  try {
    linkSync(process.execPath, to);
  } catch {
    copyFileSync(process.execPath, to);
  }
}

/** A lab install in `root`: the lab entry and kit, this Node as the runtime, stable launchers. */
function makeInstall(root: string, lab: { kit: string; lifecycle: string }): void {
  const fake = join(work, WIN ? "fake-node.exe" : "fake-node");
  writeFileSync(fake, "not a real runtime\n");
  const pin = loadPin();
  const stage = join(work, "stage", "0.0.0-spike");
  assembleVersionFolder(stage, {
    version: "0.0.0-spike",
    build: "test",
    platform: WIN ? "win-x64" : "linux-x64",
    node: { version: pin.version, sqlite: pin.sqlite, binary: fake, license: fake },
    ...(WIN ? { launchers: compileLaunchers(join(work, "launchers")) } : {}),
  });
  mkdirSync(join(root, "versions"), { recursive: true });
  const version = assembleLabFolder(stage, join(root, "versions"), LAB_VERSION, lab);
  const node = join(version, "runtime", WIN ? "node.exe" : "node");
  rmSync(node);
  placeNode(node);
  mkdirSync(join(root, "bin"));
  if (WIN) {
    writeFileSync(join(root, "current"), LAB_VERSION);
    for (const name of ["ttasks.exe", "ttasksw.exe"]) {
      copyFileSync(join(version, "bin", name), join(root, "bin", name));
    }
  } else {
    symlinkSync(`versions/${LAB_VERSION}`, join(root, "current"));
    symlinkSync("../current/bin/ttasks", join(root, "bin", "ttasks"));
  }
  writeFileSync(join(root, "home.marker"), "");
}

// The entry of the scripted install: `mcp` answers the first line on stdin with replies.json's
// "init" and the second with its "status", each verbatim, and ends when stdin closes.
const SCRIPTED_ENTRY = `import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
if (process.argv[2] !== "mcp") process.exit(64);
const replies = JSON.parse(readFileSync(new URL("../../../replies.json", import.meta.url), "utf8"));
const queue = [replies.init, replies.status];
const lines = createInterface({ input: process.stdin });
lines.on("line", () => {
  const next = queue.shift();
  if (next !== undefined) process.stdout.write(next + "\\n");
});
lines.on("close", () => process.exit(0));
`;

/**
 * An install with the lab install's launcher and this Node, whose entry is the scripted bridge.
 * It has no service, so its bridge is always measured as offline.
 */
function makeScriptedInstall(root: string, lab: string): void {
  const version = join(root, "versions", LAB_VERSION);
  for (const dir of ["runtime", "lib", "bin"]) mkdirSync(join(version, dir), { recursive: true });
  mkdirSync(join(root, "bin"));
  placeNode(join(version, "runtime", WIN ? "node.exe" : "node"));
  writeFileSync(join(version, "lib", "ttasks.mjs"), SCRIPTED_ENTRY);
  if (WIN) {
    writeFileSync(join(root, "current"), LAB_VERSION);
    copyFileSync(join(lab, "bin", "ttasks.exe"), join(root, "bin", "ttasks.exe"));
  } else {
    copyFileSync(
      join(lab, "versions", LAB_VERSION, "bin", "ttasks"),
      join(version, "bin", "ttasks"),
    );
    chmodSync(join(version, "bin", "ttasks"), 0o755);
    symlinkSync(`versions/${LAB_VERSION}`, join(root, "current"));
    symlinkSync("../current/bin/ttasks", join(root, "bin", "ttasks"));
  }
}

function readRecords(file: string): JsonObject[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as JsonObject);
}

/** A state folder whose service.json names a live process (`pid`) that is not the service. */
function staleState(endpoint: string, pid = process.pid): string {
  const state = scratch("stale");
  writeFileSync(join(state, "ipc.key"), randomBytes(32));
  writeFileSync(
    join(state, "service.json"),
    `${JSON.stringify({
      format: 1,
      instance: "staleinstance0000000000",
      install: "0000000000000000",
      pid,
      state: "ready",
      endpoint: { kind: WIN ? "pipe" : "unix", path: endpoint },
      runtime: WIN ? "pipe" : "state",
      http: { port: 1, moved: false },
      protocols: [1],
    })}\n`,
  );
  return state;
}

/** An endpoint path nothing listens on. */
const noEndpoint = () =>
  WIN
    ? `\\\\.\\pipe\\ttasks-cold-start-none-${randomBytes(6).toString("hex")}`
    : join(work, `none-${randomBytes(4).toString("hex")}.sock`);

// The real offline answer of the forwarder, and a valid initialize reply.
const INIT_OK =
  '{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"ttasks","version":"0.0.7"}}}';
const STATUS_OFFLINE =
  '{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"Tasks\'s service is not running on this machine. Nothing was saved."}],"isError":true}}';

describe("[A7.3.7.m0-session3.cold-start] the cold-start timers and E01 against a lab install", () => {
  let root: string;
  let js: { kit: string; lifecycle: string };
  const silent = new Set<net.Server>();

  beforeAll(() => {
    js = buildLab(join(work, "lab-js"));
    root = join(work, "root");
    makeInstall(root, js);
  }, 600_000);

  afterAll(async () => {
    for (const server of silent) await new Promise((resolve) => server.close(resolve));
    if (process.platform === "linux" && process.getuid !== undefined) {
      const state = join(root, "state", "service");
      if (existsSync(state)) {
        const dir = `/run/user/${String(process.getuid())}/ttasks-${sha256Hex(realpathSync.native(state)).slice(0, 16)}`;
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  /** A listener that accepts connections and never answers, so a bridge's handshake hangs. */
  async function silentEndpoint(onConnection: () => void = () => undefined): Promise<string> {
    const path = WIN
      ? `\\\\.\\pipe\\ttasks-cold-start-silent-${randomBytes(6).toString("hex")}`
      : join(scratch("silent"), "s.sock");
    const server = net.createServer((socket) => {
      socket.on("error", () => undefined);
      onConnection();
    });
    silent.add(server);
    await new Promise<void>((resolve) => server.listen(path, resolve));
    return path;
  }

  function coldStart(
    out: string,
    metric: string,
    options: {
      state?: string;
      limit?: number;
      failAt?: string;
      interpreter?: string;
      install?: string;
    } = {},
  ) {
    const install = options.install ?? root;
    if (WIN) {
      return powershellFile(
        join(HERE, "cold-start.ps1"),
        [
          "-Root",
          install,
          "-Out",
          out,
          "-Label",
          "self-test",
          "-Metric",
          metric,
          ...(options.state === undefined ? [] : ["-State", options.state]),
          ...(options.limit === undefined ? [] : ["-Limit", String(options.limit)]),
          ...(options.failAt === undefined ? [] : ["-FailAt", options.failAt]),
        ],
        180_000,
        options.interpreter,
      );
    }
    return spawnSync(
      "sh",
      [
        join(HERE, "cold-start.sh"),
        install,
        out,
        "self-test",
        metric,
        ...(options.state === undefined ? [] : [options.state]),
      ],
      {
        encoding: "utf8",
        timeout: 120_000,
        env: {
          ...process.env,
          ...(options.limit === undefined ? {} : { COLD_START_LIMIT_S: String(options.limit) }),
          ...(options.failAt === undefined ? {} : { COLD_START_FAIL_AT: options.failAt }),
        },
      },
    );
  }

  /** No process runs from the install and the timer left no temporary folder. */
  async function expectNothingLeft(install = root): Promise<void> {
    await until(() => pidsUnder(install).length === 0, 15_000, "the install's processes to end");
    const leftovers = existsSync(join(install, "state"))
      ? readdirSync(join(install, "state")).filter((n) => n.startsWith("cold."))
      : [];
    expect(leftovers).toEqual([]);
  }

  // Windows: under Windows PowerShell 5.1, and under PowerShell 7 where it is installed.
  const PWSH = WIN
    ? spawnSync("where.exe", ["pwsh"], { encoding: "utf8", windowsHide: true })
        .stdout.split(/\r?\n/)
        .find((l) => l.trim() !== "")
        ?.trim()
    : undefined;
  const SHELLS: [string, string | undefined][] = WIN
    ? [
        ["Windows PowerShell 5.1", undefined],
        ...(PWSH === undefined ? [] : [["PowerShell 7", PWSH] as [string, string]]),
      ]
    : [["sh", undefined]];
  test.each(SHELLS)(
    "warm: offline, online and shim count only the answers their metric needs (%s)",
    async (_label, shell) => {
      const out = join(scratch("cold"), "warm.jsonl");
      const r = coldStart(out, "all", shell === undefined ? {} : { interpreter: shell });
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
      const lines = readRecords(out);
      expect(lines.map((l) => [l["metric"], l["ok"], l["answer"]])).toEqual([
        ["forwarder_offline", true, "offline"],
        ["forwarder_online", true, "service"],
        ["shim_claim", true, "service"],
      ]);
      expect(lines[1]?.["service_running_before"]).toBe(true);
      // It stopped the service it started.
      expect(existsSync(join(root, "state", "service", "service.json"))).toBe(false);
      await expectNothingLeft();
    },
    180_000,
  );

  test("a stale service.json naming a live process is not a running service: offline answer, not counted", async () => {
    const out = join(scratch("cold"), "stale.jsonl");
    const state = staleState(noEndpoint());
    const r = coldStart(out, "online", { state });
    expect(r.status, r.stderr).toBe(0);
    expect(readRecords(out)).toEqual([
      expect.objectContaining({
        metric: "forwarder_online",
        ok: false,
        service_running_before: false,
        answer: "offline",
        note: "offline answer, not counted",
      }),
    ]);
    await expectNothingLeft();
  }, 120_000);

  test("a process of the install's own runtime with another entry is not the service", async () => {
    const version = join(root, "versions", LAB_VERSION);
    const idle = join(version, "lib", "idle.mjs");
    writeFileSync(idle, "setInterval(() => undefined, 1000);\n");
    // The same runtime, the same flag, a `service` argument: only the entry differs.
    const child = spawn(
      join(version, "runtime", WIN ? "node.exe" : "node"),
      ["--report-exclude-env", idle, "service", "--state", join(work, "unused")],
      { stdio: "ignore", windowsHide: true },
    );
    const exit = new Promise((resolve) => child.once("exit", resolve));
    try {
      const pid = child.pid;
      if (pid === undefined) throw new Error("the idle process did not start");
      await until(() => pidsUnder(root).includes(pid), 30_000, "the idle process");
      const out = join(scratch("cold"), "entry.jsonl");
      const state = staleState(noEndpoint(), pid);
      const r = coldStart(out, "online", { state });
      expect(r.status, r.stderr).toBe(0);
      expect(readRecords(out)).toEqual([
        expect.objectContaining({
          metric: "forwarder_online",
          ok: false,
          service_running_before: false,
          answer: "offline",
          note: "offline answer, not counted",
        }),
      ]);
    } finally {
      child.kill();
      await exit;
      rmSync(idle, { force: true });
    }
    await expectNothingLeft();
  }, 120_000);

  describe("replies are checked by structure after the clock stops", () => {
    let scripted: string;

    beforeAll(() => {
      scripted = join(work, "scripted");
      makeScriptedInstall(scripted, root);
    });

    function measure(init: string, status: string): JsonObject[] {
      writeFileSync(join(scripted, "replies.json"), JSON.stringify({ init, status }));
      const out = join(scratch("scripted"), "scripted.jsonl");
      const r = coldStart(out, "offline", { install: scripted, limit: 10 });
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
      return readRecords(out);
    }

    test("control: the forwarder's own replies count as an offline first launch", async () => {
      expect(measure(INIT_OK, STATUS_OFFLINE)).toEqual([
        expect.objectContaining({
          metric: "forwarder_offline",
          ok: true,
          answer: "offline",
          note: "offline first launch",
        }),
      ]);
      await expectNothingLeft(scripted);
    }, 120_000);

    test.each([
      [
        "a malformed (cut off) initialize reply",
        '{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25","serverInfo":{"name":"ttasks"',
      ],
      [
        "the right fragments in the wrong structure",
        '{"jsonrpc":"2.0","id":5,"result":{"inner":{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25","serverInfo":{"name":"ttasks"}}}}}',
      ],
      [
        "a string id",
        '{"jsonrpc":"2.0","id":"0","result":{"protocolVersion":"2025-11-25","serverInfo":{"name":"ttasks"}}}',
      ],
    ])(
      "%s is not counted",
      async (_label, init) => {
        expect(measure(init, STATUS_OFFLINE)).toEqual([
          expect.objectContaining({
            metric: "forwarder_offline",
            ok: false,
            answer: "none",
            note: "no valid initialize reply within 10 s, not counted",
          }),
        ]);
        await expectNothingLeft(scripted);
      },
      120_000,
    );

    test.each([
      [
        "a notification that says not running",
        '{"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"Tasks\'s service is not running"}}',
      ],
      ["a reply to another request", STATUS_OFFLINE.replace('"id":1', '"id":7')],
      [
        "a successful result whose text says not running",
        STATUS_OFFLINE.replace(',"isError":true', ""),
      ],
    ])(
      "after a valid initialize, %s is not an offline answer",
      async (_label, status) => {
        expect(measure(INIT_OK, status)).toEqual([
          expect.objectContaining({
            metric: "forwarder_offline",
            ok: false,
            answer: "unknown",
            note: "the answer named no expected service, not counted",
          }),
        ]);
        await expectNothingLeft(scripted);
      },
      120_000,
    );
  });

  test("a bridge that never answers is stopped at the limit and its measurement does not count", async () => {
    const out = join(scratch("cold"), "hang.jsonl");
    const state = staleState(await silentEndpoint());
    const t0 = Date.now();
    const r = coldStart(out, "offline", { state, limit: 2 });
    expect(r.status, r.stderr).toBe(0);
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(readRecords(out)).toEqual([
      expect.objectContaining({ metric: "forwarder_offline", ok: false, answer: "none" }),
    ]);
    await expectNothingLeft();
  }, 120_000);

  test("a failure right after starting the service stops it and leaves no process", async () => {
    const out = join(scratch("cold"), "fail.jsonl");
    const r = coldStart(out, "all", { failAt: "service-started" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("on purpose");
    expect(readRecords(out).map((l) => l["metric"])).toEqual(["forwarder_offline"]);
    await expectNothingLeft();
  }, 120_000);

  test.skipIf(WIN)(
    "a TERM signal while the bridge hangs stops the bridge and the watchdog at once",
    async () => {
      const out = join(scratch("cold"), "term.jsonl");
      let connected = false;
      const state = staleState(
        await silentEndpoint(() => {
          connected = true;
        }),
      );
      const child = spawn(
        "sh",
        [join(HERE, "cold-start.sh"), root, out, "self-test", "offline", state],
        {
          stdio: "ignore",
        },
      );
      const exit = new Promise<number | null>((resolve) => child.once("exit", resolve));
      await until(() => connected, 30_000, "the bridge's connection");
      const t0 = Date.now();
      child.kill("SIGTERM");
      expect(await exit).toBe(143);
      expect(Date.now() - t0).toBeLessThan(10_000);
      await expectNothingLeft();
    },
    60_000,
  );

  test.skipIf(!WIN)(
    "E01 that fails after the service started through ttasksw.exe stops the supervisor and the service",
    () => {
      const out = join(scratch("e01"), "e01.json");
      // A service.json left by an earlier test's killed service would be read as this service's.
      rmSync(join(root, "state", "service", "service.json"), { force: true });
      // "a b" is not a tool name: the snapshot call fails after the service is up.
      const r = spawnSync(
        process.execPath,
        [
          join(js.lifecycle, "lab.mjs"),
          "e01",
          "--root",
          root,
          "--out",
          out,
          "--tool",
          "a b",
          "--start",
          "direct",
        ],
        { encoding: "utf8", timeout: 120_000, windowsHide: true },
      );
      expect(r.status, r.stderr).toBe(1);
      expect(r.stderr).toContain("lab e01:");
      expect(existsSync(out)).toBe(false);
      // The harness stopped them before it returned.
      expect(pidsUnder(root)).toEqual([]);
    },
    180_000,
  );
});
