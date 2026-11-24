// The supervisor's rules one by one, over an in-memory store and fake process groups: a run whose
// `starting` commit reached the store after its deadline, what retention keeps, and a queued run's
// wait, Stop and refusal.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunRecord } from "@ttasks/contracts/runs";
import { MemoryDurable, MemoryExecutionStore } from "@ttasks/launch/memory-store";
import { RunRefused, seenRun, type RunStore } from "@ttasks/launch/execution-store";
import { describe, expect, test } from "vitest";
import {
  RunFiles,
  RunHost,
  RunMachine,
  Supervisor,
  type Confirmation,
  type ProcessGroups,
  type Lane,
  type Prepared,
  type QueueLimits,
  type RunFolderList,
  type RunFolders,
  type SavedAnswer,
} from "../src/index.ts";
import { held, MACHINE, settle } from "./supervisor-world.ts";

const DAY = 24 * 60 * 60_000;
const TASK = "t_0000000000000000000000000a";
const OTHER_TASK = "t_0000000000000000000000000b";

/** A store whose openWork fails while `failing()` holds, and counts its calls in `opens`. */
function flaky(failing: () => boolean, counted: { opens: number }) {
  return (store: RunStore): RunStore =>
    new Proxy(store, {
      get(target, key, receiver) {
        const value: unknown = Reflect.get(target, key, receiver);
        if (typeof value !== "function") return value;
        const call = (value as (...a: unknown[]) => unknown).bind(target);
        if (key !== "openWork") return call;
        return (...args: unknown[]) => {
          counted.opens += 1;
          return failing() ? Promise.reject(new Error("The store is busy")) : call(...args);
        };
      },
    });
}

/** A run of TASK that ran and failed without an answer in its record. */
async function failedWithoutAnswer(store: RunStore, run: RunRecord): Promise<void> {
  const starting = await store.transitionRun(
    run.id,
    { state: "queued", version: run.version },
    "starting",
  );
  const running = await store.transitionRun(run.id, seenRun(starting), "running", {
    evidence: { pid: 7 },
  });
  await store.transitionRun(run.id, seenRun(running), "failed", { reason: "no_result" });
}

/** Process groups whose start never answers: a run that reaches one stays starting. */
const hanging: ProcessGroups = {
  probe: () => Promise.resolve({ available: true, kind: "job" }),
  kind: () => Promise.resolve("job" as const),
  start: () => new Promise<never>(() => undefined),
  interrupt: () => Promise.resolve(false),
  kill: () => Promise.resolve(),
  confirmEmpty: () => Promise.resolve({ state: "empty" }),
  recover: () => Promise.resolve({ state: "empty" }),
};

function folders(now: () => number) {
  const kept = new Map<string, { changedAt: number; answer?: SavedAnswer }>();
  const files: RunFolders & RunFolderList = {
    prepare: (id) => kept.set(id, { changedAt: now() }),
    saveAnswer: (id, answer) => kept.set(id, { changedAt: now(), answer }),
    readAnswer: (id) => kept.get(id)?.answer,
    heldAnswer: (id) => held(kept.get(id)?.answer),
    logs: () => ({ stdout: () => undefined, stderr: () => undefined, close: () => undefined }),
    removeTemps: () => undefined,
    list: () => [...kept].map(([id, f]) => ({ id, changedAt: f.changedAt })),
    remove: (id) => kept.delete(id),
  };
  return { kept, files };
}

