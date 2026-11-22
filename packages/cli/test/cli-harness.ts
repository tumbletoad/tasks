// Test helpers for the CLI: a real service as a child process in a temporary TASKS_HOME with one
// space, and `tasks` commands as child processes against it. Every PID is recorded and stopped by
// the test that started it, and the temporary folder is removed by its full name. Tests only.
//
// Against a build (`pnpm accept --installed <version folder>`, which sets TASKS_ACCEPT_INSTALLED):
// the temporary TASKS_HOME is a test install of that version folder (testkit's layoutTestInstall),
// the service is `<home>/bin/tasks serve` through the stable launcher, and every `tasks` command
// without a test script of its own runs through that launcher too, as real processes. Commands
// that need a test hook (a lost reply, a newer protocol) still run the CLI from source, against the
// built service; `runMain` runs the CLI in this process, as a person at a terminal, also against it.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAgentMarker, LocalError } from "@tasks/bridge/protocol";
import {
  diagnostics,
  openSession,
  readServiceJson,
  registerSpaces,
  removeRuntimeDirOf,
  serviceEnv,
  Services,
  tempRoot,
  waitFor,
  waitReady,
  within,
  READY_MS,
  type Proc,
  type ServiceJson,
} from "@tasks/service/test/harness";
import { classSession } from "@tasks/service/test/ops-helpers";
import { layoutTestInstall, type TestInstall } from "@tasks/testkit";
import { main, type Io, type MainOptions } from "../src/main.ts";

/** The built version folder the acceptance runs against, from `pnpm accept --installed`. */
export const INSTALLED = process.env["TASKS_ACCEPT_INSTALLED"];

export const BIN = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
export const NEWER = fileURLToPath(new URL("./newer-cli.ts", import.meta.url));
/** The CLI with a fault from TASKS_TEST_FAULT: a lost write reply, or a trace of its operations. */
export const FAULTY = fileURLToPath(new URL("./faulty-cli.ts", import.meta.url));

/** A slow runner must not fail a test that is only slow. */
export const CLI_MS = 90_000;

export interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The environment of a `tasks` child: the service's (TASKS_HOME, no other Tasks variable), without
 * the agent markers of the shell that runs the tests, so the class is `cli-script` unless `extra`
 * adds a marker.
 */
export function cliEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(serviceEnv(home)).filter(([name]) => !isAgentMarker(name)),
  );
  return { ...env, ...extra };
}

export interface CliWorld {
  readonly root: string;
  readonly home: string;
  readonly spaceFolder: string;
  readonly service: Proc;
  readonly json: ServiceJson;
  /** The test install of a build, when the acceptance runs against one. */
  readonly install: TestInstall | undefined;
  /** Runs `tasks <args>` as a child process. */
  tasks(
    args: readonly string[],
    options?: { env?: Record<string, string>; stdin?: string; script?: string },
  ): Promise<Ran>;
  close(): Promise<void>;
}

/**
 * Starts a service child with one space, "Mira" (prefix M), created by the user. `env` adds to the
 * service's environment; `machineToml` is machine.toml's text before the service starts.
 */
