// A write the service refused because the space takes no change at all (`read_only`): a restored
// copy not claimed yet, a space another machine owns, one in a synced folder. Trying again cannot
// work, so what the person typed stays with them and the page says why, never "Try again".
import type { Msg } from "../row/model.ts";

/** The reason of a `read_only` refusal (a fixed word, such as `read_only_copy`), else undefined. */
export function readOnlyReason(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const { code, data } = error as Error & { code?: unknown; data?: unknown };
  if (code !== "read_only") return undefined;
  const reason =
    typeof data === "object" && data !== null ? (data as Record<string, unknown>)["reason"] : "";
  return typeof reason === "string" ? reason : "";
}

/** Why the space takes no change, in a few words, for the place the person acted. */
export const readOnlyWhy = (reason: string): Msg => ({
  id: "space.readOnlyWhy",
  values: { reason },
});
