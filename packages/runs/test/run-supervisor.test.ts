// The supervisor on real containers: a stand-in service (stand-ins/run-service.ts) queues runs of
// stand-in agents over a fixture space, in a delegated user unit on Linux and with tasks-run.exe on
// Windows, and the tests count what is alive from the operating system, never from the container.
// Where no real container can be made, the tests say so and skip.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createLaunchSpace, type LaunchSpaceFolder } from "@tasks/testkit";
import { afterAll, beforeAll, describe, expect, test, type TestContext } from "vitest";
import type { RunRecord } from "@tasks/contracts/runs";
import { RunFiles, RUNS_FOLDER, type QueueLimits } from "../src/index.ts";
import { buildNatives, type Natives } from "./stand-ins/native.ts";
import { Service, stopTestUnits, UNIT_PREFIX, userUnits, type Where } from "./stand-ins/service.ts";
import { census, newToken, waitForCensus, type StandInMode } from "./stand-ins/stand-ins.ts";

const windows = process.platform === "win32";
const RUN_SERVICE = join(import.meta.dirname, "stand-ins", "run-service.ts");

let work = "";
let place: Where = { ok: false, reason: "not prepared" };
let natives: Natives | undefined;
const services: Service[] = [];
/** Each service's run folders, to see when an agent listens for the interrupt. */
const folders = new Map<Service, RunFiles>();
const units: string[] = [];

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "tasks-run-supervisor-"));
  if (windows) {
    natives = buildNatives(join(work, "bin"));
    place = { ok: true };
  } else if (process.platform === "linux") {
    place = userUnits();
  } else {
    place = { ok: false, reason: "runs are contained on Linux and Windows only" };
  }
}, 300_000);

afterAll(async () => {
  for (const service of services) await service.close();
  if (process.platform === "linux" && place.ok) stopTestUnits(units);
  if (work !== "") rmSync(work, { recursive: true, force: true });
});

function need(ctx: TestContext): void {
  if (!place.ok) ctx.skip(place.reason);
}

/** A stand-in service on a fixture space of its own, with the queue's limits. */
async function startService(label: string, limits?: QueueLimits): Promise<Service> {
  const folder = join(work, label);
  mkdirSync(folder, { recursive: true });
  const space: LaunchSpaceFolder = await createLaunchSpace(folder);
  const config = JSON.stringify({
    space,
    state: join(folder, "state"),
    ...(natives === undefined ? {} : { helper: natives.helper }),
    times: { stopGraceMs: 2_000 },
    ...(limits === undefined ? {} : { limits }),
  });
  let service: Service;
  if (windows) {
    service = await Service.plain(natives?.helper ?? "", RUN_SERVICE, [config]);
  } else {
    const unit = `${UNIT_PREFIX}${label}.service`;
    units.push(unit);
    service = await Service.inUnit(unit, work, RUN_SERVICE, [config]);
  }
  services.push(service);
  folders.set(service, new RunFiles(join(folder, "state", RUNS_FOLDER)));
  return service;
}

interface Queued {
  readonly run: string;
  readonly token: string;
}

async function queue(
  service: Service,
  mode: StandInMode,
  limits: { wallMs?: number; idleMs?: number } = {},
): Promise<Queued> {
  const token = newToken();
  const { run } = await service.request<{ run: string }>("queue", { mode, token, ...limits });
  return { run, token };
}

const read = (service: Service, run: string) => service.request<RunRecord>("read", { run });
const ended = (service: Service, run: string) =>
  service.request<RunRecord>("ended", { run }, 120_000);

async function waitFor<T>(what: string, get: () => T | Promise<T>, ok: (value: T) => boolean) {
  const deadline = performance.now() + 30_000;
  for (;;) {
    const value = await get();
    if (ok(value)) return value;
    if (performance.now() >= deadline) throw new Error(`${what}: never true`);
    await sleep(50);
  }
}

/** The run runs and its agent listens for the interrupt: its first message is saved. */
async function running(service: Service, q: Queued): Promise<void> {
  await waitFor(
    "running",
    () => read(service, q.run),
    (r) => r.state === "running",
  );
  await waitFor(
    "listening",
    () => folders.get(service)?.readAnswer(q.run),
    (a) => a !== undefined,
  );
}

