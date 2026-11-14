// `tasks serve` as a process (A2 3.3.1, 3.13): runs the service until it stops and returns the exit
// code. This is the one place that touches process-wide state: the crash handlers, the signal
// handlers and Node's fatal-error reports. startService() itself stays free of them, so tests can
// run it in-process.
//
// - SIGTERM (systemd, launchd's wrapper), SIGINT, SIGHUP and on Windows SIGBREAK drain the service
//   and exit 0. On Windows a stop comes as `service/shutdown` over the pipe (A2 3.3.5).
// - An uncaught exception or an unhandled rejection writes a content-free crash file and exits 70
//   at once: the locks are released by the OS, and the next start recovers the rest.
import { PRODUCT_NAME } from "@tasks/brand";
import { BUILD, startService, type StartOptions } from "./service.ts";
import {
  crashRecord,
  errorCode,
  errorType,
  refusalRecord,
  routeNodeReports,
  writeCrashFile,
  type CrashContext,
} from "./crash.ts";
import { EXIT, ServiceExit, type ExitCode } from "./exit.ts";
import type { Logger } from "./log.ts";

const SIGNALS: readonly NodeJS.Signals[] =
  process.platform === "win32"
    ? ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]
    : ["SIGINT", "SIGTERM", "SIGHUP"];

/** Runs `tasks serve` in this process and resolves with its exit code. */
export async function runServe(options: StartOptions = {}): Promise<ExitCode> {
  const context: CrashContext = { ...BUILD, startedAt: Date.now() };
  let attached: { log: Logger; crashDir: string } | undefined;

  const record = (make: (recent: readonly string[], now: Date) => Record<string, unknown>) => {
    if (attached === undefined) return;
    try {
      const now = new Date();
      writeCrashFile(attached.crashDir, make(attached.log.recent(), now), now);
    } catch {
      // The crash folder cannot be written: stderr and the exit code still tell.
    }
  };

  let crashing = false;
  const crash = (error: unknown): void => {
    if (crashing) return;
    crashing = true;
    const code = errorCode(error);
    attached?.log.log("service.crashed", {
      type: errorType(error),
      ...(code === undefined ? {} : { code }),
    });
    record((recent, now) => crashRecord(error, "service.crash", context, recent, now));
    process.exit(EXIT.crashed);
  };
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);

  let stop: (() => void) | undefined;
  // A signal that comes while the service is starting stops it as soon as it is ready.
  const received: { signal: boolean } = { signal: false };
  const onSignal = (): void => {
    received.signal = true;
    stop?.();
  };
  for (const signal of SIGNALS) process.on(signal, onSignal);

  try {
    const service = await startService({
      ...options,
      // `tasks serve` always runs the UI's listener with the product's settings (A2 3.8).
      http: options.http ?? {},
      attach: (value) => {
        attached = value;
        options.attach?.(value);
      },
    });
    if (attached !== undefined) routeNodeReports(attached.crashDir);
    stop = () => {
      void service.stop({ reason: "signal" });
    };
    if (received.signal) stop();
    return await service.exited;
  } catch (error) {
    if (!(error instanceof ServiceExit)) {
      // A failure before the lock (a folder that cannot be created, for example).
      const code = errorCode(error);
      if (attached === undefined) {
        // No log yet: stderr is the only place that can tell. A fixed line and a listed code.
        try {
          process.stderr.write(
            `${PRODUCT_NAME}'s service could not start${code === undefined ? "" : ` (${code})`}.\n`,
          );
        } catch {
          // Nothing else to tell.
        }
      }
      attached?.log.log("service.start_failed", {
        type: errorType(error),
        ...(code === undefined ? {} : { code }),
      });
      record((recent, now) => crashRecord(error, "service.start_failed", context, recent, now));
      return EXIT.crashed;
    }
    // A refusal the log could record goes to the crash folder too. Root and unsafe folders are
    // refused before the log exists, so nothing is written as root or into a folder others own.
    if (error.code === EXIT.refused && error.refusal !== undefined) {
      const refusal = error.refusal;
      record((recent, now) => refusalRecord(refusal, context, recent, now));
    } else if (error.code === EXIT.crashed) {
      record((recent, now) => crashRecord(error, "service.start_failed", context, recent, now));
    }
    return error.code;
  }
}
