// `ttasks open [<space>] [--task <ref>] [--tab] [--print-url]` (A2 3.9, 3.8.4), and
// `ttasks service port <n> [--reuse [--yes]]` (A2 3.8.2 step 5).
//
// `ttasks open`:
//   0. names its space as every command does (namedSpace: the argument, --space, TTASKS_SPACE),
//      and settles it to one space's ID by the service's rule before anything opens;
//   1. connects over the socket and asks for a one-time code (`ui/mint_code`). An agent's shell
//      (`cli-agent`) may not: "Ask the user to open TTasks". When another user holds or held the
//      UI's port, the service refuses with A2's message and no code exists;
//   2. proves the listener before trusting its port: `POST /api/v1/auth/probe` must answer the
//      HMAC of ipc.key over this instance, the port and a fresh nonce. A process squatting on the
//      port cannot, and never sees the code;
//   3. opens `http://127.0.0.1:<port>/#k=<code>&to=<path>`: the code is in the fragment, which the
//      browser never sends, and the page removes it at once. `--print-url` prints the link
//      instead, with a warning that it holds a one-time sign-in code.
//
// A service that is not running is started first (A2 3.3.6, 3.9 step 1), the same way `tasks
// service start` starts it (`startService` of @ttasks/service/install: through the OS, and only a
// ready service counts), with one line on stderr that says so, and a second when Linux started it
// by hand because its unit is not installed (A2 3.3.3). Only `not_running` starts it: a
// service that is starting, stopping, unreachable or untrusted is reported as every command
// reports it. An agent's shell never starts it: it is told to ask the user, as when the service
// runs (A2 S6, 3.6.5). A start that fails says why and names the command to look further.
//
// The browser is opened with the OS's own opener (A2 3.9: rundll32's FileProtocolHandler,
// explorer.exe in a packaged context, `gio open` then `xdg-open`, `open`); A4's opener module
// takes this over when it exists.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, win32 } from "node:path";
import { CLI_NAME, PRODUCT_NAME } from "@ttasks/brand";
import { isAgentMarker, parseKey, rpcContextEnv } from "@ttasks/bridge/protocol";
import type { ErrorBody } from "@ttasks/contracts";
import { ambiguousError, findSpace, isAmbiguity } from "@ttasks/service/copies";
import { IPC_KEY } from "@ttasks/service/paths";
import { movedMessage, PROBE_PATH, verifyProbe } from "@ttasks/service/http/shared";
import type { Globals } from "./args.ts";
import { connectService, stateDir, type ConnectOptions, type Session } from "./connect.ts";
import type { Io } from "./io.ts";
import { listenerRequest } from "./listener-request.ts";
import { bodyOf, printError, printUsage } from "./output.ts";
import { refusedArgument, serviceUsage } from "./service.ts";
import { namedSpace, type SpaceRow } from "./space.ts";
import { asAppError } from "./verbs.ts";

/** Opens a URL in the user's browser; false when no opener could. */
export type OpenUrl = (url: string, io: Io) => Promise<boolean>;

/** A start of the service that did not end with a ready service: a person's words and a command. */
export class StartFailed extends Error {
  override readonly name = "StartFailed";
  readonly hint: string | undefined;
  constructor(message: string, hint: string | undefined) {
    super(message);
    this.hint = hint;
  }
}

/**
 * Starts this install's service as `ttasks service start` does, and resolves once it is ready:
 * `started`, `started_by_hand` when it was started without the Linux unit a user manager could
 * start it through (A2 3.3.3), or `already_running` when another start got there first. Throws
 * StartFailed.
 */
export type StartService = (io: Io) => Promise<"started" | "started_by_hand" | "already_running">;

/** `ttasks service start`'s own start, loaded only when the service is not running. */
const startAsServiceStart: StartService = async (io) => {
  const install = await import("@ttasks/service/install");
  try {
    const outcome = await install.startService(install.defaultServiceContext({ env: io.env }));
    if (outcome.outcome !== "started") return "already_running";
    return outcome.unit === "not_installed" ? "started_by_hand" : "started";
  } catch (error) {
    // Its messages are for a person: fixed text and the install's own entries, never task data.
    if (error instanceof install.ServiceCommandError)
      throw new StartFailed(error.message, error.hint);
    throw new StartFailed(
      `${CLI_NAME} service start failed unexpectedly.`,
      `${CLI_NAME} service status`,
    );
  }
};

/** An agent's shell (A2 3.6.5's `cli-agent`): a marker the service would read in the bind. */
const agentShell = (io: Io): boolean => Object.keys(rpcContextEnv(io.env)).some(isAgentMarker);

