// The page's receipt from a `launches` row: the terminal and its source reach
// the page only as the fixed words a launch records. Fixture rows only.
import { describe, expect, test } from "vitest";
import { RUN_LIMITS, type RunRecord } from "@ttasks/contracts/runs";
import { leftOutEvidence } from "../launch/open.ts";
import { WORK_ON_IT } from "../runs/agent.ts";
import type { ServedSpace } from "../ops/index.ts";
import { receiptOf, UiLaunches, uiRun, type UiRunPort } from "./launches.ts";

const ID = "la_00r5mfcw5rfzxb9enb2vg50z3g";

const row = (evidence: Record<string, unknown>, state = "dispatched") => ({
  id: ID,
  reference: "L7KQ21",
  instance_id: "cx",
  route: "terminal",
  state,
  reason: null,
  detail: JSON.stringify({ at: { prepared: 1, dispatching: 2, dispatched: 3 }, evidence }),
});

describe("[A5.3.9.service.session] a Confirmed launch's session: running only while the service follows it, ended once its end was reported", () => {
  const runs = (launch: string) => launch === ID;
  const confirmed = (evidence: Record<string, unknown>) =>
    receiptOf(row({ claim: "c1", folder_checked: true, ...evidence }, "confirmed"), runs);

  test("running while followed; ended with how long it ran, also by an earlier build's exit code", () => {
    expect(confirmed({})).toMatchObject({ session: "running" });
    expect(confirmed({ exit_code: 0, ran_ms: 125_000 })).toMatchObject({
      session: "ended",
      ran_ms: 125_000,
    });
    // An end the record names wins over a shim record not yet released.
    expect(confirmed({ ran_ms: 9_000 })).toMatchObject({ session: "ended" });
    expect(confirmed({ exit_code: 0 })).toMatchObject({ session: "ended" });
    expect(confirmed({ exit_code: 0 })).not.toHaveProperty("ran_ms");
  });

  test("never running where the service cannot follow it: a lost shim, another computer, an earlier build's record", () => {
    expect(confirmed({ lost_at: 5 })).not.toHaveProperty("session");
    const elsewhere = row({ claim: "c1" }, "confirmed");
    expect(receiptOf(elsewhere, () => false)).not.toHaveProperty("session");
    expect(receiptOf(elsewhere)).not.toHaveProperty("session");
    // Only a Confirmed launch has a session to show: a dispatched one is still opening.
    expect(receiptOf(row({ claim: "c1" }), runs)).not.toHaveProperty("session");
  });
});

describe("[A4.3.4.1.t3.thread] a task's T3 Code thread on its entry: what T3 Code tells", () => {
  const t3 = (evidence: Record<string, unknown>) => ({
    ...row({ thread: "mcp:launch:1", folder_checked: true, ...evidence }, "confirmed"),
    route: "t3-mcp",
  });

  test("running with what its agent does while T3 has it, ended once T3 no longer has it, as opened when T3 does not tell", () => {
    const told = (activity: "working" | "waiting" | "idle" | "gone") => () => activity;
    expect(receiptOf(t3({}), undefined, false, told("waiting"))).toMatchObject({
      session: "running",
      activity: "waiting",
    });
    expect(receiptOf(t3({}), undefined, false, told("idle"))).toMatchObject({
      session: "running",
      activity: "idle",
    });
    const gone = receiptOf(t3({}), undefined, false, told("gone"));
    expect(gone).toMatchObject({ session: "ended" });
    expect(gone).not.toHaveProperty("activity");
    // T3 cannot be asked, or this is an earlier thread of the task: only that it opened.
    expect(receiptOf(t3({}))).not.toHaveProperty("session");
    // A thread the service found gone has ended, whatever T3 says, also when T3 says nothing.
    const lost = receiptOf(t3({ lost_at: 5 }), undefined, false, told("working"));
    expect(lost).toMatchObject({ session: "ended" });
    expect(lost).not.toHaveProperty("activity");
    expect(receiptOf(t3({ lost_at: 5 }))).toMatchObject({ session: "ended" });
  });
});

