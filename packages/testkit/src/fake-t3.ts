// A fake T3 Code server for the T3 route's tests (A4 3.4.1, A4 5.1 "Fake T3 server", A7 3.9
// M2.11). It listens on a loopback port the OS assigns and plays what an outside MCP client of T3
// sees: the server's origin in `<home>/userdata/server-runtime.json`, OAuth discovery, dynamic
// client registration and the authorization code flow with PKCE (S256), and MCP over Streamable
// HTTP at `<origin>/mcp` with the tools the route calls. Tests only; fixture data only.
//
// What is measured and what is assumed (A4 3.4.1): nothing of T3's server has
// been observed by the lab yet (L05 and L06 wait for lab sessions). The tool names and their input
// fields follow the T3 MCP tool schemas as T3 lists them to an agent session on Windows
// (2026-11-14) and A4 3.4.1 (T3 source at `322f6544`). The answers' shapes, the OAuth endpoints
// (the MCP authorization specification's discovery, RFC 7591 registration, RFC 7636 PKCE), the
// file `server-runtime.json` with an `origin` field, and the rule that a thread's ID derives from the
// authorization (the "grant namespace") and `clientRequestId` are assumed from A4 and the MCP
// specification. The fake keeps its state across a restart, as T3 keeps its database, and forgets
// its MCP sessions, as a new server process would.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { basename, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type { FakeT3CliRecord } from "./fakes/t3-cli.ts";

/**
 * The fake `t3` command line (M6.10), run as `node <file>`: it needs a running FakeT3 (it reads the
 * origin from `$T3CODE_HOME/userdata/server-runtime.json`), which does its work at `/fake-cli`.
 */
export const FAKE_T3_CLI = fileURLToPath(new URL("./fakes/t3-cli.ts", import.meta.url));

/** The commands the fake CLI knows, by their first two words. */
export type FakeT3CliCommand = "project list" | "project add" | "thread start";

/** One run of the fake CLI as the fake server saw it. Fixture data only. */
export interface FakeT3CliCall {
  readonly argv: readonly string[];
  readonly stdin: string | null;
  /** `answered`: it did the work; `error`: T3 refused it; `fault`: a fault set by the test. */
  readonly outcome: "answered" | "error" | "fault";
}

/** How the next run of a CLI command goes wrong (`cliNext`). */
export interface FakeT3CliFault {
  /** Do the work first, then answer as below (a CLI that fails after it acted). */
  readonly run?: boolean;
  readonly exit?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  /** Never answer: the CLI hangs until its time bound or until it is killed. */
  readonly hang?: boolean;
}

export interface FakeT3Project {
  readonly id: string;
  title: string;
  /** Writable: T3 can change a project's root after Tasks bound it (a test sets it). */
  workspaceRoot: string;
  archivedAt: string | null;
}

export interface FakeT3Thread {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly worktreePath: string | null;
  /** The authorization (T3's request namespace) the thread was created under. */
  readonly namespace: string;
  readonly clientRequestId: string | null;
  readonly modelSelection: unknown;
  readonly runtimeMode: unknown;
  /**
   * Whether a first message was sent, which starts an agent turn. The MCP route never sends one;
   * the CLI route's `thread start` always does (A4 3.4.1).
   */
  readonly message: boolean;
  /** The CLI route's message, as `thread start` read it from stdin. Fixture text. */
  readonly sent?: string;
}

/** One `tools/call` as the fake saw it. IDs and outcomes only. */
export interface FakeT3Call {
  readonly tool: string;
  readonly namespace: string | null;
  readonly clientRequestId: string | null;
  readonly projectId: string | null;
  readonly outcome:
    | "answered"
    | "error"
    | "dropped_before"
    | "dropped_after"
    | "rpc_error_before"
    | "rpc_error_after"
    | "http_refused"
    | "unauthorized";
}

/** What the authorization page saw of one attempt: no secret, only what the URL carried. */
export interface FakeT3Authorize {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallengeMethod: string | null;
  readonly codeChallenge: string | null;
  readonly state: string | null;
  readonly resource: string | null;
}

