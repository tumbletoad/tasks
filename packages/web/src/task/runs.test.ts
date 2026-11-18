// What the page shows of a background run (runs.ts): its state in plain words, what the agent said,
// Stop while it may still work, the row's marker, how a read joins what the page already shows,
// and the words of a refusal. Fixture runs only.
import { describe, expect, test } from "vitest";
import { Refused, type Instance, type Run } from "../api.ts";
import { mergeRuns, runMarker, runRefusal, runners, runView, stopping } from "./runs.ts";

const run = (patch: Partial<Run> = {}): Run => ({
  id: "ru_00r5mfcw5rfzxb9enb2vg50z3g",
  instance: "codex-work",
  state: "running",
  reason: null,
  queued_at: 1_000,
  started_at: 1_100,
  ended_at: null,
  asked: null,
  answer: null,
  answer_final: false,
  answer_cut: false,
  version: 4,
  ...patch,
});

const ids = (view: ReturnType<typeof runView>) => view.status.map((m) => m.id);

describe("[M6.page.run-words] a run's entry says what is the case and what the person can do", () => {
  test("waiting, working and stopping offer Stop until it is on its way; nothing ended has it", () => {
    const waiting = runView(run({ state: "queued", waiting: "task_limit" }), "Codex");
    expect(waiting).toMatchObject({ tone: "waiting", stoppable: true });
    expect(waiting.status[0]).toEqual({
      id: "run.waiting",
      values: { why: "task_limit", label: "Codex" },
    });
    expect(runView(run(), "Codex")).toMatchObject({ tone: "working", stoppable: true });
    expect(runView(run({ state: "cancelling" }), "Codex")).toMatchObject({
      tone: "stopping",
      stoppable: false,
    });
    for (const state of ["succeeded", "failed", "cancelled", "timed_out"]) {
      expect(runView(run({ state, reason: null }), "Codex").stoppable).toBe(false);
    }
    // Processes not confirmed ended: Stop ends them.
    expect(runView(run({ state: "unknown", reason: "stop_timed_out" }), "Codex")).toMatchObject({
      tone: "unknown",
      stoppable: true,
    });
  });

  test("done shows the answer, and what it left only when something had to be ended; a stop always says what was ended", () => {
    const done = runView(
      run({
        state: "succeeded",
        answer: "Updated the export.",
        answer_final: true,
        cleanup: "confirmed",
      }),
      "Codex",
    );
    expect(done.tone).toBe("done");
    expect(ids(done)).toEqual(["run.done"]);
    expect(done.said).toEqual({ kind: "answer", text: "Updated the export.", cut: false });
    const left = runView(run({ state: "succeeded", cleanup: "ended_leftovers" }), "Codex");
    expect(ids(left)).toEqual(["run.done", "run.cleanup.leftovers"]);
    const stopped = runView(run({ state: "cancelled", cleanup: "confirmed" }), "Codex");
    expect(ids(stopped)).toEqual(["run.stopped", "run.cleanup.confirmed"]);
    const early = runView(run({ state: "cancelled", started_at: null }), "Codex");
    expect(ids(early)).toEqual(["run.stoppedBeforeStart"]);
  });

  test("a question is the one state that asks for attention, with the question as what it said", () => {
    const needs = runView(
      run({
        state: "failed",
        reason: "needs_input",
        outcome: "needs_input",
        answer: "Which month?",
      }),
      "Codex",
    );
    expect(needs).toMatchObject({
      tone: "needs_you",
      said: { kind: "question", text: "Which month?" },
    });
    expect(ids(needs)[0]).toBe("run.needsYou");
  });

  test("a run that could not start, a restart, an error and a time limit each say so", () => {
    expect(ids(runView(run({ state: "failed", reason: "folder_gone" }), "Codex"))).toEqual([
      "run.notStarted",
    ]);
    const restarted = runView(
      run({ state: "failed", reason: "service_ended", answer: "Halfway" }),
      "Codex",
    );
    expect(ids(restarted)).toEqual(["run.serviceEnded"]);
    expect(restarted.said?.kind).toBe("last");
    const error = runView(
      run({
        state: "failed",
        reason: "agent_error",
        error: "401 Unauthorized. Sign in with: codex login",
      }),
      "Codex",
    );
    expect(error).toMatchObject({
      tone: "failed",
      error: "401 Unauthorized. Sign in with: codex login",
    });
    expect(runView(run({ state: "timed_out", reason: "idle" }), "Codex").status[0]).toEqual({
      id: "run.timedOut",
      values: { limit: "idle" },
    });
  });
});

describe("[M6.page.run-follow] the page shows a run as the service has it", () => {
  test("a read keeps what the page holds newer, and a run queued after the read began", () => {
    const shown = stopping(run({ version: 4 }));
    expect(shown.state).toBe("cancelling");
    const queuedLater = run({
      id: "ru_00r5mfcw5rfzxb9enb2vg50z3h",
      queued_at: 2_000,
      state: "queued",
    });
    const stale = [run({ version: 4 })];
    expect(mergeRuns([shown, queuedLater], stale)).toEqual([shown, queuedLater]);
    // The service's next step wins over the page's own.
    const later = run({ state: "cancelled", version: 5 });
    expect(mergeRuns([shown], [later])).toEqual([later]);
    // A run that left the read's window is not kept.
    const old = run({ id: "ru_00r5mfcw5rfzxb9enb2vg50z3j", queued_at: 10 });
    expect(mergeRuns([old], [run({ queued_at: 1_000 })]).map((r) => r.id)).not.toContain(old.id);
  });

  test("the row's marker: working, or needing the person, named by the instance's label", () => {
    const instances: Instance[] = [
      {
        key: "codex-work",
        label: "Codex · work",
        glyph: "Cx",
        ring: 1,
        route: "terminal",
        runs: true,
      },
      { key: "claude", label: "Claude", glyph: "Cl", ring: 2, route: "terminal" },
    ];
    expect(runMarker({ state: "needs_you", instance: "codex-work" }, instances)).toEqual({
      kind: "needs_input",
      by: "Codex · work",
    });
    expect(runMarker({ state: "working", instance: "gone" }, instances)).toEqual({
      kind: "working",
      by: "gone",
    });
    expect(runMarker({ state: "later", instance: "codex-work" }, instances)).toBeUndefined();
    expect(runMarker(undefined, instances)).toBeUndefined();
    // Run is offered by what the service says an instance can do, never by its name.
    expect(runners(instances).map((i) => i.key)).toEqual(["codex-work"]);
  });

  test("a refusal's words come from the service's reason and the folder or machine it names", () => {
    expect(
      runRefusal(
        new Refused(400, "invalid_input", undefined, {
          reason: "folder_missing",
          folder: "~/work/portal",
        }),
      ),
    ).toMatchObject({ reason: "folder_missing", folder: "~/work/portal" });
    expect(
      runRefusal(new Refused(400, "invalid_input", undefined, { reason: "folder_missing" })).reason,
    ).toBe("work_folder");
    expect(
      runRefusal(
        new Refused(400, "invalid_input", undefined, {
          reason: "other_machine",
          machine: "mira-laptop",
        }),
      ).words,
    ).toMatchObject({ reason: "other_machine", machine: "mira-laptop" });
    expect(runRefusal(new Refused(413, "too_large", undefined, { field: "text" })).reason).toBe(
      "too_large",
    );
    expect(runRefusal(new Error("offline")).reason).toBe("unknown");
  });
});
