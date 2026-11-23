// The request path for operations (A2 3.6.4 `op/call` and `op/list`; A3 3.2, 3.4, 3.5, 3.7.9;
// A1 3.8). One function per M1 registry entry. It is independent of the transport: the
// local endpoint calls it now, MCP (M2.02, M2.03) and HTTP (M2.12) call the same functions with
// their own caller. For every call:
//
//   entry → exposure (the class may call it) → principal (audience, actor, writer scope)
//   → the caller's input parsed with the contract (SafeText, defaults, the audience's limits)
//   → the space → reads through the space's reader, writes expanded into A1 operations and sent
//     to the space's writer with the scope and the intent
//   → the contract's result, checked against the entry's output schema, or the error body.
//
// A write's result is built from the writer's result and the caller's input only, so a replay of
// the same request ID gives the same result (A3 3.4.1), marked `replayed`.
import { CLI_NAME, PRODUCT_NAME } from "@ttasks/brand";
import {
  findEntry,
  AppError,
  FINISHED_CURSOR,
  GROUP_LIMITS,
  isKeyList,
  laterIn,
  LATER_PREFERENCES,
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
} from "@ttasks/contracts";
import {
  folderKey,
  freeSlug,
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
} from "@ttasks/storage";
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
  ExecutionRefused,
  isLaunchRef,
  MANUAL_INSTANCE,
  PACK_LOG,
  type LaunchIntent,
} from "@ttasks/launch";
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
  LaunchFolderUnmarked,
  LaunchUnavailable,
  type OpenTaskRequest,
  type OpenTaskResult,
  type PackContent,
} from "../launch/open.ts";
import type { Session, SessionPort } from "./binding.ts";
import { checkGrant, grantRefused, standingOf, type HomeGate } from "./grant.ts";
import { addDays, dateIn, dueDate, localTimeZone, pastInstant } from "./dates.ts";
import { GUIDES } from "./guides.ts";
import { HERE_ROWS, hereOf, hereRows, type Here, type Match } from "./here.ts";
import {
  checkFolder,
  deepestProject,
  folderState,
  expanded,
  folderName,
  folderRefused,
  moveOf,
  openPath,
  osOf,
  reservedBy,
  storedForm,
  type BindFacts,
  type Folder,
  type Follower,
} from "./folders.ts";
import {
  byOf,
  invalid,
  readOnly,
  resultFailure,
  schemaFailure,
  spaceUnavailable,
  refuseLater,
  storageFailure,
  type PathOf,
} from "./errors.ts";
import type { FolderMarkers } from "./marker.ts";
import { repoName } from "./repo.ts";
import { SearchCursors } from "../search/cursors.ts";
import { runSearch, type SearchInput } from "../search/search.ts";
import { editDistance, resolveGroup } from "./groups.ts";
import {
  readCommit,
  readCommitTasks,
  readBind,
  readFolderOwner,
  readGroupNames,
  readGroups,
  readLaunch,
  readFoldersHere,
  readHereTasks,
  readProjectFolders,
  readMove,
  readReceipt,
  readScriptChange,
  readUndoTarget,
  readSpacePreferences,
  readLaunchTask,
  readPersonsNote,
  readSiblings,
  readSpace,
  readStatus,
  readTask,
  readTaskKeys,
  readTaskRef,
  logOf,
  noteOf,
  sourceOf,
  taskRow,
  text,
  type CommitFacts,
  type HereIds,
  type TaskFolder,
  type TaskRead,
  type BindRead,
  type MoveRead,
  type Destination,
  type GroupNames,
  type ProjectFolderRow,
} from "./read.ts";
import { duplicateWarning } from "./similar.ts";
import {
  DIGEST_RANGES,
  digestOf,
  pagePlan,
  pageRanges,
  requestText,
  sectionsOf,
  type DigestFolder,
} from "./task-view.ts";
import { readFinished } from "./task-rows.ts";

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
  /** An open space whose backups are not working: why, in a fixed word (hub/backup-health.ts). */
  readonly backup?: string;
  /** Set while the space is open as this machine's. */
  readonly writer: SpaceWriterHandle | undefined;
  /** Set while the space is served: open or read-only. */
  readonly reader: WorkerConnection | undefined;
  /** The space's folder on this machine. */
  readonly folder?: string;
}

/** What the request path needs from its host. */
export interface OpsHost {
  /** This machine's ID: the writer scopes name it, and places belong to it. */
  readonly machine: { readonly id: string; readonly name?: string };
  spaces(): readonly ServedSpace[];
  /** The OS whose path rules a folder follows. Default: this process's. */
  readonly platform?: NodeJS.Platform;
  /**
   * The person's home folder on this machine: what `~` in a folder means. None: no folder binds,
   * and a folder under `~` is not found here.
   */
  readonly home?: string;
  /** TTasks's own data folder (the TTasks home): no folder is bound inside it. */
  readonly dataFolder?: string;
  /** The markers in projects' and tasks' folders (marker.ts). None: no folder is marked. */
  readonly markers?: FolderMarkers;
  /** Milliseconds since 1970. Default: Date.now. */
  readonly now?: () => number;
  /** The space's time zone. Default: this machine's. */
  readonly timeZone?: () => string;
  /**
   * Who an agent's connection is, and what a session may do now (binding/). Without it no
   * connection is a session.
   */
  readonly sessions?: SessionPort;
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
  /** Told of a write's answer that does not match its entry's contract (the service logs it). */
  readonly resultMismatch?: (entry: string) => void;
}

/** What the request path needs of the launch service (launch/service.ts). */
export interface LaunchPort {
  openTask(request: OpenTaskRequest): Promise<OpenTaskResult>;
  /**
   * Marks a link or Copy launch Connected after an agent read its task through `writer`, the open
   * writable copy the read used: nothing when that writer no longer serves the space. A
   * best-effort app's link is confirmed only from the folder its link named. Throws when the space
   * cannot take it now.
   */
  connected(
    space: string,
    writer: SpaceWriterHandle,
    launch: string,
    at: number,
    folder: string | undefined,
  ): Promise<unknown>;
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
    hint: `Update ${PRODUCT_NAME}, or restart the service: ${CLI_NAME} service restart.`,
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
  const who = decided(host, caller);
  // A run-only entry is refused to every connection: it names whether the call is a session's,
  // and reads neither its input nor a space.
  checkExposure(entry, caller.class, who.binding?.kind === "session" ? "task" : "none");
  return callAs(host, who, entry, params);
}

/**
 * The caller as its call goes on: an agent's shell is decided as its call starts, by the same rule
 * as a bridge's bind, so the call keeps one identity from here to its answer.
 */
function decided(host: OpsHost, caller: Caller): Caller {
  if (caller.class !== "cli-agent" || caller.binding !== undefined) return caller;
  const decision = host.sessions?.decide({ via: "shell", env: caller.env });
  return decision?.kind === "session"
    ? { ...caller, binding: { kind: "session", session: decision.session } }
    : caller;
}

/**
 * `opCall` as the caller's principal: a session writes as itself, computed from who the connection
 * is and its home's instance now, never from anything in the call. A retry that races its first
 * call needs no wait here: both reach the one writer, which decides one and replays the other.
 */
