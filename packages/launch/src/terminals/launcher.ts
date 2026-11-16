// The terminal route's start (A4 3.6.2, 3.7): the chain of this machine's terminals, each command
// line built with the launch's ticket, wrapped in a transient scope on Linux, started by the
// spawner, and judged by its adapter's acceptance rule (accept.ts).
//
// Linux scopes: the first launch after a start probes `systemd-run --user --scope … true` (A4
// 3.6.2); when the probe fails, or there is no systemd-run, terminals start detached in a session
// of their own instead (`setsid`, A4 3.7's fallback), and doctor will say a restart may end them.
// Windows: Windows Terminal's client is a normal child (it hands off at once, and the tab belongs
// to Windows Terminal, measured by M0 S04); the console's starter is a hidden normal child too,
// and the shim it starts through ShellExecute gets a console of its own, outside the service's
// kill-on-close job (libuv's job lets a child's children break away silently).
import { posix } from "node:path";
import type { TerminalSettings } from "../sections.ts";
import {
  acceptTerminal,
  osSpawner,
  type Attempt,
  type BuiltCommand,
  type Spawner,
  type TicketControl,
} from "./accept.ts";
import {
  scopeCommand,
  scopeProbe,
  scopeUnit,
  terminalCommand,
  type AdapterApp,
} from "./commands.ts";
import {
  terminalChoice,
  type ChainEntry,
  type TerminalChoice,
  type TerminalHost,
  type TerminalSource,
} from "./detect.ts";
import type { DispatchOutcome } from "../machine.ts";

/** How long the scope probe may take. */
export const SCOPE_PROBE_MS = 5_000;

export interface TerminalLauncherOptions {
  readonly platform: NodeJS.Platform;
  readonly settings: TerminalSettings;
  /** The install ID, for scope unit names (A4 3.7). */
  readonly install: string;
  /**
   * The product's own command, absolute program first: the stable launcher (`<root>/bin/tasks`),
   * or `node <entry>` for a service run from source. `shim <ticket>` follows it.
   */
  readonly shimCommand: readonly string[] | undefined;
  /**
   * Detection's view of this machine, with the session's variables, the person's PATH and, on
   * Windows, the default terminal setting read now.
   */
  readonly host: (
    session: Readonly<Record<string, string>>,
  ) => TerminalHost | Promise<TerminalHost>;
  /**
   * Whether the program a command runs is there, right before its spawn, without blocking the
   * service (detect.ts fileProbe). Default: the host's answer.
   */
  readonly executable?: (path: string) => Promise<boolean>;
  /** `systemd-run`, absolute, or undefined (no user manager, or not Linux). */
  readonly systemdRun: string | undefined;
  /** `true`, absolute, for the scope probe. */
  readonly trueProgram?: string;
  readonly spawn?: Spawner;
  readonly watchMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface TerminalStartInput {
  /** The launch's ID: the scope's unit name carries it. */
  readonly launch: string;
  /** The folder resolved right before the launch: the terminal's working directory. */
  readonly folder: string;
  readonly tickets: TicketControl;
  /** The terminal's environment (environment.ts terminalEnvironment). */
  readonly env: Readonly<Record<string, string>>;
  /** The session layer now (Linux), for detection's TERMINAL. */
  readonly session: Readonly<Record<string, string>>;
}

export class TerminalLauncher {
  readonly #o: TerminalLauncherOptions;
  readonly #spawn: Spawner;
  /** The scope probe's answer, once per start of the service. */
  #scopes: Promise<boolean> | undefined;

  constructor(options: TerminalLauncherOptions) {
    this.#o = options;
    this.#spawn = options.spawn ?? osSpawner;
  }

  /**
   * Whether a terminal launch can start at all: the product's command is known on an OS the
   * adapters serve. Which terminal opens is decided at the launch (A4 3.6.2's chain).
   */
  ready(): boolean {
    return this.#o.shimCommand !== undefined && this.#o.platform !== "darwin";
  }

