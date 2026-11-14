// The probe MCP server (stdio) for rows A01-A06, A09 and S05 (P-1 to P-3):
//   node probe.mjs --log-dir <folder> [--scratch-root <kit tree container>] [--markers]
// The scratch root may also come from TASKS_M0_SCRATCH_ROOT. The probe answers MCP in both eras
// and appends JSON lines to probe-<pid>-<time>.jsonl in the log folder. Every record is closed,
// structured data (probe-log.ts): environment names, allow-listed identifier values, path facts
// instead of paths (cwd, scratch homes, profile folders), the parent's PID and executable name,
// package identity through a strict class, and for every MCP request its method, era, protocol
// version and client as known labels or `[other:<sha256 prefix> length n]`. It never logs a
// command line, a tool argument or a raw path, and logs TASKS_TICKET only as a hash. Before a
// record is written, a redactor removes any environment value outside the allow-list; the `end`
// record says how often it fired (zero in normal use).
import { execFile } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  createMcpResponder,
  eraOf,
  textResult,
  VERSION_META,
  CLIENT_INFO_META,
} from "./mcp-stub.ts";
import {
  KNOWN_CLIENTS,
  KNOWN_METHODS,
  KNOWN_VERSIONS,
  createRedactor,
  environmentFacts,
  exeName,
  known,
  loadScratchRoot,
  packageName,
  pathFacts,
  version,
} from "./probe-log.ts";
import {
  LineReader,
  asObject,
  option,
  parseObject,
  sha256Hex,
  type Json,
  type JsonObject,
} from "./wire.ts";

/** The probe's only tool. Any other tool name is logged as `[other:...]`. */
const TOOLS = new Set(["probe_report"]);

const INSTRUCTIONS =
  "Tasks probe for the M0 lab. Rule: every tool call that changes data must pass a request_id " +
  "that starts with probe- followed by a number, for example probe-1. Reuse the same request_id " +
  "when you retry the same change.";

const args = process.argv.slice(2);
const logDir = option(args, "--log-dir");
if (logDir === undefined) {
  process.stderr.write(
    "Usage: probe --log-dir <folder> [--scratch-root <container>] [--markers]\n",
  );
  process.exit(64);
}
mkdirSync(logDir, { recursive: true });
const logFile = join(logDir, `probe-${String(process.pid)}-${String(Date.now())}.jsonl`);
const redactor = createRedactor(process.env);
const log = (record: JsonObject) => {
  const clean = redactor.json({ t: Date.now(), ...record });
  appendFileSync(logFile, `${JSON.stringify(clean)}\n`, { mode: 0o600 });
};

const scratch = loadScratchRoot(
  option(args, "--scratch-root") ?? process.env["TASKS_M0_SCRATCH_ROOT"],
);
const environment = environmentFacts(process.env, scratch);

/** The parent: PID and executable base name only (Linux here, Windows from the lookup below). */
function parentInfo(): JsonObject {
  const parent: JsonObject = { pid: process.ppid, name: null };
  if (process.platform === "linux") {
    try {
      parent["name"] = exeName(basename(readlinkSync(`/proc/${String(process.ppid)}/exe`)));
    } catch {
      // The parent may already be gone, or belong to someone else.
    }
  }
  return parent;
}

/** Linux: snap and flatpak. Windows: the package record below adds the package full name. */
function packageHints(): JsonObject {
  return {
    snap: packageName(process.env["SNAP_NAME"]),
    flatpak:
      packageName(process.env["FLATPAK_ID"]) ?? (existsSync("/.flatpak-info") ? "unknown" : null),
    tasks_package: packageName(process.env["TASKS_PACKAGE"]),
  };
}

const self = {
  pid: process.pid,
  ppid: process.ppid,
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  exec: exeName(basename(process.execPath)),
  scratch_root: scratch !== undefined,
  cwd: pathFacts(process.cwd(), scratch),
  parent: parentInfo(),
  env_names: environment.names,
  env: environment.values,
  paths: environment.paths,
  package: packageHints(),
} satisfies JsonObject;
log({ kind: "start", ...self });

