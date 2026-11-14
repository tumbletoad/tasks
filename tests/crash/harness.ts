// The crash harness (A1 5 "Crash injection", A7 3.8 M1.07, 3.18.1): a child process does real
// work on a real space folder and is killed, again and again, at random times and at the named
// fault points; after each kill the harness repairs as the service's start does and checks every
// invariant (checker.ts). `pnpm crash --minutes N` runs it (cli.ts), and a short slice runs in
// pnpm verify (crash.test.ts).
//
// A kill is a real kill of a real process: SIGKILL on Linux and macOS, TerminateProcess on Windows
// (Node's kill() with any signal). The harness records every child it starts and kills exactly
// those. Every run works in a temporary folder of its own, and leaves no process and no folder
// behind, also when it fails: the children are killed and the folder removed on the way out, and
// on the process's exit as a last resort.
//
// Deterministic by seed where the operating system allows: each round's plan and kill come from
// `<seed>:round:<n>` and the ledger, so a run with the same seed plans the same rounds. A kill at
// a named point lands at that point; a kill by timer lands wherever the child is after a seeded
// delay, which the OS's scheduling decides. A failure prints the seed, the round, the kill and the
// invariant, never task text.
//
// What a process kill cannot show, and this harness does not claim: power loss, a torn sector, a
// disk or file system that acknowledges a write it has not stored (fsync's guarantees), and an OS
// crash. A killed process loses only what it had not handed to the OS yet.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { StorageError } from "../../packages/storage/src/errors.ts";
import { nodeSqliteDriver } from "../../packages/storage/src/node-sqlite.ts";
import { finishInterruptedRestore } from "../../packages/storage/src/restore/folders.ts";
import { CheckedDriver } from "../../packages/storage/src/startup-check.ts";
import { formatAsOf } from "../../packages/storage/src/write/request.ts";
import { FIXTURE_MACHINE } from "../../packages/storage/test/fixture-requests.ts";
import { createSpaceAt } from "../../packages/storage/test/revisions.ts";
import { Rng } from "../../packages/testkit/src/rng.ts";
import { checkFolders, checkSpace } from "./checker.ts";
import { Ledger, type LedgerStats, type Violation } from "./ledger.ts";
import { buildPlan, chooseKill } from "./plan.ts";
import { ARM_VARIABLE, type ChildMessage, type Kill, type RoundPlan } from "./protocol.ts";
import { CREATE_STEPS, REVISION_0_1 } from "./steps.ts";

const CHILD = new URL("./child.ts", import.meta.url);

/** A round that has not ended after this long is a hang (a deadlock or a lost reply). */
const ROUND_LIMIT_MS = 300_000;

export interface CrashOptions {
  /** Hex text. The same seed plans the same rounds. */
  seed: string;
  /** Start no round after this many minutes. */
  minutes?: number;
  /** Run at most this many rounds. */
  rounds?: number;
  /** Kills by round, for the verify slice: round n ends as kills[n - 1] says, when it is given. */
  kills?: readonly Kill[];
  /** Rounds per space: each space lives for a seeded number of rounds in this range. */
  roundsPerSpace?: readonly [number, number];
  /** The folder for the run's temporary folder. Default: the OS temporary folder. */
  root?: string;
  log?: (line: string) => void;
  /** Also print the tail of a failed child's stderr (it holds no task text the harness wrote). */
  verbose?: boolean;
  /** Set to stop after the current round. */
  stop?: { requested: boolean };
  /** The harness's own tests: runs after each round's child is gone, before the checks. */
  afterRound?: (round: number, folder: string) => void;
  /** The harness's own tests: a stand-in module for child.ts. */
  child?: URL;
}

export interface CrashFailure {
  round: number;
  kill: string;
  violations: Violation[];
}

export interface CrashReport {
  seed: string;
  rounds: number;
  seconds: number;
  spaces: number;
  /** How each round ended: `<where>:<point>`, `timer`, or `none` (the plan ran out). */
  ended: Record<string, number>;
  /** Rounds whose armed point the plan did not reach. */
  notReached: number;
  stats: LedgerStats;
  backupsVerified: number;
  /** Every child process the run started. */
  pids: number[];
  failure: CrashFailure | undefined;
}

/** The text of a kill, for reports. */
export function killText(kill: Kill): string {
  if (kill.kind === "point") {
    const { where, point, nth, outcome } = kill.arm;
    return `${where}:${point} #${String(nth)}${outcome === undefined ? "" : ` (${outcome})`}`;
  }
  if (kill.kind === "timer") {
    return `timer ${String(kill.afterMs)} ms after ${kill.sends === 0 ? "ready" : `send #${String(kill.sends)}`}`;
  }
  return "none";
}

