// `ttasks doctor`, the agent side (A3 3.14; M4.05). Doctor reads and probes: it never launches an
// interactive agent app, opens a deep link or starts a login, and it writes into no agent home.
// What it reads is setup's own record (`<state>/setup/agents.json`), the homes' files through the
// reader setup uses (@ttasks/service/setup), and the service's agent-home rows (`setup/homes`).
// Until setup has registered a home, it reads no home at all: the one row then says to run setup.
//
//   claude.env            CLAUDE_CODE_MCP_ALLOWLIST_ENV=1 in the agent environment (warn)
//   agents                no home registered yet, or setup's record cannot be read
//   instances             machine.toml names no instance Open can start (run `ttasks setup
//                         instances`), or a Claude Code or Codex instance's home has no entry of
//                         setup's (run `ttasks setup agents`); reads machine.toml and the record only
//   ready.<instance>      a Claude Code or Codex instance's program, version and sign-in, from the
//                         app's own status command's exit code, with the next action
//   mcp.<instance>        the entry setup wrote: still there by the file and by the app's own
//                         `mcp get`, running this install's command, its --space and --instance
//                         the same as its grant row
//   codex.engines.<inst>  each engine that reads a Codex home (the CLI, the Codex app's bundled
//                         engine) reads TTasks's entry with its own `mcp get --json`
//   bridge.<instance>     the entry's command as a synthetic stdio client: initialize and
//                         server/discover (both eras), tools/list names this build's tools, and a
//                         `status` round trip to the service in under 2 seconds
//   desktop.restart       Claude Desktop started before setup changed its configuration
//   grants                a registered home without its row, or a row without an entry
//   t3.homes              a T3 provider instance runs in a home without TTasks's entry
//   live (--live only)    a headless call through the app (`claude -p`, `codex exec`) in a
//                         temporary folder asks the model to call `status`, and the service must
//                         have seen that call from the home's instance. It spends tokens.
//   manual                an entry of TTasks's name that setup did not write: without --instance it
//                         is a hand-made entry (print's), which reaches only the default space; with
//                         one, the grant gate refuses it until setup registers that instance
//   block                 each instruction block setup wrote is there and current (A3 3.12):
//                         an older or a missing one warns; none chosen, or a file managed
//                         elsewhere now, is information only. Reads only the recorded files
//   approvals             setup never writes approval rules
//   (The sessions row is doctor-launch.ts's: it reads the service only.)
//
// Each row says what is wrong in plain words and the command that fixes it. Rows name a home by
// its app and instance, never by its path; no entry content, prompt, model answer or token is
// printed or logged. The headless run's prompt goes on stdin, never in argv.
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { uptime } from "node:os";
import { basename, join, win32 } from "node:path";
import { CLI_NAME, MCP_SERVER_KEY, PRODUCT_NAME } from "@ttasks/brand";
import generatedTools from "@ttasks/contracts/generated/mcp-tools.json" with { type: "json" };
import { makeDir } from "@ttasks/files";
import {
  helperOutput,
  INSTANCE_ID,
  instanceHome,
  instanceReadiness,
  MANUAL_INSTANCE,
  startHelper,
  type Env,
  type Instance,
} from "@ttasks/launch";
import { loadMachineConfig } from "@ttasks/service/config";
import { homeFolder, hostFacts, resolveLayout } from "@ttasks/service/paths";
import {
  appLabel,
  codexEngines,
  codexSharedHome,
  commandEnv,
  commandFor,
  entryInstance,
  manualRemoval,
  readBlockRecords,
  homeGroups,
  readsHome,
  recordArgv,
  recordedBlocks,
  samePath,
  setupRecords,
  SetupStateInvalid,
  survey,
  toolsOf,
  t3Homes,
  t3SettingsOf,
  type HomeRecord,
  type T3Skip,
  type HomeView,
  type SetupInput,
} from "@ttasks/service/setup";
import { connectService, type ConnectOptions, type Session } from "./connect.ts";
import { readinessText } from "./readiness.ts";
import type { Io } from "./io.ts";
import { setupInputOf, type AgentsSetupOptions } from "./setup-agents.ts";

export interface AgentDoctorOptions extends ConnectOptions {
  readonly agents?: AgentsSetupOptions;
}

/** One row of doctor's report (doctor.ts has the same shape; it loads this file, not the reverse). */
export interface Check {
  readonly id: string;
  readonly status: "ok" | "warn" | "fail" | "skip";
  readonly detail: string;
}

/** A `status` round trip through the bridge must take less than this (A3 3.14). */
export const BRIDGE_ROUND_TRIP_MS = 2_000;
/** How long one bridge probe may take in all, its start included. */
const BRIDGE_PROBE_MS = 20_000;
/** How long a headless run may take (`--live`): a model answers in this time or the row fails. */
const LIVE_MS = 180_000;
/** How long an app's own `mcp get` may take. */
const GET_MS = 30_000;
/** At most this much of an app's own `mcp get` is read: more is no answer. */
const GET_CHARS = 256 * 1024;

/** The fixed prompt of `--live`. Product text, never task text; it goes on stdin. */
const LIVE_PROMPT = `Call the ${MCP_SERVER_KEY} MCP tool "status" once, with no arguments. Then reply with the single word done.\n`;

/** The tool names this build lists (contracts' generated list). */
const TOOL_NAMES: readonly string[] = generatedTools.tools.map((t) => t.name);

/**
 * A home's file by its app and setup's instance for it; a home's further settings file (Claude
 * Code's default folder has two) also by which `.claude.json` it is, never by its path.
 */
const name = (view: HomeView): string =>
  `${appLabel(view.home.app)} (${view.home.instance}${view.home.further === true ? `, ${claudeFile(view.home.isDefault)}` : ""})`;

/** Which of Claude Code's default folder's two settings files, in a row's words. */
const claudeFile = (plain: boolean): string =>
  plain ? "the user's .claude.json" : "the .claude.json inside its folder";

/** A check's ID for a home's file: the home's instance, and `.further` for a further file. */
const fileId = (kind: string, view: HomeView): string =>
  `${kind}.${view.home.instance}${view.home.further === true ? ".further" : ""}`;

