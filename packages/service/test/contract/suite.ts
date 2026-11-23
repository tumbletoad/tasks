// The contract suite of the request path (A3 3.2.1: every entry's examples are "used by tests and
// docs"; A7 3.8 M1.10, 3.9 M2.03). It is written against a transport, so every face runs the same
// suite: the request path in-process, ttasks-local/1's op/call, the CLI's --json, MCP in both eras
// and HTTP (M2.12). Import it from `@ttasks/service/test/contract` and pass a transport over a
// `contractWorld`.
//
// It builds the examples' world through the transport itself (only registry operations), as far
// as this build's operations can: Mira's tasks M-1 to M-15, with M-3 completed, M-14 and M-15
// given the portal as their folder, and M-14's notes, log entries, source and
// receipts. Then every example of every entry runs:
//
// - VERIFIED examples give a result that matches the entry's output schema and the documented
//   result in what it means: the outcome words, the references, the entries, the counts. Values
//   the example world cannot reproduce (IDs, `as_of`, times, version numbers, the folder) are
//   compared by form; an example's `base` stands for "the as_of of a read just before" and its
//   `cwd` for the world's portal folder.
// - LATER examples need a feature a later step builds. Each names that step and the outcome it
//   gives now. When the step lands, that outcome changes, the suite fails, and the step moves its
//   example to VERIFIED. No example can be left out: the suite fails on an example in neither list.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CLI_NAME } from "@ttasks/brand";
import { readsOnly, registry, type ErrorBody } from "@ttasks/contracts";
import { presetSession, SHIM_METHODS, type Attachment, type SpawnPlan } from "@ttasks/launch";
import type { RpcSession } from "@ttasks/bridge/protocol";
import type { HttpStart } from "../../src/http/index.ts";
import { startService, type RunningService, type StartOptions } from "../../src/hub/service.ts";
import { renderError } from "../../src/mcp/index.ts";
import { opCall } from "../../src/ops/index.ts";
import { removeRuntimeDir, serviceEnv, tempRoot } from "../harness.ts";
import { bridge, launchContext } from "../agents.ts";
import { agentHomeOf, classSession, grantHome, revokeHome } from "../ops-helpers.ts";

/** The request IDs of the registry's examples (contracts' entries/fixture.ts). */
const requestIdOf = (n: number): string =>
  `7f3c2a10-5d4e-4b8a-9c61-2e0f3a7b${String(n).padStart(4, "0")}`;

/** Who calls: the example's actor. The transport maps it to a connection class of its face. */
export type Actor = "agent" | "user";

/** A transport's failure with A3's error body (A3 3.5). */
export class ContractError extends Error {
  readonly body: ErrorBody;
  constructor(body: ErrorBody) {
    super(body.message);
    this.name = "ContractError";
    this.body = body;
  }
}

export interface ContractTransport {
  /** Calls one entry in the world's one space. Resolves with the result, or rejects with ContractError. */
  call(entry: string, input: Record<string, unknown>, actor: Actor): Promise<unknown>;
  /** The folder that stands for the examples' working folder (`contractWorld`'s portal). */
  readonly portal: string;
  /** A launch reference for the task in the world, for an example's `launch` (`ContractWorld.launch`). */
  launch(task: string): Promise<string>;
  /** Gives the task the portal as its folder here, as the person does (`ContractWorld.folder`). */
  folder(task: string): Promise<void>;
  /**
   * Whether the face carries an entry at all. One it does not (a UI-only entry has no command)
   * has no examples on it. Default: every entry.
   */
  carries?(entry: string): boolean;
  /**
   * The face sends every write a second time itself and checks that answer against the first, as
   * MCP checks its text against the replayed result. Default: the suite sends it again.
   */
  readonly replays?: true;
  close(): Promise<void>;
}

