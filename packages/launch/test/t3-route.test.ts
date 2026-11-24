// The T3 primary route against a fake T3 server (A4 3.4.1, 3.9.2, 3.9.3, A4 5.1 "Fake T3 server",
// A7 3.9 M2.11). The Verify line: a lost reply, then the repeat, returns the same thread across an
// HTTP reconnect and across a T3 restart; after an OAuth reauthorization the intent is Unknown and
// no thread is created; a 401 leads to "Reconnect T3"; a nested folder becomes a project of its own
// and the containing project is never used. The launch machine runs on the in-memory store with the route as its T3 step
// and recovery, as the service will compose them. Fixture text, a temporary folder and a fake T3 on
// a loopback port the OS assigns; nothing here reaches a real T3.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FakeT3 } from "@ttasks/testkit/fake-t3";
import { LaunchMachine, type RecoverySteps } from "../src/machine.ts";
import { resolvePlace, type RootFolder } from "../src/places.ts";
import type { LaunchIntent } from "../src/store.ts";
import { T3_TEXT, T3Route, type T3Prepared } from "../src/t3-route.ts";
import { MemoryT3Files, readPairing } from "../src/t3-state.ts";
import { MemoryDurable, MemoryExecutionStore, randomId } from "./memory-store.ts";
import { MACHINE } from "./stores.ts";

/** Generous: a loaded runner must not fail a test that is only slow. */
const SLOW = 60_000;

let base: string;
let fake: FakeT3;
let files: MemoryT3Files;
let route: T3Route;
let durable: MemoryDurable;
let opened: string[];
let now: number;
let roots: RootFolder[];

const INSTANCE = {
  openPermission: "full-access",
  t3: { environment: "local", providerInstance: "codex", model: "fixture-model" },
} as const;
const BRIEF = "M-14 Fixture task. Read the task with TTasks's tools (launch L7KQ2M).";

function newRoute(): T3Route {
  return new T3Route({
    home: fake.home,
    files,
    open: (url) => {
      opened.push(url);
      return Promise.resolve(true);
    },
    now: () => now,
    requestMs: 15_000,
    pairDeadlineMs: 30_000,
  });
}

/** Plays `ttasks setup t3`: a pairing attempt approved on the fake's page. */
async function pair(through: T3Route = route): Promise<void> {
  const attempt = await through.beginPairing();
  expect(await fake.approveInBrowser(attempt.url)).toBe(200);
  await through.finishPairing(attempt);
}

/** The machine as the service composes it: the route is its T3 step and recovery. */
function machine(recovery: Partial<RecoverySteps> = {}): LaunchMachine {
  return new LaunchMachine({
    store: new MemoryExecutionStore(durable),
    machine: MACHINE,
    steps: { dispatch: (intent) => route.dispatch(intent) },
    recovery: {
      observe: () => Promise.resolve({ kind: "pending" }),
      grant: () => route.grant(),
      replay: (intent) => route.replay(intent),
      ...recovery,
    },
  });
}

function folder(...parts: string[]): string {
  const path = join(base, "work", ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

/** The Prepared step for a place under the `work` root. */
async function prepare(path: string, name = path): Promise<{ prepared: T3Prepared }> {
  const resolution = await resolvePlace({ root: "work", path }, roots);
  if (resolution.status !== "ok") throw new Error(`fixture place: ${resolution.reason}`);
  const prepared = await route.prepare({
    folder: { path: resolution.folder, identity: resolution.identity },
    name,
  });
  return { prepared };
}

let clicks = 0;

/** Open: the Prepared step, the click, the plan, then the dispatch under the current grant. */
async function launch(
  m: LaunchMachine,
  path: string,
): Promise<{ intent: LaunchIntent; dispatched: LaunchIntent | undefined }> {
  const resolution = await resolvePlace({ root: "work", path }, roots);
  if (resolution.status !== "ok") throw new Error("fixture place");
  const { prepared } = await prepare(path);
  if (prepared.kind !== "bound") throw new Error(`not bound: ${prepared.kind}`);
  clicks += 1;
  const intent = await m.open(
    {
      task: randomId("t"),
      instance: "t3-codex",
      route: "t3-mcp",
      place: randomId("pl"),
      taskVersion: 1,
      briefHash: "a".repeat(64),
    },
    `t3-click-${String(clicks).padStart(8, "0")}`,
  );
  const planned = route.plan(intent.id, {
    projectId: prepared.projectId,
    strategy: prepared.strategy,
    title: "M-14 Fixture task",
    instance: INSTANCE,
    folder: resolution.identity,
  });
  if (planned.kind !== "ready") throw new Error(`no plan: ${planned.reason}`);
  const dispatched = await m.dispatch(intent.id, { grant: planned.grant });
  return { intent, dispatched };
}

beforeEach(async () => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "ttasks-t3-")));
  fake = await FakeT3.start(join(base, "t3home"));
  files = new MemoryT3Files();
  durable = new MemoryDurable();
  opened = [];
  now = Date.UTC(2026, 10, 14, 9, 0, 0);
  roots = [{ id: "work", path: join(base, "work") }];
  folder();
  route = newRoute();
  await pair();
}, SLOW);

