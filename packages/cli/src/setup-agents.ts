// `tasks setup agents` (A3 3.13; M2.14, M4.05): Tasks's MCP server entry in this machine's agent
// homes: Claude Code's user scope, every Codex home (the Codex app reads the default one), the
// homes T3 Code's provider instances use, and Claude Desktop's configuration. Loaded only for this
// command (setup.ts), so no other command pays for the TOML reader and the lock.
//
//   tasks setup agents [--preview]  each home's change: the exact command (or, for Claude Desktop,
//                                   the one entry setup writes), the key-level diff and the hash
//                                   of every file read, and the apply command with the plan's
//                                   token. The default: it writes nothing
//   tasks setup agents --apply --plan <token>
//                                   carries out that preview: registers Tasks in each home without
//                                   an entry yet, or refuses when the plan is not the same any more
//   tasks setup agents --remove     takes back each entry setup wrote that is still exactly its own
//   tasks setup agents --status     each home, registered or not, and its agent-home row (reads only)
//   tasks setup agents print --app <name>
//                                   the entry and the file it belongs in, for an app setup does not
//                                   manage or a managed file (A3 3.13.7): a hand-made entry, which
//                                   uses the machine's default space (A3 3.7.8). Writes nothing
//   [--app claude-code,codex,claude-desktop,codex-app,t3] [--instance <id>] [--home <folder>]
//   [--parts mcp,approve-tools] [--space <id or name>] [--json]
//
// The CLI changes the homes itself, in the person's session and environment, so the apps' commands
// are the ones on the person's PATH (setup/agents.ts in @tasks/service). The service keeps the
// agent-home rows of the grants table (hub/agent-homes.ts) and says which spaces it serves. Apply
// and remove run only for a person at a terminal: a script or an agent is refused before anything
// is read or written, and the service checks the class again for every row.
//
// `approve-tools` (A3 3.13.2, 3.13.4) is shown, never applied: setup never changes another app's
// approval settings, so the preview names the change for the person to make by hand.
import { statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { isAgentMarker } from "@tasks/bridge/protocol";
import { CLI_NAME, MCP_SERVER_KEY, PRODUCT_NAME } from "@tasks/brand";
import { AppError } from "@tasks/contracts";
import { detect, nodeDetectHost, pasteShell, shellLine, type Env } from "@tasks/launch";
import { loadMachineConfig } from "@tasks/service/config";
import { homeFolder, hostFacts, resolveLayout } from "@tasks/service/paths";
import {
  AGENT_APPS,
  appLabel,
  applyHome,
  approveToolsHint,
  HOSTS,
  isPrintApp,
  LockBusy,
  planOf,
  planToken,
  PrintRefused,
  PRINT_APPS,
  PRINT_LABELS,
  removeHome,
  runCommand,
  samePath,
  SERVERS_KEY,
  SetupStateInvalid,
  SetupStateUnsafe,
  snippetFor,
  survey,
  withSetupLock,
  type AgentApp,
  type Change,
  type Host,
  type HomeView,
  type Outcome,
  type OutcomeReason,
  type PlanItem,
  type PrintApp,
  type SetupInput,
} from "@tasks/service/setup";
import { UsageError, type Globals } from "./args.ts";
import { connectService, type ConnectOptions, type Session } from "./connect.ts";
import type { Io } from "./io.ts";
import { bodyOf, printError, printUsage } from "./output.ts";
import { asAppError } from "./verbs.ts";

/** Tests only: what setup and doctor's agent checks take from this process, so they run on scratch homes. */
export interface AgentsSetupOptions {
  /** The agent environment the apps' commands run in. Default: this process's environment. */
  readonly env?: Env;
  /** The user's home folder. Default: the account's (A2 3.2.2 rule 1). */
  readonly home?: string;
  /**
   * Doctor: the argv a program stands for when doctor runs it (a fake engine in place of the Codex
   * app's `codex.exe`, the CLI from source in place of a scratch install's command). Default: as is.
   */
  readonly resolve?: (argv: readonly string[]) => readonly string[];
  /** Doctor: when Claude Desktop started, `not_running`, or undefined when unknown. */
  readonly desktopStarted?: () => Promise<number | "not_running" | undefined>;
  /** Doctor: how long a headless run of `--live` may take. Default: 180 s. */
  readonly liveMs?: number;
  /** macOS: the system's Applications folder (the Codex app's engine). Default: /Applications. */
  readonly systemApplications?: string;
}

type Mode = "preview" | "apply" | "remove" | "status" | "print";

/** What `--app` selects: an app with entries, or the hosts that read their homes. */
type AppWord = AgentApp | Host;
const APP_WORDS: readonly AppWord[] = [...AGENT_APPS, ...HOSTS];
const isAppWord = (value: string): value is AppWord =>
  (APP_WORDS as readonly string[]).includes(value);

const PARTS = ["mcp", "approve-tools"] as const;
type Part = (typeof PARTS)[number];

interface Parsed {
  readonly mode: Mode;
  readonly apps: readonly string[] | undefined;
  readonly instance: string | undefined;
  readonly home: string | undefined;
  readonly parts: readonly Part[];
  /** `--plan <token>`: the preview's plan, which `--apply` carries out or refuses. */
  readonly plan: string | undefined;
}

/** A plan token: the preview's digest (planToken). */
const PLAN = /^[0-9a-f]{16}$/u;

/** `--space` is a global option (args.ts): `globals.space` carries it here. */
function parse(input: readonly string[]): Parsed {
  let mode: Mode | undefined;
  let args = input;
  if (args[0] === "print") {
    mode = "print";
    args = args.slice(1);
  } else if (args[0] === "print-block") {
    throw new UsageError(`${CLI_NAME} setup agents print-block is not in this build yet`);
  }
  let apps: string[] | undefined;
  let instance: string | undefined;
  let home: string | undefined;
  let parts: Part[] | undefined;
  let plan: string | undefined;
  const value = (token: string, i: number): string => {
    const inline = token.indexOf("=");
    const found = inline === -1 ? args[i + 1] : token.slice(inline + 1);
    if (found === undefined || found === "") throw new UsageError(`${token} needs a value`);
    return found;
  };
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? "";
    const name = token.split("=")[0] ?? "";
    const step = token.includes("=") ? 0 : 1;
    if (["--preview", "--apply", "--remove", "--status"].includes(token)) {
      if (mode !== undefined) {
        throw new UsageError("Name one of --preview, --apply, --remove, --status and print");
      }
      mode = token.slice(2) as Mode;
    } else if (name === "--app") {
      const list = value(token, i).split(",");
      apps = list;
      i += step;
    } else if (name === "--instance") {
      instance = value(token, i);
      i += step;
    } else if (name === "--home") {
      home = value(token, i);
      i += step;
    } else if (name === "--parts") {
      const list = value(token, i).split(",");
      if (list.includes("block")) {
        throw new UsageError(`${CLI_NAME} setup agents --parts block is not in this build yet`);
      }
      if (!list.every((p): p is Part => (PARTS as readonly string[]).includes(p))) {
        throw new UsageError("--parts takes mcp, approve-tools or both");
      }
      parts = list;
      i += step;
    } else if (name === "--plan") {
      plan = value(token, i);
      if (!PLAN.test(plan)) throw new UsageError("--plan takes the token the preview printed");
      i += step;
    } else {
      throw new UsageError(
        `${CLI_NAME} setup agents has no option ${/^--[a-z-]{1,30}$/.test(name) ? name : "like that"}`,
      );
    }
  }
  const chosen = mode ?? "preview";
  if (plan !== undefined && chosen !== "apply") throw new UsageError("--plan goes with --apply");
  if (parts !== undefined) {
    if (chosen === "status" || chosen === "print") {
      throw new UsageError("--parts goes with the preview, --apply and --remove");
    }
    // Remove takes out what setup wrote, and setup never writes approve-tools: a remove of only
    // that part must not take the MCP entries out.
    if (chosen === "remove" && !parts.includes("mcp")) {
      throw new UsageError(
        `setup never writes approve-tools, so there is nothing of it to remove; ${CLI_NAME} setup agents --remove takes out the MCP entries`,
      );
    }
  }
  if (chosen === "print") {
    if (apps?.length !== 1 || !isPrintApp(apps[0])) {
      throw new UsageError(`print takes --app and one of ${PRINT_APPS.join(", ")}`);
    }
  } else if (apps !== undefined && !apps.every(isAppWord)) {
    throw new UsageError(`--app takes ${APP_WORDS.join(", ")}`);
  }
  return { mode: chosen, apps, instance, home, parts: parts ?? ["mcp"], plan };
}

