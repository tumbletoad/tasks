// The Agent Monitor's child: one `ttam query` that the service starts when something asks for
// agents, and the line conversation with it (TTAM's docs/json-schema.md, "Lines").
//
// - One request is outstanding at a time, for every asker together. An ask while one is out waits
//   for the next request, which goes right after the answer and serves every ask made meanwhile:
//   its pass starts after each of them asked. `busy` means ask again.
// - No answer in time marks the monitor slow first, and later ends the child.
// - The child is ended by closing its input: closing only its output would leave an idle `ttam
//   query` running. What is left two seconds later is killed. Ten minutes after the last answer,
//   with no request since, it is ended the same way, and so it is when the service stops.
// - When the service itself dies, the child's input closes with it and TTAM ends by itself: the
//   input's other end is held by this process only, never inherited by another child.
// - Every process started here is owned until it is gone: close() waits for each, and a new child
//   starts only once the one before it is gone. Doctor's probe is one of them.
// - A child that failed is started again only after a wait, longer each time, and only when asked.
//   A missing or unfitting monitor is not asked again until recheck().
//
// Nothing TTAM writes reaches the log: the log gets fixed words and numbers only.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import {
  MONITOR_QUERY_VERSION,
  MONITOR_SCHEMA_VERSION,
  type MonitorBuild,
  type MonitorFailure,
  type MonitorProblem,
  type MonitorSnapshot,
} from "@ttasks/contracts/monitor";
import { readLine, readSnapshot } from "./lines.ts";

export interface MonitorTimes {
  /** From the start to the hello. */
  helloMs: number;
  /** An answer later than max(this, 4 × the last pass), capped by slowMaxMs, marks it slow. */
  slowMs: number;
  slowMaxMs: number;
  /** An answer later than max(this, 10 × the last pass) ends the child. */
  answerMs: number;
  /** From the last answer, with no request since, to the end of the child. */
  idleMs: number;
  /** From closing the child's input to killing it. */
  killMs: number;
  /** After `busy`, before the request goes again. */
  busyMs: number;
  /** The waits before a failed child is started again, the last one repeated. */
  retryMs: readonly number[];
}

export const MONITOR_TIMES: Readonly<MonitorTimes> = {
  helloMs: 5_000,
  slowMs: 10_000,
  slowMaxMs: 30_000,
  answerMs: 60_000,
  idleMs: 10 * 60_000,
  killMs: 2_000,
  busyMs: 250,
  retryMs: [1_000, 5_000, 30_000],
};

/** A TTAM line longer than this fails the child. */
export const MONITOR_LINE_MAX_BYTES = 8 * 1024 * 1024;

/** What to start: a `ttam` found, or why there is none. */
export type MonitorCommand =
  | {
      readonly ok: true;
      readonly file: string;
      readonly args?: readonly string[];
      readonly env: Readonly<Record<string, string | undefined>>;
      readonly cwd: string;
    }
  | { readonly ok: false; readonly reason: "not_found" | "script" };

export type MonitorAnswer =
  | {
      readonly ok: true;
      readonly snapshot: MonitorSnapshot;
      /** performance.now() when it arrived: an age in it is that old plus the time since. */
      readonly receivedAt: number;
    }
  | { readonly ok: false; readonly problem: MonitorProblem };

export interface MonitorStatus {
  readonly state: "off" | "starting" | "ready" | "problem";
  /** An answer is overdue: what was shown last is not updating. */
  readonly slow: boolean;
  readonly build: MonitorBuild | null;
  readonly problem: MonitorProblem | null;
}

/** What the monitor logs: fixed words and numbers, never a line of TTAM's. */
export type MonitorLog = (
  event: "monitor.started" | "monitor.ended",
  fields: Readonly<Record<string, string | number | boolean>>,
) => void;

export interface MonitorOptions {
  /** Finds `ttam` each time a child starts. */
  readonly command: () => Promise<MonitorCommand>;
  readonly times?: Partial<MonitorTimes>;
  readonly log?: MonitorLog;
  /** Called when status() changes. */
  readonly onChange?: () => void;
}

