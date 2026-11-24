// `ttasks update --from <archive> | --rollback | --repair [--yes] [--stop-runs]`: the
// installed version replaces itself from a local release archive, goes back to the version before
// the last switch, or finishes an update that was cut off. The updater is the service's
// (`@ttasks/service/version-update`), loaded only for this command; it verifies the archive with
// the release keys this build carries (UPDATE_KEYS) before anything of it runs.
//
// It runs only through the install's own command, which runs the version current names: an
// installed version vouches for its successor, never another one. An agent's shell may not run it,
// as it may not stop the service: the update restarts it. A service that runs when it starts, or
// at the switch, is restarted only once the person agreed: it asks once in a terminal; `--yes`
// answers for a script, and without a terminal and without `--yes` nothing is changed (exit 2).
// The restart ends background runs: the update waits for them, then asks whether to stop them;
// `--stop-runs` answers for a script, and without a terminal and without it the update is given
// up with nothing changed (exit 2). After a restart it says, for each space, whether it is as
// usable as before, and exits 8 when one is not or did not open in time.
import { resolve } from "node:path";
import { CLI_NAME, PRODUCT_NAME } from "@ttasks/brand";
import { EXIT_CODES } from "@ttasks/contracts";
import { hostFacts } from "@ttasks/service/paths";
import type { SpaceNote, SpacesReport, UpdateResult } from "@ttasks/service/version-update";
import type { Globals } from "./args.ts";
import type { Io } from "./io.ts";
import { migratedLine, migratedSince } from "./migrations.ts";
import { printUsage } from "./output.ts";

export const UPDATE_USAGE =
  "ttasks update --from <archive> [--yes] [--stop-runs], ttasks update --rollback [--yes] [--stop-runs] or ttasks update --repair [--stop-runs]";

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
  // at the switch when one started meanwhile (the updater asks through agreeRestart).
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
            "The service started while the update ran. The update restarts it: sessions keep running and reconnect; background runs are waited for first. Restart now? [y/N] ",
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
  const began = Date.now();
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
  // A restarted service opens the spaces again and migrates those at an older schema: whether each
  // is as usable as before, what a migration did and the backup from just before it, so a person
  // who misses something knows where to go back to.
  const spaces =
    result.outcome === "updated" && result.spaces !== undefined
      ? spaceLines(result.spaces, result, began)
      : undefined;
  const code = spaces?.worse === true ? EXIT_CODES.space : 0;
  if (globals.json) {
    io.stdout(`${JSON.stringify({ ok: code === 0, ...summary(result) })}\n`);
    return code;
  }
  switch (result.outcome) {
    case "updated":
      io.stdout(`${PRODUCT_NAME} ${result.to} is current (was ${result.from}).\n`);
      for (const line of spaces?.lines ?? []) io.stdout(`${line}\n`);
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
 * The end of an update that restarted the service: a line for each space that is less usable than
 * before, in the service's own words, with the migration and its backup when the new version ran
 * one, and the rollback; one for each that did not open in time; the migrations of the others;
 * and one line for the spaces as before. `worse` when a space is not as usable as before, or
 * could not be seen to be.
 */
export function spaceLines(
  report: SpacesReport,
  update: { readonly from: string },
  sinceMs: number,
): { readonly lines: string[]; readonly worse: boolean } {
  const lines: string[] = [];
  let same = 0;
  let worse = 0;
  for (const space of report.spaces) {
    const migrated = space.after?.migrated;
    const migration =
      migrated !== undefined && migratedSince(migrated, sinceMs)
        ? migratedLine(migrated)
        : undefined;
    if (space.verdict === "as_before") {
      same += 1;
      if (migration !== undefined) lines.push(`${space.name}: ${migration}`);
    } else if (space.verdict === "worse") {
      worse += 1;
      const why = [space.after?.message, migration].filter((part) => part !== undefined);
      lines.push(
        [
          `${space.name} was ${stateWords(space.before)} before the update and is ${stateWords(space.after)} now.`,
          ...why,
        ].join(" "),
      );
    } else {
      lines.push(
        `${space.name} had not finished opening ${duration(report.boundMs)} after the restart, perhaps behind a migration. ${CLI_NAME} space list shows how it opened.`,
      );
    }
  }
  const others = same < report.spaces.length;
  if (same > 0) {
    lines.push(
      same === 1
        ? `The ${others ? "other " : ""}space is as usable as before.`
        : `The ${others ? "other " : ""}${String(same)} spaces are as usable as before.`,
    );
  }
  if (worse > 0) lines.push(`To go back to ${update.from}: ${CLI_NAME} update --rollback`);
  return { lines, worse: others };
}

function summary(result: UpdateResult) {
  switch (result.outcome) {
    case "updated":
      return {
        outcome: result.outcome,
        from: result.from,
        to: result.to,
        ...(result.spaces === undefined
          ? {}
          : {
              spaces: result.spaces.spaces.map((space) => ({
                id: space.id,
                name: space.name,
                verdict: space.verdict,
                before: { state: space.before.state, reason: space.before.reason },
                after:
                  space.after === undefined
                    ? null
                    : {
                        state: space.after.state,
                        reason: space.after.reason,
                        message: space.after.message,
                      },
              })),
            }),
      };
    case "current":
      return { outcome: result.outcome, version: result.version };
    case "repaired":
      return { outcome: result.outcome, repair: result.repair.kind, current: result.current };
  }
}
