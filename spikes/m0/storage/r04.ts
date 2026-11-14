// R04 (A1 3.20): 10 writers at one write per second each, through one writer worker with its
// queue (A1 3.9). Each writer is one agent session. Latency runs from the request leaving the main
// thread to its reply arriving. Pass: p95 <= 25 ms and no STORAGE_OVERLOADED. The lab runs 5
// minutes. A shorter run (CI, or a quick probe with --r04-seconds) is indicative only.
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

export interface R04Options {
  primary: string;
  writers: number;
  seconds: number;
}

const LIMIT_MS = 25;
/** The prescribed load of A7 3.7 R04: 10 writers for 5 minutes. */
export const WRITERS = 10;
export const SECONDS = 300;

export async function r04(ctx: Context, o: R04Options): Promise<RowResult> {
  const worker = new BenchWorker({
    role: "queue",
    name: "r04-queue",
    paths: [o.primary],
    seed: ctx.seed,
    sessions: o.writers,
  });
  // Stops the senders when the run ends early, so no timer outlives a failed run.
  const stop = new AbortController();
  let senders: Promise<unknown> = Promise.resolve();
  try {
    await worker.next("ready");
    const sentAt = new Map<number, number>();
    const latencies: number[] = [];
    const commits: number[] = [];
    let overloaded = 0;
    let replies = 0;
    const total = o.writers * o.seconds;
    let allReplied: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      allReplied = resolve;
    });
    worker.onPatched = (reply) => {
      const t = sentAt.get(reply.id);
      if (t !== undefined) latencies.push(performance.now() - t);
      if (reply.overloaded) overloaded += 1;
      else commits.push(reply.commitMs);
      replies += 1;
      if (replies === total) allReplied();
    };

    const start = performance.now() + 50;
    let id = 0;
    // Each writer sends once per second, the writers spread evenly over the second. Timers on
    // Windows fire on a coarse tick, so sends may slip a few milliseconds. Latency is measured
    // from the actual send.
    const { signal } = stop;
    const writer = async (w: number): Promise<void> => {
      for (let k = 0; k < o.seconds; k++) {
        const due = start + k * 1000 + (w * 1000) / o.writers;
        const wait = due - performance.now();
        // An aborted sleep rejects at once. The check below then ends the loop.
        if (wait > 0) await sleep(wait, undefined, { signal }).catch(() => undefined);
        if (signal.aborted) return;
        id += 1;
        sentAt.set(id, performance.now());
        worker.send({ type: "patch", id, writer: w });
      }
    };
    senders = Promise.all(Array.from({ length: o.writers }, (_, w) => writer(w)));
    await Promise.race([senders, worker.failed]);
    await Promise.race([done, worker.failed]);
    worker.send({ type: "stop" });
    const stats = await worker.next("writer-stats");

    const latency = summarize(latencies);
    // Judged only under the prescribed load: 10 writers, at least 300 s, and every request
    // answered as a sample. A shorter run is indicative.
    const v = verdict(
      [
        fullScale(ctx),
        condition("writers", String(WRITERS), o.writers, o.writers === WRITERS),
        condition("seconds", `>= ${String(SECONDS)}`, o.seconds, o.seconds >= SECONDS),
        condition("answered requests", String(total), latency.count, latency.count === total),
      ],
      () => latency.p95 <= LIMIT_MS && overloaded === 0,
    );
    return {
      row: "R04",
      title: `${String(o.writers)} writers x 1 write/s for ${String(o.seconds)} s, request to reply`,
      threshold: `p95 <= ${String(LIMIT_MS)} ms and no STORAGE_OVERLOADED`,
      ...v,
      latency,
      metrics: {
        writers: o.writers,
        sessions: stats.sessions,
        seconds: o.seconds,
        requests: total,
        overloaded,
        writerCommit: summarize(commits),
      },
    };
  } finally {
    stop.abort();
    // A sender error already surfaced through the race above. Here only its settlement counts.
    await senders.catch(() => undefined);
    await worker.terminate();
  }
}
