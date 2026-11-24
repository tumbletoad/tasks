// The page's agent apps and New space against a real service in this process, over HTTP as the
// page calls them: only the person may call them, a switch is applied only as the person saw it,
// and what one click adds the next one takes out again. Scratch homes and fake agent commands
// only (testkit's fake-agents.ts): no real agent home is read or written.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLI_NAME, MCP_SERVER_KEY } from "@ttasks/brand";
import { installFakeAgents } from "@ttasks/testkit/fake-agents";
import { FixedEnvironment } from "@ttasks/launch";
import {
  agentAppVerbs,
  personEnv,
  type AgentAppsHost,
  type AppsView,
} from "../src/hub/agent-apps.ts";
import { startService, type RunningService } from "../src/hub/service.ts";
import { configOf, removeRuntimeDir, serviceEnv, stateOf, tempRoot } from "./harness.ts";
import { post } from "./http-client.ts";
import { signIn } from "./http-world.ts";
import { classSession } from "./ops-helpers.ts";

const SLOW = 120_000;

interface World {
  readonly service: RunningService;
  readonly home: string;
  readonly user: string;
  readonly token: string;
  readonly port: number;
  close(): Promise<void>;
}

async function world(
  label: string,
  extra: (root: string) => Record<string, string> = () => ({}),
): Promise<World> {
  const temp = tempRoot(label);
  const home = join(temp.root, "h");
  // The person's own home, as the agent apps see it: a Claude Code and a Codex home.
  const user = join(temp.root, "u");
  mkdirSync(join(user, ".claude"), { recursive: true });
  mkdirSync(join(user, ".codex"), { recursive: true });
  const fakes = installFakeAgents(join(temp.root, "fakes"), user);
  // The installed command every entry runs; nothing runs it here.
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(join(home, "bin", process.platform === "win32" ? `${CLI_NAME}.exe` : CLI_NAME), "");
  const service = await startService({
    env: serviceEnv(home),
    identity: () => ({ root: false, elevated: false, package: null }),
    maintenance: false,
    say: () => undefined,
    http: { ports: [0], persist: false },
    agentApps: { env: { ...fakes.env, ...extra(temp.root) }, home: user },
  });
  const sessions: { close(): void }[] = [];
  const signed = await signIn({
    user: async () => {
      const session = await classSession(home, service.endpoint.path, "cli-interactive");
      sessions.push(session);
      return session;
    },
  });
  return {
    service,
    home,
    user,
    token: signed.token,
    port: service.status().http?.port ?? 0,
    close: async () => {
      for (const s of sessions) s.close();
      await service.stop();
      removeRuntimeDir(service);
      temp.cleanup();
    },
  };
}

interface Applied {
  readonly applied: boolean;
  readonly outcomes: readonly { readonly result: string }[];
  readonly view: AppsView;
}

/** A page's call: its status and its result, read as `T`. */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the result's shape
async function call<T = Record<string, unknown>>(
  w: World,
  path: string,
  body: unknown,
): Promise<{ status: number; result: T }> {
  const reply = await post(w.port, path, body, { token: w.token });
  return { status: reply.status, result: (JSON.parse(reply.body) as { result: T }).result };
}

/** TTasks's entry in the scratch Claude Code home, or undefined (also when setup's file is gone). */
const claudeEntry = (user: string): { args?: unknown } | undefined =>
  existsSync(join(user, ".claude.json"))
    ? (
        JSON.parse(readFileSync(join(user, ".claude.json"), "utf8")) as {
          mcpServers?: Record<string, { args?: unknown }>;
        }
      ).mcpServers?.["ttasks"]
    : undefined;

const row = (view: AppsView, app: string) => {
  const found = view.rows.find((r) => r.app === app);
  if (found === undefined) throw new Error(`no ${app} row`);
  return found;
};

