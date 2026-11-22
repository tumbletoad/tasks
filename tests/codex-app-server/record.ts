// The recorder of what a real `codex app-server` says: one process per case, its JSON-RPC lines
// in both directions with their times, byte for byte into `<scratch>/raw/` only. sanitise.ts turns
// them into the fixtures in fixtures/codex-app-server/, which the run driver's fake replays. Run
// by hand, never by a test:
//
//   pnpm exec node tests/codex-app-server/record.ts <scratch> [case ...]
//   pnpm exec node tests/codex-app-server/sanitise.ts <scratch> fixtures/codex-app-server
//
// Its rules: the installed Codex, the cheapest model at the lowest effort, trivial requests in an
// empty folder inside the scratch folder, configuration per thread only (nothing is written into
// the Codex home, and nothing in it is opened or listed), and a resumed thread deleted over the
// protocol afterwards. The console gets methods, counts and times only.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, writeSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const MODEL = "gpt-5.6-luna";
const EFFORT = "low";

type Message = Record<string, unknown>;

/** The npm install of Codex: `node <prefix>/node_modules/@openai/codex/bin/codex.js`. */
function codexEntry(): string {
  const prefix =
    process.platform === "win32"
      ? join(process.env["APPDATA"] ?? "", "npm")
      : join(dirname(dirname(process.execPath)), "lib");
  const entry = join(prefix, "node_modules", "@openai", "codex", "bin", "codex.js");
  if (!existsSync(entry)) throw new Error("No npm install of Codex was found.");
  return entry;
}

/** One app-server process and its raw record. */
class Session {
  readonly child: ChildProcessWithoutNullStreams;
  readonly #fd: number;
  readonly #t0 = performance.now();
  readonly #pending = new Map<number, (message: Message) => void>();
  readonly #waiters: { test: (m: Message) => boolean; resolve: (m: Message) => void }[] = [];
  readonly #onRequest: (message: Message) => void;
  #next = 1;
  readonly exited: Promise<number | null>;

  constructor(
    raw: string,
    cwd: string,
    onRequest: (session: Session, message: Message) => void = () => undefined,
  ) {
    this.#fd = openSync(raw, "w", 0o600);
    this.#onRequest = (message) => {
      onRequest(this, message);
    };
    this.child = spawn(process.execPath, [codexEntry(), "app-server"], { cwd, windowsHide: true });
    this.exited = new Promise((resolve) => {
      this.child.once("exit", (code) => {
        this.#write("exit", { code });
        resolve(code);
      });
    });
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      let message: Message;
      try {
        message = JSON.parse(line) as Message;
      } catch {
        this.#write("recv-text", { text: line });
        return;
      }
      this.#write("recv", message);
      const id = message["id"];
      if (typeof id === "number" && ("result" in message || "error" in message)) {
        this.#pending.get(id)?.(message);
        this.#pending.delete(id);
        return;
      }
      if ("id" in message && typeof message["method"] === "string") {
        console.log(`  server request ${message["method"]}`);
        this.#onRequest(message);
      }
      for (const waiter of [...this.#waiters]) {
        if (waiter.test(message)) {
          this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.#write("stderr", { bytes: chunk.length, text: chunk.toString("utf8") });
    });
  }

  #write(dir: string, msg: unknown): void {
    const ms = Math.round(performance.now() - this.#t0);
    writeSync(this.#fd, `${JSON.stringify({ dir, ms, msg })}\n`);
  }

  send(message: Message): void {
    this.#write("send", message);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params: unknown): Promise<Message> {
    const id = this.#next++;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.send({ id, method, params });
    });
  }

  /** The next notification or request that `test` accepts, or undefined after `ms`. */
  next(test: (m: Message) => boolean, ms: number): Promise<Message | undefined> {
    return new Promise((resolve) => {
      const waiter = {
        test,
        resolve: (m: Message) => {
          clearTimeout(timer);
          resolve(m);
        },
      };
      const timer = setTimeout(() => {
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        resolve(undefined);
      }, ms);
      this.#waiters.push(waiter);
    });
  }

  mark(what: string): void {
    this.#write("mark", { what });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "ttasks_lab", title: "TTasks lab", version: "0.0.0" },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: "initialized" });
  }

  /** Ends stdin and waits for the process: the app server's own end. */
  async close(): Promise<number | null> {
    this.mark("close");
    this.child.stdin.end();
    const code = await Promise.race([
      this.exited,
      new Promise<"timeout">((resolve) => {
        setTimeout(() => {
          resolve("timeout");
        }, 15_000);
      }),
    ]);
    if (code === "timeout") {
      this.mark("killed after the close timed out");
      this.child.kill();
      return this.exited;
    }
    closeSync(this.#fd);
    return code;
  }
}

