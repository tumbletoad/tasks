// `tasks setup instances` (A4 3.2 "Detection proposes, the user confirms"; A5 3.17 step 3's CLI
// counterpart): the agent apps Open can open a task in on this machine, as machine.toml's
// `[[instance]]` entries. Loaded only for this command (setup.ts).
//
//   tasks setup instances [--preview]   what detection found (each agent command with its version,
//                                       each agent home) and the exact entries it would add, with
//                                       the apply command and the plan's token. Writes nothing
//   tasks setup instances --apply --plan <token>
//                                       adds exactly those entries, or changes nothing when the
//                                       proposal is not the same any more
//   tasks setup instances --remove      takes out every entry this command added that is still
//                                       exactly as it was written
//   [--instance <id>] [--json]
//
// Detection (@tasks/launch detect.ts) runs here, in the person's session and environment, so it
// finds the commands on the person's PATH: it reads folders' and files' presence and runs only each
// command's `--version`, never a wrapper, and opens no file in an agent home. The service writes
// the entries (hub/instances.ts), through machine.toml's own editor, and Open uses them at once.
// Only Claude Code and Codex homes with a command found are proposed: a wrapper without a home of
// its own, a home without a command and T3 Code (which needs its provider instance) are named with
// what is missing, for the person to write by hand.
//
// This changes nothing in any agent app. `tasks setup agents` registers Tasks's tools in each agent
// home, which the agent needs to read and update tasks; this command makes a home a place Open can
// start the agent in. They meet at the instance ID: an instance written here is the ID setup agents
// gives that home's entry, and a home setup agents registered first keeps its ID here.
import { createHash } from "node:crypto";
import { isAgentMarker } from "@tasks/bridge/protocol";
import { CLI_NAME, PRODUCT_NAME } from "@tasks/brand";
import { AppError } from "@tasks/contracts";
import {
  detect,
  instanceEntry,
  isBuiltInTarget,
  nodeDetectHost,
  shellLine,
  targetDef,
  type Detection,
  type InstanceValue,
  type Proposal,
} from "@tasks/launch";
import { keyText, loadMachineConfig, valueText, type EditValue } from "@tasks/service/config";
import { homeFolder, hostFacts, resolveLayout } from "@tasks/service/paths";
import { readRecords, samePath, type HomeRecord } from "@tasks/service/setup";
import { UsageError, type Globals } from "./args.ts";
import { connectService, type ConnectOptions, type Session } from "./connect.ts";
import type { Io } from "./io.ts";
import { bodyOf, printError, printUsage } from "./output.ts";
import type { AgentsSetupOptions } from "./setup-agents.ts";
import { asAppError } from "./verbs.ts";

type Mode = "preview" | "apply" | "remove";

interface Parsed {
  readonly mode: Mode;
  readonly instance: string | undefined;
  readonly plan: string | undefined;
}

const PLAN = /^[0-9a-f]{16}$/u;

function parse(args: readonly string[]): Parsed {
  let mode: Mode | undefined;
  let instance: string | undefined;
  let plan: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? "";
    const [name = "", inline] = token.split("=", 2);
    const value = (): string => {
      const found = inline ?? args[(i += 1)];
      if (found === undefined || found === "") throw new UsageError(`${name} needs a value`);
      return found;
    };
    if (token === "--preview" || token === "--apply" || token === "--remove") {
      if (mode !== undefined) throw new UsageError("Name one of --preview, --apply and --remove");
      mode = token.slice(2) as Mode;
    } else if (name === "--instance") {
      instance = value();
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/u.test(instance)) {
        throw new UsageError("--instance takes an instance ID");
      }
    } else if (name === "--plan") {
      plan = value();
      if (!PLAN.test(plan)) throw new UsageError("--plan takes the token the preview printed");
    } else {
      throw new UsageError(
        `${CLI_NAME} setup instances has no option ${/^--[a-z-]{1,30}$/.test(name) ? name : "like that"}`,
      );
    }
  }
  const chosen = mode ?? "preview";
  if (plan !== undefined && chosen !== "apply") throw new UsageError("--plan goes with --apply");
  if (chosen === "apply" && plan === undefined) {
    throw new UsageError(
      `${CLI_NAME} setup instances --apply needs --plan: run ${CLI_NAME} setup instances first and use the command it prints`,
    );
  }
  return { mode: chosen, instance, plan };
}

