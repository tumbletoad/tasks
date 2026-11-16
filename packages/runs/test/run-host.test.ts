// The run host on real containers: a stand-in service (stand-ins/run-service.ts) hosts runs of
// stand-in agents over a fixture space, in a delegated user unit on Linux and with tasks-run.exe
// on Windows, and the tests count what is alive from the operating system, never from the
// container. Where no real container can be made, the tests say so and skip: a fake would prove
// nothing.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createLaunchSpace, type LaunchSpaceFolder } from "@tasks/testkit";
import { afterAll, beforeAll, describe, expect, test, type TestContext } from "vitest";
import type { RunRecord } from "@tasks/contracts/runs";
import { RunFiles, RUNS_FOLDER } from "../src/index.ts";
import { buildNatives, type Natives } from "./stand-ins/native.ts";
import {
  Service,
  stopTestUnits,
  UNIT_PREFIX,
  userUnits,
  waitUnitGone,
  type Where,
} from "./stand-ins/service.ts";
import { census, newToken, waitForCensus, type StandInMode } from "./stand-ins/stand-ins.ts";

const windows = process.platform === "win32";
const RUN_SERVICE = join(import.meta.dirname, "stand-ins", "run-service.ts");
const MiB = 1024 * 1024;

let work = "";
let place: Where = { ok: false, reason: "not prepared" };
let natives: Natives | undefined;
const services: Service[] = [];
const units: string[] = [];

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "tasks-run-host-"));
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

/** A test's own fixture space and state folder. */
async function bench(label: string): Promise<{ space: LaunchSpaceFolder; state: string }> {
  const folder = join(work, label);
  mkdirSync(folder, { recursive: true });
  return { space: await createLaunchSpace(folder), state: join(folder, "state") };
}

/** A run service on the bench: in the user unit `tasks-test-container-<label>` on Linux. */
async function startService(
  label: string,
  at: { space: LaunchSpaceFolder; state: string },
): Promise<Service> {
  const config = JSON.stringify({
    space: at.space,
    state: at.state,
    ...(natives === undefined ? {} : { helper: natives.helper }),
    times: { stopGraceMs: 2_000 },
  });
  let service: Service;
  if (windows) {
    service = await Service.plain(natives?.helper ?? "", RUN_SERVICE, [config]);
  } else {
    const unit = `${UNIT_PREFIX}${label}.service`;
    if (!units.includes(unit)) units.push(unit);
    service = await Service.inUnit(unit, work, RUN_SERVICE, [config]);
  }
  services.push(service);
  return service;
}

/** Starts a stand-in agent as a run; its record is `starting` or later. */
async function startRun(service: Service, mode: StandInMode) {
  const token = newToken();
  const { run } = await service.request<{ run: string }>("start", { mode, token });
  return { token, run };
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
    await sleep(25);
  }
}

const bytes = (text: string | null | undefined): number => Buffer.byteLength(text ?? "", "utf8");

describe("[A4.3.11.8.run.stop] on a real container, Stop ends the agent and everything it started, and the run is cancelled only once that is confirmed", () => {
  for (const [mode, alive] of [
    ["ignore-stop", 2],
    ["fork-late", 4],
    ["detach-stay", 3],
  ] as const) {
    test(`an agent that ${mode === "ignore-stop" ? "ignores the Stop" : mode === "fork-late" ? "starts children late" : "detached a child and a daemon"}`, async (ctx) => {
      need(ctx);
      const label = `stop-${mode}-${newToken()}`;
      const at = await bench(label);
      const service = await startService(label, at);
      try {
        const { token, run } = await startRun(service, mode);
        await waitForCensus(token, (pids) => pids.length >= alive);
        await waitFor(
          "running",
          () => read(service, run),
          (r) => r.state === "running",
        );
        if (mode === "detach-stay") {
          // Its first message comes once it listens for the interrupt.
          const files = new RunFiles(join(at.state, RUNS_FOLDER));
          await waitFor(
            "listening",
            () => files.readAnswer(run),
            (a) => a !== undefined,
          );
        }
        const stopped = await service.request<RunRecord>("stop", { run });
        expect(stopped.state).toBe("cancelling");
        const after = await ended(service, run);
        expect(after.state).toBe("cancelled");
        expect(census(token)).toEqual([]);
        // Nothing starts again after the Stop either.
        await sleep(300);
        expect(census(token)).toEqual([]);
        if (mode === "detach-stay") {
          // The agent got the interrupt and gave its answer before its container was ended.
          expect(after.result?.text).toBe("Stopped, with what was found so far.");
        }
      } finally {
        await service.close();
      }
    });
  }
});

