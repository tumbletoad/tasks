// The shim's link to the service (A4 3.6.3 "Re-attaching", step 9): reports wait in order, a
// dropped connection is attached again, and only the service's refusal of the launch ends the link.
// Fake sessions and a fake agent in this process: no service, no process.
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RpcError, type JsonObject, type RpcSession } from "@ttasks/bridge/protocol";
import { REFUSED, SHIM_PROTOCOL } from "@ttasks/launch/shim-wire";
import { Link } from "../src/shim/link.ts";
import { runShim, shellAfterExit, TEXT, type ShimIo } from "../src/shim/run.ts";

/** A TTasks error as the service sends it: A3's body in `data`. */
const appError = (code: string, data: JsonObject): RpcError =>
  new RpcError(-32000, "fixture", { code, message: "fixture", data });

const REFUSAL = appError("forbidden", { reason: REFUSED });
const STOPPING = appError("service_unavailable", { reason: "not_running", retryable: true });

/** A folder check as the claim's reply carries it (places.ts FolderCheck). */
const CHECK = { dev: "2049", ino: "1311007", rootDev: "2049", rootIno: "1310977", depth: 1 };

/** A launch ID and reference of A1's and A4's forms. */
const LAUNCH = { id: `la_0${"0".repeat(25)}`, reference: "LAAAA0" };

interface FakeSession {
  readonly session: RpcSession;
  readonly calls: string[];
  readonly params: JsonObject[];
}

/** A session whose calls answer by `answer`, recording each method it was called with. */
function fake(answer: (method: string) => Promise<unknown>): FakeSession {
  const calls: string[] = [];
  const params: JsonObject[] = [];
  let closed = false;
  let onClose: (() => void) | undefined;
  const session = {
    get closed() {
      return closed;
    },
    get onClose() {
      return onClose;
    },
    set onClose(handler: (() => void) | undefined) {
      onClose = handler;
    },
    call: (method: string, sent: JsonObject = {}) => {
      if (closed) return Promise.reject(new Error("closed"));
      calls.push(method);
      params.push(sent);
      return answer(method);
    },
    close: () => {
      if (closed) return;
      closed = true;
      onClose?.();
    },
  };
  return { session: session as unknown as RpcSession, calls, params };
}

const links: Link[] = [];
const temps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const link of links.splice(0)) link.close();
  for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true });
});

function link(first: FakeSession, next: () => FakeSession): Link {
  const made = new Link(first.session, {
    connect: () => Promise.resolve(next().session),
    attach: { credential: `${"c".repeat(21)}A`, pid: 4242, start_time: "windows:1" },
    reattachMs: 5,
  });
  links.push(made);
  return made;
}

