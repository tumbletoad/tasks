// `ttasks mcp`: the entry as a function. The CLI's entry hands its `mcp` verb here
// (packages/cli/src/mcp.ts), and main.ts is the direct script entry. The build bundles
// `@ttasks/bridge/mcp` as its own `lib/bridge.mjs`.
import { join } from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { openLines, type ClientInfo, type LineSession } from "../protocol/index.ts";
import { USAGE, parseArgs } from "./args.ts";
import { baseContext } from "./context.ts";
import { hostFacts, installFolders, readEndpoint, readKey, type Folders } from "./discovery.ts";
import { Forwarder, type Timing } from "./forwarder.ts";
import { processIo, watchProcess, type McpIo } from "./io.ts";
import { BRIDGE_BUILD, OFFLINE_FILE, PACKAGE_VAR } from "./names.ts";
import { loadOffline } from "./offline.ts";
import { Unavailable } from "./unavailable.ts";

/** A usage problem. */
export const EXIT_USAGE = 2;

/** The bridge connects like the CLI: 2 s to the socket or pipe. */
export const CONNECT_MS = 2_000;

/**
 * The source tree's offline file, `packages/bridge/lib/mcp-offline.json`, which `pnpm gen`
 * writes. A built bridge passes its version folder's `lib/mcp-offline.json` instead.
 */
export const SOURCE_LIB = fileURLToPath(new URL("../../lib/mcp-offline.json", import.meta.url));

export interface McpOptions {
  /** The process by default. Tests pass streams of their own. */
  readonly io?: McpIo;
  /** The build's `lib/mcp-offline.json`. */
  readonly libFile?: string;
  readonly timing?: Partial<Timing>;
  /** The protocol this bridge names. Tests only: a bridge newer than the service. */
  readonly protocol?: number;
}

/** stderr may hold this much unwritten before further diagnostics are dropped. */
export const MAX_DIAGNOSTIC_QUEUE = 64 * 1024;

/**
 * The bridge's one diagnostic writer, `mcp bridge: …` lines on stderr. Best effort: a failed
 * write is ignored (an agent app that closed its end of stderr must not end the session), and
 * while stderr holds MAX_DIAGNOSTIC_QUEUE unwritten bytes (an agent app that does not read it) a
 * diagnostic is dropped, so diagnostics never grow the bridge's memory.
 */
export function diagnostics(stream: Writable): (text: string) => void {
  stream.on("error", () => undefined);
  return (text) => {
    if (stream.destroyed || !stream.writable) return;
    if (stream.writableLength >= MAX_DIAGNOSTIC_QUEUE) return;
    stream.write(`mcp bridge: ${text}\n`);
  };
}

/** The package identity the launcher passed, or null. */
function packageOf(env: Readonly<Record<string, string | undefined>>): string | null {
  const value = env[PACKAGE_VAR];
  return value === undefined || value.trim() === "" || value.length > 256 ? null : value;
}

/** Discovery, read again for every attempt, then the handshake and the bind. */
async function dial(
  folders: Folders | undefined,
  platform: NodeJS.Platform,
  client: ClientInfo,
  context: Record<string, unknown>,
  protocol: number | undefined,
): Promise<LineSession> {
  if (folders === undefined) throw new Unavailable("unreachable", "no_state_folder");
  const path = readEndpoint(folders.state, platform);
  const key = readKey(folders.state, platform);
  return openLines({
    path,
    key,
    client,
    context,
    connectTimeoutMs: CONNECT_MS,
    ...(protocol === undefined ? {} : { protocol }),
  });
}

/**
 * Runs the bridge until the agent app closes stdin or a signal ends it. Resolves with the exit
 * code once stdout took what was queued: 0, or 2 for a usage problem.
 */
export async function runMcp(argv: readonly string[], options: McpOptions = {}): Promise<number> {
  const io = options.io ?? processIo();
  const say = diagnostics(io.error);
  const args = parseArgs(argv);
  if ("problem" in args) {
    say(`${args.problem}. ${USAGE}`);
    return EXIT_USAGE;
  }
  let folders: Folders | undefined;
  try {
    folders = installFolders(hostFacts(io.env, io.platform));
  } catch {
    folders = undefined;
  }
  let cwd: string | undefined;
  try {
    cwd = io.cwd();
  } catch {
    cwd = undefined; // the working folder was removed
  }
  const client: ClientInfo = {
    kind: "bridge",
    version: BRIDGE_BUILD.version,
    build: BRIDGE_BUILD.build,
    pid: io.pid,
    package: packageOf(io.env),
    tty: io.tty,
  };
  const cache = folders === undefined ? undefined : join(folders.cache, OFFLINE_FILE);
  const forwarder = new Forwarder({
    input: io.input,
    output: io.output,
    warn: say,
    dial: (context) => dial(folders, io.platform, client, context, options.protocol),
    context: baseContext(args, { env: io.env, cwd, ppid: io.ppid }),
    offline: () => loadOffline({ cache, lib: options.libFile ?? SOURCE_LIB }, BRIDGE_BUILD.build),
    ...(options.timing === undefined ? {} : { timing: options.timing }),
  });
  if (options.io === undefined) {
    watchProcess(() => {
      forwarder.stop();
    }, say);
  }
  forwarder.start();
  await forwarder.done;
  return 0;
}