/** A service in this process for the suite, with its home, endpoint and portal folder. */
export interface ContractWorld {
  readonly service: RunningService;
  readonly home: string;
  readonly path: string;
  /** The space's ID. */
  readonly space: string;
  /** `<work>/lumen/portal`: an existing folder of this machine. */
  readonly portal: string;
  /**
   * Gives `task` (a reference) the portal as its own folder on this machine, as the person does
   * in the page: through the request path in this process, since not every face carries it.
   */
  folder(task: string): Promise<void>;
  /**
   * A terminal launch of `task` (a reference or ID) as a real click makes one: on an instance of its
   * own, with the instance's agent home (`agentHomeOf`) recorded at the click and registered for the
   * world's space as setup does, unless `home` asks for one of the other homes. Opened, dispatched
   * and claimed in this process as its shim would claim it (the world's terminal keeps the ticket,
   * its process probe says every process lives), and unless `started` is false its agent started:
   * what a launched agent holds. With `claimed` false no shim claims it: its Brief reached no agent.
   */
  launch(task: string, options?: LaunchAsks): Promise<WorldLaunch>;
  /** A second space, Life (prefix L), made the first time it is asked for. */
  other(): Promise<string>;
  close(): Promise<void>;
}

/** A launch of the world: its reference, the ticket its agent got, and the shim's attachment. */
export interface WorldLaunch {
  readonly id: string;
  readonly reference: string;
  readonly ticket: string;
  /** The shim's attachment, once claimed. */
  readonly attachment: Attachment | undefined;
  /** The instance the click chose, and the app and home folder it recorded (none without). */
  readonly instance: string;
  readonly app: string | undefined;
  readonly home: string | undefined;
  /** The agent-home row the world registered for its home, revoked for `revoked`. */
  readonly row: string | undefined;
  /** The session ID the click preset for Claude Code, when asked for. */
  readonly preset: string | undefined;
}

/**
 * The agent home a world launch is opened on:
 * - `registered`: its app and home recorded, and a live row of its instance for the world's space;
 * - `no-app`: the click recorded its home but no app;
 * - `no-row`: its app and home recorded, and setup never registered the home;
 * - `revoked`: registered, then the row revoked as `ttasks setup agents --remove` does;
 * - `other-space`: registered for the world's second space (`other()`), while the launch is in the
 *   world's own.
 */
export const WORLD_HOMES = ["registered", "no-app", "no-row", "revoked", "other-space"] as const;
export type WorldHome = (typeof WORLD_HOMES)[number];

/** How far a world launch goes, and on which home: claimed, started and registered by default. */
export interface LaunchAsks {
  readonly claimed?: boolean;
  readonly started?: boolean;
  readonly home?: WorldHome;
  /** The click presets a session ID, as it does for Claude Code in a terminal. */
  readonly preset?: boolean;
}

/** The start time the world's process probe reports for every process. */
export const WORLD_START = "windows:1";

/** The plan of a world launch: nothing is ever started from it. */
const WORLD_PLAN: SpawnPlan = {
  argv: [process.execPath],
  folder: null,
  env: {},
  title: "Fixture launch",
  afterExit: "close",
};

/**
 * The examples' machine and space: a service in this process, a temporary folder holding
 * `work/lumen/portal`, and one space, Mira (prefix M), created by the user. Every folder and file
 * is created with its mode, so the umask does not matter.
 */
