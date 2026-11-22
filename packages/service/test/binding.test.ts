// Session binding (A3 3.7, A3 5 "Binding tests", A7 3.9 M2.04) on a service in this process. Each
// connection is bound exactly as the local endpoint binds an mcp mode connection: its bind context
// goes to the service's binding (`bindings.bridge`, the bind hook's call), and its tool calls go to
// the request path with the slot that came of it, the endpoint's caller. One test drives the same
// through real ttasks-local/1 connections. Launches are the world's: opened, dispatched and claimed
// in this process as a shim claims them. Fixture text and temporary folders only.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { JsonObject } from "@ttasks/bridge/protocol";
import { AppError, type ErrorBody } from "@ttasks/contracts";
import { SHIM_METHODS } from "@ttasks/launch";
import { bridgePrincipal, clientOf } from "../src/mcp/index.ts";
import { opCall, type Caller, type OpsHost, type Slot } from "../src/ops/index.ts";
import { contractWorld, type ContractWorld, type WorldLaunch } from "./contract/suite.ts";
import { stateOf } from "./harness.ts";
import { bridgeContext, openMcp, RawMcp, textOf } from "./mcp-helpers.ts";
import { classSession, errorOf, grantHome } from "./ops-helpers.ts";

type Json = Record<string, unknown>;
const LONG = 180_000;

let w: ContractWorld & { root: string };
/** Added to the wall clock launching reads: a test moves it to pass a window. */
let skew = 0;

beforeAll(async () => {
  // The PID check runs only when a test asks: one that settles a launch mid-test changes its answer.
  w = await contractWorld("bind", {
    launch: { now: () => Date.now() + skew, checkMs: 24 * 60 * 60_000 },
  });
  await user("task.add", {
    tasks: ["Fixture task one", "Fixture task two", "Fixture task three", "Fixture task four"].map(
      (title) => ({ title }),
    ),
    request_id: rid(),
  });
  // The agent homes these connections name, registered for Mira as setup does (the grant gate,
  // grant-gate.test.ts).
  for (const instance of ["test-agent", "other-agent", "wire-agent", "shared-agent"]) {
    await grantHome(w.home, w.path, { instance, space: w.space });
  }
}, LONG);
afterAll(async () => {
  await w.close();
}, LONG);

let n = 0;
const rid = () => `fixture-binding-${String((n += 1)).padStart(6, "0")}`;

async function user(op: string, input: Json, space?: string): Promise<Json> {
  return (await opCall(
    w.service.ops,
    { class: "cli-interactive", env: {} },
    { op, input, ...(space === undefined ? {} : { space }) },
  )) as Json;
}

/** One agent connection, bound as the endpoint binds an mcp mode connection. */
interface Agent {
  readonly slot: Slot;
  readonly binding: Json;
  call(op: string, input?: Json, options?: { space?: string; host?: OpsHost }): Promise<Json>;
  refusal(
    op: string,
    input?: Json,
    options?: { space?: string; host?: OpsHost },
  ): Promise<ErrorBody>;
  close(): void;
}

async function connect(extra: JsonObject = {}): Promise<Agent> {
  const context = bridgeContext({ space: w.space, ...extra });
  const connection = { context };
  const binding = await w.service.bindings.bridge(connection);
  const slot = w.service.bindings.attach(connection);
  if (slot === undefined) throw new Error("no slot for the connection");
  const caller: Caller = {
    class: "bridge",
    env: {},
    principal: bridgePrincipal(context, w.service.ops.machine.id),
    client: clientOf(context),
    binding: slot,
  };
  const call: Agent["call"] = async (op, input = {}, options = {}) =>
    (await opCall(options.host ?? w.service.ops, caller, {
      op,
      input,
      ...(options.space === undefined ? {} : { space: options.space }),
    })) as Json;
  return {
    slot,
    binding,
    call,
    refusal: async (op, input = {}, options = {}) => {
      const error = await call(op, input, options).then(
        () => undefined,
        (e: unknown) => e,
      );
      if (!(error instanceof AppError)) throw new Error(`${op} was not refused`);
      return error.toBody();
    },
    close: () => {
      w.service.bindings.closed(slot);
    },
  };
}

const sessionOf = async (agent: Agent): Promise<Json> =>
  (await agent.call("space.status"))["session"] as Json;

