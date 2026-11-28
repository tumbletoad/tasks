// A run as a task's card on the phone says it: its one line, and what its agent said.
import { describe, expect, test } from "vitest";
import { runLine, runsOf, type PhoneRun } from "./card.ts";

const run = (state: string, more: Partial<PhoneRun> = {}): PhoneRun => ({
  id: "ru_1",
  state,
  reason: null,
  queued_at: 1,
  answer: null,
  answer_final: false,
  answer_cut: false,
  ...more,
});

describe("[S5.phone.run-line] a card says how a run stands and shows what its agent said", () => {
  test("waiting, working, done with its answer, needing the person with its question, failed and stopped", () => {
    expect(runLine(run("queued"))).toEqual({ tone: "waiting" });
    expect(runLine(run("running", { answer: "Still looking." }))).toEqual({
      tone: "working",
      said: { kind: "last", text: "Still looking.", cut: false },
    });
    expect(runLine(run("succeeded", { answer: "Found it.", answer_final: true }))).toEqual({
      tone: "done",
      said: { kind: "answer", text: "Found it.", cut: false },
    });
    expect(
      runLine(run("failed", { reason: "needs_input", answer: "Which export?", answer_cut: true })),
    ).toEqual({ tone: "needs_you", said: { kind: "question", text: "Which export?", cut: true } });
    expect(runLine(run("failed", { reason: "spawn_failed" }))).toEqual({ tone: "failed" });
    expect(runLine(run("cancelled"))).toEqual({ tone: "stopped" });
    expect(runLine(run("something new"))).toEqual({ tone: "unknown" });
  });

  test("the runs a phone reads come newest first", () => {
    const read = runsOf({
      result: {
        runs: [
          { id: "ru_old", state: "succeeded", queued_at: 1 },
          { id: "ru_new", state: "running", queued_at: 2 },
        ],
      },
    });
    expect(read?.value.map((r) => r.id)).toEqual(["ru_new", "ru_old"]);
  });
});