type Proc = ChildProcessByStdio<Writable, Readable, Readable>;
type Waiter = (answer: MonitorAnswer) => void;

interface Request {
  usage: "cached" | "live";
  readonly waiters: Waiter[];
}

interface Sent extends Request {
  id: number;
  readonly timers: NodeJS.Timeout[];
}

interface Child {
  readonly proc: Proc;
  readonly gone: Promise<void>;
  build: MonitorBuild | null;
  ready: boolean;
  ending: boolean;
  nextId: number;
  sent: Sent | undefined;
  timers: NodeJS.Timeout[];
}

const closed: MonitorProblem = { kind: "failed", reason: "closed" };

export function verdictOf(
  schema: unknown,
  query: unknown,
  build: MonitorBuild | null,
): MonitorProblem | undefined {
  if (schema === MONITOR_SCHEMA_VERSION && query === MONITOR_QUERY_VERSION) return undefined;
  const newer =
    (typeof schema === "number" && schema > MONITOR_SCHEMA_VERSION) ||
    (typeof query === "number" && query > MONITOR_QUERY_VERSION);
  return { kind: "does_not_fit", update: newer ? "ttasks" : "monitor", found: build };
}

/** Splits a child's output into lines; bytes after the last line end are no line. */
function lines(stream: Readable, onLine: (text: string) => void, onTooLong: () => void): void {
  let parts: Buffer[] = [];
  let size = 0;
  let over = false;
  const tooLong = (): void => {
    over = true;
    parts = [];
    onTooLong();
  };
  stream.on("data", (chunk: Buffer) => {
    if (over) return;
    let start = 0;
    for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
      const part = chunk.subarray(start, end);
      if (size + part.length > MONITOR_LINE_MAX_BYTES) {
        tooLong();
        return;
      }
      const text = Buffer.concat([...parts, part]).toString("utf8");
      parts = [];
      size = 0;
      start = end + 1;
      onLine(text.endsWith("\r") ? text.slice(0, -1) : text);
    }
    const rest = chunk.subarray(start);
    size += rest.length;
    if (size > MONITOR_LINE_MAX_BYTES) {
      tooLong();
      return;
    }
    if (rest.length > 0) parts.push(rest);
  });
}

export class Monitor {
  readonly #command: () => Promise<MonitorCommand>;
  readonly #times: MonitorTimes;
  readonly #log: MonitorLog;
  readonly #onChange: () => void;
  #child: Child | undefined;
  /** Every child whose process is not gone yet: the current one and those ending. */
  readonly #children = new Set<Child>();
  #starting = false;
  /** Doctor's probe under way, shared by every caller meanwhile. */
  #probe: { readonly result: Promise<MonitorProbe>; readonly stop: AbortController } | undefined;
  /** The request that goes once the one out is answered, shared by every ask meanwhile. */
  #next: Request | undefined;
  /** Not installed, or does not fit: kept until recheck(). */
  #verdict: MonitorProblem | undefined;
  #failure: { problem: MonitorProblem; until: number; count: number } | undefined;
  #lastPassMs = 0;
  #slow = false;
  #closed = false;

  constructor(options: MonitorOptions) {
    this.#command = options.command;
    this.#times = { ...MONITOR_TIMES, ...options.times };
    this.#log = options.log ?? (() => undefined);
    this.#onChange = options.onChange ?? (() => undefined);
  }

