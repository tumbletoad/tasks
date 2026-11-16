// The execution store's contract suite against each v1 backend (A4 3.16.1, 5.1), the space
// database's through a storage worker as the service runs it, and the rules the writer keeps a
// copy of, compared with A4's own.
import fc from "fast-check";
import {
  APP_TOOLS_STATES,
  cutRunText,
  FINAL_RUN_STATES,
  normaliseRunText,
  OPEN_RUN_STATES,
  OUTCOME_REASONS,
  RUN_ADAPTERS,
  RUN_EDGES,
  RUN_EVIDENCE_FIELDS,
  RUN_EVIDENCE_ID,
  RUN_LIMIT_BOUNDS,
  RUN_PERMISSIONS,
  RUN_REASONS,
  RUN_REQUEST_MAX_BYTES,
  RUN_STATES,
  TEXT_CAP_BYTES,
  ANSWER_CAP_BYTES,
} from "@tasks/contracts/runs";
import {
  STORAGE_FINAL_RUN_STATES,
  STORAGE_OPEN_RUN_STATES,
  STORAGE_RUN_APP_TOOLS,
  STORAGE_RUN_EDGES,
  STORAGE_RUN_EVIDENCE_FIELDS,
  STORAGE_RUN_EVIDENCE_ID,
  STORAGE_RUN_LIMIT_BOUNDS,
  STORAGE_RUN_OUTCOMES,
  STORAGE_RUN_PERMISSIONS,
  STORAGE_RUN_REASONS,
  STORAGE_RUN_REQUEST_MAX_BYTES,
  STORAGE_RUN_STATES,
  STORAGE_RUN_TEXT_MAX_BYTES,
  STORAGE_RUN_RESULT_TEXT_MAX_BYTES,
  STORAGE_FOCUS_MS,
  STORAGE_LAUNCH_EDGES,
  STORAGE_LAUNCH_EVIDENCE_FIELDS,
  STORAGE_LAUNCH_EVIDENCE_ID,
  STORAGE_LAUNCH_FAIL_REASONS,
  STORAGE_LAUNCH_STATES,
  STORAGE_LAUNCH_UNKNOWN_REASONS,
  STORAGE_OPEN_LAUNCH_STATES,
  STORAGE_OPEN_SETS,
  STORAGE_REFERENCE_WINDOW_MS,
  storageIsLaunchRef,
  storageNormaliseText,
  type LaunchSpace,
  type WorkerLaunchSpace,
} from "@tasks/testkit";
import { describe, expect, test } from "vitest";
import {
  EDGES,
  EVIDENCE_FIELDS,
  EVIDENCE_ID,
  FAIL_REASONS,
  FOCUS_MS,
  INTENT_STATES,
  UNKNOWN_REASONS,
  isLaunchRef,
  launchRefCheck,
  OPEN_STATES,
  REF_ALPHABET,
  REFERENCE_WINDOW_MS,
  ROUTES,
} from "../src/intents.ts";
import { decodeLaunch, SpaceExecutionStore } from "../src/space-store.ts";
import { ExecutionRefused } from "../src/store.ts";
import { executionStoreContract } from "./execution-store-contract.ts";
import { runStoreContract } from "./run-store-contract.ts";
import { memoryBackend, spaceBackend, spaceStore, workerSpace } from "./stores.ts";

executionStoreContract("in memory", () => Promise.resolve(memoryBackend()));

executionStoreContract("the space database, through the writer", () => spaceBackend());

runStoreContract("in memory", () => Promise.resolve(memoryBackend()));

runStoreContract("the space database, through the writer", () => spaceBackend());

describe("[A4.5.launch.open-replay] the space store says, read only, whether a request ID was decided", () => {
  test("false before a click and for another ID, true after it, through the worker and in this thread, and the lookup writes nothing", async () => {
    const worker = await workerSpace();
    try {
      const inThread = await spaceBackend();
      try {
        await decidedOn(worker.space);
        await decidedOn(inThread.space);
      } finally {
        await inThread.close();
      }
    } finally {
      await worker.close();
    }
  });
});

