// Run containers on a real container: a cgroup of a delegated systemd user unit on Linux, a job
// object held by tasks-run.exe on Windows. Each test starts stand-in agents (stand-ins/) through
// a stand-in service (stand-ins/harness.ts) and counts what is alive from the operating system,
// never from the container. Where no real container can be made, the tests say so and skip: a
// fake would prove nothing.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, test, type TestContext } from "vitest";
import {
  jobName,
  WindowsContainers,
  type AgentExit,
  type Confirmation,
} from "../src/container/index.ts";
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

let work = "";
let place: Where = { ok: false, reason: "not prepared" };
let natives: Natives | undefined;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "tasks-container-"));
  if (windows) {
    natives = buildNatives(join(work, "bin"));
    place = { ok: true };
  } else if (process.platform === "linux") {
    place = userUnits();
  } else {
    place = { ok: false, reason: "runs are contained on Linux and Windows only" };
  }
}, 300_000);

afterAll(() => {
  if (process.platform === "linux" && place.ok) stopTestUnits();
  if (work !== "") rmSync(work, { recursive: true, force: true });
});

function need(ctx: TestContext): void {
  if (!place.ok) ctx.skip(place.reason);
}

/** A new stand-in service: in its own user unit `tasks-test-container-<label>` on Linux. */
function startService(label: string): Promise<Service> {
  if (windows) return Service.plain(natives?.helper ?? "");
  return Service.inUnit(`${UNIT_PREFIX}${label}.service`, work);
}

interface Output {
  bytes: number;
  head: string;
  ended: boolean;
}

async function waitFor<T>(what: string, read: () => Promise<T>, ok: (value: T) => boolean) {
  const deadline = performance.now() + 15_000;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (performance.now() >= deadline) throw new Error(`${what}: never true`);
    await sleep(25);
  }
}

const output = (service: Service, name: string) => service.request<Output>("output", { name });

/** Starts a stand-in in a fresh container. */
async function start(service: Service, mode: StandInMode, args: string[] = []) {
  const token = newToken();
  const name = `t-${token}`;
  await service.request("start", { name, mode, token, ...(args.length > 0 ? { args } : {}) });
  return { token, name };
}

const EMPTY: Confirmation = { state: "empty" };

/** Kills the container and proves it empty, by its own confirmation and by the census. */
async function killAndConfirm(service: Service, name: string, token: string) {
  await service.request("kill", { name });
  const confirmed = await service.request<Confirmation>("confirm", { name, waitMs: 10_000 });
  expect(confirmed).toEqual(EMPTY);
  expect(census(token)).toEqual([]);
}