interface Client {
  readonly id: string;
  readonly redirectUris: readonly string[];
}

interface Code {
  readonly client: string;
  readonly redirectUri: string;
  readonly challenge: string;
  used: boolean;
}

interface Token {
  readonly namespace: string;
  readonly kind: "access" | "refresh";
  readonly client: string;
  revoked: boolean;
}

/** A reply the fake drops: before it does the call, or after. `then` runs before the drop. */
interface Fault {
  readonly tool: string;
  readonly when: "before" | "after";
  readonly then?: (() => Promise<void>) | undefined;
  /** Answer with this JSON-RPC error code instead of cutting the connection. */
  readonly rpcError?: number;
  /** Answer with this HTTP status (before) instead of cutting the connection. */
  readonly httpStatus?: number;
}

const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26"];

const sha256url = (text: string): string => createHash("sha256").update(text).digest("base64url");
const random = (prefix: string): string => `${prefix}${randomBytes(12).toString("hex")}`;

/** The worktrees `git worktree list` names for a project root, by real path; undefined without git. */
function gitWorktrees(root: string): string[] | undefined {
  const run = spawnSync("git", ["-C", root, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (run.status !== 0) return undefined;
  return run.stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

/** A real path for comparison, case-folded where the OS folds case (T3 compares real paths). */
function realKey(path: string): string | undefined {
  try {
    const real = realpathSync.native(path);
    return process.platform === "win32" || process.platform === "darwin"
      ? real.toLowerCase()
      : real;
  } catch {
    return undefined;
  }
}

export class FakeT3 {
  /** The fake's own T3 home: what `~/.t3` is to the real app. */
  readonly home: string;
  readonly environmentId = "env-fake-local";

  /** What the authorization page does: approve with full access, or deny. */
  approval: "approve" | "deny" = "approve";
  /** Seconds an access token lives, or undefined for no `expires_in`. */
  expiresIn: number | undefined = 3600;
  /** Whether a refresh keeps the authorization's namespace (L05 will tell for the real T3). */
  refreshKeepsNamespace = true;
  /** Answer MCP requests as an SSE stream instead of a JSON body. */
  sse = false;
  /** With `sse`: keep each stream open after its reply, as the specification allows. */
  sseKeepOpen = false;

  readonly projects = new Map<string, FakeT3Project>();
  readonly threads = new Map<string, FakeT3Thread>();
  readonly calls: FakeT3Call[] = [];
  /** Every run of the fake CLI that reached the server, in order. */
  readonly cliCalls: FakeT3CliCall[] = [];
  readonly authorizes: FakeT3Authorize[] = [];
  readonly registrations: Client[] = [];
  /** Requests to `/mcp` without a valid token. */
  unauthorized = 0;
  /** Requests to the token endpoint. */
  tokenRequests = 0;
  /** While set, client registrations wait for it before they answer (to overlap two pairings). */
  registrationGate: Promise<void> | undefined;
  /** Registrations waiting at the gate now. */
  registrationsWaiting = 0;

  readonly #clients = new Map<string, Client>();
  readonly #codes = new Map<string, Code>();
  readonly #tokens = new Map<string, Token>();
  readonly #sessions = new Map<string, string>();
  readonly #faults: Fault[] = [];
  readonly #cliFaults: { command: FakeT3CliCommand; fault: FakeT3CliFault }[] = [];
  readonly #hooks: { tool: string; hook: () => void }[] = [];
  #server: Server | undefined;
  readonly #sockets = new Set<Socket>();
  #origin = "";
  #projectCount = 0;

  private constructor(home: string) {
    this.home = home;
  }

  /** Starts a fake T3 whose home is `home` (created), on a port the OS assigns. */
  static async start(home: string): Promise<FakeT3> {
    const fake = new FakeT3(home);
    await fake.#listen(0);
    return fake;
  }

  get origin(): string {
    return this.#origin;
  }

  /** `<home>/userdata/server-runtime.json`, which names the running server's origin. */
  get runtimeFile(): string {
    return join(this.home, "userdata", "server-runtime.json");
  }

  /** Registers a project at `root` as T3's UI would. Returns its ID. */
  addProject(root: string, title = "Fixture project"): string {
    this.#projectCount += 1;
    const id = `proj-${String(this.#projectCount).padStart(4, "0")}-${randomBytes(3).toString("hex")}`;
    this.projects.set(id, { id, title, workspaceRoot: root, archivedAt: null });
    return id;
  }

  /** Makes the next call of `tool` lose its reply: the connection is cut before or after it runs. */
  dropNext(tool: string, when: "before" | "after", then?: () => Promise<void>): void {
    this.#faults.push({ tool, when, then });
  }

  /**
   * Makes the next call of `tool` answer with JSON-RPC error `code` instead of its result: before
   * the tool runs (as a server that refuses the request), or after it ran (as a server whose
   * handler failed late, or one that turns any failure into an internal error).
   */
  errorNext(tool: string, code: number, when: "before" | "after"): void {
    this.#faults.push({ tool, when, rpcError: code });
  }

  /** Makes the next call of `tool` answer HTTP `status` (a 4xx) before anything runs. */
  refuseNext(tool: string, status: number): void {
    this.#faults.push({ tool, when: "before", httpStatus: status });
  }

  /**
   * Runs `hook` just before the next call of `tool` is checked and done: time can pass there (a
   * token running out between the start of a call and the request that carries it).
   */
  beforeNext(tool: string, hook: () => void): void {
    this.#hooks.push({ tool, hook });
  }

  /** Makes the next run of the CLI's `command` go wrong as `fault` says. */
  cliNext(command: FakeT3CliCommand, fault: FakeT3CliFault): void {
    this.#cliFaults.push({ command, fault });
  }

  /** The CLI runs of one command. */
  cliCallsOf(command: FakeT3CliCommand): FakeT3CliCall[] {
    return this.cliCalls.filter((call) => call.argv.slice(0, 2).join(" ") === command);
  }

  /** Revokes every token, as T3 does when its grant is removed: every request is then a 401. */
  revokeAll(): void {
    for (const token of this.#tokens.values()) token.revoked = true;
  }

  /**
   * Lets every access token issued so far run out, as time past `expires_in` does: a request with
   * one is a 401, and the refresh tokens still work.
   */
  expireAccessTokens(): void {
    for (const token of this.#tokens.values()) {
      if (token.kind === "access") token.revoked = true;
    }
  }

  /** The tools/call log of one tool. */
  callsOf(tool: string): FakeT3Call[] {
    return this.calls.filter((call) => call.tool === tool);
  }

  /**
   * Stops and starts the server again, keeping its projects, threads, clients and tokens, as T3
   * keeps them in its database. MCP sessions are forgotten. `samePort` listens on the port it had;
   * otherwise the OS assigns a new one and `server-runtime.json` names it.
   */
  async restart(options: { samePort?: boolean } = {}): Promise<void> {
    const port = Number(new URL(this.#origin).port);
    await this.stop();
    this.#sessions.clear();
    await this.#listen(options.samePort === true ? port : 0);
  }

  /** Stops the server and removes `server-runtime.json`, as a T3 that quit. */
  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server === undefined) return;
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    rmSync(this.runtimeFile, { force: true });
  }

  /**
   * Plays the browser on T3's approval page: opens the authorization URL, and follows the redirect
   * the page gives to the client's loopback callback. Returns the callback's HTTP status.
   */
  async approveInBrowser(url: string): Promise<number> {
    const page = await fetch(url, { redirect: "manual" });
    await page.arrayBuffer();
    const location = page.headers.get("location");
    if (page.status !== 302 || location === null) return page.status;
    const callback = await fetch(location, { redirect: "manual" });
    await callback.arrayBuffer();
    return callback.status;
  }

  async #listen(port: number): Promise<void> {
    const server = createServer((req, res) => {
      this.#handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    server.on("connection", (socket) => {
      this.#sockets.add(socket);
      socket.on("close", () => this.#sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    this.#server = server;
    this.#origin = `http://127.0.0.1:${String(address.port)}`;
    // User-only, whatever the umask of the run (002 on an Ubuntu desktop): Tasks trusts T3's
    // runtime file only when no one else can change it or its folder (t3-client.ts). What T3 itself
    // gives them is not observed yet (L05); A4's open item 6.14 records the question.
    mkdirSync(join(this.home, "userdata"), { recursive: true, mode: 0o700 });
    writeFileSync(
      this.runtimeFile,
      `${JSON.stringify({ origin: this.#origin, pid: process.pid })}\n`,
      { mode: 0o600 },
    );
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.#origin);
    const body = await readAll(req);
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(value));
    };
    switch (url.pathname) {
      case "/.well-known/oauth-protected-resource/mcp":
      case "/.well-known/oauth-protected-resource":
        json(200, {
          resource: `${this.#origin}/mcp`,
          authorization_servers: [this.#origin],
          bearer_methods_supported: ["header"],
        });
        return;
      case "/.well-known/oauth-authorization-server":
        json(200, {
          issuer: this.#origin,
          authorization_endpoint: `${this.#origin}/oauth/authorize`,
          token_endpoint: `${this.#origin}/oauth/token`,
          registration_endpoint: `${this.#origin}/oauth/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
        return;
      case "/oauth/register":
        if (this.registrationGate !== undefined) {
          this.registrationsWaiting += 1;
          await this.registrationGate;
          this.registrationsWaiting -= 1;
        }
        this.#register(body, json);
        return;
      case "/oauth/authorize":
        this.#authorize(url, res);
        return;
      case "/oauth/token":
        this.#token(body, json);
        return;
      case "/mcp":
        await this.#mcp(req, body, res);
        return;
      case "/fake-cli":
        json(200, this.#cli(body));
        return;
      default:
        res.writeHead(404);
        res.end();
    }
  }

  #register(body: string, json: (s: number, v: unknown) => void): void {
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(body) as Record<string, unknown>;
    } catch {
      json(400, { error: "invalid_client_metadata" });
      return;
    }
    const uris = input["redirect_uris"];
    if (
      !Array.isArray(uris) ||
      uris.length === 0 ||
      !uris.every((u) => typeof u === "string" && /^http:\/\/127\.0\.0\.1:\d+\//u.test(u))
    ) {
      json(400, { error: "invalid_redirect_uri" });
      return;
    }
    const client: Client = { id: random("client-"), redirectUris: uris as string[] };
    this.#clients.set(client.id, client);
    this.registrations.push(client);
    json(201, {
      client_id: client.id,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  }

  #authorize(url: URL, res: ServerResponse): void {
    const q = url.searchParams;
    const clientId = q.get("client_id") ?? "";
    const redirectUri = q.get("redirect_uri") ?? "";
    this.authorizes.push({
      clientId,
      redirectUri,
      codeChallengeMethod: q.get("code_challenge_method"),
      codeChallenge: q.get("code_challenge"),
      state: q.get("state"),
      resource: q.get("resource"),
    });
    const client = this.#clients.get(clientId);
    const challenge = q.get("code_challenge");
    if (
      client === undefined ||
      !client.redirectUris.includes(redirectUri) ||
      q.get("response_type") !== "code" ||
      q.get("code_challenge_method") !== "S256" ||
      challenge === null
    ) {
      res.writeHead(400);
      res.end("invalid request");
      return;
    }
    const back = new URL(redirectUri);
    const state = q.get("state");
    if (state !== null) back.searchParams.set("state", state);
    if (this.approval === "deny") back.searchParams.set("error", "access_denied");
    else {
      const code = random("code-");
      this.#codes.set(code, { client: clientId, redirectUri, challenge, used: false });
      back.searchParams.set("code", code);
    }
    res.writeHead(302, { location: back.toString() });
    res.end();
  }

  #token(body: string, json: (s: number, v: unknown) => void): void {
    this.tokenRequests += 1;
    const form = new URLSearchParams(body);
    const issue = (namespace: string, client: string) => {
      const access = random("fake-at-");
      const refresh = random("fake-rt-");
      this.#tokens.set(access, { namespace, kind: "access", client, revoked: false });
      this.#tokens.set(refresh, { namespace, kind: "refresh", client, revoked: false });
      json(200, {
        access_token: access,
        token_type: "Bearer",
        refresh_token: refresh,
        scope: "full",
        ...(this.expiresIn === undefined ? {} : { expires_in: this.expiresIn }),
      });
    };
    if (form.get("grant_type") === "authorization_code") {
      const code = this.#codes.get(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      if (
        code === undefined ||
        code.used ||
        code.client !== form.get("client_id") ||
        code.redirectUri !== form.get("redirect_uri") ||
        sha256url(verifier) !== code.challenge
      ) {
        json(400, { error: "invalid_grant" });
        return;
      }
      code.used = true;
      // A new authorization: T3's request namespace for this client's session.
      issue(random("ns-"), code.client);
      return;
    }
    if (form.get("grant_type") === "refresh_token") {
      const refresh = this.#tokens.get(form.get("refresh_token") ?? "");
      if (refresh === undefined || refresh.revoked || refresh.kind !== "refresh") {
        json(400, { error: "invalid_grant" });
        return;
      }
      refresh.revoked = true;
      issue(this.refreshKeepsNamespace ? refresh.namespace : random("ns-"), refresh.client);
      return;
    }
    json(400, { error: "unsupported_grant_type" });
  }

  async #mcp(req: IncomingMessage, body: string, res: ServerResponse): Promise<void> {
    const called = toolOf(body);
    const hookAt = this.#hooks.findIndex((h) => h.tool === called);
    if (hookAt >= 0) this.#hooks.splice(hookAt, 1)[0]?.hook();
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? this.#tokens.get(auth.slice(7)) : undefined;
    if (token === undefined || token.revoked || token.kind !== "access") {
      this.unauthorized += 1;
      const tool = toolOf(body);
      if (tool !== undefined) {
        this.calls.push({
          tool,
          namespace: null,
          clientRequestId: null,
          projectId: null,
          outcome: "unauthorized",
        });
      }
      res.writeHead(401, {
        "www-authenticate": `Bearer resource_metadata="${this.#origin}/.well-known/oauth-protected-resource/mcp"`,
      });
      res.end();
      return;
    }
    let message: { id?: unknown; method?: unknown; params?: Record<string, unknown> };
    try {
      message = JSON.parse(body) as typeof message;
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const reply = (value: unknown, headers: Record<string, string> = {}) => {
      const text = JSON.stringify({ jsonrpc: "2.0", id: message.id, ...(value as object) });
      if (this.sse) {
        res.writeHead(200, { "content-type": "text/event-stream", ...headers });
        // The specification says a server SHOULD close the stream after the reply: one that
        // keeps it open (`sseKeepOpen`) leaves the end of the stream to the client.
        if (this.sseKeepOpen) res.write(`event: message\ndata: ${text}\n\n`);
        else res.end(`event: message\ndata: ${text}\n\n`);
      } else {
        res.writeHead(200, { "content-type": "application/json", ...headers });
        res.end(text);
      }
    };
    if (message.method === "initialize") {
      const session = random("mcp-session-");
      this.#sessions.set(session, token.namespace);
      const asked = message.params?.["protocolVersion"];
      reply(
        {
          result: {
            protocolVersion:
              typeof asked === "string" && PROTOCOLS.includes(asked) ? asked : PROTOCOLS[1],
            capabilities: { tools: {} },
            serverInfo: { name: "t3-fake", version: "0.1.7" },
          },
        },
        { "mcp-session-id": session },
      );
      return;
    }
    const session = req.headers["mcp-session-id"];
    if (typeof session !== "string") {
      res.writeHead(400);
      res.end();
      return;
    }
    if (!this.#sessions.has(session)) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (message.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    if (message.method === "tools/list") {
      reply({
        result: { tools: TOOLS.map((name) => ({ name, inputSchema: { type: "object" } })) },
      });
      return;
    }
    if (message.method !== "tools/call") {
      reply({ error: { code: -32601, message: "Method not found" } });
      return;
    }
    const name = message.params?.["name"];
    const args = (message.params?.["arguments"] ?? {}) as Record<string, unknown>;
    if (typeof name !== "string" || !TOOLS.includes(name)) {
      reply({ error: { code: -32602, message: "Unknown tool" } });
      return;
    }
    const record = (outcome: FakeT3Call["outcome"]) => {
      this.calls.push({
        tool: name,
        namespace: token.namespace,
        clientRequestId:
          typeof args["clientRequestId"] === "string" ? args["clientRequestId"] : null,
        projectId: typeof args["projectId"] === "string" ? args["projectId"] : null,
        outcome,
      });
    };
    const faultAt = this.#faults.findIndex((f) => f.tool === name);
    const fault = faultAt < 0 ? undefined : this.#faults.splice(faultAt, 1)[0];
    const rpcError = (code: number) => {
      reply({ error: { code, message: code === -32603 ? "Internal error" : "Request refused" } });
    };
    if (fault?.when === "before") {
      if (fault.httpStatus !== undefined) {
        record("http_refused");
        res.writeHead(fault.httpStatus);
        res.end();
        return;
      }
      if (fault.rpcError !== undefined) {
        record("rpc_error_before");
        rpcError(fault.rpcError);
        return;
      }
      record("dropped_before");
      await fault.then?.();
      req.socket.destroy();
      return;
    }
    let answer: { data: unknown } | { error: string };
    try {
      answer = { data: this.#tool(name, args, token.namespace) };
    } catch (error) {
      answer = { error: error instanceof Error ? error.message : "error" };
    }
    if (fault?.when === "after" && fault.rpcError !== undefined) {
      record("rpc_error_after");
      rpcError(fault.rpcError);
      return;
    }
    if (fault?.when === "after") {
      record("dropped_after");
      await fault.then?.();
      req.socket.destroy();
      return;
    }
    if ("error" in answer) {
      record("error");
      reply({ result: { isError: true, content: [{ type: "text", text: answer.error }] } });
      return;
    }
    record("answered");
    reply({
      result: {
        content: [{ type: "text", text: JSON.stringify(answer.data) }],
        structuredContent: answer.data,
      },
    });
  }

  /** One tool's work. Throws a T3 error message for a refusal. */
  #tool(name: string, args: Record<string, unknown>, namespace: string): unknown {
    switch (name) {
      case "t3_environment_read":
        return { environmentId: this.environmentId, label: "Local" };
      case "t3_project_list": {
        const cursor = typeof args["cursor"] === "number" ? args["cursor"] : 0;
        const limit = typeof args["limit"] === "number" ? args["limit"] : 50;
        const all = [...this.projects.values()];
        const page = all.slice(cursor, cursor + limit);
        return {
          projects: page.map((p) => ({
            id: p.id,
            title: p.title,
            workspaceRoot: p.workspaceRoot,
            archivedAt: p.archivedAt,
          })),
          nextCursor: cursor + limit < all.length ? cursor + limit : null,
        };
      }
      case "t3_project_create": {
        const root = args["workspaceRoot"];
        const title = args["title"];
        if (typeof root !== "string" || typeof title !== "string") throw new Error("bad input");
        if (realKey(root) === undefined) throw new Error("The folder does not exist");
        // A4: the only conflict is another active project with the exact same root.
        for (const p of this.projects.values()) {
          if (p.archivedAt === null && p.workspaceRoot === root) {
            throw new Error("A project with this root exists");
          }
        }
        const id = this.addProject(root, title);
        return { project: { id, title, workspaceRoot: root } };
      }
      case "t3_thread_launch":
        return this.#launch(args, namespace);
      case "t3_thread_read": {
        const thread = this.threads.get(String(args["threadId"]));
        if (thread === undefined) throw new Error("No such thread");
        return {
          thread: {
            id: thread.id,
            projectId: thread.projectId,
            title: thread.title,
            worktreePath: thread.worktreePath,
            status: "idle",
          },
        };
      }
      default:
        throw new Error("Unknown tool");
    }
  }

  /**
   * One run of the fake CLI (A4 3.4.1, as assumed until L06 runs: `project list --json`,
   * `project add <path>`, `thread start <project|path> - --json --title <t> [--provider <p> --model
   * <m>]`). Returns what the CLI prints and its exit code. A T3 error is exit 1 with its message on
   * stderr.
   */
  #cli(body: string): { code: number; stdout: string; stderr: string; hang?: boolean } {
    let input: { argv?: unknown; stdin?: unknown };
    try {
      input = JSON.parse(body) as typeof input;
    } catch {
      return { code: 2, stdout: "", stderr: "unreadable request\n" };
    }
    const argv = Array.isArray(input.argv)
      ? input.argv.filter((a): a is string => typeof a === "string")
      : [];
    const stdin = typeof input.stdin === "string" ? input.stdin : null;
    const command = argv.slice(0, 2).join(" ");
    const faultAt = this.#cliFaults.findIndex((f) => f.command === command);
    const fault = faultAt < 0 ? undefined : this.#cliFaults.splice(faultAt, 1)[0]?.fault;
    let answer: { code: number; stdout: string; stderr: string; hang?: boolean };
    let outcome: FakeT3CliCall["outcome"];
    if (fault !== undefined && fault.run !== true) {
      outcome = "fault";
      answer = { code: 1, stdout: "", stderr: "" };
    } else {
      try {
        answer = { code: 0, stdout: `${JSON.stringify(this.#cliWork(argv, stdin))}\n`, stderr: "" };
        outcome = "answered";
      } catch (error) {
        answer = {
          code: 1,
          stdout: "",
          stderr: `${error instanceof Error ? error.message : "error"}\n`,
        };
        outcome = "error";
      }
    }
    this.cliCalls.push({ argv, stdin, outcome: fault === undefined ? outcome : "fault" });
    if (fault === undefined) return answer;
    return {
      code: fault.exit ?? answer.code,
      stdout: fault.stdout ?? answer.stdout,
      stderr: fault.stderr ?? answer.stderr,
      ...(fault.hang === true ? { hang: true } : {}),
    };
  }

  #cliWork(argv: readonly string[], stdin: string | null): unknown {
    const [noun, verb, ...rest] = argv;
    if (noun === "project" && verb === "list") {
      if (rest.join(" ") !== "--json") throw new Error("Usage: t3 project list --json");
      return {
        projects: [...this.projects.values()].map((p) => ({
          id: p.id,
          title: p.title,
          workspaceRoot: p.workspaceRoot,
          archivedAt: p.archivedAt,
        })),
      };
    }
    if (noun === "project" && verb === "add") {
      const [root, ...more] = rest;
      if (root === undefined || more.length > 0) throw new Error("Usage: t3 project add <path>");
      return this.#tool("t3_project_create", { workspaceRoot: root, title: basename(root) }, "cli");
    }
    if (noun === "thread" && verb === "start") {
      const [target, message, ...options] = rest;
      if (target === undefined || message !== "-") throw new Error("Usage: t3 thread start");
      const flags = new Map<string, string>();
      for (let i = 0; i < options.length; i += 1) {
        const flag = options[i] ?? "";
        if (flag === "--json") continue;
        if (!["--title", "--provider", "--model"].includes(flag) || i + 1 >= options.length) {
          throw new Error(`Unknown option ${flag}`);
        }
        flags.set(flag, options[i + 1] ?? "");
        i += 1;
      }
      if (flags.has("--provider") !== flags.has("--model")) {
        throw new Error("--provider and --model must be given together");
      }
      if (stdin === null || stdin === "") throw new Error("A message is required");
      const project = this.#cliProject(target);
      const id = random("thread-");
      const provider = flags.get("--provider");
      this.threads.set(id, {
        id,
        projectId: project.id,
        title: flags.get("--title") ?? stdin.slice(0, 40),
        worktreePath: null,
        namespace: "cli",
        clientRequestId: null,
        modelSelection:
          provider === undefined ? null : { instanceId: provider, model: flags.get("--model") },
        runtimeMode: null,
        message: true,
        sent: stdin,
      });
      return { threadId: id, projectId: project.id, runId: random("run-") };
    }
    throw new Error("Unknown command");
  }

  /**
   * `thread start`'s target as T3 reads it (A4 3.4.1): an exact project ID wins; otherwise a path
   * resolves to the deepest active project that contains it, and the thread starts at that root.
   */
  #cliProject(target: string): FakeT3Project {
    const exact = this.projects.get(target);
    if (exact !== undefined && exact.archivedAt === null) return exact;
    const key = realKey(target);
    let found: FakeT3Project | undefined;
    let depth = -1;
    for (const project of this.projects.values()) {
      if (project.archivedAt !== null) continue;
      const root = realKey(project.workspaceRoot);
      if (root === undefined || key === undefined) continue;
      const inside = key === root || key.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
      if (inside && root.length > depth) {
        found = project;
        depth = root.length;
      }
    }
    if (found === undefined) throw new Error("No project matches");
    return found;
  }

  #launch(args: Record<string, unknown>, namespace: string): unknown {
    const title = args["title"];
    if (typeof title !== "string" || title === "") throw new Error("title is required");
    const project = this.projects.get(String(args["projectId"]));
    if (project === undefined || project.archivedAt !== null) throw new Error("No such project");
    const strategy = (args["workspaceStrategy"] ?? { type: "root" }) as Record<string, unknown>;
    let worktreePath: string | null = null;
    if (strategy["type"] === "existing_worktree") {
      const path = strategy["worktreePath"];
      const listed = gitWorktrees(project.workspaceRoot);
      const key = typeof path === "string" ? realKey(path) : undefined;
      if (key === undefined || listed?.some((w) => realKey(w) === key) !== true) {
        throw new Error("worktreePath is not a worktree of the project");
      }
      worktreePath = path as string;
    } else if (strategy["type"] !== "root") {
      throw new Error("Unsupported workspace strategy");
    }
    const key = typeof args["clientRequestId"] === "string" ? args["clientRequestId"] : null;
    // A4: the thread ID derives from the request namespace and the key, so a repeat under the
    // same authorization returns the same thread, and under another makes a new one.
    const id =
      key === null
        ? random("thread-")
        : `thread-${createHash("sha256").update(`${namespace}\n${key}`).digest("hex").slice(0, 24)}`;
    if (!this.threads.has(id)) {
      this.threads.set(id, {
        id,
        projectId: project.id,
        title,
        worktreePath,
        namespace,
        clientRequestId: key,
        modelSelection: args["modelSelection"] ?? null,
        runtimeMode: args["runtimeMode"] ?? null,
        message: typeof args["message"] === "string",
      });
    }
    return {
      threadId: id,
      projectId: project.id,
      environmentId: this.environmentId,
      link: `t3code://threads/${this.environmentId}/${id}`,
    };
  }
}

const TOOLS = [
  "t3_environment_read",
  "t3_project_list",
  "t3_project_create",
  "t3_thread_launch",
  "t3_thread_read",
];

/** The tool a JSON-RPC body calls, when it is a tools/call. */
function toolOf(body: string): string | undefined {
  try {
    const message = JSON.parse(body) as { method?: unknown; params?: { name?: unknown } };
    return message.method === "tools/call" && typeof message.params?.name === "string"
      ? message.params.name
      : undefined;
  } catch {
    return undefined;
  }
}

function readAll(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (text += chunk));
    req.on("end", () => {
      resolve(text);
    });
    req.on("error", reject);
  });
}
