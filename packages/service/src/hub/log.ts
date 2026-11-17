// The service log, `<state>/logs/service.log` (A2 3.13): JSON lines, rotated at 5 MB, 5 files kept.
//
// Content-free by construction. A caller names an event from the fixed catalogue below and passes
// fields that the catalogue declares, and every field value must be a number, a boolean, a word
// from a closed list, or an ID of a fixed shape. The log checks this again at run time, so a value
// cast past the types is dropped, never written: no path, task text, prompt, token, key or
// environment value can reach the file, because no field accepts free text. Unknown events and
// unknown fields are dropped too. Debug adds events, never content.
//
// Names that look like code are not trusted for their shape: JavaScript names a function or a
// class after the computed key it is stored under, and any code can set an error's `code`. So an
// error's code and class are words from closed lists (libuv's error names, the Node codes below,
// storage's codes; the built-in and Tasks error classes), never "anything shaped like one".
//
// Several processes may append (a second start logs why it exits). Only the process that holds
// service.lock rotates, so a second start never moves the running service's file. The holder
// rotates on the file's real size, which counts the lines of second starts too, and a second
// start does not append to a full file, so the file stays bounded while the holder is idle.
import { existsSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { getSystemErrorMap } from "node:util";
import { CLIENT_KINDS, MODES } from "@tasks/bridge/protocol";
import {
  ATTEMPT_RESULTS,
  HOST_REFUSALS,
  OPEN_RESULTS,
  PROBLEM_CODES,
  RESOLVE_REASONS,
  SNAPSHOT_OUTCOMES,
  TERMINAL_APPS,
  TERMINAL_SOURCES,
} from "@tasks/launch";
import { RUN_ADAPTERS, RUN_REASONS, RUN_STATES } from "@tasks/contracts/runs";
import { ID_ALPHABET, STORAGE_ERROR_CODES } from "@tasks/storage";
import { SECTIONS } from "../config/section-names.ts";
import { UNAVAILABLE_REASONS } from "../launch/open.ts";
import {
  BIND_REFUSALS,
  CONNECTION_CLASSES,
  HANDSHAKE_FAILURES,
  HANDSHAKE_STAGES,
  RPC_METHODS,
} from "../local/index.ts";
import {
  ENTRY_NAMES,
  HTTP_CLASSES,
  METHODS,
  PORT_OUTCOMES,
  REFUSALS as HTTP_REFUSALS,
  ROUTES,
  WS_CLOSES,
} from "../http/events.ts";
import { CLOSE_REASONS, REFUSE_REASONS, TOOL_NAMES } from "../mcp/endpoint.ts";
import { IGNORED } from "../binding/bindings.ts";
import { VIA } from "../binding/sessions.ts";
import { AGENT_APPS } from "../setup/state.ts";
import { REFUSALS } from "./exit.ts";
import { appendPrivate, makeDir } from "./files.ts";
import { isInstallId } from "./paths.ts";

export const LOG_FILE = "service.log";
/** A2 3.13: rotated at 5 MB. */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
/** A2 3.13: 5 files kept, the live one included. */
export const LOG_FILES_KEPT = 5;
/** A2 3.13: a crash file holds the last 200 log lines. */
export const RECENT_LINES = 200;

export type Level = "debug" | "info" | "warn" | "error";
const LEVELS: readonly Level[] = ["debug", "info", "warn", "error"];

/** How a field's value is checked. A list is a closed set of words. */
export type FieldKind =
  | "int"
  | "bool"
  /** A space ID, `sp_` and 26 characters of A1's alphabet. */
  | "space"
  /** A service instance ID: 32 lowercase hex characters. */
  | "instance"
  | "install"
  /** An app version, `major.minor.patch` with an optional short suffix. */
  | "version"
  /** A build label: a short token of letters, digits, dots and dashes. */
  | "build"
  /** An error class from ERROR_TYPES, such as `TypeError`. */
  | "error_type"
  /** An error code: a libuv error name, a Node code from NODE_ERROR_CODES or a storage code. */
  | "error_code"
  | readonly string[];

interface Spec {
  readonly lvl: Level;
  /** The component. */
  readonly c: "hub" | "space" | "local" | "http" | "mcp" | "launch";
  readonly fields: Readonly<Record<string, FieldKind>>;
}

/** tasks-local/1's words (M1.09): each a closed list of the library's. */
const RPC_METHOD_NAMES: readonly string[] = Object.keys(RPC_METHODS);

export const MANAGERS = ["systemd", "launchd", "tasksw", "manual"] as const;
export type Manager = (typeof MANAGERS)[number];

/** Why a space is unavailable or read-only (A2 3.1, and A1 3.18's read-only states). */
export const SPACE_REASONS = [
  "missing",
  "locked_elsewhere",
  "format_too_new",
  "network_filesystem",
  "not_authority",
  "open_failed",
  "linked_database",
  "needs_recovery",
  "read_only_copy",
  "migration_failed",
  /** The folder holds another space than its `[[spaces]]` entry's ID names (review R2-5). */
  "other_space",
  /** In a synced folder the person has not confirmed is excluded from sync (A1 3.2). */
  "synced_folder",
  /** A sync signal was found and PRAGMA quick_check failed: never written (A1 3.2). */
  "check_failed",
] as const;
export type SpaceReason = (typeof SPACE_REASONS)[number];

/** The terminal adapters' names (machine.toml's apps without `auto`). */
const TERMINAL_ADAPTERS: readonly string[] = TERMINAL_APPS.filter((app) => app !== "auto");

/** Why a pairing with T3 did not finish (tasks setup t3, hub/t3.ts): a closed list. */
export const T3_PAIR_FAILURES = [
  "t3_not_running",
  "denied",
  "timed_out",
  "cancelled",
  "unsupported",
  "t3_error",
  "unsafe_state",
] as const;
export type T3PairFailure = (typeof T3_PAIR_FAILURES)[number];

/** Why runs cannot be contained (packages/runs: UnavailableReason). */
const UNAVAILABLE_RUN_REASONS = [
  "unsupported_platform",
  "no_systemd",
  "no_cgroup_v2",
  "no_user_manager",
  "not_a_service",
  "not_delegated",
  "no_cgroup_kill",
  "helper_missing",
  "check_failed",
] as const;
/** Every event the service can log. A new event is a new entry here, reviewed as such. */
export const EVENTS = {
  "service.starting": {
    lvl: "info",
    c: "hub",
    fields: { manager: MANAGERS, version: "version", build: "build", separate: "bool" },
  },
  "service.refused": { lvl: "error", c: "hub", fields: { reason: REFUSALS } },
  "service.locked": { lvl: "warn", c: "hub", fields: { holder: "int" } },
  "service.lock_failed": { lvl: "error", c: "hub", fields: { code: STORAGE_ERROR_CODES } },
  "service.lock_acquired": { lvl: "debug", c: "hub", fields: { ms: "int" } },
  "service.key_created": {
    lvl: "info",
    c: "hub",
    fields: { reason: ["missing", "invalid", "not_private"] },
  },
  "service.machine_created": { lvl: "info", c: "hub", fields: {} },
  "service.stale_removed": {
    lvl: "info",
    c: "hub",
    fields: { what: ["socket", "temp_file"], count: "int" },
  },
  "service.endpoint_retry": {
    lvl: "warn",
    c: "hub",
    fields: { attempt: "int", code: "error_code" },
  },
  "service.endpoint_bound": {
    lvl: "info",
    c: "hub",
    fields: { kind: ["unix", "pipe"], runtime: ["run-user", "state", "pipe"], attempts: "int" },
  },
  "service.ready": {
    lvl: "info",
    c: "hub",
    fields: { ms: "int", install: "install", instance: "instance" },
  },
  "service.stopping": {
    lvl: "info",
    c: "hub",
    fields: {
      reason: ["signal", "request", "ownership_lost", "start_failed"],
      restart: "bool",
    },
  },
  "service.drain_timeout": { lvl: "warn", c: "hub", fields: { stage: ["endpoint", "spaces"] } },
  "service.stopped": { lvl: "info", c: "hub", fields: { code: "int", ms: "int" } },
  "service.ownership_lost": {
    lvl: "error",
    c: "hub",
    fields: { what: ["missing", "replaced"], via: ["watch", "timer", "start", "drain"] },
  },
  "service.crashed": {
    lvl: "error",
    c: "hub",
    fields: { type: "error_type", code: "error_code" },
  },
  // A write applied and was answered as applied, but its answer does not match its entry's
  // contract: a defect in the service, named by the entry only.
  "service.result_mismatch": { lvl: "error", c: "hub", fields: { entry: ENTRY_NAMES } },
  "service.start_failed": {
    lvl: "error",
    c: "hub",
    fields: { type: "error_type", code: "error_code" },
  },
  // An interrupted update finished or rolled back by the service (A2 3.12.6, M6.12): versions only.
  "update.repaired": {
    lvl: "warn",
    c: "hub",
    fields: {
      outcome: ["rolled_forward", "rolled_back", "kept", "stuck"],
      from: "version",
      to: "version",
    },
  },
  "update.repair_failed": { lvl: "error", c: "hub", fields: { code: "error_code" } },
  /**
   * After a repair the service restarts: current names another version than it runs (`version`),
   * or the update changed the Windows supervisor it runs under, which then hands over
   * (`supervisor`).
   */
  "update.restart": {
    lvl: "warn",
    c: "hub",
    fields: { version: "version", why: ["version", "supervisor"] },
  },
  // machine.toml (A2 3.2.4): sections and codes only, never a key's text or a value.
  "config.problem": {
    lvl: "warn",
    c: "hub",
    fields: {
      section: [...SECTIONS, "file", "other"],
      code: PROBLEM_CODES,
      severity: ["error", "warning"],
    },
  },
  "config.loaded": {
    lvl: "info",
    c: "hub",
    fields: { present: "bool", spaces: "int", roots: "int", instances: "int", problems: "int" },
  },
  "config.roots_changed": { lvl: "info", c: "hub", fields: { changed: "int", reset: "bool" } },
  "config.roots_failed": { lvl: "warn", c: "hub", fields: { code: "error_code" } },
  // `tasks roots add` (M2.07): a root added to machine.toml, with its revision. No ID, no path.
  "config.root_added": { lvl: "info", c: "hub", fields: { rev: "int", runs: "bool" } },
  // `tasks setup instances`: [[instance]] entries written or taken out. Counts only, never an ID.
  "config.instances_changed": { lvl: "info", c: "hub", fields: { added: "int", removed: "int" } },
  // Make default or `tasks space use` (M5.01): the machine's default space changed. No ID.
  "config.default_space_set": { lvl: "info", c: "hub", fields: { source: ["ui", "cli"] } },
  // Settings (M5.11): a machine preference or Open's terminal changed. The key or adapter word only.
  "config.preference_set": {
    lvl: "info",
    c: "hub",
    fields: { key: ["ui.theme", "ui.single_keys"], reset: "bool" },
  },
  "config.terminal_set": { lvl: "info", c: "hub", fields: { app: ["auto", ...TERMINAL_ADAPTERS] } },
  // A space verb recorded what it did in [[spaces]] (space-records.ts), or could not. No ID, no path.
  "config.spaces_changed": { lvl: "info", c: "hub", fields: { enabled: "bool", edits: "int" } },
  // `tasks space forget` took a space's entry out of [[spaces]]. No ID, no path.
  "config.space_forgotten": { lvl: "info", c: "hub", fields: {} },
  "config.spaces_failed": {
    lvl: "warn",
    c: "hub",
    fields: {
      reason: [
        "invalid_file",
        "unsupported_layout",
        "exists",
        "absent",
        "invalid_value",
        "changed_meanwhile",
        "too_large",
        "unsafe",
        "other_space",
        "write_failed",
      ],
      code: "error_code",
    },
  },
  // `tasks setup t3` (M2.11): a pairing kept, or why it was not. Never a token, URL or ID.
  "setup.paired": { lvl: "info", c: "hub", fields: { replaced: "bool" } },
  "setup.pair_failed": { lvl: "warn", c: "hub", fields: { reason: T3_PAIR_FAILURES } },
  // `tasks setup agents` (M2.14): an agent-home row made (replacing an earlier one of the home) or
  // rows revoked. Never a path, an instance or an account.
  "setup.home_granted": { lvl: "info", c: "hub", fields: { app: AGENT_APPS, replaced: "bool" } },
  "setup.home_revoked": { lvl: "info", c: "hub", fields: { count: "int" } },
  "space.opening": { lvl: "info", c: "space", fields: { entry: "int" } },
  "space.restore_finished": {
    lvl: "warn",
    c: "space",
    fields: { entry: "int", swapped: "bool", carried: "int" },
  },
  // A migration still runs when the open's bound passes: the open waits for it.
  "space.migrating": { lvl: "info", c: "space", fields: { entry: "int", ms: "int" } },
  "space.migrated": {
    lvl: "info",
    c: "space",
    fields: { entry: "int", space: "space", from: "int", to: "int", steps: "int" },
  },
  "space.open": {
    lvl: "info",
    c: "space",
    fields: { entry: "int", space: "space", ms: "int", registered: "bool", migrated: "bool" },
  },
  "space.read_only": {
    lvl: "warn",
    c: "space",
    // `tried`, for migration_failed: whether this open tried the migration, or a failure this
    // build recorded on this state held it back (A1 3.17).
    fields: {
      entry: "int",
      space: "space",
      reason: SPACE_REASONS,
      code: "error_code",
      ms: "int",
      tried: "bool",
    },
  },
  "space.unavailable": {
    lvl: "warn",
    c: "space",
    fields: { entry: "int", space: "space", reason: SPACE_REASONS, code: "error_code" },
  },
  "space.maintained": {
    lvl: "info",
    c: "space",
    fields: {
      entry: "int",
      space: "space",
      leftovers: "int",
      backup: ["taken", "not_due"],
      removed: "int",
      unverified: "int",
      ms: "int",
    },
  },
  // The search index failed its check (at a writer's open, or in a backup's copy): made again
  // from the tasks, or still damaged.
  "space.search_index": {
    lvl: "warn",
    c: "space",
    fields: {
      entry: "int",
      space: "space",
      outcome: ["sound", "remade", "damaged"],
      code: "error_code",
    },
  },
  "space.maintenance_failed": {
    lvl: "warn",
    c: "space",
    fields: { entry: "int", space: "space", code: "error_code" },
  },
  // The projection (A1 3.13): counts, the watermark and codes, never a path (a file's name holds a
  // task's title).
  "space.projection_started": {
    lvl: "info",
    c: "space",
    fields: { entry: "int", space: "space", rebuild: "bool", recovered: "bool", temps: "int" },
  },
  "space.projected": {
    lvl: "debug",
    c: "space",
    fields: {
      entry: "int",
      space: "space",
      written: "int",
      removed: "int",
      failed: "int",
      watermark: "int",
      backlog: "bool",
      ms: "int",
    },
  },
  "space.projection_reconciled": {
    lvl: "info",
    c: "space",
    fields: {
      entry: "int",
      space: "space",
      full: "bool",
      checked: "int",
      queued: "int",
      forgotten: "int",
    },
  },
  "space.projection_rescued": {
    lvl: "warn",
    c: "space",
    fields: { entry: "int", space: "space", files: "int" },
  },
  // Not a file at the projection's record or journal path: moved aside beside it, never removed.
  "space.projection_state_moved_aside": {
    lvl: "warn",
    c: "space",
    fields: { entry: "int", space: "space", file: ["record", "journal"] },
  },
  "space.projection_failed": {
    lvl: "warn",
    c: "space",
    fields: { entry: "int", space: "space", code: "error_code" },
  },
  "space.ownership_lost": {
    lvl: "error",
    c: "space",
    fields: {
      entry: "int",
      space: "space",
      what: ["missing", "replaced"],
      via: ["watch", "timer", "start"],
    },
  },
  "space.closed": { lvl: "info", c: "space", fields: { entry: "int", space: "space", ms: "int" } },
  "space.close_failed": {
    lvl: "warn",
    c: "space",
    fields: { entry: "int", space: "space", code: "error_code" },
  },
  // tasks-local/1's events (A2 3.13), as the library reports them.
  "local.handshake_failed": {
    lvl: "info",
    c: "local",
    fields: { stage: HANDSHAKE_STAGES, reason: HANDSHAKE_FAILURES },
  },
  "local.bind_refused": { lvl: "warn", c: "local", fields: { reason: BIND_REFUSALS } },
  "local.bound": {
    lvl: "debug",
    c: "local",
    fields: {
      conn: "int",
      class: CONNECTION_CLASSES,
      mode: MODES,
      kind: CLIENT_KINDS,
      protocol: "int",
      ms: "int",
    },
  },
  "local.frame_too_large": { lvl: "warn", c: "local", fields: { conn: "int" } },
  "local.slow_reader": { lvl: "warn", c: "local", fields: { conn: "int" } },
  "local.handler_failed": {
    lvl: "error",
    c: "local",
    fields: { conn: "int", method: RPC_METHOD_NAMES },
  },
  "local.revoked": { lvl: "info", c: "local", fields: { conn: "int" } },
  "local.listen_error": { lvl: "error", c: "local", fields: { code: "error_code" } },
  // The UI's HTTP listener (A2 3.8.3 "Logging": method, route, status, duration, connection class;
  // never a path, query, header, body, token or code). Every word comes from http/events.ts.
  "http.request": {
    lvl: "info",
    c: "http",
    fields: {
      method: METHODS,
      route: ROUTES,
      status: "int",
      ms: "int",
      class: HTTP_CLASSES,
      entry: ENTRY_NAMES,
    },
  },
  "http.refused": {
    lvl: "info",
    c: "http",
    fields: { route: ROUTES, status: "int", reason: HTTP_REFUSALS },
  },
  "http.listening": {
    lvl: "info",
    c: "http",
    fields: { outcome: PORT_OUTCOMES, moved: "bool" },
  },
  "http.blocked": { lvl: "warn", c: "http", fields: { revoked: "int" } },
  "http.port_retry": {
    lvl: "info",
    c: "http",
    fields: { outcome: ["kept", "moved_back", "blocked"] },
  },
  "http.peer_refused": { lvl: "warn", c: "http", fields: { reason: ["other_user", "unknown"] } },
  "http.capacity": {
    lvl: "warn",
    c: "http",
    fields: { kind: ["unauthenticated", "total", "token"] },
  },
  "http.ws_closed": { lvl: "info", c: "http", fields: { reason: WS_CLOSES, ms: "int" } },
  "http.feed_failed": {
    lvl: "warn",
    c: "http",
    fields: { stage: ["snapshot", "batch", "poll"] },
  },
  "http.grants_failed": { lvl: "error", c: "http", fields: { stage: ["load", "write"] } },
  "http.holder_check_failed": {
    lvl: "warn",
    c: "http",
    fields: { os: ["linux", "windows", "macos"] },
  },
  "http.port_write_failed": {
    lvl: "error",
    c: "http",
    fields: { stage: ["sighting", "persist"] },
  },
  "http.launch_failed": { lvl: "error", c: "http", fields: { stage: ["dispatch"] } },
  // The MCP endpoint's events (M2.02): a connection, a tool of the generated list, fixed words.
  // Never a message, an argument or a result.
  "mcp.closed": { lvl: "warn", c: "mcp", fields: { conn: "int", reason: CLOSE_REASONS } },
  "mcp.refused": { lvl: "debug", c: "mcp", fields: { conn: "int", reason: REFUSE_REASONS } },
  "mcp.init_replayed": { lvl: "debug", c: "mcp", fields: { conn: "int" } },
  "mcp.tool_failed": { lvl: "error", c: "mcp", fields: { conn: "int", tool: TOOL_NAMES } },
  "mcp.offline_written": {
    lvl: "info",
    c: "mcp",
    fields: { result: ["written", "unsafe"], ms: "int" },
  },
  "mcp.offline_failed": {
    lvl: "warn",
    c: "mcp",
    fields: { type: "error_type", code: "error_code" },
  },
  // Session binding (A3 3.7, M2.04): how a connection bound, and why a bind frame's ticket or
  // handle was not used. Never a ticket, a handle, a native ID, a session, a task or a folder.
  "binding.bound": { lvl: "info", c: "mcp", fields: { via: [...VIA, "handle"] } },
  "binding.ignored": {
    lvl: "warn",
    c: "mcp",
    fields: { input: ["ticket", "handle"], reason: IGNORED },
  },
  "binding.lost": { lvl: "info", c: "mcp", fields: {} },
  // Two conversations through one connection (A3 3.7.5): its calls bind only by their own ID.
  "binding.shared": { lvl: "info", c: "mcp", fields: {} },
  "binding.report_failed": { lvl: "warn", c: "mcp", fields: {} },
  "binding.store_failed": { lvl: "error", c: "mcp", fields: {} },
  "binding.store_dropped": { lvl: "warn", c: "mcp", fields: { count: "int" } },
  // The launch shim's calls (A4 3.6.3): words and counts only, never a ticket, a credential, a
  // PID, a folder or anything of a plan.
  "launch.claimed": { lvl: "info", c: "launch", fields: {} },
  "launch.attached": { lvl: "info", c: "launch", fields: {} },
  "launch.refused": {
    lvl: "warn",
    c: "launch",
    fields: { method: ["claim", "attach", "report"], reason: HOST_REFUSALS },
  },
  "launch.recovered": {
    lvl: "info",
    c: "launch",
    fields: { space: "space", open: "int", ms: "int" },
  },
  // A launch's folder did not resolve at the click or right before the launch, or failed the
  // shim's check in it (A4 3.3): the reason word only, never a root, a path or a remote.
  "launch.folder_refused": {
    lvl: "warn",
    c: "launch",
    fields: { stage: ["open", "dispatch", "shim"], reason: RESOLVE_REASONS },
  },
  "launch.failed": {
    lvl: "warn",
    c: "launch",
    fields: {
      stage: ["recover", "sweep", "check", "dispatch", "match"],
      type: "error_type",
      code: "error_code",
    },
  },
  // Each terminal a launch tried (A4 3.6.2): the adapter, its kind and how it went, never its
  // argv, its program's path or the folder. The one Dispatched names why it was chosen.
  "launch.terminal": {
    lvl: "info",
    c: "launch",
    fields: {
      app: TERMINAL_ADAPTERS,
      kind: ["handoff", "direct", "shim"],
      result: ATTEMPT_RESULTS,
      error: "error_code",
      code: "int",
      scoped: "bool",
      source: TERMINAL_SOURCES,
    },
  },
  // The login-shell snapshot (A4 3.8): how it ended and how many names it found, never a name
  // or a value. `in_folder`: a via_login_shell launch's own snapshot, taken in its folder.
  "launch.env_snapshot": {
    lvl: "info",
    c: "launch",
    fields: {
      result: [...SNAPSHOT_OUTCOMES, "not_stored", "folder_changed"],
      ms: "int",
      variables: "int",
      previous: "bool",
      in_folder: "bool",
    },
  },
  "launch.env_registry": {
    lvl: "warn",
    c: "launch",
    fields: { result: ["done", "timeout", "too_large", "failed"], ms: "int" },
  },
  // A click that no route of its instance could take (A4 3.3 step 5, 3.15.3): the reason word,
  // never the instance's command, the task or its folder.
  "launch.unavailable": {
    lvl: "info",
    c: "launch",
    fields: { reason: UNAVAILABLE_REASONS },
  },
  // A link route's opener (A4 3.6.5): which opener and how it went, never the URL.
  "launch.opener": {
    lvl: "info",
    c: "launch",
    fields: {
      opener: ["rundll32", "explorer", "gio", "xdg-open", "open", "none"],
      result: OPEN_RESULTS,
    },
  },
  // A best-effort app's binding (A4 3.4.4, 3.4.5): whether the bridge's folder was the launch's,
  // never either folder.
  "launch.folder_check": {
    lvl: "info",
    c: "launch",
    fields: { result: ["same", "other", "unknown"] },
  },
  // Codex's reference match (A4 3.4.3): whether a native ID was found, never the ID or a path.
  "launch.native_id": {
    lvl: "info",
    c: "launch",
    fields: { source: ["reference_match"], result: ["matched", "none"] },
  },
  // Background runs: whether runs can be contained here, and each run's start and end by its
  // codes. Never a run's ID, request, answer, folder or command.
  "runs.probe": {
    lvl: "info",
    c: "launch",
    fields: { available: "bool", kind: ["cgroup", "job"], reason: UNAVAILABLE_RUN_REASONS },
  },
  "run.started": { lvl: "info", c: "launch", fields: { adapter: RUN_ADAPTERS } },
  "run.settled": {
    lvl: "info",
    c: "launch",
    fields: { state: RUN_STATES, reason: Object.values(RUN_REASONS).flat() },
  },
  "run.recovered": { lvl: "info", c: "launch", fields: { runs: "int" } },
  // A queued run that could no longer start, by why; run folders retention removed, by count; an
  // update's hold on new starts taken or let go.
  "run.refused": { lvl: "info", c: "launch", fields: { reason: RUN_REASONS.failed } },
  "run.removed": { lvl: "info", c: "launch", fields: { folders: "int" } },
  "runs.hold": { lvl: "info", c: "launch", fields: { held: "bool" } },
  "run.failed": {
    lvl: "warn",
    c: "launch",
    fields: {
      stage: [
        "probe",
        "prepare",
        "host",
        "started",
        "late_start",
        "answer",
        "evidence",
        "settle",
        "round",
        "read",
        "unstarted",
        "start",
        "stop_all",
        "retain",
        "remove",
      ],
      type: "error_type",
      code: "error_code",
    },
  },
} as const satisfies Readonly<Record<string, Spec>>;

export type EventName = keyof typeof EVENTS;

type ValueOf<K> = K extends "int"
  ? number
  : K extends "bool"
    ? boolean
    : K extends readonly (infer W)[]
      ? W
      : string;

/** The fields an event may carry, each optional. */
export type EventFields<E extends EventName> = {
  readonly [F in keyof (typeof EVENTS)[E]["fields"]]?: ValueOf<(typeof EVENTS)[E]["fields"][F]>;
};

const SPACE_ID = new RegExp(`^sp_[${ID_ALPHABET}]{26}$`);
const PATTERNS: Readonly<Record<string, RegExp>> = {
  space: SPACE_ID,
  instance: /^[0-9a-f]{32}$/,
  version: /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?(?:\+[0-9A-Za-z.-]{1,40})?$/,
  build: /^[0-9A-Za-z][0-9A-Za-z.-]{0,39}$/,
};

/**
 * The error classes a diagnostic may name: JavaScript's own and Tasks's. Another class is named by
 * the nearest of these it extends (crash.ts errorType).
 */
export const ERROR_TYPES: readonly string[] = [
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
  "DOMException",
  "AbortError",
  "StorageError",
  "ServiceExit",
  "LockBusy",
  "Timeout",
  "LayoutError",
  "MachineFileInvalid",
  "MaintenanceFailed",
  "RpcError",
  "LocalError",
  "AppError",
];

/**
 * The Node codes a diagnostic may name: the ones the hub's work can meet (files, sockets and
 * pipes, worker threads, node:sqlite, child processes, memory). Another `ERR_` code is dropped.
 */
export const NODE_ERROR_CODES: readonly string[] = [
  "ERR_ACCESS_DENIED",
  "ERR_ASSERTION",
  "ERR_BUFFER_TOO_LARGE",
  "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
  "ERR_FS_FILE_TOO_LARGE",
  "ERR_ILLEGAL_CONSTRUCTOR",
  "ERR_INTERNAL_ASSERTION",
  "ERR_INVALID_ARG_TYPE",
  "ERR_INVALID_ARG_VALUE",
  "ERR_INVALID_RETURN_VALUE",
  "ERR_INVALID_STATE",
  "ERR_INVALID_THIS",
  "ERR_IPC_CHANNEL_CLOSED",
  "ERR_METHOD_NOT_IMPLEMENTED",
  "ERR_MISSING_ARGS",
  "ERR_MODULE_NOT_FOUND",
  "ERR_OPERATION_FAILED",
  "ERR_OUT_OF_RANGE",
  "ERR_SERVER_ALREADY_LISTEN",
  "ERR_SERVER_NOT_RUNNING",
  "ERR_SOCKET_CLOSED",
  "ERR_SQLITE_ERROR",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ERR_STREAM_WRITE_AFTER_END",
  "ERR_STRING_TOO_LONG",
  "ERR_SYSTEM_ERROR",
  "ERR_UNHANDLED_ERROR",
  "ERR_UNHANDLED_REJECTION",
  "ERR_UNKNOWN_FILE_EXTENSION",
  "ERR_WORKER_INIT_FAILED",
  "ERR_WORKER_NOT_RUNNING",
  "ERR_WORKER_OUT_OF_MEMORY",
  "ERR_WORKER_UNSERIALIZABLE_ERROR",
];

/** Every error code a diagnostic may name: libuv's error names, the Node codes, storage's codes. */
const ERROR_CODES: ReadonlySet<string> = new Set<string>([
  ...[...getSystemErrorMap().values()].map(([name]) => name),
  ...NODE_ERROR_CODES,
  ...STORAGE_ERROR_CODES,
]);

/** Whether `value` is allowed for a field of `kind`. */
export function fieldAllowed(kind: FieldKind, value: unknown): boolean {
  if (typeof kind !== "string") return typeof value === "string" && kind.includes(value);
  switch (kind) {
    case "int":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "bool":
      return typeof value === "boolean";
    case "install":
      return isInstallId(value);
    case "error_type":
      return typeof value === "string" && ERROR_TYPES.includes(value);
    case "error_code":
      return typeof value === "string" && ERROR_CODES.has(value);
    default: {
      const pattern = PATTERNS[kind];
      return pattern !== undefined && typeof value === "string" && pattern.test(value);
    }
  }
}

const hasOwn = (object: object, key: string): boolean => Object.hasOwn(object, key);

/** The JSON line for one event, or the line of `log.invalid_event` for a name not in the catalogue. */
export function formatEvent(
  ev: string,
  fields: Readonly<Record<string, unknown>>,
  context: { t: Date; pid: number },
): { lvl: Level; line: string } {
  const t = context.t.toISOString();
  if (!hasOwn(EVENTS, ev)) {
    return {
      lvl: "error",
      line: JSON.stringify({
        t,
        lvl: "error",
        c: "hub",
        ev: "log.invalid_event",
        pid: context.pid,
      }),
    };
  }
  const spec: Spec = EVENTS[ev as EventName];
  const out: Record<string, unknown> = { t, lvl: spec.lvl, c: spec.c, ev, pid: context.pid };
  let dropped = 0;
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const kind = hasOwn(spec.fields, name) ? spec.fields[name] : undefined;
    if (kind !== undefined && fieldAllowed(kind, value)) out[name] = value;
    else dropped += 1;
  }
  if (dropped > 0) out["dropped"] = dropped;
  return { lvl: spec.lvl, line: JSON.stringify(out) };
}

