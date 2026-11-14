// Spawn-to-first-byte measurements for rows B01 (and B06) and B07, as A2 3.7.7 defines them:
// the forwarder from spawn to the first byte of its `initialize` reply with the service running
// and stopped, and the shim from spawn to its claim reaching the service. The timed forwarders
// and shims come from a built .mjs kit, and an in-process stand-in service runs in `<work>/state`.
// Median, p95 and max in ms. Memory and concurrency (B02-B05) are the lab step's harness.
//
// Warm runs: `--runs 20` measures all three metrics, or the one `--metric` names. From the .ts
// sources the kit is built into `<work>/kit-js` first.
// Cold runs (`--cold`): exactly one metric and one run per invocation, right after a reboot, from
// a prebuilt kit given with `--kit <dir>` that this process has not loaded. The bench never builds
// for a cold run and refuses a kit that is missing or older than its sources, because building
// or an earlier metric would warm the very files the run must find cold.
import { spawn } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";
import { KIT_DIR, buildKit, checkBuiltKit } from "./build.ts";
import { startService, type KitEvent } from "./service.ts";
import { KitError, RpcClient, clientInfo, connect, sha256Hex } from "./wire.ts";

export interface Stats {
  runs: number;
  median: number;
  p95: number;
  max: number;
}

export const METRICS = ["forwarder_online", "forwarder_offline", "shim_claim"] as const;
export type Metric = (typeof METRICS)[number];

export interface BenchOptions {
  work: string;
  runs: number;
  /** Measure only this metric. Required for a cold run. */
  metric?: Metric;
  /** One run of one metric from a prebuilt `kit`, right after a reboot. */
  cold?: boolean;
  /** A prebuilt kit (`kit build <dir>`) to spawn the timed processes from. */
  kit?: string;
}

export interface BenchResult {
  os: string;
  node: string;
  cold: boolean;
  kit: string;
  forwarder_online?: Stats;
  forwarder_offline?: Stats;
  shim_claim?: Stats;
}

const INITIALIZE = `${JSON.stringify({
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "kit-bench", version: "1" },
  },
})}\n`;

/** The same clock as the service's event timestamps. */
const now = () => performance.timeOrigin + performance.now();

export function stats(samples: readonly number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? 0;
  const round = (n: number) => Math.round(n * 10) / 10;
  return { runs: sorted.length, median: round(at(0.5)), p95: round(at(0.95)), max: round(at(1)) };
}

/** Spawns the forwarder, sends `initialize` at once, and times the first byte of the reply. */
function forwarderFirstByte(js: string, state: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = now();
    let elapsed: number | undefined;
    const child = spawn(process.execPath, [join(js, "forwarder.mjs"), "--state", state], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      shell: false,
    });
    const timer = setTimeout(() => child.kill(), 15_000);
    child.stdin.write(INITIALIZE);
    child.stdout.once("data", () => {
      elapsed = now() - started;
      child.stdin.end();
    });
    child.once("error", reject);
    child.once("exit", () => {
      clearTimeout(timer);
      if (elapsed === undefined) reject(new Error("the forwarder exited without a reply"));
      else resolve(elapsed);
    });
  });
}

/** The kit the timed processes come from, per the rules in the header. */
function timedKit(options: BenchOptions): string {
  if (options.kit !== undefined) {
    const kit = realpathSync.native(checkBuiltKit(options.kit));
    if (options.cold === true && kit === realpathSync.native(KIT_DIR)) {
      throw new KitError(
        "usage",
        "A cold run needs --kit to name a separate built copy: this process already loaded its own files.",
      );
    }
    return kit;
  }
  if (options.cold === true) {
    throw new KitError(
      "kit_missing",
      "A cold run needs a prebuilt kit: run `kit build <dir>` before the reboot, then pass --kit <dir>.",
    );
  }
  return buildKit(join(options.work, "kit-js"));
}

export async function runBench(options: BenchOptions): Promise<BenchResult> {
  const { work, metric } = options;
  const cold = options.cold === true;
  if (cold && metric === undefined) {
    throw new KitError("usage", "A cold run measures one metric: pass --metric <name>.");
  }
  const runs = cold ? 1 : options.runs;
  mkdirSync(work, { recursive: true });
  const js = timedKit(options);
  const state = join(work, "state");
  const wanted = (m: Metric) => metric === undefined || metric === m;
  let listener: ((event: KitEvent) => void) | undefined;
  const onEvent = (event: KitEvent) => listener?.(event);
  const result: BenchResult = {
    os: `${process.platform} ${release()}`,
    node: process.version,
    cold,
    kit: js,
  };

  if (wanted("forwarder_online")) {
    const service = await startService({ state, onEvent });
    const online: number[] = [];
    try {
      for (let i = 0; i < runs; i++) online.push(await forwarderFirstByte(js, state));
    } finally {
      await service.close();
    }
    result.forwarder_online = stats(online);
  }

  if (wanted("forwarder_offline")) {
    const offline: number[] = [];
    for (let i = 0; i < runs; i++) offline.push(await forwarderFirstByte(js, state));
    result.forwarder_offline = stats(offline);
  }

  if (wanted("shim_claim")) {
    const service = await startService({ state, onEvent });
    const claims: number[] = [];
    try {
      const rpc = new RpcClient(
        await connect(state, { mode: "rpc", client: clientInfo("cli"), context: {} }),
      );
      for (let i = 0; i < runs; i++) {
        const { ticket } = (await rpc.call("spike.mint_ticket", {
          argv: [process.execPath, "-e", ""],
          cwd: work,
          title: "M-1 Bench launch",
        })) as { ticket: string };
        const tag = sha256Hex(ticket).slice(0, 12);
        const started = now();
        // The claim event's time is when the claim arrived, before the service logged anything.
        const claimed = new Promise<number>((resolve) => {
          listener = (event) => {
            if (event.kind === "claim" && event["ticket"] === tag) resolve(event.t - started);
          };
        });
        const child = spawn(process.execPath, [join(js, "shim.mjs"), "--state", state, ticket], {
          stdio: "ignore",
          windowsHide: true,
          shell: false,
        });
        const exited = new Promise((resolve) => child.once("exit", resolve));
        const noClaim = exited.then(() => {
          throw new Error("the shim exited without a claim");
        });
        claims.push(await Promise.race([claimed, noClaim]));
        await exited;
      }
      rpc.close();
    } finally {
      listener = undefined;
      await service.close();
    }
    result.shim_claim = stats(claims);
  }
  return result;
}