/** The log entries of a task, newest first, with their authors (A1's history). */
async function logOf(task: string): Promise<Json[]> {
  const read = await user("task.get", { task, sections: ["log"] });
  return ((read["sections"] as Json)["log"] as Json[] | undefined) ?? [];
}

async function waitLaunch(launch: WorldLaunch, ready: (evidence: Json, state: string) => boolean) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const intent = await w.service.launches.read(w.space, launch.id);
    if (intent !== undefined && ready(intent.evidence, intent.state)) return intent;
    if (Date.now() > deadline) throw new Error("the launch did not record the binding");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("[A3.3.7.binding.ticket] the ticket binds at the bind frame, once per role, its own launch only", () => {
  test(
    "the first redemption binds the launch's session: status, the actor and the launch say so",
    { timeout: LONG },
    async () => {
      const launch = await w.launch("M-1");
      const agent = await connect({ env: { TTASKS_TICKET: launch.ticket } });
      expect(agent.binding).toMatchObject({ state: "bound", space: w.space });
      expect(String(agent.binding["handle"])).toMatch(/^bh_[A-Za-z0-9_-]{22}$/);
      expect(await sessionOf(agent)).toMatchObject({ state: "bound", task: "M-1" });

      // The bound task is the default, and the actor is the session's, from the credential.
      const logged = await agent.call("entry.add", {
        kind: "progress",
        text: "Fixture progress through the ticket.",
        request_id: rid(),
      });
      expect(logged).toMatchObject({ result: "logged", task: "M-1" });
      const session = agent.slot.session?.id ?? "";
      expect(session).toMatch(/^se_/);
      expect((await logOf("M-1"))[0]?.["author"]).toBe(`agent:test-agent:${session}`);

      // A4 3.9.2: the bridge's binding is evidence for Confirmed.
      const confirmed = await waitLaunch(launch, (e) => typeof e["bound_at"] === "number");
      expect(confirmed.state).toBe("confirmed");
      agent.close();

      // Machine state holds no secret: neither the ticket nor the handle, only its hash.
      const file = readFileSync(join(stateOf(w.home), "sessions.json"), "utf8");
      expect(file).not.toContain(launch.ticket);
      expect(file).not.toContain(String(agent.binding["handle"]));
      expect(file).toContain(session);
    },
  );

  test(
    "a forged, malformed or other install's ticket binds nothing, nor does one of another space",
    { timeout: LONG },
    async () => {
      const other = await contractWorld("bind-other");
      try {
        await opCall(
          other.service.ops,
          { class: "cli-interactive", env: {} },
          { op: "task.add", input: { tasks: [{ title: "Fixture" }], request_id: rid() } },
        );
        const foreign = await other.launch("M-1");
        for (const ticket of [
          foreign.ticket, // a real ticket of another install
          "0123456789ABCDEFGHJKMNPQ", // its form, issued by no one
          "not a ticket",
        ]) {
          const agent = await connect({ env: { TTASKS_TICKET: ticket } });
          expect(agent.binding["state"], ticket).toBe("unbound");
          expect((await sessionOf(agent))["state"]).toBe("unbound");
          agent.close();
        }
      } finally {
        await other.close();
      }

      // A ticket of this install, presented by a connection whose entry names another space.
      const launch = await w.launch("M-2");
      const elsewhere = await connect({
        space: "sp_0000000000000000000000000z",
        env: { TTASKS_TICKET: launch.ticket },
      });
      expect(elsewhere.binding).toMatchObject({ state: "unbound" });
      elsewhere.close();
      // Not spent by any of that: the right connection binds with it.
      const right = await connect({ env: { TTASKS_TICKET: launch.ticket } });
      expect(right.binding["state"]).toBe("bound");
      right.close();
    },
  );

  test(
    "a ticket presented again: refused while its session's connection is open, honoured for the same session with its native ID or once that connection closed, and never after the agent ended",
    { timeout: LONG },
    async () => {
      const launch = await w.launch("M-3");
      const NATIVE = "11111111-2222-4333-8444-555555555555";
      const first = await connect({
        env: { TTASKS_TICKET: launch.ticket, CLAUDE_CODE_SESSION_ID: NATIVE },
      });
      expect(first.binding["state"]).toBe("bound");
      const session = first.slot.session?.id;

      // A terminal opened from the launched one keeps the ticket: its bridge binds nothing.
      const lingering = await connect({ env: { TTASKS_TICKET: launch.ticket } });
      expect(lingering.binding["state"]).toBe("unbound");
      lingering.close();

      // The agent app's MCP server again, with the native ID the session holds.
      const restarted = await connect({
        env: { TTASKS_TICKET: launch.ticket, CLAUDE_CODE_SESSION_ID: NATIVE },
      });
      expect(restarted.binding["state"]).toBe("bound");
      expect(restarted.slot.session?.id).toBe(session);
      restarted.close();

      // No other connection of the session open, and the agent runs: honoured.
      first.close();
      const again = await connect({ env: { TTASKS_TICKET: launch.ticket } });
      expect(again.binding["state"]).toBe("bound");
      expect(again.slot.session?.id).toBe(session);
      again.close();

      // The agent ended (the shim's report): its launch's machine state goes, and the ticket with
      // it. A bind after the launch reached its end binds nothing.
      const attachment = launch.attachment;
      if (attachment === undefined) throw new Error("the launch was not claimed");
      const ended = await w.service.launches.host.report(attachment, SHIM_METHODS.exited, {
        code: 0,
        signal: null,
        ran_ms: 5_000,
        settled: true,
      });
      expect(ended.kind).toBe("applied");
      const late = await connect({
        env: { TTASKS_TICKET: launch.ticket, CLAUDE_CODE_SESSION_ID: NATIVE },
      });
      expect(late.binding["state"]).toBe("unbound");
      late.close();
    },
  );

  test(
    "a ticket binds nothing before its agent started or after its 15-minute window",
    { timeout: LONG },
    async () => {
      const early = await w.launch("M-1", { started: false });
      const before = await connect({ env: { TTASKS_TICKET: early.ticket } });
      expect(before.binding["state"]).toBe("unbound");
      before.close();

      const late = await w.launch("M-2");
      skew = 15 * 60_000 + 1_000;
      try {
        const after = await connect({ env: { TTASKS_TICKET: late.ticket } });
        expect(after.binding["state"]).toBe("unbound");
        after.close();
      } finally {
        skew = 0;
      }
    },
  );
});

