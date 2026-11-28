// What the page shows of a background run (runs.ts): its state in plain words, what the agent said,
// Stop while it may still work, the row's marker, how a read joins what the page already shows,
// and the words of a refusal. Fixture runs only.
import { createIntl } from "react-intl";
import { describe, expect, test } from "vitest";
import { PRODUCT_NAME, CLI_NAME } from "@ttasks/brand";
import { Refused, type Instance, type Run } from "../api.ts";
import en from "../i18n/en.json" with { type: "json" };
import { continueRefusal } from "../row/launch.ts";
import { mergeRuns, agentMarker, runRefusal, runners, runView, withStops } from "./runs.ts";

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

/** A view's state as the page words it, in the source catalogue: formatting errors fail. */
function words(view: ReturnType<typeof runView>): string[] {
  const intl = createIntl({
    locale: "en",
    messages: en,
    onError: (error) => {
      throw error;
    },
  });
  return view.status.map((m) =>
    intl.formatMessage({ id: m.id }, { product: PRODUCT_NAME, cli: CLI_NAME, ...m.values }),
  );
}

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

  test("a working run says how long it has said nothing, from a minute on, and keeps Stop", () => {
    const since = 1_000_000;
    const early = runView(run({ quiet_since: since }), "Codex", since + 59_000);
    expect(ids(early)).toEqual(["run.working"]);
    expect(early.quiet).toBeUndefined();
    const quiet = runView(run({ quiet_since: since }), "Codex", since + 25 * 60_000 + 5_000);
    expect(quiet).toMatchObject({ tone: "working", stoppable: true });
    expect(ids(quiet)).toEqual(["run.working"]);
    expect(quiet.quiet).toEqual({ id: "run.quiet", values: { minutes: 25 } });
  });

  test("a working run shows what it said so far, so a server it keeps running can be used before Stop", () => {
    const serving = runView(
      run({ answer: "The preview is at http://localhost:5173.", answer_final: true }),
      "Claude Code",
    );
    expect(serving).toMatchObject({
      tone: "working",
      stoppable: true,
      said: { kind: "last", text: "The preview is at http://localhost:5173." },
    });
    expect(runView(run(), "Claude Code").said).toBeUndefined();
  });

  test("a run whose permission refused some of the agent's requests says how many", () => {
    const done = runView(run({ state: "succeeded", refused: 2 }), "Claude Code");
    expect(words(done)).toContain("Its permission refused 2 requests of Claude Code.");
    const failed = runView(
      run({ state: "failed", reason: "agent_error", refused: 1 }),
      "Claude Code",
    );
    expect(words(failed)).toContain("Its permission refused 1 request of Claude Code.");
    expect(ids(runView(run({ state: "succeeded" }), "Claude Code"))).toEqual(["run.done"]);
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

  test("a restored copy's run that was open when its backup was made says so, with no Stop and no word of going on", () => {
    const working = runView(run({ state: "recorded" }), "Codex");
    expect(working).toMatchObject({ tone: "recorded", stoppable: false });
    expect(words(working)).toEqual(["Codex was working on it when this backup was made."]);
    const waiting = runView(run({ state: "recorded", started_at: null }), "Codex");
    expect(waiting.stoppable).toBe(false);
    expect(words(waiting)).toEqual(["Codex had not started on it when this backup was made."]);
    // A claim or a restore in place ended it.
    const ended = runView(run({ state: "failed", reason: "restored" }), "Codex");
    expect(ended.stoppable).toBe(false);
    expect(words(ended)).toEqual([
      "Interrupted when the space was restored from a backup. Run it again to go on.",
    ]);
  });
});

describe("[M6.page.run-continue] a run that holds its agent's conversation offers Continue", () => {
  test("an ended run continues now, one that may still work after it is stopped, and one without a conversation not at all", () => {
    for (const state of ["succeeded", "failed", "cancelled", "timed_out"]) {
      expect(runView(run({ state, resumable: true }), "Codex").continues).toBe("now");
    }
    expect(
      runView(run({ state: "failed", reason: "needs_input", resumable: true }), "Codex").continues,
    ).toBe("now");
    expect(runView(run({ resumable: true }), "Codex").continues).toBe("after_stop");
    expect(
      runView(run({ state: "unknown", reason: "stop_timed_out", resumable: true }), "Codex")
        .continues,
    ).toBe("after_stop");
    expect(runView(run({ state: "succeeded" }), "Codex").continues).toBeUndefined();
  });
});

describe("[M6.page.run-continue] a Continue that opened nothing says why", () => {
  test("each of the service's reasons has its words, and another refusal is not one", () => {
    const intl = createIntl({
      locale: "en",
      messages: en,
      onError: (error) => {
        throw error;
      },
    });
    const refused = (data: unknown) => Object.assign(new Error("refused"), { data });
    for (const why of [
      "conversation",
      "machine",
      "folder",
      "instance",
      "home",
      "folder_moved",
      "not_stopped",
    ]) {
      const reason = continueRefusal(refused({ field: "run", reason: why }));
      expect(reason).toBe(why);
      const words = intl.formatMessage({ id: "run.continueRefused" }, { why: reason });
      expect(words, why).not.toBe(
        intl.formatMessage({ id: "run.continueRefused" }, { why: "other" }),
      );
    }
    expect(continueRefusal(refused({ field: "instance", reason: "no_terminal" }))).toBeUndefined();
  });
});

