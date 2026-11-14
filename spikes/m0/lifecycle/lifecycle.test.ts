// The self-test of the M0.07 lab additions (A7 3.7, rows S03, S08, E01 and lab session 3): the
// forwarder's reconnect, the service's environment snapshot and its parsers, the tasksw.exe
// supervisor stand-in, the lab release folder and its entry, and the POSIX cold-start supervisor.
// Fixture text only. Every process a test starts is stopped before its folder is removed.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildKit } from "../kit/build.ts";
import { startService, type RunningService } from "../kit/service.ts";
import {
  buildSnapshot,
  expandWindows,
  mergeLayers,
  parseEnvBlock,
  parseRegQuery,
  parseSessionEnvironment,
  resolveTool,
  snapshotDifferences,
  windowsRegistryEnvironment,
} from "../kit/snapshot.ts";
import {
  LineReader,
  RpcClient,
  clientInfo,
  connect,
  parseObject,
  sha256Hex,
  type JsonObject,
} from "../kit/wire.ts";
import { assembleVersionFolder, verifyVersionFolder } from "../packaging/src/version-folder.ts";
import { assembleLabFolder, buildLab } from "./build.ts";
import { decide, supervise, type SupervisorIO } from "./supervisor.ts";

const WIN = process.platform === "win32";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let work: string;
let js: string;
const children = new Set<ChildProcess>();
const services = new Set<RunningService>();

beforeAll(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), "tasks-lifecycle-")));
  js = buildKit(join(work, "kit-js"));
});

afterAll(async () => {
  for (const child of children) {
    child.kill("SIGKILL");
  }
  for (const service of services) await service.close();
  await sleep(200);
  // The per-user runtime folders of this test's state folders (Linux), if they are empty now.
  if (process.platform === "linux" && process.getuid !== undefined) {
    for (const name of ["state-r", "state-d", "state-s", "cold/root/state/service"]) {
      const state = join(work, name);
      if (!existsSync(state)) continue;
      const dir = `/run/user/${String(process.getuid())}/tasks-${sha256Hex(realpathSync.native(state)).slice(0, 16)}`;
      rmSync(dir, { recursive: true, force: true });
    }
  }
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** An MCP client on a child's stdio: one request at a time, replies by ID. */
class StdioClient {
  readonly child: ChildProcess;
  #next = 1;
  readonly #pending = new Map<number, (msg: JsonObject) => void>();

  constructor(file: string, args: string[], env?: NodeJS.ProcessEnv) {
    this.child = spawn(file, args, {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      ...(env === undefined ? {} : { env }),
    });
    children.add(this.child);
    this.child.once("exit", () => children.delete(this.child));
    const stdout = this.child.stdout;
    if (stdout === null) throw new Error("no stdout");
    new LineReader(stdout).pipe((line) => {
      const msg = parseObject(line);
      const id = msg?.["id"];
      if (msg === undefined || typeof id !== "number") return;
      this.#pending.get(id)?.(msg);
      this.#pending.delete(id);
    });
  }

  request(method: string, params: JsonObject = {}): Promise<JsonObject> {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`no reply to ${method}`));
      }, 15_000);
      this.#pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  initialize(): Promise<JsonObject> {
    return this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "lifecycle-self-test", version: "1" },
    });
  }

  /** The instance that answered `status`, or the offline text's kind. */
  async status(): Promise<string> {
    const reply = await this.request("tools/call", { name: "status", arguments: {} });
    const result = reply["result"] as JsonObject | undefined;
    const content = result?.["content"] as JsonObject[] | undefined;
    const text = typeof content?.[0]?.["text"] === "string" ? content[0]["text"] : "";
    const parsed = parseObject(text);
    if (typeof parsed?.["instance"] === "string") return parsed["instance"];
    return /not running/.test(text) ? "offline" : "lost";
  }

  async end(): Promise<number | null> {
    const exited = new Promise<number | null>((resolve) => this.child.once("exit", resolve));
    this.child.stdin?.end();
    return Promise.race([exited, sleep(5000).then(() => -1)]);
  }
}

async function untilInstance(client: StdioClient, instance: string, ms: number): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if ((await client.status()) === instance) return Date.now() - started;
    await sleep(100);
  }
  throw new Error("the forwarder did not reconnect");
}