describe("[A4.3.11.8.container.kill] after kill nothing a stand-in agent started is left, and confirmEmpty says empty only when it is", () => {
  let service: Service | undefined;
  const get = () => {
    if (service === undefined) throw new Error("no service");
    return service;
  };

  beforeAll(async () => {
    if (place.ok) service = await startService(`kill-${newToken()}`);
  }, 60_000);

  afterAll(async () => {
    await service?.close();
  });

  test("an agent that behaves: stopped while it runs", async (ctx) => {
    need(ctx);
    const { token, name } = await start(get(), "behave");
    await waitForCensus(token, (pids) => pids.length === 1);
    expect(await get().request<Confirmation>("confirm", { name })).toMatchObject({
      state: "occupied",
    });
    await killAndConfirm(get(), name, token);
  });

  test("an agent that keeps starting children after a while", async (ctx) => {
    need(ctx);
    const { token, name } = await start(get(), "fork-late");
    await waitForCensus(token, (pids) => pids.length >= 4);
    await killAndConfirm(get(), name, token);
    // Nothing forks after the kill either.
    await sleep(300);
    expect(census(token)).toEqual([]);
  });

  test("an agent that detaches and daemonises its children, then exits", async (ctx) => {
    need(ctx);
    const { token, name } = await start(get(), "detach");
    const exit = await get().request<AgentExit>("exited", { name });
    expect(exit.code).toBe(0);
    // The agent is gone and its detached child and daemonised grandchild live on.
    await waitForCensus(token, (pids) => pids.length === 2);
    expect(await get().request<Confirmation>("confirm", { name })).toMatchObject({
      state: "occupied",
    });
    await killAndConfirm(get(), name, token);
  });

  test("an agent and its child that ignore the interrupt", async (ctx) => {
    need(ctx);
    const { token, name } = await start(get(), "ignore-stop");
    await waitForCensus(token, (pids) => pids.length === 2);
    await waitFor(
      "ready",
      () => output(get(), name),
      (o) => o.head.includes("ready"),
    );
    expect(await get().request<{ delivered: boolean }>("interrupt", { name })).toEqual({
      delivered: true,
    });
    await waitFor(
      "ignored",
      () => output(get(), name),
      (o) => o.head.includes("ignored"),
    );
    await sleep(300);
    expect(census(token)).toHaveLength(2);
    await killAndConfirm(get(), name, token);
  });

  test("an agent whose child holds its output pipe after it exited", async (ctx) => {
    need(ctx);
    const { token, name } = await start(get(), "hold-pipe");
    expect((await get().request<AgentExit>("exited", { name })).code).toBe(0);
    await waitForCensus(token, (pids) => pids.length === 1);
    expect((await output(get(), name)).ended).toBe(false);
    expect(await get().request<Confirmation>("confirm", { name })).toMatchObject({
      state: "occupied",
    });
    await killAndConfirm(get(), name, token);
    await waitFor(
      "end of output",
      () => output(get(), name),
      (o) => o.ended,
    );
  });

  test("an agent that floods its output", async (ctx) => {
    need(ctx);
    const { token, name } = await start(get(), "flood");
    await waitFor(
      "5 MB of output",
      () => output(get(), name),
      (o) => o.bytes >= 5 * 1024 * 1024,
    );
    await killAndConfirm(get(), name, token);
  });

  test("an agent that dies: its container is empty by itself", async (ctx) => {
    need(ctx);
    const { token, name } = await start(get(), "die");
    expect((await get().request<AgentExit>("exited", { name })).code).toBe(3);
    expect(await get().request<Confirmation>("confirm", { name, waitMs: 10_000 })).toEqual(EMPTY);
    expect(census(token)).toEqual([]);
  });
});

describe("[A4.3.11.8.container.interrupt] an interrupt reaches the agent, which may stop by itself; it ends nothing on its own", () => {
  test("an agent that behaves prints its last words and exits on the interrupt", async (ctx) => {
    need(ctx);
    const service = await startService(`interrupt-${newToken()}`);
    try {
      const { token, name } = await start(service, "behave");
      await waitFor(
        "ready",
        () => output(service, name),
        (o) => o.head.includes("ready"),
      );
      expect(await service.request("interrupt", { name })).toEqual({ delivered: true });
      expect((await service.request<AgentExit>("exited", { name })).code).toBe(0);
      expect((await output(service, name)).head).toContain("interrupted");
      expect(await service.request("confirm", { name, waitMs: 10_000 })).toEqual(EMPTY);
      expect(census(token)).toEqual([]);
    } finally {
      await service.close();
    }
  });
});

