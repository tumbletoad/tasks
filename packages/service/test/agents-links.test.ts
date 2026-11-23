// The Agent Monitor's agents linked to the tasks TTasks started them for, through the service: two
// spaces, launches and runs recorded through their operations, and the test kit's fake `ttam`
// reporting sessions with the IDs those records hold. A link needs the agent app, the home and the
// session to name one task; the page gets the task, never the session ID. Fixture data only.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentsPicture, AgentsSession } from "@ttasks/contracts/monitor";
import { RUN_LIMITS } from "@ttasks/contracts/runs";
import { SpaceExecutionStore } from "@ttasks/launch";
import { fakeTtam, ttamAgent, ttamHome } from "@ttasks/testkit";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { HttpTimerKind } from "../src/http/index.ts";
import { testClock } from "./clock.ts";
import { instanceToml } from "./harness.ts";
import { homeDigest } from "../src/setup/agents.ts";
import { httpWorld, openFeed, signIn, type FeedClient, type HttpWorld } from "./http-world.ts";

const LOOKED = { agents: true, visible: true, focused: true };
const HASH = "0123456789abcdef".repeat(4);

/** Session IDs as the agent apps write them: invented. */
const ID = {
  terminal: "aaaaaaaa-1111-4111-8111-000000000001",
  thread: "019a0000-0000-7000-8000-00000000000b",
  run: "019a0000-0000-7000-8000-00000000000c",
  missing: "aaaaaaaa-1111-4111-8111-000000000004",
  shared: "aaaaaaaa-1111-4111-8111-000000000005",
  twin: "aaaaaaaa-1111-4111-8111-000000000006",
  ended: "aaaaaaaa-1111-4111-8111-000000000007",
  trashed: "aaaaaaaa-1111-4111-8111-000000000008",
  moved: "aaaaaaaa-1111-4111-8111-000000000009",
  homeless: "aaaaaaaa-1111-4111-8111-00000000000a",
} as const;

let w: HttpWorld;
let dir: string;
let feed: FeedClient;
/** The agent homes the instances name in machine.toml. */
let homes: { claude: string; other: string; twin: string; codex: string };
const homeOfInstance = (instance: string): string =>
  ({
    "claude-work": homes.claude,
    "claude-other": homes.other,
    "claude-twin": homes.twin,
    "codex-work": homes.codex,
  })[instance] ?? "";
const tasks = new Map<string, { id: string; ref: string; space: string }>();
let n = 0;
const rid = () => `fixture-links-${String((n += 1)).padStart(6, "0")}`;

async function addTask(space: string, title: string): Promise<void> {
  const user = await w.user();
  const added = (await user.call(
    "op/call",
    { space, op: "task.add", input: { tasks: [{ title }], request_id: rid() } },
    { timeoutMs: 60_000 },
  )) as { tasks: { id: string; ref: string }[] };
  const task = added.tasks[0];
  if (task === undefined) throw new Error("no task was added");
  tasks.set(title, { ...task, space });
}

async function storeOf(space: string): Promise<SpaceExecutionStore> {
  const served = w.service.ops.spaces().find((s) => s.name === space);
  const writer = served?.writer;
  if (writer === undefined || served?.id === undefined) throw new Error(`${space} is not open`);
  const machine = w.service.ops.machine.id;
  return new SpaceExecutionStore({
    writer,
    spaceId: served.id,
    credential: {
      scope_id: `links:${machine}`,
      principal_id: await writer.actor("human", "user"),
      actor_kind: "human",
      machine_id: machine,
      origin: "ui",
    },
  });
}

/**
 * A terminal launch of `title`'s task with `instance`, its record holding `evidence` and the agent
 * home its click started the app in: by default the one the instance names now, null for none.
 */
