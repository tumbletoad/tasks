// `ttasks install --finish [--created <path>]...` (A2 3.12.4 step 4 on Linux, step 5 on Windows):
// the install scripts' hand-over to the version they have verified and renamed into
// `<root>/versions/<v>/`, run through that version's own version-local launcher. Authenticity was
// settled by the script before anything from the archive ran (review SL-13); this is the
// functional half:
//   1. the install it belongs to is checked: a separate install whose root the launcher named, a
//      umask that leaves the person's own bits, and a state folder no other user can change,
//   2. the self-test: doctor's integrity and runtime rows and the candidate's checks (A2 3.12.6),
//      printed as doctor prints them. Any failure stops here, and current stays as it was. It
//      checks the version, not whether bin holds both stable launchers yet: an install cut off
//      between them is finished by the next step, never refused by this one,
//   3. only then the switch (service's finishInstall): update.lock, current, the stable command,
//      install.json with what the installer created,
//   4. the stable command, and the offer of `ttasks service install` (A2 3.12.4), which this
//      never runs itself,
//   5. when this install's service runs another version, the last lines say so and name the
//      restart. A person at a terminal is asked once whether to restart it now: a restart ends
//      background runs, so it never happens unasked.
// It loads the service's install code, and with it storage, only for this command.
import { existsSync, readdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { CLI_NAME, EARLIER_DATA_FOLDER, PRODUCT_NAME } from "@ttasks/brand";
import { shellLine } from "@ttasks/launch";
import { homeFolder, hostFacts, type HostFacts, type Layout } from "@ttasks/service/paths";
import type { Globals } from "./args.ts";
import { candidateRows, versionChecks, type Check } from "./doctor.ts";
import type { Io } from "./io.ts";
import { printUsage } from "./output.ts";

export const INSTALL_USAGE = `${CLI_NAME} install --finish [--created <path>]...: the install scripts run it, through the new version's own launcher.`;

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

/**
 * The line that names the data folder of a build from before the rename, so its spaces do not look
 * lost. Only the install that makes this version's data folder shows it: once, and never to a
 * person who already uses this version.
 */
export function earlierDataNotice(facts: HostFacts, madeData: boolean): string | undefined {
  if (!madeData) return undefined;
  let home: string;
  try {
    home = homeFolder(facts);
  } catch {
    return undefined;
  }
  const folder = join(home, EARLIER_DATA_FOLDER);
  if (!existsSync(folder)) return undefined;
  return `${folder} holds the spaces and settings of a build from before the product was called ${PRODUCT_NAME}. This version does not use that folder and leaves it untouched.`;
}

/**
 * Whether this install makes the data folder. A separate install keeps its data in its root, which
 * the install script made in this run when it names "." among what it created.
 */
export function makesDataFolder(
  layout: Pick<Layout, "data" | "home">,
  created: readonly string[],
): boolean {
  return layout.home === undefined ? !existsSync(layout.data) : created.includes(".");
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
      `${CLI_NAME} install --finish runs in a version folder, through its own launcher. From source there is nothing to install.`,
    );
  }
  const install = await import("@ttasks/service/version-install");
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
  const madeData = makesDataFolder(target.layout, parsed.created);

  const checks: Check[] = [
    ...(await versionChecks(io, versionFolder, undefined, { launchers: false })),
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

  // A service of this install that answers now is seen working on its version: a later switch
  // keeps that version as the way back.
  const service = await installedService(io);
  const before = await service?.running();
  let finished: Awaited<ReturnType<typeof install.finishInstall>>;
  try {
    finished = await install.finishInstall({
      versionFolder,
      facts,
      created: parsed.created,
      stateCreated: !stateExisted,
      ...(typeof before === "string" ? { seen: before } : {}),
    });
  } catch (error) {
    if (error instanceof install.InstallError) {
      if (globals.json) io.stdout(`${JSON.stringify({ ok: false, checks })}\n`);
      io.stderr(`${error.message}\n`);
      return error.exitCode;
    }
    throw error;
  }
  const running = await service?.running();
  const pending = running !== undefined && running !== finished.version;
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
        ...(pending ? { service: { version: running, restart_needed: true } } : {}),
      })}\n`,
    );
    return 0;
  }
  io.stdout(
    [
      `Installed ${PRODUCT_NAME} ${finished.version} (${finished.build}) in ${finished.root}, install ID ${finished.installId}.`,
      `Its command: ${finished.command}`,
      `To have its service start by itself: ${finished.command} service install`,
      `Its data is in ${target.layout.data}. Backups of its spaces go to ${target.layout.backups}, outside it.`,
      "",
    ].join("\n"),
  );
  const earlier = earlierDataNotice(facts, madeData);
  if (earlier !== undefined) io.stdout(`${earlier}\n`);
  if (pending && service !== undefined) {
    await offerRestart(
      io,
      { version: finished.version, command: finished.command },
      running,
      service,
    );
  }
  return 0;
}

/** This install's service as the end of an install sees it (the service install's context). */
export interface InstalledService {
  /**
   * The version the running service answers with; null for one that runs but speaks another
   * protocol, so its version is not known; undefined when none runs.
   */
  readonly running: () => Promise<string | null | undefined>;
  /** An agent's shell may not restart the service: it is not asked. */
  readonly agentShell: boolean;
  /** `ttasks service restart`, printing what it prints; its exit code. */
  readonly restart: () => Promise<number>;
}

async function installedService(io: Io): Promise<InstalledService | undefined> {
  const install = await import("@ttasks/service/install");
  let ctx: ReturnType<typeof install.defaultServiceContext>;
  try {
    ctx = install.defaultServiceContext({ env: io.env });
  } catch {
    return undefined;
  }
  return {
    agentShell: ctx.agentShell,
    running: async () => {
      const probe = await ctx.probe();
      if (probe.answers) return probe.status.version;
      return probe.reason === "service_too_old" || probe.reason === "restart_session"
        ? null
        : undefined;
    },
    restart: () =>
      install.serviceEntry(
        "restart",
        {},
        {
          out: (text) => {
            io.stdout(text);
          },
          err: (text) => {
            io.stderr(text);
          },
          ask: undefined,
        },
        () => ctx,
      ),
  };
}

/**
 * The end of an install whose service still runs another version: at a terminal, one question
 * whether to restart it now; otherwise, or when the restart did not happen, the last lines say
 * what runs now and name the one command that brings up the installed version.
 */
export async function offerRestart(
  io: Io,
  installed: { readonly version: string; readonly command: string },
  running: string | null,
  service: InstalledService,
): Promise<void> {
  let now: string | null | undefined = running;
  if (io.ask !== undefined && !service.agentShell) {
    const yes = await io.ask(
      `\n${PRODUCT_NAME}'s service still runs ${running ?? "another version"}. Restart it on ${installed.version} now? Background runs end and keep their answers so far. Agent sessions keep running and reconnect. [y/N] `,
    );
    if (yes) {
      if ((await service.restart()) === 0) return;
      // The restart said why it failed; it may have stopped the old service first.
      now = await service.running();
      if (now === installed.version) return;
    }
  }
  const verb = now === undefined ? "start" : "restart";
  const line =
    shellLine(io.platform, [installed.command, "service", verb]) ??
    `${installed.command} service ${verb}`;
  const state =
    now === undefined
      ? `${PRODUCT_NAME}'s service is not running.`
      : `${PRODUCT_NAME}'s service still runs ${now ?? "another version"}.`;
  io.stdout(`\n${state} To run ${installed.version}, ${verb} it:\n  ${line}\n`);
}
