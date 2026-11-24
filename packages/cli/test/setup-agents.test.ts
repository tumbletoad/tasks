// `ttasks setup agents` through the CLI and a real service (A3 3.13.1, A2 3.2.5; A7 3.9 M2.14): the
// preview names the served space and writes nothing, only the user applies and removes, the
// service keeps one agent-home row per home in its grants table and revokes it with the entry, and
// the homes come back key for key. A real service in this process, the CLI in this process, fake
// `claude` and `codex` commands (testkit) on a scratch PATH, scratch homes in a temporary folder.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CLI_NAME, MCP_SERVER_KEY } from "@ttasks/brand";
import { valueText } from "@ttasks/service/config";
import { startService, type RunningService } from "@ttasks/service/hub";
import {
  configOf,
  removeRuntimeDir,
  serviceEnv,
  stateOf,
  tempRoot,
} from "@ttasks/service/test/harness";
import { classSession } from "@ttasks/service/test/ops-helpers";
import { installFakeAgents, type FakeAgents } from "@ttasks/testkit/fake-agents";
import { runMain } from "./cli-harness.ts";

const SLOW = 180_000;
const windows = process.platform === "win32";

let service: RunningService;
let root: string;
let home: string;
let user: string;
let fakes: FakeAgents;
let space: string;
let cleanup: () => void;

beforeAll(async () => {
  const temp = tempRoot("sa");
  cleanup = temp.cleanup;
  root = temp.root;
  home = join(temp.root, "h");
  user = join(temp.root, "u");
  mkdirSync(user);
  fakes = installFakeAgents(join(temp.root, "t"), user);
  service = await startService({
    env: serviceEnv(home),
    identity: () => ({ root: false, elevated: false, package: null }),
    maintenance: false,
    say: () => undefined,
  });
  const session = await classSession(home, service.endpoint.path, "cli-interactive");
  try {
    await session.call(
      "space/create",
      { name: "Mira", path: join(temp.root, "s", "mira"), ref_prefix: "M" },
      { timeoutMs: 120_000 },
    );
    const listed = (await session.call("space/list", {}, { timeoutMs: 30_000 })) as {
      spaces: { id: string }[];
    };
    space = listed.spaces[0]?.id ?? "";
  } finally {
    session.close();
  }
  // The install's stable command, which every entry runs.
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(join(home, "bin", windows ? "ttasks.exe" : "ttasks"), "");
  // A Claude Code home with another server, and a Codex home.
  mkdirSync(join(user, ".claude"));
  writeFileSync(
    join(user, ".claude.json"),
    JSON.stringify({ mcpServers: { other: { command: "/opt/other", args: [] } } }, null, 2),
  );
  mkdirSync(join(user, ".codex"));
  writeFileSync(
    join(user, ".codex", "config.toml"),
    'model = "m"\n\n[mcp_servers.other]\ncommand = "x"\n',
  );
}, SLOW);

afterAll(async () => {
  await service.stop();
  removeRuntimeDir(service);
  cleanup();
}, SLOW);

const files = () => [join(user, ".claude.json"), join(user, ".codex", "config.toml")];
const read = () => files().map((f) => readFileSync(f, "utf8"));
const recordFile = () => join(stateOf(home), "setup", "agents.json");

/** `ttasks <argv>` as a person at a terminal (tty), a script, or an agent's shell. */
const run = (argv: string[], tty = true, env: Record<string, string> = {}) =>
  runMain(argv, {
    home,
    tty,
    env,
    // macOS: never the machine's own Applications folder.
    main: { agents: { env: fakes.env, home: user, systemApplications: join(user, "Apps") } },
  });

/** The live agent-home rows, as any CLI may read them. */
async function rows(): Promise<
  { grant: string; app: string; home: string; instance: string; spaces: string[] }[]
> {
  const session = await classSession(home, service.endpoint.path, "cli-script");
  try {
    const result = (await session.call("setup/homes", {}, { timeoutMs: 30_000 })) as {
      homes: { grant: string; app: string; home: string; instance: string; spaces: string[] }[];
    };
    return result.homes;
  } finally {
    session.close();
  }
}

