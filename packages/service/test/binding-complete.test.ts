// Binding complete (A3 3.7, A3 5 "Binding tests", A4 3.10, A7 3.11 M4.06) on a service in this
// process. Each agent connection is bound as the local endpoint binds an mcp mode connection (its
// bind context goes to `bindings.bridge`), and its tool calls go through the endpoint's own caller
// (`toolCaller`), so a call carries what a real one carries: Codex's per-call thread ID, the shared
// flag and the compact text. The user's session changes go through the service's rpc methods as
// `tasks session` sends them. Fixture text and temporary folders only.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { JsonObject } from "@tasks/bridge/protocol";
import { newId } from "@tasks/storage";
import { bridgePrincipal, toolCaller } from "../src/mcp/index.ts";
import { opCall, type BindingPort, type Slot } from "../src/ops/index.ts";
import { contractWorld, type ContractWorld } from "./contract/suite.ts";
import { bridgeContext } from "./mcp-helpers.ts";
import { classSession, errorOf, grantHome } from "./ops-helpers.ts";

type Json = Record<string, unknown>;
const LONG = 180_000;
const PRESET = "22222222-3333-4444-8555-666666666666";

let w: ContractWorld & { root: string };

beforeAll(async () => {
  w = await contractWorld("bind-done");
  await user("task.add", {
    tasks: ["Fixture task one", "Fixture task two", "Fixture task three", "Fixture task four"].map(
      (title) => ({ title }),
    ),
    request_id: rid(),
  });
  for (const instance of ["done-agent", "chat-agent"]) {
    await grantHome(w.home, w.path, { instance, space: w.space });
  }
}, LONG);
afterAll(async () => {
  await w.close();
}, LONG);

let n = 0;
const rid = () => `fixture-done-${String((n += 1)).padStart(6, "0")}`;

async function user(op: string, input: Json): Promise<Json> {
  return (await opCall(
    w.service.ops,
    { class: "cli-interactive", env: {} },
    { op, input, space: w.space },
  )) as Json;
}

/** One agent connection: bound as the endpoint binds it, called as the endpoint calls. */
interface Agent {
  readonly slot: Slot;
  readonly binding: Json;
  /** A tool call's compact text, and whether it is an error. */
  tool(name: string, args?: Json, thread?: string): Promise<{ text: string; error: boolean }>;
  close(): void;
}

async function connect(extra: JsonObject = {}): Promise<Agent> {
  const context = bridgeContext({ space: w.space, instance: "done-agent", ...extra });
  const connection = { context };
  const binding = await w.service.bindings.bridge(connection);
  const slot = w.service.bindings.attach(connection);
  if (slot === undefined) throw new Error("no slot for the connection");
  const call = toolCaller({
    ops: w.service.ops,
    context,
    conn: 1,
    slot,
    bindings: w.service.bindings,
  });
  return {
    slot,
    binding,
    tool: async (name, args = {}, thread) => {
      const result = await call(name, args, thread);
      // One text item per result (A3 3.3).
      const text = result.content
        .flatMap((item) => (item.type === "text" ? [item.text] : []))
        .join("\n");
      return { text, error: result.isError === true };
    },
    close: () => {
      w.service.bindings.closed(slot);
    },
  };
}

/** The task's sessions, as get_task's sessions section gives them to the user. */
async function sessionsOf(task: string): Promise<Json[]> {
  const read = await user("task.get", { task, sections: ["sessions"] });
  return ((read["sections"] as Json)["sessions"] as Json[] | undefined) ?? [];
}

