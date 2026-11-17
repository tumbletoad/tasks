// The execution store's contract suite for runs (A4 3.16.1, 5.1): every backend of the run part
// must pass it, so the run machine, which knows only the interface, behaves the same on each. v1
// runs it against the in-memory backend and the space database's (in-thread and through the
// storage worker). The L1 journal must pass it too (M3.12).
//
// It covers what the run machine relies on: one queued record per request ID and its replay, a
// compare-and-set on the state and the version that moves nothing when it loses, only A4's edges
// and each state's reasons, evidence that only grows, a result once and only entering a final
// state, a time per state, openWork per machine after a restart, records whose only texts are the
// request and the result's, and every result value judged as the writer's own validation judges
// it, kept as the writer keeps it (a property over every JSON shape).
import fc from "fast-check";
import {
  ANSWER_CAP_BYTES,
  APP_TOOLS_STATES,
  FINAL_RUN_STATES,
  normaliseRunText,
  OUTCOME_REASONS,
  RUN_EDGES,
  RUN_LIMITS,
  RUN_REQUEST_MAX_BYTES,
  RUN_STATES,
  TEXT_CAP_BYTES,
  type NewRun,
  type RunPatch,
  type RunRecord,
  type RunResult,
  type RunState,
} from "@tasks/contracts/runs";
import { openLaunchSpace } from "@tasks/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SpaceExecutionStore } from "../src/space-store.ts";
import { cutResultTexts, RunRefused, seenRun, type ExecutionStore } from "../src/store.ts";
import type { ContractBackend } from "./execution-store-contract.ts";

const HASH = "5e0b7d13".repeat(8);
const OTHER_MACHINE = "m_0000000000000000000000000z";
const ROUTINE = "ro_0000000000000000000000000r";

/** A path through A4's run machine from `queued` to `state`, with the patches each step needs. */
const PATHS: Record<RunState, { next: RunState; patch?: RunPatch }[]> = {
  queued: [],
  starting: [{ next: "starting" }],
  running: [{ next: "starting" }, { next: "running" }],
  waiting_for_input: [{ next: "starting" }, { next: "running" }, { next: "waiting_for_input" }],
  cancelling: [{ next: "starting" }, { next: "cancelling" }],
  reconciling: [{ next: "starting" }, { next: "reconciling" }],
  succeeded: [{ next: "starting" }, { next: "running" }, { next: "succeeded" }],
  failed: [{ next: "starting" }, { next: "failed", patch: { reason: "spawn_failed" } }],
  timed_out: [
    { next: "starting" },
    { next: "running" },
    { next: "timed_out", patch: { reason: "wall" } },
  ],
  cancelled: [{ next: "cancelled" }],
  unknown: [{ next: "starting" }, { next: "unknown", patch: { reason: "stop_timed_out" } }],
};

/** The patch a transition into `next` needs. */
function patchFor(from: RunState, next: RunState): RunPatch {
  if (from === next) return { evidence: { pid: 4242 } };
  if (next === "failed") return { reason: "agent_error" };
  if (next === "timed_out") return { reason: "idle" };
  if (next === "unknown") return { reason: "stop_timed_out" };
  return {};
}

const RESULT: RunResult = {
  ok: true,
  outcome: "success",
  exitCode: 0,
  signal: null,
  nativeId: "thread-0001",
  text: "Fixed the export.",
  error: null,
  usage: { inputTokens: 1_200, outputTokens: 300 },
  appTools: "connected",
  declined: 0,
  permissionDenials: 0,
  durationMs: 64_000,
};

let requests = 0;
const requestId = (): string => `run-contract-${String((requests += 1)).padStart(8, "0")}`;

async function refusal(promise: Promise<unknown>): Promise<RunRefused> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RunRefused) return error;
    throw error;
  }
  throw new Error("The call was not refused");
}