export async function startWorld(
  label: string,
  options: { readonly env?: Record<string, string>; readonly machineToml?: string } = {},
): Promise<CliWorld> {
  const temp = tempRoot(label);
  const home = join(temp.root, "h");
  const services = new Services();
  const children = new Set<ReturnType<typeof spawn>>();
  let json: ServiceJson | undefined;
  try {
    if (options.machineToml !== undefined) registerSpaces(home, [], options.machineToml);
    const install = INSTALLED === undefined ? undefined : layoutTestInstall(INSTALLED, home);
    const service = services.start(home, {
      ...(install === undefined ? {} : { command: [install.launcher, "serve"] as const }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    // tasks.exe starts Node as its child, so on Windows service.json names Node's PID, not the
    // launcher's. The POSIX launcher execs Node: one process.
    json =
      install !== undefined && process.platform === "win32"
        ? await waitFor(
            () => {
              const record = readServiceJson(home);
              return record?.state === "ready" ? record : undefined;
            },
            READY_MS,
            "the built service ready",
          )
        : await waitReady(home, service.pid);
    const path = json.endpoint?.path ?? "";
    const spaceFolder = join(temp.root, "s", "mira");
    const user = await classSession(home, path, "cli-interactive");
    try {
      await user.call(
        "space/create",
        { name: "Mira", path: spaceFolder, ref_prefix: "M" },
        { timeoutMs: 120_000 },
      );
    } finally {
      user.close();
    }
    const tasks: CliWorld["tasks"] = (args, options = {}) => {
      const [file, ...argv] =
        install !== undefined && options.script === undefined
          ? [install.launcher, ...args]
          : [process.execPath, options.script ?? BIN, ...args];
      const child = spawn(file, argv, {
        env: cliEnv(home, options.env),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        cwd: temp.root,
      });
      children.add(child);
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.stdin ?? "");
      return within(
        new Promise<Ran>((resolve) => {
          child.once("exit", (code) => {
            children.delete(child);
            // The streams may still hold the last chunk.
            setImmediate(() => {
              resolve({ code, stdout, stderr });
            });
          });
        }),
        CLI_MS,
        "a tasks command",
      );
    };
    const ready = json;
    return {
      root: temp.root,
      home,
      spaceFolder,
      service,
      json: ready,
      install,
      tasks,
      close: async () => {
        try {
          await reportLostService(service, home, ready).catch(() => undefined);
          for (const child of children) child.kill("SIGKILL");
          if (install === undefined) service.send("stop");
          else {
            // The built `tasks serve` has no test entry to read a stop line: the graceful stop on
            // every OS is service/shutdown (A2 3.3.5), which a script's connection may send.
            const session = await openSession(home, path).catch(() => undefined);
            await session
              ?.call("service/shutdown", {}, { timeoutMs: 10_000 })
              .catch(() => undefined);
            session?.close();
          }
          await within(service.exit, 60_000, "the service's stop").catch(() =>
            services.kill(service),
          );
          await services.stopAll();
        } finally {
          // The runtime folder the service caused, by its full name, also after a kill or a stop
          // that failed; then the test's folder.
          removeRuntimeDirOf(home);
          temp.cleanup();
        }
      },
    };
  } catch (error) {
    try {
      await services.stopAll();
    } finally {
      removeRuntimeDirOf(home);
      temp.cleanup();
    }
    throw error;
  }
}

/** How long a service whose endpoint failed may take to be seen as ended. */
const EXIT_SEEN_MS = 5_000;

/** A failed probe's error, with the transport's reason and detail when it has them. */
function probeError(error: unknown): string {
  if (error instanceof LocalError) return `${error.reason} (${error.detail})`;
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** An exit code, with its NTSTATUS in hex on Windows, where a native crash ends with one. */
function exitText(code: number | null): string {
  if (code === null || process.platform !== "win32" || code < 0x100) return String(code);
  return `${String(code)} (0x${(code >>> 0).toString(16).toUpperCase()})`;
}

/**
 * A service that ended, or stopped answering, before its test stopped it fails the commands after
 * it with an error that says nothing about why: the probe's error, whether service.json still names
 * the service the test started, how it ended, its stderr, the end of its log and its crash files go
 * to this test's stderr, so the failure carries its cause.
 */
async function reportLostService(service: Proc, home: string, saved: ServiceJson): Promise<void> {
  const path = saved.endpoint?.path ?? "";
  let probe: string | undefined;
  if (service.child.exitCode === null && service.child.signalCode === null) {
    try {
      (await openSession(home, path, 10_000)).close();
      return;
    } catch (error) {
      probe = probeError(error);
    }
    // A process that crashes closes its endpoint before its parent sees the exit.
    await within(service.exit, EXIT_SEEN_MS, "the exit").catch(() => undefined);
  }
  const { exitCode, signalCode } = service.child;
  const running = exitCode === null && signalCode === null;
  const now = readServiceJson(home);
  const same = (field: "pid" | "instance") =>
    now === undefined ? "no service.json" : now[field] === saved[field] ? "same" : "changed";
  const endpoint =
    now === undefined ? "no service.json" : now.endpoint?.path === path ? "same" : "changed";
  let found: { file: string; text: string }[];
  try {
    found = diagnostics(home);
  } catch (error) {
    found = [{ file: "logs and crash files", text: `not read: ${String(error)}` }];
  }
  const files = found.map(({ file, text }) => {
    const lines = text.split("\n");
    return `--- ${file} ---\n${lines.slice(-80).join("\n")}`;
  });
  process.stderr.write(
    [
      running
        ? `The service stopped answering before its test stopped it: service.json says ${String(now?.state)}`
        : `The service ended before its test stopped it: exit ${exitText(exitCode)}, signal ${String(signalCode)}`,
      `A new connection: ${probe ?? "not tried, the service had ended"}`,
      `service.json against the start: pid ${same("pid")}, instance ${same("instance")}, endpoint ${endpoint}`,
      `--- its stderr ---\n${service.stderr()}`,
      ...files,
      "",
    ].join("\n"),
  );
}

/**
 * Runs `tasks <argv>` in this process with a recorded Io. `tty` makes the connection a person's
 * (`cli-interactive`), as a terminal would: the class is decided by the service from it. `true`
 * is a terminal on every stream; an object names each stream, as a pipe or a redirect leaves them.
 */
export async function runMain(
  argv: readonly string[],
  options: {
    home: string;
    cwd?: string;
    tty?: boolean | { stdin: boolean; stdout: boolean; stderr: boolean };
    env?: Record<string, string>;
    stdin?: string;
    main?: MainOptions;
    /** Records what Ctrl+C would print, each time the command changes it. */
    interrupts?: (string | undefined)[];
  },
): Promise<Ran> {
  let stdout = "";
  let stderr = "";
  const io: Io = {
    argv,
    env: cliEnv(options.home, options.env),
    cwd: options.cwd ?? options.home,
    platform: process.platform,
    tty:
      typeof options.tty === "object"
        ? options.tty
        : {
            stdin: options.tty === true,
            stdout: options.tty === true,
            stderr: options.tty === true,
          },
    pid: process.pid,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    readStdin: () => Promise.resolve(options.stdin ?? ""),
    readFile: (path) => readFile(path, "utf8"),
    ...(options.interrupts === undefined
      ? {}
      : {
          onInterrupt: (note: string | undefined) => {
            options.interrupts?.push(note);
          },
        }),
  };
  const code = await main(io, options.main);
  return { code, stdout, stderr };
}

/**
 * The text (latin1) of every file under `dir` that holds content, by path: no folder, socket or
 * pipe. A running service replaces its files through a temp file and a rename, so a file listed
 * can be gone before it is read: then the folder changed, and it is read again from the start.
 */
export function fileTexts(dir: string): Map<string, string> {
  const read = (at: string, into: Map<string, string>): Map<string, string> => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      const facts = statSync(path);
      if (facts.isDirectory()) read(path, into);
      else if (facts.isFile()) into.set(path, readFileSync(path).toString("latin1"));
    }
    return into;
  };
  for (let attempt = 1; ; attempt += 1) {
    try {
      return read(dir, new Map());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || attempt >= 20) throw error;
    }
  }
}
