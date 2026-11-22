// Session binding (A3 3.7, A3 5 "Binding tests", A7 3.9 M2.04) on a service in this process. Every
// connection is made as a bridge or a shell makes one, through the local endpoint (agents.ts): a
// bridge's bind frame and MCP tool calls, a shell's environment and op/call. A test reads what the
// endpoint answers, and the receipts and log the space kept. Launches are the world's: opened as a
// click opens them, on an agent home registered as setup does, and claimed in this process as a
// shim claims them. Fixture text and temporary folders only.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { JsonObject } from "@ttasks/bridge/protocol";
import { SHIM_METHODS } from "@ttasks/launch";
import { opCall, type OpsHost } from "../src/ops/index.ts";
import { bridge, ended, launchContext, onHost, shell, written, type Agent } from "./agents.ts";
import { contractWorld, type ContractWorld, type WorldLaunch } from "./contract/suite.ts";
import { stateOf } from "./harness.ts";
import { bridgeContext, openMcp, RawMcp, textOf } from "./mcp-helpers.ts";
import { classSession, grantHome } from "./ops-helpers.ts";

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
  // The agent homes the connections of no launch name, registered for Mira as setup does (the
  // grant gate, grant-gate.test.ts). Each world launch registers its own.
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

/** A bridge of no launch: an entry for Mira of the `test-agent` home, with `extra` over it. */
const connect = (extra: JsonObject = {}): Promise<Agent<string>> =>
  bridge(w, bridgeContext({ space: w.space, ...extra }));

/** The bridge a launched agent's app starts: the entry of the launch's home, with its ticket. */
const launched = (launch: WorldLaunch, env: Json = {}, extra: JsonObject = {}) =>
  bridge(w, { ...launchContext(w.space, launch, { env }), ...extra });

/** The session line of a connection's status: `Session: bound to M-1 …` or `Session: not bound …`. */
const sessionLine = async (agent: Agent<string>): Promise<string> =>
  (await agent.call("space.status")).split("\n").find((line) => line.startsWith("Session:")) ?? "";

/**
 * The writer scope a connection's changes are kept under, from the receipt of a note it adds to
 * its bound task: `session:<id>` for a session.
 */
async function scopeOf(agent: Agent<string>): Promise<string> {
  const request = rid();
  await agent.call("entry.add", { kind: "note", text: "Fixture note.", request_id: request });
  const receipts = await written(w, w.space, request);
  expect(receipts).toHaveLength(1);
  return receipts[0]?.scope ?? "";
}

