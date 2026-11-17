// What the service answers for `tasks doctor`'s launch rows and sessions row (A3 3.14; A4 3.4.1,
// 3.7, 3.8; A7 3.11 M4.05b): `doctor/launch` asks the very scope probe a terminal launch uses, once
// per start, and the environment's own check; `t3/status` says when the token runs out and whether
// the pairing renews it; `doctor/sessions` counts open and shared connections and dropped records.
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
} from "@tasks/launch";
import { sessionFacts } from "../src/binding/index.ts";
import type { Logger } from "../src/hub/log.ts";
import { t3Host, t3Verbs } from "../src/hub/t3.ts";
import { LaunchService } from "../src/launch/service.ts";
import { Slot } from "../src/ops/index.ts";

let base = "";

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "tasks-doctor-facts-"));
});

afterAll(() => {
  if (base !== "") rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const log = { log: () => undefined } as unknown as Logger;

/** A fake environment whose check answers `checked`, and records each call's `take`. */
function environment(checked?: EnvironmentCheck): EnvironmentSource & { takes: boolean[] } {
  const source = {
    takes: [] as boolean[],
    prepare: () => Promise.resolve(),
    base: () => Promise.resolve({ kind: "service" as const, env: {} }),
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
    shimCommand: ["/opt/tasks/bin/tasks"],
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
    expect(await scoped.service.doctor(false)).toEqual({
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
      await launches("linux", 0, environment({ kind: "snapshot" })).service.doctor(false),
    ).toMatchObject({
      environment: { kind: "snapshot", outcome: null, attempted_at: null, taken_at: null },
    });

    const unscoped = launches("linux", 1, environment());
    expect(await unscoped.service.doctor(false)).toEqual({
      scopes: false,
      environment: null,
      terminal: GNOME_INSTALLED,
    });

    // Windows: no scopes, the registry's answer, and the person's Console Host over Windows
    // Terminal.
    const windows = launches("win32", 0, environment({ kind: "registry", read: false }));
    expect(await windows.service.doctor(false)).toEqual({
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
        shimCommand: ["C:\\tasks\\tasks.exe"],
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
    expect((await decided.made.doctor(false))["terminal"]).toMatchObject({
      app: "wt",
      source: "configured",
      unread: null,
    });
    expect(decided.reads.count).toBe(0);
    const auto = service(DEFAULT_TERMINAL);
    expect((await auto.made.doctor(false))["terminal"]).toMatchObject({
      app: "console",
      source: "installed",
      unread: "windows",
    });
    expect(auto.reads.count).toBe(1);
  });

  test("t3/status: the token's expiry and whether the pairing renews it, also while T3 is not running", async () => {
    const files = new MemoryT3Files();
    const status = () =>
      t3Verbs(t3Host({ log, home: undefined, files, platform: "linux", env: {}, instances: [] }))[
        "t3/status"
      ]?.({}, "cli-script");
    expect(await status()).toMatchObject({ state: "not_paired" });
    expect(await status()).not.toHaveProperty("renews");
    const expiresAt = Date.UTC(2026, 10, 18);
    const pairing = {
      grant: newGrantId(),
      pairedAt: Date.UTC(2026, 10, 1),
      reconnect: false,
      clientId: "fixture-client",
      accessToken: "fixture-access",
      expiresAt,
    };
    writePairing(files, pairing);
    expect(await status()).toMatchObject({
      state: "not_running",
      expires_at: "2026-11-18T00:00:00.000Z",
      renews: false,
    });
    writePairing(files, { ...pairing, refreshToken: "fixture-refresh" });
    expect(await status()).toMatchObject({ renews: true });
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
  test("doctor/sessions: open bridge connections, the shared ones by instance, the dropped records", () => {
    const slot = (instance: string, shared: boolean, kind: "bridge" | "mapped" = "bridge") => {
      const made = new Slot({ kind, instance, origin: kind === "bridge" ? "mcp" : "cli" });
      made.shared = shared;
      return made;
    };
    const open = [
      slot("codex", true),
      slot("codex", true),
      slot("claude", false),
      slot("manual", true),
      // A CLI call mapped to a session is no connection of an agent app.
      slot("codex", true, "mapped"),
    ];
    expect(sessionFacts({ open: () => open, dropped: 1 })).toEqual({
      open: 4,
      shared: [
        { instance: "codex", count: 2 },
        { instance: "manual", count: 1 },
      ],
      dropped: 1,
    });
    expect(sessionFacts({ open: () => [], dropped: 0 })).toEqual({
      open: 0,
      shared: [],
      dropped: 0,
    });
  });
});
