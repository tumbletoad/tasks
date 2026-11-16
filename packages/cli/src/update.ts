// `tasks update --from <archive> | --rollback | --repair [--yes] [--stop-runs]` (A2 3.12.6): the
// installed version replaces itself from a local release archive, goes back to the version before
// the last switch, or finishes an update that was cut off. The updater is the service's
// (`@tasks/service/version-update`), loaded only for this command; it verifies the archive with
// the release keys this build carries (UPDATE_KEYS) before anything of it runs.
//
// It runs only through the install's own command, which runs the version current names: an
// installed version vouches for its successor, never another one. An agent's shell may not run it,
// as it may not stop the service (A2 3.3.5, 3.12.6): the update restarts it. Before the
// restart it asks once in a terminal; `--yes` answers for a script, and without a terminal and
// without `--yes` nothing is changed (exit 2). The restart ends background runs: the update waits
// for them, then asks whether to stop them; `--stop-runs` answers for a script, and without a
// terminal and without it the update is given up with nothing changed (exit 2).
import { resolve } from "node:path";
import { PRODUCT_NAME } from "@tasks/brand";
import { hostFacts } from "@tasks/service/paths";
import type { UpdateResult } from "@tasks/service/version-update";
import type { Globals } from "./args.ts";
import { readServiceRecord, stateDir } from "./connect.ts";
import type { Io } from "./io.ts";
import { migrationLines } from "./migrations.ts";
import { printUsage } from "./output.ts";

export const UPDATE_USAGE =
  "tasks update --from <archive> [--yes] [--stop-runs], tasks update --rollback [--yes] [--stop-runs] or tasks update --repair";

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
      "tasks update runs in an installed version, through the install's own command. From source there is nothing to update.",
    );
  }
  const install = await import("@tasks/service/install");
  const update = await import("@tasks/service/version-update");
  const { UPDATE_KEYS } = await import("@tasks/service/release-keys");
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
  if (parsed.verb !== "repair" && !parsed.yes && (await control.running()) !== undefined) {
    if (ask === undefined) {
      return fail(
        "The update restarts the service. Run it again with --yes to go ahead without a question.",
        2,
      );
    }
    const yes = await ask(
      "The update restarts the service. Sessions keep running and reconnect; background runs are waited for first. Restart now? [y/N] ",
    );
    if (!yes) return fail("Nothing was changed.", 2);
  }
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
  // A restarted service opens the spaces again and migrates those at an older schema: what it did,
  // and the backup from just before, so a person who misses something knows where to go back to.
  if (globals.json) {
    io.stdout(`${JSON.stringify({ ok: true, ...summary(result) })}\n`);
    return 0;
  }
  const migrations =
    result.outcome === "updated" && readServiceRecord(stateDir(io)) !== undefined
      ? await migrationLines(io, {}, began)
      : [];
  switch (result.outcome) {
    case "updated":
      io.stdout(`${PRODUCT_NAME} ${result.to} is current (was ${result.from}).\n`);
      for (const line of migrations) io.stdout(`${line}\n`);
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
  return 0;
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