const method = (name: string) => (m: Message) => m["method"] === name;
const params = (m: Message | undefined): Message => (m?.["params"] ?? {}) as Message;
const result = (m: Message): Message => (m["result"] ?? {}) as Message;

interface ThreadOptions {
  approvalPolicy: string;
  sandbox: string;
  ephemeral: boolean;
  config?: Record<string, unknown>;
}

const FULL: ThreadOptions = {
  approvalPolicy: "never",
  sandbox: "danger-full-access",
  ephemeral: true,
};

async function startThread(s: Session, cwd: string, options: ThreadOptions): Promise<string> {
  const started = await s.request("thread/start", {
    cwd,
    model: MODEL,
    approvalPolicy: options.approvalPolicy,
    sandbox: options.sandbox,
    ephemeral: options.ephemeral,
    ...(options.config === undefined ? {} : { config: options.config }),
  });
  const thread = (result(started)["thread"] ?? {}) as Message;
  if (typeof thread["id"] !== "string") throw new Error("thread/start gave no thread");
  return thread["id"];
}

async function turn(
  s: Session,
  thread: string,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const answer = await s.request("turn/start", {
    threadId: thread,
    input: [{ type: "text", text }],
    effort: EFFORT,
    ...extra,
  });
  const t = (result(answer)["turn"] ?? {}) as Message;
  return String(t["id"]);
}

async function completed(s: Session, ms = 180_000): Promise<Message | undefined> {
  const done = await s.next(method("turn/completed"), ms);
  const t = (params(done)["turn"] ?? {}) as Message;
  console.log(`  turn ${typeof t["status"] === "string" ? t["status"] : "not completed"}`);
  return done;
}

type Case = (scratch: string, work: string, state: Message) => Promise<void>;