function bench(
  options: {
    store?: (store: RunStore) => RunStore;
    deadline?: number;
    prepare?: (run: RunRecord) => Promise<Prepared> | undefined;
    prepareMs?: number;
    updating?: () => boolean;
    limits?: QueueLimits;
    groups?: ProcessGroups;
  } = {},
) {
  let now = Date.UTC(2026, 10, 16, 9, 0, 0);
  const durable = new MemoryDurable(() => now);
  const plain = new MemoryExecutionStore(durable);
  const machine = new RunMachine({
    store: options.store?.(plain) ?? plain,
    machine: MACHINE,
    ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
  });
  const { kept, files } = folders(() => now);
  const host = new RunHost({ machine, groups: options.groups ?? hanging, files });
  const lane: Lane = { space: "sp_0000000000000000000000000a", machine, host };
  let refuse = false;
  const supervisor = new Supervisor({
    lanes: () => [lane],
    limits: () => options.limits ?? { runs: 3, perInstance: 2, perTask: 1 },
    prepare: (_lane, run) =>
      options.prepare?.(run) ??
      Promise.resolve(
        refuse
          ? { refused: "folder_gone" as const }
          : { command: () => ({ command: "agent", args: [], cwd: "/", env: {} }) },
      ),
    ...(options.prepareMs === undefined ? {} : { prepareMs: options.prepareMs }),
    ...(options.updating === undefined ? {} : { updating: options.updating }),
    folders: files,
    retention: { days: 14, count: 2 },
    now: () => now,
  });
  let requests = 0;
  const queue = async (task = TASK): Promise<RunRecord> => {
    requests += 1;
    now += 1;
    return machine.queue(
      {
        task,
        routine: null,
        instance: "claude-work",
        adapter: "claude-print",
        place: null,
        request: "Look into the export.",
        briefHash: "0a1b2c3d".repeat(8),
        permission: "auto-edit",
        limits: { maxTurns: 50, wallMs: 60 * 60_000, idleMs: 20 * 60_000 },
      },
      `supervisor-unit-${String(requests).padStart(6, "0")}`,
    );
  };
  return {
    durable,
    store: plain,
    machine,
    host,
    lane,
    supervisor,
    kept,
    queue,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    refuse: (on: boolean) => {
      refuse = on;
    },
  };
}