describe("[A3.3.7.binding.reference] get_task with a launch reference binds once", () => {
  test(
    "the first redemption binds; the same connection again gets the same binding, a resumed one too; another connection gets launch_used with the task",
    { timeout: LONG },
    async () => {
      const launch = await w.launch("M-2");
      const agent = await connect();
      expect(agent.binding["state"]).toBe("unbound");
      const loaded = await agent.call("task.get", { launch: launch.reference });
      expect(loaded).toMatchObject({ view: "digest", bound: true, task: { ref: "M-2" } });
      expect(await agent.call("task.get", { launch: launch.reference })).toMatchObject({
        bound: true,
      });
      expect(await sessionOf(agent)).toMatchObject({ state: "bound", task: "M-2" });
      await waitLaunch(launch, (e) => typeof e["bound_at"] === "number");

      const second = await connect();
      expect(await second.refusal("task.get", { launch: launch.reference })).toMatchObject({
        code: "launch_used",
        data: { task: "M-2" },
      });
      second.close();

      // A reconnect with its handle is the same connection: the same binding.
      agent.close();
      const resumed = await connect({ resume: { handle: agent.binding["handle"] } });
      expect(resumed.binding).toMatchObject({ state: "bound", handle: agent.binding["handle"] });
      expect(await resumed.call("task.get", { launch: launch.reference })).toMatchObject({
        bound: true,
      });
      expect(resumed.slot.session?.id).toBe(agent.slot.session?.id);
      resumed.close();
    },
  );

  test(
    "a bound connection is never bound to something else: another launch, another task",
    { timeout: LONG },
    async () => {
      const one = await w.launch("M-1");
      const two = await w.launch("M-3");
      const agent = await connect();
      await agent.call("task.get", { launch: one.reference });
      expect(await agent.refusal("task.get", { launch: two.reference })).toMatchObject({
        code: "already_bound",
        data: { task: "M-1" },
      });
      expect(await agent.refusal("task.get", { task: "M-3", bind: true })).toMatchObject({
        code: "already_bound",
        data: { task: "M-1" },
      });
      expect(await agent.call("task.get", { task: "M-1", bind: true })).toMatchObject({
        bound: true,
      });
      // The other launch was not used up by the refusal.
      const other = await connect();
      expect(await other.call("task.get", { launch: two.reference })).toMatchObject({
        bound: true,
        task: { ref: "M-3" },
      });
      agent.close();
      other.close();
    },
  );

  test(
    "references that bind nothing: mistyped, unknown, of another space, never sent, ended, over 24 hours old",
    { timeout: LONG },
    async () => {
      const agent = await connect();
      const fresh = await w.launch("M-4");
      // One changed symbol fails the check character.
      const swapped = `${fresh.reference.slice(0, 1)}${fresh.reference[1] === "2" ? "3" : "2"}${fresh.reference.slice(2)}`;
      const typo = await agent.refusal("task.get", { launch: swapped });
      expect(typo.code).toBe("launch_unknown");

      // Never sent: a terminal launch no shim claimed (its Brief reached no agent).
      const unclaimed = await w.launch("M-4", { claimed: false });
      expect(await agent.refusal("task.get", { launch: unclaimed.reference })).toMatchObject({
        code: "launch_unknown",
      });

      // Ended: its shim's check failed (Failed), or its agent exited (its exit code recorded).
      const failed = await w.launch("M-4");
      if (failed.attachment === undefined) throw new Error("not claimed");
      await w.service.launches.host.report(failed.attachment, SHIM_METHODS.failed, {
        reason: "verify",
      });
      expect(await agent.refusal("task.get", { launch: failed.reference })).toMatchObject({
        code: "launch_expired",
        data: { task: "M-4" },
      });
      const exited = await w.launch("M-4");
      if (exited.attachment === undefined) throw new Error("not claimed");
      await w.service.launches.host.report(exited.attachment, SHIM_METHODS.exited, {
        code: 0,
        signal: null,
        ran_ms: 9_000,
        settled: true,
      });
      expect(await agent.refusal("task.get", { launch: exited.reference })).toMatchObject({
        code: "launch_expired",
      });

      // More than 24 hours after its click.
      const later: OpsHost = { ...w.service.ops, now: () => Date.now() + 25 * 60 * 60_000 };
      expect(
        await agent.refusal("task.get", { launch: fresh.reference }, { host: later }),
      ).toMatchObject({ code: "launch_expired", data: { task: "M-4" } });

      // The session was bound by none of them, and the fresh launch still binds.
      expect((await sessionOf(agent))["state"]).toBe("unbound");
      expect(await agent.call("task.get", { launch: fresh.reference })).toMatchObject({
        bound: true,
      });
      agent.close();
    },
  );

  test(
    "a connection that cannot hold a binding resolves the reference for that call only",
    { timeout: LONG },
    async () => {
      const launch = await w.launch("M-1");
      for (const cls of ["cli-script", "cli-interactive", "ui"] as const) {
        const read = (await opCall(
          w.service.ops,
          { class: cls, env: {} },
          { op: "task.get", input: { launch: launch.reference } },
        )) as Json;
        expect(read, cls).toMatchObject({ view: "digest", bound: false, task: { ref: "M-1" } });
        const bind = (await opCall(
          w.service.ops,
          { class: cls, env: {} },
          { op: "task.get", input: { task: "M-1", bind: true } },
        )) as Json;
        expect(bind, cls).toMatchObject({ bound: false });
      }
      // Nothing was used up: an agent's connection binds with it.
      const agent = await connect();
      expect(await agent.call("task.get", { launch: launch.reference })).toMatchObject({
        bound: true,
      });
      agent.close();
    },
  );
});

