// A fake T3 Code server for the T3 route's tests.
// It listens on a loopback port the OS assigns and plays what an outside MCP client of T3
// sees: the server's origin in `<home>/userdata/server-runtime.json`, OAuth discovery, dynamic
// client registration and the authorization code flow with PKCE (S256), and MCP over Streamable
// HTTP at `<origin>/mcp` with the tools the route calls. Tests only; fixture data only.
//
// What it plays follows T3 Code's own source (pingdotgg/t3code 0.1.11, MIT; its server's
// `auth/McpOAuth.ts`, `auth/EnvironmentAuth.ts`, `mcp/McpToolAccess.ts` and
// `mcp/toolkits/project/`): the OAuth endpoints under `/oauth/mcp/`, the `authorization_code`
// grant only and a 30-day token with no refresh token, a request namespace of `client:<session>` per
// authorization, a launch's thread ID `mcp:launch:<SHA-256 of [namespace, key]>` that a repeat with
// the same key replays, Full access to register a project, and a refusal as a tool result with
// `isError` and T3's fixed `code`. The fake keeps its state across a restart, as T3 keeps its
// database, and forgets its MCP sessions, as a new server process would.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";

export interface FakeT3Project {
  readonly id: string;
  title: string;
  /** Writable: T3 can change a project's root after TTasks bound it (a test sets it). */
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
  /** Whether a first message was sent, which starts an agent turn. The route never sends one. */
  readonly message: boolean;
  /** T3's thread status (`idle`, or a run's, such as `running`): a test sets it. */
  status: string;
  /** Approvals and questions that wait for the person: a test sets it. */
  pendingRequestCount: number;
  archived: boolean;
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
  readonly access: FakeT3Access;
  used: boolean;
}

interface Token {
  readonly namespace: string;
  readonly client: string;
  /** The access the person approved on T3's page (its runtime-mode ceiling). */
  readonly access: FakeT3Access;
  revoked: boolean;
}

/** The access levels T3's approval page offers, broadest last; read-only writes nothing. */
export type FakeT3Access =
  "read-only" | "approval-required" | "auto-accept-edits" | "auto" | "full-access";
const ACCESS_RANK: readonly string[] = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