const askTheUser = () => ({
  code: "forbidden" as const,
  message: `Ask the user to open ${PRODUCT_NAME}.`,
  data: { reason: "connection_class" },
});

export interface OpenOptions extends ConnectOptions {
  /** Tests record the URL instead of opening a browser. */
  readonly openUrl?: OpenUrl;
  /** Tests start their own service. The default is `ttasks service start`'s (startAsServiceStart). */
  readonly startService?: StartService;
  /**
   * Asks the person a yes-or-no question (`ttasks service port --reuse`). The default asks in the
   * terminal when stdin and stdout are one; tests answer it.
   */
  readonly ask?: (question: string) => Promise<boolean>;
}

/** A yes-or-no question on the process's own terminal. */
async function terminalAsk(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^(y|yes)$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

/** The probe's deadline for the whole exchange, and the most it reads back. */
const PROBE_MS = 5_000;
const PROBE_MAX_BYTES = 4096;

/**
 * Whether the listener on `port` is this service's: the HMAC probe of A2 3.8.4 step 2, within one
 * deadline for the whole exchange (`deadlineMs`, 5 s), whatever answers on the port.
 */
export async function probeListener(
  port: number,
  key: Uint8Array,
  instance: string,
  deadlineMs = PROBE_MS,
): Promise<boolean> {
  const nonce = randomBytes(24).toString("base64url");
  const body = JSON.stringify({ nonce });
  const answer = await listenerRequest(port, {
    method: "POST",
    path: PROBE_PATH,
    headers: {
      Host: `127.0.0.1:${String(port)}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
    body,
    deadlineMs,
    maxBytes: PROBE_MAX_BYTES,
  });
  if (answer?.status !== 200) return false;
  try {
    const reply = JSON.parse(answer.body) as { proof?: unknown };
    return verifyProbe(key, instance, port, nonce, reply.proof);
  } catch {
    return false;
  }
}

/** Runs `file args` detached and resolves with whether it started and, within 10 s, did not fail. */
function launch(file: string, args: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        detached: true,
        stdio: "ignore",
        shell: false,
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      child.unref();
      resolve(true);
    }, 10_000);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      // rundll32 and explorer.exe report no useful code; gio, xdg-open and open do.
      resolve(code === 0 || file.toLowerCase().endsWith(".exe"));
    });
  });
}

/** The OS's opener (A2 3.9 step 3), tried in order. */
export const openInBrowser: OpenUrl = async (url, io) => {
  const candidates: [string, string[]][] = [];
  if (io.platform === "win32") {
    const system = io.env["SystemRoot"] ?? "C:\\Windows";
    const packaged = (io.env["TTASKS_PACKAGE"] ?? "") !== "";
    candidates.push(
      packaged
        ? [win32.join(system, "explorer.exe"), [url]]
        : [win32.join(system, "System32", "rundll32.exe"), ["url.dll,FileProtocolHandler", url]],
    );
  } else if (io.platform === "darwin") {
    candidates.push(["/usr/bin/open", [url]]);
  } else {
    candidates.push(["gio", ["open", url]], ["xdg-open", [url]]);
  }
  for (const [file, args] of candidates) if (await launch(file, args)) return true;
  return false;
};

/**
 * The page's route for the tab (A5 3.3): `/s/<space ID>`, and `/task/<ref>` below it for a task; a
 * task without a space is `/task/<ref>`, which the page opens in the machine's default space.
 */
function routeOf(id: string | undefined, task: string | undefined): string | undefined {
  if (id === undefined) return task === undefined ? undefined : `/task/${task}`;
  return task === undefined ? `/s/${id}` : `/s/${id}/task/${task}`;
}

/**
 * The ID of the one space `named` means, by the service's own rule (findSpace), among the spaces
 * it does not hold closed; else the error that says there is none or several, with the spaces to
 * choose from.
 */
async function resolveSpace(
  session: Session,
  named: string,
): Promise<{ readonly id: string } | { readonly error: ErrorBody }> {
  const listed = (await session.call("space/list", {}, { timeoutMs: 10_000 })) as {
    spaces: SpaceRow[];
  };
  const live = listed.spaces
    .filter((row) => row.state !== "closed")
    .map((row) => ({ ...row, id: row.id ?? row.registered }));
  const found = findSpace(live, named);
  const choices = (rows: readonly (typeof live)[number][]) => ({
    spaces: rows.flatMap((row) =>
      row.id === undefined
        ? []
        : [
            {
              id: row.id,
              ...(row.name === undefined ? {} : { name: row.name }),
              ...(row.folder === undefined ? {} : { folder: row.folder }),
            },
          ],
    ),
  });
  if (isAmbiguity(found)) {
    return {
      error: {
        ...ambiguousError(`Name it by its ID or its folder: ${CLI_NAME} open <space>.`).toBody(),
        data: choices(found.candidates),
      },
    };
  }
  if (found?.id !== undefined) return { id: found.id };
  return {
    error: {
      code: "not_found",
      message: isAbsolute(named)
        ? "The service has no space in that folder."
        : "The service has no space by that ID or name.",
      hint: `${CLI_NAME} space list also shows the closed ones.`,
      data: choices(live),
    },
  };
}

/** An error, and in text the spaces it offers, one a line: name, ID and folder. */
function printChoices(io: Io, json: boolean, body: ErrorBody): number {
  const code = printError(io, json, body);
  const spaces = body.data?.["spaces"];
  if (!json && Array.isArray(spaces)) {
    for (const s of spaces as { id: string; name?: string; folder?: string }[]) {
      io.stderr(`  ${[s.name ?? "(unnamed)", s.id, s.folder].filter(Boolean).join("  ")}\n`);
    }
  }
  return code;
}

interface Minted {
  readonly code: string;
  readonly port: number;
  readonly persisted: number | null;
  readonly moved: boolean;
}

function mintedOf(value: unknown): Minted | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const { code, port, persisted, moved } = v;
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(code)) return undefined;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return;
  return {
    code,
    port,
    persisted: typeof persisted === "number" ? persisted : null,
    moved: moved === true,
  };
}

/** `ttasks open`. */
export async function openCommand(
  io: Io,
  globals: Globals,
  args: readonly string[],
  options: OpenOptions,
): Promise<number> {
  let task: string | undefined;
  let given: string | undefined;
  let printUrl = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--print-url") printUrl = true;
    else if (arg === "--tab") continue;
    else if (arg === "--task") {
      task = args[i + 1];
      i += 1;
      if (task === undefined || !/^[A-Za-z0-9_-]{1,64}$/.test(task)) {
        return printUsage(io, globals.json, "ttasks open --task takes a task reference");
      }
    } else if (!arg.startsWith("-") && given === undefined) {
      given = arg;
    } else {
      return printUsage(
        io,
        globals.json,
        "ttasks open takes one <space>, --space, --task, --tab and --print-url",
      );
    }
  }
  const named = namedSpace(io, globals, given);
  let session: Session;
  try {
    session = await connectService(io, options);
  } catch (error) {
    const body = bodyOf(asAppError(error));
    if (body.code !== "service_unavailable" || body.data?.["reason"] !== "not_running") {
      return printError(io, globals.json, body);
    }
    // Not running: started as `ttasks service start` starts it, never from an agent's shell.
    if (agentShell(io)) return printError(io, globals.json, askTheUser());
    try {
      const outcome = await (options.startService ?? startAsServiceStart)(io);
      if (outcome !== "already_running") io.stderr(`Started ${PRODUCT_NAME}'s service.\n`);
      if (outcome === "started_by_hand") {
        io.stderr(`${(await import("@ttasks/service/install")).NO_UNIT_LINE}\n`);
      }
    } catch (failure) {
      const why = failure instanceof StartFailed ? failure : undefined;
      return printError(io, globals.json, {
        code: "service_unavailable",
        message: `${PRODUCT_NAME}'s service is not running, and it could not be started: ${why?.message ?? "the start failed."}`,
        hint: `Run: ${why?.hint ?? `${CLI_NAME} service status`}`,
        data: { reason: "not_running", retryable: false },
      });
    }
    try {
      session = await connectService(io, options);
    } catch (again) {
      return printError(io, globals.json, bodyOf(asAppError(again)));
    }
  }
  try {
    // The space is settled before a code exists: a name that means no space or two opens nothing,
    // since the page would land on its default and the next edit would go to the wrong list.
    let space: string | undefined;
    if (named !== undefined) {
      try {
        const resolved = await resolveSpace(session, named);
        if ("error" in resolved) return printChoices(io, globals.json, resolved.error);
        space = resolved.id;
      } catch (error) {
        return printError(io, globals.json, bodyOf(asAppError(error)));
      }
    }
    let minted: Minted | undefined;
    try {
      minted = mintedOf(await session.call("ui/mint_code", {}, { timeoutMs: 10_000 }));
    } catch (error) {
      const body = bodyOf(asAppError(error));
      if (body.code === "forbidden") return printError(io, globals.json, askTheUser());
      return printError(io, globals.json, body);
    }
    if (minted === undefined) {
      return printError(io, globals.json, {
        code: "internal",
        message: "The service answered ui/mint_code with something else.",
      });
    }
    let key: Uint8Array;
    try {
      key = parseKey(readFileSync(join(stateDir(io), IPC_KEY), "utf8"));
    } catch {
      return printError(io, globals.json, {
        code: "service_unavailable",
        message: `${PRODUCT_NAME}'s key cannot be read.`,
        hint: "Run: ttasks doctor",
        data: { reason: "unreachable", retryable: false },
      });
    }
    if (!(await probeListener(minted.port, key, session.bound.service.instance))) {
      return printError(io, globals.json, {
        code: "service_unavailable",
        message: `Something other than ${PRODUCT_NAME}'s service answers on port ${String(minted.port)}. No sign-in code was sent to it.`,
        hint: "Run: ttasks doctor",
        data: { reason: "untrusted_endpoint", retryable: false },
      });
    }
    const to = routeOf(space, task);
    const url =
      `http://127.0.0.1:${String(minted.port)}/#k=${minted.code}` +
      (to === undefined ? "" : `&to=${encodeURIComponent(to)}`);
    if (minted.moved && minted.persisted !== null) {
      io.stderr(`${movedMessage(minted.persisted, minted.port)}\n`);
    }
    if (printUrl) {
      io.stderr("This link holds a one-time sign-in code: it works once, within 60 seconds.\n");
      io.stdout(globals.json ? `${JSON.stringify({ url, port: minted.port })}\n` : `${url}\n`);
      return 0;
    }
    const opened = await (options.openUrl ?? openInBrowser)(url, io);
    if (!opened) {
      return printError(io, globals.json, {
        code: "service_unavailable",
        message: "No browser could be opened from here.",
        hint: `Run: ${CLI_NAME} open --print-url, and open the link yourself.`,
        data: { reason: "no_opener", retryable: false },
      });
    }
    io.stdout(
      globals.json
        ? `${JSON.stringify({ opened: true, port: minted.port, moved: minted.moved })}\n`
        : `Opened ${PRODUCT_NAME} in the browser.\n`,
    );
    return 0;
  } finally {
    session.close();
  }
}

/**
 * `ttasks service port <n> [--reuse [--yes]]`: a new persisted port, the sightings cleared, a
 * restart. `--reuse` (the blocked port again) asks the person to confirm that every tab and app
 * window is closed (A2 3.8.2 step 5); `--yes` confirms without asking, where no terminal can ask.
 */
export async function servicePortCommand(
  io: Io,
  globals: Globals,
  args: readonly string[],
  options: OpenOptions,
): Promise<number> {
  const [value, ...rest] = args;
  const reuse = rest.includes("--reuse");
  const yes = rest.includes("--yes") || rest.includes("-y");
  const stray = rest.find((a) => a !== "--reuse" && a !== "--yes" && a !== "-y");
  if (stray !== undefined) return serviceUsage(io, globals.json, refusedArgument("port", stray));
  if (value === undefined || !/^\d{1,5}$/.test(value) || (yes && !reuse)) {
    return serviceUsage(
      io,
      globals.json,
      "ttasks service port takes a port number, and --reuse with --yes to confirm without asking",
    );
  }
  const port = Number(value);
  if (reuse && !yes) {
    // Like `ttasks service install`: no question with --json, or where no terminal can answer it.
    const ask = globals.json
      ? undefined
      : (options.ask ?? (io.tty.stdin && io.tty.stdout ? terminalAsk : undefined));
    if (ask === undefined) {
      return serviceUsage(
        io,
        globals.json,
        "ttasks service port --reuse asks for a yes in a terminal; add --yes once every tab and app window is closed",
      );
    }
    const closed = await ask(
      `Choosing port ${String(port)} again is safe only once every ${PRODUCT_NAME} tab and app window is closed. Are they all closed? [y/N] `,
    );
    if (!closed) {
      io.stderr("Nothing changed.\n");
      return 0;
    }
  }
  let session: Session;
  try {
    session = await connectService(io, options);
  } catch (error) {
    return printError(io, globals.json, bodyOf(asAppError(error)));
  }
  try {
    const result = await session.call("service/port", { port, reuse }, { timeoutMs: 30_000 });
    io.stdout(
      globals.json
        ? `${JSON.stringify(result)}\n`
        : `${PRODUCT_NAME}'s UI port is now ${String(port)}. The service restarts.\n`,
    );
    return 0;
  } catch (error) {
    const body = bodyOf(asAppError(error));
    return printError(io, globals.json, body);
  } finally {
    session.close();
  }
}