describe("[A4.5.run.supervisor] the supervisor's rules: a start whose record landed late, retention's keeps, and a queued run's wait, Stop and refusal", () => {
  test("a `starting` commit that reached the store after its deadline leaves a run that the next round fails start_timed_out, with nothing started", async () => {
    let slow = true;
    const b = bench({
      deadline: 20,
      store: (store) =>
        new Proxy(store, {
          get(target, key, receiver) {
            const value: unknown = Reflect.get(target, key, receiver);
            if (typeof value !== "function") return value;
            if (key !== "transitionRun")
              return (value as (...a: unknown[]) => unknown).bind(target);
            return async (...args: unknown[]) => {
              if (slow && args[2] === "starting") {
                slow = false;
                await new Promise((resolve) => setTimeout(resolve, 80));
              }
              return (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
            };
          },
        }),
    });
    const run = await b.queue();
    await b.supervisor.round();
    // The host gave up on the commit; the commit then landed.
    expect(b.host.hosted()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect((await b.store.readRun(run.id))?.state).toBe("starting");
    await b.supervisor.round();
    expect(await b.store.readRun(run.id)).toMatchObject({
      state: "failed",
      reason: "start_timed_out",
    });
    b.supervisor.close();
  });

  test("a queued run past its limits says why it waits; a Stop cancels it at once and it never starts; one that can no longer start fails with why", async () => {
    const b = bench();
    // The first run of the task takes the task's one place: its process group is still starting.
    const first = await b.queue();
    await b.supervisor.round();
    expect((await b.store.readRun(first.id))?.state).toBe("starting");
    const second = await b.queue();
    await b.supervisor.round();
    expect(b.supervisor.waiting(second.id)).toBe("task_limit");
    expect((await b.store.readRun(second.id))?.state).toBe("queued");
    expect(await b.host.stop(second.id)).toMatchObject({ state: "cancelled" });
    await b.supervisor.round();
    expect(b.supervisor.waiting(second.id)).toBeUndefined();
    expect(b.host.hosted()).toEqual([first.id]);
    // A run of another task whose folder is gone fails before anything starts for it.
    b.refuse(true);
    const third = await b.queue("t_0000000000000000000000000b");
    await b.supervisor.round();
    expect(await b.store.readRun(third.id)).toMatchObject({
      state: "failed",
      reason: "folder_gone",
    });
    expect(b.host.hosted()).toEqual([first.id]);
    b.supervisor.close();
    await b.host.close();
  });

  test("a run whose Stop could not be confirmed holds its task's place: the task's next run waits until that end is confirmed", async () => {
    let left = true;
    const confirm = (): Promise<Confirmation> =>
      Promise.resolve(left ? { state: "occupied", detail: "left" } : { state: "empty" });
    const b = bench({ groups: { ...hanging, confirmEmpty: confirm, recover: confirm } });
    const first = await b.queue();
    const starting = await b.store.transitionRun(
      first.id,
      { state: "queued", version: first.version },
      "starting",
    );
    const running = await b.store.transitionRun(first.id, seenRun(starting), "running", {
      evidence: { pid: 7 },
    });
    const cancelling = await b.store.transitionRun(first.id, seenRun(running), "cancelling");
    await b.store.transitionRun(first.id, seenRun(cancelling), "unknown", {
      reason: "stop_timed_out",
    });
    await b.host.recover();
    expect(b.host.hosted()).toEqual([first.id]);
    const second = await b.queue();
    await b.supervisor.round();
    expect((await b.store.readRun(second.id))?.state).toBe("queued");
    expect(b.supervisor.waiting(second.id)).toBe("task_limit");
    left = false;
    expect(await b.host.forceEnd(first.id)).toMatchObject({ state: "cancelled" });
    await b.supervisor.round();
    expect((await b.store.readRun(second.id))?.state).toBe("starting");
    b.supervisor.close();
    await b.host.close();
  });

  test("retention removes old folders of runs that ended and were saved, and keeps open, unconfirmed and unsaved runs' folders and those of runs no open space knows", async () => {
    const b = bench();
    const make = async (state: "succeeded" | "unknown" | "running" | "unsaved") => {
      const run = await b.queue();
      b.kept.set(run.id, {
        changedAt: b.now(),
        answer: { text: "Found it.", final: true, cut: false },
      });
      let after = await b.store.transitionRun(
        run.id,
        { state: "queued", version: run.version },
        "starting",
      );
      if (state === "running" || state === "succeeded" || state === "unsaved") {
        after = await b.store.transitionRun(run.id, seenRun(after), "running", {
          evidence: { pid: 7 },
        });
      }
      if (state === "succeeded") {
        await b.store.transitionRun(run.id, seenRun(after), "succeeded", {
          result: {
            ok: true,
            outcome: "success",
            exitCode: 0,
            signal: null,
            nativeId: null,
            text: "Found it.",
            error: null,
            usage: null,
            appTools: null,
            declined: 0,
            permissionDenials: 0,
            durationMs: 1,
          },
        });
      }
      if (state === "unsaved") {
        await b.store.transitionRun(run.id, seenRun(after), "failed", { reason: "no_result" });
      }
      if (state === "unknown") {
        await b.store.transitionRun(run.id, seenRun(after), "unknown", {
          reason: "stop_timed_out",
        });
      }
      return run.id;
    };
    const done = await make("succeeded");
    const open = await make("running");
    const unsure = await make("unknown");
    const unsaved = await make("unsaved");
    const elsewhere = "ru_0000000000000000000000000z";
    b.kept.set(elsewhere, { changedAt: 0 });
    // Within 14 days and the newest two: nothing goes yet but what is past the count.
    expect(await b.supervisor.retain()).toBe(1);
    expect(b.kept.has(done)).toBe(false);
    b.advance(15 * DAY);
    expect(await b.supervisor.retain()).toBe(0);
    expect([...b.kept.keys()].sort()).toEqual([open, unsure, unsaved, elsewhere].sort());
    b.supervisor.close();
    await settle();
  });

  test("retention keeps the folder of a run whose record holds no answer while an answer file is there, even one that cannot be read", async () => {
    const b = bench();
    const run = await b.queue();
    await failedWithoutAnswer(b.store, run);
    const root = mkdtempSync(join(tmpdir(), "ttasks-retain-"));
    try {
      const files = new RunFiles(root);
      files.prepare(run.id);
      const answer = join(files.folder(run.id), "answer.json");
      writeFileSync(answer, "{ not an answer");
      const supervisor = new Supervisor({
        lanes: () => [b.lane],
        limits: () => ({ runs: 3, perInstance: 2, perTask: 1 }),
        prepare: () => Promise.resolve({ refused: "spawn_failed" }),
        folders: files,
        retention: { days: 14, count: 0 },
        now: b.now,
      });
      expect(await supervisor.retain()).toBe(0);
      rmSync(answer);
      expect(await supervisor.retain()).toBe(1);
      expect(files.list()).toEqual([]);
      supervisor.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("retention removes the folder of a run that ended with no answer once its record holds that end, and keeps one whose end only the folder holds", async () => {
    const b = bench();
    const said = {
      outcome: "agent_error" as const,
      error: "Not signed in. Sign in with: codex login",
    };
    const recorded = await b.queue();
    const starting = await b.store.transitionRun(
      recorded.id,
      { state: "queued", version: recorded.version },
      "starting",
    );
    const running = await b.store.transitionRun(recorded.id, seenRun(starting), "running", {
      evidence: { pid: 7 },
    });
    await b.store.transitionRun(recorded.id, seenRun(running), "failed", {
      reason: "agent_error",
      result: {
        ok: false,
        ...said,
        exitCode: 1,
        signal: null,
        nativeId: null,
        text: null,
        usage: null,
        appTools: null,
        declined: 0,
        permissionDenials: 0,
        durationMs: 1,
      },
    });
    const unrecorded = await b.queue();
    await failedWithoutAnswer(b.store, unrecorded);
    const root = mkdtempSync(join(tmpdir(), "ttasks-retain-"));
    try {
      const files = new RunFiles(root);
      for (const run of [recorded, unrecorded]) {
        files.prepare(run.id);
        files.saveAnswer(run.id, { text: null, final: false, cut: false, ...said });
      }
      const supervisor = new Supervisor({
        lanes: () => [b.lane],
        limits: () => ({ runs: 3, perInstance: 2, perTask: 1 }),
        prepare: () => Promise.resolve({ refused: "spawn_failed" }),
        folders: files,
        retention: { days: 14, count: 0 },
        now: b.now,
      });
      expect(await supervisor.retain()).toBe(1);
      expect(files.list().map((folder) => folder.id)).toEqual([unrecorded.id]);
      supervisor.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an update is asked about every run a host works on, also when the space's store did not answer the round after its start", async () => {
    let failing = false;
    const counted = { opens: 0 };
    const b = bench({ store: flaky(() => failing, counted) });
    const run = await b.queue();
    await b.supervisor.round();
    expect(b.host.hosted()).toEqual([run.id]);
    failing = true;
    expect(await b.supervisor.blocking()).toEqual([
      expect.objectContaining({ run: run.id, state: "starting" }),
    ]);
    b.supervisor.close();
    await b.host.close();
  });

  test("waiting for the end of a run left starting asks for one round, not one after another while its store does not answer", async () => {
    let failing = false;
    const counted = { opens: 0 };
    const b = bench({ store: flaky(() => failing, counted) });
    const run = await b.queue();
    await b.store.transitionRun(run.id, { state: "queued", version: run.version }, "starting");
    failing = true;
    counted.opens = 0;
    const ended = b.supervisor.ended(b.lane, run.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(counted.opens).toBeLessThanOrEqual(2);
    b.supervisor.close();
    expect((await ended)?.state).toBe("starting");
  });

  test("a check before a start that does not answer leaves its run queued and holds up no other run", async () => {
    const stalled = new Set<string>();
    const b = bench({
      prepareMs: 20,
      prepare: (run) => (stalled.has(run.id) ? new Promise<never>(() => undefined) : undefined),
    });
    const first = await b.queue();
    stalled.add(first.id);
    const second = await b.queue(OTHER_TASK);
    await b.supervisor.round();
    expect((await b.store.readRun(first.id))?.state).toBe("queued");
    expect((await b.store.readRun(second.id))?.state).toBe("starting");
    b.supervisor.close();
    await b.host.close();
  });

  test("a store that does not take a start leaves the run queued for a later round, without a round after round", async () => {
    let refusals = 0;
    const b = bench({
      store: (store) =>
        new Proxy(store, {
          get(target, key, receiver) {
            const value: unknown = Reflect.get(target, key, receiver);
            if (typeof value !== "function") return value;
            const call = (value as (...a: unknown[]) => unknown).bind(target);
            if (key !== "transitionRun") return call;
            return (...args: unknown[]) => {
              // Bounded, so a supervisor that asks again and again ends and the count tells.
              if (args[2] === "starting" && refusals < 50) {
                refusals += 1;
                return Promise.reject(new RunRefused("unavailable", "The space is read-only"));
              }
              return call(...args);
            };
          },
        }),
    });
    const run = await b.queue();
    await b.supervisor.round();
    await settle();
    expect(refusals).toBe(1);
    expect((await b.store.readRun(run.id))?.state).toBe("queued");
    b.supervisor.close();
    await b.host.close();
  });

  test("a run whose check keeps failing leaves its place to the next run in line within the same round", async () => {
    const failing = new Set<string>();
    const b = bench({
      limits: { runs: 1, perInstance: 2, perTask: 1 },
      prepare: (run) =>
        failing.has(run.id) ? Promise.reject(new Error("The task could not be read")) : undefined,
    });
    const first = await b.queue();
    failing.add(first.id);
    const second = await b.queue(OTHER_TASK);
    await b.supervisor.round();
    expect((await b.store.readRun(first.id))?.state).toBe("queued");
    expect((await b.store.readRun(second.id))?.state).toBe("starting");
    b.supervisor.close();
    await b.host.close();
  });

  test("a run left starting whose store does not take its end holds up no round: other runs start meanwhile", async () => {
    const stuck = new Set<string>();
    const b = bench({
      prepareMs: 20,
      store: (store) =>
        new Proxy(store, {
          get(target, key, receiver) {
            const value: unknown = Reflect.get(target, key, receiver);
            if (typeof value !== "function") return value;
            const call = (value as (...a: unknown[]) => unknown).bind(target);
            if (key !== "transitionRun") return call;
            return (...args: unknown[]) =>
              stuck.has(String(args[0])) && args[2] !== "starting"
                ? Promise.reject(new Error("The disk is full"))
                : call(...args);
          },
        }),
    });
    const left = await b.queue();
    stuck.add(left.id);
    await b.store.transitionRun(left.id, { state: "queued", version: left.version }, "starting");
    const other = await b.queue(OTHER_TASK);
    await b.supervisor.round();
    expect((await b.store.readRun(left.id))?.state).toBe("starting");
    expect((await b.store.readRun(other.id))?.state).toBe("starting");
    expect(b.host.hosted()).toEqual([other.id]);
    b.supervisor.close();
    await b.host.close();
  });

  test("while an update has not finished nothing new starts, also without the updater's hold, and the run says why it waits", async () => {
    let updating = true;
    const b = bench({ updating: () => updating });
    const run = await b.queue();
    await b.supervisor.round();
    expect(b.supervisor.waiting(run.id)).toBe("update");
    expect((await b.store.readRun(run.id))?.state).toBe("queued");
    updating = false;
    await b.supervisor.round();
    expect((await b.store.readRun(run.id))?.state).toBe("starting");
    b.supervisor.close();
    await b.host.close();
  });
});