describe("[A4.5.shim.client] the shim's link", () => {
  test("a report the service could not take now is sent again after a reattach; only the launch's refusal ends the link", async () => {
    // The first connection answers the service's drain: retryable, not a refusal.
    const first = fake((method) =>
      method === "launch.started" ? Promise.reject(STOPPING) : Promise.resolve({}),
    );
    const second = fake(() => Promise.resolve({}));
    const l = link(first, () => second);
    expect(await l.finish("launch.started", { pid: 1, started_at: 1 }, 2_000)).toBe(true);
    expect(l.refused).toBe(false);
    expect(second.calls).toEqual(["launch.attach", "launch.started"]);

    // The service's refusal of the launch ends it: nothing more is sent.
    const third = fake((method) =>
      method === "launch.settled" ? Promise.reject(REFUSAL) : Promise.resolve({}),
    );
    const refused = link(third, () => fake(() => Promise.resolve({})));
    expect(await refused.finish("launch.settled", {}, 2_000)).toBe(false);
    expect(refused.refused).toBe(true);
  });

  test("a report queued while the connection is down is sent once the link attached again", async () => {
    const first = fake(() => Promise.resolve({}));
    let down = true;
    const second = fake(() => Promise.resolve({}));
    const made = new Link(first.session, {
      connect: () =>
        down ? Promise.reject(new Error("not running")) : Promise.resolve(second.session),
      attach: { credential: `${"c".repeat(21)}A`, pid: 4242, start_time: "windows:1" },
      reattachMs: 5,
    });
    links.push(made);
    // The service stops: the connection drops, and the settle comes while it is down.
    first.session.close();
    made.send("launch.settled", {});
    expect(made.waiting).toBe(1);
    // The service is back: the link attaches again and sends what waited.
    down = false;
    expect(await made.finish("launch.exited", { code: 0 }, 2_000)).toBe(true);
    expect(second.calls).toEqual(["launch.attach", "launch.settled", "launch.exited"]);
  });

  test("a claim the service could not take yet is presented again within the 30 s; a refusal is final", async () => {
    const folder = realpathSync.native(mkdtempSync(join(tmpdir(), "ttasks-shim-link-")));
    temps.push(folder);
    const reply = {
      protocol: SHIM_PROTOCOL,
      launch: LAUNCH,
      argv: [process.execPath],
      folder,
      check: CHECK,
      env: {},
      title: "Fixture launch",
      after_exit: "close",
      credential: `${"c".repeat(21)}A`,
      exit_file: join(folder, "exit.json"),
    };
    const run = async (answers: ((method: string) => Promise<unknown>)[]) => {
      const sessions: FakeSession[] = [];
      const lines: string[] = [];
      let started = 0;
      let entered = 0;
      const code = await runShim(["0".repeat(24)], {
        io: {
          ...fakeIo(lines),
          waitEnter: () => {
            entered += 1;
            return Promise.resolve();
          },
        },
        startTime: () => Promise.resolve("windows:1"),
        connect: () => {
          const answer = answers[sessions.length] ?? (() => Promise.resolve({}));
          const made = fake(answer);
          sessions.push(made);
          return Promise.resolve(made.session);
        },
        startAgent: () => {
          started += 1;
          return Promise.resolve({
            pid: 99,
            exited: Promise.resolve({ code: 0, signal: null }),
            kill: () => undefined,
          });
        },
        checkFolder: () => Promise.resolve({ status: "ok" }),
        timing: { retryEveryMs: 1, connectRetryMs: 5_000 },
      });
      return { code, sessions, lines, started, entered };
    };

    // Draining, then a space still opening: the same claim twice more, then the agent.
    const notYet = appError("service_unavailable", { reason: "not_ready", retryable: true });
    const ok = await run([
      () => Promise.reject(STOPPING),
      () => Promise.reject(notYet),
      (method) => Promise.resolve(method === "launch.claim" ? reply : {}),
    ]);
    expect(ok.sessions.map((s) => s.calls[0])).toEqual([
      "launch.claim",
      "launch.claim",
      "launch.claim",
    ]);
    expect(ok.started).toBe(1);
    expect(ok.code).toBe(0);

    // A refusal, and a reply lost on the way, are final: one claim, no agent. A refused claim
    // waits for Enter so its line can be read. A lost reply may have been taken: while the shim
    // lives the service holds the launch as opening, so it ends at once.
    for (const [final, entered] of [
      [REFUSAL, 1],
      [new Error("connection lost"), 0],
    ] as const) {
      const no = await run([() => Promise.reject(final)]);
      expect(no.sessions).toHaveLength(1);
      expect(no.started).toBe(0);
      expect(no.code).toBe(1);
      expect(no.entered).toBe(entered);
    }
  });
});

