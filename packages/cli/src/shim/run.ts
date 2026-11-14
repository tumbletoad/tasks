// `tasks shim <ticket>` (A4 3.6.3): the launch shim. A terminal runs it and nothing else; it claims
// its launch once with the ticket, verifies what the claim's reply says, starts the agent as its
// child, reports the agent's start, settle and exit, and stays attached across service restarts.
//
// Steps (A4 3.6.3's numbering):
// 1. Start. The ticket's pattern is checked; the process title becomes `tasks shim`, which on Linux
//    overwrites the argv area, so from here the ticket no longer shows in /proc/<pid>/cmdline.
//    Until the claim, a hang-up ends the shim without claiming.
// 2. Connect, retrying for 30 s while the service is down or starting.
// 3. Claim: `launch.claim {ticket, role, pid, start_time}`. The ticket is not used again.
// 4. Verify the protocol, then the folder before anything else is done there: the service started
//    the shim's terminal in the folder it resolved right before the launch, and the reply's check
//    (A4 3.3) must find that very directory as the shim's own working directory
//    (`checkWorkingFolder`, through `.`), then the executable. A failure is reported as
//    `launch.failed`, with the folder check's reason, and nothing starts.
// 5. Announce: the terminal's title and one line.
// 6. Spawn the agent (agent.ts, the seam M2.09 replaces) and report `launch.started`. The agent
//    gets no working-directory option, so it inherits the checked directory, and the shim never
//    changes its own working directory.
// 7. Settle: after 3 s, if the agent still runs, `launch.settled`.
// 9. Exit report: `launch.exited`, or `exit.json` when the service cannot be reached.
// 10. After exit: `close`, `close-on-success`, `pause`. `shell` waits like `pause` until M2.09.
// 11. Exit with the agent's exit code (128 + the signal's number for a signal).
//
// Nothing of the ticket, the credential, the environment or the argv is printed or logged: the
// shim prints fixed sentences, the title (the person's own task, on their own terminal) and codes.
import { statSync } from "node:fs";
import { constants } from "node:os";
import { isAbsolute, posix, win32 } from "node:path";
import { isatty } from "node:tty";
import { CLI_NAME, ENV_PREFIX, PRODUCT_NAME } from "@tasks/brand";
import {
  checkWorkingFolder,
  type FolderCheck,
  type ResolveReason,
  type WorkingFolderCheck,
} from "@tasks/launch/places";
import { ownStartTime, powershellPath } from "@tasks/launch/process";
import {
  AFTER_EXIT_MODES,
  checkFolderCheck,
  CONNECT_RETRY_MS,
  CREDENTIAL,
  AGENT_ENV_NAME,
  hasExactly,
  isBoundedText,
  isPlainObject,
  LAUNCH_ID_FORM,
  LAUNCH_REF_FORM,
  REATTACH_MS,
  REPLY_BOUNDS,
  SETTLE_MS,
  SHIM_METHODS,
  SHIM_PROTOCOL,
  TERMINAL_ENV,
  TICKET,
  type ClaimReply,
  type ExitFile,
} from "@tasks/launch/shim-wire";
import type { RpcSession } from "@tasks/bridge/protocol";
import { startAgent as startDirect, type AgentExit, type StartAgent } from "./agent.ts";
import { writeExitFile } from "./exit-file.ts";
import {
  CALL_MS,
  connectOnce,
  isRefusal,
  isRetryable,
  Link,
  passing,
  reasonOf,
  type Place,
} from "./link.ts";

/** How long the shim waits for its exit report to be taken before it writes exit.json. */
export const FINISH_MS = 10_000;
/** A4 3.6.3 step 8: after a hang-up the agent gets this long before the shim exits. */
export const HANGUP_GRACE_MS = 2_000;

/** The usage error (exit 2) never repeats the arguments. */
export const EXIT_USAGE = 2;
export const EXIT_FAILED = 1;