describe("[A4.3.11.9.run.queue] on a real container, runs past the limit wait in the queue and start in order as places free; the run limits end a run with its answer; an update's hold waits, then stops the runs", () => {
  test("four runs with room for two: two run, two wait and say why, and each Stop starts the oldest waiting one", async (ctx) => {
    need(ctx);
    const service = await startService(`queue-${newToken()}`, {
      runs: 2,
      perInstance: 10,
      perTask: 10,
    });
    try {
      const runs: Queued[] = [];
      for (let i = 0; i < 4; i += 1) runs.push(await queue(service, "talk"));
      const [a, b, c, d] = runs as [Queued, Queued, Queued, Queued];
      await running(service, a);
      await running(service, b);
      await waitForCensus(a.token, (pids) => pids.length > 0);
      await waitForCensus(b.token, (pids) => pids.length > 0);
      for (const q of [c, d]) {
        expect((await read(service, q.run)).state).toBe("queued");
        expect(await service.request("waiting", { run: q.run })).toBe("machine_limit");
        expect(census(q.token)).toEqual([]);
      }
      // A place frees: the oldest waiting run takes it, the other still waits.
      await service.request("stop", { run: a.run });
      expect(await ended(service, a.run)).toMatchObject({ state: "cancelled" });
      await running(service, c);
      expect((await read(service, d.run)).state).toBe("queued");
      expect(census(d.token)).toEqual([]);
      await service.request("stop", { run: b.run });
      await running(service, d);
      for (const q of [c, d]) await service.request("stop", { run: q.run });
      for (const q of runs) {
        expect(await ended(service, q.run)).toMatchObject({
          state: "cancelled",
          result: { text: "Stopped, with what was found so far." },
        });
      }
      for (const q of runs) await waitForCensus(q.token, (pids) => pids.length === 0);
    } finally {
      await service.close();
    }
  });

  test("a run that reaches its total time and one that stays quiet too long each end timed out with their answer", async (ctx) => {
    need(ctx);
    const service = await startService(`limits-${newToken()}`);
    try {
      const wall = await queue(service, "chatty", { wallMs: 2_000, idleMs: 60_000 });
      const idle = await queue(service, "talk", { wallMs: 60_000, idleMs: 1_500 });
      const answer = "Stopped, with what was found so far.";
      expect(await ended(service, wall.run)).toMatchObject({
        state: "timed_out",
        reason: "wall",
        result: { text: answer, textFinal: true },
      });
      expect(await ended(service, idle.run)).toMatchObject({
        state: "timed_out",
        reason: "idle",
        result: { text: answer, textFinal: true },
      });
      await waitForCensus(wall.token, (pids) => pids.length === 0);
      await waitForCensus(idle.token, (pids) => pids.length === 0);
    } finally {
      await service.close();
    }
  });

  test("an update's hold: nothing new starts, the running runs are named, a Stop of all of them keeps each answer, and once the hold goes the queue moves", async (ctx) => {
    need(ctx);
    const service = await startService(`hold-${newToken()}`);
    try {
      const first = await queue(service, "talk");
      const second = await queue(service, "talk");
      await running(service, first);
      await running(service, second);
      await service.request("hold");
      const waiting = await queue(service, "talk");
      expect(await service.request("waiting", { run: waiting.run })).toBe("update");
      const blocking = await service.request<{ run: string; state: string }[]>("blocking");
      expect(blocking.map((b) => b.run).sort()).toEqual([first.run, second.run].sort());
      // The update waited and the person said: stop them.
      expect(await service.request("stopAll", {}, 60_000)).toEqual([]);
      for (const q of [first, second]) {
        expect(await read(service, q.run)).toMatchObject({
          state: "cancelled",
          result: { text: "Stopped, with what was found so far." },
        });
        expect(census(q.token)).toEqual([]);
      }
      await sleep(300);
      expect((await read(service, waiting.run)).state).toBe("queued");
      expect(census(waiting.token)).toEqual([]);
      // The updater's hold goes: the queue moves again.
      await service.request("release");
      await running(service, waiting);
      await service.request("stop", { run: waiting.run });
      expect(await ended(service, waiting.run)).toMatchObject({ state: "cancelled" });
      await waitForCensus(waiting.token, (pids) => pids.length === 0);
    } finally {
      await service.close();
    }
  });
});