describe("[A4.5.shim.folder] the shim checks its folder before anything else", () => {
  test("a failed check starts nothing, reports the launch as failed with the reason, and says it in one line; a reply without a check is no reply", async () => {
    const folder = realpathSync.native(mkdtempSync(join(tmpdir(), "ttasks-shim-link-")));
    temps.push(folder);
    const reply = {
      protocol: SHIM_PROTOCOL,
      launch: LAUNCH,
      argv: [process.execPath],
      folder,
      check: CHECK,
      env: {},
      title: "Fixture launch",
      after_exit: "close",
      credential: `${"c".repeat(21)}A`,
      exit_file: join(folder, "exit.json"),
    };
    const run = async (sent: unknown) => {
      const session = fake((method) => Promise.resolve(method === "launch.claim" ? sent : {}));
      const lines: string[] = [];
      const checked: unknown[] = [];
      let started = 0;
      const code = await runShim(["0".repeat(24)], {
        io: fakeIo(lines),
        startTime: () => Promise.resolve("windows:1"),
        connect: () => Promise.resolve(session.session),
        checkFolder: (check) => {
          checked.push(check);
          return Promise.resolve({ status: "failed", reason: "folder_changed" });
        },
        startAgent: () => {
          started += 1;
          return Promise.reject(new Error("never"));
        },
      });
      return { code, session, lines, checked, started };
    };

    const changed = await run(reply);
    expect(changed.code).toBe(1);
    expect(changed.started).toBe(0);
    // The check it was handed, as the reply carried it.
    expect(changed.checked).toEqual([CHECK]);
    expect(changed.session.calls).toEqual(["launch.claim", "launch.failed"]);
    expect(changed.session.params[1]).toEqual({ reason: "verify", folder: "folder_changed" });
    expect(changed.lines[0]).toContain("(folder_changed). This launch did not start.");

    // A reply whose check is missing or not one starts nothing and checks nothing.
    for (const check of [undefined, { ...CHECK, dev: "-1" }, { ...CHECK, depth: 1.5 }, "/home"]) {
      const bad = await run({ ...reply, check });
      expect(bad.code, JSON.stringify(check)).toBe(1);
      expect(bad.checked).toEqual([]);
      expect(bad.started).toBe(0);
    }
  });
});