export async function contractWorld(
  label: string,
  options: {
    /** Start the UI listener too, on a port the OS chooses, never persisted. */
    readonly http?: HttpStart;
    /** Launching's clock and more, over the world's terminal and probe. */
    readonly launch?: StartOptions["launch"];
  } = {},
): Promise<ContractWorld & { readonly root: string }> {
  const temp = tempRoot(label);
  const home = join(temp.root, "h");
  const work = join(temp.root, "work");
  const portal = join(work, "lumen", "portal");
  mkdirSync(portal, { recursive: true, mode: 0o700 });
  const tickets = new Map<string, string>();
  const service = await startService({
    env: serviceEnv(home),
    identity: () => ({ root: false, elevated: false, package: null }),
    maintenance: false,
    say: () => undefined,
    // A terminal that keeps the ticket and starts nothing, and a probe for which every process
    // lives: the world claims its launches itself.
    launch: {
      terminal: ({ intent, ticket }) => {
        tickets.set(intent.id, ticket);
        return Promise.resolve({ kind: "accepted" });
      },
      probe: {
        startTimes: (pids) => Promise.resolve(new Map(pids.map((pid) => [pid, WORLD_START]))),
      },
      ...options.launch,
    },
    ...(options.http === undefined
      ? {}
      : { http: { ports: [0], persist: false, ...options.http } }),
  });
  const user = await classSession(home, service.endpoint.path, "cli-interactive");
  let created: { space?: { id?: string }; id?: string };
  try {
    created = (await user.call(
      "space/create",
      { name: "Mira", path: join(temp.root, "s", "mira"), ref_prefix: "M" },
      { timeoutMs: 120_000 },
    )) as typeof created;
  } finally {
    user.close();
  }
  const space = created.space?.id ?? created.id ?? "";
  const path = service.endpoint.path;
  // The person's session that registers the launches' homes, as setup does: one for the world.
  let setupSession: Promise<RpcSession> | undefined;
  const person = (): Promise<RpcSession> =>
    (setupSession ??= classSession(home, path, "cli-interactive"));
  let otherSpace: Promise<string> | undefined;
  const other = (): Promise<string> =>
    (otherSpace ??= (async () => {
      const operator = await classSession(home, path, "cli-interactive");
      try {
        const made = (await operator.call(
          "space/create",
          { name: "Life", path: join(temp.root, "s", "life"), ref_prefix: "L" },
          { timeoutMs: 120_000 },
        )) as { space: { id: string } };
        return made.space.id;
      } finally {
        operator.close();
      }
    })());
  let launches = 0;
  const launch = async (task: string, launchOptions: LaunchAsks = {}): Promise<WorldLaunch> => {
    // In the world's space by its ID: a test may serve more spaces beside it.
    const read = (await opCall(
      service.ops,
      { class: "cli-interactive", env: {} },
      { op: "task.get", input: { task, sections: ["history"] }, space },
    )) as { task: { id: string } };
    // Taken once: launches opened at the same time each keep their own number across the awaits.
    const number = (launches += 1);
    // An instance of its own, so a second launch of a task while the first is still opening is a
    // launch of its own rather than the first one again. One home per instance, as setup has it.
    const instance = `contract-agent-${String(number)}`;
    const agent = agentHomeOf(home, instance);
    const kind = launchOptions.home ?? "registered";
    let row: string | undefined;
    if (kind !== "no-app" && kind !== "no-row") {
      const setup = await person();
      const where = kind === "other-space" ? await other() : space;
      row = await grantHome(home, path, { instance, space: where }, setup);
      if (kind === "revoked" && (await revokeHome(home, path, [row], setup)) !== 1) {
        throw new Error("the row was not revoked");
      }
    }
    const request = `contract-launch-${String(number).padStart(6, "0")}`;
    const preset = launchOptions.preset === true ? presetSession(space, request) : undefined;
    const given = {
      ...(kind === "no-app" ? { home: agent.home } : agent),
      ...(preset === undefined ? {} : { preset }),
    };
    const intent = await service.launches.open(
      space,
      {
        task: read.task.id,
        instance,
        route: "terminal",
        place: null,
        taskVersion: 1,
        briefHash: "c".repeat(64),
      },
      request,
      WORLD_PLAN,
      given,
    );
    const made = {
      instance,
      app: kind === "no-app" ? undefined : agent.app,
      home: agent.home,
      row,
      preset,
    };
    await service.launches.dispatch(space, intent.id);
    const ticket = tickets.get(intent.id);
    if (ticket === undefined) throw new Error("the launch was not dispatched to its terminal");
    if (launchOptions.claimed === false) {
      return { id: intent.id, reference: intent.reference, ticket, attachment: undefined, ...made };
    }
    const claimed = await service.launches.host.claim(
      { ticket, role: "shim", pid: process.pid, start_time: WORLD_START },
      () => Promise.resolve(),
    );
    if (claimed.kind !== "claimed") throw new Error(`the claim was refused: ${claimed.reason}`);
    if (launchOptions.started !== false) {
      const started = await service.launches.host.report(claimed.attachment, SHIM_METHODS.started, {
        pid: process.pid,
        started_at: Date.now(),
      });
      if (started.kind !== "applied") throw new Error("the agent's start was not recorded");
    }
    return {
      id: intent.id,
      reference: intent.reference,
      ticket,
      attachment: claimed.attachment,
      ...made,
    };
  };
  let folders = 0;
  const folder = async (task: string): Promise<void> => {
    folders += 1;
    await opCall(
      service.ops,
      { class: "cli-interactive", env: {} },
      {
        op: "folder.manage",
        input: {
          action: "set",
          task,
          folder: portal,
          request_id: `contract-folder-${String(folders).padStart(6, "0")}`,
        },
        space,
      },
    );
  };
  return {
    service,
    home,
    path: service.endpoint.path,
    space,
    portal,
    root: temp.root,
    folder,
    launch,
    other,
    close: async () => {
      if (setupSession !== undefined) (await setupSession).close();
      await service.stop();
      removeRuntimeDir(service);
      temp.cleanup();
    },
  };
}

