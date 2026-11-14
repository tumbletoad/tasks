// `tasks setup t3` (A4 3.4.1 "Pairing", A7 3.9 M2.11): the CLI hands T3's approval page to the
// browser, the service runs the OAuth flow against a fake T3 and keeps the token in machine state:
// a 0600 file in a 0700 folder, and nowhere else (not machine.toml, the log, service.json or any
// answer). Only the user pairs. A real service in this process, the CLI in this process with an
// injected browser, a fake T3 on a loopback port the OS assigns, fixture data and a temporary
// folder only; nothing reaches a real T3.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FakeT3 } from "@tasks/testkit/fake-t3";
import { startService, type RunningService } from "@tasks/service/hub";
import {
  removeRuntimeDir,
  serviceEnv,
  stateOf,
  tempRoot,
  waitFor,
} from "@tasks/service/test/harness";
import { classSession } from "@tasks/service/test/ops-helpers";
import { runMain } from "./cli-harness.ts";

const SLOW = 120_000;
let service: RunningService;
let fake: FakeT3;
let home: string;
let cleanup: () => void;
const browsed: string[] = [];

beforeAll(async () => {
  const temp = tempRoot("t3");
  cleanup = temp.cleanup;
  home = join(temp.root, "h");
  fake = await FakeT3.start(join(temp.root, "t3home"));
  service = await startService({
    env: serviceEnv(home, { T3CODE_HOME: fake.home }),
    identity: () => ({ root: false, elevated: false, package: null }),
    maintenance: false,
    say: () => undefined,
  });
}, SLOW);

afterAll(async () => {
  await service.stop();
  removeRuntimeDir(service);
  await fake.stop();
  cleanup();
}, SLOW);

/** `tasks <argv>` as a person at a terminal (tty) or a script, with the fake as the browser. */
const run = (argv: string[], tty = true) =>
  runMain(argv, {
    home,
    tty,
    main: {
      openUrl: async (url) => {
        browsed.push(url);
        return (await fake.approveInBrowser(url)) === 200;
      },
    },
  });

