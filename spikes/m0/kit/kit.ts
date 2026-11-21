// The M0 spike kit's command line. Lab code: never shipped, never imported by a package (A7 3.7).
// From the repository: pnpm exec node spikes/m0/kit/kit.ts <command>. From a built copy:
// node <out>/kit.mjs <command>. spikes/m0/README.md maps the lab rows to these commands.
import { otherAccounts } from "./accounts.ts";
import { METRICS, runBench, type Metric } from "./bench.ts";
import { runBridgeBench, type BridgeBenchOptions, type RowName } from "./bridge-bench.ts";
import { buildKit } from "./build.ts";
import { runShim } from "./run-shim.ts";
import { startService, type SocketDirChoice } from "./service.ts";
import { buildTree } from "./tree.ts";
import {
  KitError,
  RpcClient,
  asObject,
  clientInfo,
  connect,
  option,
  readKey,
  textOf,
  verifyListener,
  type JsonObject,
} from "./wire.ts";

const USAGE = `Usage: kit <command>
  service --state <dir> [--port <n>] [--socket-dir auto|run-user|state] [--tree <container>]
          [--ui <built spike UI>]          run the stand-in service until stopped
  call --state <dir> <method> [<json>]     one rpc call, for example service/status
  open --state <dir> [--path <p>]          mint a UI code, verify the port, print the URL
  ticket --state <dir> --cwd <dir> [--title <t>] [--run [--brief <text>]] -- <argv...>
                                           mint a one-use ticket for the shim or the run shim
  run-shim --state <dir> [--run-dir <dir>] [--grace <ms>] <ticket>
                                           the run shim (A4 3.11), the same as run-shim.mjs
  tree <base>                              build the scratch folder tree under <base>
  build <out>                              write the standalone .mjs kit to <out>
  bench --work <dir> [--runs <n>] [--metric <m>] [--kit <dir>] [--cold]
                                           B01, B06 and B07 start-time measurements. Metrics:
                                           ${METRICS.join(", ")}
  bridge --work <dir> --out <dir> [--rows B01,B02,B03,B04] [--label <l>] [--role <r>]
         [--runs 20] [--cold --metric <m> --kit <dir>] [--calls 10] [--idle-ms 60000]
         [--bridges 10] [--bridge-calls 100] [--direct-calls 500] [--quiet-ms 3000]
         [--repeat <n>] [--node-flag <flag>]... [--compile-cache <dir>]
                                           B01-B07 with result files (B01 also writes B06 and
                                           B07, B03 also writes B05). --repeat 20 runs B02, B03
                                           and B04 20 times each, one file per row with every
                                           run, the median and the p95 (A2 3.7.7)
  accounts                                 S12: the machine's other interactive accounts
Separate entry points: forwarder, shim, run-shim and probe (see spikes/m0/README.md).`;

const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

async function cli(state: string): Promise<RpcClient> {
  return new RpcClient(
    await connect(state, { mode: "rpc", client: clientInfo("cli"), context: {} }),
  );
}

function need(value: string | undefined, what: string): string {
  if (value === undefined) throw new KitError("usage", `Missing ${what}.\n\n${USAGE}`);
  return value;
}

