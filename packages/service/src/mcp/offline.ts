// The offline file (A2 3.7.3, format 1): what the bridge answers while it cannot
// reach the service. A3 owns its content and this step fills it: the server instructions, the
// SDK's own `initialize`, `server/discover` and `tools/list` results for both eras, the fields
// every 2026-07-28 result carries, and the seven texts of A3 3.5's transport reasons.
//
// The results are not written by hand: they are what this build's endpoint answers, captured by
// running the same factory over the same transport in memory. So the offline list and the live
// list cannot drift, and a test holds them byte-identical. `pnpm gen` writes the file into the
// bridge's `lib/` (scripts/bridge-offline.ts), the build copies it into each version folder
// (M1.13), and the service rewrites `<cache>/mcp-offline.json` at every start.
import { join } from "node:path";
import { CLI_NAME, PRODUCT_ID, PRODUCT_NAME } from "@tasks/brand";
// The bridge's names only: the bridge itself is its own bundle (lib/bridge.mjs), never the service's.
import { OFFLINE_FILE } from "@tasks/bridge/mcp/names";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { BUILD } from "../hub/build.ts";
import { atomicWrite, ensurePrivateDir, removeStaleTemps } from "../hub/files.ts";
import { LEGACY_VERSIONS, MODERN_VERSIONS, VERSION_META } from "./eras.ts";
import { createServer } from "./server.ts";
import { TOOLS } from "./tools.ts";
import { ChannelTransport, type LineChannel } from "./transport.ts";

type Json = Record<string, unknown>;

/** The file's content, as the bridge's parseOffline reads it. */
export interface OfflineContent {
  readonly format: 1;
  readonly build: string;
  readonly initialize: { readonly result: Json; readonly supported_versions: string[] };
  readonly discover: { readonly result: Json; readonly supported_versions: string[] };
  readonly tools_list: { readonly result: Json; readonly modern_result: Json };
  readonly modern_result_fields: Json;
  readonly texts: Readonly<Record<string, string>>;
}

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** How long one in-memory request may take while the offline file is built. */
const EXCHANGE_MS = 10_000;

/**
 * Sends `requests` to a fresh connection's server, one after another, and returns each result.
 * Tool calls get an error result with no text: only its envelope is used.
 */
async function exchange(requests: readonly Json[]): Promise<Json[]> {
  const results: Json[] = [];
  let waiting: ((message: Json) => void) | undefined;
  const channel: LineChannel = {
    onLine: undefined,
    onClose: undefined,
    send: (line) => {
      const message = JSON.parse(line) as Json;
      waiting?.(message);
      return true;
    },
    drained: () => Promise.resolve(),
    close: () => undefined,
  };
  const transport = new ChannelTransport(channel);
  const handle = serveStdio(
    () =>
      createServer(() => Promise.resolve({ content: [{ type: "text", text: "" }], isError: true })),
    { transport },
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    for (const request of requests) {
      // In memory the answer comes at once; the bound keeps a broken build from holding a start.
      const answer = new Promise<Json>((resolve, reject) => {
        waiting = resolve;
        timer = setTimeout(() => {
          reject(new Error("the endpoint did not answer while building the offline file"));
        }, EXCHANGE_MS);
      });
      channel.onLine?.(JSON.stringify(request));
      const message = await answer;
      clearTimeout(timer);
      if (!isObject(message["result"])) {
        throw new Error(
          `the endpoint refused ${String(request["method"])} while building the offline file`,
        );
      }
      results.push(message["result"]);
    }
  } finally {
    clearTimeout(timer);
    await handle.close();
  }
  return results;
}

const fail = (reason: string, sentence: string): string =>
  `error service_unavailable (${reason}): ${sentence}`;

/** The texts a tool call gets offline, one per transport reason (A2 3.7.3, A3 3.5). */
export function offlineTexts(): Record<string, string> {
  const name = PRODUCT_NAME;
  const cli = CLI_NAME;
  return {
    service_down: fail(
      "not_running",
      `${name}'s service is not running on this machine. Nothing was saved. Ask the user to run \`${cli} service start\`, then retry.`,
    ),
    starting: fail(
      "starting",
      `${name}'s service is starting or restarting. Nothing was saved. Retry in a few seconds with the same request ID.`,
    ),
    unreachable: fail(
      "unreachable",
      `${name}'s service cannot be reached from where this agent runs, for example from inside a sandbox. Nothing was saved. Ask the user to run \`${cli} doctor\`.`,
    ),
    untrusted_endpoint: fail(
      "untrusted_endpoint",
      `Something other than ${name} is listening at ${name}'s address. Nothing was sent to it. Ask the user to run \`${cli} doctor\`.`,
    ),
    restart_session: fail(
      "restart_session",
      `${name} was updated. Restart this agent session to use its tools.`,
    ),
    service_too_old: fail(
      "service_too_old",
      `The running ${name} service is older than this session's ${name} tools. Ask the user to restart it (\`${cli} service stop\`, then \`${cli} service start\`), then retry.`,
    ),
    connection_lost: fail(
      "connection_lost",
      `${name} restarted during this call. It may or may not have been applied. Retry with the same request ID.`,
    ),
  };
}

/** The offline file's content for this build, from this build's endpoint. */
export async function offlineContent(): Promise<OfflineContent> {
  const client = { name: `${PRODUCT_ID}-offline`, version: BUILD.version };
  const [initialize, legacyList] = await exchange([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: LEGACY_VERSIONS[0], capabilities: {}, clientInfo: client },
    },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]);
  const meta = {
    _meta: {
      [VERSION_META]: MODERN_VERSIONS[0],
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": client,
    },
  };
  const [discover, modernList, call] = await exchange([
    { jsonrpc: "2.0", id: 1, method: "server/discover", params: meta },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: meta },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: TOOLS[0]?.name, arguments: {}, ...meta },
    },
  ]);
  if (
    initialize === undefined ||
    legacyList === undefined ||
    discover === undefined ||
    modernList === undefined ||
    call === undefined
  ) {
    throw new Error("the endpoint did not answer while building the offline file");
  }
  // What a 2026-07-28 result carries beside its own fields: the call's result without them.
  const fields = Object.fromEntries(
    Object.entries(call).filter(([key]) => key !== "content" && key !== "isError"),
  );
  return {
    format: 1,
    build: BUILD.build,
    initialize: { result: initialize, supported_versions: [...LEGACY_VERSIONS] },
    discover: { result: discover, supported_versions: [...MODERN_VERSIONS] },
    tools_list: { result: legacyList, modern_result: modernList },
    modern_result_fields: fields,
    texts: offlineTexts(),
  };
}

/** The file as the bridge's `lib/` and the cache hold it. */
export async function offlineFileText(): Promise<string> {
  return `${JSON.stringify(await offlineContent(), null, 2)}\n`;
}

/**
 * Writes `<cache>/mcp-offline.json` (0600) for this build (A2 3.7.3: at every start), so a bridge
 * of this build answers offline with this endpoint's answers. A cache folder another user can
 * change is left alone: its file could put words in an agent's instructions.
 */
export async function writeOfflineCache(cacheDir: string): Promise<"written" | "unsafe"> {
  const text = await offlineFileText();
  if (ensurePrivateDir(cacheDir) !== undefined) return "unsafe";
  removeStaleTemps(cacheDir, [OFFLINE_FILE]);
  atomicWrite(join(cacheDir, OFFLINE_FILE), text, 0o600);
  return "written";
}