/** A person at a terminal (A2 3.6.5's `cli-interactive`): no agent marker, both ends a TTY. */
function userAtTerminal(io: Io): boolean {
  const agent = Object.entries(io.env).some(([n, v]) => v !== undefined && isAgentMarker(n));
  return !agent && io.tty.stdin && io.tty.stdout;
}

const forbidden = (): AppError =>
  new AppError({
    code: "forbidden",
    message: "Only the user can change the agent homes, from an interactive terminal.",
    hint: `Ask the user to run: ${CLI_NAME} setup agents --apply`,
    data: { rule: "user_only" },
  });

/**
 * The app's command as the person would run it, its variables first, as one line for PowerShell on
 * Windows and a POSIX shell elsewhere (launch's shell-line.ts, A3 3.13.7). Undefined when a word
 * holds a character no quoting keeps literal there.
 */
const commandLine = (platform: NodeJS.Platform, change: Change): string | undefined =>
  shellLine(platform, [...change.exec, ...change.args], change.set);

const REASON: Readonly<Record<OutcomeReason, string>> = {
  unreadable: "its file cannot be read",
  too_large: "its file is too large",
  encoding: "its file is not UTF-8 text",
  invalid_file: "its file is not valid (a key written twice counts)",
  duplicate_key: "its file has a key written twice",
  managed: `its file is managed elsewhere (a link, marked as generated, listed in machine.toml's [setup.managed] paths, or tracked by another git repository): ${CLI_NAME} setup agents print --app <app> shows the entry to add at its source`,
  unsafe: "its file or folder belongs to another user, or anyone can change it",
  wrong_type: "its servers are not a table",
  unsupported_layout:
    "its MCP servers are written in a layout setup cannot keep (inline, dotted keys, or JSON it cannot splice)",
  foreign_entry: `it has an entry named ${MCP_SERVER_KEY} that setup did not write`,
  no_command: "the app's command was not found on this PATH",
  not_set_up:
    "Claude Desktop has not made its configuration file yet: open its Settings, then Developer, once, and run setup again",
  ambiguous: `there are several Claude Desktop configuration files: pass --home <folder> for the one the app uses`,
  edited: "the entry was changed after setup wrote it",
  interrupted: `an earlier apply did not finish: run ${CLI_NAME} setup agents --remove`,
  missing: "the entry setup wrote is gone",
  not_registered: "setup has not registered it",
  changed_meanwhile: "its file changed while setup was working",
  command_failed: "the app's command failed; run the command from the preview to see why",
  unexpected_entry: "the app's command did not write the entry setup asked for",
  other_space: `it names another space: run ${CLI_NAME} setup agents --remove first`,
  grant_failed: `${PRODUCT_NAME}'s service did not keep its grant row, so nothing was changed there`,
};