async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  switch (command) {
    case "service": {
      // A2 3.5 rule 3: the service refuses to run with package identity.
      if ((process.env["TTASKS_PACKAGE"] ?? "") !== "") {
        process.stderr.write(
          "TTasks's service cannot run inside another app's package. Start it from the Start menu or a normal terminal.\n",
        );
        return 64;
      }
      const port = option(rest, "--port");
      const socketDir = option(rest, "--socket-dir");
      const tree = option(rest, "--tree");
      const ui = option(rest, "--ui");
      if (socketDir !== undefined && !["auto", "run-user", "state"].includes(socketDir)) {
        throw new KitError("usage", `--socket-dir is auto, run-user or state.\n\n${USAGE}`);
      }
      let service;
      try {
        service = await startService({
          state: need(option(rest, "--state"), "--state"),
          ...(port === undefined ? {} : { port: Number(port) }),
          ...(socketDir === undefined ? {} : { socketDir: socketDir as SocketDirChoice }),
          ...(tree === undefined ? {} : { tree }),
          ...(ui === undefined ? {} : { ui }),
        });
      } catch (error) {
        if (error instanceof KitError && error.code === "locked") {
          process.stderr.write(`${error.message}\n`);
          return 73;
        }
        // A2 3.3.1: refused (unsafe permissions, no runtime folder) is exit 64, no restart.
        if (
          error instanceof KitError &&
          (error.code === "unsafe_permissions" || error.code === "runtime_dir_unavailable")
        ) {
          process.stderr.write(`${error.message}\n`);
          return 64;
        }
        // The permission check could not run at all: an OS error, not a verdict on the folder.
        if (error instanceof KitError && error.code === "cannot_inspect_permissions") {
          process.stderr.write(`${error.message}\n`);
          return 71;
        }
        throw error;
      }
      const stop = () => void service.close();
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      print({ ready: true, ...service.info });
      await service.closed;
      return 0;
    }
    case "call": {
      const state = need(option(rest, "--state"), "--state");
      const positional = rest.filter((a, i) => a !== "--state" && rest[i - 1] !== "--state");
      const method = need(positional[0], "a method");
      const params = asObject(JSON.parse(positional[1] ?? "{}")) ?? {};
      const rpc = await cli(state);
      try {
        print(await rpc.call(method, params));
      } finally {
        rpc.close();
      }
      return 0;
    }
    case "open": {
      // A2 3.8.4 steps 1-3: mint a code, verify the listener by HMAC, then hand out the URL.
      const state = need(option(rest, "--state"), "--state");
      const path = option(rest, "--path");
      const rpc = await cli(state);
      const minted = asObject(await rpc.call("ui/mint_code", path === undefined ? {} : { path }));
      rpc.close();
      const port = Number(minted?.["port"]);
      if (!(await verifyListener(port, readKey(state), instanceOf(rpc.bind)))) {
        process.stderr.write(`Something other than TTasks answers on port ${String(port)}.\n`);
        return 69;
      }
      process.stdout.write(`http://127.0.0.1:${String(port)}/#k=${textOf(minted?.["code"])}\n`);
      return 0;
    }
    case "ticket": {
      const state = need(option(rest, "--state"), "--state");
      const dash = rest.indexOf("--");
      const argv = dash === -1 ? [] : rest.slice(dash + 1);
      const before = dash === -1 ? rest : rest.slice(0, dash);
      const title = option(before, "--title");
      const brief = option(before, "--brief");
      const rpc = await cli(state);
      try {
        print(
          await rpc.call("spike.mint_ticket", {
            argv,
            cwd: need(option(before, "--cwd"), "--cwd"),
            ...(title === undefined ? {} : { title }),
            ...(before.includes("--run") ? { run: true } : {}),
            ...(brief === undefined ? {} : { brief }),
          }),
        );
      } finally {
        rpc.close();
      }
      return 0;
    }
    case "tree":
      print(buildTree(need(rest[0], "a base folder")));
      return 0;
    case "build":
      process.stdout.write(`${buildKit(need(rest[0], "an output folder"))}\n`);
      return 0;
    case "run-shim":
      return runShim(rest);
    case "bench": {
      const metric = option(rest, "--metric");
      if (metric !== undefined && !(METRICS as readonly string[]).includes(metric)) {
        throw new KitError("usage", `--metric is one of ${METRICS.join(", ")}.\n\n${USAGE}`);
      }
      const kit = option(rest, "--kit");
      print(
        await runBench({
          work: need(option(rest, "--work"), "--work"),
          runs: Number(option(rest, "--runs") ?? "20"),
          cold: rest.includes("--cold"),
          ...(metric === undefined ? {} : { metric: metric as Metric }),
          ...(kit === undefined ? {} : { kit }),
        }),
      );
      return 0;
    }
    case "bridge":
      return bridge(rest);
    case "accounts":
      print({ other_accounts: otherAccounts() });
      return 0;
    default:
      process.stdout.write(`${USAGE}\n`);
      return command === undefined || command === "help" ? 0 : 64;
  }
}

/** `kit bridge`: rows B01-B07 (bridge-bench.ts), with a result file per row. */
async function bridge(rest: string[]): Promise<number> {
  const num = (name: string): number | undefined => {
    const value = option(rest, name);
    return value === undefined ? undefined : Number(value);
  };
  const rows = (option(rest, "--rows") ?? "B01,B02,B03,B04").split(",");
  for (const row of rows) {
    if (!["B01", "B02", "B03", "B04"].includes(row)) {
      throw new KitError("usage", `--rows takes B01, B02, B03 and B04.\n\n${USAGE}`);
    }
  }
  const nodeArgs = rest.flatMap((a, i) => (rest[i - 1] === "--node-flag" ? [a] : []));
  const cache = option(rest, "--compile-cache");
  const metric = option(rest, "--metric");
  const kit = option(rest, "--kit");
  const cold = rest.includes("--cold");
  if (cold && (metric === undefined || kit === undefined || !rows.every((r) => r === "B01"))) {
    throw new KitError("usage", `--cold needs --rows B01, --metric and --kit.\n\n${USAGE}`);
  }
  if (metric !== undefined && !(METRICS as readonly string[]).includes(metric)) {
    throw new KitError("usage", `--metric is one of ${METRICS.join(", ")}.\n\n${USAGE}`);
  }
  const options: BridgeBenchOptions = {
    work: need(option(rest, "--work"), "--work"),
    out: need(option(rest, "--out"), "--out"),
    nodeArgs,
  };
  const label = option(rest, "--label");
  const role = option(rest, "--role");
  if (label !== undefined) options.label = label;
  if (role !== undefined) options.role = role;
  if (cache !== undefined) options.bridgeEnv = { NODE_COMPILE_CACHE: cache };
  const counts: [keyof BridgeBenchOptions, string][] = [
    ["calls", "--calls"],
    ["idleMs", "--idle-ms"],
    ["bridges", "--bridges"],
    ["bridgeCalls", "--bridge-calls"],
    ["directCalls", "--direct-calls"],
    ["quietMs", "--quiet-ms"],
    ["repeat", "--repeat"],
  ];
  for (const [key, flag] of counts) {
    const value = num(flag);
    if (value !== undefined) (options as unknown as Record<string, number>)[key] = value;
  }
  const start =
    cold && metric !== undefined && kit !== undefined
      ? { runs: 1, cold: { metric: metric as Metric, kit } }
      : { runs: num("--runs") ?? 20 };
  if (!cold && kit !== undefined) options.kit = kit;
  await runBridgeBench(rows as RowName[], options, start);
  return 0;
}

function instanceOf(bind: JsonObject): string {
  const service = asObject(bind["service"]);
  return typeof service?.["instance"] === "string" ? service["instance"] : "";
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof KitError && error.code === "usage" ? 64 : 1;
}
