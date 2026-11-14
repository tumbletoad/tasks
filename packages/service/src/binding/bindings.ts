// Session binding (A3 3.7, M2.04, M4.06): which task and space each agent connection writes to, and
// as whom. The request path reads a connection's Slot (ops/binding.ts); this service is the only
// code that changes one, and it decides only from what the connection presented in its
// authenticated bind frame (A2 3.6.4: the entry's `--space`, `--instance` and `--app`,
// `env.TASKS_TICKET`, the native IDs, `parent.pid`, `resume.handle`), from the native ID a tool
// call carries (Codex's `_meta.threadId`, A3 3.7.2), and from what the service itself issued or
// learned (the ticket, the launch reference, the handle, the native IDs its launches set or
// received). Nothing an agent chooses freely binds: not its working folder (`cwd` is never read
// here), not a tool argument (no tool names a session), not `TASKS_TASK` or `TASKS_SPACE`.
//
// A launch's session is made with its launch intent, before dispatch (A3 3.7.7, `launched`), so a
// `cli-agent` call before any bridge bound maps to it. Until an agent binds it, it holds the
// launch's instance and no `via`; the first connection that binds it makes it its home's.
//
// The rules, in A3 3.7.3's order:
// 0. The host, read after rule 1 and before rule 2: a connection whose app runs one server for many
//    conversations (hosts.ts, A3 3.7.5) is shared from its bind frame on; its ticket and native IDs
//    bind nothing at the bind frame.
// 1. `resume.handle`: a handle this service issued to a connection of the same instance, used in
//    the last 24 hours, restores its binding and its pinned space; one whose session ended answers
//    `lost`, and the connection continues unbound.
// 2. The ticket: its first bridge-role redemption, within 15 minutes of the agent's start, binds to
//    the launch's session. A ticket redeemed before is honoured again for that session only when
//    the connection presents a native ID the session holds, or no other connection of the session
//    is open and the agent still runs (its MCP server restarted). Otherwise it is ignored and
//    logged. A ticket of another space than the connection's is ignored.
// 3. A native ID alone: one that a launch set or received (Claude's preset, T3's thread ID, Codex's
//    reference match) for exactly one live session of this instance binds it (`native_id`). The
//    bind frame carries Claude's and T3's; Codex's comes with each tool call (`forCall`).
// Then, through `get_task`: a launch reference binds once, the same connection again gets the same
// binding, another gets `launch_used`; an explicit task binds an ad-hoc session. A bound connection
// is never bound to something else (`already_bound`); the user unbinds, rebinds or ends a session.
//
// A session is pinned to its space for its whole life (A3 3.7.8), and an unbound connection to the
// space its bind frame named (or the default, A2 3.7.1). The UI's space plays no part. A ticket or
// native ID of a space the connection's agent home is not granted binds nothing (the grant gate,
// ops/grant.ts); a binding restored by its handle stays, and the request path refuses its calls
// while its home is not granted its space, so a home registered again finds its sessions as they
// were.
//
// Three rules keep a binding consistent with what was written under it:
// - Durable before irreversible: a session is on disk (with the connection's handle naming it)
//   before a ticket's role is spent, a launch records the binding, or a bind is answered `bound`.
//   A launch that does not answer binds nothing yet; the same connection asks again with the same
//   instant, so a late write is recognised as its own.
// - A call sees a settled binding (`use`): a call on a session whose bind still waits on its launch
//   waits for the outcome, and a slot whose session is gone, ended or not bound is unbound before a
//   call reads it. Receipts survive the move from unbound to bound: a connection that was unbound
//   at any time keeps that scope as a lookup (marked in its handle's first write), and a write with
//   an earlier scope waits for that scope's writes with its request ID (ops/handlers.ts).
// - A connection that carries two conversations (a shared host, two different native IDs of one
//   source, or an ID its bound session does not hold, A3 3.7.5) is shared, and stays so in its
//   handle: a call acts as a session only when its own native ID proves that session, and no call
//   binds the connection.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { JsonObject } from "@tasks/bridge/protocol";
import { AppError } from "@tasks/contracts";
import { INSTANCE_ID, MANUAL_INSTANCE, type BridgeTicket, type LaunchIntent } from "@tasks/launch";
import { isId, newId } from "@tasks/storage";
import {
  MAX_PRESENTED,
  NATIVE_ID,
  principalOf,
  Slot,
  grantRefused,
  type BindOutcome,
  type BindingPort,
  type BoundSession,
  type FoundLaunch,
  type HomeGate,
  type NativeSource,
  type ServedSpace,
  type SessionRow,
} from "../ops/index.ts";
import { sharedHost, type Ancestry } from "./hosts.ts";
import {
  BINDS_ALONE,
  MAX_HANDLES,
  MAX_LAUNCHES,
  MAX_NATIVE,
  MAX_SESSIONS,
  type EndReason,
  type HandleRecord,
  type NativeRecord,
  type SessionRecord,
  type SessionStore,
  type Trust,
  type Via,
} from "./sessions.ts";

/** A3 3.7.4: a binding handle is valid 24 hours after its last use, sliding. */
export const HANDLE_IDLE_MS = 24 * 60 * 60_000;
/** A handle past its validity is kept this long, so its bridge hears `lost` rather than nothing. */
export const HANDLE_KEEP_MS = 8 * 24 * 60 * 60_000;
/** A session with no open connection, no running agent and no call for this long has ended. */
export const SESSION_IDLE_MS = 24 * 60 * 60_000;
/** A4 3.10: a session made with its launch that never bound ends `stale` after 7 quiet days. */
export const SESSION_STALE_MS = 7 * 24 * 60 * 60_000;
/** An ended session's record is kept this long (its launch keeps `bound_at` in the space). */
export const SESSION_KEEP_MS = 30 * 24 * 60 * 60_000;
/** A last-seen time is written at most this often; in memory it is always current. */
export const SEEN_WRITE_MS = 60_000;
/** At most this many sessions of a task are listed (`task.get`'s sessions section). */
export const LISTED_SESSIONS = 20;

/** A handle: `bh_` and 128 random bits (A2 3.6.4), never logged, never shown to the model. */
export const HANDLE = /^bh_[A-Za-z0-9_-]{22}$/;

/** The bind context's environment names that carry a native ID (A3 3.7.2), by source. */
const NATIVE_ENV: Readonly<Record<string, NativeSource>> = {
  CLAUDE_CODE_SESSION_ID: "claude",
  T3CODE_THREAD_ID: "t3",
  CODEX_THREAD_ID: "codex",
};

/**
 * Resume (A4 3.10): the native ID source each target resumes by. A target that is not here offers
 * no Resume (Claude Desktop, Copy, a custom target): its button reads Open.
 */
const RESUMES: Readonly<Record<string, NativeSource>> = {
  "claude-cli": "claude",
  "codex-cli": "codex",
  t3: "t3",
  "codex-app": "codex",
};

/** Why a bind frame's input was not used (the log's closed list). Nothing of the input is logged. */
export const IGNORED = [
  "malformed",
  "unknown",
  "instance",
  "expired",
  "space",
  "window",
  "used",
  "routine",
  "unrecorded",
  // A ticket of a space the connection's agent home is not granted (A3 3.7.8).
  "grant",
  // A ticket or native ID at the bind frame of a connection that carries many conversations.
  "shared",
  // A ticket of a launch whose session ended before an agent bound it.
  "ended",
] as const;
export type Ignored = (typeof IGNORED)[number];

export const BIND_STATES = ["bound", "unbound", "lost"] as const;
export type BindState = (typeof BIND_STATES)[number];