async function waitBound(launch: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const intent = await w.service.launches.read(w.space, launch);
    if (typeof intent?.evidence.bound_at === "number") return;
    if (Date.now() > deadline) throw new Error("the launch did not record the binding");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A Copy launch of `task`, dispatched at once (A4 3.4.6): its reference binds once. */
async function copyLaunch(task: string): Promise<{ id: string; reference: string }> {
  const read = await user("task.get", { task, sections: ["history"] });
  const intent = await w.service.launches.open(
    w.space,
    {
      task: String((read["task"] as Json)["id"]),
      instance: "clipboard",
      route: "clipboard",
      place: null,
      taskVersion: 1,
      briefHash: "d".repeat(64),
    },
    rid(),
  );
  // A3 3.7.7: its session exists before its dispatch.
  expect(w.service.bindings.sessionOfLaunch(intent.id)).toBeDefined();
  await w.service.launches.dispatch(w.space, intent.id);
  return { id: intent.id, reference: intent.reference };
}

describe("[A3.3.7.binding.native] a launch's preset session ID binds alone, through the service", () => {
  test(
    "a Claude Code bridge presenting the preset ID and no ticket binds its launch's session, writes as it and confirms the launch",
    { timeout: LONG },
    async () => {
      const launch = await w.launch("M-1", { instance: "done-agent", preset: PRESET });
      const agent = await connect({ env: { CLAUDE_CODE_SESSION_ID: PRESET } });
      try {
        expect(agent.binding).toMatchObject({ state: "bound", space: w.space });
        const session = agent.slot.session?.id ?? "";
        expect(session).toBe(w.service.bindings.sessionOfLaunch(launch.id)?.id);
        await waitBound(launch.id);
        const logged = await agent.tool("add_entry", {
          kind: "progress",
          text: "Fixture progress, bound by the preset ID.",
          request_id: rid(),
        });
        expect(logged).toMatchObject({ error: false });
        expect(logged.text).toContain("on M-1");
        const read = await user("task.get", { task: "M-1", sections: ["log"] });
        const log = (read["sections"] as Json)["log"] as Json[];
        expect(log[0]?.["author"]).toBe(`agent:done-agent:${session}`);
        // The session list: bound by its native ID, live, no ID shown, no Resume (no instance here).
        const [row] = await sessionsOf("M-1");
        expect(row).toMatchObject({
          id: session,
          state: "live",
          instance: "done-agent",
          via: "native_id",
          route: "terminal",
          resume: false,
        });
        expect(JSON.stringify(await sessionsOf("M-1"))).not.toContain(PRESET);
      } finally {
        agent.close();
      }
    },
  );
});

describe("[A3.3.7.binding.launch-session] a CLI call maps to its launch's session before any agent bound it", () => {
  test(
    "a launch whose instance is no registered home: its shell acts as the waiting session, ungated, in its space; once a home binds it, its calls are that home's",
    { timeout: LONG },
    async () => {
      // T3's or Copy's instance is no agent home of its own: the session waits for the home that
      // binds it (A3 3.7.7, 3.7.8).
      const launch = await w.launch("M-4", { instance: "t3-launch" });
      const waiting = w.service.bindings.sessionOfLaunch(launch.id);
      expect(waiting?.waiting).toBe(true);
      const shell = await classSession(w.home, w.path, "cli-agent", {
        TASKS_TICKET: launch.ticket,
      });
      try {
        const logged = (await shell.call(
          "op/call",
          {
            op: "entry.add",
            input: { kind: "progress", text: "Fixture progress, waiting.", request_id: rid() },
          },
          { timeoutMs: 60_000 },
        )) as Json;
        expect(logged).toMatchObject({ task: "M-4" });
        const read = await user("task.get", { task: "M-4", sections: ["log"] });
        const log = (read["sections"] as Json)["log"] as Json[];
        expect(log[0]?.["author"]).toBe(`agent:t3-launch:${waiting?.id ?? ""}`);
      } finally {
        shell.close();
      }
      // The provider's home binds it with the ticket: the session is that home's from now on.
      const agent = await connect({ env: { TASKS_TICKET: launch.ticket } });
      try {
        expect(agent.binding["state"]).toBe("bound");
        expect(agent.slot.session).toMatchObject({ id: waiting?.id, instance: "done-agent" });
        expect(agent.slot.session?.waiting).toBeUndefined();
      } finally {
        agent.close();
      }
    },
  );
});

describe("[A3.3.7.binding.call-only] a shared connection binds for its call only; a bound one says which task it stays on", () => {
  test(
    "Claude Desktop's chat: a launch reference loads its task with durable false and the hint, is not used up, and its session reads opened by reference",
    { timeout: LONG },
    async () => {
      const launch = await copyLaunch("M-2");
      const chat = await connect({ instance: "chat-agent", app: "claude-desktop" });
      try {
        expect(chat.slot.shared).toBe(true);
        const loaded = await chat.tool("get_task", { launch: launch.reference });
        expect(loaded.error).toBe(false);
        expect(loaded.text).toContain(
          'Session: not bound, this call only. Pass task "M-2" on later calls.',
        );
        const raw = (await opCall(
          w.service.ops,
          {
            class: "bridge",
            env: {},
            shared: true,
            home: "chat-agent",
            principal: bridgePrincipal(
              bridgeContext({ instance: "chat-agent" }),
              w.service.ops.machine.id,
            ),
          },
          { op: "task.get", input: { launch: launch.reference }, space: w.space },
        )) as Json;
        expect(raw).toMatchObject({ bound: false, durable: false });
        expect(chat.slot.session).toBeUndefined();
        expect((await sessionsOf("M-2"))[0]).toMatchObject({ state: "opening", untracked: true });
        // The chat's next call without a task is unbound: nothing leaked into the connection.
        expect(
          (await chat.tool("add_entry", { kind: "progress", text: "x", request_id: rid() })).text,
        ).toMatch(/^error unbound/);
      } finally {
        chat.close();
      }
      // Not used up: a per-session connection binds with the same reference.
      const agent = await connect();
      try {
        expect((await agent.tool("get_task", { launch: launch.reference })).text).toContain(
          "Session: bound to this task by this call",
        );
        expect((await sessionsOf("M-2"))[0]).toMatchObject({ via: "launch_ref", state: "live" });
        expect((await sessionsOf("M-2"))[0]?.["untracked"]).toBeUndefined();
      } finally {
        agent.close();
      }
    },
  );

  test(
    "a bound connection's call naming another task applies to it, and its result says the session stays bound to its task",
    { timeout: LONG },
    async () => {
      const agent = await connect();
      try {
        expect((await agent.tool("get_task", { task: "M-3", bind: true })).error).toBe(false);
        const other = await agent.tool("add_entry", {
          task: "M-4",
          kind: "progress",
          text: "Fixture progress on another task.",
          request_id: rid(),
        });
        expect(other.text).toContain("on M-4");
        expect(other.text).toContain("This session is bound to M-3.");
        const read = await agent.tool("get_task", { task: "M-4" });
        expect(read.text).toContain("This session is bound to M-3.");
        // Its own task, by reference or by default: no such line.
        expect((await agent.tool("get_task", { task: "M-3" })).text).not.toContain(
          "This session is bound to",
        );
        expect(
          (await agent.tool("add_entry", { kind: "progress", text: "Own.", request_id: rid() }))
            .text,
        ).not.toContain("This session is bound to");
      } finally {
        agent.close();
      }
    },
  );
});

describe("[A3.3.7.binding.user-ops] the user ends, unbinds and rebinds a session through the service", () => {
  test(
    "session/rebind moves a bound connection to another task, session/end then ends it, and only a person at a terminal may call them",
    { timeout: LONG },
    async () => {
      const agent = await connect();
      const person = await classSession(w.home, w.path, "cli-interactive");
      const script = await classSession(w.home, w.path, "cli-script");
      const shell = await classSession(w.home, w.path, "cli-agent", { CLAUDECODE: "1" });
      try {
        await agent.tool("get_task", { task: "M-1", bind: true });
        const first = agent.slot.session?.id ?? "";
        for (const other of [script, shell]) {
          const refused = await other
            .call("session/end", { session: first }, { timeoutMs: 60_000 })
            .then(
              () => undefined,
              (e: unknown) => e,
            );
          expect(refused, "refused").toBeDefined();
        }
        expect(agent.slot.session?.id).toBe(first);

        const rebound = (await person.call(
          "session/rebind",
          { session: first, task: "M-2" },
          { timeoutMs: 60_000 },
        )) as Json;
        expect(rebound).toMatchObject({ session: first, result: "rebound", task: "M-2" });
        expect((await agent.tool("status", {})).text).toContain("Session: bound to M-2");
        const next = String(rebound["next"]);
        expect(agent.slot.session?.id).toBe(next);

        expect(
          await person.call("session/end", { session: next }, { timeoutMs: 60_000 }),
        ).toMatchObject({ session: next, result: "ended" });
        const after = await agent.tool("add_entry", {
          kind: "progress",
          text: "Fixture progress after the end.",
          request_id: rid(),
        });
        expect(after.text).toMatch(/^error unbound/);
        expect(after.text).toContain("session ended");
        expect((await sessionsOf("M-2"))[0]).toMatchObject({ id: next, end_reason: "user" });

        const unknown = await person
          .call("session/end", { session: newId("se") }, { timeoutMs: 60_000 })
          .then(
            () => undefined,
            (e: unknown) => errorOf(e),
          );
        expect(unknown?.code).toBe("not_found");
      } finally {
        person.close();
        script.close();
        shell.close();
        agent.close();
      }
    },
  );

  test(
    "a write that read its binding before the user's end writes nothing, and its retry acts as the connection is now",
    { timeout: LONG },
    async () => {
      const real = w.service.bindings;
      const agent = await connect();
      await agent.tool("get_task", { task: "M-3", bind: true });
      const session = agent.slot.session?.id ?? "";
      expect(session).not.toBe("");
      // The end lands right after the call read its binding: the slot keeps the session it read,
      // as a call does whose principal was computed before the end.
      agent.close();
      let armed = true;
      const racing: BindingPort = {
        redeem: (slot, launch) => real.redeem(slot, launch),
        bindTask: (slot, space, task) => real.bindTask(slot, space, task),
        pin: (slot, space) => {
          real.pin(slot, space);
        },
        use: async (slot) => {
          await real.use(slot);
          if (armed) {
            armed = false;
            await real.end(session);
          }
        },
        liveSessions: (space) => real.liveSessions(space),
        sessionsOf: (space, task) => real.sessionsOf(space, task),
        untracked: (launch) => {
          real.untracked(launch);
        },
        goesOn: (id) => real.goesOn(id),
      };
      const call = toolCaller({
        ops: { ...w.service.ops, bindings: racing },
        context: bridgeContext({ space: w.space, instance: "done-agent" }),
        conn: 2,
        slot: agent.slot,
        bindings: real,
      });
      const text = async (args: Json) => {
        const result = await call("add_entry", args, undefined);
        return result.content
          .flatMap((item) => (item.type === "text" ? [item.text] : []))
          .join("\n");
      };
      const request = rid();
      const args = {
        task: "M-3",
        kind: "progress",
        text: "Fixture progress racing the end.",
        request_id: request,
      };
      const refused = await text(args);
      expect(refused).toMatch(/^error unbound/);
      expect(refused).toContain("nothing was written");
      const log = async () =>
        ((await user("task.get", { task: "M-3", sections: ["log"] }))["sections"] as Json)[
          "log"
        ] as Json[];
      expect((await log()).some((entry) => entry["text"] === args.text)).toBe(false);
      // The retry: the connection's session ended, so the call acts as its unbound agent home.
      const retried = await text(args);
      expect(retried).toContain("on M-3");
      const written = (await log()).filter((entry) => entry["text"] === args.text);
      expect(written.map((entry) => entry["author"])).toEqual(["agent:done-agent"]);
    },
  );
});
