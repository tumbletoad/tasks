// `ttasks open` with the fragment code (A2 3.8.4, 3.9) and `ttasks service port` (A2 3.8.2 step 5),
// against a real service: the code is minted over the socket, the listener is proved by its HMAC
// before the port is trusted, the URL carries the code in its fragment only, and a browser (a
// Node client sending what a browser sends) redeems it once. A blocked UI prints A2's message, a
// moved port its line, and an agent's shell is told to ask the user. No browser is opened: the
// opener is recorded.
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { blockedMessage, movedMessage } from "@ttasks/service/http/shared";
import { post, send } from "@ttasks/service/test/http-client";
import { httpWorld, persistPort, type HttpWorld } from "@ttasks/service/test/http-world";
import { selfTest } from "../src/doctor-http.ts";
import { probeListener, StartFailed } from "../src/open.ts";
import { runMain } from "./cli-harness.ts";

const SLOW = { timeout: 180_000 };
const worlds: HttpWorld[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
  for (const s of servers.splice(0)) await new Promise((resolve) => s.close(resolve));
});

async function world(...args: Parameters<typeof httpWorld>): Promise<HttpWorld> {
  const w = await httpWorld(...args);
  worlds.push(w);
  return w;
}

const URL_SHAPE = /^http:\/\/127\.0\.0\.1:(\d+)\/#k=([A-Za-z0-9_-]{43})(?:&to=([^&\s]+))?$/;

