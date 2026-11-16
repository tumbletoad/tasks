// The supervisor's rules one by one, over an in-memory store and fake containers: a run whose
// `starting` commit reached the store after its deadline, what retention keeps, and a queued run's
// wait, Stop and refusal.
import type { RunRecord } from "@tasks/contracts/runs";
import { MemoryDurable, MemoryExecutionStore } from "@tasks/launch/memory-store";
import { seenRun, type RunStore } from "@tasks/launch/execution-store";
import { describe, expect, test } from "vitest";
import {
  RunHost,
  RunMachine,
  Supervisor,
  type Containers,
  type Lane,
  type RunFolderList,
  type RunFolders,
  type SavedAnswer,
} from "../src/index.ts";
import { MACHINE, settle } from "./supervisor-world.ts";

const DAY = 24 * 60 * 60_000;
const TASK = "t_0000000000000000000000000a";

/** Containers whose start never answers: a run that reaches one stays starting. */
const hanging: Containers = {
  probe: () => Promise.resolve({ available: true, kind: "job" }),
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
    logs: () => ({ stdout: () => undefined, stderr: () => undefined, close: () => undefined }),
    removeTemps: () => undefined,
    list: () => [...kept].map(([id, f]) => ({ id, changedAt: f.changedAt })),
    remove: (id) => kept.delete(id),
  };
  return { kept, files };
}

function bench(options: { store?: (store: RunStore) => RunStore; deadline?: number } = {}) {
  let now = Date.UTC(2026, 10, 16, 9, 0, 0);
  const durable = new MemoryDurable(() => now);
  const plain = new MemoryExecutionStore(durable);
  const machine = new RunMachine({
    store: options.store?.(plain) ?? plain,
    machine: MACHINE,
    ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
  });
  const { kept, files } = folders(() => now);
  const host = new RunHost({ machine, containers: hanging, files });
  const lane: Lane = { space: "sp_0000000000000000000000000a", machine, host };
  let refuse = false;
  const supervisor = new Supervisor({
    lanes: () => [lane],
    limits: () => ({ runs: 3, perInstance: 2, perTask: 1 }),
    available: () => Promise.resolve(true),
    prepare: () =>
      Promise.resolve(
        refuse
          ? { refused: "folder_gone" as const }
          : { command: "agent", args: [], cwd: "/", env: {} },
      ),
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
    // The first run of the task takes the task's one place: its container is still starting.
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
});