/** The fixed lines the shim prints. */
export const TEXT = {
  usage: `${CLI_NAME} shim: usage: ${CLI_NAME} shim <ticket>`,
  notRunning: `The ${PRODUCT_NAME} service is not running. Start it, then press Open again.`,
  untrusted: `Something other than ${PRODUCT_NAME} is listening at its endpoint. This launch did not start.`,
  expired: `This launch expired. Press Open again in ${PRODUCT_NAME}.`,
  lost: `The connection to ${PRODUCT_NAME} was lost before this launch started. Press Open again in ${PRODUCT_NAME}.`,
  ownTime: `${PRODUCT_NAME} could not read this process's start time. This launch did not start.`,
  verify: {
    protocol: `This ${CLI_NAME} is not the version the service expects. This launch did not start.`,
    reply: `${PRODUCT_NAME}'s answer for this launch could not be read. This launch did not start.`,
    executable: "The agent's program is not where it should be. This launch did not start.",
  },
  /** The folder check's reason is a fixed word of places.ts, never a path. */
  folder: (reason: ResolveReason): string =>
    `This window is not in the task's folder as it was checked (${reason}). This launch did not start.`,
  spawn: "The agent's program could not be started.",
  enter: "Press Enter to close.",
} as const;

/** What the shim does to its process and terminal: injected in tests. */
export interface ShimIo extends Place {
  /** One line for the person, on stderr. */
  say(line: string): void;
  /** Text on stdout: the terminal title and the announce line. */
  write(text: string): void;
  /** Resolves on Enter or the end of stdin. Never called while the agent runs. */
  waitEnter(): Promise<void>;
  /** Sets the process title (A4 3.6.3 step 1). */
  setTitle(title: string): void;
  /**
   * Makes `folder` this process's working directory (step 4, before the folder check). Throws
   * what the OS said when it cannot.
   */
  enter(folder: string): void;
  /** Handles a signal. Returns the removal. */
  on(signal: NodeJS.Signals, handler: () => void): () => void;
  /** Ends the process at once (a hang-up's grace has passed). */
  exit(code: number): void;
}

export interface ShimOptions {
  readonly io?: ShimIo;
  readonly startAgent?: StartAgent;
  /** The in-folder check (places.ts checkWorkingFolder), on this process's working directory. */
  readonly checkFolder?: (check: FolderCheck) => Promise<WorkingFolderCheck>;
  readonly startTime?: () => Promise<string>;
  readonly connect?: (place: Place) => Promise<RpcSession>;
  readonly timing?: Partial<{
    connectRetryMs: number;
    retryEveryMs: number;
    reattachMs: number;
    settleMs: number;
    finishMs: number;
  }>;
}

function processIo(): ShimIo {
  return {
    env: process.env,
    platform: process.platform,
    pid: process.pid,
    tty: { stdin: isatty(0), stdout: isatty(1) },
    say: (line) => {
      try {
        process.stderr.write(`${line}\n`);
      } catch {
        // Nothing else to tell.
      }
    },
    write: (text) => {
      try {
        process.stdout.write(text);
      } catch {
        // The terminal is gone.
      }
    },
    waitEnter: () =>
      new Promise<void>((resolve) => {
        const stdin = process.stdin;
        const done = (): void => {
          stdin.pause();
          resolve();
        };
        stdin.once("data", done);
        stdin.once("end", done);
        stdin.once("error", done);
        stdin.resume();
      }),
    setTitle: (title) => {
      process.title = title;
    },
    enter: (folder) => {
      process.chdir(folder);
    },
    on: (signal, handler) => {
      process.on(signal, handler);
      return () => process.off(signal, handler);
    },
    exit: (code) => process.exit(code),
  };
}

/** The title and the announce line hold no control characters (A4 3.6.3 step 5, sanitised). */
export const printable = (text: string): string =>
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  text.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, "").slice(0, 200);

/** What step 4 found wrong: the protocol, the executable, or the folder with its check's reason. */
export type VerifyProblem =
  | { readonly what: keyof typeof TEXT.verify }
  | { readonly what: "folder"; readonly reason: ResolveReason };