describe("[A2.3.9.cli.open] ttasks open", () => {
  test(
    "--print-url: a one-time code in the fragment, after the listener proved itself; a browser redeems it once",
    SLOW,
    async () => {
      const w = await world("oa");
      const ran = await runMain(["open", "--print-url"], { home: w.home, tty: true });
      expect(ran.code).toBe(0);
      expect(ran.stderr).toContain("one-time sign-in code");
      const match = URL_SHAPE.exec(ran.stdout.trim());
      expect(match).not.toBeNull();
      const port = Number(match?.[1]);
      const code = match?.[2] ?? "";
      expect(port).toBe(w.port());
      // The browser: the shell, then the redemption, then the feed's ticket.
      const shell = await send(port, { path: "/" });
      expect(shell.status).toBe(200);
      const redeemed = await post(port, "/api/v1/auth/redeem", { code });
      expect(redeemed.status).toBe(200);
      const { token } = JSON.parse(redeemed.body) as { token: string };
      expect((await post(port, "/api/v1/ws-ticket", {}, { token })).status).toBe(200);
      expect((await post(port, "/api/v1/auth/redeem", { code })).status).toBe(401);
    },
  );

  test("the opener gets the URL; --space and --task become the tab's route", SLOW, async () => {
    const w = await world("ob");
    const opened: string[] = [];
    const openUrl = (url: string) => {
      opened.push(url);
      return Promise.resolve(true);
    };
    const ran = await runMain(["open", "--space", "Mira", "--task", "M-1"], {
      home: w.home,
      tty: true,
      main: { openUrl },
    });
    expect(ran.code).toBe(0);
    expect(ran.stdout).toBe("Opened TTasks in the browser.\n");
    // The code is never printed when the browser is opened.
    expect(ran.stdout + ran.stderr).not.toMatch(/#k=/);
    const match = URL_SHAPE.exec(opened[0] ?? "");
    const to = decodeURIComponent(match?.[3] ?? "");
    expect(to).toMatch(/^\/s\/sp_[0-9a-z]{26}\/task\/M-1$/);
    // A folder no space of the service is in opens nothing.
    const refused = await runMain(["open", "--space", join(w.root, "s", "mira-copy")], {
      home: w.home,
      tty: true,
      main: { openUrl },
    });
    expect(refused.code).toBe(3);
    expect(refused.stderr).toContain("The service has no space in that folder.");
    expect(opened).toHaveLength(1);
    const json = await runMain(["open", "--json"], { home: w.home, tty: true, main: { openUrl } });
    expect(JSON.parse(json.stdout)).toEqual({ opened: true, port: w.port(), moved: false });
    const failed = await runMain(["open"], {
      home: w.home,
      tty: true,
      main: { openUrl: () => Promise.resolve(false) },
    });
    expect(failed.code).toBe(6);
    expect(failed.stderr).toContain("--print-url");
  });

  test("a space that names no space, or two, opens nothing and lists the spaces there are", SLOW, async () => {
    const w = await world("od");
    const opened: string[] = [];
    const openUrl = (url: string) => {
      opened.push(url);
      return Promise.resolve(true);
    };
    const open = (args: string[], env: Record<string, string> = {}) =>
      runMain(["open", ...args], { home: w.home, tty: true, env, main: { openUrl } });

    const typo = await open(["--space", "Mra"]);
    expect(typo.code).toBe(3);
    expect(typo.stderr).toContain("The service has no space by that ID or name.");
    expect(typo.stderr).toMatch(/\n {2}Mira {2}sp_[0-9a-z]{26} {2}\S/);
    const fromEnv = await open([], { TTASKS_SPACE: "Mra" });
    expect(fromEnv.code).toBe(3);

    const user = await w.user();
    const other = (await user.call(
      "space/create",
      { name: "mira", path: join(w.root, "s", "mira-two"), ref_prefix: "N" },
      { timeoutMs: 120_000 },
    )) as { space: { id: string } };
    const two = await open(["--space", "Mira", "--task", "M-1"]);
    expect(two.code).toBe(3);
    expect(two.stderr).toContain("Several spaces have this name.");
    expect(two.stderr).toContain(`  mira  ${other.space.id}`);
    const json = await open(["--space", "Mira", "--json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({
      error: {
        code: "ambiguous",
        data: {
          spaces: expect.arrayContaining([
            expect.objectContaining({ id: other.space.id, name: "mira" }),
          ]),
        },
      },
    });
    expect(opened).toEqual([]);

    // Its ID, its folder or the argument name the one space, and the tab goes to it.
    for (const args of [["--space", other.space.id], [join(w.root, "s", "mira-two")]]) {
      expect((await open(args)).code).toBe(0);
      const to = decodeURIComponent(URL_SHAPE.exec(opened.pop() ?? "")?.[3] ?? "");
      expect(to).toBe(`/s/${other.space.id}`);
    }
    // No space named: the page's own default, as before.
    expect((await open([])).code).toBe(0);
    expect(URL_SHAPE.exec(opened.pop() ?? "")?.[3]).toBeUndefined();
  });

  test("an agent's shell cannot open the UI: it is told to ask the user", SLOW, async () => {
    const w = await world("oc", {}, { space: false });
    const ran = await runMain(["open", "--print-url"], {
      home: w.home,
      env: { CLAUDECODE: "1" },
    });
    expect(ran.code).toBe(5);
    expect(ran.stderr).toContain("Ask the user to open TTasks.");
    expect(ran.stdout).toBe("");
  });

  test(
    "another user holds the UI's port: A2's message, no code, exit 6; ttasks service port resolves it",
    SLOW,
    async () => {
      const w = await world("od");
      const port = w.port();
      persistPort(w.home, port);
      await w.restart({ holders: (p) => (p === port ? [{ owner: null }] : []) });
      const ran = await runMain(["open", "--print-url"], { home: w.home, tty: true });
      expect(ran.code).toBe(6);
      expect(ran.stderr).toContain(blockedMessage(port));
      expect(ran.stdout).toBe("");
      // The script class may not move the port; the person may, with --reuse for the same port.
      const script = await runMain(["service", "port", String(port)], { home: w.home });
      expect(script.code).toBe(5);
      const again = await runMain(["service", "port", String(port)], { home: w.home, tty: true });
      expect(again.code).toBe(2);
      expect(again.stderr).toContain("--reuse");
      // --reuse asks the person to confirm every tab and app window is closed: a no changes nothing.
      const questions: string[] = [];
      const declined = await runMain(["service", "port", String(port), "--reuse"], {
        home: w.home,
        tty: true,
        main: {
          ask: (question) => {
            questions.push(question);
            return Promise.resolve(false);
          },
        },
      });
      expect(declined.code).toBe(0);
      expect(declined.stderr).toContain("Nothing changed");
      expect(questions).toHaveLength(1);
      expect(questions[0]).toContain("tab and app window");
      expect(w.service.status().http?.blocked).toBe("foreign_port_holder");
      // Without a terminal to ask in, --reuse needs --yes.
      const unasked = await runMain(["service", "port", String(port), "--reuse"], { home: w.home });
      expect(unasked.code).toBe(2);
      expect(unasked.stderr).toContain("--yes");
      const reuse = await runMain(["service", "port", String(port), "--reuse"], {
        home: w.home,
        tty: true,
        main: { ask: () => Promise.resolve(true) },
      });
      expect(reuse.code).toBe(0);
      expect(reuse.stdout).toContain(`UI port is now ${String(port)}`);
      expect(await w.service.exited).toBe(75);
    },
  );

  test("a busy persisted port: the run's port is used and A2's line printed", SLOW, async () => {
    const holder = createServer();
    servers.push(holder);
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    const address = holder.address();
    const busy = typeof address === "object" && address !== null ? address.port : 0;
    const w = await world("oe", {}, { space: false });
    persistPort(w.home, busy);
    await w.restart({ holders: () => [] });
    const ran = await runMain(["open", "--print-url"], { home: w.home, tty: true });
    expect(ran.code).toBe(0);
    expect(ran.stderr).toContain(movedMessage(busy, w.port()));
    expect(URL_SHAPE.exec(ran.stdout.trim())?.[1]).toBe(String(w.port()));
  });

  test(
    "the probe: only the service's listener answers it; a squatter or a closed port does not",
    SLOW,
    async () => {
      const w = await world("of", {}, { space: false });
      const { keyOf } = await import("@ttasks/service/test/harness");
      const key = keyOf(w.home);
      const instance = w.service.instance;
      expect(await probeListener(w.port(), key, instance)).toBe(true);
      expect(await probeListener(w.port(), key, "f".repeat(32))).toBe(false);
      expect(await probeListener(w.port(), new Uint8Array(32), instance)).toBe(false);
      // A squatter that answers 200 with a made-up proof.
      const squatter = createHttpServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ proof: "A".repeat(43) }));
      });
      await new Promise<void>((resolve) => squatter.listen(0, "127.0.0.1", resolve));
      const sq = squatter.address();
      const sqPort = typeof sq === "object" && sq !== null ? sq.port : 0;
      try {
        expect(await probeListener(sqPort, key, instance)).toBe(false);
      } finally {
        await new Promise((resolve) => squatter.close(resolve));
      }
      expect(await probeListener(sqPort, key, instance)).toBe(false);
    },
  );

  test(
    "a squatter that trickles bytes or never ends its body holds neither the probe nor doctor past the deadline",
    SLOW,
    async () => {
      const key = new Uint8Array(32).fill(7);
      const instance = "0123456789abcdef0123456789abcdef";
      const timers = new Set<NodeJS.Timeout>();
      const accepted = new Set<Socket>();
      // Answers with a head, then a byte every 50 ms for as long as the client stays.
      const trickle = createServer((socket) => {
        accepted.add(socket);
        socket.on("error", () => undefined);
        socket.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n");
        const timer = setInterval(() => socket.write(" "), 50);
        timers.add(timer);
        socket.on("close", () => {
          clearInterval(timer);
        });
      });
      // Answers with a body that never ends, as fast as the client reads.
      const endless = createServer((socket) => {
        accepted.add(socket);
        socket.on("error", () => undefined);
        socket.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n");
        const more = () => {
          while (socket.writable && socket.write(" ".repeat(4096)));
        };
        socket.on("drain", more);
        more();
      });
      servers.push(trickle, endless);
      const portOf = async (server: Server) => {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        return typeof address === "object" && address !== null ? address.port : 0;
      };
      const slow = await portOf(trickle);
      const big = await portOf(endless);
      // The deadlines are short here; the guard only tells a hang from an answer.
      const guard = async <T>(work: Promise<T>) => {
        let timer: NodeJS.Timeout | undefined;
        const hung = new Promise<"hung">((resolve) => {
          timer = setTimeout(() => {
            resolve("hung");
          }, 20_000);
        });
        try {
          return await Promise.race([work, hung]);
        } finally {
          clearTimeout(timer);
        }
      };
      try {
        expect(await guard(probeListener(slow, key, instance, 300))).toBe(false);
        expect(await guard(probeListener(big, key, instance, 10_000))).toBe(false);
        const problems = await guard(selfTest(slow, 300));
        expect(problems).not.toBe("hung");
        expect(problems).toContain("Host evil.example got no answer, not 421");
      } finally {
        for (const timer of timers) clearInterval(timer);
        // The squatters read nothing, so they would not see the client go: closed here.
        for (const socket of accepted) socket.destroy();
      }
    },
  );
});