describe("[M6.page.run-follow] the page shows a run as the service has it", () => {
  test("a read keeps what the page holds newer, and a run queued after the read began", () => {
    const answered = run({ state: "cancelling", version: 5 });
    const queuedLater = run({
      id: "ru_00r5mfcw5rfzxb9enb2vg50z3h",
      queued_at: 2_000,
      state: "queued",
    });
    const stale = [run({ version: 4 })];
    expect(mergeRuns([answered, queuedLater], stale)).toEqual([answered, queuedLater]);
    // The service's next step wins over what the page held.
    const later = run({ state: "cancelled", version: 6 });
    expect(mergeRuns([answered], [later])).toEqual([later]);
    // A run that left the read's window is not kept.
    const old = run({ id: "ru_00r5mfcw5rfzxb9enb2vg50z3j", queued_at: 10 });
    expect(mergeRuns([old], [run({ queued_at: 1_000 })]).map((r) => r.id)).not.toContain(old.id);
  });

  test("a Stop on its way shows as stopping; without it, the run shows with its Stop again", () => {
    const working = run({ state: "running", version: 4 });
    const other = run({ id: "ru_00r5mfcw5rfzxb9enb2vg50z3h", state: "running", version: 2 });
    const list = [working, other];
    const pressed = new Map([[working.id, { version: 4 }]]);
    const shown = withStops(list, pressed);
    expect(shown.map((r) => r.state)).toEqual(["cancelling", "running"]);
    expect(runView(shown[0] ?? working, "Codex").stoppable).toBe(false);
    // A stale read while the Stop is on its way does not undo it.
    expect(withStops([run({ state: "running", version: 4 }), other], pressed)[0]?.state).toBe(
      "cancelling",
    );
    // The service is further along: its record shows.
    const ended = run({ state: "succeeded", version: 5 });
    expect(withStops([ended, other], pressed)[0]).toBe(ended);
    // The Stop failed and is forgotten: the run is as the service has it, with its Stop.
    const after = withStops(list, new Map());
    expect(after).toBe(list);
    expect(runView(after[0] ?? working, "Codex").stoppable).toBe(true);
    // A queued run stops as any other: only the service says it stopped before it started.
    expect(
      withStops([run({ state: "queued", version: 1 })], new Map([[working.id, { version: 1 }]]))[0]
        ?.state,
    ).toBe("cancelling");
  });

  test("the row's marker: working, or needing the person, named by the instance's label", () => {
    const instances: Instance[] = [
      {
        key: "codex-work",
        app: "Codex",
        label: "Codex · work",
        glyph: "Cx",
        ring: 1,
        route: "terminal",
        runs: true,
      },
      { key: "claude", app: "Claude", label: "Claude", glyph: "Cl", ring: 2, route: "terminal" },
    ];
    expect(
      agentMarker({ id: "ru_1", state: "needs_you", instance: "codex-work" }, instances),
    ).toEqual({
      kind: "needs_input",
      by: "Codex · work",
    });
    expect(agentMarker({ id: "ru_1", state: "working", instance: "gone" }, instances)).toEqual({
      kind: "working",
      by: "gone",
    });
    expect(
      agentMarker({ id: "ru_1", state: "later", instance: "codex-work" }, instances),
    ).toBeUndefined();
    // A restored copy's run was open when its backup was made: nothing of it works now.
    expect(
      agentMarker({ id: "ru_1", state: "recorded", instance: "codex-work" }, instances),
    ).toBeUndefined();
    expect(agentMarker(undefined, instances)).toBeUndefined();
    // An agent's question that waits asks for the person, as a run that needs them does.
    const question = { ref: "l3", by: "Claude", text: "Which export?", at: 1 };
    expect(agentMarker(undefined, instances, question)).toEqual({
      kind: "needs_input",
      by: "Claude",
    });
    expect(
      agentMarker({ id: "ru_1", state: "working", instance: "codex-work" }, instances, question),
    ).toEqual({ kind: "needs_input", by: "Claude" });
    // An earlier run's question, while a later run works, names that run's agent as the page does.
    const asked = { ref: "ru_2", by: "codex-work", instance: "codex-work", text: "Which?", at: 1 };
    expect(
      agentMarker({ id: "ru_3", state: "working", instance: "claude" }, instances, asked),
    ).toEqual({ kind: "needs_input", by: "Codex · work" });
    // The newest question names the marker, also when an older one is a run that asks.
    expect(
      agentMarker({ id: "ru_1", state: "needs_you", instance: "codex-work" }, instances, question),
    ).toEqual({ kind: "needs_input", by: "Claude" });
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