describe("[A4.5.shim.reply] the shim reads the claim's reply strictly, and reports every reply it cannot follow", () => {
  /** A claim answered with `sent`, a failed check if one is run, and the link's later sessions. */
  const run = async (
    sent: unknown,
    options: { failedAnswer?: () => Promise<unknown>; reconnect?: boolean } = {},
  ) => {
    const session = fake((method) =>
      method === "launch.claim"
        ? Promise.resolve(sent)
        : method === "launch.failed" && options.failedAnswer !== undefined
          ? options.failedAnswer()
          : Promise.resolve({}),
    );
    const lines: string[] = [];
    const checked: unknown[] = [];
    let started = 0;
    let connects = 0;
    const code = await runShim(["0".repeat(24)], {
      io: fakeIo(lines),
      startTime: () => Promise.resolve("windows:1"),
      connect: () => {
        connects += 1;
        if (connects === 1) return Promise.resolve(session.session);
        if (options.reconnect !== true) return Promise.reject(new Error("not running"));
        return Promise.resolve(fake(() => Promise.resolve({})).session);
      },
      checkFolder: (check) => {
        checked.push(check);
        return Promise.resolve({ status: "ok" });
      },
      startAgent: () => {
        started += 1;
        return Promise.reject(new Error("never"));
      },
      timing: { reattachMs: 5, finishMs: 300 },
    });
    return { code, session, lines, checked, started, connects };
  };

  const valid = (folder: string) => ({
    protocol: SHIM_PROTOCOL,
    launch: LAUNCH,
    argv: [process.execPath],
    folder,
    check: CHECK,
    env: { PATH: "/usr/bin" },
    title: "Fixture launch",
    after_exit: "close",
    credential: `${"c".repeat(21)}A`,
    exit_file: join(folder, "exit.json"),
  });

  test("a valid envelope with a check or any other field that is not exactly one is a failed claim: reported as launch.failed {verify}, nothing checked or started, one line", async () => {
    const folder = realpathSync.native(mkdtempSync(join(tmpdir(), "ttasks-shim-reply-")));
    temps.push(folder);
    const reply = valid(folder);
    const broken: [string, unknown][] = [
      ["no check", { ...reply, check: undefined }],
      ["a negative identity", { ...reply, check: { ...CHECK, dev: "-1" } }],
      ["a fractional depth", { ...reply, check: { ...CHECK, depth: 1.5 } }],
      ["a path for a check", { ...reply, check: "/home" }],
      ["an unknown field in the check", { ...reply, check: { ...CHECK, path: "/home" } }],
      ["an unknown field in the reply", { ...reply, cwd: "/home" }],
      ["a shell to run the agent through", { ...reply, login_shell: "/bin/sh" }],
      ["no folder", { ...reply, folder: undefined }],
      ["a relative folder", { ...reply, folder: "work/portal" }],
      ["a folder past its bound", { ...reply, folder: `${folder}${"a".repeat(4_097)}` }],
      ["a folder that is not text", { ...reply, folder: 7 }],
      ["an unknown field in the launch", { ...reply, launch: { ...LAUNCH, task: "t" } }],
      ["a reference of another form", { ...reply, launch: { ...LAUNCH, reference: "x" } }],
      ["a 400,000-character title", { ...reply, title: "t".repeat(400_000) }],
      ["a title that is not text", { ...reply, title: 7 }],
      ["no argv", { ...reply, argv: [] }],
      ["an argument that is not text", { ...reply, argv: [process.execPath, 1] }],
      ["an argument past its bound", { ...reply, argv: [process.execPath, "a".repeat(131_073)] }],
      ["too many arguments", { ...reply, argv: Array.from({ length: 4097 }, () => "a") }],
      ["a NUL in an argument", { ...reply, argv: [process.execPath, "a\u0000b"] }],
      ["an environment name with =", { ...reply, env: { "A=B": "x" } }],
      ["an environment value that is not text", { ...reply, env: { PATH: 1 } }],
      ["an environment value past its bound", { ...reply, env: { PATH: "a".repeat(32_769) } }],
      ["an after_exit mode it does not know", { ...reply, after_exit: "linger" }],
      ["a notice it does not know", { ...reply, notice: "anything" }],
      ["a protocol that is not a number", { ...reply, protocol: "1" }],
    ];
    for (const [what, sent] of broken) {
      const result = await run(sent);
      expect(result.code, what).toBe(1);
      expect(result.started, what).toBe(0);
      expect(result.checked, what).toEqual([]);
      // Reported on the connection that claimed, which holds the attachment.
      expect(result.session.calls, what).toEqual(["launch.claim", "launch.failed"]);
      expect(result.session.params[1], what).toEqual({ reason: "verify" });
      expect(result.lines[0], what).toBe(TEXT.verify.reply);
    }
    // The valid reply itself passes the reading: its check is run.
    const ok = await run(reply);
    expect(ok.checked).toEqual([CHECK]);
  });

  test("another protocol is reported with the version line; a reply that is no object at all is reported too", async () => {
    const folder = realpathSync.native(mkdtempSync(join(tmpdir(), "ttasks-shim-reply-")));
    temps.push(folder);
    const other = await run({ ...valid(folder), protocol: SHIM_PROTOCOL + 1, extra: true });
    expect(other.code).toBe(1);
    expect(other.session.calls).toEqual(["launch.claim", "launch.failed"]);
    expect(other.session.params[1]).toEqual({ reason: "verify" });
    expect(other.lines[0]).toBe(TEXT.verify.protocol);
    for (const sent of [null, [], "reply", 42, {}]) {
      const result = await run(sent);
      expect(result.code, JSON.stringify(sent)).toBe(1);
      expect(result.session.calls, JSON.stringify(sent)).toEqual(["launch.claim", "launch.failed"]);
      expect(result.lines[0], JSON.stringify(sent)).toBe(TEXT.verify.reply);
    }
  });

  test("a report the service did not take goes to exit.json when the envelope names one; without a credential the link never attaches again; never a crash", async () => {
    const folder = realpathSync.native(mkdtempSync(join(tmpdir(), "ttasks-shim-reply-")));
    temps.push(folder);
    const reply = valid(folder);
    const lost = () => Promise.reject(new Error("connection lost"));

    // The check is broken and the report is lost on the way: exit.json holds the failure.
    const kept = await run({ ...reply, check: "/home" }, { failedAnswer: lost });
    expect(kept.code).toBe(1);
    const written = JSON.parse(readFileSync(join(folder, "exit.json"), "utf8")) as unknown;
    expect(written).toEqual({
      format: 1,
      launch: LAUNCH.id,
      spawned: false,
      settled: false,
      code: null,
      signal: null,
      ran_ms: 0,
      failed: "verify",
    });
    rmSync(join(folder, "exit.json"));

    // No credential: the link reports on the claim's connection and never tries another.
    const bare = await run({ ...reply, credential: undefined }, { reconnect: true });
    expect(bare.code).toBe(1);
    expect(bare.session.calls).toEqual(["launch.claim", "launch.failed"]);
    const dropped = await run(
      { ...reply, credential: "not a credential" },
      { failedAnswer: lost, reconnect: true },
    );
    expect(dropped.code).toBe(1);
    expect(dropped.connects).toBe(1);
    // Not taken, and no other connection to send it on: exit.json holds it.
    expect(JSON.parse(readFileSync(join(folder, "exit.json"), "utf8"))).toMatchObject({
      launch: LAUNCH.id,
      failed: "verify",
    });
    rmSync(join(folder, "exit.json"));

    // An exit file that is not an absolute exit.json, or a launch ID of another form: nothing is
    // written anywhere, and the shim still ends with its line.
    for (const sent of [
      { ...reply, title: 7, exit_file: "exit.json" },
      { ...reply, title: 7, exit_file: join(folder, "other.json") },
      { ...reply, title: 7, launch: { id: "la_fixture", reference: "LAAAA0" } },
    ]) {
      const result = await run(sent, { failedAnswer: lost });
      expect(result.code).toBe(1);
      expect(result.lines[0]).toBe(TEXT.verify.reply);
    }
    expect(readdirSync(folder)).toEqual([]);
  });
});