describe("[A7.3.12.m5-12.page-gate] Only the person changes this machine's agent apps", () => {
  it("refuses an agent's connection, a script and the bridge before it reads anything", async () => {
    // Nothing of the host is read before the refusal: an empty one would fail if it were.
    const verbs = agentAppVerbs({} as AgentAppsHost);
    for (const cls of ["cli-agent", "cli-script", "bridge", "shim"] as const) {
      await expect(verbs.view({ space: "sp_x" }, cls)).rejects.toMatchObject({
        code: "forbidden",
      });
      await expect(verbs.apply({ space: "sp_x", changes: [] }, cls)).rejects.toMatchObject({
        code: "forbidden",
      });
    }
  });
});

describe("[A7.3.12.m5-12.page-apps] The page's agent apps: one click adds, the next takes out, and a stale view writes nothing", () => {
  let w: World;
  let space: string;
  beforeAll(async () => {
    w = await world("apps");
    const made = await call<{ id: string }>(w, "/api/v1/space/create", {
      name: "Mira",
      folder: join(w.home, "mira"),
    });
    expect(made.status).toBe(200);
    space = made.result.id;
  }, SLOW);
  afterAll(async () => {
    await w.close();
  }, SLOW);

  it(
    "a new space from a name alone: its prefix and folder are proposed, the home shown as ~",
    async () => {
      const proposed = await call<{ ref_prefix: string; folder: string }>(
        w,
        "/api/v1/space/propose",
        { name: "Studio work" },
      );
      expect(proposed.result.ref_prefix).toBe("S");
      expect(proposed.result.folder).toMatch(/studio-work$/u);
      const made = await call<{ id: string; name: string }>(w, "/api/v1/space/create", {
        name: "Studio work",
      });
      expect(made.status).toBe(200);
      expect(made.result.name).toBe("Studio work");
      // Open folder of a space that is served already: the same space.
      const opened = await call<{ id: string }>(w, "/api/v1/space/open", {
        folder: join(w.home, "spaces", "studio-work"),
      });
      expect(opened.result.id).toBe(made.result.id);
      const relative = await call(w, "/api/v1/space/open", { folder: "spaces/studio-work" });
      expect(relative.status).toBe(400);
    },
    SLOW,
  );

  it(
    "shows each app's two switches with what they write, applies the ones turned over, and takes them out again",
    async () => {
      const seen = (await call<AppsView>(w, "/api/v1/machine/apps", { space })).result;
      const claude = row(seen, "claude-code");
      const codex = row(seen, "codex");
      expect(claude.home).toMatch(/^~[\\/]\.claude$/u);
      expect(claude.open).toMatchObject({ on: false, change: "add" });
      expect(claude.tools).toMatchObject({ on: false, change: "add" });
      // The lines its file gains, and no command a person could paste into another account.
      expect(claude.tools?.detail.join("\n")).toContain(`mcpServers.${MCP_SERVER_KEY}.command`);
      expect(claude.tools?.detail.join("\n")).not.toContain("mcp add");
      expect(codex.tools).toMatchObject({ on: false, change: "add" });
      // Nothing is written by looking.
      expect(existsSync(join(w.user, ".claude.json"))).toBe(false);

      const applied = await call<Applied>(w, "/api/v1/machine/apps_apply", {
        space,
        changes: [
          { key: claude.key, part: "open", on: true, plan: claude.open?.plan },
          { key: claude.key, part: "tools", on: true, plan: claude.tools?.plan },
          { key: codex.key, part: "tools", on: true, plan: codex.tools?.plan },
        ],
      });
      expect(applied.result.applied).toBe(true);
      expect(applied.result.outcomes.map((o) => o.result)).toEqual(["done", "done", "done"]);
      const after = applied.result.view;
      expect(row(after, "claude-code").open).toMatchObject({ on: true, change: "remove" });
      expect(row(after, "claude-code").tools).toMatchObject({ on: true, change: "remove" });
      expect(row(after, "codex").open).toMatchObject({ on: false, change: "add" });
      expect(row(after, "codex").tools).toMatchObject({ on: true, change: "remove" });
      expect(claudeEntry(w.user)?.args).toEqual(
        expect.arrayContaining([
          "mcp",
          "--space",
          space,
          "--instance",
          "claude",
          "--app",
          "claude-code",
        ]),
      );
      expect(readFileSync(join(configOf(w.home), "machine.toml"), "utf8")).toContain(
        'id = "claude"',
      );

      const back = (await call<AppsView>(w, "/api/v1/machine/apps", { space })).result;
      const removed = await call<Applied>(w, "/api/v1/machine/apps_apply", {
        space,
        changes: [
          { key: claude.key, part: "open", on: false, plan: row(back, "claude-code").open?.plan },
          { key: claude.key, part: "tools", on: false, plan: row(back, "claude-code").tools?.plan },
          { key: codex.key, part: "tools", on: false, plan: row(back, "codex").tools?.plan },
        ],
      });
      expect(removed.result.applied).toBe(true);
      const gone = removed.result.view;
      for (const app of ["claude-code", "codex"]) {
        expect(row(gone, app).tools).toMatchObject({ on: false, change: "add" });
        expect(row(gone, app).open).toMatchObject({ on: false, change: "add" });
      }
      expect(claudeEntry(w.user)).toBeUndefined();
      expect(readFileSync(join(configOf(w.home), "machine.toml"), "utf8")).not.toContain(
        'id = "claude"',
      );
    },
    SLOW,
  );

  it(
    "a home that changed between the view and the click is not written, and the new view comes back",
    async () => {
      const seen = (await call<AppsView>(w, "/api/v1/machine/apps", { space })).result;
      const claude = row(seen, "claude-code");
      const codex = row(seen, "codex");
      // Codex's file changes meanwhile (another program, or the person).
      appendFileSync(join(w.user, ".codex", "config.toml"), '\nmodel = "o4"\n');
      const stale = await call<Applied>(w, "/api/v1/machine/apps_apply", {
        space,
        changes: [
          { key: claude.key, part: "tools", on: true, plan: claude.tools?.plan },
          { key: codex.key, part: "tools", on: true, plan: codex.tools?.plan },
        ],
      });
      expect(stale.result.applied).toBe(false);
      // Neither home was written, not even the one that did not change.
      expect(claudeEntry(w.user)).toBeUndefined();
      expect(readFileSync(join(w.user, ".codex", "config.toml"), "utf8")).not.toContain("tasks");
      const fresh = stale.result.view;
      expect(row(fresh, "codex").tools?.plan).not.toBe(codex.tools?.plan);
      const again = await call<Applied>(w, "/api/v1/machine/apps_apply", {
        space,
        changes: [
          { key: codex.key, part: "tools", on: true, plan: row(fresh, "codex").tools?.plan },
        ],
      });
      expect(again.result.applied).toBe(true);
      expect(readFileSync(join(w.user, ".codex", "config.toml"), "utf8")).toContain(
        "[mcp_servers.ttasks]",
      );
    },
    SLOW,
  );

  it(
    "the tools switch shows the access, not the file: an unreadable file stays on and turns off; an entry that could not be taken out shows off, and turning it on again works",
    async () => {
      const file = join(w.user, ".claude.json");
      const tools = async () =>
        row((await call<AppsView>(w, "/api/v1/machine/apps", { space })).result, "claude-code");
      const turn = async (on: boolean) => {
        const found = await tools();
        return call<Applied>(w, "/api/v1/machine/apps_apply", {
          space,
          changes: [{ key: found.key, part: "tools", on, plan: found.tools?.plan }],
        });
      };
      expect((await tools()).tools).toMatchObject({ on: false, change: "add" });
      expect((await turn(true)).result.outcomes).toMatchObject([{ result: "done" }]);
      const withEntry = readFileSync(file, "utf8");

      // A trailing comma someone typed: setup cannot read the file, and the access is still there.
      const broken = withEntry.replace(/\}\s*$/u, ",}\n");
      writeFileSync(file, broken);
      expect((await tools()).tools).toMatchObject({
        on: true,
        change: "remove",
        why: "file_unreadable",
      });
      const off = await turn(false);
      expect(off.result.outcomes).toMatchObject([{ result: "done", kept: true }]);
      expect(row(off.result.view, "claude-code").tools).toMatchObject({
        on: false,
        why: "file_unreadable",
      });
      expect(readFileSync(file, "utf8")).toBe(broken);

      // Mended: the access is off and the entry is still there, and turning it on works.
      writeFileSync(file, withEntry);
      expect((await tools()).tools).toMatchObject({
        on: false,
        change: "add",
        why: "entry_left",
      });
      const on = await turn(true);
      expect(on.result.outcomes).toMatchObject([{ result: "done" }]);
      expect(row(on.result.view, "claude-code").tools).toMatchObject({ on: true });
      expect(readFileSync(file, "utf8")).toBe(withEntry);

      const done = await turn(false);
      expect(done.result.outcomes).toMatchObject([{ result: "done" }]);
      expect(claudeEntry(w.user)).toBeUndefined();
      expect(row(done.result.view, "claude-code").tools).toMatchObject({
        on: false,
        change: "add",
      });
    },
    SLOW,
  );

  it(
    "with setup's own record unreadable the page names it, every home with access turns off, nothing turns on, and no file changes",
    async () => {
      const record = join(stateOf(w.home), "setup", "agents.json");
      const claudeFile = join(w.user, ".claude.json");
      const look = async () => (await call<AppsView>(w, "/api/v1/machine/apps", { space })).result;
      const first = await look();
      const before = row(first, "claude-code");
      if (!before.tools?.on) {
        await call<Applied>(w, "/api/v1/machine/apps_apply", {
          space,
          changes: [{ key: before.key, part: "tools", on: true, plan: before.tools?.plan }],
        });
      }
      const kept = readFileSync(record);
      const damaged = '{"format": 2, "homes": [';
      writeFileSync(record, damaged);
      const files = [claudeFile, join(w.user, ".codex", "config.toml")];
      const bytes = files.map((f) => readFileSync(f));
      try {
        const seen = await look();
        expect(seen.record).toMatch(/agents\.json$/u);
        const claude = row(seen, "claude-code");
        expect(claude.tools).toMatchObject({
          on: true,
          change: "remove",
          why: "record_unreadable",
        });
        const off = await call<Applied>(w, "/api/v1/machine/apps_apply", {
          space,
          changes: [{ key: claude.key, part: "tools", on: false, plan: claude.tools?.plan }],
        });
        expect(off.result.outcomes).toMatchObject([{ result: "done" }]);
        // Off, and it cannot be turned on again while the record cannot be read.
        expect(row(off.result.view, "claude-code").tools).toMatchObject({
          on: false,
          change: null,
          why: "record_unreadable",
        });
        expect(files.map((f) => readFileSync(f))).toEqual(bytes);
        expect(readFileSync(record, "utf8")).toBe(damaged);
      } finally {
        writeFileSync(record, kept);
      }
    },
    SLOW,
  );

  it(
    "refuses a space this service does not serve, and a switch named twice",
    async () => {
      expect(
        (await call(w, "/api/v1/machine/apps", { space: "sp_00000000000000000000000000" })).status,
      ).toBe(400);
      const seen = (await call<AppsView>(w, "/api/v1/machine/apps", { space })).result;
      const claude = row(seen, "claude-code");
      const twice = { key: claude.key, part: "open", on: true, plan: claude.open?.plan };
      expect(
        (await call<Applied>(w, "/api/v1/machine/apps_apply", { space, changes: [twice, twice] }))
          .status,
      ).toBe(400);
    },
    SLOW,
  );
});