/** A person at a terminal (A2 3.6.5's `cli-interactive`): no agent marker, both ends a TTY. */
function userAtTerminal(io: Io): boolean {
  const agent = Object.entries(io.env).some(([n, v]) => v !== undefined && isAgentMarker(n));
  return !agent && io.tty.stdin && io.tty.stdout;
}

const forbidden = (): AppError =>
  new AppError({
    code: "forbidden",
    message:
      "Only the user can change this machine's agent instances, from an interactive terminal.",
    hint: `Ask the user to run: ${CLI_NAME} setup instances`,
    data: { rule: "user_only" },
  });

/** One proposal the preview offers: the entry it writes, keys in their order. */
interface Offer {
  readonly id: string;
  readonly label: string;
  readonly entry: ReadonlyMap<string, InstanceValue>;
}

/** A proposal it does not offer, and what is missing for the person to write by hand. */
interface Left {
  readonly id: string;
  readonly reason: "no_command" | "needs_home" | "needs_t3_provider" | "id_taken";
}

const LEFT_TEXT: Readonly<Record<Left["reason"], string>> = {
  no_command: "its command was not found on this PATH",
  needs_home:
    "it is a wrapper, which selects its own home: write its config_home into machine.toml by hand",
  needs_t3_provider:
    "T3 Code needs the provider instance it runs: write it into machine.toml by hand (t3_provider_instance)",
  id_taken: "another instance has its ID: write it into machine.toml by hand with another ID",
};

interface Survey {
  readonly detection: Detection;
  readonly offers: readonly Offer[];
  readonly left: readonly Left[];
  /** The instances machine.toml names now. */
  readonly configured: readonly { readonly id: string; readonly target: string }[];
  readonly platform: NodeJS.Platform;
}

/** Setup agents' app for a detected target. */
const APP_OF: Readonly<Record<string, HomeRecord["app"]>> = {
  "claude-cli": "claude-code",
  "codex-cli": "codex",
};

/**
 * What this machine has and what the preview proposes: detection in the person's environment, the
 * instances machine.toml names, and the IDs setup agents already gave a home.
 */
async function surveyOf(
  io: Io,
  options: { readonly agents?: AgentsSetupOptions },
  only: string | undefined,
): Promise<Survey> {
  const facts = hostFacts(io.env, io.platform);
  const layout = resolveLayout(facts);
  const env = options.agents?.env ?? io.env;
  const userHome = options.agents?.home ?? homeFolder(facts);
  const machine = loadMachineConfig(layout.config, io.platform).config;
  const detection = await detect(
    nodeDetectHost({ platform: io.platform, env, home: userHome }),
    machine.instances,
  );
  let records: HomeRecord[] = [];
  try {
    records = readRecords(layout.state);
  } catch {
    // Setup agents' record cannot be read: the proposals keep detection's IDs.
  }
  const taken = new Set(machine.instances.map((i) => i.id));
  const offers: Offer[] = [];
  const left: Left[] = [];
  for (const found of detection.proposals) {
    // A home setup agents registered keeps the instance ID its entry names.
    const record = records.find(
      (r) =>
        r.app === APP_OF[found.target] &&
        found.configHome !== undefined &&
        samePath(io.platform, r.home, found.configHome),
    );
    const proposal: Proposal = record === undefined ? found : { ...found, id: record.instance };
    if (only !== undefined && proposal.id !== only) continue;
    if (proposal.target === "t3") {
      left.push({ id: proposal.id, reason: "needs_t3_provider" });
      continue;
    }
    if (taken.has(proposal.id) || offers.some((o) => o.id === proposal.id)) {
      left.push({ id: proposal.id, reason: "id_taken" });
      continue;
    }
    const made = instanceEntry(proposal);
    if (!made.ok) {
      left.push({
        id: proposal.id,
        reason: made.needs.includes("exec") ? "no_command" : "needs_home",
      });
      continue;
    }
    offers.push({ id: proposal.id, label: proposal.label, entry: made.entry });
  }
  return {
    detection,
    offers,
    left,
    configured: machine.instances.map((i) => ({ id: i.id, target: i.target })),
    platform: io.platform,
  };
}