/** `decided` on one space's store: false before the click, true after it, false for another ID. */
async function decidedOn(space: LaunchSpace | WorkerLaunchSpace): Promise<void> {
  const store = new SpaceExecutionStore({
    writer: space.writer,
    spaceId: space.spaceId,
    credential: space.credential,
  });
  const input = {
    task: await space.task(),
    machine: space.machine,
    instance: "codex-work",
    route: "terminal" as const,
    place: null,
    taskVersion: 1,
    briefHash: "0123456789abcdef".repeat(4),
  };
  expect(await store.decided("replay-request-0000001")).toBe(false);
  // Asking twice decides nothing: the ID is still free for its first call.
  expect(await store.decided("replay-request-0000001")).toBe(false);
  const intent = await store.createIntent(input, "replay-request-0000001");
  expect(await store.decided("replay-request-0000001")).toBe(true);
  expect(await store.decided("replay-request-0000002")).toBe(false);
  expect((await store.createIntent(input, "replay-request-0000001")).id).toBe(intent.id);
}

describe("[A4.5.execution-store.contract] the space database's store through a storage worker", () => {
  test("a click, a compare-and-set, a refusal and openWork across a restart of the writer", async () => {
    const { space, close } = await workerSpace();
    try {
      const store = spaceStore(space);
      const input = {
        task: await space.task(),
        machine: space.machine,
        instance: "codex-work",
        route: "terminal" as const,
        place: await space.place(),
        taskVersion: 2,
        briefHash: "0123456789abcdef".repeat(4),
      };
      const intent = await store.createIntent(input, "worker-request-0000001");
      expect(intent.state).toBe("prepared");
      expect(isLaunchRef(intent.reference)).toBe(true);
      const dispatching = await store.transitionIntent(intent.id, "prepared", "dispatching");
      const stale = await store.transitionIntent(intent.id, "prepared", "dispatching").then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(stale).toBeInstanceOf(ExecutionRefused);
      expect((stale as ExecutionRefused).current).toEqual(dispatching);
      await space.restart();
      const restarted = spaceStore(space);
      expect((await restarted.openWork(space.machine)).intents).toEqual([dispatching]);
      expect((await restarted.createIntent(input, "worker-request-0000001")).id).toBe(intent.id);
    } finally {
      await close();
    }
  });
});

describe("[A4.5.execution-store.contract] a launch row read back from the space", () => {
  const row = {
    id: "la_0000000000000000000000000a",
    reference: "L7KQ2" + (launchRefCheck("7KQ2") ?? ""),
    task_id: "t_0000000000000000000000000b",
    session_id: null,
    instance_id: "codex-work",
    machine_id: "m_0000000000000000000000000c",
    route: "terminal",
    place_id: null,
    task_version: 3,
    brief_hash: "f".repeat(64),
    state: "dispatched",
    reason: null,
    evidence: { claim: "claim-1", later_key: "kept-out" },
    at: { prepared: 1, dispatching: 2, dispatched: 3 },
    created_at: 1,
    updated_at: 3,
    version: 9,
  };

  test("leaves out evidence a newer build added, and refuses a damaged row", () => {
    expect(decodeLaunch(row)).toMatchObject({
      state: "dispatched",
      folderKind: "work_folder",
      evidence: { claim: "claim-1" },
      at: { prepared: 1, dispatching: 2, dispatched: 3 },
    });
    expect(decodeLaunch(row).evidence).not.toHaveProperty("later_key");
    for (const damaged of [
      { ...row, state: "opening" },
      { ...row, route: "pigeon" },
      { ...row, reason: "it broke" },
      { ...row, reference: "L7KQ2Z" === row.reference ? "L7KQ2Y" : "L7KQ2Z" },
      { ...row, evidence: { claim: "two words" } },
      { ...row, at: { opening: 1 } },
    ]) {
      expect(() => decodeLaunch(damaged)).toThrow(/invalid/);
    }
  });
});