/** What one example gives in M1 when its feature is a later step's. */
interface Later {
  readonly owner: string;
  readonly why: string;
  /** The outcome now: a result that matches the output schema, or an error code. */
  readonly now: { readonly error: string } | { readonly result: "schema" };
}

/** Examples by `<entry> <index>`. */
const LATER: Readonly<Record<string, Later>> = {
  "space.status 0": {
    owner: "the step that makes here read folders",
    why: "here lists the tasks placed at the working folder, and the world's tasks have folders",
    now: { result: "schema" },
  },
  "space.status 1": {
    owner: "a world in which only M-14 changed since the example's time",
    why: "every task of the world was made after the example's since, so all of them changed",
    now: { result: "schema" },
  },
  "launch.open 0": {
    owner: "the step that makes Open use folders",
    why: "the brief's folder line names the task's place, and the world's tasks have folders",
    now: { result: "schema" },
  },

  "task.add 0": {
    owner: "a world whose M-14 holds the ticket jira:LUM-212 and sits in Lumen Health",
    why:
      "the second draft matches M-14 by that ticket, and the first warns of M-14 in its project; " +
      "the world's M-14 has neither, so both drafts are created, in a new area and project",
    now: { result: "schema" },
  },
  "group.manage 0": {
    owner:
      "a world that holds Mira's areas and projects (Lumen Health, Brightside Bikes, Learning)",
    why: "the world's groups are the ones its own examples create, with other counts",
    now: { result: "schema" },
  },
  "run.report 0": {
    owner: "M6.06 (run and routine bindings)",
    why: "no connection is bound to a run before M6",
    now: { error: "not_permitted" },
  },
  "task.search 0": {
    owner: "the query design for word forms, and a world that holds Mira's areas and projects",
    why:
      "the rows need Mira's areas and projects, an earlier example reopens M-3, and the phrase " +
      '"time zone" does not find "time zones"',
    now: { result: "schema" },
  },
  "task.search 1": {
    owner:
      "the step that gives task.delete a face (A5's Trash, M5), with a cursor of the world's own search",
    why: "the next page after a task was deleted, under the example's cursor",
    now: { error: "cursor_expired" },
  },
};

const VERIFIED = new Set([
  "space.status 2",
  "task.get 0",
  "task.get 1",
  "task.get 2",
  "task.finished 0",
  "task.finished 1",
  "task.finished 2",
  "task.update 0",
  "entry.add 0",
  "entry.add 1",
  "note.remove 0",
  "note.remove 1",
  "task.finish 0",
  "task.finish 1",
  "task.reopen 0",
  "receipt.get 0",
  "receipt.get 1",
  "receipt.get 2",
  "group.manage 1",
  "folder.manage 0",
  "prefs.manage 0",
  "prefs.manage 1",
  "history.undo 0",
  "history.redo 0",
  "task.delete 0",
  "task.delete 1",
  "task.trash 0",
]);

type Value = Record<string, unknown>;

const refs = (list: unknown, key = "ref"): unknown[] =>
  Array.isArray(list) ? (list as Value[]).map((item) => item[key]) : [];

