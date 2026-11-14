// `tasks install --finish [--created <path>]...` (A2 3.12.4 step 4 on Linux, step 5 on Windows):
// the install scripts' hand-over to the version they have verified and renamed into
// `<root>/versions/<v>/`, run through that version's own version-local launcher. Authenticity was
// settled by the script before anything from the archive ran (review SL-13); this is the
// functional half:
//   1. the install it belongs to is checked: a separate install whose root the launcher named, a
//      umask that leaves the person's own bits, and a state folder no other user can change,
//   2. the self-test: doctor's integrity and runtime rows and the candidate's checks (A2 3.12.6),
//      printed as doctor prints them. Any failure stops here, and current stays as it was,
//   3. only then the switch (service's finishInstall): update.lock, current, the stable command,
//      install.json with what the installer created,
//   4. the stable command, and the offer of `tasks service install` (A2 3.12.4), which this
//      never runs itself.
// It loads the service's install code, and with it storage, only for this command.
import { existsSync, readdirSync, rmdirSync } from "node:fs";
import { PRODUCT_NAME } from "@tasks/brand";
import { hostFacts, type Layout } from "@tasks/service/paths";
import type { Globals } from "./args.ts";
import { candidateRows, versionChecks, type Check } from "./doctor.ts";
import type { Io } from "./io.ts";
import { printUsage } from "./output.ts";

export const INSTALL_USAGE =
  "tasks install --finish [--created <path>]...: the install scripts run it, through the new version's own launcher.";

function parse(args: readonly string[]): { created: string[] } | undefined {
  const created: string[] = [];
  let finish = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const value = args[i + 1];
    if (arg === "--finish" && !finish) finish = true;
    else if (arg === "--created" && value !== undefined) {
      created.push(value);
      i += 1;
    } else return undefined;
  }
  return finish ? { created } : undefined;
}

/** Removes the layout's `<state>/tmp` and `<state>` when this run made them and they are empty again. */
function removeIfMade(layout: Pick<Layout, "state" | "tmp">): void {
  for (const dir of [layout.tmp, layout.state]) {
    try {
      if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
    } catch {
      // Something else is in it now: it stays.
    }
  }
}

export async function installCommand(
  io: Io,
  globals: Globals,
  args: readonly string[],
  versionFolder: string | undefined,
): Promise<number> {
  const parsed = parse(args);
  if (parsed === undefined) return printUsage(io, globals.json, INSTALL_USAGE);
  if (versionFolder === undefined) {
    return printUsage(
      io,
      globals.json,
      "tasks install --finish runs in a version folder, through its own launcher. From source there is nothing to install.",
    );
  }
  const install = await import("@tasks/service/version-install");
  const facts = hostFacts(io.env, io.platform);
  let target: ReturnType<typeof install.installTarget>;
  try {
    target = install.installTarget(versionFolder, facts);
    // Before the self-test writes into `<state>/tmp`: the umask and the state folder
    // (A2 3.2.2 rule 5).
    install.refuseBeforeFinish(target, io.platform);
  } catch (error) {
    if (error instanceof install.InstallError) {
      io.stderr(`${error.message}\n`);
      return error.exitCode;
    }
    throw error;
  }
  const state = target.layout.state;
  const stateExisted = existsSync(state);

  const checks: Check[] = [
    ...(await versionChecks(io, versionFolder)),
    ...(await candidateRows(io, versionFolder, true, state)),
  ];
  const failed = checks.some((check) => check.status === "fail");
  if (!globals.json) {
    io.stdout(`Self-test of ${PRODUCT_NAME} ${target.version} (${target.manifest.build}):\n`);
    for (const check of checks) {
      io.stdout(`${check.status.padEnd(4)}  ${check.id}: ${check.detail}\n`);
    }
  }
  if (failed) {
    if (!stateExisted) removeIfMade(target.layout);
    if (globals.json) io.stdout(`${JSON.stringify({ ok: false, checks })}\n`);
    io.stderr("The new version failed its self-test, so current was not changed.\n");
    return 1;
  }

  let finished: Awaited<ReturnType<typeof install.finishInstall>>;
  try {
    finished = await install.finishInstall({
      versionFolder,
      facts,
      created: parsed.created,
      stateCreated: !stateExisted,
    });
  } catch (error) {
    if (error instanceof install.InstallError) {
      if (globals.json) io.stdout(`${JSON.stringify({ ok: false, checks })}\n`);
      io.stderr(`${error.message}\n`);
      return error.exitCode;
    }
    throw error;
  }
  if (globals.json) {
    io.stdout(
      `${JSON.stringify({
        ok: true,
        checks,
        install: {
          root: finished.root,
          version: finished.version,
          build: finished.build,
          install_id: finished.installId,
          command: finished.command,
        },
      })}\n`,
    );
    return 0;
  }
  io.stdout(
    [
      `Installed ${PRODUCT_NAME} ${finished.version} (${finished.build}) in ${finished.root}, install ID ${finished.installId}.`,
      `Its command: ${finished.command}`,
      `To have its service start by itself: ${finished.command} service install`,
      "",
    ].join("\n"),
  );
  return 0;
}
