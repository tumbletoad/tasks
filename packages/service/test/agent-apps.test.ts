// The page's agent apps and New space against a real service in this process, over HTTP as the
// page calls them: only the person may call them, a switch is applied only as the person saw it,
// and what one click adds the next one takes out again. Scratch homes and fake agent commands
// only (testkit's fake-agents.ts): no real agent home is read or written.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLI_NAME } from "@ttasks/brand";
import { installFakeAgents } from "@ttasks/testkit/fake-agents";
import { FixedEnvironment } from "@ttasks/launch";
import {
  agentAppVerbs,
  personEnv,
  type AgentAppsHost,
  type AppsView,
} from "../src/hub/agent-apps.ts";
import { startService, type RunningService } from "../src/hub/service.ts";
import { configOf, removeRuntimeDir, serviceEnv, tempRoot } from "./harness.ts";
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

/** TTasks's entry in the scratch Claude Code home, or undefined. */
const claudeEntry = (user: string): { args?: unknown } | undefined =>
  (
    JSON.parse(readFileSync(join(user, ".claude.json"), "utf8")) as {
      mcpServers?: Record<string, { args?: unknown }>;
    }
  ).mcpServers?.["tasks"];

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
      expect(claude.tools?.detail.join("\n")).toContain("mcp add");
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
            .mcpServers?.["tasks"] !== undefined;
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
