// T3 Code's primary route, `t3-mcp` (A4 3.4.1, L6, L14): Tasks as a paired MCP client of the local
// T3 server. A launch binds the task's exact folder to a T3 project (t3-binding.ts), creates an
// idle thread with `t3_thread_launch` and no message, keyed by the launch ID as `clientRequestId`
// under the grant recorded on the intent, checks the thread's folder, and opens the thread link
// with the brief as an unsent draft.
//
// The route is the launch machine's T3 step and recovery (A4 3.9.1): `dispatch`
// is the machine's external call after Dispatching is durable, `grant` and `replay` its recovery
// steps. The machine decides; the route only answers what T3 said:
// - A definite refusal (nothing reached T3, a 401, a request T3 refused before any tool ran) is
//   `refused`: Failed. A 401 also marks the pairing "Reconnect T3".
// - Everything else that is not a thread (no answer, a cut connection, an unreadable answer, a
//   tool error, which T3's own guidance says to repeat with the same key) is `unknown`: the machine
//   repeats once with the same key, under the same grant only.
// - `replay` sends only while the pairing still holds the intent's grant, read and compared
//   synchronously right before the request leaves with that pairing's token. After a re-pairing it
//   sends nothing and answers `refused`, which the machine records as Unknown.
//
// Machine state (t3-state.ts) holds the pairing, the "Not now" answers and each launch's plan; the
// plan is written before Dispatching, so the repeat after a restart sends the same call.
import { PRODUCT_NAME, CLI_NAME } from "@ttasks/brand";
import type { Permission } from "./catalogue.ts";
import { EVIDENCE_ID } from "./intents.ts";
import type { DispatchOutcome, Observation } from "./machine.ts";
import type { FolderIdentity } from "./places.ts";
import type { Instance } from "./sections.ts";
import type { LaunchIntent } from "./store.ts";
import { bindFolder, identityAt, type BindFolder, type T3Project } from "./t3-binding.ts";
import {
  certainNothingDone,
  readT3Origin,
  T3Error,
  T3Mcp,
  type Fetch,
  type T3Target,
} from "./t3-client.ts";
import { beginPairing, refreshGrant, type Grant, type PairingAttempt } from "./t3-oauth.ts";
import {
  newGrantId,
  NOT_NOW_MS,
  notNowUntil,
  readPairing,
  readPlan,
  REFRESH_KEEPS_GRANT,
  rememberNotNow,
  writePairing,
  writePlan,
  type T3Files,
  type T3Pairing,
  type T3Plan,
  type T3Strategy,
} from "./t3-state.ts";

/** Why the T3 route cannot open a task now. Each has a line for people (T3_TEXT). */
export type T3Unavailable =
  /** TTasks is not paired with this machine's T3. */
  | "not_paired"
  /** No T3 server answers: the desktop app is closed, or the service is down. */
  | "not_running"
  /** T3 refused the token (401), or it ran out without a refresh: pair again. */
  | "reconnect"
  /** T3 answered, but not in a way that tells: try again. */
  | "no_answer"
  /** The folder is no T3 project root or worktree, and the person chose Not now. */
  | "not_registered"
  /** The instance names a T3 provider instance without a model; T3 needs both together. */
  | "model_required"
  // The CLI fallback route (t3-cli.ts, A4 3.4.1 "Fallback route"):
  /** The instance names a model without a provider instance: the CLI takes both or neither. */
  | "provider_required"
  /** The instance's provider instance or model cannot be passed to T3's command line as it is. */
  | "invalid_instance"
  /** Not paired, and the instance names no `t3` command (`exec`). */
  | "no_cli"
  /** The instance's `t3` command cannot be run as TTasks runs it (its `.cmd` shim, its home). */
  | "cli_unusable"
  /** The folder is an existing worktree: only the paired route attaches one. */
  | "worktree_needs_pairing"
  /** The instance asks for a mode T3's command line cannot set: only the paired route can. */
  | "mode_needs_pairing"
  /** The brief does not fit the route. */
  | "too_long"
  /** The bound folder, or the project root T3 holds for it, is another folder now. */
  | "folder_changed";