describe("[A4.5.routes.chosen] the page's receipt names what its click left out", () => {
  test("the codes the launch recorded at the click, and nothing it does not know", () => {
    const left = leftOutEvidence(["read-only", "home"]);
    expect(receiptOf(row({ left_out: left }))).toMatchObject({ left_out: ["read-only", "home"] });
    expect(receiptOf(row({}))).not.toHaveProperty("left_out");
    expect(receiptOf(row({ left_out: "elsewhere" }))).not.toHaveProperty("left_out");
  });
});

describe("[A4.5.terminal.receipt] the receipt names the terminal and its source", () => {
  test("the recorded words pass; anything else is left out, never shown", () => {
    expect(receiptOf(row({ terminal: "ghostty", terminal_source: "desktop" }))).toMatchObject({
      terminal: { app: "ghostty", source: "desktop" },
      at: { prepared: 1, dispatching: 2, dispatched: 3 },
    });
    for (const evidence of [
      {},
      { terminal: "ghostty" },
      { terminal: "auto", terminal_source: "desktop" },
      { terminal: "alacritty", terminal_source: "desktop" },
      { terminal: "ghostty", terminal_source: "/home/someone" },
      { terminal: 3, terminal_source: "desktop" },
    ]) {
      expect(receiptOf(row(evidence))).not.toHaveProperty("terminal");
    }
  });
});

const record = (patch: Partial<RunRecord> = {}): RunRecord => ({
  id: "ru_00r5mfcw5rfzxb9enb2vg50z3g",
  task: "t_00r5mfcw5rfzxb9enb2vg50z3h",
  routine: null,
  session: null,
  machine: "m_00r5mfcw5rfzxb9enb2vg50z3j",
  instance: "codex-work",
  adapter: "codex",
  place: null,
  folderKind: "work_folder",
  request: WORK_ON_IT,
  briefHash: "0".repeat(64),
  permission: "full-access",
  limits: RUN_LIMITS.task,
  state: "queued",
  reason: null,
  attempt: 1,
  evidence: {},
  at: { queued: 1 },
  result: null,
  queuedAt: 1,
  startedAt: null,
  endedAt: null,
  version: 1,
  ...patch,
});

