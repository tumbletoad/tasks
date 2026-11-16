// The thin entries of `tasks service install|uninstall|start|stop|status`: they print and return
// the exit code. The CLI (packages/cli/src/service.ts, A2 3.10.1) parses the command
// line and calls serviceEntry with the verb and its flags.
//
// install and uninstall print their plan first, the preview, and ask once before they change
// anything. `--yes` applies without asking, `--dry-run` shows the preview and changes nothing. A
// run that cannot ask (no terminal, or `--json`) and has neither flag changes nothing and exits 2.
import { createInterface } from "node:readline/promises";
import { CLI_NAME, PRODUCT_NAME } from "@tasks/brand";
import { blockedMessage, movedMessage } from "../http/messages.ts";
import {
  applyPlan,
  NO_UNIT_LINE,
  planInstall,
  planUninstall,
  serviceStatus,
  startService,
  stopService,
  type Plan,
  type ServiceAnswer,
  type StartOutcome,
  type StatusReport,
  type Step,
  type StopOutcome,
} from "./commands.ts";
import { defaultServiceContext, isTty, type ServiceContext } from "./context.ts";
import { ServiceCommandError } from "./errors.ts";
import { RegExportError, RegistryError } from "./registry.ts";

export const SERVICE_VERBS = ["install", "uninstall", "start", "stop", "status"] as const;
export type ServiceVerb = (typeof SERVICE_VERBS)[number];

export const isServiceVerb = (value: string): value is ServiceVerb =>
  (SERVICE_VERBS as readonly string[]).includes(value);

export interface ServiceFlags {
  /** One JSON document on stdout (A2 3.10.2). */
  readonly json?: boolean | undefined;
  /** install and uninstall: apply the plan without asking. */
  readonly yes?: boolean | undefined;
  /** install and uninstall: print the plan and change nothing. */
  readonly dryRun?: boolean | undefined;
}

const FLAGS: Readonly<Record<string, keyof ServiceFlags>> = {
  "--yes": "yes",
  "-y": "yes",
  "--dry-run": "dryRun",
  "--json": "json",
};

/** The verb and flags of `tasks service <verb> [flags]`, or undefined when they are not valid. */
export function parseServiceArgs(
  args: readonly string[],
): { readonly verb: ServiceVerb; readonly flags: ServiceFlags } | undefined {
  const [verb, ...rest] = args;
  if (verb === undefined || !isServiceVerb(verb)) return undefined;
  const flags: { -readonly [K in keyof ServiceFlags]: boolean } = {};
  for (const arg of rest) {
    const flag = Object.hasOwn(FLAGS, arg) ? FLAGS[arg] : undefined;
    if (flag === undefined) return undefined;
    flags[flag] = true;
  }
  return { verb, flags };
}

export interface EntryIO {
  /** stdout: the result. */
  readonly out: (text: string) => void;
  /** stderr: errors and hints. */
  readonly err: (text: string) => void;
  /** Asks a yes-or-no question. Undefined when no one can answer (no terminal). */
  readonly ask: ((question: string) => Promise<boolean>) | undefined;
}