describe("[A3.3.7.binding.explicit] an explicit task choice binds an ad-hoc session", () => {
  test(
    "get_task with task and bind true binds; later calls default to the task; an explicit task applies to its call only; a retry after binding replays the unbound attempt",
    { timeout: LONG },
    async () => {
      const agent = await connect();
      // Written unbound first, then bound: the retry finds the first receipt (A3 3.7.9).
      const request = rid();
      const first = await agent.call("entry.add", {
        task: "M-1",
        kind: "progress",
        text: "Fixture progress before binding.",
        request_id: request,
      });
      expect((await logOf("M-1"))[0]?.["author"]).toBe("agent:test-agent");

      expect(await agent.call("task.get", { task: "M-3", bind: true })).toMatchObject({
        bound: true,
        task: { ref: "M-3" },
      });
      const retry = await agent.call("entry.add", {
        task: "M-1",
        kind: "progress",
        text: "Fixture progress before binding.",
        request_id: request,
      });
      expect(retry).toMatchObject({ ...first, replayed: true });

      expect(
        await agent.call("entry.add", { kind: "note", text: "Fixture note.", request_id: rid() }),
      ).toMatchObject({ task: "M-3" });
      expect(
        await agent.call("entry.add", {
          task: "M-1",
          kind: "progress",
          text: "Fixture progress on another task.",
          request_id: rid(),
        }),
      ).toMatchObject({ task: "M-1" });
      expect(await sessionOf(agent)).toMatchObject({ state: "bound", task: "M-3" });
      expect(await agent.call("task.get", { bind: true })).toMatchObject({
        bound: true,
        task: { ref: "M-3" },
      });
      const session = agent.slot.session?.id ?? "";
      expect((await logOf("M-1"))[0]?.["author"]).toBe(`agent:test-agent:${session}`);
      agent.close();

      // Without a task and unbound: nothing to bind.
      const loose = await connect();
      expect((await loose.refusal("task.get", { bind: true })).code).toBe("unbound");
      loose.close();
    },
  );
});

