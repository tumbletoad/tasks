// `ttasks setup agents` (A3 3.13; M2.14, M4.05): TTasks's MCP server entry in this machine's agent
// homes: Claude Code's user scope, every Codex home (the Codex app reads the default one), the
// homes T3 Code's provider instances use, and Claude Desktop's configuration. Loaded only for this
// command (setup.ts), so no other command pays for the TOML reader and the lock.
//
//   ttasks setup agents [--preview]  each home's change: the exact command (or, for Claude Desktop,
//                                   the one entry setup writes), the key-level diff and the hash
//                                   of every file read, and the apply command with the plan's
//                                   token. The default: it writes nothing
//   ttasks setup agents --apply --plan <token>
//                                   carries out that preview: registers TTasks in each home without
//                                   an entry yet, or refuses when the plan is not the same any more
//   ttasks setup agents --remove     turns each home's access off, then takes back each entry setup
//                                   wrote that is still exactly its own
//   ttasks setup agents --status     each home, registered or not, and its agent-home row (reads only)
//   ttasks setup agents print --app <name>
//                                   the entry and the file it belongs in, for an app setup does not
//                                   manage or a managed file (A3 3.13.7): a hand-made entry, which
//                                   names the machine's default space, the one such an entry may
//                                   use. Writes nothing
//   ttasks setup agents print-block --for claude|agents
//                                   the instruction block and the file it belongs in, for a managed
//                                   file's source or an app setup does not write (A3 3.12). Reads no
//                                   home and writes nothing
//   [--app claude-code,codex,claude-desktop,codex-app,t3] [--instance <id>] [--home <folder>]
//   [--parts mcp,approve-tools,block] [--space <id or name>] [--json]
//
// `block` (A3 3.12, setup/block.ts) is the optional instruction block in each Claude Code and Codex
// home's instruction file: the preview shows its unified diff, apply writes exactly that, and
// remove takes back only a block that is still exactly setup's. It names no space and needs no
// service, so a plan of only that part asks the service nothing.
//
// The CLI changes the homes itself, in the person's session and environment, so the apps' commands
// are the ones on the person's PATH (setup/agents.ts in @ttasks/service). The service keeps the
// agent-home rows of the grants table (hub/agent-homes.ts) and says which spaces it serves. Apply
// and remove run only for a person at a terminal: a script or an agent is refused before anything
// is read or written, and the service checks the class again for every row.
//
// `approve-tools` (A3 3.13.2, 3.13.4) is shown, never applied: setup never changes another app's
// approval settings, so the preview names the change for the person to make by hand.
import { statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { CLI_NAME, MCP_SERVER_KEY, PRODUCT_NAME } from "@ttasks/brand";
import { AppError } from "@ttasks/contracts";
import { detect, nodeDetectHost, shellLine, type Env } from "@ttasks/launch";
import { loadMachineConfig } from "@ttasks/service/config";
import { homeFolder, hostFacts, resolveLayout } from "@ttasks/service/paths";
import {
  AGENT_APPS,
  appLabel,
  applyBlock,
  applyHome,
  approveToolsHint,
  BLOCK_FORS,
  blockCanonical,
  editedDiff,
  planBlocks,
  printedBlock,
  printTargets,
  readBlockRecords,
  removeBlock,
  surveyBlocks,
  type BlockFor,
  type BlockItem,
  type BlockOutcome,
  type BlockReason,
  type BlockView,
  manualRemoval,
  hasAccess,
  HOSTS,
  isPrintApp,
  LockBusy,
  toolsOf,
  planOf,
  planToken,
  PRINT_APPS,
  PRINT_HOMES,
  PRINT_LABELS,
  recordFile,
  removeHome,
  rowAccess,
  runCommand,
  registrationOfRecord,
  rowOfHome,
  samePath,
  SetupStateInvalid,
  SetupStateUnsafe,
  settleHomes,
  snippetFor,
  survey,
  withSetupLock,
  type AgentApp,
  type Host,
  type HomeView,
  type ToolsAnswer,
  type Outcome,
  type OutcomeReason,
  type PlanItem,
  type PrintApp,
  type RowCall,
  type ServiceRow,
  type SetupInput,
} from "@ttasks/service/setup";
import { UsageError, type Globals } from "./args.ts";
import { connectService, type ConnectOptions, type Session } from "./connect.ts";
import { personAtTerminal, type Io } from "./io.ts";
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
  /** Doctor: how long one bridge probe may take in all, its start included. Default: 20 s. */
  readonly bridgeProbeMs?: number;
  /** macOS: the system's Applications folder (the Codex app's engine). Default: /Applications. */
  readonly systemApplications?: string;
}

type Mode = "preview" | "apply" | "remove" | "status" | "print" | "print-block";

/** What `--app` selects: an app with entries, or the hosts that read their homes. */
type AppWord = AgentApp | Host;
const APP_WORDS: readonly AppWord[] = [...AGENT_APPS, ...HOSTS];
const isAppWord = (value: string): value is AppWord =>
  (APP_WORDS as readonly string[]).includes(value);

