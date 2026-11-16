// R03 (A1 M0 item 2): commit latency of one-task patches with synchronous=FULL, in the space
// folder the caller names (the lab uses ~/Tasks), plus receipt-only commits.
// Pass: p95 <= 10 ms for the `windows` role, <= 25 ms for the `linux` role.
import { summaryText } from "./fixture.ts";
import { withConnection } from "./connection.ts";
import {
  condition,
  type Context,
  fullScale,
  type RowResult,
  summarize,
  verdict,
} from "./results.ts";
import { Rng } from "./rng.ts";
import { openWriter, SpaceWriter } from "./space.ts";

export interface R03Options {
  primary: string;
  patches: number;
}

/** The prescribed count of A7 3.7 R03. */
export const PATCHES = 1000;

export function r03(ctx: Context, o: R03Options): RowResult {
  return withConnection(openWriter(o.primary), (db) => {
    const synchronous = (db.prepare("PRAGMA synchronous").get() as { synchronous: number })
      .synchronous;
    const journal = (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string })
      .journal_mode;
    const writer = new SpaceWriter(db, `r03-${ctx.seed}`);
    const rng = new Rng(`${ctx.seed}/r03`);
    const patch: number[] = [];
    for (let i = 1; i <= o.patches; i++) {
      const ref = rng.pick(writer.openRefs);
      const text = summaryText(rng);
      const t0 = performance.now();
      writer.patchSummary(ref, text);
      patch.push(performance.now() - t0);
    }
    const receipt: number[] = [];
    for (let i = 1; i <= o.patches; i++) {
      const t0 = performance.now();
      writer.receiptOnly();
      receipt.push(performance.now() - t0);
    }
    const latency = summarize(patch);
    const limit = ctx.machine.role === "windows" ? 10 : 25;
    // A7 3.7: 1,000 one-task patches on the design-scale database.
    const v = verdict(
      [
        fullScale(ctx),
        condition("patches", String(PATCHES), latency.count, latency.count === PATCHES),
      ],
      () => latency.p95 <= limit,
    );
    return {
      row: "R03",
      title: `commit latency, ${String(o.patches)} one-task patches, synchronous=FULL`,
      threshold: `p95 <= ${String(limit)} ms (${ctx.machine.role}; windows 10 ms, linux 25 ms)`,
      ...v,
      latency,
      metrics: {
        patches: o.patches,
        // PRAGMA synchronous reports 2 for FULL.
        synchronous: synchronous === 2 ? "FULL" : String(synchronous),
        journalMode: journal,
        receiptOnly: summarize(receipt),
        p50TargetMs: ctx.machine.role === "windows" ? 3 : null,
      },
    };
  });
}
