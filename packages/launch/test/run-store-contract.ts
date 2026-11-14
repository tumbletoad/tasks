// The execution store's contract suite for runs (A4 3.16.1, 5.1): every backend of the run part
// must pass it, so the run machine, which knows only the interface, behaves the same on each. v1
// runs it against the in-memory backend and the space database's (in-thread and through the
// storage worker). The L1 journal must pass it too (M3.12).
//
// It covers what the run machine relies on: one queued record per request ID and its replay, a
// compare-and-set on the state and the version that moves nothing when it loses, only A4's edges
// and each state's reasons, evidence that only grows, a result once and only entering a final
// state, a time per state, openWork per machine after a restart, and records whose only texts are
// the request and the result's.
import {
  FINAL_RUN_STATES,
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
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { RunRefused, seenRun, type ExecutionStore } from "../src/store.ts";
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
  failed: [{ next: "starting" }, { next: "failed", patch: { reason: "not_claimed" } }],
  timed_out: [
    { next: "starting" },
    { next: "running" },
    { next: "timed_out", patch: { reason: "wall" } },
  ],
  cancelled: [{ next: "cancelled" }],
  unknown: [{ next: "starting" }, { next: "unknown", patch: { reason: "lost" } }],
};

/** The patch a transition into `next` needs. */
function patchFor(from: RunState, next: RunState): RunPatch {
  if (from === next) return { evidence: { pid: 4242 } };
  if (next === "failed") return { reason: "agent_error" };
  if (next === "timed_out") return { reason: "idle" };
  if (next === "unknown") return { reason: from === "cancelling" ? "stop_timed_out" : "lost" };
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
      adapter: "codex-exec",
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
        adapter: "codex-exec",
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
      for (const patch of [{}, { reason: "wall" as const }, { reason: "lost" as const }]) {
        const refused = await refusal(store.transitionRun(run.id, seenRun(run), "failed", patch));
        expect(refused).toMatchObject({ code: "invalid", field: "patch.reason" });
      }
      const noReason = await refusal(
        store.transitionRun(run.id, seenRun(run), "running", { reason: "lost" }),
      );
      expect(noReason.field).toBe("patch.reason");
    });

    test("a compare-and-set on the state and the version moves nothing when it loses", async () => {
      const run = await runIn("starting");
      const claimed = await store.transitionRun(run.id, seenRun(run), "starting", {
        evidence: { claim: "claim-1", claimed_at: run.queuedAt + 1 },
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
        evidence: { claim: "claim-1" },
      });
      const other = await refusal(
        store.transitionRun(claimed.id, seenRun(claimed), "starting", {
          evidence: { claim: "claim-2" },
        }),
      );
      expect(other).toMatchObject({ code: "evidence", current: claimed });
      const same = await store.transitionRun(claimed.id, seenRun(claimed), "starting", {
        evidence: { claim: "claim-1" },
      });
      expect(same).toEqual(claimed);
      backend.advance(1_000);
      const running = await store.transitionRun(claimed.id, seenRun(claimed), "running", {
        evidence: { pid: 4242, native_id: "thread-0001" },
      });
      expect(running.evidence).toEqual({ claim: "claim-1", pid: 4242, native_id: "thread-0001" });
      expect(running.startedAt).toBe(running.at.running);
      const early = await refusal(
        store.transitionRun(running.id, seenRun(running), "running", {
          evidence: { folder_checked: true },
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
      const lost = await runIn("unknown");
      const settled = await store.transitionRun(lost.id, seenRun(lost), "failed", {
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
        if (!(FINAL_RUN_STATES as readonly RunState[]).includes(state)) expected.push(run.id);
      }
      // A stop that timed out: a later exit still settles it, so it stays on the list. The unknown
      // run above is lost, which nothing settles any more.
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
      // U+0344 is 2 UTF-8 bytes and normalises to two marks of 2 bytes each: 8 KiB becomes 16.
      const grows = "̈́".repeat(TEXT_CAP_BYTES / 2);
      const run = await runIn("running");
      const done = await store.transitionRun(run.id, seenRun(run), "succeeded", {
        result: { ...RESULT, text: grows, error: "Stopped\r\nat a prompt\u0007" },
      });
      expect(done.result?.text).toBe("̈́".repeat(TEXT_CAP_BYTES / 4));
      expect(done.result?.error).toBe("Stopped\nat a prompt");
      expect(await store.readRun(run.id)).toEqual(done);
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