/** A store's or the writer's verdict on a result: refused as a result, or the result it kept. */
type Verdict = { refused: true } | { kept: RunResult | null };

/** The verdict of a transition that carries a result: any other refusal is not one. */
async function verdictOf(transition: Promise<RunRecord>): Promise<Verdict> {
  try {
    return { kept: (await transition).result };
  } catch (error) {
    if (
      error instanceof RunRefused &&
      error.code === "invalid" &&
      /^patch\.result(\.|$)/u.test(error.field ?? "")
    ) {
      return { refused: true };
    }
    throw error;
  }
}

const RESULT_COLUMNS: Readonly<Record<string, string>> = {
  exitCode: "exit_code",
  textCut: "text_cut",
  textFinal: "text_final",
  nativeId: "native_id",
  appTools: "app_tools",
  permissionDenials: "permission_denials",
  durationMs: "duration_ms",
};

const USAGE_COLUMNS: Readonly<Record<string, string>> = {
  inputTokens: "input_tokens",
  cachedInputTokens: "cached_input_tokens",
  outputTokens: "output_tokens",
  reasoningOutputTokens: "reasoning_output_tokens",
  costUsd: "cost_usd",
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A result value as every store sends it to the writer, and nothing more: the texts cut as every
 * store cuts them (A4 3.11.2), the known keys in the column's snake case, every value and every
 * other key as it is, so the writer judges the value itself.
 */
function writerForm(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(cutResultTexts(value)).map(([key, item]) => {
      let out: unknown = item;
      if (key === "usage" && isPlainObject(item)) {
        out = Object.fromEntries(
          Object.entries(item).map(([name, n]) => [USAGE_COLUMNS[name] ?? name, n]),
        );
      }
      return [RESULT_COLUMNS[key] ?? key, out];
    }),
  );
}

/** Numbers at the edges of every range a result's fields have, and past them. */
const EDGE_NUMBERS = [
  0,
  -0,
  1,
  -1,
  1.5,
  2 ** 31 - 1,
  2 ** 31,
  -(2 ** 31),
  -(2 ** 31) - 1,
  2 ** 32 - 1,
  2 ** 32,
  253_402_300_799_999,
  253_402_300_800_000,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 1,
  Number.MIN_VALUE,
  Number.MAX_VALUE,
  -Number.MAX_VALUE,
];
const number = fc.oneof(
  fc.constantFrom(...EDGE_NUMBERS),
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
);
const text = fc.oneof(
  fc.string(),
  fc.string({ unit: "binary", maxLength: 40 }),
  // Longer than the cap, and longer once normalised (U+0344 expands to two marks).
  fc.constantFrom(
    "x".repeat(TEXT_CAP_BYTES + 1),
    "̈́".repeat(TEXT_CAP_BYTES / 2),
    "x".repeat(ANSWER_CAP_BYTES + 1),
    "̈́".repeat(ANSWER_CAP_BYTES / 2),
    "",
  ),
);
/** Every JSON shape: null, booleans, numbers, texts, lists and objects, nested. */
const anyJson = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  number,
  text,
  fc.constant([]),
  fc.constant({}),
  fc.array(fc.jsonValue({ maxDepth: 2 }), { maxLength: 3 }),
  fc.dictionary(fc.string({ maxLength: 8 }), fc.jsonValue({ maxDepth: 2 }), { maxKeys: 3 }),
);
/**
 * A field's value: one the writer keeps most of the time, else one at or past the edge of what it
 * keeps, or any JSON value.
 */
const field = (fits: fc.Arbitrary<unknown>, edge: fc.Arbitrary<unknown>): fc.Arbitrary<unknown> =>
  fc.oneof(
    { weight: 12, arbitrary: fits },
    { weight: 1, arbitrary: edge },
    { weight: 1, arbitrary: anyJson },
  );
const orNull = (fits: fc.Arbitrary<unknown>): fc.Arbitrary<unknown> =>
  fc.oneof(fc.constant(null), fits);
