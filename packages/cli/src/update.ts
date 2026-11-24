// `ttasks update --from <archive> | --rollback | --repair [--yes] [--stop-runs]`: the
// installed version replaces itself from a local release archive, goes back to the version before
// the last switch, or finishes an update that was cut off. The updater is the service's
// (`@ttasks/service/version-update`), loaded only for this command; it verifies the archive with
// the release keys this build carries (UPDATE_KEYS) before anything of it runs.
//
// It runs only through the install's own command, which runs the version current names: an
// installed version vouches for its successor, never another one. An agent's shell may not run it,
// as it may not stop the service: the update restarts it. A service that runs is restarted only
// once the person agreed, asked once in a terminal, before anything is held or stopped: when it
// starts, or when a service runs later where the update or a repair would restart it. `--yes`
// answers for a script; without a terminal and without `--yes` an update changes nothing (exit 2)
// and a repair leaves the service running for its next start. The restart ends background runs:
// the update waits for them, then asks whether to stop them; `--stop-runs` answers for a script,
// and without a terminal and without it the update is given up with nothing changed (exit 2).
// Every update ends by naming each space that is not usable now, in the service's own words, and
// exits 8 when it named one, one did not open in time, or the service could not be asked.
import { resolve } from "node:path";
import { CLI_NAME, PRODUCT_NAME } from "@ttasks/brand";
import { EXIT_CODES } from "@ttasks/contracts";
import { hostFacts } from "@ttasks/service/paths";
import type { SpaceNote, SpacesReport, UpdateResult } from "@ttasks/service/version-update";
import type { Globals } from "./args.ts";
import type { Io } from "./io.ts";
import { printUsage } from "./output.ts";

export const UPDATE_USAGE =
  "ttasks update --from <archive> [--yes] [--stop-runs], ttasks update --rollback [--yes] [--stop-runs] or ttasks update --repair [--yes] [--stop-runs]";

interface Answers {
  readonly yes: boolean;
  /** Background runs still running after the wait are stopped without a question. */
  readonly stopRuns: boolean;
}

type Parsed =
  | ({ readonly verb: "from"; readonly archive: string } & Answers)
  | ({ readonly verb: "rollback" | "repair" } & Answers);

function parse(args: readonly string[]): Parsed | undefined {
  let verb: Parsed["verb"] | undefined;
  let archive: string | undefined;
  let yes = false;
  let stopRuns = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--yes" && !yes) yes = true;
    else if (arg === "--stop-runs" && !stopRuns) stopRuns = true;
    else if (arg === "--from" && verb === undefined && args[i + 1] !== undefined) {
      verb = "from";
      archive = args[i + 1];
      i += 1;
    } else if ((arg === "--rollback" || arg === "--repair") && verb === undefined) {
      verb = arg === "--rollback" ? "rollback" : "repair";
    } else return undefined;
  }
  if (verb === undefined) return undefined;
  return verb === "from"
    ? { verb, archive: archive ?? "", yes, stopRuns }
    : { verb, yes, stopRuns };
}