describe("[M6.page.run-view] the page's view of a run", () => {
  test("a run without the person's words says so, its answer and how it ended come along", () => {
    expect(uiRun(record(), { waiting: "task_limit" })).toMatchObject({
      asked: null,
      waiting: "task_limit",
      answer: null,
    });
    const ended = uiRun(
      record({
        request: "Check the export",
        state: "failed",
        reason: "needs_input",
        result: {
          ok: false,
          outcome: "needs_input",
          exitCode: 0,
          signal: null,
          nativeId: null,
          text: "Which month?",
          textFinal: false,
          error: null,
          usage: null,
          appTools: null,
          declined: 0,
          permissionDenials: 0,
          durationMs: 10,
          cleanup: "confirmed",
        },
      }),
    );
    expect(ended).toMatchObject({
      asked: "Check the export",
      state: "failed",
      reason: "needs_input",
      outcome: "needs_input",
      cleanup: "confirmed",
      answer: "Which month?",
      answer_final: false,
    });
    expect(ended).not.toHaveProperty("waiting");
    expect(ended).not.toHaveProperty("refused");
  });

  test("a running run says since when it is quiet and what it said so far, and an ended one how many requests were refused", () => {
    const since = Date.UTC(2026, 10, 21, 9, 30);
    const said = { text: "The server listens on port 5173.", final: true, cut: false };
    expect(uiRun(record({ state: "running" }), { quietSince: since, said })).toMatchObject({
      quiet_since: since,
      answer: "The server listens on port 5173.",
      answer_final: true,
      answer_cut: false,
    });
    const refused = uiRun(
      record({
        state: "succeeded",
        result: {
          ok: true,
          outcome: "success",
          exitCode: 0,
          signal: null,
          nativeId: null,
          text: "Done.",
          textFinal: true,
          error: null,
          usage: null,
          appTools: null,
          declined: 0,
          permissionDenials: 2,
          durationMs: 10,
        },
      }),
    );
    expect(refused.refused).toBe(2);
  });

  test("Run checks what the page sent before anything is queued", async () => {
    const queued: unknown[] = [];
    const port: UiRunPort = {
      runnable: (key) => key === "codex-work",
      queueTask: (_space, asked) => {
        queued.push(asked);
        return Promise.resolve(record());
      },
      list: () => Promise.resolve([]),
      stop: () => Promise.resolve(undefined),
      live: () => ({}),
      continuable: () => Promise.resolve({ ok: false }),
    };
    const launches = new UiLaunches({
      host: {
        machine: { id: "m_00r5mfcw5rfzxb9enb2vg50z3j" },
        spaces: () => [
          {
            id: "sp_00r5mfcw5rfzxb9enb2vg50z3k",
            name: "Mira",
            state: "open",
            writer: undefined,
            reader: {} as never,
          },
        ],
      },
      port: {
        instances: () => [
          {
            key: "codex-work",
            app: "Codex",
            label: "Codex",
            glyph: "Cx",
            ring: 1,
            route: "terminal",
          },
          {
            key: "claude",
            app: "Claude",
            label: "Claude",
            glyph: "Cl",
            ring: 2,
            route: "terminal",
          },
        ],
      },
      runs: port,
      log: () => undefined,
      changed: () => undefined,
    });
    const space = "sp_00r5mfcw5rfzxb9enb2vg50z3k";
    const task = "t_00r5mfcw5rfzxb9enb2vg50z3h";
    const id = "0b9f3b5e-7c1d-4a8e-9f2a-1c3d5e7f9a0b";
    await expect(launches.run(space, { task: "MIRA-1", request_id: id })).rejects.toThrow();
    await expect(launches.run(space, { task, request_id: "x" })).rejects.toThrow();
    await expect(launches.run(space, { task, request_id: id, instance: "a b" })).rejects.toThrow();
    await expect(
      launches.run(space, { task, request_id: id, text: "x".repeat(70_000) }),
    ).rejects.toThrow("longer");
    expect(queued).toEqual([]);
    // The page offers Run for the instances the service says can run.
    expect(launches.instances("sp_3q7k9d2xw8f4r6t1c5v0b2n8a7").map((i) => [i.key, i.runs])).toEqual(
      [
        ["codex-work", true],
        ["claude", undefined],
      ],
    );
    // Blank words are no words: the run works on the task.
    await launches.run(space, { task, request_id: id, text: "  \n" });
    await launches.run(space, { task, request_id: id, text: "Check the export" });
    expect(queued).toEqual([
      { task, request: null, requestId: id },
      { task, request: "Check the export", requestId: id },
    ]);
  });

  test("a task's runs: the newest, and an older one that still works, so its Stop stays", async () => {
    // Newest first, as the service lists them: twelve ended runs, then one that still works.
    const listed = Array.from({ length: 13 }, (_, at) =>
      record({
        id: `ru_00r5mfcw5rfzxb9enb2vg5${String(at).padStart(2, "0")}`,
        state: at === 12 ? "running" : "succeeded",
      }),
    );
    const launches = new UiLaunches({
      host: {
        machine: { id: "m_00r5mfcw5rfzxb9enb2vg50z3j" },
        spaces: () => [
          {
            id: "sp_00r5mfcw5rfzxb9enb2vg50z3k",
            name: "Mira",
            state: "open",
            writer: undefined,
            reader: {} as never,
          },
        ],
      },
      port: { instances: () => [] },
      runs: {
        runnable: () => true,
        queueTask: () => Promise.reject(new Error("not here")),
        list: () => Promise.resolve(listed.map((run) => ({ run }))),
        stop: () => Promise.resolve(undefined),
        live: () => ({}),
        continuable: () => Promise.resolve({ ok: false }),
      },
      log: () => undefined,
      changed: () => undefined,
    });
    const shown = await launches.runs("sp_00r5mfcw5rfzxb9enb2vg50z3k", {
      task: "t_00r5mfcw5rfzxb9enb2vg50z3h",
    });
    expect(shown.map((r) => r.state)).toEqual(["running", ...Array<string>(10).fill("succeeded")]);
    expect(shown[0]?.id).toBe(listed[12]?.id);
  });
});