function callAs(
  host: OpsHost,
  caller: Caller,
  entry: AnyEntry,
  params: OpCallParams,
): Promise<unknown> {
  const standing = standingOf(host.sessions, caller);
  const principal =
    standing !== undefined && caller.binding?.kind === "session"
      ? sessionPrincipal(
          caller.binding.session,
          standing.instance,
          caller.class === "bridge" ? "mcp" : "cli",
        )
      : (caller.principal ?? principalOf(caller.class, host.machine.id, caller.grant));
  return callWith(host, caller, entry, params, principal);
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
    throw invalid(
      "base",
      `Required to ${action}`,
      "Pass base: the as_of of the last answer that showed you what you change.",
    );
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
  refuseLater(entry.name, input);
  const parsed = parseInput(entry, principal.audience, input);
  if (!parsed.success) throw schemaFailure(parsed.error, input, principal.origin, entry.name);
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
  // A call that binds a folder or may create a group by name decides on what it read of the
  // space: such calls go one at a time per space, from that read to the writer's answer, so two
  // never both create one name or bind one folder by two spellings.
  const result = await (decidesOnNames(entry.name, call.input)
    ? oneAtATime(space.id, () => handler(call))
    : handler(call));
  const checked = entry.output.safeParse(result);
  if (!checked.success) {
    // A write whose handler returned has done its work, whichever path it wrote through: an error
    // would send the caller to do it again, or to undo an older change. The mismatch is a defect
    // to find in the log. A read has changed nothing, so its caller can be told plainly.
    if (entry.kind === "write") {
      host.resultMismatch?.(entry.name);
      return result;
    }
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
 * The space a call uses: `space` (a folder, an ID or a name), else TTASKS_SPACE from the connection,
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

function pickSpace(host: OpsHost, caller: Caller, named: string | undefined): UsableSpace {
  const binding = caller.binding;
  if (binding?.kind === "session") return heldSpace(host, caller, binding.session.space, named);
  if (caller.class === "bridge") {
    // A bridge never picks a space on a call: its bind settled one for its life, or none.
    const held = binding?.space;
    // Read only for a refusal: the one space its home's live row names, for a hand-made entry the
    // machine's default.
    const entry = (): EntryFacts => ({
      named: binding?.named === true,
      manual: caller.home === undefined || caller.home === MANUAL_INSTANCE,
      mayUse: host.homes?.spaceOf(caller.home ?? ""),
    });
    if (held === undefined) {
      const facts = entry();
      // An instance whose home has no one live row (revoked, never registered, or two): the
      // grant refusal's command registers the home and rewrites its entry in one step.
      if (!facts.manual && facts.mayUse === undefined) throw grantRefused();
      throw noSpace(host, facts);
    }
    try {
      return heldSpace(host, caller, held, named);
    } catch (error) {
      // Its home may use another space now: it says which, and what moves the agent there. The
      // held space is kept, never replaced, while it is denied.
      if (!(error instanceof AppError) || error.data["rule"] !== "grant") throw error;
      const facts = entry();
      if (facts.mayUse === undefined || facts.mayUse === held) throw error;
      throw grantedElsewhere(host, facts.mayUse, facts);
    }
  }
  return pickByRule(host, caller, named);
}

/**
 * The space a session or a bridge holds, kept whether it is open, opening, closed or denied: the
 * grant first, so a home that may not use it can do nothing whatever the call names; a call that
 * names another space is refused, never sent to either; a held space not served now is
 * `space_unavailable`, never another space.
 */
function heldSpace(
  host: OpsHost,
  caller: Caller,
  held: string,
  named: string | undefined,
): UsableSpace {
  checkGrant(host, caller, held);
  const live = host.spaces().filter((s) => s.state !== "closed");
  if (named !== undefined && named !== held) {
    const other = findSpace(live, named);
    // A name is not known until its space opens: while the held space opens, it may be its own.
    // Another ID, or another space's folder, is never its own, opening or not.
    const ownOpening = live.some((s) => s.state === "opening" && s.registered === held);
    const name = !isId(named, "sp") && !isAbsolute(named);
    if (other === undefined && name && ownOpening) throw spaceUnavailable("opening", true);
    // A copy that is still opening is known by the ID its entry names.
    if (other === undefined || isAmbiguity(other) || (other.id ?? other.registered) !== held) {
      throw new AppError({
        code: "forbidden",
        message: "This session is bound to another space.",
        hint: "Leave out the space: a session's calls go to the space it is bound to.",
        data: { rule: "binding" },
      });
    }
    // A folder names its copy, which a session of the space may use.
    if (isAbsolute(named)) return answerFor(live, other, named);
  }
  const found = copyOf(live, held);
  if (isAmbiguity(found)) throw ambiguousError(found);
  return answerFor(live, found, held);
}

/** A space a call may go on with: open or read-only, so served, with its ID. */
export type UsableSpace = ServedSpace & { readonly id: string };

/**
 * The one answer for the space a call means, which every call's path ends in (`pickSpace` for a
 * person, an agent's shell, a session and a bridge, and `personSpace` for the run verbs): its copy
 * when it is open or read-only; `opening`, to retry, while it is still opening; else `not_served`,
 * with the copy's reason. A copy found by its folder or its registered ID while it opens has no
 * ID yet, so nothing past here meets one.
 */
function answerFor(
  live: readonly ServedSpace[],
  found: ServedSpace | undefined,
  wanted: string | undefined,
): UsableSpace {
  if (found === undefined) {
    throw wanted === undefined ? spaceUnavailable("not_served", false) : unserved(live, wanted);
  }
  if (found.state === "opening") throw spaceUnavailable("opening", true);
  if (found.id === undefined || (found.state !== "open" && found.state !== "read_only")) {
    throw spaceUnavailable("not_served", false, found.reason ?? found.state, found.message);
  }
  return found as UsableSpace;
}

/**
 * Why no copy answers for the space `wanted` means: `opening`, to retry, while a space that may be
 * it is still opening, else `not_served`. An opening space has no ID of its own yet, only the one
 * its entry names, and no name until it opens.
 */
function unserved(live: readonly ServedSpace[], wanted: string): AppError {
  const opening = live.filter((s) => s.state === "opening");
  const may = isId(wanted, "sp")
    ? opening.some((s) => s.registered === wanted)
    : !isAbsolute(wanted) && opening.length > 0;
  return may ? spaceUnavailable("opening", true) : spaceUnavailable("not_served", false);
}

/**
 * What a bridge's refusal knows of its entry, so its hint says what helps that entry: whether it
 * named a space, whether it is hand-made (no instance, so only the machine's default), and the one
 * space its home may use now. Setup's own entry always names the space its home is registered for,
 * so a registered home's entry that names none, or a name that is no space, was edited by hand,
 * and the default does not help it: naming its space does.
 */
interface EntryFacts {
  readonly named: boolean;
  readonly manual: boolean;
  readonly mayUse: string | undefined;
}

const ENTRY = `the agent's ${PRODUCT_NAME} entry`;

/** A space as a hint names it: by name when it is open, else by ID. */
function spaceWords(host: OpsHost, space: string): string {
  const name = host.spaces().find((s) => s.id === space)?.name;
  return name === undefined ? space : `the space ${name}`;
}

/**
 * A bridge whose bind found no space it can be sure of: refused on every call, saying what settles
 * it. Its entry named a space that is no one space here; or it named none, and its process
 * started with no default to take, or an older bridge reconnected without its space. It serves
 * two entries: a registered home with one space it may use, told to name that space, and a
 * hand-made entry, told what the default needs. A registered home with no such space gets the
 * grant refusal instead (pickSpace).
 */
function noSpace(host: OpsHost, entry: EntryFacts): AppError {
  const unknown = entry.named
    ? `The agent's ${PRODUCT_NAME} entry names a space this machine has none of, or two of (${CLI_NAME} space list). `
    : "";
  let fix: string;
  if (!entry.manual && entry.mayUse !== undefined) {
    fix = `It may use ${spaceWords(host, entry.mayUse)}: ask the user to name it in ${ENTRY} (--space ${entry.mayUse}), then to restart the agent app.`;
  } else if (entry.named) {
    fix =
      "Ask the user to take the space out of the entry, which then uses the default space, or to correct it, then restart the agent app.";
  } else if (host.defaultSpace?.() !== undefined) {
    fix = "Ask the user to restart the agent app: it then works in the default space.";
  } else {
    fix = `Ask the user to set a default space (${CLI_NAME} space use, after ${CLI_NAME} space create if there is none), then restart the agent app.`;
  }
  return new AppError({
    code: "space_unavailable",
    message: "This connection has no space it can work in.",
    hint: `${unknown}${fix}`,
    data: { reason: "no_space", retryable: false },
  });
}

/**
 * The grant refusal of a bridge whose home may use another space now, which it names, with what
 * moves it there. A hand-made entry: a restart, which takes the default, after taking out a space
 * it names. A registered home: a restart with that space named in its entry, as setup writes it.
 */
function grantedElsewhere(host: OpsHost, space: string, entry: EntryFacts): AppError {
  const there = spaceWords(host, space);
  const hint = !entry.manual
    ? `It may use ${there} now: ask the user to check that ${ENTRY} names it (--space ${space}), then to restart the agent app.`
    : entry.named
      ? `It may use ${there} now: ask the user to take the space out of ${ENTRY}, then to restart the agent app.`
      : `It may use ${there} now: ask the user to restart the agent app to work there.`;
  return new AppError({
    code: "forbidden",
    message: "This agent is not registered for this space.",
    hint,
    data: { rule: "grant", space },
  });
}

/** The space a person's own command means: the one it names, else the machine's default. */
export function personSpace(host: OpsHost, named: string | undefined): UsableSpace {
  return pickByRule(host, { class: "cli-interactive", env: {} }, named);
}

function pickByRule(host: OpsHost, caller: Caller, named: string | undefined): UsableSpace {
  const live = host.spaces().filter((s) => s.state !== "closed");
  // A bridge's environment is not passed (A3 3.7.2: TTASKS_SPACE never chooses its space).
  const fromEnv = caller.binding === undefined ? caller.env["TTASKS_SPACE"] : undefined;
  const wanted = named ?? (fromEnv === "" ? undefined : fromEnv);
  if (wanted !== undefined) {
    const found = findSpace(live, wanted);
    if (isAmbiguity(found)) throw ambiguousError(found);
    return answerFor(live, found, wanted);
  }
  if (caller.class === "cli-agent") {
    throw invalid("space", "Name the space", "Pass --space, or set TTASKS_SPACE.");
  }
  const defaultId = host.defaultSpace?.();
  if (defaultId !== undefined) {
    const fallback = copyOf(live, defaultId);
    if (isAmbiguity(fallback)) throw ambiguousError(fallback);
    return answerFor(live, fallback, defaultId);
  }
  const only = onlySpace(live);
  if (only === undefined) return answerFor(live, undefined, undefined);
  if (only === "several") {
    throw invalid(
      "space",
      "Name the space",
      "Pass --space with an ID, a name or a folder from ttasks space list.",
    );
  }
  if (isAmbiguity(only)) throw ambiguousError(only);
  return answerFor(live, only, undefined);
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

/** Whether a field of the input resolves against `cwd`: a folder given as "cwd". */
function resolvesCwd(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(resolvesCwd);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([k, v]) => (k === "folder" && v === "cwd") || resolvesCwd(v));
}

/**
 * The input as the receipt's fingerprint covers it (A3 3.4.1): the input as the
 * caller sent it, without `cwd` when nothing in it resolves against that folder. The CLI fills
 * `cwd` itself, like the base, so a retry from another folder is the same intent; a folder given as
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
    /**
     * The groups a call creates by name, `count` operations put at `at` ahead of the handler's own:
     * a refusal's `op` counts the handler's own operations, as its results do (`ownResults`).
     */
    readonly inserted?: { readonly at: number; readonly count: number };
    /** The input path of the caller's own operation `i`, with the field a refusal names. */
    readonly pathOf?: PathOf;
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
    checkGrant(call.host, call.caller, call.space.id);
    const principalId = await actorOf(writer, principal);
    const request: WriteRequest = {
      space_id: writer.spaceId,
      request_id: String(input["request_id"]),
      actor: {
        scope_id: principal.scope,
        principal_id: principalId,
        actor_kind: principal.actorKind,
        machine_id: call.host.machine.id as Id<"m">,
        origin: principal.origin,
        ...(principal.session === undefined ? {} : { session_id: principal.session as Id<"se"> }),
        ...(principal.run === undefined ? {} : { run_id: principal.run as Id<"ru"> }),
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
    checkGrant(call.host, call.caller, call.space.id);
    result = await writer.submit(request);
  } catch (error) {
    throw storageFailure(error);
  }
  if (result.status === "conflict" || result.status === "rejected") {
    const { inserted } = options;
    const own =
      inserted === undefined
        ? undefined
        : (i: number): number | undefined =>
            i < inserted.at ? i : i < inserted.at + inserted.count ? undefined : i - inserted.count;
    const field = result.error?.field;
    const keyed = field === "status" || field === "effort" ? field : undefined;
    let hints = options.hints;
    if (result.error?.code === "VALIDATION_FAILED" && keyed !== undefined) {
      const keys = await readTaskKeys(readerOf(call.space)).catch(() => undefined);
      if (keys !== undefined) {
        hints = { ...hints, VALIDATION_FAILED: allowedHint(keyed, keys[keyed]) };
      }
    }
    throw resultFailure(result, hints, options.wrapUp, principal.origin, own, options.pathOf);
  }
  return result;
}

const replayed = (result: WriteResult) => (result.replayed === true ? { replayed: true } : {});

/** What a status or an effort may be in this space, as a refusal's hint. */
function allowedHint(field: "status" | "effort", keys: readonly string[]): string {
  return field === "status"
    ? `Use one of the space's statuses: ${keys.join(", ")}.`
    : `Use one of the space's efforts: ${keys.join(", ")}. Put another estimate in context.`;
}

/** The writer's name of a draft's field where the caller's input names it otherwise. */
const DRAFT_INPUT: Readonly<Record<string, string>> = { dedupe: "on_existing" };

/**
 * Where each operation of drafts came from in the input (`at(k)` for draft `k`), so a refusal
 * names the draft and its field: the draft's own field for its task.create, its log, a source by
 * `sources`, its folder.
 */
function draftPathOf(
  ops: readonly Operation[],
  ids: readonly string[],
  at: (k: number) => string,
  sources: ReadonlyMap<number, string>,
): PathOf {
  return (i, field) => {
    const source = sources.get(i);
    if (source !== undefined) return source;
    const op = ops[i];
    if (op === undefined) return undefined;
    const task = op.kind === "task.create" ? op.id : "task" in op ? op.task : undefined;
    const k = typeof task === "string" ? ids.indexOf(task) : -1;
    if (k < 0) return undefined;
    switch (op.kind) {
      case "task.create":
        return field !== undefined && /^[a-z_]+$/u.test(field)
          ? `${at(k)}.${DRAFT_INPUT[field] ?? field}`
          : at(k);
      case "log.add":
        return `${at(k)}.log`;
      case "task.folder_set":
        return `${at(k)}.folder`;
      default:
        return at(k);
    }
  };
}

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

/**
 * The sources of the draft at `path` that were linked without their key, because another active
 * task holds it (Dedupe.decide), by their index in the draft.
 */
function heldOf(
  result: WriteResult,
  paths: ReadonlyMap<number, string>,
  path: string,
): { held?: { source: number; held_by: string }[] } {
  const prefix = `${path}.sources.`;
  const held = result.results.flatMap((op) => {
    const at = paths.get(op.i);
    if (op.held_by === undefined || at?.startsWith(prefix) !== true) return [];
    return [{ source: Number(at.slice(prefix.length)), held_by: op.held_by }];
  });
  return held.length === 0 ? {} : { held };
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
 * column of the grouping, `folder` and `sources` by a row of theirs under the task.
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
      case "folder":
        return rows("folders").length > 0;
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
 * An agent read a link or Copy launch's task: the launch is marked Connected, once. Only for a
 * bridge or an agent's shell, on the open writable copy this call read, with the grant checked
 * again. It never fails the read: a mark that did not land is tried again at the next such read.
 */
async function markConnected(call: Call, launch: FoundLaunch): Promise<void> {
  const { caller, space } = call;
  if (caller.class !== "bridge" && caller.class !== "cli-agent") return;
  if (launch.route !== "link" && launch.route !== "clipboard") return;
  if (launch.state === "failed" || launch.boundAt !== undefined) return;
  if (space.state !== "open" || space.writer === undefined || space.id === undefined) return;
  try {
    checkGrant(call.host, caller, space.id);
    await call.host.launches?.connected(
      space.id,
      space.writer,
      launch.id,
      (call.host.now ?? Date.now)(),
      caller.folder,
    );
  } catch {
    // Tried again at the next read.
  }
}

/** The session a call's connection is, if it is one. */
const sessionIn = (call: Call): Session | undefined =>
  call.caller.binding?.kind === "session" ? call.caller.binding.session : undefined;

/**
 * The task a call names, else its session's task, else `unbound` with the tasks for the caller's
 * `cwd` as candidates, best first, when it gave one. The working folder never picks the task:
 * the model or the user chooses from the candidates.
 */
async function taskOf(call: Call): Promise<string> {
  const task = call.input["task"];
  if (typeof task === "string") return task;
  const bound = sessionIn(call)?.task;
  if (bound !== undefined) return bound;
  const cwd = call.input["cwd"];
  let candidates: Record<string, unknown>[] = [];
  if (typeof cwd === "string") {
    const here = await hereFor(call, cwd);
    if (here !== undefined) {
      const read = await readHereTasks(readerOf(call.space), here.ids);
      candidates = hereRows(read.rows, here.found)
        .slice(0, CANDIDATES)
        .map(({ row }) => taskRow(row, read.space.refPrefix));
    }
  }
  throw new AppError({
    code: "unbound",
    message: "Name the task: this call is not bound to one.",
    hint: "Pass task, such as M-14. status with your cwd lists the tasks for your folder.",
    ...(candidates.length === 0 ? {} : { data: { candidates } }),
  });
}

/** A launch as its reference finds it in the call's space. */
interface FoundLaunch {
  /** `la_` ID. */
  readonly id: string;
  /** Its task (`t_` ID). */
  readonly task: string;
  readonly state: string;
  readonly route: string;
  /** Whether it was marked Connected already (evidence `bound_at`). */
  readonly boundAt: number | undefined;
  /** The note the launch names as the person's request. */
  readonly request: string | undefined;
}

const launchUnknown = (typo: boolean): AppError =>
  new AppError({
    code: "launch_unknown",
    message: "No launch in this space has this reference.",
    hint: typo
      ? "Its check character does not match: a symbol may be mistyped. Check the Brief."
      : "Check the reference in the Brief, or pass task.",
  });

/**
 * The launch a reference names in the call's space: one whose check character fails, that no
 * launch of this space and machine has, of a routine, or that never left the service (Prepared) is
 * `launch_unknown`. Any other reads its task, whatever its age or state: a reference is never
 * given to another launch.
 */
async function launchOf(call: Call, reference: unknown): Promise<FoundLaunch> {
  if (!isLaunchRef(reference)) throw launchUnknown(true);
  let found;
  try {
    found = await readLaunch(readerOf(call.space), reference);
  } catch (error) {
    throw storageFailure(error);
  }
  const launch = found.launch;
  if (
    launch === undefined ||
    launch.task === null ||
    launch.machine !== call.host.machine.id ||
    launch.state === "prepared"
  ) {
    throw launchUnknown(false);
  }
  const boundAt = launch.evidence["bound_at"];
  const request = launch.evidence["request"];
  return {
    id: launch.id,
    task: launch.task,
    state: launch.state,
    route: launch.route,
    boundAt: typeof boundAt === "number" ? boundAt : undefined,
    request: typeof request === "string" ? request : undefined,
  };
}

/**
 * What relates to the working folder `cwd` on this machine (here.ts): undefined when `cwd` is no
 * folder here or nothing relates to it, else the matches and the IDs the reads take.
 */
async function hereFor(
  call: Call,
  cwd: string,
): Promise<{ found: Here; ids: HereIds } | undefined> {
  const machine = call.host.machine.id;
  const folders = await readFoldersHere(readerOf(call.space), machine);
  const found = await hereOf(cwd, folders, {
    home: call.host.home,
    platform: call.host.platform ?? process.platform,
  });
  if (found === undefined || (found.tasks.size === 0 && found.projects.size === 0)) {
    return undefined;
  }
  return {
    found,
    ids: { machine, tasks: [...found.tasks.keys()], projects: [...found.projects.keys()] },
  };
}

/**
 * Where a task opens on this machine, for the digest: its folder, whether it is there now and the
 * repository it holds.
 */
async function digestFolder(call: Call, folder: TaskFolder): Promise<DigestFolder | undefined> {
  switch (folder.kind) {
    case "task":
    case "project": {
      const platform = call.host.platform ?? process.platform;
      const state = await folderState(folder.path, call.host.home, platform);
      const open = openPath(folder.path, call.host.home, platform);
      const repo =
        state === "missing" || open === undefined ? undefined : await repoName(open, platform);
      return {
        path: folder.path,
        of: folder.kind,
        ...(state === "missing" ? { missing: true } : {}),
        ...(repo === undefined ? {} : { repo }),
      };
    }
    case "other_machine":
      return { machine: folder.machine };
    case "none":
      return undefined;
  }
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

/**
 * When something the caller recreates really happened (a draft's `created`, complete_task's
 * `finished`, an entry's `at`), as an instant: never in the future.
 */
function pastAt(call: Call, value: unknown, path: string): number | undefined {
  if (typeof value !== "string") return undefined;
  const now = (call.host.now ?? Date.now)();
  const at = pastInstant(value, now, (call.host.timeZone ?? localTimeZone)());
  if (at === "future") {
    throw invalid(path, "In the future", "Give when it really happened: today or earlier.");
  }
  if (at === undefined) {
    throw invalid(
      path,
      "Not a date or an instant",
      "Use an ISO date, or an instant with its offset such as 2026-03-02T14:05:00Z.",
    );
  }
  return at;
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

/** What a folder's checks need to know of this machine (folders.ts). */
function bindFacts(call: Call): BindFacts & { readonly home: string } {
  const { host } = call;
  const home = host.home;
  if (home === undefined) {
    throw new AppError({ code: "internal", message: "This service has no home folder to bind." });
  }
  return {
    home,
    platform: host.platform ?? process.platform,
    reserved: [
      ...(host.dataFolder === undefined ? [] : [host.dataFolder]),
      ...host.spaces().flatMap((s) => (s.folder === undefined ? [] : [s.folder])),
    ],
  };
}

/** The folder a field names, in its stored form: `"cwd"` is the caller's working folder. */
function folderOf(
  call: Call,
  value: string,
  at: string,
  facts: BindFacts & { readonly home: string },
): Folder {
  let given = value;
  if (value === "cwd") {
    const cwd = call.input["cwd"];
    if (typeof cwd !== "string") throw folderRefused("cwd", "no_cwd");
    given = cwd;
  }
  const form = storedForm(given, facts.home, facts.platform);
  if (typeof form === "string") throw folderRefused(at, form);
  return form;
}

/**
 * The folder a task's field names, in its stored form and checked at bind (folders.ts). TTasks may
 * share a folder, so no project's folder is in the way.
 */
async function taskFolder(
  call: Call,
  value: string,
  at: string,
  facts: BindFacts & { readonly home: string },
): Promise<Folder> {
  const folder = folderOf(call, value, at, facts);
  const problem = await checkFolder(folder, facts);
  if (problem !== undefined) throw folderRefused(at, problem.reason);
  return folder;
}

/**
 * The checks at bind of `project`'s folder on this machine (folders.ts). `taken`: another live
 * project has the folder here.
 */
async function projectFolderChecked(
  facts: BindFacts & { readonly home: string },
  project: string,
  folder: Folder,
  read: BindRead,
): Promise<{ readonly taken?: ProjectFolderRow }> {
  const others = read.projects.filter((p) => p.project !== project);
  const problem = await checkFolder(folder, { ...facts, projects: others });
  if (problem?.reason === "folder_taken" && problem.project !== undefined) {
    const holder = problem.project;
    return {
      taken: others.find((p) => p.project === holder.project) ?? { ...holder, archived: false },
    };
  }
  if (problem !== undefined) throw folderRefused("folder", problem.reason);
  return {};
}

/** The folders inside an owner's old folder: what moved along with it, or what stayed. */
interface FolderMove {
  readonly carry: boolean;
  readonly inside: readonly Follower[];
  /** The followers whose new place is not a folder on this machine now. */
  readonly missing: ReadonlySet<Follower>;
}

const NO_MOVE: FolderMove = { carry: false, inside: [], missing: new Set() };

/**
 * What changing an owner's folder here to `folder` does to the folders inside its old one
 * (`moveOf`). The folders that move along are checked as a bind checks one: none may land in
 * TTasks's own data.
 */
async function folderMove(
  call: Call,
  facts: BindFacts & { readonly home: string },
  owner: { readonly kind: "project" | "task"; readonly id: string },
  folder: Folder,
): Promise<FolderMove> {
  let read: MoveRead;
  try {
    read = await readMove(readerOf(call.space), owner, call.host.machine.id);
  } catch (error) {
    throw storageFailure(error);
  }
  const plan = await moveOf(
    read.current,
    folder,
    { kind: owner.kind, owner: read.owner ?? owner.id },
    read.here,
    facts,
  );
  if (plan.kind !== "carry") return { ...NO_MOVE, inside: plan.inside };
  const missing = new Set<Follower>();
  for (const follower of plan.inside) {
    const absolute = expanded(follower.to, facts.home, facts.platform);
    const reason = await reservedBy(absolute, facts);
    if (reason !== undefined) {
      throw folderRefused(
        "folder",
        reason,
        follower.kind === "task" ? { task: follower.label } : {},
      );
    }
    if ((await folderState(follower.to, facts.home, facts.platform)) === "missing") {
      missing.add(follower);
    }
  }
  return { carry: true, inside: plan.inside, missing };
}

/** An owner's folder here that a write cleared, which loses that owner's marker. */
interface Cleared {
  readonly kind: "project" | "task";
  readonly id: string;
  readonly stored: string;
}

/** The owner's folder here before a clear, for its marker. Undefined when it has none. */
async function clearedOf(
  call: Call,
  owner: { readonly kind: "project" | "task"; readonly id: string },
): Promise<Cleared | undefined> {
  if (call.host.markers === undefined) return undefined;
  const read = await readMove(readerOf(call.space), owner, call.host.machine.id).catch(
    () => undefined,
  );
  if (read?.current === undefined || read.owner === undefined) return undefined;
  return { kind: owner.kind, id: read.owner, stored: read.current };
}

/**
 * After a write applied (marker.ts): each folder it gave an owner takes that owner's marker, a
 * folder it cleared loses it, and the folders that moved along keep theirs, which moved with them.
 * A folder that takes no marker changes nothing here.
 */
async function markersAfter(
  call: Call,
  ops: readonly Operation[],
  result: WriteResult,
  extra: { readonly move?: FolderMove; readonly cleared?: Cleared | undefined } = {},
): Promise<void> {
  const markers = call.host.markers;
  const space = call.space.id;
  if (markers === undefined || space === undefined) return;
  if (result.status !== "applied" || result.replayed === true) return;
  for (const [k, op] of ops.entries()) {
    if (op.kind !== "project.folder_set" && op.kind !== "task.folder_set") continue;
    // A draft that matched a task takes no folder.
    if (result.results[k]?.status === "existing") continue;
    const id =
      op.kind === "project.folder_set"
        ? op.project
        : isId(op.task, "t")
          ? op.task
          : result.results[k]?.task;
    if (id === undefined) continue;
    const kind = op.kind === "project.folder_set" ? "project" : "task";
    await markers.mark({ space, kind, id }, op.path);
  }
  if (extra.move?.carry === true) {
    for (const f of extra.move.inside)
      markers.moved({ space, kind: f.kind, id: f.owner }, f.from, f.to);
  }
  const cleared = extra.cleared;
  if (cleared !== undefined) {
    await markers.unmark({ space, kind: cleared.kind, id: cleared.id }, cleared.stored);
  }
}

/** At most this many folders that moved along or stayed are named in an answer. */
const FOLLOWERS_SHOWN = 20;

/** A move's part of folder.manage's and organize's answer (FolderMove). */
function moveAnswer(move: FolderMove): Record<string, unknown> {
  if (move.inside.length === 0) return {};
  const named = move.inside.slice(0, FOLLOWERS_SHOWN).map((f) => ({
    kind: f.kind,
    ...(f.kind === "task" ? { ref: f.label } : { name: f.label }),
    folder: move.carry ? f.to : f.from,
    ...(move.missing.has(f) ? { missing: true } : {}),
  }));
  return move.carry
    ? { moved: move.inside.length, followed: named }
    : { stayed: move.inside.length, kept: named };
}

/** The same in words, for a tool whose answer has warnings only. */
function moveWarnings(move: FolderMove): string[] {
  if (move.inside.length === 0) return [];
  const names = move.inside
    .slice(0, FOLLOWERS_SHOWN)
    .map((f) => (f.kind === "task" ? f.label : `project ${f.label}`))
    .join(", ");
  const n = move.inside.length;
  const count = `${String(n)} folder${n === 1 ? "" : "s"}`;
  if (!move.carry) {
    const stay = n === 1 ? "stays where it is" : "stay where they are";
    return [`The old folder is still there, so ${count} inside it ${stay}: ${names}.`];
  }
  const gone = move.missing.size;
  const missing =
    gone === 0 ? "" : ` ${String(gone)} of them ${gone === 1 ? "is" : "are"} not there now.`;
  return [`The old folder was moved, so ${count} inside it moved along: ${names}.${missing}`];
}

/** What binding an owner's folder on this machine reads first (read.ts). */
async function bindRead(call: Call, kind: "project" | "task", id: string): Promise<BindRead> {
  try {
    return await readBind(readerOf(call.space), { kind, id }, call.host.machine.id);
  } catch (error) {
    throw storageFailure(error);
  }
}

/** Refuses a project's folder that another live project has here, naming that project. */
const takenBy = (holder: ProjectFolderRow): AppError =>
  folderRefused("folder", "folder_taken", { project: { id: holder.project, name: holder.name } });

/** The drafts with the projects their folders file them in, and their folders' operations. */
interface DraftFolders {
  readonly list: Record<string, unknown>[];
  /** `task.folder_set` for each draft that keeps a folder of its own: after every other operation. */
  readonly ops: Operation[];
  readonly warnings: string[];
}

/**
 * The folders of new tasks. A draft that names no area and no project goes to the project whose
 * folder holds its folder most closely (`deepestProject`), and keeps a folder of its own only when
 * it is not that project's folder itself. A folder in an archived project's folder files the task
 * in no project, and the result says so. `ids` are the drafts' task IDs.
 *
 * Checking a folder looks at this machine's disk, which may have changed since a call applied, so a
 * retry the writer replays reads nothing and sends no folder: the writer finds its receipt before it
 * stages anything. Every draft has its own task.create, so the request is never empty.
 */
async function draftFolders(
  call: Call,
  list: readonly Record<string, unknown>[],
  ids: readonly string[],
  path: (k: number) => string,
): Promise<DraftFolders> {
  const none = (): DraftFolders => ({ list: [...list], ops: [], warnings: [] });
  if (!list.some((draft) => typeof draft["folder"] === "string") || (await applied(call))) {
    return none();
  }
  const facts = bindFacts(call);
  const out = [...list];
  const ops: Operation[] = [];
  const warnings: string[] = [];
  let projects: readonly ProjectFolderRow[] | undefined;
  const looks = new Map<string, Promise<string | undefined>>();
  try {
    for (const [k, draft] of list.entries()) {
      const value = draft["folder"];
      if (typeof value !== "string") continue;
      const at = `${path(k)}.folder`;
      const folder = await taskFolder(call, value, at, facts);
      let own = true;
      if (draft["area"] === undefined && draft["project"] === undefined) {
        try {
          projects ??= await readProjectFolders(readerOf(call.space), call.host.machine.id);
        } catch (error) {
          throw storageFailure(error);
        }
        const found = await deepestProject(folder, projects, facts, looks);
        if (found?.project.archived === true) {
          warnings.push(
            `${at}: the folder is in an archived project's folder, so the task is in no project. Unarchive the project to file tasks there.`,
          );
        } else if (found !== undefined) {
          out[k] = { ...draft, project: found.project.project };
          own = !found.exact;
        }
      }
      if (own) ops.push({ kind: "task.folder_set", task: ids[k] ?? "", path: folder.stored });
    }
  } catch (error) {
    // The same request may have been decided meanwhile (a retry racing its first call).
    if (error instanceof AppError && (await applied(call))) return none();
    throw error;
  }
  return { list: out, ops, warnings };
}

/** Whether the call's request ID has a receipt in its writer scope: a retry the writer replays. */
async function applied(call: Call): Promise<boolean> {
  const writer = writerOf(call.space);
  try {
    const found = await writer.receipt({
      scope_id: call.principal.scope,
      request_id: String(call.input["request_id"]),
    });
    return found !== undefined;
  } catch (error) {
    throw storageFailure(error);
  }
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

/** The drafts with their groups resolved, and the groups their new names create. */
interface ResolvedDrafts {
  readonly list: Record<string, unknown>[];
  /** `area.create` and `project.create` for each new name, once per name, in first-named order. */
  readonly groups: Operation[];
  /** One warning that names the groups the names made, so a name that matched nothing is seen. */
  readonly made: string[];
}

/**
 * The drafts (or `update_task`'s `set`) with their area and project names resolved to IDs
 * (groups.ts, A3 3.4.5), as the writer takes them; `path` gives each item's input path. A name no
 * group has, and none is close to, is a new group: its create goes with the request, once however
 * many drafts name it, so the drafts and their new groups are one commit and one undo. A request
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
): Promise<ResolvedDrafts> {
  const named = list.some((d) => d["area"] !== undefined || d["project"] !== undefined);
  if (!named) return { list: [...list], groups: [], made: [] };
  const standIns = (): ResolvedDrafts => ({
    list: list.map((draft) => ({
      ...draft,
      ...(typeof draft["area"] === "string" ? { area: REPLAY_GROUP } : {}),
      ...(typeof draft["project"] === "string" ? { project: REPLAY_GROUP } : {}),
    })),
    groups: [],
    made: [],
  });
  if (await applied(call)) return standIns();
  let names: GroupNames;
  try {
    names = await readGroupNames(readerOf(call.space));
  } catch (error) {
    throw storageFailure(error);
  }
  const groups: Operation[] = [];
  /** The input paths of the names that made a group, by kind. */
  const news = { area: [] as string[], project: [] as string[] };
  const face = call.principal.origin;
  // The groups an earlier draft makes join the names, with the slugs the writer will give them, so
  // a later draft resolves them by the same rules as the space's own: one call answers as its
  // drafts sent one by one would.
  const areas = [...names.areas];
  const projects = [...names.projects];
  const working: GroupNames = { areas, projects, aliases: names.aliases };
  const made = new Set<string>();
  const slugOf = (title: string, kind: "area" | "project"): string =>
    freeSlug(title, kind, (slug) =>
      (kind === "area" ? areas : projects).some((group) => group.slug === slug),
    );
  try {
    const resolved = list.map((draft, k) => {
      const at = path(k);
      const out = { ...draft };
      const area = draft["area"];
      if (typeof area === "string") {
        let id = resolveGroup(working, "area", area, `${at}.area`, { face });
        if (id === undefined) {
          const created = newId("a");
          made.add(created);
          areas.push({
            id: created,
            slug: slugOf(area.trim(), "area"),
            title: area.trim(),
            area: null,
          });
          groups.push({ kind: "area.create", id: created, title: area.trim() });
          news.area.push(`${at}.area`);
          id = created;
        }
        out["area"] = id;
      }
      const project = draft["project"];
      if (typeof project === "string") {
        const within = typeof out["area"] === "string" ? out["area"] : undefined;
        // An area the call makes holds only the projects the call makes there: a project of
        // that name elsewhere is no reason to refuse, and no typo of one there.
        const among =
          within !== undefined && made.has(within)
            ? { ...working, projects: projects.filter((p) => p.area === within) }
            : working;
        let id = resolveGroup(among, "project", project, `${at}.project`, {
          area: within,
          face,
        });
        if (id === undefined) {
          const created = newId("p");
          projects.push({
            id: created,
            slug: slugOf(project.trim(), "project"),
            title: project.trim(),
            area: within ?? null,
          });
          groups.push({
            kind: "project.create",
            id: created,
            title: project.trim(),
            ...(within === undefined ? {} : { area: within }),
          });
          news.project.push(`${at}.project`);
          id = created;
        }
        out["project"] = id;
      }
      return out;
    });
    return { list: resolved, groups, made: madeWarning(news.area, news.project) };
  } catch (error) {
    // A retry racing its first call: the request may have been decided meanwhile.
    if (error instanceof AppError && (await applied(call))) return standIns();
    throw error;
  }
}

/** At most this many paths of the names that made a group, then how many more. */
const MADE_SHOWN = 5;

/**
 * The one warning for the groups a call's names made, whatever their number, so it fits the
 * answer. Not "<path>: ...": a draft that matched an existing task drops those, and its group was
 * made all the same. A project's name matched none in its area, which another area may have.
 */
function madeWarning(areas: readonly string[], projects: readonly string[]): string[] {
  const paths = [...areas, ...projects];
  if (paths.length === 0) return [];
  const count = (n: number, one: string) =>
    n === 0 ? [] : [`${String(n)} ${one}${n === 1 ? "" : "s"}`];
  const what = [...count(areas.length, "new area"), ...count(projects.length, "new project")];
  const more = paths.length - MADE_SHOWN;
  const at = `${paths.slice(0, MADE_SHOWN).join(", ")}${more > 0 ? ` and ${String(more)} more` : ""}`;
  return [
    `Made ${what.join(" and ")} for names that matched none (a project, none in its area): ${at}.`,
  ];
}

/**
 * A result as the call's own operations see it: the results of the groups it created by name are
 * left out and the rest numbered from 0, so a handler reads its operations by their own indexes
 * whether a name made a group or not, and a replay, which creates none, reads the same.
 */
function ownResults(result: WriteResult): WriteResult {
  const own = result.results.filter((r) => !isId(r.id, "a") && !isId(r.id, "p"));
  return { ...result, results: own.map((r, i) => ({ ...r, i })) };
}

/**
 * The `possible duplicate` warnings of the drafts (similar.ts, A3 3.4.5): one per draft whose
 * title is close to an active task's in the group it lands in, or to an earlier draft's of the
 * same call, which it names by its path. They go with the request, so the receipt keeps them and a
 * replay says the first call's; a draft that matched an existing task drops its warning after the
 * write (`task.add`).
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
  const drafted = list.map((draft, k) => ({
    ref: `tasks.${String(k)}`,
    title: String(draft["title"]),
    destination: destinations[k] as Destination,
  }));
  return list.flatMap((draft, k) => {
    const destination = destinations[k];
    if (destination === undefined) return [];
    const found = duplicateWarning(`tasks.${String(k)}`, String(draft["title"]), destination, [
      ...siblings,
      ...drafted.slice(0, k),
    ]);
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
  call: Call,
  draft: Record<string, unknown>,
  id: Id<"t">,
  path: string,
  start: number,
  sourcePaths: Map<number, string>,
  agent: boolean,
): Operation[] {
  const { today } = call;
  const create: TaskCreate = { kind: "task.create", id, title: String(draft["title"]) };
  const created = pastAt(call, draft["created"], `${path}.created`);
  if (created !== undefined) create.created_at = created;
  if (toInbox(draft, agent)) create.inbox = true;
  // `return`, the default, is A1's: an active match takes the draft's log entry, nothing else.
  if (draft["on_existing"] === "add_sources") create.link_sources = true;
  if (draft["on_existing"] === "create_new") create.dedupe = "new";
  for (const key of ["summary", "status", "effort", "waiting_on", "context"] as const) {
    if (typeof draft[key] === "string") create[key] = draft[key];
  }
  if (draft["inbox"] === false) create.inbox = false;
  if (typeof draft["priority"] === "number") create.priority = draft["priority"];
  // A star is for today, as task.update's.
  if (draft["focus"] === true) create.focus = today;
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

/** A link's URL: a scheme, then no blank, control, format character, quote or angle bracket. */
const LINK_URL = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"\p{Cc}\p{Cf}]+$/u;

/**
 * An entry's text with its links (A3 3.4.7) as a list below it, one `- title: <url>` line each.
 * Schema 0.1 stores no link rows for notes and log entries, so the links are part of the entry's
 * Markdown, where every face and the projection show them. A URL that would break the line is
 * refused; TTasks never fetches one (A3 3.10).
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
    const reader = readerOf(call.space);
    const now = (call.host.now ?? Date.now)();
    // A guide is one workflow text instead of the overview (A3 3.4.2): no sections, no `here`.
    const include =
      guide === undefined && Array.isArray(input["include"]) ? (input["include"] as string[]) : [];
    const cwd = guide === undefined && typeof input["cwd"] === "string" ? input["cwd"] : undefined;
    // Null: a cwd that relates to no folder here, so no task matches it.
    const found = cwd === undefined ? undefined : ((await hereFor(call, cwd)) ?? null);
    const boundTask = sessionIn(call)?.task;
    const status = await readStatus(reader, {
      today: call.today,
      week: addDays(call.today, 7),
      since: sinceOf(input["since"], now),
      include,
      ...(found === undefined || found === null ? {} : { here: found.ids }),
      ...(boundTask === undefined ? {} : { bound: boundTask }),
    });
    const here =
      found === undefined ? undefined : found === null ? [] : hereRows(status.here, found.found);
    // A session has its task: the hint is for a connection that has to name one.
    const hint =
      here === undefined || boundTask !== undefined
        ? undefined
        : hereHint(here, status.space.refPrefix);
    const live =
      here === undefined || here.length === 0
        ? undefined
        : call.host.sessions?.live(status.space.id);
    return {
      as_of: status.space.asOf,
      date: call.today,
      time_zone: (call.host.timeZone ?? localTimeZone)(),
      // Nothing in this build holds an agent's change for the user: every change applies at once.
      autonomy: "full",
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

  "task.finished": async (call) => {
    const { input, host } = call;
    let after: { at: number; id: string } | undefined;
    const cursor = input["cursor"];
    if (cursor !== undefined) {
      if (typeof cursor !== "string" || !FINISHED_CURSOR.test(cursor)) {
        throw invalid("cursor", "Not a cursor this read gave", "Read from the start again.");
      }
      const dot = cursor.indexOf(".");
      after = { at: Number(cursor.slice(0, dot)), id: cursor.slice(dot + 1) };
    }
    const limit = Number(input["limit"]);
    const checkedOff = typeof input["checked_off"] === "boolean" ? input["checked_off"] : undefined;
    const reader = readerOf(call.space);
    let read;
    try {
      read = await readFinished(
        reader,
        { checkedOff, limit, after },
        {
          machine: host.machine.id,
          home: host.home,
          platform: host.platform ?? process.platform,
        },
      );
    } catch (error) {
      throw storageFailure(error);
    }
    const at = read.rows[read.rows.length - 1]?.["finished_at"];
    const id = read.rows[read.rows.length - 1]?.["id"];
    return {
      rows: read.rows,
      ...(read.more && typeof at === "number" && typeof id === "string"
        ? { cursor: `${String(at)}.${id}` }
        : {}),
    };
  },

  "task.get": async (call) => {
    const { input } = call;
    const sections = Array.isArray(input["sections"]) ? (input["sections"] as string[]) : [];
    if (sections.length === 0 && input["before"] !== undefined) {
      throw invalid("before", "A before token pages a sections read", "Pass its sections too.");
    }
    const reader = readerOf(call.space);
    let task: string;
    // A reference reads its launch's task for this call, on any connection: it never binds.
    let launch: FoundLaunch | undefined;
    if (typeof input["launch"] === "string") {
      if (input["task"] !== undefined) throw invalid("task", "Pass task or launch, not both");
      launch = await launchOf(call, input["launch"]);
      task = launch.task;
    } else {
      task = await taskOf(call);
    }
    const machine = call.host.machine.id;
    const ranges =
      sections.length === 0
        ? DIGEST_RANGES
        : pageRanges(
            pagePlan(
              sections,
              input["before"],
              typeof input["log_limit"] === "number" ? input["log_limit"] : 20,
            ),
          );
    const named = Array.isArray(input["notes"])
      ? (input["notes"] as string[]).map((ref) => Number(ref.slice(1)))
      : undefined;
    const read = await readTask(reader, task, {
      machine,
      ...ranges,
      ...(named === undefined ? {} : { named }),
    });
    const notes = named === undefined ? {} : { notes: read.named.map(noteOf) };
    // The connection is this task's session: its later calls need no task.
    const bound = sessionIn(call)?.task === String(read.row["id"]);
    // What the person asked this launch's agent to do: the note the launch names, while it is there.
    const asked = launch?.request;
    let request: Record<string, unknown> | undefined;
    if (asked !== undefined) {
      let body: string | undefined;
      try {
        body = await readPersonsNote(reader, String(read.row["id"]), asked);
      } catch (error) {
        throw storageFailure(error);
      }
      if (body !== undefined) request = { note: asked, ...requestText(body) };
    }
    let answer: Record<string, unknown>;
    if (sections.length === 0) {
      const digest = digestOf(read, call.today, await digestFolder(call, read.folder));
      answer = {
        view: "digest",
        as_of: read.space.asOf,
        bound,
        ...(request === undefined ? {} : { request }),
        task: digest,
        ...notes,
      };
    } else {
      const logLimit = typeof input["log_limit"] === "number" ? input["log_limit"] : 20;
      const page = sectionsOf(read, pagePlan(sections, input["before"], logLimit));
      answer = {
        view: "sections",
        as_of: read.space.asOf,
        bound,
        ...(request === undefined ? {} : { request }),
        task: taskRow(read.row, read.space.refPrefix),
        sections: page.sections,
        ...(page.before === undefined ? {} : { before: page.before }),
        ...notes,
      };
    }
    // Connected only once the agent has its whole answer, the person's request included.
    if (launch !== undefined) await markConnected(call, launch);
    return answer;
  },

  "task.add": async (call) => {
    const { input } = call;
    const agent = call.principal.actorKind !== "human";
    const at = (k: number): string => `tasks.${String(k)}`;
    const named = await resolvedDrafts(call, drafts(input["tasks"]), at);
    const ids = named.list.map(() => newId("t"));
    const folders = await draftFolders(call, named.list, ids, at);
    const { list } = folders;
    const ops: Operation[] = [];
    const firsts: number[] = [];
    const sourcePaths = new Map<number, string>();
    list.forEach((draft, k) => {
      firsts.push(ops.length);
      ops.push(...draftOps(call, draft, ids[k] as Id<"t">, at(k), ops.length, sourcePaths, agent));
    });
    const duplicates = await duplicateWarnings(call, list, agent);
    // The folders last, so the drafts' operations keep their indexes in a replay, which sends none.
    ops.push(...folders.ops);
    // The folders' and the possible duplicates' warnings go with the request: the writer keeps
    // them with the result, so a replay says the first call's, never this call's late reading.
    // New groups first, so the drafts can name them; the drafts' results are read without them.
    const result = ownResults(
      await submit(call, [...named.groups, ...ops], {
        warnings: [...named.made, ...duplicates, ...folders.warnings],
        inserted: { at: 0, count: named.groups.length },
        pathOf: draftPathOf(ops, ids, at, sourcePaths),
      }),
    );
    await markersAfter(call, ops, result);
    const outcomes = list.map((_, k) => draftOutcome(result, firsts[k] ?? 0));
    // A matched draft takes no folder and creates no task, so the warnings of its folder and its
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
          ...heldOf(result, sourcePaths, at(k)),
        };
      }),
      warnings: [...differsWarnings(result, sourcePaths), ...kept],
      ...replayed(result),
    };
  },

  "task.update": async (call) => {
    const { input, today } = call;
    const task = await taskOf(call);
    const ops: Operation[] = [];
    /** The groups a new area or project name creates, before the task moves into them. */
    const groups: Operation[] = [];
    const made: string[] = [];
    const fields: string[] = [];
    const set = isRecord(input["set"]) ? input["set"] : {};
    // A3 3.4.6: a finished task is not a status. The input alone decides it, so no receipt.
    if (typeof set["status"] === "string" && FINISHED.has(set["status"].toLowerCase())) {
      throw new AppError({
        code: "wrong_tool",
        message: "A task is finished, not given a status.",
        hint: "Use complete_task with an outcome (ttasks done).",
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
    // The folder is a row of its own, set or cleared after the other operations.
    const clearFolder = clear.includes("folder");
    if (clearFolder && set["folder"] !== undefined) {
      throw invalid("clear", "Set the folder or clear it, not both");
    }
    const unset = clear.filter((field) => field !== "folder");
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
      const resolved = await resolvedDrafts(call, [set], () => "set");
      const [group = set] = resolved.list;
      groups.push(...resolved.groups);
      made.push(...resolved.made);
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
    // The folder last, so the other operations keep their indexes in a replay, which checks no
    // folder (draftFolders) and sends a stand-in when nothing else is in the request.
    const folder = set["folder"];
    let move = NO_MOVE;
    if (typeof folder === "string") {
      let stored: string | undefined;
      if (!(await applied(call))) {
        try {
          const facts = bindFacts(call);
          const checked = await taskFolder(call, folder, "set.folder", facts);
          move = await folderMove(call, facts, { kind: "task", id: task }, checked);
          stored = checked.stored;
        } catch (error) {
          if (!(error instanceof AppError) || !(await applied(call))) throw error;
        }
      }
      if (stored !== undefined) {
        ops.push({
          kind: "task.folder_set",
          task,
          path: stored,
          ...(move.carry ? { carry: true } : {}),
        });
      } else if (ops.length === 0) ops.push({ kind: "task.folder_clear", task });
    }
    const cleared = clearFolder ? await clearedOf(call, { kind: "task", id: task }) : undefined;
    if (clearFolder) ops.push({ kind: "task.folder_clear", task });
    fields.push(...Object.keys(set), ...clear);
    if (context !== undefined) fields.push("context");
    if (added.length > 0) fields.push("sources");
    if (ops.length === 0) throw invalid("set", "Nothing to change");
    // update_task changes an active task (A3 3.4.6): the writer refuses a completed or archived
    // one with TASK_NOT_ACTIVE (wrong_tool), in the request's transaction, so it is receipted.
    const result = ownResults(
      await submit(call, [...groups, ...ops], {
        active: true,
        inserted: { at: 0, count: groups.length },
        warnings: made,
        pathOf: (i, field) =>
          ops[i]?.kind === "task.patch" && field !== undefined && /^[a-z_]+$/u.test(field)
            ? `set.${field}`
            : undefined,
      }),
    );
    const updated = result.status === "applied";
    await markersAfter(call, ops, result, { move, cleared });
    const first = opAt(result, 0);
    const named = [...new Set(fields)];
    const facts = updated ? await commitOf(call, first, result.seq) : undefined;
    return {
      result: updated ? "updated" : "no_change",
      task: refOf(first),
      // The fields the commit changed, read from its history, so a replay answers the same.
      // Unread, the fields the call set stand in.
      fields: !updated ? [] : facts === undefined ? named : changedFields(named, facts),
      as_of: result.as_of,
      warnings: [
        ...differsWarnings(result, sourcePaths),
        ...result.warnings,
        ...(updated && result.replayed !== true ? moveWarnings(move) : []),
      ],
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
    if (kind === "note" && input["at"] !== undefined) {
      throw invalid("at", "A note is dated when it is written", "Give the entry a log kind.");
    }
    const at = pastAt(call, input["at"], "at");
    const task = await taskOf(call);
    const op: Operation =
      kind === "note"
        ? {
            kind: "note.add",
            task,
            body,
            addressee: input["for_agents"] === true ? "agents" : "self",
          }
        : {
            kind: "log.add",
            task,
            body,
            log_kind: kind as never,
            ...(at === undefined ? {} : { at }),
          };
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
    const task = await taskOf(call);
    const outcome = typeof input["outcome"] === "string" ? input["outcome"] : undefined;
    const learnings = Array.isArray(input["learnings"]) ? (input["learnings"] as string[]) : [];
    const dropped = input["status"] === "dropped";
    if (dropped && input["finished"] !== undefined) {
      throw invalid("finished", "A dropped task keeps no time it was done", "Leave out finished.");
    }
    const finishedAt = pastAt(call, input["finished"], "finished");
    // A3 3.4.8, decided by the writer on the task as it finds it: an active task is completed
    // (done) or archived (dropped), one the user finished first is left as it is (`if_active`),
    // and the outcome and learnings are its wrap-up, `once`: a task wrapped already is no change
    // with the same outcome and a conflict otherwise. The operations follow from the input alone,
    // so a replay's stored result lines up with them whatever the task's state is now.
    const ops: Operation[] = [
      dropped
        ? { kind: "task.archive", task, if_active: true }
        : {
            kind: "task.complete",
            task,
            if_active: true,
            ...(finishedAt === undefined ? {} : { at: finishedAt }),
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
    const at = (k: number): string => `follow_ups.${String(k)}`;
    const named = await resolvedDrafts(call, drafts(input["follow_ups"]), at);
    const ids = named.list.map(() => newId("t"));
    const folders = await draftFolders(call, named.list, ids, at);
    const agent = call.principal.actorKind !== "human";
    const sourcePaths = new Map<number, string>();
    const follow = folders.list;
    const firsts: number[] = [];
    follow.forEach((draft, k) => {
      firsts.push(ops.length);
      ops.push(...draftOps(call, draft, ids[k] as Id<"t">, at(k), ops.length, sourcePaths, agent));
    });
    ops.push(...folders.ops);
    // New groups after the task's own operations, so its wrap-up keeps its index, and before the
    // follow-ups that name them; the results are read without them.
    const groups = named.groups;
    const sent = [...ops.slice(0, own), ...groups, ...ops.slice(own)];
    const result = ownResults(
      await submit(call, sent, {
        ...(own > 1 ? { wrapUp: 1 } : {}),
        inserted: { at: own, count: groups.length },
        warnings: [...named.made, ...folders.warnings],
        pathOf: draftPathOf(ops, ids, at, sourcePaths),
      }),
    );
    await markersAfter(call, ops, result);
    const outcomes = follow.map((_, k) => draftOutcome(result, firsts[k] ?? 0));
    // A matched follow-up takes no folder, so its folder's warning does not apply.
    const matched = follow.map((_, k) => at(k)).filter((_, k) => outcomes[k]?.result === "exists");
    const warnings = [
      ...differsWarnings(result, sourcePaths),
      ...result.warnings.filter((w) => !matched.some((m) => w.startsWith(`${m}.`))),
    ];
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
      follow_ups: outcomes.map((outcome, k) => ({
        result: outcome.result,
        ...(outcome.ref === undefined ? {} : { ref: outcome.ref }),
        title: String(follow[k]?.["title"]),
        ...heldOf(result, sourcePaths, at(k)),
      })),
      ...(warnings.length === 0 ? {} : { warnings }),
      as_of: result.as_of,
      ...replayed(result),
    };
  },

  "task.reopen": async (call) => {
    const { input } = call;
    const task = await taskOf(call);
    const reason = input["reason"];
    const result = await submit(call, [
      { kind: "task.reopen", task, ...(typeof reason === "string" ? { reason } : {}) },
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
    let text = typeof input["text"] === "string" ? input["text"] : undefined;
    const instance = typeof input["instance"] === "string" ? input["instance"] : undefined;
    // Open again with a request already on the task: a note the person wrote, as it is now.
    const requestNote = typeof input["request"] === "string" ? input["request"] : undefined;
    if (requestNote !== undefined) {
      if (instance === undefined)
        throw invalid("request", "Copy takes no request note", "Pass instance.");
      if (text !== undefined) throw invalid("request", "Pass text or request, not both");
      let body: string | undefined;
      try {
        body = await readPersonsNote(readerOf(call.space), read.id, requestNote);
      } catch (error) {
        throw storageFailure(error);
      }
      if (body === undefined) {
        throw new AppError({
          code: "not_found",
          message: "The task has no note of yours with this reference.",
          hint: "Type the request again.",
          data: { field: "request" },
        });
      }
      text = body;
    }
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
        ...(requestNote === undefined ? {} : { requestNote }),
        requestId,
        ...(pack === undefined ? {} : { pack }),
        ...(input["mark_folder"] === true ? { markFolder: true } : {}),
        ...(input["another"] === true ? { another: true } : {}),
        // The person's words as a note of theirs: the note entry's own request path, an undoable
        // step of theirs, under a request ID the click's derives. Its writer scope is the click's
        // as the launch's replay is, not the sign-in's: a click repeated from any page or shell
        // finds the note instead of adding a second one.
        saveNote: async (body, forAgents) => {
          const principal = { ...call.principal, scope: `launch-note:${host.machine.id}` };
          const saved = (await opCall(
            host,
            { ...call.caller, principal },
            {
              space,
              op: "entry.add",
              input: {
                task: read.id,
                kind: "note",
                text: body,
                ...(forAgents ? { for_agents: true } : {}),
                request_id: noteRequestOf(requestId),
              },
            },
          )) as { entry: string };
          return saved.entry;
        },
      });
    } catch (error) {
      if (error instanceof LaunchFolderUnmarked) throw await unmarkedError(call, error);
      throw launchError(error);
    }
    return {
      launch: launchReceipt(opened.intent),
      ...(opened.copy === undefined ? {} : { copy: opened.copy }),
      text: opened.composer,
      ...(opened.note === undefined ? {} : { note: opened.note }),
    };
  },

  // A1 3.10.1: the user's one stack, shared by every tab and the user's CLI. Guarded by
  // provenance in the writer, so no base; a conflict comes back as `conflict` with A1's cause.
  "history.undo": async (call) => {
    const { input } = call;
    if (input["check_script"] === true && input["commit"] === undefined) {
      await refuseBehindScript(call);
    }
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
    const boundTask = sessionIn(call)?.task;
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
        ...(call.caller.shows === undefined
          ? {}
          : { shows: (page: unknown) => call.caller.shows?.("task.search", page) !== false }),
        live: () =>
          [...(host.sessions?.live(space) ?? new Map<string, number>())]
            .filter(([, count]) => count > 0)
            .map(([task]) => task),
        here: async (cwd) => {
          const found = await hereFor(call, cwd);
          return found === undefined ? { tasks: [], projects: [] } : found.ids;
        },
        folderOf: (given) => {
          const platform = host.platform ?? process.platform;
          if (host.home === undefined) return undefined;
          const form = storedForm(given, host.home, platform);
          return typeof form === "string" ? undefined : { stored: form.stored, os: osOf(platform) };
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
      // The input rules of a write come first, so the agent fixes its call once (A3 3.4.10): every
      // write names its group, and a change to an existing one needs base (A1 3.5).
      if (input["path"] === undefined) {
        throw invalid("path", `Required to ${action}`, "Name the area, or the area/project.");
      }
      if (action !== "create" && input["base"] === undefined) {
        throw invalid(
          "base",
          `Required to ${action}`,
          "Pass base: the as_of of the last answer that showed you what you change.",
        );
      }
      return groupWrite(call, action);
    }
    if (input["folder"] !== undefined) throw invalid("folder", "A list takes no folder");
    const reader = readerOf(call.space);
    let read;
    let names: GroupNames | undefined;
    try {
      read = await readGroupsHere(call, reader);
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

  "folder.manage": async (call) => {
    const { input } = call;
    const action = String(input["action"]);
    const folder = typeof input["folder"] === "string" ? input["folder"] : undefined;
    if (action === "add_project") {
      if (input["task"] !== undefined) throw invalid("task", "A new project takes no task");
    } else {
      if ((input["project"] === undefined) === (input["task"] === undefined)) {
        throw invalid("project", "Name a project or a task, one of them");
      }
      if (input["area"] !== undefined) throw invalid("area", "Only a new project takes an area");
    }
    if (action === "clear" && folder !== undefined) {
      throw invalid("folder", "A clear takes no folder");
    }
    if (action !== "clear" && folder === undefined) {
      throw invalid("folder", `Required to ${action === "set" ? "set" : "add"} a folder`);
    }
    // One at a time with the space's other binds (decidesOnNames).
    return folderWrite(call, action, folder);
  },

  "prefs.manage": async (call) => {
    const { input } = call;
    const action = String(input["action"]);
    const actor = call.principal.actorKind;
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

  // Refused by the exposure gate before any handler runs (`opCall`). The handler says the same, so
  // no path reaches a write.
  "run.report": (call) => {
    checkExposure(call.entry, call.caller.class, sessionIn(call) === undefined ? "none" : "task");
    return Promise.reject(new AppError({ code: "internal", message: "No run binding exists." }));
  },
};

// ---------------------------------------------------------------------------------------------
// group.manage (A3 3.4.10) and prefs.manage (A3 3.4.11)

// ---------------------------------------------------------------------------------------------
// folder.manage: a project's or a task's folder on this machine (folders.ts)

/** The calls in flight that decide on what they read, by space: each waits for the one before. */
const turns = new Map<string, Promise<unknown>>();

async function oneAtATime<T>(space: string, work: () => Promise<T>): Promise<T> {
  const before = turns.get(space) ?? Promise.resolve();
  const mine = before.then(work, work);
  const settled = mine.then(
    () => undefined,
    () => undefined,
  );
  turns.set(space, settled);
  try {
    return await mine;
  } finally {
    if (turns.get(space) === settled) turns.delete(space);
  }
}

/**
 * Whether a call binds a folder or names an area or project it may create: folder.manage,
 * organize's create, move and set_folder, and a task tool whose drafts name a group.
 */
function decidesOnNames(entry: string, input: Record<string, unknown>): boolean {
  const named = (list: unknown): boolean =>
    Array.isArray(list) &&
    list.some((d) => isRecord(d) && (d["area"] !== undefined || d["project"] !== undefined));
  switch (entry) {
    case "folder.manage":
      return true;
    case "group.manage":
      return (
        input["action"] === "create" ||
        input["action"] === "move" ||
        input["action"] === "set_folder"
      );
    case "task.add":
      return named(input["tasks"]);
    case "task.update":
      return named([input["set"]]);
    case "task.finish":
      return named(input["follow_ups"]);
    default:
      return false;
  }
}

/** The project a folder write names: `Area/Project`, or a project by name, slug or ID. */
function projectNamed(names: GroupNames, given: string): { id: string; name: string } {
  const cut = given.lastIndexOf("/");
  const area =
    cut > 0
      ? resolveGroup(names, "area", given.slice(0, cut).trim(), "project", { lookup: true })
      : undefined;
  const name = cut > 0 ? given.slice(cut + 1).trim() : given.trim();
  const id = resolveGroup(names, "project", name, "project", { lookup: true, area }) ?? "";
  return { id, name: names.projects.find((p) => p.id === id)?.title ?? name };
}

async function folderWrite(
  call: Call,
  action: string,
  given: string | undefined,
): Promise<unknown> {
  const { input } = call;
  const facts = bindFacts(call);
  let stored: Folder | undefined;
  if (given !== undefined) {
    const form = storedForm(given, facts.home, facts.platform);
    if (typeof form === "string") throw folderRefused("folder", form);
    stored = form;
  }
  const replay = await applied(call);
  const reader = readerOf(call.space);
  let names: GroupNames;
  try {
    names = await readGroupNames(reader);
  } catch (error) {
    throw storageFailure(error);
  }

  if (action === "add_project") {
    const folder = must(stored);
    const name =
      typeof input["project"] === "string" && input["project"].trim() !== ""
        ? input["project"].trim()
        : folderName(folder.absolute, facts.platform);
    if (name === undefined) {
      throw invalid("project", "A drive or a root has no name to give the project", "Name it.");
    }
    const projectId = newId("p");
    const ops: Operation[] = [];
    if (!replay) {
      const read = await bindRead(call, "project", projectId);
      const { taken } = await projectFolderChecked(facts, projectId, folder, read);
      // A folder another live project has here: that project, rather than a second one for it.
      if (taken !== undefined) {
        return {
          action,
          result: "exists",
          owner: { kind: "project", id: taken.project, name: taken.name },
          folder: taken.stored,
          as_of: read.space.asOf,
        };
      }
    }
    let area: string | undefined;
    if (typeof input["area"] === "string") {
      area = replay
        ? REPLAY_GROUP
        : resolveGroup(names, "area", input["area"], "area", { face: call.principal.origin });
      if (area === undefined) {
        area = newId("a");
        ops.push({ kind: "area.create", id: area as Id<"a">, title: input["area"].trim() });
      }
    }
    ops.push(
      {
        kind: "project.create",
        id: projectId,
        title: name,
        ...(area === undefined ? {} : { area }),
      },
      { kind: "project.folder_set", project: projectId, path: folder.stored },
    );
    const result = await submit(call, ops);
    await markersAfter(call, ops, result);
    const project = result.results.find((r) => isId(r.id, "p"));
    return {
      action,
      result: result.status === "applied" ? "created" : "no_change",
      owner: { kind: "project", id: project?.id ?? projectId, name },
      folder: folder.stored,
      as_of: result.as_of,
      ...replayed(result),
    };
  }

  // set or clear, on a project or a task.
  let owner: { kind: "project" | "task"; id: string; name?: string };
  if (typeof input["project"] === "string") {
    // A retry of a decided write is the writer's to replay: a rename since never refuses it, and
    // its result names the project.
    const project = replay
      ? { id: REPLAY_GROUP, name: input["project"] }
      : projectNamed(names, input["project"]);
    owner = { kind: "project", id: project.id, name: project.name };
  } else {
    // The writer resolves the reference; its result names the task by ID.
    owner = { kind: "task", id: String(input["task"]) };
  }
  let move = NO_MOVE;
  if (!replay && action === "set") {
    const folder = must(stored);
    if (owner.kind === "project") {
      const checked = await projectFolderChecked(
        facts,
        owner.id,
        folder,
        await bindRead(call, "project", owner.id),
      );
      if (checked.taken !== undefined) throw takenBy(checked.taken);
    } else {
      const problem = await checkFolder(folder, facts);
      if (problem !== undefined) throw folderRefused("folder", problem.reason);
    }
    move = await folderMove(call, facts, owner, folder);
  }
  const carry = move.carry ? { carry: true } : {};
  const op: Operation =
    action === "set"
      ? owner.kind === "project"
        ? { kind: "project.folder_set", project: owner.id, path: must(stored).stored, ...carry }
        : { kind: "task.folder_set", task: owner.id, path: must(stored).stored, ...carry }
      : owner.kind === "project"
        ? { kind: "project.folder_clear", project: owner.id }
        : { kind: "task.folder_clear", task: owner.id };
  const cleared = action === "clear" && !replay ? await clearedOf(call, owner) : undefined;
  const result = await submit(call, [op]);
  await markersAfter(call, [op], result, { move, cleared });
  const done = result.results[0];
  const changed = result.status === "applied";
  if (owner.kind === "project" && owner.id === REPLAY_GROUP) {
    // The result names the folder, or the project when a clear found none.
    let id = done?.id ?? "";
    if (!isId(id, "p")) {
      try {
        id = (await readFolderOwner(reader, id)) ?? "";
      } catch (error) {
        throw storageFailure(error);
      }
    }
    owner = { ...owner, id, name: names.projects.find((p) => p.id === id)?.title ?? "" };
  }
  return {
    action,
    result: changed ? (action === "set" ? "set" : "cleared") : "no_change",
    owner: {
      kind: owner.kind,
      id: owner.kind === "task" ? (done?.task ?? "") : owner.id,
      ...(owner.name === undefined ? {} : { name: owner.name }),
      ...(done?.ref === undefined ? {} : { ref: done.ref }),
    },
    ...(action === "set" ? { folder: must(stored).stored } : {}),
    ...(changed && result.replayed !== true ? moveAnswer(move) : {}),
    as_of: result.as_of,
    ...replayed(result),
  };
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new AppError({ code: "internal", message: "A value is missing." });
  return value;
}

/** What organize's write did, by its action, when it changed the group. */
const GROUP_DONE: Readonly<Record<string, string>> = {
  create: "created",
  rename: "renamed",
  move: "moved",
  archive: "archived",
  unarchive: "unarchived",
  set_folder: "folder_set",
  clear_folder: "folder_cleared",
};

/** The group a write names, by its path: `Area` or `Area/Project`. */
interface GroupPath {
  readonly area: string;
  readonly project: string | undefined;
}

function groupPath(input: Record<string, unknown>): GroupPath {
  const parts = String(input["path"])
    .split("/")
    .map((part) => part.trim());
  const [area = "", project, ...more] = parts;
  if (area === "" || more.length > 0 || project === "") {
    throw invalid("path", "Expected Area or Area/Project", "Name the area, or the area/project.");
  }
  return { area, project };
}

/** The group a write changed, as its result names it. */
interface WrittenGroup {
  readonly kind: "area" | "project";
  readonly id: string;
  readonly name: string;
  readonly folder?: string;
}

/**
 * organize's writes (A3 3.4.10): create an area, or a project in an area (a new area too), with
 * its folder here; rename, move a project to another area, archive and unarchive; set and clear a
 * project's folder here. A name resolves as a draft's does (groups.ts): a name close to another is
 * refused with the close ones, a group that exists is `no_change` for create. A project created
 * with a folder another project has answers `exists` with that project, and writes nothing. The
 * answer is the list as of the write.
 */
async function groupWrite(call: Call, action: string): Promise<unknown> {
  const { input } = call;
  let path = groupPath(input);
  const to = typeof input["to"] === "string" ? input["to"].trim() : undefined;
  if ((action === "rename" || action === "move") && (to === undefined || to === "")) {
    throw invalid("to", `Required to ${action}`, action === "move" ? "Name the area." : undefined);
  }
  const given = typeof input["folder"] === "string" ? input["folder"] : undefined;
  if (given !== undefined && action !== "create" && action !== "set_folder") {
    throw invalid("folder", `A ${action} takes no folder`);
  }
  if (action === "set_folder" && given === undefined) {
    throw invalid(
      "folder",
      "Required to set_folder",
      'Give "cwd", an absolute folder or one under ~.',
    );
  }
  const folderAction = action === "set_folder" || action === "clear_folder";
  if (folderAction && path.project === undefined) {
    throw invalid("path", "Only a project has a folder", "Name it as Area/Project.");
  }
  const facts = given === undefined ? undefined : bindFacts(call);
  const folder =
    given === undefined || facts === undefined ? undefined : folderOf(call, given, "folder", facts);
  // An area and a folder: a project in the area named after the folder, as add_project names one.
  if (folder !== undefined && facts !== undefined && path.project === undefined) {
    const named = folderName(folder.absolute, facts.platform);
    if (named === undefined) {
      throw invalid(
        "path",
        "A drive or a root has no name to give the project",
        "Name it as Area/Project.",
      );
    }
    path = { area: path.area, project: named };
  }
  if (await applied(call)) {
    // A retry of a decided write: the writer replays it. Its names and its folder are not looked
    // at again, since a rename it made would refuse its own retry; a stand-in operation carries it
    // to the writer.
    const result = await submit(call, [{ kind: "area.create", title: path.area }]);
    const read = await afterWrite(call, (reader) => readGroupsHere(call, reader));
    const kind = action === "move" || path.project !== undefined ? "project" : "area";
    const last = result.results.at(-1)?.id ?? "";
    const id =
      isId(last, "a") || isId(last, "p")
        ? last
        : await afterWrite(call, (reader) => readFolderOwner(reader, last));
    const changed = result.status === "applied";
    return {
      ...(read === undefined
        ? { areas: [], projects: [], total_areas: 0, total_projects: 0 }
        : groupList(read, undefined)),
      action,
      as_of: result.as_of,
      result: changed ? (GROUP_DONE[action] ?? "no_change") : "no_change",
      group: {
        kind,
        id: id ?? "",
        name: action === "rename" ? (to ?? "") : (path.project ?? path.area),
        ...(folder === undefined ? {} : { folder: folder.stored }),
      },
      ...replayed(result),
    };
  }
  let names: GroupNames;
  try {
    names = await readGroupNames(readerOf(call.space));
  } catch (error) {
    throw storageFailure(error);
  }
  const lookup = (kind: "area" | "project", name: string, area?: string): string =>
    resolveGroup(names, kind, name, "path", { lookup: true, area }) ?? "";
  const titleOf = (kind: "area" | "project", id: string): string =>
    (kind === "area" ? names.areas : names.projects).find((g) => g.id === id)?.title ?? "";
  const ops: Operation[] = [];
  let group: WrittenGroup;
  let done = GROUP_DONE[action] ?? "no_change";
  let move = NO_MOVE;
  let cleared: Cleared | undefined;
  if (action === "create") {
    // The group created is created as named; an area named only to hold it keeps the typo check.
    let area = resolveGroup(names, "area", path.area, "path", {
      create: path.project === undefined,
      face: call.principal.origin,
    });
    if (area === undefined) {
      area = newId("a");
      ops.push({ kind: "area.create", id: area as Id<"a">, title: path.area });
    }
    group = { kind: "area", id: area, name: path.area };
    if (path.project !== undefined) {
      const fresh = ops.length > 0;
      let project = fresh
        ? undefined
        : resolveGroup(names, "project", path.project, "path", { area, create: true });
      const exists = project !== undefined;
      if (project === undefined) {
        project = newId("p");
        ops.push({ kind: "project.create", id: project as Id<"p">, title: path.project, area });
        group = { kind: "project", id: project, name: path.project };
      } else group = { kind: "project", id: project, name: titleOf("project", project) };
      if (folder !== undefined && facts !== undefined) {
        const read = await bindRead(call, "project", project);
        const here = read.current;
        if (
          here !== undefined &&
          folderKey(here.path, osOf(facts.platform)) ===
            folderKey(folder.stored, osOf(facts.platform))
        ) {
          group = { ...group, folder: here.path };
        } else if (here !== undefined) {
          throw invalid(
            "folder",
            "The project has another folder here",
            "Change it with action set_folder and base.",
          );
        } else {
          const { taken } = await projectFolderChecked(facts, project, folder, read);
          // A folder another live project has here: that project, rather than a second one for it.
          if (taken !== undefined) {
            const list = await readGroupsHere(call, readerOf(call.space));
            return {
              ...groupList(list, undefined),
              action,
              as_of: read.space.asOf,
              result: "exists",
              group: { kind: "project", id: taken.project, name: taken.name, folder: taken.stored },
            };
          }
          ops.push({ kind: "project.folder_set", project, path: folder.stored });
          group = { ...group, folder: folder.stored };
          if (exists) done = "folder_set";
        }
      }
    } else if (ops.length === 0) group = { kind: "area", id: area, name: titleOf("area", area) };
  } else {
    const kind = path.project === undefined ? "area" : "project";
    const area = lookup("area", path.area);
    const id = kind === "area" ? area : lookup("project", path.project ?? "", area);
    group = { kind, id, name: titleOf(kind, id) };
    if (action === "rename") {
      const title = to ?? "";
      ops.push(
        kind === "area"
          ? { kind: "area.patch", area: id, set: { title } }
          : { kind: "project.patch", project: id, set: { title } },
      );
      group = { ...group, name: title };
    } else if (action === "move") {
      if (kind !== "project") {
        throw invalid("path", "Only a project moves to another area", "Name it as Area/Project.");
      }
      let target = resolveGroup(names, "area", to ?? "", "to", { face: call.principal.origin });
      if (target === undefined) {
        target = newId("a");
        ops.push({ kind: "area.create", id: target as Id<"a">, title: to ?? "" });
      }
      ops.push({ kind: "project.move", project: id, area: target });
    } else if (action === "set_folder" && folder !== undefined && facts !== undefined) {
      const checked = await projectFolderChecked(
        facts,
        id,
        folder,
        await bindRead(call, "project", id),
      );
      if (checked.taken !== undefined) throw takenBy(checked.taken);
      move = await folderMove(call, facts, { kind: "project", id }, folder);
      ops.push({
        kind: "project.folder_set",
        project: id,
        path: folder.stored,
        ...(move.carry ? { carry: true } : {}),
      });
      group = { ...group, folder: folder.stored };
    } else if (action === "clear_folder") {
      cleared = await clearedOf(call, { kind: "project", id });
      ops.push({ kind: "project.folder_clear", project: id });
    } else {
      const archive = action === "archive";
      ops.push(
        kind === "area"
          ? { kind: archive ? "area.archive" : "area.unarchive", area: id }
          : { kind: archive ? "project.archive" : "project.unarchive", project: id },
      );
    }
  }
  let asOf: string | undefined;
  let outcome = "no_change";
  let replay = false;
  if (ops.length > 0) {
    const result = await submit(call, ops);
    await markersAfter(call, ops, result, { move, cleared });
    asOf = result.as_of;
    replay = result.replayed === true;
    if (result.status === "applied") outcome = done;
  }
  // The list as of the write, so the caller sees the group where it is now.
  let read: GroupsHere;
  try {
    read = await readGroupsHere(call, readerOf(call.space));
  } catch (error) {
    throw storageFailure(error);
  }
  return {
    ...groupList(read, undefined),
    action,
    as_of: asOf ?? read.space.asOf,
    result: outcome,
    group,
    ...(outcome !== "no_change" && !replay ? moveAnswer(move) : {}),
    ...(replay ? { replayed: true } : {}),
  };
}

/** The space's active areas and projects, and the projects' folders on this machine. */
interface GroupsHere extends Awaited<ReturnType<typeof readGroups>> {
  /** A project's folder here, and the name of the repository it holds, by the project's ID. */
  readonly folders: ReadonlyMap<string, { readonly stored: string; readonly repo?: string }>;
}

/**
 * The groups as organize lists them. The folders are read on their own: a space whose schema has
 * no folders lists its groups without.
 */
async function readGroupsHere(call: Call, reader: WorkerConnection): Promise<GroupsHere> {
  const read = await readGroups(reader);
  const folders = await readProjectFolders(reader, call.host.machine.id).catch(
    (): ProjectFolderRow[] => [],
  );
  const platform = call.host.platform ?? process.platform;
  const repos = await Promise.all(
    folders.map((f) => {
      const open = openPath(f.stored, call.host.home, platform);
      return open === undefined ? Promise.resolve(undefined) : repoName(open, platform);
    }),
  );
  return {
    ...read,
    folders: new Map(
      folders.map((f, k) => {
        const repo = repos[k];
        return [f.project, { stored: f.stored, ...(repo === undefined ? {} : { repo }) }];
      }),
    ),
  };
}

/** A group row as the result names it, a project with its folder here and the repository in it. */
function groupRow(
  row: Row,
  folders?: GroupsHere["folders"],
): { id: string; slug: string; name: string; active: number; folder?: string; repo?: string } {
  const folder = folders?.get(String(row["id"]));
  return {
    id: String(row["id"]),
    slug: String(row["slug"]),
    name: String(row["title"]),
    active: Number(row["active"]),
    ...(folder === undefined ? {} : { folder: folder.stored }),
    ...(folder?.repo === undefined ? {} : { repo: folder.repo }),
  };
}

/**
 * The areas and their projects (A3 3.4.10), in the space's order: at most GROUP_LIMITS.areas areas,
 * each with at most GROUP_LIMITS.projects projects and the count of those left out, and the
 * projects without an area. `only` keeps one area.
 */
function groupList(read: GroupsHere, only: string | undefined): Record<string, unknown> {
  const areas = read.areas.filter((row) => only === undefined || row["id"] === only);
  const projectsOf = (area: unknown) => read.projects.filter((p) => p["area_id"] === area);
  const loose = read.projects.filter(
    (p) => p["area_id"] === null || !read.areas.some((a) => a["id"] === p["area_id"]),
  );
  const project = (row: Row) => groupRow(row, read.folders);
  return {
    action: "list",
    as_of: read.space.asOf,
    areas: areas.slice(0, GROUP_LIMITS.areas).map((row) => {
      const projects = projectsOf(row["id"]);
      const more = projects.length - GROUP_LIMITS.projects;
      return {
        ...groupRow(row),
        projects: projects.slice(0, GROUP_LIMITS.projects).map(project),
        ...(more > 0 ? { more_projects: more } : {}),
      };
    }),
    projects: only === undefined ? loose.slice(0, GROUP_LIMITS.projects).map(project) : [],
    total_areas: areas.length,
    total_projects:
      only === undefined ? read.projects.length : areas.flatMap((a) => projectsOf(a["id"])).length,
  };
}

/**
 * The keys the `preferences` tool shows (A3 3.4.11), sorted: the registry's space keys whose value
 * is one of the tool's kinds, a word, a whole number, true or false, or a list of keys. An object
 * or a map (`grouping.names`, `autonomy.overrides`, `autonomy.areas`) has no form in the schema
 * grammar's outputs yet, and a machine key lives in machine.toml (A1 3.16). A key this build does
 * not act on yet (`LATER_PREFERENCES`) is left out.
 */
const TOOL_PREFERENCES: readonly PreferenceSpec[] = PREFERENCES.filter(
  (p) =>
    p.scope === "space" &&
    !LATER_PREFERENCES.some((later) => later.key === p.key) &&
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

/** No caller changes a key while the tool's set is a later step's. */
const PREFS_SET = laterIn("prefs.manage", { action: "set" }) === undefined;

/** Whether `actor` may set the key here (A1 3.16): never a policy key, else by its writers. */
const prefWritable = (p: PreferenceSpec, actor: string): boolean =>
  PREFS_SET && !p.policy && mayWrite(p, actor);

/** A stored or default value as the tool shows it: a list of `{key}` objects as its keys. */
function shownValue(p: PreferenceSpec, value: PrefValue | null): PrefValue | null {
  return isKeyList(p.shape) && Array.isArray(value)
    ? value.map((item: unknown) => String((item as { key?: unknown }).key))
    : value;
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

/** A conflict's `reason` when an undo with `check_script` found a newer change by a script. */
export const SCRIPT_CHANGE_AFTER = "script_change_after";

/**
 * `check_script`: the person's newest change is older than a change a script of theirs made, which
 * no undo reaches. Undoing now would take back the older change, which is rarely what someone who
 * just ran a script and then `undo` means, so nothing is undone and the conflict names both: the
 * change that would be undone (its commit, which a confirmed undo passes) and the script's. A
 * retry of an undo that applied finds its receipt and replays it instead.
 */
async function refuseBehindScript(call: Call): Promise<void> {
  const reader = readerOf(call.space);
  const { principal } = call;
  let found;
  try {
    const stored = await readReceipt(reader, {
      scope_id: principal.scope,
      request_id: String(call.input["request_id"]),
    });
    if (receiptResult(stored).found) return;
    const target = await readUndoTarget(reader, await actorOf(writerOf(call.space), principal));
    if (target === undefined) return;
    const scripted = await readScriptChange(reader, {
      scope: principalOf("cli-script", call.host.machine.id).scope,
      undone: target.commit,
      seq: Number.MAX_SAFE_INTEGER,
    });
    if (scripted === undefined) return;
    found = { target, scripted };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw storageFailure(error);
  }
  const { target, scripted } = found;
  throw new AppError({
    code: "conflict",
    message: `A script changed ${scripted.task} after your newest change, so nothing was undone: an undo now would take back your older change${target.tasks.length === 0 ? "" : ` to ${target.tasks.join(", ")}`}.`,
    hint: "Undo it anyway with --yes, or leave it.",
    data: {
      reason: SCRIPT_CHANGE_AFTER,
      commit: target.commit,
      ...(target.change === undefined ? {} : { change: target.change }),
      tasks: target.tasks,
      task_count: target.count,
      script_change: scripted,
    },
  });
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

/**
 * A launch whose folder's marker is gone or names other owners (marker.ts), as the person reads
 * it: whose the folder is instead, by a project's name, a task's reference or another space's
 * name, and the way on. The folder is named as the space stores it.
 */
async function unmarkedError(call: Call, error: LaunchFolderUnmarked): Promise<AppError> {
  const whose = error.of === "project" ? "this task's project" : "this task";
  const space = call.space.id;
  const names: string[] = [];
  let groups: GroupNames | undefined;
  for (const owner of error.owners.slice(0, 3)) {
    if (owner.space !== space) {
      const other = call.host.spaces().find((s) => s.id === owner.space)?.name;
      names.push(other === undefined ? "another space" : `the space ${other}`);
      continue;
    }
    if (owner.kind === "project") {
      groups ??= await readGroupNames(readerOf(call.space)).catch(() => undefined);
      const name = groups?.projects.find((p) => p.id === owner.id)?.title;
      names.push(name === undefined ? "another project" : `the project ${name}`);
    } else {
      const ref = await readTaskRef(readerOf(call.space), owner.id).catch(() => undefined);
      names.push(ref === undefined ? "another task" : `the task ${ref}`);
    }
  }
  const why =
    error.reason === "marker_missing"
      ? `The folder has no ${PRODUCT_NAME} marker`
      : names.length === 0
        ? `The folder's ${PRODUCT_NAME} marker cannot be read`
        : `The folder's ${PRODUCT_NAME} marker names ${[...new Set(names)].join(", ")}`;
  return new AppError({
    code: "invalid_input",
    message: `${why}, so it may not be the folder set for ${whose}. Nothing was started.`,
    hint: `To use this folder and mark it, open it again with --mark-folder. Or give ${whose} another folder.`,
    data: {
      field: "task",
      reason: error.reason,
      folder: error.folder,
      of: error.of,
      ...(names.length === 0 ? {} : { owners: [...new Set(names)] }),
    },
  });
}

export function launchError(error: unknown): unknown {
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
    const { reason, folder } = error;
    return new AppError({
      code: "invalid_input",
      message:
        reason === "path_missing"
          ? "Folder not found on this machine."
          : reason === "not_a_directory"
            ? "The task's folder is a file on this machine, not a folder."
            : reason === "not_answering"
              ? "The task's folder did not answer in time."
              : "This task's folder cannot be used on this machine.",
      ...(folder === undefined
        ? {}
        : {
            hint: "Connect the drive it is on, or give the task or its project another folder, then open it again.",
          }),
      data: { field: "task", reason, ...(folder === undefined ? {} : { folder }) },
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
 * This connection's session: bound, with its task line and the notes from the user for agents on
 * it, or unbound. An MCP connection shows the instance and app its entry names.
 */
function sessionOf(
  call: Call,
  bound: { readonly ref: string; readonly instructions: number } | undefined,
): Record<string, unknown> {
  const { instance, app } = call.caller.client ?? {};
  const session = sessionIn(call);
  return {
    state: session === undefined ? "unbound" : "bound",
    ...(session === undefined || bound === undefined
      ? {}
      : { task: bound.ref, notes_for_agents: bound.instructions }),
    ...(instance !== undefined && CLIENT_WORD.test(instance) ? { instance } : {}),
    ...(app !== undefined && CLIENT_WORD.test(app) ? { app } : {}),
  };
}

/**
 * What a connection that is no session does next when tasks match the working folder exactly: with
 * one clear match it names that task on the calls that act on it, with several it asks. The folder itself never
 * chooses the task.
 */
function hereHint(
  here: readonly { readonly row: Row; readonly match: Match }[],
  prefix: string,
): string | undefined {
  const exact = here.filter((h) => h.match === "exact");
  const [only] = exact;
  if (exact.length === 1 && only !== undefined) {
    const ref = String(taskRow(only.row, prefix)["ref"]);
    return `One task matches this folder. If your work belongs to it, pass task ${ref} on the calls that act on it, and tell the user.`;
  }
  if (exact.length > 1) {
    return `${String(exact.length)} tasks match this folder. Ask the user which one, then pass its task on the calls that act on it.`;
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
