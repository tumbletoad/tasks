// What the service answers for `ttasks doctor`'s launch rows and sessions row (A3 3.14; A4 3.4.1,
// 3.7, 3.8; A7 3.11 M4.05b): `doctor/launch` asks the very scope probe a terminal launch uses, once
// per start, and the environment's own check; `t3/status` says when the token runs out;
// `doctor/sessions` counts the open connections and the sessions among them.
// Fakes only: a fake spawner for the probe, a fake environment, an in-memory T3 state, fake slots.
// Nothing real is started, and the temporary folder is removed afterwards.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  DEFAULT_TERMINAL,
  MemoryT3Files,
  newGrantId,
  writePairing,
  type EnvironmentCheck,
  type EnvironmentSource,
  type SpawnRequest,
  type Spawner,
  type TerminalSettings,
} from "@ttasks/launch";
import { Bridges, sessionFacts } from "../src/binding/index.ts";
import type { Logger } from "../src/hub/log.ts";
import { t3Host, t3Verbs } from "../src/hub/t3.ts";
import { LaunchService } from "../src/launch/service.ts";

let base = "";

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "ttasks-doctor-facts-"));
});

afterAll(() => {
  if (base !== "") rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const log = { log: () => undefined } as unknown as Logger;

/** A fake environment whose check answers `checked`, and records each call's `take` and each base read. */
function environment(
  checked?: EnvironmentCheck,
): EnvironmentSource & { takes: boolean[]; bases: number } {
  const source = {
    takes: [] as boolean[],
    bases: 0,
    prepare: () => Promise.resolve(),
    base: () => {
      source.bases += 1;
      return Promise.resolve({ kind: "user" as const, env: { PATH: "/person/bin" } });
    },
    inFolder: () => Promise.resolve(undefined),
    session: () => Promise.resolve({ XDG_RUNTIME_DIR: "/run/user/1000" }),
  };
  return checked === undefined
    ? source
    : Object.assign(source, {
        check: (take: boolean) => {
          source.takes.push(take);
          return Promise.resolve(checked);
        },
      });
}

/** A launch service on `platform` whose scope probe exits with `code`, recording what it ran. */
function launches(
  platform: NodeJS.Platform,
  code: number,
  env: EnvironmentSource,
): { service: LaunchService; probes: SpawnRequest[] } {
  const probes: SpawnRequest[] = [];
  const spawn: Spawner = (request) => {
    probes.push(request);
    return Promise.resolve({
      pid: 1,
      exited: Promise.resolve({ code, signal: null }),
      stop: () => undefined,
    });
  };
  const service = new LaunchService({
    machine: "m_7c0hq2m4w9d8k1r6t3v5x0b2nf",
    root: join(base, `launch-${platform}-${String(code)}`),
    stateDir: join(base, "state"),
    platform,
    env: { PATH: "/usr/bin:/bin", HOME: "/home/mira" },
    spaces: () => [],
    log,
    environment: env,
    shimCommand: ["/opt/ttasks/bin/ttasks"],
    terminals: {
      spawn,
      systemdRun: "/usr/bin/systemd-run",
      trueProgram: "/usr/bin/true",
      // A fake machine: GNOME Terminal on Linux; on Windows, Windows Terminal installed and the
      // person's default set to Windows Console Host. Nothing of this machine is read.
      host: (_session, path) => ({
        platform,
        path: platform === "win32" ? path : ["/usr/bin"],
        terminalVar: undefined,
        home: "/home/mira",
        windowsApps: "C:\\Local\\Microsoft\\WindowsApps",
        powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        delegation: { console: CONHOST, terminal: CONHOST },
        executable: (p) =>
          p === "/usr/bin/gnome-terminal" || p === "C:\\Local\\Microsoft\\WindowsApps\\wt.exe",
        readText: () => undefined,
        realpath: (p) => p,
      }),
    },
  });
  return { service, probes };
}

const CONHOST = "{B23D10C0-E52E-411E-9D5B-C09FDF709C7D}";
const GNOME_INSTALLED = {
  app: "gnome-terminal",
  source: "installed",
  found: true,
  unsupported: null,
  unread: null,
};

describe("[A3.3.14.doctor.launch] the service's answers for doctor's launch rows", () => {
  test("doctor/launch: the launch's own scope probe, once per start, and the environment's check", async () => {
    const checked: EnvironmentCheck = {
      kind: "snapshot",
      outcome: "timeout",
      attemptedAt: Date.UTC(2026, 10, 14),
      takenAt: Date.UTC(2026, 10, 13),
    };
    const env = environment(checked);
    const scoped = launches("linux", 0, env);
    const report = await scoped.service.doctor(false);
    expect(report.facts).toEqual({
      scopes: true,
      environment: {
        kind: "snapshot",
        outcome: "timeout",
        attempted_at: "2026-11-14T00:00:00.000Z",
        taken_at: "2026-11-13T00:00:00.000Z",
      },
      // The terminal a launch now opens first, and why.
      terminal: GNOME_INSTALLED,
    });
    // The report's other rows get the person's environment as a launch now would start from it.
    expect(report.env).toEqual({ PATH: "/person/bin" });
    // The probe a launch runs: systemd-run's scope around `true`, with the terminal's environment.
    expect(scoped.probes).toHaveLength(1);
    expect(scoped.probes[0]?.argv[0]).toBe("/usr/bin/systemd-run");
    expect(scoped.probes[0]?.argv).toContain("/usr/bin/true");
    expect(scoped.probes[0]?.env["XDG_RUNTIME_DIR"]).toBe("/run/user/1000");
    // Asked again (`--live`: take one now), the start's answer stands: the probe is not run twice.
    await scoped.service.doctor(true);
    expect(scoped.probes).toHaveLength(1);
    expect(env.takes).toEqual([false, true]);
    // Nothing attempted and nothing stored: nulls, never a guess.
    expect(
      (await launches("linux", 0, environment({ kind: "snapshot" })).service.doctor(false)).facts,
    ).toMatchObject({
      environment: { kind: "snapshot", outcome: null, attempted_at: null, taken_at: null },
    });

    const unscoped = launches("linux", 1, environment());
    expect((await unscoped.service.doctor(false)).facts).toEqual({
      scopes: false,
      environment: null,
      terminal: GNOME_INSTALLED,
    });

    // Windows: no scopes, the registry's answer, and the person's Console Host over Windows
    // Terminal. The registry is read once: the other rows get what the check read.
    const unread = { kind: "service" as const, env: { Path: "C:\\service" } };
    const registry = environment({ kind: "registry", read: false, base: unread });
    const windows = launches("win32", 0, registry);
    const windowsReport = await windows.service.doctor(false);
    expect(windowsReport.env).toEqual(unread.env);
    expect(registry.bases).toBe(0);
    expect(windowsReport.facts).toEqual({
      scopes: null,
      environment: { kind: "registry", read: false },
      terminal: {
        app: "console",
        source: "windows",
        found: true,
        unsupported: null,
        unread: null,
      },
    });
    expect(windows.probes).toEqual([]);
  });

  test("doctor/launch: Windows' setting is read only when [terminal] leaves the choice to it, and an unread one is said", async () => {
    const service = (terminalSettings: TerminalSettings) => {
      const reads = { count: 0 };
      const made = new LaunchService({
        machine: "m_7c0hq2m4w9d8k1r6t3v5x0b2nf",
        root: join(base, "launch-registry"),
        stateDir: join(base, "state"),
        platform: "win32",
        env: {},
        spaces: () => [],
        log,
        environment: environment(),
        shimCommand: ["C:\\tasks\\ttasks.exe"],
        terminalSettings,
        terminals: {
          // reg.exe did not answer.
          delegation: () => {
            reads.count += 1;
            return Promise.resolve(undefined);
          },
        },
      });
      return { made, reads };
    };
    const decided = service({ ...DEFAULT_TERMINAL, app: "wt", fallbacks: ["console"] });
    expect((await decided.made.doctor(false)).facts["terminal"]).toMatchObject({
      app: "wt",
      source: "configured",
      unread: null,
    });
    expect(decided.reads.count).toBe(0);
    const auto = service(DEFAULT_TERMINAL);
    expect((await auto.made.doctor(false)).facts["terminal"]).toMatchObject({
      app: "console",
      source: "installed",
      unread: "windows",
    });
    expect(auto.reads.count).toBe(1);
  });

  test("t3/status: the token's expiry, also while T3 is not running", async () => {
    const files = new MemoryT3Files();
    const status = () =>
      t3Verbs(t3Host({ log, home: undefined, files, platform: "linux", instances: [] }))[
        "t3/status"
      ]?.({}, "cli-script");
    expect(await status()).toMatchObject({ state: "not_paired" });
    // A token that runs out in ten days.
    const expiresAt = Date.now() + 10 * 24 * 60 * 60_000;
    const pairing = {
      grant: newGrantId(),
      pairedAt: Date.now(),
      reconnect: false,
      clientId: "fixture-client",
      accessToken: "fixture-access",
      expiresAt,
    };
    writePairing(files, pairing);
    expect(await status()).toMatchObject({
      state: "not_running",
      expires_at: new Date(expiresAt).toISOString(),
    });
    // A pairing T3 no longer accepts says only that.
    writePairing(files, { ...pairing, reconnect: true });
    const reconnect = (await status()) as Record<string, unknown>;
    expect(reconnect["state"]).toBe("reconnect");
    expect(reconnect).not.toHaveProperty("expires_at");
    // No token in the answer.
    expect(JSON.stringify(await status())).not.toContain("fixture-");
  });
});

describe("[A3.3.14.doctor.sessions] the service's answer for doctor's sessions row", () => {
  test("doctor/sessions: the bridge connections open now, and how many are a launch's or a run's session", () => {
    const home = {
      launch: { of: "launch", app: "codex", home: undefined },
      run: { of: "run", run: "ru_00000000000000000000000001", instance: "fixture-runner" },
    } as const;
    const bridges = new Bridges({
      sessions: {
        // A fixture's value names the kind of session it is, or none.
        decide: (presented) => {
          const of = presented.env["TTASKS_TICKET"];
          if (of !== "launch" && of !== "run") return { kind: "none" };
          const session = {
            session: "se_00000000000000000000000001",
            space: "sp_00000000000000000000000001",
            task: "t_00000000000000000000000001",
            home: home[of],
          };
          return { kind: "session", by: "ticket", session };
        },
        standing: () => ({ kind: "failed" }),
        live: () => new Map(),
      },
      spaces: () => [],
      defaultSpace: () => undefined,
    });
    const connections = ["launch", "launch", "run", "none"].map((of) => ({
      context: { env: { TTASKS_TICKET: of } },
    }));
    for (const connection of connections) bridges.bind(connection);
    // A connection whose bind was answered counts once its MCP session starts, until it ends.
    expect(sessionFacts(bridges)).toEqual({ open: 0, sessions: { launch: 0, run: 0 } });
    for (const connection of connections) bridges.attach(connection);
    expect(sessionFacts(bridges)).toEqual({ open: 4, sessions: { launch: 2, run: 1 } });
    bridges.closed(connections[0] ?? {});
    expect(sessionFacts(bridges)).toEqual({ open: 3, sessions: { launch: 1, run: 1 } });
    // A connection that never bound is none of them.
    expect(bridges.attach({ context: {} })).toBeUndefined();
    expect(sessionFacts(bridges)).toEqual({ open: 3, sessions: { launch: 1, run: 1 } });
  });
});