/** A4 3.18's lines, for the UI and the CLI. */
export const T3_TEXT = {
  not_paired: `Pair ${PRODUCT_NAME} with T3 Code first: ${CLI_NAME} setup t3`,
  not_running: "Start T3 Code",
  reconnect: "Reconnect T3",
  no_answer: "T3 Code did not answer. Try again.",
  not_registered: "T3 opens only registered folders.",
  model_required: "Set t3_model for this instance: T3 takes a provider instance with its model.",
  provider_required:
    "Set t3_provider_instance for this instance: T3's command line takes a model with its provider instance.",
  invalid_instance:
    "This instance's t3_provider_instance or t3_model cannot be passed to T3's command line.",
  no_cli: `Pair ${PRODUCT_NAME} with T3 Code first: ${CLI_NAME} setup t3`,
  cli_unusable: `T3's command line cannot be run from ${PRODUCT_NAME}. Pair with T3 Code instead: ${CLI_NAME} setup t3`,
  worktree_needs_pairing: `This folder is a git worktree. Pair ${PRODUCT_NAME} with T3 Code to open it there: ${CLI_NAME} setup t3`,
  mode_needs_pairing: `T3's command line cannot set this instance's permission. Pair ${PRODUCT_NAME} with T3 Code: ${CLI_NAME} setup t3`,
  too_long: "The brief is too long for T3 Code.",
  folder_changed: "The task's folder changed. Open the task again.",
  register: (name: string) => `Register ${name} as a T3 project?`,
  folder_mismatch: "T3 bound a different folder.",
  regranted: (thread: string) =>
    `${PRODUCT_NAME} re-paired with T3 before this launch settled. Check T3 for a thread named ${thread}.`,
} as const;

/** Whether T3 can be used now, from machine state and T3's runtime file alone (no request). */
export type T3Availability =
  | { readonly state: "ready"; readonly expiresAt?: number; readonly pairedAt: number }
  | { readonly state: "not_paired" | "not_running" | "reconnect" };

/** The result of the Prepared step for T3 (A4 3.4.1 steps 1 to 4). */
export type T3Prepared =
  | { readonly kind: "bound"; readonly projectId: string; readonly strategy: T3Strategy }
  /** "Register <name> as a T3 project?" with Register and Not now. */
  | { readonly kind: "ask"; readonly question: "register"; readonly text: string }
  | { readonly kind: "unavailable"; readonly reason: T3Unavailable };

/** A4 3.2: an instance's permission as T3's runtime mode. `inherit` sends none. */
export const T3_RUNTIME_MODES: Readonly<Record<Permission, string | undefined>> = {
  inherit: undefined,
  "full-access": "full-access",
  "auto-edit": "auto-accept-edits",
  // T3 has no read-only mode: every change waits for an approval.
  "read-only": "approval-required",
};

/** A thread link's brief may hold this many characters (A4 3.4.1: T3's limit is 8,000). */
export const T3_PROMPT_LIMIT = 8_000;

/** A refresh is due this long before the token runs out. */
const REFRESH_MARGIN_MS = 60_000;
/** At most this many pages of projects are read. */
const MAX_PAGES = 50;
const PAGE = 100;

export interface T3RouteOptions {
  /** T3's home folder (`~/.t3`, or T3CODE_HOME), or undefined when it is not known. */
  readonly home: string | undefined;
  /** Machine state (t3-state.ts). */
  readonly files: T3Files;
  /** Opens a URL through the OS (A4 3.6.5): true when the opener accepted it. M2.09's opener. */
  readonly open?: (url: string) => Promise<boolean>;
  readonly fetch?: Fetch;
  readonly now?: () => number;
  readonly platform?: NodeJS.Platform;
  /** Each request to T3. Default T3_REQUEST_MS. */
  readonly requestMs?: number;
  /** The person's approval when pairing. Default PAIR_DEADLINE_MS. */
  readonly pairDeadlineMs?: number;
}