/** Content-free events for the hub's log (`binding.*` in log.ts). */
export type BindingEvent =
  | { readonly ev: "binding.bound"; readonly via: Via | "handle" }
  | {
      readonly ev: "binding.ignored";
      readonly input: "ticket" | "handle" | "native";
      readonly reason: Ignored;
    }
  | { readonly ev: "binding.lost" }
  | { readonly ev: "binding.shared" }
  | { readonly ev: "binding.ended"; readonly reason: EndReason }
  | { readonly ev: "binding.report_failed" }
  | { readonly ev: "binding.store_failed" }
  | { readonly ev: "binding.store_dropped"; readonly count: number };

/** What binding needs of launching (launch/service.ts, the shim host). */
export interface LaunchPort {
  /** What a ticket names for its bridge role, without spending it (`ShimHost.bridgeTicket`). */
  bridgeTicket(ticket: string): BridgeTicket | undefined;
  /** Spends the bridge role: the first redemption (`ShimHost.redeemBridge`). */
  redeemBridge(ticket: string): { space: string; launch: string } | undefined;
  /** Whether the launch's agent runs, as its machine state says. */
  agentRuns(launch: string): boolean;
  /**
   * Records the bridge's binding on the launch (A4 3.9.1: `confirmed` with `bound_at`, which
   * also settles an Unknown launch) and returns the launch as it is after. Throws when the space's
   * store cannot take it now.
   */
  confirm(space: string, launch: string, at: number): Promise<LaunchIntent | undefined>;
}

/** An instance of machine.toml as Resume needs it (A4 3.2, 3.10). */
export interface ResumeInstance {
  readonly id: string;
  readonly target: string;
  readonly enabled: boolean;
}

export interface BindingsOptions {
  readonly store: SessionStore;
  /** This machine (`m_` ID): an unbound connection's writer scope names it. */
  readonly machine: string;
  /**
   * The grant gate (ops/grant.ts, A3 3.7.8): a ticket binds only into a space the connection's
   * agent home may use, so a refused home's bind frame writes nothing into that space.
   */
  readonly homes: HomeGate;
  readonly spaces: () => readonly ServedSpace[];
  readonly launches: LaunchPort;
  /** A connection's ancestors, for its host (hosts.ts, A3 3.7.5). None: no host is read. */
  readonly ancestry?: Ancestry;
  /** machine.toml's instances now: Resume needs one that exists (A4 3.10). Default: none. */
  readonly instances?: () => readonly ResumeInstance[];
  readonly log?: (event: BindingEvent) => void;
  /** Wall clock milliseconds. Default: Date.now. */
  readonly now?: () => number;
}

/** What a user's change of a session (`end`, `unbind`, `rebind`) did. */
export type SessionChange =
  | { readonly kind: "changed"; readonly session: string; readonly next?: string }
  | { readonly kind: "no_change"; readonly session: string }
  | { readonly kind: "not_found" }
  | { readonly kind: "ended"; readonly session: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A bind whose session could not be put on disk, or found no room: nothing was bound. */
const unrecorded = (): AppError =>
  new AppError({
    code: "internal",
    message: "The service could not record this session, so the call bound nothing.",
    hint: "Pass task on each call for now, and ask the user to run tasks doctor.",
  });

const noop = (): void => undefined;

/** Dropped sessions remembered, so their slots go unbound rather than lost. */
const MAX_DROPPED = 256;

/** The hash a handle is stored as: SHA-256 in a domain of its own. */
export const handleHash = (handle: string): string =>
  createHash("sha256").update(`binding-handle/1\n${handle}`, "utf8").digest("hex");

const sameHex = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));

const view = (record: SessionRecord): BoundSession => ({
  id: record.id,
  space: record.space,
  task: record.task,
  instance: record.instance,
  launches: record.launches,
  ...(record.via === null ? { waiting: true as const } : {}),
});

/** The instance a bind context names: an A4 instance ID, else `manual` (mcp/principal.ts's rule). */
const instanceIn = (context: JsonObject): string => {
  const value = context["instance"];
  return typeof value === "string" && INSTANCE_ID.test(value) ? value : MANUAL_INSTANCE;
};

/** How far each trust goes: a native ID keeps the strongest it was recorded with. */
const RANK: Readonly<Record<Trust, number>> = {
  preset: 2,
  returned: 2,
  "reference-match": 2,
  bridge: 1,
  presented: 0,
};

/** The native IDs a launch set or received (A4 3.9.1 evidence `preset`, `thread`). */
function launchNative(intent: LaunchIntent): NativeRecord[] {
  const out: NativeRecord[] = [];
  const { preset, thread } = intent.evidence;
  if (typeof preset === "string" && NATIVE_ID.test(preset)) {
    out.push({ source: "claude", id: preset, trust: "preset" });
  }
  if (typeof thread === "string" && NATIVE_ID.test(thread)) {
    // T3 returns its thread ID; a terminal launch's thread is Codex's, from the reference match.
    if (intent.route === "t3-mcp" || intent.route === "t3-cli") {
      out.push({ source: "t3", id: thread, trust: "returned" });
    } else if (intent.route === "terminal") {
      out.push({ source: "codex", id: thread, trust: "reference-match" });
    }
  }
  return out;
}

const iso = (at: number): string => new Date(at).toISOString();

export class Bindings implements BindingPort {
  readonly #options: BindingsOptions;
  readonly #now: () => number;
  readonly #sessions = new Map<string, SessionRecord>();
  /** By hash. */
  readonly #handles = new Map<string, HandleRecord>();
  /** Each bridge connection's slot, by the connection the local library hands the hooks. */
  readonly #slots = new WeakMap<object, Slot>();
  /** The handle each slot holds (its hash). */
  readonly #handleOf = new WeakMap<Slot, string>();
  /** Slots whose connection is open: they count for liveness and for a ticket presented again. */
  readonly #attached = new Set<Slot>();
  /** Calls in a section of their own: one per slot, one per launch. */
  readonly #sections = new Map<unknown, Promise<unknown>>();
  /** Sessions whose bind through a reference waits on the launch's answer: calls on them wait. */
  readonly #provisional = new Map<string, Promise<void>>();
  /** Sessions a bind made and took back (its launch did not take it), newest last. */
  readonly #dropped = new Set<string>();
  /**
   * Reference binds whose launch did not answer, by launch: the instant sent and the handle of the
   * connection that sent it. Its retry sends the same instant, so a late write is its own.
   */
  readonly #unanswered = new Map<string, { readonly at: number; readonly handle: string }>();
  #savedAt = 0;
  #dirty = false;
  #prunedAt = 0;

  constructor(options: BindingsOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    const { state, dropped } = options.store.load();
    for (const session of state.sessions) this.#sessions.set(session.id, session);
    for (const handle of state.handles) this.#handles.set(handle.hash, handle);
    if (dropped > 0) this.#log({ ev: "binding.store_dropped", count: dropped });
  }

  // -------------------------------------------------------------------------------------------
  // The launch side (A3 3.7.7, A4 3.10)