  /** Whether terminals go into transient scopes (Linux, with a working user manager). */
  scopes(env: Readonly<Record<string, string>>): Promise<boolean> {
    this.#scopes ??= this.#probe(env);
    return this.#scopes;
  }

  async #probe(env: Readonly<Record<string, string>>): Promise<boolean> {
    const run = this.#o.systemdRun;
    if (this.#o.platform !== "linux" || run === undefined) return false;
    try {
      const started = await this.#spawn({
        argv: scopeProbe(run, this.#o.trueProgram ?? "/bin/true"),
        cwd: "/",
        env,
        detached: true,
      });
      const exit = await Promise.race([
        started.exited,
        new Promise<undefined>((resolve) => {
          setTimeout(() => {
            resolve(undefined);
          }, SCOPE_PROBE_MS).unref();
        }),
      ]);
      // A probe that did not answer in time is ended, with what it started: no scopes.
      if (exit === undefined) started.stop();
      return exit?.code === 0;
    } catch {
      return false;
    }
  }

  /** The choice a launch now would make: settings over what this machine has now (doctor). */
  async choose(session: Readonly<Record<string, string>>): Promise<TerminalChoice> {
    return terminalChoice(this.#o.settings, await this.#o.host(session));
  }

  /**
   * Starts the launch's terminal by the chain and the acceptance rules. `terminal` is the one that
   * was Dispatched, with why it was in the chain.
   */
  async start(input: TerminalStartInput): Promise<{
    outcome: DispatchOutcome;
    attempts: Attempt[];
    scoped: boolean;
    terminal?: { app: AdapterApp; source: TerminalSource };
  }> {
    const product = this.#o.shimCommand;
    if (product === undefined || product.length === 0) {
      return { outcome: { kind: "refused", reason: "refused" }, attempts: [], scoped: false };
    }
    const scoped = await this.scopes(input.env);
    const host = await this.#o.host(input.session);
    const chain = terminalChoice(this.#o.settings, host).chain;
    const run = this.#o.systemdRun;
    const build = (entry: ChainEntry, ticket: string, attempt: number) => {
      const command = terminalCommand({
        app: entry.app,
        program: entry.program,
        shim: [...product, "shim", ticket],
        platform: this.#o.platform,
        window: this.#o.settings.window,
        ...(this.#o.settings.custom === undefined ? {} : { custom: this.#o.settings.custom }),
        ...(entry.linkKind === undefined ? {} : { linkKind: entry.linkKind }),
      });
      if ("refused" in command) return command;
      const program = command.argv[0] ?? "";
      const argv =
        scoped && run !== undefined
          ? scopeCommand(run, scopeUnit(this.#o.install, input.launch, attempt), command.argv)
          : command.argv;
      const built: BuiltCommand = { ...command, argv, program };
      return built;
    };
    const ready = async (program: string): Promise<boolean> =>
      (this.#o.platform === "win32" || posix.isAbsolute(program)) &&
      (this.#o.executable === undefined
        ? host.executable(program)
        : await this.#o.executable(program));
    const result = await acceptTerminal({
      chain,
      build,
      ready,
      spawn: this.#spawn,
      tickets: input.tickets,
      cwd: input.folder,
      env: input.env,
      ...(this.#o.watchMs === undefined ? {} : { watchMs: this.#o.watchMs }),
      ...(this.#o.sleep === undefined ? {} : { sleep: this.#o.sleep }),
    });
    // The last attempt is the one that ended the chain; it was Dispatched when the outcome is not
    // a refusal. Each adapter is in the chain once.
    const last = result.attempts.at(-1);
    const used =
      result.outcome.kind === "refused" || last === undefined
        ? undefined
        : chain.find((entry) => entry.app === last.app);
    return {
      ...result,
      scoped,
      ...(used === undefined ? {} : { terminal: { app: used.app, source: used.source } }),
    };
  }
}
