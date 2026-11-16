// Launching in the service (A4 3.6.3, 3.9): one LaunchMachine per space open as this
// machine's, on the space database's execution store, and the shim host over this install's launch
// folders. It answers the shim's rpc methods, recovers each space's open launches when the space
// opens, and every 30 s sweeps them and checks the attached shims by PID and start time.
//
// What it gives the steps after it: `open` (a click, with the terminal's spawn plan), `dispatch`
// (the person confirmed), `read`, and the terminal's start as one seam (`TerminalStart`): M2.09's
// terminal adapters replace the tests' direct start of `tasks shim <ticket>`.
//
// Each connection that claimed or attached holds its attachment (a WeakMap on the connection the
// library hands every handler), so a report is accepted only on the connection that presented the
// ticket or the credential, and never names its launch itself.
import { existsSync } from "node:fs";
import { isAbsolute, join, win32 } from "node:path";
import { PRODUCT_ID, PRODUCT_NAME } from "@tasks/brand";
import type { JsonObject } from "@tasks/bridge/protocol";
import { AppError } from "@tasks/contracts";
import {
  checkPlan,
  CLAIM_WINDOW_MS,
  PREPARED_TTL_MS,
  cliArgv,
  codexToolEnv,
  DEFAULT_TERMINAL,
  ExecutionRefused,
  expandUrl,
  findOnPosixPath,
  folderKeyOf,
  FolderRecords,
  identityKey,
  isBuiltInTarget,
  isUncPath,
  LaunchMachine,
  MATCH_POLL_MS,
  MATCH_WINDOW_MS,
  openUrl,
  osProbe,
  osSpawner,
  osTerminalHost,
  powershellPath,
  presetSession,
  readDelegation,
  ReferenceMatch,
  REFUSED,
  regPath,
  renderBrief,
  renderContextPack,
  resolveLaunchFolder,
  routeOf,
  sanitiseComposer,
  sanitiseTitle,
  SHIM_METHODS,
  ShimHost,
  SpaceExecutionStore,
  TerminalLauncher,
  terminalEnvironment,
  UserEnvironment,
  type Brief,
  type BriefFolder,
  type Instance,
  type AgentBase,
  type EnvironmentSource,
  type Spawner,
  type TerminalHost,
  type TerminalSettings,
  type TicketControl,
  type WindowsDelegation,
  type Attachment,
  type PlanPlace,
  type Resolution,
  type RootFolder,
  type ClaimReply,
  type DispatchOutcome,
  type Evidence,
  type HostRefusal,
  type LaunchIntent,
  type NewIntent,
  type Observation,
  type ProcessProbe,
  type RecordStore,
  type ReportMethod,
  type Route,
  type SpawnPlan,
} from "@tasks/launch";
import { errorCode, errorType } from "../hub/crash.ts";
import type { Logger } from "../hub/log.ts";
import type { ConnectionInfo, RpcContext, RpcHandlers } from "../local/index.ts";
import type { ServedSpace } from "../ops/index.ts";
import {
  briefNames,
  chooseRoute,
  codexEntryOf,
  codexHomeOf,
  COPY,
  COPY_INSTANCE,
  glyphOf,
  LaunchFolderUnavailable,
  LaunchUnavailable,
  type Choice,
  type OpenTaskRequest,
  type OpenTaskResult,
} from "./open.ts";

/** An instance as the page draws its tile (A5 3.6): a key, a label, a monogram and a ring slot. */
export interface LaunchInstance {
  /** The instance's key in machine.toml's `[[instance]]`. */
  readonly key: string;
  /** Names the account: "Codex · work". */
  readonly label: string;
  /** A neutral monogram: "Cx". */
  readonly glyph: string;
  /** One of the eight ring slots of A5 3.19. */
  readonly ring: number;
  readonly route: Route;
}

/** A reference of a launch reference's length, for deciding a brief's budget before the click. */
const REFERENCE_LENGTH_STAND_IN = "L00000";

/** A task's place on this machine as a spawn plan holds it, or null for its work folder. */
const placeOf = (task: OpenTaskRequest["task"]): PlanPlace | null =>
  task.place === null
    ? null
    : {
        root: task.place.root,
        path: task.place.path,
        ...(task.place.gitRemote === undefined ? {} : { gitRemote: task.place.gitRemote }),
      };

/** A4 3.6.3: shims are checked by PID and start time every 30 s; the sweep runs with it. */
export const CHECK_MS = 30_000;

/**
 * At most this many via_login_shell bases are kept for their claims at once; a launch past it has
 * its claim take the snapshot itself.
 */
const FRESH_MAX = 32;

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Starts the terminal that runs `tasks shim <ticket>` for a terminal launch, after Dispatching is
 * durable, the folder resolved, the environment's snapshot brought up to date and the ticket
 * issued. The default is the terminal adapters (M2.09, `TerminalLauncher`); tests of the shim pass
 * a direct start. The terminal starts with `folder` as its working directory, and the shim enters
 * that real path itself before its check (A4 3.3). Its answer is the adapter's acceptance
 * rule (A4 3.6.2); `tickets` lets it revoke a ticket a failed direct terminal carried and give the
 * next terminal a new one.
 */
export type TerminalStart = (start: {
  readonly intent: LaunchIntent;
  readonly ticket: string;
  readonly plan: SpawnPlan;
  readonly folder: string;
  readonly tickets: TicketControl;
}) => Promise<DispatchOutcome>;

/** The seams of the terminal adapters, for tests: the spawner records argv and starts fakes. */
export interface TerminalSeams {
  readonly spawn?: Spawner;
  /** `systemd-run`, absolute, or undefined for none. Default: found on the service's PATH. */
  readonly systemdRun?: string | undefined;
  readonly trueProgram?: string;
  /** Detection's view of the machine. Default: the OS's. */
  readonly host?: (
    session: Readonly<Record<string, string>>,
    path: readonly string[],
  ) => TerminalHost;
  /** Windows: reads the "Default terminal application" setting. Default: reg.exe. */
  readonly delegation?: () => Promise<WindowsDelegation | undefined>;
  readonly watchMs?: number;
}

export { LaunchFolderUnavailable };

/** What a start of the service may set for launching. Tests set the clocks and the probe. */
export interface LaunchOptions {
  /** Wall clock milliseconds. Default: Date.now. */
  readonly now?: () => number;
  /** A monotonic clock (LaunchMachine). Default: performance.now. */
  readonly elapsed?: () => number;
  readonly probe?: ProcessProbe;
  /** Replaces the terminal adapters entirely (the shim's own tests start the shim directly). */
  readonly terminal?: TerminalStart;
  /** The terminal adapters' seams. */
  readonly terminals?: TerminalSeams;
  /**
   * The product's command the terminal runs before `shim <ticket>`, absolute program first.
   * Default: the install's stable launcher, else `node <entry>` for a service run from source.
   */
  readonly shimCommand?: readonly string[];
  /** How often the sweep and the PID check run. Default: CHECK_MS. */
  readonly checkMs?: number;
  /**
   * A fixed base for the agent's environment, taken through the allow-list as the service's own
   * would be. Tests only; `environment` wins when both are given.
   */
  readonly baseEnv?: () => Env;
  /** Where the agent's environment comes from (A4 3.8). Default: this machine's account. */
  readonly environment?: EnvironmentSource;
  /** The machine state. Default: the install's launch folders. */
  readonly records?: RecordStore;
}