const PARTS = ["mcp", "approve-tools", "block"] as const;
type Part = (typeof PARTS)[number];

interface Parsed {
  readonly mode: Mode;
  readonly apps: readonly string[] | undefined;
  readonly instance: string | undefined;
  readonly home: string | undefined;
  readonly parts: readonly Part[];
  /** `--plan <token>`: the preview's plan, which `--apply` carries out or refuses. */
  readonly plan: string | undefined;
  /** print-block's `--for`: the instruction file's kind. */
  readonly for: BlockFor | undefined;
}

/** A plan token: the preview's digest (planToken). */
const PLAN = /^[0-9a-f]{16}$/u;

/** `--space` is a global option (args.ts): `globals.space` carries it here. */
function parse(input: readonly string[]): Parsed {
  let mode: Mode | undefined;
  let args = input;
  if (args[0] === "print" || args[0] === "print-block") {
    mode = args[0];
    args = args.slice(1);
  }
  let apps: string[] | undefined;
  let instance: string | undefined;
  let home: string | undefined;
  let parts: Part[] | undefined;
  let plan: string | undefined;
  let kind: BlockFor | undefined;
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
        throw new UsageError(
          "Name one of --preview, --apply, --remove, --status, print and print-block",
        );
      }
      mode = token.slice(2) as Mode;
    } else if (name === "--for") {
      const found = value(token, i);
      if (!(BLOCK_FORS as readonly string[]).includes(found)) {
        throw new UsageError(`--for takes ${BLOCK_FORS.join(" or ")}`);
      }
      kind = found as BlockFor;
      i += step;
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
      if (!list.every((p): p is Part => (PARTS as readonly string[]).includes(p))) {
        throw new UsageError(`--parts takes ${PARTS.join(", ")} or several of them`);
      }
      parts = [...new Set(list)];
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
  if (kind !== undefined && chosen !== "print-block") {
    throw new UsageError("--for goes with print-block");
  }
  if (parts !== undefined) {
    if (chosen === "status" || chosen === "print" || chosen === "print-block") {
      throw new UsageError("--parts goes with the preview, --apply and --remove");
    }
    // Remove takes out what setup wrote, and setup never writes approve-tools: a remove of only
    // that part must not take the MCP entries out.
    if (chosen === "remove" && !parts.includes("mcp") && !parts.includes("block")) {
      throw new UsageError(
        `setup never writes approve-tools, so there is nothing of it to remove; ${CLI_NAME} setup agents --remove takes out the MCP entries, and --parts block the instruction blocks`,
      );
    }
  }
  if (chosen === "print-block") {
    if (kind === undefined) throw new UsageError(`print-block takes --for ${BLOCK_FORS.join("|")}`);
    if (apps !== undefined || instance !== undefined || home !== undefined) {
      throw new UsageError("print-block reads no home: it takes only --for");
    }
  } else if (chosen === "print") {
    if (apps?.length !== 1 || !isPrintApp(apps[0])) {
      throw new UsageError(`print takes --app and one of ${PRINT_APPS.join(", ")}`);
    }
    if (home !== undefined && !(PRINT_HOMES as readonly string[]).includes(apps[0])) {
      throw new UsageError(`print takes --home for ${PRINT_HOMES.join(" and ")} only`);
    }
  } else if (apps !== undefined && !apps.every(isAppWord)) {
    throw new UsageError(`--app takes ${APP_WORDS.join(", ")}`);
  }
  return { mode: chosen, apps, instance, home, parts: parts ?? ["mcp"], plan, for: kind };
}

const forbidden = (): AppError =>
  new AppError({
    code: "forbidden",
    message: "Only the user can change the agent homes, from an interactive terminal.",
    hint: `Ask the user to run: ${CLI_NAME} setup agents --apply`,
    data: { rule: "user_only" },
  });

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
    "its MCP servers are written in a layout setup cannot keep (inline, dotted keys, or JSON it cannot splice), or the entry's command cannot be written there",
  foreign_entry: `it has an entry named ${MCP_SERVER_KEY} that setup did not write`,
  not_set_up:
    "Claude Desktop has not made its configuration file yet: open its Settings, then Developer, once, and run setup again",
  ambiguous: `there are several Claude Desktop configuration files: pass --home <folder> for the one the app uses`,
  edited: "the entry was changed after setup wrote it",
  interrupted: `an earlier setup did not finish there: the next ${CLI_NAME} setup agents --apply or --remove settles it first`,
  missing: "the entry setup wrote is gone, so its tools do not start",
  moved: `its entry runs ${PRODUCT_NAME} where it was installed before, so its tools do not start`,
  not_installed: `${PRODUCT_NAME}'s command is not installed where the entry runs it, so its tools do not start: install ${PRODUCT_NAME} first`,
  edited_gone:
    "its entry was changed by hand and runs a program that is not there, so its tools do not start",
  access_off: "its access is off, so its tools do not start",
  entry_left: `its access is off, and its entry is still in its file: the next ${CLI_NAME} setup agents --apply or --remove takes it out`,
  not_registered: "setup has not registered it",
  changed_meanwhile: "its file changed while setup was working",
  unexpected_entry: "the entry is not there as setup wrote it",
  busy: "Claude Code kept its settings file locked while setup waited: try again in a moment",
  other_space: `it names another space: run ${CLI_NAME} setup agents --remove first`,
  grant_failed: `${PRODUCT_NAME}'s service did not confirm that it gave it access`,
  instance_taken: `another agent home is registered as this instance: run ${CLI_NAME} setup agents again for a free one, or give this home an instance of its own in machine.toml`,
  record_unreadable: `${PRODUCT_NAME} cannot read its own record of the agent homes, so it changes no file there: ${CLI_NAME} setup agents --remove still turns access off`,
  revoke_failed: `${PRODUCT_NAME}'s service did not confirm that it took its access back, so nothing else was changed`,
  unwritable:
    "its file could not be written: it is read-only, another program holds it, or the disk is full",
  state_unwritable: `setup could not write its own record of it (a full disk?), so its file was left as it was: run ${CLI_NAME} setup agents --remove again once it can`,
};