afterEach(async () => {
  await fake.stop();
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("[A4.5.t3.fake-server] the T3 primary route against a fake T3 server", () => {
  test(
    "an idle thread at the exact root: the grant on the intent, no message, the folder check, the draft",
    async () => {
      const lumen = fake.addProject(folder("lumen"), "lumen");
      const m = machine();
      const { intent, dispatched } = await launch(m, "lumen");
      const grant = readPairing(files)?.grant;
      expect(grant).toMatch(/^t3g-/u);
      expect(dispatched?.state).toBe("dispatched");
      expect(dispatched?.evidence.grant).toBe(grant);
      const thread = dispatched?.evidence.thread ?? "";
      const made = fake.threads.get(thread);
      expect(made).toMatchObject({
        projectId: lumen,
        worktreePath: null,
        clientRequestId: intent.id,
        message: false,
        runtimeMode: "full-access",
        modelSelection: { instanceId: "codex", model: "fixture-model" },
        title: "M-14 Fixture task",
      });
      const confirmed = await m.report(intent.id, await route.confirm(dispatched as LaunchIntent));
      expect(confirmed?.state).toBe("confirmed");
      expect(confirmed?.evidence).toMatchObject({ folder_checked: true, thread });
      const link = await route.openThread(confirmed as LaunchIntent, BRIEF);
      expect(link).toEqual({ opened: true, prompt: true });
      const url = new URL(opened[0] ?? "");
      expect(`${url.protocol}//${url.host}${decodeURIComponent(url.pathname)}`).toBe(
        `t3code://threads/${fake.environmentId}/${thread}`,
      );
      expect(url.searchParams.get("prompt")).toBe(BRIEF);
      // Opened again later: the thread alone, so a draft the person changed in T3 stays.
      await route.openThread(confirmed as LaunchIntent, undefined);
      expect(new URL(opened[1] ?? "").search).toBe("");
    },
    SLOW,
  );

  test(
    "T3's refusal of the model, a narrower mode or a read-only pairing is Failed with its reason at once: no repeat, no thread",
    async () => {
      fake.addProject(folder("lumen"));
      fake.models = ["another-model"];
      const model = await launch(machine(), "lumen");
      expect(model.dispatched?.state).toBe("failed");
      expect(model.dispatched?.reason).toBe("model_unavailable");
      fake.models = undefined;
      // The person approved less than full access: an instance with full access asks for more.
      fake.access = "auto-accept-edits";
      await pair();
      const mode = await launch(machine(), "lumen");
      expect(mode.dispatched?.state).toBe("failed");
      expect(mode.dispatched?.reason).toBe("pairing_denied");
      // Read only: T3 lists the projects and makes no thread.
      fake.access = "read-only";
      await pair();
      const read = await launch(machine(), "lumen");
      expect(read.dispatched?.state).toBe("failed");
      expect(read.dispatched?.reason).toBe("pairing_denied");
      expect(fake.threads.size).toBe(0);
      for (const { intent } of [model, mode, read]) {
        const calls = fake.callsOf("t3_thread_launch");
        expect(calls.filter((c) => c.clientRequestId === intent.id)).toHaveLength(1);
      }
    },
    SLOW,
  );

  test(
    "a pairing ends with its 30-day token: Reconnect T3, and nothing is sent",
    async () => {
      fake.addProject(folder("lumen"));
      const pairing = readPairing(files);
      expect((pairing?.expiresAt ?? 0) - now).toBe(30 * 24 * 60 * 60_000);
      now = (pairing?.expiresAt ?? now) + 1;
      const before = fake.calls.length;
      expect(await route.availability()).toEqual({ state: "reconnect" });
      expect((await prepare("lumen")).prepared).toEqual({
        kind: "unavailable",
        reason: "reconnect",
      });
      expect(fake.calls.length).toBe(before);
    },
    SLOW,
  );

  test(
    "a lost reply, then the repeat with the same key, returns the same thread across an HTTP reconnect",
    async () => {
      fake.addProject(folder("lumen"));
      for (const when of ["after", "before"] as const) {
        fake.dropNext("t3_thread_launch", when);
        const { intent, dispatched } = await launch(machine(), "lumen");
        expect(dispatched?.state, when).toBe("dispatched");
        expect(dispatched?.evidence.replayed_at, when).toBeTypeOf("number");
        const calls = fake
          .callsOf("t3_thread_launch")
          .filter((c) => c.clientRequestId === intent.id);
        expect(calls.map((c) => c.outcome)).toEqual([`dropped_${when}`, "answered"]);
        // One thread for the key, the one the repeat returned.
        const threads = [...fake.threads.values()].filter((t) => t.clientRequestId === intent.id);
        expect(threads.map((t) => t.id)).toEqual([dispatched?.evidence.thread]);
      }
    },
    SLOW,
  );

  test(
    "a JSON-RPC error to the launch call is Unknown whatever its code, and the repeat finds the thread; a 4xx is Failed",
    async () => {
      fake.addProject(folder("lumen"));
      // An internal error, and invalid params from a server that checks a tool's result after
      // the tool ran (the MCP SDK's server does): neither says whether the thread was made.
      for (const code of [-32603, -32602]) {
        fake.errorNext("t3_thread_launch", code, "after");
        const late = await launch(machine(), "lumen");
        expect(late.dispatched?.state, String(code)).toBe("dispatched");
        expect(late.dispatched?.evidence.replayed_at).toBeTypeOf("number");
        expect(
          fake
            .callsOf("t3_thread_launch")
            .filter((c) => c.clientRequestId === late.intent.id)
            .map((c) => c.outcome),
        ).toEqual(["rpc_error_after", "answered"]);
        const made = [...fake.threads.values()].filter((t) => t.clientRequestId === late.intent.id);
        expect(made.map((t) => t.id)).toEqual([late.dispatched?.evidence.thread]);
      }

      // A 4xx: the transport refused the request before any method ran.
      fake.refuseNext("t3_thread_launch", 400);
      const refused = await launch(machine(), "lumen");
      expect(refused.dispatched?.state).toBe("failed");
      expect(refused.dispatched?.reason).toBe("refused");
      expect(
        [...fake.threads.values()].filter((t) => t.clientRequestId === refused.intent.id),
      ).toHaveLength(0);
    },
    SLOW,
  );

  test(
    "a lost reply, then the repeat, returns the same thread across a T3 restart on a new port",
    async () => {
      fake.addProject(folder("lumen"));
      const before = fake.origin;
      fake.dropNext("t3_thread_launch", "after", () => fake.restart());
      const { intent, dispatched } = await launch(machine(), "lumen");
      expect(fake.origin).not.toBe(before);
      expect(dispatched?.state).toBe("dispatched");
      const threads = [...fake.threads.values()].filter((t) => t.clientRequestId === intent.id);
      expect(threads).toHaveLength(1);
      expect(threads[0]?.id).toBe(dispatched?.evidence.thread);
    },
    SLOW,
  );

  test(
    "after a service restart, recovery repeats under the same grant and T3, restarted too, returns the same thread",
    async () => {
      fake.addProject(folder("lumen"));
      // The first service dies after T3 made the thread and before the reply was recorded: its
      // record stays in Dispatching. The step's answer is lost with the service.
      fake.dropNext("t3_thread_launch", "after");
      const first = machine({
        replay: () => new Promise(() => undefined),
        grant: () => new Promise(() => undefined),
      });
      const resolution = await resolvePlace({ root: "work", path: "lumen" }, roots);
      if (resolution.status !== "ok") throw new Error("fixture");
      const { prepared } = await prepare("lumen");
      if (prepared.kind !== "bound") throw new Error("fixture");
      const intent = await first.open(
        {
          task: randomId("t"),
          instance: "t3-codex",
          route: "t3-mcp",
          place: randomId("pl"),
          taskVersion: 1,
          briefHash: "b".repeat(64),
        },
        "t3-recovery-click-0001",
      );
      const planned = route.plan(intent.id, {
        ...prepared,
        title: "M-14 Fixture task",
        instance: INSTANCE,
        folder: resolution.identity,
      });
      if (planned.kind !== "ready") throw new Error("fixture");
      const store = new MemoryExecutionStore(durable);
      const dispatching = await store.transitionIntent(
        intent.id,
        { state: "prepared", version: intent.version },
        "dispatching",
        { evidence: { grant: planned.grant } },
      );
      expect((await route.dispatch(dispatching)).kind).toBe("unknown");
      await fake.restart({ samePort: true });
      // A new service: a new route over the same machine state, a new machine over the same store.
      route = newRoute();
      const recovered = await machine().recover();
      const after = recovered.find((r) => r.id === intent.id);
      expect(after?.state).toBe("dispatched");
      const threads = [...fake.threads.values()].filter((t) => t.clientRequestId === intent.id);
      expect(threads.map((t) => t.id)).toEqual([after?.evidence.thread]);
    },
    SLOW,
  );

  test(
    "recovery after the token ran out sends nothing: the intent is Unknown and the pairing is Reconnect T3",
    async () => {
      fake.addProject(folder("lumen"));
      fake.dropNext("t3_thread_launch", "after");
      const first = machine({
        replay: () => new Promise(() => undefined),
        grant: () => new Promise(() => undefined),
      });
      const resolution = await resolvePlace({ root: "work", path: "lumen" }, roots);
      if (resolution.status !== "ok") throw new Error("fixture");
      const { prepared } = await prepare("lumen");
      if (prepared.kind !== "bound") throw new Error("fixture");
      const intent = await first.open(
        {
          task: randomId("t"),
          instance: "t3-codex",
          route: "t3-mcp",
          place: randomId("pl"),
          taskVersion: 1,
          briefHash: "e".repeat(64),
        },
        "t3-expired-click-0001",
      );
      const planned = route.plan(intent.id, {
        ...prepared,
        title: "M-14 Fixture task",
        instance: INSTANCE,
        folder: resolution.identity,
      });
      if (planned.kind !== "ready") throw new Error("fixture");
      const dispatching = await new MemoryExecutionStore(durable).transitionIntent(
        intent.id,
        { state: "prepared", version: intent.version },
        "dispatching",
        { evidence: { grant: planned.grant } },
      );
      expect((await route.dispatch(dispatching)).kind).toBe("unknown");
      // The service is down past the token's expiry: an expired token is not sent.
      const expiresAt = readPairing(files)?.expiresAt ?? now;
      now = expiresAt + 60_000;
      fake.revokeAll();
      route = newRoute();
      const refusedBefore = fake.unauthorized;
      const after = (await machine().recover()).find((r) => r.id === intent.id);
      expect(after?.state).toBe("unknown");
      expect(after?.reason).toBe("no_answer");
      expect(fake.unauthorized).toBe(refusedBefore);
      expect(
        fake
          .callsOf("t3_thread_launch")
          .filter((c) => c.clientRequestId === intent.id || c.outcome === "unauthorized")
          .map((c) => c.outcome),
      ).toEqual(["dropped_after"]);
      expect((await route.availability()).state).toBe("reconnect");
    },
    SLOW,
  );

  test(
    "after an OAuth reauthorization the intent is Unknown and no thread is created",
    async () => {
      fake.addProject(folder("lumen"));
      // T3 never got the call, and TTasks pairs again before the repeat: the same key under the
      // new grant would make a thread, so none is sent.
      fake.dropNext("t3_thread_launch", "before", () => pair());
      const { intent, dispatched } = await launch(machine(), "lumen");
      expect(dispatched?.state).toBe("unknown");
      expect(dispatched?.reason).toBe("regranted");
      expect(dispatched?.evidence.grant).not.toBe(readPairing(files)?.grant);
      expect(fake.threads.size).toBe(0);
      expect(fake.callsOf("t3_thread_launch").map((c) => c.outcome)).toEqual(["dropped_before"]);
      expect(intent.id).toBe(dispatched?.id);

      // A re-pairing between the machine's read of the grant and the repeat: the route sends
      // nothing, and the machine records Unknown.
      fake.dropNext("t3_thread_launch", "before");
      const late = machine({
        grant: async () => {
          const grant = await route.grant();
          await pair();
          return grant;
        },
      });
      const second = await launch(late, "lumen");
      expect(second.dispatched?.state).toBe("unknown");
      expect(second.dispatched?.evidence.replayed_at).toBeTypeOf("number");
      expect(fake.threads.size).toBe(0);
      expect(
        fake.callsOf("t3_thread_launch").filter((c) => c.clientRequestId === second.intent.id),
      ).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "a 401 leads to Reconnect T3: before a launch the route is unavailable, during one it fails",
    async () => {
      fake.addProject(folder("lumen"));
      fake.revokeAll();
      expect((await prepare("lumen")).prepared).toEqual({
        kind: "unavailable",
        reason: "reconnect",
      });
      expect(await route.availability()).toEqual({ state: "reconnect" });
      expect(T3_TEXT.reconnect).toBe("Reconnect T3");

      // Pairing again clears it; a 401 on the dispatch itself is a refusal: nothing was made.
      await pair();
      expect((await route.availability()).state).toBe("ready");
      const resolution = await resolvePlace({ root: "work", path: "lumen" }, roots);
      if (resolution.status !== "ok") throw new Error("fixture");
      const { prepared } = await prepare("lumen");
      if (prepared.kind !== "bound") throw new Error("fixture");
      const m = machine();
      const intent = await m.open(
        {
          task: randomId("t"),
          instance: "t3-codex",
          route: "t3-mcp",
          place: null,
          taskVersion: 1,
          briefHash: "c".repeat(64),
        },
        "t3-401-click-00001",
      );
      const planned = route.plan(intent.id, {
        ...prepared,
        title: "M-14 Fixture task",
        instance: INSTANCE,
        folder: resolution.identity,
      });
      if (planned.kind !== "ready") throw new Error("fixture");
      fake.revokeAll();
      const failed = await m.dispatch(intent.id, { grant: planned.grant });
      expect(failed?.state).toBe("failed");
      expect(failed?.reason).toBe("refused");
      expect(await route.availability()).toEqual({ state: "reconnect" });
      expect(fake.threads.size).toBe(0);
    },
    SLOW,
  );

  test(
    "a nested folder becomes a T3 project of its own without a question, and the containing project is never used",
    async () => {
      const lumen = fake.addProject(folder("lumen"), "lumen");
      folder("lumen", "docs");
      const resolution = await resolvePlace({ root: "work", path: "lumen/docs" }, roots);
      if (resolution.status !== "ok") throw new Error("fixture");
      const { prepared } = await prepare("lumen/docs", "docs");
      const docs = [...fake.projects.values()].find((p) => p.workspaceRoot === resolution.folder);
      expect(docs?.title).toBe("docs");
      expect(prepared).toEqual({ kind: "bound", projectId: docs?.id, strategy: { type: "root" } });
      const m = machine();
      const { dispatched } = await launch(m, "lumen/docs");
      expect(fake.threads.get(dispatched?.evidence.thread ?? "")?.projectId).toBe(docs?.id);
      // Confirmed from the project T3 holds by ID, without listing every project again.
      const lists = fake.callsOf("t3_project_list").length;
      expect((await route.confirm(dispatched as LaunchIntent)).kind).toBe("confirmed");
      expect(fake.callsOf("t3_project_list")).toHaveLength(lists);
      expect(fake.callsOf("t3_thread_launch").some((c) => c.projectId === lumen)).toBe(false);

      // A pairing below full access cannot register: pair again, choosing Full access.
      folder("lumen", "notes");
      fake.access = "auto";
      await pair();
      expect((await prepare("lumen/notes")).prepared).toEqual({
        kind: "unavailable",
        reason: "pairing_denied",
      });
    },
    SLOW,
  );

  test(
    "a thread T3 bound elsewhere fails the folder check and stays; the link without a brief over the limit",
    async () => {
      fake.addProject(folder("lumen"));
      const m = machine();
      const { dispatched } = await launch(m, "lumen");
      const thread = dispatched?.evidence.thread ?? "";
      // T3 moved the thread to another project: not the resolved folder.
      const other = fake.addProject(folder("other"));
      const held = fake.threads.get(thread);
      if (held === undefined) throw new Error("fixture");
      fake.threads.set(thread, { ...held, projectId: other });
      const observed = await route.confirm(dispatched as LaunchIntent);
      expect(observed).toEqual({
        kind: "failed",
        reason: "folder_mismatch",
        evidence: { thread },
      });
      const failed = await m.report(dispatched?.id ?? "", observed);
      expect(failed?.state).toBe("failed");
      expect(fake.threads.has(thread)).toBe(true);

      const link = await route.openThread(dispatched as LaunchIntent, "x".repeat(8_001));
      expect(link).toEqual({ opened: true, prompt: false });
      expect(new URL(opened.at(-1) ?? "").search).toBe("");
    },
    SLOW,
  );

  test(
    "an instance with a provider instance and no model is refused before anything is sent",
    async () => {
      fake.addProject(folder("lumen"));
      const resolution = await resolvePlace({ root: "work", path: "lumen" }, roots);
      if (resolution.status !== "ok") throw new Error("fixture");
      const { prepared } = await prepare("lumen");
      if (prepared.kind !== "bound") throw new Error("fixture");
      const planned = route.plan(randomId("la"), {
        ...prepared,
        title: "M-14 Fixture task",
        instance: {
          openPermission: "inherit",
          t3: { environment: "local", providerInstance: "codex", model: "" },
        },
        folder: resolution.identity,
      });
      expect(planned).toEqual({ kind: "unavailable", reason: "model_required" });
      expect(fake.callsOf("t3_thread_launch")).toHaveLength(0);
    },
    SLOW,
  );

  test(
    "T3 that is not running, or not paired, makes the route unavailable before anything is dispatched",
    async () => {
      fake.addProject(folder("lumen"));
      await fake.stop();
      expect(await route.availability()).toEqual({ state: "not_running" });
      expect((await prepare("lumen")).prepared).toEqual({
        kind: "unavailable",
        reason: "not_running",
      });
      expect(T3_TEXT.not_running).toBe("Start T3 Code");
      files.files.clear();
      expect(await route.availability()).toEqual({ state: "not_paired" });
    },
    SLOW,
  );

  test(
    "answers as an SSE stream read the same",
    async () => {
      fake.addProject(folder("lumen"));
      fake.sse = true;
      const first = await launch(machine(), "lumen");
      expect(first.dispatched?.state).toBe("dispatched");
      // A stream T3 keeps open after the reply: the reply is read as soon as it arrives, not at
      // the request's deadline (which would make every launch a lost reply).
      fake.sseKeepOpen = true;
      const keep = route;
      route = new T3Route({ home: fake.home, files, now: () => now, requestMs: 3_000 });
      const open = await launch(machine(), "lumen");
      expect(open.dispatched?.state).toBe("dispatched");
      expect(open.dispatched?.evidence.replayed_at).toBeUndefined();
      fake.sseKeepOpen = false;
      route = keep;
    },
    SLOW,
  );
});