/** What a result means, per entry: the parts an example documents that a world can reproduce. */
function meaning(entry: string, value: Value): unknown {
  switch (entry) {
    case "space.status": {
      const counts = value["counts"] as Value;
      return {
        // The instance and app depend on the face (an MCP entry names them; the CLI has none).
        session: (value["session"] as Value)["state"],
        here: ((value["here"] as Value[] | undefined) ?? []).map((row) => [
          row["ref"],
          row["match"],
        ]),
        statuses: refs(counts["statuses"], "status"),
        sections: ((value["sections"] as Value[] | undefined) ?? []).map((s) => [
          s["name"],
          refs(s["tasks"]),
        ]),
        hint: typeof value["hint"] === "string",
        // The skills read with their text: the list depends on the person's own files.
        asked: ((value["asked"] as Value[] | undefined) ?? []).map((s) => [
          s["name"],
          typeof s["text"],
        ]),
        missing: value["missing"],
      };
    }
    case "task.finished":
      return {
        rows: ((value["rows"] as Value[] | undefined) ?? []).map((r) => [
          r["ref"],
          r["lifecycle"],
          r["wrap_state"],
          typeof r["finished_at"],
        ]),
        cursor: value["cursor"],
      };
    case "task.update":
      return {
        result: value["result"],
        task: value["task"],
        fields: value["fields"],
        warnings: (value["warnings"] as unknown[]).length,
      };
    case "task.get": {
      const sections = (value["sections"] ?? {}) as Value;
      const task = value["task"] as Value;
      return {
        view: value["view"],
        // The transport's connection is no launch's session: a reference reads, never binds.
        bound: value["bound"],
        task: { ref: task["ref"], lifecycle: task["lifecycle"], title: task["title"] },
        sections: Object.keys(sections).sort(),
        instructions: refs(sections["instructions"]),
        log: (sections["log"] as Value[] | undefined)?.map((e) => [e["ref"], e["kind"]]),
        history: Array.isArray(sections["history"]),
        // The task's own learnings and its wrap-up state, as its wrap-up left them.
        outcome:
          sections["outcome"] === undefined
            ? undefined
            : [
                (sections["outcome"] as Value)["wrap_state"],
                (sections["outcome"] as Value)["learnings"],
              ],
      };
    }
    case "entry.add":
      return {
        result: value["result"],
        task: value["task"],
        entry: value["entry"],
        kind: value["kind"],
      };
    case "task.finish":
      return {
        result: value["result"],
        task: value["task"],
        lifecycle: value["lifecycle"],
        wrap_state: value["wrap_state"],
        learnings: value["learnings"],
        // A follow-up's reference is the world's: compared by form.
        follow_ups: ((value["follow_ups"] as Value[] | undefined) ?? []).map((f) => [
          f["result"],
          typeof f["ref"],
          f["title"],
        ]),
      };
    case "group.manage":
      // The world's other groups and their counts are its own: the write and its group.
      return {
        action: value["action"],
        result: value["result"],
        group: [
          (value["group"] as Value | undefined)?.["kind"],
          (value["group"] as Value | undefined)?.["name"],
        ],
      };
    case "folder.manage": {
      // The folder is the world's portal, stored as this machine spells it.
      const owner = value["owner"] as Value;
      return {
        action: value["action"],
        result: value["result"],
        owner: [owner["kind"], owner["name"]],
        folder: typeof value["folder"],
      };
    }
    case "task.reopen":
      return {
        result: value["result"],
        task: value["task"],
        lifecycle: value["lifecycle"],
        status: value["status"],
      };
    case "launch.open": {
      // The reference and the folder are the world's: the brief's lines are compared by what they
      // say, with the reference and the folder's path as slots.
      const launch = value["launch"] as Value;
      const reference = String(launch["reference"]);
      const copy = typeof value["copy"] === "string" ? value["copy"] : "";
      return {
        launch: [
          launch["instance"],
          launch["route"],
          launch["state"],
          Object.keys(launch["at"] as Value),
        ],
        text: value["text"],
        copy: copy.replaceAll(reference, "{ref}").replace(/^Folder: .*$/mu, "Folder: {folder}"),
      };
    }
    case "prefs.manage":
      // Who may change a key is the caller's (as the UI, every example is the user's).
      return {
        action: value["action"],
        prefs: (value["prefs"] as Value[]).map((row) =>
          Object.fromEntries(Object.entries(row).filter(([field]) => field !== "writable")),
        ),
        result: value["result"],
      };
    case "history.undo":
    case "history.redo":
      // The user's newest change differs by face (as the UI, every example is the user's), so
      // the outcome and how many tasks it changed back, not which.
      return {
        result: value["result"],
        tasks: (value["tasks"] as unknown[]).length,
        task_count: value["task_count"],
        unresolved: value["unresolved"],
      };
    case "task.delete":
      return {
        result: value["result"],
        moved: value["moved"],
        already: value["already"],
        restored: (value["restored"] as Value[] | undefined)?.map((t) => [
          t["ref"],
          t["lifecycle"],
        ]),
        commit: typeof value["commit"],
      };
    case "note.remove":
      return { result: value["result"], task: value["task"], note: value["note"] };
    case "task.trash":
      return (value["rows"] as Value[]).map((r) => [
        r["ref"],
        (r["removed"] as Value)["by"],
        (r["removed"] as Value)["count"],
      ]);
    case "receipt.get":
      return {
        found: value["found"],
        status: value["status"],
        results: (value["results"] as Value[] | undefined)?.map((r) => [
          r["i"],
          r["status"],
          r["ref"],
        ]),
        conflicts: (value["conflicts"] as Value[] | undefined)?.map((c) => [
          c["entity"],
          c["ref"],
          c["field"],
        ]),
        cause: (value["error"] as Value | undefined)?.["cause"],
      };
    default:
      return value;
  }
}