const edgeNumber = fc.oneof(
  fc.constantFrom(...EDGE_NUMBERS),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
);
const count = fc.integer({ min: 0, max: 2 ** 31 - 1 });
const usageKey = fc.constantFrom(...Object.keys(USAGE_COLUMNS));
const RESULT_KEYS = [
  "ok",
  "outcome",
  "exitCode",
  "signal",
  "nativeId",
  "text",
  "textCut",
  "textFinal",
  "error",
  "usage",
  "appTools",
  "declined",
  "permissionDenials",
  "durationMs",
] as const;
/** Result values: most of them objects of a result's keys, now and then one missing or added. */
const resultValue: fc.Arbitrary<unknown> = fc.oneof(
  {
    weight: 9,
    arbitrary: fc
      .tuple(
        fc.record({
          ok: field(fc.boolean(), fc.constantFrom(0, 1, "true")),
          outcome: field(
            fc.constantFrom(...OUTCOME_REASONS),
            fc.constantFrom("Success", "success ", "lost_track"),
          ),
          exitCode: field(orNull(fc.integer({ min: -(2 ** 31), max: 2 ** 32 - 1 })), edgeNumber),
          signal: field(
            fc.constantFrom(null, "SIGTERM", "SIGKILL", "SIGINT"),
            fc.constantFrom("SIG", "SIGABCDEFGHIJKLM", "sigterm", "SIG-TERM"),
          ),
          nativeId: field(
            fc.constantFrom(null, "thread-0001", "0199a3f2-7c41-7d20-9b6e-3f1c2a4b5d6e"),
            fc.constantFrom("a".repeat(128), "a".repeat(129), "two words", "-x", ""),
          ),
          text: field(orNull(text), fc.constant(undefined)),
          textCut: field(fc.constantFrom(undefined, true, false), fc.constantFrom(0, "yes")),
          textFinal: field(fc.constantFrom(undefined, true, false), fc.constantFrom(1, null)),
          error: field(orNull(text), fc.constant(undefined)),
          usage: field(
            orNull(
              fc.dictionary(
                usageKey,
                fc.oneof(fc.nat(), fc.double({ min: 0, max: 1e6, noNaN: true })),
                { maxKeys: 5 },
              ),
            ),
            fc.oneof(
              fc.constant([]),
              fc.constant([1, 2]),
              fc.dictionary(
                fc.oneof(usageKey, fc.constantFrom("tokens", "folder")),
                fc.oneof(edgeNumber, anyJson),
                { maxKeys: 4 },
              ),
            ),
          ),
          appTools: field(
            fc.constantFrom(null, ...APP_TOOLS_STATES),
            fc.constantFrom("Connected", "none"),
          ),
          declined: field(count, edgeNumber),
          permissionDenials: field(count, edgeNumber),
          durationMs: field(orNull(fc.integer({ min: 0, max: 253_402_300_799_999 })), edgeNumber),
        }),
        fc.oneof(
          { weight: 12, arbitrary: fc.constant(undefined) },
          { weight: 1, arbitrary: fc.constantFrom(...RESULT_KEYS) },
        ),
        fc.oneof(
          { weight: 12, arbitrary: fc.constant(undefined) },
          { weight: 1, arbitrary: fc.tuple(fc.constantFrom("folder", "extra"), anyJson) },
        ),
      )
      .map(([value, missing, extra]) => {
        // A key whose generated value is undefined is left out, as JSON leaves it out.
        const out: Record<string, unknown> = Object.fromEntries(
          Object.entries(value).filter(([key, item]) => item !== undefined && key !== missing),
        );
        if (extra !== undefined) out[extra[0]] = extra[1];
        return out;
      }),
  },
  { weight: 1, arbitrary: anyJson },
);

