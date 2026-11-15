// T3 Code's provider instances read as T3 writes them (A3 3.13.6): `driver`, `config.homePath` with
// `~` expanded, a home variable in `environment`, `enabled`, the default instances the file does not
// list, the legacy `providers` key, and entries passed over with why. The settings are fixture
// documents (no file is read), on a fixture home of each OS's path form, and a Codex shadow home is
// a scratch folder this test makes and removes. No real T3 folder or agent home is read.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  codexSharedHome,
  t3ProviderInstances,
  type HostsInput,
  type T3ProviderInstance,
} from "../src/setup/index.ts";
import { t3Homes, t3InstanceId } from "../src/setup/hosts.ts";

/** A secret another environment entry holds: it must never leave the settings. */
const SENTINEL = "sentinel-secret-7d41";

const linux = (env: Record<string, string> = {}): HostsInput => ({
  platform: "linux",
  userHome: "/home/mira",
  env,
});
const windows = (env: Record<string, string> = {}): HostsInput => ({
  platform: "win32",
  userHome: "C:\\Users\\mira",
  env,
});

const byId = (instances: readonly T3ProviderInstance[], id: string): T3ProviderInstance => {
  const found = instances.find((i) => i.id === id);
  if (found === undefined) throw new Error(`no instance ${id}`);
  return found;
};