export interface LoggerOptions {
  /** The logs folder. Created when missing. */
  readonly dir: string;
  readonly level?: Level;
  /** Warnings and errors also go to stderr (systemd's journal, launchd's log). Default true. */
  readonly stderr?: boolean;
  readonly maxBytes?: number;
  readonly now?: () => Date;
}

export class Logger {
  readonly path: string;
  readonly #dir: string;
  readonly #min: number;
  readonly #stderr: boolean;
  readonly #maxBytes: number;
  readonly #now: () => Date;
  readonly #recent: string[] = [];
  #owner = false;
  #failed = false;

  constructor(options: LoggerOptions) {
    this.#dir = options.dir;
    this.path = join(options.dir, LOG_FILE);
    this.#min = LEVELS.indexOf(options.level ?? "info");
    this.#stderr = options.stderr ?? true;
    this.#maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
    this.#now = options.now ?? (() => new Date());
  }

  /** Logs one event from the catalogue. Never throws: logging never stops the service. */
  log<E extends EventName>(ev: E, fields: EventFields<E> = {}): void {
    const { lvl, line } = formatEvent(ev, fields, { t: this.#now(), pid: process.pid });
    if (LEVELS.indexOf(lvl) < this.#min) return;
    this.#recent.push(line);
    if (this.#recent.length > RECENT_LINES) this.#recent.shift();
    if (this.#stderr && (lvl === "warn" || lvl === "error")) {
      try {
        process.stderr.write(`${line}\n`);
      } catch {
        // A closed stderr changes nothing for the file.
      }
    }
    this.#append(`${line}\n`);
  }

  /**
   * This process now holds service.lock: it may rotate the file, before any line that would take
   * the file over its limit.
   */
  own(): void {
    this.#owner = true;
  }

  /** The last lines this process wrote, for a crash file. Already content-free. */
  recent(): readonly string[] {
    return [...this.#recent];
  }

  /** Whether an append has failed since the start. */
  get failed(): boolean {
    return this.#failed;
  }

  #append(text: string): void {
    const bytes = Buffer.byteLength(text);
    try {
      // The file's real size: second starts append to it too, and their lines count.
      const size = statSync(this.path, { throwIfNoEntry: false })?.size ?? 0;
      if (size > 0 && size + bytes > this.#maxBytes) {
        // Only the holder rotates. A second start never takes the file past its limit: an idle
        // holder logs nothing that would rotate it, so the line goes to stderr and recent() only.
        if (!this.#owner) return;
        this.#rotate();
      }
      if (!existsSync(this.#dir)) makeDir(this.#dir, 0o700);
      appendPrivate(this.path, text);
    } catch {
      this.#failed = true;
    }
  }

  /** service.log becomes service.log.1, and so on. The oldest beyond the kept count goes. */
  #rotate(): void {
    const name = (n: number) => (n === 0 ? this.path : `${this.path}.${String(n)}`);
    rmSync(name(LOG_FILES_KEPT - 1), { force: true });
    for (let n = LOG_FILES_KEPT - 2; n >= 0; n -= 1) {
      if (existsSync(name(n))) renameSync(name(n), name(n + 1));
    }
  }
}
