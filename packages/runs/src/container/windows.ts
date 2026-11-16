// Windows containers: each run is a named job object `Local\tasks-run-<name>`, created and held by
// tasks-run.exe (packages/launcher-win/src/run.c), which starts the agent already inside it.
// Nothing in the job can break away, detached processes included. The helper holds the only
// handle to the job, and the job ends every process when its last handle closes: so the run ends
// when the helper ends, and the helper ends with the service (Node starts it as a plain child, in
// the job libuv keeps for its children) or when the service closes its control pipe.
//
// Confirmation reads the job by name in a separate, short-lived helper that closes its handle at
// once: any open handle keeps a job and its processes alive. "No job by that name" (error 2) or
// "0 active processes" is the evidence; any other error is not.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { PRODUCT_ID } from "@tasks/brand";
import { windowsCommandLine } from "./command-line.ts";
import { unavailableMessage } from "./placement.ts";
import {
  checkName,
  ContainerError,
  DEFAULT_RECOVER_WAIT_MS,
  type AgentExit,
  type ConfirmOptions,
  type Confirmation,
  type Contained,
  type Containers,
  type ContainerSpec,
  type ProbeResult,
} from "./types.ts";

/** How long the service waits for the helper's answer to a command, or for it to end. */
const ANSWER_MS = 5_000;
const POLL_MS = 50;

/** The job's name for a container: its prefix keeps runs apart from other programs' jobs. */
export const jobName = (name: string): string => `${PRODUCT_ID}-run-${name}`;

export interface WindowsOptions {
  /** The absolute path of tasks-run.exe. */
  readonly helper: string;
}

interface Live {
  readonly helper: ChildProcess;
  readonly control: Writable;
  readonly pid: number;
  /** The next answer line of each command, in order. */
  readonly waiting: ((line: string | undefined) => void)[];
  ended: boolean;
  /** The agent itself exited: an interrupt would reach only what it left behind. */
  agentExited: boolean;
  readonly helperEnded: Promise<void>;
}

/** What `tasks-run.exe confirm|end` reported. */
type Reading =
  | { readonly state: "empty" }
  | { readonly state: "occupied"; readonly detail: string }
  | { readonly state: "unknown"; readonly detail: string };