describe("[A7.3.7.m0-lifecycle.self-test] the M0.07 lifecycle lab", () => {
  test("the forwarder with --reconnect binds when the service starts, replays initialize and survives restarts", async () => {
    const state = join(work, "state-r");
    const client = new StdioClient(process.execPath, [
      join(js, "forwarder.mjs"),
      "--state",
      state,
      "--reconnect",
    ]);
    const init = await client.initialize();
    expect((init["result"] as JsonObject)["protocolVersion"]).toBe("2025-11-25");
    expect(await client.status()).toBe("offline");

    const a = await startService({ state });
    services.add(a);
    await untilInstance(client, a.info.instance, 10_000);
    // The reconnect carried the client's initialize as mcp_init: the service saw it, no reply.
    expect(a.events.some((e) => e.kind === "mcp" && e["method"] === "initialize")).toBe(true);

    await a.close();
    services.delete(a);
    expect(["offline", "lost"]).toContain(await client.status());
    const b = await startService({ state });
    services.add(b);
    await untilInstance(client, b.info.instance, 10_000);
    expect(b.info.instance).not.toBe(a.info.instance);

    // Without a client the forwarder leaves at once: no retry timer keeps it alive.
    await b.close();
    services.delete(b);
    expect(await client.end()).toBe(0);
  }, 60_000);

  test("the forwarder with --reconnect replays an initialize that arrives while a reconnect's handshake waits", async () => {
    const state = join(work, "state-d");
    // No initialize yet: the forwarder starts offline and retries after 0.5 s.
    const client = new StdioClient(process.execPath, [
      join(js, "forwarder.mjs"),
      "--state",
      state,
      "--reconnect",
    ]);
    let bindArrived = (): void => undefined;
    const arrived = new Promise<void>((resolve) => (bindArrived = resolve));
    let delayed = false;
    const service = await startService({
      state,
      // The first bind reply comes 1.5 s late, so the client's initialize lands in the wait.
      replyDelayMs: (method) => {
        if (method !== "tasks/bind" || delayed) return 0;
        delayed = true;
        bindArrived();
        return 1500;
      },
    });
    services.add(service);
    await arrived;
    const init = await client.initialize();
    expect((init["result"] as JsonObject)["protocolVersion"]).toBe("2025-11-25");
    await untilInstance(client, service.info.instance, 15_000);
    // The binding that came online carried the initialize as mcp_init.
    expect(service.events.some((e) => e.kind === "mcp" && e["method"] === "initialize")).toBe(true);
    await service.close();
    services.delete(service);
    expect(await client.end()).toBe(0);
  }, 60_000);

  test("the service answers spike.env_snapshot with counts and found flags, never values", async () => {
    const state = join(work, "state-s");
    const service = await startService({ state });
    services.add(service);
    const rpc = new RpcClient(
      await connect(state, { mode: "rpc", client: clientInfo("cli"), context: {} }),
    );
    try {
      const reply = (await rpc.call("spike.env_snapshot", { tools: ["mira-tool"] })) as JsonObject;
      const built = reply["built"] as JsonObject;
      const inherited = reply["inherited"] as JsonObject;
      expect(built["method"]).toBe(WIN ? "registry" : "login-shell");
      expect(inherited["method"]).toBe("inherited");
      const tools = built["tools"] as Record<string, JsonObject>;
      expect(Object.keys(tools)).toEqual(expect.arrayContaining(["node", "codex", "mira-tool"]));
      expect(tools["mira-tool"]?.["found"]).toBe(false);
      const text = JSON.stringify(reply);
      for (const value of [process.env["PATH"], process.env["HOME"], process.env["USERPROFILE"]]) {
        if (value !== undefined && value.length > 3) expect(text).not.toContain(value);
      }
      await expect(rpc.call("spike.env_snapshot", { tools: ["a b"] })).rejects.toThrow();
    } finally {
      rpc.close();
      await service.close();
      services.delete(service);
    }
  }, 60_000);

  test("the snapshot parsers keep the markers, the session names, A4's merge rule and the registry layers", () => {
    const block = Buffer.from("rc noise\n\0m1\0PATH=/a:/b\0MIRA=one=two\0\0m1\0trailing", "utf8");
    expect(parseEnvBlock(block, "m1")).toEqual({ PATH: "/a:/b", MIRA: "one=two" });
    expect(parseEnvBlock(Buffer.from("no markers"), "m1")).toBeUndefined();

    const session = parseSessionEnvironment(
      "DISPLAY=:0\nPATH=/usr/bin\nXDG_RUNTIME_DIR=/run/user/1\nSSH_AUTH_SOCK=$'/s p'\nHOME=/h\n",
    );
    expect(session).toEqual({
      DISPLAY: ":0",
      XDG_RUNTIME_DIR: "/run/user/1",
      SSH_AUTH_SOCK: "/s p",
    });
    const merged = mergeLayers(
      { DISPLAY: ":1" },
      { DISPLAY: ":0", PATH: "/n", SSH_AUTH_SOCK: "/gone" },
    );
    expect(merged).toEqual({ DISPLAY: ":1", PATH: "/n" });

    const reg = parseRegQuery(
      "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\bin;C:\\x\r\n    TEMP    REG_EXPAND_SZ    %USERPROFILE%\\t\r\n    MIRA    REG_SZ    a  b\r\n",
    );
    expect(reg.get("MIRA")).toEqual({ type: "REG_SZ", value: "a  b" });
    expect(expandWindows("%userprofile%\\x;%NOPE%", { USERPROFILE: "C:\\U" })).toBe(
      "C:\\U\\x;%NOPE%",
    );
    const system = parseRegQuery(
      "    Path    REG_EXPAND_SZ    %SystemRoot%\\sys\r\n    OS    REG_SZ    Windows_NT\r\n",
    );
    const env = windowsRegistryEnvironment(system, reg, {
      SystemRoot: "C:\\W",
      USERPROFILE: "C:\\U",
    });
    expect(env["Path"]).toBe("C:\\W\\sys;C:\\U\\bin;C:\\x");
    expect(env["TEMP"]).toBe("C:\\U\\t");
    expect(env["OS"]).toBe("Windows_NT");
  });

  test("E01's differences name every tool and the SSH agent whose found flag differs", () => {
    const built = {
      tools: { node: { found: true }, rg: { found: false } },
      ssh_agent: { found: true, via: "SSH_AUTH_SOCK" },
    };
    // The Linux lab machine's committed E01 result: the same tools, the agent only in the service.
    expect(
      snapshotDifferences(["node", "rg"], built, {
        tools: { node: true, rg: false },
        ssh_agent: false,
      }),
    ).toEqual(["ssh_agent"]);
    expect(
      snapshotDifferences(["node", "rg", "mira-tool"], built, {
        tools: { node: false, rg: false, "mira-tool": true },
        ssh_agent: true,
      }),
    ).toEqual(["node", "mira-tool"]);
    expect(snapshotDifferences(["node"], undefined, { tools: {}, ssh_agent: false })).toEqual([]);
  });

  test("tools resolve on PATH by PATHEXT on Windows and by the exec bit elsewhere", () => {
    const dir = join(work, "bin-fixture");
    mkdirSync(dir, { recursive: true });
    if (WIN) {
      writeFileSync(join(dir, "mira-tool.cmd"), "@echo off\r\n");
      const env = { Path: `C:\\nowhere;${dir}`, PATHEXT: ".COM;.EXE;.CMD" };
      expect(resolveTool("mira-tool", env, "win32")).toBe(join(dir, "mira-tool.cmd"));
      expect(resolveTool("mira-missing", env, "win32")).toBeUndefined();
    } else {
      writeFileSync(join(dir, "mira-tool"), "#!/bin/sh\n");
      writeFileSync(join(dir, "mira-plain"), "not executable\n");
      chmodSync(join(dir, "mira-tool"), 0o755);
      chmodSync(join(dir, "mira-plain"), 0o644);
      const env = { PATH: `/nowhere:${dir}` };
      expect(resolveTool("mira-tool", env, "linux")).toBe(join(dir, "mira-tool"));
      expect(resolveTool("mira-plain", env, "linux")).toBeUndefined();
    }
  });

  test.skipIf(WIN)(
    "the login-shell snapshot reads a fixture shell between its markers and stops a hanging one",
    async () => {
      const dir = join(work, "shell-fixture");
      mkdirSync(join(dir, "bin"), { recursive: true });
      writeFileSync(join(dir, "bin", "mira-tool"), "#!/bin/sh\n");
      chmodSync(join(dir, "bin", "mira-tool"), 0o755);
      // A login shell whose rc files print noise and add a folder to PATH, like nvm does.
      writeFileSync(
        join(dir, "fake-shell"),
        `#!/bin/sh\necho "welcome noise"\nexport PATH="${join(dir, "bin")}:$PATH"\nexec /bin/sh -c "$2"\n`,
      );
      writeFileSync(join(dir, "slow-shell"), "#!/bin/sh\nexec sleep 30\n");
      chmodSync(join(dir, "fake-shell"), 0o755);
      chmodSync(join(dir, "slow-shell"), 0o755);
      const snap = await buildSnapshot({
        tools: ["mira-tool"],
        loginShell: join(dir, "fake-shell"),
      });
      expect(snap.ok).toBe(true);
      expect(snap.tools["mira-tool"]?.found).toBe(true);
      expect(snap.variables).toBeGreaterThan(0);
      const slow = await buildSnapshot({
        tools: ["mira-tool"],
        loginShell: join(dir, "slow-shell"),
        timeoutMs: 500,
      });
      expect(slow).toMatchObject({ ok: false, reason: "timeout" });
      expect(slow.ms).toBeLessThan(5000);
    },
    30_000,
  );

  test("the supervisor stops on 0, 64 and 73, restarts 75 at once and gives up at the 5th crash in 10 minutes", async () => {
    expect(decide(0, [], 0)).toEqual({ action: "stop", reason: "clean" });
    expect(decide(64, [], 0)).toEqual({ action: "stop", reason: "refused" });
    expect(decide(73, [], 0)).toEqual({ action: "stop", reason: "locked" });
    expect(decide(75, [], 0)).toEqual({ action: "restart", delayMs: 0, reason: "requested" });
    const failures: number[] = [];
    const delays = [1, 2, 3, 4].map((i) => decide(1, failures, i * 1000));
    expect(delays.map((d) => (d.action === "restart" ? d.delayMs : -1))).toEqual([
      1000, 2000, 4000, 8000,
    ]);
    expect(decide(null, failures, 5000)).toEqual({ action: "give_up" });
    // Crashes older than 10 minutes no longer count.
    const old = [0, 1, 2, 3];
    expect(decide(1, old, 11 * 60 * 1000)).toEqual({
      action: "restart",
      delayMs: 1000,
      reason: "crash",
    });

    const codes = [75, 1, 1, 1, 1, 1];
    const slept: number[] = [];
    const log: string[] = [];
    let clock = 0;
    let gaveUp = false;
    const io: SupervisorIO = {
      start: () => ({ pid: 1, exit: Promise.resolve(codes.shift() ?? 0) }),
      sleep: (ms) => {
        slept.push(ms);
        clock += ms;
        return Promise.resolve();
      },
      now: () => clock,
      log: (event) => log.push(String(event["kind"])),
      gaveUp: () => {
        gaveUp = true;
      },
    };
    expect(await supervise(io)).toBe(0);
    expect(slept).toEqual([1000, 2000, 4000, 8000]);
    expect(gaveUp).toBe(true);
    expect(log.filter((k) => k === "start")).toHaveLength(6);
  });

  describe("the lab release folder", () => {
    let folder: string;
    let lab: { kit: string; lifecycle: string };

    beforeAll(() => {
      const fake = join(work, "fake-node");
      writeFileSync(fake, "not a real runtime\n");
      const stage = join(work, "stage", "0.0.0-spike");
      assembleVersionFolder(stage, {
        version: "0.0.0-spike",
        build: "test",
        platform: "linux-x64",
        node: { version: "v26.13.1", sqlite: "3.54.1", binary: fake, license: fake },
      });
      lab = buildLab(join(work, "lab-js"));
      folder = assembleLabFolder(stage, join(work, "lab"), "0.0.7-lab.t", lab);
    }, 60_000);

    test("it swaps the entry, adds the kit and the supervisor, and its manifest verifies", () => {
      expect(verifyVersionFolder(folder)).toEqual([]);
      const manifest = JSON.parse(
        readFileSync(join(folder, "manifest.json"), "utf8"),
      ) as JsonObject;
      expect(manifest["version"]).toBe("0.0.7-lab.t");
      expect(readFileSync(join(folder, "lib", "tasks.mjs"))).toEqual(
        readFileSync(join(lab.lifecycle, "entry.mjs")),
      );
      for (const name of ["forwarder", "shim", "kit", "service", "wire", "snapshot"]) {
        expect(existsSync(join(folder, "lib", "kit", `${name}.mjs`)), name).toBe(true);
      }
      expect(existsSync(join(folder, "lib", "supervisor.mjs"))).toBe(true);
      expect(existsSync(join(folder, "lib", "gate.mjs"))).toBe(true);
      expect(() => assembleLabFolder(folder, join(work, "lab"), "0.0.7-lab.t", lab)).toThrow();
    });

    test("its entry routes version and mcp, and refuses no command without tasksw", async () => {
      const entry = join(folder, "lib", "tasks.mjs");
      const run = (args: string[]) =>
        spawnSync(process.execPath, [entry, ...args], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 30_000,
          env: { PATH: process.env["PATH"] ?? "", SystemRoot: process.env["SystemRoot"] ?? "" },
        });
      expect(run(["version"]).stdout.trim()).toBe("0.0.7-lab.t");
      expect(run([]).status).toBe(64);

      const bridge = new StdioClient(process.execPath, [
        entry,
        "mcp",
        "--state",
        join(work, "no-service"),
      ]);
      const init = await bridge.initialize();
      expect(init["result"]).toBeDefined();
      expect(await bridge.status()).toBe("offline");
      expect(await bridge.end()).toBe(0);
    }, 60_000);
  });
});