export interface LaunchServiceOptions extends LaunchOptions {
  /** This machine (`m_` ID). */
  readonly machine: string;
  /** The install's launch folders (A2 3.2.1). */
  readonly root: string;
  /** The install's machine state folder, which holds the spaces' work folders (A4 3.3). */
  readonly stateDir: string;
  /** This machine's roots as they are now (`OpsHost.roots`): places resolve with them. */
  readonly roots: () => readonly RootFolder[];
  readonly platform: NodeJS.Platform;
  readonly env: Env;
  readonly spaces: () => readonly ServedSpace[];
  readonly log: Logger;
  /** machine.toml's `[terminal]` (A4 3.6.1). Default: DEFAULT_TERMINAL. */
  readonly terminalSettings?: TerminalSettings;
  /** The install ID: scope unit names carry it (A4 3.7). */
  readonly install?: string;
  /**
   * The install's command folder (A2 3.2.1, the layout's `bin`: `~/.local/bin`, or `<root>/bin` of
   * a TASKS_HOME install): its stable launcher is the shim's program.
   */
  readonly commandFolder?: string;
  /** The account's home folder. */
  readonly home?: string;
  /**
   * machine.toml's `[[instance]]` (A4 3.2): what Open can open a task in. Default: none. A function
   * is asked at each use, so instances `tasks setup instances` writes are used at once.
   */
  readonly instances?: readonly Instance[] | (() => readonly Instance[]);
}

interface Hosted {
  readonly writer: unknown;
  readonly made: Promise<{ machine: LaunchMachine; store: SpaceExecutionStore }>;
}

/** The one answer every refused shim call gets: no reason a guesser could learn from. */
const refusal = (): AppError =>
  new AppError({
    code: "forbidden",
    message: `This launch expired. Press Open again in ${PRODUCT_NAME}.`,
    data: { reason: REFUSED },
  });

/**
 * What the service could not decide or record yet rather than refused: the space is still
 * opening, the OS did not answer about the process, or the store did not take a report now. Each
 * comes only after the ticket or the credential and the process it names matched, and none spends
 * the ticket, so the shim tries again; only `refusal` ends a launch for it.
 */
const NOT_YET: ReadonlySet<HostRefusal> = new Set<HostRefusal>(["space", "check_failed", "store"]);

const answer = (reason: HostRefusal): AppError =>
  NOT_YET.has(reason)
    ? new AppError({
        code: "service_unavailable",
        message: `${PRODUCT_NAME} cannot take this launch call yet.`,
        data: { reason: "not_ready", retryable: true },
      })
    : refusal();

/** A best-effort app's folder check, as `launch.folder_check` logs it (A4 3.4.4). */
type FolderCheck = "same" | "other" | "unknown";

export class LaunchService {
  readonly host: ShimHost;
  /** Where the agent's environment comes from (A4 3.8). */
  readonly environment: EnvironmentSource;
  /** The terminal adapters (A4 3.6.2, 3.7). */
  readonly terminals: TerminalLauncher;
  readonly #options: LaunchServiceOptions;
  readonly #hosted = new Map<string, Hosted>();
  readonly #attachments = new WeakMap<ConnectionInfo, Attachment>();
  #timer: NodeJS.Timeout | undefined;
  #ticking: Promise<void> | undefined;
  #stopped = false;
  /** The person's environment as the last base read it: terminal detection searches its PATH. */
  #personEnv: Env = {};
  /**
   * `via_login_shell` launches: the base their dispatch step took in the task's folder, for their
   * claims (a claim normally never waits for a shell). Kept for the claim window, after which no
   * claim is taken; a live one is never dropped for room (#baseFor recovers one that is missing).
   */
  readonly #fresh = new Map<
    string,
    { readonly base: AgentBase | undefined; readonly at: number }
  >();
  /**
   * A link launch's brief and place, from its click to its dispatch step, which builds the URL
   * with the folder resolved right then. In memory only: a click is dispatched in the same call,
   * and an intent whose service restarted before it was dispatched expires (A4 3.9.1).
   */
  readonly #links = new Map<
    string,
    {
      readonly space: string;
      readonly brief: string;
      readonly place: PlanPlace | null;
      readonly at: number;
      /** The instance's link template (A4 3.4.2, 3.4.4, 3.4.5). */
      readonly url: string;
      /** A best-effort app's link: the folder's identity is recorded for the binding's check. */
      readonly confirmFolder: boolean;
    }
  >();
  /**
   * Codex launches' reference match (A4 3.4.3): what their home's session folders held at
   * dispatch, so only newer files are read; the watch runs from the agent's start.
   */
  readonly #matches = new Map<
    string,
    { readonly space: string; readonly match: ReferenceMatch; readonly at: number }
  >();
  readonly #timers = new Set<NodeJS.Timeout>();
  readonly #listeners = new Set<(space: string) => void>();
  /** `launch.open` calls under way, by space and request ID: the last of each queue. */
  readonly #opening = new Map<string, Promise<OpenTaskResult>>();