const AS_OF = /^[0-9]{1,10}\.[0-9]{1,15}\.[0-9a-hjkmnp-tv-z]{8}$/;

// ---------------------------------------------------------------------------------------------
// The grant gate on every face that carries an agent home's call (A3 3.7.8)

/** A3 3.5's body for a space the agent home is not granted: one body, whatever the face. */
export const GRANT_BODY: ErrorBody = {
  code: "forbidden",
  message: "This agent is not registered for this space.",
  hint: `Ask the user to run: ${CLI_NAME} setup agents`,
  data: { rule: "grant" },
};

/**
 * A face's calls as an agent home that is not granted the world's space. A face that cannot carry
 * an agent home's call has none: HTTP is the UI's, and the UI is the user.
 */
export interface GrantTransport {
  /**
   * One call through the face: the refusal's body, or the text where the face gives only text
   * (MCP's tool result). Undefined when the call was not refused.
   */
  refused(entry: string, input: Record<string, unknown>): Promise<ErrorBody | string | undefined>;
  close(): Promise<void>;
}

/** A base the gate refuses before it is ever compared: the call reads nothing. */
const ANY_BASE = "1.1.00000000";

/**
 * Every agent tool's entry, with an input its agent audience accepts. `run_report` is refused as
 * `not_permitted` before any space is chosen, on every connection that is not a run's (A3 3.4.12),
 * so it tells a home of another space nothing either.
 */
const GRANT_CALLS: readonly [string, (n: number) => Record<string, unknown>][] = [
  ["space.status", () => ({})],
  ["task.search", () => ({ q: "status:open" })],
  ["task.get", () => ({ task: "M-1" })],
  [
    "task.add",
    (n) => ({
      tasks: [{ title: "Fixture task, refused." }],
      request_id: `contract-grant-${String(n).padStart(8, "0")}`,
    }),
  ],
  ["group.manage", () => ({ action: "list" })],
  ["prefs.manage", () => ({ action: "get" })],
  [
    "task.update",
    (n) => ({
      task: "M-1",
      set: { summary: "Fixture summary, refused." },
      base: ANY_BASE,
      request_id: `contract-grant-${String(n).padStart(8, "0")}`,
    }),
  ],
  [
    "entry.add",
    (n) => ({
      task: "M-1",
      kind: "progress",
      text: "Fixture progress, refused.",
      request_id: `contract-grant-${String(n).padStart(8, "0")}`,
    }),
  ],
  [
    "task.finish",
    (n) => ({
      task: "M-1",
      outcome: "Fixture outcome, refused.",
      base: ANY_BASE,
      request_id: `contract-grant-${String(n).padStart(8, "0")}`,
    }),
  ],
  [
    "task.reopen",
    (n) => ({
      task: "M-1",
      reason: "Fixture reason, refused.",
      base: ANY_BASE,
      request_id: `contract-grant-${String(n).padStart(8, "0")}`,
    }),
  ],
];

/**
 * `forbidden` with rule `grant` through one face (A3 3.7.8, 3.5): every agent tool's call from an
 * agent home that is not granted the world's space gives A3's body, or its text form where the
 * face has only text, and changes nothing.
 */
export function grantSuite(name: string, open: () => Promise<GrantTransport>): void {
  describe(name, () => {
    test(
      "[A3.3.7.grant.faces] every agent tool's call from a home that is not granted the space: forbidden, rule grant, A3's body",
      { timeout: 180_000 },
      async () => {
        // Every agent tool is called, but run_report, refused before any space is chosen.
        const tools = registry
          .filter((e) => e.actors === "agent" && e.faces.mcp !== undefined)
          .map((e) => e.name)
          .sort();
        expect(GRANT_CALLS.map(([entry]) => entry).sort()).toEqual(tools);
        const transport = await open();
        try {
          let n = 0;
          for (const [entry, input] of GRANT_CALLS) {
            const refused = await transport.refused(entry, input((n += 1)));
            if (typeof refused === "string") {
              expect(refused, entry).toBe(renderError(GRANT_BODY));
            } else {
              expect(refused, entry).toEqual(GRANT_BODY);
            }
          }
        } finally {
          await transport.close();
        }
      },
    );
  });
}