/** The process's own streams, and a question on the terminal when stdin and stdout are one. */
export function processIO(): EntryIO {
  const interactive = isTty(process.stdin) && isTty(process.stdout);
  return {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    ask: interactive
      ? async (question) => {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          try {
            return /^(y|yes)$/i.test((await rl.question(question)).trim());
          } finally {
            rl.close();
          }
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// Text for people

const indent = (text: string, by: string): string =>
  text
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => `${by}${line}`.trimEnd())
    .join("\n");

function whichInstall(ctx: ServiceContext): string {
  return ctx.layout.home === undefined
    ? `this user's ${PRODUCT_NAME} (install ID ${ctx.installId})`
    : `the test install at ${ctx.layout.home} (install ID ${ctx.installId})`;
}

function startText(ctx: ServiceContext): string {
  switch (ctx.platform) {
    case "linux":
      return `Start the service: systemctl --user start ${ctx.names.unit}, and wait until it is ready.`;
    case "win32":
      return `Start the service through Explorer, as Windows does at sign-in: explorer.exe "${ctx.program}", and wait until it is ready.`;
    case "darwin":
      return `Start the service: launchctl kickstart gui/${String(ctx.uid ?? 0)}/${ctx.names.label}, and wait until it is ready.`;
  }
}

/** The keys a value's write creates, topmost first, for the preview. */
const createdKeys = (keys: readonly string[]): string =>
  keys.length === 0
    ? ""
    : `\n     It creates the key${keys.length === 1 ? "" : "s"} ${[...keys].reverse().join(", ")}, which ${keys.length === 1 ? "does" : "do"} not exist yet.`;

const EXISTING = {
  absent: "",
  same: " It is already there and the same, so it is left as it is.",
  different: ` It replaces the ${PRODUCT_NAME} entry there, which starts another program path.`,
} as const;

function stepText(ctx: ServiceContext, step: Step): string {
  switch (step.do) {
    case "create-folder":
      return `Create the folder ${step.path}.`;
    case "write-file":
      return step.existing === "same"
        ? `Keep ${step.path}.${EXISTING.same}`
        : `Write ${step.path}:${EXISTING[step.existing]}\n${indent(step.text, "     | ")}`;
    case "remove-file":
      return `Remove ${step.path}.`;
    case "remove-empty-folder":
      return `Remove the folder ${step.path} if it is empty: install created it.`;
    case "set-value":
      return step.existing === "same"
        ? `Keep the value "${step.name}" in ${step.key}.${EXISTING.same}`
        : `Set the value "${step.name}" (REG_SZ) in ${step.key}\n     to ${step.data}${step.existing === "different" ? `, replacing the ${PRODUCT_NAME} path there` : ""}. Windows starts it at each sign-in.${createdKeys(step.creates)}`;
    case "remove-value":
      return step.record === "entry"
        ? `Remove the value "${step.name}" from ${step.key}.`
        : `Remove Task Manager's on or off record for "${step.name}" from ${step.key}.`;
    case "remove-empty-key":
      return `Remove the key ${step.key} if it is empty: install created it.`;
    case "forget-created":
      return `Remove ${step.path}, the note of what install created.`;
    case "run":
      return `Run: ${[step.file, ...step.args].join(" ")}${step.creates === undefined ? "" : `\n     It creates the folder ${step.creates}.`}`;
    case "start":
      return startText(ctx);
    case "stop":
      return step.startedByHand === true
        ? "If the service runs without its unit (started by hand), stop it and wait until it has stopped, so that the unit starts it in the next step."
        : "Stop the service if it runs, and wait until it has stopped.";
  }
}

/** The preview: every step the plan takes, in order, with the text of what it writes. */
export function previewText(ctx: ServiceContext, plan: Plan): string {
  const lines = [`${CLI_NAME} service ${plan.verb}, for ${whichInstall(ctx)}.`];
  if (plan.steps.length === 0) {
    lines.push(
      plan.verb === "uninstall"
        ? `Nothing to remove: ${plan.entry.where}${plan.entry.kind === "run-value" ? ` has no value "${plan.entry.name}"` : " does not exist"}.`
        : "Nothing to do.",
    );
    return `${lines.join("\n")}\n`;
  }
  lines.push("This will:");
  plan.steps.forEach((step, n) => {
    lines.push(indent(`${String(n + 1)}. ${stepText(ctx, step)}`, "  "));
  });
  for (const note of plan.notes) lines.push(note);
  lines.push(
    plan.verb === "install"
      ? `Nothing else changes. To undo it: ${CLI_NAME} service uninstall`
      : `Nothing else changes. To set it up again: ${CLI_NAME} service install`,
  );
  return `${lines.join("\n")}\n`;
}

const minutes = (ms: number): string => {
  const total = Math.round(ms / 60_000);
  return total < 1
    ? "under a minute"
    : total < 120
      ? `${String(total)} min`
      : `${String(Math.round(total / 60))} h`;
};

function runningText(outcome: StartOutcome, plain = false): string {
  const s = outcome.status;
  const head =
    outcome.outcome === "already_running" && !plain
      ? `${PRODUCT_NAME}'s service already runs`
      : `${PRODUCT_NAME}'s service runs`;
  return `${head}: ${s.state}, PID ${String(s.pid)}, version ${s.version} (${s.build}), started by ${s.manager}.\n`;
}

function stoppedText(outcome: StopOutcome): string {
  return outcome.outcome === "not_running"
    ? `${PRODUCT_NAME}'s service is not running.\n`
    : `${PRODUCT_NAME}'s service has stopped.\n`;
}

const REASONS = {
  not_running: "not running",
  starting: "starting",
  stopping: "stopping",
  unreachable: "not reachable",
  untrusted_endpoint: "not trusted: the endpoint did not prove it is this install's service",
  other_install: "not this install's service",
  restart_session: `runs a newer version than this ${CLI_NAME} command, which cannot talk to it`,
  service_too_old: "runs an older version than the one installed: restart it",
} as const;

/** The spaces line of status: how many, by state. */
function spacesText(spaces: readonly { readonly state: string }[]): string {
  if (spaces.length === 0) return "none";
  const counts = new Map<string, number>();
  for (const space of spaces) counts.set(space.state, (counts.get(space.state) ?? 0) + 1);
  const listed = [...counts].map(([state, n]) => `${String(n)} ${state}`).join(", ");
  return counts.has("unavailable") || counts.has("read_only")
    ? `${listed}. ${CLI_NAME} space list says why and what to run`
    : listed;
}

/** The UI line of status: the listener's address, or A2 3.8.2's moved line or blocked message. */
/** Whether background runs can be contained here; nothing for a service that hosts none. */
function runsText(runs: Extract<ServiceAnswer, { answers: true }>["runs"]): string | undefined {
  if (runs === null) return undefined;
  if (runs.available === null) return "not checked yet";
  return runs.available ? "can run here" : `off. ${runs.message}`;
}

function uiText(http: Extract<ServiceAnswer, { answers: true }>["http"]): string {
  if (http === null) return "no listener";
  if (http.blocked !== null) return blockedMessage(http.port);
  if (http.port === null) return "no listener";
  if (http.moved && http.persisted !== null) return movedMessage(http.persisted, http.port);
  return `http://127.0.0.1:${String(http.port)}`;
}

/** `tasks service status` for people. */
export function statusText(ctx: ServiceContext, report: StatusReport): string {
  const entry = report.entry;
  const where =
    entry.kind === "run-value" ? `the value "${entry.name}" in ${entry.where}` : entry.where;
  const state =
    entry.state === "absent"
      ? "not installed"
      : entry.state === "foreign"
        ? "belongs to something else"
        : entry.current
          ? "installed"
          : `installed, but not what install writes now: run ${CLI_NAME} service install to update it`;
  const lines = [
    `${PRODUCT_NAME} service, for ${whichInstall(ctx)}`,
    `  Entry:    ${where}: ${state}`,
  ];
  const a = report.autostart;
  switch (a.kind) {
    case "systemd": {
      // What linger means for the service holds only for this install's own unit: without one,
      // nothing starts the service at sign-in or boot, linger or not.
      const unit = entry.state === "ours";
      lines.push(
        !a.user_manager
          ? "  systemd:  no user manager on this machine: nothing starts the service at login"
          : unit
            ? `  systemd:  ${a.enabled ?? "unknown"}, ${a.active ?? "unknown"}`
            : `  systemd:  no unit of this install, so nothing starts the service at sign-in or boot. To have it start by itself: ${CLI_NAME} service install`,
        a.linger === "unknown"
          ? "  Linger:   unknown"
          : !unit || !a.user_manager
            ? `  Linger:   ${a.linger === "yes" ? "on" : "off"}`
            : a.linger === "yes"
              ? "  Linger:   on: the service starts at boot, before you sign in"
              : "  Linger:   off: the service starts when you sign in. To start it at boot: loginctl enable-linger",
      );
      break;
    }
    case "run":
      lines.push(
        a.startup_apps === "off"
          ? `  Startup apps: off. ${PRODUCT_NAME} is turned off in Startup apps (Task Manager), so Windows does not start it at sign-in`
          : `  Startup apps: on${a.startup_apps === "not_set" ? " (no choice recorded)" : ""}`,
      );
      break;
    case "launchd":
      lines.push(`  launchd:  ${a.loaded ? "loaded" : "not loaded"}`);
      break;
  }
  const s = report.service;
  lines.push(
    s.answers
      ? `  Service:  ${s.state}, PID ${String(s.pid)}, version ${s.version} (${s.build}), up ${minutes(s.uptime_ms)}, started by ${s.manager}`
      : `  Service:  ${REASONS[s.reason]}`,
  );
  if (s.answers) {
    lines.push(`  Spaces:   ${spacesText(s.spaces)}`, `  UI:       ${uiText(s.http)}`);
    const runs = runsText(s.runs);
    if (runs !== undefined) lines.push(`  Runs:     ${runs}`);
  }
  if (!report.program_present) lines.push(`  Build:    missing at ${report.program}`);
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------
// JSON

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function planJson(plan: Plan): unknown {
  return { verb: plan.verb, entry: plan.entry, steps: plan.steps, notes: plan.notes };
}

function errorJson(error: ServiceCommandError): unknown {
  return {
    error: {
      code: error.code,
      class: error.errorClass,
      message: error.message,
      ...(error.hint === undefined ? {} : { hint: error.hint }),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The entries

async function changeEntry(
  verb: "install" | "uninstall",
  ctx: ServiceContext,
  flags: ServiceFlags,
  io: EntryIO,
): Promise<number> {
  const plan = verb === "install" ? await planInstall(ctx) : await planUninstall(ctx);
  if (flags.json !== true) io.out(previewText(ctx, plan));
  if (plan.steps.length === 0 || flags.dryRun === true) {
    if (flags.json === true) io.out(json({ ...(planJson(plan) as object), applied: false }));
    return 0;
  }
  if (flags.yes !== true) {
    if (flags.json === true || io.ask === undefined) {
      throw new ServiceCommandError(
        "usage",
        "confirmation_needed",
        "Nothing was changed: this needs a yes, and no one can answer here.",
        `${CLI_NAME} service ${verb} --yes`,
      );
    }
    if (!(await io.ask("Continue? [y/N] "))) {
      io.out("Nothing was changed.\n");
      return 0;
    }
  }
  const applied = await applyPlan(ctx, plan);
  if (flags.json === true) {
    io.out(
      json({
        ...(planJson(plan) as object),
        applied: true,
        ...(applied.started === undefined ? {} : { started: applied.started }),
        ...(applied.stopped === undefined ? {} : { stopped: applied.stopped }),
      }),
    );
    return 0;
  }
  if (verb === "install") {
    io.out(`Done. ${PRODUCT_NAME}'s service is installed.\n`);
    // After install the service runs, whether this start or the manager's own load started it.
    if (applied.started !== undefined) io.out(runningText(applied.started, true));
  } else {
    if (applied.stopped !== undefined) io.out(stoppedText(applied.stopped));
    io.out(`Done. ${PRODUCT_NAME}'s service no longer starts by itself.\n`);
  }
  return 0;
}

/**
 * Runs one `tasks service` verb and returns its exit code (A2 3.10.3). `context` gives the install
 * and the places it writes: the real ones by default. Tests pass their own.
 */
export async function serviceEntry(
  verb: ServiceVerb,
  flags: ServiceFlags = {},
  io: EntryIO = processIO(),
  context: () => ServiceContext = () => defaultServiceContext(),
): Promise<number> {
  try {
    const ctx = context();
    switch (verb) {
      case "install":
      case "uninstall":
        return await changeEntry(verb, ctx, flags, io);
      case "start": {
        const outcome = await startService(ctx);
        if (flags.json === true) io.out(json(outcome));
        else {
          io.out(runningText(outcome));
          if (outcome.unit === "not_installed") io.out(`${NO_UNIT_LINE}\n`);
        }
        return 0;
      }
      case "stop": {
        const outcome = await stopService(ctx);
        io.out(flags.json === true ? json(outcome) : stoppedText(outcome));
        return 0;
      }
      case "status": {
        const report = await serviceStatus(ctx);
        io.out(flags.json === true ? json(report) : statusText(ctx, report));
        return 0;
      }
    }
  } catch (caught) {
    const error =
      caught instanceof ServiceCommandError
        ? caught
        : caught instanceof RegistryError || caught instanceof RegExportError
          ? new ServiceCommandError("internal", "registry_failed", `${caught.message}.`)
          : new ServiceCommandError(
              "internal",
              "internal",
              `${CLI_NAME} service ${verb} failed unexpectedly${caught instanceof Error && typeof (caught as NodeJS.ErrnoException).code === "string" ? ` (${String((caught as NodeJS.ErrnoException).code)})` : ""}.`,
            );
    if (flags.json === true) io.out(json(errorJson(error)));
    else io.err(`${error.message}\n${error.hint === undefined ? "" : `Try: ${error.hint}\n`}`);
    return error.exitCode;
  }
}
