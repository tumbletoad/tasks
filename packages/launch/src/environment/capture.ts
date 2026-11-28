// One bounded run of a helper program whose output the service reads (the session layer,
// the login-shell snapshot, the registry layers). Never through a shell, stdin closed, a hard
// deadline, a bound on what is read, and a defined result for every way it can go:
// - `done`: the program wrote what the caller waits for (`complete` said so), or it ended. When
//   `complete` ends the capture first, the deadline still holds for the program: one still running
//   then (a shell hanging in an EXIT trap or a logout script) is killed with its process group;
// - `timeout`: the deadline passed first. Its process group (Linux and macOS: it leads its own) is
//   killed, so nothing it started keeps running;
// - `too_large`: it wrote more than the bound;
// - `failed`: it could not be started.
// The caller decides what an exit code or the output means. Nothing read here is logged.
import { spawn } from "node:child_process";

export interface CaptureRequest {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  /** Ends the capture as soon as the output holds what the caller needs. */
  readonly complete?: (output: Buffer) => boolean;
}

export type CaptureResult =
  | {
      readonly kind: "done";
      readonly output: Buffer;
      /** Undefined when `complete` ended the capture before the program did. */
      readonly code: number | null | undefined;
      readonly ms: number;
    }
  | { readonly kind: "timeout" | "too_large" | "failed"; readonly ms: number };

/** Runs a helper and captures its stdout. Tests pass a fake. */
export type Capture = (request: CaptureRequest) => Promise<CaptureResult>;

/** The OS's capture: a child without a shell, its own process group on Linux and macOS. */
export const captureOutput: Capture = (request) =>
  new Promise<CaptureResult>((resolve) => {
    const started = performance.now();
    const ms = (): number => Math.round(performance.now() - started);
    const [file, ...args] = request.argv;
    if (file === undefined) {
      resolve({ kind: "failed", ms: 0 });
      return;
    }
    const posix = process.platform !== "win32";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, {
        env: { ...request.env },
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        stdio: ["ignore", "pipe", "ignore"],
        detached: posix,
        windowsHide: true,
        shell: false,
      });
    } catch {
      resolve({ kind: "failed", ms: ms() });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    /** The program itself has ended (its 'exit'; its output may still be open). */
    let ended = false;
    const kill = (): void => {
      const pid = child.pid;
      try {
        if (posix && pid !== undefined) process.kill(-pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const finish = (result: CaptureResult, killFirst: boolean): void => {
      if (settled) return;
      settled = true;
      if (killFirst) {
        clearTimeout(timer);
        kill();
      } else if (ended) {
        clearTimeout(timer);
      } else {
        // Done before the program ended: the deadline still ends it, without holding the service.
        timer.unref();
      }
      child.stdout?.destroy();
      child.unref();
      resolve(result);
    };
    const timer = setTimeout(() => {
      // After a completed capture, a program still running is ended with its group. One that ended
      // on its own is left alone, as a terminal's shell would be.
      if (!settled) finish({ kind: "timeout", ms: ms() }, true);
      else if (!ended) kill();
    }, request.timeoutMs);
    child.once("exit", () => {
      ended = true;
      if (settled) clearTimeout(timer);
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > request.maxBytes) {
        finish({ kind: "too_large", ms: ms() }, true);
        return;
      }
      chunks.push(chunk);
      if (request.complete !== undefined) {
        const output = Buffer.concat(chunks);
        if (request.complete(output))
          finish({ kind: "done", output, code: undefined, ms: ms() }, false);
      }
    });
    child.stdout?.on("error", () => undefined);
    child.once("error", () => {
      ended = child.pid === undefined; // It never started: nothing to end at the deadline.
      finish({ kind: "failed", ms: ms() }, false);
    });
    child.once("close", (code) => {
      finish({ kind: "done", output: Buffer.concat(chunks), code, ms: ms() }, false);
    });
  });