describe("[A3.3.7.binding.folder] a working folder, a hint or an argument never binds", () => {
  test(
    "the bind frame's cwd, TTASKS_TASK and TTASKS_SPACE, status with one exact match, and a tool argument naming a session bind nothing",
    { timeout: LONG },
    async () => {
      const task = await user("task.get", { task: "M-4", sections: ["history"] });
      const taskId = String((task["task"] as Json)["id"]);
      await user("folder.manage", {
        action: "set",
        task: "M-4",
        folder: w.portal,
        base: (await user("space.status", {}))["as_of"],
        request_id: rid(),
      });
      const agent = await connect({
        cwd: w.portal,
        env: { TTASKS_TASK: taskId, TTASKS_SPACE: "sp_0000000000000000000000000z" },
      });
      expect(agent.binding["state"]).toBe("unbound");
      const status = await agent.call("space.status", { cwd: w.portal });
      expect(status["session"]).toMatchObject({ state: "unbound" });
      expect((status["space"] as Json)["id"]).toBe(w.space);
      expect(status["here"]).toEqual([expect.objectContaining({ ref: "M-4", match: "exact" })]);
      expect(String(status["hint"])).toContain("bind true");
      // Still unbound: the folder named no task.
      const refused = await agent.refusal("task.get", { cwd: w.portal });
      expect(refused).toMatchObject({ code: "unbound" });
      expect(JSON.stringify(refused.data)).toContain("M-4");
      expect((await sessionOf(agent))["state"]).toBe("unbound");
      expect(
        (await agent.refusal("task.get", { task: "M-4", session: "se_0000000000000000000000000z" }))
          .code,
      ).toBe("invalid_input");
      agent.close();
    },
  );
});

describe("[A3.3.7.binding.space] a session is pinned to its space", () => {
  test(
    "its calls go to its space whatever a call or a later bind frame names; a space no longer served is unavailable, never another",
    { timeout: LONG },
    async () => {
      const operator = await classSession(w.home, w.path, "cli-interactive");
      let life: string;
      try {
        const created = (await operator.call(
          "space/create",
          { name: "Life", path: join(w.root, "s", "life"), ref_prefix: "L" },
          { timeoutMs: 120_000 },
        )) as { space: { id: string } };
        life = created.space.id;
      } finally {
        operator.close();
      }
      await user("task.add", { tasks: [{ title: "Fixture life task" }], request_id: rid() }, life);

      const agent = await connect();
      await agent.call("task.get", { task: "M-2", bind: true });
      expect(await agent.refusal("space.status", {}, { space: life })).toMatchObject({
        code: "forbidden",
        data: { rule: "binding" },
      });

      // Resumed through a bind frame that names the other space: still its own.
      agent.close();
      const resumed = await connect({ space: life, resume: { handle: agent.binding["handle"] } });
      expect(resumed.binding).toMatchObject({ state: "bound", space: w.space });
      const status = await resumed.call("space.status");
      expect((status["space"] as Json)["id"]).toBe(w.space);
      expect(status["session"]).toMatchObject({ state: "bound", task: "M-2" });
      resumed.close();

      // An unbound connection pinned to Life (its home registered for Life): once Life is
      // closed, unavailable, never Mira.
      await grantHome(w.home, w.path, { instance: "life-agent", space: life });
      const pinned = await connect({ space: life, instance: "life-agent" });
      expect(pinned.binding["space"]).toBe(life);
      expect((await pinned.call("space.status"))["space"]).toMatchObject({ id: life });
      const closer = await classSession(w.home, w.path, "cli-interactive");
      try {
        await closer.call("space/close", { space: life }, { timeoutMs: 60_000 });
      } finally {
        closer.close();
      }
      expect(await pinned.refusal("space.status")).toMatchObject({
        code: "space_unavailable",
        data: { reason: "not_served" },
      });
      pinned.close();
    },
  );
});

