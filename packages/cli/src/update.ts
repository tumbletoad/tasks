// `tasks update --from <archive> | --rollback | --repair [--yes]` (A2 3.12.6, A7 3.13 M6.12): the
// installed version replaces itself from a local release archive, goes back to the version before
// the last switch, or finishes an update that was cut off. The updater is the service's
// (`@tasks/service/version-update`), loaded only for this command; it verifies the archive with
// the release keys this build carries (UPDATE_KEYS) before anything of it runs.
//
// It runs only through the install's own command, which runs the version current names: an
// installed version vouches for its successor, never another one. An agent's shell may not run it,
// as it may not stop the service (A2 3.3.5, 3.12.6): the update restarts it. Before the
// restart it asks once in a terminal; `--yes` answers for a script, and without a terminal and
// without `--yes` nothing is changed (exit 2).
import { resolve } from "node:path";
import { PRODUCT_NAME } from "@tasks/brand";
import { hostFacts } from "@tasks/service/paths";
import type { UpdateResult } from "@tasks/service/version-update";
import type { Globals } from "./args.ts";
import type { Io } from "./io.ts";
import { printUsage } from "./output.ts";

export const UPDATE_USAGE =
  "tasks update --from <archive> [--yes], tasks update --rollback [--yes] or tasks update --repair";

type Parsed =
  | { readonly verb: "from"; readonly archive: string; readonly yes: boolean }
  | { readonly verb: "rollback" | "repair"; readonly yes: boolean };

function parse(args: readonly string[]): Parsed | undefined {
  let verb: Parsed["verb"] | undefined;
  let archive: string | undefined;
  let yes = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--yes" && !yes) yes = true;
    else if (arg === "--from" && verb === undefined && args[i + 1] !== undefined) {
      verb = "from";
      archive = args[i + 1];
      i += 1;
    } else if ((arg === "--rollback" || arg === "--repair") && verb === undefined) {
      verb = arg === "--rollback" ? "rollback" : "repair";
    } else return undefined;
  }
  if (verb === undefined) return undefined;
  return verb === "from" ? { verb, archive: archive ?? "", yes } : { verb, yes };
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
  if (parsed.verb !== "repair" && !parsed.yes && (await control.running()) !== undefined) {
    const ask = io.tty.stdin && io.tty.stdout ? install.processIO().ask : undefined;
    if (ask === undefined) {
      return fail(
        "The update restarts the service. Run it again with --yes to go ahead without a question.",
        2,
      );
    }
    const yes = await ask(
      "The update restarts the service. Sessions and runs keep running and reconnect. Restart now? [y/N] ",
    );
    if (!yes) return fail("Nothing was changed.", 2);
  }
  const options = {
    facts: hostFacts(io.env, io.platform),
    keys: UPDATE_KEYS,
    self: versionFolder,
    control,
    selfTest: update.launcherSelfTest(io.env, io.platform),
    say: (line: string) => {
      if (!globals.json) io.stdout(`${line}\n`);
    },
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
  if (globals.json) {
    io.stdout(`${JSON.stringify({ ok: true, ...summary(result) })}\n`);
    return 0;
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