type Call = (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** The value after `flag` in an argv, or undefined. */
function argAfter(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

interface Row {
  readonly grant: string;
  readonly app: string;
  readonly home: string;
  readonly instance: string;
  readonly spaces: readonly string[];
}

/** The rows that need no registered home: they read only the environment. */
function envCheck(env: Env): Check {
  return env["CLAUDE_CODE_MCP_ALLOWLIST_ENV"] === "1"
    ? {
        id: "claude.env",
        status: "warn",
        detail:
          "CLAUDE_CODE_MCP_ALLOWLIST_ENV=1 is set where Claude Code starts: Claude Code then passes MCP servers only allow-listed variables, so the ticket of a launch may not reach the bridge. Remove it from your shell profile unless you need it.",
      }
    : {
        id: "claude.env",
        status: "ok",
        detail: "Claude Code's environment passes the bridge what it needs.",
      };
}

/**
 * `block` (A3 3.12): each instruction block setup wrote is still there and the current version.
 * Only the files of setup's block record are read, so with none it reads nothing. No block at all
 * is information only, because the server instructions carry the workflow on their own, and so is
 * a file that is managed elsewhere now. A block the person changed is theirs, and passes.
 */
async function blockCheck(
  io: Io,
  state: string,
  options: AgentDoctorOptions,
  given?: SetupInput,
): Promise<Check> {
  let records;
  try {
    records = readBlockRecords(state);
  } catch (error) {
    if (!(error instanceof SetupStateInvalid)) throw error;
    return {
      id: "block",
      status: "fail",
      detail: `Setup's record of the instruction blocks (setup/blocks.json in the state folder) cannot be read, so setup changes no block. Move it aside, take the blocks out of the instruction files by hand if they are not wanted, then run: ${CLI_NAME} setup agents --parts block`,
    };
  }
  if (records.length === 0) {
    return {
      id: "block",
      status: "skip",
      detail: `No instruction block is chosen. It is optional: the server instructions carry the workflow on their own. ${CLI_NAME} setup agents --parts block shows the one to add.`,
    };
  }
  const input = given ?? (await setupInputOf(io, options)).input;
  const warn: string[] = [];
  const info: string[] = [];
  const fine: string[] = [];
  for (const view of await recordedBlocks(input)) {
    const who = `${appLabel(view.home.app)} (${view.home.instance})`;
    if (view.shadowed === true) {
      warn.push(
        `${who}: Codex now reads another instruction file (an AGENTS.override.md), so it no longer sees the block`,
      );
    } else if (view.pastCodexCap === true) {
      warn.push(
        `${who}: the block now ends past the first 32 KiB of its file, which is all Codex reads, so Codex no longer sees it; move it nearer the top`,
      );
    } else if (view.state === "outdated") warn.push(`${who}: an older version of the block`);
    else if (view.state === "missing") warn.push(`${who}: the block setup wrote is gone`);
    else if (view.refusal === "markers") {
      warn.push(
        `${who}: the block's markers are duplicated or unbalanced now (lines ${(view.lines ?? []).join(", ")} of the file); fix them by hand`,
      );
    } else if (view.state === "refused") {
      info.push(
        view.refusal === "managed"
          ? `${who}: its file is managed elsewhere now, so the block belongs at its source (${CLI_NAME} setup agents print-block --for ${view.for})`
          : view.refusal === "no_folder"
            ? `${who}: its home folder is gone`
            : `${who}: its file cannot be read the way setup reads it (another owner, too large, or not UTF-8 text)`,
      );
    } else if (view.state === "edited") fine.push(`${who} (changed by hand)`);
    else fine.push(who);
  }
  if (warn.length > 0) {
    return {
      id: "block",
      status: "warn",
      detail: `${[...warn, ...info].join("; ")}. Run ${CLI_NAME} setup agents --parts block to bring it up to date, or ${CLI_NAME} setup agents --remove --parts block to take it out.`,
    };
  }
  return {
    id: "block",
    status: fine.length > 0 ? "ok" : "skip",
    detail: [
      ...(fine.length > 0 ? [`The instruction block is current in ${fine.join(", ")}`] : []),
      ...info,
    ]
      .join("; ")
      .concat("."),
  };
}

const SKIPPED_ROWS: readonly Check[] = [
  {
    id: "approvals",
    status: "skip",
    detail: `${PRODUCT_NAME} never writes approval rules: ${CLI_NAME} setup agents --parts approve-tools shows the change to make by hand.`,
  },
];

/** The agent-side rows of `ttasks doctor` (A3 3.14). */
export async function agentChecks(
  io: Io,
  state: string,
  live: boolean,
  options: AgentDoctorOptions,
): Promise<Check[]> {
  const env = options.agents?.env ?? io.env;
  const checks: Check[] = [envCheck(env)];
  // Every record of either record file is a home set up; a further file whose record cannot be
  // read is named on its file's row below.
  const read = setupRecords(state);
  if (read.blind) {
    return [
      ...checks,
      instancesCheck(io, undefined, options),
      ...(await readinessChecks(io, options)),
      {
        id: "agents",
        status: "fail",
        detail: `Setup's record of the agent homes (${read.unreadable[0] ?? "in the state folder"}) cannot be read, so setup changes no file. Turning access off still works (${CLI_NAME} setup agents --remove, or Settings). To clean up, move the record aside, take ${PRODUCT_NAME}'s entries out of the apps by hand, then run: ${CLI_NAME} setup agents`,
      },
      await blockCheck(io, state, options),
      ...SKIPPED_ROWS,
    ];
  }
  const records = read.all;
  checks.push(instancesCheck(io, records, options), ...(await readinessChecks(io, options)));
  let session: Session | undefined;
  try {
    session = await connectService(io, options);
  } catch {
    session = undefined;
  }
  const call: Call | undefined =
    session === undefined
      ? undefined
      : async (method, params) =>
          (await session.call(method, params, { timeoutMs: 30_000 })) as Record<string, unknown>;
  try {
    let rows: Row[] | undefined;
    try {
      rows =
        call === undefined
          ? undefined
          : (((await call("setup/homes", {}))["homes"] ?? []) as Row[]);
    } catch {
      rows = undefined;
    }
    // Nothing recorded, no record file that cannot be read and no live row: no agent can reach the
    // service, and no home is read. A live row whose record was lost is checked as what it is, below.
    if (records.length === 0 && read.unreadable.length === 0 && (rows ?? []).length === 0) {
      return [
        ...checks,
        {
          id: "agents",
          status: "warn",
          detail: `No agent app has ${PRODUCT_NAME}'s MCP entry yet, so agents cannot reach it. Run: ${CLI_NAME} setup agents`,
        },
        await blockCheck(io, state, options),
        ...SKIPPED_ROWS,
        liveSkipped(live, "No agent home is registered."),
      ];
    }
    const { input } = await setupInputOf(io, options);
    const surveyed = await survey(input);
    const resolve = (argv: readonly string[]) => options.agents?.resolve?.(argv) ?? argv;
    // Each file setup has a record of, each file with an entry of TTasks's name whose record cannot
    // be read, and each other file of a home set up that needs something: one setup cannot read, or
    // one without the entry.
    const setUp = (v: HomeView) =>
      surveyed.some(
        (o) =>
          o.record !== undefined &&
          o.home.app === v.home.app &&
          samePath(input.platform, o.home.home, v.home.home),
      );
    const views = surveyed.filter(
      (v) =>
        v.record !== undefined ||
        (v.refusal === "record_unreadable" && v.entry !== undefined) ||
        (setUp(v) &&
          (v.state === "not_registered" ||
            (v.state === "refused" && v.refusal !== "foreign_entry"))),
    );
    const rowOf = (view: HomeView) =>
      rows?.find(
        (r) => r.app === view.home.app && samePath(input.platform, r.home, view.home.home),
      );

    // One bridge's round trip per home: its files' entries run the same instance.
    const bridged = new Set<string>();
    for (const view of views) {
      checks.push(
        await mcpCheck(
          input,
          view,
          rows === undefined ? undefined : (rowOf(view) ?? null),
          resolve,
        ),
      );
      if (view.home.app === "codex" && view.state === "registered") {
        checks.push(await enginesCheck(input, view, resolve));
      }
      const home = JSON.stringify([view.home.app, view.home.home]);
      if (view.state === "registered" && !bridged.has(home)) {
        bridged.add(home);
        checks.push(
          session === undefined
            ? {
                id: `bridge.${view.home.instance}`,
                status: "skip",
                detail: "No service: the bridge's round trip needs it.",
              }
            : await bridgeCheck(
                io,
                view,
                resolve,
                options.agents?.bridgeProbeMs ?? BRIDGE_PROBE_MS,
              ),
        );
      }
      if (view.home.app === "claude-desktop" && view.state === "registered") {
        checks.push(
          await restartCheck(view, options.agents?.desktopStarted ?? (() => desktopStarted(io))),
        );
      }
    }
    checks.push(grantsCheck(input, views, rows));
    checks.push(manualCheck(surveyed));
    checks.push(t3Check(input, surveyed));
    checks.push(await blockCheck(io, state, options, input));
    checks.push(...SKIPPED_ROWS);
    if (!live) checks.push(liveSkipped(false, ""));
    else {
      const liveMs = options.agents?.liveMs ?? LIVE_MS;
      checks.push(
        ...(await liveChecks(
          input,
          state,
          views.filter((v) => v.record !== undefined),
          call,
          resolve,
          liveMs,
        )),
      );
    }
    return checks;
  } finally {
    session?.close();
  }
}

/** Setup agents' app for an instance's target: the homes it registers. */
const HOME_APP: Readonly<Record<string, HomeRecord["app"]>> = {
  "claude-cli": "claude-code",
  "codex-cli": "codex",
};

/**
 * `instances`: the agent apps Open can start a task in here (machine.toml's enabled instances),
 * and whether each Claude Code or Codex instance's home has the entry setup agents writes, without
 * which its agent cannot read or update the task. It reads machine.toml and setup's record only,
 * never an agent home. Instances by ID, never by path.
 */
function instancesCheck(
  io: Io,
  records: readonly HomeRecord[] | undefined,
  options: AgentDoctorOptions,
): Check {
  const { instances, userHome } = enabledInstances(io, options);
  if (instances.length === 0) {
    return {
      id: "instances",
      status: "warn",
      detail: `No agent app is set up for Open on this machine, so a task offers only Copy. Run: ${CLI_NAME} setup instances`,
    };
  }
  const without = instances.filter((instance) => {
    const app = HOME_APP[instance.target];
    const own = instanceHome(instance, userHome, io.platform)?.path;
    if (app === undefined || own === undefined || records === undefined) return false;
    // A Codex shadow home reads the entry of the home its config.toml links to.
    const home = (app === "codex" ? codexSharedHome(io.platform, own) : undefined) ?? own;
    return !records.some((r) => r.app === app && samePath(io.platform, r.home, home));
  });
  const ids = instances.map((i) => i.id).join(", ");
  if (without.length > 0) {
    const named = without.map((i) => i.id).join(", ");
    return {
      id: "instances",
      status: "warn",
      detail: `Open can start a task in ${ids}, but ${named} ${without.length === 1 ? "runs in a home" : "run in homes"} without ${PRODUCT_NAME}'s tools, so ${without.length === 1 ? "its agent" : "their agents"} cannot read or update the task. Run: ${CLI_NAME} setup agents`,
    };
  }
  return { id: "instances", status: "ok", detail: `Open can start a task in ${ids}.` };
}

/** machine.toml's enabled instances, and the account's home folder they are read against. */
function enabledInstances(
  io: Io,
  options: AgentDoctorOptions,
): { readonly instances: readonly Instance[]; readonly userHome: string | undefined } {
  const facts = hostFacts(io.env, io.platform);
  const instances = loadMachineConfig(
    resolveLayout(facts).config,
    io.platform,
  ).config.instances.filter((i) => i.enabled);
  let userHome: string | undefined;
  try {
    userHome = options.agents?.home ?? homeFolder(facts);
  } catch {
    userHome = undefined;
  }
  return { instances, userHome };
}

/**
 * `ready.<instance>`: each Claude Code or Codex instance's program, version and sign-in, with the
 * next action (readinessText). The apps' own status commands run side by side.
 */
async function readinessChecks(io: Io, options: AgentDoctorOptions): Promise<Check[]> {
  const { instances, userHome } = enabledInstances(io, options);
  const base = options.agents?.env ?? io.env;
  const found = await Promise.all(
    instances.map(async (instance) => ({
      instance,
      ready: await instanceReadiness(instance, { platform: io.platform, base, home: userHome }),
    })),
  );
  return found.flatMap(({ instance, ready }): Check[] =>
    ready === undefined
      ? []
      : [
          {
            id: `ready.${instance.id}`,
            status: ready.state === "signed_in" ? "ok" : "warn",
            detail: `${instance.id}: ${readinessText(ready)}`,
          },
        ],
  );
}

function liveSkipped(live: boolean, why: string): Check {
  return {
    id: "live",
    status: "skip",
    detail: live
      ? why
      : `${CLI_NAME} doctor --live asks each agent app to call ${PRODUCT_NAME} once; it spends tokens, so it never runs by itself.`,
  };
}

const REFUSED: Readonly<Record<string, string>> = {
  managed:
    "its file is now managed elsewhere (a link, generated, listed, or tracked by another git repository)",
  unsafe: "its file or folder now belongs to another user, or anyone can change it",
  not_set_up: "its file is gone",
  record_unreadable: "setup cannot read its own record of this file",
};

/** `mcp.<instance>`: the entry setup wrote, as the file and the app itself see it. */
async function mcpCheck(
  input: SetupInput,
  view: HomeView,
  row: Row | null | undefined,
  resolve: (argv: readonly string[]) => readonly string[],
): Promise<Check> {
  const id = fileId("mcp", view);
  const fix = `${CLI_NAME} setup agents --remove, then ${CLI_NAME} setup agents and the apply it prints`;
  const record = view.record;
  if (view.refusal === "record_unreadable") {
    // Setup leaves the file as it is: its record of it is in a record file it cannot read.
    const damaged = setupRecords(input.stateDir).unreadable.join(" or ");
    if (view.entry === undefined) {
      return {
        id,
        status: "warn",
        detail: `${name(view)}: setup cannot read its record of this file (${damaged}), so it changes nothing there. Put that record file back as it was (from a backup), then run: ${CLI_NAME} setup agents --status`,
      };
    }
    const removal = manualRemoval(view.home);
    return {
      id,
      status: "fail",
      detail: `${name(view)}: ${PRODUCT_NAME}'s entry is still in this file, and setup cannot read its record of it (${damaged}), so it leaves the entry there. Either put that record file back as it was (from a backup), and turning the tools off then takes the entry out (${CLI_NAME} setup agents --remove, or Settings); or take ${removal.what} out of this file by hand (${CLI_NAME} setup agents shows its full path).`,
    };
  }
  if (record === undefined) {
    // A file of a home set up whose reader gets no entry from setup.
    if (view.state === "refused") {
      return {
        id,
        status: "fail",
        detail: `${name(view)}: setup cannot change this file: ${REFUSED[view.refusal ?? ""] ?? "the file is not in a state setup understands"}, so an app that reads it cannot reach ${PRODUCT_NAME}. Fix the file, then run: ${CLI_NAME} setup agents --status`,
      };
    }
    if (view.state === "not_registered") {
      return {
        id,
        status: "warn",
        detail: `${name(view)}: this file has no ${PRODUCT_NAME} entry, so an app that reads it cannot reach ${PRODUCT_NAME}. Run: ${CLI_NAME} setup agents, then the apply it prints`,
      };
    }
    return { id, status: "skip", detail: "Not registered by setup." };
  }
  // Whether its tools start: the answer Settings and setup agents give (toolsOf).
  const answer = toolsOf(
    row === undefined ? input : { ...input, rows: row === null ? [] : [row] },
    view,
    "",
  );
  switch (view.state) {
    case "refused":
      return {
        id,
        status: "fail",
        detail: `${name(view)}: setup can no longer read its file: ${REFUSED[view.refusal ?? ""] ?? "the file is not in a state setup understands"}. Fix the file, then run: ${CLI_NAME} setup agents --status`,
      };
    case "interrupted":
      return {
        id,
        status: "fail",
        detail: `${name(view)}: an apply did not finish. Run: ${fix}`,
      };
    case "missing":
      return {
        id,
        status: "fail",
        detail: `${name(view)}: ${PRODUCT_NAME}'s entry is gone, so this app cannot reach ${PRODUCT_NAME}. Run: ${fix}`,
      };
    case "edited":
      if (answer.why === "edited_gone") {
        return {
          id,
          status: "fail",
          detail: `${name(view)}: the entry was changed by hand and runs a program that is not there, so this app cannot reach ${PRODUCT_NAME}. Fix the entry, or take it out by hand and run: ${CLI_NAME} setup agents`,
        };
      }
      return {
        id,
        status: "warn",
        detail: `${name(view)}: the entry was changed by hand after setup wrote it, so setup leaves it alone. If that was not meant, take it out by hand, then run: ${CLI_NAME} setup agents`,
      };
    default:
      break;
  }
  // The app's own view of its entry (A3 3.14: "according to the app's own mcp get").
  const exec = commandFor(input, view.home);
  if (exec !== undefined) {
    const args =
      view.home.app === "codex"
        ? ["mcp", "get", MCP_SERVER_KEY, "--json"]
        : ["mcp", "get", MCP_SERVER_KEY];
    const out = await output(input, view, resolve([...exec, ...args]));
    if (out === undefined) {
      return {
        id,
        status: "fail",
        detail: `${name(view)}: the app's own mcp get does not find ${PRODUCT_NAME}'s entry, though its file has it. Run: ${fix}`,
      };
    }
  }
  const argv = recordArgv(record);
  const command = argv[0] ?? "";
  if (answer.why === "moved" || answer.why === "not_installed") {
    return {
      id,
      status: "fail",
      detail: `${name(view)}: the entry runs a ${CLI_NAME} command that is not there any more. Install ${PRODUCT_NAME} again, or run: ${fix}`,
    };
  }
  if (!samePath(input.platform, command, input.tasks)) {
    return {
      id,
      status: "warn",
      detail: `${name(view)}: the entry runs another ${CLI_NAME} than this install's stable command. Run: ${fix}`,
    };
  }
  if (answer.why === "access_off") {
    return {
      id,
      status: "fail",
      detail: `${name(view)}: the entry has no grant row in the service. Run: ${CLI_NAME} setup agents, then the apply it prints (it renews the row)`,
    };
  }
  if (
    row !== undefined &&
    row !== null &&
    (row.spaces[0] !== argAfter(argv, "--space") || row.instance !== argAfter(argv, "--instance"))
  ) {
    return {
      id,
      status: "fail",
      detail: `${name(view)}: the entry's --space or --instance does not match its grant row. Run: ${fix}`,
    };
  }
  return {
    id,
    status: "ok",
    detail: `${name(view)}: ${PRODUCT_NAME}'s entry is in place and runs this install's command${row === undefined ? "" : ", as its grant row says"}.`,
  };
}

/** `codex.engines.<instance>`: every engine that reads the home reads TTasks's entry. */
async function enginesCheck(
  input: SetupInput,
  view: HomeView,
  resolve: (argv: readonly string[]) => readonly string[],
): Promise<Check> {
  const id = `codex.engines.${view.home.instance}`;
  const engines = codexEngines(input, view.home);
  if (engines.length === 0) {
    return { id, status: "skip", detail: `${name(view)}: no Codex engine was found to ask.` };
  }
  const command = view.record === undefined ? "" : (recordArgv(view.record)[0] ?? "");
  const failed: string[] = [];
  for (const engine of engines) {
    const out = await output(
      input,
      view,
      resolve([...engine.exec, "mcp", "get", MCP_SERVER_KEY, "--json"]),
    );
    if (!readsEntry(out, command)) {
      failed.push(engine.kind === "app" ? "the Codex app's engine" : "the Codex CLI");
    }
  }
  return failed.length === 0
    ? {
        id,
        status: "ok",
        detail: `${name(view)}: ${engines.length === 1 ? "its Codex engine reads" : `all ${String(engines.length)} Codex engines read`} ${PRODUCT_NAME}'s entry.`,
      }
    : {
        id,
        status: "fail",
        detail: `${name(view)}: ${[...new Set(failed)].join(" and ")} cannot read ${PRODUCT_NAME}'s entry (it rejects the file or a key setup wrote). Update that Codex, or run: ${CLI_NAME} setup agents --remove`,
      };
}

/** Whether an engine's `mcp get --json` answer is JSON that names the entry's command. */
function readsEntry(out: string | undefined, command: string): boolean {
  if (out === undefined) return false;
  try {
    return JSON.stringify(JSON.parse(out)).includes(JSON.stringify(command));
  } catch {
    return false;
  }
}

/**
 * An app's command's stdout in the home's environment, or undefined when it failed: a helper of
 * the runner's (@ttasks/launch helpers.ts), like every program doctor starts.
 */
function output(
  input: SetupInput,
  view: HomeView,
  argv: readonly string[],
): Promise<string | undefined> {
  const { env } = commandEnv(input, view.home);
  return helperOutput(argv, {
    env,
    cwd: input.userHome,
    deadlineMs: GET_MS,
    maxChars: GET_CHARS,
  });
}

/** A folder as the OS resolves it (links, case, short names), or as given when it cannot. */
function realFolder(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** `grants`: each registered home has its row, and each row an entry of setup's. */
function grantsCheck(
  input: SetupInput,
  views: readonly HomeView[],
  rows: readonly Row[] | undefined,
): Check {
  if (rows === undefined) return { id: "grants", status: "skip", detail: "No service to ask." };
  // One grant per home: a home is named once, whatever number of its files are registered.
  const registered = homeGroups(
    input.platform,
    views.filter((v) => v.record?.state === "applied"),
    (v) => v.home,
  ).flatMap((files) => files.slice(0, 1));
  const without = registered.filter(
    (v) => !rows.some((r) => r.app === v.home.app && samePath(input.platform, r.home, v.home.home)),
  );
  const orphans = rows.filter(
    (r) =>
      !views.some((v) => v.home.app === r.app && samePath(input.platform, r.home, v.home.home)),
  );
  if (without.length > 0) {
    return {
      id: "grants",
      status: "fail",
      detail: `${without.map(name).join(", ")} ${without.length === 1 ? "has" : "have"} no grant row in the service. Run: ${CLI_NAME} setup agents, then the apply it prints (it renews the rows)`,
    };
  }
  if (orphans.length > 0) {
    return {
      id: "grants",
      status: "warn",
      detail: `${String(orphans.length)} grant row${orphans.length === 1 ? " has" : "s have"} no entry of setup's. Run: ${CLI_NAME} setup agents --remove (it revokes rows without entries)`,
    };
  }
  return {
    id: "grants",
    status: "ok",
    detail: "Every registered home has its grant row, and every row its entry.",
  };
}

/**
 * `manual` (A3 3.7.8): an entry of TTasks's name in a home that setup did not write. Without
 * `--instance` it is a hand-made entry, as `print` writes one: not a mistake, so the row says what
 * it reaches (the machine's default space only). With one, the grant gate refuses its calls until
 * setup registers that instance, whose refusal sends the person to setup, which leaves the home
 * alone while the entry is there: so the row says what to take out of which file. A home is named
 * by its app and setup's instance for it, and its file by its name, without the home's path.
 */
function manualCheck(views: readonly HomeView[]): Check {
  const found = views.filter((v) => v.state === "refused" && v.refusal === "foreign_entry");
  if (found.length === 0) {
    return {
      id: "manual",
      status: "ok",
      detail: `Every ${PRODUCT_NAME} entry in the agent homes is one setup wrote.`,
    };
  }
  const parts = found.map((view) => {
    // The file by its name only: ttasks setup agents shows each home's file in full.
    const removal = manualRemoval(view.home);
    const how = `take ${removal.what} out of that home's ${basename(removal.file)} (${CLI_NAME} setup agents shows its full path)`;
    // The instance the service sees, by its own rule (binding's `instanceIn`): an entry without
    // --instance, or with one that is `manual` or no instance ID, acts as the hand-made entry.
    const named = entryInstance(view.entry);
    const instance =
      named === undefined
        ? undefined
        : named !== null && INSTANCE_ID.test(named) && named !== MANUAL_INSTANCE
          ? named
          : null;
    const what =
      instance === null
        ? `an entry added by hand without --instance (or with one the service reads as the hand-made entry's, as ${CLI_NAME} setup agents print gives one without): its agents act as the hand-made entry and reach only the machine's default space. For an instance and a space of its own`
        : instance === undefined
          ? `an entry added by hand whose arguments are not ones ${PRODUCT_NAME}'s server takes. For setup to register this home`
          : `an entry added by hand as instance ${instance}, which setup did not register for this home, so the service refuses its calls unless a registered home holds that instance. For setup to register this home`;
    return `${name(view)}: ${what}, ${how}, then run: ${CLI_NAME} setup agents`;
  });
  return { id: "manual", status: "warn", detail: parts.join(" ") };
}

/** A T3 provider instance's key that a row may show as it is. */
const PROVIDER_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;

/** Why an entry of T3's settings was passed over, in a row's words. */
const T3_SKIP_TEXT: Readonly<Record<T3Skip, string>> = {
  unknown_driver: "a kind of agent this build does not know",
  invalid_entry: "not in the form T3 Code writes, or its home is no absolute folder",
  secret_home: "its home is kept in T3 Code's secret store",
};

/**
 * `t3.homes`: every home an enabled T3 provider instance runs in has TTasks's entry. An instance
 * turned off in T3 is named and not checked; an entry setup passed over is named with why, and one
 * whose home cannot be known warns, since that home may lack the entry.
 */
function t3Check(input: SetupInput, views: readonly HomeView[]): Check {
  const settings = t3SettingsOf(input);
  if (settings === undefined) {
    return { id: "t3.homes", status: "skip", detail: "T3 Code is not on this machine." };
  }
  const homes = t3Homes(settings);
  const plain = (id: string) => (PROVIDER_KEY.test(id) ? id : "(a key that is not a plain name)");
  const off = settings.off.map(plain);
  const unknown = settings.skipped.filter((s) => s.reason === "unknown_driver");
  const unclear = settings.skipped.filter((s) => s.reason !== "unknown_driver");
  // Facts that change nothing: said after the row's verdict.
  const notes: string[] = [];
  if (off.length > 0) {
    notes.push(`Turned off in T3 Code, so not checked: ${off.join(", ")}.`);
  }
  if (unknown.length > 0) {
    notes.push(
      `Passed over, ${T3_SKIP_TEXT.unknown_driver}: ${unknown.map((s) => plain(s.id)).join(", ")}.`,
    );
  }
  // A provider instance whose Claude Code reads one of the default folder's two settings files
  // that Claude Code has not made yet: the home has files, and none is that reader's (readsHome).
  const reads = (t3: (typeof homes)[number], v: HomeView) =>
    readsHome(input.platform, t3, v.home.app, v.home.home, v.home.isDefault);
  const elsewhere = homes.filter(
    (t3) =>
      views.some((v) => v.home.app === t3.app && samePath(input.platform, v.home.home, t3.home)) &&
      !views.some((v) => reads(t3, v)),
  );
  const gaps = homes.filter((t3) => {
    if (elsewhere.includes(t3)) return false;
    const view = views.find((v) =>
      readsHome(input.platform, t3, v.home.app, v.home.home, v.home.isDefault),
    );
    return view === undefined || !(view.state === "registered" || view.state === "edited");
  });
  if (
    gaps.length === 0 &&
    elsewhere.length === 0 &&
    unclear.length === 0 &&
    settings.file !== "refused"
  ) {
    return {
      id: "t3.homes",
      status: "ok",
      detail: [
        `Every home T3 Code's provider instances use has ${PRODUCT_NAME}'s entry.`,
        ...notes,
      ].join(" "),
    };
  }
  // A provider instance by its key in T3's settings when that is a plain name; a key with a path,
  // spaces or control characters in it never reaches a row.
  const label = (g: (typeof homes)[number]) =>
    `${plain(g.provider)} (${g.app === "codex" ? "Codex" : "Claude Code"})`;
  // Each part says what to do; the command that fixes a gap comes last, as the row's last words.
  const parts: string[] = [];
  if (settings.file === "refused") {
    parts.push(
      `T3 Code's settings file is not one setup reads (a link, another user's file or one anyone can change, too large, or not strict JSON), so only T3's default instances were checked.`,
    );
  }
  for (const s of unclear) {
    parts.push(
      `T3 Code's provider instance ${plain(s.id)} was passed over, ${T3_SKIP_TEXT[s.reason]}: ${PRODUCT_NAME} cannot tell which home it runs in.`,
    );
  }
  parts.push(...notes);
  parts.push(
    ...elsewhere.map(
      (t3) =>
        `T3 Code's provider instance ${label(t3)} starts Claude Code so that it reads ${claudeFile(t3.isDefault)}, which Claude Code has not made yet. Start Claude Code that way once, then run: ${CLI_NAME} setup agents --app t3`,
    ),
  );
  if (gaps.length > 0) {
    parts.push(
      `T3 Code's provider instance${gaps.length === 1 ? "" : "s"} ${gaps.map(label).join(", ")} ${gaps.length === 1 ? "runs" : "run"} in a home without ${PRODUCT_NAME}'s entry. Run: ${CLI_NAME} setup agents --app t3`,
    );
  }
  return { id: "t3.homes", status: "warn", detail: parts.join(" ") };
}

/** `desktop.restart`: Claude Desktop loads its configuration only when it starts (A3 3.13.3). */
async function restartCheck(
  view: HomeView,
  started: () => Promise<number | "not_running" | undefined>,
): Promise<Check> {
  const id = "desktop.restart";
  const changed = Date.parse(view.record?.at ?? "");
  const booted = Date.now() - uptime() * 1000;
  const ok: Check = {
    id,
    status: "ok",
    detail: "Claude Desktop has started since setup changed its configuration.",
  };
  if (!Number.isFinite(changed) || booted > changed) return ok;
  const at = await started();
  if (at === "not_running") {
    return {
      id,
      status: "ok",
      detail: "Claude Desktop is not running; it loads the entry when it starts.",
    };
  }
  if (typeof at === "number" && at > changed) return ok;
  return {
    id,
    status: "warn",
    detail:
      at === undefined
        ? `If Claude Desktop was running when setup changed its configuration (${view.record?.at ?? ""}), quit and reopen it: it loads the entry only when it starts.`
        : "Restart needed: Claude Desktop started before setup changed its configuration. Quit and reopen it.",
  };
}

/**
 * When Claude Desktop started: on Windows the earliest start of its `claude.exe` from the MSIX or
 * the classic install (not Claude Code's own `claude.exe`), asked of CIM through Windows
 * PowerShell by its full path; `not_running` when none runs. Elsewhere unknown.
 */
async function desktopStarted(io: Io): Promise<number | "not_running" | undefined> {
  if (io.platform !== "win32") return undefined;
  const root = io.env["SystemRoot"] ?? "C:\\Windows";
  const powershell = win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | ForEach-Object { [string]$_.ExecutablePath + '|' + $_.CreationDate.ToUniversalTime().ToString('o') }";
  const out = await helperOutput(
    [powershell, "-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: io.env,
      cwd: io.cwd,
      deadlineMs: 15_000,
      maxChars: 1024 * 1024,
    },
  );
  if (out === undefined) return undefined;
  const starts = out
    .split(/\r?\n/u)
    .map((line) => line.split("|"))
    .filter(([path]) => /\\WindowsApps\\Claude_|\\AnthropicClaude\\/iu.test(path ?? ""))
    .map(([, at]) => Date.parse(at ?? ""))
    .filter(Number.isFinite);
  return starts.length === 0 ? "not_running" : Math.min(...starts);
}

// ---------------------------------------------------------------------------------------------
// Programs doctor starts (the entries' commands for the bridge probe, the apps for --live, the
// apps' own `mcp get`, Windows PowerShell for desktop.restart) are all helpers of the runner in
// @ttasks/launch (helpers.ts, A3 3.14): it ends each with what it started at its deadline, on stop,
// and when doctor exits, so a headless run never goes on, and spends tokens, after the person
// stopped doctor. This file imports no child_process (dependency-cruiser checks it).

// ---------------------------------------------------------------------------------------------
// The bridge probe

type Message = Record<string, unknown>;

/** A line of the probe's output not yet ended may be at most this long; past it the probe ends. */
const MAX_PROBE_LINE = 1024 * 1024;

const isMessage = (value: unknown): value is Message =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface Probe {
  request(method: string, params: Message): Promise<Message | undefined>;
  notify(method: string): void;
  /** Whether the deadline ended the probe: every request still open then got no answer. */
  timedOut(): boolean;
  close(): Promise<void>;
}

/**
 * The entry's command with stdio, as an agent app starts it: one JSON-RPC line at a time, as a
 * helper of the runner. A line that is not a JSON object is no answer; a line longer than the bound
 * ends the probe. When the program ends, by itself or by the deadline, every open request settles
 * without an answer. Throws when the command cannot be started at all.
 */
function probe(argv: readonly string[], env: Env, cwd: string, deadlineMs: number): Probe {
  const run = startHelper(argv, { env, cwd, deadlineMs, stdin: true, stdout: true });
  const { child } = run;
  const replies = new Map<unknown, (message: Message | undefined) => void>();
  let ended = false;
  const settleAll = () => {
    ended = true;
    for (const settle of replies.values()) settle(undefined);
    replies.clear();
  };
  const stop = () => {
    settleAll();
    run.stop();
  };
  const exited = run.ended.then(settleAll);
  let pending = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    pending += chunk;
    for (let end = pending.indexOf("\n"); end !== -1; end = pending.indexOf("\n")) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isMessage(message) || "method" in message) continue;
      const settle = replies.get(message["id"]);
      if (settle !== undefined) {
        replies.delete(message["id"]);
        settle(message);
      }
    }
    if (pending.length > MAX_PROBE_LINE) stop();
  });
  let next = 1;
  return {
    request(method, params) {
      if (ended) return Promise.resolve(undefined);
      const id = next;
      next += 1;
      return new Promise((resolve) => {
        replies.set(id, resolve);
        child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    notify(method) {
      if (!ended) child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
    },
    timedOut: () => run.timedOut(),
    async close() {
      child.stdin?.end();
      const timer = setTimeout(stop, 3_000);
      await exited;
      clearTimeout(timer);
    },
  };
}

const MODERN_META = {
  _meta: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": { name: `${CLI_NAME}-doctor`, version: "1" },
  },
};

/** The error code at the start of a tool's error text (A3 3.5: `error <code> …`), or a word. */
const errorCode = (text: unknown): string =>
  /^error ([a-z_]+)/u.exec(typeof text === "string" ? text : "")?.[1] ?? "error";

/** `bridge.<instance>`: the registered command answers in both eras and reaches the service. */
async function bridgeCheck(
  io: Io,
  view: HomeView,
  resolve: (argv: readonly string[]) => readonly string[],
  probeMs: number,
): Promise<Check> {
  const id = `bridge.${view.home.instance}`;
  const argv = resolve(view.record === undefined ? [] : recordArgv(view.record));
  const failed = (why: string): Check => ({
    id,
    status: "fail",
    detail: `${name(view)}: the entry's command ${why}. Run: ${CLI_NAME} doctor again once the service runs; if it stays, run ${CLI_NAME} setup agents --remove, then ${CLI_NAME} setup agents`,
  });
  const legacy = async (): Promise<Check | number> => {
    const bridge = probe(argv, io.env, io.cwd, probeMs);
    // An answer missing because the deadline ended the probe is a probe out of time.
    const fail = (why: string) => failed(bridge.timedOut() ? "did not answer in time" : why);
    try {
      const init = await bridge.request("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: `${CLI_NAME}-doctor`, version: "1" },
      });
      if (!isMessage(init?.["result"])) return fail("did not answer initialize");
      bridge.notify("notifications/initialized");
      const listed = await bridge.request("tools/list", {});
      const result = listed?.["result"];
      const tools = isMessage(result) && Array.isArray(result["tools"]) ? result["tools"] : [];
      const names = tools.map((t: unknown) => (isMessage(t) ? t["name"] : undefined));
      if (names.length !== TOOL_NAMES.length || !TOOL_NAMES.every((n) => names.includes(n))) {
        return fail("lists other tools than this build's (an older or newer install answers)");
      }
      const started = performance.now();
      const status = await bridge.request("tools/call", { name: "status", arguments: {} });
      const took = performance.now() - started;
      const answer = status?.["result"];
      if (!isMessage(answer)) return fail("did not answer a status call");
      if (answer["isError"] === true) {
        const content = Array.isArray(answer["content"]) ? (answer["content"] as unknown[]) : [];
        const first = content[0];
        return failed(
          `got an error for status (${errorCode(isMessage(first) ? first["text"] : undefined)})`,
        );
      }
      return took;
    } finally {
      await bridge.close();
    }
  };
  const modern = async (): Promise<boolean> => {
    const bridge = probe(argv, io.env, io.cwd, probeMs);
    try {
      const discovered = await bridge.request("server/discover", MODERN_META);
      return isMessage(discovered?.["result"]);
    } finally {
      await bridge.close();
    }
  };
  try {
    const first = await legacy();
    if (typeof first !== "number") return first;
    if (!(await modern())) {
      return failed("did not answer server/discover (the 2026-07-28 era)");
    }
    if (first >= BRIDGE_ROUND_TRIP_MS) {
      return {
        id,
        status: "warn",
        detail: `${name(view)}: a status round trip took ${String(Math.round(first))} ms, over ${String(BRIDGE_ROUND_TRIP_MS)} ms. Run: ${CLI_NAME} doctor again; if it stays slow, restart the service: ${CLI_NAME} service restart`,
      };
    }
    return {
      id,
      status: "ok",
      detail: `${name(view)}: the entry's command answers both eras, lists this build's tools, and a status round trip took ${String(Math.round(first))} ms.`,
    };
  } catch {
    return failed("could not be started");
  }
}

