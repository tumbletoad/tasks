// pnpm crash: runs the crash harness (harness.ts) and prints its summary.
//
//   pnpm crash --minutes N [--seed HEX]   run rounds for N minutes (A7 3.18: 5 per PR, 30 nightly)
//   pnpm crash --rounds N --seed HEX      replay the first N rounds of a seed
//
// It exits with 0 when every round was clean, 1 on a violation (with the seed, the round, the kill
// and the invariant, and the command that replays it), and 2 when it could not run.
// First, as in the product's entries: this script ends through process.exit (A2 3.12.1).
import "../../packages/bridge/src/safe-exit.ts";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { runCrash, type CrashReport } from "./harness.ts";

const USAGE = "usage: pnpm crash --minutes N [--seed HEX] | --rounds N --seed HEX [--verbose]";

function parse(): { minutes?: number; rounds?: number; seed: string; verbose: boolean } {
  const { values } = parseArgs({
    options: {
      minutes: { type: "string" },
      rounds: { type: "string" },
      seed: { type: "string" },
      verbose: { type: "boolean", default: false },
    },
    strict: true,
  });
  const number = (text: string | undefined): number | undefined => {
    if (text === undefined) return undefined;
    const n = Number(text);
    if (!Number.isFinite(n) || n <= 0) throw new Error(USAGE);
    return n;
  };
  const minutes = number(values.minutes);
  const rounds = number(values.rounds);
  if (minutes === undefined && rounds === undefined) throw new Error(USAGE);
  const seed = values.seed ?? randomBytes(8).toString("hex");
  if (!/^[0-9a-f]{1,32}$/i.test(seed)) throw new Error("a seed is 1 to 32 hex digits");
  return {
    ...(minutes === undefined ? {} : { minutes }),
    ...(rounds === undefined ? {} : { rounds: Math.floor(rounds) }),
    seed: seed.toLowerCase(),
    verbose: values.verbose,
  };
}

const count = (n: number): string => n.toLocaleString("en-US");

export function summary(report: CrashReport): string[] {
  const ended = Object.entries(report.ended);
  const points = ended
    .filter(([name]) => name.includes(":"))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, n]) => `${name} ${count(n)}`);
  const atPoints = ended.filter(([name]) => name.includes(":")).reduce((s, [, n]) => s + n, 0);
  const s = report.stats;
  return [
    `crash: ${count(report.rounds)} rounds in ${report.seconds.toFixed(1)} s on ${report.spaces === 1 ? "1 space" : `${count(report.spaces)} spaces`} (${process.platform} ${process.arch}, Node ${process.version}), seed ${report.seed}`,
    `crash: kills at named points ${count(atPoints)}, by timer ${count(report.ended["timer"] ?? 0)}; rounds that ran to the end ${count(report.ended["none"] ?? 0)} (armed point not reached in ${count(report.notReached)})`,
    `crash: points killed at: ${points.join(", ") || "none"}`,
    `crash: checked after every round: ${count(s.acked)} acknowledged results (${count(s.replays)} replays), ${count(report.backupsVerified)} backups verified (${count(s.backups)} completed), ${count(s.migrations)} migrations, ${count(s.restores)} restores in place, ${count(s.actors)} agent actors joined`,
  ];
}

async function main(): Promise<number> {
  let args;
  try {
    args = parse();
  } catch (error) {
    console.error(error instanceof Error ? error.message : USAGE);
    return 2;
  }
  const stop = { requested: false };
  process.on("SIGINT", () => {
    if (stop.requested) process.exit(130);
    stop.requested = true;
    console.error("crash: stopping after this round (Ctrl+C again to stop now)");
  });
  // Stop now: the harness's exit handler kills the children it started and removes its folder.
  process.on("SIGTERM", () => process.exit(143));
  console.log(
    `crash: seed ${args.seed}, ${args.minutes === undefined ? `${String(args.rounds)} rounds` : `${String(args.minutes)} minutes`}`,
  );
  let report: CrashReport;
  try {
    report = await runCrash({
      seed: args.seed,
      ...(args.minutes === undefined ? {} : { minutes: args.minutes }),
      ...(args.rounds === undefined ? {} : { rounds: args.rounds }),
      log: (line) => {
        console.log(line);
      },
      verbose: args.verbose,
      stop,
    });
  } catch (error) {
    // The harness itself broke, not an invariant: its error's name and code only.
    const code = (error as { code?: unknown } | null)?.code;
    const name = error instanceof Error ? error.name : "unknown";
    console.error(
      `crash: the harness failed (${name}${typeof code === "string" ? ` ${code}` : ""}), seed ${args.seed}`,
    );
    return 2;
  }
  for (const line of summary(report)) console.log(line);
  const failure = report.failure;
  if (failure === undefined) {
    console.log("crash: clean");
    return 0;
  }
  console.error(
    `crash: VIOLATION in round ${String(failure.round)} (kill ${failure.kill}), seed ${report.seed}`,
  );
  // Each broken invariant, with its first few details: one lost commit can break dozens of rows.
  const byInvariant = Map.groupBy(failure.violations, (v) => v.invariant);
  for (const [invariant, found] of byInvariant) {
    for (const v of found.slice(0, 3)) console.error(`crash:   ${invariant}: ${v.detail}`);
    if (found.length > 3)
      console.error(`crash:   ${invariant}: and ${String(found.length - 3)} more`);
  }
  console.error(
    `crash: replay with: pnpm crash --seed ${report.seed} --rounds ${String(failure.round)}`,
  );
  return 1;
}

process.exit(await main());