describe("[A4.3.11.8.container.crash] killing the service by force leaves nothing of its runs, and recover confirms each container empty", () => {
  test("the service killed by force with three runs, then recovered by name", async (ctx) => {
    need(ctx);
    const label = `crash-${newToken()}`;
    const service = await startService(label);
    const runs = [
      await start(service, "ignore-stop"),
      await start(service, "detach"),
      await start(service, "fork-late"),
    ];
    const [ignoring, detaching, forking] = runs;
    if (ignoring === undefined || detaching === undefined || forking === undefined) return;
    await waitForCensus(ignoring.token, (pids) => pids.length === 2);
    await waitForCensus(detaching.token, (pids) => pids.length === 2);
    await waitForCensus(forking.token, (pids) => pids.length >= 3);

    await service.crash();
    for (const run of runs) await waitForCensus(run.token, (pids) => pids.length === 0, 10_000);

    if (windows) {
      const fresh = new WindowsContainers({ helper: natives?.helper ?? "" });
      for (const run of runs) expect(await fresh.recover(run.name)).toEqual(EMPTY);
    } else {
      // The next service runs in the same unit, so it finds the same cgroup paths.
      const unit = `${UNIT_PREFIX}${label}.service`;
      await waitUnitGone(unit);
      const next = await startService(label);
      try {
        for (const run of runs)
          expect(await next.request("recover", { name: run.name })).toEqual(EMPTY);
      } finally {
        await next.close();
      }
    }
    for (const run of runs) expect(census(run.token)).toEqual([]);
  });

  test("a service that lost its records recovers a live container from its name alone", async (ctx) => {
    need(ctx);
    const service = await startService(`forget-${newToken()}`);
    try {
      const { token, name } = await start(service, "ignore-stop");
      await waitForCensus(token, (pids) => pids.length === 2);
      await service.request("forget");
      expect(await service.request("confirm", { name })).toMatchObject({ state: "occupied" });
      expect(await service.request("recover", { name })).toEqual(EMPTY);
      expect(census(token)).toEqual([]);
    } finally {
      await service.close();
    }
  });

  test("Windows: a job handle held elsewhere keeps the run alive past the crash; confirm says so and recover ends it", async (ctx) => {
    if (!windows) ctx.skip("job handles exist on Windows only");
    need(ctx);
    const service = await startService(`hold-${newToken()}`);
    const { token, name } = await start(service, "ignore-stop");
    await waitForCensus(token, (pids) => pids.length === 2);
    const hold = spawn(natives?.jobhold ?? "", [jobName(name)], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        hold.stdout.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("held")) resolve();
          else reject(new Error(chunk.toString()));
        });
      });
      await service.crash();
      await sleep(500);
      expect(census(token)).toHaveLength(2);
      const fresh = new WindowsContainers({ helper: natives?.helper ?? "" });
      expect(await fresh.confirmEmpty(name)).toMatchObject({ state: "occupied" });
      expect(await fresh.recover(name)).toEqual(EMPTY);
      expect(census(token)).toEqual([]);
    } finally {
      hold.stdin.end();
    }
  });
});

describe("[A4.3.11.8.container.start] the agent starts in its container with its arguments as given and no handle of the service", () => {
  test("hostile arguments arrive unchanged", async (ctx) => {
    need(ctx);
    const args = [
      "",
      "plain",
      "with space",
      'a"quote',
      "back\\slash",
      "trailing\\",
      'both\\"',
      "\\\\server\\share\\",
      "tab\there",
      "new\nline",
      "%PATH%",
      "^&|<>",
      "$HOME `id` $(id)",
      "ü 日本 🙂",
    ];
    const service = await startService(`argv-${newToken()}`);
    try {
      const { name } = await start(service, "argv", args);
      expect((await service.request<AgentExit>("exited", { name })).code).toBe(0);
      const said = await waitFor(
        "output",
        () => output(service, name),
        (o) => o.ended,
      );
      expect(JSON.parse(said.head) as unknown).toEqual(args);
    } finally {
      await service.close();
    }
  });

  test("the agent holds none of the service's control pipes", async (ctx) => {
    need(ctx);
    const service = await startService(`handles-${newToken()}`);
    try {
      const { token, name } = await start(service, "handles");
      const said = await waitFor(
        "output",
        () => output(service, name),
        (o) => o.head !== "",
      );
      expect(said.head.trim()).toBe("fd3 closed fd4 closed");
      await killAndConfirm(service, name, token);
    } finally {
      await service.close();
    }
  });

  test("a name in use is refused, and the running container is untouched", async (ctx) => {
    need(ctx);
    const service = await startService(`taken-${newToken()}`);
    try {
      const { token, name } = await start(service, "behave");
      const again = () => service.request("start", { name, mode: "behave", token: newToken() });
      await expect(again()).rejects.toMatchObject({ code: "exists" });
      // Also when the service no longer knows it: the operating system refuses the name.
      await service.request("forget");
      await expect(again()).rejects.toMatchObject({ code: "exists" });
      await waitForCensus(token, (pids) => pids.length === 1);
      expect(await service.request("recover", { name })).toEqual(EMPTY);
      expect(census(token)).toEqual([]);
    } finally {
      await service.close();
    }
  });

  test("the probe creates, kills and confirms a container where runs can be contained", async (ctx) => {
    need(ctx);
    const service = await startService(`probe-${newToken()}`);
    try {
      expect(await service.request("probe")).toEqual({
        available: true,
        kind: windows ? "job" : "cgroup",
      });
    } finally {
      await service.close();
    }
  });
});