/**
 * A4 3.6.3 step 4. Undefined when everything holds, else what failed. The protocol first (the
 * reply's shape is that version's), then the folder, before anything else touches it: the shim
 * enters the folder's real path itself (no terminal decides where it starts), and the check reads
 * the directory it is then in through `.` (places.ts checkWorkingFolder), never the path. Then the
 * executable, which starts directly: nothing runs between this check and the agent.
 */
export async function verifyReply(
  reply: ClaimReply,
  checkFolder: (check: FolderCheck) => Promise<WorkingFolderCheck> = (check) =>
    checkWorkingFolder(check),
  enter: (folder: string) => void = (folder) => {
    process.chdir(folder);
  },
): Promise<VerifyProblem | undefined> {
  if (reply.protocol !== SHIM_PROTOCOL) return { what: "protocol" };
  try {
    enter(reply.folder);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    const reason: ResolveReason =
      code === "ENOENT"
        ? "path_missing"
        : code === "ENOTDIR"
          ? "not_a_directory"
          : "folder_changed";
    return { what: "folder", reason };
  }
  let folder: WorkingFolderCheck;
  try {
    folder = await checkFolder(reply.check);
  } catch {
    folder = { status: "failed", reason: "folder_changed" };
  }
  if (folder.status === "failed") return { what: "folder", reason: folder.reason };
  const exe = reply.argv[0];
  if (exe === undefined || !isAbsolute(exe) || /\.(cmd|bat)$/i.test(exe)) {
    return { what: "executable" };
  }
  try {
    if (!statSync(exe).isFile()) return { what: "executable" };
  } catch {
    return { what: "executable" };
  }
  return undefined;
}

/** The claim's reply as the shim read it: one it follows, or why not with what can still report. */
export type ReplyRead =
  | { readonly ok: true; readonly reply: ClaimReply }
  | {
      readonly ok: false;
      /** `protocol`: another version's reply; `reply`: not exactly a reply of this one. */
      readonly problem: "protocol" | "reply";
      /** The parts of the envelope that are valid each on its own, for the failure's report. */
      readonly credential?: string;
      readonly launch?: string;
      readonly exitFile?: string;
    };

const REPLY_FIELDS = [
  "protocol",
  "launch",
  "argv",
  "folder",
  "check",
  "env",
  "title",
  "after_exit",
  "credential",
  "exit_file",
] as const;

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null && Object.hasOwn(value, name)
    ? (value as Record<string, unknown>)[name]
    : undefined;

/** Where the service asks for `exit.json`: an absolute path of this OS that ends in it. */
function isExitFile(value: unknown, platform: NodeJS.Platform): value is string {
  if (!isBoundedText(value, REPLY_BOUNDS.path)) return false;
  const P = platform === "win32" ? win32 : posix;
  return P.isAbsolute(value) && P.basename(value) === "exit.json";
}

/** An absolute path of this OS. */
const isAbsoluteOn = (value: string, platform: NodeJS.Platform): boolean =>
  (platform === "win32" ? win32 : posix).isAbsolute(value);

/**
 * The claim's reply, read strictly (A4 3.6.3 step 4's first part): exactly the fields of this
 * protocol's reply, each of its type and within its bound (wire.ts REPLY_BOUNDS, which the service
 * keeps too). Anything else is a reply this shim cannot follow, which it reports like a failed
 * verification, so the claim it made is never left without an answer. The parts of the envelope a
 * report needs (the credential to attach again, the launch and the exit file for `exit.json`) are
 * read each on its own, so a reply broken elsewhere is still reported as fully as it can be.
 */
