// The M0 spike kit self-test (A7 3.7, step M0.02, Verify: "Kit self-test passes on both CI
// runners"). It runs every part of the kit the way the lab runs it: the stand-in service in a
// temporary state folder, the forwarder, shims and probe as child processes started from the
// built .mjs kit, and the scratch tree under a temporary base folder. Fixture text only.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { otherAccounts } from "./accounts.ts";
import { runBench } from "./bench.ts";
import { buildKit } from "./build.ts";
import {
  CLIENT_CAPABILITIES_META,
  CLIENT_INFO_META,
  MODERN_VERSIONS,
  STUB_TOOLS,
  VERSION_META,
  createMcpResponder,
  textResult,
} from "./mcp-stub.ts";
import { aclProblems, assertPrivate, parseSddl, posixProblems, readAcls } from "./perms.ts";
import { createRedactor, other } from "./probe-log.ts";
import {
  selectSocketDir,
  startService,
  type RunningService,
  type ServiceOptions,
} from "./service.ts";
import { buildTree, type ScratchTree } from "./tree.ts";
import {
  KitError,
  LineReader,
  RpcClient,
  clientInfo,
  clientProof,
  connect,
  connectWithRetry,
  handshake,
  httpProbeProof,
  nonce,
  parseObject,
  serverProof,
  sha256Hex,
  verifyListener,
  writeLine,
  type JsonObject,
} from "./wire.ts";

const FIXTURE_TITLE = "M-14 Fix appointment time zones";
const FIXTURE_TICKET = "kt_MiraFixtureTicketValue000000000000";
const SECRET_VALUE = "mira-value-that-must-never-be-logged";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let work: string;
let js: string;
let state: string;
let service: RunningService;
let tree: ScratchTree;
const revealed: string[] = [];

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
  replies: JsonObject[];
}

/**
 * A minimal explicit environment for a child process: the platform's prerequisites and `extra`,
 * nothing else from the host, so no test depends on the runner's variables (review round 2,
 * finding F: USERNAME=runneradmin on Windows CI changed what the probe redacted).
 */
function fixtureEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const needed =
    process.platform === "win32"
      ? ["SystemRoot", "windir", "SystemDrive", "ComSpec", "PATH", "PATHEXT", "TEMP", "TMP"]
      : ["PATH", "TMPDIR"];
  const env: NodeJS.ProcessEnv = {};
  for (const name of needed) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
}

/**
 * Every process a test starts, by PID. A test's `finally` and `afterAll` terminate and await
 * them (and a detached agent's whole tree) before files are deleted (review round 2, finding E).
 */
const owned = new Set<number>();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kills `pid` and its tree (Windows) or its process group and itself (Unix), then awaits it. */
async function killTree(pid: number): Promise<void> {
  if (alive(pid)) {
    if (process.platform === "win32") {
      const taskkill = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "taskkill.exe");
      spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        timeout: 10_000,
        env: fixtureEnv(),
      });
    } else {
      for (const target of [-pid, pid]) {
        try {
          process.kill(target, "SIGKILL");
        } catch {
          // Not a group leader, or already gone.
        }
      }
    }
  }
  const end = Date.now() + 10_000;
  while (alive(pid) && Date.now() < end) await sleep(50);
  owned.delete(pid);
}

async function killOwned(): Promise<void> {
  for (const pid of [...owned]) await killTree(pid);
}

/** Extra services a test starts, closed in `afterAll` too when a test ends early. */
const services = new Set<RunningService>();

async function ownedService(options: ServiceOptions): Promise<RunningService> {
  const started = await startService(options);
  services.add(started);
  return started;
}

interface StartedShim {
  child: ReturnType<typeof spawn>;
  pid: number;
  exit: Promise<{ code: number | null; signal: string | null }>;
  stderr: () => string;
}

/** Starts the built run shim with the fixture environment and owns its PID. */
function startRunShim(runState: string, extra: string[], ticket: string): StartedShim {
  const child = spawn(
    process.execPath,
    [join(js, "run-shim.mjs"), "--state", runState, ...extra, ticket],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, env: fixtureEnv() },
  );
  if (child.pid === undefined) throw new Error("the run shim did not start");
  owned.add(child.pid);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
  return { child, pid: child.pid, exit, stderr: () => stderr };
}

/** The detached agent's PID from the run's meta.json, owned from then on. */
async function agentOf(runDir: string): Promise<number> {
  const pid = await waitFor(
    () => {
      const text = readIf(join(runDir, "meta.json"));
      return text === "" ? undefined : ((JSON.parse(text) as JsonObject)["agent_pid"] as number);
    },
    15_000,
    "meta.json",
  );
  owned.add(pid);
  return pid;
}

