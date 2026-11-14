// R02 (A1 M0 item 1): one writer and two reader workers on one WAL database, and a single-step
// backup() of the design-scale database while they run, then integrity_check on the copy.
// Pass: it works, and the backup with its integrity check takes at most 30 s (A1 3.20).
import { statSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import {
  condition,
  type Context,
  fullScale,
  type RowResult,
  summarize,
  verdict,
} from "./results.ts";
import { BenchWorker } from "./threads.ts";

export interface R02Options {
  primary: string;
  second: string;
  backupTarget: string;
  /** Minimum time the writer and readers run, in seconds. */
  seconds: number;
}

const LIMIT_MS = 30_000;
/** The bench's run time at full scale. A7 3.7 prescribes no duration, so a shorter run is a probe. */
export const SECONDS = 10;

export async function r02(ctx: Context, o: R02Options): Promise<RowResult> {
  const seed = ctx.seed;
  // Every worker started is terminated, even when a later one fails to start.
  const all: BenchWorker[] = [];
  const start = (config: ConstructorParameters<typeof BenchWorker>[0]): BenchWorker => {
    const worker = new BenchWorker(config);
    all.push(worker);
    return worker;
  };
  try {
    // The writer opens first and is ready (WAL set, schema read) before any reader opens, as in
    // the product (A1 3.9).
    const writer = start({
      role: "writer",
      name: "r02-writer",
      paths: [o.primary],
      seed,
      pauseMs: 2,
    });
    await writer.next("ready");
    const readers = [1, 2].map((i) =>
      start({
        role: "reader",
        name: `r02-reader-${String(i)}`,
        paths: [o.primary, o.second],
        seed,
      }),
    );
    const maintenance = start({
      role: "maintenance",
      name: "r02-maintenance",
      paths: [o.primary],
      seed,
    });
    await Promise.all([...readers, maintenance].map((w) => w.next("ready")));
    const started = performance.now();
    for (const w of [writer, ...readers]) w.send({ type: "start" });
    await sleep(Math.min(1000, (o.seconds * 1000) / 4));

    maintenance.send({ type: "backup", target: o.backupTarget });
    const backup = await maintenance.next("backup-done");

    const left = o.seconds * 1000 - (performance.now() - started);
    if (left > 0) await sleep(left);
    for (const w of [writer, ...readers]) w.send({ type: "stop" });
    const writes = await writer.next("writer-stats");
    const reads = await Promise.all(readers.map((r) => r.next("reader-stats")));

    const byRef = reads.flatMap((r) => [...r.byRef]);
    const openView = reads.flatMap((r) => [...r.openView]);
    const consistencyErrors = reads.reduce((n, r) => n + r.consistencyErrors, 0);
    const totalMs = backup.backupMs + backup.integrityMs;
    const works =
      backup.integrity === "ok" &&
      consistencyErrors === 0 &&
      writes.commits.length > 0 &&
      byRef.length > 0 &&
      backup.steps === 1;
    const v = verdict(
      [
        fullScale(ctx),
        condition("seconds", `>= ${String(SECONDS)}`, o.seconds, o.seconds >= SECONDS),
      ],
      () => works && totalMs <= LIMIT_MS,
    );
    return {
      row: "R02",
      title: "1 writer + 2 readers on one WAL database, reader get-by-reference latency",
      threshold:
        "works (integrity ok, readers consistent, one backup step) and backup + integrity_check <= 30 s",
      ...v,
      latency: summarize(byRef),
      metrics: {
        works,
        databaseBytes: statSync(o.primary).size,
        backupBytes: statSync(o.backupTarget).size,
        backupMs: Math.round(backup.backupMs),
        integrityMs: Math.round(backup.integrityMs),
        backupPlusIntegrityMs: Math.round(totalMs),
        backupSteps: backup.steps,
        backupPages: backup.pages,
        backupLastSeq: backup.lastSeq,
        integrity: backup.integrity,
        writerCommits: writes.commits.length,
        writerCommit: summarize(writes.commits),
        readerQueries: byRef.length + openView.length,
        getByReference: summarize(byRef),
        openView: summarize(openView),
        consistencyChecks: reads.reduce((n, r) => n + r.consistencyChecks, 0),
        consistencyErrors,
        runMs: Math.round(performance.now() - started),
      },
    };
  } finally {
    await Promise.all(all.map((w) => w.terminate()));
  }
}
