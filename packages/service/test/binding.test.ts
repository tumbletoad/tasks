// Who an agent's connection is, on a service in this process. Every connection is made as a bridge
// or a shell makes one, through the local endpoint (agents.ts): a bridge's bind frame and MCP tool
// calls, a shell's environment and op/call. A test reads what the endpoint answers, and the
// receipts and log the space and the service kept. Launches are the world's: opened as a click
// opens them, on an agent home registered as setup does, and claimed in this process as a shim
// claims them. Fixture text and temporary folders only.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { JsonObject } from "@ttasks/bridge/protocol";
import { SHIM_METHODS } from "@ttasks/launch";
import { opCall, type OpsHost } from "../src/ops/index.ts";
import { bridge, launchContext, onHost, shell, written, type Agent } from "./agents.ts";
import { contractWorld, type ContractWorld, type WorldLaunch } from "./contract/suite.ts";
import { readLog } from "./harness.ts";
import { bridgeContext } from "./mcp-helpers.ts";
import { classSession, grantHome, revokeHome } from "./ops-helpers.ts";

type Json = Record<string, unknown>;
const LONG = 180_000;

let w: ContractWorld & { root: string };
/** Added to the wall clock launching reads: a test moves it to show there is no window. */
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
  // The agent homes of the connections of no launch, registered for Mira as setup does. Each world
  // launch registers its own.
  for (const instance of ["test-agent", "wire-agent"]) {
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

/** The session a launch is: named after it. */
const sessionOfLaunch = (launch: WorldLaunch): string => `se_${launch.id.slice("la_".length)}`;

/**
 * The writer scope a connection's changes are kept under, from the receipt of a note it adds to
 * its session's task: `session:<id>` for a session.
 */
async function scopeOf(agent: Agent<unknown>): Promise<string> {
  const request = rid();
  await agent.call("entry.add", { kind: "note", text: "Fixture note.", request_id: request });
  const receipts = await written(w, w.space, request);
  expect(receipts).toHaveLength(1);
  return receipts[0]?.scope ?? "";
}

/** The log entries of a task, newest first, with their authors (A1's history). */
async function logOf(task: string): Promise<Json[]> {
  const read = await user("task.get", { task, sections: ["log"] });
  return ((read["sections"] as Json)["log"] as Json[] | undefined) ?? [];
}

/** The service's `binding.*` log events from `mark` on: how a connection bound, or why it did not. */
const bindingLog = (mark: number): Json[] =>
  readLog(w.home)
    .slice(mark)
    .filter((e) => String(e["ev"]).startsWith("binding."))
    .map(({ ev, how, reason }) => ({
      ev,
      ...(how === undefined ? {} : { how }),
      ...(reason === undefined ? {} : { reason }),
    }));

/** The agent's end as the shim reports it: the launch is released. */
async function exited(launch: WorldLaunch): Promise<void> {
  if (launch.attachment === undefined) throw new Error("the launch was not claimed");
  const ended = await w.service.launches.host.report(launch.attachment, SHIM_METHODS.exited, {
    code: 0,
    signal: null,
    ran_ms: 5_000,
    settled: true,
  });
  expect(ended.kind).toBe("applied");
}

describe("[A3.3.7.binding.ticket] a launched agent's bridge is its session by the value TTasks issued, its app and its home's instance", () => {
  test(
    "from the claim and with no window: the bind answer, the default task, the actor and the scope are the session's, named after the launch, and the launch records nothing for it",
    { timeout: LONG },
    async () => {
      const mark = readLog(w.home).length;
      const launch = await w.launch("M-1", { started: false });
      const agent = await launched(launch);
      expect(agent.binding).toEqual({ space: w.space, state: "bound" });
      expect(await sessionLine(agent)).toContain("Session: bound to M-1");

      const request = rid();
      const logged = await agent.call("entry.add", {
        kind: "progress",
        text: "Fixture progress through the ticket.",
        request_id: request,
      });
      expect(logged).toMatch(/^logged \S+ on M-1 /);
      const session = sessionOfLaunch(launch);
      expect(await written(w, w.space, request)).toEqual([
        { scope: `session:${session}`, status: "applied" },
      ]);
      expect((await logOf("M-1"))[0]?.["author"]).toBe(`agent:${launch.instance}:${session}`);
      // A bind writes nothing: the launch\'s Connected comes from its terminal, not from its bridge.
      expect((await w.service.launches.read(w.space, launch.id))?.evidence["bound_at"]).toBe(
        undefined,
      );
      await agent.close();

      // Twenty minutes later, and again: the same session.
      skew = 20 * 60_000;
      try {
        const later = await launched(launch);
        expect(later.binding?.["state"]).toBe("bound");
        expect(await scopeOf(later)).toBe(`session:${session}`);
        await later.close();
      } finally {
        skew = 0;
      }
      expect(bindingLog(mark)).toEqual([
        { ev: "binding.bound", how: "ticket" },
        { ev: "binding.bound", how: "ticket" },
      ]);
      expect(JSON.stringify(readLog(w.home).slice(mark))).not.toContain(launch.ticket);
    },
  );

  test(
    "values that name nothing live are as if none was presented: forged, malformed, a launch no shim claimed, one whose agent ended, one whose click recorded no app",
    { timeout: LONG },
    async () => {
      const unclaimed = await w.launch("M-2", { claimed: false });
      const noApp = await w.launch("M-2", { home: "no-app" });
      const ended = await w.launch("M-2");
      await exited(ended);
      for (const ticket of [
        "0123456789ABCDEFGHJKMNPQ", // its form, issued by no one
        "not a ticket",
        unclaimed.ticket,
        noApp.ticket,
        ended.ticket,
      ]) {
        const agent = await connect({ env: { TTASKS_TICKET: ticket } });
        expect(agent.binding, ticket).toEqual({ space: w.space, state: "unbound" });
        expect(await sessionLine(agent)).toContain("Session: not bound");
        expect(await scopeOf(agent).catch((e: unknown) => e)).toMatchObject({
          refusal: { code: "unbound" },
        });
        await agent.close();
        const sh = await shell(w, { TTASKS_TICKET: ticket });
        expect(
          (await sh.refusal("entry.add", { kind: "note", text: "x", request_id: rid() })).code,
        ).toBe(
          "invalid_input", // no space named: an agent's shell that is no session names its space
        );
        await sh.close();
      }
    },
  );

  test(
    "the bridge presents the click's app and its home's instance: another app, another or a malformed instance are none; a home that never had a row is manual; with only revoked rows its instance is the session and every call is refused",
    { timeout: LONG },
    async () => {
      const mark = readLog(w.home).length;
      const launch = await w.launch("M-3");
      const other = await bridge(w, launchContext(w.space, launch, { present: "other-instance" }));
      expect(other.binding?.["state"]).toBe("unbound");
      await other.close();
      for (const extra of [
        { app: "claude-code" },
        { app: null },
        { instance: "Not An Instance" },
      ]) {
        const wrong = await launched(launch, {}, extra);
        expect(wrong.binding?.["state"], JSON.stringify(extra)).toBe("unbound");
        await wrong.close();
      }
      expect(bindingLog(mark)).toEqual([
        { ev: "binding.unbound", reason: "home" },
        { ev: "binding.unbound", reason: "app" },
        { ev: "binding.unbound", reason: "app" },
        { ev: "binding.unbound", reason: "home" },
      ]);

      // Setup never registered the home: the hand-made entry, with no --instance, is the session
      // as `manual`, in the machine's default space (Mira, the only one so far).
      const handMade = await w.launch("M-3", { home: "no-row" });
      const named = await launched(handMade);
      expect(named.binding?.["state"]).toBe("unbound");
      await named.close();
      const manual = await launched(handMade, {}, { instance: null });
      expect(manual.binding).toEqual({ space: w.space, state: "bound" });
      await manual.call("entry.add", {
        kind: "progress",
        text: "Fixture progress, hand-made.",
        request_id: rid(),
      });
      expect((await logOf("M-3"))[0]?.["author"]).toBe(`agent:manual:${sessionOfLaunch(handMade)}`);
      await manual.close();

      // Its registration removed: its own instance is still its session, refused on every call.
      const revoked = await w.launch("M-3", { home: "revoked" });
      const stopped = await launched(revoked);
      expect(stopped.binding?.["state"]).toBe("bound");
      for (const [op, input] of [
        ["space.status", {}],
        ["entry.add", { kind: "note", text: "x", request_id: rid() }],
      ] as const) {
        expect((await stopped.refusal(op, input)).text, op).toContain(
          "not registered for this space",
        );
      }
      await stopped.close();
    },
  );

  test(
    "the preset alone makes the bridge the session, as with the ticket stripped in allow-list mode, under the same scope as its shell's ticket; a ticket and a preset of two live launches are none",
    { timeout: LONG },
    async () => {
      const mark = readLog(w.home).length;
      const launch = await w.launch("M-4", { preset: true });
      const preset = launch.preset ?? "";
      const stripped = await bridge(
        w,
        bridgeContext({
          space: w.space,
          instance: launch.instance,
          app: launch.app ?? null,
          env: { CLAUDE_CODE_SESSION_ID: preset },
        }),
      );
      expect(stripped.binding?.["state"]).toBe("bound");
      const scope = await scopeOf(stripped);
      expect(scope).toBe(`session:${sessionOfLaunch(launch)}`);
      const sh = await shell(w, { TTASKS_TICKET: launch.ticket });
      expect(await scopeOf(sh)).toBe(scope);
      await sh.close();
      await stripped.close();

      const another = await w.launch("M-4");
      const two = await launched(another, { CLAUDE_CODE_SESSION_ID: preset });
      expect(two.binding?.["state"]).toBe("unbound");
      await two.close();
      const both = await shell(w, {
        TTASKS_TICKET: another.ticket,
        CLAUDE_CODE_SESSION_ID: preset,
      });
      expect((await both.call("space.status", {}, { space: w.space }))["session"]).toEqual({
        state: "unbound",
      });
      await both.close();
      expect(bindingLog(mark)).toEqual([
        { ev: "binding.bound", how: "preset" },
        { ev: "binding.bound", how: "ticket" },
        { ev: "binding.unbound", reason: "values" },
        { ev: "binding.unbound", reason: "values" },
      ]);
    },
  );

  test(
    "an open bridge keeps who it is: after its agent's end it stays the session until it disconnects; a new bind or a shell then is the app's or an unknown agent's, and a retry through it is a new change",
    { timeout: LONG },
    async () => {
      const launch = await w.launch("M-1");
      const helper = await launched(launch);
      expect(helper.binding?.["state"]).toBe("bound");
      const input = {
        task: "M-1",
        kind: "progress",
        text: "Fixture progress before the end.",
        request_id: rid(),
      };
      await helper.call("entry.add", input);
      await exited(launch);

      // Accepted: a program the agent left running, connected when it ended, is still its session.
      expect(
        await helper.call("entry.add", { kind: "note", text: "Fixture note.", request_id: rid() }),
      ).toMatch(/^noted \S+ on M-1 /);
      const late = await launched(launch);
      expect(late.binding?.["state"]).toBe("unbound");
      expect(
        (await late.refusal("entry.add", { kind: "note", text: "x", request_id: rid() })).code,
      ).toBe("unbound");
      // The same request again after the end: a new change under the app's scope.
      expect(await late.call("entry.add", input)).not.toContain("(replayed)");
      expect((await written(w, w.space, input.request_id)).map((r) => r.scope)).toEqual([
        `bridge:${launch.instance}:${w.service.ops.machine.id}`,
        `session:${sessionOfLaunch(launch)}`,
      ]);
      await late.close();
      await helper.close();
      const sh = await shell(w, { TTASKS_TICKET: launch.ticket });
      expect(
        await sh.call("entry.add", { ...input, request_id: rid() }, { space: w.space }),
      ).toMatchObject({ task: "M-1" });
      expect((await logOf("M-1"))[0]?.["author"]).toBe("agent:unknown");
      await sh.close();
    },
  );
});

describe("[A3.3.7.binding.cli] an agent's shell is the session when a live value names its launch, decided at each call", () => {
  test(
    "no bridge needed: from the claim the shell is the session, its task the default in its space, and its bridge shares its scope, so a retry through the other tool replays",
    { timeout: LONG },
    async () => {
      const launch = await w.launch("M-3", { started: false });
      const sh = await shell(w, { TTASKS_TICKET: launch.ticket });
      const input = {
        kind: "progress",
        text: "Fixture progress from the shell.",
        request_id: rid(),
      };
      const first = await sh.call("entry.add", input);
      expect(first).toMatchObject({ task: "M-3" });
      const session = sessionOfLaunch(launch);
      expect((await logOf("M-3"))[0]?.["author"]).toBe(`agent:${launch.instance}:${session}`);
      const agent = await launched(launch);
      expect(await agent.call("entry.add", input)).toContain("(replayed)");
      expect(await written(w, w.space, input.request_id)).toEqual([
        { scope: `session:${session}`, status: "applied" },
      ]);
      await agent.close();
      // A task's session is no run: run_report is refused, and says so.
      expect(
        (
          await sh.refusal("run.report", {
            sources: [{ name: "Mail", state: "ok", items_seen: 1 }],
            summary: "Fixture summary, refused.",
            request_id: rid(),
          })
        ).body,
      ).toMatchObject({ code: "not_permitted", data: { binding: "task" } });

      // Its home's registration removed: the next call is refused; registered again, it goes on.
      const row = launch.row ?? "";
      expect(await revokeHome(w.home, w.path, [row])).toBe(1);
      const refused = await sh.refusal("space.status");
      expect(refused.body).toMatchObject({ code: "forbidden", data: { rule: "grant" } });
      await grantHome(w.home, w.path, { instance: launch.instance, space: w.space });
      expect((await sh.call("space.status"))["session"]).toMatchObject({
        state: "bound",
        task: "M-3",
      });
      await sh.close();
    },
  );

  test(
    "a shell's write held in the writer while its retry comes through the agent's bridge: one commit, and both answers are the same change",
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
      const input = {
        kind: "progress",
        text: "Fixture progress held in flight.",
        request_id: request,
      };
      const sh = await shell(w, { TTASKS_TICKET: launch.ticket });
      const agent = await launched(launch);
      const [original, retry] = await onHost(w, held, async () => {
        const original = sh.call("entry.add", input);
        await atGate;
        const retry = await agent.call("entry.add", input);
        open();
        return [await original, retry] as const;
      });
      expect(original).toMatchObject({ task: "M-4", replayed: true });
      expect(retry).not.toContain("(replayed)");
      const log = JSON.stringify(await logOf("M-4"));
      expect(log.split(input.text).length - 1).toBe(1);
      expect(await written(w, w.space, request)).toHaveLength(1);
      await sh.close();
      await agent.close();
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

describe("[A3.3.7.binding.reference] a launch reference reads its task on any connection and never binds", () => {
  test(
    "every connection reads it, the second as the first; it is bound only for the launch's own session, which reads its task by task too",
    { timeout: LONG },
    async () => {
      const launch = await w.launch("M-2");
      const first = await connect();
      const loaded = await first.call("task.get", { launch: launch.reference });
      expect(loaded).toContain("M-2");
      expect(loaded).toContain("Pass task M-2 on each call: this connection is not its session");
      expect(await sessionLine(first)).toContain("Session: not bound");
      const second = await connect();
      expect(await second.call("task.get", { launch: launch.reference })).toContain("M-2");
      await first.close();
      await second.close();

      const own = await launched(launch);
      const read = await own.call("task.get", { launch: launch.reference });
      expect(read).toContain("Session: this task's, so calls without task act on it");
      await own.close();
      const sh = await shell(w, { TTASKS_TICKET: launch.ticket });
      expect(await sh.call("task.get", { task: "M-2" })).toMatchObject({ bound: true });
      expect(await sh.call("task.get", { task: "M-1" })).toMatchObject({ bound: false });
      await sh.close();
    },
  );

  test(
    "a mistyped reference and one no launch here has are unknown; any launch that left the service reads, whatever its age or state",
    { timeout: LONG },
    async () => {
      const agent = await connect();
      const fresh = await w.launch("M-4");
      // One changed symbol fails the check character.
      const swapped = `${fresh.reference.slice(0, 1)}${fresh.reference[1] === "2" ? "3" : "2"}${fresh.reference.slice(2)}`;
      expect((await agent.refusal("task.get", { launch: swapped })).code).toBe("launch_unknown");
      expect((await agent.refusal("task.get", { launch: "L00000" })).code).toBe("launch_unknown");
      const unclaimed = await w.launch("M-4", { claimed: false });

      const failed = await w.launch("M-4");
      if (failed.attachment === undefined) throw new Error("not claimed");
      await w.service.launches.host.report(failed.attachment, SHIM_METHODS.failed, {
        reason: "verify",
      });
      const ended = await w.launch("M-4");
      await exited(ended);
      for (const launch of [unclaimed, failed, ended]) {
        expect(await agent.call("task.get", { launch: launch.reference })).toContain("M-4");
      }
      expect(
        await agent.call(
          "task.get",
          { launch: fresh.reference },
          { host: () => ({ now: () => Date.now() + 25 * 60 * 60_000 }) },
        ),
      ).toContain("M-4");
      await agent.close();
    },
  );

  test(
    "the person's classes and a script read it as well, and are no session",
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
      }
      const old = await connect();
      expect((await old.refusal("task.get", { task: "M-1", bind: true })).code).toBe(
        "invalid_input",
      );
      await old.close();
    },
  );
});

describe("[A3.3.7.binding.folder] a working folder, a hint or an argument never chooses the task", () => {
  test(
    "the bind frame's cwd, TTASKS_TASK and TTASKS_SPACE, status with one exact match, and a tool argument naming a session leave the connection no session",
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
      expect(status).toContain("pass task M-4 on each call");
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

describe("[A3.3.7.binding.space] one bridge process works in one space", () => {
  test(
    "a session works in its launch's space whatever its entry or a call names; a space its bridge holds wins over a launch's, and is kept while denied or closed, never replaced",
    { timeout: LONG },
    async () => {
      const life = await w.other();
      await user("task.add", { tasks: [{ title: "Fixture life task" }], request_id: rid() }, life);

      // An entry for Life presented by the agent of a launch in Mira: its session, in Mira.
      const launch = await w.launch("M-2");
      const agent = await launched(launch, {}, { space: life });
      expect(agent.binding).toEqual({ space: w.space, state: "bound" });
      expect(await agent.call("space.status")).toContain("Space: Mira (M)");
      await agent.close();
      const sh = await shell(w, { TTASKS_TICKET: launch.ticket });
      expect((await sh.refusal("space.status", {}, { space: life })).body).toMatchObject({
        code: "forbidden",
        data: { rule: "binding" },
      });
      await sh.close();

      // The same bridge process holds Life from an earlier bind: it stays there, no session. Its
      // home may not use Life, and the refusal names the space it may use.
      const held = await launched(launch, {}, { held_space: life });
      expect(held.binding).toEqual({ space: life, state: "unbound" });
      const denied = await held.refusal("space.status");
      expect(denied.code).toBe("forbidden");
      expect(denied.text).toContain("It may use the space Mira now");
      await held.close();

      // A connection that is no session, holding Life (its home registered for Life): once Life is
      // closed, unavailable, never Mira.
      await grantHome(w.home, w.path, { instance: "life-agent", space: life });
      const pinned = await connect({ space: life, instance: "life-agent" });
      expect(pinned.binding).toEqual({ space: life, state: "unbound" });
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

describe("[A3.3.7.binding.wire] the same over real ttasks-local/1 mcp mode connections", () => {
  test(
    "the bind result is the space and the state, with no handle; an old bridge's handle is ignored",
    { timeout: LONG },
    async () => {
      const first = await connect({ instance: "wire-agent" });
      const old = await connect({
        instance: "wire-agent",
        resume: { handle: "bh_0123456789abcdefghijkl" },
      });
      try {
        expect(first.binding).toEqual({ space: w.space, state: "unbound" });
        expect(old.binding).toEqual({ space: w.space, state: "unbound" });
        expect(await old.call("space.status")).toContain("Session: not bound");
      } finally {
        await first.close();
        await old.close();
      }
    },
  );
});