export async function updateCommand(
  io: Io,
  globals: Globals,
  args: readonly string[],
  versionFolder: string | undefined,
): Promise<number> {
  const parsed = parse(args);
  if (parsed === undefined) return printUsage(io, globals.json, UPDATE_USAGE);
  if (versionFolder === undefined) {
    return printUsage(
      io,
      globals.json,
      "ttasks update runs in an installed version, through the install's own command. From source there is nothing to update.",
    );
  }
  const install = await import("@ttasks/service/install");
  const update = await import("@ttasks/service/version-update");
  const { UPDATE_KEYS } = await import("@ttasks/service/release-keys");
  const fail = (message: string, code: number): number => {
    if (globals.json) io.stdout(`${JSON.stringify({ ok: false, error: message })}\n`);
    io.stderr(`${message}\n`);
    return code;
  };
  let ctx: ReturnType<typeof install.defaultServiceContext>;
  try {
    ctx = install.defaultServiceContext({ env: io.env });
  } catch (error) {
    if (error instanceof install.ServiceCommandError) return fail(error.message, error.exitCode);
    throw error;
  }
  if (ctx.agentShell) {
    return fail(
      `An agent's shell cannot update ${PRODUCT_NAME}: the update restarts the service. Run it in your own terminal.`,
      5,
    );
  }
  const control = update.osServiceControl(ctx, io.env);
  const ask = io.tty.stdin && io.tty.stdout ? install.processIO().ask : undefined;
  // The person's answer about the restart, asked at most once: here when the service runs now, or
  // when the updater needs it later for a service that started meanwhile (agreeRestart).
  let agreed: boolean | undefined = parsed.yes ? true : undefined;
  if (parsed.verb !== "repair" && agreed === undefined && (await control.running()) !== undefined) {
    if (ask === undefined) {
      return fail(
        "The update restarts the service. Run it again with --yes to go ahead without a question.",
        2,
      );
    }
    agreed = await ask(
      "The update restarts the service. Sessions keep running and reconnect; background runs are waited for first. Restart now? [y/N] ",
    );
    if (!agreed) return fail("Nothing was changed.", 2);
  }
  const agreeRestart = async (): Promise<boolean> => {
    agreed ??=
      ask === undefined
        ? false
        : await ask(
            "The service is running, and the update restarts it: sessions keep running and reconnect; background runs are waited for first. Restart now? [y/N] ",
          );
    return agreed;
  };
  // Runs still running once the wait is over: the option answers for a script, a person is asked,
  // and without either the update is given up, so no run a person waits for ends unasked.
  const decide = async (): Promise<"stop" | "give_up"> => {
    if (parsed.stopRuns) return "stop";
    if (ask === undefined) {
      io.stderr("Run it again when they finished, or with --stop-runs to stop them.\n");
      return "give_up";
    }
    const stop = await ask(
      "Stop these runs and update now? Each keeps its answer so far. No gives up the update. [y/N] ",
    );
    return stop ? "stop" : "give_up";
  };
  const options = {
    facts: hostFacts(io.env, io.platform),
    keys: UPDATE_KEYS,
    self: versionFolder,
    control,
    selfTest: update.launcherSelfTest(io.env, io.platform),
    say: (line: string) => {
      if (!globals.json) io.stdout(`${line}\n`);
    },
    runs: { decide },
    agreeRestart,
  };
  let result: UpdateResult;
  try {
    result =
      parsed.verb === "from"
        ? await update.updateFromArchive(resolve(io.cwd, parsed.archive), options)
        : parsed.verb === "rollback"
          ? await update.rollbackUpdate(options)
          : await update.repairUpdate(options);
  } catch (error) {
    if (error instanceof update.UpdateError) return fail(error.message, error.exitCode);
    throw error;
  }
  // Whatever the update did, the service that runs the current version says how each space is
  // now: one that is not usable is named in its words, so a person knows before they need it.
  const report = result.spaces;
  const spaces = report === undefined ? undefined : spaceLines(report);
  const code = spaces?.flagged === true ? EXIT_CODES.space : 0;
  if (globals.json) {
    io.stdout(
      `${JSON.stringify({
        ok: code === 0,
        ...summary(result),
        ...(report === undefined || spaces === undefined
          ? {}
          : { spaces: spacesJson(report, spaces.commands) }),
      })}\n`,
    );
    return code;
  }
  switch (result.outcome) {
    case "updated":
      io.stdout(`${PRODUCT_NAME} ${result.to} is current (was ${result.from}).\n`);
      break;
    case "current":
      break;
    case "repaired":
      io.stdout(
        result.repair.kind === "nothing"
          ? `No update was interrupted. ${PRODUCT_NAME} ${result.current} is current.\n`
          : `${PRODUCT_NAME} ${result.current} is current and complete.\n`,
      );
      break;
  }
  for (const line of spaces?.lines ?? []) io.stdout(`${line}\n`);
  return code;
}

/** What a state means to a person, in a line about a space. */
const STATE_WORDS: Readonly<Record<string, string>> = {
  open: "open for changes",
  read_only: "read-only",
  unavailable: "unavailable",
  closed: "closed",
  opening: "still opening",
  closing: "closing",
};

const stateWords = (space: SpaceNote | undefined): string =>
  space === undefined ? "not listed" : (STATE_WORDS[space.state] ?? space.state);

const duration = (ms: number): string =>
  ms >= 60_000
    ? `${String(Math.round(ms / 60_000))} minutes`
    : `${String(Math.round(ms / 1000))} seconds`;