describe("[A4.5.execution-store.contract] the writer's copy of A4's launch rules", () => {
  test("the states, edges, open states, routes, focus, reference window, evidence and reasons are A4's", () => {
    expect([...STORAGE_LAUNCH_STATES]).toEqual([...INTENT_STATES]);
    expect(STORAGE_LAUNCH_EDGES).toEqual(EDGES);
    expect([...STORAGE_OPEN_LAUNCH_STATES]).toEqual([...OPEN_STATES]);
    expect([...STORAGE_OPEN_SETS["launches.route"]]).toEqual([...ROUTES]);
    expect(STORAGE_FOCUS_MS).toBe(FOCUS_MS);
    expect(STORAGE_REFERENCE_WINDOW_MS).toBe(REFERENCE_WINDOW_MS);
    expect(STORAGE_LAUNCH_EVIDENCE_FIELDS).toEqual(EVIDENCE_FIELDS);
    expect([...STORAGE_LAUNCH_FAIL_REASONS]).toEqual([...FAIL_REASONS]);
    expect([...STORAGE_LAUNCH_UNKNOWN_REASONS]).toEqual([...UNKNOWN_REASONS]);
    expect(STORAGE_LAUNCH_EVIDENCE_ID.source).toBe(EVIDENCE_ID.source);
  });

  test("both read a launch reference alike, and a changed symbol breaks its check", () => {
    let checked = 0;
    for (const a of REF_ALPHABET) {
      for (const b of "07KZ") {
        for (const check of REF_ALPHABET) {
          const reference = `L${a}${b}Q2${check}`;
          expect(storageIsLaunchRef(reference), reference).toBe(isLaunchRef(reference));
          if (isLaunchRef(reference)) {
            checked += 1;
            for (const other of REF_ALPHABET) {
              if (other !== a) expect(isLaunchRef(`L${other}${b}Q2${check}`)).toBe(false);
            }
          }
        }
      }
    }
    expect(checked).toBe(32 * 4);
    for (const bad of ["L7KQ2", "M7KQ2M", "L7kq2m", "LIKQ2M", 42, null]) {
      expect(isLaunchRef(bad)).toBe(false);
      expect(storageIsLaunchRef(bad)).toBe(false);
    }
  });
});

describe("[A4.5.execution-store.contract] the writer's copy of A4's run rules", () => {
  test("the states, open and final states, edges, reasons, evidence, adapters, permissions, limits and caps are contracts'", () => {
    expect([...STORAGE_RUN_STATES]).toEqual([...RUN_STATES]);
    expect([...STORAGE_OPEN_RUN_STATES]).toEqual([...OPEN_RUN_STATES]);
    expect([...STORAGE_FINAL_RUN_STATES]).toEqual([...FINAL_RUN_STATES]);
    expect(STORAGE_RUN_EDGES).toEqual(RUN_EDGES);
    expect(STORAGE_RUN_REASONS).toEqual(RUN_REASONS);
    expect(STORAGE_RUN_EVIDENCE_FIELDS).toEqual(RUN_EVIDENCE_FIELDS);
    expect(STORAGE_RUN_EVIDENCE_ID.source).toBe(RUN_EVIDENCE_ID.source);
    expect([...STORAGE_OPEN_SETS["runs.adapter"]]).toEqual([...RUN_ADAPTERS]);
    expect([...STORAGE_RUN_PERMISSIONS]).toEqual([...RUN_PERMISSIONS]);
    expect(STORAGE_RUN_LIMIT_BOUNDS).toEqual(RUN_LIMIT_BOUNDS);
    expect([...STORAGE_RUN_OUTCOMES]).toEqual([...OUTCOME_REASONS]);
    expect([...STORAGE_RUN_APP_TOOLS]).toEqual([...APP_TOOLS_STATES]);
    expect(STORAGE_RUN_TEXT_MAX_BYTES).toBe(TEXT_CAP_BYTES);
    expect(STORAGE_RUN_RESULT_TEXT_MAX_BYTES).toBe(ANSWER_CAP_BYTES);
    expect(STORAGE_RUN_REQUEST_MAX_BYTES).toBe(RUN_REQUEST_MAX_BYTES);
  });

  test("a run's texts are normalised as the writer stores them, and a cut text is one the writer keeps as it is", () => {
    // Line breaks, C0 controls, lone surrogates and marks that NFC composes, reorders or expands.
    const pieces = fc.constantFrom(
      "a",
      "é",
      "̈́",
      "क़",
      "가",
      "\r\n",
      "\r",
      "\u0007",
      "\t",
      "\ud800",
      "\udc00",
      "\u{1f600}",
      "̣̇",
    );
    const text = fc.oneof(
      fc.string({ unit: "binary" }),
      fc.array(pieces, { maxLength: 400 }).map((p) => p.join("")),
    );
    fc.assert(
      fc.property(text, fc.integer({ min: 1, max: 64 }), (value, bytes) => {
        expect(normaliseRunText(value)).toBe(storageNormaliseText(value));
        const cut = cutRunText(value, bytes);
        expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(bytes);
        expect(storageNormaliseText(cut)).toBe(cut);
        expect(normaliseRunText(value).startsWith(cut)).toBe(true);
      }),
      { numRuns: 2_000 },
    );
  });
});