  constructor(options: LaunchServiceOptions) {
    this.#options = options;
    this.environment = options.environment ?? defaultEnvironment(options);
    this.host = new ShimHost({
      records: options.records ?? new FolderRecords(options.root),
      probe: options.probe ?? osProbe,
      platform: options.platform,
      machine: async (space) => (await this.#space(space))?.machine,
      environment: (launch) => this.#baseFor(launch),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    const seams = options.terminals ?? {};
    const servicePath = pathEntries(options.env, options.platform);
    const systemdRun =
      "systemdRun" in seams
        ? seams.systemdRun
        : options.platform === "linux"
          ? findOnPosixPath("systemd-run", options.env["PATH"])
          : undefined;
    const home = options.home ?? "";
    const delegation =
      seams.delegation ??
      (() =>
        readDelegation({
          reg: regPath(options.env),
          env: helperEnv(options.env),
        }));
    this.terminals = new TerminalLauncher({
      platform: options.platform,
      settings: options.terminalSettings ?? DEFAULT_TERMINAL,
      install: options.install ?? "",
      shimCommand: options.shimCommand ?? defaultShimCommand(options),
      host: async (session) => {
        // The person's PATH first, where `~/.local/bin` and the like are, then the service's.
        const person = pathEntries(this.#personEnv, options.platform);
        const path = [...person, ...servicePath.filter((p) => !person.includes(p))];
        if (seams.host !== undefined) return seams.host(session, path);
        // The session's variables first: a service started at boot may lack the desktop's.
        const variable = (name: string): string | undefined => session[name] ?? options.env[name];
        return osTerminalHost({
          platform: options.platform,
          path,
          terminalVar: session["TERMINAL"],
          xdg: {
            configHome: variable("XDG_CONFIG_HOME"),
            configDirs: variable("XDG_CONFIG_DIRS"),
            dataHome: variable("XDG_DATA_HOME"),
            dataDirs: variable("XDG_DATA_DIRS"),
            currentDesktop: variable("XDG_CURRENT_DESKTOP"),
          },
          home,
          windowsApps: windowsAppsOf(options.env),
          ...(options.platform === "win32"
            ? {
                powershell: powershellPath(options.env),
                // Read at each launch: the person may change it at any time. No answer is none.
                delegation: await delegation().catch(() => undefined),
              }
            : {}),
        });
      },
      systemdRun,
      ...(seams.trueProgram === undefined
        ? options.platform === "linux"
          ? { trueProgram: findOnPosixPath("true", options.env["PATH"]) ?? "/bin/true" }
          : {}
        : { trueProgram: seams.trueProgram }),
      ...(seams.spawn === undefined ? {} : { spawn: seams.spawn }),
      ...(seams.watchMs === undefined ? {} : { watchMs: seams.watchMs }),
    });
  }

  /** Starts the periodic sweep and PID check, with one round at once. */
  start(): void {
    if (this.#stopped || this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      void this.tick();
    }, this.#options.checkMs ?? CHECK_MS);
    this.#timer.unref();
    void this.tick();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }

  /** Calls `listener` with a space whose launch records this service changed (the page's feed). */
  onChange(listener: (space: string) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #changed(space: string): void {
    for (const listener of this.#listeners) {
      try {
        listener(space);
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  /**
   * `doctor/launch` (A3 3.14; A4 3.7, 3.8): whether terminals start in scopes, asked through the
   * very probe and environment a terminal launch uses (Linux only, else null), and how the agent's
   * environment stands (null for a source doctor does not check): with `take` (`doctor --live`)
   * the login shell's snapshot is taken now. Words and times only.
   */
  async doctor(take: boolean): Promise<JsonObject> {
    const { platform } = this.#options;
    let scopes: boolean | null = null;
    const session = await this.environment.session().catch(() => ({}));
    if (platform === "linux") {
      scopes = await this.terminals.scopes(
        terminalEnvironment(this.#options.env, session, platform),
      );
    }
    const terminal = this.terminals.ready() ? await this.#terminalFacts(session) : null;
    const checked = await this.environment.check?.(take).catch(() => undefined);
    const time = (at: number | undefined) => (at === undefined ? null : new Date(at).toISOString());
    const environment: JsonObject | null =
      checked === undefined
        ? null
        : checked.kind === "registry"
          ? { kind: "registry", read: checked.read }
          : {
              kind: "snapshot",
              outcome: checked.outcome ?? null,
              attempted_at: time(checked.attemptedAt),
              taken_at: time(checked.takenAt),
            };
    return { scopes, environment, terminal };
  }

  /**
   * The terminal a launch now would try first (A4 3.6.1): its adapter, why, whether its program
   * was found, and a default the person set that Tasks cannot open. Words only, never a path.
   */
  async #terminalFacts(session: Readonly<Record<string, string>>): Promise<JsonObject | null> {
    const choice = await this.terminals.choose(session).catch(() => undefined);
    if (choice === undefined) return null;
    const first = choice.chain[0];
    return {
      app: first?.app ?? null,
      source: first?.source ?? null,
      found: first?.program !== undefined,
      unsupported: choice.unsupported ?? null,
    };
  }

  /** The instances now: machine.toml's as this start read them, or as setup last wrote them. */
  #instances(): readonly Instance[] {
    const given = this.#options.instances;
    return typeof given === "function" ? given() : (given ?? []);
  }

  /** Whether a terminal route can start here: a product command, or a test's terminal. */
  #terminalReady(): boolean {
    return this.#options.terminal !== undefined || this.terminals.ready();
  }

  /**
   * The instances Open can open a task in on this machine (A5 3.6's tiles), in machine.toml's
   * order: enabled ones whose target has a route here now. Copy is not an instance.
   */
  instances(): LaunchInstance[] {
    const out: LaunchInstance[] = [];
    for (const instance of this.#instances()) {
      let choice: Choice;
      try {
        choice = this.#route(instance);
      } catch {
        continue;
      }
      out.push({
        key: instance.id,
        label: instance.label,
        glyph: glyphOf(instance),
        ring: (out.length % 8) + 1,
        route: choice.route,
      });
    }
    return out;
  }

  /**
   * A click on Open or Copy (`launch.open`, A4 3.4, 3.15; A5 3.8): the route its instance takes
   * now, the brief for that route, the Prepared intent, then the route's one external call. A
   * repeated request returns the same intent and starts nothing (A1 3.8, A4 3.9.1).
   *
   * Throws LaunchUnavailable when no route of the instance can open the task here, and
   * LaunchFolderUnavailable when the task's folder does not resolve (A4 3.3 step 5): no intent is
   * made either way. Copy is always available.
   *
   * Calls with the same request ID in a space run one after the other: a retry that arrives while
   * its first call is still under way waits for it and then replays its intent, so it is never
   * built again from a task that changed in between.
   */
  openTask(request: OpenTaskRequest): Promise<OpenTaskResult> {
    const key = `${request.space}\n${request.requestId}`;
    const before = this.#opening.get(key) ?? Promise.resolve();
    const run = before.then(
      () => this.#openTask(request),
      () => this.#openTask(request),
    );
    this.#opening.set(key, run);
    const done = (): void => {
      if (this.#opening.get(key) === run) this.#opening.delete(key);
    };
    void run.then(done, done);
    return run;
  }

  async #openTask(request: OpenTaskRequest): Promise<OpenTaskResult> {
    const { space, task, requestId } = request;
    const hosted = await this.#space(space);
    if (hosted === undefined) throw new Error("The space is not open on this machine");
    // A repeated request (A1 3.8) replays the intent it made, read from its receipt before the
    // task or machine.toml is read again: an edit to the task since the click never turns a retry
    // into a conflict, and a retry saves, prepares and dispatches nothing.
    const replayed = await hosted.store.replayed(requestId);
    if (replayed !== undefined) return this.#replay(space, replayed, request);
    const { platform } = this.#options;
    let instance: Instance | undefined;
    let choice: Choice = COPY;
    if (request.instance !== undefined) {
      instance = this.#instances().find((i) => i.id === request.instance);
      if (instance === undefined) throw this.#unavailable("not_set_up");
      try {
        choice = this.#route(instance);
      } catch (error) {
        if (error instanceof LaunchUnavailable) this.#log("launch.unavailable", error.reason);
        throw error;
      }
    }
    const place = placeOf(task);
    // R11: a place on another machine never falls back to this machine's work folder.
    if (choice.route !== "clipboard" && task.place === null && task.elsewhere) {
      throw this.#unavailable("other_machine");
    }
    // A link opens the folder resolved now (and again at its dispatch); a UNC one cannot.
    if (choice.route === "link") {
      const where = await this.resolveFolder(space, place);
      if (where.status === "failed") {
        this.#options.log.log("launch.folder_refused", { stage: "open", reason: where.reason });
        throw new LaunchFolderUnavailable(where.reason);
      }
      if (isUncPath(where.folder)) throw this.#unavailable("unc");
    }

    const brief = await this.#briefOf(space, request, choice);
    // Decided on a reference of the real one's length: the real brief has the same length, so
    // the same lines and the same hash (the hash holds the reference as a slot).
    const probe = brief(REFERENCE_LENGTH_STAND_IN);
    if (probe.status !== "ok") throw this.#unavailable("too_long");
    if (probe.composer === "note" && probe.composerText !== undefined) {
      // The note is saved before the intent is recorded: a terminal click whose folder cannot be
      // used is refused first, so a refused click saves nothing (the link's was checked above).
      if (choice.route === "terminal") {
        const where = await this.resolveFolder(space, place);
        if (where.status === "failed") {
          this.#options.log.log("launch.folder_refused", { stage: "open", reason: where.reason });
          throw new LaunchFolderUnavailable(where.reason);
        }
      }
      await request.saveNote(probe.composerText);
    }

    // The terminal route's plan: the agent's argv with the brief, kept in machine state.
    const session =
      choice.route === "terminal" && instance?.target === "claude-cli"
        ? presetSession(space, requestId)
        : undefined;
    let planFor: ((reference: string) => SpawnPlan) | undefined;
    if (choice.route === "terminal" && instance !== undefined) {
      const chosen = instance;
      const codexHome =
        chosen.target === "codex-cli"
          ? codexHomeOf(chosen, this.#options.home, platform)
          : undefined;
      const entry = codexHome === undefined ? undefined : codexEntryOf(codexHome);
      const toolEnv = entry?.kind === "lacks_env_vars" ? codexToolEnv(entry.names) : [];
      const title = sanitiseTitle(task.title);
      planFor = (reference) => {
        const text = brief(reference);
        const built = cliArgv(chosen, choice.prompt ?? "sent", {
          task: task.ref,
          title,
          reference,
          toolEnv,
          ...(session === undefined ? {} : { session }),
          ...(choice.prompt === "clipboard" || text.status !== "ok" ? {} : { brief: text.text }),
        });
        return {
          argv: built.argv,
          place,
          env: chosen.env,
          title: `${task.ref} ${title}`,
          afterExit: (this.#options.terminalSettings ?? DEFAULT_TERMINAL).afterExit,
          ...(chosen.viaLoginShell && platform !== "win32" ? { loginShell: true } : {}),
          ...(built.folderArgs.length === 0 ? {} : { folderArgs: built.folderArgs }),
          ...(codexHome === undefined ? {} : { match: { home: codexHome } }),
        };
      };
      if (checkPlan(planFor(REFERENCE_LENGTH_STAND_IN)) === undefined) {
        throw new Error("The spawn plan is not one the shim can start");
      }
    }

    const click: Omit<NewIntent, "machine"> = {
      task: task.id,
      instance: instance?.id ?? COPY_INSTANCE,
      route: choice.route,
      place: task.place?.id ?? null,
      taskVersion: task.version,
      briefHash: probe.hash,
      ...(session === undefined ? {} : { evidence: { preset: session } }),
    };
    const planned = planFor;
    let intent =
      planned === undefined
        ? await hosted.machine.open(click, requestId)
        : await this.#openWith(space, hosted, click, requestId, place, (i) => planned(i.reference));
    const text = brief(intent.reference);
    if (text.status !== "ok") throw this.#unavailable("too_long");
    if (choice.route === "link" && intent.state === "prepared" && !this.#links.has(intent.id)) {
      const link =
        instance !== undefined && isBuiltInTarget(instance.target)
          ? routeOf(instance.target, "link")
          : undefined;
      if (link?.url !== undefined) {
        this.#links.set(intent.id, {
          space,
          brief: text.text,
          place,
          at: performance.now(),
          url: link.url,
          confirmFolder: link.confirmFolder === true,
        });
      }
    }
    this.#changed(space);
    if (intent.state === "prepared") {
      const dispatching = hosted.machine
        .dispatch(intent.id)
        .then((after) => {
          this.#changed(space);
          return after;
        })
        .catch((error: unknown) => {
          // The machine recorded what it could; the sweep settles the rest (A4 3.9.3).
          this.#failed("dispatch", error);
          return undefined;
        });
      // Copy is Dispatched at once (A4 3.4.6): its one external step is the page's own copy.
      if (choice.route === "clipboard") intent = (await dispatching) ?? intent;
    }
    return {
      intent,
      copy: choice.copy ? text.text : undefined,
      composer: probe.composer,
      removed: probe.removed,
    };
  }

  /** The route an instance takes here now (chooseRoute). Throws LaunchUnavailable. */
  #route(instance: Instance): Choice {
    return chooseRoute(instance, {
      terminal: this.#terminalReady(),
      home: this.#options.home,
      platform: this.#options.platform,
    });
  }

  /**
   * The brief of a click on a route, for any launch reference (A4 3.15). Copy's pointer brief
   * has the folder line: where the task works here, as far as it resolves (A4 3.15.4).
   */
  async #briefOf(
    space: string,
    request: OpenTaskRequest,
    choice: Choice,
  ): Promise<(reference: string) => Brief> {
    const { task } = request;
    let folder: BriefFolder | undefined;
    if (choice.route === "clipboard") {
      const place = placeOf(task);
      if (task.place === null && task.elsewhere) folder = { kind: "elsewhere" };
      else {
        const where = await this.resolveFolder(space, place).catch(() => undefined);
        const absolute = where?.status === "ok" ? where.folder : undefined;
        folder =
          place === null
            ? { kind: "work_folder", absolute }
            : { kind: "place", root: place.root, path: place.path, absolute };
      }
    }
    const names = briefNames();
    const pack = request.pack;
    if (choice.route === "clipboard" && pack !== undefined && folder !== undefined) {
      // Shift+Copy (A4 3.15.5): the context pack in place of the pointer brief. The person's words
      // are part of it, whole, so they never become a note.
      const shown = folder;
      const words = request.composer === undefined ? undefined : sanitiseComposer(request.composer);
      const given = words !== undefined && words.text.trim() !== "";
      return (reference) => {
        const made = renderContextPack({
          ...pack,
          task: task.ref,
          title: task.title,
          reference,
          folder: shown,
          ...(given ? { composer: words.text } : {}),
        });
        return {
          status: "ok",
          text: made.text,
          hash: made.hash,
          composer: given ? "inline" : "none",
          composerText: undefined,
          removed: words?.removed === true,
        };
      };
    }
    return (reference) =>
      renderBrief({
        kind: choice.kind,
        task: task.ref,
        title: task.title,
        reference,
        composer: request.composer,
        ...(folder === undefined ? {} : { folder }),
        budget: choice.budget,
        names,
      });
  }

  /**
   * A repeated `launch.open` (A1 3.8): the intent its request made, as it is now. A request ID
   * names one click, so another task or instance under it is refused as reused, whatever the
   * rest says. The text for the clipboard is rendered again for the intent's reference with the
   * task as it is now, while the instance still takes the intent's route here. Nothing is saved,
   * prepared or dispatched: the click that made the intent did that, or its intent expires.
   */
  async #replay(
    space: string,
    intent: LaunchIntent,
    request: OpenTaskRequest,
  ): Promise<OpenTaskResult> {
    if (
      intent.task !== request.task.id ||
      intent.instance !== (request.instance ?? COPY_INSTANCE)
    ) {
      throw new ExecutionRefused("request_id_reused", "This request ID was used for another click");
    }
    let choice: Choice | undefined = COPY;
    if (request.instance !== undefined) {
      const instance = this.#instances().find((i) => i.id === request.instance);
      try {
        choice = instance === undefined ? undefined : this.#route(instance);
      } catch {
        choice = undefined;
      }
    }
    const given = request.composer?.trim() ?? "";
    const bare: OpenTaskResult = {
      intent,
      copy: undefined,
      composer: given === "" ? "none" : "inline",
      removed: false,
    };
    if (choice?.route !== intent.route) return bare;
    const text = (await this.#briefOf(space, request, choice))(intent.reference);
    if (text.status !== "ok") return bare;
    return {
      intent,
      copy: choice.copy ? text.text : undefined,
      composer: text.composer,
      removed: text.removed,
    };
  }

  #unavailable(reason: LaunchUnavailable["reason"]): LaunchUnavailable {
    this.#log("launch.unavailable", reason);
    return new LaunchUnavailable(reason);
  }

  #log(event: "launch.unavailable", reason: LaunchUnavailable["reason"]): void {
    this.#options.log.log(event, { reason });
  }

  /**
   * One round: a machine for every space that opened since (with its recovery), the sweep of
   * each, then the PID check. One round at a time.
   */
  tick(): Promise<void> {
    if (this.#ticking === undefined) {
      // Held before the round can end, so a round that ends at once never stands for later ones.
      const ticking: Promise<void> = this.#round()
        .catch((error: unknown) => {
          this.#failed("sweep", error);
        })
        .finally(() => {
          if (this.#ticking === ticking) this.#ticking = undefined;
        });
      this.#ticking = ticking;
    }
    return this.#ticking;
  }

  async #round(): Promise<void> {
    const spaces = this.#options.spaces().filter(isOpen);
    for (const space of spaces) {
      const id = space.id ?? "";
      const hosted = await this.#space(id).catch(() => undefined);
      if (hosted === undefined) continue;
      await hosted.machine.sweep().catch((error: unknown) => {
        if (this.#stillOpen(id, space.writer)) this.#failed("sweep", error);
      });
    }
    await this.host.check().catch((error: unknown) => {
      this.#failed("check", error);
    });
    this.#pruneMatches();
    // A link click whose dispatch never ran: its intent expires in Prepared (A4 3.9.1).
    for (const [id, link] of this.#links) {
      if (performance.now() - link.at > PREPARED_TTL_MS) this.#links.delete(id);
    }
  }

  /** The launch machine of a space open as this machine's, or undefined. */
  async machine(space: string): Promise<LaunchMachine | undefined> {
    return (await this.#space(space))?.machine;
  }

  /**
   * The folder a terminal launch of `space` with this place would work in, resolved now (A4 3.3):
   * the place through this machine's live roots, or for no place the space's work folder. M2.13's
   * launch slot asks this to disable a route with its reason; `open` and the dispatch step ask it
   * too.
   */
  resolveFolder(space: string, place: PlanPlace | null): Promise<Resolution> {
    return resolveLaunchFolder(place, space, {
      roots: this.#options.roots(),
      stateDir: this.#options.stateDir,
      platform: this.#options.platform,
    });
  }

  /**
   * A click (A4 3.9.1): the Prepared intent, or the one a repeated request or a second click
   * returns. A terminal launch keeps its spawn plan in machine state. Before a new intent is made,
   * its folder must resolve now, or the click is refused with the reason
   * (`LaunchFolderUnavailable`) and no intent is made; it is resolved again right before the
   * launch.
   *
   * A repeated request (the same request ID, A1 3.8) is a replay: the store returns the intent it
   * made the first time, as it is now, or refuses the ID for another click. No new intent can come
   * from it, so nothing that guards only a new intent stands in front of it: the folder may have
   * gone since the first call succeeded and its answer was lost, and the replay still returns that
   * intent (its dispatch resolves the folder again). The plan's shape is the input's own and is
   * checked before anything; machine state is made only for a Prepared intent that has none.
   */
  async open(
    space: string,
    click: Omit<NewIntent, "machine">,
    requestId: string,
    plan?: SpawnPlan,
  ): Promise<LaunchIntent> {
    const hosted = await this.#space(space);
    if (hosted === undefined) throw new Error("The space is not open on this machine");
    if (click.route !== "terminal") return hosted.machine.open(click, requestId);
    if (plan === undefined) throw new Error("A terminal launch needs its spawn plan");
    if (checkPlan(plan) === undefined) {
      throw new Error("The spawn plan is not one the shim can start");
    }
    return this.#openWith(space, hosted, click, requestId, plan.place, () => plan);
  }

  /**
   * A terminal click: the folder's preflight for a new request, the intent, then its spawn plan
   * in machine state for a Prepared intent that has none. `planFor` builds the plan for the
   * intent the store returned (its launch reference is the writer's).
   */
  async #openWith(
    space: string,
    hosted: { machine: LaunchMachine; store: SpaceExecutionStore },
    click: Omit<NewIntent, "machine">,
    requestId: string,
    place: PlanPlace | null,
    planFor: (intent: LaunchIntent) => SpawnPlan,
  ): Promise<LaunchIntent> {
    if (!(await hosted.store.decided(requestId))) {
      const where = await this.resolveFolder(space, place);
      if (where.status === "failed") {
        this.#options.log.log("launch.folder_refused", { stage: "open", reason: where.reason });
        throw new LaunchFolderUnavailable(where.reason);
      }
    }
    const intent = await hosted.machine.open(click, requestId);
    if (intent.route === "terminal" && intent.state === "prepared") {
      this.host.prepare(space, intent, planFor(intent));
    }
    return intent;
  }

  /** The person confirmed (A4 3.9.1): Dispatching, then the route's one external call. */
  async dispatch(
    space: string,
    launch: string,
    evidence: Evidence = {},
  ): Promise<LaunchIntent | undefined> {
    const hosted = await this.#space(space);
    if (hosted === undefined) throw new Error("The space is not open on this machine");
    return hosted.machine.dispatch(launch, evidence);
  }

  /** The intent as the space holds it now. */
  async read(space: string, launch: string): Promise<LaunchIntent | undefined> {
    return (await this.#space(space))?.store.readIntent(launch);
  }

  /**
   * The bridge's binding of a launch (A3 3.7.7 `session.bound`, A4 3.9.1): `confirmed` with
   * `bound_at`, in the launch's section, which also settles an Unknown launch. Returns the launch
   * as it is after: one that took no binding (it failed, or a terminal launch no shim claimed)
   * holds no `bound_at`, and one bound before holds its first. A store that cannot take it now is
   * `space_unavailable`, to retry; a space not open as this machine's takes none.
   */
  async confirmBinding(
    space: string,
    launch: string,
    at: number,
    folder?: string,
  ): Promise<LaunchIntent | undefined> {
    const hosted = await this.#space(space).catch(() => undefined);
    const machine = hosted?.machine;
    if (hosted === undefined || machine === undefined) {
      throw new AppError({
        code: "space_unavailable",
        message: "The space cannot record this launch's binding now.",
        hint: "Try again in a moment.",
        data: { reason: "not_served", retryable: true },
      });
    }
    try {
      // The bridge's folder is read by one stat before the section, only for a link launch (its
      // route never changes); the decision is made in the section, on the record as it is then.
      const before = await hosted.store.readIntent(launch);
      const here =
        before?.route === "link" && folder !== undefined
          ? await folderKeyOf(folder, this.#options.platform)
          : undefined;
      let check: FolderCheck | undefined;
      const after = await machine.report(launch, (intent) => {
        const decided = this.#bindingObservation(intent, at, here);
        check = decided.check;
        return decided.observation;
      });
      if (check !== undefined) this.#options.log.log("launch.folder_check", { result: check });
      // The page's receipts follow at once, as for the shim's reports.
      this.#changed(space);
      return after;
    } catch {
      throw new AppError({
        code: "space_unavailable",
        message: "The space cannot record this launch's binding now.",
        hint: "Try again in a moment.",
        data: { reason: "busy", retryable: true },
      });
    }
  }

  /**
   * What the bridge's binding tells about a launch (A4 3.9.2): Confirmed, except for a best-effort
   * app's link (A4 3.4.4, 3.4.5), whose session may have started in another folder than the link
   * named. That one is Confirmed only when the bridge's working folder has the identity the link's
   * folder had at its dispatch; otherwise the binding is recorded as evidence and the launch stays
   * Dispatched ("Opened · not confirmed"). It is decided in the launch's section on the record as
   * it is then (`here` is the bridge folder's identity key, read before), so a binding that arrives
   * while the opener still runs is decided after the dispatch recorded the folder. A link launch is
   * checked when its record holds a folder identity (only a best-effort app's link records one,
   * whatever its instance has become in machine.toml since), when its instance's route asks for
   * the check, and when its instance is no longer in machine.toml.
   */
  #bindingObservation(
    intent: LaunchIntent,
    at: number,
    here: string | undefined,
  ): { observation: Observation; check?: FolderCheck } {
    const confirmed: Observation = { kind: "confirmed", evidence: { bound_at: at } };
    if (intent.route !== "link") return { observation: confirmed };
    const recorded = intent.evidence.folder_id;
    const instance = this.#instances().find((i) => i.id === intent.instance);
    const checks =
      recorded !== undefined ||
      instance === undefined ||
      !isBuiltInTarget(instance.target) ||
      routeOf(instance.target, "link")?.confirmFolder === true;
    if (!checks) return { observation: confirmed };
    const same = recorded !== undefined && here !== undefined && here === recorded;
    return {
      observation: same ? confirmed : { kind: "evidence", evidence: { bound_at: at } },
      check: same ? "same" : recorded === undefined || here === undefined ? "unknown" : "other",
    };
  }

  /** The rpc methods of the shim class (A2 3.6.4): the hub registers these in its handler table. */
  handlers(): RpcHandlers {
    const report =
      (method: ReportMethod) =>
      (params: JsonObject, context: RpcContext): Promise<unknown> =>
        this.#report(method, params, context);
    return {
      "launch.claim": (params, context) => this.#claim(params, context),
      "launch.attach": (params, context) => this.#attach(params, context),
      "launch.started": report(SHIM_METHODS.started),
      "launch.settled": report(SHIM_METHODS.settled),
      "launch.exited": report(SHIM_METHODS.exited),
      "launch.failed": report(SHIM_METHODS.failed),
    };
  }

  /**
   * `launch.claim`. The host runs the reply inside the claim's section; it hands the reply to this
   * handler, which returns it, and the step ends once the line has gone to the socket. The claim
   * itself may end after the reply left.
   */
  async #claim(params: JsonObject, context: RpcContext): Promise<unknown> {
    let deliver!: (reply: ClaimReply) => void;
    const replied = new Promise<ClaimReply>((resolve) => {
      deliver = resolve;
    });
    const outcome = this.host.claim(params, async (reply, attachment) => {
      this.#attachments.set(context.connection, attachment);
      deliver(reply);
      // The server writes the reply when this handler returns it, a few microtasks from now.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await context.drained();
    });
    const first = await Promise.race([
      replied.then((reply) => ({ reply })),
      outcome.then((result) => ({ result })),
    ]);
    if ("reply" in first) {
      outcome.then(
        () => undefined,
        () => undefined,
      );
      this.#options.log.log("launch.claimed", {});
      return first.reply;
    }
    if (first.result.kind === "refused") {
      this.#refused("claim", first.result.reason);
      throw answer(first.result.reason);
    }
    throw refusal();
  }

  async #attach(params: JsonObject, context: RpcContext): Promise<unknown> {
    const outcome = await this.host.attach(params);
    if (outcome.kind === "refused") {
      this.#refused("attach", outcome.reason);
      throw answer(outcome.reason);
    }
    this.#attachments.set(context.connection, outcome.attachment);
    this.#options.log.log("launch.attached", {});
    return outcome.reply;
  }

  async #report(method: ReportMethod, params: JsonObject, context: RpcContext): Promise<unknown> {
    const attachment = this.#attachments.get(context.connection);
    if (attachment === undefined) {
      this.#refused("report", "not_attached");
      throw refusal();
    }
    const outcome = await this.host.report(attachment, method, params);
    if (outcome.kind === "refused") {
      this.#refused("report", outcome.reason);
      throw answer(outcome.reason);
    }
    if (outcome.ended) this.#attachments.delete(context.connection);
    if (outcome.folder !== undefined) {
      this.#options.log.log("launch.folder_refused", { stage: "shim", reason: outcome.folder });
    }
    this.#changed(attachment.space);
    if (method === SHIM_METHODS.started) this.#watchMatch(attachment.space, attachment.launch);
    return {};
  }

