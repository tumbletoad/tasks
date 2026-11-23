// `ttasks doctor [--json] [--self-test]` (A2 3.13), the service-side checks this build can make.
// It works without a running service: that is one of the things it reports. It opens no space
// database: the service reports each space's state.
//
//   paths      the state folder exists and, on Linux and macOS, no other user can change it (the
//              service's own rule, permissions.ts), with the command that fixes it
//   config     machine.toml as the service reads it: what would refuse the start fails here, with
//              the command that fixes a file or folder another user could change
//   install    install.json's install ID matches the one computed from the state folder
//   update     no update journal is left (one is an update running or cut off), and the last
//              update's outcome from install.json (M6.12)
//   integrity  the version folder this CLI runs from matches its manifest.json, `current` names an
//              installed version, and on Windows both stable launchers are there
//   runtime    the runtime gate of A2 3.12.1 with this process's Node, against the manifest's pins
//   service    running, its version and build against this CLI's, its protocol range
//   endpoint   ipc.key readable, the handshake verifies, service/status answers
//   spaces     each space's state and the holder of a lock held elsewhere
//   requests   the request path end to end: op/list names every verb's entry, and space.status
//              answers through op/call for each served space
//   autostart  whether the OS starts the service by itself, as `ttasks service status` says it
//   crashes    crash files of the last 7 days, by event
//   logs       errors and warnings of the last 24 hours, by event name
//   accounts   other interactive user accounts on the machine (agent sandbox accounts left out)
//   http       the UI listener: blocked by a foreign port holder, moved, a Windows excluded range,
//              and its self-test (a rebinding Host gets 421, index.html has a fresh nonce)
//   launch.scopes, launch.terminal, launch.env, launch.t3, sessions
//              what the service's launch service and binding say (doctor-launch.ts, A3 3.14)
//   candidate-space, candidate-endpoint, candidate-bridge
//              with --self-test from a version folder: the candidate's own checks of A2 3.12.6
//              (M1.14): a temporary space, a temporary endpoint and handshake, and this version's
//              bridge answering tools/list, each in a folder of its own below <state>/tmp/
//
// Every check is non-interactive. `--self-test` (A2 3.13: the subset for CI, install and updates)
// adds the candidate's checks, which write temporary files; `ttasks install --finish` runs integrity,
// runtime and those before it switches current. Run from source there is no version folder, so
// integrity, runtime and the candidate's checks are skipped: the build runs them in every version
// folder it makes.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { CLI_NAME, PRODUCT_ID, PRODUCT_NAME } from "@ttasks/brand";
import { PROTOCOL } from "@ttasks/bridge/protocol";
import { LATER_PREFERENCES } from "@ttasks/contracts";
import {
  configRefusal,
  fatalProblems,
  loadMachineConfig,
  unsafeConfigMessage,
} from "@ttasks/service/config";
import {
  canonicalStatePath,
  hostFacts,
  installId,
  resolveLayout,
  runtimeNames,
  type Layout,
} from "@ttasks/service/paths";
import {
  isPrivateDir,
  judgePath,
  socketBlock,
  socketBlockedMessage,
  unsafeMessage,
  type UnsafeThing,
} from "@ttasks/service/permissions";
import type { ServiceContext } from "@ttasks/service/install";
import type { GateFacts } from "@ttasks/service/runtime-gate";
import type { VersionManifest } from "@ttasks/service/version-folder";
import { CLI_SPEC, type Globals } from "./args.ts";
import {
  alive,
  CLI_BUILD,
  connectService,
  readServiceRecord,
  stateDir,
  type ConnectOptions,
  type Session,
} from "./connect.ts";
import { readAccounts, type AccountFacts } from "./accounts.ts";
import { accountsCheck, httpCheck, type HttpStatusView } from "./doctor-http.ts";
import type { Io } from "./io.ts";
import { migratedLine, migratedSince, type Migrated } from "./migrations.ts";
import { bodyOf, printUsage, RESTART_HINT } from "./output.ts";
import type { AgentsSetupOptions } from "./setup-agents.ts";
import { asAppError } from "./verbs.ts";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface Check {
  readonly id: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

const DAY = 86_400_000;

/** ttasksw.exe's record that it gave up restarting the service (A2 3.3.2), in `<state>/crash`. */
const SUPERVISOR_RECORD = "supervisor-gave-up.json";

/**
 * A successful start keeps an old give-up record (A2 3.3.2), so it is reported only when it is
 * newer than the running service's start, or when no service runs.
 */
function supervisorCheck(state: string, crash: string): Check {
  let t: number;
  try {
    const record = JSON.parse(readFileSync(join(crash, SUPERVISOR_RECORD), "utf8")) as Record<
      string,
      unknown
    >;
    const value = record["t"];
    t = typeof value === "number" ? value : Date.parse(String(value));
  } catch {
    return { id: "supervisor", status: "ok", detail: "The supervisor has not given up." };
  }
  const startedAt = readServiceRecord(state)?.started_at;
  const started = typeof startedAt === "string" ? Date.parse(startedAt) : Number.NaN;
  if (!Number.isNaN(started) && !(t > started)) {
    return {
      id: "supervisor",
      status: "ok",
      detail: "An older give-up record; the service started since.",
    };
  }
  return {
    id: "supervisor",
    status: "warn",
    detail: "The supervisor gave up restarting the service. Start it with: ttasks service start",
  };
}

function readJsonLines(path: string): Record<string, unknown>[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function countBy(values: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].map(([k, n]) => `${k} ${String(n)}`).join(", ");
}

/**
 * machine.toml (A2 3.2.4) read as the service reads it at its start: what would refuse the start
 * fails here with the same words, the fix included (a file or folder another user could change).
 * Problems that drop only their entry are a warning. Keys and codes only, never a value.
 */
export function configCheck(io: Pick<Io, "env" | "platform">): Check {
  let dir: string;
  try {
    dir = resolveLayout(hostFacts(io.env, io.platform)).config;
  } catch {
    return { id: "config", status: "fail", detail: "The configuration folder cannot be found." };
  }
  const loaded = loadMachineConfig(dir, io.platform);
  // Before the missing file: a config folder that fails the rule fails here before machine.toml
  // exists too, as it refuses the service's start.
  if (loaded.unsafe !== undefined) {
    return { id: "config", status: "fail", detail: unsafeConfigMessage(loaded.unsafe) };
  }
  if (!loaded.present) {
    return { id: "config", status: "ok", detail: "No machine.toml: the defaults apply." };
  }
  const fatal = fatalProblems(loaded.problems);
  if (fatal.length > 0) return { id: "config", status: "fail", detail: configRefusal(fatal) };
  const retired = loaded.problems.filter((p) => p.code === "retired");
  const notRead = loaded.problems.filter((p) => p.code === "not_read");
  const others = loaded.problems.filter((p) => p.code !== "retired" && p.code !== "not_read");
  if (loaded.problems.length > 0) {
    const keys = others.map((p) => (p.key === "" ? p.code : `${p.key} (${p.code})`));
    const parts = [
      ...(keys.length === 0
        ? []
        : [`machine.toml has problems that drop only their entry: ${named(keys)}.`]),
      ...(retired.length === 0
        ? []
        : [
            `machine.toml's [roots] lines do nothing now: a task opens in its own folder or its project's. ${PRODUCT_NAME} leaves them as they are, and you can remove them.`,
          ]),
      ...notRead.map((p) => notReadNote(p.key.slice("preferences.".length))),
    ];
    return { id: "config", status: "warn", detail: parts.join(" ") };
  }
  return { id: "config", status: "ok", detail: "machine.toml is valid." };
}

/** What a person reads about a machine preference this build does not read yet, and what holds. */
function notReadNote(key: string): string {
  const inForce = LATER_PREFERENCES.find((later) => later.key === key)?.inForce;
  const holds =
    typeof inForce === "string"
      ? `: ${inForce}`
      : ` (in force: ${JSON.stringify(inForce ?? null)})`;
  return `machine.toml sets ${key}, which this build does not read yet, so it changes nothing${holds}.`;
}

/** The checks that need no service. */
function localChecks(io: Io, layout: Layout, now: number): Check[] {
  const checks: Check[] = [];
  const state = layout.state;
  // The data folder is hidden (`~/.ttasks`), so the row says where it is (A2 3.13).
  const where = `Data and configuration are in ${layout.data}.`;
  if (!existsSync(state)) {
    checks.push({
      id: "paths",
      status: "fail",
      detail: `${where} The state folder does not exist yet: start the service once.`,
    });
    return checks;
  }
  if (io.platform === "win32") {
    checks.push({
      id: "paths",
      status: "ok",
      detail: `${where} The state folder exists. Its ACL is not checked by this build.`,
    });
  } else {
    // The service's own rule (permissions.ts), over the same folders: what refuses its start fails
    // here, with the one command that fixes all of it. The log and crash folders are judged when
    // they are there; inside a state folder this user cannot look into, they are named as unseen.
    const failed: { thing: UnsafeThing; hidden: string[] }[] = [];
    for (const [dir, name] of [
      [state, "The state folder"],
      [layout.logs, "The log folder"],
      [layout.crash, "The crash folder"],
    ] as const) {
      const judged = judgePath(dir, "folder", { followLink: true });
      if (judged === "unseen") {
        failed.find((f) => dir.startsWith(`${f.thing.facts.path}/`))?.hidden.push(name);
      } else if (judged !== undefined) {
        failed.push({ thing: { name, ...judged }, hidden: [] });
      }
    }
    checks.push(
      failed.length === 0
        ? {
            id: "paths",
            status: "ok",
            detail: `${where} No other user can change the state folder.`,
          }
        : {
            id: "paths",
            status: "fail",
            detail: `${where} ${unsafeMessage(
              failed.map(({ thing, hidden }) =>
                hidden.length === 0 ? thing : { ...thing, hides: hidden.join(" and ") },
              ),
              `Whoever can change ${failed.length > 1 ? "them" : "it"} could change what the service records and runs, so the service does not start`,
            )}`,
          },
    );
  }
  const installFile = join(state, "install.json");
  if (existsSync(installFile)) {
    let recorded: unknown;
    try {
      recorded = (JSON.parse(readFileSync(installFile, "utf8")) as Record<string, unknown>)[
        "install_id"
      ];
    } catch {
      recorded = undefined;
    }
    const computed = installId(canonicalStatePath(realpathSync.native(state), io.platform));
    checks.push(
      recorded === computed
        ? { id: "install", status: "ok", detail: `Install ID ${computed}.` }
        : {
            id: "install",
            status: "fail",
            detail: "install.json names another install ID: run ttasks service install again.",
          },
    );
    checks.push(updateCheck(state, installFile));
  } else {
    checks.push({
      id: "install",
      status: "skip",
      detail: "No install.json: a source or test install.",
    });
  }
  const crashDir = layout.crash;
  const recent: string[] = [];
  if (existsSync(crashDir)) {
    for (const name of readdirSync(crashDir)) {
      if (name === SUPERVISOR_RECORD) continue;
      const path = join(crashDir, name);
      try {
        if (now - statSync(path).mtimeMs > 7 * DAY) continue;
        const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        const event = record["event"];
        recent.push(typeof event === "string" && /^[a-z_.]{1,40}$/.test(event) ? event : "report");
      } catch {
        recent.push("report");
      }
    }
  }
  checks.push(
    recent.length === 0
      ? { id: "crashes", status: "ok", detail: "No crash files in the last 7 days." }
      : {
          id: "crashes",
          status: "warn",
          detail: `Crash files in the last 7 days: ${countBy(recent)}.`,
        },
  );
  const errors = readJsonLines(join(layout.logs, "service.log")).filter((e) => {
    const t = Date.parse(String(e["t"]));
    return (e["lvl"] === "error" || e["lvl"] === "warn") && now - t <= DAY;
  });
  checks.push(
    errors.length === 0
      ? { id: "logs", status: "ok", detail: "No errors or warnings in the last 24 hours." }
      : {
          id: "logs",
          status: errors.some((e) => e["lvl"] === "error") ? "warn" : "ok",
          detail: `Errors and warnings in the last 24 hours: ${countBy(errors.map((e) => String(e["ev"])))}.`,
        },
  );
  return checks;
}

interface Status {
  state?: string;
  version?: string;
  build?: string;
  uptime_ms?: number;
  protocol?: { min?: number; max?: number };
  http?: HttpStatusView | null;
  runs?: { available: boolean | null; reason?: string; message?: string };
  spaces?: {
    entry: number;
    id?: string;
    name?: string;
    state: string;
    reason?: string;
    holder?: unknown;
    /** What happened and what to run, when the space is not open for writing. */
    message?: string;
    migrated?: Migrated;
    /** An open space whose backups are not working: what happened and what to do. */
    backup?: { why?: string; message?: string };
  }[];
}

/**
 * The request path, end to end: `op/list` names the entry of every verb this CLI has, and
 * `space.status` answers through `op/call` for each served space, so a service whose status
 * answers while its operations fail does not pass. One folder serves a space at a time, so each
 * space is asked once by its ID. With no space served, op/call must still answer with A3's body for
 * a space it does not serve. Only codes reach the detail, never a result.
 */
export async function requestCheck(session: Session, spaces: Status["spaces"]): Promise<Check> {
  const ask = (space: string | undefined): Promise<unknown> =>
    session.call(
      "op/call",
      { op: "space.status", input: {}, ...(space === undefined ? {} : { space }) },
      { timeoutMs: 10_000 },
    );
  try {
    const listed = (await session.call("op/list", {}, { timeoutMs: 10_000 })) as {
      entries?: { name?: unknown }[];
    };
    const names = new Set((listed.entries ?? []).map((entry) => entry.name));
    const missing = CLI_SPEC.verbs.filter((verb) => !names.has(verb.entry)).map((v) => v.verb);
    if (missing.length > 0) {
      return {
        id: "requests",
        status: "fail",
        detail: `The service has no operation for ttasks ${missing.join(", ")}. ${RESTART_HINT}`,
      };
    }
    const served = (spaces ?? []).filter(
      (s) => (s.state === "open" || s.state === "read_only") && s.id !== undefined,
    );
    if (served.length === 0) {
      const code = await ask(undefined).then(
        () => "answered",
        (error: unknown) => bodyOf(asAppError(error)).code,
      );
      return code === "answered" || code === "space_unavailable" || code === "invalid_input"
        ? { id: "requests", status: "ok", detail: "No space is served; op/call answered." }
        : { id: "requests", status: "fail", detail: `op/call failed: ${code}.` };
    }
    // Copies of one space share its ID, which names the copy A2 3.10.5's rule picks: each space
    // is asked once, by its ID.
    const ids = [...new Set(served.map((space) => space.id))];
    for (const id of ids) await ask(id);
    return {
      id: "requests",
      status: "ok",
      detail: `Every verb has its operation; space.status answered for ${String(ids.length)} space(s).`,
    };
  } catch (error) {
    return {
      id: "requests",
      status: "fail",
      detail: `A request through the service failed: ${bodyOf(asAppError(error)).code}.`,
    };
  }
}

/**
 * What stands where a stopped service's socket goes (Linux and macOS), which keeps it from
 * starting: anything but nothing or a socket nobody answers on.
 */
async function socketBlocked(
  io: Pick<Io, "env" | "platform">,
  layout: Layout,
  state: string,
): Promise<string | undefined> {
  if (io.platform === "win32") return undefined;
  try {
    const id = installId(canonicalStatePath(realpathSync.native(state), io.platform));
    const plan = runtimeNames(layout, id, hostFacts(io.env, io.platform), isPrivateDir).endpoint;
    if (plan.kind !== "unix") return undefined;
    const block = await socketBlock(plan.path);
    return block === undefined ? undefined : socketBlockedMessage(plan.path, block);
  } catch {
    // A state folder that cannot be read is the paths row's to report.
    return undefined;
  }
}

/** The checks that talk to the service. */
async function serviceChecks(
  io: Io,
  state: string,
  layout: Layout,
  connect: ConnectOptions,
  live: boolean,
): Promise<Check[]> {
  // The launch rows and the sessions row (A3 3.14), loaded only here, like the agent side.
  const launch = await import("./doctor-launch.ts");
  const record = readServiceRecord(state);
  if (record === undefined) {
    const blocked = await socketBlocked(io, layout, state);
    return [
      {
        id: "service",
        status: "fail",
        detail:
          blocked === undefined
            ? "Not running. Start it with: ttasks service start"
            : `Not running. ${blocked}`,
      },
      { id: "endpoint", status: "skip", detail: "No service to reach." },
      { id: "spaces", status: "skip", detail: "No service to ask." },
      { id: "requests", status: "skip", detail: "No service to ask." },
      { id: "http", status: "skip", detail: "No service to ask." },
      { id: "runs", status: "skip", detail: "No service to ask." },
      ...launch.LAUNCH_ROWS_WITHOUT_SERVICE,
      { id: "monitor", status: "skip", detail: "No service to ask." },
    ];
  }
  let session: Session | undefined;
  try {
    session = await connectService(io, connect);
    const status = (await session.call("service/status", {}, { timeoutMs: 10_000 })) as Status;
    const checks: Check[] = [];
    const sameBuild = status.version === CLI_BUILD.version && status.build === CLI_BUILD.build;
    const range = status.protocol;
    const speaks =
      range !== undefined && (range.min ?? 0) <= PROTOCOL && PROTOCOL <= (range.max ?? 0);
    checks.push({
      id: "service",
      status: !speaks ? "fail" : sameBuild ? "ok" : "warn",
      detail: `Running ${String(status.version)} (${String(status.build)}), up ${String(Math.round((status.uptime_ms ?? 0) / 1000))} s, protocol ${String(range?.min)}-${String(range?.max)}${sameBuild ? "." : `; this CLI is ${CLI_BUILD.version} (${CLI_BUILD.build}). ${RESTART_HINT}`}`,
    });
    checks.push({ id: "endpoint", status: "ok", detail: "The handshake verified with ipc.key." });
    const spaces = status.spaces ?? [];
    // A space the person closed is as they left it, not a problem. One whose backups are not
    // working is.
    const bad = spaces.filter(
      (s) =>
        (s.state !== "open" && s.state !== "read_only" && s.state !== "closed") ||
        s.backup !== undefined,
    );
    // A space's way out names `<folder>`, which ttasks space list shows: this row holds no path.
    const folders = spaces.some(
      (s) =>
        s.message?.includes("<folder>") === true ||
        s.backup?.message?.includes("<folder>") === true,
    )
      ? " Run ttasks space list to see each space's folder."
      : "";
    // What this run of the service migrated: an update shows here until the next restart.
    const started = Date.now() - (status.uptime_ms ?? 0);
    checks.push({
      id: "spaces",
      status: bad.length > 0 ? "warn" : "ok",
      detail:
        spaces.length === 0
          ? "No spaces."
          : spaces
              .map((s) => {
                const name = s.name ?? s.id ?? `entry ${String(s.entry)}`;
                const reason = s.reason === undefined ? "" : ` (${s.reason})`;
                const message = s.message === undefined ? "" : `. ${s.message}`;
                const migrated =
                  s.migrated !== undefined && migratedSince(s.migrated, started)
                    ? `. ${migratedLine(s.migrated)}`
                    : "";
                const backup = s.backup?.message === undefined ? "" : `. ${s.backup.message}`;
                return `${name}: ${s.state}${reason}${message}${migrated}${backup}`;
              })
              .join("; ") + folders,
    });
    checks.push(await requestCheck(session, spaces));
    checks.push(await httpCheck(status.http, io.platform, io.env));
    checks.push(runsCheck(status.runs));
    checks.push(...(await launch.launchChecks(session, live)));
    return checks;
  } catch (error) {
    const body = bodyOf(asAppError(error));
    const given = body.data?.["reason"];
    const reason = typeof given === "string" ? given : body.code;
    // A record a crash or a restore left: its process is gone, so what answers at the socket's
    // path is not this service.
    const blocked = alive(record.pid) ? undefined : await socketBlocked(io, layout, state);
    return [
      {
        id: "service",
        status: "fail",
        detail: blocked === undefined ? body.message : `${body.message} ${blocked}`,
      },
      {
        id: "endpoint",
        status: "fail",
        detail:
          reason === "untrusted_endpoint"
            ? "The endpoint failed the handshake. Nothing was sent to it."
            : `Not reachable (${reason}).`,
      },
      { id: "spaces", status: "skip", detail: "No service to ask." },
      { id: "requests", status: "skip", detail: "No service to ask." },
      { id: "http", status: "skip", detail: "No service to ask." },
      { id: "runs", status: "skip", detail: "No service to ask." },
      ...launch.LAUNCH_ROWS_WITHOUT_SERVICE,
      { id: "monitor", status: "skip", detail: "No service to ask." },
    ];
  } finally {
    session?.close();
  }
}

/**
 * Whether background runs get a process group here, as the service found at its start. Runs start
 * either way; where a person can give them one (an earlier unit without Delegate=yes, a missing
 * ttasks-run.exe), a warning with what to do; on a platform without process groups, only a note.
 */
function runsCheck(runs: Status["runs"]): Check {
  if (runs === undefined || runs.available === null) {
    return { id: "runs", status: "skip", detail: "The service has not checked yet." };
  }
  if (runs.available) {
    return { id: "runs", status: "ok", detail: "Background runs each get a process group here." };
  }
  return {
    id: "runs",
    status: runs.reason === "unsupported_platform" ? "skip" : "warn",
    detail:
      `Background runs get no process group here, so Stop ends what ${PRODUCT_NAME} can find of a run. ${runs.message ?? ""}`.trimEnd(),
  };
}

const VERSION_WORD = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

/**
 * The update row (A2 3.12.6, 3.13): an update journal means an update runs now or was cut off,
 * which the service or `ttasks update --repair` finishes; else the last update's outcome from
 * install.json, a rolled-back one with its reason.
 */
function updateCheck(state: string, installFile: string): Check {
  if (existsSync(join(state, "update.json"))) {
    return {
      id: "update",
      status: "warn",
      detail:
        "An update is running, or one was cut off: the service finishes it, or ttasks update --repair does.",
    };
  }
  let last: Record<string, unknown> | undefined;
  try {
    const value = (JSON.parse(readFileSync(installFile, "utf8")) as Record<string, unknown>)[
      "last_update"
    ];
    last =
      typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    last = undefined;
  }
  const word = (value: unknown) =>
    typeof value === "string" && VERSION_WORD.test(value) ? value : "?";
  if (last?.["outcome"] === "reverted") {
    const reason =
      typeof last["reason"] === "string" && /^[a-z_]{1,40}$/.test(last["reason"])
        ? last["reason"]
        : "failed";
    return {
      id: "update",
      status: "warn",
      detail: `The last switch to ${word(last["to"])} was rolled back (${reason}): ${word(last["from"])} stayed current.`,
    };
  }
  if (last?.["outcome"] === "completed") {
    return {
      id: "update",
      status: "ok",
      detail: `The last switch made ${word(last["to"])} current (from ${word(last["from"])}).`,
    };
  }
  return { id: "update", status: "ok", detail: "No update has run in this install." };
}

/** At most this many problems are named in one row. */
const NAMED = 5;

const named = (problems: readonly string[]): string =>
  `${problems.slice(0, NAMED).join("; ")}${problems.length > NAMED ? `; and ${String(problems.length - NAMED)} more` : ""}`;

/**
 * The version folder's rows (A2 3.13): integrity, and the runtime gate of A2 3.12.1 against the
 * manifest's pins. Both load their modules only here: the gate loads storage's start-up check,
 * which probes in-memory databases only, and nothing else of the CLI needs either.
 */
export async function versionChecks(
  io: Io,
  versionFolder: string | undefined,
  gateFacts?: GateFacts,
): Promise<Check[]> {
  if (versionFolder === undefined) {
    return [
      {
        id: "integrity",
        status: "skip",
        detail: "Run from source: there is no version folder to check.",
      },
      {
        id: "runtime",
        status: "skip",
        detail: "Run from source: the build runs the runtime gate in each version folder.",
      },
    ];
  }
  const folder = await import("@ttasks/service/version-folder");
  let manifest: VersionManifest;
  try {
    manifest = folder.readVersionManifest(versionFolder);
  } catch (error) {
    const detail = error instanceof folder.ManifestError ? error.message : "unreadable";
    return [
      { id: "integrity", status: "fail", detail: `This version folder's ${detail}.` },
      { id: "runtime", status: "fail", detail: "No manifest.json names the runtime to expect." },
    ];
  }
  const problems = [
    ...folder.checkVersionFolder(versionFolder),
    ...folder.checkInstallAround(versionFolder, io.platform),
  ];
  const integrity: Check =
    problems.length === 0
      ? {
          id: "integrity",
          status: "ok",
          detail: `Every file of ${manifest.version} (${manifest.build}, ${manifest.platform}) matches manifest.json.`,
        }
      : { id: "integrity", status: "fail", detail: `${named(problems)}.` };
  const { runtimeGate } = await import("@ttasks/service/runtime-gate");
  const gate = await runtimeGate({ node: manifest.node, sqlite: manifest.sqlite }, gateFacts);
  const failed = gate.filter((check) => !check.ok);
  const runtime: Check =
    failed.length === 0
      ? { id: "runtime", status: "ok", detail: gate.map((check) => check.detail).join(" ") }
      : { id: "runtime", status: "fail", detail: failed.map((check) => check.detail).join(" ") };
  return [integrity, runtime];
}

/**
 * The candidate's checks of A2 3.12.6, handed to M1.14: a temporary space, a
 * temporary endpoint with a handshake, and this version's own bridge answering tools/list, each in
 * a folder of its own below `<state>/tmp/`. They run with `--self-test` from a version folder:
 * `ttasks install --finish` runs them before it switches current, and the build's gate runs them in
 * every folder it makes. From source there is no version to check.
 */
export async function candidateRows(
  io: Io,
  versionFolder: string | undefined,
  selfTest: boolean,
  state: string = stateDir(io),
): Promise<Check[]> {
  if (!selfTest) {
    return [
      {
        id: "candidate",
        status: "skip",
        detail: "ttasks doctor --self-test runs the candidate checks.",
      },
    ];
  }
  if (versionFolder === undefined) {
    return [
      {
        id: "candidate",
        status: "skip",
        detail: "Run from source: the candidate checks run in a version folder.",
      },
    ];
  }
  const folder = await import("@ttasks/service/version-folder");
  let manifest: VersionManifest;
  try {
    manifest = folder.readVersionManifest(versionFolder);
  } catch {
    return [{ id: "candidate", status: "fail", detail: "No manifest.json names this version." }];
  }
  const { candidateChecks } = await import("@ttasks/service/candidate");
  return candidateChecks({
    state,
    build: { version: manifest.version, build: manifest.build },
    // This version's runtime and entry, with the flag its launchers pass (A2 3.12.3): the bridge
    // runs in a home of its own, which a launcher would replace with the install root.
    entry: [
      process.execPath,
      "--report-exclude-env",
      join(versionFolder, "lib", `${PRODUCT_ID}.mjs`),
    ],
    offline: join(versionFolder, "lib", "mcp-offline.json"),
    env: io.env,
  });
}

/** Whether the service starts by itself, as `ttasks service status` says it (autostartStatus). */
async function autostartCheck(io: Io, connect: DoctorOptions): Promise<Check> {
  const install = await import("@ttasks/service/install");
  try {
    const ctx = (
      connect.serviceContext ?? (() => install.defaultServiceContext({ env: io.env }))
    )();
    const { starts } = await install.autostartStatus(ctx);
    return {
      id: "autostart",
      status: starts.on === true ? "ok" : "warn",
      detail: install.autostartLine(starts),
    };
  } catch {
    return {
      id: "autostart",
      status: "warn",
      detail: `Whether the service starts by itself could not be read. Run: ${CLI_NAME} service status`,
    };
  }
}

export interface DoctorOptions extends ConnectOptions {
  /** Tests only: the service install's stand-ins, so `ttasks service` and doctor reach no real entry. */
  readonly serviceContext?: () => ServiceContext;
  /** The machine's accounts. Tests inject them: the real read is accounts.ts readAccounts. */
  readonly accounts?: () => AccountFacts | undefined;
  /** Tests only: the agent environment and home the agent checks read (doctor-agents.ts). */
  readonly agents?: AgentsSetupOptions;
}

export async function doctor(
  io: Io,
  globals: Globals,
  args: readonly string[],
  connect: DoctorOptions & { readonly versionFolder?: string },
  now: number = Date.now(),
): Promise<number> {
  const unknown = args.filter((a) => a !== "--self-test" && a !== "--live");
  if (unknown.length > 0) {
    return printUsage(io, globals.json, "ttasks doctor takes --self-test, --live and --json only");
  }
  // stateDir names a layout that cannot be resolved; past it, the layout is this install's.
  const state = stateDir(io);
  const layout = resolveLayout(hostFacts(io.env, io.platform));
  // The OS's account list can take seconds on a slow machine: it is read while the other rows run.
  const accounts =
    connect.accounts === undefined
      ? readAccounts(io.platform, io.env, io.cwd).catch(() => undefined)
      : Promise.resolve(connect.accounts());
  const before = [
    ...localChecks(io, layout, now),
    configCheck(io),
    ...(await versionChecks(io, connect.versionFolder)),
  ];
  const after = [
    ...(io.platform === "win32" ? [supervisorCheck(state, layout.crash)] : []),
    ...(await serviceChecks(io, state, layout, connect, args.includes("--live"))),
    ...(await candidateRows(io, connect.versionFolder, args.includes("--self-test"), state)),
    // The agent side, loaded only here: it loads setup's engine.
    ...(await (
      await import("./doctor-agents.ts")
    ).agentChecks(io, state, args.includes("--live"), connect)),
    await autostartCheck(io, connect),
  ];
  const checks = [...before, accountsCheck(await accounts), ...after];
  const failed = checks.some((c) => c.status === "fail");
  if (globals.json) {
    io.stdout(`${JSON.stringify({ ok: !failed, checks })}\n`);
  } else {
    for (const check of checks)
      io.stdout(`${check.status.padEnd(4)}  ${check.id}: ${check.detail}\n`);
  }
  return failed ? 1 : 0;
}
