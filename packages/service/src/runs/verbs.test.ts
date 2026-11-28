// `runs/show` says truly whether the answer it returns is whole. Fixture records only.
import { describe, expect, test } from "vitest";
import { RUN_LIMITS, type RunRecord, type RunResult } from "@ttasks/contracts/runs";
import type { UsableSpace } from "../ops/index.ts";
import { WORK_ON_IT } from "./agent.ts";
import type { RunLive, RunService } from "./service.ts";
import { runVerbs } from "./verbs.ts";

const RUN = "ru_00r5mfcw5rfzxb9enb2vg50z3g";

const result = (patch: Partial<RunResult>): RunResult => ({
  ok: true,
  outcome: "success",
  exitCode: 0,
  signal: null,
  nativeId: null,
  text: "The report starts here",
  error: null,
  usage: null,
  appTools: null,
  declined: 0,
  permissionDenials: 0,
  durationMs: 10,
  ...patch,
});

const record = (patch: Partial<RunRecord>): RunRecord => ({
  id: RUN,
  task: "t_00r5mfcw5rfzxb9enb2vg50z3h",
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
  state: "succeeded",
  reason: null,
  attempt: 1,
  evidence: {},
  at: { queued: 1 },
  result: null,
  queuedAt: 1,
  startedAt: 2,
  endedAt: 3,
  version: 1,
  ...patch,
});

/** `runs/show` over a store that holds `run`, with what the service knows of it now. */
function show(run: RunRecord, live: RunLive = {}): Promise<unknown> {
  const runs = {
    show: () => Promise.resolve({ run, task: "M-14" }),
    live: () => live,
  } as unknown as RunService;
  const verbs = runVerbs({ runs, space: () => ({ id: "sp_x" }) as unknown as UsableSpace });
  return verbs["runs/show"]?.({ run: RUN }, "cli-interactive") ?? Promise.reject(new Error());
}

describe("[A4.3.11.run.answer-cut] ttasks run show says whether the answer it shows is whole", () => {
  test("an ended run's answer that its record marks as cut is final and cut", async () => {
    const cut = record({ result: result({ textFinal: true, textCut: true }) });
    expect(await show(cut)).toMatchObject({
      answer: "The report starts here",
      answer_final: true,
      answer_cut: true,
    });
    const whole = record({ result: result({ textFinal: true }) });
    expect(await show(whole)).toMatchObject({ answer_final: true, answer_cut: false });
  });

  test("a working run's answer so far says whether it is final and whether it is cut", async () => {
    const working = record({ state: "running", endedAt: null });
    const said = { text: "Half of it", final: true, cut: true };
    expect(await show(working, { said })).toMatchObject({
      answer: "Half of it",
      answer_final: true,
      answer_cut: true,
    });
    expect(await show(working)).toMatchObject({
      answer: null,
      answer_final: false,
      answer_cut: false,
    });
  });
});