export function readReply(value: unknown, platform: NodeJS.Platform): ReplyRead {
  const credential = field(value, "credential");
  const launch = field(value, "launch");
  const id = field(launch, "id");
  const exitFile = field(value, "exit_file");
  const fail = (problem: "protocol" | "reply"): ReplyRead => ({
    ok: false,
    problem,
    ...(typeof credential === "string" && CREDENTIAL.test(credential) ? { credential } : {}),
    ...(typeof id === "string" && LAUNCH_ID_FORM.test(id) ? { launch: id } : {}),
    ...(isExitFile(exitFile, platform) ? { exitFile } : {}),
  });
  // Another version's reply may have other fields: the version is read first.
  const protocol = field(value, "protocol");
  if (
    typeof protocol === "number" &&
    Number.isSafeInteger(protocol) &&
    protocol !== SHIM_PROTOCOL
  ) {
    return fail("protocol");
  }
  if (!hasExactly(value, REPLY_FIELDS)) return fail("reply");
  if (protocol !== SHIM_PROTOCOL) return fail("reply");
  if (!hasExactly(launch, ["id", "reference"])) return fail("reply");
  const reference = launch["reference"];
  if (typeof id !== "string" || !LAUNCH_ID_FORM.test(id)) return fail("reply");
  if (typeof reference !== "string" || !LAUNCH_REF_FORM.test(reference)) return fail("reply");
  const argv = value["argv"];
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > REPLY_BOUNDS.argv) {
    return fail("reply");
  }
  if (!argv.every((a): a is string => isBoundedText(a, REPLY_BOUNDS.arg))) return fail("reply");
  // The folder the shim enters itself (M2.09): an absolute path of this OS.
  const folder = value["folder"];
  if (!isBoundedText(folder, REPLY_BOUNDS.path) || !isAbsoluteOn(folder, platform)) {
    return fail("reply");
  }
  const check = checkFolderCheck(value["check"]);
  if (check === undefined) return fail("reply");
  const env = value["env"];
  if (!isPlainObject(env) || Object.keys(env).length > REPLY_BOUNDS.env) return fail("reply");
  const vars = Object.entries(env);
  if (!vars.every(([n, v]) => AGENT_ENV_NAME.test(n) && isBoundedText(v, REPLY_BOUNDS.value))) {
    return fail("reply");
  }
  const title = value["title"];
  if (!isBoundedText(title, REPLY_BOUNDS.title)) return fail("reply");
  const afterExit = value["after_exit"];
  if (!(AFTER_EXIT_MODES as readonly unknown[]).includes(afterExit)) return fail("reply");
  if (typeof credential !== "string" || !CREDENTIAL.test(credential)) return fail("reply");
  if (!isExitFile(exitFile, platform)) return fail("reply");
  return {
    ok: true,
    reply: {
      protocol: SHIM_PROTOCOL,
      launch: { id, reference },
      argv,
      folder,
      check,
      env: Object.fromEntries(vars as [string, string][]),
      title,
      after_exit: afterExit as ClaimReply["after_exit"],
      credential,
      exit_file: exitFile,
    },
  };
}

/**
 * The environment the agent gets: the service's, plus the terminal's own variables the service's
 * does not name (wire.ts TERMINAL_ENV), never the rest of the shim's.
 */
export function withTerminal(
  env: Readonly<Record<string, string>>,
  own: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): Record<string, string> {
  const fold = (name: string): string => (platform === "win32" ? name.toUpperCase() : name);
  const named = new Set(Object.keys(env).map(fold));
  const out: Record<string, string> = { ...env };
  for (const name of TERMINAL_ENV) {
    const found = Object.entries(own).find(([n]) => fold(n) === fold(name));
    const value = found?.[1];
    if (value !== undefined && value !== "" && !named.has(fold(name))) out[name] = value;
  }
  return out;
}

/** The shim's exit code for the agent's end. */
export function exitCodeOf(exit: AgentExit): number {
  if (exit.code !== null) return exit.code;
  const number = exit.signal === null ? undefined : constants.signals[exit.signal];
  return number === undefined ? EXIT_FAILED : 128 + number;
}

