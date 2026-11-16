// Percentiles, the result-file shape and the console lines every benchmark shares. Results hold
// numbers, counts and machine facts only: no task text, no paths and no host name.
import { writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Row = "R02" | "R03" | "R04" | "R05" | "R06";
export type MachineRole = "windows" | "linux";

export interface Latency {
  count: number;
  /** Milliseconds, nearest-rank percentiles. */
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export interface Machine {
  role: MachineRole;
  platform: NodeJS.Platform;
  release: string;
  arch: string;
  cpu: string;
  cpus: number;
  memoryGiB: number;
  node: string;
  sqlite: string;
}

/** The text profile of the corpora (fixture.ts). "default" keeps the calibrated corpus. */
export type TextProfile = "default" | "heavy";

export interface Context {
  scale: number;
  seed: string;
  text: TextProfile;
  machine: Machine;
  out: string;
}

/** One prescribed condition of a row: the scale, a count or a duration of A7 3.7 and A1 3.20. */
export interface Condition {
  name: string;
  required: string;
  actual: number | string;
  met: boolean;
}

export const condition = (
  name: string,
  required: string,
  actual: number | string,
  met: boolean,
): Condition => ({ name, required, actual, met });

/** Tasks in one design-scale space (A1 3.20): 5,000 open and 50,000 completed. */
export const DESIGN_TASKS = 55_000;

/** Every row runs on the full-scale corpora (A1 3.20) or is indicative only. */
export const fullScale = (ctx: Context): Condition =>
  condition("scale", "1", ctx.scale, ctx.scale === 1);

/**
 * A verdict is given only when every prescribed condition holds. Otherwise the run is indicative:
 * judged false and pass null, whatever its numbers say.
 */
export function verdict(
  conditions: Condition[],
  pass: () => boolean,
): { judged: boolean; pass: boolean | null; conditions: Condition[] } {
  const judged = conditions.every((c) => c.met);
  return { judged, pass: judged ? pass() : null, conditions };
}

export interface RowResult {
  row: Row;
  title: string;
  /** The row's pass condition, as A7 3.7 states it. */
  threshold: string;
  /**
   * True only when the run met every prescribed condition (`conditions`). Otherwise the result is
   * indicative: a 1 % run or a shortened run proves the bench works, not the machine.
   */
  judged: boolean;
  pass: boolean | null;
  conditions: Condition[];
  /** The headline latency of the row. */
  latency: Latency;
  metrics: Record<string, unknown>;
}

/** The names and values of the conditions a run did not meet, for the console and summary. */
export const unmet = (r: RowResult): string[] =>
  r.conditions
    .filter((c) => !c.met)
    .map((c) => `${c.name} ${String(c.actual)} (needs ${c.required})`);

const round = (ms: number): number => Math.round(ms * 1000) / 1000;

/** Nearest-rank percentiles of durations in milliseconds. */
export function summarize(samples: ArrayLike<number>): Latency {
  const sorted = Float64Array.from(samples).sort();
  const n = sorted.length;
  if (n === 0) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const at = (p: number): number => sorted[Math.min(n - 1, Math.ceil((p / 100) * n) - 1)] ?? 0;
  let sum = 0;
  for (const v of sorted) sum += v;
  return {
    count: n,
    p50: round(at(50)),
    p95: round(at(95)),
    p99: round(at(99)),
    max: round(sorted[n - 1] ?? 0),
    mean: round(sum / n),
  };
}

export function machine(role: MachineRole): Machine {
  const db = new DatabaseSync(":memory:");
  let sqlite: string;
  try {
    sqlite = (db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
  } finally {
    db.close();
  }
  return {
    role,
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    cpu: os.cpus()[0]?.model.trim() ?? "unknown",
    cpus: os.availableParallelism(),
    memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    node: process.version,
    sqlite,
  };
}

const ms = (v: number): string => `${v.toFixed(2)} ms`;

/** Prints the row's percentiles and threshold, and writes <out>/<row>.json. */
export function report(ctx: Context, result: RowResult): void {
  const l = result.latency;
  console.log(
    `${result.row} ${result.title}: n ${String(l.count)}  p50 ${ms(l.p50)}  p95 ${ms(l.p95)}  p99 ${ms(l.p99)}  max ${ms(l.max)}`,
  );
  const verdictText = result.judged
    ? result.pass === true
      ? "PASS"
      : "FAIL"
    : `not judged, indicative only: ${unmet(result).join("; ")}`;
  console.log(`${result.row} threshold: ${result.threshold} -> ${verdictText}`);
  writeJson(join(ctx.out, `${result.row}.json`), {
    ...result,
    indicative: !result.judged,
    complete: true,
    scale: ctx.scale,
    seed: ctx.seed,
    text: ctx.text,
    machine: ctx.machine,
    finishedAt: new Date().toISOString(),
  });
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