/**
 * The home's access after the action, said apart from its file: an entry that stayed is named
 * with its file, so the person knows what is left there and that it no longer works.
 */
function accessText(outcome: Outcome): string | undefined {
  if (outcome.access === undefined) return undefined;
  if (outcome.access === "on") return "Access is on.";
  if (outcome.access === "unknown") {
    return `Access could not be confirmed off: run ${CLI_NAME} setup agents --remove again while ${PRODUCT_NAME}'s service runs.`;
  }
  if (outcome.kept === "edited") {
    return `Access is off. Your edited entry is still in ${outcome.home.file}.`;
  }
  if (outcome.kept === "own") return `Access is off. The entry is still in ${outcome.home.file}.`;
  return "Access is off.";
}

/**
 * Why a home was left, for people. An entry of TTasks's name that setup did not write (one added by
 * hand) also says what to take out of which file, so the next setup can register the home (A3
 * 3.7.8: the grant gate's refusal of such an entry sends the person here).
 */
function reasonText(reason: OutcomeReason, home: HomeView["home"]): string {
  if (reason !== "foreign_entry") return REASON[reason];
  const removal = manualRemoval(home);
  return `${REASON.foreign_entry} (one added by hand). For setup to register this home, take ${removal.what} out of ${removal.file}; then run ${CLI_NAME} setup agents again`;
}

const NOTE: Readonly<Record<string, string>> = {
  undone: "Its entry was taken out again.",
  undo_failed: `The entry may still be there: the next ${CLI_NAME} setup agents --apply or --remove takes it out.`,
  entry_left:
    "The entry there is not exactly the one setup asked for, so it was left as it is: take it out by hand if it is not wanted.",
};

const STATE_TEXT: Readonly<Record<HomeView["state"], string>> = {
  not_registered: "not registered",
  registered: "registered",
  edited: "registered, then changed by hand",
  missing: "registered, entry gone",
  interrupted: "a setup that did not finish",
  refused: "left alone",
};

/**
 * A home as its answer (toolsOf) says it: its state, the one reason, and what apply or --remove
 * does about it. `live`: its access is live now, when the service said.
 */
function toolsLine(view: HomeView, answer: ToolsAnswer, live: boolean | undefined): string {
  const { why } = answer;
  const said =
    why === undefined
      ? STATE_TEXT[view.state]
      : view.state === "registered" || view.state === "missing" || view.state === "edited"
        ? `registered, and ${reasonText(why, view.home)}`
        : view.state === "interrupted"
          ? reasonText(why, view.home)
          : `${STATE_TEXT[view.state]}: ${reasonText(why, view.home)}`;
  const access = live === true ? "" : " and gives it its access again";
  if (answer.on === "grant") return `${said}: apply gives it its access again`;
  if (answer.on === "repair") {
    return `${said}: apply writes it again with the command installed now${access}`;
  }
  if (answer.status === "off" && answer.off) {
    const still = live === true ? "its access is still on, and " : "";
    return `${said}: ${still}${CLI_NAME} setup agents --remove turns its access off`;
  }
  return said;
}

const HOST_TEXT: Readonly<Record<Host, string>> = { "codex-app": "the Codex app", t3: "T3 Code" };

const title = (view: Pick<HomeView, "home">): string => {
  const hosts = view.home.hosts.map((h) => HOST_TEXT[h]);
  const also = hosts.length === 0 ? "" : `; also read by ${hosts.join(" and ")}`;
  const shadows = view.home.shadows ?? [];
  const linked =
    shadows.length === 0 ? "" : `; also read through the shadow home ${shadows.join(", ")}`;
  return `${appLabel(view.home.app)} · ${view.home.home} (instance ${view.home.instance}${also}${linked})`;
};