const CASES: Record<string, Case> = {
  /** A plain turn with full access. */
  async plain(scratch, work) {
    const s = new Session(raw(scratch, "plain"), work);
    await s.initialize();
    const thread = await startThread(s, work, FULL);
    await turn(s, thread, "Reply with the word ok and nothing else.");
    await completed(s);
    console.log(`  exit ${String(await s.close())}`);
  },

  /** A turn that runs a command; the thread is kept for `resume`. */
  async command(scratch, work, state) {
    const s = new Session(raw(scratch, "command"), work);
    await s.initialize();
    const thread = await startThread(s, work, { ...FULL, ephemeral: false });
    state["thread"] = thread;
    await turn(s, thread, "Run the shell command `echo hi`, then reply with the word done.");
    await completed(s);
    console.log(`  exit ${String(await s.close())}`);
  },

  /** A tool of an MCP server the thread's configuration names, as TTasks's tools are given. */
  async tool(scratch, work) {
    const s = new Session(raw(scratch, "tool"), work);
    await s.initialize();
    const stub = join(dirname(fileURLToPath(import.meta.url)), "mcp-stub.ts");
    const thread = await startThread(s, work, {
      ...FULL,
      config: {
        "mcp_servers.ttasks": {
          command: process.execPath,
          args: [stub],
          env: { TTASKS_TICKET: "LABTICKET0000000000000000" },
        },
      },
    });
    await turn(
      s,
      thread,
      "Call the tool probe_echo with the text hello, then reply with the word done.",
    );
    await completed(s);
    console.log(`  exit ${String(await s.close())}`);
  },

  /** A turn interrupted while its command runs. */
  async interrupt(scratch, work) {
    const s = new Session(raw(scratch, "interrupt"), work);
    await s.initialize();
    const thread = await startThread(s, work, FULL);
    const turnId = await turn(
      s,
      thread,
      "Run the shell command `Start-Sleep -Seconds 60` and wait for it, then reply with the word done.",
    );
    const started = await s.next(
      (m) =>
        m["method"] === "item/started" &&
        ((params(m)["item"] ?? {}) as Message)["type"] === "commandExecution",
      120_000,
    );
    console.log(`  command ${started === undefined ? "never started" : "started"}`);
    s.mark("interrupt");
    await s.request("turn/interrupt", { threadId: thread, turnId });
    await completed(s, 60_000);
    console.log(`  exit ${String(await s.close())}`);
  },

  /** A command left running after the turn: what the server says while and after it runs. */
  async background(scratch, work) {
    const s = new Session(raw(scratch, "background"), work);
    await s.initialize();
    const thread = await startThread(s, work, FULL);
    await turn(
      s,
      thread,
      "Use your shell tool to run `Start-Sleep -Seconds 20; Write-Output finished` with a short yield time, so that it keeps running as a background terminal, and reply with the word started without waiting for it to end.",
    );
    await completed(s);
    s.mark("after the turn");
    const late = await s.next(
      (m) => m["method"] === "item/completed" || m["method"] === "turn/started",
      45_000,
    );
    console.log(
      `  after the turn: ${typeof late?.["method"] === "string" ? late["method"] : "nothing within 45 s"}`,
    );
    if (late?.["method"] === "turn/started") await completed(s);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    console.log(`  exit ${String(await s.close())}`);
  },

  /** A command in a mode that asks first; the request is accepted. */
  async "approval-command"(scratch, work) {
    const s = new Session(raw(scratch, "approval-command"), work, (session, m) => {
      session.send({ id: m["id"], result: { decision: "accept" } });
    });
    await s.initialize();
    const thread = await startThread(s, work, {
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      ephemeral: true,
    });
    await turn(s, thread, "Run the shell command `echo hi`, then reply with the word done.");
    await completed(s);
    console.log(`  exit ${String(await s.close())}`);
  },

  /** A file change in a mode that asks first; the request is declined. */
  async "approval-file"(scratch, work) {
    const s = new Session(raw(scratch, "approval-file"), work, (session, m) => {
      session.send({ id: m["id"], result: { decision: "decline" } });
    });
    await s.initialize();
    const thread = await startThread(s, work, {
      approvalPolicy: "on-request",
      sandbox: "read-only",
      ephemeral: true,
    });
    await turn(
      s,
      thread,
      "Create a file named note.txt that holds the word ok, then reply with the word done.",
    );
    await completed(s);
    console.log(`  exit ${String(await s.close())}`);
  },

  /** A question for the person in plan mode: left unanswered, the turn is interrupted. */
  async question(scratch, work) {
    let asked: Message | undefined;
    const s = new Session(raw(scratch, "question"), work, (_session, m) => {
      asked = m;
    });
    await s.initialize();
    const thread = await startThread(s, work, FULL);
    const turnId = await turn(
      s,
      thread,
      "Before you do anything, ask me with your question tool which of two colours, red or blue, I prefer. Then reply with my answer.",
      { collaborationMode: { mode: "plan", settings: { model: MODEL, reasoning_effort: EFFORT } } },
    );
    const first = await Promise.race([
      s.next((m) => "id" in m && typeof m["method"] === "string", 120_000),
      s.next(method("turn/completed"), 120_000),
    ]);
    if (asked !== undefined || (first !== undefined && "id" in first)) {
      s.mark("interrupt with the question open");
      await s.request("turn/interrupt", { threadId: thread, turnId });
      await completed(s, 60_000);
    } else console.log("  no question was asked");
    console.log(`  exit ${String(await s.close())}`);
  },

  /** The `command` case's thread resumed in a new process, then deleted. */
  async resume(scratch, work, state) {
    const thread = state["thread"];
    if (typeof thread !== "string") throw new Error("resume needs the command case first");
    const s = new Session(raw(scratch, "resume"), work);
    await s.initialize();
    await s.request("thread/resume", {
      threadId: thread,
      cwd: work,
      model: MODEL,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    await turn(s, thread, "Reply with the word again and nothing else.");
    await completed(s);
    s.mark("delete");
    await s.request("thread/delete", { threadId: thread });
    console.log(`  exit ${String(await s.close())}`);
  },
};

function raw(scratch: string, name: string): string {
  return join(scratch, "raw", `${name}.jsonl`);
}

async function main(): Promise<void> {
  const [scratch, ...wanted] = process.argv.slice(2);
  if (scratch === undefined) throw new Error("usage: record.ts <scratch> [case ...]");
  mkdirSync(join(scratch, "raw"), { recursive: true });
  const state: Message = {};
  const names = wanted.length === 0 ? Object.keys(CASES) : wanted;
  for (const name of names) {
    const run = CASES[name];
    if (run === undefined) throw new Error(`no case ${name}`);
    const work = join(scratch, `work-${name}`);
    mkdirSync(work, { recursive: true });
    if (readdirSync(work).length > 0) throw new Error("the working folder is not empty");
    console.log(`case ${name}`);
    const t0 = performance.now();
    await run(scratch, work, state);
    console.log(`  ${String(Math.round(performance.now() - t0))} ms`);
  }
}

await main();
