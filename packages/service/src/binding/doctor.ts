// `doctor/sessions`: what doctor's sessions row reads of the bridges, the connections open now.
// No connection carries two conversations any more and nothing is kept on disk, so `shared` is
// empty and `dropped` is 0: the shape stays until doctor's words change with it.
import type { JsonObject } from "@ttasks/bridge/protocol";

export function sessionFacts(bridges: { readonly open: number }): JsonObject {
  return { open: bridges.open, shared: [], dropped: 0 };
}