describe("[A7.3.12.m5-12.page-status] The tools switch is on only while the tools start, and the first start proposes only what a person would choose", () => {
  let w: World;
  let space: string;
  const look = async () => (await call<AppsView>(w, "/api/v1/machine/apps", { space })).result;
  const turn = async (app: string, on: boolean) => {
    const found = row(await look(), app);
    return call<Applied>(w, "/api/v1/machine/apps_apply", {
      space,
      changes: [{ key: found.key, part: "tools", on, plan: found.tools?.plan }],
    });
  };
  beforeAll(async () => {
    w = await world("status");
    space = (await call<{ id: string }>(w, "/api/v1/space/create", { name: "Mira" })).result.id;
  }, SLOW);
  afterAll(async () => {
    await w.close();
  }, SLOW);

  it(
    "a folder found by its name only is listed with nothing proposed, and the usual home beside it is",
    async () => {
      mkdirSync(join(w.user, ".codex-backup"));
      try {
        const seen = await look();
        const backup = seen.rows.find((r) => r.app === "codex" && r.home?.endsWith("backup"));
        expect(backup).toMatchObject({ byName: true, tools: { on: false, change: "add" } });
        expect(row(seen, "codex")).not.toHaveProperty("byName");
        expect(row(seen, "claude-code")).not.toHaveProperty("byName");
      } finally {
        rmSync(join(w.user, ".codex-backup"), { recursive: true });
      }
    },
    SLOW,
  );

  it(
    "a home whose access went shows off with why, and turning it on gives the access back",
    async () => {
      expect((await turn("claude-code", true)).result.outcomes).toMatchObject([{ result: "done" }]);
      const session = await classSession(w.home, w.service.endpoint.path, "cli-interactive");
      try {
        await session.call("setup/home_revoke", {
          app: "claude-code",
          home: join(w.user, ".claude"),
        });
      } finally {
        session.close();
      }
      expect(row(await look(), "claude-code").tools).toMatchObject({
        on: false,
        change: "add",
        why: "access_off",
      });
      expect((await turn("claude-code", true)).result.outcomes).toMatchObject([{ result: "done" }]);
      expect(row(await look(), "claude-code").tools).toMatchObject({ on: true, change: "remove" });
      await turn("claude-code", false);
    },
    SLOW,
  );

  it(
    "an entry that runs a program that is gone shows off, and turning it on writes it again with the present one",
    async () => {
      expect((await turn("claude-code", true)).result.outcomes).toMatchObject([{ result: "done" }]);
      const present = join(
        w.home,
        "bin",
        process.platform === "win32" ? `${CLI_NAME}.exe` : CLI_NAME,
      );
      const gone = join(w.home, "old", process.platform === "win32" ? `${CLI_NAME}.exe` : CLI_NAME);
      // The install moved: the entry and setup's record of it name the old place.
      const moved = (file: string) => {
        const text = readFileSync(file, "utf8");
        writeFileSync(
          file,
          text.replaceAll(JSON.stringify(present).slice(1, -1), JSON.stringify(gone).slice(1, -1)),
        );
      };
      moved(join(w.user, ".claude.json"));
      moved(join(stateOf(w.home), "setup", "agents.json"));
      const seen = row(await look(), "claude-code").tools;
      expect(seen).toMatchObject({ on: false, change: "add", why: "moved" });
      expect(seen?.detail.join("\n")).toContain("-");
      expect((await turn("claude-code", true)).result.outcomes).toMatchObject([{ result: "done" }]);
      expect(row(await look(), "claude-code").tools).toMatchObject({ on: true, change: "remove" });
      expect((claudeEntry(w.user) as { command?: string } | undefined)?.command).toBe(present);
      await turn("claude-code", false);
    },
    SLOW,
  );
  it(
    "each home has one label within the bound, the same alone and beside others, and a saved one as saved",
    async () => {
      const suffix = "a".repeat(30);
      mkdirSync(join(w.user, `.claude-${suffix}`));
      try {
        const seen = await look();
        const long = seen.rows.find((r) => r.home?.endsWith(suffix));
        const codex = row(seen, "codex");
        expect(long?.label.length).toBeLessThanOrEqual(40);
        expect(codex.label).toBe("Codex");
        const applied = await call<Applied>(w, "/api/v1/machine/apps_apply", {
          space,
          changes: [
            { key: long?.key, part: "open", on: true, plan: long?.open?.plan },
            { key: codex.key, part: "open", on: true, plan: codex.open?.plan },
          ],
        });
        expect(applied.result.outcomes.map((o) => o.result)).toEqual(["done", "done"]);
        // The person renames Codex's tile in machine.toml: the row says it as saved.
        const toml = join(configOf(w.home), "machine.toml");
        writeFileSync(
          toml,
          readFileSync(toml, "utf8").replace('label = "Codex"', 'label = "Mine"'),
        );
        expect(row(await look(), "codex").label).toBe("Mine");
        const back = await look();
        const off = [back.rows.find((r) => r.home?.endsWith(suffix)), row(back, "codex")];
        await call<Applied>(w, "/api/v1/machine/apps_apply", {
          space,
          changes: off.map((r) => ({ key: r?.key, part: "open", on: false, plan: r?.open?.plan })),
        });
      } finally {
        rmSync(join(w.user, `.claude-${suffix}`), { recursive: true });
      }
    },
    SLOW,
  );

  it(
    "an entry someone took out shows off even while its access is live, and turning it on writes it again",
    async () => {
      expect((await turn("claude-code", true)).result.outcomes).toMatchObject([{ result: "done" }]);
      const file = join(w.user, ".claude.json");
      const doc = JSON.parse(readFileSync(file, "utf8")) as { mcpServers: Record<string, unknown> };
      delete doc.mcpServers[MCP_SERVER_KEY];
      writeFileSync(file, JSON.stringify(doc));
      expect(row(await look(), "claude-code").tools).toMatchObject({
        on: false,
        change: "add",
        why: "missing",
      });
      expect((await turn("claude-code", true)).result.outcomes).toMatchObject([{ result: "done" }]);
      expect(row(await look(), "claude-code").tools).toMatchObject({ on: true, change: "remove" });
      expect(claudeEntry(w.user)).toBeDefined();
      await turn("claude-code", false);
    },
    SLOW,
  );
});