/** A refusal as T3 answers it: an `OrchestratorMcpFailure` with its fixed code. */
class Refusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
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

  /** What the authorization page does: approve, or deny. */
  approval: "approve" | "deny" = "approve";
  /** The access the person chooses on the approval page. */
  access: FakeT3Access = "full-access";
  /** Seconds an access token lives: T3's 30 days. Undefined for no `expires_in`. */
  expiresIn: number | undefined = 30 * 24 * 60 * 60;
  /**
   * The models T3 offers, or undefined for any. A launch with another, or without one while
   * `default` is not offered, is `model_unavailable`.
   */
  models: readonly string[] | undefined = undefined;
  /**
   * The model a thread made without one takes: the project's effective default. Null: the project
   * has none, and T3 refuses such a launch as it does (`invalid_request`, its own message).
   */
  defaultModel: string | null = "default";
  /** Answer MCP requests as an SSE stream instead of a JSON body. */
  sse = false;
  /** With `sse`: keep each stream open after its reply, as the specification allows. */
  sseKeepOpen = false;

  readonly projects = new Map<string, FakeT3Project>();
  readonly threads = new Map<string, FakeT3Thread>();
  readonly calls: FakeT3Call[] = [];
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

  /** Revokes every token, as T3 does when its grant is removed: every request is then a 401. */
  revokeAll(): void {
    for (const token of this.#tokens.values()) token.revoked = true;
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
    // User-only, whatever the umask of the run (002 on an Ubuntu desktop): TTasks trusts T3's
    // runtime file only when no one else can change it or its folder (t3-client.ts). What T3 itself
    // gives them is not observed yet.
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
          authorization_endpoint: `${this.#origin}/oauth/mcp/authorize`,
          token_endpoint: `${this.#origin}/oauth/mcp/token`,
          registration_endpoint: `${this.#origin}/oauth/mcp/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
        return;
      case "/oauth/mcp/register":
        if (this.registrationGate !== undefined) {
          this.registrationsWaiting += 1;
          await this.registrationGate;
          this.registrationsWaiting -= 1;
        }
        this.#register(body, json);
        return;
      case "/oauth/mcp/authorize":
        this.#authorize(url, res);
        return;
      case "/oauth/mcp/token":
        this.#token(body, json);
        return;
      case "/mcp":
        await this.#mcp(req, body, res);
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
      grant_types: ["authorization_code"],
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
      this.#codes.set(code, {
        client: clientId,
        redirectUri,
        challenge,
        access: this.access,
        used: false,
      });
      back.searchParams.set("code", code);
    }
    res.writeHead(302, { location: back.toString() });
    res.end();
  }

  #token(body: string, json: (s: number, v: unknown) => void): void {
    this.tokenRequests += 1;
    const form = new URLSearchParams(body);
    const issue = (namespace: string, client: string, level: FakeT3Access) => {
      const access = random("fake-at-");
      this.#tokens.set(access, { namespace, client, access: level, revoked: false });
      json(200, {
        access_token: access,
        token_type: "Bearer",
        scope:
          level === "full-access"
            ? "orchestration:read orchestration:operate settings:write"
            : "orchestration:read orchestration:operate",
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
      // T3's namespace of a new authorization: its MCP client session.
      issue(`client:${randomUUID()}`, code.client, code.access);
      return;
    }
    json(400, { error: "unsupported_grant_type" });
  }

  async #mcp(req: IncomingMessage, body: string, res: ServerResponse): Promise<void> {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? this.#tokens.get(auth.slice(7)) : undefined;
    if (token === undefined || token.revoked) {
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
    let answer: { data: unknown } | { error: { code: string; message: string } };
    try {
      answer = { data: this.#tool(name, args, token) };
    } catch (error) {
      answer = {
        error: {
          code: error instanceof Refusal ? error.code : "orchestration_error",
          message: error instanceof Error ? error.message : "error",
        },
      };
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
      const failure = { _tag: "OrchestratorMcpFailure", ...answer.error };
      reply({
        result: {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(failure) }],
        },
      });
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

  /** One tool's work, for a caller with `token`'s namespace and access. Throws a Refusal. */
  #tool(
    name: string,
    args: Record<string, unknown>,
    token: Pick<Token, "namespace" | "access">,
  ): unknown {
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
        if (typeof root !== "string" || typeof title !== "string") {
          throw new Refusal("invalid_request", "bad input");
        }
        if (token.access !== "full-access") {
          throw new Refusal("capability_denied", "Registering a project needs full access.");
        }
        if (realKey(root) === undefined) {
          throw new Refusal("invalid_request", "The folder does not exist");
        }
        // The only conflict is another active project with the exact same root.
        for (const p of this.projects.values()) {
          if (p.archivedAt === null && p.workspaceRoot === root) {
            throw new Refusal("invalid_request", "A project with this root exists");
          }
        }
        const id = this.addProject(root, title);
        return { id, title, workspaceRoot: root, archivedAt: null };
      }
      case "t3_project_read": {
        const project = this.projects.get(String(args["projectId"]));
        if (project === undefined)
          throw new Refusal("invalid_request", "The project was not found.");
        return { ...project };
      }
      case "t3_thread_launch":
        return this.#launch(args, token);
      case "t3_thread_read": {
        const thread = this.threads.get(String(args["threadId"]));
        if (thread === undefined) throw new Refusal("thread_not_found", "No such thread");
        return {
          thread: {
            threadId: thread.id,
            projectId: thread.projectId,
            title: thread.title,
            worktreePath: thread.worktreePath,
            status: thread.status,
            pendingRequestCount: thread.pendingRequestCount,
            archived: thread.archived,
            updatedAt: new Date().toISOString(),
          },
        };
      }
      default:
        throw new Refusal("invalid_request", "Unknown tool");
    }
  }

  #launch(args: Record<string, unknown>, token: Pick<Token, "namespace" | "access">): unknown {
    const { namespace } = token;
    const title = args["title"];
    if (typeof title !== "string" || title === "") {
      throw new Refusal("invalid_request", "title is required");
    }
    if (token.access === "read-only") {
      throw new Refusal("capability_denied", "This client was approved for read-only access.");
    }
    // The mode may not be broader than the one the person approved (checked on every call).
    const mode = args["runtimeMode"];
    if (typeof mode === "string" && ACCESS_RANK.indexOf(mode) > ACCESS_RANK.indexOf(token.access)) {
      throw new Refusal("runtime_mode_escalation_denied", `Runtime mode ${mode} is too broad.`);
    }
    const key = typeof args["clientRequestId"] === "string" ? args["clientRequestId"] : null;
    // The thread ID derives from the request namespace and the key, so a repeat under the same
    // authorization replays the first launch, and under another makes a new one.
    const id =
      key === null
        ? random("mcp:launch:")
        : `mcp:launch:${createHash("sha256")
            .update(JSON.stringify([namespace, key]))
            .digest("hex")}`;
    if (this.threads.has(id)) return this.#launched(id);
    const project = this.projects.get(String(args["projectId"]));
    if (project === undefined || project.archivedAt !== null) {
      throw new Refusal("invalid_request", "The project was not found.");
    }
    // Without a selection the thread takes T3's default, which T3 checks the same way.
    const selection = args["modelSelection"] as { model?: unknown } | undefined;
    const model = typeof selection?.model === "string" ? selection.model : this.defaultModel;
    if (model === null) {
      throw new Refusal(
        "invalid_request",
        "Pass modelSelection: the project has no default model. orchestrator_capabilities lists providers and models.",
      );
    }
    if (this.models !== undefined && !this.models.includes(model)) {
      throw new Refusal("model_unavailable", `Model ${model} is not advertised.`);
    }
    const strategy = (args["workspaceStrategy"] ?? { type: "root" }) as Record<string, unknown>;
    let worktreePath: string | null = null;
    if (strategy["type"] === "existing_worktree") {
      const path = strategy["worktreePath"];
      const listed = gitWorktrees(project.workspaceRoot);
      const at = typeof path === "string" ? realKey(path) : undefined;
      if (at === undefined || listed?.some((w) => realKey(w) === at) !== true) {
        throw new Refusal("invalid_request", "worktreePath is not a worktree of the project");
      }
      worktreePath = path as string;
    } else if (strategy["type"] !== "root") {
      throw new Refusal("invalid_request", "Unsupported workspace strategy");
    }
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
      status: "idle",
      pendingRequestCount: 0,
      archived: false,
    });
    return this.#launched(id);
  }

  /** A launch's answer, the first time and on every repeat with its key. */
  #launched(id: string): unknown {
    const thread = this.threads.get(id);
    return {
      threadId: id,
      projectId: thread?.projectId,
      modelSelection: thread?.modelSelection ?? { instanceId: "codex", model: "default" },
      runId: null,
      status: null,
      link: `https://app.t3.codes/threads/${this.environmentId}/${encodeURIComponent(id)}`,
    };
  }
}

const TOOLS = [
  "t3_environment_read",
  "t3_project_list",
  "t3_project_create",
  "t3_project_read",
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