let base: string;
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "tasks-t3-settings-"));
});
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("[A3.3.13.6.t3-settings] T3's provider instances as T3 writes them", () => {
  test("an added instance, a renamed default and the unlisted default", () => {
    const read = t3ProviderInstances(linux(), {
      providerInstances: {
        // As T3 writes an added Claude instance, and a default that was only renamed.
        claude_personal: {
          driver: "claudeAgent",
          displayName: "Claude Personal",
          enabled: true,
          config: { homePath: "~/.claude_personal" },
        },
        claudeAgent: { driver: "claudeAgent", displayName: "Claude Work", enabled: true },
      },
    });
    expect(read.skipped).toEqual([]);
    expect(read.instances).toEqual([
      {
        id: "claude_personal",
        driver: "claudeAgent",
        app: "claude-code",
        displayName: "Claude Personal",
        enabled: true,
        listed: true,
        home: "/home/mira/.claude_personal",
        isDefault: false,
      },
      {
        id: "claudeAgent",
        driver: "claudeAgent",
        app: "claude-code",
        displayName: "Claude Work",
        enabled: true,
        listed: true,
        home: "/home/mira/.claude",
        isDefault: true,
      },
      // T3's default Codex instance, which the file does not list.
      {
        id: "codex",
        driver: "codex",
        app: "codex",
        enabled: true,
        listed: false,
        home: "/home/mira/.codex",
        isDefault: true,
      },
    ]);
    // No settings at all: T3's two default instances on the default homes.
    expect(t3ProviderInstances(linux(), undefined, "missing")).toMatchObject({
      file: "missing",
      instances: [
        { id: "codex", home: "/home/mira/.codex", isDefault: true },
        { id: "claudeAgent", home: "/home/mira/.claude", isDefault: true },
      ],
    });
  });

  test("the home: homePath, then the instance's environment, then the inherited variable", () => {
    const doc = {
      providerInstances: {
        codex: {
          driver: "codex",
          environment: [
            { name: "OPENAI_API_KEY", value: SENTINEL, sensitive: true },
            { name: "CODEX_HOME", value: "~/.codex_personal", sensitive: false },
          ],
        },
        codex_work: {
          driver: "codex",
          // homePath wins over the environment.
          environment: [{ name: "CODEX_HOME", value: "/srv/elsewhere", sensitive: false }],
          config: { homePath: "/srv/codex-work" },
        },
        claude_vault: {
          driver: "claudeAgent",
          // A home kept in T3's secret store cannot be known: passed over, never guessed.
          environment: [{ name: "CLAUDE_CONFIG_DIR", value: "", sensitive: true, secret: "ref" }],
        },
      },
    };
    const read = t3ProviderInstances(linux({ CLAUDE_CONFIG_DIR: "/srv/claude-shell" }), doc);
    expect(byId(read.instances, "codex")).toMatchObject({
      home: "/home/mira/.codex_personal",
      isDefault: false,
    });
    expect(byId(read.instances, "codex_work").home).toBe("/srv/codex-work");
    // The default Claude instance takes the variable T3 inherited.
    expect(byId(read.instances, "claudeAgent")).toMatchObject({
      home: "/srv/claude-shell",
      isDefault: false,
    });
    expect(read.skipped).toEqual([{ id: "claude_vault", reason: "secret_home" }]);
    // No other environment value is read or kept.
    expect(JSON.stringify(read)).not.toContain(SENTINEL);

    // Windows: the variable's name in any case, the last one wins, `~\` expanded.
    const win = t3ProviderInstances(windows(), {
      providerInstances: {
        codex: {
          driver: "codex",
          environment: [
            { name: "CODEX_HOME", value: "D:\\first", sensitive: false },
            { name: "codex_home", value: "~\\.codex_personal", sensitive: false },
          ],
        },
      },
    });
    expect(byId(win.instances, "codex").home).toBe("C:\\Users\\mira\\.codex_personal");
    // Linux reads names exactly: `codex_home` is another variable.
    const exact = t3ProviderInstances(linux(), {
      providerInstances: {
        codex: {
          driver: "codex",
          environment: [{ name: "codex_home", value: "/srv/x", sensitive: false }],
        },
      },
    });
    expect(byId(exact.instances, "codex")).toMatchObject({ home: "/home/mira/.codex" });

    // A Codex instance T3 manages ignores the variables; its shadow home is named.
    const managed = t3ProviderInstances(linux({ CODEX_HOME: "/srv/shell" }), {
      providerInstances: {
        codex: { driver: "codex", config: { setupMode: "managed" } },
        codex_personal: {
          driver: "codex",
          config: { homePath: "~/.codex", shadowHomePath: "~/.codex-t3/personal" },
        },
      },
    });
    expect(byId(managed.instances, "codex").home).toBe("/home/mira/.codex");
    expect(byId(managed.instances, "codex_personal")).toMatchObject({
      home: "/home/mira/.codex",
      shadow: "/home/mira/.codex-t3/personal",
    });
  });

  test("enabled: false, the legacy providers key, other drivers and entries of another form", () => {
    const read = t3ProviderInstances(linux(), {
      providerInstances: {
        codex: { driver: "codex", enabled: false },
        claudeAgent: { driver: "claudeAgent", config: { enabled: false, homePath: "~/.claude" } },
        claude_on: { driver: "claudeAgent", config: { homePath: "/srv/claude-on" } },
        cursor: { driver: "cursor", enabled: true },
        future: { driver: "futureAgent" },
        nodriver: { config: {} },
        badconfig: { driver: "codex", config: "~/.codex" },
        badhome: { driver: "codex", config: { homePath: 7 } },
        relative: { driver: "claudeAgent", config: { homePath: "claude-somewhere" } },
        "has space": { driver: "codex" },
      },
      // Ignored for `codex`, which providerInstances lists; migrated for another driver only.
      providers: { codex: { homePath: "/srv/legacy" } },
    });
    expect(read.instances.map((i) => [i.id, i.enabled])).toEqual([
      ["codex", false],
      ["claudeAgent", false],
      ["claude_on", true],
    ]);
    // A disabled instance runs nothing: it is no T3 home.
    expect(t3Homes(read)).toEqual([
      { app: "claude-code", provider: "claude_on", home: "/srv/claude-on", isDefault: false },
    ]);
    expect(read.skipped).toEqual([
      { id: "future", reason: "unknown_driver" },
      { id: "nodriver", reason: "invalid_entry" },
      { id: "badconfig", reason: "invalid_entry" },
      { id: "badhome", reason: "invalid_entry" },
      { id: "relative", reason: "invalid_entry" },
      { id: "has space", reason: "invalid_entry" },
    ]);

    // The legacy key alone, as T3 migrates it: `providers.codex` is the codex instance.
    const legacy = t3ProviderInstances(linux(), {
      providers: { codex: { enabled: true, homePath: "~/.codex_old" }, claudeAgent: "x" },
    });
    expect(byId(legacy.instances, "codex")).toMatchObject({
      listed: true,
      home: "/home/mira/.codex_old",
    });
    expect(byId(legacy.instances, "claudeAgent")).toMatchObject({ listed: false });
    // providerInstances of another type: only the defaults, and the entry is named.
    expect(t3ProviderInstances(linux(), { providerInstances: [] }).skipped).toEqual([
      { id: "providerInstances", reason: "invalid_entry" },
    ]);
  });

  test("an instance ID for a home only T3 uses comes from its folder, `_` as well as `-`", () => {
    const id = (home: string, provider = "x") =>
      t3InstanceId({ app: "claude-code", provider, home, isDefault: false }, "linux");
    expect(id("/home/mira/.claude_personal")).toBe("claude-personal");
    expect(id("/home/mira/.claude-work")).toBe("claude-work");
    expect(id("/home/mira/.claude")).toBe("claude");
    expect(id("/srv/agents/home", "claude-lab")).toBe("claude-lab");
    expect(id("/srv/agents/home", "claude_personal")).toBe("claude-personal");
    expect(id("/srv/agents/home", "Claude Lab")).toBe("claude-t3");
  });

  test("a Codex shadow home is recognised by its config.toml linking into another home", () => {
    const shared = join(base, "shared");
    const own = join(base, "own");
    mkdirSync(shared);
    mkdirSync(own);
    writeFileSync(join(shared, "config.toml"), "");
    writeFileSync(join(own, "config.toml"), "");
    expect(codexSharedHome(process.platform, own)).toBeUndefined();
    expect(codexSharedHome(process.platform, join(base, "none"))).toBeUndefined();
    // Windows makes a link to a file only with an elevated right or developer mode, which T3's
    // shadow homes need there too; the link cases run where a person can make one.
    if (process.platform === "win32") return;
    const shadow = join(base, "shadow");
    mkdirSync(shadow);
    symlinkSync(join(shared, "config.toml"), join(shadow, "config.toml"));
    expect(codexSharedHome(process.platform, shadow)).toBe(shared);
    // A link to another file name, or to nothing, is not a shadow.
    const odd = join(base, "odd");
    mkdirSync(odd);
    writeFileSync(join(shared, "other.toml"), "");
    symlinkSync(join(shared, "other.toml"), join(odd, "config.toml"));
    expect(codexSharedHome(process.platform, odd)).toBeUndefined();
    const dangling = join(base, "dangling");
    mkdirSync(dangling);
    symlinkSync(join(base, "gone", "config.toml"), join(dangling, "config.toml"));
    expect(codexSharedHome(process.platform, dangling)).toBeUndefined();
  });
});