/**
 * A launched agent's session in the world's space whose agent home's row was revoked: a world
 * launch on its home registered as setup does, its bridge its session by its ticket through the
 * local endpoint, then the row revoked as `ttasks setup agents --remove` does. A shell's call
 * carrying the ticket is that session, so every one of them is refused with rule grant. The world
 * gets a task M-1 if it has none.
 */
export async function revokedSession(world: ContractWorld): Promise<{ readonly ticket: string }> {
  const added = (await opCall(
    world.service.ops,
    { class: "cli-interactive", env: {} },
    {
      op: "task.add",
      input: { tasks: [{ title: "Fixture task" }], request_id: rid() },
      space: world.space,
    },
  )) as { tasks: { ref: string }[] };
  const task = added.tasks[0]?.ref ?? "M-1";
  const launch = await world.launch(task);
  const agent = await bridge(world, launchContext(world.space, launch));
  if (agent.binding?.["state"] !== "bound") {
    throw new Error("the agent's bridge did not bind by its ticket");
  }
  await agent.close();
  if ((await revokeHome(world.home, world.path, [launch.row ?? ""])) !== 1) {
    throw new Error("the home's row was not revoked");
  }
  return { ticket: launch.ticket };
}

/** The body of a transport's failure, or the failure itself when it is no ContractError. */
function bodyOf(error: unknown): ErrorBody {
  if (error instanceof ContractError) return error.body;
  throw error;
}

/** The suite, over `open()`'s transport, in a describe block named `name`. */
export function contractSuite(name: string, open: () => Promise<ContractTransport>): void {
  describe(name, () => {
    test("every example of every entry is verified or listed with the step that owns it", () => {
      for (const entry of registry) {
        entry.examples.forEach((_example, i) => {
          const key = `${entry.name} ${String(i)}`;
          expect(VERIFIED.has(key) || Object.hasOwn(LATER, key), key).toBe(true);
          expect(VERIFIED.has(key) && Object.hasOwn(LATER, key), key).toBe(false);
        });
      }
    });

    test("no two examples share a request ID: in the one space they run in, the second is refused", () => {
      const seen = new Map<string, string>();
      for (const entry of registry) {
        entry.examples.forEach((example, i) => {
          const id = (example.input as Value)["request_id"];
          if (typeof id !== "string") return;
          const key = `${entry.name} ${String(i)}`;
          expect(seen.get(id), key).toBeUndefined();
          seen.set(id, key);
        });
      }
    });

    test("every example gives its documented result, or the outcome its later step changes", async () => {
      const transport = await open();
      try {
        const world = await buildWorld(transport);
        for (const entry of registry) {
          if (transport.carries?.(entry.name) === false) continue;
          for (const [i, example] of entry.examples.entries()) {
            const key = `${entry.name} ${String(i)}`;
            const actor: Actor = example.actor ?? "agent";
            const input = { ...(example.input as Value) };
            // An example's base is "the as_of of a read just before": the world's own.
            if (typeof input["base"] === "string") input["base"] = await world.asOf();
            // An example's working folder is the world's portal, M-14's and M-15's folder.
            if (typeof input["cwd"] === "string") input["cwd"] = transport.portal;
            // An example's folder is the world's portal too: a folder that exists on this machine.
            if (entry.name === "folder.manage" && typeof input["folder"] === "string") {
              input["folder"] = transport.portal;
            }
            // A verified example's launch reference stands for a launch of its task in the world:
            // `task.get 0` loads M-14 by the reference its Brief gave.
            if (typeof input["launch"] === "string" && VERIFIED.has(key)) {
              input["launch"] = await transport.launch("M-14");
            }
            let result: unknown;
            let error: ErrorBody | undefined;
            try {
              result = await transport.call(entry.name, input, actor);
            } catch (thrown) {
              error = bodyOf(thrown);
            }
            const later = LATER[key];
            if (later !== undefined) {
              if ("error" in later.now) {
                expect(error?.code, `${key}: ${later.why}`).toBe(later.now.error);
              } else {
                expect(error, `${key}: ${later.why}`).toBeUndefined();
                expect(entry.output.safeParse(result).success, key).toBe(true);
              }
              continue;
            }
            expect(error, `${key}: ${JSON.stringify(error)}`).toBeUndefined();
            const parsed = entry.output.safeParse(result);
            expect(parsed.success, key).toBe(true);
            const value = result as Value;
            if (typeof value["as_of"] === "string") expect(value["as_of"]).toMatch(AS_OF);
            expect(meaning(entry.name, value), key).toEqual(
              meaning(entry.name, example.output as Value),
            );
            // The same write sent again, as after a lost answer, gets the answer it got (A3 3.4.1).
            if (
              transport.replays !== true &&
              !readsOnly(entry, input) &&
              typeof input["request_id"] === "string"
            ) {
              const again = await transport.call(entry.name, input, actor);
              expect(again, `${key}: sent again`).toEqual({ ...value, replayed: true });
            }
          }
        }
      } finally {
        await transport.close();
      }
    }, 180_000);
  });
}