  /** Drops reference matches whose agent never started within the windows. */
  #pruneMatches(): void {
    const limit = CLAIM_WINDOW_MS + MATCH_WINDOW_MS;
    for (const [id, kept] of this.#matches) {
      if (performance.now() - kept.at > limit) this.#matches.delete(id);
    }
  }

  /**
   * Codex's reference match (A4 3.4.3), from the agent's start for two minutes: the thread ID of
   * the session file that names this launch's folder and reference becomes the launch's `thread`
   * evidence. No match leaves the launch as its shim's reports make it: no native ID, no Resume.
   */
  #watchMatch(space: string, launch: string): void {
    const kept = this.#matches.get(launch);
    if (kept === undefined) return;
    const until = performance.now() + MATCH_WINDOW_MS;
    const look = (): void => {
      if (this.#stopped || this.#matches.get(launch) !== kept) return;
      let thread: string | undefined;
      try {
        thread = kept.match.look((this.#options.now ?? Date.now)());
      } catch {
        thread = undefined;
      }
      if (thread !== undefined || kept.match.settled || performance.now() > until) {
        this.#matches.delete(launch);
        this.#options.log.log("launch.native_id", {
          source: "reference_match",
          result: thread === undefined ? "none" : "matched",
        });
        if (thread === undefined) return;
        const found = thread;
        void this.machine(space)
          .then((machine) =>
            machine?.report(launch, { kind: "evidence", evidence: { thread: found } }),
          )
          .then(() => {
            this.#changed(space);
          })
          .catch(() => {
            this.#failed("match", undefined);
          });
        return;
      }
      const timer = setTimeout(() => {
        this.#timers.delete(timer);
        look();
      }, MATCH_POLL_MS);
      timer.unref();
      this.#timers.add(timer);
    };
    look();
  }

  /** The space's machine and store, made once per writer, with that writer's recovery. */
  async #space(
    space: string,
  ): Promise<{ machine: LaunchMachine; store: SpaceExecutionStore } | undefined> {
    const served = this.#options.spaces().find((s) => s.id === space && isOpen(s));
    const writer = served?.writer;
    if (served === undefined || writer === undefined) return undefined;
    const known = this.#hosted.get(space);
    if (known?.writer === writer) return known.made;
    const made = this.#make(space, served);
    this.#hosted.set(space, { writer, made });
    made.then(
      ({ machine }) => this.#recover(space, writer, machine),
      () => {
        if (this.#hosted.get(space)?.made === made) this.#hosted.delete(space);
      },
    );
    return made;
  }

  async #make(
    space: string,
    served: ServedSpace,
  ): Promise<{ machine: LaunchMachine; store: SpaceExecutionStore }> {
    const writer = served.writer;
    if (writer === undefined) throw new Error("The space has no writer");
    const { machine: id, now, elapsed } = this.#options;
    // A4 3.16: `created_by = user`. The launch path writes as the space's human, in a scope of
    // its own.
    const human = await writer.actor("human", "user");
    const store = new SpaceExecutionStore({
      writer,
      spaceId: space,
      credential: {
        scope_id: `launch:${id}`,
        principal_id: human,
        actor_kind: "human",
        machine_id: id,
        origin: "ui",
      },
    });
    const machine = new LaunchMachine({
      store,
      machine: id,
      steps: { dispatch: (intent) => this.#dispatchStep(intent) },
      recovery: {
        observe: (intent) => this.host.observe(intent),
        // T3 (M2.11): not paired yet, so a T3 launch left open is Unknown.
        grant: () => Promise.resolve(undefined),
        replay: () => Promise.resolve({ kind: "refused" }),
      },
      ...(now === undefined ? {} : { now }),
      ...(elapsed === undefined ? {} : { elapsed }),
    });
    return { machine, store };
  }

  /**
   * The route's external call. Terminal only so far: right before the launch the folder is
   * resolved again (A4 3.3); a folder that no longer resolves fails the launch as a check
   * before anything external (`cancelled`), with its reason in the log. Then the environment's
   * snapshot is brought up to date (A4 3.8: before the terminal, so the claim never waits for a
   * shell), the ticket is issued with the folder's check, and the terminal adapters start the
   * terminal in that folder by their acceptance rules (A4 3.6.2).
   */
  async #dispatchStep(intent: LaunchIntent): Promise<DispatchOutcome> {
    switch (intent.route) {
      case "terminal":
        return this.#dispatchTerminal(intent);
      case "link":
        return this.#dispatchLink(intent);
      case "clipboard":
        // Copy (A4 3.4.6): the page copies the pointer brief in the person's click. The launch is
        // Dispatched at once and Confirmed if an agent redeems its reference (M2.04).
        return { kind: "accepted" };
      default:
        return { kind: "refused" };
    }
  }

  /**
   * A link route's one external call (A4 3.4.2 `claude-cli://`, 3.6.5): the folder resolved again
   * right before (A4 3.3), the URL with that folder and the click's brief, each value
   * encoded once, opened through the OS's opener. Each opener outcome is a defined state: opened
   * is Dispatched, a definite "nothing opened" Failed, anything else Unknown ("it may have
   * opened"); a fallback opener runs only when the one before never started (opener.ts).
   */
  async #dispatchLink(intent: LaunchIntent): Promise<DispatchOutcome> {
    const pending = this.#links.get(intent.id);
    this.#links.delete(intent.id);
    // The click's brief is gone (a restart between the click and its dispatch): nothing opens.
    if (pending === undefined) return { kind: "refused", reason: "cancelled" };
    const where = await this.resolveFolder(pending.space, pending.place);
    if (where.status === "failed") {
      this.#options.log.log("launch.folder_refused", { stage: "dispatch", reason: where.reason });
      return { kind: "refused", reason: "cancelled" };
    }
    if (isUncPath(where.folder)) {
      this.#log("launch.unavailable", "unc");
      return { kind: "refused", reason: "cancelled" };
    }
    const url = expandUrl(pending.url, { cwd: where.folder, brief: pending.brief });
    const { platform } = this.#options;
    const session = await this.environment.session().catch(() => ({}));
    const env = terminalEnvironment(this.#options.env, session, platform);
    const path = [
      ...pathEntries(this.#personEnv, platform),
      ...pathEntries(this.#options.env, platform),
    ].join(":");
    const opened = await openUrl(url, {
      platform,
      env,
      spawn: this.#options.terminals?.spawn ?? osSpawner,
      which: (name) => findOnPosixPath(name, path),
      cwd: this.#options.home ?? this.#options.stateDir,
    });
    this.#options.log.log("launch.opener", { opener: opened.opener, result: opened.result });
    switch (opened.result) {
      case "opened":
        // A best-effort app's link records the identity of the folder it named: the bridge's
        // binding confirms the launch only from that folder (A4 3.4.4, 3.4.5).
        return pending.confirmFolder
          ? { kind: "accepted", evidence: { folder_id: identityKey(where.identity) } }
          : { kind: "accepted" };
      case "unknown":
        return { kind: "unknown" };
      default:
        return { kind: "refused" };
    }
  }

  async #dispatchTerminal(intent: LaunchIntent): Promise<DispatchOutcome> {
    const record = this.host.record(intent.id);
    if (record === undefined) return { kind: "refused" };
    const where = await this.resolveFolder(record.space, record.plan.place);
    if (where.status === "failed") {
      this.#options.log.log("launch.folder_refused", { stage: "dispatch", reason: where.reason });
      // No ticket was issued and nothing started: nothing more can come from its machine state.
      this.host.release(intent.id);
      return { kind: "refused", reason: "cancelled" };
    }
    // `via_login_shell` (A4 3.8): the person's login shell runs now, in the task's folder, and its
    // environment is this launch's base. The agent still starts directly from the shim, after its
    // folder check and A4's scrub: no profile runs between them (A4 3.8).
    const loginShell = record.plan.loginShell === true && this.#options.platform !== "win32";
    const fresh = loginShell
      ? await this.environment.inFolder(where.folder, where.check).catch(() => undefined)
      : undefined;
    // What it gave, for its claims: a failed one means the stored snapshot, brought up to date.
    if (loginShell) this.#keepFresh(intent.id, fresh);
    if (fresh === undefined) await this.environment.prepare().catch(() => undefined);
    // Codex's reference match (A4 3.4.3): what its home's session folders hold before anything
    // can start, so only newer files are ever read.
    const match = record.plan.match;
    if (match !== undefined) {
      this.#pruneMatches();
      this.#matches.set(intent.id, {
        space: record.space,
        match: new ReferenceMatch(
          match.home,
          { folder: where.folder, reference: intent.reference, platform: this.#options.platform },
          (this.#options.now ?? Date.now)(),
        ),
        at: performance.now(),
      });
    }
    let ticket = this.host.issueTicket(intent.id, { path: where.folder, check: where.check });
    const tickets: TicketControl = {
      current: () => ticket,
      claimed: () => this.host.ticketSpent(intent.id),
      replace: () => {
        const next = this.host.replaceTicket(intent.id);
        if (next !== undefined) ticket = next;
        return next;
      },
    };
    const start =
      this.#options.terminal ?? ((s) => this.#startTerminal(s.intent, s.folder, s.tickets));
    return start({ intent, ticket, plan: record.plan, folder: where.folder, tickets });
  }

  /** Drops the via_login_shell bases past the claim window: no claim can use them any more. */
  #pruneFresh(): void {
    const now = performance.now();
    for (const [id, kept] of this.#fresh) {
      if (now - kept.at > CLAIM_WINDOW_MS) this.#fresh.delete(id);
    }
  }

  /**
   * Keeps what a via_login_shell launch's snapshot gave for its claims: the base, or undefined when
   * the snapshot failed (its claims then take the stored one). Past FRESH_MAX live ones it keeps
   * none more, and that launch's claim takes its snapshot itself (#baseFor): nothing live is dropped.
   */
  #keepFresh(launch: string, base: AgentBase | undefined): void {
    this.#pruneFresh();
    if (this.#fresh.size < FRESH_MAX || this.#fresh.has(launch)) {
      this.#fresh.set(launch, { base, at: performance.now() });
    }
  }

  /**
   * The base a claim builds the agent's environment from. A via_login_shell launch gets the base
   * its dispatch step took in its folder (or, when that snapshot failed, the stored one, as A4's
   * fallback). When its dispatch's result is not here at all (a restart between the dispatch and
   * the claim, or no room), the claim takes the snapshot again in the launch's resolved folder: a
   * launch never silently runs without its folder's environment.
   */
  async #baseFor(launch: string): Promise<AgentBase> {
    this.#pruneFresh();
    const kept = this.#fresh.get(launch);
    if (kept !== undefined) return kept.base ?? this.environment.base();
    const record = this.host.record(launch);
    if (
      record?.plan.loginShell === true &&
      record.folder !== undefined &&
      this.#options.platform !== "win32"
    ) {
      const fresh = await this.environment
        .inFolder(record.folder.path, record.folder.check)
        .catch(() => undefined);
      this.#keepFresh(launch, fresh);
      if (fresh !== undefined) return fresh;
    }
    return this.environment.base();
  }

  /** The terminal adapters' start, with each terminal tried logged by its words. */
  async #startTerminal(
    intent: LaunchIntent,
    folder: string,
    tickets: TicketControl,
  ): Promise<DispatchOutcome> {
    const { platform } = this.#options;
    const session = await this.environment.session().catch(() => ({}));
    if (platform !== "win32") {
      const base =
        this.#fresh.get(intent.id)?.base ?? (await this.environment.base().catch(() => undefined));
      if (base?.kind === "user") this.#personEnv = base.env;
    }
    const env = terminalEnvironment(this.#options.env, session, platform);
    const { outcome, attempts, scoped, terminal } = await this.terminals.start({
      launch: intent.id,
      folder,
      tickets,
      env,
      session,
    });
    for (const attempt of attempts) {
      this.#options.log.log("launch.terminal", {
        app: attempt.app,
        ...(attempt.kind === undefined ? {} : { kind: attempt.kind }),
        result: attempt.result,
        ...(attempt.error === undefined ? {} : { error: attempt.error }),
        ...(typeof attempt.code === "number" ? { code: attempt.code } : {}),
        scoped,
        ...(terminal === undefined || attempt.result !== "dispatched"
          ? {}
          : { source: terminal.source }),
      });
    }
    // The receipt names the terminal and why it was chosen (A4 3.6.1).
    if (outcome.kind === "accepted" && terminal !== undefined) {
      return {
        ...outcome,
        evidence: {
          ...outcome.evidence,
          terminal: terminal.app,
          terminal_source: terminal.source,
        },
      };
    }
    return outcome;
  }

  async #recover(space: string, writer: unknown, machine: LaunchMachine): Promise<void> {
    const t0 = performance.now();
    try {
      const left = await machine.recover();
      this.#options.log.log("launch.recovered", {
        space,
        open: left.length,
        ms: Math.round(performance.now() - t0),
      });
      // What recovery finalized from exit.json, or found gone, leaves machine state now.
      await this.host.check();
    } catch (error) {
      // A space that closed meanwhile takes its writer with it: its next open recovers again.
      if (this.#stillOpen(space, writer)) this.#failed("recover", error);
    }
  }

  /** Whether the space is still open with the writer a call started on. */
  #stillOpen(space: string, writer: unknown): boolean {
    return this.#options.spaces().some((s) => s.id === space && isOpen(s) && s.writer === writer);
  }

  #refused(method: "claim" | "attach" | "report", reason: HostRefusal): void {
    this.#options.log.log("launch.refused", { method, reason });
  }

  #failed(stage: "recover" | "sweep" | "check" | "dispatch" | "match", error: unknown): void {
    const code = errorCode(error);
    this.#options.log.log("launch.failed", {
      stage,
      type: errorType(error),
      ...(code === undefined ? {} : { code }),
    });
  }
}