/**
 * The end of every update: a line for each space that is not usable now, in the service's own
 * words, which name the backup of a failed migration; one for each that had not opened within the
 * bound; one line for the others; and the rollback when a space is not usable. A space the note
 * from before the switch did not hold may have been so already, except one whose migration failed,
 * which the running version tried. When the service stopped answering: what it said last, and
 * where to look again. When it was not running: that nothing was checked, and how to look once it
 * runs, which flags nothing. `flagged` when anything was named; `commands`, the ones the lines name.
 */
export function spaceLines(report: SpacesReport): {
  readonly lines: string[];
  readonly flagged: boolean;
  readonly commands: string[];
} {
  const lines: string[] = [];
  const commands: string[] = [];
  const name = (command: string): string => {
    if (!commands.includes(command)) commands.push(command);
    return command;
  };
  if (report.service === "not_running") {
    lines.push(
      `The service is not running, so the spaces were not checked. Once it runs (${name(`${CLI_NAME} service start`)}): ${name(`${CLI_NAME} doctor`)} and ${name(`${CLI_NAME} space list`)} show how they opened.`,
    );
    return { lines, flagged: false, commands };
  }
  if (report.service === "stopped_answering") {
    const said = report.spaces.map((space) => `${space.name} ${stateWords(space.now)}`);
    lines.push(
      [
        "The service stopped answering while the update waited for the spaces, so they could not be checked.",
        ...(said.length > 0 ? [`What it said last: ${said.join("; ")}.`] : []),
        `To look again: ${name(`${CLI_NAME} doctor`)} and ${name(`${CLI_NAME} space list`)}`,
      ].join(" "),
    );
    return { lines, flagged: true, commands };
  }
  let fine = 0;
  let notUsable = 0;
  for (const space of report.spaces) {
    const now = space.now;
    if (space.verdict === "usable" || space.verdict === "as_before") {
      fine += 1;
    } else if (space.verdict === "not_usable") {
      notUsable += 1;
      const head =
        space.before !== undefined
          ? `${space.name} was ${stateWords(space.before)} before the update and is ${stateWords(now)} now.`
          : report.noted || now?.reason === "migration_failed"
            ? `${space.name} is ${stateWords(now)} now.`
            : `${space.name} is ${stateWords(now)} now, as it may have been before this update.`;
      lines.push(now?.message === undefined ? head : `${head} ${now.message}`);
    } else {
      lines.push(
        `${space.name} had not finished opening within ${duration(report.boundMs)}, perhaps behind a migration. ${name(`${CLI_NAME} space list`)} shows how it opened.`,
      );
    }
  }
  const others = fine < report.spaces.length;
  if (fine > 0) {
    const how = report.noted ? "as usable as before" : "usable";
    lines.push(
      fine === 1
        ? `The ${others ? "other " : ""}space is ${how}.`
        : `The ${others ? "other " : ""}${String(fine)} spaces are ${how}.`,
    );
  }
  if (notUsable > 0 && report.wayBack !== undefined) {
    lines.push(`To go back to ${report.wayBack}: ${name(`${CLI_NAME} update --rollback`)}`);
  }
  return { lines, flagged: others, commands };
}

/** A space's entry in `--json`: its state, and the service's reason, words and backup. */
const noteJson = (note: SpaceNote) => ({
  state: note.state,
  ...(note.reason === undefined ? {} : { reason: note.reason }),
  ...(note.message === undefined ? {} : { message: note.message }),
  ...(note.migration_backup === undefined ? {} : { backup: note.migration_backup }),
});

/** The spaces in `--json`: the same facts as the lines, and the commands they name. */
export function spacesJson(report: SpacesReport, commands: readonly string[]) {
  return {
    service: report.service,
    noted: report.noted,
    bound_ms: report.boundMs,
    ...(report.wayBack === undefined ? {} : { way_back: report.wayBack }),
    commands,
    spaces: report.spaces.map((space) => ({
      id: space.id,
      name: space.name,
      verdict: space.verdict,
      now: space.now === undefined ? null : noteJson(space.now),
      before: space.before === undefined ? null : noteJson(space.before),
    })),
  };
}

function summary(result: UpdateResult) {
  switch (result.outcome) {
    case "updated":
      return { outcome: result.outcome, from: result.from, to: result.to };
    case "current":
      return { outcome: result.outcome, version: result.version };
    case "repaired":
      return { outcome: result.outcome, repair: result.repair.kind, current: result.current };
  }
}