async function launch(
  title: string,
  instance: string,
  evidence: { preset?: string; thread?: string },
  ended = false,
  home: string | null = homeOfInstance(instance),
): Promise<void> {
  const task = tasks.get(title);
  if (task === undefined) throw new Error(`no task ${title}`);
  const store = await storeOf(task.space);
  const machine = w.service.ops.machine.id;
  const base = { task: task.id, machine, instance, route: "terminal" as const, place: null };
  const prepared = await store.createIntent(
    {
      ...base,
      taskVersion: 1,
      briefHash: HASH,
      evidence: {
        ...(evidence.preset === undefined ? {} : { preset: evidence.preset }),
        ...(home === null ? {} : { home: homeDigest(process.platform, home) }),
      },
    },
    rid(),
  );
  const dispatching = await store.transitionIntent(prepared.id, "prepared", "dispatching");
  const dispatched = await store.transitionIntent(dispatching.id, "dispatching", "dispatched");
  await store.transitionIntent(dispatched.id, "dispatched", "confirmed", {
    evidence: {
      folder_checked: true,
      ...(evidence.thread === undefined ? {} : { thread: evidence.thread }),
      ...(ended ? { ran_ms: 60_000 } : {}),
    },
  });
}

/**
 * A backup of `title`'s space restored beside it, then the task trashed in the original: the
 * restored copy still holds the task and its launch.
 */
async function trashAfterRestore(title: string): Promise<void> {
  const task = tasks.get(title);
  const served = w.service.ops.spaces().find((s) => s.name === task?.space);
  const writer = served?.writer;
  if (task === undefined || served?.id === undefined || served.folder === undefined || !writer) {
    throw new Error(`no task ${title}`);
  }
  const user = await w.user();
  const call = { timeoutMs: 120_000 };
  const backup = (await user.call("space/backup", { space: served.folder }, call)) as {
    backup: { name: string };
  };
  await user.call(
    "space/restore",
    { backup: backup.backup.name, to: join(w.root, "s", "restored"), of: served.folder },
    call,
  );
  const got = (await user.call("op/call", {
    space: task.space,
    op: "task.get",
    input: { task: task.ref },
  })) as { as_of: unknown };
  const result = await writer.submit({
    space_id: served.id,
    request_id: rid(),
    actor: {
      scope_id: `links:${w.service.ops.machine.id}`,
      principal_id: await writer.actor("human", "user"),
      actor_kind: "human",
      machine_id: w.service.ops.machine.id,
      origin: "ui",
    },
    ops: [{ kind: "task.delete", task: task.id }],
    base: got.as_of,
  });
  if (result.status !== "applied") throw new Error(JSON.stringify(result));
}