/** Starts `node <script>`, writes JSON lines to stdin, reads JSON lines from stdout. */
function runChild(
  script: string,
  args: readonly string[],
  lines: readonly unknown[],
  expected: number,
  env: NodeJS.ProcessEnv = fixtureEnv(),
  cwd?: string,
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    if (child.pid !== undefined) owned.add(child.pid);
    const replies: JsonObject[] = [];
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    const reader = new LineReader(child.stdout);
    reader.pipe((line) => {
      const msg = parseObject(line);
      if (msg !== undefined) replies.push(msg);
      if (replies.length >= expected) child.stdin.end();
    });
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${script} timed out. stderr: ${stderr}`));
    }, 20_000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (child.pid !== undefined) owned.delete(child.pid);
      resolve({ code, stdout, stderr, replies });
    });
    for (const line of lines) child.stdin.write(`${JSON.stringify(line)}\n`);
    if (expected === 0) child.stdin.end();
  });
}

const request = (id: number, method: string, params: JsonObject = {}) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});

const legacyInit = request(0, "initialize", {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "kit-self-test", version: "1" },
});

/** A 2026-07-28 request with the `_meta` fields its schema requires. */
const modern = (
  id: number,
  method: string,
  params: JsonObject = {},
  version: string = MODERN_VERSIONS[0],
) =>
  request(id, method, {
    ...params,
    _meta: {
      [VERSION_META]: version,
      [CLIENT_CAPABILITIES_META]: {},
      [CLIENT_INFO_META]: { name: "kit-self-test", version: "1" },
    },
  });

const cliOptions = { mode: "rpc" as const, client: clientInfo("cli"), context: {} };

async function cli(at = state): Promise<RpcClient> {
  return new RpcClient(await connect(at, cliOptions));
}

function hash12(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

async function waitFor<T>(
  probe: () => T | undefined | false,
  ms: number,
  what: string,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const readIf = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");

/** A pipe or socket path for a fake endpoint. */
const fakePath = (name: string) =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\ttasks-kit-${name}-${nonce().slice(0, 12)}`
    : join(work, `${name}.sock`);

/** Mints a UI code, redeems it and returns the origin and a bearer token. */
async function signIn(): Promise<{ origin: string; port: number; token: string }> {
  const rpc = await cli();
  const minted = (await rpc.call("ui/mint_code")) as JsonObject;
  rpc.close();
  const port = minted["port"] as number;
  const origin = `http://127.0.0.1:${String(port)}`;
  const res = await fetch(`${origin}/api/v1/auth/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ code: minted["code"] }),
  });
  const { token } = (await res.json()) as { token: string };
  return { origin, port, token };
}

/** The status of a raw WebSocket upgrade request: 101 accepted, anything else refused. */
function upgradeStatus(
  port: number,
  ticket: string,
  headers: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: `/api/v1/ws?ticket=${ticket}`,
      headers: {
        host: `127.0.0.1:${String(port)}`,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...headers,
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), "ttasks-kit-")));
  js = buildKit(join(work, "kit-js"));
  tree = buildTree(join(work, "tree"));
  state = join(work, "state");
  service = await startService({
    state,
    tree: tree.container,
    // U06: a fake opener, so the self-test never opens a file manager window.
    opener: (dir) => {
      revealed.push(dir);
      return Promise.resolve({ opener: "fake", ok: true });
    },
  });
}, 60_000);

afterAll(async () => {
  await killOwned();
  for (const extra of services) await extra.close();
  await service.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("[A7.3.7.m0-kit.self-test] the M0 spike kit", () => {
  test("the build writes a standalone .mjs kit with a build record", () => {
    const names = [
      "wire",
      "mcp-stub",
      "forwarder",
      "shim",
      "run-shim",
      "probe",
      "probe-log",
      "perms",
      "service",
      "kit",
    ];
    for (const name of names) {
      const file = join(js, `${name}.mjs`);
      expect(existsSync(file), file).toBe(true);
      expect(readFileSync(file, "utf8")).not.toMatch(/from\s+["']\.{1,2}\/[^"']+\.ts["']/);
    }
    const record = JSON.parse(readFileSync(join(js, "build.json"), "utf8")) as JsonObject;
    expect(record["outputs"]).toEqual(expect.arrayContaining(names.map((n) => `${n}.mjs`)));
  });

  test("a second service on the same state folder is refused", async () => {
    await expect(startService({ state })).rejects.toMatchObject({ code: "locked" });
  });

  test("the HMAC handshake completes over the socket or pipe", async () => {
    const rpc = await cli();
    expect(rpc.bind["protocol"]).toBe(1);
    const status = (await rpc.call("service/status")) as JsonObject;
    expect(status["instance"]).toBe(service.info.instance);
    expect(service.info.endpoint.kind).toBe(process.platform === "win32" ? "pipe" : "unix");
    expect(status["runtime"]).toBe(service.info.runtime);
    rpc.close();
  });

  test("a client with the wrong key is refused, and the client refuses a fake endpoint", async () => {
    // Wrong key: the service closes the connection without sending its proof.
    const socket = net.createConnection(service.info.endpoint.path);
    await new Promise((resolve) => socket.once("connect", resolve));
    const reader = new LineReader(socket);
    const wrong = Buffer.alloc(32, 7);
    await expect(
      handshake(socket, reader, wrong, { mode: "rpc", client: clientInfo("cli"), context: {} }),
    ).rejects.toMatchObject({ code: "untrusted_endpoint" });
    socket.destroy();

    // Fake endpoint: it learns one hello line with protocol, mode, nonce and proof only.
    const seen: string[] = [];
    const fake = net.createServer((conn) => {
      writeLine(conn, {
        jsonrpc: "2.0",
        method: "ttasks/challenge",
        params: { nonce: nonce(), instance: "fake", protocols: [1] },
      });
      const r = new LineReader(conn);
      r.pipe((line) => {
        seen.push(line);
        writeLine(conn, { jsonrpc: "2.0", id: 0, result: { proof: "AAAA" } });
      });
    });
    const path = fakePath("fake");
    await new Promise<void>((resolve) => fake.listen(path, resolve));
    const conn = net.createConnection(path);
    await new Promise((resolve) => conn.once("connect", resolve));
    await expect(
      handshake(conn, new LineReader(conn), service.key, {
        mode: "mcp",
        client: clientInfo("forwarder"),
        context: { env: { TTASKS_TICKET: FIXTURE_TICKET } },
      }),
    ).rejects.toBeInstanceOf(KitError);
    conn.destroy();
    await new Promise((resolve) => fake.close(resolve));
    expect(seen).toHaveLength(1);
    const hello = parseObject(seen[0] ?? "");
    expect(hello?.["method"]).toBe("ttasks/hello");
    expect(Object.keys(hello?.["params"] as JsonObject).sort()).toEqual([
      "mode",
      "nonce",
      "proof",
      "protocol",
    ]);
    expect(seen.join("")).not.toContain(FIXTURE_TICKET);
  });

  test("a silent endpoint at each handshake stage times out and its socket is destroyed", async () => {
    // Review finding 6: connect and the shim's retry window were unbounded against a peer that
    // accepts and then says nothing.
    const key = Buffer.alloc(32, 9);
    for (const stage of ["accept", "challenge", "proof"] as const) {
      const fakeState = join(work, `silent-${stage}`);
      mkdirSync(fakeState, { recursive: true });
      let closedByClient = false;
      const server = net.createServer((conn) => {
        conn.on("close", () => (closedByClient = true));
        conn.on("error", () => undefined);
        conn.resume(); // read, so the client's close is seen at every stage
        if (stage === "accept") return; // never sends the challenge
        const ns = nonce();
        writeLine(conn, {
          jsonrpc: "2.0",
          method: "ttasks/challenge",
          params: { nonce: ns, instance: "silent", protocols: [1] },
        });
        if (stage === "challenge") return; // never answers the hello
        const reader = new LineReader(conn);
        reader.pipe((line) => {
          const params = parseObject(line)?.["params"] as JsonObject | undefined;
          if (params?.["nonce"] === undefined) return;
          const ids = {
            instance: "silent",
            protocol: 1,
            mode: "rpc" as const,
            ns,
            nc: params["nonce"] as string,
          };
          expect(params["proof"]).toBe(clientProof(key, ids));
          // A valid server proof, then silence instead of the bind result.
          writeLine(conn, { jsonrpc: "2.0", id: 0, result: { proof: serverProof(key, ids) } });
        });
      });
      const path = fakePath(`silent-${stage}`);
      await new Promise<void>((resolve) => server.listen(path, resolve));
      writeFileSync(
        join(fakeState, "service.json"),
        JSON.stringify({
          endpoint: { kind: process.platform === "win32" ? "pipe" : "unix", path },
        }),
      );
      writeFileSync(join(fakeState, "ipc.key"), key);
      const started = Date.now();
      await expect(connect(fakeState, cliOptions, { handshakeMs: 300 })).rejects.toMatchObject({
        code: "handshake_timeout",
      });
      expect(Date.now() - started).toBeLessThan(3_000);
      await waitFor(() => closedByClient, 3_000, `the ${stage} socket to close`);

      // The shim's 30 s retry loop is bounded too: each attempt has its deadline.
      const retryStart = Date.now();
      await expect(
        connectWithRetry(fakeState, "shim", 600, { handshakeMs: 200 }),
      ).resolves.toBeUndefined();
      expect(Date.now() - retryStart).toBeLessThan(5_000);
      await new Promise((resolve) => server.close(resolve));
    }

    // ttasks open's HTTP probe against a listener that accepts and never answers.
    const silentHttp = net.createServer((conn) => conn.on("error", () => undefined));
    await new Promise<void>((resolve) => silentHttp.listen(0, "127.0.0.1", resolve));
    const silentPort = (silentHttp.address() as net.AddressInfo).port;
    const probeStart = Date.now();
    await expect(verifyListener(silentPort, service.key, "x", 300)).resolves.toBe(false);
    expect(Date.now() - probeStart).toBeLessThan(3_000);
    silentHttp.close();
  }, 30_000);

  test("the stub's envelopes have the fields both official MCP schemas require", () => {
    // Review finding 3. Required fields from schema/2026-07-28/schema.json and
    // schema/2025-11-25/schema.json (modelcontextprotocol/modelcontextprotocol, 2026-11-12).
    const respond = createMcpResponder({
      name: "kit-self-test-server",
      instructions: "Fixture instructions.",
      tools: STUB_TOOLS,
      call: () => textResult("Mira result"),
    });
    const result = (msg: JsonObject) => respond(msg)?.["result"] as JsonObject;
    const error = (msg: JsonObject) => respond(msg)?.["error"] as JsonObject;

    // 2026-07-28: DiscoverResult, ListToolsResult (CacheableResult), CallToolResult.
    const discover = result(modern(1, "server/discover"));
    for (const field of [
      "cacheScope",
      "capabilities",
      "resultType",
      "supportedVersions",
      "ttlMs",
    ]) {
      expect(discover, field).toHaveProperty(field);
    }
    expect(discover["resultType"]).toBe("complete");
    expect(discover["supportedVersions"]).toEqual([...MODERN_VERSIONS]);
    const list = result(modern(2, "tools/list"));
    for (const field of ["cacheScope", "resultType", "tools", "ttlMs"])
      expect(list, field).toHaveProperty(field);
    for (const cacheable of [discover, list]) {
      expect(["public", "private"]).toContain(cacheable["cacheScope"]);
      expect(Number.isInteger(cacheable["ttlMs"]) && (cacheable["ttlMs"] as number) >= 0).toBe(
        true,
      );
    }
    const call = result(modern(3, "tools/call", { name: "status", arguments: {} }));
    expect(call).toMatchObject({
      resultType: "complete",
      content: [{ type: "text", text: "Mira result" }],
    });
    // UnsupportedProtocolVersionError: code -32022 with data.requested and data.supported.
    expect(error(modern(4, "tools/list", {}, "1999-01-01"))).toMatchObject({
      code: -32022,
      data: { requested: "1999-01-01", supported: [...MODERN_VERSIONS] },
    });
    // RequestParams requires _meta with the version: an unversioned discover is not answered.
    expect(error(request(5, "server/discover"))).toMatchObject({ code: -32602 });
    expect(respond(request(5, "server/discover"))).not.toHaveProperty("result");
    // ping is not a 2026-07-28 request.
    expect(error(modern(6, "ping"))).toMatchObject({ code: -32601 });

    // 2025-11-25: InitializeResult, ListToolsResult, CallToolResult. No resultType there.
    const init = result(legacyInit);
    for (const field of ["capabilities", "protocolVersion", "serverInfo"])
      expect(init, field).toHaveProperty(field);
    expect((init["serverInfo"] as JsonObject)["name"]).toBe("kit-self-test-server");
    expect(typeof (init["serverInfo"] as JsonObject)["version"]).toBe("string");
    const older = result(
      request(7, "initialize", {
        protocolVersion: "2024-01-01",
        capabilities: {},
        clientInfo: { name: "c", version: "1" },
      }),
    );
    expect(older["protocolVersion"]).toBe("2025-11-25"); // the lifecycle's counter-offer
    expect(error(request(8, "initialize", { capabilities: {} }))).toMatchObject({ code: -32602 });
    const legacyList = result(request(9, "tools/list"));
    expect(legacyList).toHaveProperty("tools");
    expect(legacyList).not.toHaveProperty("resultType");
    expect(result(request(10, "tools/call", { name: "status" }))).toHaveProperty("content");
    expect(result(request(11, "ping"))).toEqual({});
  });

  test("2026-only metadata without a version is invalid params, in every combination", () => {
    // Review round 2, finding C: tools/list and tools/call with 2026-only metadata but no
    // version were answered as legacy requests. Markers from schema/2026-07-28/schema.ts.
    const caps = { [CLIENT_CAPABILITIES_META]: {} };
    const markers: [string, JsonObject][] = [
      ["clientInfo", { _meta: { [CLIENT_INFO_META]: { name: "kit-self-test", version: "1" } } }],
      ["clientCapabilities", { _meta: caps }],
      ["logLevel", { _meta: { "io.modelcontextprotocol/logLevel": "info" } }],
      ["inputResponses", { inputResponses: {} }],
      ["requestState", { requestState: "opaque" }],
    ];
    const legacyMeta: [string, JsonObject][] = [
      ["no params", {}],
      ["progressToken", { _meta: { progressToken: 7 } }],
      ["related-task", { _meta: { "io.modelcontextprotocol/related-task": { taskId: "t1" } } }],
    ];
    const toolParams = (method: string): JsonObject =>
      method === "tools/call" ? { name: "status", arguments: {} } : {};
    for (const initialized of [false, true]) {
      for (const method of ["tools/list", "tools/call"]) {
        const respond = createMcpResponder({
          name: "kit-self-test-server",
          instructions: "Fixture instructions.",
          tools: STUB_TOOLS,
          call: () => textResult("Mira result"),
        });
        if (initialized) expect(respond(legacyInit)).toHaveProperty("result");
        const where = `${method}, initialized ${String(initialized)}`;
        for (const [name, params] of markers) {
          const reply = respond(request(1, method, { ...toolParams(method), ...params }));
          expect(reply?.["error"], `${where}: ${name}`).toMatchObject({ code: -32602 });
          expect(reply, `${where}: ${name}`).not.toHaveProperty("result");
        }
        for (const [name, params] of legacyMeta) {
          const reply = respond(request(2, method, { ...toolParams(method), ...params }));
          const result = reply?.["result"] as JsonObject | undefined;
          expect(result, `${where}: ${name}`).toBeDefined();
          expect(result, `${where}: ${name}`).not.toHaveProperty("resultType");
        }
        // With its version (and the required capabilities) the request is a 2026-07-28 one.
        const full = respond(modern(3, method, toolParams(method)));
        expect(full?.["result"], where).toMatchObject({ resultType: "complete" });
        // A version without the capabilities is invalid too, and an unknown version is -32022.
        const noCaps = respond(
          request(4, method, { ...toolParams(method), _meta: { [VERSION_META]: "2026-07-28" } }),
        );
        expect(noCaps?.["error"], where).toMatchObject({ code: -32602 });
        expect(
          respond(modern(5, method, toolParams(method), "1999-01-01"))?.["error"],
          where,
        ).toMatchObject({ code: -32022 });
      }
    }
  });

  test("the stub MCP endpoint answers both eras through the forwarder", async () => {
    const forwarder = join(js, "forwarder.mjs");
    const legacy = await runChild(
      forwarder,
      ["--state", state],
      [
        legacyInit,
        { jsonrpc: "2.0", method: "notifications/initialized" },
        request(1, "tools/list"),
        request(2, "tools/call", { name: "status", arguments: {} }),
      ],
      3,
    );
    expect(legacy.code, legacy.stderr).toBe(0);
    const [init, list, call] = legacy.replies;
    expect((init?.["result"] as JsonObject)["protocolVersion"]).toBe("2025-11-25");
    expect(
      ((list?.["result"] as JsonObject)["tools"] as JsonObject[]).map((t) => t["name"]),
    ).toEqual(["status", "echo"]);
    expect(JSON.stringify(call?.["result"])).toContain("stand-in");

    const current = await runChild(
      forwarder,
      ["--state", state],
      [
        modern(0, "server/discover"),
        modern(1, "tools/call", { name: "echo", arguments: { text: "Mira echo" } }),
        modern(2, "tools/list", {}, "1999-01-01"),
        request(3, "server/discover"),
      ],
      4,
    );
    expect(current.code, current.stderr).toBe(0);
    const [discover, echo, unsupported, unversioned] = current.replies;
    expect(discover?.["result"]).toMatchObject({
      supportedVersions: [...MODERN_VERSIONS],
      resultType: "complete",
      ttlMs: 0,
      cacheScope: "private",
    });
    expect(echo?.["result"]).toMatchObject({ resultType: "complete" });
    expect(JSON.stringify(echo?.["result"])).toContain("Mira echo");
    // Corrected expectation: the 2026-07-28 schema's UnsupportedProtocolVersionError is -32022.
    expect(unsupported?.["error"]).toMatchObject({
      code: -32022,
      data: { requested: "1999-01-01" },
    });
    expect(unversioned?.["error"]).toMatchObject({ code: -32602 });

    const eras = service.events.filter((e) => e.kind === "mcp").map((e) => e["era"]);
    expect(eras).toContain("legacy");
    expect(eras).toContain("2026-07-28");
  });

  test("the forwarder answers offline when the service is not running", async () => {
    const empty = join(work, "no-service");
    mkdirSync(empty, { recursive: true });
    const offline = await runChild(
      join(js, "forwarder.mjs"),
      ["--state", empty],
      [
        legacyInit,
        request(1, "tools/list"),
        request(2, "tools/call", { name: "status" }),
        modern(3, "server/discover"),
        modern(4, "tools/call", { name: "status" }),
      ],
      5,
    );
    expect(offline.code, offline.stderr).toBe(0);
    const [init, list, call, discover, modernCall] = offline.replies;
    expect((init?.["result"] as JsonObject)["protocolVersion"]).toBe("2025-11-25");
    expect(((list?.["result"] as JsonObject)["tools"] as JsonObject[]).length).toBe(2);
    expect((call?.["result"] as JsonObject)["isError"]).toBe(true);
    expect(JSON.stringify(call?.["result"])).toContain("not running");
    expect(discover?.["result"]).toMatchObject({ resultType: "complete", ttlMs: 0 });
    expect(modernCall?.["result"]).toMatchObject({ resultType: "complete", isError: true });
  });

  test("the page bootstraps a token from a fragment code and echoes over the WebSocket", async () => {
    const rpc = await cli();
    const minted = (await rpc.call("ui/mint_code", { path: "/today" })) as JsonObject;
    rpc.close();
    const port = minted["port"] as number;
    const code = minted["code"] as string;
    const origin = `http://127.0.0.1:${String(port)}`;

    // ttasks open verifies the listener before it trusts the port (A2 3.8.4 step 2).
    const np = nonce();
    const probe = await fetch(`${origin}/api/v1/auth/probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce: np }),
    });
    const { proof } = (await probe.json()) as { proof: string };
    expect(proof).toBe(httpProbeProof(service.key, service.info.instance, port, np));
    expect(await verifyListener(port, service.key, service.info.instance)).toBe(true);

    const page = await fetch(`${origin}/`);
    expect(page.status).toBe(200);
    const csp = page.headers.get("content-security-policy") ?? "";
    const pageNonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(pageNonce).toBeDefined();
    expect(await page.text()).toContain(`<meta name="csp-nonce" content="${pageNonce ?? ""}">`);
    expect((await fetch(`${origin}/app.js`)).status).toBe(200);

    const redeem = (headers: Record<string, string>) =>
      fetch(`${origin}/api/v1/auth/redeem`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ code }),
      });
    expect((await redeem({ origin: "http://evil.example" })).status).toBe(403);
    const redeemed = await redeem({ origin });
    expect(redeemed.status).toBe(200);
    const { token } = (await redeemed.json()) as { token: string };
    expect(token).toMatch(/^ttasks_u_[A-Za-z0-9_-]{43}$/);
    expect((await redeem({ origin })).status).toBe(401);

    const auth = { authorization: `Bearer ${token}`, origin, "content-type": "application/json" };
    expect((await fetch(`${origin}/api/v1/session`, { headers: auth })).status).toBe(200);
    expect((await fetch(`${origin}/api/v1/session`)).status).toBe(401);
    const wsTicket = async () => {
      const res = await fetch(`${origin}/api/v1/ws-ticket`, {
        method: "POST",
        headers: auth,
        body: "{}",
      });
      return ((await res.json()) as { ticket: string }).ticket;
    };
    const ticket = await wsTicket();

    const echoed = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/api/v1/ws?ticket=${ticket}`, {
        headers: { origin },
      });
      const timer = setTimeout(() => {
        reject(new Error("WebSocket timed out"));
      }, 10_000);
      ws.onmessage = (event) => {
        const msg = JSON.parse(String(event.data)) as { type: string; text?: string };
        if (msg.type === "hello") ws.send(JSON.stringify({ type: "echo", text: "Mira echo" }));
        if (msg.type === "echo") {
          clearTimeout(timer);
          ws.close();
          resolve(msg.text ?? "");
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("WebSocket failed"));
      };
    });
    expect(echoed).toBe("Mira echo");

    // Review finding 8: the upgrade applies the Sec-Fetch-Site rule of /api/* (A2 3.8.3).
    expect(
      await upgradeStatus(port, await wsTicket(), { origin, "sec-fetch-site": "cross-site" }),
    ).toBe(403);
    expect(
      await upgradeStatus(port, await wsTicket(), { origin, "sec-fetch-site": "same-site" }),
    ).toBe(403);
    expect(
      await upgradeStatus(port, await wsTicket(), { origin, "sec-fetch-site": "same-origin" }),
    ).toBe(101);

    const log = readFileSync(join(state, "events.jsonl"), "utf8");
    expect(log).not.toContain(token);
    expect(log).not.toContain(code);
  });

  test("Reveal opens only a known scratch folder, by index, for an authenticated page", async () => {
    // Review finding 7 (U06).
    const { origin, token } = await signIn();
    const page = await (await fetch(`${origin}/`)).text();
    expect(page).toContain('id="reveal"');
    expect(await (await fetch(`${origin}/app.js`)).text()).toContain("/api/v1/spike/reveal");
    const headers = {
      authorization: `Bearer ${token}`,
      origin,
      "content-type": "application/json",
    };
    const listed = await fetch(`${origin}/api/v1/spike/reveal-targets`, { headers });
    const { targets } = (await listed.json()) as { targets: { index: number; label: string }[] };
    expect(targets.map((t) => t.label)).toEqual(
      expect.arrayContaining(["exactRoot", "unicode", "punctuation"]),
    );
    const unicode = targets.find((t) => t.label === "unicode");
    const reveal = (body: unknown, extra: Record<string, string> = {}) =>
      fetch(`${origin}/api/v1/spike/reveal`, {
        method: "POST",
        headers: { ...headers, ...extra },
        body: JSON.stringify(body),
      });

    const before = revealed.length;
    const opened = await reveal({ index: unicode?.index });
    expect(opened.status).toBe(200);
    expect(revealed.slice(before)).toEqual([realpathSync.native(tree.unicode)]);
    expect((await reveal({ index: 99 })).status).toBe(400);
    expect((await reveal({ index: "0" })).status).toBe(400);
    expect((await reveal({ path: tree.exactRoot })).status).toBe(400);
    expect((await reveal({ index: 0 }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    const anonymous = await fetch(`${origin}/api/v1/spike/reveal`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ index: 0 }),
    });
    expect(anonymous.status).toBe(401);
    expect(revealed.length).toBe(before + 1);
    const event = service.events.findLast((e) => e.kind === "reveal");
    expect(event).toMatchObject({ label: "unicode", opener: "fake", ok: true });
    expect(JSON.stringify(event)).not.toContain(tree.container);
  });

  test("the shim claims its ticket once and runs the agent in the exact folder", async () => {
    const rpc = await cli();
    const agent = [process.execPath, "-e", "process.stdout.write(process.cwd())"];
    const { ticket } = (await rpc.call("spike.mint_ticket", {
      argv: agent,
      cwd: tree.unicode,
      title: FIXTURE_TITLE,
    })) as { ticket: string };
    rpc.close();
    const shim = join(js, "shim.mjs");
    const first = await runChild(shim, ["--state", state, ticket], [], 0);
    expect(first.code, first.stderr).toBe(0);
    expect(realpathSync.native(first.stdout.trim())).toBe(realpathSync.native(tree.unicode));
    expect(first.stderr).toContain(FIXTURE_TITLE);
    const kinds = service.events.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["claim", "launch.started", "launch.exited"]));

    // Review finding 4 (B07): the claim is stamped when it arrives, before the service writes
    // the `rpc` event for it to the log.
    const claim = service.events.find((e) => e.kind === "claim" && e["ticket"] === hash12(ticket));
    const received = service.events.find((e) => e.kind === "rpc" && e["method"] === "launch.claim");
    expect(claim?.t).toBeLessThanOrEqual(received?.t ?? 0);

    const second = await runChild(shim, ["--state", state, ticket], [], 0);
    expect(second.code).not.toBe(0);
    expect(second.stderr).toContain("This launch expired");
    expect(readFileSync(join(state, "events.jsonl"), "utf8")).not.toContain(ticket);
  });

  test("the probe writes closed, structured records, and its redactor stays silent", async () => {
    // Review round 2, finding B: the normal fixture. Path facts instead of paths, known labels,
    // allow-listed identifiers, and a redactor that never had to fire.
    const logDir = join(work, "probe-logs-normal");
    const homes = join(work, "probe-homes");
    const env = fixtureEnv({
      TTASKS_TICKET: FIXTURE_TICKET,
      TTASKS_TASK: "M-14",
      CLAUDE_CODE_SESSION_ID: "fixture-session-0001",
      T3CODE_THREAD_ID: "fixture-thread-0001",
      CODEX_HOME: tree.nested,
      MIRA_PRIVATE_SETTING: SECRET_VALUE,
      APPDATA: join(homes, "Roaming"),
      LOCALAPPDATA: join(homes, "Local"),
      USERPROFILE: join(homes, "profile"),
      TEMP: join(homes, "temp"),
    });
    const result = await runChild(
      join(js, "probe.mjs"),
      ["--log-dir", logDir, "--scratch-root", tree.container, "--markers"],
      [legacyInit, request(1, "tools/call", { name: "probe_report", arguments: {} })],
      2,
      env,
      tree.unicode,
    );
    expect(result.code, result.stderr).toBe(0);
    const [initReply, report] = result.replies;
    expect((initReply?.["result"] as JsonObject)["protocolVersion"]).toBe("2025-11-25");
    const content = (report?.["result"] as JsonObject)["content"] as JsonObject[];
    const reported = JSON.parse(content[0]?.["text"] as string) as JsonObject;
    expect(reported["env"]).toMatchObject({ CLAUDE_CODE_SESSION_ID: "fixture-session-0001" });
    expect(reported["cwd"]).toMatchObject({ inside_scratch: true, tree: "unicode" });

    const files = readdirSync(logDir);
    expect(files).toHaveLength(1);
    const text = readFileSync(join(logDir, files[0] ?? ""), "utf8");
    expect(text).not.toContain(SECRET_VALUE);
    expect(text).not.toContain(FIXTURE_TICKET);
    expect(text).not.toContain("[redacted]");
    for (const path of [work, tree.container, homes]) {
      expect(text).not.toContain(JSON.stringify(path).slice(1, -1));
    }
    const records = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as JsonObject);
    const start = records.find((r) => r["kind"] === "start");
    expect(start?.["env_names"]).toEqual(
      expect.arrayContaining(["MIRA_PRIVATE_SETTING", "TTASKS_TICKET", "CODEX_HOME"]),
    );
    expect(start?.["env"]).toEqual({
      TTASKS_TICKET: `sha256:${hash12(FIXTURE_TICKET)}`,
      TTASKS_TASK: "M-14",
      CLAUDE_CODE_SESSION_ID: "fixture-session-0001",
      T3CODE_THREAD_ID: "fixture-thread-0001",
    });
    expect(start?.["cwd"]).toEqual({
      sha256: sha256Hex(realpathSync.native(tree.unicode)),
      inside_scratch: true,
      under_packages: false,
      tree: "unicode",
      depth: 1,
    });
    const paths = start?.["paths"] as JsonObject;
    expect(paths["CODEX_HOME"]).toMatchObject({ inside_scratch: true, tree: "nested" });
    expect(paths["APPDATA"]).toMatchObject({ inside_scratch: false, under_packages: false });
    expect(Object.keys(start?.["parent"] as JsonObject).sort()).toEqual(["name", "pid"]);
    expect((start?.["parent"] as JsonObject)["pid"]).toBe(process.pid);
    expect(start?.["exec"]).toMatch(/^node(\.exe)?$/);
    expect(records.find((r) => r["kind"] === "mcp")).toEqual(
      expect.objectContaining({
        method: "initialize",
        era: "legacy",
        version: "2025-11-25",
        client: "kit-self-test",
        client_version: "1",
      }),
    );
    expect(records.filter((r) => r["kind"] === "tool").map((r) => r["name"])).toEqual([
      "probe_report",
    ]);
    expect(records.find((r) => r["kind"] === "markers")).toMatchObject({
      written: ["APPDATA", "LOCALAPPDATA", "USERPROFILE", "TEMP"],
    });
    expect(existsSync(join(homes, "profile", ".ttasks-m0"))).toBe(true);
    if (process.platform === "win32") {
      const pkg = records.find((r) => r["kind"] === "package");
      expect(pkg).toMatchObject({ ok: true, package_full_name: null });
      expect((pkg?.["parent"] as JsonObject)["name"]).toBe("node.exe");
    } else if (process.platform === "linux") {
      expect((start?.["parent"] as JsonObject)["name"]).toMatch(/^node/);
    }
    expect(records.at(-1)).toMatchObject({ kind: "end", redactions: 0 });
  });

  test("planted secrets of 4, 5 and 40 characters never reach the probe's log or report", async () => {
    // Review round 2, finding B: every leak the reviewer showed, at each length. The letters
    // hold no hex digit, so no hash in the log can contain a planted value by chance.
    const alphabet = "GHJKMNPQRSTVWXYZghjkmnpqrstvwxyz";
    const plant = (place: number, length: number) => {
      let x = place * 7919 + length * 104_729 + 17;
      let out = "";
      for (let i = 0; i < length; i++) {
        x = (x * 48_271) % 2_147_483_647;
        out += alphabet[x % alphabet.length] ?? "Q";
      }
      return out;
    };
    const lengths = [4, 5, 40];
    const at = (place: number) => lengths.map((n) => plant(place, n));
    const plain = at(0);
    const pathValued = at(1);
    const pathList = at(2);
    const equal = at(3);
    const cwdName = at(4);
    const clientName = at(5);
    const clientVersion = at(6);
    const tool = at(7);
    const parentArg = at(8);
    const all = [
      plain,
      pathValued,
      pathList,
      equal,
      cwdName,
      clientName,
      clientVersion,
      tool,
      parentArg,
    ].flat();
    expect(new Set(all).size).toBe(all.length);

    const planted: NodeJS.ProcessEnv = { TTASKS_TICKET: FIXTURE_TICKET };
    lengths.forEach((n, i) => {
      planted[`MIRA_PLAIN_${String(n)}`] = plain[i];
      const dir = join(work, `probe-dir-${pathValued[i] ?? ""}`);
      mkdirSync(dir, { recursive: true });
      planted[`MIRA_DIR_${String(n)}`] = dir;
      planted[`MIRA_LIST_${String(n)}`] = [
        join(work, `probe-none-${pathList[i] ?? ""}`),
        join(work, "probe-none-b"),
      ].join(delimiter);
      planted[`MIRA_COPY_${String(n)}`] = equal[i];
    });
    // Each equal value is also the value of an allow-listed identifier.
    planted["TTASKS_TASK"] = equal[0];
    planted["TTASKS_SPACE"] = equal[1];
    planted["CODEX_THREAD_ID"] = equal[2];
    // The cwd: inside the scratch root but not one of its folders, its name full of secrets.
    const cwd = join(tree.container, `probe-cwd-${cwdName.join("-")}`);
    mkdirSync(cwd, { recursive: true });
    const logDir = join(work, "probe-logs-planted");
    const probeArgs = [
      join(js, "probe.mjs"),
      "--log-dir",
      logDir,
      "--scratch-root",
      tree.container,
    ];
    // The probe's parent is a node process whose command line carries secrets.
    const parent = [
      'const { spawn } = require("node:child_process");',
      'const c = spawn(process.execPath, JSON.parse(process.argv[1]), { stdio: "inherit" });',
      'c.on("exit", (code) => process.exit(code ?? 1));',
    ].join("\n");
    const lines: unknown[] = [];
    lengths.forEach((_, i) => {
      lines.push(
        request(i, "initialize", {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: clientName[i] ?? "", version: clientVersion[i] ?? "" },
        }),
      );
      lines.push(request(10 + i, "tools/call", { name: tool[i] ?? "", arguments: {} }));
    });
    lines.push(request(20, "tools/call", { name: "probe_report", arguments: {} }));
    const result = await runChild(
      "-e",
      [parent, JSON.stringify(probeArgs), ...parentArg],
      lines,
      lines.length,
      fixtureEnv(planted),
      cwd,
    );
    expect(result.code, result.stderr).toBe(0);
    const replies = JSON.stringify(result.replies);
    const files = readdirSync(logDir);
    expect(files).toHaveLength(1);
    const text = readFileSync(join(logDir, files[0] ?? ""), "utf8");
    for (const secret of [...all, FIXTURE_TICKET]) {
      expect(text, secret).not.toContain(secret);
      expect(replies, secret).not.toContain(secret);
    }
    const records = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as JsonObject);
    const start = records.find((r) => r["kind"] === "start");
    expect(start?.["cwd"]).toEqual({
      sha256: sha256Hex(realpathSync.native(cwd)),
      inside_scratch: true,
      under_packages: false,
      tree: null,
      depth: 1,
    });
    const clients = records.filter((r) => r["kind"] === "mcp" && r["method"] === "initialize");
    expect(clients.map((r) => r["client"])).toEqual(clientName.map((name) => other(name)));
    expect(clients.map((r) => r["client_version"])).toEqual(clientVersion.map((v) => other(v)));
    expect(records.filter((r) => r["kind"] === "tool").map((r) => r["name"])).toEqual([
      ...tool.map((name) => other(name)),
      "probe_report",
    ]);
    // The allow-listed identifiers that equal a planted value were the only thing to redact.
    expect(start?.["env"]).toMatchObject({
      TTASKS_TASK: "[redacted]",
      TTASKS_SPACE: "[redacted]",
      CODEX_THREAD_ID: "[redacted]",
    });
    expect(records.at(-1)?.["redactions"]).toBeGreaterThan(0);
  });

  test("the probe's redactor replaces every planted value, with no path or length exemption", () => {
    const forty = `${"W".repeat(39)}z`;
    const env: NodeJS.ProcessEnv = {
      MIRA_FOUR: "Wq7z",
      MIRA_FIVE: "Wq7zK",
      MIRA_FORTY: forty,
      MIRA_SHORT: "Wq7",
      MIRA_DIR: work,
      MIRA_LIST: [join(work, "a"), join(work, "b")].join(delimiter),
      TTASKS_TASK: "tk-Vx9Q",
      MIRA_COPY: "tk-Vx9Q",
      USERNAME: "mira",
    };
    const redactor = createRedactor(env);
    const out = JSON.stringify(
      redactor.json({
        a: "Wq7z and Wq7zK",
        [`key ${forty}`]: "x",
        dir: join(work, "inner"),
        list: env["MIRA_LIST"] ?? "",
        task: "tk-Vx9Q",
        short: "Wq7 stays",
        user: "mira stays",
      }),
    );
    for (const value of ["Wq7z", forty, JSON.stringify(work).slice(1, -1), "tk-Vx9Q"]) {
      expect(out).not.toContain(value);
    }
    expect(out).toContain("Wq7 stays");
    expect(out).toContain("mira stays");
    expect(redactor.fired).toBeGreaterThanOrEqual(6);
    const quiet = createRedactor(env);
    quiet.json({ kind: "start", method: "initialize", client: "kit-self-test" });
    expect(quiet.fired).toBe(0);
  });

  test("the service refuses a state folder or key another principal can open", async () => {
    // Review finding 2 (and lab row R10). The pure rules first, then the real OS.
    const facts = {
      uid: 1000,
      mode: 0o40700,
      isDirectory: true,
      isFile: false,
      isSymbolicLink: false,
    };
    expect(posixProblems("dir", facts, 1000)).toEqual([]);
    expect(posixProblems("dir", { ...facts, mode: 0o40750 }, 1000)).toEqual([]);
    expect(posixProblems("dir", { ...facts, mode: 0o40770 }, 1000)).toHaveLength(1);
    expect(posixProblems("dir", facts, 1001)).toHaveLength(1);
    expect(posixProblems("dir", { ...facts, isSymbolicLink: true }, 1000)).toHaveLength(1);
    const key = {
      uid: 1000,
      mode: 0o100600,
      isDirectory: false,
      isFile: true,
      isSymbolicLink: false,
    };
    expect(posixProblems("key", key, 1000)).toEqual([]);
    expect(posixProblems("key", { ...key, mode: 0o100640 }, 1000)).toHaveLength(1);
    const user = "S-1-5-21-1-2-3-1001";
    const entry = (sid: string, type = "Allow") => ({
      sid,
      type,
      rights: "Read",
      inherited: true,
      inheritOnly: false,
    });
    const acl = (owner: string, ...entries: ReturnType<typeof entry>[]) => ({
      path: "x",
      owner,
      entries,
    });
    expect(
      aclProblems(
        acl(user, entry(user), entry("S-1-5-18"), entry("S-1-5-32-544"), entry("S-1-3-0")),
        user,
      ),
    ).toEqual([]);
    expect(aclProblems(acl(user, entry("S-1-1-0", "Deny")), user)).toEqual([]);
    expect(aclProblems(acl(user, entry("S-1-1-0")), user)).toHaveLength(1);
    expect(
      aclProblems(acl(user, { ...entry("S-1-5-32-545"), inheritOnly: true }), user),
    ).toHaveLength(1);
    expect(aclProblems(acl("S-1-5-21-9-9-9-1002", entry(user)), user)).toHaveLength(1);

    const open = join(work, "open-state");
    mkdirSync(open, { recursive: true });
    if (process.platform === "win32") {
      // An inheritable Everyone:R entry, as in the review.
      const icacls = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "icacls.exe");
      expect(spawnSync(icacls, [open, "/grant", "*S-1-1-0:(OI)(CI)R"]).status).toBe(0);
      await expect(startService({ state: open })).rejects.toMatchObject({
        code: "unsafe_permissions",
      });
      expect(existsSync(join(open, "ipc.key"))).toBe(false);
      expect(existsSync(join(open, "service.json"))).toBe(false);

      // What the service creates carries a user-only ACL, not the inherited one.
      const { user: sid, items } = readAcls([state, join(state, "ipc.key")]);
      for (const item of items) {
        expect(item.entries.map((e) => [e.sid, e.inherited])).toEqual([[sid, false]]);
        expect(aclProblems(item, sid)).toEqual([]);
      }
    } else {
      chmodSync(open, 0o777);
      await expect(startService({ state: open })).rejects.toMatchObject({
        code: "unsafe_permissions",
      });
      expect(existsSync(join(open, "service.json"))).toBe(false);
      chmodSync(open, 0o700);
      writeFileSync(join(open, "ipc.key"), Buffer.alloc(32, 1), { mode: 0o644 });
      chmodSync(join(open, "ipc.key"), 0o644);
      await expect(startService({ state: open })).rejects.toMatchObject({
        code: "unsafe_permissions",
      });
      expect(existsSync(join(open, "service.json"))).toBe(false);
      expect(statSync(state).mode & 0o777).toBe(0o700);
      expect(statSync(join(state, "ipc.key")).mode & 0o777).toBe(0o600);
    }
  });

  test("the SDDL reader resolves owners and entries by SID and fails closed", () => {
    // Review round 2, finding A: the Windows check now parses SDDL, so its rules run everywhere.
    const user = "S-1-5-21-1-2-3-1001";
    const parsed = parseSddl(
      "x",
      `O:${user}D:PAI(A;OICI;FA;;;${user})(A;OICIID;FA;;;SY)(A;OICIIOID;GA;;;CO)(D;;FA;;;WD)`,
      user,
    );
    expect(parsed.owner).toBe(user);
    expect(parsed.entries).toEqual([
      { sid: user, type: "Allow", rights: "FA", inherited: false, inheritOnly: false },
      { sid: "S-1-5-18", type: "Allow", rights: "FA", inherited: true, inheritOnly: false },
      { sid: "S-1-3-0", type: "Allow", rights: "GA", inherited: true, inheritOnly: true },
      { sid: "S-1-1-0", type: "Deny", rights: "FA", inherited: false, inheritOnly: false },
    ]);
    expect(aclProblems(parsed, user)).toEqual([]);
    expect(parseSddl("x", "O:BAD:(A;;FA;;;BA)", user).owner).toBe("S-1-5-32-544");
    expect(aclProblems(parseSddl("x", "O:BAD:(A;;FA;;;BA)", user), user)).toEqual([]);
    // Everyone, Users, Authenticated Users and the Codex sandbox group's SID are refused.
    for (const trustee of ["WD", "BU", "AU", "S-1-5-21-9-9-9-2310774133"]) {
      expect(
        aclProblems(parseSddl("x", `O:${user}D:(A;OICIID;0x1301bf;;;${trustee})`, user), user),
      ).toHaveLength(1);
    }
    // A null or missing DACL grants everyone everything.
    expect(aclProblems(parseSddl("x", `O:${user}D:NO_ACCESS_CONTROL`, user), user)).toHaveLength(1);
    expect(aclProblems(parseSddl("x", `O:${user}`, user), user)).toHaveLength(1);
    // An unknown alias or ACE type is never trusted. LA is the user only when the user is RID 500.
    expect(aclProblems(parseSddl("x", `O:${user}D:(A;;FA;;;QQ)`, user), user)).toHaveLength(1);
    expect(aclProblems(parseSddl("x", `O:${user}D:(ZZ;;FA;;;WD)`, user), user)).toHaveLength(1);
    expect(aclProblems(parseSddl("x", "O:LAD:(A;;FA;;;LA)", user), user)).toHaveLength(2);
    const admin = "S-1-5-21-1-2-3-500";
    expect(aclProblems(parseSddl("x", "O:LAD:(A;;FA;;;LA)", admin), admin)).toEqual([]);
    expect(
      aclProblems(parseSddl("x", `O:S-1-5-21-9-9-9-1002D:(A;;FA;;;${user})`, user), user),
    ).toHaveLength(1);
    expect(() => parseSddl("x", "D:(A;;FA;;;SY)", user)).toThrow(KitError);
    // Review round 3: a conditional ACE nests parentheses. A flat reader stopped at its first ")"
    // and never saw the Everyone grant after it. Such a descriptor is refused, not interpreted.
    const hidden = `O:${user}D:P(XD;;FA;;;WD;(Member_of {SID(BG)}))(A;;FA;;;WD)`;
    expect(() => parseSddl("x", hidden, user)).toThrow(/conditional or callback entry/);
    for (const bad of [
      `O:${user}D:(XA;;FA;;;${user};(Member_of {SID(BA)}))`, // conditional allow
      `O:${user}D:(XA;;FA;;;${user})`, // callback type without an expression
      `O:${user}D:(ZA;;FA;;;${user})`,
      `O:${user}D:(A;;FA;;;${user};extra)`, // a seventh field
      `O:${user}D:(A;;FA;;;${user})trailing`, // text outside an entry
      `O:${user}D:(A;;FA;;;${user})(A;;FA;;;WD`, // an unclosed entry
      `O:${user}X:(A;;FA;;;${user})`, // an unknown part after the owner
    ]) {
      expect(() => parseSddl("x", bad, user), bad).toThrow(KitError);
    }
    // A group part between owner and DACL is read, and an entry after the user's is still seen.
    expect(
      aclProblems(parseSddl("x", `O:${user}G:BAD:(A;;FA;;;${user})(A;;FA;;;WD)`, user), user),
    ).toHaveLength(1);
  });

  test.skipIf(process.platform !== "win32")(
    "an existing key whose DACL hides a grant behind a conditional entry is refused",
    () => {
      // The reviewer's reproduction on a real file: Windows accepts this descriptor, and the old
      // reader then judged the key private.
      const dir = mkdtempSync(join(tmpdir(), "ttasks-kit-acl-"));
      try {
        const key = join(dir, "ipc.key");
        writeFileSync(key, "fixture");
        const me = readAcls([dir]).user;
        const sddl = `O:${me}D:P(XD;;FA;;;WD;(Member_of {SID(BG)}))(A;;FA;;;WD)(A;;FA;;;${me})`;
        const powershell = join(
          process.env["SystemRoot"] ?? "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        );
        const set = spawnSync(
          powershell,
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$a=New-Object Security.AccessControl.FileSecurity; " +
              "$a.SetSecurityDescriptorSddlForm($env:TTASKS_T_SDDL," +
              "[Security.AccessControl.AccessControlSections]::Access); " +
              "[IO.File]::SetAccessControl($env:TTASKS_T_KEY,$a)",
          ],
          {
            // The same minimal environment the permission reader gives Windows PowerShell.
            // Without TEMP and SystemDrive it took 30 s to start on the CI runner.
            env: {
              SystemRoot: process.env["SystemRoot"],
              windir: process.env["windir"],
              SystemDrive: process.env["SystemDrive"],
              TEMP: process.env["TEMP"],
              TMP: process.env["TMP"],
              TTASKS_T_KEY: key,
              TTASKS_T_SDDL: sddl,
            },
            windowsHide: true,
            // A loaded windows-2025 runner once needed more than 60 s to start it.
            timeout: 120_000,
          },
        );
        expect(set.status, set.stderr.toString()).toBe(0);
        expect(() => assertPrivate([{ path: key, kind: "key", what: "key" }])).toThrow(
          /conditional or callback entry/,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    240_000,
  );

  test("the service restarts on its own state under a hostile PSModulePath", async () => {
    // Review round 2, finding A: from PowerShell 7, Windows PowerShell inherited PS7's module
    // path, Get-Acl failed to load, and every restart refused its own state as unsafe. A module
    // path that holds a broken Microsoft.PowerShell.Security (and PS7's own folder when present)
    // must not matter now.
    if (process.platform !== "win32") return;
    const hostile = join(work, "hostile-modules");
    const fake = join(hostile, "Microsoft.PowerShell.Security");
    mkdirSync(fake, { recursive: true });
    writeFileSync(
      join(fake, "Microsoft.PowerShell.Security.psd1"),
      "@{ ModuleVersion = '99.0'; RootModule = 'broken.psm1'; FunctionsToExport = @('Get-Acl') }\n",
    );
    writeFileSync(join(fake, "broken.psm1"), "throw 'hostile module loaded'\n");
    const ps7 = join(
      process.env["ProgramFiles"] ?? "C:\\Program Files",
      "PowerShell",
      "7",
      "Modules",
    );
    const saved = process.env["PSModulePath"];
    process.env["PSModulePath"] = [hostile, ...(existsSync(ps7) ? [ps7] : [])].join(delimiter);
    // The parent passes down no inheritable entry, as CI's TEMP does: a new folder then gets the
    // token's default DACL as explicit entries, which the user-only ACL must remove too.
    const parent = join(work, "no-inherit");
    mkdirSync(parent, { recursive: true });
    const icaclsExe = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "icacls.exe");
    const me = readAcls([]).user;
    expect(spawnSync(icaclsExe, [parent, "/inheritance:r", "/grant:r", `*${me}:F`]).status).toBe(0);
    const restartState = join(parent, "restart-state");
    try {
      for (let round = 0; round < 3; round++) {
        const svc = await ownedService({ state: restartState });
        const rpc = await cli(restartState);
        expect(((await rpc.call("service/status")) as JsonObject)["instance"]).toBe(
          svc.info.instance,
        );
        rpc.close();
        await svc.close();
      }
      const { user, items } = readAcls([restartState, join(restartState, "ipc.key")]);
      for (const item of items) {
        // An elevated administrator's new objects are owned by Administrators (CI's runner).
        expect([user, "S-1-5-32-544"]).toContain(item.owner);
        expect(item.entries.map((e) => [e.sid, e.type, e.inherited])).toEqual([
          [user, "Allow", false],
        ]);
      }
    } finally {
      if (saved === undefined) delete process.env["PSModulePath"];
      else process.env["PSModulePath"] = saved;
    }
  }, 60_000);

  test("a permission check that cannot run refuses with its own error, not unsafe_permissions", async () => {
    if (process.platform !== "win32") return;
    const inspect = { powershell: join(work, "no-such-powershell.exe") };
    for (const at of [join(work, "inspect-new"), state]) {
      const refused = await startService({ state: at, inspect }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(KitError);
      expect(refused).toMatchObject({ code: "cannot_inspect_permissions" });
      expect((refused as KitError).message).toMatch(/^Cannot inspect permissions: /);
    }
    expect(existsSync(join(work, "inspect-new", "service.json"))).toBe(false);
    // An item the reader cannot open is reported as unreadable, never as unsafe.
    expect(() => readAcls([join(work, "no-such-folder")])).toThrow(
      expect.objectContaining({ code: "cannot_inspect_permissions" }),
    );
  });

  test("the socket folder is the per-user runtime folder first and <state>/run second", async () => {
    // Review finding 5 (E02). The selection logic on every OS, then the real thing on Linux.
    const base = join(work, "run-user");
    const usable = (dir: string) => dir === join(base, "1000");
    const pick = (choice: "auto" | "run-user" | "state", uid: number | undefined) =>
      selectSocketDir({ choice, state: "st", install: "abc", uid, runUserBase: base, usable });
    expect(pick("auto", 1000)).toEqual({ dir: join(base, "1000", "ttasks-abc"), kind: "run-user" });
    expect(pick("auto", 1001)).toEqual({ dir: join("st", "run"), kind: "state" });
    expect(pick("auto", undefined)).toEqual({ dir: join("st", "run"), kind: "state" });
    expect(pick("state", 1000)).toEqual({ dir: join("st", "run"), kind: "state" });
    expect(pick("run-user", 1000)).toEqual({
      dir: join(base, "1000", "ttasks-abc"),
      kind: "run-user",
    });
    expect(() => pick("run-user", 1001)).toThrow(KitError);

    if (process.platform !== "linux") return;
    const uid = String(process.getuid?.() ?? -1);
    mkdirSync(join(base, uid), { recursive: true, mode: 0o700 });
    chmodSync(join(base, uid), 0o700);
    const runUser = await startService({ state: join(work, "e02-run-user"), runUserBase: base });
    try {
      expect(runUser.info.runtime).toBe("run-user");
      expect(runUser.info.endpoint.path.startsWith(join(base, uid, "ttasks-"))).toBe(true);
      expect(statSync(join(runUser.info.endpoint.path, "..")).mode & 0o777).toBe(0o700);
      const rpc = await cli(join(work, "e02-run-user"));
      expect(((await rpc.call("service/status")) as JsonObject)["runtime"]).toBe("run-user");
      rpc.close();
    } finally {
      await runUser.close();
    }
    const forced = await startService({
      state: join(work, "e02-state"),
      runUserBase: base,
      socketDir: "state",
    });
    expect(forced.info.endpoint.path).toBe(join(work, "e02-state", "run", "ttasks.sock"));
    await forced.close();
    chmodSync(join(base, uid), 0o770); // group-writable: auto falls back
    const fallback = await startService({ state: join(work, "e02-fallback"), runUserBase: base });
    expect(fallback.info.runtime).toBe("state");
    await fallback.close();
    await expect(
      startService({ state: join(work, "e02-forced"), runUserBase: base, socketDir: "run-user" }),
    ).rejects.toMatchObject({ code: "runtime_dir_unavailable" });
  });

  test("the run shim leads no group, survives a service restart and forwards a cancel", async () => {
    // Review item 9: the run-shim topology of A4 3.11 for rows S01, S04 and N01-N04.
    const agent = [
      'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
      'let brief = "";',
      'process.stdin.on("data", (d) => { brief += d; });',
      'process.stdin.on("end", () => out({ event: "brief", length: brief.length }));',
      'for (const s of ["SIGINT", "SIGHUP", "SIGBREAK"]) {',
      "  try { process.on(s, () => { out({ event: s.toLowerCase() }); setTimeout(() => process.exit(130), 50); }); } catch {}",
      "}",
      'out({ event: "started" });',
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const runState = join(work, "run-state");
    // Finding E: the shim and the agent are owned outside the body, so `finally` always ends them.
    const procs: { shim?: number; agent?: number } = {};
    let svc = await ownedService({ state: runState });
    const brief = "Mira brief M-14";
    try {
      const rpc = await cli(runState);
      const minted = (await rpc.call("spike.mint_ticket", {
        argv: [process.execPath, "-e", agent],
        cwd: tree.exactRoot,
        run: true,
        brief,
      })) as { ticket: string; run: string };
      rpc.close();
      // An interactive shim cannot claim a run ticket: the claim's role must match.
      const wrongRole = await runChild(
        join(js, "shim.mjs"),
        ["--state", runState, minted.ticket],
        [],
        0,
      );
      expect(wrongRole.code).toBe(75);
      const shim = startRunShim(runState, ["--grace", "1500"], minted.ticket);
      procs.shim = shim.pid;
      const runDir = join(runState, "runs", minted.run);
      const started = await waitFor(
        () => svc.events.find((e) => e.kind === "run.started"),
        15_000,
        "run.started",
      );
      const agentPid = await agentOf(runDir);
      procs.agent = agentPid;
      await waitFor(
        () => readIf(join(runDir, "stdout.jsonl")).includes('"brief"'),
        15_000,
        "the agent",
      );
      const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8")) as JsonObject;
      expect(started["pid"]).toBe(agentPid);
      expect(meta["shim_pid"]).toBe(shim.pid);
      if (process.platform !== "win32") {
        expect(meta["pgid"]).toBe(agentPid); // the agent leads its own group (setsid)
      }

      // S04: the agent and the shim survive the service going away, and the shim re-attaches.
      await svc.close();
      await sleep(500);
      expect(alive(agentPid)).toBe(true);
      expect(shim.child.exitCode).toBeNull();
      svc = await ownedService({ state: runState });
      await waitFor(() => svc.events.find((e) => e.kind === "run.attach"), 15_000, "run.attach");

      // N01-N04 and S01: a cancel through the new service reaches the agent's group, not the shim.
      const again = await cli(runState);
      expect(await again.call("spike.cancel_run", { run: minted.run })).toEqual({ sent: true });
      again.close();
      const exited = await waitFor(
        () => svc.events.find((e) => e.kind === "run.exited"),
        20_000,
        "run.exited",
      );
      const { code, signal } = await shim.exit;
      expect(code, shim.stderr()).toBe(0);
      expect(signal).toBeNull();
      expect(svc.events.some((e) => e.kind === "run.signal")).toBe(false);
      expect(existsSync(join(runDir, "shim-signals.log"))).toBe(false);
      const stdout = readFileSync(join(runDir, "stdout.jsonl"), "utf8");
      expect(stdout).toContain(`"length":${String(brief.length)}`);
      const cancels = svc.events.filter((e) => e.kind === "run.cancel");
      if (process.platform === "win32") {
        // taskkill /T without /F first. A console-less agent cannot observe it (row N03 asks
        // whether a console-attach helper is needed), so the forced stop follows after --grace.
        expect(cancels[0]).toMatchObject({ method: "taskkill /T" });
        expect(cancels.map((c) => c["method"])).toContain("taskkill /T /F");
      } else {
        expect(cancels[0]).toMatchObject({ method: "SIGINT to group", status: "sent" });
        expect(stdout).toContain('"event":"sigint"');
        expect(exited["code"]).toBe(130);
      }
      const outcome = JSON.parse(readFileSync(join(runDir, "exit.json"), "utf8")) as JsonObject;
      expect(outcome).toMatchObject({ cancelled: true, code: exited["code"] });
      expect(readFileSync(join(runState, "events.jsonl"), "utf8")).not.toContain(brief);
      expect(alive(agentPid)).toBe(false);
    } finally {
      for (const pid of [procs.agent, procs.shim]) if (pid !== undefined) await killTree(pid);
      await svc.close();
    }
  }, 60_000);

  test("a late run.attach neither keeps a finished run shim alive nor loses its exit report", async () => {
    // Review round 2, finding D: an attach that began before the agent exited and was answered
    // after the reporting window kept the shim alive with run.exited never sent.
    for (const scenario of ["after the window", "within the window"] as const) {
      const late = scenario === "after the window";
      const runState = join(work, `late-attach-${late ? "after" : "within"}`);
      const go = join(work, `late-attach-go-${late ? "after" : "within"}`);
      // The agent waits for the go file, then exits 3.
      const agent = [
        "const fs = require('node:fs');",
        "const go = process.argv[1];",
        "const t = setInterval(() => { if (fs.existsSync(go)) { clearInterval(t); process.exit(3); } }, 50);",
      ].join("\n");
      const procs: { shim?: number; agent?: number } = {};
      let svc = await ownedService({ state: runState });
      try {
        const rpc = await cli(runState);
        const minted = (await rpc.call("spike.mint_ticket", {
          argv: [process.execPath, "-e", agent, go],
          cwd: tree.exactRoot,
          run: true,
          brief: "",
        })) as { ticket: string; run: string };
        rpc.close();
        const window = late ? 1_500 : 8_000;
        const shim = startRunShim(runState, ["--report-window", String(window)], minted.ticket);
        procs.shim = shim.pid;
        const runDir = join(runState, "runs", minted.run);
        await waitFor(() => svc.events.find((e) => e.kind === "run.started"), 15_000, "started");
        procs.agent = await agentOf(runDir);

        // The service restarts as a slow one: its reply to run.attach comes 2.5 s (within the
        // window) or 4.5 s (after the 1.5 s window) after the request.
        await svc.close();
        const delay = late ? 4_500 : 2_500;
        svc = await ownedService({
          state: runState,
          replyDelayMs: (method) => (method === "run.attach" ? delay : 0),
        });
        await waitFor(
          () => svc.events.find((e) => e.kind === "rpc" && e["method"] === "run.attach"),
          15_000,
          "the attach request",
        );
        // The agent exits while the attach is still unanswered.
        writeFileSync(go, "go");
        const exitedAt = await waitFor(
          () => (existsSync(join(runDir, "exit.json")) ? Date.now() : undefined),
          10_000,
          "exit.json",
        );
        const { code } = await shim.exit;
        expect(code, shim.stderr()).toBe(0);
        const outcome = JSON.parse(readFileSync(join(runDir, "exit.json"), "utf8")) as JsonObject;
        expect(outcome).toMatchObject({ code: 3, cancelled: false });
        if (late) {
          // The shim did not wait for the late reply: it left at the end of its window, and
          // exit.json is the record. The late reply finds nobody to adopt it.
          expect(Date.now() - exitedAt).toBeLessThan(delay - 500);
          expect(shim.stderr()).toContain("exit.json holds it");
          await sleep(delay);
          expect(svc.events.some((e) => e.kind === "run.exited")).toBe(false);
        } else {
          // The attach that completed within the window carried the exit report.
          expect(svc.events.find((e) => e.kind === "run.exited")).toMatchObject({ code: 3 });
        }
        expect(alive(shim.pid)).toBe(false);
      } finally {
        for (const pid of [procs.agent, procs.shim]) if (pid !== undefined) await killTree(pid);
        await svc.close();
      }
    }
  }, 90_000);

  test("the scratch tree has an exact root, nested folder, worktree, clone and odd names", () => {
    for (const path of Object.values(tree) as string[]) expect(existsSync(path), path).toBe(true);
    expect(tree.nested.startsWith(tree.exactRoot)).toBe(true);
    expect(existsSync(join(tree.worktree, ".git"))).toBe(true);
    expect(readFileSync(join(tree.worktree, ".git"), "utf8")).toMatch(/^gitdir: /);
    expect(existsSync(join(tree.siblingClone, ".git", "config"))).toBe(true);
    expect(tree.unicode).toMatch(/[^ -~]/);
    expect(tree.punctuation).toMatch(/[&'()[\]#%!;=,+@~$]/);
    expect(JSON.parse(readFileSync(join(tree.container, "tree.json"), "utf8"))).toEqual(tree);
  });

  test("the other-accounts check and the bench run", async () => {
    const accounts = otherAccounts();
    expect(Array.isArray(accounts)).toBe(true);
    const bench = await runBench({ work: join(work, "bench"), runs: 2 });
    expect(bench.cold).toBe(false);
    for (const metric of [bench.forwarder_online, bench.forwarder_offline, bench.shim_claim]) {
      expect(metric?.runs).toBe(2);
      expect(metric?.p95).toBeGreaterThan(0);
    }
  }, 60_000);

  test("a cold bench run needs one metric and a fresh prebuilt kit, and never builds", async () => {
    // Review finding 4: a cold run must not build or warm the files it times.
    const coldWork = join(work, "bench-cold");
    await expect(
      runBench({ work: coldWork, runs: 1, cold: true, metric: "forwarder_offline" }),
    ).rejects.toMatchObject({ code: "kit_missing" });
    expect(existsSync(join(coldWork, "kit-js"))).toBe(false);
    const coldKit = buildKit(join(work, "kit-cold"));
    await expect(
      runBench({ work: coldWork, runs: 1, cold: true, kit: coldKit }),
    ).rejects.toMatchObject({
      code: "usage",
    });
    const recordPath = join(coldKit, "build.json");
    const original = readFileSync(recordPath, "utf8");
    const record = JSON.parse(original) as { sources: Record<string, string> };
    record.sources["wire.ts"] = "0".repeat(64);
    writeFileSync(recordPath, JSON.stringify(record));
    await expect(
      runBench({ work: coldWork, runs: 1, cold: true, kit: coldKit, metric: "shim_claim" }),
    ).rejects.toMatchObject({ code: "kit_stale" });
    writeFileSync(recordPath, original);

    const result = await runBench({
      work: coldWork,
      runs: 20,
      cold: true,
      kit: coldKit,
      metric: "shim_claim",
    });
    expect(result.cold).toBe(true);
    expect(result.shim_claim?.runs).toBe(1);
    expect(result.forwarder_online).toBeUndefined();
    expect(result.forwarder_offline).toBeUndefined();
    expect(existsSync(join(coldWork, "kit-js"))).toBe(false);

    rmSync(join(coldKit, "forwarder.mjs"));
    await expect(
      runBench({ work: coldWork, runs: 1, cold: true, kit: coldKit, metric: "forwarder_online" }),
    ).rejects.toMatchObject({ code: "kit_missing" });
  }, 60_000);
});
