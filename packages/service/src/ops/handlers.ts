// The request path for operations (A2 3.6.4 `op/call` and `op/list`; A3 3.2, 3.4, 3.5, 3.7.9;
// A1 3.8). One function per M1 registry entry. It is independent of the transport: the
// local endpoint calls it now, MCP (M2.02, M2.03) and HTTP (M2.12) call the same functions with
// their own caller. For every call:
//
//   entry → exposure (the class may call it) → principal (audience, actor, writer scope)
//   → the caller's input parsed with the contract (SafeText, defaults, the audience's limits)
//   → the space → reads through the space's reader, writes expanded into A1 operations and sent
//     to the space's writer with the scope, the earlier scope and the intent
//   → the contract's result, checked against the entry's output schema, or the error body.
//
// A write's result is built from the writer's result and the caller's input only, so a replay of
// the same request ID gives the same result (A3 3.4.1), marked `replayed`.
import { CLI_NAME, PRODUCT_NAME } from "@tasks/brand";
import {
  findEntry,
  AppError,
  fitsShape,
  GROUP_LIMITS,
  isKeyList,
  mayWrite,
  opSpec,
  parseInput,
  PREFERENCES,
  readsOnly,
  receiptResult,
  registry,
  shapeText,
  type AnyEntry,
  type PreferenceRead,
  type PreferenceSpec,
  type PrefValue,
} from "@tasks/contracts";
import {
  isId,
  newId,
  type Id,
  type Operation,
  type OpResult,
  type SourceFields,
  type PatchableField,
  type Row,
  type SpaceWriterHandle,
  type TaskCreate,
  type WorkerConnection,
  type WriteRequest,
  type WriteResult,
} from "@tasks/storage";
import {
  checkExposure,
  checkHiddenFields,
  principalOf,
  sessionPrincipal,
  type Caller,
  type Principal,
} from "./caller.ts";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  apart,
  ExecutionRefused,
  isLaunchRef,
  PACK_LOG,
  type LaunchIntent,
  type Root,
} from "@tasks/launch";
import {
  ambiguousError,
  copyOf,
  findSpace,
  isAmbiguity,
  onlySpace,
  type Ambiguity,
  type Copy,
} from "./copies.ts";
import {
  LaunchFolderUnavailable,
  LaunchUnavailable,
  type OpenTaskRequest,
  type OpenTaskResult,
  type PackContent,
} from "../launch/open.ts";
import { type BindOutcome, type BindingPort, type FoundLaunch } from "./binding.ts";
import { checkGrant, grantRefused, homesOf, type HomeGate } from "./grant.ts";
import { addDays, dateIn, dueDate, localTimeZone } from "./dates.ts";
import { GUIDE_STEPS, GUIDES } from "./guides.ts";
import { HERE_ROWS, hereOf, hereRows, placeState, type Match, type PlaceState } from "./here.ts";
import { bindPlace, outsideWarning, placeRefused, remoteWarning } from "./places.ts";
import {
  byOf,
  invalid,
  readOnly,
  resultFailure,
  schemaFailure,
  spaceUnavailable,
  storageFailure,
  unsupported,
} from "./errors.ts";
import { SearchCursors } from "../search/cursors.ts";
import { runSearch, type SearchInput } from "../search/search.ts";
import { editDistance, resolveGroup } from "./groups.ts";
import {
  readCommit,
  readCommitTasks,
  readGroupNames,
  readGroups,
  readLaunch,
  readPlaced,
  readPlacedAny,
  readReceipt,
  readScriptChange,
  readSpacePreferences,
  readLaunchTask,
  readSiblings,
  readSpace,
  readStatus,
  readTask,
  readTaskRef,
  logOf,
  noteOf,
  sourceOf,
  taskRow,
  text,
  type CommitFacts,
  type TaskRead,
  type Destination,
  type GroupNames,
} from "./read.ts";
import { duplicateWarning } from "./similar.ts";
import { DIGEST_RANGES, digestOf, pagePlan, pageRanges, sectionsOf } from "./task-view.ts";
import { planningApply, planningPreview, planningUndo } from "./import-planning.ts";

/** A space as the request path sees it. The hub's space manager provides them. */
export interface ServedSpace {
  /** The space's ID as read from its folder, once it is served. */
  readonly id: string | undefined;
  /**
   * The ID its machine.toml entry names, also before it is served (unavailable, opening): it tells
   * which space an unserved copy is of, so copies of one space count as one (ops/copies.ts).
   */
  readonly registered?: string;
  readonly name: string | undefined;
  readonly state: "opening" | "open" | "read_only" | "unavailable" | "closing" | "closed";
  readonly reason?: string;
  /** Why a read-only space is read-only, in A1 3.2's words (a synced or network folder). */
  readonly message?: string;
  /** Set while the space is open as this machine's. */
  readonly writer: SpaceWriterHandle | undefined;
  /** Set while the space is served: open or read-only. */
  readonly reader: WorkerConnection | undefined;
  /** The space's folder on this machine: where an import's run folder goes (A7 3.15.1). */
  readonly folder?: string;
  /** The space's machine-local backup folder, when one is set: an import's barrier backup. */
  readonly backupDir?: string;
}

/** What the request path needs from its host. */
export interface OpsHost {
  /** This machine's ID: the writer scopes name it, and places belong to it. */
  readonly machine: { readonly id: string };
  spaces(): readonly ServedSpace[];
  /** This machine's roots (machine.toml `[roots]`), as they are now. Default: none. */
  readonly roots?: () => readonly Root[];
  /** The OS whose path rules a place follows. Default: this process's. */
  readonly platform?: NodeJS.Platform;
  /** Milliseconds since 1970. Default: Date.now. */
  readonly now?: () => number;
  /** The space's time zone. Default: this machine's. */
  readonly timeZone?: () => string;
  /**
   * Session binding (binding/, M2.04). Without it no connection binds: a launch reference and an
   * explicit bind resolve for the call only.
   */
  readonly bindings?: BindingPort;
  /**
   * machine.toml's `[service] default_space` as it is now (A2 3.1): what an unbound call of the
   * person and a new tab use. Default: none.
   */
  readonly defaultSpace?: () => string | undefined;
  /**
   * The agent homes' grant rows (grant.ts, A3 3.7.8): which spaces an agent home's calls may use.
   * Without it, every agent home's call is refused.
   */
  readonly homes?: HomeGate;
  /** Launching (`launch.open`): the hub's launch service. None: no task opens here. */
  readonly launches?: LaunchPort;
}

/** What `launch.open` needs of the launch service (launch/service.ts). */
export interface LaunchPort {
  openTask(request: OpenTaskRequest): Promise<OpenTaskResult>;
}

/** `op/call`'s params (A2 3.6.4). */
export interface OpCallParams {
  readonly space?: unknown;
  readonly op?: unknown;
  readonly input?: unknown;
  readonly request_id?: unknown;
}