/** The session a `session:<id>` scope is of. */
const sessionIn = (scope: string): string => {
  expect(scope).toMatch(/^session:se_/);
  return scope.slice("session:".length);
};

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
      const agent = await launched(launch);
      expect(agent.binding).toMatchObject({ state: "bound", space: w.space });
      expect(String(agent.binding?.["handle"])).toMatch(/^bh_[A-Za-z0-9_-]{22}$/);
      expect(await sessionLine(agent)).toContain("Session: bound to M-1");

      // The bound task is the default, and the actor is the session's, from the credential.
      const request = rid();
      const logged = await agent.call("entry.add", {
        kind: "progress",
        text: "Fixture progress through the ticket.",
        request_id: request,
      });
      expect(logged).toMatch(/^logged \S+ on M-1 /);
      const [receipt] = await written(w, w.space, request);
      const session = sessionIn(receipt?.scope ?? "");
      expect((await logOf("M-1"))[0]?.["author"]).toBe(`agent:${launch.instance}:${session}`);

      // A4 3.9.2: the bridge's binding is evidence for Confirmed.
      const confirmed = await waitLaunch(launch, (e) => typeof e["bound_at"] === "number");
      expect(confirmed.state).toBe("confirmed");
      await agent.close();

      // Machine state holds no secret: neither the ticket nor the handle, only its hash.
      const file = readFileSync(join(stateOf(w.home), "sessions.json"), "utf8");
      expect(file).not.toContain(launch.ticket);
      expect(file).not.toContain(String(agent.binding?.["handle"]));
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
          expect(agent.binding?.["state"], ticket).toBe("unbound");
          expect(await sessionLine(agent)).toContain("Session: not bound");
          await agent.close();
        }
      } finally {
        await other.close();
      }

      // A ticket of this install, presented by its launch's bridge whose entry names another space.
      const launch = await w.launch("M-2");
      const elsewhere = await launched(launch, {}, { space: "sp_0000000000000000000000000z" });
      expect(elsewhere.binding).toMatchObject({ state: "unbound" });
      await elsewhere.close();
      // Not spent by any of that: the right connection binds with it.
      const right = await launched(launch);
      expect(right.binding?.["state"]).toBe("bound");
      await right.close();
    },
  );

  test(
    "a ticket presented again: refused while its session's connection is open, honoured for the same session with its native ID or once that connection closed, and never after the agent ended",
    { timeout: LONG },
    async () => {
      const launch = await w.launch("M-3");
      const NATIVE = "11111111-2222-4333-8444-555555555555";
      const first = await launched(launch, { CLAUDE_CODE_SESSION_ID: NATIVE });
      expect(first.binding?.["state"]).toBe("bound");
      const session = await scopeOf(first);

      // A terminal opened from the launched one keeps the ticket: its bridge binds nothing.
      const lingering = await launched(launch);
      expect(lingering.binding?.["state"]).toBe("unbound");
      await lingering.close();

      // The agent app's MCP server again, with the native ID the session holds.
      const restarted = await launched(launch, { CLAUDE_CODE_SESSION_ID: NATIVE });
      expect(restarted.binding?.["state"]).toBe("bound");
      expect(await scopeOf(restarted)).toBe(session);
      await restarted.close();

      // No other connection of the session open, and the agent runs: honoured.
      await first.close();
      const again = await launched(launch);
      expect(again.binding?.["state"]).toBe("bound");
      expect(await scopeOf(again)).toBe(session);
      await again.close();

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
      const late = await launched(launch, { CLAUDE_CODE_SESSION_ID: NATIVE });
      expect(late.binding?.["state"]).toBe("unbound");
      await late.close();
    },
  );

  test(
    "a ticket binds nothing before its agent started or after its 15-minute window",
    { timeout: LONG },
    async () => {
      const early = await w.launch("M-1", { started: false });
      const before = await launched(early);
      expect(before.binding?.["state"]).toBe("unbound");
      await before.close();

      const late = await w.launch("M-2");
      skew = 15 * 60_000 + 1_000;
      try {
        const after = await launched(late);
        expect(after.binding?.["state"]).toBe("unbound");
        await after.close();
      } finally {
        skew = 0;
      }
    },
  );
});

