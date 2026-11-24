// The request path for operations (A2 3.6.4 `op/call` and `op/list`; A3 3.2, 3.4, 3.5, 3.7.9;
// A1 3.8). One function per M1 registry entry. It is independent of the transport: the
// local endpoint calls it now, MCP (M2.02, M2.03) and HTTP (M2.12) call the same functions with
// their own caller. For every call:
//
//   entry → exposure (the class may call it) → principal (audience, actor, writer scope)
//   → the space, and for a write its request's receipt: a request the writer accepted is a retry,
//     answered from that receipt (A3 3.4.1), marked `replayed`, before any rule reads its input
//   → the caller's input parsed with the contract (SafeText, defaults, the audience's limits)
//   → reads through the space's reader, writes expanded into A1 operations and sent to the space's
//     writer with the scope and the intent
//   → the contract's result, checked against the entry's output schema, or the error body.
//
// A write's answer is built by one function of its entry (ANSWERS) from what the write stored: the
// writer's result and the record the handler sent with the request (`submit`'s `answer`). The
// first answer and every retry are built the same way, so a retry says what the write did. Names
// and lists in an answer are read as of when it is made, in one snapshot whose `as_of` it carries;
// a read that fails leaves them out, and never the answer.
import { CLI_NAME, PRODUCT_NAME } from "@ttasks/brand";
import {
  findEntry,
  AppError,
  FINISHED_CURSOR,
  fitsShape,
  TRASH_CURSOR,
  GROUP_CURSOR,
  GROUP_PAGE,
  isKeyList,
  laterIn,
  AUTONOMY_IN_FORCE,
  LATER_PREFERENCES,
  LATER_SETS,
  mayWrite,
  newerWorkJson,
  opSpec,
  parseInput,
  PREFERENCES,
  readsOnly,
  receiptResult,
  registry,
  shapeText,
  TaskUpdateInput,
  type AnyEntry,
  type PreferenceRead,
  type PreferenceSpec,
  type PrefValue,
} from "@ttasks/contracts";
import { localDate } from "@ttasks/contracts/day";
import {
  folderKey,
  freeSlug,
  intentFingerprint,
  isId,
  newId,
  normaliseSourceKey,
  normaliseStored,
  type InsideFolder,
  type Id,
  type Operation,
  type OpResult,
  type SourceFields,
  type PatchableField,
  type Receipt,
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
  sessionReplaced,
  spaceChanged,
  type Copy,
} from "./copies.ts";
import {
  LaunchFolderUnavailable,
  LaunchFolderUnmarked,
  LaunchUnavailable,
  LaunchWriterGone,
  leftOutOf,
  NOT_FOR_SPACE,
  type OpenTaskRequest,
  type OpenTaskResult,
  type PackContent,
} from "../launch/open.ts";
import type { Session, SessionPort } from "./binding.ts";
import { checkGrant, grantRefused, standingOf, type HomeGate } from "./grant.ts";
import { dueDate, localTimeZone, pastInstant, sourceInstant } from "./dates.ts";
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
  type Stayed,
  type Move,
} from "./folders.ts";
import {
  byOf,
  invalid,
  readOnly,
  requestIdReused,
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
import { editDistance, fold, resolveGroup } from "./groups.ts";
import {
  readCommit,
  readCommitOps,
  readCommitTasks,
  readBind,
  readGroupNames,
  readGroups,
  readGroupsAt,
  readProjectFolders,
  readLaunch,
  readFoldersHere,
  readHereTasks,
  readMove,
  readRemoval,
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
  readReviewedMark,
  readTaskLinks,
  readKeyHolders,
  readTaskKeys,
  readTaskRef,
  readTitles,
  logOf,
  noteOf,
  sourceOf,
  taskRow,
  text,
  type CommitFacts,
  type CommitOp,
  type HereIds,
  type TaskFolder,
  type TaskRead,
  type BindRead,
  type MoveRead,
  type Destination,
  type GroupName,
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
import { readChangeTasks, readTrash } from "./trash.ts";
import { listSkills, readSkills, servedText, type Catalog, type Skill } from "../skills/index.ts";

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
  /** A restored copy not claimed: when it was restored, and from which backup file. */
  readonly restored?: { readonly at: string; readonly backup?: string };
  /**
   * The copy it is served as, once served (hub/spaces.ts copyToken): a page sends it back with
   * each call, so a tab never writes into another copy than the one it loaded.
   */
  readonly copy?: string;
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
  /** The person's skills folder (`<TTasks home>/skills`). None: the default skills alone. */
  readonly skillsFolder?: string;
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
  /**
   * The fingerprint of the input as the caller sent it, before any rule of this build read it. It
   * goes with the request's record, so a retry sent as it was is known whatever a later build's
   * rules say of its input.
   */
  readonly sent: string;
}

/** What a write's answer is built from besides the stored record: never the call's input. */
type View = Pick<Call, "host" | "caller" | "principal" | "entry" | "space">;

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
      "Pass base: the as_of of the answer that last listed the group.",
    );
  }
}

/**
 * `opCall` as `principal`. A write whose request ID has the receipt of an accepted request in the
 * caller's scope is a retry: it is answered from that receipt before any rule of this build reads
 * its input, so neither a write since nor a rule a later build tightened turns it into an error.
 */
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
  if (params.space !== undefined && typeof params.space !== "string") {
    throw invalid("space", "Expected a space ID or name");
  }
  // A call whose space cannot be picked is told what is wrong with its input first, as before.
  let space: UsableSpace | undefined;
  let unpicked: unknown;
  try {
    space = pickSpace(host, caller, params.space);
  } catch (error) {
    unpicked = error;
  }
  const picked = (): UsableSpace => {
    if (space === undefined) throw unpicked;
    return space;
  };
  const requestId = input["request_id"];
  // A launch is the user's record of its own, which answers a repeated click itself.
  if (
    space === undefined ||
    entry.kind !== "write" ||
    typeof requestId !== "string" ||
    readsOnly(entry, input) ||
    entry.ops.some((op) => opSpec(op)?.r7 === true)
  ) {
    return decideCall(host, caller, entry, principal, picked, input);
  }
  const receipt = await receiptOf(host, caller, space, principal, requestId);
  if (receipt === undefined || !isAccepted(receipt.status)) {
    return decideCall(host, caller, entry, principal, picked, input);
  }
  const view: View = { host, caller, principal, entry, space };
  const record = receipt.result.answer;
  // A receipt names the entry its request was for: under its ID, another entry's is refused.
  const madeFor = record?.["entry"];
  if (madeFor !== undefined && madeFor !== entry.name) throw requestIdReused(receipt.at);
  const sent = record?.["sent"];
  if (sent === intentPrint(space.id, entry.name, input)) {
    return checked(host, entry, await retried(view, receipt.result));
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = checkedInput(entry, principal, input);
  } catch (error) {
    if (sent !== undefined || !(error instanceof AppError)) throw error;
    // An earlier build's receipt names no entry and keeps no fingerprint of the input as sent,
    // and this body does not pass this build's rules. Its commit shows whose request it was: this
    // entry's is said, uncompared, and another's holds the ID. One that committed nothing wrote
    // nothing, and its body is judged as any other.
    const ops = receipt.seq === null ? [] : await commitOps(view, receipt.seq);
    if (ops.length === 0) throw error;
    if (!madeBy(ops).includes(entry.name)) throw requestIdReused(receipt.at);
    const options = { compared: false, earlier: { ops } } as const;
    return checked(host, entry, await retried(view, receipt.result, options));
  }
  if (intentPrint(space.id, entry.name, parsed) === receipt.fingerprint) {
    // An earlier build's receipt keeps no record of what its handler decided: its input says.
    const options = sent === undefined ? { earlier: { input: parsed } } : {};
    return checked(host, entry, await retried(view, receipt.result, options));
  }
  // Another request under this ID: the writer refuses it (REQUEST_ID_REUSED).
  return decideCall(host, caller, entry, principal, picked, input);
}

/** The input after the entry's rules: hidden fields, later steps, the contract, action fields. */
function checkedInput(
  entry: AnyEntry,
  principal: Principal,
  input: Record<string, unknown>,
): Record<string, unknown> {
  checkHiddenFields(entry, input, principal.audience);
  refuseLater(entry.name, input, principal.audience);
  const parsed = parseInput(entry, principal.audience, input);
  if (!parsed.success) throw schemaFailure(parsed.error, input, principal.origin, entry.name);
  checkActionFields(entry, parsed.data);
  return parsed.data;
}

/**
 * A call without a retry's receipt: the input's rules, then the handler. A write that fails once
 * its own request committed, or while its own retry overlaps it and commits, is answered from
 * that request's stored result: never an error after a commit.
 */
async function decideCall(
  host: OpsHost,
  caller: Caller,
  entry: AnyEntry,
  principal: Principal,
  picked: () => UsableSpace,
  input: Record<string, unknown>,
): Promise<unknown> {
  const parsed = checkedInput(entry, principal, input);
  const space = picked();
  const now = (host.now ?? Date.now)();
  const call: Call = {
    host,
    caller,
    principal,
    entry,
    space,
    input: parsed,
    today: localDate(now, (host.timeZone ?? localTimeZone)()),
    sent: intentPrint(space.id, entry.name, input),
  };
  const handler = HANDLERS[entry.name];
  if (handler === undefined) throw opUnknown();
  let result: unknown;
  try {
    // A call that binds a folder or may create a group by name decides on what it read of the
    // space: such calls go one at a time per space, from that read to the writer's answer, so two
    // never both create one name or bind one folder by two spellings.
    result = await (decidesOnNames(entry.name, call.input)
      ? oneAtATime(space.id, () => handler(call))
      : handler(call));
  } catch (error) {
    const own = committed.get(call);
    const stored = own ?? (error instanceof AppError ? await acceptedReceipt(call) : undefined);
    if (stored === undefined) throw error;
    result = await retried(call, stored);
  }
  return checked(host, entry, result);
}

/**
 * The result checked against the entry's output schema. A write's is returned all the same: it
 * has done its work, and an error would send the caller to do it again, or to undo an older
 * change. The mismatch is a defect to find in the log. A read has changed nothing, so its caller
 * can be told plainly.
 */
function checked(host: OpsHost, entry: AnyEntry, result: unknown): unknown {
  if (entry.output.safeParse(result).success) return result;
  if (entry.kind === "write") {
    host.resultMismatch?.(entry.name);
    return result;
  }
  throw new AppError({
    code: "internal",
    message: "The service built a result that does not match its contract.",
  });
}

/**
 * A write's answer from what it stored (ANSWERS), for a retry or a call that failed after its
 * commit. `compared: false` marks a retry this build could not compare with its request.
 * `earlier` stands in for the record of a receipt an earlier build wrote, which keeps none.
 */
async function retried(
  view: View,
  stored: WriteResult,
  options: { readonly compared?: false; readonly earlier?: Earlier } = {},
): Promise<unknown> {
  const answer = ANSWERS[view.entry.name];
  if (answer === undefined) throw opUnknown();
  const built = await answer(view, stored, options.earlier);
  return options.compared === false ? { ...built, compared: false } : built;
}

/** The accepted result of each call whose request committed: its answer is built from it. */
const committed = new WeakMap<Call, WriteResult>();

/** The accepted receipt of the call's own intent, if one is there now: a retry that overlapped. */
async function acceptedReceipt(call: Call): Promise<WriteResult | undefined> {
  const id = call.input["request_id"];
  const writer = call.space.state === "open" ? call.space.writer : undefined;
  if (call.entry.kind !== "write" || typeof id !== "string" || writer === undefined) {
    return undefined;
  }
  const found = await writer
    .receipt({ scope_id: call.principal.scope, request_id: id })
    .catch(() => undefined);
  const intent = intentPrint(call.space.id ?? "", call.entry.name, call.input);
  return found !== undefined && found.fingerprint === intent && isAccepted(found.status)
    ? found.result
    : undefined;
}

const isAccepted = (status: string): boolean => status === "applied" || status === "unchanged";

/** The operations commit `seq` ran, read for a receipt of an earlier build. */
async function commitOps(view: View, seq: number): Promise<CommitOp[]> {
  try {
    return await readCommitOps(readerOf(view.space), seq);
  } catch (error) {
    throw storageFailure(error);
  }
}

/**
 * Whose request a commit of an earlier build was, by the kinds of operation it ran, first row
 * first: the entries that run one of a row's kinds. Two share a row where one commit could be
 * either's with the same effect. Receipts of this build name their entry, so earlier builds'
 * kinds are all this needs to know.
 */
const MADE_BY: readonly (readonly [readonly string[], readonly string[]])[] = [
  [["undo"], ["history.undo"]],
  [["redo"], ["history.redo"]],
  [["task.complete", "task.archive", "task.wrap_up"], ["task.finish"]],
  [["task.create"], ["task.add"]],
  [["task.reopen"], ["task.reopen"]],
  [["task.delete", "task.restore"], ["task.delete"]],
  [["note.delete", "note.restore"], ["note.remove"]],
  [["log.add", "note.add"], ["entry.add"]],
  [["pref.set"], ["prefs.manage"]],
  [
    [
      "task.patch",
      "task.context_append",
      "task.move",
      "source.add",
      "source.unlink",
      "source.relink",
      "place.set",
      "place.clear",
    ],
    ["task.update"],
  ],
  [
    ["task.folder_set", "task.folder_clear"],
    ["task.update", "folder.manage"],
  ],
  [
    [
      "area.patch",
      "area.move",
      "area.archive",
      "area.unarchive",
      "project.patch",
      "project.move",
      "project.archive",
      "project.unarchive",
    ],
    ["group.manage"],
  ],
  [
    ["area.create", "project.create", "project.folder_set", "project.folder_clear"],
    ["group.manage", "folder.manage"],
  ],
];