describe("[A4.3.11.5.run.answer] on a real container, the answer is kept whole up to 1 MiB after 50 MB of other output, and cut with a flag beyond it", () => {
  test("a 1 MiB answer that escaping makes far longer, after 50 MB of other output", async (ctx) => {
    need(ctx);
    const label = `flood-${newToken()}`;
    const at = await bench(label);
    const service = await startService(label, at);
    try {
      const { token, run } = await startRun(service, "flood-answer");
      const after = await ended(service, run);
      expect(after.state).toBe("succeeded");
      const expected = '"\\\n\t'.repeat(MiB / 4);
      expect(bytes(after.result?.text)).toBe(MiB);
      expect(after.result?.text === expected).toBe(true);
      expect(after.result?.textCut).toBeUndefined();
      expect(after.result?.textFinal).toBe(true);
      expect(new RunFiles(join(at.state, RUNS_FOLDER)).readAnswer(run)?.text === expected).toBe(
        true,
      );
      expect(census(token)).toEqual([]);
    } finally {
      await service.close();
    }
  });

  test("an answer longer than 1 MiB is cut on a code point and flagged, and the run succeeds", async (ctx) => {
    need(ctx);
    const label = `huge-${newToken()}`;
    const service = await startService(label, await bench(label));
    try {
      const { token, run } = await startRun(service, "huge-answer");
      const after = await ended(service, run);
      expect(after.state).toBe("succeeded");
      const text = after.result?.text ?? "";
      expect(bytes(text)).toBeLessThanOrEqual(MiB);
      expect(bytes(text)).toBeGreaterThan(MiB - 3);
      expect(/^€+$/u.test(text)).toBe(true);
      expect(after.result?.textCut).toBe(true);
      expect(census(token)).toEqual([]);
    } finally {
      await service.close();
    }
  });
});

describe("[A4.3.11.9.run.crash] the service killed by force mid run and mid answer write leaves nothing running, and the next start ends each run with its last saved answer", () => {
  /** Kills the service, waits until what it ran is gone, and starts the next on the same space. */
  async function crashAndRestart(
    label: string,
    at: { space: LaunchSpaceFolder; state: string },
    service: Service,
    token: string,
  ): Promise<Service> {
    await service.crash();
    await waitForCensus(token, (pids) => pids.length === 0, 15_000);
    if (!windows) await waitUnitGone(`${UNIT_PREFIX}${label}.service`);
    return startService(label, at);
  }

  test("killed mid run: interrupted because Tasks restarted, with the last message", async (ctx) => {
    need(ctx);
    const label = `crash-${newToken()}`;
    const at = await bench(label);
    const files = new RunFiles(join(at.state, RUNS_FOLDER));
    const service = await startService(label, at);
    const { token, run } = await startRun(service, "talk");
    await waitFor(
      "answer saved",
      () => files.readAnswer(run),
      (a) => a !== undefined,
    );
    const next = await crashAndRestart(label, at, service, token);
    try {
      expect(await next.request("recover")).toEqual([{ id: run, state: "failed" }]);
      const after = await read(next, run);
      expect(after).toMatchObject({ state: "failed", reason: "service_ended" });
      expect(after.result?.text).toBe("Working on it.");
      expect(after.result?.textFinal).toBeUndefined();
      expect(census(token)).toEqual([]);
    } finally {
      await next.close();
    }
  });

  test("killed while answers are being saved: the record holds the last whole one", async (ctx) => {
    need(ctx);
    const label = `crash-write-${newToken()}`;
    const at = await bench(label);
    const files = new RunFiles(join(at.state, RUNS_FOLDER));
    const service = await startService(label, at);
    const { token, run } = await startRun(service, "answers");
    await waitFor(
      "answers being saved",
      () => files.readAnswer(run)?.text.slice(0, 8) ?? "",
      (n) => Number(n) >= 20,
    );
    const next = await crashAndRestart(label, at, service, token);
    try {
      await next.request("recover");
      const after = await read(next, run);
      expect(after).toMatchObject({ state: "failed", reason: "service_ended" });
      const text = after.result?.text ?? "";
      expect(bytes(text)).toBe(256 * 1024);
      expect(/^\d{8}a+$/u.test(text)).toBe(true);
      expect(text === files.readAnswer(run)?.text).toBe(true);
      expect(census(token)).toEqual([]);
    } finally {
      await next.close();
    }
  });
});