const viewJson = (view: HomeView) => ({
  app: view.home.app,
  home: view.home.home,
  file: view.home.file,
  instance: view.home.instance,
  account: view.home.account,
  hosts: view.home.hosts,
  ...(view.home.shadows === undefined ? {} : { shadows: view.home.shadows }),
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
  ...(outcome.access === undefined ? {} : { access: outcome.access }),
  ...(outcome.kept === undefined ? {} : { kept: outcome.kept }),
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
  // Copies of one space share its ID, which is what an entry names (A2 3.10.5): one space.
  const ids = [...new Set(found.map((s) => s.id))];
  const [only, other] = ids;
  if (only !== undefined && other === undefined) return only;
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

/** What setup reads and runs on this machine, for `ttasks setup agents` and `ttasks doctor`. */
export async function setupInputOf(
  io: Io,
  options: { readonly agents?: AgentsSetupOptions },
): Promise<{ input: SetupInput; defaultSpace: string | undefined; root: string }> {
  const facts = hostFacts(io.env, io.platform);
  const layout = resolveLayout(facts);
  const env = options.agents?.env ?? io.env;
  const userHome = options.agents?.home ?? homeFolder(facts);
  // The install's stable command (A2 3.12) in the layout's command folder: `~/.local/bin/ttasks`,
  // or `<root>/bin/ttasks` of a TTASKS_HOME install (`ttasks.exe` on Windows).
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
    if ((parsed.mode === "apply" || parsed.mode === "remove") && !personAtTerminal(io)) {
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
    const mcp = parsed.parts.includes("mcp");
    const block = parsed.parts.includes("block");
    // The service's rows matter only for the entries: a plan of only the block asks it nothing.
    const rowsOf = async () => (mcp ? withRows(input, call) : input);
    const mode: Mode = parsed.mode;
    switch (mode) {
      case "status":
        return await status(io, globals, await withRows(input, call), selected);
      case "preview":
        return await preview(io, globals, await rowsOf(), selected, parsed, spaceOf);
      case "print-block":
        return printBlock(io, globals, input, parsed.for ?? "claude");
      case "print":
        // A printed entry is a hand-made one, which may use the machine's default space only.
        if (globals.space !== undefined) {
          throw new UsageError(
            "print takes no --space: an entry added by hand uses the machine's default space",
          );
        }
        return printCommand(
          io,
          globals,
          input,
          parsed.apps?.[0] as PrintApp,
          await printSpace(call, defaultSpace),
          parsed.home,
        );
      case "apply": {
        if (mcp && (!isFolder(root) || !exists(input.tasks))) {
          throw new AppError({
            code: "invalid_input",
            message: `${PRODUCT_NAME}'s command is not installed where the entries would run it.`,
            hint: "Install it first; the entries run the installed command, never a source tree.",
            data: { issues: [{ path: "command", message: "Not installed" }] },
          });
        }
        const access = rowAccess(rowCall(call));
        const { outcomes, blocks } = await withSetupLock(input.stateDir, async () => {
          // What a run that ended midway left is settled first, and said.
          const settled = mcp ? await settleHomes(await rowsOf(), access) : [];
          // The preview again, under the lock: apply goes on only when it is the plan the
          // person saw (`--plan`), whatever changed in the homes, machine.toml or the spaces.
          const now = await rowsOf();
          const all = (await survey(now)).filter(selected);
          const views = mcp ? all : [];
          const space = needsSpace(views) ? await spaceOf() : "";
          const items = planOf(now, views, space);
          const planned = block ? await blockPlan(input, all, selected) : undefined;
          const token = planToken(
            space,
            items,
            planned === undefined ? undefined : blockCanonical(planned),
          );
          if (token !== parsed.plan) {
            throw new AppError({
              code: "conflict",
              message:
                settled.length === 0
                  ? "The agent homes changed since the preview, so nothing was changed."
                  : "A setup that did not finish was settled first, so the agent homes are not as the preview showed. Nothing else was changed.",
              hint: `Run ${CLI_NAME} setup agents again and use the command it prints.`,
              ...(settled.length === 0 ? {} : { data: { settled: settled.map(outcomeJson) } }),
            });
          }
          const done: Outcome[] = [...settled];
          for (const item of items) {
            done.push(await applyHome(now, item.view, space, access, item.change));
          }
          return { outcomes: done, blocks: (planned ?? []).map((b) => applyBlock(input, b)) };
        });
        return report(io, globals, "apply", outcomes, [], blocks);
      }
      case "remove": {
        const access = rowAccess(rowCall(call));
        const { outcomes, notes, blocks } = await withSetupLock(input.stateDir, async () => {
          const done: Outcome[] = mcp ? await settleHomes(input, access) : [];
          let surveyed = await survey(input);
          const said: string[] = [];
          const unrecorded = surveyed.some((view) => view.refusal === "record_unreadable");
          if (mcp && unrecorded) {
            // Without its record setup reaches a home by its live row: the access goes, and no
            // file changes.
            const live = await withRows(input, call);
            surveyed = await survey(live);
            const rowed = (view: HomeView) =>
              (live.rows ?? []).some((row) =>
                rowOfHome(input.platform, row, view.home, registrationOfRecord(view.record)),
              );
            for (const view of surveyed.filter((v) => selected(v) && rowed(v))) {
              done.push(await removeHome(input, view, access));
            }
            said.push(...(await revokeLeftRows(input, selected, call)));
            said.push(recordUnreadableText(input.stateDir));
          } else if (mcp) {
            const views = surveyed.filter((view) => selected(view) && view.record !== undefined);
            // Reverse order (A3 3.13.1): the latest apply first.
            views.sort((a, b) => (b.record?.at ?? "").localeCompare(a.record?.at ?? ""));
            for (const view of views) done.push(await removeHome(input, view, access));
            // Under the same lock: an apply that runs right after must not lose its row to this.
            said.push(...(await revokeLeftRows(input, selected, call)));
          }
          if (!block) {
            // The blocks are a part of their own: a remove of the entries says they stay.
            const kept = readBlockRecords(input.stateDir).some((r) =>
              selected({ home: { app: r.app, instance: r.instance, home: r.home, hosts: [] } }),
            );
            if (kept) said.push(BLOCKS_STAY);
            return { outcomes: done, notes: said, blocks: [] };
          }
          const found = await surveyBlocks(
            input,
            surveyed.map((v) => v.home),
          );
          const chosen = found.filter(
            (v) => selected(v) && (v.record !== undefined || v.state === "foreign"),
          );
          return { outcomes: done, notes: said, blocks: chosen.map((v) => removeBlock(input, v)) };
        });
        return report(io, globals, "remove", outcomes, notes, blocks);
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

/**
 * Setup's input with the service's live agent-home rows, so the preview and its apply propose
 * each new home an instance no other home's row holds (A3 3.7.8). Without a service it is the
 * input as it is: apply needs the service anyway, and checks the plan again under its lock.
 */
async function withRows(input: SetupInput, call: Call): Promise<SetupInput> {
  let answer: Record<string, unknown>;
  try {
    answer = await call("setup/homes", {});
  } catch {
    return input;
  }
  const listed = answer["homes"];
  const rows = (Array.isArray(listed) ? (listed as unknown[]) : []).flatMap((row) => {
    if (typeof row !== "object" || row === null) return [];
    const { grant, app, home, file, instance } = row as Record<string, unknown>;
    return typeof grant === "string" &&
      typeof app === "string" &&
      typeof home === "string" &&
      typeof instance === "string"
      ? [
          {
            grant,
            app,
            home,
            ...(typeof file === "string" ? { file } : {}),
            instance,
          },
        ]
      : [];
  });
  return { ...input, rows };
}

/** Whether `--app`, `--instance` and `--home` select a home. */
type Selected = (view: {
  readonly home: {
    readonly app: AgentApp;
    readonly instance: string;
    readonly home: string;
    readonly hosts: readonly Host[];
  };
}) => boolean;

/** The service's row verbs, each refusal as the AppError it carries. */
const rowCall =
  (call: Call): RowCall =>
  async (method, params) => {
    try {
      return await call(method, params);
    } catch (error) {
      throw new AppError(bodyOf(asAppError(error)));
    }
  };

/** Whether apply registers a home, so it needs the space new entries name (from the service). */
const needsSpace = (views: readonly HomeView[]): boolean =>
  views.some((view) => view.state === "not_registered");

/** Whether apply has anything to do: a home it turns on, or a registered one whose row it renews. */
const applies = (input: SetupInput, items: readonly PlanItem[]): boolean =>
  items.some(({ view, change }) => {
    const answer = toolsOf(input, view, "", typeof change === "string" ? change : undefined);
    return answer.on !== undefined || (view.state === "registered" && answer.why === undefined);
  });

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
  let rows: (ServiceRow & { hosts?: string[] })[];
  try {
    rows = ((await call("setup/homes", {}))["homes"] ?? []) as typeof rows;
  } catch {
    return [
      `${PRODUCT_NAME}'s service is not running, so the homes' grant rows stay. Run ${CLI_NAME} setup agents --remove again once it runs.`,
    ];
  }
  const views = await survey(input);
  const stale = rows.filter((row) => {
    if (!(AGENT_APPS as readonly string[]).includes(row.app)) return false;
    const view = views.find((v) =>
      rowOfHome(input.platform, row, v.home, registrationOfRecord(v.record)),
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
): Promise<number> {
  // One snapshot of the rows for every home: its answer and its row say the same.
  const views = (await survey(input)).filter(selected);
  const { rows } = input;
  const rowOf = (view: HomeView) =>
    rows?.find((r) => rowOfHome(input.platform, r, view.home, registrationOfRecord(view.record)));
  if (globals.json) {
    io.stdout(
      `${JSON.stringify({
        homes: views.map((view) => ({
          ...viewJson(view),
          tools: toolsOf(input, view, ""),
          row: rowOf(view)?.grant ?? null,
        })),
        service: rows !== undefined,
      })}\n`,
    );
    return 0;
  }
  if (views.length === 0) io.stdout("No agent home was found.\n");
  for (const view of views) {
    const row = rowOf(view);
    const space = view.record === undefined ? "" : `, space ${view.record.space}`;
    const grant = rows === undefined ? "" : row === undefined ? ", no grant row" : `, grant row `;
    const said = toolsLine(
      view,
      toolsOf(input, view, ""),
      rows === undefined ? undefined : row !== undefined,
    );
    io.stdout(`${title(view)}\n  ${said}${space}${grant}\n`);
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
  const all = (await survey(input)).filter(selected);
  const mcp = parsed.parts.includes("mcp");
  const views = mcp ? all : [];
  const registers = needsSpace(views);
  const blocks = parsed.parts.includes("block") ? await blockPlan(input, all, selected) : undefined;
  const blockChanges = (blocks ?? []).filter((b) => typeof b.change === "object").length;
  const anything = applies(input, planOf(input, views, "")) || blockChanges > 0;
  // The space each new entry names comes from the service, which keeps the rows apply makes.
  const space = registers ? await spaceOf() : "";
  const items = planOf(input, views, space);
  const answerOf = (view: HomeView, change: PlanItem["change"]) =>
    toolsOf(input, view, space, typeof change === "string" ? change : undefined);
  const plan = planToken(space, items, blocks === undefined ? undefined : blockCanonical(blocks));
  const delegated = parsed.parts.includes("approve-tools") ? approvals(all, io.platform) : [];
  // The exact apply of this preview: the same selection, parts and space, and the plan's token.
  const parts = parsed.parts.filter((p) => p !== "approve-tools");
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
    ...(parts.length === 1 && parts[0] === "mcp" ? [] : ["--parts", parts.join(",")]),
    // The space by its ID, which the preview resolved: the same space, and safe in any shell.
    ...(registers ? ["--space", space] : []),
  ];
  if (globals.json) {
    io.stdout(
      `${JSON.stringify({
        mode: "preview",
        ...(registers ? { space } : {}),
        ...(anything ? { plan, apply } : {}),
        ...(blocks === undefined ? {} : { blocks: blocks.map(blockItemJson) }),
        // Every change says the access it leaves: each turn-on ends with the home's access on.
        homes: items.map(({ view, change }) => {
          const answer = answerOf(view, change);
          return {
            ...viewJson(view),
            tools: answer,
            ...(answer.on === undefined
              ? typeof change === "string"
                ? { state: "refused", reason: change }
                : {}
              : typeof change === "object"
                ? { change: { entry: change.entry, diff: change.diff, access: "on" } }
                : { change: { access: "on" } }),
          };
        }),
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
    const answer = answerOf(view, change);
    const live = input.rows === undefined ? undefined : hasAccess(input.platform, input.rows, view);
    if (answer.on === "add" && typeof change === "object") {
      changes += 1;
      io.stdout(
        `   ${PRODUCT_NAME} writes one entry into this file, and nothing else there, and gives this home its access:\n`,
      );
      for (const line of change.diff) io.stdout(`     ${line}\n`);
    } else if (answer.on !== undefined) {
      changes += 1;
      const diff = typeof change === "object" ? change.diff : [];
      io.stdout(`   ${toolsLine(view, answer, live)}${diff.length === 0 ? "." : ":"}\n`);
      for (const line of diff) io.stdout(`     ${line}\n`);
    } else {
      io.stdout(`   ${toolsLine(view, answer, live)}. Nothing to do.\n`);
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
  if (blocks !== undefined) {
    io.stdout(
      `Instruction block (optional: the server instructions carry the workflow without it):\n`,
    );
    if (blocks.length === 0) {
      io.stdout("  No selected home has an instruction file setup writes.\n");
    }
    for (const item of blocks) {
      n += 1;
      showBlock(io, n, item);
      if (typeof item.change === "object") changes += 1;
    }
  }
  if (!mcp && blocks === undefined) return 0;
  // A --home no line keeps as it is, or a line too long to paste: the person's own command again,
  // with the apply's words.
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

/** The block part of a plan: the selected homes' instruction files, judged and planned. */
async function blockPlan(
  input: SetupInput,
  homes: readonly HomeView[],
  selected: Selected,
): Promise<BlockItem[]> {
  const views = await surveyBlocks(
    input,
    homes.map((v) => v.home),
  );
  return planBlocks(views.filter(selected));
}

/** What a remove says when setup's own record cannot be read: the access went, nothing else. */
const recordUnreadableText = (stateDir: string): string =>
  `${PRODUCT_NAME} cannot read its own record of the agent homes, ${recordFile(stateDir)}, so a remove only takes the access away and changes no file: the record and each app's entry stay as they are. ${CLI_NAME} doctor says how to clean them up.`;

/** A remove of the entries leaves the blocks: they are a part of their own. */
const BLOCKS_STAY = `The instruction blocks setup wrote stay: ${CLI_NAME} setup agents --remove --parts block takes them out.`;

const BLOCK_STATE: Readonly<Record<BlockView["state"], string>> = {
  absent: "no block yet",
  current: "has setup's block, the current version",
  outdated: "has setup's block, an older version",
  edited: "has setup's block, changed by hand since",
  missing: "setup wrote a block here that is gone now",
  foreign: "has a block setup did not write",
  refused: "left alone",
};

const BLOCK_REASON: Readonly<Record<BlockReason, string>> = {
  managed:
    "its file is managed elsewhere (a link, marked as generated in its first 20 lines, listed in machine.toml's [setup.managed] paths, or tracked by another git repository), so setup writes nothing there",
  unsafe: "its file or folder belongs to another user, or anyone can change it",
  unreadable: "its file cannot be read",
  too_large: "its file is too large",
  encoding: "its file is not UTF-8 text",
  markers: `its ${MCP_SERVER_KEY} block markers are duplicated or unbalanced: fix them by hand, then run setup again`,
  no_folder: "the home's folder is not there",
  codex_cap:
    "Codex reads only the first 32 KiB of the file, and the block would come after that, so setup writes nothing: put the block near the top yourself",
  edited:
    "the block was changed by hand since setup wrote it, so setup leaves it: to have setup's block again, delete it and run setup again",
  foreign:
    "the block there was not written by setup (added by hand, or setup lost its record), so setup leaves it: take it out by hand if it is not wanted",
  not_registered: "setup has not written a block there",
  missing: "the block setup wrote is gone",
  changed_meanwhile: "its file changed while setup was working",
};

/** Why a home's block was left, with what the person can do: print-block for a managed file. */
function blockReason(reason: BlockReason, view: BlockView): string {
  const text = BLOCK_REASON[reason];
  const print = `${CLI_NAME} setup agents print-block --for ${view.for} prints it`;
  if (reason === "managed" && view.lines !== undefined) {
    // Rule 2: the person can see the line, and add the block by hand if the file is their own.
    return `line ${view.lines.join(", ")} of its file says the file is generated or managed by another tool, so setup writes nothing there. Add the block at its source, or by hand if the file is your own: ${print}`;
  }
  if (reason === "managed" || reason === "codex_cap")
    return `${text}. Add it at its source: ${print}`;
  if (reason === "markers" && view.lines !== undefined) {
    return `${text} (lines ${view.lines.join(", ")} of the file)`;
  }
  return text;
}

const blockTitle = (view: BlockView): string =>
  `${appLabel(view.home.app)} · ${view.home.home} (instance ${view.home.instance})`;

/** Indents a diff under its home. */
const indented = (diff: string): string =>
  diff
    .split("\n")
    .filter((line, i, lines) => line !== "" || i < lines.length - 1)
    .map((line) => `     ${line}\n`)
    .join("");

function showBlock(io: Io, n: number, { view, change }: BlockItem): void {
  io.stdout(`${String(n)}. ${blockTitle(view)}\n`);
  const hash = view.sha256 === null ? "not there yet" : `sha256 ${view.sha256}`;
  io.stdout(`   ${view.file} (${hash})\n`);
  if (view.shadowed === true) {
    io.stdout(
      "   Codex now reads another instruction file here (an AGENTS.override.md), so it does not see this block.\n",
    );
  }
  if (view.pastCodexCap === true) {
    io.stdout(
      "   The block ends past the first 32 KiB of the file, which is all Codex reads, so Codex does not see it: move it nearer the top.\n",
    );
  }
  if (change === undefined) {
    const reason =
      view.state === "refused"
        ? `: ${blockReason(view.refusal ?? "unreadable", view)}`
        : view.state === "edited" || view.state === "foreign"
          ? `: ${blockReason(view.state, view)}`
          : "";
    const delegated = view.refusal === "managed" ? "delegated" : BLOCK_STATE[view.state];
    io.stdout(`   ${delegated}${reason}. Nothing to do.\n`);
    if (view.state === "edited") {
      io.stdout("   What was changed since setup wrote it:\n");
      io.stdout(indented(editedDiff(view)));
    }
  } else if (typeof change === "string") {
    io.stdout(
      `   ${change === "managed" ? "delegated" : "left alone"}: ${blockReason(change, view)}.\n`,
    );
  } else {
    io.stdout(
      change.kind === "add"
        ? `   ${view.sha256 === null ? "creates the file with the block" : "adds the block at the end of the file"}:\n`
        : "   replaces the older block in place:\n",
    );
    io.stdout(indented(change.diff));
  }
}

const blockItemJson = ({ view, change }: BlockItem) => ({
  app: view.home.app,
  home: view.home.home,
  instance: view.home.instance,
  file: view.file,
  for: view.for,
  state: view.state,
  ...(view.refusal === undefined ? {} : { reason: view.refusal }),
  ...(view.refusal === "managed" ? { delegated: true } : {}),
  ...(view.lines === undefined ? {} : { lines: view.lines }),
  ...(view.shadowed === true ? { shadowed: true } : {}),
  ...(view.pastCodexCap === true ? { past_codex_cap: true } : {}),
  sha256: view.sha256,
  ...(view.state === "edited" ? { edit: editedDiff(view) } : {}),
  ...(change === undefined
    ? {}
    : typeof change === "string"
      ? { state: "refused", reason: change, ...(change === "managed" ? { delegated: true } : {}) }
      : { change: { kind: change.kind, diff: change.diff } }),
});

const blockOutcomeJson = (outcome: BlockOutcome) => ({
  app: outcome.view.home.app,
  home: outcome.view.home.home,
  instance: outcome.view.home.instance,
  file: outcome.view.file,
  result: outcome.result,
  ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
});

/** `print-block --for claude|agents`: the block and where it goes. Reads no home, writes nothing. */
function printBlock(io: Io, globals: Globals, input: SetupInput, kind: BlockFor): number {
  const files = printTargets(input, kind);
  const text = printedBlock();
  if (globals.json) {
    io.stdout(`${JSON.stringify({ for: kind, files, text })}\n`);
    return 0;
  }
  io.stdout(
    kind === "claude"
      ? `Add this to ${files.join(", ")}, or at its source when that file is managed, keeping what is there:\n`
      : `Add this to ${files[0] ?? ""} (or ${files[1] ?? ""} when it is there: Codex then reads only that file), or to the AGENTS.md another app reads, or at its source when the file is managed, within the first 32 KiB, keeping what is there:\n`,
  );
  io.stdout(text);
  io.stdout("Nothing was changed.\n");
  return 0;
}

/**
 * The space a printed entry names: the one the grant gate lets a hand-made entry use, the
 * configured default, else the one space the service serves.
 */
async function printSpace(call: Call, machineDefault: string | undefined): Promise<string> {
  if (machineDefault !== undefined) return machineDefault;
  const listed = (await call("space/list", {})) as { spaces?: SpaceRow[] };
  // Copies of one space share its ID, which is what an entry names: one space.
  const ids = new Set(
    (listed.spaces ?? []).flatMap((s) => (s.state !== "closed" && s.id ? [s.id] : [])),
  );
  const [only] = ids;
  if (only !== undefined && ids.size === 1) return only;
  throw new AppError({
    code: "invalid_input",
    message:
      ids.size === 0
        ? "The service serves no space yet."
        : "The service serves several spaces and the machine has no default space.",
    hint:
      ids.size === 0
        ? `Create one first: ${CLI_NAME} space create`
        : `Set the default space the entry is for: ${CLI_NAME} space use <id or name>`,
    data: { issues: [{ path: "space", message: "Set a default space" }] },
  });
}

/** `print --app <name>`: the entry and where it goes. Reads no home and writes nothing. */
function printCommand(
  io: Io,
  globals: Globals,
  input: SetupInput,
  app: PrintApp,
  space: string,
  home: string | undefined,
): number {
  const snippet = snippetFor(input, app, space, home);
  if (globals.json) {
    io.stdout(`${JSON.stringify(snippet)}\n`);
    return 0;
  }
  const where = snippet.files.length === 1 ? "in" : "in one of";
  io.stdout(
    `${PRINT_LABELS[app]}: add this ${where} ${snippet.files.join(", ")}, keeping what is there\n`,
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
  blocks: readonly BlockOutcome[] = [],
): number {
  const complete =
    outcomes.every((o) => o.result !== "failed" && o.result !== "left") &&
    blocks.every((b) => b.result !== "failed" && b.result !== "left");
  if (globals.json) {
    io.stdout(
      `${JSON.stringify({
        mode,
        homes: outcomes.map(outcomeJson),
        ...(blocks.length === 0 ? {} : { blocks: blocks.map(blockOutcomeJson) }),
        ...(notes.length === 0 ? {} : { notes }),
      })}\n`,
    );
  } else {
    if (outcomes.length === 0 && blocks.length === 0) io.stdout("Nothing to do.\n");
    const blockVerb = {
      added: "instruction block added",
      updated: "instruction block replaced by the current version",
      removed: "instruction block removed",
      unchanged: "instruction block unchanged",
      left: "instruction block left alone",
      failed: "instruction block not changed",
    } as const;
    for (const outcome of blocks) {
      const reason =
        outcome.reason === undefined || outcome.result === "removed"
          ? ""
          : `: ${blockReason(outcome.reason, outcome.view)}`;
      io.stdout(`${blockTitle(outcome.view)}\n  ${blockVerb[outcome.result]}${reason}\n`);
      if (outcome.reason === "edited") {
        io.stdout("  What was changed since setup wrote it:\n");
        io.stdout(indented(editedDiff(outcome.view)));
      }
    }
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
          : `: ${reasonText(outcome.reason, outcome.home)}`;
      io.stdout(`${title(outcome)}\n  ${verb[outcome.result]}${reason}\n`);
      for (const note of outcome.notes ?? []) io.stdout(`  ${NOTE[note] ?? note}\n`);
      const access = accessText(outcome);
      if (access !== undefined) io.stdout(`  ${access}\n`);
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
    if (blocks.some((b) => b.result === "added" || b.result === "updated")) {
      io.stdout("Agent sessions read the instruction file when they start.\n");
    }
  }
  return complete ? 0 : 10;
}