// ---------------------------------------------------------------------------------------------
// --live

/** The headless call of an app (A3 3.14 `live`), or undefined for an app without one. */
function liveArgv(app: HomeView["home"]["app"], exec: readonly string[]): string[] | undefined {
  if (app === "claude-code") {
    return [
      ...exec,
      "-p",
      "--allowedTools",
      `mcp__${MCP_SERVER_KEY}__status`,
      "--no-session-persistence",
    ];
  }
  if (app === "codex") {
    return [
      ...exec,
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "-c",
      `mcp_servers.${MCP_SERVER_KEY}.default_tools_approval_mode="approve"`,
      "-",
    ];
  }
  return undefined;
}

/**
 * Runs `argv` as a helper of the runner with `stdin` and nothing kept of its output; its exit code,
 * or null when it could not start or its deadline ended it.
 */
async function runHeadless(
  argv: readonly string[],
  env: Env,
  cwd: string,
  stdin: string,
  timeoutMs: number,
): Promise<number | null> {
  try {
    const run = startHelper(argv, { env, cwd, deadlineMs: timeoutMs, stdin: true });
    run.child.stdin?.end(stdin);
    return await run.ended;
  } catch {
    return null;
  }
}

/** `live`: one headless call per registered app home, and the service saw it from that home. */
async function liveChecks(
  input: SetupInput,
  state: string,
  views: readonly HomeView[],
  call: Call | undefined,
  resolve: (argv: readonly string[]) => readonly string[],
  liveMs: number,
): Promise<Check[]> {
  if (call === undefined) return [liveSkipped(true, "No service: it must see the call.")];
  sweepLive(state, liveMs);
  const checks: Check[] = [];
  for (const view of views.filter((v) => v.state === "registered")) {
    const id = `live.${view.home.instance}`;
    const exec = commandFor(input, view.home);
    const argv = exec === undefined ? undefined : liveArgv(view.home.app, exec);
    if (argv === undefined) {
      checks.push({
        id,
        status: "skip",
        detail: `${name(view)}: ${exec === undefined && view.home.app !== "claude-desktop" ? "the app's command was not found on this PATH" : "the app has no headless mode"}.`,
      });
      continue;
    }
    // A temporary folder of the doctor's own: the run's working folder, removed by its full name.
    const dir = join(state, "tmp", `${LIVE_FOLDER}${randomBytes(6).toString("hex")}`);
    makeDir(dir, 0o700);
    const started = Date.now();
    try {
      const code = await runHeadless(
        resolve(argv),
        commandEnv(input, view.home).env,
        dir,
        LIVE_PROMPT,
        liveMs,
      );
      // The run's own evidence: a call from this home's instance, after the run started, from a
      // bridge working in the run's folder (the app starts its servers there). A call from the
      // home in another folder may be another session's.
      const folders = [dir, realFolder(dir)].filter((f, i, all) => all.indexOf(f) === i);
      const seen = ((await call("setup/seen", { folders }))["calls"] ?? []) as {
        instance: string;
        at: string;
        folder_at?: string | null;
      }[];
      const mine = seen.find((s) => s.instance === view.home.instance);
      const after = (time: string | null | undefined) => {
        const at = Date.parse(time ?? "");
        return Number.isFinite(at) && at >= started;
      };
      checks.push(
        after(mine?.folder_at)
          ? {
              id,
              status: "ok",
              detail: `${name(view)}: the service carried out a call from this home through the app.`,
            }
          : after(mine?.at)
            ? {
                id,
                status: "warn",
                detail: `${name(view)}: the service saw a call from this home during the run, but not from the run's own folder, so another session of this home may have made it. Close other sessions of this app, then run: ${CLI_NAME} doctor --live`,
              }
            : {
                id,
                status: "fail",
                detail: `${name(view)}: the app ${code === 0 ? "ran, but the service saw no call from this home" : "did not finish its headless run"}. Check that the app is signed in and loads MCP servers, then run: ${CLI_NAME} setup agents --status`,
              },
      );
    } finally {
      removeFolder(dir);
    }
  }
  return checks.length === 0 ? [liveSkipped(true, "No registered home to call through.")] : checks;
}

/** The name of `--live`'s working folders in `<state>/tmp`, before 12 hex digits. */
const LIVE_FOLDER = "doctor-live-";

/**
 * Removes a working folder of doctor's own. On Windows a process an app left behind may still hold
 * it: it stays then, without failing the report, and a later `--live` removes it (sweepLive).
 */
function removeFolder(dir: string): void {
  try {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  } catch {
    // Left for the next sweep.
  }
}

/** Earlier runs' working folders that could not be removed then, once no run can still use them. */
function sweepLive(state: string, liveMs: number): void {
  const tmp = join(state, "tmp");
  let names: string[];
  try {
    names = readdirSync(tmp);
  } catch {
    return;
  }
  const pattern = new RegExp(`^${LIVE_FOLDER}[0-9a-f]{12}$`, "u");
  for (const name of names.filter((n) => pattern.test(n))) {
    const dir = join(tmp, name);
    try {
      if (Date.now() - lstatSync(dir).mtimeMs > 2 * liveMs) removeFolder(dir);
    } catch {
      // Gone meanwhile.
    }
  }
}