const codeOf = (error: unknown): string =>
  error instanceof StorageError ? error.code : error instanceof Error ? error.name : "unknown";

function newSpace(checked: CheckedDriver, run: string, n: number): Ledger {
  const parent = join(run, `s${String(n)}`);
  mkdirSync(parent);
  // At 0.1, as a released 0.1 build created it: its first writer migrates it (steps.ts).
  const created = createSpaceAt(
    checked,
    join(parent, "space"),
    { name: "Crash", ownerLabel: "Crash owner", machineId: FIXTURE_MACHINE.id, refPrefix: "CR" },
    CREATE_STEPS,
  );
  const ledger = new Ledger(created.folder, created.space.spaceId, created.actors.human);
  const { authority } = created.space;
  ledger.incarnation = authority.incarnation;
  ledger.epoch = authority.epoch;
  ledger.epochs.add(authority.epoch);
  ledger.revision = REVISION_0_1;
  ledger.base = formatAsOf({ ...authority, seq: created.space.lastSeq });
  return ledger;
}

interface RoundEnd {
  ended: string;
  armedNotReached: boolean;
  violations: Violation[];
  stderr: string;
}

/** Runs one child for one round and ends it as `kill` says. */
async function runChild(
  module: URL,
  plan: RoundPlan,
  kill: Kill,
  ledger: Ledger,
  children: Set<ChildProcess>,
  pids: number[],
): Promise<RoundEnd> {
  const child = spawn(process.execPath, [fileURLToPath(module)], {
    env: { ...process.env, [ARM_VARIABLE]: plan.arm === null ? "" : JSON.stringify(plan.arm) },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  children.add(child);
  if (child.pid !== undefined) pids.push(child.pid);
  const violations: Violation[] = [];
  // Set from the child's events, read once it has closed.
  const state: {
    killed: boolean;
    done: boolean;
    hung: boolean;
    at: string | undefined;
    failure: { during: string; code: string } | undefined;
  } = { killed: false, done: false, hung: false, at: undefined, failure: undefined };
  let stderr = "";
  // Killed only when the signal reached a live child: kill() returns false for a child that had
  // already ended on its own, which is then judged by how it ended.
  let killing = false;
  const end = (): void => {
    if (killing) return;
    killing = true;
    state.killed = child.kill("SIGKILL");
  };
  let timer: NodeJS.Timeout | undefined;
  let sends = 0;
  const startTimer = (afterMs: number): void => {
    timer ??= setTimeout(end, afterMs);
  };
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message: ChildMessage;
    try {
      message = JSON.parse(line) as ChildMessage;
    } catch {
      violations.push({
        invariant: "harness",
        detail: "the child wrote a line that is no message",
      });
      return;
    }
    violations.push(...ledger.take(message));
    if (message.t === "at") {
      const outcome = plan.arm?.outcome;
      state.at = `${message.where}:${message.point}${outcome === undefined ? "" : `:${outcome}`}`;
      end();
    } else if (message.t === "ready" && kill.kind === "timer" && kill.sends === 0) {
      startTimer(kill.afterMs);
    } else if (message.t === "send" && kill.kind === "timer") {
      sends += 1;
      if (sends === kill.sends) startTimer(kill.afterMs);
    } else if (message.t === "error") state.failure = message;
    else if (message.t === "done") state.done = true;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4096);
  });
  // A child killed before it read its plan closes the pipe under the write.
  child.stdin.on("error", () => undefined);
  child.stdin.end(JSON.stringify(plan));
  const watchdog = setTimeout(() => {
    state.hung = true;
    end();
  }, ROUND_LIMIT_MS);
  const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on("close", (code, signal) => {
      resolve({ code, signal });
    });
    // A child that could not start.
    child.on("error", () => {
      resolve({ code: null, signal: "not started" });
    });
  });
  clearTimeout(timer);
  clearTimeout(watchdog);
  children.delete(child);

  // An error the child reported is a failure however the round ended: a kill at another thread's
  // point a moment later must not hide it. A kill never makes the child report one.
  const { failure } = state;
  if (failure !== undefined) {
    violations.push({
      invariant: "child-failed",
      detail: `${failure.during} failed (${failure.code})`,
    });
  }
  if (state.hung) {
    violations.push({
      invariant: "child-hung",
      detail: `the round did not end within ${String(ROUND_LIMIT_MS / 1000)} s`,
    });
    return { ended: "hung", armedNotReached: false, violations, stderr };
  }
  if (state.done && exit.code === 0) {
    return { ended: "none", armedNotReached: plan.arm !== null, violations, stderr };
  }
  if (state.killed) {
    return { ended: state.at ?? "timer", armedNotReached: false, violations, stderr };
  }
  if (failure === undefined) {
    violations.push({
      invariant: "child-failed",
      detail: `the child exited with ${String(exit.code ?? exit.signal)}`,
    });
  }
  return { ended: "failed", armedNotReached: false, violations, stderr };
}