/** Runs the shim with the arguments after `shim` and resolves with its exit code. */
export async function runShim(argv: readonly string[], options: ShimOptions = {}): Promise<number> {
  const io = options.io ?? processIo();
  const timing = {
    connectRetryMs: CONNECT_RETRY_MS,
    retryEveryMs: 1_000,
    reattachMs: REATTACH_MS,
    settleMs: SETTLE_MS,
    finishMs: FINISH_MS,
    ...options.timing,
  };
  const connect = (): Promise<RpcSession> => (options.connect ?? connectOnce)(io);

  // 1. Start.
  const ticket = argv.length === 1 ? argv[0] : undefined;
  if (ticket === undefined || !TICKET.test(ticket)) {
    io.say(TEXT.usage);
    return EXIT_USAGE;
  }
  io.setTitle(`${CLI_NAME} shim`);
  const removers: (() => void)[] = [];
  const cleanup = (): void => {
    for (const remove of removers.splice(0)) remove();
  };
  // Ctrl+C belongs to the agent (A4 3.6.3 step 8): the shim ignores it, and SIGQUIT on Unix.
  removers.push(io.on("SIGINT", () => undefined));
  if (io.platform !== "win32") removers.push(io.on("SIGQUIT", () => undefined));
  // Until the agent runs, a hang-up (window closed) ends the shim at once, so before the claim it
  // never claims. Once the agent runs, the agent gets the hang-up itself, and 2 s to end.
  const state: {
    hungUp: boolean;
    agent: { kill(signal: NodeJS.Signals): void } | undefined;
  } = { hungUp: false, agent: undefined };
  removers.push(
    io.on("SIGHUP", () => {
      state.hungUp = true;
      if (state.agent === undefined) {
        io.exit(129);
        return;
      }
      setTimeout(() => {
        io.exit(129);
      }, HANGUP_GRACE_MS).unref();
    }),
  );
  removers.push(
    io.on("SIGTERM", () => {
      if (state.agent === undefined) io.exit(143);
      else state.agent.kill("SIGTERM");
    }),
  );
  try {
    const ownTime = (options.startTime ?? ownStartTime)();
    ownTime.catch(() => undefined);
    const pause = (): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, timing.retryEveryMs));

    // 2 and 3. Connect and claim, for 30 s while the service is down, starting or draining, or
    // could not decide yet: each of those answers leaves the ticket unspent. Any other answer
    // to the claim is final, a lost one included (the claim may have been taken).
    const deadline = performance.now() + timing.connectRetryMs;
    let session: RpcSession;
    let startTime: string | undefined;
    let answered: unknown;
    for (;;) {
      try {
        session = await connect();
      } catch (error) {
        const reason = reasonOf(error);
        if (reason === "untrusted_endpoint") {
          io.say(TEXT.untrusted);
          return await closeAfter(io, EXIT_FAILED);
        }
        if (!passing(reason) || performance.now() >= deadline) {
          io.say(TEXT.notRunning);
          return await closeAfter(io, EXIT_FAILED);
        }
        await pause();
        continue;
      }
      try {
        startTime ??= await ownTime;
      } catch {
        session.close();
        io.say(TEXT.ownTime);
        return await closeAfter(io, EXIT_FAILED);
      }
      if (state.hungUp) {
        session.close();
        return 129;
      }
      try {
        answered = await session.call(
          SHIM_METHODS.claim,
          { ticket, role: "shim", pid: io.pid, start_time: startTime },
          { timeoutMs: CALL_MS },
        );
        break;
      } catch (error) {
        session.close();
        if (isRetryable(error) && performance.now() < deadline) {
          await pause();
          continue;
        }
        // Refused, or still not taken after the 30 s: this launch will not start. Lost on the
        // way: it may have been taken, and the shim cannot tell.
        io.say(isRefusal(error) || isRetryable(error) ? TEXT.expired : TEXT.lost);
        return await closeAfter(io, EXIT_FAILED);
      }
    }
    // The claim was answered: the service took it, and this connection holds its attachment. From
    // here every way out reports the launch's end (A4 3.6.3 step 4), a reply this shim cannot read
    // included: on this connection, again after a reattach when the reply gave a credential, or in
    // exit.json when it named one.
    const read = readReply(answered, io.platform);
    const credential = read.ok ? read.reply.credential : read.credential;
    const link = new Link(session, {
      connect,
      ...(credential === undefined
        ? {}
        : { attach: { credential, pid: io.pid, start_time: startTime } }),
      reattachMs: timing.reattachMs,
    });
    try {
      if (!read.ok) {
        const where = {
          ...(read.launch === undefined ? {} : { launch: read.launch }),
          ...(read.exitFile === undefined ? {} : { exitFile: read.exitFile }),
        };
        return await reportFailure(io, link, where, timing.finishMs, {
          reason: "verify",
          line: TEXT.verify[read.problem],
        });
      }
      return await afterClaim(
        io,
        read.reply,
        link,
        options.startAgent ?? startDirect,
        options.checkFolder,
        timing,
        state,
      );
    } finally {
      link.close();
    }
  } finally {
    cleanup();
  }
}

