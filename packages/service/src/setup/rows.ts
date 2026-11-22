// A home's agent-home row in the service's grants table (hub/agent-homes.ts) and its entry go
// together: the row is asked for first, the entry written after, and a row made for an entry that
// was not written is taken back. The command line and the page both register a home this way.
import { AppError } from "@ttasks/contracts";
import { applyHome, type Outcome, type PlanItem, type SetupInput } from "./agents.ts";

/** One of the service's `setup/*` verbs. It throws an AppError when the service refuses. */
export type RowCall = (
  method: "setup/home_grant" | "setup/home_revoke",
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** One home's apply: its agent-home row first (the service checks the caller), then the entry. */
export async function applyWithRow(
  input: SetupInput,
  item: PlanItem,
  space: string,
  call: RowCall,
): Promise<Outcome> {
  const { view, change } = item;
  const { home } = view;
  // A registered home's row is renewed for the space its entry names, unless this apply names a
  // space for new entries: an entry of another space is then left (`other_space`).
  const target = view.state === "registered" && space === "" ? (view.record?.space ?? "") : space;
  const registered = view.state === "registered" && view.record?.space === target;
  if (view.state !== "not_registered" && !registered) {
    return applyHome(input, view, target, null);
  }
  if (view.state === "not_registered" && (change === undefined || typeof change === "string")) {
    return applyHome(input, view, space, null, change);
  }
  let granted: Record<string, unknown>;
  try {
    granted = await call("setup/home_grant", {
      app: home.app,
      home: home.home,
      instance: home.instance,
      account: home.account,
      hosts: home.hosts,
      space: target,
    });
  } catch (error) {
    // The service refused the row or is gone: this home is left as it is, the others still run
    // and every outcome is reported. A refusal of a taken instance is named as such.
    const taken = error instanceof AppError && error.data["reason"] === "instance_taken";
    return { home, result: "failed", reason: taken ? "instance_taken" : "grant_failed" };
  }
  const grant = (granted["grant"] as { grant?: unknown } | undefined)?.grant;
  const grantId = typeof grant === "string" ? grant : null;
  const outcome = await applyHome(input, view, target, grantId, change);
  if (outcome.result === "failed" && granted["created"] === true && grantId !== null) {
    try {
      await call("setup/home_revoke", { grants: [grantId] });
    } catch {
      // The row stays; a remove revokes the rows of homes without an entry of setup's.
    }
  }
  return outcome;
}