describe("[A4.5.shim.client] how long the agent ran", () => {
  test("a slow spawn and a wall clock step do not count towards how long the agent ran", async () => {
    const folder = realpathSync.native(mkdtempSync(join(tmpdir(), "ttasks-shim-link-")));
    temps.push(folder);
    const reply = {
      protocol: SHIM_PROTOCOL,
      launch: LAUNCH,
      argv: [process.execPath],
      folder,
      check: CHECK,
      env: {},
      title: "Fixture launch",
      after_exit: "close",
      credential: `${"c".repeat(21)}A`,
      exit_file: join(folder, "exit.json"),
    };
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const wall = vi.spyOn(Date, "now").mockReturnValue(0);
    const session = fake((method) => {
      if (method === "launch.started") {
        wall.mockReturnValue(3_600_000);
        elapsed += 2;
      }
      return Promise.resolve(method === "launch.claim" ? reply : {});
    });
    const code = await runShim(["0".repeat(24)], {
      io: fakeIo([]),
      startTime: () => Promise.resolve("windows:1"),
      connect: () => Promise.resolve(session.session),
      checkFolder: () => Promise.resolve({ status: "ok" }),
      startAgent: () => {
        elapsed += 4_000;
        return Promise.resolve({
          pid: 99,
          exited: Promise.resolve({ code: 1, signal: null }),
          kill: () => undefined,
        });
      },
    });
    expect(code).toBe(1);
    const exited = session.params[session.calls.indexOf("launch.exited")];
    expect(exited).toMatchObject({ code: 1, settled: false, ran_ms: 2 });
  });
});