/** Steps 4 to 11, once the claim's reply is in hand. */
async function afterClaim(
  io: ShimIo,
  reply: ClaimReply,
  link: Link,
  start: StartAgent,
  checkFolder: ((check: FolderCheck) => Promise<WorkingFolderCheck>) | undefined,
  timing: { settleMs: number; finishMs: number },
  state: { hungUp: boolean; agent: { kill(signal: NodeJS.Signals): void } | undefined },
): Promise<number> {
  const where = { launch: reply.launch.id, exitFile: reply.exit_file };
  const failed = (
    reason: "verify" | "spawn",
    line: string,
    folder?: ResolveReason,
  ): Promise<number> =>
    reportFailure(io, link, where, timing.finishMs, {
      reason,
      line,
      ...(folder === undefined ? {} : { folder }),
    });

  // 4. Verify: the protocol, then the folder (entered, then checked) before anything else is done
  // in it.
  const problem = await verifyReply(reply, checkFolder, (folder) => {
    io.enter(folder);
  });
  if (problem !== undefined) {
    return problem.what === "folder"
      ? failed("verify", TEXT.folder(problem.reason), problem.reason)
      : failed("verify", TEXT.verify[problem.what]);
  }

  // 5. Announce.
  const title = printable(reply.title);
  if (io.tty.stdout) io.write(`\u001b]0;${title}\u0007`);
  const line = `${PRODUCT_NAME} · ${title} · ${printable(reply.launch.reference)}`;
  io.write(io.tty.stdout ? `\u001b[2m${line}\u001b[0m\n` : `${line}\n`);

  // 6. Spawn.
  let agent;
  const env = withTerminal(reply.env, io.env, io.platform);
  try {
    agent = await start({ argv: reply.argv, env });
  } catch {
    return failed("spawn", TEXT.spawn);
  }
  // The instant for the record; how long the agent ran is measured on the monotonic clock, so
  // a step of the wall clock never makes an agent that ended at once look settled.
  const startedAt = Date.now();
  const t0 = performance.now();
  state.agent = agent;
  link.send(SHIM_METHODS.started, { pid: agent.pid, started_at: startedAt });

  // 7. Settle.
  let settled = false;
  const settle = setTimeout(() => {
    settled = true;
    link.send(SHIM_METHODS.settled, {});
  }, timing.settleMs);
  const exit = await agent.exited;
  clearTimeout(settle);
  state.agent = undefined;
  const ranMs = Math.max(0, Math.round(performance.now() - t0));

  // 9. Exit report.
  const report = { code: exit.code, signal: exit.signal, ran_ms: ranMs, settled };
  const taken = await link.finish(SHIM_METHODS.exited, report, timing.finishMs);
  if (!taken) writeExit(where, { spawned: true, ...report });
  link.close();

  // 10. After exit. A hung-up terminal has no one to press Enter.
  const code = exitCodeOf(exit);
  if (state.hungUp) return code;
  switch (reply.after_exit) {
    case "close":
      return code;
    case "close-on-success":
      if (code === 0) return code;
      io.say(`The agent exited with code ${String(code)}. ${TEXT.enter}`);
      await io.waitEnter();
      return code;
    case "pause":
      io.say(`The agent exited with code ${String(code)}. ${TEXT.enter}`);
      await io.waitEnter();
      return code;
    case "shell": {
      // The person's own shell in the checked folder (the shim's working directory, inherited),
      // with the product's variables removed (A4 3.6.3 step 10).
      io.say(`The agent exited with code ${String(code)}.`);
      const shell = shellAfterExit(env, io.platform);
      try {
        const child = await start({ argv: shell, env: withoutProduct(env, io.platform) });
        await child.exited;
      } catch {
        io.say(TEXT.enter);
        await io.waitEnter();
      }
      return code;
    }
  }
}