const NOTE: Readonly<Record<string, string>> = {
  empty_parent_kept: `Claude Code keeps an empty ${SERVERS_KEY["claude-code"]} object after its own remove. ${PRODUCT_NAME} never edits that file.`,
  undo_failed: `The entry may still be there: run ${CLI_NAME} setup agents --remove.`,
  entry_left:
    "The entry there is not exactly the one setup asked for, so it was left as it is: take it out by hand if it is not wanted.",
};

const STATE_TEXT: Readonly<Record<HomeView["state"], string>> = {
  not_registered: "not registered",
  registered: "registered",
  edited: "registered, then changed by hand",
  missing: "registered, entry gone",
  interrupted: "an apply that did not finish",
  refused: "left alone",
};

const HOST_TEXT: Readonly<Record<Host, string>> = { "codex-app": "the Codex app", t3: "T3 Code" };

const title = (view: Pick<HomeView, "home">): string => {
  const hosts = view.home.hosts.map((h) => HOST_TEXT[h]);
  const also = hosts.length === 0 ? "" : `; also read by ${hosts.join(" and ")}`;
  return `${appLabel(view.home.app)} · ${view.home.home} (instance ${view.home.instance}${also})`;
};

const viewJson = (view: HomeView) => ({
  app: view.home.app,
  home: view.home.home,
  file: view.home.file,
  instance: view.home.instance,
  account: view.home.account,
  hosts: view.home.hosts,
  state: view.state,
  ...(view.refusal === undefined ? {} : { reason: view.refusal }),
  sha256: view.sha256,
  ...(view.record === undefined ? {} : { space: view.record.space, grant: view.record.grant }),
});

