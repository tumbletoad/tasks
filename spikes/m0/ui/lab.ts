// Runs the spike page once for rows U05 and U07 (step M0.08) and writes the result files.
// Lab code: Node built-ins and the kit only, so it runs on Linux from the packaged Node
// without node_modules. It installs nothing and changes no setting: the stand-in service runs in
// this process on a new state folder (socket folder inside it, so nothing under /run/user), and
// a browser, when one is named, gets a new profile folder that this run creates.
//
//   node spikes/m0/ui/lab.ts run --state <new dir> --ui <built page> --out <dir>
//     --machine windows|linux [--measure u07|none] [--timeout 300] [--size 1440x900]
//     [--browser <exe> --kind firefox|chrome --profile <new dir> [--headless]]
//
// Without --browser it prints the URL (one line of JSON) and waits for the page to report, so an
// agent can open it in a browser it drives itself. The page reports through the service's
// /api/v1/spike/report. Result files hold numbers, yes or no answers and short labels only.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startService, type KitEvent, type RunningService } from "../kit/service.ts";
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
} from "../kit/wire.ts";

/** A5 3.25 targets the page judges against (measure.ts holds the same numbers). */
export const U07_TARGETS = {
  scroll: "60 fps: p95 frame interval <= 17.5 ms; rendered rows <= visible + 10 above and below",
  view_switch_ms: 100,
  burst_work_ms_per_frame: 16,
  heap_mb: 200,
  first_list_ms: 800,
} as const;

export interface PageRun {
  url: string;
  report: KitEvent;
}

/** Mints a UI code and checks the listener, as `kit open` does (A2 3.8.4 steps 1-3). */
export async function openUrl(state: string, query: string): Promise<string> {
  const rpc = new RpcClient(
    await connect(state, { mode: "rpc", client: clientInfo("cli"), context: {} }),
  );
  try {
    const minted = asObject(await rpc.call("ui/mint_code", {}));
    const port = Number(minted?.["port"]);
    const instance = textOf(asObject(rpc.bind["service"])?.["instance"]);
    if (!(await verifyListener(port, readKey(state), instance))) {
      throw new KitError(
        "listener",
        `Something other than the stand-in service answers on ${String(port)}.`,
      );
    }
    return `http://127.0.0.1:${String(port)}/${query}#k=${textOf(minted?.["code"])}`;
  } finally {
    rpc.close();
  }
}

/** Resolves with the first page report that satisfies `done`, or rejects after `timeoutMs`. */
export function waitForReport(
  service: RunningService,
  done: (event: KitEvent) => boolean,
  timeoutMs: number,
): Promise<KitEvent> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let seen = 0;
    const timer = setInterval(() => {
      for (; seen < service.events.length; seen++) {
        const event = service.events[seen];
        if (event?.kind === "page_report" && done(event)) {
          clearInterval(timer);
          resolve(event);
          return;
        }
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new KitError("timeout", `No page report within ${String(timeoutMs)} ms.`));
      }
    }, 200);
  });
}

export function browserArgs(
  kind: "firefox" | "chrome",
  profile: string,
  headless: boolean,
  size: [number, number],
  url: string,
): string[] {
  const [w, h] = size;
  if (kind === "firefox") {
    return [
      ...(headless ? ["--headless"] : []),
      "--no-remote",
      "-profile",
      profile,
      // Headless Firefox 159 keeps its default 1366x768 window either way (seen on Ubuntu 24.04),
      // so the page reports its real viewport and the result files carry that.
      `--window-size=${String(w)},${String(h)}`,
      url,
    ];
  }
  return [
    ...(headless ? ["--headless=new"] : []),
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    `--window-size=${String(w)},${String(h)}`,
    url,
  ];
}

/** Whether any process of the group led by `pgid` is still alive (Unix). */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stops the browser and every process of its group (Unix) or tree (Windows). On Unix the group
 * is signalled even when the launcher itself has exited (the snap's launcher may exec or leave
 * children behind): SIGTERM, up to 10 s for the group to go, then SIGKILL.
 */
export async function stopBrowser(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    if (child.exitCode !== null) return;
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", shell: false });
    return;
  }
  if (!groupAlive(pid)) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }
  const until = Date.now() + 10_000;
  while (groupAlive(pid) && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (groupAlive(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The group is gone.
    }
  }
}