describe("[A3.3.7.binding.reference] get_task with a launch reference binds once", () => {
  /** A get_task answer that bound the session by this call. */
  const BOUND = "Session: bound to this task by this call";

  test(
    "the first redemption binds; the same connection again gets the same binding, a resumed one too; another connection gets launch_used with the task",
    { timeout: LONG },
    async () => {
      const launch = await w.launch("M-2");
      const agent = await connect();
      expect(agent.binding?.["state"]).toBe("unbound");
      const loaded = await agent.call("task.get", { launch: launch.reference });
      expect(loaded).toContain("M-2");
      expect(loaded).toContain(BOUND);
      expect(await agent.call("task.get", { launch: launch.reference })).toContain(BOUND);
      expect(await sessionLine(agent)).toContain("Session: bound to M-2");
      await waitLaunch(launch, (e) => typeof e["bound_at"] === "number");
      const session = await scopeOf(agent);

      const second = await connect();
      const used = await second.refusal("task.get", { launch: launch.reference });
      expect(used.code).toBe("launch_used");
      expect(used.text).toContain("Pass task M-2 instead.");
      await second.close();

      // A reconnect with its handle is the same connection: the same binding.
      await agent.close();
      const resumed = await connect({
        resume: { handle: agent.binding?.["handle"] },
      });
      expect(resumed.binding).toMatchObject({ state: "bound", handle: agent.binding?.["handle"] });
      expect(await resumed.call("task.get", { launch: launch.reference })).toContain(BOUND);
      expect(await scopeOf(resumed)).toBe(session);
      await resumed.close();
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
      for (const input of [{ launch: two.reference }, { task: "M-3", bind: true }]) {
        const refused = await agent.refusal("task.get", input);
        expect(refused.code).toBe("already_bound");
        expect(refused.text).toContain("bound to M-1 already");
      }
      expect(await agent.call("task.get", { task: "M-1", bind: true })).toContain(BOUND);
      // The other launch was not used up by the refusal.
      const other = await connect();
      const read = await other.call("task.get", { launch: two.reference });
      expect(read).toContain(BOUND);
      expect(read).toContain("M-3");
      await agent.close();
      await other.close();
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
      expect((await agent.refusal("task.get", { launch: swapped })).code).toBe("launch_unknown");

      // Never sent: a terminal launch no shim claimed (its Brief reached no agent).
      const unclaimed = await w.launch("M-4", { claimed: false });
      expect((await agent.refusal("task.get", { launch: unclaimed.reference })).code).toBe(
        "launch_unknown",
      );

      // Ended: its shim's check failed (Failed), or its agent exited (its exit code recorded).
      const failed = await w.launch("M-4");
      if (failed.attachment === undefined) throw new Error("not claimed");
      await w.service.launches.host.report(failed.attachment, SHIM_METHODS.failed, {
        reason: "verify",
      });
      const expired = await agent.refusal("task.get", { launch: failed.reference });
      expect(expired.code).toBe("launch_expired");
      expect(expired.text).toContain("Pass task M-4 instead.");
      const exited = await w.launch("M-4");
      if (exited.attachment === undefined) throw new Error("not claimed");
      await w.service.launches.host.report(exited.attachment, SHIM_METHODS.exited, {
        code: 0,
        signal: null,
        ran_ms: 9_000,
        settled: true,
      });
      expect((await agent.refusal("task.get", { launch: exited.reference })).code).toBe(
        "launch_expired",
      );

      // More than 24 hours after its click.
      const later = await agent.refusal(
        "task.get",
        { launch: fresh.reference },
        { host: () => ({ now: () => Date.now() + 25 * 60 * 60_000 }) },
      );
      expect(later.code).toBe("launch_expired");
      expect(later.text).toContain("Pass task M-4 instead.");

      // The session was bound by none of them, and the fresh launch still binds.
      expect(await sessionLine(agent)).toContain("Session: not bound");
      expect(await agent.call("task.get", { launch: fresh.reference })).toContain(BOUND);
      await agent.close();
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
      expect(await agent.call("task.get", { launch: launch.reference })).toContain(BOUND);
      await agent.close();
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
      const input = {
        task: "M-1",
        kind: "progress",
        text: "Fixture progress before binding.",
        request_id: request,
      };
      const first = await agent.call("entry.add", input);
      expect((await logOf("M-1"))[0]?.["author"]).toBe("agent:test-agent");

      const bound = await agent.call("task.get", { task: "M-3", bind: true });
      expect(bound).toContain("Session: bound to this task by this call");
      expect(bound).toContain("M-3");
      expect(await agent.call("entry.add", input)).toBe(`${first} (replayed)`);
      expect(await written(w, w.space, request)).toEqual([
        { scope: expect.stringMatching(/^bridge:test-agent:/) as unknown, status: "applied" },
      ]);

      expect(
        await agent.call("entry.add", { kind: "note", text: "Fixture note.", request_id: rid() }),
      ).toMatch(/^noted \S+ on M-3 /);
      expect(
        await agent.call("entry.add", {
          task: "M-1",
          kind: "progress",
          text: "Fixture progress on another task.",
          request_id: rid(),
        }),
      ).toMatch(/^logged \S+ on M-1 /);
      expect(await sessionLine(agent)).toContain("Session: bound to M-3");
      expect(await agent.call("task.get", { bind: true })).toContain(
        "Session: bound to this task by this call",
      );
      const session = sessionIn(await scopeOf(agent));
      expect((await logOf("M-1"))[0]?.["author"]).toBe(`agent:test-agent:${session}`);
      await agent.close();

      // Without a task and unbound: nothing to bind.
      const loose = await connect();
      expect((await loose.refusal("task.get", { bind: true })).code).toBe("unbound");
      await loose.close();
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
      expect(agent.binding?.["state"]).toBe("unbound");
      const status = await agent.call("space.status", { cwd: w.portal });
      expect(status).toContain("Session: not bound");
      expect(status).toContain("Space: Mira (M)");
      expect(status).toMatch(/M-4 .*exact/);
      expect(status).toContain("bind true");
      // Still unbound: the folder named no task.
      const refused = await agent.refusal("task.get", { cwd: w.portal });
      expect(refused.code).toBe("unbound");
      expect(refused.text).toContain("M-4");
      expect(await sessionLine(agent)).toContain("Session: not bound");
      expect(
        (await agent.refusal("task.get", { task: "M-4", session: "se_0000000000000000000000000z" }))
          .code,
      ).toBe("invalid_input");
      await agent.close();
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

      // The launched agent's session. No tool names a space, so its shell is what names one: the
      // same session, and its call goes nowhere else.
      const launch = await w.launch("M-2");
      const agent = await launched(launch);
      expect(agent.binding?.["state"]).toBe("bound");
      const sh = await shell(w, { TTASKS_TICKET: launch.ticket });
      expect((await sh.refusal("space.status", {}, { space: life })).body).toMatchObject({
        code: "forbidden",
        data: { rule: "binding" },
      });
      await sh.close();

      // Resumed through a bind frame that names the other space: still its own.
      await agent.close();
      const resumed = await launched(
        launch,
        {},
        { space: life, resume: { handle: agent.binding?.["handle"] } },
      );
      expect(resumed.binding).toMatchObject({ state: "bound", space: w.space });
      const status = await resumed.call("space.status");
      expect(status).toContain("Space: Mira (M)");
      expect(status).toContain("Session: bound to M-2");
      await resumed.close();

      // An unbound connection pinned to Life (its home registered for Life): once Life is
      // closed, unavailable, never Mira.
      await grantHome(w.home, w.path, { instance: "life-agent", space: life });
      const pinned = await connect({ space: life, instance: "life-agent" });
      expect(pinned.binding?.["space"]).toBe(life);
      expect(await pinned.call("space.status")).toContain("Space: Life (L)");
      const closer = await classSession(w.home, w.path, "cli-interactive");
      try {
        await closer.call("space/close", { space: life }, { timeoutMs: 60_000 });
      } finally {
        closer.close();
      }
      const unavailable = await pinned.refusal("space.status");
      expect([unavailable.code, unavailable.reason]).toEqual(["space_unavailable", "not_served"]);
      await pinned.close();
    },
  );
});

