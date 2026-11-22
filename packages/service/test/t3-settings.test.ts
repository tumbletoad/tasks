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
  t3SettingsOf,
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
  base = mkdtempSync(join(tmpdir(), "ttasks-t3-settings-"));
});
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("[A3.3.13.6.t3-settings] T3's provider instances as T3 writes them", () => {
  test("an added instance, a renamed default and the unlisted default", () => {
    const read = t3ProviderInstances(linux(), {
      providerInstances: {
        // As T3 writes an added Claude instance, and a default that was only renamed.
        claude_second: {
          driver: "claudeAgent",
          displayName: "Claude Second",
          enabled: true,
          config: { homePath: "~/.claude_second" },
        },
        claudeAgent: { driver: "claudeAgent", displayName: "Claude Work", enabled: true },
      },
    });
    expect(read.skipped).toEqual([]);
    expect(read.instances).toEqual([
      {
        id: "claude_second",
        driver: "claudeAgent",
        app: "claude-code",
        displayName: "Claude Second",
        listed: true,
        home: "/home/mira/.claude_second",
        isDefault: false,
      },
      {
        id: "claudeAgent",
        driver: "claudeAgent",
        app: "claude-code",
        displayName: "Claude Work",
        listed: true,
        home: "/home/mira/.claude",
        isDefault: true,
      },
      // T3's default Codex instance, which the file does not list.
      {
        id: "codex",
        driver: "codex",
        app: "codex",
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
            { name: "CODEX_HOME", value: "~/.codex_second", sensitive: false },
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
      home: "/home/mira/.codex_second",
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
            { name: "codex_home", value: "~\\.codex_second", sensitive: false },
          ],
        },
      },
    });
    expect(byId(win.instances, "codex").home).toBe("C:\\Users\\mira\\.codex_second");
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

    // An entry that sets the variable empty replaces the inherited one: T3 then runs the default
    // home, never the home the inherited variable names.
    const blank = t3ProviderInstances(
      linux({ CODEX_HOME: "/srv/inherited", CLAUDE_CONFIG_DIR: "/srv/inherited-claude" }),
      {
        providerInstances: {
          codex: { driver: "codex", environment: [{ name: "CODEX_HOME", value: "" }] },
          claudeAgent: {
            driver: "claudeAgent",
            environment: [
              { name: "CLAUDE_CONFIG_DIR", value: "/srv/first" },
              { name: "CLAUDE_CONFIG_DIR", value: "  " },
            ],
          },
        },
      },
    );
    expect(byId(blank.instances, "codex")).toMatchObject({
      home: "/home/mira/.codex",
      isDefault: true,
    });
    expect(byId(blank.instances, "claudeAgent")).toMatchObject({
      home: "/home/mira/.claude",
      isDefault: true,
    });
    // An inherited home T3 would resolve against its own working folder cannot be known: skipped,
    // never taken for the default. T3 expands `~` in an inherited CODEX_HOME, not in an inherited
    // CLAUDE_CONFIG_DIR.
    const inherited = t3ProviderInstances(
      linux({ CODEX_HOME: "relative/codex", CLAUDE_CONFIG_DIR: "~/.claude_second" }),
      undefined,
      "missing",
    );
    expect(inherited.instances).toEqual([]);
    expect(inherited.skipped).toEqual([
      { id: "codex", reason: "invalid_entry" },
      { id: "claudeAgent", reason: "invalid_entry" },
    ]);
    expect(
      byId(
        t3ProviderInstances(linux({ CODEX_HOME: "~/.codex_work" }), undefined).instances,
        "codex",
      ).home,
    ).toBe("/home/mira/.codex_work");
    // Codex keeps a path as written, Claude trims it.
    const spaced = t3ProviderInstances(linux(), {
      providerInstances: {
        codex: { driver: "codex", config: { homePath: "/srv/codex " } },
        claudeAgent: { driver: "claudeAgent", config: { homePath: " /srv/claude " } },
      },
    });
    expect(byId(spaced.instances, "codex").home).toBe("/srv/codex ");
    expect(byId(spaced.instances, "claudeAgent").home).toBe("/srv/claude");

    // A Codex instance T3 manages ignores the variables; its shadow home is named.
    const managed = t3ProviderInstances(linux({ CODEX_HOME: "/srv/shell" }), {
      providerInstances: {
        codex: { driver: "codex", config: { setupMode: "managed" } },
        codex_second: {
          driver: "codex",
          config: { homePath: "~/.codex", shadowHomePath: "~/.codex-t3/second" },
        },
      },
    });
    expect(byId(managed.instances, "codex").home).toBe("/home/mira/.codex");
    expect(byId(managed.instances, "codex_second")).toMatchObject({
      home: "/home/mira/.codex",
      shadow: "/home/mira/.codex-t3/second",
    });
  });

  test("enabled: false, the legacy providers key, other drivers and entries of another form", () => {
    const read = t3ProviderInstances(linux(), {
      providerInstances: {
        codex: { driver: "codex", enabled: false },
        claudeAgent: { driver: "claudeAgent", config: { enabled: false, homePath: "~/.claude" } },
        claude_on: { driver: "claudeAgent", config: { homePath: "/srv/claude-on" } },
        // Turned off: a home that cannot be known is not worked out, so not passed over either.
        claude_off_relative: {
          driver: "claudeAgent",
          enabled: false,
          config: { homePath: "relative" },
        },
        codex_off_secret: {
          driver: "codex",
          enabled: false,
          environment: [{ name: "CODEX_HOME", sensitive: true, secret: "ref" }],
        },
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
    expect(read.instances.map((i) => i.id)).toEqual(["claude_on"]);
    expect(read.off).toEqual(["codex", "claudeAgent", "claude_off_relative", "codex_off_secret"]);
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
    expect(id("/home/mira/.claude_second")).toBe("claude-second");
    expect(id("/home/mira/.claude-work")).toBe("claude-work");
    expect(id("/home/mira/.claude")).toBe("claude");
    expect(id("/srv/agents/home", "claude-lab")).toBe("claude-lab");
    expect(id("/srv/agents/home", "claude_second")).toBe("claude-second");
    expect(id("/srv/agents/home", "Claude Lab")).toBe("claude-t3");
  });

  test("a Codex shadow home is recognised by its config.toml and sessions linking into another home", () => {
    const shared = join(base, "shared");
    const own = join(base, "own");
    mkdirSync(join(shared, "sessions"), { recursive: true });
    mkdirSync(join(own, "sessions"), { recursive: true });
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
    symlinkSync(join(shared, "sessions"), join(shadow, "sessions"));
    expect(codexSharedHome(process.platform, shadow)).toBe(shared);
    // A T3 instance whose home is that shadow runs on the shared home's file: its home is the
    // shared one, with the shadow named, so setup marks the shared home as T3's and doctor checks it.
    const t3 = join(base, "t3");
    mkdirSync(join(t3, "userdata"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(t3, "userdata", "settings.json"),
      JSON.stringify({
        providerInstances: {
          codex: { driver: "codex", enabled: false },
          codex_shadowed: { driver: "codex", config: { homePath: shadow } },
        },
      }),
      { mode: 0o600 },
    );
    const settings = t3SettingsOf({
      platform: process.platform,
      userHome: base,
      env: { T3CODE_HOME: t3 },
    });
    expect(settings?.file).toBe("read");
    const codex = settings?.instances.filter((i) => i.app === "codex");
    expect(codex?.map((i) => [i.id, i.home, i.shadow])).toEqual([
      ["codex_shadowed", shared, shadow],
    ]);
    // A config.toml linked alone (a dotfiles setup) is no shadow: setup refuses that link.
    const dotfiles = join(base, "dotfiles");
    mkdirSync(join(dotfiles, "sessions"), { recursive: true });
    symlinkSync(join(shared, "config.toml"), join(dotfiles, "config.toml"));
    expect(codexSharedHome(process.platform, dotfiles)).toBeUndefined();
    // Links into two different folders, to another file name, or to nothing, are no shadow.
    const split = join(base, "split");
    mkdirSync(split);
    symlinkSync(join(shared, "config.toml"), join(split, "config.toml"));
    symlinkSync(join(own, "sessions"), join(split, "sessions"));
    expect(codexSharedHome(process.platform, split)).toBeUndefined();
    const odd = join(base, "odd");
    mkdirSync(odd);
    writeFileSync(join(shared, "other.toml"), "");
    symlinkSync(join(shared, "other.toml"), join(odd, "config.toml"));
    symlinkSync(join(shared, "sessions"), join(odd, "sessions"));
    expect(codexSharedHome(process.platform, odd)).toBeUndefined();
    const dangling = join(base, "dangling");
    mkdirSync(dangling);
    symlinkSync(join(base, "gone", "config.toml"), join(dangling, "config.toml"));
    symlinkSync(join(base, "gone", "sessions"), join(dangling, "sessions"));
    expect(codexSharedHome(process.platform, dangling)).toBeUndefined();
  });
});
