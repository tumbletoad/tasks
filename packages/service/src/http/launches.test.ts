// The page's receipt from a `launches` row: the terminal and its source reach
// the page only as the fixed words a launch records. Fixture rows only.
import { describe, expect, test } from "vitest";
import { RUN_LIMITS, type RunRecord } from "@tasks/contracts/runs";
import { WORK_ON_IT } from "../runs/agent.ts";
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
    expect(uiRun(record(), "task_limit")).toMatchObject({
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
      "task_limit",
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
    // Only a queued run waits.
    expect(ended).not.toHaveProperty("waiting");
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
      waiting: () => undefined,
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
          { key: "codex-work", label: "Codex", glyph: "Cx", ring: 1, route: "terminal" },
          { key: "claude", label: "Claude", glyph: "Cl", ring: 2, route: "terminal" },
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
    expect(launches.instances().map((i) => [i.key, i.runs])).toEqual([
      ["codex-work", true],
      ["claude", undefined],
    ]);
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
        waiting: () => undefined,
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