/** Every string a record holds but its request and its result's texts: IDs, codes and states. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(strings);
}

export function runStoreContract(
  name: string,
  open: () => Promise<ContractBackend>,
  timeout = 60_000,
): void {
  describe(`[A4.5.execution-store.contract] the ExecutionStore contract for runs: ${name}`, () => {
    let backend: ContractBackend;
    let store: ExecutionStore;

    beforeEach(async () => {
      backend = await open();
      store = backend.store;
    }, timeout);

    afterEach(async () => {
      await backend.close();
    }, timeout);

    const runInput = async (extra: Partial<NewRun> = {}): Promise<NewRun> => ({
      task: await backend.task(),
      routine: null,
      machine: backend.machine,
      instance: "codex-work",
      adapter: "codex",
      place: null,
      request: "Check the export and fix the time zone.",
      briefHash: HASH,
      permission: "full-access",
      limits: RUN_LIMITS.task,
      ...extra,
    });

    /** A fresh run moved along A4's machine to `state`. */
    const runIn = async (state: RunState, extra: Partial<NewRun> = {}): Promise<RunRecord> => {
      let run = await store.createRun(await runInput(extra), requestId());
      for (const step of PATHS[state]) {
        run = await store.transitionRun(run.id, seenRun(run), step.next, step.patch);
      }
      return run;
    };

    test("createRun records a queued run with what it was given, and a request ID replays", async () => {
      const input = await runInput({ place: await backend.place() });
      const id = requestId();
      const run = await store.createRun(input, id);
      expect(run).toMatchObject({
        task: input.task,
        routine: null,
        session: null,
        machine: backend.machine,
        instance: "codex-work",
        adapter: "codex",
        place: input.place,
        folderKind: "place",
        request: input.request,
        briefHash: HASH,
        permission: "full-access",
        limits: RUN_LIMITS.task,
        state: "queued",
        reason: null,
        attempt: 1,
        evidence: {},
        result: null,
        startedAt: null,
        endedAt: null,
      });
      expect(run.at).toEqual({ queued: run.queuedAt });
      expect(await store.readRun(run.id)).toEqual(run);
      expect(await store.createRun(input, id)).toEqual(run);
      const reused = await refusal(store.createRun({ ...input, request: "Something else" }, id));
      expect(reused.code).toBe("request_id_reused");
      // A routine's run has no task, and a run takes exactly one of them.
      const routine = await store.createRun(
        await runInput({ task: null, routine: ROUTINE, request: null }),
        requestId(),
      );
      expect(routine).toMatchObject({ task: null, routine: ROUTINE, request: null });
      const both = await refusal(
        store.createRun(await runInput({ routine: ROUTINE }), requestId()),
      );
      expect(both).toMatchObject({ code: "invalid", field: "task" });
      const inherit = await refusal(
        store.createRun(
          { ...(await runInput()), permission: "inherit" as NewRun["permission"] },
          requestId(),
        ),
      );
      expect(inherit).toMatchObject({ code: "invalid", field: "permission" });
      const silent = await refusal(store.createRun(await runInput({ request: null }), requestId()));
      expect(silent).toMatchObject({ code: "invalid", field: "request" });
    });

    test("only A4's edges, with each state's reasons, and every one read back as returned", async () => {
      for (const from of RUN_STATES) {
        const run = await runIn(from);
        expect(run.state, from).toBe(from);
        for (const to of RUN_STATES) {
          if (RUN_EDGES[from].includes(to)) continue;
          const refused = await refusal(store.transitionRun(run.id, seenRun(run), to, {}));
          expect(refused, `${from} -> ${to}`).toMatchObject({ code: "invalid", field: "next" });
        }
        expect(await store.readRun(run.id), from).toEqual(run);
      }
      for (const from of RUN_STATES) {
        for (const to of RUN_EDGES[from]) {
          const run = await runIn(from);
          const moved = await store.transitionRun(run.id, seenRun(run), to, patchFor(from, to));
          expect(moved.state, `${from} -> ${to}`).toBe(to);
          expect(moved.version).toBeGreaterThan(run.version);
          expect(await store.readRun(run.id)).toEqual(moved);
        }
      }
      const run = await runIn("starting");
      for (const patch of [
        {},
        { reason: "wall" as const },
        { reason: "stop_timed_out" as const },
      ]) {
        const refused = await refusal(store.transitionRun(run.id, seenRun(run), "failed", patch));
        expect(refused).toMatchObject({ code: "invalid", field: "patch.reason" });
      }
      const noReason = await refusal(
        store.transitionRun(run.id, seenRun(run), "running", { reason: "stop_timed_out" }),
      );
      expect(noReason.field).toBe("patch.reason");
    });

    test("a compare-and-set on the state and the version moves nothing when it loses", async () => {
      const run = await runIn("starting");
      const claimed = await store.transitionRun(run.id, seenRun(run), "starting", {
        evidence: { pid: 4242, pid_started_at: run.queuedAt + 1 },
      });
      // The record the caller read is gone: its version moved.
      const stale = await refusal(store.transitionRun(run.id, seenRun(run), "running"));
      expect(stale.code).toBe("stale");
      expect(stale.current).toEqual(claimed);
      const moved = await refusal(
        store.transitionRun(run.id, { state: "queued", version: claimed.version }, "starting"),
      );
      expect(moved).toMatchObject({ code: "stale", current: claimed });
      expect(await store.readRun(run.id)).toEqual(claimed);
      const missing = await refusal(
        store.transitionRun("ru_0000000000000000000000000x", seenRun(run), "running"),
      );
      expect(missing.code).toBe("not_found");
    });

    test("evidence only grows, a result goes in once and only entering a final state, each state has its time", async () => {
      const run = await runIn("starting");
      const claimed = await store.transitionRun(run.id, seenRun(run), "starting", {
        evidence: { pid: 4242 },
      });
      const other = await refusal(
        store.transitionRun(claimed.id, seenRun(claimed), "starting", {
          evidence: { pid: 4343 },
        }),
      );
      expect(other).toMatchObject({ code: "evidence", current: claimed });
      const same = await store.transitionRun(claimed.id, seenRun(claimed), "starting", {
        evidence: { pid: 4242 },
      });
      expect(same).toEqual(claimed);
      backend.advance(1_000);
      const running = await store.transitionRun(claimed.id, seenRun(claimed), "running", {
        evidence: { pid: 4242, pid_started_at: 1_800_000_000_000, native_id: "thread-0001" },
      });
      expect(running.evidence).toEqual({
        pid: 4242,
        pid_started_at: 1_800_000_000_000,
        native_id: "thread-0001",
      });
      expect(running.startedAt).toBe(running.at.running);
      const early = await refusal(
        store.transitionRun(running.id, seenRun(running), "running", {
          evidence: { native_id: "thread-0002" },
          result: RESULT,
        }),
      );
      expect(early).toMatchObject({ code: "invalid", field: "patch.result" });
      backend.advance(60_000);
      const done = await store.transitionRun(running.id, seenRun(running), "succeeded", {
        result: RESULT,
      });
      expect(done).toMatchObject({ state: "succeeded", result: RESULT, reason: null });
      expect(done.endedAt).toBe(done.at.succeeded);
      expect(Object.keys(done.at)).toEqual(["queued", "starting", "running", "succeeded"]);
      expect((done.at.succeeded ?? 0) - (done.at.running ?? 0)).toBeGreaterThanOrEqual(60_000);
      // An unknown run settled later keeps one result.
      const unsure = await runIn("unknown");
      const settled = await store.transitionRun(unsure.id, seenRun(unsure), "failed", {
        reason: "no_result",
        result: { ...RESULT, ok: false, outcome: "no_result" },
      });
      expect(settled).toMatchObject({ state: "failed", reason: "no_result" });
      expect(FINAL_RUN_STATES).toContain(settled.state);
    });

    test("openWork lists this machine's open runs and the unknown ones that await their exit, the same after a restart", async () => {
      const expected: string[] = [];
      for (const state of RUN_STATES) {
        const run = await runIn(state);
        backend.advance(1);
        // An unknown run awaits the confirmation that its container is empty: it stays listed.
        if (!(FINAL_RUN_STATES as readonly RunState[]).includes(state) || state === "unknown") {
          expected.push(run.id);
        }
      }
      const stopping = await runIn("cancelling");
      const timedOut = await store.transitionRun(stopping.id, seenRun(stopping), "unknown", {
        reason: "stop_timed_out",
      });
      expected.push(timedOut.id);
      const ids = (work: { runs: RunRecord[] }): string[] => work.runs.map((r) => r.id);
      expect(ids(await store.openWork(backend.machine))).toEqual(expected);
      expect((await store.openWork(OTHER_MACHINE)).runs).toEqual([]);
      const before = await store.openWork(backend.machine);
      const restarted = await backend.restart();
      expect((await restarted.openWork(backend.machine)).runs).toEqual(before.runs);
    });

    test("texts are kept as the space stores them: an agent's are cut, never refused, and a request is judged after normalising", async () => {
      // U+0344 is 2 UTF-8 bytes and normalises to two marks of 2 bytes each: its text doubles.
      const grows = (bytes: number): string => "̈́".repeat(bytes / 2);
      const run = await runIn("running");
      const error = `Stopped\r\nat a prompt\u0007${grows(TEXT_CAP_BYTES)}`;
      const done = await store.transitionRun(run.id, seenRun(run), "succeeded", {
        result: {
          ...RESULT,
          text: grows(ANSWER_CAP_BYTES),
          error,
        },
      });
      // The answer is kept up to its cap and flagged as cut; the error has the small cap.
      const bytes = (s: string | null | undefined): number =>
        new TextEncoder().encode(s ?? "").length;
      const answer = done.result?.text ?? "";
      expect(bytes(answer)).toBe(ANSWER_CAP_BYTES);
      expect(normaliseRunText(grows(ANSWER_CAP_BYTES)).startsWith(answer)).toBe(true);
      expect(done.result?.textCut).toBe(true);
      expect(normaliseRunText(error).startsWith(done.result?.error ?? "-")).toBe(true);
      expect(bytes(done.result?.error)).toBeGreaterThan(TEXT_CAP_BYTES - 4);
      expect(bytes(done.result?.error)).toBeLessThanOrEqual(TEXT_CAP_BYTES);
      expect(await store.readRun(run.id)).toEqual(done);
      // An answer the size of its cap is kept whole and not flagged.
      const whole = "a".repeat(ANSWER_CAP_BYTES);
      const other = await runIn("running");
      const flagged = await store.transitionRun(other.id, seenRun(other), "succeeded", {
        result: { ...RESULT, text: whole, textFinal: true },
      });
      expect(flagged.result).toEqual({ ...RESULT, text: whole, textFinal: true });
      // Every other field is judged as the writer judges it, so no backend accepts a result
      // another refuses: a cost beyond a safe integer, a fractional duration, usage that is a list.
      for (const [bad, field] of [
        [{ ...RESULT, usage: { costUsd: 1e300 } }, "patch.result.usage"],
        [{ ...RESULT, durationMs: 1.5 }, "patch.result.durationMs"],
        [{ ...RESULT, exitCode: 2 ** 32 }, "patch.result.exitCode"],
        [{ ...RESULT, usage: [] as unknown as RunResult["usage"] }, "patch.result.usage"],
      ] as const) {
        const other = await runIn("running");
        const refused = await refusal(
          store.transitionRun(other.id, seenRun(other), "succeeded", { result: bad }),
        );
        expect(refused, field).toMatchObject({ code: "invalid", field });
      }
      const kept = await store.createRun(
        await runInput({ request: "Fix the export\r\nand the zone\u0007" }),
        requestId(),
      );
      expect(kept.request).toBe("Fix the export\nand the zone");
      const large = await refusal(
        store.createRun(
          await runInput({ request: "̈́".repeat(RUN_REQUEST_MAX_BYTES / 4 + 1) }),
          requestId(),
        ),
      );
      expect(large).toMatchObject({ code: "invalid", field: "request" });
      const blank = await refusal(
        store.createRun(await runInput({ request: "\u0007\r\n" }), requestId()),
      );
      expect(blank).toMatchObject({ code: "invalid", field: "request" });
    });

    test("every result value gets the writer's own verdict, and one that is kept reads back as the writer keeps it", async () => {
      // The writer's verdict comes from a space of its own: the same value, as every store sends
      // it (the texts cut, A4 3.11.2; the keys in the column's snake case), in a run.transition
      // submitted to its writer directly. A result goes in entering any final state; this one
      // takes a queued run to cancelled, one write per verdict.
      const parent = mkdtempSync(join(tmpdir(), "tasks-run-judge-"));
      try {
        const judge = await openLaunchSpace(parent);
        try {
          const judgeStore = new SpaceExecutionStore({
            writer: judge.writer,
            spaceId: judge.spaceId,
            credential: judge.credential,
          });
          const judgeInput = {
            ...(await runInput()),
            task: await judge.task(),
            machine: judge.machine,
          };
          const input = await runInput();
          let judged = 0;
          const verdicts = { kept: 0, refused: 0 };
          await fc.assert(
            fc.asyncProperty(resultValue, async (value) => {
              const run = await store.createRun(input, requestId());
              const mine = await verdictOf(
                store.transitionRun(run.id, seenRun(run), "cancelled", {
                  result: value as RunResult,
                }),
              );
              const target = await judgeStore.createRun(judgeInput, requestId());
              const written = judge.writer.submit({
                space_id: judge.spaceId,
                request_id: `run-judge-${String((judged += 1)).padStart(8, "0")}`,
                actor: judge.credential,
                ops: [
                  {
                    kind: "run.transition",
                    run: target.id,
                    expect: "queued",
                    expect_version: target.version,
                    next: "cancelled",
                    result: writerForm(value),
                  },
                ],
              });
              let writers: Verdict;
              if (written.status === "applied") {
                writers = { kept: (await judgeStore.readRun(target.id))?.result ?? null };
              } else {
                const field = written.error?.field ?? "";
                expect(written.error?.code).toBe("VALIDATION_FAILED");
                expect(field).toMatch(/^ops\[0\]\.result(\.|$)/u);
                writers = { refused: true };
              }
              // As JSON, which is what the space keeps: -0 is 0 there.
              expect(JSON.parse(JSON.stringify(mine))).toEqual(JSON.parse(JSON.stringify(writers)));
              verdicts["refused" in writers ? "refused" : "kept"] += 1;
            }),
            { numRuns: 300 },
          );
          // The values reach both verdicts, so the property compares what is kept too.
          expect(verdicts.kept).toBeGreaterThan(10);
          expect(verdicts.refused).toBeGreaterThan(10);
        } finally {
          judge.close();
        }
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    }, 120_000);

    test("a record's only texts are its request and its result's: everything else is an ID, a code or a state", async () => {
      const run = await runIn("running");
      const done = await store.transitionRun(run.id, seenRun(run), "succeeded", {
        result: RESULT,
      });
      const { request, result, ...rest } = done;
      const { text, error, ...counts } = result ?? RESULT;
      expect(request).toBe("Check the export and fix the time zone.");
      expect([text, error]).toEqual([RESULT.text, null]);
      for (const value of strings({ ...rest, ...counts })) {
        expect(value, value).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
      }
    });
  });
}
