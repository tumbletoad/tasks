// ttasksw.exe's supervisor loop,
// with the stub service of test/stub/ttasks.mjs. The test build (TTASKS_TEST_HOOKS) shortens the
// time unit and traces each decision, so the sequence is checked exactly and the waits are
// checked against the stub's own clock. Windows only: elsewhere every test is collected and skipped.
import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Launchers } from "../src/build.ts";
import {
  addVersion,
  runLaunchers,
  alive,
  killQuietly,
  makeStable,
  prepareRuntime,
  readLines,
  removeDir,
  run,
  samePath,
  stable,
  tempDir,
  versionLocal,
  waitUntil,
  windows,
} from "./install.ts";

const OLD = "0.1.0";
const NEW = "0.2.0";
/** Slack for clock granularity between the stub's end line and the supervisor's own wait. */
const CLOCK_SLACK_MS = 40;

interface Step {
  exit: number;
  ms?: number;
  switchTo?: string;
  replaceSupervisor?: boolean;
}

interface StubLine {
  ev: "start" | "end";
  n: number;
  t: number;
  pid?: number;
  ppid?: number;
  version?: string;
  execPath?: string;
  args?: string[];
  mode?: string | null;
  manager?: string | null;
  exit?: number;
}

interface Supervised {
  status: number | null;
  stderr: string;
  trace: string[];
  starts: StubLine[];
  ends: StubLine[];
  /** Milliseconds from the end of start n to the beginning of start n + 1. */
  gaps: number[];
  gaveUp: GiveUp | undefined;
}

interface GiveUp {
  format: number;
  event: string;
  t: string;
  window_ms: number;
  failures: { t: string; exit: number | null; start?: string }[];
}

