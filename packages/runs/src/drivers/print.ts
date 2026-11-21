// The driver of an agent's print mode: it takes its input on stdin, prints its events as JSON
// lines, and settles by exiting. Its work is what the stream parser (streams/) judges from those
// lines and the exit. It has no protocol to stop it: a Stop interrupts the process.
import type { RunOutcome } from "@ttasks/contracts/runs";
import { createStreamParser, type StreamKind } from "../streams/index.ts";
import type { OpenDriver, Work } from "./types.ts";

/** The work a print-mode run's parser judged. */
export function workOf(outcome: RunOutcome): Work {
  return {
    ok: outcome.ok,
    outcome: outcome.reason,
    nativeId: outcome.nativeId,
    text: outcome.result,
    textCut: outcome.resultCut,
    textFinal: outcome.resultFinal,
    error: outcome.error,
    usage: outcome.usage,
    appTools: outcome.session?.appTools ?? null,
    declined: outcome.counts.declined,
    permissionDenials: outcome.counts.permissionDenials,
  };
}

/** A print-mode driver for `kind`'s stream, given `input` on stdin, which then ends. */
export function printDriver(kind: StreamKind, input = ""): OpenDriver {
  return ({ stdin, stdout }, report) => {
    const parser = createStreamParser(kind);
    let settle: (work: Work) => void = () => undefined;
    const settled = new Promise<Work>((resolve) => {
      settle = resolve;
    });
    stdout.on("data", (chunk: Buffer) => {
      for (const event of parser.push(chunk)) report(event);
    });
    stdin.end(input);
    return {
      settled,
      interrupt: () => false,
      close: () => {
        stdin.end();
      },
      ended: (exit) => {
        const { events, outcome } = parser.end(exit);
        for (const event of events) report(event);
        settle(workOf(outcome));
      },
    };
  };
}