describe("[A3.3.7.binding.cli] a cli-agent call's ticket maps to its live session and redeems no role", () => {
  test(
    "no session yet: agent:unknown, and the bridge still binds; then the session's actor; after the agent ended, nothing",
    { timeout: LONG },
    async () => {
      const launch = await w.launch("M-3");
      const env = { TTASKS_TICKET: launch.ticket };
      const early = rid();
      const earlyInput = {
        task: "M-3",
        kind: "progress",
        text: "Fixture progress from the shell.",
        request_id: early,
      };
      // No session for the launch yet: no mapping, so the agent's CLI names its space (A2
      // 3.10.5) and writes as agent:unknown. Its ticket is not spent by it.
      const cli = await shell(w, env);
      const first = await cli.call("entry.add", earlyInput, { space: w.space });
      expect((await logOf("M-3"))[0]?.["author"]).toBe("agent:unknown");
      await cli.close();
      const agent = await launched(launch);
      expect(agent.binding?.["state"]).toBe("bound");

      const mapped = await shell(w, env);
      try {
        // The shell's retry of its unmapped write, once mapped: its first result, not a second
        // entry (A3 3.7.9: binding later never resets anything).
        const newest = (await logOf("M-3"))[0];
        expect(await mapped.call("entry.add", earlyInput)).toMatchObject({
          ...first,
          replayed: true,
        });
        expect((await logOf("M-3"))[0]).toEqual(newest);
        expect(await written(w, w.space, early)).toEqual([
          { scope: expect.stringMatching(/^agent:unknown:/) as unknown, status: "applied" },
        ]);

        // No task, no space: the session's task in the session's space, as the session.
        const request = rid();
        const logged = await mapped.call("entry.add", {
          kind: "progress",
          text: "Fixture progress, mapped.",
          request_id: request,
        });
        expect(logged).toMatchObject({ task: "M-3" });
        const [receipt] = await written(w, w.space, request);
        const session = sessionIn(receipt?.scope ?? "");
        expect(await scopeOf(agent)).toBe(receipt?.scope);
        expect((await logOf("M-3"))[0]?.["author"]).toBe(`agent:${launch.instance}:${session}`);
        // A mapped call binds nothing new.
        const other = await w.launch("M-1");
        expect((await mapped.refusal("task.get", { launch: other.reference })).code).toBe(
          "already_bound",
        );
      } finally {
        await mapped.close();
        await agent.close();
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
      let holding = true;
      const held = (own: OpsHost): Partial<OpsHost> => ({
        spaces: () =>
          own.spaces().map((s) => {
            const writer = s.writer;
            if (writer === undefined) return s;
            return {
              ...s,
              writer: new Proxy(writer, {
                get(target, key) {
                  if (key === "submit") {
                    return async (request_: { readonly request_id: string }) => {
                      if (holding && request_.request_id === request) {
                        holding = false;
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
      });
      const env = { TTASKS_TICKET: launch.ticket };
      const input = {
        task: "M-4",
        kind: "progress",
        text: "Fixture progress held in flight.",
        request_id: request,
      };
      // No session for the launch yet: the shell's write is agent:unknown's, held in the writer
      // while the session appears and the retry comes.
      const first = await shell(w, env);
      const mapped = await shell(w, env);
      let agent: Agent<string> | undefined;
      const [original, retry] = await onHost(w, held, async () => {
        const original = first.call("entry.add", input, { space: w.space });
        await atGate;
        agent = await launched(launch);
        expect(agent.binding?.["state"]).toBe("bound");
        const retry = mapped.call("entry.add", input);
        await new Promise((resolve) => setTimeout(resolve, 50));
        open();
        return Promise.all([original, retry]);
      });
      expect(retry).toMatchObject({ ...original, replayed: true });
      const log = JSON.stringify(await logOf("M-4"));
      expect(log.split(input.text).length - 1).toBe(1);
      await first.close();
      await mapped.close();
      await agent?.close();
    },
  );

  test(
    "a shell's write retried once its agent's exit is on disk, before the PID check settles the launch, commits once",
    { timeout: LONG },
    async () => {
      const launch = await w.launch("M-2");
      const agent = await launched(launch);
      expect(agent.binding?.["state"]).toBe("bound");
      const sh = await shell(w, { TTASKS_TICKET: launch.ticket });
      const input = {
        task: "M-2",
        kind: "progress",
        text: "Fixture progress retried across the exit.",
        request_id: rid(),
      };
      const write = (): Promise<Json> => sh.call("entry.add", input, { space: w.space });
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
        expect(await written(w, w.space, input.request_id)).toHaveLength(1);
      } finally {
        await sh.close();
        await agent.close();
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
      const first = await connect({ instance: "wire-agent" });
      const second = await connect({ instance: "wire-agent" });
      try {
        expect(first.binding).toMatchObject({ state: "unbound", space: w.space });
        expect(await first.call("task.get", { launch: launch.reference })).toContain(
          "Session: bound to this task by this call",
        );
        expect(await first.call("space.status")).toContain("Session: bound to M-1");
        expect((await second.refusal("task.get", { launch: launch.reference })).text).toMatch(
          /^error launch_used/,
        );
      } finally {
        await first.close();
        await second.close();
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
      expect(await other.call("task.get", { launch: two.reference })).toContain(
        "Session: bound to this task by this call",
      );
      await other.close();
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
      await agent.close();
      const handle = String(agent.binding?.["handle"]);

      for (const [extra, why] of [
        [{ instance: "other-agent", resume: { handle } }, "another instance's"],
        [{ resume: { handle: `bh_${"A".repeat(22)}` } }, "forged"],
        [{ resume: { handle: "not a handle" } }, "malformed"],
      ] as const) {
        const tried = await connect(extra);
        expect(tried.binding?.["state"], why).toBe("unbound");
        expect(tried.binding?.["handle"], why).not.toBe(handle);
        await tried.close();
      }
      const back = await connect({ resume: { handle } });
      expect(back.binding).toMatchObject({ state: "bound", handle });
      await back.close();
      // Its last use is its end, which the service must have seen before the clock moves.
      await ended(w);

      skew = 24 * 60 * 60_000 + 1_000;
      try {
        const late = await connect({ resume: { handle } });
        expect(late.binding?.["state"]).toBe("lost");
        expect(late.binding?.["handle"]).not.toBe(handle);
        expect(await sessionLine(late)).toContain("Session: not bound");
        const refused = await late.refusal("task.get");
        expect(refused.code).toBe("unbound");
        expect(refused.text).toContain("session ended");
        expect(refused.text).toContain("Pass task, or ask the user.");
        // It works unbound with an explicit task (A3 3.7.3).
        const read = await late.call("task.get", { task: "M-2" });
        expect(read).toContain("M-2");
        expect(read).not.toContain("Session: bound to this task by this call");
        await late.close();
      } finally {
        skew = 0;
      }
    },
  );
});