describe("[A3.3.7.binding.cli] a cli-agent call's ticket maps to its live session and redeems no role", () => {
  test(
    "no session yet: agent:unknown, and the bridge still binds; then the session's actor; after the agent ended, nothing",
    { timeout: LONG },
    async () => {
      const launch = await w.launch("M-3");
      const cli = await classSession(w.home, w.path, "cli-agent", { TTASKS_TICKET: launch.ticket });
      const early = rid();
      const earlyInput = {
        task: "M-3",
        kind: "progress",
        text: "Fixture progress from the shell.",
        request_id: early,
      };
      let first: Json;
      try {
        // No session for the launch yet: no mapping, so the agent's CLI names its space (A2
        // 3.10.5) and writes as agent:unknown. Its ticket is not spent by it.
        first = (await cli.call(
          "op/call",
          { space: w.space, op: "entry.add", input: earlyInput },
          { timeoutMs: 60_000 },
        )) as Json;
        expect((await logOf("M-3"))[0]?.["author"]).toBe("agent:unknown");
      } finally {
        cli.close();
      }
      const bridge = await connect({ env: { TTASKS_TICKET: launch.ticket } });
      expect(bridge.binding["state"]).toBe("bound");
      const session = bridge.slot.session?.id ?? "";

      const mapped = await classSession(w.home, w.path, "cli-agent", {
        TTASKS_TICKET: launch.ticket,
      });
      try {
        // The shell's retry of its unmapped write, once mapped: its first result, not a second
        // entry (A3 3.7.9: binding later never resets anything).
        const newest = (await logOf("M-3"))[0];
        const retried = (await mapped.call(
          "op/call",
          { op: "entry.add", input: earlyInput },
          { timeoutMs: 60_000 },
        )) as Json;
        expect(retried).toMatchObject({ ...first, replayed: true });
        expect((await logOf("M-3"))[0]).toEqual(newest);

        // No task, no space: the session's task in the session's space.
        const logged = (await mapped.call(
          "op/call",
          {
            op: "entry.add",
            input: { kind: "progress", text: "Fixture progress, mapped.", request_id: rid() },
          },
          { timeoutMs: 60_000 },
        )) as Json;
        expect(logged).toMatchObject({ task: "M-3" });
        expect((await logOf("M-3"))[0]?.["author"]).toBe(`agent:test-agent:${session}`);
        // A mapped call binds nothing new.
        const other = await w.launch("M-1");
        const refused = await mapped
          .call(
            "op/call",
            { op: "task.get", input: { launch: other.reference } },
            { timeoutMs: 60_000 },
          )
          .then(
            () => undefined,
            (e: unknown) => errorOf(e),
          );
        expect(refused?.code).toBe("already_bound");
      } finally {
        mapped.close();
        bridge.close();
      }
    },
  );
});