  /**
   * A launch intent as the space recorded it (launch/service.ts reports every record its launch
   * machine writes). A new click's intent gets its session now, before dispatch, so a `cli-agent`
   * call before any bridge bound maps to it; a Resume's (`intent.session`) joins the session it
   * continues. The native IDs the launch set or received (Claude's preset, T3's thread, Codex's
   * reference match) join the launch's live sessions, which rule 3 then binds by.
   */
  launched(space: string, intent: LaunchIntent): void {
    if (intent.task === null || !isId(space, "sp") || !isId(intent.task, "t")) return;
    let changed = false;
    if (this.#launchSessions(intent.id).length === 0 && intent.state === "prepared") {
      const continued = intent.session === null ? undefined : this.#sessions.get(intent.session);
      if (continued !== undefined && continued.space === space && continued.task === intent.task) {
        // A Resume: a new intent in the same session (A4 3.10). The session goes on.
        const open: { -readonly [K in keyof SessionRecord]: SessionRecord[K] } = {
          ...continued,
          launches: [...continued.launches, intent.id].slice(-MAX_LAUNCHES),
          seen_at: this.#now(),
        };
        delete open.ended_at;
        delete open.end_reason;
        this.#sessions.set(continued.id, open);
        changed = true;
      } else if (this.#room(1)) {
        const now = this.#now();
        const id = newId("se");
        const instance = INSTANCE_ID.test(intent.instance) ? intent.instance : MANUAL_INSTANCE;
        this.#sessions.set(id, {
          id,
          space,
          task: intent.task,
          instance,
          via: null,
          launches: [intent.id],
          native: [],
          opened_with: instance,
          route: intent.route,
          created_at: now,
          seen_at: now,
        });
        changed = true;
      }
    }
    const learned = launchNative(intent);
    if (learned.length > 0) {
      for (const session of this.#launchSessions(intent.id)) {
        if (session.ended_at !== undefined) continue;
        const next = this.#joined(session, learned);
        if (next !== session) {
          this.#sessions.set(session.id, next);
          changed = true;
        }
      }
    }
    if (changed) {
      this.#dirty = true;
      this.#persist();
    }
  }

  /**
   * A launch reference was resolved on a shared connection, for that call only (A3 3.7.5): its
   * session, while no agent bound it, says it was opened by reference and is not tracked.
   */
  untracked(launch: string): void {
    for (const session of this.#launchSessions(launch)) {
      if (session.via !== null || session.ended_at !== undefined || session.untracked === true) {
        continue;
      }
      this.#sessions.set(session.id, { ...session, untracked: true });
      this.#dirty = true;
      this.#save(true);
    }
  }

  // -------------------------------------------------------------------------------------------
  // The bind frame (A3 3.7.2, 3.7.3 rules 0 to 3)

  /**
   * The bind frame of an mcp mode connection: resolves its binding and returns the bind result's
   * `binding` (A2 3.6.4: `{handle, space, state}`). The connection's slot is kept for `attach`.
   */
  async bridge(connection: { readonly context: JsonObject }): Promise<JsonObject> {
    const context = connection.context;
    this.#prune();
    const instance = instanceIn(context);
    const named = context["space"];
    const slot = new Slot({
      kind: "bridge",
      instance,
      origin: "mcp",
      unboundScope: `bridge:${instance}:${this.#options.machine}`,
      ...(typeof named === "string" && named !== "" ? { named } : {}),
    });
    const env = isObject(context["env"]) ? context["env"] : {};
    this.#present(slot, env);

    // Rule 1: a handle of this service restores the binding and the space it pinned.
    let state: BindState = "unbound";
    let handle = this.#resume(slot, context["resume"]);
    if (handle !== undefined) state = slot.session !== undefined ? "bound" : "unbound";
    if (slot.lost) state = "lost";
    if (slot.space === undefined) this.#pinAtBind(slot);
    // A new handle unless one was restored (a lost one was removed): issued before rule 2, so the
    // session a ticket binds reaches the disk with the handle that names it, in one write.
    handle ??= this.#issue(slot);

    // Rule 0: a host that runs one server for many conversations (hosts.ts).
    if (!slot.shared) {
      const host = await sharedHost(
        { app: context["app"], env, parent: context["parent"] },
        this.#options.ancestry,
      );
      if (host !== undefined) this.#share(slot);
    }

    // Rule 2: the ticket, read from the bind frame only.
    const ticket = env["TASKS_TICKET"];
    if (ticket !== undefined && slot.session === undefined) {
      // A shared host's environment is every conversation's: its ticket proves none of them.
      if (slot.shared) this.#ignored("ticket", "shared");
      else if (await this.#ticket(slot, ticket)) state = "bound";
    }
    // Rule 3: a native ID a launch set or received, alone.
    if (slot.session === undefined && slot.presented.size > 0) {
      if (slot.shared) this.#ignored("native", "shared");
      else if (this.#byNative(slot, [...slot.presented])) state = "bound";
    }
    // Unbound now, so it may write unbound before it binds: that scope stays a receipt lookup,
    // marked in this write of the handle rather than at a later write that might not land.
    if (slot.session === undefined) this.#markUnbound(slot);
    this.#save(true);
    this.#slots.set(connection, slot);
    return { handle, space: slot.space ?? null, state };
  }

  /** The slot was unbound: its unbound scope stays a receipt lookup once it binds (A3 3.7.9). */
  #markUnbound(slot: Slot): void {
    if (slot.wroteUnbound || slot.kind !== "bridge") return;
    slot.wroteUnbound = true;
    this.#updateHandle(slot, { wrote_unbound: true });
  }

  /** A new handle for the slot (A2 3.6.4), making room among the handles no open connection holds. */
  #issue(slot: Slot): string {
    if (this.#handles.size >= MAX_HANDLES) {
      const held = new Set<string | undefined>(
        [...this.#attached].map((s) => this.#handleOf.get(s)),
      );
      const free = [...this.#handles.values()]
        .filter((h) => !held.has(h.hash))
        .sort((a, b) => a.used_at - b.used_at);
      for (const old of free.slice(0, this.#handles.size - MAX_HANDLES + 1)) {
        this.#handles.delete(old.hash);
      }
    }
    const handle = `bh_${randomBytes(16).toString("base64url")}`;
    const now = this.#now();
    const hash = handleHash(handle);
    this.#handles.set(hash, {
      hash,
      instance: slot.instance,
      space: slot.space ?? null,
      session: slot.session?.id ?? null,
      wrote_unbound: slot.wroteUnbound,
      ...(slot.shared ? { shared: true } : {}),
      created_at: now,
      used_at: now,
    });
    this.#handleOf.set(slot, hash);
    this.#dirty = true;
    return handle;
  }

  /** The mcp hook: the slot of a connection whose bind was answered, now open. */
  attach(connection: object): Slot | undefined {
    const slot = this.#slots.get(connection);
    if (slot !== undefined) this.#attached.add(slot);
    return slot;
  }

  /**
   * The connection closed. Its binding stays: its handle resumes it after a restart. An open
   * connection was in use until now, however quiet, so its handle's day starts again here (a
   * service restart closes every connection, and each bridge comes back with its handle).
   */
  closed(slot: Slot): void {
    this.#attached.delete(slot);
    if (slot.session !== undefined) this.#touch(slot.session.id);
    this.#updateHandle(slot, {});
  }

  /** The bridge connections open now, for doctor and tests. */
  open(): readonly Slot[] {
    return [...this.#attached];
  }

  /** The native IDs a bind context's environment carries, kept on the slot. */
  #present(slot: Slot, env: Record<string, unknown>): void {
    for (const [name, source] of Object.entries(NATIVE_ENV)) {
      const value = env[name];
      if (typeof value === "string") this.present(slot, source, value);
    }
  }

  /**
   * A native ID the connection presented: from its bind frame, or a tool call's `_meta.threadId`
   * (A3 3.7.2). Recorded on its session when it binds or is bound (A3 3.7.3). The
   * connection carries another conversation (A3 3.7.5: "the service also marks a connection shared
   * when it sees two different native IDs through it") when it showed another ID of the source
   * before, or its bound session holds IDs of the source and not this one (the first thread of a
   * resumed connection may be another's): it is shared from then on, and the ID joins no session.
   */
  present(slot: Slot, source: NativeSource, id: string): void {
    if (!NATIVE_ID.test(id)) return;
    const held = slot.presented.get(source);
    if (held === id) return;
    const session = slot.session === undefined ? undefined : this.#sessions.get(slot.session.id);
    const theirs = session?.native.filter((n) => n.source === source) ?? [];
    if (held !== undefined || (theirs.length > 0 && !theirs.some((n) => n.id === id))) {
      this.#share(slot);
      return;
    }
    if (slot.presented.size >= MAX_PRESENTED) return;
    slot.presented.set(source, id);
    if (session !== undefined) this.#record(session, slot, {});
  }

  /** The connection carries two conversations: shared from now on, its handle too. */
  #share(slot: Slot): void {
    if (slot.shared) return;
    slot.shared = true;
    this.#updateHandle(slot, { shared: true });
    this.#save(true);
    this.#log({ ev: "binding.shared" });
  }

  /**
   * The slot a tool call acts on, given the native ID the call carries (Codex's `_meta.threadId`,
   * which reaches only tool calls, A3 3.7.2). On a connection that is not shared, rule 3 is read
   * here: an unbound connection whose call carries an ID a launch recorded for one live session of
   * its instance binds to that session, for good. On a shared connection (A3 3.7.5) a call is a
   * session's only when its own ID proves it, and for that call only: the connection's bound
   * session when it holds the ID, else the one session whose launch recorded it. Any other call
   * acts without a binding, so it inherits no task or actor and binds nothing (its launch reference
   * or bind resolves for that call only).
   */
  forCall(slot: Slot, source: NativeSource, id: string | undefined): Slot | undefined {
    if (id !== undefined) this.present(slot, source, id);
    if (!slot.shared) {
      if (id !== undefined && slot.session === undefined && slot.kind === "bridge") {
        this.#byNative(slot, [[source, id]]);
      }
      return slot;
    }
    if (id === undefined || !NATIVE_ID.test(id)) return undefined;
    const session = slot.session === undefined ? undefined : this.#sessions.get(slot.session.id);
    if (session?.native.some((n) => n.source === source && n.id === id) === true) return slot;
    // Per call (A3 3.7.5): the one live session of this instance whose launch recorded the ID.
    const found = this.#nativeSession(slot.instance, [[source, id]]);
    if (found === undefined || !this.#options.homes.may(slot.instance, found.space)) {
      return undefined;
    }
    let bound = found;
    if (found.via === null) {
      // Proven by its launch's own ID: the first agent call makes it its home's.
      bound = this.#claim(found, slot.instance, "native_id");
      this.#sessions.set(bound.id, bound);
      if (!this.#persist()) {
        this.#sessions.set(found.id, found);
        return undefined;
      }
      this.#log({ ev: "binding.bound", via: "native_id" });
      const launch = bound.launches[0];
      if (launch !== undefined) this.#confirmLater(bound.space, launch);
    }
    const call = new Slot({
      kind: "mapped",
      instance: slot.instance,
      origin: slot.origin,
      ...(slot.unboundScope === undefined ? {} : { unboundScope: slot.unboundScope }),
      space: bound.space,
      session: view(bound),
    });
    call.wroteUnbound = slot.wroteUnbound;
    return call;
  }

  /** Rule 1. Returns the handle when it was restored as it is. */
  #resume(slot: Slot, resume: unknown): string | undefined {
    if (resume === undefined || resume === null) return undefined;
    const raw = isObject(resume) ? resume["handle"] : undefined;
    if (typeof raw !== "string" || !HANDLE.test(raw)) {
      this.#ignored("handle", "malformed");
      return undefined;
    }
    const hash = handleHash(raw);
    let found: HandleRecord | undefined;
    for (const record of this.#handles.values()) if (sameHex(record.hash, hash)) found = record;
    if (found === undefined) {
      this.#ignored("handle", "unknown");
      return undefined;
    }
    if (found.instance !== slot.instance) {
      this.#ignored("handle", "instance");
      return undefined;
    }
    const now = this.#now();
    const expired = now - found.used_at >= HANDLE_IDLE_MS || found.used_at - now >= HANDLE_IDLE_MS;
    // The space a handle pinned is the connection's, whatever its bind frame names now.
    if (found.space !== null) slot.space = found.space;
    if (found.wrote_unbound) slot.wroteUnbound = true;
    if (found.shared === true) slot.shared = true;
    if (found.session !== null) {
      const session = this.#sessions.get(found.session);
      if (expired || session === undefined || session.ended_at !== undefined) {
        // A3 3.7.3 "A lost binding": the connection continues unbound, and says why.
        slot.lost = true;
        this.#handles.delete(found.hash);
        this.#log({ ev: "binding.lost" });
        return undefined;
      }
      if (session.via !== null) {
        this.#handleOf.set(slot, found.hash);
        this.#handles.set(found.hash, { ...found, used_at: now });
        this.#bindSlot(slot, session);
        this.#log({ ev: "binding.bound", via: "handle" });
        return raw;
      }
      // A bind that was taken back before an agent bound the session: the handle binds nothing.
      found = { ...found, session: null };
    }
    if (expired) {
      this.#ignored("handle", "expired");
      this.#handles.delete(found.hash);
      return undefined;
    }
    this.#handleOf.set(slot, found.hash);
    this.#handles.set(found.hash, { ...found, used_at: now });
    return raw;
  }

  /**
   * The space an unbound connection pins at its bind (A2 3.7.1): the entry's `--space` when it is a
   * space ID or the name of exactly one served space, else the one space served when its agent home
   * may use it. Otherwise its first allowed call pins it (`pin`).
   */
  #pinAtBind(slot: Slot): void {
    const live = this.#options.spaces().filter((s) => s.state !== "closed" && s.id !== undefined);
    const named = slot.named;
    if (named !== undefined) {
      if (isId(named, "sp")) {
        slot.space = named;
        return;
      }
      const byName = live.filter((s) => s.name?.toLowerCase() === named.toLowerCase());
      if (byName.length === 1) slot.space = byName[0]?.id;
      return;
    }
    // Chosen for it, not named by it: only a space its home may use, so a connection refused the
    // one space served now pins nothing and follows the person's fix (a registration, another
    // space opened as the default) at its first allowed call (ops/grant.ts).
    const only = live.length === 1 ? live[0]?.id : undefined;
    if (only !== undefined && this.#options.homes.may(slot.instance, only)) slot.space = only;
  }

  /**
   * Rule 2: the ticket (A3 3.7.3, A4 3.1). True when it bound the slot. Every refusal is logged and
   * leaves the slot unbound.
   */
  async #ticket(slot: Slot, ticket: unknown): Promise<boolean> {
    if (typeof ticket !== "string") {
      this.#ignored("ticket", "malformed");
      return false;
    }
    const found = this.#options.launches.bridgeTicket(ticket);
    if (found === undefined) {
      // Forged, of another install, of a launch whose agent ended or never started.
      this.#ignored("ticket", "unknown");
      return false;
    }
    if (found.task === null) {
      this.#ignored("ticket", "routine"); // A routine's binds the space (M6).
      return false;
    }
    if (slot.space !== undefined && slot.space !== found.space) {
      this.#ignored("ticket", "space");
      return false;
    }
    const task = found.task;
    return this.#section(`launch:${found.launch}`, () => {
      // Decided on the ticket as it is now, in the launch's section: a redemption queued before
      // this one may have spent it.
      const now = this.#options.launches.bridgeTicket(ticket);
      if (now?.launch !== found.launch) {
        this.#ignored("ticket", "unknown");
        return Promise.resolve(false);
      }
      // A3 3.7.8: a home binds nothing in a space it may not use, so no session is made, the ticket
      // is not spent and the launch records nothing of this connection (A3 has A4 refuse such a
      // launch before dispatch). Asked here, in the section, so a row revoked while this bind
      // waited for it counts.
      if (!this.#options.homes.may(slot.instance, found.space)) {
        this.#ignored("ticket", "grant");
        return Promise.resolve(false);
      }
      const sessions = this.#launchSessions(found.launch);
      const existing = sessions.find((s) => s.ended_at === undefined);
      // Its session ended (the user ended it, or it went stale): the launch binds nothing more.
      if (existing === undefined && sessions.length > 0) {
        this.#ignored("ticket", "ended");
        return Promise.resolve(false);
      }
      // A session is its agent home's (A3 3.7.8): a connection of another instance never acts as
      // it, as with a handle (rule 1), so the session's actor and the home the grant gate checks
      // are one. A session no agent bound yet becomes the home's of the first connection to bind.
      if (existing !== undefined && existing.via !== null && existing.instance !== slot.instance) {
        this.#ignored("ticket", "instance");
        return Promise.resolve(false);
      }
      if (!now.used) {
        if (!now.inWindow) {
          this.#ignored("ticket", "window");
          return Promise.resolve(false);
        }
        // The session on disk first, with this connection's handle naming it, then the role
        // spent: a crash between the two leaves a session its handle or its unspent ticket binds
        // again. A session that cannot be written spends nothing.
        const before = existing;
        const session =
          existing === undefined
            ? this.#newSession(slot, found.space, task, "ticket", [found.launch])
            : this.#claim(existing, slot.instance, "ticket");
        if (session === undefined) {
          this.#ignored("ticket", "unrecorded");
          return Promise.resolve(false);
        }
        this.#sessions.set(session.id, session);
        this.#bindSlot(slot, session);
        const recorded = this.#persist();
        if (!recorded || this.#options.launches.redeemBridge(ticket) === undefined) {
          // Not on disk, or (in no case known) spent meanwhile: nothing of this bind stays.
          this.#takeBack(slot, session, before);
          this.#ignored("ticket", recorded ? "used" : "unrecorded");
          return Promise.resolve(false);
        }
        this.#log({ ev: "binding.bound", via: "ticket" });
        this.#confirmLater(found.space, found.launch);
        return Promise.resolve(true);
      }
      // Presented again (A3 3.7.3): the same session only, when the connection presents a
      // native ID it holds, or no other connection of it is open and the agent still runs.
      if (existing?.via === null || existing === undefined) {
        this.#ignored("ticket", "used");
        return Promise.resolve(false);
      }
      const held = [...slot.presented].some(([source, id]) =>
        existing.native.some((n) => n.source === source && n.id === id),
      );
      const free = !this.#isOpen(existing.id) && this.#options.launches.agentRuns(found.launch);
      if (!held && !free) {
        this.#ignored("ticket", "used");
        return Promise.resolve(false);
      }
      // Answered bound only once the handle naming the session is on disk.
      this.#bindSlot(slot, existing);
      if (!this.#persist()) {
        this.#unbindSlot(slot);
        this.#ignored("ticket", "unrecorded");
        return Promise.resolve(false);
      }
      this.#log({ ev: "binding.bound", via: "ticket" });
      return Promise.resolve(true);
    });
  }

  /**
   * Rule 3 (A3 3.7.3): a native ID that a launch set or received for exactly one live session of
   * the slot's instance binds the slot to it, when its home may use that space and the slot is not
   * pinned to another. The launch of a session no agent bound before records the binding: Claude
   * Code's is confirmed by its preset session (A3 3.7.7). True when it bound the slot.
   */
  #byNative(slot: Slot, ids: readonly (readonly [NativeSource, string])[]): boolean {
    const session = this.#nativeSession(slot.instance, ids);
    if (session === undefined) return false;
    if (!this.#options.homes.may(slot.instance, session.space)) {
      this.#ignored("native", "grant");
      return false;
    }
    if (slot.space !== undefined && slot.space !== session.space) {
      this.#ignored("native", "space");
      return false;
    }
    const claimed = this.#claim(session, slot.instance, "native_id");
    this.#sessions.set(claimed.id, claimed);
    this.#bindSlot(slot, claimed);
    if (!this.#persist()) {
      this.#takeBack(slot, claimed, session);
      this.#ignored("native", "unrecorded");
      return false;
    }
    this.#log({ ev: "binding.bound", via: "native_id" });
    const launch = claimed.launches[0];
    if (session.via === null && launch !== undefined) this.#confirmLater(claimed.space, launch);
    return true;
  }

  /**
   * The one live session that holds one of `ids` as an ID its launch set or received, of
   * `instance` when one is given (a CLI call names none). Two such sessions: none, never a guess.
   */
  #nativeSession(
    instance: string | undefined,
    ids: readonly (readonly [NativeSource, string])[],
  ): SessionRecord | undefined {
    const found = new Set<SessionRecord>();
    for (const session of this.#sessions.values()) {
      if (session.ended_at !== undefined || this.#provisional.has(session.id)) continue;
      // A session is its home's once an agent bound it; one still waiting is the first binder's.
      if (instance !== undefined && session.via !== null && session.instance !== instance) continue;
      const holds = session.native.some(
        (n) =>
          BINDS_ALONE.has(n.trust) &&
          ids.some(([source, id]) => n.source === source && n.id === id),
      );
      if (holds) found.add(session);
    }
    return found.size === 1 ? [...found][0] : undefined;
  }

  // -------------------------------------------------------------------------------------------
  // Through tools (A3 3.7.3)

  redeem(slot: Slot, launch: FoundLaunch): Promise<BindOutcome> {
    return this.#section(slot, () =>
      this.#section(`launch:${launch.id}`, async (): Promise<BindOutcome> => {
        // The grant once more, in the section and before any record is made (A3 3.7.8): the call
        // was admitted before it waited here, and its row may have been revoked meanwhile.
        this.#granted(slot, launch.space);
        const current = this.#current(slot);
        if (current !== undefined) {
          if (!current.launches.includes(launch.id)) {
            return { kind: "already_bound", task: current.task };
          }
          // The same connection again: the same binding. A binding the launch lost the record of
          // (a crash before its report) is recorded again.
          if (launch.boundAt === undefined) this.#confirmLater(launch.space, launch.id);
          return { kind: "bound" };
        }
        if (slot.kind !== "bridge" || slot.shared || launch.task === null) {
          return { kind: "launch_unknown" };
        }
        // This connection asked before and the launch did not answer: the binding it holds now
        // may be the one that request wrote late, recognised by the instant sent with it.
        const handle = this.#handleOf.get(slot);
        const asked = this.#unanswered.get(launch.id);
        const again = asked !== undefined && asked.handle === handle ? asked : undefined;
        const sessions = this.#launchSessions(launch.id);
        // Another connection's (A3 3.7.3), or bound before by a session whose record this
        // machine no longer holds: `launch_used`, with the task to pass instead.
        if (
          sessions.some((s) => s.via !== null) ||
          (launch.boundAt !== undefined && launch.boundAt !== again?.at)
        ) {
          return { kind: "launch_used" };
        }
        // A launch that ended binds nothing: it failed, its agent exited, or the user ended its
        // session before an agent bound it.
        const waiting = sessions.find((s) => s.ended_at === undefined);
        if (
          launch.state === "failed" ||
          launch.exited ||
          (waiting === undefined && sessions.length > 0)
        ) {
          return { kind: "launch_ended" };
        }
        // The session on disk first, with this connection's handle naming it, then the launch's
        // record: a crash between the two leaves a binding the handle restores, and the same
        // connection's next redemption records the launch's evidence again.
        const session =
          waiting === undefined
            ? this.#newSession(slot, launch.space, launch.task, "launch_ref", [launch.id])
            : this.#claim(waiting, slot.instance, "launch_ref");
        if (session === undefined) throw unrecorded();
        this.#sessions.set(session.id, session);
        this.#bindSlot(slot, session);
        if (!this.#persist()) {
          this.#takeBack(slot, session, waiting);
          throw unrecorded();
        }
        // Until the launch answers, a call on the session (this connection's, or one that resumed
        // its handle) waits for the outcome.
        let settle = noop;
        this.#provisional.set(
          session.id,
          new Promise<void>((resolve) => {
            settle = resolve;
          }),
        );
        const settled = (): void => {
          this.#provisional.delete(session.id);
          settle();
        };
        const at = again?.at ?? this.#now();
        let after: LaunchIntent | undefined;
        try {
          after = await this.#options.launches.confirm(launch.space, launch.id, at);
        } catch (error) {
          // The space's store did not answer, and may still write it late. Nothing is bound until
          // it answers: the agent retries (the error says so), and the retry sends this instant.
          if (handle !== undefined) {
            this.#unanswered.delete(launch.id);
            this.#unanswered.set(launch.id, { at, handle });
            if (this.#unanswered.size > MAX_DROPPED) {
              const oldest = this.#unanswered.keys().next().value;
              if (oldest !== undefined) this.#unanswered.delete(oldest);
            }
          }
          this.#takeBack(slot, session, waiting);
          settled();
          throw error;
        }
        this.#unanswered.delete(launch.id);
        const bound = after?.evidence.bound_at;
        if (bound === at) {
          this.#log({ ev: "binding.bound", via: "launch_ref" });
          settled();
          return { kind: "bound" };
        }
        this.#takeBack(slot, session, waiting);
        settled();
        // The launch took no binding: bound before (another session), ended, or never started an
        // agent (a terminal launch no shim claimed: its Brief reached no one).
        if (bound !== undefined) return { kind: "launch_used" };
        return after?.state === "failed" ? { kind: "launch_ended" } : { kind: "launch_unknown" };
      }),
    );
  }

  bindTask(slot: Slot, space: string, task: string): Promise<BindOutcome> {
    return this.#section(slot, (): Promise<BindOutcome> => {
      // As in `redeem`: the grant once more, in the section, before the session is made.
      this.#granted(slot, space);
      const current = this.#current(slot);
      if (current !== undefined) {
        return Promise.resolve(
          current.task === task ? { kind: "bound" } : { kind: "already_bound", task: current.task },
        );
      }
      if (slot.kind !== "bridge" || slot.shared) {
        return Promise.resolve({ kind: "already_bound", task: null });
      }
      const session = this.#newSession(slot, space, task, "task", []);
      if (session === undefined) return Promise.reject(unrecorded());
      this.#sessions.set(session.id, session);
      this.#bindSlot(slot, session);
      if (!this.#persist()) {
        this.#takeBack(slot, session, undefined);
        return Promise.reject(unrecorded());
      }
      this.#log({ ev: "binding.bound", via: "task" });
      return Promise.resolve({ kind: "bound" });
    });
  }

  /**
   * A call on `slot` starts (A3 3.7.4, 3.7.9): it waits while the bind of its session still waits
   * on its launch, finds a slot whose session is gone or ended unbound, and counts a bound call as
   * the session's last use. The call reads the slot's binding after this.
   */
  async use(slot: Slot): Promise<void> {
    for (;;) {
      const id = slot.session?.id;
      const pending = id === undefined ? undefined : this.#provisional.get(id);
      if (pending === undefined) break;
      await pending;
    }
    this.#current(slot);
    if (slot.session !== undefined) this.seen(slot);
    else this.wroteUnbound(slot);
  }

  pin(slot: Slot, space: string): void {
    if (slot.space !== undefined || slot.kind !== "bridge") return;
    slot.space = space;
    this.#updateHandle(slot, { space });
    this.#save(true);
  }

  wroteUnbound(slot: Slot): void {
    if (slot.wroteUnbound || slot.kind !== "bridge") return;
    slot.wroteUnbound = true;
    this.#updateHandle(slot, { wrote_unbound: true });
    this.#save(true);
  }

  seen(slot: Slot): void {
    if (slot.session === undefined) return;
    this.#touch(slot.session.id);
    const hash = this.#handleOf.get(slot);
    const handle = hash === undefined ? undefined : this.#handles.get(hash);
    if (handle !== undefined) this.#handles.set(handle.hash, { ...handle, used_at: this.#now() });
    this.#save(false);
  }

  liveSessions(space: string): ReadonlyMap<string, number> {
    const counts = new Map<string, number>();
    for (const session of this.#sessions.values()) {
      if (session.space !== space || session.task === null || session.ended_at !== undefined) {
        continue;
      }
      if (this.#live(session)) counts.set(session.task, (counts.get(session.task) ?? 0) + 1);
    }
    return counts;
  }

  /**
   * A `cli-agent` call's binding (A3 3.7.4, 3.7.6): its ticket maps to the live session of the
   * ticket's launch, and otherwise a native ID in its environment that a launch set or received
   * (Claude's preset, Codex's matched thread, T3's thread) maps to the one live session holding it.
   * The call acts as that session. The CLI presents the ticket as an identifier and redeems no
   * role: nothing is spent. A session is made with its launch (`launched`), so a call before any
   * bridge bound maps to it.
   */
  mapped(env: Readonly<Record<string, string>>): Slot | undefined {
    let session: SessionRecord | undefined;
    const ticket = env["TASKS_TICKET"];
    const found = ticket === undefined ? undefined : this.#options.launches.bridgeTicket(ticket);
    if (found !== undefined) {
      const live = this.#sessionOfLaunch(found.launch);
      if (live?.space === found.space) session = live;
    }
    if (session === undefined) {
      const ids: [NativeSource, string][] = [];
      for (const [name, source] of Object.entries(NATIVE_ENV)) {
        const value = env[name];
        if (typeof value === "string" && NATIVE_ID.test(value)) ids.push([source, value]);
      }
      session = ids.length === 0 ? undefined : this.#nativeSession(undefined, ids);
    }
    if (session === undefined) return undefined;
    const slot = new Slot({
      kind: "mapped",
      instance: session.instance,
      origin: "cli",
      // An earlier process of this agent's shell may have written before the session existed,
      // as `agent:unknown` (A3 3.7.9: binding later never resets anything): that scope stays a
      // receipt lookup, so its retry replays rather than writing twice.
      unboundScope: principalOf("cli-agent", this.#options.machine).scope,
      space: session.space,
      session: view(session),
    });
    slot.wroteUnbound = true;
    return slot;
  }

  /** The live session of `launch`, if any: one an agent bound, or one waiting for its agent. */
  sessionOfLaunch(launch: string): BoundSession | undefined {
    const session = this.#sessionOfLaunch(launch);
    return session === undefined ? undefined : view(session);
  }

  // -------------------------------------------------------------------------------------------
  // The session list and the user's changes (A3 3.7.3 "Rebinding", A4 3.10)

  /**
   * The sessions of a task, newest first (`task.get`'s sessions section): IDs, words and times,
   * and whether Resume is offered. No native ID, folder or launch leaves here.
   */
  sessionsOf(space: string, task: string): readonly SessionRow[] {
    return [...this.#sessions.values()]
      .filter((s) => s.space === space && s.task === task)
      .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1))
      .slice(0, LISTED_SESSIONS)
      .map((s) => ({
        id: s.id,
        state:
          s.ended_at !== undefined
            ? "ended"
            : s.via === null
              ? "opening"
              : this.#live(s)
                ? "live"
                : "unknown",
        instance: s.instance,
        ...(s.via === null ? {} : { via: s.via }),
        ...(s.route === undefined ? {} : { route: s.route }),
        ...(s.untracked === true ? { untracked: true } : {}),
        started: iso(s.created_at),
        last_seen: iso(s.seen_at),
        ...(s.ended_at === undefined ? {} : { ended: iso(s.ended_at) }),
        ...(s.end_reason === undefined ? {} : { end_reason: s.end_reason }),
        resume: this.#resumable(s),
      }));
  }

  /**
   * Resume (A4 3.10) is offered only with a native ID Tasks trusts, of the source its launch's
   * target resumes by, and an instance that exists here: an ID the launch set or received, or one
   * the connection that bound through the launch presented. Never one a connection merely showed,
   * never by folder and time.
   */
  #resumable(session: SessionRecord): boolean {
    const id = session.opened_with;
    if (id === undefined) return false;
    const instance = (this.#options.instances?.() ?? []).find((i) => i.id === id && i.enabled);
    const source = instance === undefined ? undefined : RESUMES[instance.target];
    if (source === undefined) return false;
    return session.native.some((n) => n.source === source && n.trust !== "presented");
  }

  /** A session as the user's commands name it, or undefined. */
  session(id: string): BoundSession | undefined {
    const found = this.#sessions.get(id);
    return found === undefined ? undefined : view(found);
  }

  /**
   * The user ends a session (A3 3.7.3, `session.end`): its record ends, its open connections are
   * unbound and say their session ended (`lost`), and its handles answer `lost` at their next
   * bind. Its launch's ticket binds it no more. The agent may go on unbound.
   */
  async end(id: string): Promise<SessionChange> {
    await this.#settledBind(id);
    return this.#endWith(id, "user");
  }

  /**
   * The user unbinds a session (`session.unbind`): it ends, and its open connections and their
   * handles go on unbound, quietly: they keep their space and may bind again.
   */
  async unbind(id: string): Promise<SessionChange> {
    await this.#settledBind(id);
    return this.#endWith(id, "unbound");
  }

  /**
   * A user's change applies to a settled binding, as a call reads one (`use`): while a bind of the
   * session through its launch reference waits on the launch's answer, the change waits too, so a
   * bind taken back afterwards never writes back the session as it was before the change.
   */
  async #settledBind(id: string): Promise<void> {
    for (;;) {
      const pending = this.#provisional.get(id);
      if (pending === undefined) return;
      await pending;
    }
  }

  #endWith(id: string, reason: "user" | "unbound"): SessionChange {
    const session = this.#sessions.get(id);
    if (session === undefined) return { kind: "not_found" };
    if (session.ended_at !== undefined) return { kind: "no_change", session: id };
    this.#sessions.set(id, { ...session, ended_at: this.#now(), end_reason: reason });
    for (const slot of this.#attached) {
      if (slot.session?.id !== id) continue;
      if (reason === "user") {
        // Its handle still names the ended session, so a reconnect hears `lost` too.
        slot.session = undefined;
        slot.lost = true;
      } else {
        this.#unbindSlot(slot);
      }
      this.#markUnbound(slot);
    }
    if (reason === "unbound") {
      for (const handle of [...this.#handles.values()]) {
        if (handle.session === id) {
          this.#handles.set(handle.hash, { ...handle, session: null, wrote_unbound: true });
        }
      }
    }
    this.#dirty = true;
    this.#persist();
    this.#log({ ev: "binding.ended", reason });
    return { kind: "changed", session: id };
  }

  /**
   * The user rebinds a session to another task of its space (`session.rebind`): the session ends,
   * and a new one on that task takes its place, with its launches, native IDs and instance: its
   * open connections and their handles are bound to the new one. A session on that task already
   * is no change. `task` must be a task of the session's space (the caller resolved it there).
   */
  async rebind(id: string, task: string): Promise<SessionChange> {
    await this.#settledBind(id);
    const session = this.#sessions.get(id);
    if (session === undefined) return { kind: "not_found" };
    if (session.ended_at !== undefined) return { kind: "ended", session: id };
    if (session.task === task) return { kind: "no_change", session: id };
    if (!this.#room(1)) throw unrecorded();
    const now = this.#now();
    const next: SessionRecord = {
      ...session,
      id: newId("se"),
      task,
      // One no agent bound yet stays waiting for its agent, now on the other task.
      via: session.via === null ? null : "rebind",
      created_at: now,
      seen_at: now,
    };
    this.#sessions.set(id, { ...session, ended_at: now, end_reason: "rebound" });
    this.#sessions.set(next.id, next);
    for (const slot of this.#attached) {
      if (slot.session?.id === id) slot.session = view(next);
    }
    for (const handle of [...this.#handles.values()]) {
      if (handle.session === id) this.#handles.set(handle.hash, { ...handle, session: next.id });
    }
    this.#dirty = true;
    this.#persist();
    this.#log({ ev: "binding.ended", reason: "rebound" });
    return { kind: "changed", session: id, next: next.id };
  }

  // -------------------------------------------------------------------------------------------
  // Records

  /**
   * The slot's session while it lives. A slot whose session ended (or whose record is gone) is
   * unbound and lost: its handle still names the session, so a reconnect hears `lost` too. One
   * whose session a bind took back (its launch did not take it, or no agent bound it), or that
   * the user unbound, is unbound, not lost.
   */
  #current(slot: Slot): SessionRecord | undefined {
    const id = slot.session?.id;
    if (id === undefined) return undefined;
    const session = this.#sessions.get(id);
    // A CLI call maps to a session its agent has not bound yet (A3 3.7.7); a connection holds
    // only one an agent bound.
    if (
      session !== undefined &&
      session.ended_at === undefined &&
      (session.via !== null || slot.kind === "mapped")
    ) {
      return session;
    }
    const quiet =
      this.#dropped.has(id) ||
      (session !== undefined &&
        (session.ended_at === undefined || session.end_reason === "unbound"));
    if (quiet) {
      this.#unbindSlot(slot);
    } else {
      slot.session = undefined;
      slot.lost = true;
    }
    this.wroteUnbound(slot);
    return undefined;
  }

  /** Every session of `launch`, oldest first. */
  #launchSessions(launch: string): SessionRecord[] {
    return [...this.#sessions.values()].filter((s) => s.launches.includes(launch));
  }

  /** The live session of `launch`: bound, or waiting for its agent. */
  #sessionOfLaunch(launch: string): SessionRecord | undefined {
    return this.#launchSessions(launch).find((s) => s.ended_at === undefined);
  }

  #isOpen(session: string): boolean {
    for (const slot of this.#attached) if (slot.session?.id === session) return true;
    return false;
  }

  /** Whether something keeps the session alive: an open connection bound to it, or its agent. */
  #live(session: SessionRecord): boolean {
    return (
      this.#isOpen(session.id) ||
      this.#provisional.has(session.id) ||
      session.launches.some((launch) => this.#options.launches.agentRuns(launch))
    );
  }

  /**
   * Room for `count` more sessions within MAX_SESSIONS: ended records go first, oldest first, then
   * the least recently seen of those nothing keeps alive. A live session is never removed: false
   * when only live ones are left.
   */
  #room(count: number): boolean {
    const over = this.#sessions.size + count - MAX_SESSIONS;
    if (over <= 0) return true;
    const order = [...this.#sessions.values()]
      .filter((s) => s.ended_at !== undefined || !this.#live(s))
      .sort(
        (a, b) =>
          (a.ended_at === undefined ? 1 : 0) - (b.ended_at === undefined ? 1 : 0) ||
          (a.ended_at ?? a.seen_at) - (b.ended_at ?? b.seen_at),
      );
    for (const old of order.slice(0, over)) this.#sessions.delete(old.id);
    this.#dirty = true;
    return this.#sessions.size + count <= MAX_SESSIONS;
  }

  /** A new session record for the slot, not yet kept, or undefined when there is no room. */
  #newSession(
    slot: Slot,
    space: string,
    task: string,
    via: Via,
    launches: readonly string[],
  ): SessionRecord | undefined {
    if (!this.#room(1)) return undefined;
    const now = this.#now();
    return {
      id: newId("se"),
      space,
      task,
      instance: slot.instance,
      via,
      launches: launches.slice(0, MAX_LAUNCHES),
      native: [],
      created_at: now,
      seen_at: now,
    };
  }

  /**
   * A session as the first agent connection binds it: a session made with its launch and bound by
   * no agent yet takes the connection's instance (its home, A3 3.7.8) and how it bound. A session
   * bound before stays as it is.
   */
  #claim(session: SessionRecord, instance: string, via: Via): SessionRecord {
    if (session.via !== null) return session;
    // An agent bound it: it is tracked from now on.
    const claimed: { -readonly [K in keyof SessionRecord]: SessionRecord[K] } = {
      ...session,
      instance,
      via,
    };
    delete claimed.untracked;
    return claimed;
  }

  /** Binds the slot to `session`: its handle names it, and the native IDs the slot holds join it. */
  #bindSlot(slot: Slot, session: SessionRecord): void {
    slot.session = view(session);
    slot.space = session.space;
    slot.lost = false;
    this.#updateHandle(slot, { session: session.id, space: session.space });
    this.#record(session, slot, { seen_at: this.#now() });
  }

  #unbindSlot(slot: Slot): void {
    slot.session = undefined;
    this.#updateHandle(slot, { session: null });
  }

  /**
   * A binding that did not take: a session made for it goes again, and one that waited for its
   * agent (`before`) is as it was; every open slot bound to it (a reconnect may have resumed the
   * handle meanwhile) is unbound. A slot not open yet finds it at its next call (`#current`).
   */
  #takeBack(slot: Slot, session: SessionRecord, before: SessionRecord | undefined): void {
    this.#unbindSlot(slot);
    this.#markUnbound(slot);
    for (const other of this.#attached) {
      if (other.session?.id !== session.id) continue;
      this.#unbindSlot(other);
      this.#markUnbound(other);
    }
    if (before === undefined) {
      this.#dropped.add(session.id);
      if (this.#dropped.size > MAX_DROPPED) {
        const oldest = this.#dropped.values().next().value;
        if (oldest !== undefined) this.#dropped.delete(oldest);
      }
      this.#sessions.delete(session.id);
    } else if (before.via === null) {
      // As it was, with any ID its launch recorded meanwhile (`launched`), not this slot's.
      const now = this.#sessions.get(before.id);
      const learned = (now?.native ?? []).filter((n) => BINDS_ALONE.has(n.trust));
      this.#sessions.set(before.id, this.#joined(before, learned));
    }
    // A session an agent bound before this call stays: only this binding goes.
    this.#dirty = true;
    this.#save(true);
  }

  /** `session` with `learned` joined: a native ID keeps the strongest trust it was recorded with. */
  #joined(session: SessionRecord, learned: readonly NativeRecord[]): SessionRecord {
    let native = session.native;
    for (const entry of learned) {
      const at = native.findIndex((n) => n.source === entry.source && n.id === entry.id);
      if (at >= 0) {
        const held = native[at];
        if (held !== undefined && RANK[entry.trust] > RANK[held.trust]) {
          native = native.map((n, i) => (i === at ? entry : n));
        }
      } else if (native.length < MAX_NATIVE) {
        native = [...native, entry];
      }
    }
    return native === session.native ? session : { ...session, native };
  }

  /**
   * The session with the slot's native IDs joined and `changes` applied. An ID a connection
   * presented is `bridge` when the session was bound through its launch (its ticket, reference or
   * native ID, or a rebind of such a session) and the connection is not shared, else `presented`.
   */
  #record(session: SessionRecord, slot: Slot, changes: Partial<SessionRecord>): void {
    const trust: Trust =
      !slot.shared && session.via !== null && session.via !== "task" ? "bridge" : "presented";
    const joined = this.#joined(
      session,
      [...slot.presented].map(([source, id]) => ({ source, id, trust })),
    );
    const next: SessionRecord = { ...joined, ...changes };
    this.#sessions.set(session.id, next);
    this.#dirty = true;
    if (slot.session?.id === session.id) slot.session = view(next);
  }

  #touch(session: string): void {
    const record = this.#sessions.get(session);
    if (record === undefined) return;
    this.#sessions.set(session, { ...record, seen_at: this.#now() });
    this.#dirty = true;
  }

  #updateHandle(slot: Slot, changes: Partial<HandleRecord>): void {
    const hash = this.#handleOf.get(slot);
    const handle = hash === undefined ? undefined : this.#handles.get(hash);
    if (handle === undefined) return;
    this.#handles.set(handle.hash, { ...handle, ...changes, used_at: this.#now() });
    this.#dirty = true;
  }

  /**
   * Records that the launch's binding is the bridge's, in the space (A4 3.9.1), without
   * holding up the bind frame, whose client waits 5 s at most: the ticket alone decided the
   * binding, and the launch's evidence follows. A failure is logged; the session stays bound.
   */
  #confirmLater(space: string, launch: string): void {
    this.#options.launches.confirm(space, launch, this.#now()).then(
      () => undefined,
      () => {
        this.#log({ ev: "binding.report_failed" });
      },
    );
  }

  /**
   * Ends quiet sessions and forgets old records (at most once a minute). A session ends after a
   * day with no open connection, no running agent and no call (`idle`); one made with its launch
   * that no agent bound, after 7 such days (`stale`). Its record stays a month.
   */
  #prune(): void {
    const now = this.#now();
    if (now - this.#prunedAt < SEEN_WRITE_MS && this.#prunedAt !== 0) return;
    this.#prunedAt = now;
    for (const session of [...this.#sessions.values()]) {
      if (session.ended_at !== undefined) {
        if (now - session.ended_at >= SESSION_KEEP_MS) {
          this.#sessions.delete(session.id);
          this.#dirty = true;
        }
        continue;
      }
      const limit = session.via === null ? SESSION_STALE_MS : SESSION_IDLE_MS;
      const idle = now - session.seen_at >= limit;
      if (!idle || this.#isOpen(session.id)) continue;
      if (session.launches.some((launch) => this.#options.launches.agentRuns(launch))) continue;
      this.#sessions.set(session.id, {
        ...session,
        ended_at: now,
        end_reason: session.via === null ? "stale" : "idle",
      });
      this.#dirty = true;
    }
    const held = new Set([...this.#attached].map((s) => this.#handleOf.get(s)));
    for (const handle of [...this.#handles.values()]) {
      if (now - handle.used_at >= HANDLE_KEEP_MS && !held.has(handle.hash)) {
        this.#handles.delete(handle.hash);
        this.#dirty = true;
      }
    }
    // Bounded (records an earlier build wrote past the limits): never a live session (`#room`).
    this.#room(0);
  }

  /**
   * Writes the records now. False when the store could not take them: logged, and tried again
   * with the next change. A bind that must outlive a restart is answered only after a true.
   */
  #persist(): boolean {
    try {
      this.#options.store.save({
        sessions: [...this.#sessions.values()],
        handles: [...this.#handles.values()],
      });
      this.#dirty = false;
      this.#savedAt = this.#now();
      return true;
    } catch {
      this.#dirty = true;
      this.#log({ ev: "binding.store_failed" });
      return false;
    }
  }

  /**
   * Writes the records at once when `now`, else when the last write is a minute old: for what may
   * be behind after a crash (last-seen times, a new handle, a pinned space). A failed write stays
   * in memory and is logged.
   */
  #save(now: boolean): void {
    if (!now && !(this.#dirty && this.#now() - this.#savedAt >= SEEN_WRITE_MS)) return;
    this.#persist();
  }

  /** Writes what changed since the last write (a stop). */
  flush(): void {
    if (this.#dirty) this.#save(true);
  }

  /** Runs `fn` after every earlier call in the same section has ended. */
  #section<T>(key: unknown, fn: () => Promise<T>): Promise<T> {
    const before = this.#sections.get(key) ?? Promise.resolve();
    const run = before.then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.#sections.set(key, settled);
    void settled.then(() => {
      if (this.#sections.get(key) === settled) this.#sections.delete(key);
    });
    return run;
  }

  /**
   * Throws the grant refusal (ops/grant.ts) unless the slot's agent home may use `space` now: a bind
   * through a tool records nothing for a home whose row was revoked while its call waited.
   */
  #granted(slot: Slot, space: string): void {
    if (!this.#options.homes.may(slot.instance, space)) throw grantRefused();
  }

  #ignored(input: "ticket" | "handle" | "native", reason: Ignored): void {
    this.#log({ ev: "binding.ignored", input, reason });
  }

  #log(event: BindingEvent): void {
    try {
      this.#options.log?.(event);
    } catch {
      // A log line never breaks a binding.
    }
  }
}