/** The plan's token: the entries the preview showed, in order, key for key. */
function planToken(offers: readonly Offer[]): string {
  const doc = offers.map((o) => [...o.entry]);
  return createHash("sha256").update(JSON.stringify(doc)).digest("hex").slice(0, 16);
}

/** The block machine.toml gets for an entry, as its editor writes it. */
const blockOf = (entry: ReadonlyMap<string, InstanceValue>): string[] => [
  "[[instance]]",
  ...[...entry].map(([k, v]) => `${keyText(k)} = ${valueText(v as EditValue)}`),
];

/** An entry as the service's `instances/add` takes it. */
const wireOf = (entry: ReadonlyMap<string, InstanceValue>): Record<string, unknown> =>
  Object.fromEntries([...entry].map(([k, v]) => [k, Array.isArray(v) ? [...(v as string[])] : v]));

export async function instancesCommand(
  io: Io,
  globals: Globals,
  args: readonly string[],
  options: ConnectOptions & { readonly agents?: AgentsSetupOptions },
): Promise<number> {
  let session: Session | undefined;
  const call = async (method: string, params: Record<string, unknown>) => {
    session ??= await connectService(io, options);
    return (await session.call(method, params, { timeoutMs: globals.timeoutS * 1000 })) as Record<
      string,
      unknown
    >;
  };
  try {
    const parsed = parse(args);
    if (parsed.mode !== "preview" && !userAtTerminal(io)) throw forbidden();
    if (parsed.mode === "remove") {
      const result = await call("instances/remove", {
        ...(parsed.instance === undefined ? {} : { ids: [parsed.instance] }),
      });
      return removed(io, globals, result);
    }
    const survey = await surveyOf(io, options, parsed.instance);
    const plan = planToken(survey.offers);
    if (parsed.mode === "preview") return preview(io, globals, survey, plan, parsed);
    if (plan !== parsed.plan) {
      throw new AppError({
        code: "conflict",
        message: "What this machine has changed since the preview, so nothing was changed.",
        hint: `Run ${CLI_NAME} setup instances again and use the command it prints.`,
      });
    }
    if (survey.offers.length === 0) {
      io.stdout(globals.json ? `${JSON.stringify({ added: [] })}\n` : "Nothing to do.\n");
      return 0;
    }
    const result = await call("instances/add", {
      entries: survey.offers.map((o) => wireOf(o.entry)),
    });
    const ids = survey.offers.map((o) => o.id);
    if (globals.json) {
      io.stdout(`${JSON.stringify({ added: result["added"] ?? ids })}\n`);
      return 0;
    }
    io.stdout(
      `Added ${ids.length === 1 ? "the instance" : "the instances"} ${ids.join(", ")} to machine.toml. Open offers ${ids.length === 1 ? "it" : "them"} now: reload ${PRODUCT_NAME}'s page.\n` +
        `For the agents to read and update tasks, register ${PRODUCT_NAME}'s tools in their homes: ${CLI_NAME} setup agents\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof UsageError) return printUsage(io, globals.json, error.message);
    return printError(io, globals.json, bodyOf(asAppError(error)));
  } finally {
    session?.close();
  }
}

function preview(io: Io, globals: Globals, survey: Survey, plan: string, parsed: Parsed): number {
  const apply = [
    CLI_NAME,
    "setup",
    "instances",
    "--apply",
    "--plan",
    plan,
    ...(parsed.instance === undefined ? [] : ["--instance", parsed.instance]),
  ];
  const { detection } = survey;
  if (globals.json) {
    io.stdout(
      `${JSON.stringify({
        mode: "preview",
        commands: detection.commands.map((c) => ({
          target: c.target,
          found: c.source,
          usable: c.exec.length > 0,
          ...(c.version === undefined ? {} : { version: c.version }),
          ...(c.tested === undefined ? {} : { tested: c.tested }),
        })),
        homes: detection.homes.map((h) => ({ target: h.target, home: h.path })),
        configured: survey.configured,
        add: survey.offers.map((o) => ({ id: o.id, entry: wireOf(o.entry) })),
        left: survey.left,
        ...(survey.offers.length === 0 ? {} : { plan, apply }),
      })}\n`,
    );
    return 0;
  }
  const out: string[] = [
    `Found on this machine (only each command's --version was run; no file in an agent home was read):`,
  ];
  if (detection.commands.length === 0) out.push("  no agent command on this PATH");
  for (const c of detection.commands) {
    const version =
      c.version === undefined
        ? "version unknown"
        : `${c.version}${c.tested === false ? ", not a tested version" : ""}`;
    out.push(
      `  ${targetDef(c.target).label}: ${c.exec.length > 0 ? version : "found, but it cannot be run directly"}`,
    );
  }
  for (const h of detection.homes) out.push(`  ${targetDef(h.target).label} home: ${h.path}`);
  out.push(
    survey.configured.length === 0
      ? "machine.toml names no instance yet."
      : `machine.toml names: ${survey.configured.map((i) => `${i.id} (${isBuiltInTarget(i.target) ? targetDef(i.target).label : i.target})`).join(", ")}.`,
  );
  survey.offers.forEach((offer, n) => {
    out.push(`${String(n + 1)}. ${offer.label} (instance ${offer.id}): adds to machine.toml`);
    for (const line of blockOf(offer.entry)) out.push(`     ${line}`);
  });
  for (const l of survey.left) out.push(`Not added: ${l.id}: ${LEFT_TEXT[l.reason]}.`);
  if (survey.offers.length === 0) {
    out.push("Nothing to add. Nothing was changed.");
  } else {
    const line = shellLine(io.platform, apply) ?? apply.join(" ");
    out.push(
      `Nothing was changed. To add ${survey.offers.length === 1 ? "this instance" : `these ${String(survey.offers.length)} instances`}, run: ${line}`,
      `${CLI_NAME} setup agents then registers ${PRODUCT_NAME}'s tools in their homes, which is a separate change to each agent app.`,
    );
  }
  io.stdout(`${out.join("\n")}\n`);
  return 0;
}

const REMOVED_TEXT = {
  removed: "removed from machine.toml",
  edited: "left in machine.toml: it was changed after setup wrote it",
  missing: "already gone from machine.toml",
} as const;

function removed(io: Io, globals: Globals, result: Record<string, unknown>): number {
  const outcomes = (Array.isArray(result["outcomes"]) ? result["outcomes"] : []) as {
    id: string;
    result: keyof typeof REMOVED_TEXT;
  }[];
  if (globals.json) {
    io.stdout(`${JSON.stringify({ outcomes })}\n`);
  } else {
    if (outcomes.length === 0) io.stdout("Nothing to remove: setup added no instance.\n");
    for (const o of outcomes) io.stdout(`${o.id}: ${REMOVED_TEXT[o.result]}\n`);
    if (outcomes.some((o) => o.result === "removed")) {
      io.stdout(
        `Open no longer offers ${outcomes.filter((o) => o.result === "removed").length === 1 ? "it" : "them"}: reload ${PRODUCT_NAME}'s page. Their homes' ${PRODUCT_NAME} entries stay until ${CLI_NAME} setup agents --remove.\n`,
      );
    }
  }
  return outcomes.some((o) => o.result === "edited") ? 10 : 0;
}
