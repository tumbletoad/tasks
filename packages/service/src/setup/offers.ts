// The [[instance]] entries setup offers for machine.toml: what Open starts an agent with. The
// command line's `ttasks setup instances` and the page's agent apps show and write the same entries.
import type { InstanceValue } from "@ttasks/launch";
import { keyText, valueText, type EditValue } from "../config/edit.ts";

/** One proposal setup offers: the entry it writes, keys in their order. */
export interface Offer {
  readonly id: string;
  readonly label: string;
  readonly entry: ReadonlyMap<string, InstanceValue>;
  /** A T3 instance: where its model came from (Proposal `t3.modelFrom`). */
  readonly modelFrom?: "t3" | "catalogue";
}

/** The block machine.toml gets for an entry, as its editor writes it. */
export const blockOf = (entry: ReadonlyMap<string, InstanceValue | EditValue>): string[] => [
  "[[instance]]",
  ...[...entry].map(([k, v]) => `${keyText(k)} = ${valueText(v)}`),
];

/** An entry as the service's `instances/add` takes it. */
export const wireOf = (entry: ReadonlyMap<string, InstanceValue>): Record<string, unknown> =>
  Object.fromEntries([...entry].map(([k, v]) => [k, Array.isArray(v) ? [...(v as string[])] : v]));
