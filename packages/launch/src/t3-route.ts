// T3 Code's primary route, `t3-mcp` (A4 3.4.1, L6, L14): TTasks as a paired MCP client of the local
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
// Machine state (t3-state.ts) holds the pairing and each launch's plan; the plan is written before
// Dispatching, so the repeat after a restart sends the same call. T3 issues a 30-day token and no
// refresh token: a pairing that ran out is "Reconnect T3", and the person pairs again.
import { PRODUCT_NAME, CLI_NAME } from "@ttasks/brand";
import type { Permission } from "./catalogue.ts";
import { EVIDENCE_ID, type FailReason } from "./intents.ts";
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
import { beginPairing, type Grant, type PairingAttempt } from "./t3-oauth.ts";
import {
  newGrantId,
  readPairing,
  readPlan,
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
  /** T3 refused the token (401), or it ran out: pair again. */
  | "reconnect"
  /** T3 answered, but not in a way that tells: try again. */
  | "no_answer"
  /** The folder is no T3 project root or worktree, and T3 did not add it as one. */
  | "not_registered"
  /** The instance names a T3 provider instance without a model; T3 needs both together. */
  | "model_required"
  /** The pairing allows less than opening here needs: pair again, choosing Full access. */
  | "pairing_denied";

/** A4 3.18's lines, for the UI and the CLI. */
export const T3_TEXT = {
  not_paired: `Pair ${PRODUCT_NAME} with T3 Code first: ${CLI_NAME} setup t3`,
  not_running: "Start T3 Code",
  reconnect: `T3 Code no longer accepts ${PRODUCT_NAME}'s pairing. Pair again: ${CLI_NAME} setup t3`,
  no_answer: "T3 Code did not answer. Try again.",
  not_registered: `T3 Code did not add this folder as a project. Add it in T3 Code, or pair again choosing Full access: ${CLI_NAME} setup t3`,
  model_required: "Set t3_model for this instance: T3 takes a provider instance with its model.",
  pairing_denied: `The pairing with T3 Code does not allow this. Pair again, choosing Full access: ${CLI_NAME} setup t3`,
} as const satisfies Record<T3Unavailable, string>;

/** Whether T3 can be used now, from machine state and T3's runtime file alone (no request). */
export type T3Availability =
  | { readonly state: "ready"; readonly expiresAt?: number; readonly pairedAt: number }
  | { readonly state: "not_paired" | "not_running" | "reconnect" };

/** The result of the Prepared step for T3 (A4 3.4.1 steps 1 to 4). */
export type T3Prepared =
  | { readonly kind: "bound"; readonly projectId: string; readonly strategy: T3Strategy }
  | { readonly kind: "unavailable"; readonly reason: T3Unavailable };

/** A4 3.2: an instance's permission as T3's runtime mode. `inherit` sends none. */
export const T3_RUNTIME_MODES: Readonly<Record<Permission, string | undefined>> = {
  inherit: undefined,
  "full-access": "full-access",
  "auto-edit": "auto-accept-edits",
  // T3 has no read-only mode: every change waits for an approval.
  "read-only": "approval-required",
};

/** T3's refusals of a launch that it makes before any thread, by its code. */
const PRE_LAUNCH: Readonly<Record<string, FailReason>> = {
  model_unavailable: "model_unavailable",
  runtime_mode_escalation_denied: "pairing_denied",
  capability_denied: "pairing_denied",
};

/** A thread link's brief may hold this many characters (A4 3.4.1: T3's limit is 8,000). */
export const T3_PROMPT_LIMIT = 8_000;

/** A token this close to running out is not used: a request would reach T3 after it ran out. */
const EXPIRY_MARGIN_MS = 60_000;
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
    if (pairing.reconnect || this.#ranOut(pairing)) return { state: "reconnect" };
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

  async #origin(): Promise<string> {
    if (this.#options.home === undefined) throw new T3Error("unreachable");
    const found = await readT3Origin(this.#options.home, this.#platform);
    if (found.status !== "ok") throw new T3Error("unreachable");
    return found.origin;
  }

  /**
   * The pairing to send with. Throws T3Error `unauthorized` when there is none, it is marked
   * "Reconnect T3", or its token runs out within EXPIRY_MARGIN_MS (then it is marked so).
   */
  #usable(): T3Pairing {
    const pairing = this.pairing();
    if (pairing === undefined || pairing.reconnect) throw new T3Error("unauthorized");
    if (pairing.expiresAt !== undefined && this.#now() >= pairing.expiresAt - EXPIRY_MARGIN_MS) {
      this.#reconnect(pairing.grant);
      throw new T3Error("unauthorized");
    }
    return pairing;
  }

  /** A call with the usable pairing. A 401 marks it "Reconnect T3". */
  async #call(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const pairing = this.#usable();
    const target: T3Target = { origin: await this.#origin(), token: pairing.accessToken };
    try {
      return await this.#mcp.call(target, tool, args);
    } catch (error) {
      if (error instanceof T3Error && error.failure === "unauthorized") {
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
   * existing worktree. Any other folder is registered as a project of its own, titled `name`, and
   * bound to it: a thread runs only at a project root, and the person chose this folder for the
   * task. It is never bound to a containing project. The caller has checked `availability`.
   */
  async prepare(input: {
    readonly folder: BindFolder;
    readonly name: string;
  }): Promise<T3Prepared> {
    try {
      const binding = await bindFolder(await this.#projects(), input.folder, this.#platform);
      if (binding.kind === "bound") return binding;
      const made = await this.#call("t3_project_create", {
        workspaceRoot: input.folder.path,
        title: input.name,
      });
      if (typeof made["id"] !== "string" || made["id"] === "") throw new T3Error("unreadable");
      return { kind: "bound", projectId: made["id"], strategy: { type: "root" } };
    } catch (error) {
      // Registering needs Full access: a narrower pairing is the person's to widen.
      if (error instanceof T3Error && error.code === "capability_denied") {
        return { kind: "unavailable", reason: "pairing_denied" };
      }
      // T3 refused the folder otherwise (a project made there meanwhile): what it lists decides.
      if (error instanceof T3Error && error.failure === "tool_error") {
        const binding = await this.#projects()
          .then((projects) => bindFolder(projects, input.folder, this.#platform))
          .catch(() => undefined);
        if (binding?.kind === "bound") return binding;
        return { kind: "unavailable", reason: "not_registered" };
      }
      return { kind: "unavailable", reason: unavailableFor(error) };
    }
  }

  /**
   * Writes the launch's plan (before Dispatching: persistence before the step) and returns the
   * grant to dispatch it with: `dispatch(id, {grant})`.
   */
  plan(
    id: string,
    input: T3PlanInput,
  ):
    | { readonly kind: "ready"; readonly grant: string }
    | { readonly kind: "unavailable"; readonly reason: T3Unavailable } {
    const t3 = input.instance.t3;
    const provider = t3?.providerInstance;
    const model = t3?.model ?? "";
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
      pairing = this.#usable();
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
   * answers in that grant's namespace, or with a 401).
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
    // A token past its expiry is not sent: T3 would only answer 401. A dispatch fails, a repeat
    // is Unknown.
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
      // A 401 did nothing. It marks "Reconnect T3".
      if (error.failure === "unauthorized") this.#reconnect(pairing.grant);
      // T3 checks the model and the mode before it makes the thread.
      const before = error.code === undefined ? undefined : PRE_LAUNCH[error.code];
      if (before !== undefined) return { kind: "refused", reason: before };
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
    let found: unknown;
    let folder: unknown;
    try {
      found = (await this.#call("t3_thread_read", { threadId: thread, limit: 1 }))["thread"];
      if (!isObject(found) || typeof found["projectId"] !== "string") return { kind: "pending" };
      if (found["projectId"] !== plan.projectId) {
        return { kind: "failed", reason: "folder_mismatch", evidence: { thread } };
      }
      const worktree = found["worktreePath"];
      folder =
        typeof worktree === "string" && worktree !== ""
          ? worktree
          : (await this.#call("t3_project_read", { projectId: plan.projectId }))["workspaceRoot"];
    } catch {
      return { kind: "pending" };
    }
    if (typeof folder !== "string") return { kind: "pending" };
    const identity = await identityAt(folder);
    if (identity === undefined) return { kind: "pending" };
    const same =
      identity.dev.toString() === plan.folder.dev && identity.ino.toString() === plan.folder.ino;
    return same
      ? { kind: "confirmed", evidence: { folder_checked: true, thread } }
      : { kind: "failed", reason: "folder_mismatch", evidence: { thread } };
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