describe("[A2.3.9.cli.open-start] ttasks open starts a stopped service first", () => {
  test(
    "a stopped service is started as ttasks service start does, with one line, then the page opens",
    SLOW,
    async () => {
      const w = await world("og", {}, { space: false });
      await w.stop();
      let starts = 0;
      const startService = async () => {
        starts += 1;
        await w.restart();
        return "started" as const;
      };
      const ran = await runMain(["open", "--print-url"], {
        home: w.home,
        tty: true,
        main: { startService },
      });
      expect(ran.code).toBe(0);
      expect(starts).toBe(1);
      expect(ran.stderr).toContain("Started TTasks's service.\n");
      expect(URL_SHAPE.exec(ran.stdout.trim())?.[1]).toBe(String(w.port()));
      // A running service is not started again.
      const again = await runMain(["open", "--print-url"], {
        home: w.home,
        tty: true,
        main: { startService },
      });
      expect(again.code).toBe(0);
      expect(starts).toBe(1);
      expect(again.stderr).not.toContain("Started");
      // A start that another start beat says nothing about starting.
      await w.stop();
      const beaten = await runMain(["open", "--print-url"], {
        home: w.home,
        tty: true,
        main: {
          startService: async () => {
            await w.restart();
            return "already_running" as const;
          },
        },
      });
      expect(beaten.code).toBe(0);
      expect(beaten.stderr).not.toContain("Started");
      // Started by hand on Linux, where no unit of this install is installed: one more line says
      // it does not start by itself (A2 3.3.3).
      await w.stop();
      const byHand = await runMain(["open", "--print-url"], {
        home: w.home,
        tty: true,
        main: {
          startService: async () => {
            await w.restart();
            return "started_by_hand" as const;
          },
        },
      });
      expect(byHand.code).toBe(0);
      expect(byHand.stderr).toContain(
        "Started TTasks's service.\nIt does not start by itself when you sign in. To have it start by itself, run: ttasks service install\n",
      );
    },
  );

  test(
    "a start that fails says why and names the command; an agent's shell never starts it",
    SLOW,
    async () => {
      const w = await world("oh", {}, { space: false });
      await w.stop();
      const failed = await runMain(["open"], {
        home: w.home,
        tty: true,
        main: {
          startService: () =>
            Promise.reject(
              new StartFailed(
                "TTasks's service did not become ready within 20 s.",
                "ttasks service status",
              ),
            ),
          openUrl: () => Promise.reject(new Error("no browser may open")),
        },
      });
      expect(failed.code).toBe(6);
      expect(failed.stderr).toBe(
        "error service_unavailable: TTasks's service is not running, and it could not be started: TTasks's service did not become ready within 20 s. Run: ttasks service status\n",
      );
      expect(failed.stdout).toBe("");
      let starts = 0;
      const agent = await runMain(["open", "--print-url"], {
        home: w.home,
        env: { CODEX_THREAD_ID: "t-1" },
        main: {
          startService: () => {
            starts += 1;
            return Promise.resolve("started" as const);
          },
        },
      });
      expect(agent.code).toBe(5);
      expect(agent.stderr).toContain("Ask the user to open TTasks.");
      expect(agent.stdout).toBe("");
      expect(starts).toBe(0);
    },
  );
});
