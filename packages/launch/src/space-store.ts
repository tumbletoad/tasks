// The v1 execution store: the space database (A4 3.16.1, X7). Each call is one A1 operation,
// `launch.create` or `launch.transition`, sent to the space's writer, which commits the record, its
// history and the request's receipt in one transaction (A1 3.7). Reads go to the
// same writer, behind the requests sent before them. Launch code never imports storage (A7 3.2):
// the writer reaches this store as a port, the in-thread SpaceWriter in tests and the worker's
// SpaceWriterHandle in the service, which both fit it.
import {
  EVIDENCE_FIELDS,
  INTENT_STATES,
  isEvidenceValue,
  isFailReason,
  isIntentState,
  isLaunchRef,
  isRoute,
  isUnknownReason,
  type EvidenceKey,
  type IntentState,
} from "./intents.ts";
import {
  checkNewIntent,
  checkTransition,
  ExecutionRefused,
  LAUNCH_ID,
  type ExecutionStore,
  type Expected,
  type LaunchIntent,
  type NewIntent,
  type Outcome,
  type RefusalCode,
} from "./store.ts";

type MaybePromise<T> = T | Promise<T>;

/** A launch row as the space's writer reads it back (storage: `LaunchRecord`). */
export interface SpaceLaunchRow {
  id: string;
  reference: string;
  task_id: string | null;
  session_id: string | null;
  instance_id: string;
  machine_id: string;
  route: string;
  place_id: string | null;
  task_version: number | null;
  brief_hash: string | null;
  state: string;
  reason: string | null;
  evidence: Readonly<Record<string, unknown>>;
  at: Readonly<Record<string, unknown>>;
  created_at: number;
  updated_at: number;
  version: number;
}

/** The part of a write result this store reads (storage: `WriteResult`). */
export interface SpaceWriteResult {
  status: string;
  results: readonly { id: string }[];
  error?: { code: string; message: string; field?: string };
}

/**
 * The credential the store's requests carry (A1 3.21; storage: `Credential`). The writer refuses
 * launch operations from any actor but a human or the space's system (R7).
 */
export interface SpaceCredential {
  scope_id: string;
  principal_id: string;
  actor_kind: string;
  machine_id: string;
  origin: string;
}

/** The space's writer, as this store needs it. */
export interface SpaceWriterPort {
  submit(request: SpaceWriteRequest): MaybePromise<SpaceWriteResult>;
  launch(id: string): MaybePromise<SpaceLaunchRow | null | undefined>;
  openLaunches(machine: string): MaybePromise<readonly SpaceLaunchRow[]>;
  /**
   * A request's receipt in a writer scope (storage: `receipt`, A1 3.8), read only: whether the
   * scope already decided a request with this ID. Behind the requests sent before it.
   */
  receipt(lookup: {
    scope_id: string;
    request_id: string;
  }): MaybePromise<SpaceReceipt | null | undefined>;
}

/** The part of a request's receipt this store reads (storage: `Receipt`). */
export interface SpaceReceipt {
  readonly request_id: string;
  readonly status?: string;
  /** The stored result, as a replay returns it. */
  readonly result?: { readonly results: readonly { readonly id: string }[] };
}

/** A write request with launch operations (storage: `WriteRequest`). */
export interface SpaceWriteRequest {
  space_id: string;
  request_id: string;
  actor: SpaceCredential;
  ops: Record<string, unknown>[];
}

export interface SpaceExecutionStoreOptions {
  writer: SpaceWriterPort;
  spaceId: string;
  /**
   * Who writes the records: the person who clicked (A4 3.16: `created_by = user`), in the writer
   * scope of the service's launch path. Its machine is the one the records belong to.
   */
  credential: SpaceCredential;
}

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * A fresh request ID for each transition call: 130 random bits. A call is never repeated under the
 * same ID: a transition whose answer was lost leaves its outcome open (A1 3.8), and the caller
 * reads the record again instead. The compare-and-set then refuses the repeat of a transition that
 * did commit, so no caller can take a lost answer as permission to act twice.
 */
function transitionRequestId(): string {
  const bytes = new Uint8Array(26);
  globalThis.crypto.getRandomValues(bytes);
  return `launch-${Array.from(bytes, (b) => ALPHABET.charAt(b % 32)).join("")}`;
}

export class SpaceExecutionStore implements ExecutionStore {
  readonly #writer: SpaceWriterPort;
  readonly #spaceId: string;
  readonly #credential: SpaceCredential;

  constructor(options: SpaceExecutionStoreOptions) {
    this.#writer = options.writer;
    this.#spaceId = options.spaceId;
    this.#credential = options.credential;
  }