describe.runIf(windows)(
  "[A2.3.3.2.launcher-win.supervisor] ttasksw.exe supervises ttasks serve",
  () => {
    let work: string;
    let hooks: Launchers;
    let release: Launchers;
    let count = 0;

    beforeAll(async () => {
      work = tempDir("supervisor");
      prepareRuntime(work);
      hooks = await runLaunchers("hooks");
      release = await runLaunchers("release");
    }, 300_000);

    afterAll(() => {
      removeDir(work);
    });

    /**
     * A fresh TTASKS_HOME install (home.marker, so its state folder is <root>\state) with OLD current
     * and NEW beside it, launchers in bin\ and a stub folder.
     */
    function install(launchers: Launchers = hooks): string {
      count += 1;
      const root = join(work, `root-${String(count)}`);
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "home.marker"), "");
      addVersion(root, OLD, launchers);
      addVersion(root, NEW, launchers);
      makeStable(root, OLD, launchers);
      mkdirSync(join(root, "stub"));
      return root;
    }

    const giveUpFile = (root: string) => join(root, "state", "crash", "supervisor-gave-up.json");

    /**
     * Runs <root>\bin\ttasksw.exe with no arguments until it stops, with the stub following plan.
     * prepare runs after the state folder is cleared and before the supervisor starts. With
     * readRecord false, whatever stands at the record's name is left unread.
     */
    function supervise(
      root: string,
      plan: Step[],
      unitMs: number,
      exe = stable(root, true),
      prepare: () => void = () => undefined,
      readRecord = true,
    ) {
      const stub = join(root, "stub");
      writeFileSync(join(stub, "plan.json"), JSON.stringify(plan));
      for (const file of ["log.jsonl", "trace.txt"]) rmSync(join(stub, file), { force: true });
      rmSync(join(root, "state"), { recursive: true, force: true });
      prepare();
      const result = run(exe, [], {
        env: {
          TTASKS_STUB_DIR: stub,
          TTASKS_TEST_TIME_UNIT_MS: String(unitMs),
          TTASKS_TEST_TRACE: join(stub, "trace.txt"),
          // A caller's value never reaches the service: the supervisor sets its own.
          ttasks_service_manager: "systemd",
        },
        timeout: 120_000,
      });
      const lines = readLines<StubLine>(join(stub, "log.jsonl"));
      const starts = lines.filter((l) => l.ev === "start");
      const ends = lines.filter((l) => l.ev === "end");
      const gaps = ends
        .slice(0, starts.length - 1)
        .map((end, i) => (starts[i + 1]?.t ?? 0) - end.t);
      const traceFile = join(stub, "trace.txt");
      const supervised: Supervised = {
        status: result.status,
        stderr: result.stderr,
        trace: existsSync(traceFile)
          ? readFileSync(traceFile, "utf8").split("\n").filter(Boolean)
          : [],
        starts,
        ends,
        gaps,
        gaveUp:
          readRecord && existsSync(giveUpFile(root))
            ? (JSON.parse(readFileSync(giveUpFile(root), "utf8")) as GiveUp)
            : undefined,
      };
      return supervised;
    }

    test("restarts after 1, 2, 4 and 8 units and gives up at the 5th failure, with the record", () => {
      const unit = 100;
      const root = install();
      const s = supervise(
        root,
        [{ exit: 70 }, { exit: 70 }, { exit: 1 }, { exit: 70 }, { exit: 70 }],
        unit,
      );
      expect(s.trace).toEqual([
        "exit 70",
        "wait 1",
        "exit 70",
        "wait 2",
        "exit 1",
        "wait 4",
        "exit 70",
        "wait 8",
        "exit 70",
        "gave-up",
      ]);
      expect(s.status).toBe(70);
      expect(s.starts).toHaveLength(5);
      [1, 2, 4, 8].forEach((units, i) => {
        expect(s.gaps[i], `wait ${String(units)}`).toBeGreaterThanOrEqual(
          units * unit - CLOCK_SLACK_MS,
        );
      });
      for (const start of s.starts) {
        expect(start.args).toEqual(["serve"]);
        expect(start.mode).toBe("stable");
        // The service learns who supervises it, whatever the caller had set.
        expect(start.manager).toBe("ttasksw");
        expect(start.version).toBe(OLD);
        expect(samePath(start.execPath, join(root, "versions", OLD, "runtime", "node.exe"))).toBe(
          true,
        );
      }
      const record = s.gaveUp;
      expect(record?.format).toBe(1);
      expect(record?.event).toBe("supervisor.gave_up");
      expect(record?.window_ms).toBe(600 * unit);
      expect(record?.failures.map((f) => f.exit)).toEqual([70, 70, 1, 70, 70]);
      for (const f of record?.failures ?? [])
        expect(f.t).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      expect(Date.parse(record?.t ?? "")).toBeGreaterThan(Date.now() - 60_000);
    });

    test("the daily install's supervisor writes its record to %USERPROFILE%\\.ttasks, the service's state", () => {
      // The daily layout: <base>\share\ttasks with the stable launchers in <base>\bin, and a
      // stand-in profile folder, never the real one.
      count += 1;
      const base = join(work, `daily-${String(count)}`);
      const root = join(base, "share", "ttasks");
      const profile = join(base, "profile");
      mkdirSync(root, { recursive: true });
      mkdirSync(profile);
      addVersion(root, OLD, hooks);
      makeStable(root, OLD, hooks);
      const stub = join(base, "stub");
      mkdirSync(stub);
      writeFileSync(join(stub, "plan.json"), JSON.stringify(FAILING));
      const exe = join(base, "bin", "ttasksw.exe");
      expect(samePath(stable(root, true), exe)).toBe(true);
      const supervised = (userProfile: string) => {
        // The stub counts its starts in log.jsonl: each run follows the plan from its start.
        rmSync(join(stub, "log.jsonl"), { force: true });
        return run(exe, [], {
          env: { TTASKS_STUB_DIR: stub, TTASKS_TEST_TIME_UNIT_MS: "10", USERPROFILE: userProfile },
          timeout: 120_000,
        });
      };
      const ran = supervised(profile);
      expect([ran.status, ran.stderr]).toEqual([70, ""]);
      const record = join(profile, ".ttasks", "state", "crash", "supervisor-gave-up.json");
      const parsed = JSON.parse(readFileSync(record, "utf8")) as GiveUp;
      expect(parsed.failures.map((f) => f.exit)).toEqual([70, 70, 70, 70, 70]);
      // Nothing in the program's folder.
      expect(existsSync(join(root, "state"))).toBe(false);
      // A USERPROFILE that names no folder: no record anywhere, and the supervisor says so.
      rmSync(join(profile, ".ttasks"), { recursive: true });
      for (const odd of ["relative\\profile", "\\\\?\\C:\\x"]) {
        const refused = supervised(odd);
        expect(refused.status).toBe(70);
        expect(refused.stderr).toMatch(/USERPROFILE names no folder/);
      }
      expect(existsSync(join(profile, ".ttasks"))).toBe(false);
      expect(existsSync(join(root, "state"))).toBe(false);
    });

    test("stops on 0, 64 and 73 and exits with that code", () => {
      const root = install();
      for (const code of [0, 64, 73]) {
        const s = supervise(root, [{ exit: 70 }, { exit: code }], 20);
        expect(s.trace, String(code)).toEqual([
          "exit 70",
          "wait 1",
          `exit ${String(code)}`,
          `stop ${String(code)}`,
        ]);
        expect(s.status).toBe(code);
        expect(s.starts).toHaveLength(2);
        expect(s.gaveUp).toBeUndefined();
      }
    });

    test("restarts at once on 75, re-reading current", () => {
      // A long unit: any wait at all would show in the gap.
      const unit = 5000;
      const root = install();
      const s = supervise(root, [{ exit: 75, switchTo: NEW }, { exit: 0 }], unit);
      expect(s.trace).toEqual(["exit 75", "restart", "exit 0", "stop 0"]);
      expect(s.status).toBe(0);
      expect(s.starts.map((x) => x.version)).toEqual([OLD, NEW]);
      expect(
        samePath(s.starts[1]?.execPath, join(root, "versions", NEW, "runtime", "node.exe")),
      ).toBe(true);
      expect(s.gaps[0]).toBeLessThan(unit);
    });

    test("more than 5 restart requests in the window count as failures, so the loop cannot spin", () => {
      const root = install();
      const s = supervise(
        root,
        [...Array.from({ length: 6 }, () => ({ exit: 75 })), { exit: 0 }],
        20,
      );
      expect(s.trace).toEqual([
        ...Array.from({ length: 5 }, () => ["exit 75", "restart"]).flat(),
        "exit 75",
        "wait 1",
        "exit 0",
        "stop 0",
      ]);
      expect(s.status).toBe(0);
    });

    test("failures older than the window no longer count", () => {
      // Unit 5 ms: the window is 3 s. The 5th failure comes 3.5 s after the 4th, so it is the only
      // one left in the window and waits 1 unit instead of giving up.
      const root = install();
      const s = supervise(
        root,
        [
          { exit: 70 },
          { exit: 70 },
          { exit: 70 },
          { exit: 70 },
          { exit: 70, ms: 3500 },
          { exit: 0 },
        ],
        5,
      );
      expect(s.trace).toEqual([
        "exit 70",
        "wait 1",
        "exit 70",
        "wait 2",
        "exit 70",
        "wait 4",
        "exit 70",
        "wait 8",
        "exit 70",
        "wait 1",
        "exit 0",
        "stop 0",
      ]);
      expect(s.gaveUp).toBeUndefined();
    });

    test("a start that fails counts as a failure, and the record says so", () => {
      const root = install();
      writeFileSync(join(root, "current"), "9.9.9");
      const s = supervise(root, [], 10);
      expect(s.trace).toEqual([
        "start-failed",
        "wait 1",
        "start-failed",
        "wait 2",
        "start-failed",
        "wait 4",
        "start-failed",
        "wait 8",
        "start-failed",
        "gave-up",
      ]);
      expect(s.status).toBe(70);
      expect(s.starts).toHaveLength(0);
      expect(s.gaveUp?.failures.map((f) => [f.exit, f.start])).toEqual(
        Array.from({ length: 5 }, () => [null, "failed"]),
      );
    });

    /** Five failures in a row: the supervisor gives up after 150 units. */
    const FAILING: Step[] = Array.from({ length: 5 }, () => ({ exit: 70 }));

    test("the give-up record never writes through a hard link: files outside the install keep their contents", () => {
      // The hooks build writes the record through the same code as the release build, which only
      // ignores the 10 ms unit; that is proved by 'a release build ignores the test hooks'.
      const root = install(hooks);
      const crash = join(root, "state", "crash");
      // Victims outside the install, hard-linked at the old temporary name and at the record's name.
      const victims = [
        join(work, `victim-${String(count)}-a`),
        join(work, `victim-${String(count)}-b`),
      ];
      for (const victim of victims) writeFileSync(victim, "victim");
      const s = supervise(root, FAILING, 10, stable(root, true), () => {
        mkdirSync(crash, { recursive: true });
        linkSync(victims[0] ?? "", join(crash, "supervisor-gave-up.json.tmp"));
        linkSync(victims[1] ?? "", join(crash, "supervisor-gave-up.json"));
      });
      expect(s.status).toBe(70);
      for (const victim of victims) expect(readFileSync(victim, "utf8"), victim).toBe("victim");
      expect(s.gaveUp?.failures.map((f) => f.exit)).toEqual([70, 70, 70, 70, 70]);
      // Only the record and the planted name: the temporary file the supervisor made is gone.
      expect(readdirSync(crash).sort()).toEqual([
        "supervisor-gave-up.json",
        "supervisor-gave-up.json.tmp",
      ]);
    });

    test("a state or crash folder that is a junction is refused: nothing is written outside the install", () => {
      const cases: [label: string, setUp: (root: string, outside: string) => void][] = [
        [
          "state",
          (root, outside) => {
            symlinkSync(outside, join(root, "state"), "junction");
          },
        ],
        [
          "crash",
          (root, outside) => {
            mkdirSync(join(root, "state"));
            symlinkSync(outside, join(root, "state", "crash"), "junction");
          },
        ],
      ];
      for (const [label, setUp] of cases) {
        const root = install();
        const outside = join(work, `outside-${String(count)}`);
        mkdirSync(outside);
        const s = supervise(root, FAILING, 10, stable(root, true), () => {
          setUp(root, outside);
        });
        expect(s.status, label).toBe(70);
        expect(s.trace.at(-1), label).toBe("gave-up");
        expect(readdirSync(outside, { recursive: true }), label).toEqual([]);
        expect(s.stderr, label).toMatch(/is a link or junction/);
      }
    });

    test("a record that cannot be renamed into place warns and exits 70, leaving what stands there and no temporary file", () => {
      /** libuv's flag for an open without any sharing, so the file cannot be deleted or replaced. */
      const UV_FS_O_EXLOCK = 0x10000000;
      /** Files the test holds open while the supervisor runs. */
      const open: number[] = [];
      const cases: [label: string, setUp: (record: string) => void, check: (r: string) => void][] =
        [
          [
            "a folder at the record's name",
            (record) => {
              mkdirSync(join(record, "inside"), { recursive: true });
              writeFileSync(join(record, "inside", "kept.txt"), "kept");
            },
            (record) => {
              expect(statSync(record).isDirectory()).toBe(true);
              expect(readdirSync(record, { recursive: true }).sort()).toEqual([
                "inside",
                join("inside", "kept.txt"),
              ]);
              expect(readFileSync(join(record, "inside", "kept.txt"), "utf8")).toBe("kept");
            },
          ],
          [
            "a record held open without delete sharing",
            (record) => {
              mkdirSync(dirname(record), { recursive: true });
              writeFileSync(record, "old record");
              open.push(openSync(record, constants.O_RDONLY | UV_FS_O_EXLOCK));
            },
            (record) => {
              expect(readFileSync(record, "utf8")).toBe("old record");
            },
          ],
        ];
      for (const [label, setUp, check] of cases) {
        const root = install();
        const record = giveUpFile(root);
        let s: Supervised;
        try {
          s = supervise(
            root,
            FAILING,
            10,
            stable(root, true),
            () => {
              setUp(record);
            },
            false,
          );
        } finally {
          for (const fd of open.splice(0)) closeSync(fd);
        }
        expect(s.status, label).toBe(70);
        expect(s.trace.at(-1), label).toBe("gave-up");
        expect(s.stderr, label).toMatch(/cannot write .*supervisor-gave-up\.json \(error \d+\)/);
        check(record);
        // The temporary file the supervisor made is gone.
        expect(readdirSync(dirname(record)), label).toEqual(["supervisor-gave-up.json"]);
      }
    });

    test("ttasksw.exe in a version folder does not supervise", () => {
      const root = install();
      const s = supervise(root, [{ exit: 0 }], 10, versionLocal(root, NEW, true));
      expect(s.status).toBe(64);
      expect(s.starts).toHaveLength(0);
    });

    test("the service is not in a job: it survives the supervisor", async () => {
      const root = install();
      const stub = join(root, "stub");
      writeFileSync(join(stub, "plan.json"), JSON.stringify([{ exit: 0, ms: 30_000 }]));
      const child = spawn(stable(root, true), [], {
        env: { ...process.env, TTASKS_STUB_DIR: stub },
        windowsHide: true,
      });
      let pid: number | undefined;
      try {
        const started = await waitUntil(
          () => readLines<StubLine>(join(stub, "log.jsonl")).some((l) => l.ev === "start"),
          20_000,
        );
        expect(started, "the stub service did not start").toBe(true);
        pid = readLines<StubLine>(join(stub, "log.jsonl"))[0]?.pid;
        expect(alive(pid ?? 0)).toBe(true);
        child.kill();
        await new Promise((resolve) => setTimeout(resolve, 1000));
        expect(alive(pid ?? 0), "the service died with ttasksw.exe").toBe(true);
      } finally {
        child.kill();
        killQuietly(pid);
      }
    });

    test("[A2.3.3.2.launcher-win.handover] a supervisor whose bin\\ttasksw.exe was replaced while it ran hands the service over to the new one; one that cannot start leaves it supervising", async () => {
      const root = install();
      const stub = join(root, "stub");
      const trace = join(stub, "trace.txt");
      const log = join(stub, "log.jsonl");
      // Another file with the same build: only the file at bin\ttasksw.exe is another one.
      copyFileSync(hooks.ttasksw, join(stub, "ttasksw-next.exe"));
      // The service renames the running supervisor's file aside, puts the new one there (as an
      // update does) and asks for a restart.
      const s = supervise(root, [{ exit: 75, replaceSupervisor: true }, { exit: 0 }], 20);
      // The supervisor the test started handed over and exited 0 at once...
      expect(s.status).toBe(0);
      // ...and the new one started the service again and stopped on its 0.
      const finished = await waitUntil(
        () => existsSync(trace) && readFileSync(trace, "utf8").includes("stop 0"),
        30_000,
      );
      expect(finished, "the new supervisor did not finish").toBe(true);
      expect(readFileSync(trace, "utf8").split("\n").filter(Boolean)).toEqual([
        "exit 75",
        "hand-over",
        "exit 0",
        "stop 0",
      ]);
      const starts = readLines<StubLine>(log).filter((l) => l.ev === "start");
      expect(starts).toHaveLength(2);
      const [first, second] = starts;
      expect(second?.ppid, "the second start comes from another supervisor").not.toBe(first?.ppid);
      expect(second?.manager).toBe("ttasksw");
      expect(await waitUntil(() => !alive(second?.ppid ?? 0), 20_000)).toBe(true);
      expect(readdirSync(join(root, "bin")).sort()).toEqual([
        "ttasks.exe",
        "ttasksw.exe",
        "ttasksw.exe.old-1",
      ]);

      // A new file that cannot run: the supervisor says so and goes on supervising itself.
      const broken = install();
      writeFileSync(join(broken, "stub", "ttasksw-next.exe"), "not a program");
      const kept = supervise(broken, [{ exit: 75, replaceSupervisor: true }, { exit: 0 }], 20);
      expect(kept.status).toBe(0);
      expect(kept.trace).toEqual(["exit 75", "hand-over-failed", "restart", "exit 0", "stop 0"]);
      expect(kept.starts.map((x) => x.ppid)).toEqual([kept.starts[0]?.ppid, kept.starts[0]?.ppid]);
      expect(kept.stderr).toMatch(/cannot start the new supervisor/);
    });

    test("[A2.3.3.2.launcher-win.handover] a replaced supervisor hands over before any restart of its service, also after a failure: a service that dies after its repair replaced ttasksw.exe, before its exit 75, is not left to the old one", async () => {
      const root = install();
      const stub = join(root, "stub");
      const trace = join(stub, "trace.txt");
      copyFileSync(hooks.ttasksw, join(stub, "ttasksw-next.exe"));
      // The service replaces the supervisor's file, then dies (no exit 75): the old supervisor
      // waits its first back-off unit and, instead of starting the service itself again, starts
      // the new one, which starts it.
      const s = supervise(root, [{ exit: 70, replaceSupervisor: true }, { exit: 0 }], 20);
      expect(s.status).toBe(0);
      const finished = await waitUntil(
        () => existsSync(trace) && readFileSync(trace, "utf8").includes("stop 0"),
        30_000,
      );
      expect(finished, "the new supervisor did not finish").toBe(true);
      expect(readFileSync(trace, "utf8").split("\n").filter(Boolean)).toEqual([
        "exit 70",
        "wait 1",
        "hand-over",
        "exit 0",
        "stop 0",
      ]);
      const starts = readLines<StubLine>(join(stub, "log.jsonl")).filter((l) => l.ev === "start");
      expect(starts).toHaveLength(2);
      expect(starts[1]?.ppid, "the second start comes from another supervisor").not.toBe(
        starts[0]?.ppid,
      );
      expect(await waitUntil(() => !alive(starts[1]?.ppid ?? 0), 20_000)).toBe(true);
    });

    test("a release build ignores the test hooks: it waits a real second and traces nothing", () => {
      const root = install(release);
      const s = supervise(root, [{ exit: 70 }, { exit: 0 }], 1);
      expect(s.status).toBe(0);
      expect(s.starts).toHaveLength(2);
      expect(s.gaps[0]).toBeGreaterThanOrEqual(1000 - CLOCK_SLACK_MS);
      expect(s.trace).toEqual([]);
    });
  },
);
