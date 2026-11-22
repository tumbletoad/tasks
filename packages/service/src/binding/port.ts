// The sessions port the request path and the bind share (ops/binding.ts `SessionPort`): the one
// rule (decide.ts) over the hub's readers, logged. A presented value is never logged, only how it
// bound or why it did not.
import type { BoundBy, SessionPort, UnboundReason } from "../ops/index.ts";
import { decide, standing, type DecideSources } from "./decide.ts";

/** Content-free events for the hub's log (`binding.*` in log.ts). */
export type BindingEvent =
  | { readonly ev: "binding.bound"; readonly how: BoundBy }
  | { readonly ev: "binding.unbound"; readonly reason: UnboundReason };

export interface SessionPortOptions extends DecideSources {
  /** How many live sessions each task of a space has: running launches and running runs. */
  live(space: string): ReadonlyMap<string, number>;
  readonly log?: (event: BindingEvent) => void;
}

export function sessionPort(options: SessionPortOptions): SessionPort {
  return {
    decide(presented) {
      const decision = decide(options, presented);
      if (decision.kind === "session") {
        options.log?.({ ev: "binding.bound", how: decision.by });
      } else if (decision.kind === "none" && decision.reason !== undefined) {
        options.log?.({ ev: "binding.unbound", reason: decision.reason });
      }
      return decision;
    },
    standing: (home) => standing(options, home),
    live: (space) => options.live(space),
  };
}