// ---------------------------------------------------------------------------------------------
// The examples' world, built through the transport

const TITLES: Readonly<Record<number, string>> = {
  3: "Fix DST bug in reports",
  14: "Fix appointment time zones",
  15: "Review Jonas's pull request for the billing export",
};

let counter = 0;
const rid = (): string => `contract-world-${String((counter += 1)).padStart(8, "0")}`;

async function buildWorld(t: ContractTransport): Promise<{ asOf(): Promise<string> }> {
  const asOf = async (): Promise<string> =>
    ((await t.call("space.status", {}, "agent")) as { as_of: string }).as_of;
  const tasks = Array.from({ length: 15 }, (_, i) => ({
    title: TITLES[i + 1] ?? `Fixture task ${String(i + 1)}`,
  }));
  await t.call("task.add", { tasks, request_id: rid() }, "user");

  // M-14 and M-15 in the portal folder, as the user gives it them: the tasks `here` names.
  for (const task of ["M-14", "M-15"]) await t.folder(task);

  // M-3: completed and wrapped up with a learning, with its context, a note and its ticket.
  await t.call(
    "task.update",
    {
      task: "M-3",
      context: { mode: "replace", text: "Report times drift by one hour across the DST change." },
      add_sources: [{ key: "jira:LUM-187", kind: "ticket", title: "Report times wrong after DST" }],
      base: await asOf(),
      request_id: rid(),
    },
    "agent",
  );
  await t.call(
    "entry.add",
    {
      task: "M-3",
      kind: "note",
      text: "The April reports were regenerated after the fix.",
      request_id: rid(),
    },
    "agent",
  );
  await t.call(
    "task.finish",
    {
      task: "M-3",
      outcome: "Reports convert from UTC with the clinic's zone ID.",
      learnings: ["Always store UTC plus the clinic's zone ID, never offsets."],
      base: await asOf(),
      request_id: rid(),
    },
    "agent",
  );

  // M-14: the user's note for agents (n1), two log entries (l1, l2) and its ticket.
  await t.call(
    "entry.add",
    {
      task: "M-14",
      kind: "note",
      text: "Keep the old export format until Lumen confirms the change.",
      for_agents: true,
      request_id: rid(),
    },
    "user",
  );
  await t.call(
    "entry.add",
    { task: "M-14", kind: "progress", text: "Started on the export path.", request_id: rid() },
    "agent",
  );
  await t.call(
    "entry.add",
    {
      task: "M-14",
      kind: "evidence",
      text: "Reproduced with the 11-12 clinic export: times shift by one hour.",
      request_id: rid(),
    },
    "agent",
  );

  // receipt.get's examples: an applied summary update (11), and a stale one (13). Its summary is
  // not task.update's example's, which then changes it.
  const before = await asOf();
  await t.call(
    "task.update",
    {
      task: "M-14",
      set: { summary: "Fixture summary before the examples" },
      base: before,
      request_id: requestIdOf(11),
    },
    "agent",
  );
  await t
    .call(
      "task.update",
      {
        task: "M-14",
        set: { summary: "Fixture stale summary" },
        base: before,
        request_id: requestIdOf(13),
      },
      "agent",
    )
    .then(
      () => {
        throw new Error("the stale update was applied");
      },
      (error: unknown) => {
        if (bodyOf(error).code !== "conflict") throw error;
      },
    );
  return { asOf };
}