const outcomeJson = (outcome: Outcome) => ({
  app: outcome.home.app,
  home: outcome.home.home,
  instance: outcome.home.instance,
  result: outcome.result,
  ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
  ...(outcome.notes === undefined ? {} : { notes: outcome.notes }),
});

interface SpaceRow {
  readonly id?: string;
  readonly name?: string;
  readonly state?: string;
}

/**
 * The space each new entry names (A3 3.13.1): `--space` (an ID or a name), else the
 * machine's default space (machine.toml's `[service] default_space`) when the service serves it,
 * else the one space the service serves.
 */
async function pickSpace(
  call: Call,
  wanted: string | undefined,
  machineDefault: string | undefined,
): Promise<string> {
  const listed = (await call("space/list", {})) as { spaces?: SpaceRow[] };
  const served = (listed.spaces ?? []).filter(
    (s): s is SpaceRow & { id: string } => typeof s.id === "string" && s.state !== "closed",
  );
  const byDefault = served.filter((s) => s.id === machineDefault);
  const found =
    wanted !== undefined
      ? served.filter((s) => s.id === wanted || s.name?.toLowerCase() === wanted.toLowerCase())
      : byDefault.length > 0
        ? byDefault
        : served;
  const [only, other] = found;
  if (only !== undefined && other === undefined) return only.id;
  throw new AppError({
    code: "invalid_input",
    message:
      wanted !== undefined
        ? found.length === 0
          ? "The service serves no space by that ID or name."
          : "Several spaces have that name."
        : served.length === 0
          ? "The service serves no space yet."
          : "The service serves several spaces: name the one the agents use.",
    hint:
      served.length === 0
        ? `Create one first: ${CLI_NAME} space create`
        : `Pass --space <id or name>. ${CLI_NAME} space list shows them.`,
    data: { issues: [{ path: "space", message: "Name one served space" }] },
  });
}