describe("[A3.3.13.setup.cli] ttasks setup agents through the CLI and the service", () => {
  test(
    "preview writes nothing; only the user applies; one row per home; remove takes entries and rows back",
    async () => {
      const before = read();

      const preview = await run(["setup", "agents", "--json"], false);
      expect(preview.code, preview.stderr).toBe(0);
      const planned = JSON.parse(preview.stdout) as {
        space: string;
        plan: string;
        apply: string[];
        homes: {
          app: string;
          state: string;
          sha256: string;
          change: { entry: { command: string; args: string[] }; diff: string[] };
        }[];
      };
      expect(planned.space).toBe(space);
      // The preview's exact apply: its plan and the space it resolved, by ID.
      expect(planned.apply).toEqual([
        CLI_NAME,
        "setup",
        "agents",
        "--apply",
        "--plan",
        planned.plan,
        "--space",
        space,
      ]);
      expect(planned.homes.map((h) => [h.app, h.state]).sort()).toEqual([
        ["claude-code", "not_registered"],
        ["codex", "not_registered"],
      ]);
      for (const h of planned.homes) {
        expect(h.sha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(h.change.entry.command).toBe(join(home, "bin", windows ? "ttasks.exe" : "ttasks"));
        expect(h.change.entry.args).toContain(space);
      }
      const text = await run(["setup", "agents"], false);
      expect(text.code).toBe(0);
      // The file each entry goes in, and no command a person could paste into another account.
      expect(text.stdout).toContain(join(user, ".codex", "config.toml"));
      expect(text.stdout).not.toContain("mcp add");
      expect(text.stdout).toContain("+ startup_timeout_sec = 20");
      expect(text.stdout).toContain(
        `Nothing was changed. To make these 2 changes, run: ${planned.apply.join(" ")}`,
      );
      expect(read()).toEqual(before);
      expect(existsSync(recordFile())).toBe(false);

      // A script and an agent are refused before anything is read or written.
      for (const [tty, env] of [
        [false, {}],
        [true, { CLAUDECODE: "1" }],
      ] as const) {
        const refused = await run([...planned.apply.slice(1), "--json"], tty, env);
        expect(refused.code).toBe(5);
        expect(JSON.parse(refused.stdout)).toMatchObject({
          error: { code: "forbidden", data: { rule: "user_only" } },
        });
      }
      expect(read()).toEqual(before);
      expect(existsSync(recordFile())).toBe(false);
      expect(await rows()).toEqual([]);

      // Apply carries out a preview or nothing: without the plan it is a usage error, and with a
      // plan the homes no longer match it changes nothing.
      expect((await run(["setup", "agents", "--apply"])).code).toBe(2);
      const codexFile = files()[1] ?? "";
      writeFileSync(codexFile, `${before[1] ?? ""}# touched since the preview\n`);
      const stale = await run([...planned.apply.slice(1), "--json"]);
      expect(stale.code, stale.stdout).toBe(4);
      expect(JSON.parse(stale.stdout)).toMatchObject({ error: { code: "conflict" } });
      writeFileSync(codexFile, before[1] ?? "");
      expect(read()).toEqual(before);
      expect(existsSync(recordFile())).toBe(false);
      expect(await rows()).toEqual([]);

      const applied = await run([...planned.apply.slice(1), "--json"]);
      expect(applied.code, applied.stdout + applied.stderr).toBe(0);
      expect(
        (JSON.parse(applied.stdout) as { homes: { result: string }[] }).homes.map((h) => h.result),
      ).toEqual(["applied", "applied"]);
      const granted = await rows();
      expect(granted.map((r) => [r.app, r.instance, r.spaces]).sort()).toEqual([
        ["claude-code", "claude", [space]],
        ["codex", "codex", [space]],
      ]);
      const status = await run(["setup", "agents", "--status", "--json"], false);
      const homes = (
        JSON.parse(status.stdout) as { homes: { state: string; row: string; grant: string }[] }
      ).homes;
      expect(homes.map((h) => h.state)).toEqual(["registered", "registered"]);
      for (const h of homes) expect(h.row).toBe(h.grant);
      expect(granted.map((r) => r.grant).sort()).toEqual(homes.map((h) => h.row).sort());

      // Applying again keeps the entries and the rows.
      const renew = JSON.parse((await run(["setup", "agents", "--json"], false)).stdout) as {
        apply: string[];
      };
      const again = await run([...renew.apply.slice(1), "--json"]);
      expect(
        (JSON.parse(again.stdout) as { homes: { result: string }[] }).homes.map((h) => h.result),
      ).toEqual(["unchanged", "unchanged"]);
      expect((await rows()).map((r) => r.grant).sort()).toEqual(granted.map((r) => r.grant).sort());

      // A registered home whose access went: the preview says that its apply gives it again, and a
      // plan made while its access was on does not turn it back on.
      const person = await classSession(home, service.endpoint.path, "cli-interactive");
      try {
        const codexRow = granted.find((r) => r.app === "codex");
        await person.call(
          "setup/home_revoke",
          { grants: [codexRow?.grant] },
          { timeoutMs: 30_000 },
        );
      } finally {
        person.close();
      }
      const shownOn = await run([...renew.apply.slice(1), "--json"]);
      expect(shownOn.code, shownOn.stdout).toBe(4);
      expect(JSON.parse(shownOn.stdout)).toMatchObject({ error: { code: "conflict" } });
      expect((await rows()).map((r) => r.app)).toEqual(["claude-code"]);
      const off = await run(["setup", "agents"], false);
      expect(off.stdout).toContain(
        "registered, and its access is off, so its tools do not start: apply gives it its access again.",
      );
      expect(off.stdout).toContain("To make this change, run:");
      const back = JSON.parse((await run(["setup", "agents", "--json"], false)).stdout) as {
        apply: string[];
        homes: { app: string; state: string; change?: unknown }[];
      };
      // The JSON says the same: the access that apply gives back, for that home alone.
      expect(back.homes.map((h) => [h.app, h.state, h.change])).toEqual([
        ["claude-code", "registered", undefined],
        ["codex", "registered", { access: "on" }],
      ]);
      expect((await run([...back.apply.slice(1), "--json"])).code).toBe(0);
      expect((await rows()).map((r) => r.app).sort()).toEqual(["claude-code", "codex"]);

      // The install moved: Codex's entry, and setup's record of it, name the old command, in the
      // quoting the TOML writer gives each. Status says its tools do not start, and the apply
      // writes it again with the command there now.
      const present = join(home, "bin", windows ? "ttasks.exe" : "ttasks");
      const old = join(home, "old", windows ? "ttasks.exe" : "ttasks");
      const toml = join(user, ".codex", "config.toml");
      const as = { toml: readFileSync(toml, "utf8"), record: readFileSync(recordFile(), "utf8") };
      try {
        const seeded = as.toml.replace(
          `command = ${valueText(present)}`,
          `command = ${valueText(old)}`,
        );
        expect(seeded).not.toBe(as.toml);
        writeFileSync(toml, seeded);
        const record = JSON.parse(as.record) as {
          homes: { app: string; entry: { command: string } }[];
        };
        for (const h of record.homes) if (h.app === "codex") h.entry.command = old;
        writeFileSync(recordFile(), JSON.stringify(record));
        const moved = JSON.parse(
          (await run(["setup", "agents", "--status", "--json"], false)).stdout,
        ) as { homes: { app: string; tools: { status: string; why?: string; on?: string } }[] };
        expect(moved.homes.map((h) => [h.app, h.tools])).toEqual([
          ["claude-code", { status: "on", off: true }],
          ["codex", { status: "off", why: "moved", on: "repair", off: true }],
        ]);
        const repair = await run(["setup", "agents"], false);
        expect(repair.stdout).toContain("where it was installed before, so its tools do not start");
        expect(repair.stdout).toContain(`- command = ${valueText(old)}`);
        expect(repair.stdout).toContain(`+ command = ${valueText(present)}`);
        const repaired = JSON.parse((await run(["setup", "agents", "--json"], false)).stdout) as {
          apply: string[];
        };
        const fixed = await run([...repaired.apply.slice(1), "--json"]);
        expect(
          (JSON.parse(fixed.stdout) as { homes: { result: string }[] }).homes.map((h) => h.result),
        ).toEqual(["unchanged", "applied"]);
        expect(readFileSync(toml, "utf8")).toContain(valueText(present));
        expect((await rows()).map((r) => r.app).sort()).toEqual(["claude-code", "codex"]);
      } catch (error) {
        // What later tests meet is the registered home, not this one's half-made fixture.
        writeFileSync(toml, as.toml);
        writeFileSync(recordFile(), as.record);
        throw error;
      }

      // Remove: refused for a script, then the user's takes back entries and rows.
      expect((await run(["setup", "agents", "--remove", "--json"], false)).code).toBe(5);
      const removed = await run(["setup", "agents", "--remove"]);
      expect(removed.code, removed.stdout + removed.stderr).toBe(0);
      expect(removed.stdout).toContain("removed");
      expect(await rows()).toEqual([]);
      expect(read()).toEqual(before);
      const log = readFileSync(join(stateOf(home), "logs", "service.log"), "utf8");
      expect(log).toContain('"setup.home_granted"');
      expect(log).toContain('"setup.home_revoked"');
      expect(log).not.toContain(user);
    },
    SLOW,
  );

  test(
    "the service's rows: user-only, one live row per home, a served space only, bad input refused",
    async () => {
      const script = await classSession(home, service.endpoint.path, "cli-script");
      const person = await classSession(home, service.endpoint.path, "cli-interactive");
      const grant = (params: Record<string, unknown>) =>
        person.call("setup/home_grant", params, { timeoutMs: 30_000 }) as Promise<{
          grant: { grant: string; instance: string };
          created: boolean;
        }>;
      const failure = async (promise: Promise<unknown>) => {
        try {
          await promise;
        } catch (error) {
          return (error as { data?: { code?: string } }).data?.code;
        }
        return "none";
      };
      try {
        const row = {
          app: "codex",
          home: join(user, ".codex-x"),
          file: join(user, ".codex-x", "config.toml"),
          instance: "codex-x",
          account: "x",
        };
        expect(
          await failure(script.call("setup/home_grant", { ...row, space }, { timeoutMs: 30_000 })),
        ).toBe("forbidden");
        const first = await grant({ ...row, space });
        expect(first.created).toBe(true);
        // The same answer keeps the row; another one replaces it.
        expect(await grant({ ...row, space })).toMatchObject({
          created: false,
          grant: { grant: first.grant.grant },
        });
        const second = await grant({ ...row, instance: "codex-y", space });
        expect(second.created).toBe(true);
        expect((await rows()).map((r) => [r.grant, r.instance])).toEqual([
          [second.grant.grant, "codex-y"],
        ]);
        for (const bad of [
          { ...row, app: "cursor", space },
          { ...row, instance: "Not An ID", space },
          { ...row, account: "x\ny", space },
          { ...row, account: "x".repeat(65), space },
          { ...row, account: 7, space },
          { ...row, space: "sp_00000000000000000000000000" },
        ]) {
          expect(await failure(grant(bad))).not.toBe("none");
        }
        expect(
          await failure(
            person.call("setup/home_revoke", { grants: ["not-an-id"] }, { timeoutMs: 30_000 }),
          ),
        ).toBe("invalid_input");
        expect(
          await person.call(
            "setup/home_revoke",
            { grants: [second.grant.grant] },
            { timeoutMs: 30_000 },
          ),
        ).toEqual({ revoked: 1 });
        expect(await rows()).toEqual([]);
        // An instance without an account label (machine.toml's `account` is optional) is a row too.
        const unlabelled = await grant({ ...row, account: "", space });
        expect(unlabelled.created).toBe(true);
        expect(
          await person.call(
            "setup/home_revoke",
            { grants: [unlabelled.grant.grant] },
            { timeoutMs: 30_000 },
          ),
        ).toEqual({ revoked: 1 });
        expect(await rows()).toEqual([]);
      } finally {
        script.close();
        person.close();
      }
    },
    SLOW,
  );

  test("--help prints the help; a wrong option or two modes are usage errors", async () => {
    const help = await run(["setup", "agents", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("agents --apply");
    expect((await run(["setup", "agents", "--force"])).code).toBe(2);
    expect((await run(["setup", "agents", "--apply", "--remove"])).code).toBe(2);
    expect((await run(["setup", "agents", "--app", "cursor"])).code).toBe(2);
    expect((await run(["setup", "agents", "--apply", "--plan", "not-a-plan"])).code).toBe(2);
    expect((await run(["setup", "agents", "--remove", "--plan", "0123456789abcdef"])).code).toBe(2);
  });

  test(
    "--space names the space, and the printed apply keeps the preview's selection",
    async () => {
      const session = await classSession(home, service.endpoint.path, "cli-interactive");
      let listed: { spaces: { id: string; name: string }[] };
      try {
        await session.call(
          "space/create",
          { name: "Ostra", path: join(root, "s", "ostra"), ref_prefix: "O" },
          { timeoutMs: 120_000 },
        );
        listed = (await session.call("space/list", {}, { timeoutMs: 30_000 })) as typeof listed;
      } finally {
        session.close();
      }
      const other = listed.spaces.find((s) => s.name === "Ostra")?.id ?? "";
      expect(other).not.toBe(space);
      const before = read();

      const argv = ["setup", "agents", "--instance", "codex", "--space", "Ostra"];
      const preview = await run([...argv, "--json"], false);
      expect(preview.code, preview.stderr).toBe(0);
      const planned = JSON.parse(preview.stdout) as {
        space: string;
        plan: string;
        apply: string[];
        homes: { app: string; change: { entry: { args: string[] } } }[];
      };
      expect(planned.space).toBe(other);
      expect(planned.homes.map((h) => h.app)).toEqual(["codex"]);
      expect(planned.homes[0]?.change.entry.args).toContain(other);
      expect(planned.apply).toEqual([
        CLI_NAME,
        "setup",
        "agents",
        "--apply",
        "--plan",
        planned.plan,
        "--instance",
        "codex",
        "--space",
        other,
      ]);
      expect((await run(argv, false)).stdout).toContain(`run: ${planned.apply.join(" ")}`);
      // Two served spaces and no default: without --space nothing is planned.
      expect((await run(["setup", "agents", "--json"], false)).code).not.toBe(0);

      const applied = await run([...planned.apply.slice(1), "--json"]);
      expect(applied.code, applied.stdout + applied.stderr).toBe(0);
      expect((await rows()).map((r) => [r.app, r.instance, r.spaces])).toEqual([
        ["codex", "codex", [other]],
      ]);
      const removed = await run(["setup", "agents", "--remove", "--json"]);
      expect(removed.code, removed.stdout).toBe(0);
      expect(await rows()).toEqual([]);
      expect(read()).toEqual(before);
    },
    SLOW,
  );
});

describe("[A3.3.13.setup.free-instance] setup proposes a free instance, and names the refusal of a taken one", () => {
  /** A live row of another home, made as setup makes rows; the function revokes it. */
  async function foreignRow(
    instance: string,
    of: string = join(user, ".codex-elsewhere"),
  ): Promise<() => Promise<void>> {
    const person = await classSession(home, service.endpoint.path, "cli-interactive");
    try {
      const made = (await person.call(
        "setup/home_grant",
        { app: "codex", home: of, file: join(of, "config.toml"), instance, account: "", space },
        { timeoutMs: 30_000 },
      )) as { grant: { grant: string } };
      return async () => {
        const again = await classSession(home, service.endpoint.path, "cli-interactive");
        try {
          await again.call(
            "setup/home_revoke",
            { grants: [made.grant.grant] },
            { timeoutMs: 30_000 },
          );
        } finally {
          again.close();
        }
      };
    } finally {
      person.close();
    }
  }

  test(
    "a detected home whose proposed instance another home holds is offered another one",
    async () => {
      const before = read();
      const revoke = await foreignRow("codex");
      try {
        const preview = await run(["setup", "agents", "--space", space, "--json"], false);
        expect(preview.code, preview.stderr).toBe(0);
        const planned = JSON.parse(preview.stdout) as {
          apply: string[];
          homes: {
            app: string;
            home: string;
            instance: string;
            change: { entry: { args: string[] } };
          }[];
        };
        // The default Codex home would be `codex`, which the other home's row holds; Claude Code's
        // `claude` is free and kept. The other home is listed with its row, so it can be turned off.
        expect(planned.homes.map((h) => [h.app, h.home, h.instance])).toEqual([
          ["claude-code", join(user, ".claude"), "claude"],
          ["codex", join(user, ".codex"), "codex-2"],
          ["codex", join(user, ".codex-elsewhere"), "codex"],
        ]);
        const codex = planned.homes.find((h) => h.instance === "codex-2");
        expect(codex?.change.entry.args).toEqual(expect.arrayContaining(["--instance", "codex-2"]));
        // --instance selects by the instance the preview shows.
        const selected = await run(
          ["setup", "agents", "--space", space, "--instance", "codex-2", "--json"],
          false,
        );
        expect(
          (JSON.parse(selected.stdout) as { homes: { instance: string }[] }).homes.map(
            (h) => h.instance,
          ),
        ).toEqual(["codex-2"]);

        // Not complete: the other home's folder is gone, so its tools cannot start, and its access
        // is still on.
        const applied = await run([...planned.apply.slice(1), "--json"]);
        expect(applied.code, applied.stdout + applied.stderr).toBe(10);
        expect(JSON.parse(applied.stdout)).toMatchObject({
          homes: [
            { instance: "claude", result: "applied" },
            { instance: "codex-2", result: "applied" },
            { instance: "codex", result: "left", reason: "missing" },
          ],
        });
        expect((await rows()).map((r) => [r.app, r.instance]).sort()).toEqual([
          ["claude-code", "claude"],
          ["codex", "codex"],
          ["codex", "codex-2"],
        ]);
        // Registered, the home keeps its instance: setup's record names it from now on.
        const again = JSON.parse(
          (await run(["setup", "agents", "--space", space, "--json"], false)).stdout,
        ) as { homes: { app: string; instance: string; state: string }[] };
        expect(again.homes.find((h) => h.app === "codex" && h.instance !== "codex")).toMatchObject({
          instance: "codex-2",
          state: "registered",
        });
        const removed = await run(["setup", "agents", "--remove", "--json"]);
        expect(removed.code, removed.stdout).toBe(0);
        expect(read()).toEqual(before);
      } finally {
        await revoke();
      }
      expect(await rows()).toEqual([]);
    },
    SLOW,
  );

  test(
    "a home whose own row outlived setup's record gets that row's instance back, not a new proposal",
    async () => {
      const before = read();
      // The default Codex home's own row, as setup made it once, with setup's record gone since.
      const revoke = await foreignRow("codex-7", join(user, ".codex"));
      try {
        const preview = await run(
          ["setup", "agents", "--app", "codex", "--space", space, "--json"],
          false,
        );
        expect(preview.code, preview.stderr).toBe(0);
        const planned = JSON.parse(preview.stdout) as {
          homes: { app: string; instance: string }[];
        };
        expect(planned.homes.map((h) => [h.app, h.instance])).toEqual([["codex", "codex-7"]]);
        expect(read()).toEqual(before);
      } finally {
        await revoke();
      }
      expect(await rows()).toEqual([]);
    },
    SLOW,
  );

  test(
    "an instance machine.toml names that another home holds: the refusal is named, and the home is left as it was",
    async () => {
      const before = read();
      const config = join(configOf(home), "machine.toml");
      mkdirSync(configOf(home), { recursive: true, mode: 0o700 });
      // The person's own instance for the default Codex home: setup keeps their ID, never another.
      writeFileSync(
        config,
        [
          "[[instance]]",
          'id = "codex-mine"',
          'target = "codex-cli"',
          'label = "Codex mine"',
          `config_home = '${join(user, ".codex")}'`,
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      const revoke = await foreignRow("codex-mine");
      try {
        const argv = ["setup", "agents", "--app", "codex", "--space", space];
        const preview = await run([...argv, "--json"], false);
        expect(preview.code, preview.stderr).toBe(0);
        const planned = JSON.parse(preview.stdout) as {
          apply: string[];
          homes: { home: string; instance: string }[];
        };
        expect(planned.homes.map((h) => [h.home, h.instance])).toEqual([
          [join(user, ".codex"), "codex-mine"],
          [join(user, ".codex-elsewhere"), "codex-mine"],
        ]);
        const applied = await run([...planned.apply.slice(1), "--json"]);
        expect(applied.code, applied.stdout).toBe(10);
        expect(JSON.parse(applied.stdout)).toMatchObject({
          homes: [
            { app: "codex", result: "failed", reason: "instance_taken" },
            { app: "codex", home: join(user, ".codex-elsewhere"), result: "left" },
          ],
        });
        const text = await run(planned.apply.slice(1));
        expect(text.stdout).toContain("another agent home is registered as this instance");
        expect(read()).toEqual(before);
        expect((await rows()).map((r) => r.instance)).toEqual(["codex-mine"]);
      } finally {
        await revoke();
        rmSync(config, { force: true });
      }
      expect(await rows()).toEqual([]);
    },
    SLOW,
  );

  test(
    "an entry added by hand: the preview leaves the home and says how to take the entry out",
    async () => {
      const before = read();
      const claudeFile = files()[0] ?? "";
      const handMade = JSON.parse(before[0] ?? "{}") as { mcpServers: Record<string, unknown> };
      handMade.mcpServers[MCP_SERVER_KEY] = { command: "/opt/tasks", args: ["mcp", "--app", "x"] };
      writeFileSync(claudeFile, JSON.stringify(handMade, null, 2));
      try {
        const preview = await run(
          ["setup", "agents", "--app", "claude-code", "--space", space],
          false,
        );
        expect(preview.code, preview.stderr).toBe(0);
        expect(preview.stdout).toContain("that setup did not write (one added by hand)");
        expect(preview.stdout).toContain(
          `"${MCP_SERVER_KEY}" member of "mcpServers" out of ${claudeFile}`,
        );
        expect(preview.stdout).not.toContain("mcp remove");
        expect(preview.stdout).toContain(`then run ${CLI_NAME} setup agents again`);
      } finally {
        writeFileSync(claudeFile, before[0] ?? "");
      }
      expect(read()).toEqual(before);
    },
    SLOW,
  );

  test(
    "setup's own record unreadable: remove turns every home's access off by its row, says where the record is, and changes no file",
    async () => {
      const before = read();
      const shown = await run(["setup", "agents", "--space", space, "--json"], false);
      expect(shown.code, shown.stdout + shown.stderr).toBe(0);
      const planned = JSON.parse(shown.stdout) as {
        apply: string[];
      };
      expect((await run([...planned.apply.slice(1), "--json"])).code).toBe(0);
      expect((await rows()).map((r) => r.app).sort()).toEqual(["claude-code", "codex"]);
      const withEntries = read();
      const kept = readFileSync(recordFile());
      const damaged = '{"format": 2, "homes": [';
      writeFileSync(recordFile(), damaged);
      try {
        // The preview turns nothing on.
        const preview = await run(["setup", "agents"], false);
        expect(preview.code, preview.stderr).toBe(0);
        expect(preview.stdout).toContain("cannot read its own record of the agent homes");
        expect(preview.stdout).toContain("Nothing was changed.");
        const removed = await run(["setup", "agents", "--remove"]);
        // Not complete: each entry stays in its file.
        expect(removed.code, removed.stdout + removed.stderr).toBe(10);
        expect(removed.stdout).toContain(recordFile());
        expect(removed.stdout).toContain("Access is off.");
        expect(await rows()).toEqual([]);
        expect(read()).toEqual(withEntries);
        expect(readFileSync(recordFile(), "utf8")).toBe(damaged);
      } finally {
        writeFileSync(recordFile(), kept);
      }
      // Readable again: the next remove takes the entries out.
      expect((await run(["setup", "agents", "--remove"])).code).toBe(0);
      expect(read()).toEqual(before);
    },
    SLOW,
  );
});