/**
 * The shell `after_exit = "shell"` starts: the person's login shell (`$SHELL -l`, else `/bin/sh -l`)
 * on Linux and macOS; PowerShell 7 (`pwsh -NoLogo`) found on the agent's PATH, else Windows
 * PowerShell, on Windows.
 */
export function shellAfterExit(
  env: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
): string[] {
  if (platform !== "win32") {
    const shell = env["SHELL"];
    return [shell !== undefined && shell.startsWith("/") ? shell : "/bin/sh", "-l"];
  }
  const path = Object.entries(env).find(([name]) => name.toUpperCase() === "PATH")?.[1] ?? "";
  for (const dir of path.split(";")) {
    if (dir === "" || !win32.isAbsolute(dir)) continue;
    const pwsh = win32.join(dir, "pwsh.exe");
    try {
      if (statSync(pwsh).isFile()) return [pwsh, "-NoLogo"];
    } catch {
      // Not here.
    }
  }
  return [powershellPath(env), "-NoLogo"];
}

/** An environment without the product's own variables (A4 3.6.3 step 10). */
export function withoutProduct(
  env: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
): Record<string, string> {
  const prefix = ENV_PREFIX;
  return Object.fromEntries(
    Object.entries(env).filter(([name]) =>
      platform === "win32" ? !name.toUpperCase().startsWith(prefix) : !name.startsWith(prefix),
    ),
  );
}

/** Where a launch's `exit.json` goes, when the claim's reply named it validly. */
interface ExitPlace {
  readonly launch?: string;
  readonly exitFile?: string;
}

/** Writes `exit.json` when there is a place for it. Never throws. */
function writeExit(where: ExitPlace, fields: Omit<ExitFile, "format" | "launch">): void {
  if (where.launch === undefined || where.exitFile === undefined) return;
  try {
    writeExitFile(where.exitFile, { format: 1, launch: where.launch, ...fields });
  } catch {
    // The launch folder is gone: the service's PID check settles the launch.
  }
}

/**
 * A claimed launch that starts no agent (A4 3.6.3 step 4, a spawn error in step 6): reported as
 * `launch.failed`, or written into `exit.json` when the service does not take it within `finishMs`,
 * then one line for the person, then Enter.
 */
async function reportFailure(
  io: ShimIo,
  link: Link,
  where: ExitPlace,
  finishMs: number,
  failure: { reason: "verify" | "spawn"; line: string; folder?: ResolveReason },
): Promise<number> {
  const why = failure.folder === undefined ? {} : { folder: failure.folder };
  const taken = await link.finish(
    SHIM_METHODS.failed,
    { reason: failure.reason, ...why },
    finishMs,
  );
  if (!taken) {
    writeExit(where, {
      spawned: false,
      settled: false,
      code: null,
      signal: null,
      ran_ms: 0,
      failed: failure.reason,
      ...why,
    });
  }
  io.say(failure.line);
  return closeAfter(io, EXIT_FAILED);
}

/** A failure the person must read before the window closes: wait for Enter, then exit. */
async function closeAfter(io: ShimIo, code: number): Promise<number> {
  io.say(TEXT.enter);
  await io.waitEnter();
  return code;
}
