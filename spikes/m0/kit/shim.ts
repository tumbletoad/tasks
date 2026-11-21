// Stand-in for `ttasks shim <ticket>` (A4 3.6.3), at spike level, for rows B07, L01, S01 and S04:
//   node shim.mjs --state <state> <ticket>
// It connects, verifies the service's proof before it sends anything that identifies the launch,
// makes its one spawn claim, verifies the folder and executable, announces the launch, runs the
// agent with inherited stdio and reports started, settled and exited.
// Not in the spike: re-attaching after a service restart, exit.json and the after-exit modes
// other than `close`.
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import {
  RpcClient,
  asObject,
  connectWithRetry,
  option,
  textOf,
  type Connection,
  type JsonObject,
} from "./wire.ts";

const TICKET = /^kt_[A-Za-z0-9_-]{32}$/;
const startTime = Math.round(Date.now() - process.uptime() * 1000);

const say = (line: string) => process.stderr.write(`${line}\n`);

/** Waits for Enter when a person is watching, so the window does not vanish (A4 3.6.3). */
function waitForEnter(): Promise<void> {
  if (!process.stdin.isTTY) return Promise.resolve();
  say("Press Enter to close.");
  return new Promise((resolve) =>
    process.stdin.once("data", () => {
      resolve();
    }),
  );
}

function sanitizeTitle(title: string): string {
  let clean = "";
  for (const c of title) {
    const n = c.codePointAt(0) ?? 0;
    clean += n < 0x20 || (n >= 0x7f && n < 0xa0) ? " " : c;
  }
  return clean.slice(0, 120);
}

async function main(args: string[]): Promise<number> {
  const state = option(args, "--state");
  const ticket = args.at(-1) ?? "";
  if (state === undefined || !TICKET.test(ticket)) {
    say("Usage: shim --state <state> <ticket>");
    return 64;
  }
  process.title = "ttasks shim";
  process.on("SIGINT", () => undefined); // the agent handles Ctrl+C (A4 3.6.3 step 8)
  if (process.platform !== "win32") process.on("SIGQUIT", () => undefined);

  let connection: Connection | undefined;
  try {
    connection = await connectWithRetry(state, "shim", 30_000);
  } catch (error) {
    say(error instanceof Error ? error.message : "The connection failed.");
    await waitForEnter();
    return 69;
  }
  if (connection === undefined) {
    say("The TTasks service is not running. Start it, then press Open again.");
    await waitForEnter();
    return 69;
  }
  const rpc = new RpcClient(connection);

  let claim: JsonObject;
  try {
    claim =
      asObject(
        await rpc.call("launch.claim", {
          ticket,
          role: "shim",
          pid: process.pid,
          start_time: startTime,
        }),
      ) ?? {};
  } catch (error) {
    say(error instanceof Error ? error.message : "The claim failed.");
    rpc.close();
    await waitForEnter();
    return 75;
  }

  const argv = claim["argv"];
  const cwd = claim["cwd"];
  const env = asObject(claim["env"]) ?? {};
  const title = typeof claim["title"] === "string" ? claim["title"] : "Tasks launch";
  const fail = async (reason: string, text: string) => {
    await rpc.call("launch.failed", { reason }).catch(() => undefined);
    rpc.close();
    say(text);
    await waitForEnter();
    return 70;
  };
  if (
    !Array.isArray(argv) ||
    !argv.every((a) => typeof a === "string") ||
    typeof cwd !== "string"
  ) {
    return fail("bad_claim", "The service sent an incomplete launch.");
  }
  if (!existsSync(cwd) || realpathSync.native(cwd) !== cwd) {
    return fail("cwd_mismatch", "The launch folder does not exist or has moved.");
  }
  const [file, ...rest] = argv;
  if (file === undefined || !existsSync(file) || /\.(cmd|bat)$/i.test(file)) {
    return fail("bad_executable", "The agent's executable is missing or is a batch file.");
  }

  if (process.stdout.isTTY) process.stdout.write(`\x1b]0;${sanitizeTitle(title)}\x07`);
  say(process.stderr.isTTY ? `\x1b[2mTasks · ${title}\x1b[0m` : `Tasks · ${title}`);

  const childEnv: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.toUpperCase().startsWith("TTASKS_")) childEnv[name] = value;
  }
  for (const [name, value] of Object.entries(env)) childEnv[name] = textOf(value);

  const started = Date.now();
  const child = spawn(file, rest, { cwd, env: childEnv, stdio: "inherit", shell: false });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
    child.once("error", () => {
      resolve({ code: null, signal: null });
    });
  });
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  if (process.platform !== "win32") {
    process.on("SIGHUP", () => {
      rpc.notify("launch.failed", { reason: "terminal_closed" });
      setTimeout(() => process.exit(129), 2000);
    });
  }
  await rpc
    .call("launch.started", { pid: child.pid ?? null, start_time: started })
    .catch(() => undefined);
  const settle = setTimeout(() => {
    rpc.call("launch.settled", {}).catch(() => undefined);
  }, 3000);

  const { code, signal } = await exited;
  clearTimeout(settle);
  await rpc
    .call("launch.exited", { code, signal, duration_ms: Date.now() - started })
    .catch(() => undefined);
  rpc.close();
  return code ?? 1;
}

process.exitCode = await main(process.argv.slice(2));
