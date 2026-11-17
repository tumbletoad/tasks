// Session binding as the request path sees it (A3 3.7, M2.04). A connection that can hold a
// binding carries one Slot for its life: an MCP connection (the bridge's, A3 3.7.3) and a `cli-agent`
// call whose ticket maps to a live session (A3 3.7.4, "redeems no role"). The binding service
// (binding/) decides every change of a slot, from what the connection presented in its
// authenticated bind frame and from what the service itself issued (the ticket, the launch
// reference, the binding handle); the request path only reads it:
//
// - the principal: a bound slot writes as its session, `agent:<instance>:<session>` with the
//   session's writer scope (A3 3.7.4, 3.7.9), computed from the slot, never from input;
// - the space: a bound slot's calls go to its session's space, an unbound one's to the space it
//   pinned at bind (A2 3.7.1, A3 3.7.8), never to whatever a UI tab shows;
// - the task a call defaults to: the bound task (A3 3.4.1).
//
// A connection without a slot (the UI, the CLI's other classes) never binds: `get_task {launch}`
// and `{bind: true}` resolve for that call only and say `bound: false` (A3 3.7.5's rule for a
// connection that cannot hold a binding), so a one-shot CLI command never uses up a reference.
/** A session a slot is bound to (A3 3.7, A4 3.10): the parts the request path reads. */
export interface BoundSession {
  /** `se_` ID. */
  readonly id: string;
  /** The space it is pinned to for its whole life (`sp_` ID). */
  readonly space: string;
  /** The task it is bound to (`t_` ID); null for a routine's (M6). */
  readonly task: string | null;
  /** The instance whose connection bound it: part of its actor. */
  readonly instance: string;
  /** The launches it was bound through (`la_` IDs), first open first. */
  readonly launches: readonly string[];
}

/** A background run's ID: a session a run's ticket bound names its run among its launches. */
const RUN_ID = /^ru_[0-7][0-9a-hjkmnp-tv-z]{25}$/;

/** The background run a session acts for, when a run's ticket bound it. */
export const runOf = (session: Pick<BoundSession, "launches"> | undefined): string | undefined =>
  session?.launches.find((id) => RUN_ID.test(id));

/** Where a native session ID came from (A3 3.7.2). Recorded, never used to bind before M4.06. */
export const NATIVE_SOURCES = ["claude", "t3", "codex"] as const;
export type NativeSource = (typeof NATIVE_SOURCES)[number];

/** A native ID: the shape A4's evidence IDs have, so it never holds text (A4 3.9.1). */
export const NATIVE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** At most this many native IDs per connection: a shared host shows two (A3 3.7.5). */
export const MAX_PRESENTED = 4;

/**
 * One connection's binding. The binding service sets every field; the request path reads them.
 * `kind`: a bridge connection can bind (A3 3.7.3); a `mapped` CLI call is its session's for that
 * call and binds nothing new.
 */
export class Slot {
  readonly kind: "bridge" | "mapped";
  /** The instance of the agent home the connection names (its entry's `--instance`), or `manual`. */
  readonly instance: string;
  /** How a write of this connection reaches history (A1's commit origin). */
  readonly origin: "mcp" | "cli";
  /** The writer scope of the connection while unbound (A3 3.7.9). */
  readonly unboundScope: string | undefined;
  /** The entry's `--space` (an ID or a name), for a space not pinned yet. */
  readonly named: string | undefined;
  /** The space this connection's calls use, pinned at bind or at its first call. */
  space: string | undefined;
  session: BoundSession | undefined;
  /** A binding this connection had ended (`binding_lost`, A3 3.7.3): unbound calls say so. */
  lost = false;
  /** It wrote unbound: that scope stays a second receipt lookup once it binds (A3 3.7.9). */
  wroteUnbound = false;
  /**
   * It carries two conversations: two different native IDs of one source came through it (A3
   * 3.7.5). A call acts as its bound session only when the call's own ID proves that session, and
   * no call binds it any more.
   */
  shared = false;
  /** Native IDs the connection presented, by source (A3 3.7.3: recorded at a later bind). */
  readonly presented = new Map<NativeSource, string>();
  /**
   * The bridge's working folder as its bind frame said. It binds nothing: only a best-effort app's
   * launch is confirmed by it, when it is the folder the launch's link named (A4 3.4.4).
   */
  readonly folder: string | undefined;

  constructor(options: {
    kind: "bridge" | "mapped";
    instance: string;
    origin: "mcp" | "cli";
    unboundScope?: string;
    named?: string;
    space?: string;
    session?: BoundSession;
    folder?: string;
  }) {
    this.kind = options.kind;
    this.instance = options.instance;
    this.origin = options.origin;
    this.unboundScope = options.unboundScope;
    this.named = options.named;
    this.folder = options.folder;
    this.space = options.space;
    this.session = options.session;
  }
}

/** A launch as a reference finds it in the connection's space (A3 3.7.3). */
export interface FoundLaunch {
  /** `la_` ID. */
  readonly id: string;
  readonly reference: string;
  readonly space: string;
  /** Its task (`t_` ID), or null for a routine's launch (M6). */
  readonly task: string | null;
  /** The task's reference, such as M-14, for error data. */
  readonly taskRef: string | undefined;
  readonly state: string;
  readonly route: string;
  /** Whether the bridge's binding is recorded on it already (evidence `bound_at`). */
  readonly boundAt: number | undefined;
  /** The agent's exit code is recorded: its agent has ended. */
  readonly exited: boolean;
}

/**
 * What a bind asked through a tool came to: bound (this call bound, or the connection was bound to
 * it already), or a refusal the handler words with the task references it can read.
 */
export type BindOutcome =
  | { readonly kind: "bound" }
  | { readonly kind: "already_bound"; readonly task: string | null }
  | { readonly kind: "launch_used" }
  | { readonly kind: "launch_ended" }
  | { readonly kind: "launch_unknown" };

/** The binding service, as the request path calls it (binding/bindings.ts implements it). */
export interface BindingPort {
  /**
   * `get_task {launch}` on a connection with a slot (A3 3.7.3): the first redemption binds
   * the slot to the launch's session; the same connection again gets the same binding; another
   * connection gets `launch_used`. Throws a AppError the store's failure maps to.
   */
  redeem(slot: Slot, launch: FoundLaunch): Promise<BindOutcome>;
  /** `get_task {task, bind: true}` (step 6): an ad-hoc session on the task, bound to the slot. */
  bindTask(slot: Slot, space: string, task: string): Promise<BindOutcome>;
  /** The slot's space, pinned at its first call when its bind frame could not name one. */
  pin(slot: Slot, space: string): void;
  /**
   * A call on the slot starts. It waits while its session's bind still waits on a launch, leaves
   * the slot unbound when its session is gone or ended, and records a bound call as the session's
   * last use (A3 3.7.7 `session.call`). The call reads the slot's binding after this.
   */
  use(slot: Slot): Promise<void>;
  /**
   * Whether the slot holds a live session once a bind in progress on it has settled, read without
   * recording anything: for a call refused before it may act (`run_report` outside a run, A3
   * 3.4.12), which leaves no trace, not even a last use.
   */
  holds(slot: Slot): Promise<boolean>;
  /** How many live sessions each task of the space has (A3 3.4.2 `live_sessions`). */
  liveSessions(space: string): ReadonlyMap<string, number>;
}