/** A background run of `title`'s task that reported `nativeId` and has ended. */
async function run(title: string, nativeId: string): Promise<void> {
  const task = tasks.get(title);
  if (task === undefined) throw new Error(`no task ${title}`);
  const store = await storeOf(task.space);
  // No round of the service's runs takes this record while the test moves it.
  const hold = w.service.runs.hold();
  const queued = await store.createRun(
    {
      task: task.id,
      routine: null,
      machine: w.service.ops.machine.id,
      instance: "codex-work",
      adapter: "codex",
      place: null,
      request: "Fixture request",
      briefHash: HASH,
      permission: "full-access",
      limits: RUN_LIMITS.task,
    },
    rid(),
  );
  const starting = await store.transitionRun(
    queued.id,
    { state: "queued", version: queued.version },
    "starting",
  );
  const running = await store.transitionRun(
    starting.id,
    { state: "starting", version: starting.version },
    "running",
    { evidence: { native_id: nativeId, home: homeDigest(process.platform, homes.codex) } },
  );
  await store.transitionRun(
    running.id,
    { state: "running", version: running.version },
    "succeeded",
    {
      result: {
        ok: true,
        outcome: "success",
        exitCode: 0,
        signal: null,
        nativeId,
        text: "Fixture answer",
        error: null,
        usage: null,
        appTools: null,
        declined: 0,
        permissionDenials: 0,
        durationMs: 1,
      },
    },
  );
  hold.release();
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ttasks-links-"));
  homes = {
    claude: join(dir, "claude-home"),
    other: join(dir, "claude-other"),
    twin: join(dir, "claude-twin"),
    codex: join(dir, "codex-home"),
  };
  const agents = join(dir, "agents.json");
  const fake = fakeTtam({ agents, maxMs: 600_000 });
  const toml = [
    ["claude-work", "claude-cli", { CLAUDE_CONFIG_DIR: homes.claude }],
    ["claude-other", "claude-cli", { CLAUDE_CONFIG_DIR: homes.other }],
    ["claude-twin", "claude-cli", { CLAUDE_CONFIG_DIR: homes.twin }],
    ["codex-work", "codex-cli", { CODEX_HOME: homes.codex }],
  ]
    .map(([id, target, env]) =>
      instanceToml({
        id: id as string,
        target: target as string,
        label: `Fixture ${id as string}`,
        exec: process.execPath,
        env: env as Record<string, string>,
      }),
    )
    .join("");
  const clock = testClock<HttpTimerKind>({ virtual: ["monitor_ask", "monitor_keep"] });
  w = await httpWorld(
    "agents-links",
    { timers: clock.timers, steady: () => clock.now },
    {
      toml,
      launch: { terminal: () => Promise.resolve({ kind: "accepted" as const }) },
      monitor: {
        command: () =>
          Promise.resolve({
            ok: true,
            file: fake.file,
            args: fake.args,
            env: process.env,
            cwd: dir,
          }),
      },
    },
  );
  const user = await w.user();
  await user.call(
    "space/create",
    { name: "Studio", path: join(w.root, "s", "studio"), ref_prefix: "S" },
    { timeoutMs: 60_000 },
  );
  for (const title of [
    "Terminal",
    "Thread",
    "Missing",
    "Shared",
    "Twin",
    "Ended",
    "Trashed",
    "Moved",
    "Homeless",
  ]) {
    await addTask("Mira", title);
  }
  for (const title of ["Run", "Shared too"]) await addTask("Studio", title);
  await launch("Terminal", "claude-work", { preset: ID.terminal });
  await launch("Thread", "codex-work", { thread: ID.thread });
  await launch("Missing", "claude-other", { preset: ID.missing });
  await launch("Shared", "claude-work", { preset: ID.shared });
  await launch("Shared too", "claude-work", { preset: ID.shared });
  await launch("Twin", "claude-twin", { preset: ID.twin });
  await launch("Ended", "claude-work", { preset: ID.ended }, true);
  await run("Run", ID.run);
  await launch("Trashed", "claude-work", { preset: ID.trashed });
  await trashAfterRestore("Trashed");
  // Started in a home the instance named then; machine.toml names another one now.
  await launch("Moved", "claude-work", { preset: ID.moved }, false, join(dir, "claude-before"));
  // A record from before the click recorded its home.
  await launch("Homeless", "claude-work", { preset: ID.homeless }, false, null);

  const agent = (row: string, provider: string, home: string, session: string, name: string) =>
    ttamAgent({ row, provider, home, session, name, activity: "working" });
  writeFileSync(
    agents,
    JSON.stringify({
      homes: [
        ttamHome({ id: "claude-test", provider: "claude", path: homes.claude }),
        ttamHome({ id: "codex-test", provider: "codex", path: homes.codex }),
        // Two of TTAM's homes at one path: which one the twin's launch used is not known.
        ttamHome({ id: "twin-a", provider: "claude", path: homes.twin }),
        ttamHome({ id: "twin-b", provider: "claude", path: homes.twin }),
      ],
      agents: [
        agent("a-terminal", "claude", "claude-test", ID.terminal, "Fixture terminal agent"),
        ttamAgent({
          row: "a-inside",
          parent: "a-terminal",
          kind: "subagent",
          provider: "claude",
          home: "claude-test",
          session: ID.terminal,
          name: "Fixture agent inside",
          activity: "working",
        }),
        agent("b-thread", "codex", "codex-test", ID.thread, "Fixture thread agent"),
        agent("c-run", "codex", "codex-test", ID.run, "Fixture run agent"),
        agent("d-missing", "claude", "claude-test", ID.missing, "Fixture missing home"),
        agent("e-shared", "claude", "claude-test", ID.shared, "Fixture shared session"),
        agent("f-twin", "claude", "twin-a", ID.twin, "Fixture twin home"),
        agent("g-ended", "claude", "claude-test", ID.ended, "Fixture ended launch"),
        agent("i-trashed", "claude", "claude-test", ID.trashed, "Fixture trashed task"),
        agent("j-moved", "claude", "claude-test", ID.moved, "Fixture moved home"),
        agent("k-homeless", "claude", "claude-test", ID.homeless, "Fixture no home recorded"),
        // A Claude session ID of a launch, under Codex: another app's session.
        agent("h-other-app", "codex", "codex-test", ID.terminal, "Fixture other app"),
      ],
    }),
  );
  const { token } = await signIn(w);
  feed = await openFeed(w.port(), token);
  await feed.next((m) => m["type"] === "hello");
  feed.send({ type: "watch", ...LOOKED });
}, 180_000);