describe("[A3.3.7.binding.cli] a cli-agent call's ticket maps to its live session and redeems no role", () => {
  test(
    "a shell's write still in flight when its session appears: the retry through the mapped CLI waits for it and replays it",
    { timeout: LONG },
    async () => {
      const launch = await w.launch("M-4");
      const request = rid();
      let open = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      let reached = (): void => undefined;
      const atGate = new Promise<void>((resolve) => {
        reached = resolve;
      });
      // The space's writer, holding the shell's first write until the gate opens.
      const held: OpsHost = {
        ...w.service.ops,
        spaces: () =>
          w.service.ops.spaces().map((s) => {
            const writer = s.writer;
            if (writer === undefined) return s;
            return {
              ...s,
              writer: new Proxy(writer, {
                get(target, key) {
                  if (key === "submit") {
                    return async (request_: { readonly request_id: string }) => {
                      if (request_.request_id === request) {
                        reached();
                        await gate;
                      }
                      return target.submit(request_);
                    };
                  }
                  const value: unknown = Reflect.get(target, key, target);
                  return typeof value === "function"
                    ? (value as (...a: unknown[]) => unknown).bind(target)
                    : value;
                },
              }),
            };
          }),
      };
      const env = { TTASKS_TICKET: launch.ticket };
      const input = {
        task: "M-4",
        kind: "progress",
        text: "Fixture progress held in flight.",
        request_id: request,
      };
      // No session for the launch yet: the shell's write is agent:unknown's.
      const original = opCall(
        held,
        { class: "cli-agent", env },
        { space: w.space, op: "entry.add", input },
      );
      await atGate;

      const bridge = await connect({ env: { TTASKS_TICKET: launch.ticket } });
      expect(bridge.binding["state"]).toBe("bound");
      const mapped = w.service.bindings.mapped(env);
      if (mapped === undefined) throw new Error("the ticket maps to no session");
      const retry = opCall(
        w.service.ops,
        { class: "cli-agent", env, binding: mapped },
        { op: "entry.add", input },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      open();
      const [first, second] = await Promise.all([original, retry]);
      expect(second).toMatchObject({ ...(first as Json), replayed: true });
      const log = JSON.stringify(await logOf("M-4"));
      expect(log.split(input.text).length - 1).toBe(1);
      bridge.close();
    },
  );

  test(
    "a shell's write retried once its agent's exit is on disk, before the PID check settles the launch, commits once",
    { timeout: LONG },
    async () => {
      const launch = await w.launch("M-2");
      const bridge = await connect({ env: { TTASKS_TICKET: launch.ticket } });
      expect(bridge.binding["state"]).toBe("bound");
      const shell = await classSession(w.home, w.path, "cli-agent", {
        TTASKS_TICKET: launch.ticket,
      });
      const input = {
        task: "M-2",
        kind: "progress",
        text: "Fixture progress retried across the exit.",
        request_id: rid(),
      };
      const write = async (): Promise<Json> =>
        (await shell.call(
          "op/call",
          { space: w.space, op: "entry.add", input },
          { timeoutMs: 60_000 },
        )) as Json;
      try {
        const first = await write();
        // The agent ended while the service could not take the shim's report: its exit is on
        // disk, and the shell retries the write whose answer it lost.
        const exit = {
          format: 1,
          launch: launch.id,
          spawned: true,
          settled: true,
          code: 0,
          signal: null,
          ran_ms: 5_000,
        };
        writeFileSync(join(w.service.runtime.launch, launch.id, "exit.json"), JSON.stringify(exit));
        expect(await write()).toMatchObject({ ...first, replayed: true });
        const log = JSON.stringify(await logOf("M-2"));
        expect(log.split(input.text).length - 1).toBe(1);
      } finally {
        shell.close();
        bridge.close();
      }
    },
  );
});

describe("[A3.3.7.binding.wire] the same over real ttasks-local/1 mcp mode connections", () => {
  test(
    "the bind result carries the binding; status, a launch_used refusal and the session line read the same as text",
    { timeout: LONG },
    async () => {
      const launch = await w.launch("M-1");
      const first = new RawMcp(
        await openMcp(w.home, w.path, bridgeContext({ space: w.space, instance: "wire-agent" })),
      );
      const second = new RawMcp(
        await openMcp(w.home, w.path, bridgeContext({ space: w.space, instance: "wire-agent" })),
      );
      try {
        expect(first.session.bound.binding).toMatchObject({ state: "unbound", space: w.space });
        await first.initialize();
        await second.initialize();
        const tool = async (mcp: RawMcp, name: string, args: Json) =>
          textOf((await mcp.request("tools/call", { name, arguments: args })).message["result"]);
        expect(await tool(first, "get_task", { launch: launch.reference })).toContain(
          "Session: bound to this task by this call",
        );
        expect(await tool(first, "status", {})).toContain("Session: bound to M-1");
        expect(await tool(second, "get_task", { launch: launch.reference })).toMatch(
          /^error launch_used/,
        );
      } finally {
        first.close();
        second.close();
      }
    },
  );
});

describe("[A3.3.7.binding.shared] a connection that carries two conversations binds neither for the other", () => {
  test(
    "two thread IDs through one connection: each call is the bound session's only when its own ID proves it, and another thread's binds and inherits nothing",
    { timeout: LONG },
    async () => {
      const one = await w.launch("M-1");
      const two = await w.launch("M-2");
      const mcp = new RawMcp(
        await openMcp(w.home, w.path, bridgeContext({ space: w.space, instance: "shared-agent" })),
      );
      const A = "019a0000-0000-7000-8000-00000000000a";
      const B = "019a0000-0000-7000-8000-00000000000b";
      const tool = async (thread: string, name: string, args: Json) =>
        textOf(
          (
            await mcp.request("tools/call", {
              name,
              arguments: args,
              _meta: { threadId: thread, sessionId: thread },
            })
          ).message["result"],
        );
      try {
        await mcp.initialize();
        expect(await tool(A, "get_task", { launch: one.reference })).toContain(
          "Session: bound to this task by this call",
        );
        // Thread B through the same connection: it is not thread A's session.
        expect(await tool(B, "status", {})).toContain("Session: not bound");
        expect(
          await tool(B, "add_entry", {
            kind: "progress",
            text: "Fixture progress from another thread.",
            request_id: rid(),
          }),
        ).toMatch(/^error unbound/);
        // Its launch reference resolves for its call only, and is not used up.
        const loaded = await tool(B, "get_task", { launch: two.reference });
        expect(loaded).toContain("M-2");
        expect(loaded).not.toContain("Session: bound to this task by this call");
        // Thread A keeps its binding: its calls default to its task, as its session.
        expect(
          await tool(A, "add_entry", {
            kind: "progress",
            text: "Fixture progress from the bound thread.",
            request_id: rid(),
          }),
        ).toContain("M-1");
        expect((await logOf("M-1"))[0]?.["author"]).toMatch(/^agent:shared-agent:se_/);
        expect(await tool(A, "status", {})).toContain("Session: bound to M-1");
      } finally {
        mcp.close();
      }

      // The bridge reconnects with its handle, and thread B calls first: still not A's session.
      const handle = (mcp.session.bound.binding as Json)["handle"];
      const back = new RawMcp(
        await openMcp(
          w.home,
          w.path,
          bridgeContext({ space: w.space, instance: "shared-agent", resume: { handle } }),
        ),
      );
      const again = async (thread: string, name: string, args: Json) =>
        textOf(
          (
            await back.request("tools/call", {
              name,
              arguments: args,
              _meta: { threadId: thread, sessionId: thread },
            })
          ).message["result"],
        );
      try {
        expect(back.session.bound.binding).toMatchObject({ state: "bound" });
        await back.initialize();
        expect(
          await again(B, "add_entry", {
            kind: "progress",
            text: "Fixture progress from another thread, after a reconnect.",
            request_id: rid(),
          }),
        ).toMatch(/^error unbound/);
        expect(await again(A, "status", {})).toContain("Session: bound to M-1");
      } finally {
        back.close();
      }
      const other = await connect();
      expect(await other.call("task.get", { launch: two.reference })).toMatchObject({
        bound: true,
      });
      other.close();
    },
  );
});

describe("[A3.3.7.binding.resume] binding handles restore a binding, for a day", () => {
  test(
    "a handle restores its binding; another instance's, a forged or a malformed one restores nothing; unused for a day its binding is lost, and the connection continues unbound and says why",
    { timeout: LONG },
    async () => {
      const agent = await connect();
      await agent.call("task.get", { task: "M-2", bind: true });
      agent.close();
      const handle = String(agent.binding["handle"]);

      for (const [extra, why] of [
        [{ instance: "other-agent", resume: { handle } }, "another instance's"],
        [{ resume: { handle: `bh_${"A".repeat(22)}` } }, "forged"],
        [{ resume: { handle: "not a handle" } }, "malformed"],
      ] as const) {
        const tried = await connect(extra);
        expect(tried.binding["state"], why).toBe("unbound");
        expect(tried.binding["handle"], why).not.toBe(handle);
        tried.close();
      }
      const back = await connect({ resume: { handle } });
      expect(back.binding).toMatchObject({ state: "bound", handle });
      back.close();

      skew = 24 * 60 * 60_000 + 1_000;
      try {
        const late = await connect({ resume: { handle } });
        expect(late.binding["state"]).toBe("lost");
        expect(late.binding["handle"]).not.toBe(handle);
        expect((await sessionOf(late))["state"]).toBe("unbound");
        const refused = await late.refusal("task.get");
        expect(refused).toMatchObject({ code: "unbound", hint: "Pass task, or ask the user." });
        expect(refused.message).toContain("session ended");
        // It works unbound with an explicit task (A3 3.7.3).
        expect(await late.call("task.get", { task: "M-2" })).toMatchObject({ bound: false });
        late.close();
      } finally {
        skew = 0;
      }
    },
  );
});