/** `promise`'s value, or undefined after `ms`; the timer does not outlive the answer. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  const timer = new AbortController();
  try {
    return await Promise.race([
      promise,
      sleep(ms, undefined, { signal: timer.signal }).catch(() => undefined),
    ]);
  } finally {
    timer.abort();
  }
}

export class WindowsContainers implements Containers {
  private readonly helper: string;
  private readonly live = new Map<string, Live>();

  constructor(options: WindowsOptions) {
    this.helper = options.helper;
  }

  async probe(): Promise<ProbeResult> {
    if (!existsSync(this.helper)) {
      return {
        available: false,
        reason: "helper_missing",
        message: unavailableMessage("helper_missing"),
      };
    }
    const name = `probe-${randomBytes(6).toString("hex")}`;
    try {
      await this.start({
        name,
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1 << 30)"],
        cwd: process.cwd(),
        env: {},
      });
    } catch (error) {
      const why = error instanceof Error ? error.message : "the test process did not start";
      return {
        available: false,
        reason: "check_failed",
        message: unavailableMessage("check_failed", why),
      };
    }
    await this.kill(name);
    const confirmed = await this.confirmEmpty(name, { waitMs: 5_000 });
    if (confirmed.state !== "empty") {
      return {
        available: false,
        reason: "check_failed",
        message: unavailableMessage(
          "check_failed",
          `the test container was not empty: ${confirmed.detail}`,
        ),
      };
    }
    return { available: true, kind: "job" };
  }

  async start(spec: ContainerSpec): Promise<Contained> {
    checkName(spec.name);
    if (!existsSync(this.helper)) {
      throw new ContainerError("unavailable", unavailableMessage("helper_missing"));
    }
    if (this.live.has(spec.name)) {
      throw new ContainerError("exists", "a container with this name exists");
    }
    const helper = spawn(
      this.helper,
      ["start", jobName(spec.name), spec.command, windowsCommandLine([spec.command, ...spec.args])],
      {
        cwd: spec.cwd,
        env: spec.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
      },
    );
    const control = helper.stdio[3] as Writable | null;
    const events = helper.stdio[4] as Readable | null;
    const { stdout, stderr } = helper;
    if (control === null || events === null || stdout === null || stderr === null) {
      helper.kill();
      throw new Error("spawn gave no pipes");
    }
    control.on("error", () => undefined);
    // Ended: the process exited and its last event line was read. Its stdout can stay open longer,
    // in a process of the job that is still being ended.
    const helperEnded = new Promise<void>((resolve) => {
      let exited = false;
      let closed = false;
      helper.once("exit", () => {
        exited = true;
        if (closed) resolve();
      });
      events.once("close", () => {
        closed = true;
        if (exited) resolve();
      });
      helper.once("error", () => {
        if (helper.pid === undefined) resolve();
      });
    });
    let reportExit: (exit: AgentExit) => void = () => undefined;
    const exited = new Promise<AgentExit>((resolve) => {
      reportExit = resolve;
    });
    void helperEnded.then(() => {
      reportExit({ code: null, signal: null });
    });

    return new Promise<Contained>((resolve, reject) => {
      let live: Live | undefined;
      let failure = "the helper ended before the agent started";
      const lines = createInterface({ input: events, crlfDelay: Infinity });
      lines.on("line", (line) => {
        const [word, ...rest] = line.split(" ");
        if (live === undefined) {
          if (word === "pid") {
            const pid = Number(rest[0]);
            live = {
              helper,
              control,
              pid,
              waiting: [],
              ended: false,
              agentExited: false,
              helperEnded,
            };
            this.live.set(spec.name, live);
            resolve({ name: spec.name, pid, stdout, stderr, exited });
          } else if (word === "error") {
            failure =
              rest[0] === "exists" ? "exists" : `the agent did not start (${rest.join(" ")})`;
          }
          return;
        }
        if (word === "exit") {
          live.agentExited = true;
          reportExit({ code: Number(rest[0]), signal: null });
        } else if (word === "interrupt" || word === "kill") live.waiting.shift()?.(line);
      });
      void helperEnded.then(() => {
        if (live === undefined) {
          reject(
            failure === "exists"
              ? new ContainerError("exists", "a container with this name exists")
              : new ContainerError("start_failed", failure),
          );
          return;
        }
        live.ended = true;
        for (const answer of live.waiting.splice(0)) answer(undefined);
      });
    });
  }

  /** Sends a command to the live helper and waits for its answer: true when it succeeded. */
  private async command(live: Live, command: "interrupt" | "kill"): Promise<boolean> {
    if (live.ended) return false;
    const answer = new Promise<string | undefined>((resolve) => {
      live.waiting.push(resolve);
    });
    live.control.write(`${command}\n`);
    const line = await within(answer, ANSWER_MS);
    return line?.split(" ")[1] === "1";
  }

  async interrupt(name: string): Promise<boolean> {
    const live = this.live.get(name);
    return live === undefined || live.agentExited ? false : this.command(live, "interrupt");
  }

  async kill(name: string): Promise<void> {
    checkName(name);
    const live = this.live.get(name);
    if (live !== undefined && (await this.command(live, "kill"))) return;
    // No helper of this service holds the job, or it did not answer: end it by name.
    await this.read("end", name);
  }

  async confirmEmpty(name: string, options: ConfirmOptions = {}): Promise<Confirmation> {
    checkName(name);
    const deadline = performance.now() + (options.waitMs ?? 0);
    const live = this.live.get(name);
    if (live !== undefined) {
      // The helper says "empty" and ends once the job is empty: wait for that first, then read
      // the job by name, which is the evidence.
      await within(live.helperEnded, Math.max(0, deadline - performance.now()));
    }
    for (;;) {
      const reading = await this.read("confirm", name);
      if (reading.state === "empty") {
        if (live !== undefined) await this.release(name, live);
        return reading;
      }
      if (reading.state === "unknown" || performance.now() >= deadline) return reading;
      await sleep(POLL_MS);
    }
  }

  async recover(name: string, options: ConfirmOptions = {}): Promise<Confirmation> {
    checkName(name);
    await this.read("end", name);
    return this.confirmEmpty(name, { waitMs: options.waitMs ?? DEFAULT_RECOVER_WAIT_MS });
  }

  /** Lets the helper of an empty job go: it ends, and the job's name with it. */
  private async release(name: string, live: Live): Promise<void> {
    live.control.destroy();
    await within(live.helperEnded, ANSWER_MS);
    this.live.delete(name);
  }

  /** Runs `tasks-run.exe confirm|end <job>` and reads its answer. */
  private read(mode: "confirm" | "end", name: string): Promise<Reading> {
    return new Promise((resolve) => {
      execFile(
        this.helper,
        [mode, jobName(name)],
        { windowsHide: true, encoding: "utf8", timeout: 15_000 },
        (error, stdout) => {
          const said = stdout.trim();
          const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
          if (code === 0 && (said === "gone" || said === "active 0")) resolve({ state: "empty" });
          else if (code === 1 && said.startsWith("active ")) {
            resolve({ state: "occupied", detail: `job: ${said}` });
          } else resolve({ state: "unknown", detail: `job: ${said === "" ? "no answer" : said}` });
        },
      );
    });
  }
}