describe("[A2.3.10.5.copies.gone] a page's call for a copy that is not served says what happened to it", () => {
  test("while the space closes it says nothing yet; once closed, closed; once another folder serves it, replaced", async () => {
    const id = "sp_00r5mfcw5rfzxb9enb2vg50z3k";
    const loaded = "a".repeat(24);
    let spaces: ServedSpace[] = [];
    const entry = (state: ServedSpace["state"], copy: string, folder: string): ServedSpace => ({
      id,
      name: "Mira",
      state,
      folder,
      copy,
      writer: undefined,
      reader: state === "open" ? ({} as never) : undefined,
    });
    const launches = new UiLaunches({
      host: { machine: { id: "m_00r5mfcw5rfzxb9enb2vg50z3j" }, spaces: () => spaces },
      port: { instances: () => [], busy: () => Promise.resolve([]) },
      log: () => undefined,
      changed: () => undefined,
    });
    const reason = (error: unknown) => (error as { data: Record<string, unknown> }).data;

    spaces = [entry("open", loaded, "/mira")];
    await expect(launches.busy(id, loaded)).resolves.toEqual([]);
    spaces = [entry("closing", loaded, "/mira")];
    expect(reason(await launches.busy(id, loaded).catch((e: unknown) => e))).toEqual({
      reason: "closing",
      retryable: true,
    });
    spaces = [entry("closed", loaded, "/mira")];
    expect(reason(await launches.busy(id, loaded).catch((e: unknown) => e))).toEqual({
      reason: "closed",
      retryable: false,
    });
    expect(reason(await launches.last(id, loaded).catch((e: unknown) => e))).toMatchObject({
      reason: "closed",
    });
    spaces = [entry("closed", loaded, "/mira"), entry("open", "b".repeat(24), "/mira-copy")];
    expect(reason(await launches.busy(id, loaded).catch((e: unknown) => e))).toEqual({
      reason: "replaced",
      retryable: false,
    });
  });
});

describe("[A5.agents.run-nudge] a run a person queues or stops anywhere reaches the page", () => {
  test("the runs' change, from the page or `ttasks run`, pokes the feed and the monitor; none after close", () => {
    let listener: ((space: string) => void) | undefined;
    const changed: string[] = [];
    const launches = new UiLaunches({
      host: { machine: { id: "m_00r5mfcw5rfzxb9enb2vg50z3j" }, spaces: () => [] },
      port: { instances: () => [] },
      runs: {
        runnable: () => true,
        queueTask: () => Promise.reject(new Error("not here")),
        list: () => Promise.resolve([]),
        stop: () => Promise.resolve(undefined),
        live: () => ({}),
        continuable: () => Promise.resolve({ ok: false }),
        onChange: (heard) => {
          listener = heard;
          return () => {
            listener = undefined;
          };
        },
      },
      log: () => undefined,
      changed: (space) => changed.push(space),
    });
    listener?.("sp_00r5mfcw5rfzxb9enb2vg50z3k");
    expect(changed).toEqual(["sp_00r5mfcw5rfzxb9enb2vg50z3k"]);
    launches.close();
    expect(listener).toBeUndefined();
  });
});
