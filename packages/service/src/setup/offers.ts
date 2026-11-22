// The [[instance]] entries setup offers for machine.toml: what Open starts an agent with. The
// command line's `ttasks setup instances` and the page's agent apps show and write the same entries.
import { posix, win32 } from "node:path";
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

/**
 * Offers a person can tell apart: two of one app (two Codex homes) are each labelled with their
 * home's folder name, such as `Codex (.codex-second)`, in the preview and in the entry, whose
 * label names the instance's tile.
 */
export function distinctLabels<O extends Offer>(
  offers: readonly O[],
  homes: ReadonlyMap<string, string>,
  platform: NodeJS.Platform,
): O[] {
  const name = (path: string) => (platform === "win32" ? win32 : posix).basename(path);
  return offers.map((offer) => {
    const home = homes.get(offer.id);
    const shared = offers.filter((other) => other.label === offer.label).length > 1;
    if (!shared || home === undefined) return offer;
    const label = `${offer.label} (${name(home)})`;
    const entry = new Map(offer.entry);
    if (entry.get("label") === offer.label) entry.set("label", label);
    return { ...offer, label, entry };
  });
}

/** The block machine.toml gets for an entry, as its editor writes it. */
export const blockOf = (entry: ReadonlyMap<string, InstanceValue | EditValue>): string[] => [
  "[[instance]]",
  ...[...entry].map(([k, v]) => `${keyText(k)} = ${valueText(v)}`),
];

/** An entry as the service's `instances/add` takes it. */
export const wireOf = (entry: ReadonlyMap<string, InstanceValue>): Record<string, unknown> =>
  Object.fromEntries([...entry].map(([k, v]) => [k, Array.isArray(v) ? [...(v as string[])] : v]));