/** What setup reads and runs on this machine, for `tasks setup agents` and `tasks doctor`. */
export async function setupInputOf(
  io: Io,
  options: { readonly agents?: AgentsSetupOptions },
): Promise<{ input: SetupInput; defaultSpace: string | undefined; root: string }> {
  const facts = hostFacts(io.env, io.platform);
  const layout = resolveLayout(facts);
  const env = options.agents?.env ?? io.env;
  const userHome = options.agents?.home ?? homeFolder(facts);
  // The install's stable command (A2 3.12) in the layout's command folder: `~/.local/bin/tasks`,
  // or `<root>/bin/tasks` of a TASKS_HOME install (`tasks.exe` on Windows).
  const tasks = (io.platform === "win32" ? win32 : posix).join(
    layout.bin,
    io.platform === "win32" ? `${CLI_NAME}.exe` : CLI_NAME,
  );
  const detection = await detect(nodeDetectHost({ platform: io.platform, env, home: userHome }));
  // machine.toml as the service reads it; a problem in it only drops what it names.
  const machine = loadMachineConfig(layout.config, io.platform).config;
  return {
    input: {
      platform: io.platform,
      userHome,
      env,
      stateDir: layout.state,
      tasks,
      detection,
      instances: machine.instances,
      managedPaths: machine.setup.managedPaths,
      ...(options.agents?.systemApplications === undefined
        ? {}
        : { systemApplications: options.agents.systemApplications }),
      isFolder,
      run: (argv, childEnv) =>
        runCommand(options.agents?.resolve?.(argv) ?? argv, childEnv, userHome),
    },
    defaultSpace: machine.service.defaultSpace,
    root: layout.root,
  };
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export async function agentsCommand(
  io: Io,
  globals: Globals,
  args: readonly string[],
  options: ConnectOptions & { readonly agents?: AgentsSetupOptions },
): Promise<number> {
  let session: Session | undefined;
  const timeoutMs = globals.timeoutS * 1000;
  const call = async (method: string, params: Record<string, unknown>) => {
    session ??= await connectService(io, options);
    return (await session.call(method, params, { timeoutMs })) as Record<string, unknown>;
  };
  try {
    const parsed = parse(args);
    if ((parsed.mode === "apply" || parsed.mode === "remove") && !userAtTerminal(io)) {
      throw forbidden();
    }
    // Apply carries out a preview the person has seen, or nothing (A3 3.13.1).
    if (parsed.mode === "apply" && parsed.plan === undefined) {
      throw new UsageError(
        `${CLI_NAME} setup agents --apply needs --plan: run ${CLI_NAME} setup agents first and use the command it prints`,
      );
    }
    const { input, defaultSpace, root } = await setupInputOf(io, options);
    const selected: Selected = (view) =>
      (parsed.apps === undefined ||
        parsed.apps.includes(view.home.app) ||
        view.home.hosts.some((h) => parsed.apps?.includes(h))) &&
      (parsed.instance === undefined || view.home.instance === parsed.instance) &&
      (parsed.home === undefined || samePath(input.platform, view.home.home, parsed.home));
    const spaceOf = () => pickSpace(call, globals.space, defaultSpace);
    const mode: Mode = parsed.mode;
    switch (mode) {
      case "status":
        return await status(io, globals, input, selected, call);
      case "preview":
        return await preview(io, globals, input, selected, parsed, spaceOf);
      case "print":
        // A printed entry is a hand-made one, which uses the machine's default space (print.ts).
        if (globals.space !== undefined) {
          throw new UsageError(
            "print takes no --space: an entry added by hand uses the machine's default space",
          );
        }
        return printCommand(io, globals, input, parsed.apps?.[0] as PrintApp);
      case "apply": {
        if (!isFolder(root) || !exists(input.tasks)) {
          throw new AppError({
            code: "invalid_input",
            message: `${PRODUCT_NAME}'s command is not installed where the entries would run it.`,
            hint: "Install it first; the entries run the installed command, never a source tree.",
            data: { issues: [{ path: "command", message: "Not installed" }] },
          });
        }
        const outcomes = await withSetupLock(input.stateDir, async () => {
          // The preview again, under the lock: apply goes on only when it is the plan the
          // person saw (`--plan`), whatever changed in the homes, machine.toml or the spaces.
          const views = parsed.parts.includes("mcp") ? survey(input).filter(selected) : [];
          const space = needsSpace(views) ? await spaceOf() : "";
          const items = planOf(input, views, space);
          if (planToken(space, items) !== parsed.plan) {
            throw new AppError({
              code: "conflict",
              message: "The agent homes changed since the preview, so nothing was changed.",
              hint: `Run ${CLI_NAME} setup agents again and use the command it prints.`,
            });
          }
          const done: Outcome[] = [];
          for (const item of items) done.push(await applyOne(input, item, space, call));
          return done;
        });
        return report(io, globals, "apply", outcomes);
      }
      case "remove": {
        const { outcomes, notes } = await withSetupLock(input.stateDir, async () => {
          const views = survey(input).filter((view) => selected(view) && view.record !== undefined);
          // Reverse order (A3 3.13.1): the latest apply first.
          views.sort((a, b) => (b.record?.at ?? "").localeCompare(a.record?.at ?? ""));
          const done: Outcome[] = [];
          for (const view of views) done.push(await removeHome(input, view));
          // Under the same lock: an apply that runs right after must not lose its row to this.
          return { outcomes: done, notes: await revokeLeftRows(input, selected, call) };
        });
        return report(io, globals, "remove", outcomes, notes);
      }
      default: {
        const never: never = mode;
        return never;
      }
    }
  } catch (error) {
    if (error instanceof UsageError) return printUsage(io, globals.json, error.message);
    return printError(io, globals.json, bodyOf(asAppError(setupError(error))));
  } finally {
    session?.close();
  }
}

function exists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Setup's own failures as A3's error bodies. */
function setupError(error: unknown): unknown {
  if (error instanceof LockBusy) {
    return new AppError({
      code: "conflict",
      message: `Another ${CLI_NAME} setup agents is running.`,
      hint: "Try again when it has finished.",
    });
  }
  if (error instanceof SetupStateInvalid || error instanceof SetupStateUnsafe) {
    return new AppError({
      code: "invalid_input",
      message: `${error.message}, so nothing was changed.`,
      hint: `Run: ${CLI_NAME} doctor`,
    });
  }
  return error;
}

type Call = (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Whether `--app`, `--instance` and `--home` select a home. */
type Selected = (view: {
  readonly home: {
    readonly app: AgentApp;
    readonly instance: string;
    readonly home: string;
    readonly hosts: readonly Host[];
  };
}) => boolean;

/** One home's apply: its agent-home row first (the service checks the class), then the entry. */
async function applyOne(
  input: SetupInput,
  item: PlanItem,
  space: string,
  call: Call,
): Promise<Outcome> {
  const { view, change } = item;
  const { home } = view;
  // A registered home's row is renewed for the space its entry names, unless this apply names a
  // space for new entries: an entry of another space is then left (`other_space`).
  const target = view.state === "registered" && space === "" ? (view.record?.space ?? "") : space;
  const registered = view.state === "registered" && view.record?.space === target;
  if (view.state !== "not_registered" && !registered) {
    return applyHome(input, view, target, null);
  }
  if (view.state === "not_registered" && (change === undefined || typeof change === "string")) {
    return applyHome(input, view, space, null, change);
  }
  let granted: Record<string, unknown>;
  try {
    granted = await call("setup/home_grant", {
      app: home.app,
      home: home.home,
      instance: home.instance,
      account: home.account,
      hosts: home.hosts,
      space: target,
    });
  } catch {
    // The service refused the row or is gone: this home is left as it is, the others still run
    // and every outcome is reported.
    return { home, result: "failed", reason: "grant_failed" };
  }
  const grant = (granted["grant"] as { grant?: unknown } | undefined)?.grant;
  const grantId = typeof grant === "string" ? grant : null;
  const outcome = await applyHome(input, view, target, grantId, change);
  if (outcome.result === "failed" && granted["created"] === true && grantId !== null) {
    try {
      await call("setup/home_revoke", { grants: [grantId] });
    } catch {
      // The row stays; `--remove` revokes the rows of homes without an entry of setup's.
    }
  }
  return outcome;
}

/** Whether apply registers a home, so it needs the space new entries name (from the service). */
const needsSpace = (views: readonly HomeView[]): boolean =>
  views.some((view) => view.state === "not_registered");

/** Whether apply has anything to do: a home to register, or a registered one whose row it renews. */
const applies = (views: readonly HomeView[]): boolean =>
  needsSpace(views) || views.some((view) => view.state === "registered");

/**
 * After a remove: revokes the agent-home rows of the selected homes that no longer have an entry of
 * setup's, also rows a remove without the service left behind. Without the service the rows stay,
 * and the person is told.
 */
async function revokeLeftRows(
  input: SetupInput,
  selected: Selected,
  call: Call,
): Promise<string[]> {
  let rows: { grant: string; app: string; home: string; instance: string; hosts?: string[] }[];
  try {
    rows = ((await call("setup/homes", {}))["homes"] ?? []) as typeof rows;
  } catch {
    return [
      `${PRODUCT_NAME}'s service is not running, so the homes' grant rows stay. Run ${CLI_NAME} setup agents --remove again once it runs.`,
    ];
  }
  const views = survey(input);
  const stale = rows.filter((row) => {
    if (!(AGENT_APPS as readonly string[]).includes(row.app)) return false;
    const view = views.find(
      (v) => v.home.app === row.app && samePath(input.platform, v.home.home, row.home),
    );
    // A home that is gone is selected by its row's app, instance, home and hosts.
    const pick = selected(
      view ?? {
        home: {
          app: row.app as AgentApp,
          instance: row.instance,
          home: row.home,
          hosts: (row.hosts ?? []).filter((h): h is Host =>
            (HOSTS as readonly string[]).includes(h),
          ),
        },
      },
    );
    return pick && view?.record === undefined;
  });
  if (stale.length > 0) await call("setup/home_revoke", { grants: stale.map((r) => r.grant) });
  return [];
}

async function status(
  io: Io,
  globals: Globals,
  input: SetupInput,
  selected: Selected,
  call: Call,
): Promise<number> {
  const views = survey(input).filter(selected);
  let rows: { grant: string; app: string; home: string; spaces: string[] }[] | undefined;
  try {
    rows = ((await call("setup/homes", {}))["homes"] ?? []) as typeof rows;
  } catch {
    rows = undefined;
  }
  const rowOf = (view: HomeView) =>
    rows?.find((r) => r.app === view.home.app && samePath(input.platform, r.home, view.home.home));
  if (globals.json) {
    io.stdout(
      `${JSON.stringify({
        homes: views.map((view) => ({ ...viewJson(view), row: rowOf(view)?.grant ?? null })),
        service: rows !== undefined,
      })}\n`,
    );
    return 0;
  }
  if (views.length === 0) io.stdout("No agent home was found.\n");
  for (const view of views) {
    const row = rowOf(view);
    const reason = view.refusal === undefined ? "" : `: ${REASON[view.refusal]}`;
    const space = view.record === undefined ? "" : `, space ${view.record.space}`;
    const grant =
      rows === undefined ? "" : row === undefined ? ", no grant row" : `, grant row ${row.grant}`;
    io.stdout(`${title(view)}\n  ${STATE_TEXT[view.state]}${reason}${space}${grant}\n`);
  }
  if (rows === undefined) {
    io.stdout(`${PRODUCT_NAME}'s service is not running: the grant rows are not shown.\n`);
  }
  return 0;
}

/** The approve-tools part of each selected home: a change for the person to make, never made. */
function approvals(views: readonly HomeView[], platform: NodeJS.Platform) {
  return views.flatMap((view) => {
    const hint = approveToolsHint(view.home.app, view.home.home, platform);
    return hint === undefined ? [] : [{ view, ...hint }];
  });
}

async function preview(
  io: Io,
  globals: Globals,
  input: SetupInput,
  selected: Selected,
  parsed: Parsed,
  spaceOf: () => Promise<string>,
): Promise<number> {
  const all = survey(input).filter(selected);
  const views = parsed.parts.includes("mcp") ? all : [];
  const registers = needsSpace(views);
  const anything = applies(views);
  // The space each new entry names comes from the service, which keeps the rows apply makes.
  const space = registers ? await spaceOf() : "";
  const items = planOf(input, views, space);
  const plan = planToken(space, items);
  const delegated = parsed.parts.includes("approve-tools") ? approvals(all, io.platform) : [];
  // The exact apply of this preview: the same selection, the same space, and the plan's token.
  const apply = [
    CLI_NAME,
    "setup",
    "agents",
    "--apply",
    "--plan",
    plan,
    ...(parsed.apps === undefined ? [] : ["--app", parsed.apps.join(",")]),
    ...(parsed.instance === undefined ? [] : ["--instance", parsed.instance]),
    ...(parsed.home === undefined ? [] : ["--home", parsed.home]),
    // The space by its ID, which the preview resolved: the same space, and safe in any shell.
    ...(registers ? ["--space", space] : []),
  ];
  if (globals.json) {
    io.stdout(
      `${JSON.stringify({
        mode: "preview",
        ...(registers ? { space } : {}),
        ...(anything ? { plan, apply } : {}),
        homes: items.map(({ view, change }) => ({
          ...viewJson(view),
          ...(change === undefined
            ? {}
            : typeof change === "string"
              ? { state: "refused", reason: change }
              : {
                  change: {
                    writer: change.writer,
                    exec: change.exec,
                    args: change.args,
                    env: change.set,
                    unset: change.unset,
                    diff: change.diff,
                  },
                }),
        })),
        ...(parsed.parts.includes("approve-tools")
          ? {
              approve_tools: delegated.map((d) => ({
                app: d.view.home.app,
                instance: d.view.home.instance,
                file: d.file,
                change: d.text,
                delegated: true,
              })),
            }
          : {}),
      })}\n`,
    );
    return 0;
  }
  if (parsed.parts.includes("mcp") && items.length === 0) io.stdout("No agent home was found.\n");
  let n = 0;
  let changes = 0;
  for (const { view, change } of items) {
    n += 1;
    io.stdout(`${String(n)}. ${title(view)}\n`);
    const hash = view.sha256 === null ? "not there yet" : `sha256 ${view.sha256}`;
    io.stdout(`   ${view.home.file} (${hash})\n`);
    if (change === undefined) {
      const reason = view.refusal === undefined ? "" : `: ${REASON[view.refusal]}`;
      io.stdout(`   ${STATE_TEXT[view.state]}${reason}. Nothing to do.\n`);
    } else if (typeof change === "string") {
      io.stdout(`   left alone: ${REASON[change]}.\n`);
    } else {
      changes += 1;
      if (change.writer === "edit") {
        io.stdout(`   writes one entry into this file (the app has no command for it)\n`);
      } else {
        io.stdout(
          `   runs: ${commandLine(io.platform, change) ?? `the app's own command, whose words no line for ${pasteShell(io.platform)} keeps as they are (--json lists them)`}\n`,
        );
        if (change.unset.length > 0) {
          io.stdout(`   without ${change.unset.join(", ")} from your environment\n`);
        }
      }
      const by =
        view.home.app === "codex"
          ? `the command writes the table; ${PRODUCT_NAME} adds the last ${String(change.patches.length)} keys`
          : change.writer === "edit"
            ? `${PRODUCT_NAME} writes these keys`
            : "the command writes these keys";
      io.stdout(`   diff (${by}):\n`);
      for (const line of change.diff) io.stdout(`     ${line}\n`);
    }
  }
  if (delegated.length > 0) {
    io.stdout(
      `approve-tools: ${PRODUCT_NAME} never changes another app's approval settings. To approve its tools yourself:\n`,
    );
    for (const d of delegated) {
      io.stdout(
        `  ${appLabel(d.view.home.app)} (instance ${d.view.home.instance}): in ${d.file}, ${d.text}\n`,
      );
    }
  }
  if (!parsed.parts.includes("mcp")) return 0;
  // A --home no line keeps as it is: the person's own command again, with the apply's words.
  const line =
    shellLine(io.platform, apply) ??
    `this command again with --apply --plan ${plan}${registers ? ` --space ${space}` : ""} in place of --preview`;
  io.stdout(
    !anything
      ? "Nothing was changed.\n"
      : changes === 0
        ? `Nothing was changed. To renew the registered homes' grant rows, run: ${line}\n`
        : `Nothing was changed. To make ${changes === 1 ? "this change" : `these ${String(changes)} changes`}, run: ${line}\n`,
  );
  return 0;
}

/** `print --app <name>`: the entry and where it goes. Reads no home and writes nothing. */
function printCommand(io: Io, globals: Globals, input: SetupInput, app: PrintApp): number {
  let snippet;
  try {
    snippet = snippetFor(input, app);
  } catch (error) {
    if (!(error instanceof PrintRefused)) throw error;
    throw new AppError({
      code: "invalid_input",
      message: `${PRODUCT_NAME}'s command path holds a character that no line pasted into ${error.runIn} keeps as it is (on Windows % ! ^ & | < > ", anywhere a control character), so no command is printed.`,
      hint: `Run ${CLI_NAME} setup agents: it runs the app's own command without a shell.`,
      data: { issues: [{ path: "command", message: "Cannot be quoted for a shell" }] },
    });
  }
  if (globals.json) {
    io.stdout(`${JSON.stringify(snippet)}\n`);
    return 0;
  }
  const where = snippet.files.length === 1 ? "in" : "in one of";
  io.stdout(
    snippet.format === "command"
      ? `${PRINT_LABELS[app]}: run this in ${snippet.runIn ?? pasteShell(io.platform)}; it writes the entry ${where} ${snippet.files.join(", ")}\n`
      : `${PRINT_LABELS[app]}: add this ${where} ${snippet.files.join(", ")}, keeping what is there\n`,
  );
  io.stdout(snippet.text);
  io.stdout("Nothing was changed.\n");
  return 0;
}

function report(
  io: Io,
  globals: Globals,
  mode: "apply" | "remove",
  outcomes: readonly Outcome[],
  notes: readonly string[] = [],
): number {
  const complete = outcomes.every((o) => o.result !== "failed" && o.result !== "left");
  if (globals.json) {
    io.stdout(
      `${JSON.stringify({ mode, homes: outcomes.map(outcomeJson), ...(notes.length === 0 ? {} : { notes }) })}\n`,
    );
  } else {
    if (outcomes.length === 0) io.stdout("Nothing to do.\n");
    const verb = {
      applied: "registered",
      removed: "removed",
      unchanged: "unchanged",
      left: "left alone",
      failed: "failed",
    } as const;
    for (const outcome of outcomes) {
      const reason =
        outcome.reason === undefined || outcome.result === "removed"
          ? ""
          : `: ${REASON[outcome.reason]}`;
      io.stdout(`${title(outcome)}\n  ${verb[outcome.result]}${reason}\n`);
      for (const note of outcome.notes ?? []) io.stdout(`  ${NOTE[note] ?? note}\n`);
    }
    for (const note of notes) io.stdout(`${note}\n`);
    const changed = outcomes.filter((o) => o.result === "applied" || o.result === "removed");
    if (changed.some((o) => o.home.app === "claude-desktop")) {
      // A3 3.13.3: the app loads its configuration only when it starts.
      io.stdout("Quit and reopen Claude Desktop to load the change.\n");
    }
    if (mode === "apply" && changed.some((o) => o.home.app !== "claude-desktop")) {
      io.stdout("Restart the agent apps' sessions to load the entry.\n");
    }
  }
  return complete ? 0 : 10;
}
