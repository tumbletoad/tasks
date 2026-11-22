// `doctor/sessions`: what doctor's sessions row reads of the bridges, the connections open now
// and how many of them are the session of a launch or of a run. Counts only.
import type { JsonObject } from "@ttasks/bridge/protocol";
import type { Bridges } from "./bridges.ts";

export function sessionFacts(bridges: Pick<Bridges, "open">): JsonObject {
  const { connections, launch, run } = bridges.open;
  return { open: connections, sessions: { launch, run } };
}