describe("[A4.5.shim.folder] the shim enters the folder itself, then checks it", () => {
  const replyIn = (folder: string): Record<string, unknown> => ({
    protocol: SHIM_PROTOCOL,
    launch: LAUNCH,
    argv: [process.execPath],
    folder,
    check: CHECK,
    env: {},
    title: "Fixture launch",
    after_exit: "close",
    credential: `${"c".repeat(21)}A`,
    exit_file: join(folder, "exit.json"),
  });

  test("the reply's folder is entered before the check, and a folder that cannot be entered starts nothing", async () => {
    const folder = realpathSync.native(mkdtempSync(join(tmpdir(), "ttasks-shim-link-")));
    temps.push(folder);
    const order: string[] = [];
    const run = async (sent: unknown, enter: (folder: string) => void) => {
      const session = fake((method) => Promise.resolve(method === "launch.claim" ? sent : {}));
      const lines: string[] = [];
      let started = 0;
      const io = { ...fakeIo(lines), enter };
      const code = await runShim(["0".repeat(24)], {
        io,
        startTime: () => Promise.resolve("windows:1"),
        connect: () => Promise.resolve(session.session),
        checkFolder: () => {
          order.push("check");
          return Promise.resolve({ status: "ok" });
        },
        startAgent: () => {
          started += 1;
          order.push("agent");
          return Promise.resolve({
            pid: 99,
            exited: Promise.resolve({ code: 0, signal: null }),
            kill: () => undefined,
          });
        },
      });
      return { code, session, lines, started };
    };
    const ok = await run(replyIn(folder), (f) => {
      order.push(`enter ${f}`);
    });
    expect(ok.code).toBe(0);
    expect(order).toEqual([`enter ${folder}`, "check", "agent"]);

    // Gone between the dispatch and the shim: nothing starts, and the reason is the folder's.
    order.length = 0;
    const gone = await run(replyIn(folder), () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    expect(gone.code).toBe(1);
    expect(gone.started).toBe(0);
    expect(order).toEqual([]);
    expect(gone.session.params[1]).toEqual({ reason: "verify", folder: "path_missing" });

    // A reply without the folder is no reply.
    const without = replyIn(folder);
    delete without["folder"];
    const none = await run(without, () => undefined);
    expect(none.code).toBe(1);
    expect(none.started).toBe(0);
  });
});

describe("[A4.5.shim.client] via_login_shell and the shell after exit", () => {
  test("nothing runs between the folder check and the agent: it starts directly with the reply's argv and environment; a reply that names a shell is not followed", async () => {
    // A Linux shim: the folder and the exit file are this OS's absolute paths. Nothing is entered
    // for real (the fake records it) and the check is the fake's.
    const folder = "/fixture/work/portal";
    const argv = [process.execPath, "--title", `"$(id)" ; \`id\``, "-e"];
    const reply = {
      protocol: SHIM_PROTOCOL,
      launch: LAUNCH,
      argv,
      folder,
      check: CHECK,
      env: { SHELL: "/usr/bin/zsh", PATH: "/usr/bin" },
      title: "Fixture launch",
      after_exit: "close",
      credential: `${"c".repeat(21)}A`,
      exit_file: `${folder}/exit.json`,
    };
    const run = async (answer: object) => {
      const session = fake((method) => Promise.resolve(method === "launch.claim" ? answer : {}));
      const order: string[] = [];
      const started: { argv: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
      const entered: string[] = [];
      const lines: string[] = [];
      const code = await runShim(["0".repeat(24)], {
        io: { ...fakeIo(lines, entered), platform: "linux" },
        startTime: () => Promise.resolve("windows:1"),
        connect: () => Promise.resolve(session.session),
        checkFolder: () => {
          order.push("check");
          return Promise.resolve({ status: "ok" });
        },
        startAgent: (spec) => {
          order.push("agent");
          started.push(spec);
          return Promise.resolve({
            pid: 99,
            exited: Promise.resolve({ code: 0, signal: null }),
            kill: () => undefined,
          });
        },
      });
      return { code, order, started, entered, session, lines };
    };
    const direct = await run(reply);
    expect(direct.lines).not.toContain(TEXT.notice.brief_sent);
    expect(direct.code).toBe(0);
    expect(direct.entered).toEqual([folder]);
    expect(direct.order).toEqual(["check", "agent"]);
    expect(direct.started).toEqual([{ argv, env: { SHELL: "/usr/bin/zsh", PATH: "/usr/bin" } }]);
    // A field an older build sent to run the agent through a shell: not this protocol's reply, so
    // nothing is entered and nothing starts, and the launch is reported as failed.
    const shell = await run({ ...reply, login_shell: "/usr/bin/zsh" });
    expect(shell.code).toBe(1);
    expect(shell.entered).toEqual([]);
    expect(shell.started).toEqual([]);
    expect(shell.session.calls).toContain("launch.failed");
    // An app too old to hold the brief unsent: its line, then the agent as usual.
    const sent = await run({ ...reply, notice: "brief_sent" });
    expect(sent.code).toBe(0);
    expect(sent.lines).toContain(TEXT.notice.brief_sent);
    expect(sent.order).toEqual(["check", "agent"]);
  });

  test("after_exit shell starts the person's shell in the folder without the product's variables, then exits with the agent's code", async () => {
    const folder = "/fixture/work/portal";
    const session = fake((method) =>
      Promise.resolve(
        method === "launch.claim"
          ? {
              protocol: SHIM_PROTOCOL,
              launch: LAUNCH,
              argv: [process.execPath],
              folder,
              check: CHECK,
              env: { SHELL: "/usr/bin/fish", PATH: "/usr/bin", TTASKS_TICKET: "T".repeat(24) },
              title: "Fixture launch",
              after_exit: "shell",
              credential: `${"c".repeat(21)}A`,
              exit_file: `${folder}/exit.json`,
            }
          : {},
      ),
    );
    const started: { argv: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
    const code = await runShim(["0".repeat(24)], {
      io: { ...fakeIo([]), platform: "linux" },
      startTime: () => Promise.resolve("windows:1"),
      connect: () => Promise.resolve(session.session),
      checkFolder: () => Promise.resolve({ status: "ok" }),
      startAgent: (spec) => {
        started.push(spec);
        return Promise.resolve({
          pid: 99 + started.length,
          exited: Promise.resolve({ code: started.length === 1 ? 3 : 0, signal: null }),
          kill: () => undefined,
        });
      },
    });
    expect(code).toBe(3);
    expect(started.map((s) => s.argv)).toEqual([[process.execPath], ["/usr/bin/fish", "-l"]]);
    expect(started[1]?.env).toEqual({ SHELL: "/usr/bin/fish", PATH: "/usr/bin" });
    expect(shellAfterExit({}, "linux")).toEqual(["/bin/sh", "-l"]);
    expect(shellAfterExit({ SHELL: "zsh" }, "darwin")).toEqual(["/bin/sh", "-l"]);
    const windows = shellAfterExit({ Path: "C:\\nowhere" }, "win32");
    expect(windows[1]).toBe("-NoLogo");
    expect(windows[0]?.toLowerCase()).toMatch(/powershell\.exe$|pwsh\.exe$/);
  });
});

/**
 * The shim's process and terminal, recorded: Enter is pressed at once, and the folders it enters
 * are recorded (the test process never changes its own working directory).
 */
function fakeIo(lines: string[], entered: string[] = []): ShimIo {
  return {
    env: {},
    platform: process.platform,
    pid: process.pid,
    tty: { stdin: false, stdout: false },
    say: (line) => lines.push(line),
    write: () => undefined,
    waitEnter: () => Promise.resolve(),
    setTitle: () => undefined,
    enter: (folder) => {
      entered.push(folder);
    },
    on: () => () => undefined,
    exit: () => undefined,
  };
}