  async createIntent(value: NewIntent, requestId: string): Promise<LaunchIntent> {
    const input = checkNewIntent(value);
    if (input.machine !== this.#credential.machine_id) {
      throw new ExecutionRefused("invalid", "This store writes for its own machine", "machine");
    }
    const result = await this.#submit(requestId, {
      kind: "launch.create",
      task: input.task,
      instance: input.instance,
      route: input.route,
      place: input.place,
      task_version: input.taskVersion,
      brief_hash: input.briefHash,
      ...(input.session === undefined ? {} : { session: input.session }),
      ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
    });
    const id = result.results[0]?.id;
    if (result.error !== undefined || id === undefined) throw refusal(result);
    return this.#read(id);
  }

  async transitionIntent(
    id: string,
    expect: Expected,
    next: IntentState,
    outcome?: Outcome,
  ): Promise<LaunchIntent> {
    const change = checkTransition(id, expect, next, outcome);
    const result = await this.#submit(transitionRequestId(), {
      kind: "launch.transition",
      launch: change.id,
      expect: change.expect,
      ...(change.version === undefined ? {} : { expect_version: change.version }),
      next: change.next,
      ...(change.reason === undefined ? {} : { reason: change.reason }),
      ...(Object.keys(change.evidence).length === 0 ? {} : { evidence: change.evidence }),
    });
    if (result.error === undefined) return this.#read(change.id);
    const refused = refusal(result);
    if (refused.code === "stale" || refused.code === "evidence") {
      const current = await this.readIntent(change.id);
      throw new ExecutionRefused(refused.code, refused.message, refused.field, current);
    }
    throw refused;
  }

  /**
   * Whether this store's writer scope already decided a request with this ID (A1 3.8), read only.
   * Then `createIntent` with it replays that decision (the same intent, as it is now) or refuses it
   * as `request_id_reused`, and never makes a new intent: a check that guards only a new intent
   * must not stand in front of its replay.
   */
  async decided(requestId: string): Promise<boolean> {
    const found = await this.#writer.receipt({
      scope_id: this.#credential.scope_id,
      request_id: requestId,
    });
    return found !== null && found !== undefined;
  }

  /**
   * The intent a request this scope already decided made (or was given by A4's 5 s rule), as it
   * is now: a replay read from the receipt alone, before anything the click would be built from is
   * read again (A1 3.8). Undefined when the scope has not decided the request or it made no
   * intent; `createIntent` then decides it, a refusal included. Read only.
   */
  async replayed(requestId: string): Promise<LaunchIntent | undefined> {
    const found = await this.#writer.receipt({
      scope_id: this.#credential.scope_id,
      request_id: requestId,
    });
    if (found === null || found === undefined) return undefined;
    if (found.status !== "applied" && found.status !== "unchanged") return undefined;
    const id = found.result?.results[0]?.id;
    return id === undefined ? undefined : this.readIntent(id);
  }

  async readIntent(id: string): Promise<LaunchIntent | undefined> {
    if (!LAUNCH_ID.test(id)) return undefined;
    const row = await this.#writer.launch(id);
    return row === null || row === undefined ? undefined : decodeLaunch(row);
  }

  async openWork(machine: string): Promise<{ intents: LaunchIntent[] }> {
    const rows = await this.#writer.openLaunches(machine);
    return { intents: rows.map(decodeLaunch) };
  }

  async #read(id: string): Promise<LaunchIntent> {
    const intent = await this.readIntent(id);
    if (intent === undefined) throw new Error("A launch the writer returned is not there");
    return intent;
  }

  async #submit(requestId: string, op: Record<string, unknown>): Promise<SpaceWriteResult> {
    return this.#writer.submit({
      space_id: this.#spaceId,
      request_id: requestId,
      actor: this.#credential,
      ops: [op],
    });
  }
}

/** The refusal a rejected request means. The writer's message is a fixed sentence. */
function refusal(result: SpaceWriteResult): ExecutionRefused {
  const error = result.error ?? { code: "INTERNAL", message: "The writer returned no result" };
  // The writer names a field of the one operation, with or without its `ops[0].` prefix.
  const field = error.field?.replace(/^ops\[0\]\./, "");
  let code: RefusalCode;
  switch (error.code) {
    case "INVALID_TRANSITION":
      code = field?.startsWith("evidence") === true ? "evidence" : "stale";
      break;
    case "NOT_FOUND":
    case "DELETED":
      code = "not_found";
      break;
    case "REQUEST_ID_REUSED":
      code = "request_id_reused";
      break;
    case "VALIDATION_FAILED":
    case "REQUEST_ID_INVALID":
    case "TOO_LARGE":
      code = "invalid";
      break;
    default:
      code = "unavailable";
  }
  return new ExecutionRefused(code, error.message, field);
}

/** A launch row as a LaunchIntent, checked: a row that is not one is a damaged space. */
export function decodeLaunch(row: SpaceLaunchRow): LaunchIntent {
  const bad = (column: string): never => {
    throw new Error(`A launch row holds an invalid ${column}`);
  };
  const { state, route, reason } = row;
  if (!LAUNCH_ID.test(row.id)) bad("id");
  if (!isLaunchRef(row.reference)) bad("reference");
  if (!isIntentState(state)) return bad("state");
  if (!isRoute(route)) return bad("route");
  if (reason !== null && !isFailReason(reason) && !isUnknownReason(reason)) return bad("reason");
  const at: Partial<Record<IntentState, number>> = {};
  for (const [key, value] of Object.entries(row.at)) {
    if (!isIntentState(key) || typeof value !== "number") return bad("at");
    at[key] = value;
  }
  // A4's keys, checked by their kind. A key a newer build added is left out, not refused: the
  // writer has checked its shape, and evidence only grows.
  const evidence: Record<string, unknown> = {};
  for (const key of Object.keys(row.evidence).sort()) {
    if (!Object.hasOwn(EVIDENCE_FIELDS, key)) continue;
    const value = row.evidence[key];
    if (!isEvidenceValue(EVIDENCE_FIELDS[key as EvidenceKey], value)) return bad("evidence");
    evidence[key] = value;
  }
  return {
    id: row.id,
    reference: row.reference,
    task: row.task_id,
    session: row.session_id,
    machine: row.machine_id,
    instance: row.instance_id,
    route,
    place: row.place_id,
    folderKind: row.place_id === null ? "work_folder" : "place",
    taskVersion: row.task_version,
    briefHash: row.brief_hash,
    state,
    reason,
    evidence,
    at: Object.fromEntries(INTENT_STATES.flatMap((s) => (s in at ? [[s, at[s]]] : []))),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}