/** Every regular file under `dir`. */
function filesBelow(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesBelow(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

const pairingFile = () => join(stateOf(home), "t3", "pairing.json");
const pairing = () => JSON.parse(readFileSync(pairingFile(), "utf8")) as Record<string, unknown>;

describe("[A4.3.4.1.t3.setup] tasks setup t3 through the service", () => {
  test(
    "only the user pairs; the token lives in one user-only file of machine state",
    async () => {
      const script = await run(["setup", "t3", "--json"], false);
      expect(script.code).toBe(5);
      // The method table refuses a script's connection before the handler, which checks again.
      expect(JSON.parse(script.stdout)).toMatchObject({
        error: { code: "forbidden", data: { reason: "connection_class", class: "cli-script" } },
      });
      expect(browsed).toHaveLength(0);

      expect(JSON.parse((await run(["setup", "t3", "--status", "--json"], false)).stdout)).toEqual({
        state: "not_paired",
        message: "Pair TT Tasks with T3 Code first: tasks setup t3",
      });

      const paired = await run(["setup", "t3", "--json"]);
      expect(paired.code, paired.stderr).toBe(0);
      expect(JSON.parse(paired.stdout)).toMatchObject({ paired: true, replaced: false });
      expect(browsed).toHaveLength(1);
      // The page: T3's authorization endpoint with the attempt's S256 challenge and state.
      const page = new URL(browsed[0] ?? "");
      expect(page.origin).toBe(fake.origin);
      expect(page.searchParams.get("code_challenge_method")).toBe("S256");
      expect(paired.stderr).toContain(page.href);

      const first = pairing();
      const token = String(first["accessToken"]);
      const refresh = String(first["refreshToken"]);
      expect(token).toMatch(/^fake-at-/u);
      expect(first["grant"]).toMatch(/^t3g-/u);
      if (process.platform !== "win32") {
        expect(statSync(pairingFile()).mode & 0o777).toBe(0o600);
        expect(statSync(join(stateOf(home), "t3")).mode & 0o777).toBe(0o700);
      }
      // Nowhere else: no other file of the install, no output, no URL Tasks made.
      for (const file of filesBelow(home)) {
        if (file === pairingFile()) continue;
        const text = readFileSync(file, "latin1");
        expect(text.includes(token) || text.includes(refresh), file).toBe(false);
      }
      for (const text of [paired.stdout, paired.stderr, ...browsed]) {
        expect(text).not.toContain(token);
        expect(text).not.toContain(refresh);
      }
      const log = readFileSync(join(stateOf(home), "logs", "service.log"), "utf8");
      expect(log).toContain('"setup.paired"');

      const status = await run(["setup", "t3", "--status", "--json"], false);
      expect(JSON.parse(status.stdout)).toMatchObject({
        state: "ready",
        message: "Paired with T3 Code.",
      });
      expect(status.stdout).not.toContain(token);
    },
    SLOW,
  );

  test(
    "pairing again replaces the pairing under a new grant; a refusal or a stopped T3 keeps it",
    async () => {
      const before = pairing();
      const again = await run(["setup", "t3"]);
      expect(again.code, again.stderr).toBe(0);
      expect(again.stdout).toContain("Paired with T3 Code.");
      expect(again.stdout).toContain("This replaced the earlier pairing.");
      const after = pairing();
      expect(after["grant"]).not.toBe(before["grant"]);
      expect(after["accessToken"]).not.toBe(before["accessToken"]);

      fake.approval = "deny";
      const denied = await run(["setup", "t3", "--json"]);
      expect(denied.code).toBe(5);
      expect(JSON.parse(denied.stdout)).toMatchObject({
        error: { code: "forbidden", data: { reason: "denied" } },
      });
      expect(pairing()["grant"]).toBe(after["grant"]);
      fake.approval = "approve";

      await fake.stop();
      const stopped = await run(["setup", "t3", "--json"]);
      expect(stopped.code).toBe(2);
      expect(JSON.parse(stopped.stdout)).toMatchObject({
        error: { code: "invalid_input", data: { reason: "t3_not_running" } },
      });
      expect(JSON.parse((await run(["setup", "t3", "--status", "--json"])).stdout)).toMatchObject({
        state: "not_running",
        message: "Start T3 Code",
      });
      await fake.restart();
      expect(pairing()["grant"]).toBe(after["grant"]);
    },
    SLOW,
  );

  test(
    "an approval is kept when T3 answers, even when nothing waits for it any more",
    async () => {
      const before = pairing()["grant"];
      const user = await classSession(home, service.endpoint.path, "cli-interactive");
      try {
        const started = (await user.call("t3/pair", {}, { timeoutMs: 30_000 })) as {
          url: string;
        };
        // The CLI went away: nobody calls t3/pair_wait. The person approves anyway.
        expect(await fake.approveInBrowser(started.url)).toBe(200);
        await waitFor(
          () => (pairing()["grant"] !== before ? true : undefined),
          30_000,
          "the new pairing",
        );
      } finally {
        user.close();
      }
    },
    SLOW,
  );
  test(
    "two pairings started at once leave one attempt: the older is cancelled before it hands out a page",
    async () => {
      const before = pairing()["grant"];
      const one = await classSession(home, service.endpoint.path, "cli-interactive");
      const two = await classSession(home, service.endpoint.path, "cli-interactive");
      let open!: () => void;
      fake.registrationGate = new Promise((resolve) => {
        open = resolve;
      });
      try {
        // Both calls are past their start before either attempt is set up.
        const calls = [one, two].map(
          (session) =>
            session.call("t3/pair", {}, { timeoutMs: 30_000 }) as Promise<{ url: string }>,
        );
        await waitFor(
          () => (fake.registrationsWaiting === 2 ? true : undefined),
          30_000,
          "both registrations",
        );
        open();
        const settled = await Promise.allSettled(calls);
        const started = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
        const cancelled = settled.flatMap((s): unknown[] =>
          s.status === "rejected" ? [s.reason as unknown] : [],
        );
        expect(started).toHaveLength(1);
        expect(cancelled).toHaveLength(1);
        expect(cancelled[0]).toMatchObject({
          data: { code: "conflict", data: { reason: "cancelled" } },
        });
        // The older attempt was set up (registered) and closed again; the newer one pairs.
        expect(fake.registrations.length).toBeGreaterThanOrEqual(2);
        expect(await fake.approveInBrowser(started[0]?.url ?? "")).toBe(200);
        await waitFor(
          () => (pairing()["grant"] !== before ? true : undefined),
          30_000,
          "the new pairing",
        );
      } finally {
        fake.registrationGate = undefined;
        open();
        one.close();
        two.close();
      }
    },
    SLOW,
  );

  test("--help prints the help and runs nothing; a wrong option is a usage error", async () => {
    for (const args of [
      ["setup", "t3", "--help"],
      ["help", "setup"],
    ]) {
      const ran = await run(args);
      expect(ran.code).toBe(0);
      expect(ran.stdout).toMatch(/^Usage: tasks setup/u);
    }
    expect((await run(["setup", "t3", "--force"])).code).toBe(2);
    expect((await run(["setup", "codex"])).code).toBe(2);
  });
});