describe("[A7.3.12.m5-12.page-desktop] Several Claude Desktop files: the person picks one with its switch", () => {
  it.skipIf(process.platform !== "win32")(
    "each file can take the tools, none is proposed, and moving them is one apply",
    async () => {
      const w = await world("desktop", (root) => ({
        LOCALAPPDATA: join(root, "local"),
        APPDATA: join(root, "roaming"),
      }));
      try {
        // The current app's folder and a classic install's, both with a file.
        const files = [
          join(w.user, "..", "local", "Claude-Data", "claude_pkg7"),
          join(w.user, "..", "roaming", "Claude"),
        ].map((folder) => {
          mkdirSync(folder, { recursive: true });
          const file = join(folder, "claude_desktop_config.json");
          writeFileSync(file, "{}");
          return file;
        });
        const has = (file: string) =>
          (JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, unknown> })
            .mcpServers?.["ttasks"] !== undefined;
        const made = await call<{ id: string }>(w, "/api/v1/space/create", {
          name: "Mira",
          folder: join(w.home, "mira"),
        });
        const space = made.result.id;
        const desktops = (view: AppsView) => view.rows.filter((r) => r.app === "claude-desktop");

        const seen = (await call<AppsView>(w, "/api/v1/machine/apps", { space })).result;
        expect(desktops(seen).map((r) => r.tools)).toEqual([
          expect.objectContaining({ on: false, change: "add", why: "several" }),
          expect.objectContaining({ on: false, change: "add", why: "several" }),
        ]);
        const [first, second] = desktops(seen);
        if (first === undefined || second === undefined) throw new Error("two Desktop rows");
        const one = await call<Applied>(w, "/api/v1/machine/apps_apply", {
          space,
          changes: [{ key: first.key, part: "tools", on: true, plan: first.tools?.plan }],
        });
        expect(one.result.outcomes.map((o) => o.result)).toEqual(["done"]);
        expect(files.map(has)).toEqual([true, false]);

        // Moved to the other file: out of the first and into the second in one apply.
        const [on, off] = desktops(one.result.view);
        const moved = await call<Applied>(w, "/api/v1/machine/apps_apply", {
          space,
          changes: [
            { key: on?.key, part: "tools", on: false, plan: on?.tools?.plan },
            { key: off?.key, part: "tools", on: true, plan: off?.tools?.plan },
          ],
        });
        expect(moved.result.outcomes.map((o) => o.result)).toEqual(["done", "done"]);
        expect(files.map(has)).toEqual([false, true]);
      } finally {
        await w.close();
      }
    },
    SLOW,
  );
});

describe("[A7.3.12.m5-12.page-env] The agent apps are looked for in the person's environment", () => {
  it("brings the person's environment up to date before it is read", async () => {
    const base = new FixedEnvironment({ kind: "user", env: { PATH: "/person/bin" } });
    expect(await personEnv(base)).toEqual({ PATH: "/person/bin" });
    expect(base.prepared).toBe(1);
  });
});
