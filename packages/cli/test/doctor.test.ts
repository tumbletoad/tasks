// `tasks doctor --self-test` with the service checks (A2 3.13, A7 3.8 M1.10): it works without a
// service, it tells an untrusted endpoint from a stopped service, and with a running service it
// reports its version, protocol and spaces, and recent crash files. Fixture text only.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { RpcError } from "@tasks/bridge/protocol";
import { endpointRoot, listen } from "@tasks/bridge/test/endpoint";
import { tempRoot } from "@tasks/service/test/harness";
import { CLI_SPEC } from "../src/args.ts";
import type { Session } from "../src/connect.ts";
import { requestCheck } from "../src/doctor.ts";
import { runMain, startWorld, type CliWorld } from "./cli-harness.ts";

interface Report {
  ok: boolean;
  checks: { id: string; status: string; detail: string }[];
}

const status = (report: Report, id: string) => report.checks.find((c) => c.id === id)?.status;

let world: CliWorld;
/** Linux: a stand-in systemd-run first on the service's PATH, so the scope probe starts no unit. */
let tools: ReturnType<typeof tempRoot> | undefined;
let probes = "";

beforeAll(async () => {
  let env: Record<string, string> | undefined;
  if (process.platform === "linux") {
    tools = tempRoot("dt");
    probes = join(tools.root, "probes.txt");
    const bin = join(tools.root, "bin");
    mkdirSync(bin, { mode: 0o700 });
    writeFileSync(join(bin, "systemd-run"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${probes}'\n`, {
      mode: 0o700,
    });
    env = { PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}` };
  }
  world = await startWorld("dr", env === undefined ? {} : { env });
}, 180_000);

afterAll(async () => {
  try {
    await world.close();
  } finally {
    tools?.cleanup();
  }
}, 120_000);

describe("[A2.3.13.cli.doctor] tasks doctor --self-test", () => {
  test("without a service: a failed service check, and the command still answers", async () => {
    const temp = tempRoot("dn");
    try {
      const ran = await runMain(["doctor", "--self-test", "--json"], {
        home: join(temp.root, "h"),
      });
      expect(ran.code).toBe(1);
      const report = JSON.parse(ran.stdout) as Report;
      expect(report.ok).toBe(false);
      expect(status(report, "service")).toBe("fail");
      expect(status(report, "sessions")).toBe("skip");
      const text = await runMain(["doctor"], { home: join(temp.root, "h") });
      expect(text.stdout).toMatch(/^fail {2}paths:/m);
    } finally {
      temp.cleanup();
    }
  });

  test("an endpoint that fails the handshake is untrusted, not stopped", async () => {
    const temp = tempRoot("du");
    const root = endpointRoot();
    const path = root.path("fake");
    // Removed whatever happens, a failed listen included.
    const fake = await listen(path, (socket) => {
      socket.write("not a challenge\n");
    }).catch((error: unknown) => {
      root.remove();
      temp.cleanup();
      throw error;
    });
    try {
      const home = join(temp.root, "h");
      const state = join(home, "state");
      mkdirSync(state, { recursive: true, mode: 0o700 });
      writeFileSync(join(state, "ipc.key"), randomBytes(32).toString("base64url"));
      writeFileSync(
        join(state, "service.json"),
        JSON.stringify({ state: "ready", pid: process.pid, endpoint: { kind: "unix", path } }),
      );
      const ran = await runMain(["doctor", "--self-test", "--json"], { home });
      const report = JSON.parse(ran.stdout) as Report;
      expect(status(report, "endpoint")).toBe("fail");
      expect(report.checks.find((c) => c.id === "endpoint")?.detail).toContain(
        "failed the handshake",
      );
    } finally {
      await fake.close();
      root.remove();
      temp.cleanup();
    }
  });

  test("a running service: version, protocol, spaces and recent crash files", async () => {
    const ok = await runMain(["doctor", "--self-test", "--json"], { home: world.home });
    const report = JSON.parse(ok.stdout) as Report;
    expect(ok.code, ok.stdout).toBe(0);
    expect(status(report, "service")).toBe("ok");
    expect(status(report, "endpoint")).toBe("ok");
    expect(status(report, "spaces")).toBe("ok");
    expect(report.checks.find((c) => c.id === "spaces")?.detail).toContain("Mira: open");
    expect(status(report, "requests")).toBe("ok");
    expect(report.checks.find((c) => c.id === "requests")?.detail).toContain("for 1 space(s)");
    // The launch rows and the sessions row come from the running service (A3 3.14); none fails
    // the report, and a service with no agent connection has nothing shared or dropped.
    for (const id of ["launch.scopes", "launch.terminal", "launch.env", "launch.t3", "sessions"]) {
      expect([id, status(report, id)]).not.toEqual([id, undefined]);
      expect([id, status(report, id)]).not.toEqual([id, "fail"]);
    }
    expect(status(report, "sessions")).toBe("ok");
    expect(status(report, "launch.t3")).toBe("skip");
    // The service's own launch service answers them: its environment's check, and on Linux the
    // scope probe a terminal launch runs (here the stand-in systemd-run, which exits 0).
    const env = report.checks.find((c) => c.id === "launch.env");
    expect(env?.detail).not.toContain("fixed environment");
    if (process.platform === "win32") expect(["ok", "warn"]).toContain(env?.status);
    else expect(env?.detail).toContain("No launch has read your login shell's environment yet");
    if (process.platform === "linux") {
      expect(status(report, "launch.scopes")).toBe("ok");
      expect(readFileSync(probes, "utf8")).toMatch(/^--user --scope .* -- \S+$/m);
    } else expect(status(report, "launch.scopes")).toBe("skip");

    // A service whose status answers while its operations fail does not pass.
    const broken = await runMain(["doctor", "--self-test", "--json"], {
      home: world.home,
      main: {
        wrap: (session) => ({
          bound: session.bound,
          close: () => {
            session.close();
          },
          call: (...args: Parameters<typeof session.call>) =>
            args[0] === "op/call"
              ? Promise.reject(new RpcError(-32603, "Internal error"))
              : session.call(...args),
        }),
      },
    });
    expect(broken.code).toBe(1);
    expect(status(JSON.parse(broken.stdout) as Report, "requests")).toBe("fail");

    writeFileSync(
      join(world.home, "state", "crash", "20261112T080000Z-1.json"),
      JSON.stringify({ event: "service.crash" }),
    );
    const crashed = JSON.parse(
      (await runMain(["doctor", "--json"], { home: world.home })).stdout,
    ) as Report;
    expect(status(crashed, "crashes")).toBe("warn");
    expect(crashed.checks.find((c) => c.id === "crashes")?.detail).toContain("service.crash 1");
  }, 120_000);

  test("the request check never passes without asking, and fails when op/call fails", async () => {
    const entries = { entries: CLI_SPEC.verbs.map((verb) => ({ name: verb.entry })) };
    const asked: unknown[] = [];
    const session = (opCall: () => Promise<unknown>): Session => ({
      bound: { spaces: [] } as unknown as Session["bound"],
      close: () => undefined,
      call: (method: string, params?: Record<string, unknown>) => {
        if (method === "op/list") return Promise.resolve(entries);
        asked.push(params?.["space"]);
        return opCall();
      },
    });
    const answers = () => Promise.resolve({});
    const notServed = () =>
      Promise.reject(
        new RpcError(-32000, "x", { code: "space_unavailable", message: "Not served." }),
      );
    const broken = () => Promise.reject(new RpcError(-32603, "Internal error"));
    const open = (entry: number, id: string) => ({ entry, id, state: "open" });

    // A copy beside its original: both share the ID, which names one copy (A2 3.10.5), so the
    // space is asked once, and a failure there fails the check.
    const shared = await requestCheck(session(broken), [open(0, "sp_a"), open(1, "sp_a")]);
    expect(shared.status).toBe("fail");
    expect(asked).toEqual(["sp_a"]);
    asked.length = 0;
    const both = await requestCheck(session(answers), [
      open(0, "sp_a"),
      open(1, "sp_a"),
      open(2, "sp_b"),
    ]);
    expect(both.status).toBe("ok");
    expect(both.detail).toContain("for 2 space(s)");
    expect(asked).toEqual(["sp_a", "sp_b"]);
    expect((await requestCheck(session(broken), [open(2, "sp_b")])).status).toBe("fail");
    // No space served: op/call must still answer with A3's body.
    expect((await requestCheck(session(notServed), [])).status).toBe("ok");
    expect((await requestCheck(session(broken), [])).status).toBe("fail");
  });

  test.skipIf(process.platform !== "win32")(
    "tasksw's give-up record is reported only when it is newer than the service's start",
    async () => {
      const record = join(world.home, "state", "crash", "supervisor-gave-up.json");
      writeFileSync(record, JSON.stringify({ t: "2000-01-01T00:00:00.000Z" }));
      const old = JSON.parse(
        (await runMain(["doctor", "--json"], { home: world.home })).stdout,
      ) as Report;
      expect(status(old, "supervisor")).toBe("ok");
      expect(old.checks.find((c) => c.id === "crashes")?.detail).not.toContain("report");
      writeFileSync(record, JSON.stringify({ t: new Date(Date.now() + 60_000).toISOString() }));
      const fresh = JSON.parse(
        (await runMain(["doctor", "--json"], { home: world.home })).stdout,
      ) as Report;
      expect(status(fresh, "supervisor")).toBe("warn");
    },
    120_000,
  );
});