const isOpen = (space: ServedSpace): boolean =>
  space.state === "open" && space.writer !== undefined && space.id !== undefined;

/** The environment a start without one gets: this machine's account (A4 3.8). */
function defaultEnvironment(options: LaunchServiceOptions): EnvironmentSource {
  const fixed = options.baseEnv;
  if (fixed !== undefined) {
    return {
      prepare: () => Promise.resolve(),
      base: () => Promise.resolve({ kind: "service", env: fixed() }),
      inFolder: () => Promise.resolve(undefined),
      session: () => Promise.resolve({}),
    };
  }
  const { log } = options;
  return new UserEnvironment({
    platform: options.platform,
    serviceEnv: options.env,
    stateDir: options.stateDir,
    home: options.home ?? options.stateDir,
    log: (event, fields) => {
      if (event === "launch.env_snapshot") {
        log.log("launch.env_snapshot", fields);
      } else if (event === "launch.env_registry") {
        log.log("launch.env_registry", fields);
      }
    },
  });
}

/**
 * The product's command a terminal runs (A4 3.6.1 `{shim}`), so the shim is the service's own
 * build: for a service run from source (`pnpm tasks serve`), the Node that runs it with its entry
 * script; otherwise the install's stable launcher in its command folder (`tasks`, `tasks.exe`),
 * which follows the current version. Undefined when neither is there: a terminal launch is then
 * refused before anything starts.
 */