// Windows: package identity (GetCurrentPackageFullName through WinRT) and the parent's process
// name, from Windows PowerShell, which inherits the probe's package context (A2 3.5, P-1). It runs
// with an environment built from scratch and calls .NET only, so no PowerShell module loads.
let lookup: Promise<void> = Promise.resolve();
if (process.platform === "win32") {
  const root = process.env["SystemRoot"] ?? "C:\\Windows";
  const ps = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "windir", "SystemDrive", "TEMP", "TMP"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const script =
    "$n=''; $p=''; " +
    "try { $n=[Windows.ApplicationModel.Package,Windows.ApplicationModel,ContentType=WindowsRuntime]::Current.Id.FullName } catch {}; " +
    `try { $p=[Diagnostics.Process]::GetProcessById(${String(process.ppid)}).ProcessName } catch {}; ` +
    "[Console]::Out.WriteLine($n + [char]9 + $p)";
  lookup = new Promise((resolve) => {
    execFile(
      ps,
      ["-NoProfile", "-NonInteractive", "-NoLogo", "-Command", script],
      { windowsHide: true, timeout: 15_000, env },
      (error, stdout) => {
        // Not trimmed: an empty package name leaves the line starting with the tab.
        const [full = "", parent = ""] = (stdout.split(/\r?\n/)[0] ?? "").split("\t");
        log({
          kind: "package",
          ok: error === null,
          package_full_name: packageName(full),
          localappdata_under_packages: /[\\/]Packages[\\/]/i.test(
            process.env["LOCALAPPDATA"] ?? "",
          ),
          parent: { pid: process.ppid, name: exeName(parent === "" ? undefined : `${parent}.exe`) },
        });
        resolve();
      },
    );
  });
}

// P-2 and P-3 (A2 3.5): markers in the redirectable folders, and a marker written beforehand.
// Logged by variable name, and the pre-marker by its content's hash, never by path or text.
if (args.includes("--markers")) {
  const written: Json[] = [];
  const targets: [string, string][] = [
    ["APPDATA", "tasks-m0"],
    ["LOCALAPPDATA", "tasks-m0"],
    ["USERPROFILE", ".tasks-m0"],
    ["TEMP", ""],
  ];
  for (const [name, sub] of targets) {
    const base = process.env[name];
    if (base === undefined) continue;
    const dir = join(base, sub);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `tasks-m0-marker-${String(process.pid)}.txt`),
      `Tasks M0 marker from probe ${String(process.pid)}\n`,
    );
    written.push(name);
  }
  const profile = process.env["USERPROFILE"];
  const pre = profile === undefined ? undefined : join(profile, ".tasks-m0", "pre-marker.txt");
  const preMarker =
    pre !== undefined && existsSync(pre)
      ? `sha256:${sha256Hex(readFileSync(pre, "utf8").trim()).slice(0, 12)}`
      : null;
  log({ kind: "markers", written, pre_marker: preMarker });
}

let era: string | null = null;
const respond = createMcpResponder({
  name: "tasks-probe",
  instructions: INSTRUCTIONS,
  tools: [
    {
      name: "probe_report",
      description:
        "Returns what the probe saw at start: allow-listed values, cwd and parent facts.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
  call: () =>
    textResult(
      JSON.stringify(
        redactor.json({
          pid: self.pid,
          cwd: self.cwd,
          parent: self.parent,
          env: self.env,
          era,
        }),
      ),
    ),
});

/** One MCP message as closed labels. */
function requestRecord(msg: JsonObject): JsonObject {
  const params = asObject(msg["params"]) ?? {};
  const meta = asObject(params["_meta"]);
  const messageEra = eraOf(msg);
  const client = asObject(params["clientInfo"]) ?? asObject(meta?.[CLIENT_INFO_META]);
  return {
    kind: "mcp",
    method: known(msg["method"], KNOWN_METHODS),
    era: messageEra,
    version: known(
      messageEra === "legacy" ? params["protocolVersion"] : meta?.[VERSION_META],
      KNOWN_VERSIONS,
    ),
    client: known(client?.["name"], KNOWN_CLIENTS),
    client_version: version(client?.["version"]),
  };
}

const stdin = new LineReader(process.stdin);
stdin.pipe(
  (line) => {
    const msg = parseObject(line);
    if (msg === undefined) return;
    if (typeof msg["method"] === "string") {
      era ??= eraOf(msg);
      log(requestRecord(msg));
    }
    if (msg["method"] === "tools/call") {
      log({ kind: "tool", name: known(asObject(msg["params"])?.["name"], TOOLS) });
    }
    const reply = respond(msg);
    if (reply !== null) process.stdout.write(`${JSON.stringify(reply)}\n`);
  },
  () => {
    void lookup.then(() => {
      log({ kind: "end", redactions: redactor.fired });
    });
  },
);