const madeBy = (ops: readonly CommitOp[]): readonly string[] =>
  MADE_BY.find(([kinds]) => ops.some((op) => kinds.includes(op.op)))?.[1] ?? [];

/**
 * The receipt of a call's request ID in its writer scope, read in the writer's queue so that it
 * sees every request sent before. None on a space without a writer here: its write is refused as
 * it was. The grant first, so a home that may not use the space reads no answer of it.
 */
async function receiptOf(
  host: OpsHost,
  caller: Caller,
  space: UsableSpace,
  principal: Principal,
  requestId: string,
): Promise<Receipt | undefined> {
  if (space.state !== "open" || space.writer === undefined) return undefined;
  checkGrant(host, caller, space.id);
  try {
    return await space.writer.receipt({ scope_id: principal.scope, request_id: requestId });
  } catch (error) {
    throw storageFailure(error);
  }
}

/**
 * The fingerprint the writer keeps for a request of `entry` with `input` (receipts.ts), as `submit`
 * sends its intent: the input as the service parsed it, or as the caller sent it (`Call.sent`).
 */
function intentPrint(space: string, entry: string, input: Record<string, unknown>): string {
  const reason = input["reason"];
  return intentFingerprint({
    space_id: space,
    entry,
    input: intentInput(input),
    reason: typeof reason === "string" ? normaliseStored(reason) : null,
  });
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
 * Only spaces that are not closed are candidates: a closed space serves no call. One folder serves
 * a space at a time, so an ID or a name means that folder (copies.ts).
 */
/**
 * The machine's default space among `live` (spaces that are not closed): the entry that serves the
 * space with that ID (copies.ts); `not_served` when none has it; undefined when the machine has no
 * default.
 */
export function defaultOf<S extends Copy>(
  live: readonly S[],
  defaultId: string | undefined,
): S | "not_served" | undefined {
  if (defaultId === undefined) return undefined;
  return copyOf(live, defaultId) ?? "not_served";
}

/**
 * The space a call uses, which must be the copy its caller was made for: the copy a page loaded,
 * or the copy an agent's session was launched in.
 */
function pickSpace(host: OpsHost, caller: Caller, named: string | undefined): UsableSpace {
  const space = spaceOfCall(host, caller, named);
  if (caller.copy !== undefined && space.copy !== caller.copy) throw spaceChanged();
  const session = caller.binding?.kind === "session" ? caller.binding.session : undefined;
  if (session?.copy !== undefined && space.copy !== session.copy) throw sessionReplaced();
  return space;
}

function spaceOfCall(host: OpsHost, caller: Caller, named: string | undefined): UsableSpace {
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
  return answerFor(live, copyOf(live, held), held);
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
 * started with no default to take, or an older bridge reconnected without its space. An entry
 * that names a space, or a registered home's, is told the one space it may use; a hand-made entry
 * that names none, what the default needs. A registered home with no such space gets the grant
 * refusal instead (pickSpace).
 */
function noSpace(host: OpsHost, entry: EntryFacts): AppError {
  const unknown = entry.named
    ? `The agent's ${PRODUCT_NAME} entry names a space this machine has none of, or two of (${CLI_NAME} space list). `
    : "";
  let fix: string;
  if ((entry.named || !entry.manual) && entry.mayUse !== undefined) {
    fix = `It may use ${spaceWords(host, entry.mayUse)}: ask the user to name it in ${ENTRY} (--space ${entry.mayUse}), then to restart the agent app.`;
  } else if (entry.named) {
    fix = `Ask the user to set a default space (${CLI_NAME} space use) and name it in ${ENTRY}, then to restart the agent app.`;
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
 * moves it there: a restart with that space named in its entry, as setup and its print write it.
 * A hand-made entry that names no space takes the default at a restart.
 */
function grantedElsewhere(host: OpsHost, space: string, entry: EntryFacts): AppError {
  const there = spaceWords(host, space);
  const hint =
    entry.named || !entry.manual
      ? `It may use ${there} now: ask the user to check that ${ENTRY} names it (--space ${space}), then to restart the agent app.`
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
    if (isAmbiguity(found)) throw ambiguousError();
    return answerFor(live, found, wanted);
  }
  if (caller.class === "cli-agent") {
    throw invalid("space", "Name the space", "Pass --space, or set TTASKS_SPACE.");
  }
  const defaultId = host.defaultSpace?.();
  if (defaultId !== undefined) return answerFor(live, copyOf(live, defaultId), defaultId);
  const only = onlySpace(live);
  if (only === undefined) return answerFor(live, undefined, undefined);
  if (only === "several") {
    throw invalid(
      "space",
      "Name the space",
      "Pass --space with an ID, a name or a folder from ttasks space list.",
    );
  }
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
 * (A1 3.8). A conflict or refusal becomes its error body. `warnings` and `answer` are what the
 * handler decided before the writer (a place bound without a remote check, the group a create
 * found, where each operation came from in the input): the writer keeps them with an accepted
 * result, so they come back in `result.warnings` and `result.answer` and the answer is built from
 * them (ANSWERS). With no operation, the request changes nothing and its receipt is kept all the
 * same, with its record.
 */
async function submit(
  call: Call,
  ops: Operation[],
  options: {
    readonly active?: boolean;
    /** The base when the caller gave none: the handler's own read that decided a value. */
    readonly base?: string;
    readonly warnings?: readonly string[];
    readonly answer?: Readonly<Record<string, unknown>>;
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
      ...(typeof input["base"] === "string"
        ? { base: input["base"] }
        : options.base === undefined
          ? {}
          : { base: options.base }),
      ...(typeof input["reason"] === "string" ? { reason: input["reason"] } : {}),
      ...(principal.actorKind === "human" && options.undoable !== false ? { undoable: true } : {}),
      ...(options.active === true ? { active: true } : {}),
      ...(options.warnings === undefined || options.warnings.length === 0
        ? {}
        : { warnings: [...options.warnings] }),
      answer: { ...options.answer, sent: call.sent, entry: call.entry.name },
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
    const failure = resultFailure(
      result,
      hints,
      options.wrapUp,
      principal.origin,
      own,
      options.pathOf,
    );
    throw (await inTrash(call, ops, result, failure)) ?? failure;
  }
  committed.set(call, result);
  return result;
}

/** The task a refused operation names, as the request gave it (a reference or an ID). */
function refusedTask(ops: readonly Operation[], result: WriteResult): string | undefined {
  const at = result.error?.op;
  const op = at === undefined ? undefined : ops[at];
  const task = op !== undefined && "task" in op ? op.task : undefined;
  return typeof task === "string" ? task : undefined;
}

/**
 * A write refused because its task is in the Trash, or a restore because its creation was undone:
 * says who moved it there and when, or that Redo brings it back, and what to do. An agent is told
 * to tell the person and never to add it again or restore it itself: a task recreated after the
 * person removed it is the mistake the Trash undoes.
 */
async function inTrash(
  call: Call,
  ops: readonly Operation[],
  result: WriteResult,
  failure: AppError,
): Promise<AppError | undefined> {
  const problem = result.error;
  const task = refusedTask(ops, result);
  if (task === undefined) return undefined;
  const undone = problem?.code === "NOT_FOUND" && problem.reason === "creation_undone";
  if (!undone && (problem?.code !== "DELETED" || problem.field !== "task")) return undefined;
  const found = await readRemoval(readerOf(call.space), task).catch(() => undefined);
  if (found === undefined) return undefined;
  const { ref, removal } = found;
  if (undone) {
    // Not in the Trash: Redo brings it back with its notes and links, which a restore would not.
    return new AppError({
      ...failure.toBody(),
      message: `${ref}'s creation was undone: it is not in the Trash, and nothing was restored.`,
      hint:
        call.principal.origin === "cli"
          ? `Redo brings it back with its notes and links: ${CLI_NAME} redo.`
          : "Redo brings it back with its notes and links.",
      data: { ...failure.data, reason: "creation_undone", task: ref },
    });
  }
  // A write to a task whose creation was undone stays plain not_found: it is in no Trash.
  if (removal.undone) return undefined;
  const who = removal.by === "user" ? "the user" : removal.by;
  const at = new Date(removal.at).toISOString();
  const hint =
    call.principal.actorKind !== "human"
      ? "Tell the user. Do not add it again or restore it yourself."
      : call.principal.origin === "cli"
        ? `Restore it first: ${CLI_NAME} restore ${ref}.`
        : "Restore it first.";
  return new AppError({
    ...failure.toBody(),
    message: `${ref} is in the Trash: ${who} moved it there at ${at}.`,
    hint,
    data: { ...failure.data, reason: "in_trash", task: ref },
  });
}

/**
 * A change the space does not have: a mistyped ID, or one from before a backup was restored over
 * the space. Which, the service cannot tell, so the answer does not say.
 */
function changeGone(): AppError {
  return new AppError({
    code: "not_found",
    message: "The space has no change with this ID, so nothing was restored.",
    hint: "The Trash shows what is there now, with each change's ID.",
    data: { field: "change", reason: "change_gone" },
  });
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

/** `refs` as a sentence lists them: "M-20", "M-20 and M-21", "M-20, M-21 and M-22". */
const listed = (refs: readonly string[]): string =>
  refs.length < 2 ? refs.join("") : `${refs.slice(0, -1).join(", ")} and ${refs.at(-1) ?? ""}`;

/**
 * What a source the request added keeps or shares, from the writer's result, so a replay warns the
 * same, by the input path of the source. A1's `source_differs` (A3 3.4.6): a source that exists
 * already keeps its metadata, and the warning names the fields the input gave otherwise, never a
 * value. `shared_key`: other active tasks hold the source's key too, so a capture of it asks which.
 */
function sourceWarnings(result: WriteResult, paths: ReadonlyMap<number, string>): string[] {
  return result.results.flatMap((op) => {
    const path = paths.get(op.i);
    if (path === undefined) return [];
    const warnings: string[] = [];
    if (op.differs !== undefined && op.differs.length > 0) {
      warnings.push(
        `The source at ${path} exists already and keeps its own ${op.differs.join(", ")} (source_differs).`,
      );
    }
    if (op.shared_with !== undefined && op.ref !== undefined) {
      warnings.push(
        `The source at ${path} is on ${listed(op.shared_with)} too: a capture of its key asks which of ${listed([op.ref, ...op.shared_with])} (shared_key).`,
      );
    }
    return warnings;
  });
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** A link a name resolved to: its source, and its version as read, when it was read. */
interface NamedLink {
  readonly source: Id<"s">;
  readonly version?: number;
}

/**
 * The links `names` name among all of a task's links, live and detached, at `path`: a source ID,
 * or a key (normalised as it is stored) or URL that names one link. A name that fits several
 * links is ambiguous and lists their IDs, whatever state each is in. Two names of one link are that
 * link once. A name that fits none is not_found, except a source ID, which the writer decides.
 */
function linksNamed(links: readonly Row[], names: readonly string[], path: string): NamedLink[] {
  const found = new Map<string, NamedLink>();
  names.forEach((name, k) => {
    const key = normaliseSourceKey(name) ?? name;
    const fits = links.filter(
      (row) =>
        row["id"] === name ||
        row["source_key"] === key ||
        row["url"] === name ||
        (row["source_key"] === null && row["ref"] === key),
    );
    const [one] = fits;
    if (fits.length > 1) {
      const ids = fits.map((row) => text(row["id"]));
      throw new AppError({
        code: "ambiguous",
        message: "Several sources of the task have this key or URL.",
        hint: `Name one by its ID: ${ids.join(", ")}.`,
        data: {
          issues: [{ path: `${path}.${String(k)}`, message: "Names several sources" }],
          candidates: fits.map((row) => ({ id: text(row["id"]), title: text(row["title"]) })),
        },
      });
    }
    if (one !== undefined) {
      const source = text(one["id"]) as Id<"s">;
      found.set(source, { source, version: Number(one["version"]) });
      return;
    }
    if (isId(name, "s")) {
      found.set(name, { source: name });
      return;
    }
    throw new AppError({
      code: "not_found",
      message: "No source of the task has this ID, key or URL.",
      hint: "Read the task's sources for their IDs (ttasks show <task> --section sources).",
      data: { issues: [{ path: `${path}.${String(k)}`, message: "Names no source of the task" }] },
    });
  });
  return [...found.values()];
}

/**
 * A put back refused because other active tasks hold the source's key: the writer names each
 * holder's link in its conflicts, and this says where captures go, with the key from `links`.
 * Undefined for any other refusal, such as a stale base on the task's own link.
 */
function keyHeld(error: unknown, task: Id<"t"> | undefined, links: readonly Row[]): unknown {
  if (!(error instanceof AppError) || error.code !== "conflict" || task === undefined) {
    return undefined;
  }
  const conflicts = (error.data["conflicts"] ?? []) as { task?: string; id?: string }[];
  const held = new Map<string, string[]>();
  for (const c of conflicts) {
    const [holder, source] = (c.id ?? "").split("|");
    if (holder === undefined || source === undefined || holder === task || c.task === undefined) {
      return undefined;
    }
    held.set(source, [...(held.get(source) ?? []), c.task]);
  }
  if (held.size === 0) return undefined;
  // A replay answers with the holders the request was refused for: they may hold it no more.
  const then = error.data["replayed"] === true;
  const said = [...held].map(([source, refs]) => {
    const row = links.find((link) => link["id"] === source);
    const key = typeof row?.["source_key"] === "string" ? row["source_key"] : "Its key";
    if (then) return `${key} was on ${listed(refs)} when this was decided.`;
    return refs.length === 1
      ? `${key} is on ${listed(refs)} now: captures go there.`
      : `${key} is on ${listed(refs)} now: a capture of it asks which.`;
  });
  return new AppError({
    code: "conflict",
    message: `${said.join(" ")} Nothing was put back.`,
    hint: "Put it back once no other active task holds the key: finished, dropped, or the source detached from it.",
    data: { ...error.data, reason: "key_held" },
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
      case "reviewed":
        return rows("tasks").some((c) => c.field === "reviewed_at");
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

/** A source as the writer takes it: its date a real date, or an instant with its offset. */
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
    const at = sourceInstant(source["at"]);
    if (at === undefined) {
      throw invalid(
        `${path}.at`,
        "Not a date or an instant",
        "Use an ISO date, or an instant with its offset such as 2026-03-02T14:05:00Z.",
      );
    }
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

const NO_MOVE: Move = { moved: [], stayed: [] };

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
): Promise<Move> {
  let read: MoveRead;
  try {
    read = await readMove(readerOf(call.space), owner, call.host.machine.id);
  } catch (error) {
    throw storageFailure(error);
  }
  const id = read.owner ?? owner.id;
  const from = read.current;
  const { markers } = call.host;
  const space = call.space.id;
  const move = await moveOf(from, folder, { kind: owner.kind, owner: id }, read.here, facts, () =>
    markers === undefined || space === undefined || from === undefined
      ? Promise.resolve(false)
      : markers.movedTo({ space, kind: owner.kind, id }, from, folder.stored),
  );
  for (const follower of move.moved) {
    const reason = await reservedBy(expanded(follower.to, facts.home, facts.platform), facts);
    if (reason !== undefined) {
      throw folderRefused(
        "folder",
        reason,
        follower.kind === "task" ? { task: follower.label } : {},
      );
    }
  }
  return move;
}

/** A folder write's `carry`: the owners whose folders moved along with it. */
const carryOf = (move: Move): { carry?: string[] } =>
  move.moved.length === 0 ? {} : { carry: move.moved.map((f) => f.owner) };

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
 * folder it cleared loses it, and the folders the writer moved along keep theirs, which moved with
 * them. A folder that takes no marker changes nothing here.
 */
async function markersAfter(
  call: Call,
  ops: readonly Operation[],
  result: WriteResult,
  extra: { readonly cleared?: Cleared | undefined } = {},
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
  for (const f of result.results.flatMap((op) => op.inside?.along ?? [])) {
    await markers.moved({ space, kind: f.kind, id: f.owner }, f.from, f.to);
  }
  const cleared = extra.cleared;
  if (cleared !== undefined) {
    await markers.unmark({ space, kind: cleared.kind, id: cleared.id }, cleared.stored);
  }
}

/** At most this many folders that moved along or stayed are named in an answer. */
const FOLLOWERS_SHOWN = 20;

/**
 * Why the service leaves the folders inside the old one where they are, when it does: what it
 * found on disk, which goes with the request's record (`submit`'s `answer`).
 */
const stayedOf = (move: Move): { stayed_because?: Stayed } =>
  move.because === undefined ? {} : { stayed_because: move.because };

/** The projects' names, by ID, in an answer's snapshot (`Now`): what it calls a project. */
type Names = ReadonlyMap<string, string>;

/**
 * A move's part of an answer (folder.manage, organize, update_task): what the writer did to the
 * folders inside the old one (OpResult.inside), those it took along and those it left, with why
 * the service left them. A task by its reference; a project by its name now, when it was read.
 * One the writer found there that the service had not looked at stays unchecked.
 */
function movedOf(result: WriteResult, names: Names | undefined): Record<string, unknown> {
  const inside = result.results.find((op) => op.inside !== undefined)?.inside;
  if (result.status !== "applied" || inside === undefined) return {};
  const named = (list: readonly InsideFolder[]) =>
    list.slice(0, FOLLOWERS_SHOWN).map((f) => {
      const name = names?.get(f.owner);
      return {
        kind: f.kind,
        ...(f.kind === "task" ? { ref: f.ref } : name === undefined ? {} : { name }),
        folder: f.to,
      };
    });
  const because = result.answer?.["stayed_because"] ?? "unchecked";
  return {
    ...(inside.moved === 0 ? {} : { moved: inside.moved, followed: named(inside.along) }),
    ...(inside.stayed === 0
      ? {}
      : { stayed: inside.stayed, stayed_because: because, kept: named(inside.left) }),
  };
}

/** Whether a write's answer names a project that its folder move took along or left. */
const namesProjects = (result: WriteResult): boolean =>
  result.results.some(
    (op) =>
      op.inside !== undefined &&
      [...op.inside.along, ...op.inside.left].some((f) => f.kind === "project"),
  );

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
 */
async function draftFolders(
  call: Call,
  list: readonly Record<string, unknown>[],
  ids: readonly string[],
  path: (k: number) => string,
): Promise<DraftFolders> {
  const none = (): DraftFolders => ({ list: [...list], ops: [], warnings: [] });
  if (!list.some((draft) => typeof draft["folder"] === "string")) {
    return none();
  }
  const facts = bindFacts(call);
  const out = [...list];
  const ops: Operation[] = [];
  const warnings: string[] = [];
  let projects: readonly ProjectFolderRow[] | undefined;
  const looks = new Map<string, Promise<string | undefined>>();
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
  return { list: out, ops, warnings };
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

/** The drafts with their groups resolved, and the groups their new names create. */
interface ResolvedDrafts {
  readonly list: Record<string, unknown>[];
  /** `area.create` and `project.create` for each new name, once per name, in first-named order. */
  readonly groups: Operation[];
  /** Each group's kind and the input path of the name that made it, in the order of `groups`. */
  readonly made: Made[];
}

/** A group a call's name makes: its kind, and the input path of that name. */
interface Made {
  readonly kind: "area" | "project";
  readonly at: string;
}

/**
 * The drafts (or `update_task`'s `set`) with their area and project names resolved to IDs
 * (groups.ts, A3 3.4.5), as the writer takes them; `path` gives each item's input path. A name no
 * group has, and none is close to, is a new group: its create goes with the request, once however
 * many drafts name it, so the drafts and their new groups are one commit and one undo. Without
 * names to resolve, nothing is read.
 */
async function resolvedDrafts(
  call: Call,
  list: readonly Record<string, unknown>[],
  path: (k: number) => string,
): Promise<ResolvedDrafts> {
  const named = list.some((d) => d["area"] !== undefined || d["project"] !== undefined);
  if (!named) return { list: [...list], groups: [], made: [] };
  let names: GroupNames;
  try {
    names = await readGroupNames(readerOf(call.space));
  } catch (error) {
    throw storageFailure(error);
  }
  const groups: Operation[] = [];
  const made: Made[] = [];
  const face = call.principal.origin;
  // The groups an earlier draft makes join the names, with the slugs the writer will give them, so
  // a later draft resolves them by the same rules as the space's own: one call answers as its
  // drafts sent one by one would.
  const areas = [...names.areas];
  const projects = [...names.projects];
  const working: GroupNames = { areas, projects, aliases: names.aliases };
  /** The areas the call makes. */
  const fresh = new Set<string>();
  const slugOf = (title: string, kind: "area" | "project"): string =>
    freeSlug(title, kind, (slug) =>
      (kind === "area" ? areas : projects).some((group) => group.slug === slug),
    );
  const resolved = list.map((draft, k) => {
    const at = path(k);
    const out = { ...draft };
    const area = draft["area"];
    if (typeof area === "string") {
      let id = resolveGroup(working, "area", area, `${at}.area`, { face });
      if (id === undefined) {
        const created = newId("a");
        fresh.add(created);
        areas.push({
          id: created,
          slug: slugOf(area.trim(), "area"),
          title: area.trim(),
          area: null,
        });
        groups.push({ kind: "area.create", id: created, title: area.trim() });
        made.push({ kind: "area", at: `${at}.area` });
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
        within !== undefined && fresh.has(within)
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
        made.push({ kind: "project", at: `${at}.project` });
        id = created;
      }
      out["project"] = id;
    }
    return out;
  });
  return { list: resolved, groups, made };
}

/** At most this many paths of the names that made a group, then how many more. */
const MADE_SHOWN = 5;

/**
 * The one warning for the groups a call's names made, whatever their number, so it fits the
 * answer, from the writer's result: a group that only drafts matching a task by key named is not
 * made (the writer leaves it out), and is not said. Its names go with the request (`answer`), so a
 * replay says the same. Not "<path>: ...": a draft that matched an existing task drops those, and
 * a group it named first may be made for a later draft. A project's name matched none in its area,
 * which another area may have. `at` is the index of the first group's result.
 */
function madeOf(result: WriteResult, at: number): string[] {
  const made = result.answer?.["made"];
  if (!Array.isArray(made)) return [];
  const created = (made as Made[]).filter((_, k) => result.results[at + k]?.status === "created");
  return madeWarning(
    created.filter((m) => m.kind === "area").map((m) => m.at),
    created.filter((m) => m.kind === "project").map((m) => m.at),
  );
}

function madeWarning(areas: readonly string[], projects: readonly string[]): string[] {
  const paths = [...areas, ...projects];
  if (paths.length === 0) return [];
  const count = (n: number, one: string) =>
    n === 0 ? [] : [`${String(n)} ${one}${n === 1 ? "" : "s"}`];
  const what = [...count(areas.length, "new area"), ...count(projects.length, "new project")];
  const more = paths.length - MADE_SHOWN;
  const at = `${paths.slice(0, MADE_SHOWN).join(", ")}${more > 0 ? ` and ${String(more)} more` : ""}`;
  return [
    `${MADE}${what.join(" and ")} for names that matched none (a project, none in its area): ${at}.`,
  ];
}

/** How the groups line starts, so an answer can put it first. */
const MADE = "Made ";

/**
 * The warnings with the groups line first: a cut takes from the end, and the line says what no
 * other warning does. A receipt of an earlier build holds it among its warnings, found by its start.
 */
const madeFirst = (warnings: readonly string[]): string[] => [
  ...warnings.filter((w) => w.startsWith(MADE)),
  ...warnings.filter((w) => !w.startsWith(MADE)),
];

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
 * same call, which it names by its path. They go with the request, so the receipt keeps them; a
 * draft that matched an existing task drops its warning in the answer (`draftWarnings`).
 */
async function duplicateWarnings(
  call: Call,
  list: readonly Record<string, unknown>[],
  agent: boolean,
): Promise<string[]> {
  if (list.length === 0) return [];
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

/** The list a session's first call gives: every skill, and the folders it did not read. */
const listFields = ({ skills, unread }: Catalog): Record<string, unknown> => ({
  skills: skills.map(skillRow),
  ...(unread === 0 ? {} : { skills_unread: unread }),
});

/** A skill as an answer lists it: its name, when to read it, and why the user's file is unused. */
function skillRow(skill: Skill): Record<string, unknown> {
  const file = skill.path === undefined ? "The user's file" : `The user's file ${skill.path}`;
  const problem =
    skill.problem === undefined
      ? undefined
      : skill.origin === "own"
        ? `${file} cannot be used: ${skill.problem}.`
        : `${file} is not used: ${skill.problem}. This is the default.`;
  return {
    name: skill.name,
    ...(skill.description === "" ? {} : { when: skill.description }),
    ...(problem === undefined ? {} : { problem }),
  };
}

// ---------------------------------------------------------------------------------------------
// The handlers

type Handler = (call: Call) => Promise<unknown>;

// ---------------------------------------------------------------------------------------------
// Answers: what a write did, from what it stored (A3 3.4.1)

/**
 * A write's answer, from what the write stored: the writer's result, with the record its handler
 * sent with the request (`submit`'s `answer`). One function per entry builds the first answer and
 * every retry, so what the write did is the same in both. Its `as_of` is the write's own
 * (WriteResult.as_of), in every answer: a caller hands it back as the base of its next write, which
 * is then refused if anything it has not seen changed since. Names and lists come from one read of
 * the space as it is when the answer is made (`now`), and may be newer than that.
 */
type Answer = (
  view: View,
  stored: WriteResult,
  earlier: Earlier | undefined,
) => Promise<Record<string, unknown>>;

/**
 * What stands in for the record of a receipt an earlier build wrote, which keeps none: the input
 * of a retry this build could compare with it, or else the operations its commit ran.
 */
interface Earlier {
  readonly input?: Readonly<Record<string, unknown>>;
  readonly ops?: readonly CommitOp[];
}

/** A read of the space as it is now, for an answer's names and lists: undefined when it fails. */
async function now<T>(
  view: View,
  read: (reader: WorkerConnection) => Promise<T>,
): Promise<T | undefined> {
  try {
    return await read(readerOf(view.space));
  } catch {
    return undefined;
  }
}

/** A draft's operations among a request's own results (ownResults): where each came from. */
interface Draft {
  /** Its input path, such as `tasks.0`. */
  readonly at: string;
  /** Its task.create. */
  readonly first: number;
  /** Its log.add. */
  readonly log?: number;
  /** Its source.add operations, with each source's input path. */
  readonly sources: ReadonlyMap<number, string>;
}

/**
 * The drafts at `prefix` (`tasks` or `follow_ups`), by the input path of each operation that the
 * record keeps (`paths`). A receipt of an earlier build keeps none: there a draft starts at a
 * task.create that made a task or matched one, its log is the one result that names an entry, and
 * its sources follow in their order.
 */
function draftsOf(result: WriteResult, prefix: string): Draft[] {
  const drafts: { at: string; first: number; log?: number; sources: Map<number, string> }[] = [];
  const paths = result.answer?.["paths"];
  if (Array.isArray(paths)) {
    const whole = new RegExp(`^${prefix}\\.[0-9]+$`, "u");
    paths.forEach((path: unknown, i) => {
      if (typeof path !== "string") return;
      if (whole.test(path)) drafts.push({ at: path, first: i, sources: new Map() });
      const draft = drafts.at(-1);
      if (draft === undefined) return;
      if (path === `${draft.at}.log`) draft.log = i;
      else if (path.startsWith(`${draft.at}.sources.`)) draft.sources.set(i, path);
    });
    return drafts;
  }
  for (const op of result.results) {
    if (isId(op.id, "t") && (op.status === "created" || op.matched_by !== undefined)) {
      drafts.push({ at: `${prefix}.${String(drafts.length)}`, first: op.i, sources: new Map() });
      continue;
    }
    const draft = drafts.at(-1);
    if (draft === undefined) continue;
    if (op.entry !== undefined) draft.log = op.i;
    else if (isId(op.id, "s")) {
      draft.sources.set(op.i, `${draft.at}.sources.${String(draft.sources.size)}`);
    }
  }
  return drafts;
}

/** Every source of the drafts, by its operation, with its input path. */
const sourcesOf = (drafts: readonly Draft[]): Map<number, string> =>
  new Map(drafts.flatMap((d) => [...d.sources]));

/**
 * What became of a draft's log entry (A1 3.6): added to a created task or to its one active match,
 * which the writer reports as created, unchanged when that task has it already, and left out
 * (existing) when several match or the match is finished. Left out, the answer must say so: this
 * request added it nowhere, and the caller may hold the only copy.
 */
function draftLog(result: WriteResult, draft: Draft): { log_added: boolean; log_left_out?: true } {
  if (draft.log === undefined) return { log_added: false };
  const status = opAt(result, draft.log).status;
  return {
    log_added: status === "created",
    ...(status === "existing" ? { log_left_out: true } : {}),
  };
}

/**
 * Each draft's row: what the writer did with it, and its task's title as it is now. A matched task
 * keeps its own title, and an echo of the draft's would hand a caller a title it never had.
 */
async function draftRows(
  view: View,
  result: WriteResult,
  drafts: readonly Draft[],
): Promise<Record<string, unknown>[]> {
  const outcomes = drafts.map((d) => draftOutcome(result, d.first));
  const ids = outcomes.flatMap((o) => (o.id === undefined ? [] : [o.id]));
  const titles = ids.length === 0 ? undefined : await now(view, (r) => readTitles(r, ids));
  return drafts.map((d, k) => {
    const outcome = outcomes[k] ?? draftOutcome(result, d.first);
    const title = titles?.get(outcome.id ?? "");
    return {
      ...outcome,
      ...(title === undefined ? {} : { title }),
      ...draftLog(result, d),
      ...heldOf(result, d.sources, d.at),
    };
  });
}

/**
 * The warnings of a request with drafts: the groups its names made, its sources', and what the
 * writer and the service's look before it found, without those of a draft that matched a task,
 * which took no folder and made no task. Each of those starts with the draft's path.
 */
function draftWarnings(
  stored: WriteResult,
  result: WriteResult,
  drafts: readonly Draft[],
  rows: readonly Record<string, unknown>[],
  groupsAt: number,
): string[] {
  const matched = drafts.filter((_, k) => rows[k]?.["result"] === "exists").map((d) => d.at);
  return madeFirst([
    ...madeOf(stored, groupsAt),
    ...sourceWarnings(result, sourcesOf(drafts)),
    ...result.warnings.filter(
      (w) => !matched.some((at) => w.startsWith(`${at}:`) || w.startsWith(`${at}.`)),
    ),
  ]);
}

const addAnswer: Answer = async (view, stored) => {
  const result = ownResults(stored);
  const drafts = draftsOf(result, "tasks");
  const rows = await draftRows(view, result, drafts);
  return {
    as_of: result.as_of,
    tasks: rows,
    warnings: draftWarnings(stored, result, drafts, rows, 0),
    ...replayed(stored),
  };
};

/** Every field an update can name, in its contract's order. */
const UPDATE_FIELDS = [
  ...Object.keys(TaskUpdateInput.shape.set.unwrap().shape),
  "context",
  "sources",
];

/**
 * The fields of `named`, in their order, that the request's operations changed: a task field by
 * the writer's result for it (OpResult.fields), `folder` and `sources` by an operation of theirs
 * that changed something. A receipt of an earlier build holds neither: its commit's history says
 * which fields it changed, whatever a retry names, and nothing is said when that read fails.
 */
async function changedOf(
  view: View,
  result: WriteResult,
  named: readonly string[],
): Promise<string[] | undefined> {
  const paths = result.answer?.["paths"];
  if (!Array.isArray(paths)) {
    const first = opAt(result, 0);
    const facts = await now(view, (r) => readCommit(r, first.task ?? first.id, result.seq));
    return facts === undefined ? undefined : changedFields(UPDATE_FIELDS, facts);
  }
  const changed = new Set<string>();
  for (const op of result.results) {
    if (op.status === "unchanged" || op.status === "existing") continue;
    const path = String(paths[op.i] ?? "");
    for (const field of op.fields ?? []) changed.add(field === "reviewed_at" ? "reviewed" : field);
    if (/^(?:add_sources|remove_sources|put_back_sources)/u.test(path)) changed.add("sources");
    if (path === "set.folder" || path === "clear") changed.add("folder");
  }
  return named.filter((field) => changed.has(field));
}

const updateAnswer: Answer = async (view, stored, earlier) => {
  const result = ownResults(stored);
  const updated = result.status === "applied";
  const record = stored.answer ?? {};
  const fields = updated ? await changedOf(view, result, strings(record["fields"])) : [];
  const paths = Array.isArray(record["paths"]) ? (record["paths"] as unknown[]) : [];
  const context = earlier?.input?.["context"];
  const appended = Array.isArray(record["paths"])
    ? result.results.some((op) => paths[op.i] === "context" && op.status === "updated")
    : earlier?.ops !== undefined
      ? earlier.ops.some((op) => op.op === "task.context_append")
      : isRecord(context) && context["mode"] === "append";
  const names = namesProjects(result) ? await now(view, readGroups) : undefined;
  const sources = new Map(
    paths.flatMap((path, i) =>
      typeof path === "string" && path.startsWith("add_sources.") ? [[i, path] as const] : [],
    ),
  );
  return {
    result: updated ? "updated" : "no_change",
    task: refOf(opAt(result, 0)),
    ...(fields === undefined ? {} : { fields }),
    ...(updated && fields?.includes("context") === true
      ? { context: appended ? ("appended" as const) : ("replaced" as const) }
      : {}),
    as_of: result.as_of,
    ...movedOf(result, names === undefined ? undefined : projectNames(names.projects)),
    warnings: madeFirst([
      ...madeOf(stored, 0),
      ...sourceWarnings(result, sources),
      ...result.warnings,
    ]),
    ...replayed(stored),
  };
};

const entryAnswer: Answer = (_view, stored, earlier) => {
  const done = opAt(stored, 0);
  const op = earlier?.ops?.[0];
  const kind =
    stored.answer?.["kind"] ??
    earlier?.input?.["kind"] ??
    (done.entry?.startsWith("n") === true
      ? "note"
      : op?.op === "log.add"
        ? (op.input["log_kind"] ?? "progress")
        : undefined);
  return Promise.resolve({
    result: "logged",
    task: refOf(done),
    entry: done.entry,
    ...(kind === undefined ? {} : { kind }),
    as_of: stored.as_of,
    ...replayed(stored),
  });
};

const noteAnswer: Answer = (_view, stored, earlier) => {
  const done = opAt(stored, 0);
  const action =
    stored.answer?.["action"] ??
    (earlier?.input !== undefined
      ? typeof earlier.input["remove"] === "string"
        ? "remove"
        : "put_back"
      : earlier?.ops?.[0] === undefined
        ? undefined
        : earlier.ops[0].op === "note.delete"
          ? "remove"
          : "put_back");
  const word =
    done.status !== "updated"
      ? "no_change"
      : action === "remove"
        ? "removed"
        : action === undefined
          ? undefined
          : "put_back";
  return Promise.resolve({
    ...(word === undefined ? {} : { result: word }),
    task: refOf(done),
    note: done.entry,
    as_of: stored.as_of,
    ...replayed(stored),
  });
};

const finishAnswer: Answer = async (view, stored) => {
  const result = ownResults(stored);
  const drafts = draftsOf(result, "follow_ups");
  // The task's own operations come first: its finish, and its wrap-up when the call gave one.
  const own = drafts[0]?.first ?? result.results.length;
  const done = opAt(result, 0);
  const wrap = own > 1 ? opAt(result, 1) : undefined;
  const changed = result.results.slice(0, own).some((op) => op.status !== "unchanged");
  // A receipt of an earlier build holds none of the task's state: its commit's history does.
  const facts =
    done.lifecycle === undefined
      ? await now(view, (r) => readCommit(r, done.task ?? done.id, result.seq))
      : undefined;
  const lifecycle = done.lifecycle ?? facts?.lifecycle;
  const wrapState = done.lifecycle === undefined ? facts?.wrapState : done.wrap_state;
  const learnings =
    result.status !== "applied"
      ? 0
      : done.lifecycle !== undefined
        ? (wrap?.learnings ?? 0)
        : facts?.changes.filter((c) => c.entity === "learnings" && c.field === null).length;
  const rows = await draftRows(view, result, drafts);
  const warnings = draftWarnings(stored, result, drafts, rows, own);
  return {
    result: changed ? "completed" : "no_change",
    task: refOf(done),
    ...(lifecycle === undefined ? {} : { lifecycle }),
    ...(wrapState === undefined ? {} : { wrap_state: wrapState }),
    ...(learnings === undefined ? {} : { learnings }),
    // A follow-up upserts by its source keys as task.add's drafts do (A3 3.4.5, 3.4.8).
    follow_ups: rows.map((row) => ({
      result: row["result"],
      ...(row["ref"] === undefined ? {} : { ref: row["ref"] }),
      ...(row["title"] === undefined ? {} : { title: row["title"] }),
      ...(row["result"] === "exists" ? { lifecycle: row["lifecycle"] } : {}),
      ...(row["ambiguous"] === undefined ? {} : { ambiguous: row["ambiguous"] }),
      log_added: row["log_added"],
      ...(row["log_left_out"] === undefined ? {} : { log_left_out: row["log_left_out"] }),
      ...(row["held"] === undefined ? {} : { held: row["held"] }),
    })),
    ...(warnings.length === 0 ? {} : { warnings }),
    as_of: result.as_of,
    ...replayed(stored),
  };
};

const reopenAnswer: Answer = async (view, stored) => {
  const done = opAt(stored, 0);
  // A receipt of an earlier build holds no status: its commit's history does.
  const status =
    done.status_key ??
    (await now(view, (r) => readCommit(r, done.task ?? done.id, stored.seq)))?.status;
  return {
    result: stored.status === "applied" ? "reopened" : "no_change",
    task: refOf(done),
    lifecycle: done.lifecycle ?? "active",
    ...(status === undefined ? {} : { status }),
    as_of: stored.as_of,
    ...replayed(stored),
  };
};

const deleteAnswer: Answer = (_view, stored) => {
  // A task named twice (its reference and its ID) is one task: the operation that moved it says
  // so, and the one that then found it moved says nothing.
  const moved = stored.results.filter((r) => r.status === "updated");
  const movedIds = new Set(moved.map((r) => r.id));
  const skipped = stored.results.filter((r) => r.status === "unchanged" && !movedIds.has(r.id));
  // A task of the change restored and moved to the Trash again since is there, with that later
  // change: not back already.
  const later = skipped.filter((r) => r.later === true);
  const already = skipped.filter((r) => r.later !== true);
  const refs = (list: readonly OpResult[]) => [...new Set(list.map(refOf))];
  // Where each restored task is back, by the names its commit found: the answer has no part read
  // later, so its as_of, the write's, dates them.
  const restored = moved.flatMap((op) =>
    op.back === undefined
      ? []
      : [
          {
            id: op.id,
            ref: refOf(op),
            ...op.back,
            ...(op.regrouped === undefined ? {} : { regrouped: op.regrouped }),
            ...(op.held_links === undefined ? {} : { held: op.held_links }),
          },
        ],
  );
  return Promise.resolve({
    // Only a restore that brought a task back says where it is back.
    result: moved.length === 0 ? "no_change" : restored.length > 0 ? "restored" : "moved",
    moved: refs(moved),
    ...(already.length === 0 ? {} : { already: refs(already) }),
    ...(later.length === 0 ? {} : { later: refs(later) }),
    ...(restored.length === 0 ? {} : { restored }),
    ...(stored.commit === undefined ? {} : { commit: stored.commit }),
    as_of: stored.as_of,
    ...replayed(stored),
  });
};

/**
 * An undo's or a redo's answer: the change it moved, the tasks its commit changed (the writer's
 * result; a receipt of an earlier build reads them from history, and leaves them out when that
 * read fails), and what a partial undo left as others set it.
 */
const historyAnswer: Answer = async (view, stored) => {
  const undo = view.entry.name === "history.undo";
  const word = !undo ? "redone" : stored.conflicts.length > 0 ? "partial" : "undone";
  const done = opAt(stored, 0);
  const tasks =
    done.tasks !== undefined
      ? { refs: done.tasks, count: done.task_count ?? done.tasks.length }
      : await now(view, (r) => readCommitTasks(r, stored.seq));
  // A3 3.7.4: a script of the same person (`cli-script` on this machine) writes as `script`, whose
  // changes are on no undo stack. When one changed the space after the change undone, the answer
  // names it, so the person knows this undo did not take it back. That is history between the two
  // changes: it is read here, never stored, and does not date the answer.
  const scripted = !undo
    ? undefined
    : await now(view, (reader) =>
        readScriptChange(reader, {
          scope: principalOf("cli-script", view.host.machine.id).scope,
          undone: done.id,
          seq: stored.seq,
        }),
      );
  return {
    result: word,
    commit: done.id,
    ...(tasks === undefined ? {} : { tasks: tasks.refs, task_count: tasks.count }),
    ...(stored.passed === undefined ? {} : { passed_over: stored.passed }),
    ...(stored.newer === undefined ? {} : newerWorkJson(stored.newer)),
    ...(word === "partial"
      ? {
          unresolved: stored.conflicts.map((c) => ({
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
    as_of: stored.as_of,
    ...replayed(stored),
    ...(scripted === undefined ? {} : { script_change: scripted }),
  };
};

/** A record's text field, or empty. */
const textOf = (value: unknown): string => (typeof value === "string" ? value : "");

/** The projects' names by ID, from a read of the groups. */
const projectNames = (projects: readonly Row[]): Names =>
  new Map(projects.map((p) => [String(p["id"]), String(p["title"])]));

/** A group as an answer names it now: its name, and a project's area, from one read. */
function groupNow(
  read: { readonly areas: readonly Row[]; readonly projects: readonly Row[] } | undefined,
  kind: "area" | "project",
  id: string,
): { name?: string; area?: Record<string, unknown> } {
  if (read === undefined) return {};
  const row = (kind === "area" ? read.areas : read.projects).find((g) => g["id"] === id);
  if (row === undefined) return {};
  const areaId = kind === "project" ? row["area_id"] : undefined;
  const area = typeof areaId === "string" ? read.areas.find((a) => a["id"] === areaId) : undefined;
  return {
    name: String(row["title"]),
    ...(area === undefined
      ? {}
      : {
          area: {
            id: String(area["id"]),
            name: String(area["title"]),
            ...(area["lifecycle"] === "archived" ? { archived: true } : {}),
          },
        }),
  };
}

/**
 * What organize's write did, from its record (`groupWrite`): the action, the word for what the
 * call decided (`exists`) or for a write that applied (`done`), the group by kind, ID and folder.
 * Its name and area, and the list, are read now, in one snapshot. A receipt of an earlier build
 * names the group by the result its last operation has, and its action by its input or commit.
 */
const groupAnswer: Answer = async (view, stored, earlier) => {
  const record = stored.answer ?? {};
  const action = textOf(
    record["action"] ?? earlier?.input?.["action"] ?? groupAction(earlier?.ops ?? []),
  );
  const changed = stored.status === "applied";
  const last = stored.results.at(-1)?.id ?? "";
  const written = (record["group"] ?? {
    kind: isId(last, "a") ? "area" : "project",
    id: isId(last, "a") || isId(last, "p") ? last : "",
  }) as { kind: "area" | "project"; id: string; folder?: string };
  const read = await now(view, (reader) => readGroupsHere(view, reader));
  const answer = {
    action,
    as_of: stored.as_of,
    result: record["result"] ?? (changed ? (record["done"] ?? GROUP_DONE[action]) : "no_change"),
    group: { ...written, ...groupNow(read, written.kind, written.id) },
    ...movedOf(stored, read === undefined ? undefined : projectNames(read.projects)),
    ...replayed(stored),
  };
  // A write whose list could not be read leaves it out: never part of it shown as whole.
  return {
    ...(read === undefined
      ? {}
      : groupList(read, listScope(view.caller, record["archived"] === true, answer))),
    ...answer,
  };
};

/**
 * What folder.manage's write did, from its record: the action, the owner by kind and ID, the
 * folder it set, or the project that has it already (`exists`). A project's name and area are
 * read now. A receipt of an earlier build names the owner by its results, and the rest by its
 * input or its commit.
 */
const folderAnswer: Answer = async (view, stored, earlier) => {
  const record = stored.answer ?? {};
  const shown = earlier?.ops === undefined ? undefined : folderOps(earlier.ops);
  const action = textOf(record["action"] ?? earlier?.input?.["action"] ?? shown?.action);
  const changed = stored.status === "applied";
  const read = await now(view, readGroups);
  const dated = { as_of: stored.as_of };
  const holder = record["exists"] as { id: string; folder: string } | undefined;
  if (holder !== undefined) {
    return {
      action,
      result: "exists",
      owner: { kind: "project", id: holder.id, ...groupNow(read, "project", holder.id) },
      folder: holder.folder,
      ...dated,
      ...replayed(stored),
    };
  }
  const folder = record["folder"] ?? earlierFolder(view, earlier?.input) ?? shown?.folder;
  if (action === "add_project") {
    const project = stored.results.find((r) => isId(r.id, "p"))?.id ?? "";
    return {
      action,
      result: changed ? "created" : "no_change",
      owner: { kind: "project", id: project, ...groupNow(read, "project", project) },
      ...(typeof folder === "string" ? { folder } : {}),
      ...dated,
      ...replayed(stored),
    };
  }
  const done = stored.results[0];
  const owner = record["owner"] as { kind: "project" | "task"; id: string } | undefined;
  const task = shown?.task ?? earlier?.input?.["task"] !== undefined;
  const kind = owner?.kind ?? (task ? "task" : "project");
  const id =
    kind === "task"
      ? (done?.task ?? "")
      : (owner?.id ?? (isId(done?.id ?? "", "p") ? String(done?.id) : ""));
  return {
    action,
    result: changed ? (action === "set" ? "set" : "cleared") : "no_change",
    owner: {
      kind,
      id,
      ...(kind === "project" ? pickName(groupNow(read, "project", id)) : {}),
      ...(done?.ref === undefined ? {} : { ref: done.ref }),
    },
    ...(action === "set" && typeof folder === "string" ? { folder } : {}),
    ...movedOf(stored, read === undefined ? undefined : projectNames(read.projects)),
    ...dated,
    ...replayed(stored),
  };
};

const pickName = ({ name }: { name?: string }): { name?: string } =>
  name === undefined ? {} : { name };

/** What an earlier build's folder.manage commit did, by its operations. */
function folderOps(ops: readonly CommitOp[]): { action: string; task: boolean; folder?: string } {
  const set = ops.find((op) => op.op.endsWith(".folder_set"));
  const path = set?.input["path"];
  return {
    action: ops.some((op) => op.op === "project.create")
      ? "add_project"
      : set === undefined
        ? "clear"
        : "set",
    task: ops.some((op) => op.op.startsWith("task.")),
    ...(typeof path === "string" ? { folder: path } : {}),
  };
}

/**
 * An earlier build's organize action, by the operations its commit ran: the first of these that
 * one of them is. A move may create its area, and a create may set the new project's folder.
 */
const GROUP_OPS: readonly (readonly [string, string])[] = [
  [".move", "move"],
  [".patch", "rename"],
  [".unarchive", "unarchive"],
  [".archive", "archive"],
  [".create", "create"],
  [".folder_set", "set_folder"],
  [".folder_clear", "clear_folder"],
];

const groupAction = (ops: readonly CommitOp[]): string | undefined =>
  GROUP_OPS.find(([kind]) => ops.some((op) => op.op.endsWith(kind)))?.[1];

/** The folder an earlier build's request named, as stored: its receipt keeps no record. */
function earlierFolder(
  view: View,
  input: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const given = input?.["folder"];
  if (typeof given !== "string" || view.host.home === undefined) return undefined;
  const form = storedForm(given, view.host.home, view.host.platform ?? process.platform);
  return typeof form === "string" ? undefined : form.stored;
}

/**
 * What a preference set did, from its record: each key from the value it had to the one it set,
 * where the writer changed it. The keys as they are now are read when the answer is made.
 */
const prefsAnswer: Answer = async (view, stored) => {
  const sets = stored.answer?.["changed"] as { key: string }[] | undefined;
  const keys = new Set(sets?.map((s) => s.key) ?? stored.results.map((r) => r.id));
  const read = await now(view, readSpacePreferences);
  const asked = TOOL_PREFERENCES.filter((p) => keys.has(p.key));
  return {
    action: "set",
    as_of: stored.as_of,
    ...(read === undefined
      ? {}
      : {
          prefs: asked.map((p) => prefRow(p, "get", read.reads.get(p.key), view.principal)),
        }),
    result: stored.status === "applied" ? "updated" : "no_change",
    ...(sets === undefined
      ? {}
      : { changed: sets.filter((_, k) => stored.results[k]?.status !== "unchanged") }),
    ...replayed(stored),
  };
};

const ANSWERS: Readonly<Record<string, Answer>> = {
  "task.add": addAnswer,
  "task.update": updateAnswer,
  "entry.add": entryAnswer,
  "note.remove": noteAnswer,
  "task.finish": finishAnswer,
  "task.reopen": reopenAnswer,
  "task.delete": deleteAnswer,
  "history.undo": historyAnswer,
  "history.redo": historyAnswer,
  "group.manage": groupAnswer,
  "folder.manage": folderAnswer,
  "prefs.manage": prefsAnswer,
};

/** Each operation's input path, for the request's record: where a draft's answer finds it. */
const pathsOf = (ops: readonly Operation[], pathOf: PathOf): string[] =>
  ops.map((_, i) => pathOf(i, undefined) ?? "");

/** Where an update's operation comes from in its input, for the request's record. */
function updatePath(op: Operation, source: string | undefined): string {
  switch (op.kind) {
    case "task.context_append":
      return "context";
    case "task.move":
      return "set.area";
    case "source.add":
      return source ?? "add_sources";
    case "source.unlink":
      return "remove_sources";
    case "source.relink":
      return "put_back_sources";
    case "task.folder_set":
      return "set.folder";
    case "task.folder_clear":
      return "clear";
    default:
      return "set";
  }
}

/** A write's answer: the entry's own (ANSWERS), from the result the writer gave the call. */
function answerOf(call: Call, stored: WriteResult): Promise<Record<string, unknown>> {
  const answer = ANSWERS[call.entry.name];
  if (answer === undefined) throw opUnknown();
  return answer(call, stored, undefined);
}

const HANDLERS: Readonly<Record<string, Handler>> = {
  "space.status": async (call) => {
    const { input } = call;
    const asked = Array.isArray(input["skills"]) ? [...new Set(input["skills"] as string[])] : [];
    const reader = readerOf(call.space);
    const now = (call.host.now ?? Date.now)();
    // Skills asked for come instead of the overview: no sections, no `here`.
    const reading = asked.length > 0;
    const include =
      !reading && Array.isArray(input["include"]) ? (input["include"] as string[]) : [];
    const cwd = !reading && typeof input["cwd"] === "string" ? input["cwd"] : undefined;
    // Null: a cwd that relates to no folder here, so no task matches it.
    const found = cwd === undefined ? undefined : ((await hereFor(call, cwd)) ?? null);
    const boundTask = sessionIn(call)?.task;
    const status = await readStatus(reader, {
      clock: { today: call.today, now, timeZone: (call.host.timeZone ?? localTimeZone)() },
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
        : call.host.sessions?.live(status.space.id, call.space.copy);
    let skillFields: Record<string, unknown>;
    if (reading) {
      // Only the files asked for are read.
      const [space, read] = await Promise.all([
        readTaskKeys(reader).then((keys) => ({ sizes: keys.effort.map((key) => ({ key })) })),
        readSkills(call.host.skillsFolder, asked),
      ]);
      skillFields = {
        asked: read.skills.map((skill) => {
          const text = servedText(skill, space);
          return { ...skillRow(skill), ...(text === undefined ? {} : { text }) };
        }),
        ...(read.missing.length === 0 ? {} : { missing: read.missing }),
      };
    } else {
      skillFields = listFields(await listSkills(call.host.skillsFolder));
    }
    return {
      as_of: status.space.asOf,
      date: call.today,
      time_zone: (call.host.timeZone ?? localTimeZone)(),
      autonomy: AUTONOMY_IN_FORCE,
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
      ...skillFields,
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
    // A task in the Trash reads as it is, marked so: an agent that gets not_found would add it again.
    const read = await readTask(reader, task, {
      machine,
      ...ranges,
      ...(named === undefined ? {} : { named }),
      trash: true,
      // The notes the person took back are theirs to read and put back, never an agent's.
      removed: sections.length === 0 && call.principal.audience === "user",
    });
    const notes = named === undefined ? {} : { notes: read.named.map(noteOf) };
    const removed = read.removedNotes.map(noteOf);
    // The connection is this task's session: its later calls need no task.
    const bound = sessionIn(call)?.task === String(read.row["id"]);
    // What the person asked this launch's agent to do: the note the launch names. The launch named
    // a note of the person's, so one not read now was taken back.
    const asked = launch?.request;
    let request: Record<string, unknown> | undefined;
    if (asked !== undefined) {
      let body: string | undefined;
      try {
        body = await readPersonsNote(reader, String(read.row["id"]), asked);
      } catch (error) {
        throw storageFailure(error);
      }
      request =
        body === undefined ? { note: asked, removed: true } : { note: asked, ...requestText(body) };
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
        ...(removed.length === 0 ? {} : { removed_notes: removed }),
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
    // A read by launch is a session's first call: it lists the skills, as status does.
    if (launch !== undefined) {
      Object.assign(answer, listFields(await listSkills(call.host.skillsFolder)));
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
    const sourcePaths = new Map<number, string>();
    list.forEach((draft, k) => {
      ops.push(...draftOps(call, draft, ids[k] as Id<"t">, at(k), ops.length, sourcePaths, agent));
    });
    const duplicates = await duplicateWarnings(call, list, agent);
    ops.push(...folders.ops);
    // The folders' and the possible duplicates' warnings go with the request: the writer keeps
    // them with the result. New groups first, so the drafts can name them; the drafts' results
    // are read without them.
    const pathOf = draftPathOf(ops, ids, at, sourcePaths);
    const submitted = await submit(call, [...named.groups, ...ops], {
      warnings: [...duplicates, ...folders.warnings],
      answer: { made: named.made, paths: pathsOf(ops, pathOf) },
      inserted: { at: 0, count: named.groups.length },
      pathOf,
    });
    await markersAfter(call, ops, ownResults(submitted));
    return answerOf(call, submitted);
  },

  "task.update": async (call) => {
    const { input, today } = call;
    const task = await taskOf(call);
    const ops: Operation[] = [];
    /** The groups a new area or project name creates, before the task moves into them. */
    const groups: Operation[] = [];
    const made: Made[] = [];
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
    // A dismissal's mark comes from this read, which is the base of a request that only dismisses.
    let readBase: string | undefined;
    const reviewed = set["reviewed"];
    if (typeof reviewed === "string") {
      let read: Awaited<ReturnType<typeof readReviewedMark>>;
      try {
        read = await readReviewedMark(readerOf(call.space), task, reviewed);
      } catch (error) {
        throw storageFailure(error);
      }
      if (read.mark === undefined) {
        throw invalid("set.reviewed", "No question of this task has this entry");
      }
      values["reviewed_at"] = read.mark;
      readBase = read.asOf;
    }
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
    const detach = strings(input["remove_sources"]);
    const putBack = strings(input["put_back_sources"]);
    /** The task's links, live and detached: what the names name, and a refusal's keys. */
    let links: Row[] = [];
    let linkTask: Id<"t"> | undefined;
    if (detach.length > 0 || putBack.length > 0) {
      try {
        links = await readTaskLinks(readerOf(call.space), task);
      } catch (error) {
        throw storageFailure(error);
      }
      const [first] = links;
      if (first !== undefined) linkTask = text(first["task_id"]) as Id<"t">;
      const detached = linksNamed(links, detach, "remove_sources");
      const back = linksNamed(links, putBack, "put_back_sources");
      const both = back.findIndex((b) => detached.some((d) => d.source === b.source));
      if (both >= 0) {
        throw invalid(
          `put_back_sources.${String(both)}`,
          "Detach a source or put it back, not both",
        );
      }
      // Without a base, each change is checked against the link's version as read just now.
      const based = typeof input["base"] === "string";
      const versioned = (link: NamedLink) =>
        based || link.version === undefined ? {} : { link_version: link.version };
      for (const link of detached) {
        ops.push({ kind: "source.unlink", task, source: link.source, ...versioned(link) });
      }
      for (const link of back) {
        ops.push({ kind: "source.relink", task, source: link.source, ...versioned(link) });
      }
    }
    // The folder is a row of its own, after the task's other operations.
    const folder = set["folder"];
    let move = NO_MOVE;
    if (typeof folder === "string") {
      const facts = bindFacts(call);
      const checked = await taskFolder(call, folder, "set.folder", facts);
      move = await folderMove(call, facts, { kind: "task", id: task }, checked);
      ops.push({ kind: "task.folder_set", task, path: checked.stored, ...carryOf(move) });
    }
    const cleared = clearFolder ? await clearedOf(call, { kind: "task", id: task }) : undefined;
    if (clearFolder) ops.push({ kind: "task.folder_clear", task });
    fields.push(...Object.keys(set), ...clear);
    if (context !== undefined) fields.push("context");
    if (added.length > 0 || detach.length > 0 || putBack.length > 0) fields.push("sources");
    if (ops.length === 0) throw invalid("set", "Nothing to change");
    // update_task changes an active task (A3 3.4.6): the writer refuses a completed or archived
    // one with TASK_NOT_ACTIVE (wrong_tool), in the request's transaction. A
    // request that only detaches or puts back sources also corrects a finished task, which still
    // catches captures of its sources for a while, and a dismissal of its questions sets aside
    // what waits for the person whatever became of the task.
    const anyLifecycle = ops.every(
      (op) =>
        op.kind === "source.unlink" ||
        op.kind === "source.relink" ||
        (op.kind === "task.patch" &&
          op.unset === undefined &&
          Object.keys(op.set ?? {}).every((field) => field === "reviewed_at")),
    );
    // Any other field in the request keeps its own check against the base the caller read.
    const dismissOnly = ops.every(
      (op) => op.kind === "task.patch" && Object.keys(op.set ?? {}).join() === "reviewed_at",
    );
    let submitted: WriteResult;
    try {
      submitted = await submit(call, [...groups, ...ops], {
        active: !anyLifecycle,
        ...(readBase === undefined || !dismissOnly ? {} : { base: readBase }),
        inserted: { at: 0, count: groups.length },
        answer: {
          ...stayedOf(move),
          made,
          fields: [...new Set(fields)],
          paths: ops.map((op, i) => updatePath(op, sourcePaths.get(i))),
        },
        pathOf: (i, field) =>
          ops[i]?.kind === "task.patch" && field !== undefined && /^[a-z_]+$/u.test(field)
            ? `set.${field}`
            : undefined,
      });
    } catch (error) {
      throw keyHeld(error, linkTask, links) ?? error;
    }
    await markersAfter(call, ops, ownResults(submitted), { cleared });
    return answerOf(call, submitted);
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
    return answerOf(call, await submit(call, [op], { answer: { kind } }));
  },

  "note.remove": async (call) => {
    const { input } = call;
    const remove = typeof input["remove"] === "string" ? input["remove"] : undefined;
    const putBack = typeof input["put_back"] === "string" ? input["put_back"] : undefined;
    const given = remove ?? putBack;
    if (given === undefined || (remove !== undefined && putBack !== undefined)) {
      throw invalid(
        remove === undefined ? "remove" : "put_back",
        "Name one note: to remove, or to put back",
        "Pass remove or put_back with the note's number, such as 3.",
      );
    }
    const ordinal = Number(given.replace(/^n/u, ""));
    const kind = remove === undefined ? "note.restore" : "note.delete";
    const result = await submit(call, [{ kind, task: String(input["task"]), ordinal }], {
      answer: { action: remove === undefined ? "put_back" : "remove" },
    });
    return answerOf(call, result);
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
    follow.forEach((draft, k) => {
      ops.push(...draftOps(call, draft, ids[k] as Id<"t">, at(k), ops.length, sourcePaths, agent));
    });
    ops.push(...folders.ops);
    // New groups after the task's own operations, so its wrap-up keeps its index, and before the
    // follow-ups that name them; the results are read without them.
    const groups = named.groups;
    const sent = [...ops.slice(0, own), ...groups, ...ops.slice(own)];
    const pathOf = draftPathOf(ops, ids, at, sourcePaths);
    const submitted = await submit(call, sent, {
      ...(own > 1 ? { wrapUp: 1 } : {}),
      inserted: { at: own, count: groups.length },
      warnings: folders.warnings,
      answer: { made: named.made, paths: pathsOf(ops, pathOf) },
      pathOf,
    });
    await markersAfter(call, ops, ownResults(submitted));
    return answerOf(call, submitted);
  },

  "task.reopen": async (call) => {
    const { input } = call;
    const task = await taskOf(call);
    const reason = input["reason"];
    const result = await submit(call, [
      { kind: "task.reopen", task, ...(typeof reason === "string" ? { reason } : {}) },
    ]);
    return answerOf(call, result);
  },

  "task.delete": async (call) => {
    const { input } = call;
    const restore = input["restore"] === true;
    const change = typeof input["change"] === "string" ? input["change"] : undefined;
    // A task named twice is one task: the answer never calls it both moved and there already.
    const named = Array.isArray(input["tasks"]) ? [...new Set(input["tasks"] as string[])] : [];
    if (change !== undefined && !restore) {
      throw invalid(
        "change",
        "A change is named to restore it",
        "Pass restore, or leave out change.",
      );
    }
    if (change !== undefined && named.length > 0) {
      throw invalid("tasks", "Pass tasks or change, not both");
    }
    if (change === undefined && named.length === 0) {
      throw invalid("tasks", "Name the tasks", restore ? "Pass tasks, or change." : "Pass tasks.");
    }
    let ops: Operation[];
    if (change === undefined) {
      ops = named.map((task) => ({ kind: restore ? "task.restore" : "task.delete", task }));
    } else {
      // Every task the change moved, whether still there or not: the writer restores those whose
      // tombstone it still holds and names the rest, so the answer says how many were back.
      let found;
      try {
        found = await readChangeTasks(readerOf(call.space), change);
      } catch (error) {
        throw storageFailure(error);
      }
      if (found === undefined) throw changeGone();
      // A change that moved nothing there (a restore, an edit) has nothing to bring back.
      if (found.tasks.length === 0) {
        throw invalid(
          "change",
          "This change moved nothing to the Trash, so nothing was restored",
          "The Trash shows what is there now, with each change's ID.",
        );
      }
      ops = found.tasks.map((task) => ({ kind: "task.restore", task, change: change as Id<"op"> }));
    }
    return answerOf(call, await submit(call, ops));
  },

  "task.trash": async (call) => {
    const { input, host } = call;
    let after: { seq: number; ref: number } | undefined;
    const cursor = input["cursor"];
    if (cursor !== undefined) {
      if (typeof cursor !== "string" || !TRASH_CURSOR.test(cursor)) {
        throw invalid("cursor", "Not a cursor this read gave", "Read from the start again.");
      }
      const dot = cursor.indexOf(".");
      after = { seq: Number(cursor.slice(0, dot)), ref: Number(cursor.slice(dot + 1)) };
    }
    const q = typeof input["q"] === "string" ? input["q"].trim() : "";
    // Title words, all of them, or a reference: its task by number, with this space's prefix.
    const ref = /^(?:([A-Za-z]{1,6})-)?([1-9][0-9]{0,9})$/u.exec(q);
    const words = q === "" ? [] : q.toLowerCase().split(/\s+/u);
    let read;
    try {
      read = await readTrash(
        readerOf(call.space),
        {
          words,
          ref: ref === null ? undefined : Number(ref[2]),
          prefix: ref?.[1]?.toUpperCase(),
          working: input["working"] === true,
          ...(Array.isArray(input["tasks"]) ? { tasks: input["tasks"] as string[] } : {}),
          limit: Number(input["limit"]),
          after,
        },
        {
          machine: host.machine.id,
          home: host.home,
          platform: host.platform ?? process.platform,
        },
      );
    } catch (error) {
      throw storageFailure(error);
    }
    const last = read.entries[read.entries.length - 1];
    return {
      rows: read.entries.map((entry) => ({
        ...entry.row,
        ...(entry.area === undefined ? {} : { area: entry.area }),
        ...(entry.project === undefined ? {} : { project: entry.project }),
        ...(entry.terminals === 0 ? {} : { terminals: entry.terminals }),
        removed: entry.removed,
      })),
      ...(read.more && last !== undefined
        ? { cursor: `${String(last.seq)}.${String(last.ref)}` }
        : {}),
    };
  },

  "launch.open": async (call) => {
    const { input, host } = call;
    const launches = host.launches;
    if (launches === undefined) {
      throw new AppError({ code: "internal", message: "This service opens no tasks." });
    }
    // A launch writes launch records: the space must be open for writing on this machine.
    const writer = writerOf(call.space);
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
        writer,
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
        // It goes into the copy the click was checked against, or nowhere.
        saveNote: async (body, forAgents) => {
          const principal = { ...call.principal, scope: `launch-note:${host.machine.id}` };
          const copy = call.space.copy === undefined ? {} : { copy: call.space.copy };
          const saved = (await opCall(
            host,
            { ...call.caller, principal, ...copy },
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
    return answerOf(call, await submit(call, [op], { undoable: false }));
  },

  "history.redo": async (call) => {
    const result = await submit(call, [{ kind: "redo", ...namedCommit(call.input) }], {
      undoable: false,
      // A redo is all or nothing (A1 3.10.1): the remedy is a new edit, never a partial form.
      hints: { UNDO_CONFLICT: "Keep their change, or set the value again yourself." },
    });
    return answerOf(call, result);
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
          [...(host.sessions?.live(space, call.space.copy) ?? new Map<string, number>())]
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
          "Pass base: the as_of of the answer that last listed the group.",
        );
      }
      if (input["cursor"] !== undefined) throw invalid("cursor", "Only a list takes a cursor");
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
    // `path` narrows the list to the group it names, archived or not: an area with its projects,
    // or one project.
    const only = names === undefined ? undefined : namedGroup(names, groupPath(input));
    const cursor = input["cursor"];
    return groupList(read, {
      ...listScope(call.caller, input["archived"] === true),
      ...(only === undefined ? {} : { only }),
      ...(typeof cursor === "string" ? { after: placeOf(cursor, read.space.id) } : {}),
    });
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
    if (action === "set") return prefsSet(call);
    const declared = prefsAsked(
      input["keys"],
      call.principal.audience === "agent" ? AGENT_PREFERENCES : TOOL_PREFERENCES,
    );
    let read;
    try {
      read = await readSpacePreferences(readerOf(call.space));
    } catch (error) {
      throw storageFailure(error);
    }
    return {
      action,
      as_of: read.space.asOf,
      prefs: declared.map((p) => prefRow(p, action, read.reads.get(p.key), call.principal)),
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
    const read = await bindRead(call, "project", projectId);
    const { taken } = await projectFolderChecked(facts, projectId, folder, read);
    // A folder another live project has here: that project, rather than a second one for it. The
    // request writes nothing, and its receipt keeps the project the call found.
    if (taken !== undefined) {
      const exists = { id: taken.project, folder: taken.stored };
      return answerOf(call, await submit(call, [], { answer: { action, exists } }));
    }
    const ops: Operation[] = [];
    let area: string | undefined;
    if (typeof input["area"] === "string") {
      area = resolveGroup(names, "area", input["area"], "area", { face: call.principal.origin });
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
    const result = await submit(call, ops, { answer: { action, folder: folder.stored } });
    await markersAfter(call, ops, result);
    return answerOf(call, result);
  }

  // set or clear, on a project or a task. The writer resolves a task's reference.
  const owner: { kind: "project" | "task"; id: string } =
    typeof input["project"] === "string"
      ? { kind: "project", id: projectNamed(names, input["project"]).id }
      : { kind: "task", id: String(input["task"]) };
  let move = NO_MOVE;
  if (action === "set") {
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
  const carry = carryOf(move);
  const op: Operation =
    action === "set"
      ? owner.kind === "project"
        ? { kind: "project.folder_set", project: owner.id, path: must(stored).stored, ...carry }
        : { kind: "task.folder_set", task: owner.id, path: must(stored).stored, ...carry }
      : owner.kind === "project"
        ? { kind: "project.folder_clear", project: owner.id }
        : { kind: "task.folder_clear", task: owner.id };
  const cleared = action === "clear" ? await clearedOf(call, owner) : undefined;
  const result = await submit(call, [op], {
    answer: {
      action,
      owner,
      ...(action === "set" ? { folder: must(stored).stored } : {}),
      ...stayedOf(move),
    },
  });
  await markersAfter(call, [op], result, { cleared });
  return answerOf(call, result);
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

/**
 * The group a call names by its path: `Area` or `Area/Project`, by name or ID, or a project's ID
 * alone, which names one without an area or with a slash in its name too.
 */
type GroupPath =
  | { readonly area: string; readonly project: string | undefined }
  | { readonly area?: undefined; readonly project: string };

function groupPath(input: Record<string, unknown>): GroupPath {
  const whole = String(input["path"]).trim();
  if (isId(whole, "p")) return { project: whole };
  const parts = whole.split("/").map((part) => part.trim());
  const [area = "", project, ...more] = parts;
  if (area === "" || more.length > 0 || project === "") {
    throw invalid("path", "Expected Area or Area/Project", "Name the area, or the area/project.");
  }
  return { area, project };
}

/**
 * The group a path names, archived or not: its area, and the project when it names one. It only
 * looks the group up (groups.ts), so an unknown one is not_found.
 */
function namedGroup(
  names: GroupNames,
  path: GroupPath,
): { readonly area: string | undefined; readonly project: string | undefined } {
  const look = (kind: "area" | "project", name: string, area?: string) =>
    resolveGroup(names, kind, name, "path", { lookup: true, area }) ?? "";
  const area = path.area === undefined ? undefined : look("area", path.area);
  if (path.project === undefined) return { area, project: undefined };
  const project = look("project", path.project, area);
  return { area: area ?? names.projects.find((p) => p.id === project)?.area ?? undefined, project };
}

/** The list a call reads: archived groups when it asks, and a page its face shows whole. */
function listScope(
  caller: Caller,
  archived: boolean,
  extra: Record<string, unknown> = {},
): ListScope {
  const { shows } = caller;
  return {
    archived,
    ...(shows === undefined
      ? {}
      : { shows: (page: Record<string, unknown>) => shows("group.manage", { ...page, ...extra }) }),
  };
}

/** The group a write changed, as its record keeps it: its name and area are read when answered. */
interface WrittenGroup {
  readonly kind: "area" | "project";
  readonly id: string;
  readonly folder?: string;
}

/**
 * organize's writes (A3 3.4.10): create an area, or a project in an area (a new area too), with
 * its folder here; rename, move a project to another area, archive and unarchive; set and clear a
 * project's folder here. A name resolves as a draft's does (groups.ts): a name close to another is
 * refused with the close ones, a group that exists is `no_change` for create. A project created
 * with a folder another project has answers `exists` with that project, and writes nothing. The
 * answer (`groupAnswer`) lists the groups as they are when it is made.
 */
async function groupWrite(call: Call, action: string): Promise<unknown> {
  const { input } = call;
  let path = groupPath(input);
  /** What the answer is built from besides the writer's result. */
  const record = (said: Record<string, unknown>) => ({
    action,
    ...said,
    ...(input["archived"] === true ? { archived: true } : {}),
  });
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
  let names: GroupNames;
  try {
    names = await readGroupNames(readerOf(call.space));
  } catch (error) {
    throw storageFailure(error);
  }
  const ops: Operation[] = [];
  let group: WrittenGroup;
  let done = GROUP_DONE[action] ?? "no_change";
  let move = NO_MOVE;
  let cleared: Cleared | undefined;
  if (action === "create") {
    if (path.area === undefined) {
      throw invalid(
        "path",
        "A new group takes a name, not an ID",
        "This ID names a project that exists. To make another, give its name as Area/Project.",
      );
    }
    // The group created is created as named; an area named only to hold it keeps the typo check.
    let area = resolveGroup(names, "area", path.area, "path", {
      create: path.project === undefined,
      face: call.principal.origin,
    });
    if (area === undefined) {
      area = newId("a");
      ops.push({ kind: "area.create", id: area as Id<"a">, title: path.area });
    }
    group = { kind: "area", id: area };
    if (path.project !== undefined) {
      const fresh = ops.length > 0;
      let project = fresh
        ? undefined
        : resolveGroup(names, "project", path.project, "path", { area, create: true });
      const exists = project !== undefined;
      if (project === undefined) {
        project = newId("p");
        ops.push({ kind: "project.create", id: project as Id<"p">, title: path.project, area });
        group = { kind: "project", id: project };
      } else group = { kind: "project", id: project };
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
            const holder: WrittenGroup = {
              kind: "project",
              id: taken.project,
              folder: taken.stored,
            };
            const said = record({ result: "exists", group: holder });
            return answerOf(call, await submit(call, [], { answer: said }));
          }
          ops.push({ kind: "project.folder_set", project, path: folder.stored });
          group = { ...group, folder: folder.stored };
          if (exists) done = "folder_set";
        }
      }
    }
  } else {
    const named = namedGroup(names, path);
    const kind = named.project === undefined ? "area" : "project";
    const id = named.project ?? named.area ?? "";
    group = { kind, id };
    if (action === "rename") {
      const title = to ?? "";
      ops.push(
        kind === "area"
          ? { kind: "area.patch", area: id, set: { title } }
          : { kind: "project.patch", project: id, set: { title } },
      );
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
        ...carryOf(move),
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
  // A group that exists already changes nothing, and its receipt is kept all the same: a retry
  // after an undo removed the group says so again, and brings nothing back.
  const result = await submit(call, ops, {
    answer: record({ done, group, ...stayedOf(move) }),
  });
  await markersAfter(call, ops, result, { cleared });
  return answerOf(call, result);
}

/** The space's areas and projects, and the projects' folders on this machine. */
interface GroupsHere extends Awaited<ReturnType<typeof readGroups>> {
  /** A project's folder here, and the name of the repository it holds, by the project's ID. */
  readonly folders: ReadonlyMap<string, { readonly stored: string; readonly repo?: string }>;
}

/**
 * The groups as organize lists them, with the projects' folders here, in one snapshot (read.ts
 * readGroupsAt), and the repository in each folder.
 */
async function readGroupsHere(view: View, reader: WorkerConnection): Promise<GroupsHere> {
  const read = await readGroupsAt(reader, view.host.machine.id);
  const { folders } = read;
  const platform = view.host.platform ?? process.platform;
  const repos = await Promise.all(
    folders.map((f) => {
      const open = openPath(f.stored, view.host.home, platform);
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

/** Which groups an organize list holds, and where its page starts. */
interface ListScope {
  /** Archived groups too. */
  readonly archived: boolean;
  /** One area with its projects; with `project`, that project alone under its area, if any. */
  readonly only?: { readonly area?: string | undefined; readonly project?: string | undefined };
  /** The place in the list's order after which the page starts: the cursor of the page before. */
  readonly after?: Place;
  /** Whether the caller's face shows a page whole (Caller.shows): a page holds what it shows. */
  readonly shows?: ((page: Record<string, unknown>) => boolean) | undefined;
}

/**
 * A place in the list's order: an area's position and ID, or none for the projects without an
 * area, which come after every area; then a project's position and ID, or none for the area
 * itself, which comes before its projects.
 */
interface Place {
  readonly area?: readonly [string, string];
  readonly project?: readonly [string, string];
}

const comparePair = (a: readonly [string, string], b: readonly [string, string]): number =>
  a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;

function comparePlaces(a: Place, b: Place): number {
  if (a.area === undefined || b.area === undefined) {
    if (a.area !== b.area) return a.area === undefined ? 1 : -1;
  } else {
    const area = comparePair(a.area, b.area);
    if (area !== 0) return area;
  }
  if (a.project === undefined || b.project === undefined) {
    return a.project === b.project ? 0 : a.project === undefined ? -1 : 1;
  }
  return comparePair(a.project, b.project);
}

/**
 * A place in a space's list as a cursor: the space's ID, `<position>.<area ID>` or `~`, then
 * `.<position>.<project ID>`.
 */
const cursorOf = (space: string, place: Place): string =>
  [space, ...(place.area ?? ["~"]), ...(place.project ?? [])].join(".");

/** The place a cursor names in the list of `space`, whose list gave it. */
function placeOf(cursor: string, space: string): Place {
  if (!GROUP_CURSOR.test(cursor)) {
    throw invalid("cursor", "The cursor is damaged", "Start the list again without a cursor.");
  }
  const [from, ...parts] = cursor.split(".");
  if (from !== space) {
    throw invalid(
      "cursor",
      "The cursor is from another space's list",
      "Start the list again without a cursor, or pass it with the space it came from.",
    );
  }
  const loose = parts[0] === "~";
  const area = loose ? undefined : ([parts[0] ?? "", parts[1] ?? ""] as const);
  const project = parts.slice(loose ? 1 : 2);
  return {
    ...(area === undefined ? {} : { area }),
    ...(project.length === 2 ? { project: [project[0] ?? "", project[1] ?? ""] as const } : {}),
  };
}

/** A group in the list's order: an area, or a project under its area or under none. */
interface Slot {
  readonly kind: "area" | "project";
  readonly row: Row;
  readonly home?: Row;
  readonly place: Place;
}

/**
 * The areas, each followed by its projects, then the projects without an area, in the space's
 * order and at most GROUP_PAGE groups a page (A3 3.4.10). A deleted group is never shown, an
 * archived one when the caller asks for archived groups or names it, and an area whenever it holds
 * a project shown. The cursor is the place of the page's last group, so the next page goes on from
 * there in the order as it is then: a group moved since is met at its new place or not again, and
 * none that stayed put is skipped.
 */
function groupList(read: GroupsHere, scope: ListScope): Record<string, unknown> {
  const pair = (row: Row) => [String(row["position"]), String(row["id"])] as const;
  const areasById = new Map(read.areas.map((a) => [a["id"], a]));
  const order: Slot[] = [
    ...[...areasById.values()].map((row): Slot => ({
      kind: "area",
      row,
      place: { area: pair(row) },
    })),
    ...read.projects.map((row): Slot => {
      const home = areasById.get(row["area_id"]);
      return home === undefined
        ? { kind: "project", row, place: { project: pair(row) } }
        : { kind: "project", row, home, place: { area: pair(home), project: pair(row) } };
    }),
  ].sort((a, b) => comparePlaces(a.place, b.place));
  const { only } = scope;
  const listed = (row: Row) =>
    scope.archived ||
    row["lifecycle"] === "active" ||
    row["id"] === only?.area ||
    row["id"] === only?.project;
  const projectShown = (slot: Slot) =>
    slot.kind === "project" &&
    listed(slot.row) &&
    (only === undefined ||
      (only.project === undefined
        ? slot.home?.["id"] === only.area
        : slot.row["id"] === only.project));
  const homes = new Set(order.filter(projectShown).map((slot) => slot.home?.["id"]));
  const shown = (slot: Slot) =>
    slot.kind === "project"
      ? projectShown(slot)
      : only === undefined
        ? listed(slot.row) || homes.has(slot.row["id"])
        : only.project === undefined
          ? slot.row["id"] === only.area
          : homes.has(slot.row["id"]);
  const all = order.filter(shown);
  const { after } = scope;
  const rest = after === undefined ? all : all.filter((s) => comparePlaces(s.place, after) > 0);
  const refOf = groupRefs(read, areasById);
  const row = (group: Row, folders?: GroupsHere["folders"]) => {
    const ref = refOf(group);
    return {
      ...groupRow(group, folders),
      ...(group["lifecycle"] === "active" ? {} : { archived: true }),
      ...(ref === undefined ? {} : { ref }),
    };
  };
  const pageOf = (count: number): Record<string, unknown> => {
    const page = rest.slice(0, count);
    const areas: { id: string; projects: unknown[] }[] = [];
    const projects: unknown[] = [];
    for (const slot of page) {
      if (slot.kind === "area") {
        areas.push({ ...row(slot.row), projects: [] });
      } else if (slot.home === undefined) {
        projects.push(row(slot.row, read.folders));
      } else {
        // A page that starts inside an area shows that area above the rest of its projects.
        if (areas.at(-1)?.id !== slot.home["id"]) areas.push({ ...row(slot.home), projects: [] });
        areas.at(-1)?.projects.push(row(slot.row, read.folders));
      }
    }
    const last = page.at(-1);
    return {
      action: "list",
      as_of: read.space.asOf,
      areas,
      projects,
      total_areas: all.filter((slot) => slot.kind === "area").length,
      total_projects: all.filter((slot) => slot.kind === "project").length,
      ...(rest.length > count && last !== undefined
        ? { cursor: cursorOf(read.space.id, last.place) }
        : {}),
    };
  };
  // The most groups the caller's face shows whole: the next page starts at the first it would cut.
  let count = Math.min(GROUP_PAGE, rest.length);
  const { shows } = scope;
  if (shows !== undefined && count > 1 && !shows(pageOf(count))) {
    let low = 1;
    let high = count - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (shows(pageOf(mid))) low = mid;
      else high = mid - 1;
    }
    count = low;
  }
  return pageOf(count);
}

/**
 * The ID of each group whose name alone does not name it as a path would (groups.ts): its name
 * holds a slash, another group's name or slug is the same name and wins or ties with it, or it is a
 * project without an area, which no path names by name.
 */
function groupRefs(
  read: GroupsHere,
  areasById: ReadonlyMap<unknown, Row>,
): (row: Row) => string | undefined {
  const named = (row: Row, area: string | null): GroupName => ({
    id: String(row["id"]),
    slug: String(row["slug"]),
    title: String(row["title"]),
    area,
    ...(row["lifecycle"] === "active" ? {} : { archived: true }),
  });
  const areas = [...areasById.values()].map((row) => named(row, null));
  const projects = read.projects.map((row) =>
    named(row, areasById.has(row["area_id"]) ? String(row["area_id"]) : null),
  );
  // The groups of one kind, and of one area for projects, by each key a name matches them by:
  // only groups under one key can tie.
  const keyOf = (kind: string, area: string | null, key: string) =>
    `${kind}\n${area ?? ""}\n${key}`;
  const index = new Map<string, GroupName[]>();
  const add = (kind: string, group: GroupName) => {
    for (const key of new Set([fold(group.title), group.slug])) {
      const at = keyOf(kind, group.area, key);
      index.set(at, [...(index.get(at) ?? []), group]);
    }
  };
  for (const group of areas) add("area", group);
  for (const group of projects) add("project", group);
  const kinds = new Map<string, "area" | "project">([
    ...areas.map((g) => [g.id, "area"] as const),
    ...projects.map((g) => [g.id, "project"] as const),
  ]);
  const byId = new Map([...areas, ...projects].map((group) => [group.id, group]));
  return (row) => {
    const id = String(row["id"]);
    const group = byId.get(id);
    const kind = kinds.get(id);
    if (group === undefined || kind === undefined) return undefined;
    if (group.title.includes("/") || (kind === "project" && group.area === null)) return id;
    const rivals = index.get(keyOf(kind, group.area, fold(group.title))) ?? [];
    if (rivals.length <= 1) return undefined;
    const names = { areas: rivals, projects: rivals, aliases: [] };
    try {
      const area = group.area ?? undefined;
      return resolveGroup(names, kind, group.title, "path", { lookup: true, area }) === id
        ? undefined
        : id;
    } catch {
      return id;
    }
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

/**
 * The keys an audience is shown. An agent is not shown a key this build does not act on yet
 * (`LATER_PREFERENCES`): it would read as a setting in force. A person still reads what is stored.
 */
const AGENT_PREFERENCES: readonly PreferenceSpec[] = TOOL_PREFERENCES.filter(
  (p) => !LATER_PREFERENCES.some((later) => later.key === p.key),
);

/** The declarations `keys` names (A3 3.4.11): exact keys or prefixes ending in `.*`, else all. */
function prefsAsked(keys: unknown, shown: readonly PreferenceSpec[]): PreferenceSpec[] {
  if (!Array.isArray(keys) || keys.length === 0) return [...shown];
  const wanted = new Set<string>();
  (keys as string[]).forEach((key, k) => {
    const prefix = key.endsWith(".*") ? key.slice(0, -1) : undefined;
    const found = shown.filter((p) =>
      prefix === undefined ? p.key === key : p.key.startsWith(prefix),
    );
    if (found.length === 0) throw unknownPref(`keys.${String(k)}`, key, shown);
    for (const p of found) wanted.add(p.key);
  });
  return shown.filter((p) => wanted.has(p.key));
}

/**
 * A key no declaration has. Keys are the product's own words, never stored text, so the closest
 * one may stand in the hint.
 */
function unknownPref(path: string, key: string, shown: readonly PreferenceSpec[]): AppError {
  const close = shown
    .map((p) => p.key)
    .find((name) => editDistance(name, key.toLowerCase(), 3) <= 3);
  return invalid(
    path,
    "No preference has this key",
    close === undefined
      ? "Call preferences with action describe for the keys."
      : `Did you mean ${close}?`,
  );
}

/** The step that makes a key this build declares and does not read do something, if it is one. */
const laterStep = (p: PreferenceSpec): string | undefined =>
  LATER_PREFERENCES.find((later) => later.key === p.key)?.step;

/** The step that lets anyone set a key this build reads, if it is one. */
const laterSet = (p: PreferenceSpec): string | undefined =>
  LATER_SETS.find((later) => later.key === p.key)?.step;

/**
 * Whether the caller may set the key here (A1 3.16): a key this build acts on and lets be set,
 * never a policy key, else by its writers, and only for a caller who may set at all (later.ts).
 */
const prefWritable = (p: PreferenceSpec, principal: Principal): boolean =>
  laterIn("prefs.manage", { action: "set" }, principal.audience) === undefined &&
  laterStep(p) === undefined &&
  laterSet(p) === undefined &&
  !p.policy &&
  mayWrite(p, principal.actorKind);

/**
 * A value as the caller gave it, in its key's form: the command line gives one text, so a list is
 * keys separated by commas, a number its digits and a switch true or false. Undefined when it does
 * not fit the key.
 */
function prefValueOf(p: PreferenceSpec, given: unknown): PrefValue | undefined {
  let value: unknown = given;
  const { shape } = p;
  if (typeof given === "string") {
    const text = given.trim();
    if (shape.type === "list") {
      value = text
        .split(",")
        .map((key) => key.trim())
        .filter((key) => key !== "");
    } else if (shape.type === "integer" && /^-?[0-9]{1,15}$/.test(text)) {
      value = Number(text);
    } else if (shape.type === "boolean" && (text === "true" || text === "false")) {
      value = text === "true";
    }
  }
  if (isKeyList(shape) && Array.isArray(value)) value = value.map((key: unknown) => ({ key }));
  return fitsShape(shape, value) ? (value as PrefValue) : undefined;
}

/** A key's new value, checked, and where the caller gave it. */
interface PrefChange {
  readonly p: PreferenceSpec;
  readonly value: PrefValue | null;
  readonly path: string;
}

/**
 * `set` (A3 3.4.11): the keys' new values through A1's `pref.set`, in one request that never joins
 * the undo stack: setting the earlier value again changes a key back. The answer says what changed.
 */
async function prefsSet(call: Call): Promise<unknown> {
  const items = (call.input["set"] ?? []) as { key: string; value?: unknown; reset?: boolean }[];
  if (items.length === 0) throw invalid("set", "Required to set", "Give a key and its new value.");
  const changes = items.map((item, k): PrefChange => {
    const path = `set.${String(k)}`;
    // Before the lookup: a machine key nothing reads yet is not one of the tool's, and still says so.
    const step = LATER_PREFERENCES.find((later) => later.key === item.key)?.step;
    if (step !== undefined) {
      throw invalid(
        `${path}.key`,
        "This build does not act on this key yet, so it is not changed",
        `It arrives with ${step}.`,
      );
    }
    const p = TOOL_PREFERENCES.find((spec) => spec.key === item.key);
    if (p === undefined) throw unknownPref(`${path}.key`, item.key, TOOL_PREFERENCES);
    const setStep = laterSet(p);
    if (setStep !== undefined) {
      throw invalid(
        `${path}.key`,
        "This setting is fixed in this build",
        `Changing it comes with ${setStep}.`,
      );
    }
    if (!prefWritable(p, call.principal)) {
      throw invalid(`${path}.key`, "Not a key this caller changes");
    }
    const reset = item.reset === true;
    if (reset === (item.value !== undefined)) {
      throw invalid(
        `${path}.value`,
        reset ? "Give a value or reset, not both" : "Required to set",
        "Give the new value, or reset to put the key back to its default.",
      );
    }
    if (reset) return { p, value: null, path };
    const value = prefValueOf(p, item.value);
    if (value === undefined) {
      const meantReset = String(item.value).trim().toLowerCase() === "null";
      throw invalid(
        `${path}.value`,
        "Not a value of this key",
        `It takes ${shapeText(p.shape)}.${meantReset ? " reset puts it back to its default." : ""}`,
      );
    }
    return { p, value, path };
  });
  const reader = readerOf(call.space);
  const before = await readSpacePreferences(reader).catch((error: unknown) => {
    throw storageFailure(error);
  });
  for (const { p, path } of changes) {
    if (before.reads.get(p.key)?.state === "newer") {
      throw invalid(
        `${path}.key`,
        "A newer build wrote this setting, so this build only reads it",
        `Change it with the newer build, or update ${PRODUCT_NAME} here.`,
      );
    }
  }
  // Each key from the value it had to the one it is given, as the answer says it if the writer
  // changes that key: kept with the request, so a replay says what changed then.
  const sets = changes.map(({ p, value }) => ({
    key: p.key,
    from: shownValue(p, before.reads.get(p.key)?.value ?? p.default),
    to: shownValue(p, value ?? p.default),
  }));
  let result;
  try {
    result = await submit(
      call,
      changes.map(({ p, value }): Operation => ({ kind: "pref.set", key: p.key, value })),
      { undoable: false, answer: { changed: sets } },
    );
  } catch (error) {
    throw (await keysInUse(reader, changes)) ?? error;
  }
  return answerOf(call, result);
}

/**
 * The refusal of a scale change that removes a key active tasks hold (the writer's rule), naming
 * those tasks so the person knows what to move first. Undefined when that is not why it failed.
 */
async function keysInUse(
  reader: WorkerConnection,
  changes: readonly PrefChange[],
): Promise<AppError | undefined> {
  for (const { p, value, path } of changes) {
    if (p.key !== "tasks.statuses" && p.key !== "tasks.effort_scale") continue;
    const field = p.key === "tasks.statuses" ? "status" : "effort";
    const kept = new Set(scaleKeysOf(value ?? p.default));
    let holders;
    try {
      const now = await readTaskKeys(reader);
      holders = await readKeyHolders(
        reader,
        field,
        now[field].filter((key) => !kept.has(key)),
      );
    } catch {
      return undefined;
    }
    if (holders.count === 0) continue;
    const named = holders.tasks.map((t) => `${t.ref} (${t.key})`).join(", ");
    const more = holders.count - holders.tasks.length;
    return new AppError({
      code: "invalid_input",
      message: `Active tasks hold ${field === "status" ? "a status" : "an effort"} this change removes: ${named}${more > 0 ? ` and ${String(more)} more` : ""}. Nothing was changed.`,
      hint: `Give them another ${field} or finish them, then change ${p.key} again.`,
      data: {
        issues: [{ path: `${path}.value`, message: "Active tasks hold a key it removes" }],
        tasks: holders.tasks.map((t) => t.ref),
        task_count: holders.count,
      },
    });
  }
  return undefined;
}

/** A scale's keys from its value: a list of keys, or of `{key}` objects. */
const scaleKeysOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map((item: unknown) =>
        typeof item === "string" ? item : String((item as { key?: unknown }).key),
      )
    : [];

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
  principal: Principal,
): Record<string, unknown> {
  const value = shownValue(p, read?.value ?? p.default);
  const fallback = shownValue(p, p.default);
  const later = LATER_PREFERENCES.find((row) => row.key === p.key);
  return {
    key: p.key,
    ...(action === "describe" ? { summary: p.summary, shape: shapeText(p.shape) } : {}),
    ...(action === "get"
      ? { value, is_default: JSON.stringify(value) === JSON.stringify(fallback) }
      : {}),
    default: fallback,
    writable: prefWritable(p, principal) && read?.state !== "newer",
    ...(p.policy ? { policy: true } : {}),
    ...(laterSet(p) === undefined ? {} : { fixed: true }),
    ...(later === undefined ? {} : { in_force: later.inForce }),
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

/**
 * A launch intent as `launch.open` returns it: IDs, states, instants and fixed codes only, with
 * what its click left out as recorded then.
 */
function launchReceipt(intent: LaunchIntent): Record<string, unknown> {
  const leftOut = leftOutOf(intent.evidence);
  return {
    id: intent.id,
    reference: intent.reference,
    instance: intent.instance,
    route: intent.route,
    state: intent.state,
    ...(intent.reason === null ? {} : { reason: intent.reason }),
    ...(leftOut.length === 0 ? {} : { left_out: leftOut }),
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
    if (error.reason === "other_space") {
      return new AppError({
        code: "invalid_input",
        message: `This agent app works in ${error.works === undefined ? "another space" : `the space ${error.works}`}, so it could not use ${PRODUCT_NAME} in this one. Nothing was started.`,
        hint: `Register it for this space: in Settings under Agent apps, or with ${CLI_NAME} setup agents.`,
        data: {
          field: "instance",
          reason: error.reason,
          ...(error.works === undefined ? {} : { space: error.works }),
        },
      });
    }
    const said = (() => {
      switch (error.reason) {
        case "not_set_up":
          return { message: "This instance is not set up on this machine." };
        case "other_machine":
          return { message: "This task's folder is on another machine." };
        case "not_for_space":
          return {
            message: NOT_FOR_SPACE,
            hint: "Add this space to its spaces in machine.toml, or open the task with another instance.",
          };
        case "no_terminal":
          return {
            message: "No terminal can open this instance here. Nothing was started.",
            hint: `Run ${CLI_NAME} doctor to see which terminal it would use.`,
          };
        case "own_home":
          return {
            message:
              "Only a terminal opens this instance with the account chosen for it, and none can start here. Nothing was started.",
            hint: `Run ${CLI_NAME} doctor to see which terminal it would use.`,
          };
        default:
          return { message: "This instance cannot open the task here." };
      }
    })();
    return new AppError({
      code: "invalid_input",
      ...said,
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
  if (error instanceof LaunchWriterGone) return spaceUnavailable("not_served", true);
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