/** A prepared launch's input for its plan: what the Prepared step decided, and the instance. */
export interface T3PlanInput {
  readonly projectId: string;
  readonly strategy: T3Strategy;
  /** `<task reference> <sanitised title>`, the thread's title. No control characters. */
  readonly title: string;
  readonly instance: Pick<Instance, "openPermission" | "t3">;
  /** The resolved folder's identity, for the folder check. */
  readonly folder: FolderIdentity;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A failure while preparing, as the reason the route is unavailable. */
function unavailableFor(error: unknown): T3Unavailable {
  if (!(error instanceof T3Error)) return "no_answer";
  if (error.failure === "unauthorized") return "reconnect";
  if (error.failure === "unreachable") return "not_running";
  return "no_answer";
}

export class T3Route {
  readonly #options: T3RouteOptions;
  readonly #mcp: T3Mcp;
  readonly #now: () => number;
  readonly #platform: NodeJS.Platform;
  #refreshing: Promise<unknown> = Promise.resolve();

  constructor(options: T3RouteOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#platform = options.platform ?? process.platform;
    this.#mcp = new T3Mcp({
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.requestMs === undefined ? {} : { requestMs: options.requestMs }),
    });
  }

  /** The pairing as machine state holds it. */
  pairing(): T3Pairing | undefined {
    return readPairing(this.#options.files);
  }

  /** Whether T3's server runs, as its runtime file says: no request. False: "Start T3 Code". */
  async running(): Promise<boolean> {
    const home = this.#options.home;
    return home !== undefined && (await readT3Origin(home, this.#platform)).status === "ok";
  }

  /** Whether T3 can be used now: machine state and T3's runtime file, no request. */
  async availability(): Promise<T3Availability> {
    const pairing = this.pairing();
    if (pairing === undefined) return { state: "not_paired" };
    if (pairing.reconnect) return { state: "reconnect" };
    if (this.#options.home === undefined) return { state: "not_running" };
    const origin = await readT3Origin(this.#options.home, this.#platform);
    if (origin.status !== "ok") return { state: "not_running" };
    return {
      state: "ready",
      pairedAt: pairing.pairedAt,
      ...(pairing.expiresAt === undefined ? {} : { expiresAt: pairing.expiresAt }),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Pairing (`ttasks setup t3`)

  /** Starts a pairing attempt with this machine's T3: its URL goes to the person's browser. */
  async beginPairing(): Promise<PairingAttempt> {
    const origin = await this.#origin();
    return beginPairing({
      origin,
      ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
      now: this.#now,
      ...(this.#options.requestMs === undefined ? {} : { requestMs: this.#options.requestMs }),
      ...(this.#options.pairDeadlineMs === undefined
        ? {}
        : { deadlineMs: this.#options.pairDeadlineMs }),
    });
  }

  /**
   * Waits for the person's approval and keeps the grant with a new grant ID (A4 3.4.1 "Grant
   * identity"): a re-pairing always starts a new one. Then reads T3's environment ID once.
   */
  async finishPairing(
    attempt: PairingAttempt,
  ): Promise<{ readonly replaced: boolean; readonly expiresAt?: number }> {
    const grant = await attempt.wait();
    const replaced = this.pairing() !== undefined;
    const pairing = this.#keep(grant, newGrantId());
    try {
      const target = { origin: await this.#origin(), token: pairing.accessToken };
      const env = (await this.#mcp.call(target, "t3_environment_read", {}))["environmentId"];
      if (typeof env === "string" && EVIDENCE_ID.test(env)) {
        // Only while the pairing is still this one.
        const now = this.pairing();
        if (now?.grant === pairing.grant)
          writePairing(this.#options.files, { ...now, environment: env });
      }
    } catch {
      // The link step reads it when it needs it.
    }
    return {
      replaced,
      ...(pairing.expiresAt === undefined ? {} : { expiresAt: pairing.expiresAt }),
    };
  }

  #keep(grant: Grant, id: string): T3Pairing {
    const pairing: T3Pairing = { ...grant, grant: id, pairedAt: this.#now(), reconnect: false };
    writePairing(this.#options.files, pairing);
    return pairing;
  }

  /** Marks the pairing "Reconnect T3" when it is still `grant`'s. */
  #reconnect(grant: string): void {
    const pairing = this.pairing();
    if (pairing?.grant === grant && !pairing.reconnect) {
      writePairing(this.#options.files, { ...pairing, reconnect: true });
    }
  }

  /** Whether `pairing`'s access token has run out by now, as T3 said when it issued it. */
  #ranOut(pairing: T3Pairing): boolean {
    return pairing.expiresAt !== undefined && this.#now() >= pairing.expiresAt;
  }

  /**
   * T3 refused `pairing`'s token (401). A token that had run out by then explains the 401, and its
   * refresh token may still work: the pairing stays, and the next call refreshes it. Otherwise T3
   * no longer accepts the grant: "Reconnect T3".
   */
  #refusedToken(pairing: T3Pairing): void {
    if (!this.#ranOut(pairing)) this.#reconnect(pairing.grant);
  }

  async #origin(): Promise<string> {
    if (this.#options.home === undefined) throw new T3Error("unreachable");
    const found = await readT3Origin(this.#options.home, this.#platform);
    if (found.status !== "ok") throw new T3Error("unreachable");
    return found.origin;
  }

  /**
   * The pairing to send with, refreshed first when its token runs out (one refresh at a time).
   * A refresh starts a new grant ID unless REFRESH_KEEPS_GRANT. Throws T3Error `unauthorized`
   * when there is no usable pairing.
   */
  async #fresh(): Promise<T3Pairing> {
    const run = this.#refreshing.then(async () => {
      const pairing = this.pairing();
      if (pairing === undefined || pairing.reconnect) throw new T3Error("unauthorized");
      const due =
        pairing.expiresAt !== undefined && this.#now() >= pairing.expiresAt - REFRESH_MARGIN_MS;
      if (!due) return pairing;
      if (pairing.refreshToken === undefined) {
        this.#reconnect(pairing.grant);
        throw new T3Error("unauthorized");
      }
      let grant: Grant;
      try {
        grant = await refreshGrant(await this.#origin(), pairing, {
          ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
          now: this.#now,
          ...(this.#options.requestMs === undefined ? {} : { requestMs: this.#options.requestMs }),
        });
      } catch (error) {
        if (error instanceof T3Error && error.failure === "unauthorized") {
          this.#reconnect(pairing.grant);
        }
        throw error;
      }
      // Only while no re-pairing replaced it meanwhile.
      if (this.pairing()?.grant !== pairing.grant) throw new T3Error("lost");
      const kept: T3Pairing = {
        ...grant,
        grant: REFRESH_KEEPS_GRANT ? pairing.grant : newGrantId(),
        pairedAt: pairing.pairedAt,
        reconnect: false,
        ...(pairing.environment === undefined ? {} : { environment: pairing.environment }),
      };
      writePairing(this.#options.files, kept);
      return kept;
    });
    this.#refreshing = run.catch(() => undefined);
    return run;
  }

  /**
   * A call with the fresh pairing. A 401 marks it "Reconnect T3", unless the token ran out during
   * the call: then it is `lost` (try again), and the next call refreshes.
   */
  async #call(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const pairing = await this.#fresh();
    const target: T3Target = { origin: await this.#origin(), token: pairing.accessToken };
    try {
      return await this.#mcp.call(target, tool, args);
    } catch (error) {
      if (error instanceof T3Error && error.failure === "unauthorized") {
        if (this.#ranOut(pairing)) throw new T3Error("lost");
        this.#reconnect(pairing.grant);
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------------------------
  // The Prepared step (A4 3.4.1 steps 1 to 5)

  /** Every active project T3 lists, all pages (A4 3.4.1 step 1). */
  async #projects(): Promise<T3Project[]> {
    const projects = new Map<string, T3Project>();
    let cursor: number | null = 0;
    for (let page = 0; page < MAX_PAGES && cursor !== null; page += 1) {
      const answer = await this.#call("t3_project_list", { cursor, limit: PAGE });
      const list = answer["projects"];
      const next = answer["nextCursor"];
      if (!Array.isArray(list)) throw new T3Error("unreadable");
      for (const item of list as unknown[]) {
        if (!isObject(item)) continue;
        const { id, workspaceRoot, archivedAt, deletedAt } = item;
        if (typeof id !== "string" || id === "" || typeof workspaceRoot !== "string") continue;
        // An archived or deleted project is no binding (A4 3.4.1 step 5).
        if ((archivedAt ?? null) !== null || (deletedAt ?? null) !== null) continue;
        // Pages can shift: an ID seen twice is one project.
        projects.set(id, { id, root: workspaceRoot });
      }
      cursor =
        typeof next === "number" && Number.isSafeInteger(next) && next > cursor ? next : null;
    }
    return [...projects.values()];
  }

  /**
   * Binds the task's resolved folder to T3 (A4 3.4.1 steps 1 to 4): an exact project root or an
   * existing worktree, else the Register question, else, after Not now, unavailable for 30 days.
   * `place` keys the Not now answer: the folder as the space stores it. `name` is the title of the
   * task's project, which the question names and the registered T3 project takes as its title.
   */
  async prepare(input: {
    readonly place: string;
    readonly folder: BindFolder;
    readonly name: string;
  }): Promise<T3Prepared> {
    const available = await this.availability();
    if (available.state !== "ready") return { kind: "unavailable", reason: available.state };
    let projects: T3Project[];
    try {
      projects = await this.#projects();
    } catch (error) {
      return { kind: "unavailable", reason: unavailableFor(error) };
    }
    const binding = await bindFolder(projects, input.folder, this.#platform);
    if (binding.kind === "bound") return binding;
    const until = notNowUntil(this.#options.files, input.place);
    if (until !== undefined && this.#now() < until) {
      return { kind: "unavailable", reason: "not_registered" };
    }
    return { kind: "ask", question: "register", text: T3_TEXT.register(input.name) };
  }

  /**
   * Register (A4 3.4.1 step 4): `t3_project_create` for exactly the folder, titled by `name`, the
   * task's project, then step 2 again. A folder that still binds to nothing is unavailable; it is
   * never bound to a containing project.
   */
  async register(input: {
    readonly place: string;
    readonly folder: BindFolder;
    readonly name: string;
  }): Promise<T3Prepared> {
    try {
      await this.#call("t3_project_create", {
        workspaceRoot: input.folder.path,
        title: input.name,
      });
    } catch (error) {
      // A project made meanwhile (another click, T3's own UI) is found by the list below.
      if (!(error instanceof T3Error) || error.failure !== "tool_error") {
        return { kind: "unavailable", reason: unavailableFor(error) };
      }
    }
    const again = await this.prepare(input);
    return again.kind === "ask" ? { kind: "unavailable", reason: "not_registered" } : again;
  }

  /** Not now (A4 3.4.1 step 4): T3 is unavailable for this folder for 30 days. */
  notNow(place: string): void {
    const now = this.#now();
    rememberNotNow(this.#options.files, place, now + NOT_NOW_MS, now);
  }

  /**
   * Writes the launch's plan (before Dispatching: persistence before the step) and returns the
   * grant to dispatch it with, after a refresh when one is due: `dispatch(id, {grant})`.
   */
  async plan(
    id: string,
    input: T3PlanInput,
  ): Promise<
    | { readonly kind: "ready"; readonly grant: string }
    | { readonly kind: "unavailable"; readonly reason: T3Unavailable }
  > {
    const t3 = input.instance.t3;
    const provider = t3?.providerInstance;
    const model = t3?.model ?? "";
    // T3 takes a model with a provider instance (its schema requires `model`). Without one the
    // account could silently be the project's default: refused before anything is sent.
    if (provider !== undefined && model === "") {
      return { kind: "unavailable", reason: "model_required" };
    }
    const runtimeMode = T3_RUNTIME_MODES[input.instance.openPermission];
    const plan: T3Plan = {
      projectId: input.projectId,
      strategy: input.strategy,
      title: input.title,
      ...(model === ""
        ? {}
        : {
            modelSelection: { model, ...(provider === undefined ? {} : { instanceId: provider }) },
          }),
      ...(runtimeMode === undefined ? {} : { runtimeMode }),
      folder: { dev: input.folder.dev.toString(), ino: input.folder.ino.toString() },
      createdAt: this.#now(),
    };
    let pairing: T3Pairing;
    try {
      pairing = await this.#fresh();
    } catch (error) {
      return { kind: "unavailable", reason: unavailableFor(error) };
    }
    writePlan(this.#options.files, id, plan, this.#now());
    return { kind: "ready", grant: pairing.grant };
  }

  // -------------------------------------------------------------------------------------------
  // The machine's steps (A4 3.9.1)

  /** The launch machine's T3 dispatch: the idle-thread create, once, after Dispatching. */
  dispatch(intent: LaunchIntent): Promise<DispatchOutcome> {
    return this.#launch(intent);
  }

  /** RecoverySteps.grant: the current grant ID, or undefined when not paired. */
  grant(): Promise<string | undefined> {
    return Promise.resolve(this.pairing()?.grant);
  }

  /**
   * RecoverySteps.replay: the same idle-thread create with the same key, sent only while the
   * pairing still holds the intent's grant. Otherwise nothing is sent and the answer is `refused`.
   */
  replay(intent: LaunchIntent): Promise<DispatchOutcome> {
    return this.#launch(intent);
  }

  /**
   * `t3_thread_launch` with no message (A4 3.4.1 primary route step 2), under the intent's grant
   * only. The pairing is read, compared with the intent's grant and its token taken in one
   * synchronous step, after which only the requests to T3 are awaited: the call T3 receives
   * carries a token of the intent's grant, whatever re-pairing happens meanwhile (T3 then
   * answers in that grant's namespace, or with a 401). A refresh is never made here: it would
   * change the grant.
   */
  async #launch(intent: LaunchIntent): Promise<DispatchOutcome> {
    if (intent.route !== "t3-mcp") return { kind: "refused" };
    const plan = readPlan(this.#options.files, intent.id);
    if (plan === undefined) return { kind: "refused" };
    let origin: string;
    try {
      origin = await this.#origin();
    } catch {
      return { kind: "refused" };
    }
    const pairing = this.pairing();
    const grant = intent.evidence.grant;
    if (
      pairing === undefined ||
      pairing.reconnect ||
      grant === undefined ||
      pairing.grant !== grant
    ) {
      return { kind: "refused" };
    }
    // A token past its expiry is not sent: T3 would only answer 401. It is not refreshed here
    // either (that would change the grant), so nothing is sent: a dispatch fails, a repeat is
    // Unknown, and the next ordinary call refreshes the pairing.
    if (this.#ranOut(pairing)) return { kind: "refused" };
    const args: Record<string, unknown> = {
      projectId: plan.projectId,
      title: plan.title,
      workspaceStrategy: plan.strategy,
      ...(plan.modelSelection === undefined ? {} : { modelSelection: plan.modelSelection }),
      ...(plan.runtimeMode === undefined ? {} : { runtimeMode: plan.runtimeMode }),
      clientRequestId: intent.id,
    };
    try {
      const answer = await this.#mcp.call(
        { origin, token: pairing.accessToken },
        "t3_thread_launch",
        args,
      );
      const thread = answer["threadId"];
      if (typeof thread !== "string" || !EVIDENCE_ID.test(thread)) return { kind: "unknown" };
      return { kind: "accepted", evidence: { thread } };
    } catch (error) {
      if (!(error instanceof T3Error)) return { kind: "unknown" };
      // A 401 did nothing. It marks "Reconnect T3" unless the token ran out during the call.
      if (error.failure === "unauthorized") this.#refusedToken(pairing);
      return certainNothingDone(error.failure) ? { kind: "refused" } : { kind: "unknown" };
    }
  }

  /**
   * The folder check (A4 3.4.1 step 3): the thread's `worktreePath ?? project root` must be the
   * resolved folder, by identity. `confirmed` with `folder_checked` and the thread, `failed` with
   * `folder_mismatch` (the thread stays for the person to inspect), or `pending` when T3 or the
   * folder cannot be read now.
   */
  async confirm(intent: LaunchIntent): Promise<Observation> {
    const thread = intent.evidence.thread;
    const plan = readPlan(this.#options.files, intent.id);
    if (thread === undefined || plan === undefined) return { kind: "pending" };
    let read: Record<string, unknown>;
    let projects: T3Project[];
    try {
      read = await this.#call("t3_thread_read", { threadId: thread, limit: 1 });
      projects = await this.#projects();
    } catch {
      return { kind: "pending" };
    }
    const found = read["thread"];
    if (!isObject(found) || typeof found["projectId"] !== "string") return { kind: "pending" };
    const evidence = { thread };
    if (found["projectId"] !== plan.projectId) {
      return { kind: "failed", reason: "folder_mismatch", evidence };
    }
    const worktree = found["worktreePath"];
    const folder =
      typeof worktree === "string" && worktree !== ""
        ? worktree
        : projects.find((p) => p.id === plan.projectId)?.root;
    if (folder === undefined) return { kind: "pending" };
    const identity = await identityAt(folder);
    if (identity === undefined) return { kind: "pending" };
    const same =
      identity.dev.toString() === plan.folder.dev && identity.ino.toString() === plan.folder.ino;
    return same
      ? { kind: "confirmed", evidence: { folder_checked: true, thread } }
      : { kind: "failed", reason: "folder_mismatch", evidence };
  }

  /**
   * Opens `t3code://threads/<environment>/<thread>?prompt=<brief>` through the OS (A4 3.4.1 step
   * 4): the brief lands in the thread's composer, unsent. Opening a link to a known thread is not a
   * new launch, so it may be repeated ("Open in T3"). A brief over T3's limit is left out and the
   * link opens the thread alone. Returns whether the opener accepted it.
   */
  async openThread(
    intent: LaunchIntent,
    brief: string | undefined,
  ): Promise<{ readonly opened: boolean; readonly prompt: boolean }> {
    const thread = intent.evidence.thread;
    const open = this.#options.open;
    if (thread === undefined || open === undefined) return { opened: false, prompt: false };
    let environment = this.pairing()?.environment;
    if (environment === undefined) {
      try {
        const env = (await this.#call("t3_environment_read", {}))["environmentId"];
        if (typeof env === "string" && EVIDENCE_ID.test(env)) environment = env;
      } catch {
        return { opened: false, prompt: false };
      }
    }
    if (environment === undefined) return { opened: false, prompt: false };
    const prompt = brief !== undefined && brief !== "" && brief.length <= T3_PROMPT_LIMIT;
    const url = t3ThreadLink(environment, thread, prompt ? brief : undefined);
    try {
      return { opened: await open(url), prompt };
    } catch {
      return { opened: false, prompt };
    }
  }
}

/** A URL value: `encodeURIComponent` plus `!'()*`, once (A4 3.6.4). */
export const encodeUrlValue = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** `t3code://threads/<environment>/<thread>`, with `?prompt=` when a brief is given. */
export function t3ThreadLink(environment: string, thread: string, brief?: string): string {
  const base = `t3code://threads/${encodeUrlValue(environment)}/${encodeUrlValue(thread)}`;
  return brief === undefined ? base : `${base}?prompt=${encodeUrlValue(brief)}`;
}
