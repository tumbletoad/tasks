// The cross-user cases of A2 5 for the UI's port, with a real second account (A7 3.9 M2.12: "On
// Linux CI with a second account holding the port: no UI, every UI token revoked, the socket still
// working"). AGENTS.md: such tests run only on throwaway CI runners, where the test creates the
// extra user itself, and never on a developer's machines. So they run only on a GitHub-hosted Linux
// runner (GITHUB_ACTIONS and RUNNER_ENVIRONMENT=github-hosted), where `sudo -n` works; anywhere
// else they are skipped. The same cases run everywhere with injected identities (http.test.ts).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { ServiceDb } from "../src/http/index.ts";
import { send } from "./http-client.ts";
import { httpWorld, persistPort, signIn, type HttpWorld } from "./http-world.ts";
import { stateOf } from "./harness.ts";

const RUNNER =
  process.platform === "linux" &&
  process.env["GITHUB_ACTIONS"] === "true" &&
  process.env["RUNNER_ENVIRONMENT"] === "github-hosted";
const OTHER = "tasksb";
const SLOW = { timeout: 180_000 };

const worlds: HttpWorld[] = [];
const holders: ChildProcess[] = [];
afterEach(async () => {
  for (const child of holders.splice(0)) child.stdin?.end();
  for (const w of worlds.splice(0)) await w.close();
});

beforeAll(() => {
  if (!RUNNER) return;
  // The throwaway runner's second account, made by the test itself. No home, no login shell.
  spawnSync("sudo", ["-n", "useradd", "-M", "-s", "/usr/sbin/nologin", OTHER], { stdio: "ignore" });
});
afterAll(() => {
  if (!RUNNER) return;
  spawnSync("sudo", ["-n", "userdel", OTHER], { stdio: "ignore" });
});

/** Runs Python as the other account; resolves with its first line of output. */
function asOther(script: string): { child: ChildProcess; line: Promise<string> } {
  const child = spawn("sudo", ["-n", "-u", OTHER, "python3", "-c", script], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  holders.push(child);
  const line = new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      out += chunk;
      if (out.includes("\n")) resolve(out.split("\n")[0] ?? "");
    });
    child.once("error", reject);
    child.once("exit", () => {
      resolve(out.split("\n")[0] ?? "");
    });
  });
  return { child, line };
}

describe("[A2.3.8.http.cross-user] another account on the UI's port (CI runners only)", () => {
  test.runIf(RUNNER)(
    "another account holds the persisted port: no UI, every UI token revoked, the socket still working",
    SLOW,
    async () => {
      const w = await httpWorld("xu");
      worlds.push(w);
      const { token } = await signIn(w);
      const port = w.port();
      persistPort(w.home, port);
      await w.stop();
      // The other account binds the port while Tasks is stopped, and keeps it until stdin closes.
      const holder = asOther(
        "import socket, sys\n" +
          "s = socket.socket()\n" +
          `s.bind(("127.0.0.1", ${String(port)}))\n` +
          "s.listen()\n" +
          "print('listening', flush=True)\n" +
          "sys.stdin.read()\n",
      );
      expect(await holder.line).toBe("listening");
      // The real holder check of this OS (holders.ts), no injected identity.
      const service = await w.restart({});
      expect(service.status().http).toMatchObject({ port, blocked: "foreign_port_holder" });
      expect(service.http?.app.options.grants.findByToken(token)).toBeUndefined();
      const user = await w.user();
      expect(await user.call("service/status", {})).toHaveProperty(
        "http.blocked",
        "foreign_port_holder",
      );
      await w.stop();
      const db = await ServiceDb.open(stateOf(w.home));
      try {
        const seen = await db.observations(port);
        expect(seen.length).toBeGreaterThan(0);
        expect(seen[0]?.owner).toMatch(/^\d+$/);
      } finally {
        await db.close();
      }
    },
  );

  test.runIf(RUNNER)(
    "another account's connection to the UI port is closed before any byte is read or answered",
    SLOW,
    async () => {
      const w = await httpWorld("xp", {}, { space: false });
      worlds.push(w);
      const port = w.port();
      const probe = asOther(
        "import socket\n" +
          `s = socket.create_connection(("127.0.0.1", ${String(port)}))\n` +
          `s.sendall(b"GET /healthz HTTP/1.1\\r\\nHost: 127.0.0.1:${String(port)}\\r\\n\\r\\n")\n` +
          "try:\n" +
          "    data = s.recv(100)\n" +
          "except ConnectionResetError:\n" +
          "    data = b''\n" +
          "print('closed' if data == b'' else 'answered', flush=True)\n",
      );
      expect(await probe.line).toBe("closed");
      // This user's own connection is still answered.
      expect((await send(port, { path: "/healthz" })).body).toBe("ok");
    },
  );
});