export function defaultShimCommand(
  options: Pick<LaunchServiceOptions, "commandFolder" | "platform">,
  argv: readonly string[] = process.argv,
  execPath: string = process.execPath,
): readonly string[] | undefined {
  const entry = argv[1];
  const source =
    entry !== undefined && isAbsolute(entry) && entry.endsWith(".ts") && existsSync(entry);
  if (source) return [execPath, entry];
  const bin = options.commandFolder;
  if (bin === undefined) return undefined;
  const launcher = join(bin, options.platform === "win32" ? `${PRODUCT_ID}.exe` : PRODUCT_ID);
  return existsSync(launcher) ? [launcher] : undefined;
}

/** A PATH's absolute entries (Windows: `Path` in any case, `;`-separated). */
function pathEntries(env: Env, platform: NodeJS.Platform): string[] {
  const value =
    platform === "win32"
      ? Object.entries(env).find(([name]) => name.toUpperCase() === "PATH")?.[1]
      : env["PATH"];
  return (value ?? "")
    .split(platform === "win32" ? ";" : ":")
    .filter((entry) => entry !== "" && isAbsolute(entry));
}

/** Windows: the variables a system helper (reg.exe) needs, and nothing else of the service's. */
function helperEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && ["SYSTEMROOT", "WINDIR"].includes(key.toUpperCase())) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Windows: the folder where Windows keeps the account's app execution aliases (Windows Terminal's
 * `wt.exe`, A4 3.6.2 detection). Read only; Tasks never writes there.
 */
function windowsAppsOf(env: Env): string | undefined {
  // eslint-disable-next-line no-restricted-syntax -- where Windows keeps app aliases, never a path Tasks writes
  const name = "LOCALAPPDATA";
  const local = Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];
  return local === undefined || !win32.isAbsolute(local)
    ? undefined
    : win32.join(local, "Microsoft", "WindowsApps");
}