  status(): MonitorStatus {
    const busy = this.#child !== undefined || this.#starting;
    const problem = this.#closed
      ? closed
      : (this.#verdict ?? (busy ? undefined : this.#failure?.problem));
    return {
      state:
        problem !== undefined
          ? "problem"
          : this.#child?.ready === true
            ? "ready"
            : busy
              ? "starting"
              : "off",
      slow: this.#slow,
      build: this.#child?.build ?? null,
      problem: problem ?? null,
    };
  }

  /** A snapshot from a pass that starts after this call, or why there is none. */
  ask(usage: "cached" | "live" = "cached"): Promise<MonitorAnswer> {
    if (this.#closed) return Promise.resolve({ ok: false, problem: closed });
    if (this.#verdict !== undefined) return Promise.resolve({ ok: false, problem: this.#verdict });
    const failure = this.#failure;
    if (this.#child === undefined && failure !== undefined && performance.now() < failure.until) {
      return Promise.resolve({ ok: false, problem: failure.problem });
    }
    return new Promise((resolve) => {
      if (this.#next === undefined) this.#next = { usage, waiters: [resolve] };
      else {
        this.#next.waiters.push(resolve);
        if (usage === "live") this.#next.usage = "live";
      }
      this.#pump();
    });
  }

  /** Forgets a missing or unfitting monitor and the wait after a failure: the next ask looks again. */
  recheck(): void {
    this.#verdict = undefined;
    this.#failure = undefined;
    this.#onChange();
  }

  /** Doctor's look at `command`: its hello, read by a run that collects nothing. */
  probe(command: MonitorCommand): Promise<MonitorProbe> {
    if (this.#closed) return Promise.resolve({ fits: false, problem: closed });
    if (this.#probe === undefined) {
      const stop = new AbortController();
      const result = probeMonitor(command, this.#times, stop.signal).finally(() => {
        this.#probe = undefined;
      });
      this.#probe = { result, stop };
    }
    return this.#probe.result;
  }

  /**
   * Ends the child and the probe, and returns once every process started here is gone: each is
   * killed killMs after its end at the latest. Refuses every ask from now on.
   */
  async close(): Promise<void> {
    this.#closed = true;
    const child = this.#child;
    this.#answerAll(child, { ok: false, problem: closed });
    if (child !== undefined) this.#end(child, "closed");
    this.#probe?.stop.abort();
    await Promise.all([...[...this.#children].map((c) => c.gone), this.#probe?.result]);
    this.#onChange();
  }

  #pump(): void {
    if (this.#closed) return;
    const child = this.#child;
    if (child === undefined) {
      if (this.#next !== undefined && !this.#starting) void this.#start();
      return;
    }
    if (!child.ready || child.ending || child.sent !== undefined) return;
    const request = this.#next;
    if (request === undefined) {
      // Quiet: it ends idleMs after its last answer unless a request goes first.
      for (const timer of child.timers) clearTimeout(timer);
      child.timers = [
        setTimeout(() => {
          this.#end(child, "idle");
        }, this.#times.idleMs),
      ];
      return;
    }
    this.#next = undefined;
    const sent: Sent = { ...request, id: 0, timers: [] };
    child.sent = sent;
    const last = this.#lastPassMs;
    const t = this.#times;
    sent.timers.push(
      setTimeout(
        () => {
          this.#slow = true;
          this.#onChange();
        },
        Math.min(t.slowMaxMs, Math.max(t.slowMs, 4 * last)),
      ),
      setTimeout(
        () => {
          this.#fail(child, "not_answering");
        },
        Math.max(t.answerMs, 10 * last),
      ),
    );
    this.#send(child, sent);
  }

  #send(child: Child, sent: Sent): void {
    sent.id = child.nextId++;
    child.proc.stdin.write(`${JSON.stringify({ id: sent.id, type: "get", usage: sent.usage })}\n`);
    for (const timer of child.timers) clearTimeout(timer);
    child.timers = [];
  }

  async #start(): Promise<void> {
    this.#starting = true;
    this.#onChange();
    let command: MonitorCommand;
    try {
      await Promise.all([...this.#children].map((c) => c.gone));
      command = await this.#command();
    } catch {
      command = { ok: false, reason: "not_found" };
    } finally {
      this.#starting = false;
    }
    if (this.#closed) return;
    if (!command.ok) {
      this.#setVerdict({ kind: "not_installed", reason: command.reason });
      return;
    }
    let proc: Proc;
    try {
      proc = spawn(command.file, [...(command.args ?? []), "query"], {
        cwd: command.cwd,
        env: command.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      this.#failed(undefined, "start_failed");
      return;
    }
    const gone = new Promise<void>((resolve) => {
      proc.once("exit", () => {
        resolve();
      });
      proc.once("error", () => {
        if (proc.pid === undefined) resolve();
      });
    });
    const child: Child = {
      proc,
      gone,
      build: null,
      ready: false,
      ending: false,
      nextId: 1,
      sent: undefined,
      timers: [],
    };
    this.#child = child;
    this.#children.add(child);
    void gone.then(() => {
      this.#children.delete(child);
    });
    this.#log("monitor.started", {});
    // TTAM's diagnostics may name private things: read and dropped.
    proc.stderr.resume();
    proc.stdin.on("error", () => undefined);
    proc.once("error", () => {
      if (proc.pid === undefined) this.#fail(child, "start_failed");
    });
    proc.once("close", (code) => {
      this.#exited(child, code);
    });
    lines(
      proc.stdout,
      (text) => {
        this.#line(child, text);
      },
      () => {
        this.#fail(child, "bad_output");
      },
    );
    child.timers.push(
      setTimeout(() => {
        this.#fail(child, "no_hello");
      }, this.#times.helloMs),
    );
    this.#onChange();
  }

  #line(child: Child, text: string): void {
    // After the end, and from a child that is no longer the current one, nothing counts.
    if (child.ending || child !== this.#child) return;
    if (text.trim() === "") return;
    const line = readLine(text);
    if (!child.ready) {
      if (line?.type !== "hello") {
        this.#fail(child, "no_hello");
        return;
      }
      const verdict = verdictOf(line.schemaVersion, line.queryVersion, line.build);
      if (verdict !== undefined) {
        this.#setVerdict(verdict);
        return;
      }
      if (line.build === null) {
        this.#fail(child, "bad_output");
        return;
      }
      for (const timer of child.timers) clearTimeout(timer);
      child.timers = [];
      child.ready = true;
      child.build = line.build;
      this.#onChange();
      this.#pump();
      return;
    }
    if (line === undefined) {
      this.#fail(child, "bad_output");
      return;
    }
    // An error without an ID answers a line TTasks never sends.
    if (line.type === "error" && line.id === null) {
      this.#fail(child, "refused");
      return;
    }
    const sent = child.sent;
    if (
      line.type === "other" ||
      line.type === "hello" ||
      sent === undefined ||
      line.id !== sent.id
    ) {
      return;
    }
    if (line.type === "error") {
      if (line.code !== "busy") {
        this.#fail(child, "refused");
        return;
      }
      sent.timers.push(
        setTimeout(() => {
          if (child.sent === sent && !child.ending) this.#send(child, sent);
        }, this.#times.busyMs),
      );
      return;
    }
    let snapshot: MonitorSnapshot;
    try {
      snapshot = readSnapshot(line.line, MONITOR_SCHEMA_VERSION);
    } catch {
      this.#setVerdict({ kind: "does_not_fit", update: "monitor", found: child.build });
      return;
    }
    for (const timer of sent.timers) clearTimeout(timer);
    child.sent = undefined;
    this.#lastPassMs = snapshot.collectionMs;
    this.#slow = false;
    this.#failure = undefined;
    const answer: MonitorAnswer = { ok: true, snapshot, receivedAt: performance.now() };
    for (const waiter of sent.waiters) waiter(answer);
    this.#onChange();
    this.#pump();
  }

  #exited(child: Child, code: number | null): void {
    for (const timer of child.timers) clearTimeout(timer);
    if (child.ending || child !== this.#child) return;
    // A build without `ttam query` does not understand its arguments.
    if (!child.ready && code === 2) {
      this.#setVerdict({ kind: "not_installed", reason: "no_query" });
      return;
    }
    this.#fail(child, "exited");
  }

  /** The current child failed: it ends, every ask gets the failure, the next start waits. */
  #fail(child: Child, reason: MonitorFailure): void {
    if (child.ending || child !== this.#child) return;
    this.#end(child, reason);
    this.#failed(child, reason);
  }

  #failed(child: Child | undefined, reason: MonitorFailure): void {
    const problem: MonitorProblem = { kind: "failed", reason };
    const count = (this.#failure?.count ?? 0) + 1;
    const retry = this.#times.retryMs;
    const wait = retry[Math.min(count, retry.length) - 1] ?? 0;
    this.#failure = { problem, until: performance.now() + wait, count };
    this.#answerAll(child, { ok: false, problem });
    this.#onChange();
  }

  #setVerdict(problem: MonitorProblem): void {
    this.#verdict = problem;
    const child = this.#child;
    if (child !== undefined) this.#end(child, problem.kind);
    this.#answerAll(child, { ok: false, problem });
    this.#onChange();
  }

  /** Every ask waiting, on `child` and for the next request, gets `answer`. */
  #answerAll(child: Child | undefined, answer: MonitorAnswer): void {
    const waiters = [...(child?.sent?.waiters ?? []), ...(this.#next?.waiters ?? [])];
    for (const timer of child?.sent?.timers ?? []) clearTimeout(timer);
    if (child !== undefined) child.sent = undefined;
    this.#next = undefined;
    for (const waiter of waiters) waiter(answer);
  }

  /** Closes the child's input and kills it after killMs. It is no longer the current child. */
  #end(child: Child, why: string): void {
    if (child.ending) return;
    child.ending = true;
    for (const timer of child.timers) clearTimeout(timer);
    for (const timer of child.sent?.timers ?? []) clearTimeout(timer);
    if (this.#child === child) {
      this.#child = undefined;
      this.#slow = false;
    }
    child.proc.stdin.end();
    const kill = setTimeout(() => {
      child.proc.kill("SIGKILL");
    }, this.#times.killMs);
    void child.gone.then(() => {
      clearTimeout(kill);
      this.#log("monitor.ended", { why, killed: child.proc.signalCode === "SIGKILL" });
    });
  }
}

export type MonitorProbe =
  | { readonly fits: true; readonly build: MonitorBuild }
  | { readonly fits: false; readonly problem: MonitorProblem };

/**
 * Starts `command` with its input already closed and reads its hello: TTAM writes its hello, runs
 * no pass and exits, so it reads no session. Resolves once the process is gone; `stop` kills it.
 */
function probeMonitor(
  command: MonitorCommand,
  times: { readonly helloMs: number; readonly killMs: number },
  stop: AbortSignal,
): Promise<MonitorProbe> {
  if (!command.ok) {
    return Promise.resolve({
      fits: false,
      problem: { kind: "not_installed", reason: command.reason },
    });
  }
  const failed = (reason: MonitorFailure): MonitorProbe => ({
    fits: false,
    problem: { kind: "failed", reason },
  });
  return new Promise((resolve) => {
    let first: string | undefined;
    let text = "";
    const proc = spawn(command.file, [...(command.args ?? []), "query"], {
      cwd: command.cwd,
      env: command.env,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const kill = (): void => {
      proc.kill("SIGKILL");
    };
    stop.addEventListener("abort", kill);
    const deadline = setTimeout(kill, times.helloMs + times.killMs);
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      if (first !== undefined) return;
      text += chunk;
      const end = text.indexOf("\n");
      if (end !== -1) first = text.slice(0, end);
      else if (text.length > 64 * 1024) kill();
    });
    const done = (probe: MonitorProbe): void => {
      clearTimeout(deadline);
      stop.removeEventListener("abort", kill);
      resolve(probe);
    };
    proc.once("error", () => {
      if (proc.pid === undefined) done(failed("start_failed"));
    });
    proc.once("close", (code) => {
      if (stop.aborted) {
        done(failed("closed"));
        return;
      }
      if (first === undefined) {
        done(
          code === 2
            ? { fits: false, problem: { kind: "not_installed", reason: "no_query" } }
            : failed(code === null ? "no_hello" : "exited"),
        );
        return;
      }
      const line = readLine(first);
      if (line?.type !== "hello") {
        done(failed("no_hello"));
        return;
      }
      const verdict = verdictOf(line.schemaVersion, line.queryVersion, line.build);
      if (verdict !== undefined) done({ fits: false, problem: verdict });
      else if (line.build === null) done(failed("no_hello"));
      else done({ fits: true, build: line.build });
    });
  });
}