afterAll(async () => {
  feed.ws.close();
  await w.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

async function picture(): Promise<AgentsPicture> {
  for (;;) {
    const next = (await feed.next((m) => m["type"] === "agents")) as unknown as {
      picture: AgentsPicture | null;
    };
    if (next.picture !== null) return next.picture;
  }
}

const byTitle = (p: AgentsPicture, title: string): AgentsSession | undefined =>
  p.sessions.find((s) => s.title === title);

const linked = (title: string) => {
  const task = tasks.get(title);
  return task === undefined ? undefined : { id: task.id, ref: task.ref };
};

describe("[A5.agents.links] each agent of the monitor is shown with the task TTasks started it for", () => {
  test("by app, home and session together, in every open space; nothing that could be two tasks", async () => {
    const p = await picture();
    const mira = w.service.ops.spaces().find((s) => s.name === "Mira")?.id;
    const studio = w.service.ops.spaces().find((s) => s.name === "Studio")?.id;
    // A Claude Code terminal launch by the session ID its click preset, with its agent inside.
    expect(byTitle(p, "Fixture terminal agent")?.task).toEqual({
      space: mira,
      spaceName: "Mira",
      ...linked("Terminal"),
      started: "terminal",
    });
    expect(byTitle(p, "Fixture terminal agent")?.nested.map((a) => a.title)).toEqual([
      "Fixture agent inside",
    ]);
    // A Codex terminal launch by the thread its session file named.
    expect(byTitle(p, "Fixture thread agent")?.task).toMatchObject({
      ...linked("Thread"),
      started: "terminal",
    });
    // A background run in the other space, by the session ID it reported.
    expect(byTitle(p, "Fixture run agent")?.task).toEqual({
      space: studio,
      spaceName: "Studio",
      ...linked("Run"),
      started: "run",
    });
    // A launch whose agent ended still links its session: the person may have resumed it.
    expect(byTitle(p, "Fixture ended launch")?.task).toMatchObject(linked("Ended") ?? {});
    // A home TTAM does not list, one two of its homes could be, a session two tasks hold, the
    // same ID under another app, a task trashed in the space but kept in a restored copy of it, a
    // home that is not the one the launch recorded, and a record without one: no link.
    for (const title of [
      "Fixture trashed task",
      "Fixture moved home",
      "Fixture no home recorded",
      "Fixture missing home",
      "Fixture twin home",
      "Fixture shared session",
      "Fixture other app",
    ]) {
      expect(byTitle(p, title)?.task, title).toBeNull();
    }
    // The recording's own agents were not started by TTasks.
    expect(byTitle(p, "Release checklist")?.task).toBeNull();
    // Nothing of a session's ID or a home's path reaches the page.
    const sent = JSON.stringify(feed.messages.filter((m) => m["type"] === "agents"));
    for (const id of Object.values(ID)) expect(sent).not.toContain(id);
    expect(sent).not.toContain(JSON.stringify(dir).slice(1, -1));
    const log = readFileSync(w.service.log.path, "utf8");
    for (const id of Object.values(ID)) expect(log).not.toContain(id);
  }, 120_000);
});