/** Runs the crash harness. Resolves with the report; a violation is in `failure`. */
export async function runCrash(options: CrashOptions): Promise<CrashReport> {
  const log = options.log ?? (() => undefined);
  const started = performance.now();
  const deadline = options.minutes === undefined ? Infinity : started + options.minutes * 60_000;
  const maxRounds = options.rounds ?? Infinity;
  const [minRounds, maxPerSpace] = options.roundsPerSpace ?? [8, 24];
  const run = mkdtempSync(join(options.root ?? tmpdir(), "tasks-crash-"));
  const children = new Set<ChildProcess>();
  // The last resort when the harness's own process ends without its cleanup: kill what it
  // started, by the handles it holds, and remove its folder.
  const onExit = (): void => {
    for (const child of children) child.kill("SIGKILL");
    rmSync(run, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  };
  process.on("exit", onExit);

  const report: CrashReport = {
    seed: options.seed,
    rounds: 0,
    seconds: 0,
    spaces: 0,
    ended: {},
    notReached: 0,
    stats: { acked: 0, replays: 0, backups: 0, migrations: 0, restores: 0, actors: 0 },
    backupsVerified: 0,
    pids: [],
    failure: undefined,
  };
  const verified = new Set<string>();
  let ledger: Ledger | undefined;
  const addStats = (from: Ledger): void => {
    for (const key of Object.keys(report.stats) as (keyof LedgerStats)[]) {
      report.stats[key] += from.stats[key];
    }
  };
  try {
    const checked = await CheckedDriver.check(nodeSqliteDriver);
    let lastLog = started;
    let spaceEnds = 0;
    for (let round = 1; round <= maxRounds && performance.now() < deadline; round += 1) {
      if (options.stop?.requested === true) break;
      if (ledger === undefined || round > spaceEnds) {
        if (ledger !== undefined) {
          addStats(ledger);
          rmSync(ledger.parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
        }
        report.spaces += 1;
        spaceEnds =
          round -
          1 +
          new Rng(`${options.seed}:space:${String(report.spaces)}`).range(minRounds, maxPerSpace);
        ledger = newSpace(checked, run, report.spaces);
      }
      const rng = new Rng(`${options.seed}:round:${String(round)}`);
      const kill = options.kills?.[round - 1] ?? chooseKill(rng, ledger);
      const plan = buildPlan(rng, ledger, round, kill);
      const migrations = ledger.stats.migrations;
      const end = await runChild(options.child ?? CHILD, plan, kill, ledger, children, report.pids);
      report.rounds = round;
      report.ended[end.ended] = (report.ended[end.ended] ?? 0) + 1;
      if (end.armedNotReached) report.notReached += 1;
      options.afterRound?.(round, ledger.folder);

      const violations = [...end.violations, ...checkFolders(ledger)];
      // What the service runs before a space opens (A1 3.18): complete an interrupted swap.
      try {
        finishInterruptedRestore(ledger.folder);
      } catch (error) {
        violations.push({
          invariant: "restart",
          detail: `finishing a restore failed (${codeOf(error)})`,
        });
      }
      const checkedSpace = await checkSpace(checked, ledger, verified);
      violations.push(...checkedSpace.violations);
      if (violations.length > 0) {
        if (options.verbose === true && end.stderr !== "") log(end.stderr);
        report.failure = { round, kill: killText(kill), violations };
        break;
      }
      const observed = checkedSpace.observed;
      if (observed !== undefined) {
        const { space } = observed;
        ledger.highWater.set(space.authority.incarnation, {
          seq: space.lastSeq,
          nextRef: space.nextRef,
        });
        // A migration the kill cut off after its COMMIT was never reported: count it as found.
        if (
          ledger.stats.migrations === migrations &&
          ledger.revision === REVISION_0_1 &&
          observed.revision !== REVISION_0_1
        ) {
          ledger.stats.migrations += 1;
        }
        ledger.revision = observed.revision;
        ledger.base = observed.base;
      }
      if (performance.now() - lastLog > 30_000) {
        lastLog = performance.now();
        log(
          `crash: ${String(Math.round((lastLog - started) / 1000))} s, ${String(round)} rounds, ${String(report.spaces)} spaces, no violation`,
        );
      }
    }
  } finally {
    for (const child of children) child.kill("SIGKILL");
    await Promise.all(
      [...children].map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) resolve();
            else {
              child.on("close", () => {
                resolve();
              });
            }
          }),
      ),
    );
    process.off("exit", onExit);
    rmSync(run, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
  if (ledger !== undefined) addStats(ledger);
  report.backupsVerified = verified.size;
  report.seconds = (performance.now() - started) / 1000;
  return report;
}