/** Keeps a result value only when it is a short label: no token, code, path or user name. */
export function safeLabel(value: string): string | undefined {
  if (value.length > 80) return undefined;
  if (/ttasks_u_|bearer|#k=|[\\/]home[\\/]|[\\/]users[\\/]|[a-z]:\\|@/i.test(value))
    return undefined;
  return /^[\w .,:;()+\-'%/=<>]*$/.test(value) ? value : undefined;
}

const RESULT_NAME = /^[a-z0-9 _+/-]{1,60}$/i;

/**
 * The entries of `source` whose name passes `test`, with names and text values that pass the
 * label rules only. Numbers and booleans pass as they are. Anything else is dropped.
 */
const pick = (source: JsonObject, test: (name: string) => boolean): JsonObject =>
  Object.fromEntries(
    Object.entries(source).flatMap(([name, value]): [string, string | number | boolean][] => {
      if (!RESULT_NAME.test(name) || !test(name)) return [];
      if (typeof value === "boolean") return [[name, value]];
      if (typeof value === "number") return Number.isFinite(value) ? [[name, value]] : [];
      const label = typeof value === "string" ? safeLabel(value) : undefined;
      return label === undefined ? [] : [[name, label]];
    }),
  );

/** Writes U05.json, U07.json (when measured) and page-checks.json into `out`. */
export function writeResults(
  out: string,
  report: KitEvent,
  context: { machine: string; date: string; mode: string; size: string },
): string[] {
  mkdirSync(out, { recursive: true });
  const metrics = asObject(report["metrics"]) ?? {};
  const checks = asObject(report["checks"]) ?? {};
  const head = {
    machine: context.machine,
    date: context.date,
    browser: safeLabel(textOf(checks["browser"])) ?? "unknown",
    platform: safeLabel(textOf(checks["platform"])) ?? "unknown",
    mode: context.mode,
    // The page's own viewport when it reported one; the requested window size otherwise.
    viewport:
      typeof metrics["viewport_w"] === "number" && typeof metrics["viewport_h"] === "number"
        ? `${String(metrics["viewport_w"])}x${String(metrics["viewport_h"])}`
        : `requested window ${context.size}`,
  };
  const written: string[] = [];
  const write = (name: string, body: JsonObject) => {
    writeFileSync(join(out, name), `${JSON.stringify(body, null, 2)}\n`);
    written.push(name);
  };
  write("U05.json", {
    row: "U05",
    ...head,
    fonts: ["Inter Variable (Inter 4, SIL OFL 1.1)", "Fira Code Variable (SIL OFL 1.1)"],
    csp: "default-src 'self' (no font-src of its own), style-src with a per-response nonce",
    metrics: pick(metrics, (n) => n.startsWith("u05_") || n.startsWith("csp_")),
    checks: pick(checks, (n) => n.startsWith("font") || n === "csp violations"),
  });
  if (metrics["u07_done"] === true) {
    write("U07.json", {
      row: "U07",
      ...head,
      targets: U07_TARGETS,
      metrics: pick(metrics, (n) => n.startsWith("u07_")),
      checks: pick(checks, (n) => n.startsWith("u07")),
    });
  }
  write("page-checks.json", {
    note: "Unattended run of the page parts of U01-U04 and U06. Not the rows themselves: those need a person.",
    ...head,
    checks: pick(checks, (n) => !n.startsWith("u07") && !n.startsWith("font")),
    metrics: pick(metrics, (n) => n.startsWith("csp_")),
  });
  return written;
}

async function run(args: string[]): Promise<number> {
  const need = (name: string) => {
    const value = option(args, name);
    if (value === undefined) throw new KitError("usage", `Missing ${name}.`);
    return value;
  };
  const state = need("--state");
  if (existsSync(state)) throw new KitError("usage", `${state} exists. Pass a new state folder.`);
  const ui = need("--ui");
  const out = need("--out");
  const machine = need("--machine");
  const measure = option(args, "--measure") ?? "u07";
  const timeoutMs = Number(option(args, "--timeout") ?? 300) * 1000;
  const sizeText = option(args, "--size") ?? "1440x900";
  const [w, h] = sizeText.split("x").map(Number);
  const browser = option(args, "--browser");
  const headless = args.includes("--headless");
  const date = new Date().toISOString().slice(0, 10);

  const service = await startService({ state, ui, socketDir: "state" });
  let child: ChildProcess | undefined;
  // One cleanup path, for a normal end, an error and Ctrl+C or SIGTERM alike.
  let cleaning: Promise<void> | undefined;
  const cleanup = () =>
    (cleaning ??= (async () => {
      if (child !== undefined) await stopBrowser(child);
      await service.close();
    })());
  const onSignal = () => {
    void cleanup().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const url = await openUrl(state, measure === "u07" ? "?measure=u07" : "");
    if (browser === undefined) {
      process.stdout.write(`${JSON.stringify({ url })}\n`);
    } else {
      const kind = need("--kind");
      if (kind !== "firefox" && kind !== "chrome")
        throw new KitError("usage", "--kind is firefox or chrome.");
      const profile = need("--profile");
      if (existsSync(profile))
        throw new KitError("usage", `${profile} exists. Pass a new profile folder.`);
      mkdirSync(profile, { recursive: true, mode: 0o700 });
      child = spawn(browser, browserArgs(kind, profile, headless, [w ?? 1440, h ?? 900], url), {
        detached: process.platform !== "win32",
        stdio: "ignore",
        shell: false,
      });
      process.stdout.write(
        `${JSON.stringify({ browser: kind, pid: child.pid ?? null, headless })}\n`,
      );
    }
    const report = await waitForReport(
      service,
      (event) =>
        measure === "u07"
          ? event["run"] === "u07"
          : asObject(event["metrics"])?.["u05_pass"] !== undefined,
      timeoutMs,
    );
    const mode = browser === undefined ? "driven by the agent" : headless ? "headless" : "visible";
    const written = writeResults(out, report, { machine, date, mode, size: sizeText });
    process.stdout.write(`${JSON.stringify({ written, out })}\n`);
    return 0;
  } finally {
    await cleanup();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

if (process.argv[1]?.endsWith("lab.ts") === true) {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "run") {
    process.stderr.write(
      "Usage: node spikes/m0/ui/lab.ts run --state <new dir> --ui <dir> --out <dir> --machine <m> ...\n",
    );
    process.exit(64);
  }
  run(rest).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