interface Call {
  readonly host: OpsHost;
  readonly caller: Caller;
  readonly principal: Principal;
  readonly entry: AnyEntry;
  readonly space: ServedSpace;
  /** The input after the contract: SafeText, defaults and the audience's limits. */
  readonly input: Record<string, unknown>;
  readonly today: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const opUnknown = (): AppError =>
  new AppError({
    code: "op_unknown",
    message: "The running service does not know this operation.",
    hint: `Update ${PRODUCT_NAME}, or restart the service: ${CLI_NAME} service stop, then ${CLI_NAME} service start.`,
  });

/** `op/list` (A2 3.6.4): the registry's metadata for help and completion. */
export function opList(): {
  entries: { name: string; kind: string; actors: string; summary: string }[];
} {
  return {
    entries: [...registry]
      .map((entry) => ({
        name: entry.name,
        kind: entry.kind,
        actors: entry.actors,
        summary: entry.summary,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
}

/** `op/call` (A2 3.6.4): one registry operation for `caller`. Throws AppError. */
export async function opCall(
  host: OpsHost,
  caller: Caller,
  params: OpCallParams,
): Promise<unknown> {
  if (typeof params.op !== "string") throw invalid("op", "Expected an operation name");
  const entry = findEntry(params.op);
  if (entry === undefined) throw opUnknown();
  const slot = caller.binding;
  if (entry.actors === "run") {
    // A run-only entry needs a run's or a routine's binding, which none is before M6 (A3 3.4.12).
    // The refusal names the binding it found, read once any bind in progress settles but without
    // `use`, which records the call (a last use, an unbound write): the call leaves no trace, and
    // it reads neither its input nor a space.
    const bound =
      slot === undefined
        ? false
        : host.bindings === undefined
          ? slot.session !== undefined
          : await host.bindings.holds(slot);
    checkExposure(entry, caller.class, bound ? "task" : "none");
  } else {
    checkExposure(entry, caller.class);
  }
  // The call reads a settled binding (binding/bindings.ts `use`).
  if (slot !== undefined && host.bindings !== undefined) await host.bindings.use(slot);
  return callAs(host, caller, entry, params);
}

/** A write's request ID as the call gives it (checked later with the input). */
function requestIdOf(params: OpCallParams): string | undefined {
  const given =
    params.request_id ?? (isRecord(params.input) ? params.input["request_id"] : undefined);
  return typeof given === "string" && given.length <= 256 ? given : undefined;
}

/** Writes in flight, by machine, writer scope and request ID. */
const writesInFlight = new Map<string, Set<Promise<void>>>();

/**
 * Runs a write as `principal` (A3 3.7.9). One whose principal keeps an earlier writer scope (a
 * connection or a shell that was unbound and is bound now) first waits for the writes with its
 * request ID still in flight in that scope: a retry of one of them then finds its receipt through
 * the earlier scope rather than writing twice. Writes in one scope do not wait for each other:
 * the writer replays a retry that races its first call.
 */
async function writing<T>(
  key: (scope: string) => string,
  principal: Principal,
  work: () => Promise<T>,
): Promise<T> {
  // Registered before anything awaits, so a retry that starts later sees it.
  const own = key(principal.scope);
  let end = (): void => undefined;
  const mine = new Promise<void>((resolve) => {
    end = resolve;
  });
  let all = writesInFlight.get(own);
  if (all === undefined) {
    all = new Set();
    writesInFlight.set(own, all);
  }
  const set = all;
  set.add(mine);
  try {
    const earlier =
      principal.earlierScope === undefined
        ? undefined
        : writesInFlight.get(key(principal.earlierScope));
    if (earlier !== undefined) await Promise.all([...earlier]);
    return await work();
  } finally {
    set.delete(mine);
    end();
    if (set.size === 0 && writesInFlight.get(own) === set) writesInFlight.delete(own);
  }
}

/** `opCall` once the call's binding is settled. */
async function callAs(
  host: OpsHost,
  caller: Caller,
  entry: AnyEntry,
  params: OpCallParams,
): Promise<unknown> {
  // A bound connection acts as its session (A3 3.7.4): computed from the slot, which only the
  // binding service sets, never from anything in the call.
  const slot = caller.binding;
  const bound = slot?.session;
  const principal =
    slot !== undefined && bound !== undefined
      ? sessionPrincipal(slot, bound)
      : (caller.principal ?? principalOf(caller.class, host.machine.id, caller.grant));
  // A mixed entry's read action is a read (A3 3.2.3): no request ID, nothing to wait for.
  const request = readsOnly(entry, params.input) ? undefined : requestIdOf(params);
  if (request === undefined) return callWith(host, caller, entry, params, principal);
  return writing(
    (scope) => `${host.machine.id}\n${scope}\n${request}`,
    principal,
    () => callWith(host, caller, entry, params, principal),
  );
}

/**
 * A mixed entry's write action needs `request_id`, and `base` when every operation the entry may
 * emit needs one (A3 3.2.3). A read action needs neither and ignores both: it writes nothing and
 * stores no receipt, so an agent that sends a request ID with every call loses nothing. Both are
 * input rules, so a refusal stores nothing and a corrected call may reuse the ID.
 */
function checkActionFields(entry: AnyEntry, input: Record<string, unknown>): void {
  const actions = entry.actions;
  if (actions === undefined || readsOnly(entry, input)) return;
  const action = String(input[actions.field]);
  if (input["request_id"] === undefined) {
    throw invalid("request_id", `Required to ${action}`, "Pass a new request_id for this change.");
  }
  const guarded = entry.ops.every((op) => opSpec(op)?.base === true);
  if (guarded && input["base"] === undefined) {
    throw invalid("base", `Required to ${action}`, "Pass base: the as_of of your last read.");
  }
}

/** `opCall` as `principal`. */
async function callWith(
  host: OpsHost,
  caller: Caller,
  entry: AnyEntry,
  params: OpCallParams,
  principal: Principal,
): Promise<unknown> {
  const given = params.input ?? {};
  if (!isRecord(given)) throw invalid("input", "Expected an object");
  const input: Record<string, unknown> = { ...given };
  if (params.request_id !== undefined) {
    if (input["request_id"] !== undefined && input["request_id"] !== params.request_id) {
      throw invalid("request_id", "Two different request IDs");
    }
    if (Object.hasOwn(entry.input.shape, "request_id")) input["request_id"] = params.request_id;
  }
  checkHiddenFields(entry, input, principal.audience);
  const parsed = parseInput(entry, principal.audience, input);
  if (!parsed.success) throw schemaFailure(parsed.error, input);
  checkActionFields(entry, parsed.data);
  if (params.space !== undefined && typeof params.space !== "string") {
    throw invalid("space", "Expected a space ID or name");
  }
  const space = pickSpace(host, caller, params.space);
  const now = (host.now ?? Date.now)();
  const call: Call = {
    host,
    caller,
    principal,
    entry,
    space,
    input: parsed.data,
    today: dateIn(now, (host.timeZone ?? localTimeZone)()),
  };
  const handler = HANDLERS[entry.name];
  if (handler === undefined) throw opUnknown();
  const result = await handler(call);
  const checked = entry.output.safeParse(result);
  if (!checked.success) {
    throw new AppError({
      code: "internal",
      message: "The service built a result that does not match its contract.",
    });
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// The space (A2 3.10.5, A3 3.7.8)

/**
 * The space a call uses: `space` (a folder, an ID or a name), else TASKS_SPACE from the connection,
 * else the machine's default (`service.default_space`, M5.01), else the one space this service
 * serves. A default that is set but not served is `space_unavailable`, never another space in its
 * place. An agent's CLI gets no default (A2 3.10.5: A3 may forbid step 4 for agent classes, so an
 * unbound agent never writes into the default space by accident).
 *
 * Only spaces that are not closed are candidates: a closed space serves no call. A restored copy
 * has its original's ID and name, so which copy an ID or a name means is copies.ts's one rule: the
 * writable copy, and a read-only copy by its folder.
 */
/**
 * The machine's default space among `live` (spaces that are not closed): the copy of the space with
 * that ID that copies.ts picks; `not_served` when none has it; an ambiguity when two copies are
 * equally good; undefined when the machine has no default.
 */
export function defaultOf<S extends Copy>(
  live: readonly S[],
  defaultId: string | undefined,
): S | Ambiguity<S> | "not_served" | undefined {
  if (defaultId === undefined) return undefined;
  return copyOf(live, defaultId) ?? "not_served";
}

function pickSpace(host: OpsHost, caller: Caller, named: string | undefined): ServedSpace {
  const slot = caller.binding;
  // The agent home the call comes from (grant.ts): its space must be one its row grants, checked
  // on the space the call would use and before anything is read from it (A3 3.7.8).
  const homes = homesOf(caller);
  // A binding carries its space (A3 3.7.8): a bound connection's calls go to its session's space,
  // an unbound one's to the space it pinned, whichever space anything else names or shows. A call
  // that names another space is refused (A2 3.10.3: "wrong space for this binding"), never sent to
  // either; a space no longer served is `space_unavailable`, never another space.
  const pinned = slot?.session?.space ?? slot?.space;
  if (slot !== undefined && pinned !== undefined) {
    // The grant comes first: a home that may not use the space its binding pins can do nothing
    // here, whatever the call names, so `binding` (leave out the space) would not help it.
    checkGrant(host.homes, homes, pinned);
    const live = host.spaces().filter((s) => s.state !== "closed");
    if (named !== undefined && named !== pinned) {
      const other = findSpace(live, named);
      if (other === undefined || isAmbiguity(other) || other.id !== pinned) {
        throw new AppError({
          code: "forbidden",
          message: "This session is bound to another space.",
          hint: "Leave out the space: a session's calls go to the space it is bound to.",
          data: { rule: "binding" },
        });
      }
      // A folder names its copy, which a binding to the space may use.
      if (isAbsolute(named)) return other;
    }
    const found = copyOf(live, pinned);
    if (isAmbiguity(found)) throw ambiguousError(found);
    if (found === undefined) throw spaceUnavailable("not_served", false);
    return found;
  }
  const wanted = named ?? slot?.named;
  let picked: ServedSpace;
  try {
    picked = pickByRule(host, caller, wanted);
  } catch (error) {
    // An agent home learns nothing of a space it may not use (A3 3.7.8): a target that does not
    // resolve (not served, a name or ID two spaces share, none chosen) is the grant refusal, unless
    // it is a space the home is granted, whose own answer (`space_unavailable`, `ambiguous`) helps.
    if (homes.length > 0 && !grantedTarget(host, homes, wanted)) throw grantRefused();
    throw error;
  }
  // Refused before it is pinned: a connection keeps no space it may not use.
  checkGrant(host.homes, homes, picked.id);
  // An unbound connection pins the space of its first call when its bind frame could not name one
  // (A2 3.7.1: it never follows a later change of the default).
  if (slot !== undefined && picked.id !== undefined) host.bindings?.pin(slot, picked.id);
  return picked;
}

/**
 * Whether the target of an agent home's call, the space it named or else the machine's default, is
 * the home's own: every live space it matches as `pickByRule` matches (a named space by ID, else by
 * name; the default by ID only), or the ID itself when none is live, is granted to every home of
 * the call. One match the home may not use is enough to say no, so `ambiguous` never tells a home of
 * another space with its space's name.
 */
function grantedTarget(
  host: OpsHost,
  homes: readonly string[],
  wanted: string | undefined,
): boolean {
  const target = wanted ?? host.defaultSpace?.();
  if (target === undefined) return false;
  const live = host.spaces().filter((s) => s.state !== "closed");
  const byId = live.filter((s) => s.id === target);
  const matched =
    byId.length > 0 || wanted === undefined
      ? byId
      : live.filter((s) => s.name?.toLowerCase() === target.toLowerCase());
  const candidates = matched.length > 0 ? matched.map((s) => s.id) : [target];
  return candidates.every(
    (id) => id !== undefined && homes.every((home) => host.homes?.may(home, id) === true),
  );
}

function pickByRule(host: OpsHost, caller: Caller, named: string | undefined): ServedSpace {
  const live = host.spaces().filter((s) => s.state !== "closed");
  // A bridge's environment is not passed (A3 3.7.2: TASKS_SPACE never chooses its space).
  const fromEnv = caller.binding === undefined ? caller.env["TASKS_SPACE"] : undefined;
  const wanted = named ?? (fromEnv === "" ? undefined : fromEnv);
  if (wanted !== undefined) {
    const found = findSpace(live, wanted);
    if (isAmbiguity(found)) throw ambiguousError(found);
    if (found === undefined) throw spaceUnavailable("not_served", false);
    return found;
  }
  if (caller.class === "cli-agent") {
    throw invalid("space", "Name the space", "Pass --space, or set TASKS_SPACE.");
  }
  const fallback = defaultOf(live, host.defaultSpace?.());
  if (fallback === "not_served") throw spaceUnavailable("not_served", false);
  if (isAmbiguity(fallback)) throw ambiguousError(fallback);
  if (fallback !== undefined) return fallback;
  const only = onlySpace(live);
  if (only === undefined) throw spaceUnavailable("not_served", false);
  if (only === "several") {
    throw invalid(
      "space",
      "Name the space",
      "Pass --space with an ID, a name or a folder from tasks space list.",
    );
  }
  if (isAmbiguity(only)) throw ambiguousError(only);
  return only;
}

function readerOf(space: ServedSpace): WorkerConnection {
  if (space.state === "opening") throw spaceUnavailable("opening", true);
  if ((space.state === "open" || space.state === "read_only") && space.reader !== undefined) {
    return space.reader;
  }
  throw spaceUnavailable("not_served", false, space.reason ?? space.state, space.message);
}

function writerOf(space: ServedSpace): SpaceWriterHandle {
  if (space.state === "read_only") throw readOnly(space.reason, space.message);
  if (space.state === "open" && space.writer !== undefined) return space.writer;
  readerOf(space);
  throw spaceUnavailable("not_served", false, space.reason ?? space.state);
}

// ---------------------------------------------------------------------------------------------
// Writes

const actors = new WeakMap<SpaceWriterHandle, Map<string, Promise<Id<"ac">>>>();

/** The principal's actor in this space, added on its first act (A3 3.7.4). */
function actorOf(writer: SpaceWriterHandle, principal: Principal): Promise<Id<"ac">> {
  let known = actors.get(writer);
  if (known === undefined) {
    known = new Map();
    actors.set(writer, known);
  }
  const key = `${principal.actorKind}:${principal.label}`;
  let found = known.get(key);
  if (found === undefined) {
    found = writer.actor(principal.actorKind, principal.label);
    const cache = known;
    found.catch(() => cache.delete(key));
    known.set(key, found);
  }
  return found;
}

/** Whether a field of the input resolves against `cwd`: a place given as "cwd" (A3 3.4.5). */
function resolvesCwd(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(resolvesCwd);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([k, v]) => (k === "place" && v === "cwd") || resolvesCwd(v));
}

/**
 * The input as the receipt's fingerprint covers it (A3 3.4.1): the input as the
 * caller sent it, without `cwd` when nothing in it resolves against that folder. The CLI fills
 * `cwd` itself, like the base, so a retry from another folder is the same intent; a place given as
 * "cwd" makes the folder part of what the caller asked for.
 */
function intentInput(input: Record<string, unknown>): Record<string, unknown> {
  if (input["cwd"] === undefined || resolvesCwd(input)) return input;
  const rest = { ...input };
  delete rest["cwd"];
  return rest;
}

/**
 * Sends one request to the space's writer: the operations, the credential from the connection,
 * the base and reason the caller gave, and the intent, whose fingerprint the receipt keeps
 * (A1 3.8). A conflict or refusal becomes its error body. `warnings` are what the handler
 * found before the writer (a place bound without a remote check): the writer keeps them with an
 * accepted result, so they come back in `result.warnings`, and a replay returns the first call's.
 */
async function submit(
  call: Call,
  ops: Operation[],
  options: {
    readonly active?: boolean;
    readonly warnings?: readonly string[];
    /** False for an undo or redo: the stack's own move never joins the stack (A1 3.10.1). */
    readonly undoable?: false;
    /** Hints of the refusals whose remedy differs for this entry (resultFailure). */
    readonly hints?: Readonly<Record<string, string>>;
    /** The index of complete_task's `once` wrap-up operation (resultFailure). */
    readonly wrapUp?: number;
  } = {},
): Promise<WriteResult> {
  const writer = writerOf(call.space);
  const { principal, input } = call;
  // A handler sends only the operations its entry declares, so contracts' rules on an entry's
  // operations hold on this path: an entry an agent may call never declares one of R7's launches,
  // runs or routines (check.ts, A1 3.6), and a launch request carries no registry intent,
  // which every request here does. A broken handler writes nothing.
  if (ops.some((op) => !call.entry.ops.includes(op.kind))) {
    throw new AppError({
      code: "internal",
      message: "The service built an operation its entry does not declare.",
    });
  }
  let result: WriteResult;
  try {
    // The grant again before anything reaches the space (A3 3.7.8): a row revoked while this call
    // read and staged stops it before its actor is registered, and once more (below) before the
    // writer gets the request.
    checkGrant(call.host.homes, homesOf(call.caller), call.space.id);
    const principalId = await actorOf(writer, principal);
    const request: WriteRequest = {
      space_id: writer.spaceId,
      request_id: String(input["request_id"]),
      actor: {
        scope_id: principal.scope,
        ...(principal.earlierScope === undefined
          ? {}
          : { earlier_scope_id: principal.earlierScope }),
        principal_id: principalId,
        actor_kind: principal.actorKind,
        machine_id: call.host.machine.id as Id<"m">,
        origin: principal.origin,
        ...(principal.session === undefined ? {} : { session_id: principal.session as Id<"se"> }),
      },
      ...(typeof input["base"] === "string" ? { base: input["base"] } : {}),
      ...(typeof input["reason"] === "string" ? { reason: input["reason"] } : {}),
      ...(principal.actorKind === "human" && options.undoable !== false ? { undoable: true } : {}),
      ...(options.active === true ? { active: true } : {}),
      ...(options.warnings === undefined || options.warnings.length === 0
        ? {}
        : { warnings: [...options.warnings] }),
      intent: { entry: call.entry.name, input: intentInput(input) },
      ops,
    };
    // The last step before the writer: no write is handed over after the revoke took effect. Only
    // a request the writer holds already can still commit.
    checkGrant(call.host.homes, homesOf(call.caller), call.space.id);
    // An unbound connection's write was registered when its call started (`opCall`), so a retry
    // after a lost reply, once bound, still finds this receipt.
    result = await writer.submit(request);
  } catch (error) {
    throw storageFailure(error);
  }
  if (result.status === "conflict" || result.status === "rejected") {
    throw resultFailure(result, options.hints, options.wrapUp);
  }
  return result;
}

const replayed = (result: WriteResult) => (result.replayed === true ? { replayed: true } : {});

/**
 * A1's `source_differs` (A3 3.4.6): a source that exists already keeps its metadata, and the reply
 * names the fields the input gave otherwise, by the input path of the source and the field names,
 * never a value. From the writer's result, so a replay warns the same.
 */
function differsWarnings(result: WriteResult, paths: ReadonlyMap<number, string>): string[] {
  return result.results.flatMap((op) => {
    const path = paths.get(op.i);
    if (path === undefined || op.differs === undefined || op.differs.length === 0) return [];
    return [
      `The source at ${path} exists already and keeps its own ${op.differs.join(", ")} (source_differs).`,
    ];
  });
}

function opAt(result: WriteResult, i: number): OpResult {
  const found = result.results.find((r) => r.i === i);
  if (found === undefined)
    throw new AppError({ code: "internal", message: "A result is missing." });
  return found;
}

const refOf = (op: OpResult): string => {
  if (op.ref === undefined)
    throw new AppError({ code: "internal", message: "A result is missing." });
  return op.ref;
};

/**
 * A read that completes the answer to a write that has applied. It never turns that answer into an
 * error: the caller would take an applied change for a failed one and send it again, and a second
 * plain undo would take back an older, unrelated change. On a failed read the answer leaves out
 * what the read would add.
 */
async function afterWrite<T>(
  call: Call,
  read: (reader: WorkerConnection) => Promise<T>,
): Promise<T | undefined> {
  try {
    return await read(readerOf(call.space));
  } catch {
    return undefined;
  }
}

/** What the commit `seq` of a write did to the task of `op`, from history (read.ts). */
function commitOf(call: Call, op: OpResult, seq: number): Promise<CommitFacts | undefined> {
  return afterWrite(call, (reader) => readCommit(reader, op.task ?? op.id, seq));
}

/**
 * The fields of `named`, in their order, that the commit changed (A3 3.4.6: "Setting a field to
 * its current value is no change"): a task field by its change row, `area` and `project` by their
 * column of the grouping, `place` and `sources` by a row of theirs under the task.
 */
function changedFields(named: readonly string[], facts: CommitFacts): string[] {
  const rows = (entity: string) => facts.changes.filter((c) => c.entity === entity);
  const grouping = rows("tasks").find((c) => c.field === "grouping");
  const column = (value: unknown, name: string): unknown =>
    isRecord(value) ? (value[name] ?? null) : null;
  const moved = (name: string): boolean =>
    grouping !== undefined && column(grouping.before, name) !== column(grouping.after, name);
  return named.filter((field) => {
    switch (field) {
      case "area":
        return moved("area_id");
      case "project":
        return moved("project_id");
      case "place":
        return rows("places").length > 0;
      case "sources":
        return rows("task_sources").length > 0;
      default:
        return rows("tasks").some((c) => c.field === field);
    }
  });
}

/** At most this many candidate rows in an error (A3 3.5). */
const CANDIDATES = 3;

/**
 * The task a call names, else the bound task (A3 3.4.1), else `unbound` (A3 3.5) with the tasks
 * for the caller's `cwd` as candidates, best first, when it gave one. The working folder never
 * binds and never picks the task (A3 3.7.3): the model or the user chooses from the candidates.
 */
async function taskOf(call: Call): Promise<string> {
  const task = call.input["task"];
  if (typeof task === "string") return task;
  const slot = call.caller.binding;
  const bound = slot?.session?.task;
  if (typeof bound === "string") return bound;
  const cwd = call.input["cwd"];
  let candidates: Record<string, unknown>[] = [];
  if (typeof cwd === "string") {
    const platform = call.host.platform ?? process.platform;
    const roots = call.host.roots?.() ?? [];
    const here = await hereOf(cwd, roots, platform);
    if (here !== undefined && here.roots.length > 0) {
      const read = await readPlaced(readerOf(call.space), call.host.machine.id, here.roots);
      candidates = (await hereRows(read.placed, here, roots, platform))
        .slice(0, CANDIDATES)
        .map(({ row }) => taskRow(row, read.space.refPrefix));
    }
  }
  // A binding that ended (A3 3.7.3 "A lost binding"): the calls that relied on it say so.
  const lost = slot?.lost === true && slot.session === undefined;
  throw new AppError({
    code: "unbound",
    message: lost
      ? `Your ${PRODUCT_NAME} session ended: this call is not bound to a task.`
      : "Name the task: this call is not bound to one.",
    hint: lost
      ? "Pass task, or ask the user."
      : "Pass task, such as M-14. status with your cwd lists the tasks for your folder.",
    ...(candidates.length === 0 ? {} : { data: { candidates } }),
  });
}

/** A3 3.7.3: a launch reference binds within 24 hours of its launch. */
export const LAUNCH_BIND_MS = 24 * 60 * 60_000;

const launchUnknown = (typo: boolean): AppError =>
  new AppError({
    code: "launch_unknown",
    message: "No launch in this space has this reference.",
    hint: typo
      ? "Its check character does not match: a symbol may be mistyped. Check the Brief."
      : "Check the reference in the Brief, or pass task.",
  });

/**
 * The launch a reference names in the call's space (A3 3.7.3), checked as far as the
 * reference alone decides: a reference whose check character fails, one no launch of this space
 * and machine has, or one that never left the service (Prepared) is `launch_unknown`; one older
 * than 24 hours is `launch_expired` with its task. A connection that cannot bind resolves the
 * reference with this alone; binding decides the rest (binding/).
 */
async function launchOf(call: Call, reference: unknown): Promise<FoundLaunch & { task: string }> {
  if (!isLaunchRef(reference)) throw launchUnknown(true);
  let found;
  try {
    found = await readLaunch(readerOf(call.space), reference);
  } catch (error) {
    throw storageFailure(error);
  }
  const launch = found.launch;
  // A routine's launch binds the space, not a task (M6): none exists in this build.
  if (
    launch === undefined ||
    launch.task === null ||
    launch.machine !== call.host.machine.id ||
    launch.state === "prepared"
  ) {
    throw launchUnknown(false);
  }
  const now = (call.host.now ?? Date.now)();
  if (apart(now, launch.clickedAt, LAUNCH_BIND_MS)) {
    throw new AppError({
      code: "launch_expired",
      message: "This launch reference is more than 24 hours old.",
      hint: `Pass task ${launch.taskRef ?? "with its reference"} instead.`,
      ...(launch.taskRef === undefined ? {} : { data: { task: launch.taskRef } }),
    });
  }
  const boundAt = launch.evidence["bound_at"];
  return {
    id: launch.id,
    reference: launch.reference,
    space: found.space.id,
    task: launch.task,
    taskRef: launch.taskRef,
    state: launch.state,
    route: launch.route,
    boundAt: typeof boundAt === "number" ? boundAt : undefined,
    exited: launch.evidence["exit_code"] !== undefined,
  };
}

/**
 * True when a bind through a tool bound the connection (or found it bound to what it asked for);
 * otherwise the refusal (A3 3.5), with the task references the agent can pass instead.
 */
async function bindWith(
  call: Call,
  outcome: BindOutcome,
  taskRef: string | undefined,
): Promise<boolean> {
  const withTask = taskRef === undefined ? {} : { data: { task: taskRef } };
  const instead = `Pass task ${taskRef ?? "with its reference"} instead.`;
  switch (outcome.kind) {
    case "bound":
      return true;
    case "already_bound": {
      let ref: string | undefined;
      if (outcome.task !== null) {
        try {
          ref = await readTaskRef(readerOf(call.space), outcome.task);
        } catch {
          ref = undefined;
        }
      }
      throw new AppError({
        code: "already_bound",
        message: `This session is bound to ${ref ?? "another task"} already.`,
        hint: `Pass task on a call for another task. Ask the user to rebind the session in ${PRODUCT_NAME}.`,
        ...(ref === undefined ? {} : { data: { task: ref } }),
      });
    }
    case "launch_used":
      throw new AppError({
        code: "launch_used",
        message: "Another session used this launch reference already.",
        hint: instead,
        ...withTask,
      });
    case "launch_ended":
      throw new AppError({
        code: "launch_expired",
        message: "This launch has ended.",
        hint: instead,
        ...withTask,
      });
    case "launch_unknown":
      throw launchUnknown(false);
  }
}

/** A task's place on this machine as it resolves now: its folder, or why not (R11). */
async function placeStateOf(call: Call, place: Row | undefined): Promise<PlaceState | undefined> {
  if (place === undefined) return undefined;
  return placeState(
    {
      root: place["root_id"],
      path: place["rel_path"],
      kind: place["kind"],
      identity: place["identity"],
    },
    call.host.roots?.() ?? [],
    call.host.platform ?? process.platform,
  );
}

function due(value: unknown, today: string, path: string): { date: string } | undefined {
  if (typeof value !== "string") return undefined;
  const date = dueDate(value, today);
  if (date === undefined) {
    throw invalid(
      path,
      "Not a date this service reads",
      "Use an ISO date, today, tomorrow, +3d or a weekday.",
    );
  }
  return { date };
}

function sourceFields(source: Record<string, unknown>, path: string): SourceFields {
  const fields: SourceFields = {
    kind: source["kind"] as SourceFields["kind"],
    title: String(source["title"]),
  };
  for (const key of ["key", "who", "url"] as const) {
    // SafeText may leave a who empty (a name of hidden characters only): then there is none.
    const value = source[key];
    if (typeof value === "string" && (key === "key" || value !== "")) fields[key] = value;
  }
  if (typeof source["at"] === "string") {
    const at = Date.parse(source["at"]);
    if (Number.isNaN(at)) throw invalid(`${path}.at`, "Not a date and time");
    fields.at = at;
  }
  return fields;
}

/** A place field of the input, for the task it binds (a draft's client ID or a reference). */
interface PlaceAsk {
  readonly task: string;
  readonly value: unknown;
  /** The field's input path, for refusals and warnings. */
  readonly at: string;
}

/** The root ID of a stand-in `place.set` in a request the writer replays (`placeSets`). */
const REPLAY_ROOT = "replay";

/**
 * The `place.set` operations of the place fields in `asks`, bound on this machine (places.ts): a
 * root ID and a relative path, whatever form the caller used. A folder under no root is left out
 * when `outside` is `warn` (A3 3.4.5: the task is created without a place, and the result warns),
 * and refused otherwise.
 *
 * A binding depends on this machine's folders as they are now, not on the input alone, so a retry
 * after a lost reply could be refused, or bound otherwise, although the first call was applied.
 * So when the request ID already has a receipt, nothing is bound and no place operation is sent:
 * the writer checks the request's shape, then finds the receipt by the intent before it stages
 * anything, replays it and applies nothing. The request then holds only the input's own
 * operations, never more than the first call had, so it passes the writer's operation limit; a
 * request with no other operation (an update of the place alone) gets one stand-in `place.set`
 * (root `replay`), because the writer refuses a request without operations.
 *
 * The callers put these operations after all others (`others` is how many there are), so every
 * other operation keeps its index whether a folder binds or not, and a replay's stored result
 * lines up with this call's.
 *
 * `warnings` are those of places bound without a remote because their repository's config could
 * not be read exactly (`remoteWarning`): a fact of this call's binding. The callers send them with
 * the request (`submit`'s `warnings`), and the writer keeps them with the result in its receipt, so
 * a replay says exactly what the first call said: never less after a lost reply, and never this
 * call's own binding when a retry raced its first call (that binding is not what was stored).
 */
async function placeSets(
  call: Call,
  asks: readonly PlaceAsk[],
  outside: "warn" | "refuse",
  others: number,
): Promise<{ readonly ops: Operation[]; readonly warnings: string[] }> {
  const asked = asks.filter((ask) => ask.value !== undefined);
  const first = asked[0];
  if (first === undefined) return { ops: [], warnings: [] };
  const standIns = (): { ops: Operation[]; warnings: string[] } => ({
    ops: others > 0 ? [] : [{ kind: "place.set", task: first.task, root: REPLAY_ROOT, path: "" }],
    warnings: [],
  });
  // A request whose ID has a receipt is the writer's to replay: nothing of this machine's folders
  // is read for it, so no folder, remote or root changed since can refuse or reshape a replay.
  if (await applied(call)) return standIns();
  const roots = call.host.roots?.() ?? [];
  const ops: Operation[] = [];
  const warnings: string[] = [];
  for (const ask of asked) {
    try {
      const bound = await bindPlace(
        ask.value,
        call.input["cwd"],
        roots,
        ask.at,
        call.host.platform ?? process.platform,
      );
      if (bound.kind === "outside") {
        if (outside === "refuse") throw placeRefused(ask.at, "outside_roots", bound.roots);
        continue;
      }
      ops.push({ kind: "place.set", task: ask.task, ...bound.place });
      if (bound.remoteUnreadable) warnings.push(remoteWarning(ask.at));
    } catch (error) {
      // The same request may have been decided meanwhile (a retry racing its first call).
      if (!(error instanceof AppError) || !(await applied(call))) throw error;
      return standIns();
    }
  }
  return { ops, warnings };
}

/** Whether the call's request ID has a receipt in its writer scope: a retry the writer replays. */
async function applied(call: Call): Promise<boolean> {
  const writer = writerOf(call.space);
  try {
    const found = await writer.receipt({
      scope_id: call.principal.scope,
      ...(call.principal.earlierScope === undefined
        ? {}
        : { earlier_scope_id: call.principal.earlierScope }),
      request_id: String(call.input["request_id"]),
    });
    return found !== undefined;
  } catch (error) {
    throw storageFailure(error);
  }
}

/**
 * The warnings of drafts that asked for a place and got none: their folder is under no root. Read
 * from the writer's result (a place row under the created task), so a replay warns the same. A
 * draft that matched an existing task binds no place (A1 3.6), and gets no warning for it.
 */
function placeWarnings(
  result: WriteResult,
  drafts: readonly { readonly asked: boolean; readonly first: number; readonly at: string }[],
): string[] {
  return drafts.flatMap((draft) => {
    const create = opAt(result, draft.first);
    if (!draft.asked || create.status === "existing") return [];
    const bound = result.results.some((r) => r.id.startsWith("pl_") && r.task === create.id);
    return bound ? [] : [outsideWarning(draft.at)];
  });
}

/**
 * What happened to a draft (A3 3.4.5), from the writer's result for its task.create at `first`:
 * `created`, or `exists` when its source keys matched a task (A1 3.6), with how it matched and the
 * task's lifecycle. Several active matches name no task: their references are listed, and the
 * caller picks one. From the result alone, so a replay says the same.
 */
function draftOutcome(
  result: WriteResult,
  first: number,
): {
  result: "created" | "exists";
  id?: string;
  ref?: string;
  lifecycle: string;
  matched_by?: "source_key";
  ambiguous?: string[];
} {
  const create = opAt(result, first);
  if (create.status !== "existing") {
    return { result: "created", id: create.id, ref: refOf(create), lifecycle: "active" };
  }
  return {
    result: "exists",
    ...(create.ambiguous === undefined
      ? { id: create.id, ref: refOf(create) }
      : { ambiguous: create.ambiguous }),
    lifecycle: create.lifecycle ?? "active",
    matched_by: "source_key",
  };
}

/**
 * Where an agent's draft goes without a group (A3 3.4.5, 3.8.1): the Inbox, unless it says
 * `inbox: false`. The user's own faces decide where a capture lands themselves (A5).
 */
function toInbox(draft: Record<string, unknown>, agent: boolean): boolean {
  if (typeof draft["inbox"] === "boolean") return draft["inbox"];
  return agent && draft["area"] === undefined && draft["project"] === undefined;
}

/** A draft's group and Inbox flag, as the writer will place its task (A1 3.6). */
function destinationOf(draft: Record<string, unknown>, agent: boolean): Destination {
  const project = typeof draft["project"] === "string" ? draft["project"] : null;
  return {
    project,
    // A task in a project is in that project's area, which the duplicate check needs not know.
    area: project === null && typeof draft["area"] === "string" ? draft["area"] : null,
    inbox: toInbox(draft, agent),
  };
}

/** The area or project of a stand-in in a request the writer replays (`resolvedDrafts`). */
const REPLAY_GROUP = "replay";

/**
 * The drafts (or `update_task`'s `set`) with their area and project names resolved to IDs
 * (groups.ts, A3 3.4.5), as the writer takes them; `path` gives each item's input path. A request
 * ID with a receipt is the writer's to replay: its names are not resolved then, so a group renamed
 * since never refuses a retry of a call that applied (as `placeSets` does for folders), and each
 * one is a stand-in the writer's shape check takes (a name may be longer than its group field),
 * which the writer never resolves, because it finds the receipt before it stages anything. Without
 * names to resolve, nothing is read.
 */
async function resolvedDrafts(
  call: Call,
  list: readonly Record<string, unknown>[],
  path: (k: number) => string,
): Promise<Record<string, unknown>[]> {
  const named = list.some((d) => d["area"] !== undefined || d["project"] !== undefined);
  if (!named) return [...list];
  const standIns = (): Record<string, unknown>[] =>
    list.map((draft) => ({
      ...draft,
      ...(typeof draft["area"] === "string" ? { area: REPLAY_GROUP } : {}),
      ...(typeof draft["project"] === "string" ? { project: REPLAY_GROUP } : {}),
    }));
  if (await applied(call)) return standIns();
  let names: GroupNames;
  try {
    names = await readGroupNames(readerOf(call.space));
  } catch (error) {
    throw storageFailure(error);
  }
  try {
    return list.map((draft, k) => {
      const at = path(k);
      const resolved = { ...draft };
      const area = draft["area"];
      if (typeof area === "string")
        resolved["area"] = resolveGroup(names, "area", area, `${at}.area`);
      const project = draft["project"];
      if (typeof project === "string") {
        const within = typeof resolved["area"] === "string" ? resolved["area"] : undefined;
        resolved["project"] = resolveGroup(names, "project", project, `${at}.project`, {
          area: within,
        });
      }
      return resolved;
    });
  } catch (error) {
    // A retry racing its first call: the request may have been decided meanwhile.
    if (error instanceof AppError && (await applied(call))) return standIns();
    throw error;
  }
}

/**
 * The `possible duplicate` warnings of the drafts (similar.ts, A3 3.4.5): one per draft whose
 * title is close to an active task's in the group it lands in. They go with the request, so the
 * receipt keeps them and a replay says the first call's; a draft that matched an existing task
 * drops its warning after the write (`task.add`).
 */
async function duplicateWarnings(
  call: Call,
  list: readonly Record<string, unknown>[],
  agent: boolean,
): Promise<string[]> {
  if (list.length === 0 || (await applied(call))) return [];
  const destinations = list.map((draft) => destinationOf(draft, agent));
  let siblings;
  try {
    siblings = await readSiblings(readerOf(call.space), destinations);
  } catch (error) {
    throw storageFailure(error);
  }
  return list.flatMap((draft, k) => {
    const destination = destinations[k];
    if (destination === undefined) return [];
    const found = duplicateWarning(
      `tasks.${String(k)}`,
      String(draft["title"]),
      destination,
      siblings,
    );
    return found === undefined ? [] : [found];
  });
}

/**
 * A task draft (A3 3.4.5) as A1 operations: task.create, then its log entry and sources. Its place
 * is bound by `placeSets`, after every draft. `start` is the index its first operation gets in the
 * request; each source.add's index is recorded in `sourcePaths` with the source's input path, for
 * `source_differs`. A draft with a keyed source upserts by it (A1 3.6): `on_existing` says what a
 * match takes, and the writer's rebinding rules apply it. An agent's draft without a group goes to
 * the Inbox (`toInbox`).
 */
function draftOps(
  draft: Record<string, unknown>,
  id: Id<"t">,
  today: string,
  path: string,
  start: number,
  sourcePaths: Map<number, string>,
  agent: boolean,
): Operation[] {
  const create: TaskCreate = { kind: "task.create", id, title: String(draft["title"]) };
  if (toInbox(draft, agent)) create.inbox = true;
  // `return`, the default, is A1's: an active match takes the draft's log entry, nothing else.
  if (draft["on_existing"] === "add_sources") create.link_sources = true;
  // A new task beside finished ones; refused against an active one (A3 3.4.5: invalid_input).
  if (draft["on_existing"] === "create_new") create.dedupe = "new";
  for (const key of ["summary", "status", "effort", "waiting_on", "context"] as const) {
    if (typeof draft[key] === "string") create[key] = draft[key];
  }
  if (draft["inbox"] === false) create.inbox = false;
  if (typeof draft["priority"] === "number") create.priority = draft["priority"];
  if (typeof draft["area"] === "string") create.area = draft["area"];
  if (typeof draft["project"] === "string") create.project = draft["project"];
  const date = due(draft["due"], today, `${path}.due`);
  if (date !== undefined) create.due = date;
  const ops: Operation[] = [create];
  if (typeof draft["log"] === "string") ops.push({ kind: "log.add", task: id, body: draft["log"] });
  const sources = Array.isArray(draft["sources"])
    ? (draft["sources"] as Record<string, unknown>[])
    : [];
  sources.forEach((source, k) => {
    const at = `${path}.sources.${String(k)}`;
    sourcePaths.set(start + ops.length, at);
    ops.push({ kind: "source.add", task: id, source: sourceFields(source, at) });
  });
  return ops;
}

/** Status values that mean a finished task: complete_task's, never update_task's (A3 3.4.6). */
const FINISHED: ReadonlySet<string> = new Set(["done", "completed", "dropped"]);

function checkMode(input: Record<string, unknown>): void {
  if (input["mode"] === "propose") throw unsupported("mode", "M4.02 (autonomy and proposals)");
}

/** A link's URL: a scheme, then no blank, control, format character, quote or angle bracket. */
const LINK_URL = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"\p{Cc}\p{Cf}]+$/u;

/**
 * An entry's text with its links (A3 3.4.7) as a list below it, one `- title: <url>` line each.
 * Schema 0.1 stores no link rows for notes and log entries, so the links are part of the entry's
 * Markdown, where every face and the projection show them. A URL that would break the line is
 * refused; Tasks never fetches one (A3 3.10).
 */
function withLinks(text: string, links: unknown): string {
  const list = Array.isArray(links) ? (links as Record<string, unknown>[]) : [];
  if (list.length === 0) return text;
  const lines = list.map((link, k) => {
    const url = String(link["url"]);
    if (!LINK_URL.test(url)) {
      throw invalid(
        `links.${String(k)}.url`,
        `Not a link ${PRODUCT_NAME} can show`,
        "Give a URL with its scheme.",
      );
    }
    const title = String(link["title"]).trim();
    return `- ${title === "" ? "" : `${title}: `}<${url}>`;
  });
  return `${text}\n\nLinks:\n${lines.join("\n")}`;
}

const drafts = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? (value as Record<string, unknown>[]) : [];

// ---------------------------------------------------------------------------------------------
// The handlers

type Handler = (call: Call) => Promise<unknown>;

const HANDLERS: Readonly<Record<string, Handler>> = {
  "space.status": async (call) => {
    const { input } = call;
    const guide = typeof input["guide"] === "string" ? input["guide"] : undefined;
    if (guide !== undefined && !Object.hasOwn(GUIDES, guide)) {
      throw unsupported("guide", GUIDE_STEPS[guide] ?? "a later step");
    }
    const reader = readerOf(call.space);
    const now = (call.host.now ?? Date.now)();
    // A guide is one workflow text instead of the overview (A3 3.4.2): no sections, no `here`.
    const include =
      guide === undefined && Array.isArray(input["include"]) ? (input["include"] as string[]) : [];
    const cwd = guide === undefined && typeof input["cwd"] === "string" ? input["cwd"] : undefined;
    const platform = call.host.platform ?? process.platform;
    const roots = call.host.roots?.() ?? [];
    // Null: a cwd that is no folder here, so no task matches it.
    const found = cwd === undefined ? undefined : ((await hereOf(cwd, roots, platform)) ?? null);
    const boundTask = call.caller.binding?.session?.task ?? undefined;
    const status = await readStatus(reader, {
      today: call.today,
      week: addDays(call.today, 7),
      since: sinceOf(input["since"], now),
      include,
      ...(found === undefined || found === null || found.roots.length === 0
        ? {}
        : { placed: { machine: call.host.machine.id, roots: found.roots } }),
      ...(boundTask === undefined ? {} : { bound: boundTask }),
    });
    const here =
      found === undefined
        ? undefined
        : found === null
          ? []
          : await hereRows(status.placed, found, roots, platform);
    // A bound session needs no way to bind: the hint is for one that has to choose a task.
    const hint =
      here === undefined || call.caller.binding?.session !== undefined ? undefined : hereHint(here);
    const live =
      here === undefined || here.length === 0
        ? undefined
        : call.host.bindings?.liveSessions(status.space.id);
    return {
      as_of: status.space.asOf,
      date: call.today,
      time_zone: (call.host.timeZone ?? localTimeZone)(),
      autonomy: status.autonomy,
      space: { id: status.space.id, name: status.space.name, ref_prefix: status.space.refPrefix },
      session: sessionOf(call, status.bound),
      ...(here === undefined
        ? {}
        : {
            here: here.slice(0, HERE_ROWS).map(({ row, match }) => ({
              ...taskRow(row, status.space.refPrefix),
              match,
              live_sessions: live?.get(String(row["id"])) ?? 0,
            })),
            here_total: here.length,
          }),
      counts: { statuses: status.statuses, inbox: status.inbox, proposals: 0 },
      ...(include.length === 0 ? {} : { sections: status.sections }),
      ...(guide === undefined ? {} : { guide: GUIDES[guide] }),
      ...(hint === undefined ? {} : { hint }),
    };
  },

  "task.get": async (call) => {
    const { input } = call;
    const asked = Array.isArray(input["sections"]) ? (input["sections"] as string[]) : [];
    if (asked.length === 0 && input["before"] !== undefined) {
      throw invalid("before", "A before token pages a sections read", "Pass its sections too.");
    }
    const reader = readerOf(call.space);
    const slot = call.caller.binding;
    const bindings = call.host.bindings;
    let task: string;
    // Whether this call bound the connection, or found it bound already to what it asked for.
    let bound = false;
    if (typeof input["launch"] === "string") {
      // A3 3.7.3: bind by the launch reference, then load its task. A connection that
      // cannot hold a binding resolves the reference for this call only.
      if (input["task"] !== undefined) throw invalid("task", "Pass task or launch, not both");
      const launch = await launchOf(call, input["launch"]);
      if (slot !== undefined && bindings !== undefined) {
        bound = await bindWith(call, await bindings.redeem(slot, launch), launch.taskRef);
      }
      task = launch.task;
    } else {
      task = await taskOf(call);
    }
    const machine = call.host.machine.id;
    const ranges =
      asked.length === 0
        ? DIGEST_RANGES
        : pageRanges(
            pagePlan(
              asked,
              input["before"],
              typeof input["log_limit"] === "number" ? input["log_limit"] : 20,
            ),
          );
    const read = await readTask(reader, task, { machine, ...ranges });
    // A3 3.7.3: an explicit task choice binds an ad-hoc session, once the task is found.
    if (input["bind"] === true && input["launch"] === undefined) {
      if (slot !== undefined && bindings !== undefined) {
        const id = String(read.row["id"]);
        bound = await bindWith(call, await bindings.bindTask(slot, read.space.id, id), undefined);
      }
    }
    if (asked.length === 0) {
      return {
        view: "digest",
        as_of: read.space.asOf,
        bound,
        task: digestOf(read, call.today, await placeStateOf(call, read.place)),
      };
    }
    const logLimit = typeof input["log_limit"] === "number" ? input["log_limit"] : 20;
    const page = sectionsOf(read, pagePlan(asked, input["before"], logLimit));
    return {
      view: "sections",
      as_of: read.space.asOf,
      bound,
      task: taskRow(read.row, read.space.refPrefix),
      sections: page.sections,
      ...(page.before === undefined ? {} : { before: page.before }),
    };
  },

  "task.add": async (call) => {
    const { input } = call;
    checkMode(input);
    const agent = call.principal.actorKind !== "human";
    const list = await resolvedDrafts(call, drafts(input["tasks"]), (k) => `tasks.${String(k)}`);
    const ops: Operation[] = [];
    const firsts: number[] = [];
    const asks: PlaceAsk[] = [];
    const sourcePaths = new Map<number, string>();
    list.forEach((draft, k) => {
      const id = newId("t");
      firsts.push(ops.length);
      ops.push(
        ...draftOps(draft, id, call.today, `tasks.${String(k)}`, ops.length, sourcePaths, agent),
      );
      asks.push({ task: id, value: draft["place"], at: `tasks.${String(k)}.place` });
    });
    const duplicates = await duplicateWarnings(call, list, agent);
    const places = await placeSets(call, asks, "warn", ops.length);
    ops.push(...places.ops);
    // The binding's own warnings and the possible duplicates go with the request: the writer keeps
    // them with the result, so a replay says the first call's, never this call's late reading.
    const result = await submit(call, ops, { warnings: [...duplicates, ...places.warnings] });
    const placed = placeWarnings(
      result,
      asks.map((ask, k) => ({ asked: ask.value !== undefined, first: firsts[k] ?? 0, at: ask.at })),
    );
    const outcomes = list.map((_, k) => draftOutcome(result, firsts[k] ?? 0));
    // A matched draft binds no place and creates no task, so the warnings of its place and its
    // title do not apply: each starts with the draft's path.
    const matched = list
      .map((_, k) => `tasks.${String(k)}`)
      .filter((_, k) => outcomes[k]?.result === "exists");
    const kept = result.warnings.filter(
      (w) => !matched.some((at) => w.startsWith(`${at}:`) || w.startsWith(`${at}.`)),
    );
    return {
      as_of: result.as_of,
      tasks: list.map((draft, k) => {
        const first = firsts[k] ?? 0;
        // The log entry follows the draft's task.create (draftOps): added to a created task, or
        // to an active match (A1 3.6), which the writer reports as created.
        const log = typeof draft["log"] === "string" ? opAt(result, first + 1) : undefined;
        return {
          ...outcomes[k],
          title: String(draft["title"]),
          log_added: log?.status === "created",
        };
      }),
      warnings: [...differsWarnings(result, sourcePaths), ...placed, ...kept],
      ...replayed(result),
    };
  },

  "task.update": async (call) => {
    const { input, today } = call;
    checkMode(input);
    const task = await taskOf(call);
    const ops: Operation[] = [];
    const fields: string[] = [];
    const set = isRecord(input["set"]) ? input["set"] : {};
    // A3 3.4.6: a finished task is not a status. The input alone decides it, so no receipt.
    if (typeof set["status"] === "string" && FINISHED.has(set["status"].toLowerCase())) {
      throw new AppError({
        code: "wrong_tool",
        message: "A task is finished, not given a status.",
        hint: "Use complete_task with an outcome (tasks done).",
        data: { issues: [{ path: "set.status", message: "Finish the task instead" }] },
      });
    }
    const values: Record<string, unknown> = {};
    for (const key of ["title", "summary", "status", "inbox", "priority", "effort", "waiting_on"]) {
      if (set[key] !== undefined) values[key] = set[key];
    }
    const date = due(set["due"], today, "set.due");
    if (date !== undefined) values["due"] = date;
    if (typeof set["focus"] === "boolean") values["focus"] = set["focus"] ? today : null;
    const clear = Array.isArray(input["clear"]) ? (input["clear"] as string[]) : [];
    // The place is a row of its own: `place.clear` unbinds it (A1 3.6), after the other operations.
    const clearPlace = clear.includes("place");
    if (clearPlace && set["place"] !== undefined) {
      throw invalid("clear", "Set the place or clear it, not both");
    }
    const unset = clear.filter((field) => field !== "place");
    const context = isRecord(input["context"]) ? input["context"] : undefined;
    const append = context?.["mode"] === "append";
    if (context !== undefined && !append) values["context"] = context["text"];
    if (Object.keys(values).length > 0 || unset.length > 0) {
      ops.push({
        kind: "task.patch",
        task,
        ...(Object.keys(values).length > 0 ? { set: values } : {}),
        ...(unset.length > 0 ? { unset: unset as PatchableField[] } : {}),
      });
    }
    // An append needs no base and commutes with another (A1 3.5, A3 3.4.6).
    const appended = append ? context["text"] : undefined;
    if (typeof appended === "string") {
      ops.push({ kind: "task.context_append", task, text: appended });
    }
    if (set["area"] !== undefined || set["project"] !== undefined) {
      // Names as add_tasks takes them (A3 3.4.5): the writer takes IDs and slugs only.
      const [group = set] = await resolvedDrafts(call, [set], () => "set");
      ops.push({
        kind: "task.move",
        task,
        ...(typeof group["area"] === "string" ? { area: group["area"] } : {}),
        ...(typeof group["project"] === "string" ? { project: group["project"] } : {}),
      });
    }
    const added = Array.isArray(input["add_sources"])
      ? (input["add_sources"] as Record<string, unknown>[])
      : [];
    const sourcePaths = new Map<number, string>();
    added.forEach((source, k) => {
      const at = `add_sources.${String(k)}`;
      sourcePaths.set(ops.length, at);
      ops.push({ kind: "source.add", task, source: sourceFields(source, at) });
    });
    if (Array.isArray(input["remove_sources"]) && input["remove_sources"].length > 0) {
      // source.unlink is M3's (A1 3.6), with the link versions of A1 3.5.
      throw unsupported("remove_sources", "M3's source.unlink operation");
    }
    // The place last, so the other operations keep their indexes (placeSets). A folder under no
    // root is refused: binding the place is what the caller asked for.
    const places = await placeSets(
      call,
      [{ task, value: set["place"], at: "set.place" }],
      "refuse",
      ops.length,
    );
    ops.push(...places.ops);
    // Clearing is no binding: it reads no folder, so a retry needs no stand-in (placeSets).
    if (clearPlace) ops.push({ kind: "place.clear", task });
    fields.push(...Object.keys(set), ...clear);
    if (context !== undefined) fields.push("context");
    if (added.length > 0) fields.push("sources");
    if (ops.length === 0) throw invalid("set", "Nothing to change");
    // update_task changes an active task (A3 3.4.6): the writer refuses a completed or archived
    // one with TASK_NOT_ACTIVE (wrong_tool), in the request's transaction, so it is receipted.
    // The binding's warnings go with the request, so a replay says the first call's (task.add).
    const result = await submit(call, ops, { active: true, warnings: places.warnings });
    const applied = result.status === "applied";
    const first = opAt(result, 0);
    const named = [...new Set(fields)];
    const facts = applied ? await commitOf(call, first, result.seq) : undefined;
    return {
      result: applied ? "updated" : "no_change",
      task: refOf(first),
      // The fields the commit changed, read from its history, so a replay answers the same.
      // Unread, the fields the call set stand in.
      fields: !applied ? [] : facts === undefined ? named : changedFields(named, facts),
      as_of: result.as_of,
      warnings: [...differsWarnings(result, sourcePaths), ...result.warnings],
      ...replayed(result),
    };
  },

  "entry.add": async (call) => {
    const { input } = call;
    const kind = String(input["kind"]);
    if (input["for_agents"] === true && kind !== "note") {
      throw invalid("for_agents", "Only a note is addressed to agents");
    }
    const body = withLinks(String(input["text"]), input["links"]);
    const task = await taskOf(call);
    const op: Operation =
      kind === "note"
        ? {
            kind: "note.add",
            task,
            body,
            addressee: input["for_agents"] === true ? "agents" : "self",
          }
        : { kind: "log.add", task, body, log_kind: kind as never };
    const result = await submit(call, [op]);
    const done = opAt(result, 0);
    return {
      result: "logged",
      task: refOf(done),
      entry: done.entry,
      kind,
      as_of: result.as_of,
      ...replayed(result),
    };
  },

  "task.finish": async (call) => {
    const { input } = call;
    checkMode(input);
    const task = await taskOf(call);
    const outcome = typeof input["outcome"] === "string" ? input["outcome"] : undefined;
    const learnings = Array.isArray(input["learnings"]) ? (input["learnings"] as string[]) : [];
    // A3 3.4.8, decided by the writer on the task as it finds it: an active task is completed
    // (done) or archived (dropped), one the user finished first is left as it is (`if_active`),
    // and the outcome and learnings are its wrap-up, `once`: a task wrapped already is no change
    // with the same outcome and a conflict otherwise. The operations follow from the input alone,
    // so a replay's stored result lines up with them whatever the task's state is now.
    const ops: Operation[] = [
      {
        kind: input["status"] === "dropped" ? "task.archive" : "task.complete",
        task,
        if_active: true,
      },
    ];
    if (outcome !== undefined || learnings.length > 0) {
      ops.push({
        kind: "task.wrap_up",
        task,
        ...(outcome === undefined ? {} : { outcome }),
        ...(learnings.length === 0 ? {} : { learnings: { add: learnings } }),
        once: true,
      });
    }
    const own = ops.length;
    const follow = await resolvedDrafts(
      call,
      drafts(input["follow_ups"]),
      (k) => `follow_ups.${String(k)}`,
    );
    const agent = call.principal.actorKind !== "human";
    const firsts: number[] = [];
    // task.finish's result has no warnings (A3 3.4.8): a follow-up's source_differs stays in the
    // receipt's operation results.
    const sourcePaths = new Map<number, string>();
    const asks: PlaceAsk[] = [];
    follow.forEach((draft, k) => {
      const id = newId("t");
      firsts.push(ops.length);
      ops.push(
        ...draftOps(
          draft,
          id,
          call.today,
          `follow_ups.${String(k)}`,
          ops.length,
          sourcePaths,
          agent,
        ),
      );
      asks.push({ task: id, value: draft["place"], at: `follow_ups.${String(k)}.place` });
    });
    // task.finish's result has no warnings, so a follow-up's folder under no root is refused. A
    // follow-up bound without a remote (its config unreadable) has no remote check, unannounced.
    ops.push(...(await placeSets(call, asks, "refuse", ops.length)).ops);
    const result = await submit(call, ops, own > 1 ? { wrapUp: 1 } : {});
    const done = opAt(result, 0);
    // Whether the call finished or wrapped up the task, from the operations' stored results; its
    // lifecycle, wrap-up state and the learnings it recorded from history as of the commit. So a
    // replay answers what the first answer said (A3 3.4.1).
    const changed = Array.from({ length: own }, (_, i) => opAt(result, i)).some(
      (op) => op.status !== "unchanged",
    );
    const facts = await commitOf(call, done, result.seq);
    // Unread, the operations' own results stand in for history. A task finished before this call
    // was left as it was, which they do not say: "completed" stands in for it.
    const finished = done.status !== "unchanged";
    const wrapped = own > 1 && opAt(result, 1).status !== "unchanged";
    return {
      result: changed ? "completed" : "no_change",
      task: refOf(done),
      lifecycle:
        facts?.lifecycle ?? (input["status"] === "dropped" && finished ? "archived" : "completed"),
      ...(facts?.wrapState === undefined ? {} : { wrap_state: facts.wrapState }),
      learnings:
        result.status !== "applied"
          ? 0
          : facts === undefined
            ? wrapped
              ? learnings.length
              : 0
            : facts.changes.filter((c) => c.entity === "learnings" && c.field === null).length,
      // A follow-up upserts by its source keys as task.add's drafts do (A3 3.4.5, 3.4.8).
      follow_ups: follow.map((draft, k) => {
        const outcome = draftOutcome(result, firsts[k] ?? 0);
        return {
          result: outcome.result,
          ...(outcome.ref === undefined ? {} : { ref: outcome.ref }),
          title: String(draft["title"]),
        };
      }),
      as_of: result.as_of,
      ...replayed(result),
    };
  },

  "task.reopen": async (call) => {
    const { input } = call;
    checkMode(input);
    const task = await taskOf(call);
    const result = await submit(call, [
      { kind: "task.reopen", task, reason: String(input["reason"]) },
    ]);
    const done = opAt(result, 0);
    // The status is not part of the writer's result: it is the task's status as of the commit,
    // from history, so a replay answers the same after a later status change.
    const status = (await commitOf(call, done, result.seq))?.status;
    return {
      result: result.status === "applied" ? "reopened" : "no_change",
      task: refOf(done),
      lifecycle: "active",
      status: status ?? "open",
      as_of: result.as_of,
      ...replayed(result),
    };
  },

  "launch.open": async (call) => {
    const { input, host } = call;
    const launches = host.launches;
    if (launches === undefined) {
      throw new AppError({ code: "internal", message: "This service opens no tasks." });
    }
    // A launch writes launch records: the space must be open for writing on this machine.
    writerOf(call.space);
    const space = call.space.id;
    if (space === undefined) throw spaceUnavailable("not_served", false);
    let read;
    try {
      read = await readLaunchTask(readerOf(call.space), String(input["task"]), host.machine.id);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw storageFailure(error);
    }
    const requestId = String(input["request_id"]);
    const text = typeof input["text"] === "string" ? input["text"] : undefined;
    const instance = typeof input["instance"] === "string" ? input["instance"] : undefined;
    // Shift+Copy (A4 3.15.5): the context pack is a Copy, so it takes no instance.
    let pack: PackContent | undefined;
    if (input["pack"] === true) {
      if (instance !== undefined) {
        throw invalid("pack", "The context pack is a Copy", "Leave out instance.");
      }
      try {
        pack = packOf(
          await readTask(readerOf(call.space), read.id, {
            machine: host.machine.id,
            instructions: { upto: null, limit: PACK_NOTES },
            notes: { upto: null, limit: 0 },
            log: { upto: null, limit: PACK_LOG },
          }),
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw storageFailure(error);
      }
    }
    let opened: OpenTaskResult;
    try {
      opened = await launches.openTask({
        space,
        task: read,
        instance,
        composer: text,
        requestId,
        ...(pack === undefined ? {} : { pack }),
        // Over budget, the person's words become a note addressed to agents (A4 3.15.3): the
        // note entry's own request path, under a request ID the click's derives, so a repeated
        // click replays the note instead of adding a second one.
        saveNote: async (body) => {
          await opCall(host, call.caller, {
            space,
            op: "entry.add",
            input: {
              task: read.id,
              kind: "note",
              text: body,
              for_agents: true,
              request_id: noteRequestOf(requestId),
            },
          });
        },
      });
    } catch (error) {
      throw launchError(error);
    }
    return {
      launch: launchReceipt(opened.intent),
      ...(opened.copy === undefined ? {} : { copy: opened.copy }),
      text: opened.composer,
    };
  },

  "import.planning.preview": async (call) => {
    // The dry run writes no operation, but it puts its run folder in the space's folder, and the
    // import it previews can apply only to a space this machine writes: an open space only.
    writerOf(call.space);
    const reader = readerOf(call.space);
    const folder = call.space.folder;
    if (folder === undefined) throw spaceUnavailable("not_served", false, call.space.state);
    try {
      return await planningPreview({
        folder,
        reader,
        input: call.input,
        roots: call.host.roots?.() ?? [],
        platform: call.host.platform ?? process.platform,
        timeZone: (call.host.timeZone ?? localTimeZone)(),
      });
    } catch (error) {
      throw storageFailure(error);
    }
  },

  // A7 3.15.5: the user's apply of a dry run, behind a verified backup, as the import actor.
  "import.planning.apply": async (call) => {
    const writer = writerOf(call.space);
    const reader = readerOf(call.space);
    const folder = call.space.folder;
    if (folder === undefined) throw spaceUnavailable("not_served", false, call.space.state);
    let principal: Id<"ac">;
    try {
      checkGrant(call.host.homes, homesOf(call.caller), call.space.id);
      principal = await actorOf(writer, call.principal);
    } catch (error) {
      throw storageFailure(error);
    }
    try {
      return await planningApply({
        folder,
        reader,
        writer,
        input: call.input,
        roots: call.host.roots?.() ?? [],
        platform: call.host.platform ?? process.platform,
        principal,
        importer: () => writer.actor("import", "import"),
        scope: call.principal.scope,
        ...(call.principal.earlierScope === undefined
          ? {}
          : { earlierScope: call.principal.earlierScope }),
        machine: call.host.machine.id as Id<"m">,
        ...(call.space.backupDir === undefined ? {} : { backupDir: call.space.backupDir }),
        ...(call.host.now === undefined ? {} : { now: call.host.now }),
      });
    } catch (error) {
      throw storageFailure(error);
    }
  },

  // A7 3.15.5: the undo of an applied import, partial by design, never on the undo stack.
  "import.planning.undo": async (call) => {
    const writer = writerOf(call.space);
    const reader = readerOf(call.space);
    let principal: Id<"ac">;
    try {
      checkGrant(call.host.homes, homesOf(call.caller), call.space.id);
      principal = await actorOf(writer, call.principal);
    } catch (error) {
      throw storageFailure(error);
    }
    return await planningUndo({
      ...(call.space.folder === undefined ? {} : { folder: call.space.folder }),
      reader,
      writer,
      input: call.input,
      principal,
      scope: call.principal.scope,
      ...(call.principal.earlierScope === undefined
        ? {}
        : { earlierScope: call.principal.earlierScope }),
      machine: call.host.machine.id as Id<"m">,
      origin: call.principal.origin,
    });
  },

  // A1 3.10.1: the user's one stack, shared by every tab and the user's CLI. Guarded by
  // provenance in the writer, so no base; a conflict comes back as `conflict` with A1's cause.
  "history.undo": async (call) => {
    const { input } = call;
    const op: Operation = {
      kind: "undo",
      ...namedCommit(input),
      ...(input["partial"] === true ? { partial: true } : {}),
    };
    const result = await submit(call, [op], { undoable: false });
    const answer = await historyResult(
      call,
      result,
      result.conflicts.length > 0 ? "partial" : "undone",
    );
    // A3 3.7.4: a script of the same person (`cli-script` on this machine) writes as `script`,
    // whose changes are on no undo stack. When one changed the space after the change undone,
    // the answer names it, so the person knows this undo did not take it back.
    const scripted = await afterWrite(call, (reader) =>
      readScriptChange(reader, {
        scope: principalOf("cli-script", call.host.machine.id).scope,
        undone: String(answer["commit"]),
        seq: result.seq,
      }),
    );
    return scripted === undefined ? answer : { ...answer, script_change: scripted };
  },

  "history.redo": async (call) => {
    const result = await submit(call, [{ kind: "redo", ...namedCommit(call.input) }], {
      undoable: false,
      // A redo is all or nothing (A1 3.10.1): the remedy is a new edit, never a partial form.
      hints: { UNDO_CONFLICT: "Keep their change, or set the value again yourself." },
    });
    return historyResult(call, result, "redone");
  },

  "receipt.get": async (call) => {
    // A read: through the reader, so a read-only space answers too (its receipts came with it).
    const reader = readerOf(call.space);
    let stored;
    try {
      stored = await readReceipt(reader, {
        scope_id: call.principal.scope,
        ...(call.principal.earlierScope === undefined
          ? {}
          : { earlier_scope_id: call.principal.earlierScope }),
        request_id: String(call.input["request"]),
      });
    } catch (error) {
      throw storageFailure(error);
    }
    return receiptResult(stored);
  },

  "task.search": async (call) => {
    // A read through the reader (A3 3.9): a read-only space answers too.
    const reader = readerOf(call.space);
    const { host } = call;
    const space = call.space.id ?? "";
    const platform = host.platform ?? process.platform;
    const boundTask = call.caller.binding?.session?.task ?? undefined;
    try {
      // The input passed the entry's schema (TaskSearchInput) and its SafeText.
      const input: SearchInput = call.input;
      return await runSearch(reader, input, {
        cursors: cursorsOf(host),
        // A cursor serves the binding it was issued to (A3 3.9.5): the scope the call acts in.
        owner: call.principal.scope,
        space,
        audience: call.principal.audience,
        today: call.today,
        now: (host.now ?? Date.now)(),
        timeZone: (host.timeZone ?? localTimeZone)(),
        machine: host.machine.id,
        ...(boundTask === undefined ? {} : { boundTask }),
        updateFailed: call.space.state === "read_only" && call.space.reason === "migration_failed",
        live: () =>
          [...(host.bindings?.liveSessions(space) ?? new Map<string, number>())]
            .filter(([, count]) => count > 0)
            .map(([task]) => task),
        here: async (cwd) => {
          const roots = host.roots?.() ?? [];
          const found = await hereOf(cwd, roots, platform);
          if (found === undefined || found.roots.length === 0) return [];
          // Every lifecycle: the search's scope and filters at S choose among them.
          const placed = await readPlacedAny(reader, host.machine.id, found.roots);
          const rows = await hereRows(placed, found, roots, platform);
          return rows.map(({ row }) => String(row["id"]));
        },
      });
    } catch (error) {
      throw storageFailure(error);
    }
  },

  "group.manage": async (call) => {
    const { input } = call;
    const action = String(input["action"]);
    if (action !== "list") {
      checkMode(input);
      // The input rules of a write come first, so the agent fixes its call once (A3 3.4.10): every
      // write names its group, and a change to an existing one needs base (A1 3.5).
      if (input["path"] === undefined) {
        throw invalid("path", `Required to ${action}`, "Name the area, or the area/project.");
      }
      if (action !== "create" && input["base"] === undefined) {
        throw invalid("base", `Required to ${action}`, "Pass base: the as_of of your last read.");
      }
      // A1's area.* and project.* operations arrive with M4.01b (A3 3.4.10).
      throw unsupported("action", "M4.01b (A1's area and project operations)");
    }
    const reader = readerOf(call.space);
    let read;
    let names: GroupNames | undefined;
    try {
      read = await readGroups(reader);
      if (typeof input["path"] === "string") names = await readGroupNames(reader);
    } catch (error) {
      throw storageFailure(error);
    }
    // `path` narrows the list to one area, named as a draft names one (groups.ts); of "Area/Project"
    // the area. It only looks the area up, so an unknown one is not_found.
    const area = String(input["path"]).split("/")[0]?.trim() ?? "";
    const only =
      names === undefined ? undefined : resolveGroup(names, "area", area, "path", { lookup: true });
    return groupList(read, only);
  },

  "prefs.manage": async (call) => {
    const { input } = call;
    const action = String(input["action"]);
    const actor = call.principal.actorKind;
    if (action === "set") {
      checkMode(input);
      if (input["keys"] !== undefined) {
        throw invalid("keys", "A set names its keys in set", "Leave out keys.");
      }
      checkPrefSets(input["set"], actor);
      // A1's pref.set exists (A1 3.16); this tool's set waits for the step that submits it, with
      // `undoable: false` and the autonomy rules of A3 3.8 (A3 3.4.11).
      throw unsupported("set", "the step that connects this tool to A1's pref.set");
    }
    if (input["set"] !== undefined) {
      throw invalid("set", `A ${action} changes nothing`, "Use action set to change a key.");
    }
    const declared = prefsAsked(input["keys"]);
    let read;
    try {
      read = await readSpacePreferences(readerOf(call.space));
    } catch (error) {
      throw storageFailure(error);
    }
    return {
      action,
      as_of: read.space.asOf,
      prefs: declared.map((p) => prefRow(p, action, read.reads.get(p.key), actor)),
    };
  },

  // Refused by the exposure gate before any handler runs (`opCall`): no connection is bound to a
  // run or routine before M6.06. The handler says the same, so no path reaches a write.
  "run.report": (call) => {
    const bound = call.caller.binding?.session !== undefined;
    checkExposure(call.entry, call.caller.class, bound ? "task" : "none");
    return Promise.reject(new AppError({ code: "internal", message: "No run binding exists." }));
  },
};

// ---------------------------------------------------------------------------------------------
// group.manage (A3 3.4.10) and prefs.manage (A3 3.4.11)

/** A group row as the result names it. */
function groupRow(row: Row): { id: string; slug: string; name: string; active: number } {
  return {
    id: String(row["id"]),
    slug: String(row["slug"]),
    name: String(row["title"]),
    active: Number(row["active"]),
  };
}

/**
 * The areas and their projects (A3 3.4.10), in the space's order: at most GROUP_LIMITS.areas areas,
 * each with at most GROUP_LIMITS.projects projects and the count of those left out, and the
 * projects without an area. `only` keeps one area.
 */
function groupList(
  read: Awaited<ReturnType<typeof readGroups>>,
  only: string | undefined,
): Record<string, unknown> {
  const areas = read.areas.filter((row) => only === undefined || row["id"] === only);
  const projectsOf = (area: unknown) => read.projects.filter((p) => p["area_id"] === area);
  const loose = read.projects.filter(
    (p) => p["area_id"] === null || !read.areas.some((a) => a["id"] === p["area_id"]),
  );
  return {
    action: "list",
    as_of: read.space.asOf,
    areas: areas.slice(0, GROUP_LIMITS.areas).map((row) => {
      const projects = projectsOf(row["id"]);
      const more = projects.length - GROUP_LIMITS.projects;
      return {
        ...groupRow(row),
        projects: projects.slice(0, GROUP_LIMITS.projects).map(groupRow),
        ...(more > 0 ? { more_projects: more } : {}),
      };
    }),
    projects: only === undefined ? loose.slice(0, GROUP_LIMITS.projects).map(groupRow) : [],
    total_areas: areas.length,
    total_projects:
      only === undefined ? read.projects.length : areas.flatMap((a) => projectsOf(a["id"])).length,
  };
}

/**
 * The keys the `preferences` tool shows (A3 3.4.11), sorted: the registry's space keys whose value
 * is one of the tool's kinds, a word, a whole number, true or false, or a list of keys. An object
 * or a map (`grouping.names`, `autonomy.overrides`, `autonomy.areas`) has no form in the schema
 * grammar's outputs yet, and a machine key lives in machine.toml (A1 3.16).
 */
const TOOL_PREFERENCES: readonly PreferenceSpec[] = PREFERENCES.filter(
  (p) =>
    p.scope === "space" &&
    (p.shape.type === "enum" ||
      p.shape.type === "boolean" ||
      p.shape.type === "integer" ||
      p.shape.type === "text" ||
      (p.shape.type === "list" && p.shape.item.type === "text") ||
      isKeyList(p.shape)),
).toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

/** The declarations `keys` names (A3 3.4.11): exact keys or prefixes ending in `.*`, else all. */
function prefsAsked(keys: unknown): PreferenceSpec[] {
  if (!Array.isArray(keys) || keys.length === 0) return [...TOOL_PREFERENCES];
  const wanted = new Set<string>();
  (keys as string[]).forEach((key, k) => {
    const prefix = key.endsWith(".*") ? key.slice(0, -1) : undefined;
    const found = TOOL_PREFERENCES.filter((p) =>
      prefix === undefined ? p.key === key : p.key.startsWith(prefix),
    );
    if (found.length === 0) throw unknownPref(`keys.${String(k)}`, key);
    for (const p of found) wanted.add(p.key);
  });
  return TOOL_PREFERENCES.filter((p) => wanted.has(p.key));
}

/**
 * A key no declaration has. Keys are the product's own words, never stored text, so the closest
 * one may stand in the hint.
 */
function unknownPref(path: string, key: string): AppError {
  const close = TOOL_PREFERENCES.map((p) => p.key).find(
    (name) => editDistance(name, key.toLowerCase(), 3) <= 3,
  );
  return invalid(
    path,
    "No preference has this key",
    close === undefined
      ? "Call preferences with action describe for the keys."
      : `Did you mean ${close}?`,
  );
}

/** Whether `actor` may set the key here (A1 3.16): never a policy key, else by its writers. */
const prefWritable = (p: PreferenceSpec, actor: string): boolean => !p.policy && mayWrite(p, actor);

/** A tool value as the registry stores it: a list of keys becomes the list of `{key}` objects. */
function storedValue(p: PreferenceSpec, value: unknown): unknown {
  return isKeyList(p.shape) && Array.isArray(value)
    ? value.map((key: unknown) => ({ key }))
    : value;
}

/** A stored or default value as the tool shows it: a list of `{key}` objects as its keys. */
function shownValue(p: PreferenceSpec, value: PrefValue | null): PrefValue | null {
  return isKeyList(p.shape) && Array.isArray(value)
    ? value.map((item: unknown) => String((item as { key?: unknown }).key))
    : value;
}

/**
 * Each pair of a `set` (A3 3.4.11), checked as far as the input decides: a declared key, once; a
 * policy key is `forbidden` with rule `policy` for every actor (policy changes through the user's
 * own settings, A3 3.8.2), a key whose writers leave the caller out is `forbidden` with rule
 * `user_only`, and a value other than null must fit its key's own shape in the registry.
 */
function checkPrefSets(pairs: unknown, actor: string): void {
  const list = Array.isArray(pairs) ? (pairs as Record<string, unknown>[]) : [];
  if (list.length === 0) throw invalid("set", "Name the keys to set", "Pass set: [{key, value}].");
  const seen = new Set<string>();
  list.forEach((pair, k) => {
    const at = `set.${String(k)}`;
    const key = String(pair["key"]);
    const declared = TOOL_PREFERENCES.find((p) => p.key === key);
    if (declared === undefined) throw unknownPref(`${at}.key`, key);
    if (seen.has(key)) throw invalid(`${at}.key`, "This key is set twice");
    seen.add(key);
    if (declared.policy) {
      throw new AppError({
        code: "forbidden",
        message: "This setting is policy: only the user changes it.",
        hint: `Ask the user to change it in ${PRODUCT_NAME}'s settings.`,
        data: { rule: "policy", issues: [{ path: `${at}.key`, message: "Policy key" }] },
      });
    }
    if (!prefWritable(declared, actor)) {
      throw new AppError({
        code: "forbidden",
        message: "Only the user can change this setting.",
        hint: `Ask the user to change it in ${PRODUCT_NAME}.`,
        data: { rule: "user_only", issues: [{ path: `${at}.key`, message: "The user's key" }] },
      });
    }
    const value = pair["value"];
    if (value !== null && !fitsShape(declared.shape, storedValue(declared, value))) {
      throw invalid(
        `${at}.value`,
        "Not a value of this key",
        `It takes ${shapeText(declared.shape)}.`,
      );
    }
  });
}

/** One key's row: its value as the registry reads it (the default unless it fits), A1 3.16. */
function prefRow(
  p: PreferenceSpec,
  action: string,
  read: PreferenceRead | undefined,
  actor: string,
): Record<string, unknown> {
  const value = shownValue(p, read?.value ?? p.default);
  const fallback = shownValue(p, p.default);
  return {
    key: p.key,
    ...(action === "describe" ? { summary: p.summary, shape: shapeText(p.shape) } : {}),
    ...(action === "get"
      ? { value, is_default: JSON.stringify(value) === JSON.stringify(fallback) }
      : {}),
    default: fallback,
    writable: prefWritable(p, actor),
    ...(p.policy ? { policy: true } : {}),
  };
}

/**
 * The commit an undo or redo names, checked here: a malformed one depends on the input alone, so
 * it is refused before the writer and stores nothing (A3 3.4.1).
 */
function namedCommit(input: Record<string, unknown>): { commit?: Id<"op"> } {
  const commit = input["commit"];
  if (commit === undefined) return {};
  if (!isId(commit, "op")) {
    throw invalid("commit", "Expected a change's commit ID", "Copy it from the change's history.");
  }
  return { commit };
}

/**
 * An undo's or a redo's result: the change it moved, the tasks its commit changed (read from
 * history, so a replay answers the same; left out when that read fails), and what a partial undo
 * left as others set it.
 */
async function historyResult(
  call: Call,
  result: WriteResult,
  word: "undone" | "partial" | "redone",
): Promise<Record<string, unknown>> {
  const tasks = await afterWrite(call, (reader) => readCommitTasks(reader, result.seq));
  return {
    result: word,
    commit: opAt(result, 0).id,
    ...(tasks === undefined ? {} : { tasks: tasks.refs, task_count: tasks.count }),
    ...(word === "partial"
      ? {
          unresolved: result.conflicts.map((c) => ({
            entity: c.entity,
            // A row other than the task is named by its ID too, as in a conflict (errors.ts).
            ...(c.entity === "tasks" ? {} : { id: c.id }),
            ...(c.ref === undefined ? {} : { task: c.ref }),
            field: c.field,
            by: byOf(c.by),
            at: new Date(c.at).toISOString(),
          })),
        }
      : {}),
    as_of: result.as_of,
    ...replayed(result),
  };
}

/** The search cursors of one service run (A3 3.9.5): a restart drops them with the host. */
const searchCursors = new WeakMap<OpsHost, SearchCursors>();

function cursorsOf(host: OpsHost): SearchCursors {
  let cursors = searchCursors.get(host);
  if (cursors === undefined) {
    cursors = new SearchCursors(host.now ?? Date.now);
    searchCursors.set(host, cursors);
  }
  return cursors;
}

/** The `since` of a changes section: 24h, 7d or an ISO time, in milliseconds. */
/** The request ID of a click's over-budget note: derived, so a repeated click replays it. */
function noteRequestOf(requestId: string): string {
  const digest = createHash("sha256")
    .update(`launch-note\n${requestId}`, "utf8")
    .digest("base64url");
  return `launch-note-${digest.slice(0, 40)}`;
}

/** A launch intent as `launch.open` returns it: IDs, states, instants and fixed codes only. */
function launchReceipt(intent: LaunchIntent): Record<string, unknown> {
  return {
    id: intent.id,
    reference: intent.reference,
    instance: intent.instance,
    route: intent.route,
    state: intent.state,
    ...(intent.reason === null ? {} : { reason: intent.reason }),
    at: { ...intent.at },
  };
}

/** Why a click opened nothing, as A3's error: a fixed reason word, never a path or a command. */
/** At most this many notes the user addressed to agents are read for a pack; it counts the rest. */
const PACK_NOTES = 200;

/**
 * What the context pack takes of a task (A4 3.15.5), from one read: its row, the notes the user
 * addressed to agents (oldest first), its sources and its newest log entries. Related learnings
 * come with A3's retrieval (M4.03): until then the pack has none.
 */
function packOf(read: TaskRead): PackContent {
  const row = taskRow(read.row, read.space.refPrefix);
  const due = row["due"];
  const day = (at: string): string => at.slice(0, 10);
  const optional = (value: unknown): string | undefined =>
    typeof value === "string" && value !== "" ? value : undefined;
  return {
    status: String(row["status"]),
    priority: Number(row["priority"]),
    area: optional(row["area"]),
    project: optional(row["project"]),
    due:
      typeof due === "string"
        ? due
        : typeof due === "object" && due !== null
          ? `${String((due as { at: unknown }).at)} ${String((due as { tz: unknown }).tz)}`
          : undefined,
    summary: optional(text(read.row["summary"])),
    context: optional(text(read.row["context"])),
    instructions: read.instructions
      .map(noteOf)
      .reverse()
      .map((note) => ({ day: day(note.at), text: note.text })),
    instructionsTotal: read.counts.instructions,
    sources: read.sources.map(sourceOf).map((s) => ({
      kind: s.kind,
      title: s.title,
      key: s.key,
      who: s.who,
    })),
    learnings: [],
    log: read.log.map(logOf).map((e) => ({
      day: day(e.at),
      kind: e.kind,
      author: e.author,
      text: e.text,
    })),
    logTotal: read.counts.log,
  };
}

function launchError(error: unknown): unknown {
  if (error instanceof LaunchUnavailable) {
    return new AppError({
      code: "invalid_input",
      message:
        error.reason === "not_set_up"
          ? "This instance is not set up on this machine."
          : error.reason === "other_machine"
            ? "This task's folder is on another machine."
            : "This instance cannot open the task here.",
      data: { field: "instance", reason: error.reason },
    });
  }
  if (error instanceof LaunchFolderUnavailable) {
    return new AppError({
      code: "invalid_input",
      message: "This task's folder cannot be used on this machine.",
      data: { field: "task", reason: error.reason },
    });
  }
  if (error instanceof ExecutionRefused) {
    switch (error.code) {
      case "not_found":
        return new AppError({ code: "not_found", message: "The task or its place is gone." });
      case "request_id_reused":
        return new AppError({
          code: "request_id_conflict",
          message: "This request ID was used for another click.",
        });
      case "unavailable":
        return spaceUnavailable("not_served", true);
      default:
        return invalid("task", "The launch could not be recorded");
    }
  }
  return error;
}

function sinceOf(value: unknown, now: number): number {
  if (value === "7d") return now - 7 * 86_400_000;
  if (typeof value === "string" && value !== "24h") {
    const at = Date.parse(value);
    if (!Number.isNaN(at)) return at;
  }
  return now - 86_400_000;
}

/** An instance or app word a connection may show: a key, never a sentence. */
const CLIENT_WORD = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * This connection's session (A3 3.4.2): bound, with its task line and the notes from the user for
 * agents on it, or unbound. An MCP connection shows the instance and app its entry names.
 */
function sessionOf(
  call: Call,
  bound: { readonly ref: string; readonly instructions: number } | undefined,
): Record<string, unknown> {
  const { instance, app } = call.caller.client ?? {};
  const session = call.caller.binding?.session;
  return {
    state: session === undefined ? "unbound" : "bound",
    ...(session === undefined || bound === undefined
      ? {}
      : { task: bound.ref, notes_for_agents: bound.instructions }),
    ...(instance !== undefined && CLIENT_WORD.test(instance) ? { instance } : {}),
    ...(app !== undefined && CLIENT_WORD.test(app) ? { app } : {}),
  };
}

const getTaskTool = findEntry("task.get")?.faces.mcp?.tool ?? "task.get";

/**
 * What an unbound session does next when tasks match the working folder exactly (A3 3.4.2's
 * example, 3.7.6 E): with one clear match it binds and tells the user, with several it asks. The
 * folder itself never binds.
 */
function hereHint(
  here: readonly { readonly row: Row; readonly match: Match }[],
): string | undefined {
  const exact = here.filter((h) => h.match === "exact").length;
  if (exact === 1) {
    return `One task matches this folder. If your work belongs to it, call ${getTaskTool} with task and bind true, and tell the user.`;
  }
  if (exact > 1) {
    return `${String(exact)} tasks match this folder. Ask the user which one, then call ${getTaskTool} with task and bind true.`;
  }
  return undefined;
}

/** The space's name and prefix, for a person's output. */
export async function spaceNameOf(
  space: ServedSpace,
): Promise<{ name: string; refPrefix: string } | undefined> {
  if (space.reader === undefined) return undefined;
  const facts = await readSpace(space.reader);
  return { name: facts.name, refPrefix: facts.refPrefix };
}
